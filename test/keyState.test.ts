import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyRejection,
  type AttemptAuthority,
  changeKey,
  claimHalfOpen,
  DEFAULT_KEY_COOLDOWN,
  initialKeyState,
  isKeyedAttemptEligible,
  isKeyUsable,
  isRejectionCurrent,
  type KeyState,
  keyPhase,
  markWarned,
  recordAuthAccepted,
  releaseHalfOpen,
  selectAttemptAuthority,
} from '../src/modules/semanticScholarKeyState.ts'

const A = { key: 'A', generation: 0 }
const ORDINARY: AttemptAuthority = { kind: 'ordinary' }
const BYPASS: AttemptAuthority = { kind: 'bypass' }
const T0 = 1_000
const AFTER_COOLDOWN = T0 + DEFAULT_KEY_COOLDOWN.baseMs + 1

/** Corroborated rejection of A at `T0`, from ordinary traffic. */
function paused(state: KeyState = initialKeyState(), now = T0): KeyState {
  return applyRejection(state, A, { expectedAuthEpoch: state.authEpoch, authority: ORDINARY }, now).state
}

test('A→B→A re-enables A (rejection is generation-scoped)', () => {
  let s = paused()
  assert.equal(isKeyUsable(s, 'A', T0), false)
  s = changeKey(s)
  assert.equal(isKeyUsable(s, 'A', T0), true)
  assert.equal(isKeyUsable(s, 'B', T0), true)
  s = changeKey(s)
  assert.equal(isKeyUsable(s, 'A', T0), true)
})

test('a stale rejection neither pauses the current key nor warns', () => {
  const s = changeKey(initialKeyState())
  const r = applyRejection(s, A, { expectedAuthEpoch: s.authEpoch, authority: ORDINARY }, T0)
  assert.equal(r.shouldWarn, false)
  assert.equal(isKeyUsable(r.state, 'A', T0), true)
})

test('warn only once per rejection, but again after a demonstrated recovery', () => {
  let s = paused()
  s = markWarned(s, A)
  assert.equal(applyRejection(s, A, { expectedAuthEpoch: s.authEpoch, authority: ORDINARY }, T0).shouldWarn, false)

  s = recordAuthAccepted(s, A)
  const fresh = applyRejection(s, A, { expectedAuthEpoch: s.authEpoch, authority: ORDINARY }, AFTER_COOLDOWN)
  assert.equal(fresh.shouldWarn, true, 'a new incident after recovery is worth reporting')
})

test('eligibility requires the current generation, and bypass waives only the cooldown', () => {
  let s = initialKeyState()
  assert.equal(isKeyedAttemptEligible(s, A, T0, ORDINARY), true)
  assert.equal(isKeyedAttemptEligible(s, { key: 'A', generation: 5 }, T0, ORDINARY), false)

  s = paused(s)
  assert.equal(isKeyedAttemptEligible(s, A, T0, ORDINARY), false)
  assert.equal(isKeyedAttemptEligible(s, A, T0, BYPASS), true)
  assert.equal(
    isKeyedAttemptEligible(s, { key: 'A', generation: 5 }, T0, BYPASS),
    false,
    'a bypass must never transmit a superseded key',
  )
})

test('the pause is time-boxed and the ladder doubles on re-latch', () => {
  const first = paused()
  assert.equal(keyPhase(first, 'A', T0), 'paused')
  assert.equal(keyPhase(first, 'A', AFTER_COOLDOWN), 'half_open')
  assert.equal(first.rejection?.retryAt, T0 + DEFAULT_KEY_COOLDOWN.baseMs)

  // The half-open retry fails again: strike 2, double the wait.
  const claim = claimHalfOpen(first, A, AFTER_COOLDOWN)
  const authority: AttemptAuthority = { kind: 'half_open', leaseId: claim.leaseId! }
  const second = applyRejection(
    claim.state,
    A,
    { expectedAuthEpoch: claim.state.authEpoch, authority },
    AFTER_COOLDOWN,
  ).state
  assert.equal(second.rejection?.strikes, 2)
  assert.equal(second.rejection?.retryAt, AFTER_COOLDOWN + 2 * DEFAULT_KEY_COOLDOWN.baseMs)
})

test('the cooldown ladder is capped', () => {
  let s = initialKeyState()
  let now = T0
  let lastDelay = 0
  // The first strike comes from ordinary traffic; every later one from the
  // half-open retry, which is the only authority allowed to advance the ladder.
  let authority: AttemptAuthority = ORDINARY
  for (let i = 0; i < 12; i++) {
    const before = now
    s = applyRejection(s, A, { expectedAuthEpoch: s.authEpoch, authority }, now).state
    lastDelay = s.rejection!.retryAt - before
    now = s.rejection!.retryAt
    const claim = claimHalfOpen(s, A, now)
    s = claim.state
    authority = { kind: 'half_open', leaseId: claim.leaseId! }
  }
  assert.equal(s.rejection!.strikes, 12)
  assert.equal(lastDelay, DEFAULT_KEY_COOLDOWN.maxMs)
})

test('only one caller claims the half-open slot', () => {
  const s = paused()
  const first = claimHalfOpen(s, A, AFTER_COOLDOWN)
  assert.notEqual(first.leaseId, null)
  const second = claimHalfOpen(first.state, A, AFTER_COOLDOWN)
  assert.equal(second.leaseId, null, 'a second caller must fall back to anonymous')

  // Releasing with the wrong token must not free someone else's slot.
  const meddled = releaseHalfOpen(first.state, A, first.leaseId! + 99)
  assert.equal(claimHalfOpen(meddled, A, AFTER_COOLDOWN).leaseId, null)

  const released = releaseHalfOpen(first.state, A, first.leaseId!)
  assert.notEqual(claimHalfOpen(released, A, AFTER_COOLDOWN).leaseId, null)
})

test('selectAttemptAuthority yields ordinary, then nothing, then exactly one half-open', () => {
  const open = selectAttemptAuthority(initialKeyState(), 'A', T0)
  assert.deepEqual(open.authority, ORDINARY)

  const s = paused()
  assert.equal(selectAttemptAuthority(s, 'A', T0).authority, null, 'paused callers go anonymous')

  const first = selectAttemptAuthority(s, 'A', AFTER_COOLDOWN)
  assert.equal(first.authority?.kind, 'half_open')
  assert.equal(selectAttemptAuthority(first.state, 'A', AFTER_COOLDOWN).authority, null)
})

test('concurrent duplicate rejections advance the ladder once', () => {
  const s = paused()
  const duplicate = applyRejection(s, A, { expectedAuthEpoch: s.authEpoch, authority: ORDINARY }, T0 + 1)
  assert.equal(duplicate.state, s, 'a live cooldown already covers this incident')
  assert.equal(duplicate.shouldWarn, false)
  // Sound evidence, but no state change needed. Different from stale evidence:
  // the caller still has to report this as a rejection.
  assert.equal(duplicate.disposition, 'already_active')
})

test('the disposition separates stale evidence from an already-active pause', () => {
  const s = initialKeyState()
  assert.equal(applyRejection(s, A, { expectedAuthEpoch: s.authEpoch, authority: ORDINARY }, T0).disposition, 'applied')

  const staleEpoch = applyRejection(s, A, { expectedAuthEpoch: s.authEpoch + 5, authority: ORDINARY }, T0)
  assert.equal(staleEpoch.disposition, 'stale')

  const staleGeneration = applyRejection(
    s,
    { key: 'A', generation: 9 },
    { expectedAuthEpoch: s.authEpoch, authority: ORDINARY },
    T0,
  )
  assert.equal(staleGeneration.disposition, 'stale')
})

test('a bypass cannot advance the ladder or clear a held half-open lease', () => {
  const claimed = claimHalfOpen(paused(), A, AFTER_COOLDOWN)
  assert.notEqual(claimed.leaseId, null)

  // Validate corroborates two 403s while the background retry is still in flight.
  const bypassed = applyRejection(
    claimed.state,
    A,
    { expectedAuthEpoch: claimed.state.authEpoch, authority: BYPASS },
    AFTER_COOLDOWN,
  )
  assert.equal(bypassed.disposition, 'stale', 'the lease holder owns the ladder')
  assert.equal(bypassed.state, claimed.state)
  assert.equal(claimed.state.rejection!.strikes, 1)
  assert.equal(claimed.state.rejection!.halfOpenLease, claimed.leaseId)

  // A successful bypass may still clear the whole pause.
  assert.equal(recordAuthAccepted(claimed.state, A).rejection, null)
})

test('an acceptance between two 403s invalidates the pair via the epoch', () => {
  const s = initialKeyState()
  const epochAtFirstFailure = s.authEpoch
  const accepted = recordAuthAccepted(s, A) // another operation succeeded meanwhile
  const late = applyRejection(accepted, A, { expectedAuthEpoch: epochAtFirstFailure, authority: ORDINARY }, T0)
  assert.equal(late.state, accepted, 'the two failures were not adjacent')
  assert.equal(isKeyUsable(late.state, 'A', T0), true)
})

test('a stale-generation acceptance cannot clear a current rejection', () => {
  // A→B→A: the first A generation is 0, the revived A is generation 2.
  let s = paused()
  s = changeKey(s) // B
  s = changeKey(s) // A again
  s = applyRejection(s, { key: 'A', generation: 2 }, { expectedAuthEpoch: s.authEpoch, authority: ORDINARY }, T0).state
  assert.equal(isKeyUsable(s, 'A', T0), false)

  const stale = recordAuthAccepted(s, { key: 'A', generation: 0 })
  assert.equal(stale, s, 'a delayed success from an earlier generation proves nothing now')
  assert.equal(isKeyUsable(stale, 'A', T0), false)
})

test('acceptance clears the pause and the warning marks', () => {
  let s = markWarned(paused(), A)
  s = recordAuthAccepted(s, A)
  assert.equal(s.rejection, null)
  assert.equal(s.warnedFor, null)
  assert.equal(isKeyUsable(s, 'A', T0), true)
})

test('a deferred warning is stale once its cooldown has elapsed', () => {
  const s = paused()
  assert.equal(isRejectionCurrent(s, A, T0), true)
  assert.equal(isRejectionCurrent(s, A, AFTER_COOLDOWN), false)
})
