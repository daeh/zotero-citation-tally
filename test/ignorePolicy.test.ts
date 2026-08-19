import assert from 'node:assert/strict'
import { test } from 'node:test'

import { getIgnorePolicy } from '../src/modules/ignorePolicy.ts'

import type { LookupStatus } from '../src/modules/citationTypes.ts'

test('only an authoritative not-found is persistent', () => {
  assert.equal(getIgnorePolicy('not_found', false), 'persistent')
  assert.equal(getIgnorePolicy('not_found', true), 'persistent')
})

test('a missing identifier is cached for the session only', () => {
  assert.equal(getIgnorePolicy('no_identifier', true), 'session')
  assert.equal(getIgnorePolicy('no_identifier', false), 'session')
})

test('provider failures never suppress an item (regression)', () => {
  // `api_error` used to return 'persistent' under auto-update. Combined with
  // the call site collapsing every non-404 failure into `api_error`, and with
  // Crossref not checking response status before parsing, a single transient
  // outage could silence an item for up to 180 days.
  for (const status of ['api_error', 'rate_limited', 'transient_error'] as const) {
    for (const isAutoUpdate of [true, false]) {
      assert.equal(
        getIgnorePolicy(status, isAutoUpdate),
        'none',
        `${status} (isAutoUpdate=${isAutoUpdate}) must not suppress the item`,
      )
    }
  }
})

test('success never writes an ignore entry', () => {
  assert.equal(getIgnorePolicy('success', true), 'none')
  assert.equal(getIgnorePolicy('success', false), 'none')
})

test('the policy is total over LookupStatus', () => {
  // Adding a status without deciding its cache policy is the failure this
  // guards: the `default` arm would silently give it 'none'.
  const all: LookupStatus[] = ['success', 'not_found', 'no_identifier', 'rate_limited', 'transient_error', 'api_error']
  const expected: Record<LookupStatus, string> = {
    success: 'none',
    not_found: 'persistent',
    no_identifier: 'session',
    rate_limited: 'none',
    transient_error: 'none',
    api_error: 'none',
  }
  for (const status of all) {
    assert.equal(getIgnorePolicy(status, true), expected[status], status)
  }
})
