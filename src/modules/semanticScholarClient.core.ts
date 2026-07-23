/**
 * Dependency-injected Semantic Scholar request scheduler.
 *
 * Request spacing is global. HTTP 429 backoff is tracked per quota identity;
 * server, timeout, and network backoff is shared.
 */

import { getErrorName } from '../utils/errors.ts'
import { toS2PaperRefs } from '../utils/s2Identifiers.ts'

import type { ItemIdentifier, LookupResult } from './citationTypes.ts'
import type { KeyRef } from './semanticScholarKeyState.ts'

const S2_PAPER_BASE = 'https://api.semanticscholar.org/graph/v1/paper'
const S2_FIELDS = 'fields=citationCount'

export type AttemptMode =
  { readonly mode: 'keyed'; readonly key: string; readonly generation: number } | { readonly mode: 'anonymous' }

export type S2Result =
  | { readonly kind: 'response'; readonly status: number; readonly headers: Headers; readonly bodyText: string }
  | { readonly kind: 'ineligible'; readonly reason: 'stale_key' | 'key_disabled' }
  | { readonly kind: 'transient'; readonly cause: string }
  | { readonly kind: 'aborted' }

/** Access to key state owned by the Zotero adapter. */
export interface KeyStateAccess {
  isEligible: (ref: KeyRef) => boolean
  reject: (ref: KeyRef) => void
  currentContext: () => AttemptMode
}

export interface S2CoreConfig {
  timeoutMs: number
  baseDelayMs: number
  maxDelayMs: number
  /** Retries after the initial attempt. */
  maxRetries: number
  /** Key-context refreshes allowed for one identifier. */
  maxContextRestarts: number
  /** `Retry-After` threshold that opens the circuit. */
  circuitCeilingMs: number
}

export const DEFAULT_S2_CONFIG: S2CoreConfig = {
  timeoutMs: 15_000,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetries: 4,
  maxContextRestarts: 3,
  circuitCeilingMs: 120_000,
}

export interface S2CoreDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** Monotonic milliseconds. */
  monotonicNow: () => number
  /** Wall-clock epoch milliseconds. */
  nowEpochMs: () => number
  createTimeoutSignal: (ms: number) => AbortSignal
  combineSignals: (signals: AbortSignal[]) => AbortSignal
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  random: () => number
  getKeyState: KeyStateAccess
  getSpacingMs: (mode: 'keyed' | 'anonymous') => number
  parseRetryAfterMs: (headerValue: string, nowEpochMs: number) => number | null
  shutdownSignal: AbortSignal
  log: (msg: string) => void
  config?: Partial<S2CoreConfig>
}

interface QuotaState {
  failures: number
  lastFailureAt: number
  backoffUntil: number
  circuitUntil: number
}

function newQuotaState(): QuotaState {
  return { failures: 0, lastFailureAt: 0, backoffUntil: 0, circuitUntil: 0 }
}

/** Stable, non-cryptographic fingerprint used only as an in-memory map key. */
function fingerprint(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function parseCitationCount(bodyText: string): number | null {
  try {
    const parsed = JSON.parse(bodyText) as { citationCount?: unknown }
    const c = parsed?.citationCount
    return typeof c === 'number' && Number.isSafeInteger(c) && c >= 0 ? c : null
  } catch {
    return null
  }
}

export class SemanticScholarClientCore {
  private readonly deps: S2CoreDeps
  private readonly cfg: S2CoreConfig

  private lastAttemptAt: number | null = null
  private readonly quota = new Map<string, QuotaState>()
  private readonly service: QuotaState = newQuotaState()

  constructor(deps: S2CoreDeps) {
    this.deps = deps
    this.cfg = { ...DEFAULT_S2_CONFIG, ...deps.config }
  }

  private identityFor(ctx: AttemptMode): string {
    return ctx.mode === 'anonymous' ? 'anonymous' : `k:${fingerprint(ctx.key)}`
  }

  private quotaFor(identity: string): QuotaState {
    let q = this.quota.get(identity)
    if (q === undefined) {
      q = newQuotaState()
      this.quota.set(identity, q)
    }
    return q
  }

  private isCancelled(callerSignal?: AbortSignal): boolean {
    return this.deps.shutdownSignal.aborted || callerSignal?.aborted === true
  }

  /** Wait for spacing and backoff, then synchronously claim the next request slot. */
  private async acquireSlot(
    ctx: AttemptMode,
    identity: string,
    waitSignal: AbortSignal | undefined,
    callerSignal: AbortSignal | undefined,
  ): Promise<{ ok: true } | { ok: false; result: S2Result }> {
    for (;;) {
      if (this.isCancelled(callerSignal)) return { ok: false, result: { kind: 'aborted' } }
      if (ctx.mode === 'keyed' && !this.deps.getKeyState.isEligible({ key: ctx.key, generation: ctx.generation })) {
        return { ok: false, result: { kind: 'ineligible', reason: 'key_disabled' } }
      }
      const now = this.deps.monotonicNow()
      if (this.circuitUntil(identity) > now) return { ok: false, result: { kind: 'transient', cause: 'circuit' } }

      const spacing = this.deps.getSpacingMs(ctx.mode === 'keyed' ? 'keyed' : 'anonymous')
      const q = this.quotaFor(identity)
      const target = Math.max(
        this.lastAttemptAt === null ? now : this.lastAttemptAt + spacing,
        q.backoffUntil,
        this.service.backoffUntil,
      )
      if (target > now) {
        try {
          await this.deps.sleep(target - now, waitSignal)
        } catch {
          return { ok: false, result: { kind: 'aborted' } }
        }
        continue // re-evaluate after waking
      }

      if (this.isCancelled(callerSignal)) return { ok: false, result: { kind: 'aborted' } }
      if (ctx.mode === 'keyed' && !this.deps.getKeyState.isEligible({ key: ctx.key, generation: ctx.generation })) {
        return { ok: false, result: { kind: 'ineligible', reason: 'key_disabled' } }
      }
      const now2 = this.deps.monotonicNow()
      if (this.circuitUntil(identity) > now2) return { ok: false, result: { kind: 'transient', cause: 'circuit' } }
      if (this.lastAttemptAt !== null && now2 < this.lastAttemptAt + spacing) continue // lost the race; recompute
      this.lastAttemptAt = now2
      return { ok: true }
    }
  }

  private circuitUntil(identity: string): number {
    return Math.max(this.quotaFor(identity).circuitUntil, this.service.circuitUntil)
  }

  /** Advance quota-specific or shared backoff after a transient failure. */
  private recordTransient(target: QuotaState, retryAfterMs: number | null, now: number): void {
    if (target.lastFailureAt !== 0 && now - target.lastFailureAt > 2 * this.cfg.maxDelayMs) {
      target.failures = 0 // quiet period elapsed
    }
    target.failures += 1
    target.lastFailureAt = now
    if (retryAfterMs !== null && retryAfterMs > this.cfg.circuitCeilingMs) {
      // Long server delays open the circuit so queued requests fail immediately.
      target.circuitUntil = Math.max(target.circuitUntil, now + retryAfterMs)
      target.backoffUntil = Math.max(target.backoffUntil, now + retryAfterMs)
      return
    }
    const base = Math.min(this.cfg.baseDelayMs * 2 ** (target.failures - 1), this.cfg.maxDelayMs)
    const jittered = this.deps.random() * base // full jitter in [0, base]
    const delay = Math.max(retryAfterMs ?? 0, jittered)
    target.backoffUntil = Math.max(target.backoffUntil, now + delay)
  }

  private recordHealthy(identity: string): void {
    this.service.failures = 0
    this.quotaFor(identity).failures = 0
  }

  private isCircuitOpen(target: QuotaState, now: number): boolean {
    return target.circuitUntil > now
  }

  /** Send one request, retrying transient failures up to `maxRetries`. */
  async requestS2(
    paperId: string,
    ctx: AttemptMode,
    callerSignal?: AbortSignal,
    opts?: { maxRetries?: number },
  ): Promise<S2Result> {
    const maxRetries = opts?.maxRetries ?? this.cfg.maxRetries
    const identity = this.identityFor(ctx)
    const waitSignal = this.composeWaitSignal(callerSignal)
    const url = `${S2_PAPER_BASE}/${paperId}?${S2_FIELDS}`

    for (let attempt = 0; ; attempt++) {
      const slot = await this.acquireSlot(ctx, identity, waitSignal, callerSignal)
      if (!slot.ok) return slot.result

      const timeoutSignal = this.deps.createTimeoutSignal(this.cfg.timeoutMs)
      const fetchSignal = this.composeFetchSignal(callerSignal, timeoutSignal)
      const init: RequestInit = {
        redirect: 'error',
        cache: 'no-store',
        signal: fetchSignal,
        ...(ctx.mode === 'keyed' ? { headers: { 'x-api-key': ctx.key } } : {}),
      }

      try {
        const res = await this.deps.fetch(url, init)
        const status = res.status
        this.deps.log(`S2 lookup status=${status} api_key_sent=${ctx.mode === 'keyed'}`)

        // Status and Retry-After remain usable even if reading the body fails.
        if (ctx.mode === 'keyed' && (status === 401 || status === 403)) {
          this.deps.getKeyState.reject({ key: ctx.key, generation: ctx.generation })
          void res.text().catch(() => undefined) // drain unused body
          return { kind: 'response', status, headers: res.headers, bodyText: '' }
        }
        if (status === 429 || status === 408 || status >= 500) {
          const retryAfter = res.headers.get('retry-after')
          const retryAfterMs =
            retryAfter === null ? null : this.deps.parseRetryAfterMs(retryAfter, this.deps.nowEpochMs())
          void res.text().catch(() => undefined) // drain unused body
          const bucket = status === 429 ? this.quotaFor(identity) : this.service
          this.recordTransient(bucket, retryAfterMs, this.deps.monotonicNow())
          if (this.isCircuitOpen(bucket, this.deps.monotonicNow()) || attempt >= maxRetries) {
            return { kind: 'transient', cause: `http_${status}` }
          }
          continue // re-enqueue against the updated deadline
        }

        this.recordHealthy(identity)
        if (status >= 200 && status < 300) {
          const bodyText = await res.text() // may reject (abort/network) — caught below
          return { kind: 'response', status, headers: res.headers, bodyText }
        }
        void res.text().catch(() => undefined)
        return { kind: 'response', status, headers: res.headers, bodyText: '' }
      } catch (err) {
        // Caller and shutdown aborts are cancellations; other fetch failures are transient.
        if (this.isCancelled(callerSignal)) return { kind: 'aborted' }
        const cause = classifyRequestFailure(err)
        if (cause === null) throw err
        this.recordTransient(this.service, null, this.deps.monotonicNow())
        if (this.isCircuitOpen(this.service, this.deps.monotonicNow()) || attempt >= maxRetries) {
          return { kind: 'transient', cause }
        }
        continue
      }
    }
  }

  private composeWaitSignal(callerSignal?: AbortSignal): AbortSignal {
    return callerSignal === undefined
      ? this.deps.shutdownSignal
      : this.deps.combineSignals([this.deps.shutdownSignal, callerSignal])
  }

  private composeFetchSignal(callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): AbortSignal {
    const signals =
      callerSignal === undefined
        ? [this.deps.shutdownSignal, timeoutSignal]
        : [this.deps.shutdownSignal, callerSignal, timeoutSignal]
    return this.deps.combineSignals(signals)
  }

  /** Try identifiers in order until one returns a citation count. Throws `AbortError` if cancelled. */
  async lookupSemanticScholarCount(
    identifiers: readonly ItemIdentifier[],
    callerSignal?: AbortSignal,
  ): Promise<LookupResult> {
    const refs = toS2PaperRefs(identifiers)
    if (refs.length === 0) return { count: -1, status: 'no_identifier', message: 'No usable identifier' }

    let sawTransient = false
    let sawApiError = false
    let sawNotFound = false

    for (const ref of refs) {
      let ctx = this.deps.getKeyState.currentContext()
      let restarts = 0
      let advance = false // move to the next identifier

      while (!advance) {
        const result = await this.requestS2(ref.paperId, ctx, callerSignal)

        if (result.kind === 'aborted') throw new DOMException('Semantic Scholar lookup aborted', 'AbortError')
        if (result.kind === 'transient') {
          // Preserve an exhausted 429 as rate_limited; other exhausted retries are transient errors.
          const status = result.cause === 'http_429' ? 'rate_limited' : 'transient_error'
          return { count: -1, status, message: result.cause }
        }
        if (result.kind === 'ineligible') {
          if (++restarts > this.cfg.maxContextRestarts) {
            sawApiError = true
            advance = true
            break
          }
          ctx = this.deps.getKeyState.currentContext()
          continue
        }

        const status = result.status
        if (ctx.mode === 'keyed' && (status === 401 || status === 403)) {
          // Retry with the current key state after a 401 or 403.
          if (++restarts > this.cfg.maxContextRestarts) {
            sawApiError = true
            advance = true
            break
          }
          ctx = this.deps.getKeyState.currentContext()
          continue
        }
        if (ctx.mode === 'anonymous' && (status === 401 || status === 403)) {
          return { count: -1, status: 'api_error', message: `Unexpected anonymous ${status}` }
        }
        if (status === 404) {
          sawNotFound = true
          advance = true
          break
        }
        if (status >= 200 && status < 300) {
          const count = parseCitationCount(result.bodyText)
          if (count !== null) return { count, status: 'success' }
          sawTransient = true // malformed 2xx is a protocol failure, not "not found"
          advance = true
          break
        }
        if (status === 400 || status === 422) {
          sawApiError = true // identifier-specific; try the next identifier
          advance = true
          break
        }
        return { count: -1, status: 'api_error', message: `Unexpected HTTP ${status}` }
      }
    }

    if (sawTransient) return { count: -1, status: 'transient_error', message: 'Transient failure' }
    if (sawApiError) return { count: -1, status: 'api_error', message: 'Lookup error' }
    if (sawNotFound) return { count: 0, status: 'not_found', message: 'Not found' }
    return { count: 0, status: 'not_found', message: 'Not found' }
  }
}

function classifyRequestFailure(error: unknown): 'timeout' | 'network' | null {
  const name = getErrorName(error)
  // Composite signals may surface a timeout as AbortError; caller and shutdown aborts were handled above.
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  if (name === 'TypeError') return 'network'
  return null
}
