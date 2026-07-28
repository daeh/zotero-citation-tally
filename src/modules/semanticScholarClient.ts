/**
 * Zotero adapter for {@link SemanticScholarClientCore}. Manages API-key
 * preferences, validation, and rejection warnings without logging key values.
 */

import { config, version } from '../../package.json'
import { normalizeApiKey } from '../utils/apiKey'
import { getString } from '../utils/locale'
import { getPref, setPref } from '../utils/prefs'
import { parseRetryAfterMs } from '../utils/temporalParse'

import { S2_PAPER_BASE, SemanticScholarClientCore } from './semanticScholarClient.core'
import {
  applyRejection,
  changeKey,
  initialKeyState,
  isKeyedAttemptEligible,
  isRejectionCurrent,
  markPendingWarning,
  markWarned,
  recordAuthAccepted,
  releaseHalfOpen,
  selectAttemptAuthority,
} from './semanticScholarKeyState'

import type { ItemIdentifier, LookupResult, ValidationStatus } from './citationTypes'
import type { AttemptMode, KeyStateAccess, S2CoreDeps } from './semanticScholarClient.core'
import type { KeyRef, KeyState, RejectionAttempt, RejectionDisposition } from './semanticScholarKeyState'
import type { NormalizedApiKey } from '../utils/apiKey'

const PREF_KEY = 'semanticScholarApiKey' as const
const RATE_LIMITS_PREF = 'rateLimits' as const
const KEYED_SPACING_MS = 1000
const ANON_FALLBACK_SPACING_MS = 3000
/** Semantic Scholar's example paper, used for API-key validation. */
const PROBE_PAPER_ID = '649def34f8be52c8b66281af98ae884c09aef38b'
/**
 * Transient retries for a validation probe. Auth corroboration has its own budget
 * in the core, so this just absorbs a 429/5xx blip during an explicit check.
 */
const PROBE_MAX_RETRIES = 1
/** Identifies the client to Semantic Scholar. `name/version` must be one token. */
const USER_AGENT = `Citation-Tally/${version} (+https://github.com/daeh/zotero-citation-tally)`

export type { ValidationStatus }

interface ProbeOutcome {
  status: ValidationStatus
  /** Short, redacted phrase from Semantic Scholar, when it supplied one. */
  detail?: string
}

export interface CommitResult extends ProbeOutcome {
  normalizedKey: string
  generation: number
  /** Labels of characters normalization removed from the input, if any. */
  removedCharacters?: string[]
}

/**
 * The key we would actually send. A key still holding unsendable characters would
 * throw at `Headers` construction on every request, so it counts as unset and
 * lookups carry on anonymously, with the preferences pane naming the characters.
 * The stored-key read and the commit path both go through this, so they can't
 * disagree and advance the key generation for no reason.
 */
function effectiveKey(normalized: NormalizedApiKey): string {
  return normalized.unusable.length > 0 ? '' : normalized.key
}

function monotonicNow(): number {
  return performance ? performance.now() : Temporal.Now.instant().epochMilliseconds
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals)
}

function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

class SemanticScholarClient {
  private keyState: KeyState = initialKeyState()
  private lastObservedKey = ''
  private readonly shutdownController = new AbortController()
  private warningToast: { close: () => void } | null = null
  private observerId: symbol | null = null
  private readonly inFlightProbes = new Map<string, Promise<ProbeOutcome>>()
  private readonly core: SemanticScholarClientCore

  constructor() {
    const keyStateAccess: KeyStateAccess = {
      isEligible: (ref, authority) => isKeyedAttemptEligible(this.keyState, ref, monotonicNow(), authority),
      reject: (ref, attempt) => this.onKeyRejected(ref, attempt),
      recordAuthAccepted: (ref) => this.onAuthAccepted(ref),
      authEpoch: () => this.keyState.authEpoch,
      releaseHalfOpen: (ref, leaseId) => {
        this.keyState = releaseHalfOpen(this.keyState, ref, leaseId)
      },
      currentContext: () => this.currentContext(),
    }
    const deps: S2CoreDeps = {
      fetch: (url, init) => fetch(url, init),
      paperBaseUrl: S2_PAPER_BASE,
      userAgent: USER_AGENT,
      monotonicNow,
      nowEpochMs: () => Temporal.Now.instant().epochMilliseconds,
      // AbortSignal.timeout is Exposed=(Window,Worker) only, so it's missing from
      // this sandbox realm. Build the same thing out of setTimeout, which is here.
      createTimeoutSignal: (ms) => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms)
        return controller.signal
      },
      combineSignals: combineAbortSignals,
      sleep: interruptibleSleep,
      random: () => Math.random(),
      getKeyState: keyStateAccess,
      getSpacingMs: (mode) => this.getSpacingMs(mode),
      parseRetryAfterMs,
      shutdownSignal: this.shutdownController.signal,
      log: (msg) => ztoolkit.log(msg),
    }
    this.core = new SemanticScholarClientCore(deps)
  }

  private storedKey(): string {
    return effectiveKey(normalizeApiKey(getPref(PREF_KEY)))
  }

  /**
   * Select the attempt context, claiming the half-open slot atomically so that a
   * backlog of pending lookups can't each fire off their own pair of 403s.
   */
  private currentContext(): AttemptMode {
    const key = this.storedKey()
    if (key === '') return { mode: 'anonymous' }
    const generation = this.keyState.keyGeneration
    const { state, authority } = selectAttemptAuthority(this.keyState, key, monotonicNow())
    this.keyState = state
    if (authority === null) return { mode: 'anonymous' }
    // Claiming the retry slot ends the pause, so take down the notice announcing it.
    if (authority.kind === 'half_open') this.closeWarning()
    return { mode: 'keyed', key, generation, authority }
  }

  private getSpacingMs(mode: 'keyed' | 'anonymous'): number {
    if (mode === 'keyed') return KEYED_SPACING_MS
    const raw = getPref(RATE_LIMITS_PREF)
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as { semanticscholar?: unknown }
        const value = parsed?.semanticscholar
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          return Math.max(ANON_FALLBACK_SPACING_MS, value)
        }
      } catch {
        // Ignore malformed preference data.
      }
    }
    return ANON_FALLBACK_SPACING_MS
  }

  /** Reports whether the evidence stood. Only `'stale'` means it was declined. */
  private onKeyRejected(ref: KeyRef, attempt: RejectionAttempt): RejectionDisposition {
    const { state, shouldWarn, disposition } = applyRejection(this.keyState, ref, attempt, monotonicNow())
    this.keyState = state
    if (!shouldWarn) return disposition
    // Recheck state inside the microtask, since shutdown or a key change may intervene.
    queueMicrotask(() => {
      if (this.shutdownController.signal.aborted) return
      if (!isRejectionCurrent(this.keyState, ref, monotonicNow())) return
      this.showWarning(ref)
    })
    return disposition
  }

  private onAuthAccepted(ref: KeyRef): void {
    const before = this.keyState
    this.keyState = recordAuthAccepted(before, ref)
    // The notice says the key is paused, so it must not outlive the pause.
    if (before.rejection !== null && this.keyState.rejection === null) this.closeWarning()
  }

  private showWarning(ref: KeyRef): void {
    const win = Zotero.getMainWindow() as Window | null | undefined
    if (!win) {
      this.keyState = markPendingWarning(this.keyState, ref)
      return
    }
    try {
      this.closeWarning()
      const toast = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        window: win,
        closeOnClick: true,
        closeTime: -1,
      })
      toast.createLine({ text: getString('semantic-scholar-key-rejected'), type: 'fail' }).show()
      this.warningToast = toast
      this.keyState = markWarned(this.keyState, ref)
    } catch (e) {
      ztoolkit.log(`Failed to show Semantic Scholar key warning: ${String(e)}`)
      this.keyState = markPendingWarning(this.keyState, ref)
    }
  }

  flushPendingWarning(): void {
    const pending = this.keyState.pendingWarning
    // A warning held back until a window appeared is stale once its cooldown elapses.
    if (pending !== null && isRejectionCurrent(this.keyState, pending, monotonicNow())) {
      this.showWarning(pending)
    }
  }

  closeWarning(): void {
    if (this.warningToast !== null) {
      try {
        this.warningToast.close()
      } catch {
        // The window may already be destroyed.
      }
      this.warningToast = null
    }
  }

  registerObserver(): void {
    this.lastObservedKey = this.storedKey()
    this.observerId = Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.${PREF_KEY}`,
      () => this.reconcileKeyChange(this.storedKey()),
      true,
    )
  }

  unregisterObserver(): void {
    if (this.observerId !== null) {
      Zotero.Prefs.unregisterObserver(this.observerId)
      this.observerId = null
    }
  }

  shutdown(): void {
    this.shutdownController.abort()
    this.closeWarning()
    this.unregisterObserver()
  }

  get shutdownSignal(): AbortSignal {
    return this.shutdownController.signal
  }

  /** Advance key state only when its normalized value changes. */
  private reconcileKeyChange(normalizedKey: string): void {
    if (normalizedKey === this.lastObservedKey) return
    this.lastObservedKey = normalizedKey
    this.keyState = changeKey(this.keyState)
    this.closeWarning()
  }

  lookupCitationCount(identifiers: readonly ItemIdentifier[], callerSignal?: AbortSignal): Promise<LookupResult> {
    return this.core.lookupSemanticScholarCount(identifiers, callerSignal)
  }

  /**
   * Store and validate a key. An explicit check always reaches the network and is
   * never short-circuited by a pause, so a key paused by an earlier failure can be
   * rechecked without editing it or restarting Zotero. Concurrent checks of the
   * same key generation share one request; the returned key and generation let the
   * UI throw away stale results.
   */
  async commitAndValidate(rawInput: string, callerSignal?: AbortSignal): Promise<CommitResult> {
    const normalized = normalizeApiKey(rawInput)
    const normalizedKey = normalized.key
    setPref(PREF_KEY, normalizedKey)
    // Reconcile against the key we would actually send, matching storedKey().
    this.reconcileKeyChange(effectiveKey(normalized))
    const generation = this.keyState.keyGeneration
    const removedCharacters = normalized.removed.length > 0 ? normalized.removed : undefined

    if (normalizedKey === '') return { status: 'empty', normalizedKey, generation, removedCharacters }
    if (normalized.unusable.length > 0) {
      // Sending this would throw at Headers construction, which looks like a network
      // failure. Name the characters rather than let every request fail silently.
      return {
        status: 'client_error',
        detail: `Key contains characters that cannot be sent: ${normalized.unusable.join(', ')}`,
        normalizedKey,
        generation,
        removedCharacters,
      }
    }

    const dedupeKey = `${generation}:${normalizedKey}`
    let probe = this.inFlightProbes.get(dedupeKey)
    if (probe === undefined) {
      probe = this.probe(normalizedKey, generation, callerSignal).finally(() => this.inFlightProbes.delete(dedupeKey))
      this.inFlightProbes.set(dedupeKey, probe)
    }
    const outcome = await probe
    return { ...outcome, normalizedKey, generation, removedCharacters }
  }

  private async probe(key: string, generation: number, callerSignal?: AbortSignal): Promise<ProbeOutcome> {
    const ctx: AttemptMode = { mode: 'keyed', key, generation, authority: { kind: 'bypass' } }
    const result = await this.core.requestS2(PROBE_PAPER_ID, ctx, callerSignal, { maxRetries: PROBE_MAX_RETRIES })
    switch (result.kind) {
      case 'aborted':
        return { status: 'aborted' }
      case 'transient':
        return { status: 'indeterminate', detail: result.cause }
      case 'ineligible':
        // Nothing was sent, so this is not evidence that the server rejected the key.
        return { status: 'indeterminate' }
      case 'auth_rejected':
        return { status: 'invalid', detail: result.detail }
      case 'auth_unconfirmed':
        return { status: 'indeterminate', detail: result.detail }
      case 'response': {
        const s = result.status
        if ((s >= 200 && s < 300) || s === 404) return { status: 'valid' }
        if (s === 429 || s === 408 || s >= 500) return { status: 'indeterminate' }
        if (s >= 400 && s < 500) return { status: 'client_error' }
        return { status: 'indeterminate' }
      }
    }
  }
}

let instance: SemanticScholarClient | null = null
let stopped = false

/**
 * The one capability gate for Semantic Scholar features. The bootstrap bridge
 * publishes this report; if it is absent or degraded, no code path may construct
 * the client, since the bridged globals are throwing tripwire stubs.
 */
export function isSemanticScholarAvailable(): boolean {
  return _globalThis.__runtimeBridgeReport?.semanticScholarAvailable === true
}

/** Lazy singleton, so nothing is constructed at bundle evaluation. */
export function getSemanticScholarClient(): SemanticScholarClient {
  if (!isSemanticScholarAvailable()) throw new Error('Semantic Scholar is unavailable in this Zotero runtime')
  if (stopped) throw new Error('Semantic Scholar client is shut down')
  instance ??= new SemanticScholarClient()
  return instance
}

// Guard both flags, so this does nothing if never constructed or already stopped.
export function flushPendingSemanticScholarWarning(): void {
  if (!stopped) instance?.flushPendingWarning()
}

export function closeSemanticScholarWarning(): void {
  instance?.closeWarning()
}

/**
 * `instance` is not nulled, because late async continuations have to keep seeing
 * the aborted client rather than build a fresh live one. Re-enabling the plugin
 * gets fresh module state anyway, since the bundle is re-evaluated per startup.
 */
export function shutdownSemanticScholarClient(): void {
  stopped = true // set before abort, so getSemanticScholarClient() can't hand back a live client
  instance?.shutdown()
}
