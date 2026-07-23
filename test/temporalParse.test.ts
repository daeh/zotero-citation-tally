import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  parseCitationStampDate,
  parseDateAddedInstant,
  parseLastCheckedInstant,
  parseRetryAfterMs,
} from '../src/utils/temporalParse.ts'

const NOW = Temporal.Instant.from('2026-07-21T00:00:00Z').epochMilliseconds

test('parseCitationStampDate accepts YYYY-MM-DD and non-padded YYYY-M-D', () => {
  assert.equal(parseCitationStampDate('2026-07-21')?.toString(), '2026-07-21')
  assert.equal(parseCitationStampDate('2025-2-3')?.toString(), '2025-02-03')
})

test('parseCitationStampDate rejects malformed input', () => {
  assert.equal(parseCitationStampDate('2026-13-01'), null)
  assert.equal(parseCitationStampDate('2026-02-30'), null)
  assert.equal(parseCitationStampDate('garbage'), null)
})

test('parseLastCheckedInstant round-trips ISO, null on garbage', () => {
  assert.ok(parseLastCheckedInstant('2026-07-21T00:00:00.123Z') instanceof Temporal.Instant)
  assert.equal(parseLastCheckedInstant('not-a-date'), null)
})

test('parseDateAddedInstant parses Zotero SQL UTC datetime', () => {
  assert.equal(parseDateAddedInstant('2026-07-21 08:30:00')?.toString(), '2026-07-21T08:30:00Z')
  assert.equal(parseDateAddedInstant(''), null)
  assert.equal(parseDateAddedInstant('bad'), null)
})

test('parseRetryAfterMs: delta-seconds', () => {
  assert.equal(parseRetryAfterMs('120', NOW), 120_000)
  assert.equal(parseRetryAfterMs('0', NOW), 0)
  assert.equal(parseRetryAfterMs('-5', NOW), null)
  assert.equal(parseRetryAfterMs('garbage', NOW), null)
})

test('parseRetryAfterMs: IMF-fixdate (future and past)', () => {
  assert.equal(parseRetryAfterMs('Tue, 21 Jul 2026 01:00:00 GMT', NOW), 3_600_000)
  assert.equal(parseRetryAfterMs('Mon, 20 Jul 2026 00:00:00 GMT', NOW), 0)
})

test('parseRetryAfterMs: RFC-850 with 2-digit-year rollover', () => {
  assert.equal(parseRetryAfterMs('Tuesday, 21-Jul-26 01:00:00 GMT', NOW), 3_600_000)
})

test('parseRetryAfterMs: asctime, incl. space-padded single-digit day', () => {
  assert.equal(parseRetryAfterMs('Thu Jul 30 00:00:00 2026', NOW), 9 * 86_400_000)
  assert.equal(parseRetryAfterMs('Sat Aug  1 00:00:00 2026', NOW), 11 * 86_400_000)
})

test('parseRetryAfterMs: leap second :60 normalized to :59 + 1s', () => {
  assert.equal(parseRetryAfterMs('Tue, 21 Jul 2026 00:00:60 GMT', NOW), 60_000)
})

test('parseRetryAfterMs: unparseable HTTP-date → null (caller falls back to backoff)', () => {
  assert.equal(parseRetryAfterMs('Xyz, 99 Zzz 2026 99:99:99 GMT', NOW), null)
})
