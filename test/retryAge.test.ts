import assert from 'node:assert/strict'
import { test } from 'node:test'

import { retryAgeExceeded } from '../src/utils/retryAge.ts'

const NOW = Temporal.Instant.from('2026-07-21T00:00:00Z')
const daysAgo = (n: number): Temporal.Instant => NOW.subtract({ hours: 24 * n })

test('retry thresholds escalate with the failure count', () => {
  assert.equal(retryAgeExceeded(1, daysAgo(8), NOW), true)
  assert.equal(retryAgeExceeded(1, daysAgo(6), NOW), false)
  assert.equal(retryAgeExceeded(2, daysAgo(31), NOW), true)
  assert.equal(retryAgeExceeded(2, daysAgo(29), NOW), false)
  assert.equal(retryAgeExceeded(3, daysAgo(91), NOW), true)
  assert.equal(retryAgeExceeded(5, daysAgo(181), NOW), true)
  assert.equal(retryAgeExceeded(5, daysAgo(179), NOW), false)
})

test('count 0/unexpected and malformed lastChecked → retry now', () => {
  assert.equal(retryAgeExceeded(0, daysAgo(1), NOW), true)
  assert.equal(retryAgeExceeded(1, null, NOW), true)
})
