import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  IGNORE_STORE_VERSION,
  emptyIgnoreStore,
  getIgnoreRecord,
  parseIgnoreStore,
  serializeIgnoreStore,
} from '../src/utils/ignoreStore.ts'

const RECORD = { count: 2, lastChecked: '2026-08-19T00:00:00.000Z' }

function currentStoreJson(): string {
  return JSON.stringify({ version: IGNORE_STORE_VERSION, entries: { crossref: { '42': RECORD } } })
}

test('an absent or empty pref reads as an empty store', () => {
  assert.deepEqual(parseIgnoreStore(undefined), emptyIgnoreStore())
  assert.deepEqual(parseIgnoreStore(null), emptyIgnoreStore())
  assert.deepEqual(parseIgnoreStore(''), emptyIgnoreStore())
  assert.deepEqual(parseIgnoreStore('{}'), emptyIgnoreStore())
})

test('current-schema entries round-trip', () => {
  const store = parseIgnoreStore(currentStoreJson())
  assert.equal(store.version, IGNORE_STORE_VERSION)
  assert.deepEqual(getIgnoreRecord(store, 'crossref', 42), RECORD)
  assert.deepEqual(parseIgnoreStore(serializeIgnoreStore(store)), store)
})

test('v1 entries are discarded, not carried forward (migration)', () => {
  // v1 stored only {count,lastChecked} and persisted provider failures next to
  // genuine not-found results, so a poisoned entry cannot be told from a real
  // one. Keeping them would leave affected items silenced by the very release
  // that fixes the cause.
  const legacy = JSON.stringify({ crossref: { '42': RECORD }, inspire: { '7': RECORD } })
  const store = parseIgnoreStore(legacy)
  assert.deepEqual(store, emptyIgnoreStore())
  assert.equal(getIgnoreRecord(store, 'crossref', 42), undefined)
})

test('migration is idempotent across repeated startups', () => {
  const legacy = JSON.stringify({ crossref: { '42': RECORD } })
  const first = parseIgnoreStore(legacy)
  const persisted = serializeIgnoreStore(first)
  const second = parseIgnoreStore(persisted)
  const third = parseIgnoreStore(serializeIgnoreStore(second))
  assert.deepEqual(second, first)
  assert.deepEqual(third, first)
})

test('a future schema version is discarded rather than misread', () => {
  const future = JSON.stringify({ version: IGNORE_STORE_VERSION + 1, entries: { crossref: { '42': RECORD } } })
  assert.deepEqual(parseIgnoreStore(future), emptyIgnoreStore())
})

test('corrupt data fails open, suppressing nothing', () => {
  for (const raw of ['not json', '[1,2,3]', '{"version":2,"entries":[]}', 'null', '"a string"']) {
    const store = parseIgnoreStore(raw)
    assert.deepEqual(store.entries, {}, `should fail open for ${raw}`)
  }
})

test('malformed individual records are dropped, valid siblings kept', () => {
  const mixed = JSON.stringify({
    version: IGNORE_STORE_VERSION,
    entries: {
      crossref: {
        '1': RECORD,
        '2': { count: 'many', lastChecked: '2026-08-19T00:00:00.000Z' },
        '3': { count: 1 },
        '4': { count: -1, lastChecked: '2026-08-19T00:00:00.000Z' },
        '5': null,
      },
      inspire: 'not an object',
    },
  })
  const store = parseIgnoreStore(mixed)
  assert.deepEqual(getIgnoreRecord(store, 'crossref', 1), RECORD)
  for (const id of [2, 3, 4, 5]) {
    assert.equal(getIgnoreRecord(store, 'crossref', id), undefined, `record ${id} is malformed`)
  }
  assert.equal(store.entries.inspire, undefined)
})

test('databases left with no valid records are omitted entirely', () => {
  const raw = JSON.stringify({ version: IGNORE_STORE_VERSION, entries: { crossref: { '1': { count: 'x' } } } })
  assert.deepEqual(parseIgnoreStore(raw).entries, {})
})
