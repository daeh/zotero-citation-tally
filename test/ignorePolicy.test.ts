import assert from 'node:assert/strict'
import { test } from 'node:test'

import { getIgnorePolicy } from '../src/modules/ignorePolicy.ts'

test('ignore policy preserves the exact existing behavior', () => {
  assert.equal(getIgnorePolicy('not_found', false), 'persistent')
  assert.equal(getIgnorePolicy('not_found', true), 'persistent')
  assert.equal(getIgnorePolicy('no_identifier', true), 'session')
  assert.equal(getIgnorePolicy('no_identifier', false), 'session')
  assert.equal(getIgnorePolicy('api_error', true), 'persistent')
  assert.equal(getIgnorePolicy('api_error', false), 'none')
  assert.equal(getIgnorePolicy('success', true), 'none')
  assert.equal(getIgnorePolicy('rate_limited', true), 'none')
  assert.equal(getIgnorePolicy('transient_error', true), 'none')
  assert.equal(getIgnorePolicy('transient_error', false), 'none')
})
