/**
 * API-key state transitions.
 *
 * A single 403 doesn't pause a key; it takes two adjacent ones. The pause is
 * time-boxed, and once it lifts only the half-open lease holder retries, so a
 * backlog of lookups can't each fire off their own pair. Any accepted response
 * bumps `authEpoch`, which strands a pair another operation had half-finished.
 *
 * No clock of its own: every time-dependent function takes `now` in monotonic ms.
 */

export interface KeyRef {
  key: string
  generation: number
}

/** Who is making a keyed attempt, and what it's allowed to do. */
export type AttemptAuthority =
  /** Normal traffic: refused while a rejection is active. */
  | { readonly kind: 'ordinary' }
  /** The single post-cooldown retry; must present the exact lease. */
  | { readonly kind: 'half_open'; readonly leaseId: number }
  /** An explicit check by the user. Ignores the cooldown, and nothing else. */
  | { readonly kind: 'bypass' }

export interface CooldownLadder {
  baseMs: number
  maxMs: number
}

export const DEFAULT_KEY_COOLDOWN: CooldownLadder = { baseMs: 15 * 60_000, maxMs: 4 * 60 * 60_000 }

export interface KeyRejection {
  ref: KeyRef
  /** Confirmed rejections for this key; sets the cooldown length. */
  strikes: number
  /** Monotonic ms at which one keyed attempt becomes claimable again. */
  retryAt: number
  /** Opaque owner token for the post-cooldown slot; `null` when unclaimed. */
  halfOpenLease: number | null
}

export interface KeyState {
  keyGeneration: number
  /** Bumped by every accepted auth response and by key changes. */
  authEpoch: number
  nextLeaseId: number
  rejection: KeyRejection | null
  warnedFor: KeyRef | null
  pendingWarning: KeyRef | null
}

export interface RejectionAttempt {
  /** `authEpoch` sampled when the first 403 arrived. */
  expectedAuthEpoch: number
  authority: AttemptAuthority
}

/**
 * Why a rejection did or did not change state.
 *
 * `already_active` means the evidence held up but a pause was already in force.
 * That is still a rejection. Reporting it as inconclusive would make rechecking
 * an already-paused bad key say "couldn't check the key" rather than naming the
 * rejection.
 */
export type RejectionDisposition = 'applied' | 'already_active' | 'stale'

export function initialKeyState(): KeyState {
  return { keyGeneration: 0, authEpoch: 0, nextLeaseId: 1, rejection: null, warnedFor: null, pendingWarning: null }
}

function sameRef(a: KeyRef | null, b: KeyRef): boolean {
  return a !== null && a.key === b.key && a.generation === b.generation
}

/** The rejection in force for this key, or `null` if it is stale or for another key. */
function activeRejection(state: KeyState, key: string): KeyRejection | null {
  const r = state.rejection
  return r !== null && r.ref.generation === state.keyGeneration && r.ref.key === key ? r : null
}

/** `open` — no rejection; `paused` — inside the cooldown; `half_open` — one retry claimable. */
export type KeyPhase = 'open' | 'paused' | 'half_open'

export function keyPhase(state: KeyState, key: string, now: number): KeyPhase {
  const r = activeRejection(state, key)
  if (r === null) return 'open'
  return now < r.retryAt ? 'paused' : 'half_open'
}

/** True when ordinary traffic may use the key: no rejection, or its cooldown has expired. */
export function isKeyUsable(state: KeyState, key: string, now: number): boolean {
  return keyPhase(state, key, now) !== 'paused'
}

/**
 * Hand the post-cooldown attempt to exactly one caller. The returned lease must be
 * presented to use or release the slot; `null` means someone else holds it.
 */
export function claimHalfOpen(state: KeyState, ref: KeyRef, now: number): { state: KeyState; leaseId: number | null } {
  if (ref.generation !== state.keyGeneration) return { state, leaseId: null }
  const r = activeRejection(state, ref.key)
  if (r === null || now < r.retryAt || r.halfOpenLease !== null) return { state, leaseId: null }
  const leaseId = state.nextLeaseId
  return { state: { ...state, nextLeaseId: leaseId + 1, rejection: { ...r, halfOpenLease: leaseId } }, leaseId }
}

/**
 * Choose the authority for a keyed attempt, claiming the half-open slot if one is
 * free. `authority: null` means the caller has to fall back to anonymous. This
 * lives beside the state it reads so that no caller reimplements the phase check
 * and ends up using a paused key.
 */
export function selectAttemptAuthority(
  state: KeyState,
  key: string,
  now: number,
): { state: KeyState; authority: AttemptAuthority | null } {
  switch (keyPhase(state, key, now)) {
    case 'open':
      return { state, authority: { kind: 'ordinary' } }
    case 'paused':
      return { state, authority: null }
    case 'half_open': {
      const claim = claimHalfOpen(state, { key, generation: state.keyGeneration }, now)
      return {
        state: claim.state,
        authority: claim.leaseId === null ? null : { kind: 'half_open', leaseId: claim.leaseId },
      }
    }
  }
}

/** Release a half-open slot. Only the exact lease holder may do so. */
export function releaseHalfOpen(state: KeyState, ref: KeyRef, leaseId: number): KeyState {
  const r = activeRejection(state, ref.key)
  if (r === null || r.halfOpenLease !== leaseId) return state
  return { ...state, rejection: { ...r, halfOpenLease: null } }
}

/**
 * Every authority must match the current generation and key, so that a bypass
 * probe can't send a key the user has already replaced. `bypass` waives the
 * cooldown and nothing else.
 */
export function isKeyedAttemptEligible(
  state: KeyState,
  ref: KeyRef,
  now: number,
  authority: AttemptAuthority,
): boolean {
  if (ref.generation !== state.keyGeneration) return false
  const r = activeRejection(state, ref.key)
  if (r === null) return true
  if (authority.kind === 'bypass') return true
  if (now < r.retryAt) return false
  return authority.kind === 'half_open' && r.halfOpenLease === authority.leaseId
}

/**
 * Record a corroborated rejection. Epoch and lease checks happen here rather than
 * at the call site, so the whole transition can be tested in one place.
 *
 * `disposition` separates stale evidence from a rejection an existing pause
 * already covers. Only stale evidence is inconclusive.
 */
export function applyRejection(
  state: KeyState,
  ref: KeyRef,
  attempt: RejectionAttempt,
  now: number,
  ladder: CooldownLadder = DEFAULT_KEY_COOLDOWN,
): { state: KeyState; shouldWarn: boolean; disposition: RejectionDisposition } {
  const stale = { state, shouldWarn: false, disposition: 'stale' as const }
  if (ref.generation !== state.keyGeneration) return stale
  // An accepted response landed between the two 403s, so they are not adjacent.
  if (attempt.expectedAuthEpoch !== state.authEpoch) return stale

  const r = activeRejection(state, ref.key)
  if (attempt.authority.kind === 'half_open') {
    // Must still hold the exact lease it was granted.
    if (r === null || r.halfOpenLease !== attempt.authority.leaseId) return stale
  } else if (r !== null && r.halfOpenLease !== null) {
    // Another operation's retry is in flight and owns the ladder. Without this a
    // bypass would advance the strike count and clear someone else's lease.
    return stale
  }
  // A live cooldown with no outstanding lease already covers this, so nothing
  // changes. The evidence is sound, so the caller still reports a rejection.
  if (r !== null && r.halfOpenLease === null && now < r.retryAt) {
    return { state, shouldWarn: false, disposition: 'already_active' }
  }

  const strikes = (r?.strikes ?? 0) + 1
  const delay = Math.min(ladder.baseMs * 2 ** (strikes - 1), ladder.maxMs)
  const alreadyWarned = sameRef(state.warnedFor, ref) || sameRef(state.pendingWarning, ref)
  return {
    state: { ...state, rejection: { ref, strikes, retryAt: now + delay, halfOpenLease: null } },
    shouldWarn: !alreadyWarned,
    disposition: 'applied',
  }
}

/**
 * An authenticated response proves the key is accepted right now. The epoch bump
 * is unconditional for the current generation, because another operation may be
 * sitting on a first 403 that must no longer be allowed to corroborate.
 */
export function recordAuthAccepted(state: KeyState, ref: KeyRef): KeyState {
  if (ref.generation !== state.keyGeneration) return state
  const accepted: KeyState = { ...state, authEpoch: state.authEpoch + 1 }
  if (activeRejection(state, ref.key) === null) return accepted
  // Clearing the warning marks lets a genuinely new rejection warn again later.
  return { ...accepted, rejection: null, warnedFor: null, pendingWarning: null }
}

export function markWarned(state: KeyState, ref: KeyRef): KeyState {
  return { ...state, warnedFor: ref, pendingWarning: null }
}

export function markPendingWarning(state: KeyState, ref: KeyRef): KeyState {
  return { ...state, pendingWarning: ref }
}

/** A deferred warning is stale once its cooldown has elapsed. */
export function isRejectionCurrent(state: KeyState, ref: KeyRef, now: number): boolean {
  const r = activeRejection(state, ref.key)
  return r !== null && sameRef(r.ref, ref) && now < r.retryAt
}

/** Advance the generation and clear all rejection state after a normalized key change. */
export function changeKey(state: KeyState): KeyState {
  return {
    keyGeneration: state.keyGeneration + 1,
    authEpoch: state.authEpoch + 1,
    nextLeaseId: state.nextLeaseId,
    rejection: null,
    warnedFor: null,
    pendingWarning: null,
  }
}
