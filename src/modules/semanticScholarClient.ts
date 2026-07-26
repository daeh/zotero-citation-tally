/**
 * Zotero adapter for {@link SemanticScholarClientCore}. Manages API-key
 * preferences, validation, and rejection warnings without logging key values.
 */

import { config } from '../../package.json'
import { getString } from '../utils/locale'
import { getPref, setPref } from '../utils/prefs'
import { parseRetryAfterMs } from '../utils/temporalParse'

import { SemanticScholarClientCore } from './semanticScholarClient.core'
import {
  applyRejection,
  changeKey,
  initialKeyState,
  isKeyedAttemptEligible,
  isKeyUsable,
  isRejectionCurrent,
  markPendingWarning,
  markWarned,
} from './semanticScholarKeyState'

import type { ItemIdentifier, LookupResult } from './citationTypes'
import type { AttemptMode, KeyStateAccess, S2CoreDeps } from './semanticScholarClient.core'
import type { KeyRef, KeyState } from './semanticScholarKeyState'

const PREF_KEY = 'semanticScholarApiKey' as const
const RATE_LIMITS_PREF = 'rateLimits' as const
const KEYED_SPACING_MS = 1000
const ANON_FALLBACK_SPACING_MS = 3000
/** Semantic Scholar's example paper, used for API-key validation. */
const PROBE_PAPER_ID = '649def34f8be52c8b66281af98ae884c09aef38b'

export type ValidationStatus = 'valid' | 'invalid' | 'indeterminate' | 'empty' | 'client_error' | 'aborted'

export interface CommitResult {
  status: ValidationStatus
  normalizedKey: string
  generation: number
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
  private readonly inFlightProbes = new Map<string, Promise<ValidationStatus>>()
  private readonly core: SemanticScholarClientCore

  constructor() {
    const keyStateAccess: KeyStateAccess = {
      isEligible: (ref: KeyRef) => isKeyedAttemptEligible(this.keyState, ref),
      reject: (ref: KeyRef) => this.onKeyRejected(ref),
      currentContext: () => this.currentContext(),
    }
    const deps: S2CoreDeps = {
      fetch: (url, init) => fetch(url, init),
      monotonicNow: () => (performance ? performance.now() : Temporal.Now.instant().epochMilliseconds),
      nowEpochMs: () => Temporal.Now.instant().epochMilliseconds,
      // AbortSignal.timeout is Exposed=(Window,Worker) only, so it's missing in
      // this sandbox realm; build the same thing from setTimeout, which is here.
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
    const raw = getPref(PREF_KEY)
    return typeof raw === 'string' ? raw.trim() : ''
  }

  private currentContext(): AttemptMode {
    const key = this.storedKey()
    if (key === '' || !isKeyUsable(this.keyState, key)) return { mode: 'anonymous' }
    return { mode: 'keyed', key, generation: this.keyState.keyGeneration }
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

  private onKeyRejected(ref: KeyRef): void {
    const { state, shouldWarn } = applyRejection(this.keyState, ref)
    this.keyState = state
    if (!shouldWarn) return
    // Recheck state in the microtask because shutdown or a key change may intervene.
    queueMicrotask(() => {
      if (this.shutdownController.signal.aborted) return
      if (!isRejectionCurrent(this.keyState, ref)) return
      this.showWarning(ref)
    })
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
    if (pending !== null && isRejectionCurrent(this.keyState, pending)) {
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
   * Store and validate a key. Concurrent checks of the same key generation share
   * one request; the returned key and generation let the UI reject stale results.
   */
  async commitAndValidate(rawInput: string, callerSignal?: AbortSignal): Promise<CommitResult> {
    const normalizedKey = rawInput.trim()
    setPref(PREF_KEY, normalizedKey)
    this.reconcileKeyChange(normalizedKey)
    const generation = this.keyState.keyGeneration

    if (normalizedKey === '') return { status: 'empty', normalizedKey, generation }
    if (!isKeyUsable(this.keyState, normalizedKey)) return { status: 'invalid', normalizedKey, generation }

    const dedupeKey = `${generation}:${normalizedKey}`
    let probe = this.inFlightProbes.get(dedupeKey)
    if (probe === undefined) {
      probe = this.probe(normalizedKey, generation, callerSignal).finally(() => this.inFlightProbes.delete(dedupeKey))
      this.inFlightProbes.set(dedupeKey, probe)
    }
    return { status: await probe, normalizedKey, generation }
  }

  private async probe(key: string, generation: number, callerSignal?: AbortSignal): Promise<ValidationStatus> {
    const ctx: AttemptMode = { mode: 'keyed', key, generation }
    const result = await this.core.requestS2(PROBE_PAPER_ID, ctx, callerSignal, { maxRetries: 0 })
    switch (result.kind) {
      case 'aborted':
        return 'aborted'
      case 'transient':
        return 'indeterminate'
      case 'ineligible':
        return 'invalid'
      case 'response': {
        const s = result.status
        if ((s >= 200 && s < 300) || s === 404) return 'valid'
        if (s === 401 || s === 403) return 'invalid'
        if (s === 429 || s === 408 || s >= 500) return 'indeterminate'
        if (s >= 400 && s < 500) return 'client_error'
        return 'indeterminate'
      }
    }
  }
}

let instance: SemanticScholarClient | null = null
let stopped = false

/**
 * The sole capability gate for Semantic Scholar features. The bootstrap bridge
 * publishes this report; when it is absent or degraded, no code path may
 * construct the client (the bridged globals are throwing tripwire stubs).
 */
export function isSemanticScholarAvailable(): boolean {
  return _globalThis.__runtimeBridgeReport?.semanticScholarAvailable === true
}

/** Lazy singleton — nothing is constructed at bundle evaluation. */
export function getSemanticScholarClient(): SemanticScholarClient {
  if (!isSemanticScholarAvailable()) throw new Error('Semantic Scholar is unavailable in this Zotero runtime')
  if (stopped) throw new Error('Semantic Scholar client is shut down')
  instance ??= new SemanticScholarClient()
  return instance
}

// Guard both flags: no-op when never constructed or already stopped.
export function flushPendingSemanticScholarWarning(): void {
  if (!stopped) instance?.flushPendingWarning()
}

export function closeSemanticScholarWarning(): void {
  instance?.closeWarning()
}

/**
 * `instance` is not nulled: late async continuations must keep seeing the
 * aborted client rather than mint a fresh live one. Re-enable gets fresh module
 * state because the bundle is re-evaluated per startup.
 */
export function shutdownSemanticScholarClient(): void {
  stopped = true // set before abort, so getSemanticScholarClient() can't hand back a live client
  instance?.shutdown()
}
