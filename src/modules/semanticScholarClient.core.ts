/**
 * Dependency-injected Semantic Scholar request scheduler.
 *
 * Request spacing is global. HTTP 429 backoff is tracked per quota identity;
 * server, timeout, and network backoff is shared.
 *
 * Authentication is handled conservatively. Semantic Scholar fronts the Graph API
 * with AWS API Gateway, which answers an unrecognised `x-api-key` with 403 and
 * throttling with 429, but an edge or WAF rejection can come back as 403 too. One
 * 403 therefore proves nothing, so a key is paused only after two *adjacent* 403s
 * for that key, and 401 never pauses it at all.
 */

import { getErrorName } from '../utils/errors.ts'
import { toS2PaperRefs } from '../utils/s2Identifiers.ts'

import type { ItemIdentifier, LookupResult } from './citationTypes.ts'
import type { AttemptAuthority, KeyRef, RejectionAttempt, RejectionDisposition } from './semanticScholarKeyState.ts'

export const S2_PAPER_BASE = 'https://api.semanticscholar.org/graph/v1/paper'
const S2_FIELDS = 'fields=citationCount'

/** One confirming request after a first 403, on a budget of its own. */
const AUTH_CORROBORATION_RETRIES = 1
const AUTH_DETAIL_MAX_BYTES = 4096
const AUTH_DETAIL_MAX_CHARS = 120

export type AttemptMode =
  | {
      readonly mode: 'keyed'
      readonly key: string
      readonly generation: number
      readonly authority: AttemptAuthority
    }
  | { readonly mode: 'anonymous' }

export type S2Result =
  | { readonly kind: 'response'; readonly status: number; readonly headers: Headers; readonly bodyText: string }
  /** Two adjacent 403s: the key is now paused. */
  | { readonly kind: 'auth_rejected'; readonly status: 403; readonly detail?: string }
  /** A 401, or a 403 we couldn't corroborate. Says nothing about the key. */
  | { readonly kind: 'auth_unconfirmed'; readonly status: number; readonly detail?: string }
  | { readonly kind: 'ineligible'; readonly reason: 'stale_key' | 'key_disabled' }
  | { readonly kind: 'transient'; readonly cause: string }
  | { readonly kind: 'aborted' }

/** Access to key state owned by the Zotero adapter. */
export interface KeyStateAccess {
  isEligible: (ref: KeyRef, authority: AttemptAuthority) => boolean
  /** Reports whether the evidence stood. Only `'stale'` means it was declined. */
  reject: (ref: KeyRef, attempt: RejectionAttempt) => RejectionDisposition
  /** A routed, authenticated response proves the key is currently accepted. */
  recordAuthAccepted: (ref: KeyRef) => void
  authEpoch: () => number
  releaseHalfOpen: (ref: KeyRef, leaseId: number) => void
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
  /** Base URL for `/{paper_id}` lookups; injected so tests can target a local fixture. */
  paperBaseUrl: string
  /** Sent on every request so Semantic Scholar can identify the client. */
  userAgent: string
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

/**
 * API Gateway rejects an unknown key before routing, so any routed response proves
 * the key was accepted. 429/408/5xx are excluded because they can come from the
 * edge, ahead of key validation, and would clear a pause they never tested.
 */
function provesAuthAccepted(status: number): boolean {
  return (status >= 200 && status < 300) || status === 400 || status === 404 || status === 422
}

/** Reduce a response body to a short, log-safe phrase. Never returns key material. */
function summarizeAuthDetail(body: string, key: string): string | undefined {
  let text = body
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    if (typeof parsed?.message === 'string') text = parsed.message
  } catch {
    // Not JSON; the raw text is the best detail available.
  }
  if (key !== '') text = text.split(key).join('[redacted]')
  // Keep control and bidi characters out of log lines and the preferences pane.
  const cleaned = text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned === '' ? undefined : cleaned.slice(0, AUTH_DETAIL_MAX_CHARS)
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

  private keyedEligible(ctx: AttemptMode): boolean {
    if (ctx.mode !== 'keyed') return true
    return this.deps.getKeyState.isEligible({ key: ctx.key, generation: ctx.generation }, ctx.authority)
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
      if (!this.keyedEligible(ctx)) return { ok: false, result: { kind: 'ineligible', reason: 'key_disabled' } }
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
      if (!this.keyedEligible(ctx)) return { ok: false, result: { kind: 'ineligible', reason: 'key_disabled' } }
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

  /**
   * Release an unread body without allocating it. Draining it by reading would
   * defeat the size guard, since the bodies we skip are the unbounded ones.
   */
  private discardBody(res: Response): void {
    try {
      res.body?.cancel().catch(() => undefined)
    } catch {
      // No stream in this realm, or the body is already disturbed.
    }
  }

  /**
   * Read a small, uncompressed error body. Fetch decompresses transparently, so
   * `Content-Length` bounds nothing once a body is encoded. Demand identity
   * encoding as well; anything else is reported as a status and nothing more.
   */
  private async readAuthDetail(res: Response, key: string): Promise<string | undefined> {
    const encoding = res.headers.get('content-encoding')
    if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
      this.discardBody(res)
      return undefined
    }
    const declared = res.headers.get('content-length')
    if (declared === null || !/^\d+$/.test(declared) || Number(declared) > AUTH_DETAIL_MAX_BYTES) {
      this.discardBody(res)
      return undefined
    }
    try {
      return summarizeAuthDetail(await res.text(), key)
    } catch {
      return undefined // the status is already known; a failed body read must not discard it
    }
  }

  /**
   * Send one request, retrying transient failures up to `maxRetries`. The
   * half-open lease is released in the `finally` here, so no failure path can
   * strand it.
   */
  async requestS2(
    paperId: string,
    ctx: AttemptMode,
    callerSignal?: AbortSignal,
    opts?: { maxRetries?: number },
  ): Promise<S2Result> {
    try {
      return await this.dispatch(paperId, ctx, callerSignal, opts)
    } finally {
      if (ctx.mode === 'keyed' && ctx.authority.kind === 'half_open') {
        this.deps.getKeyState.releaseHalfOpen({ key: ctx.key, generation: ctx.generation }, ctx.authority.leaseId)
      }
    }
  }

  private async dispatch(
    paperId: string,
    ctx: AttemptMode,
    callerSignal?: AbortSignal,
    opts?: { maxRetries?: number },
  ): Promise<S2Result> {
    const maxRetries = opts?.maxRetries ?? this.cfg.maxRetries
    const identity = this.identityFor(ctx)
    const waitSignal = this.composeWaitSignal(callerSignal)
    const url = `${this.deps.paperBaseUrl}/${paperId}?${S2_FIELDS}`

    let sawAuthFailure = false // a 403 immediately before this attempt, in this operation
    let authEpochAtFirstFailure = 0
    let authRetriesUsed = 0
    // Counted separately from the auth-confirmation request, so that a 403 can't
    // spend a transient retry and a 429 can't spend the confirmation.
    let transientRetries = 0

    for (;;) {
      const slot = await this.acquireSlot(ctx, identity, waitSignal, callerSignal)
      if (!slot.ok) return slot.result

      const timeoutSignal = this.deps.createTimeoutSignal(this.cfg.timeoutMs)
      const fetchSignal = this.composeFetchSignal(callerSignal, timeoutSignal)
      const headers: Record<string, string> = { 'User-Agent': this.deps.userAgent }
      if (ctx.mode === 'keyed') headers['x-api-key'] = ctx.key
      const init: RequestInit = { redirect: 'error', cache: 'no-store', signal: fetchSignal, headers }

      try {
        const res = await this.deps.fetch(url, init)
        const status = res.status

        if (ctx.mode === 'keyed' && (status === 401 || status === 403)) {
          // Sample the epoch when the headers arrive. An acceptance racing the body
          // read would otherwise look as though it preceded this failure, making
          // the two 403s look adjacent when they aren't.
          const epochAtFailure = this.deps.getKeyState.authEpoch()
          const detail = await this.readAuthDetail(res, ctx.key)
          if (this.isCancelled(callerSignal)) return { kind: 'aborted' }
          this.deps.log(`S2 lookup status=${status} api_key_sent=true reason=${detail ?? 'n/a'}`)

          // 403 is Semantic Scholar's unrecognised-key signal. 401 never pauses a key.
          if (status !== 403) return { kind: 'auth_unconfirmed', status, detail }

          if (!sawAuthFailure) {
            if (authRetriesUsed >= AUTH_CORROBORATION_RETRIES) {
              return { kind: 'auth_unconfirmed', status, detail } // nothing left to confirm with
            }
            sawAuthFailure = true
            authEpochAtFirstFailure = epochAtFailure
            authRetriesUsed += 1
            continue // one confirming request, on its own budget
          }

          const disposition = this.deps.getKeyState.reject(
            { key: ctx.key, generation: ctx.generation },
            { expectedAuthEpoch: authEpochAtFirstFailure, authority: ctx.authority },
          )
          // Only stale evidence is inconclusive. Reporting it as a rejection would
          // fail a valid key. A pause already in force is still a real rejection.
          return disposition === 'stale'
            ? { kind: 'auth_unconfirmed', status, detail }
            : { kind: 'auth_rejected', status: 403, detail }
        }

        this.deps.log(`S2 lookup status=${status} api_key_sent=${ctx.mode === 'keyed'}`)
        sawAuthFailure = false // any non-403 outcome breaks adjacency within this operation

        // Status and Retry-After remain usable even if reading the body fails.
        if (status === 429 || status === 408 || status >= 500) {
          const retryAfter = res.headers.get('retry-after')
          const retryAfterMs =
            retryAfter === null ? null : this.deps.parseRetryAfterMs(retryAfter, this.deps.nowEpochMs())
          this.discardBody(res)
          const bucket = status === 429 ? this.quotaFor(identity) : this.service
          this.recordTransient(bucket, retryAfterMs, this.deps.monotonicNow())
          if (this.isCircuitOpen(bucket, this.deps.monotonicNow()) || transientRetries >= maxRetries) {
            return { kind: 'transient', cause: `http_${status}` }
          }
          transientRetries += 1
          continue // re-enqueue against the updated deadline
        }

        this.recordHealthy(identity)
        if (ctx.mode === 'keyed' && provesAuthAccepted(status)) {
          this.deps.getKeyState.recordAuthAccepted({ key: ctx.key, generation: ctx.generation })
        }
        if (status >= 200 && status < 300) {
          const bodyText = await res.text() // may reject (abort/network) — caught below
          return { kind: 'response', status, headers: res.headers, bodyText }
        }
        this.discardBody(res)
        return { kind: 'response', status, headers: res.headers, bodyText: '' }
      } catch (err) {
        // Caller and shutdown aborts are cancellations; other fetch failures are transient.
        if (this.isCancelled(callerSignal)) return { kind: 'aborted' }
        const cause = classifyRequestFailure(err)
        if (cause === null) throw err
        sawAuthFailure = false
        this.recordTransient(this.service, null, this.deps.monotonicNow())
        if (this.isCircuitOpen(this.service, this.deps.monotonicNow()) || transientRetries >= maxRetries) {
          return { kind: 'transient', cause }
        }
        transientRetries += 1
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
        if (result.kind === 'auth_unconfirmed') {
          // Uncorroborated, so the key is untouched and this says nothing about the
          // item. It must not be api_error, which auto-update stores as an ignore.
          return { count: -1, status: 'transient_error', message: `auth_unconfirmed_${result.status}` }
        }
        if (result.kind === 'auth_rejected' || result.kind === 'ineligible') {
          // The key is paused now; retry this identifier with the refreshed context.
          if (++restarts > this.cfg.maxContextRestarts) {
            sawApiError = true
            advance = true
            break
          }
          ctx = this.deps.getKeyState.currentContext()
          continue
        }

        const status = result.status
        if (status === 401 || status === 403) {
          // Anonymous only. A service condition, not a property of this item.
          return { count: -1, status: 'transient_error', message: `Unexpected anonymous ${status}` }
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
  // Composite signals can surface a timeout as AbortError. Caller and shutdown
  // aborts were already handled above.
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  if (name === 'TypeError') return 'network'
  return null
}
