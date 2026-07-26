import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  effectiveDatabases,
  SEMANTIC_SCHOLAR_DATABASE,
  semanticScholarUnavailableResult,
} from '../src/modules/citationTypes.ts'
import { getIgnorePolicy } from '../src/modules/ignorePolicy.ts'

test('degraded Semantic Scholar result can never create ignored-item entries', () => {
  const result = semanticScholarUnavailableResult()
  assert.equal(result.status, 'transient_error')
  assert.equal(result.count, -1)
  assert.equal(getIgnorePolicy(result.status, true), 'none')
  assert.equal(getIgnorePolicy(result.status, false), 'none')
})

test('effectiveDatabases drops Semantic Scholar exactly when unavailable', () => {
  assert.deepEqual(effectiveDatabases([SEMANTIC_SCHOLAR_DATABASE], false), [])
  assert.deepEqual(effectiveDatabases(['crossref', SEMANTIC_SCHOLAR_DATABASE, 'inspire'], false), [
    'crossref',
    'inspire',
  ])
  assert.deepEqual(effectiveDatabases(['crossref', SEMANTIC_SCHOLAR_DATABASE], true), [
    'crossref',
    SEMANTIC_SCHOLAR_DATABASE,
  ])
  assert.deepEqual(effectiveDatabases([], false), [])
  assert.deepEqual(effectiveDatabases(['crossref', 'inspire'], false), ['crossref', 'inspire'])
})
