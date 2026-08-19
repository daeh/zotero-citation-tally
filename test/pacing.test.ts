import assert from 'node:assert/strict'
import { test } from 'node:test'

import { reserveSlot } from '../src/utils/pacing.ts'

test('the first request departs immediately', () => {
  const { waitMs, nextAvailableMs } = reserveSlot(undefined, 1000, 250)
  assert.equal(waitMs, 0)
  assert.equal(nextAvailableMs, 1250)
})

test('an idle service departs immediately and re-arms', () => {
  // Reservation is in the past: the service has been idle longer than the spacing.
  const { waitMs, nextAvailableMs } = reserveSlot(500, 1000, 250)
  assert.equal(waitMs, 0)
  assert.equal(nextAvailableMs, 1250)
})

test('a busy service makes the caller wait exactly the remaining time', () => {
  const { waitMs, nextAvailableMs } = reserveSlot(1200, 1000, 250)
  assert.equal(waitMs, 200)
  assert.equal(nextAvailableMs, 1450)
})

test('concurrent callers are spaced, not released together (regression)', () => {
  // The defect: all callers read the same last-request timestamp at the same
  // instant, slept the same interval, and fired simultaneously. Here every
  // caller reads the clock at the same `now`, as concurrent callers would.
  const now = 1000
  const delay = 250
  let state: number | undefined
  const departures: number[] = []

  for (let i = 0; i < 5; i++) {
    const reservation = reserveSlot(state, now, delay)
    state = reservation.nextAvailableMs
    departures.push(now + reservation.waitMs)
  }

  assert.deepEqual(departures, [1000, 1250, 1500, 1750, 2000])
  for (let i = 1; i < departures.length; i++) {
    assert.equal(departures[i] - departures[i - 1], delay, 'departures must be spaced by the full delay')
  }
})

test('interleaving a later arrival does not let it jump the queue', () => {
  const delay = 100
  let state: number | undefined

  const a = reserveSlot(state, 0, delay)
  state = a.nextAvailableMs
  const b = reserveSlot(state, 0, delay)
  state = b.nextAvailableMs
  // Arrives later, but after the two already-reserved slots.
  const c = reserveSlot(state, 50, delay)

  assert.equal(0 + a.waitMs, 0)
  assert.equal(0 + b.waitMs, 100)
  assert.equal(50 + c.waitMs, 200)
})

test('a non-positive or non-finite delay still reserves monotonically', () => {
  for (const delay of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { waitMs, nextAvailableMs } = reserveSlot(undefined, 1000, delay)
    assert.equal(waitMs, 0, `delay=${delay}`)
    assert.equal(nextAvailableMs, 1000, `delay=${delay} must not produce NaN or Infinity state`)
  }
})
