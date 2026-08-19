import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  encodeIdentifierPath,
  extractArxivId,
  extractArxivIdFromUrl,
  normalizeDoi,
  stripArxivVersion,
} from '../src/utils/identifiers.ts'

test('extractArxivId: new-style identifiers', () => {
  assert.equal(extractArxivId('0803.3042'), '0803.3042')
  assert.equal(extractArxivId('arXiv:2301.12345'), '2301.12345')
  assert.equal(extractArxivId('arXiv: 2301.12345'), '2301.12345')
  // 5-digit sequence numbers exist since 1501.
  assert.equal(extractArxivId('1501.00001'), '1501.00001')
})

test('extractArxivId: version suffixes are preserved, not truncated', () => {
  assert.equal(extractArxivId('0803.3042v2'), '0803.3042v2')
  assert.equal(extractArxivId('arXiv:2301.12345v11'), '2301.12345v11')
  assert.equal(extractArxivId('hep-th/9711200v3'), 'hep-th/9711200v3')
})

test('extractArxivId: old-style identifiers keep their full archive name', () => {
  assert.equal(extractArxivId('hep-th/9711200'), 'hep-th/9711200')
  assert.equal(extractArxivId('math/0309136'), 'math/0309136')
  assert.equal(extractArxivId('cond-mat/0112017'), 'cond-mat/0112017')
})

test('extractArxivId: dotted subclasses are not truncated (regression)', () => {
  // `[a-z-]+/\d+` excluded `.`, so these matched as `GT/0309136` and `AI/0112017`
  // -- a wrong identifier rather than a missing one, which then 404s and lands
  // the item in the persistent ignore ladder.
  assert.equal(extractArxivId('math.GT/0309136'), 'math.GT/0309136')
  assert.equal(extractArxivId('cs.AI/0112017'), 'cs.AI/0112017')
  assert.equal(extractArxivId('arXiv:cond-mat.str-el/0506467'), 'cond-mat.str-el/0506467')
})

test('extractArxivId: does not treat arbitrary decimals as identifiers', () => {
  // `\d+\.\d+` matched any decimal, so a version string or a stray number in the
  // Extra field became an "arXiv ID" and was looked up.
  assert.equal(extractArxivId('version 1.2'), null)
  assert.equal(extractArxivId('see page 3.14'), null)
  assert.equal(extractArxivId('Citations: 42 (Crossref) [2026-08-19]'), null)
  assert.equal(extractArxivId(''), null)
})

test('extractArxivIdFromUrl: abs and pdf paths', () => {
  assert.equal(extractArxivIdFromUrl('http://arxiv.org/abs/0803.3042'), '0803.3042')
  assert.equal(extractArxivIdFromUrl('https://arxiv.org/abs/math.GT/0309136'), 'math.GT/0309136')
  assert.equal(extractArxivIdFromUrl('https://arxiv.org/pdf/2301.12345v2'), '2301.12345v2')
  assert.equal(extractArxivIdFromUrl('https://example.com/abs/0803.3042'), null)
})

test('normalizeDoi: bare and prefixed forms', () => {
  assert.equal(normalizeDoi('10.1103/PhysRevLett.116.061102'), '10.1103/PhysRevLett.116.061102')
  assert.equal(normalizeDoi('  10.1103/PhysRevLett.116.061102  '), '10.1103/PhysRevLett.116.061102')
  assert.equal(normalizeDoi('doi:10.1000/182'), '10.1000/182')
  assert.equal(normalizeDoi('DOI: 10.1000/182'), '10.1000/182')
})

test('normalizeDoi: resolver URLs', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1000/182'), '10.1000/182')
  assert.equal(normalizeDoi('http://dx.doi.org/10.1000/182'), '10.1000/182')
  assert.equal(normalizeDoi('https://www.doi.org/10.1000/182'), '10.1000/182')
})

test('normalizeDoi: `#` is content in a raw DOI but syntax in a URL', () => {
  // The DOI Handbook's own example: the suffix is opaque and may contain `#`.
  assert.equal(normalizeDoi('10.1000/456#789'), '10.1000/456#789')
  // In a URL the fragment is not part of the DOI.
  assert.equal(normalizeDoi('https://doi.org/10.1000/456#789'), '10.1000/456')
  // ...unless it was transported percent-encoded, in which case it is.
  assert.equal(normalizeDoi('https://doi.org/10.1000/456%23789'), '10.1000/456#789')
})

test('normalizeDoi: `?` follows the same rule as `#`', () => {
  assert.equal(normalizeDoi('10.1000/456?789'), '10.1000/456?789')
  assert.equal(normalizeDoi('https://doi.org/10.1000/456?utm_source=x'), '10.1000/456')
})

test('normalizeDoi: rejects non-DOIs', () => {
  assert.equal(normalizeDoi(''), null)
  assert.equal(normalizeDoi('   '), null)
  assert.equal(normalizeDoi('not a doi'), null)
  assert.equal(normalizeDoi('10.1000'), null, 'missing suffix')
  assert.equal(normalizeDoi('11.1000/182'), null, 'DOIs always start with 10.')
  assert.equal(normalizeDoi('https://example.com/10.1000/182'), null, 'not a resolver host')
})

test('encodeIdentifierPath: preserves separators, encodes the rest', () => {
  assert.equal(encodeIdentifierPath('10.1103/PhysRevLett.116.061102'), '10.1103/PhysRevLett.116.061102')
  assert.equal(encodeIdentifierPath('math.GT/0309136'), 'math.GT/0309136')
  assert.equal(encodeIdentifierPath('10.1000/456#789'), '10.1000/456%23789')
  assert.equal(encodeIdentifierPath('10.1000/456?789'), '10.1000/456%3F789')
  assert.equal(encodeIdentifierPath('10.1000/a b'), '10.1000/a%20b')
})

test('stripArxivVersion drops a trailing version (INSPIRE 404s versioned ids)', () => {
  // Measured live: /api/arxiv/1607.01652 -> 200, /api/arxiv/1607.01652v1 -> 404,
  // and the same for old-style: hep-th/9711200 -> 200, ...v3 -> 404.
  assert.equal(stripArxivVersion('1607.01652v1'), '1607.01652')
  assert.equal(stripArxivVersion('2301.12345v11'), '2301.12345')
  assert.equal(stripArxivVersion('hep-th/9711200v3'), 'hep-th/9711200')
  assert.equal(stripArxivVersion('cond-mat.str-el/0506467v2'), 'cond-mat.str-el/0506467')
})

test('stripArxivVersion leaves unversioned ids alone', () => {
  for (const id of ['1607.01652', 'hep-th/9711200', 'math.GT/0309136']) {
    assert.equal(stripArxivVersion(id), id)
  }
})

test('stripArxivVersion does not eat a DOI suffix that merely looks versioned', () => {
  // Guards the reason it is applied only on the arXiv branch: a DOI suffix is
  // opaque and may legitimately end in something shaped like `v2`.
  assert.equal(normalizeDoi('10.1234/journal.v2'), '10.1234/journal.v2')
  assert.equal(normalizeDoi('10.1234/abc-v12'), '10.1234/abc-v12')
})

test('extraction still keeps the version, so the grammar recognizes the id', () => {
  // The two responsibilities are separate: extraction must match `...v2` to
  // find the identifier at all; provider URL construction strips it.
  assert.equal(extractArxivId('arXiv:2301.12345v2'), '2301.12345v2')
  assert.equal(stripArxivVersion(extractArxivId('arXiv:2301.12345v2') ?? ''), '2301.12345')
})
