import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  apiKeyStatusMessage,
  apiKeyStatusTone,
  cleanedCharactersMessage,
  validateDatabaseOrder,
} from '../src/modules/preferenceMessages.ts'

// Assertions here are on message ids and arguments, not on rendered English.
// Testing the text would pin down the strings Fluent exists to let us change.

test('a valid order returns the normalized databases and the valid message', () => {
  const result = validateDatabaseOrder(' Crossref , semanticscholar ')
  assert.equal(result.valid, true)
  assert.deepEqual(result.valid ? result.databases : [], ['crossref', 'semanticscholar'])
  assert.deepEqual(result.message, { id: 'pref-database-valid' })
})

test('duplicates are detected case-insensitively', () => {
  const result = validateDatabaseOrder('crossref, CROSSREF')
  assert.equal(result.valid, false)
  assert.deepEqual(result.message, { id: 'pref-database-duplicate' })
})

test('an empty or oversized order asks for 1-3 databases', () => {
  for (const input of ['', '   ', ' , , ', 'crossref, semanticscholar, inspire, crossref2']) {
    const result = validateDatabaseOrder(input)
    assert.equal(result.valid, false, `expected ${JSON.stringify(input)} to be invalid`)
  }
  assert.deepEqual(validateDatabaseOrder('').message, { id: 'pref-database-count' })
  assert.deepEqual(validateDatabaseOrder('crossref,inspire,semanticscholar').valid, true)
})

test('an unrecognised database is reported verbatim, not sanitized', () => {
  // The validator must not escape or strip. Safety comes from the renderer
  // handing this to Fluent as an argument, and Fluent writes arguments as text.
  const payload = '<img src=x onerror=alert(1)>'
  const result = validateDatabaseOrder(`crossref, ${payload}`)
  assert.equal(result.valid, false)
  assert.deepEqual(result.message, { id: 'pref-database-invalid', args: { databases: payload } })
})

test('the reported token preserves the user’s own casing', () => {
  const result = validateDatabaseOrder('CrossRef, NotADatabase')
  assert.deepEqual(result.message, { id: 'pref-database-invalid', args: { databases: 'NotADatabase' } })
})

test('every API-key status maps to a message and a tone', () => {
  const cases = [
    ['valid', 'pref-apikey-valid', 'ok'],
    ['invalid', 'pref-apikey-invalid', 'error'],
    ['unavailable', 'pref-apikey-unavailable', 'error'],
    ['client_error', 'pref-apikey-error', 'warn'],
    ['indeterminate', 'pref-apikey-indeterminate', 'warn'],
    ['empty', 'pref-apikey-empty', 'none'],
    ['checking', 'pref-apikey-checking', 'none'],
  ] as const

  for (const [status, id, tone] of cases) {
    assert.deepEqual(apiKeyStatusMessage(status), { id }, `${status} message`)
    assert.equal(apiKeyStatusTone(status), tone, `${status} tone`)
  }
})

test('states that say nothing render nothing', () => {
  for (const status of ['neutral', 'aborted'] as const) {
    assert.equal(apiKeyStatusMessage(status), null)
    assert.equal(apiKeyStatusTone(status), 'none')
  }
})

test('the cleaned note appears only when something was removed', () => {
  assert.equal(cleanedCharactersMessage([]), null)
  assert.deepEqual(cleanedCharactersMessage(['U+200B', 'U+FEFF']), {
    id: 'pref-apikey-cleaned',
    args: { characters: 'U+200B, U+FEFF' },
  })
})
