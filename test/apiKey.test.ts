import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeApiKey } from '../src/utils/apiKey.ts'

const KEY = '0123456789abcdef0123456789abcdef01234567'

/** Built from code points on purpose: these characters are invisible in source. */
const ARTIFACTS: readonly [number, string][] = [
  [0x200b, 'U+200B'],
  [0x200c, 'U+200C'],
  [0x200d, 'U+200D'],
  [0xfeff, 'U+FEFF'],
  [0x00a0, 'U+00A0'],
  [0x000d, 'U+000D'],
  [0x000a, 'U+000A'],
]

const ch = (codePoint: number) => String.fromCodePoint(codePoint)
const contaminate = (codePoint: number) => `${KEY.slice(0, 20)}${ch(codePoint)}${KEY.slice(20)}`

test('a clean key is returned untouched', () => {
  assert.deepEqual(normalizeApiKey(KEY), { key: KEY, changed: false, removed: [], unusable: [] })
})

test('non-string input yields an empty result, not a throw', () => {
  for (const input of [undefined, null, 42, {}, []]) {
    assert.deepEqual(normalizeApiKey(input), { key: '', changed: false, removed: [], unusable: [] })
  }
})

test('characters that survive but cannot be sent are reported, not silently kept', () => {
  // U+2060 is not in the strip set and would throw at Headers construction.
  const wordJoiner = normalizeApiKey(`${KEY.slice(0, 20)}${ch(0x2060)}${KEY.slice(20)}`)
  assert.deepEqual(wordJoiner.removed, [])
  assert.deepEqual(wordJoiner.unusable, ['U+2060'])
  assert.throws(() => new Headers({ 'x-api-key': wordJoiner.key }), TypeError)

  const nul = normalizeApiKey(`${KEY}${ch(0x00)}`)
  assert.deepEqual(nul.unusable, ['U+0000'])

  assert.deepEqual(normalizeApiKey(KEY).unusable, [], 'a clean key reports nothing unusable')
})

test('the unusable predicate matches what Headers actually refuses', () => {
  // NUL, LF, CR and anything above U+00FF throw; other C0 controls and DEL are
  // accepted. See `unusableCodePoints` for why we don't flag more than that.
  for (const codePoint of [0x01, 0x08, 0x1f, 0x7f, 0xff]) {
    const candidate = `${KEY.slice(0, 20)}${ch(codePoint)}${KEY.slice(20)}`
    const result = normalizeApiKey(candidate)
    assert.doesNotThrow(() => new Headers({ 'x-api-key': result.key }))
    assert.deepEqual(result.unusable, [], `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} is sendable`)
  }

  // Every value the predicate does flag must genuinely be refused.
  for (const codePoint of [0x00, 0x100, 0x2060, 0x1f600]) {
    const result = normalizeApiKey(`${KEY}${ch(codePoint)}`)
    assert.notDeepEqual(result.unusable, [])
    assert.throws(() => new Headers({ 'x-api-key': result.key }), TypeError)
  }
})

test('boundary whitespace is trimmed without being reported as a removed character', () => {
  const result = normalizeApiKey(`  ${KEY}\t`)
  assert.equal(result.key, KEY)
  assert.equal(result.changed, true)
  assert.deepEqual(result.removed, [])
})

test('each enumerated artifact is stripped and reported by label', () => {
  for (const [codePoint, label] of ARTIFACTS) {
    const result = normalizeApiKey(contaminate(codePoint))
    assert.equal(result.key, KEY, `interior ${label} must be removed`)
    assert.equal(result.changed, true)
    assert.deepEqual(result.removed, [label])
  }
})

test('a key wrapped across lines is rejoined', () => {
  const result = normalizeApiKey(`${KEY.slice(0, 20)}\r\n${KEY.slice(20)}`)
  assert.equal(result.key, KEY)
  assert.deepEqual(result.removed.toSorted(), ['U+000A', 'U+000D'])
})

test('labels are stable identifiers, never the raw characters', () => {
  const { removed } = normalizeApiKey(`${KEY}${ch(0x200b)}${ch(0xfeff)}`)
  assert.deepEqual(removed.toSorted(), ['U+200B', 'U+FEFF'])
  for (const label of removed) assert.match(label, /^U\+[0-9A-F]{4}$/)
})

test('interior ordinary spaces are left alone — no key alphabet is published', () => {
  const spaced = `${KEY.slice(0, 10)} ${KEY.slice(10)}`
  const result = normalizeApiKey(spaced)
  assert.equal(result.key, spaced)
  assert.equal(result.changed, false)
})

test('normalization is what makes a contaminated key usable as a Headers value', () => {
  // Above U+00FF, ByteString conversion throws and the request never reaches the wire;
  // at or below it the bytes are sent and Semantic Scholar answers 403 instead.
  const throwing = `${KEY}${ch(0x200b)}`
  assert.throws(() => new Headers({ 'x-api-key': throwing }), TypeError)
  assert.doesNotThrow(() => new Headers({ 'x-api-key': normalizeApiKey(throwing).key }))

  const wireBound = `${KEY}${ch(0x00a0)}`
  assert.doesNotThrow(() => new Headers({ 'x-api-key': wireBound }))
  assert.equal(normalizeApiKey(wireBound).key, KEY)
})
