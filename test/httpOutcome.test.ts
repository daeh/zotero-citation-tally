import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyHttpStatus, parseCitationCount } from '../src/utils/httpOutcome.ts'
import { getIgnorePolicy } from '../src/modules/ignorePolicy.ts'

test('only 404 is authoritative about the item', () => {
  assert.equal(classifyHttpStatus(404), 'not_found')
})

test('429 is rate limiting', () => {
  assert.equal(classifyHttpStatus(429), 'rate_limited')
})

test('408 and 5xx are transient', () => {
  assert.equal(classifyHttpStatus(408), 'transient_error')
  for (const status of [500, 502, 503, 504, 599]) {
    assert.equal(classifyHttpStatus(status), 'transient_error', String(status))
  }
})

test('other 4xx are client errors, not not-found', () => {
  for (const status of [400, 401, 403, 405, 410, 418, 422]) {
    assert.equal(classifyHttpStatus(status), 'api_error', String(status))
  }
})

test('no failure status except 404 may be persisted (the poisoning guard)', () => {
  // This is the property that matters: a provider outage must never write a
  // persistent ignore entry, because the retry ladder would then silence the
  // item for up to 180 days.
  for (const status of [400, 401, 403, 408, 422, 429, 500, 502, 503]) {
    const classified = classifyHttpStatus(status)
    assert.notEqual(
      getIgnorePolicy(classified, true),
      'persistent',
      `HTTP ${status} classified as ${classified} must not persist`,
    )
  }
  assert.equal(getIgnorePolicy(classifyHttpStatus(404), true), 'persistent')
})

test('parseCitationCount accepts numbers and numeric strings', () => {
  assert.equal(parseCitationCount(0), 0)
  assert.equal(parseCitationCount(42), 42)
  assert.equal(parseCitationCount('42'), 42)
  assert.equal(parseCitationCount(' 42 '), 42)
})

test('parseCitationCount rejects everything that is not a count', () => {
  for (const raw of [
    undefined,
    null,
    '',
    '   ',
    'many',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    '-1',
    1.5,
    '1.5',
    1e21, // beyond safe-integer range
    {},
    [],
    true,
  ]) {
    assert.equal(parseCitationCount(raw), null, `${String(raw)} is not a valid count`)
  }
})

test('parseCitationCount does not repeat parseInt truncation', () => {
  // `parseInt('12abc')` is 12; a payload that is not cleanly numeric should be
  // rejected rather than silently truncated to a plausible-looking count.
  assert.equal(parseCitationCount('12abc'), null)
  assert.equal(parseCitationCount('42px'), null)
})
