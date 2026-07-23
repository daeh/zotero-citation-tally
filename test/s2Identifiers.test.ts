import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ItemIdentifier } from '../src/modules/citationTypes.ts'
import { toS2PaperRefs } from '../src/utils/s2Identifiers.ts'

const doi = (id: string): ItemIdentifier => ({ type: 'doi', id, source: 'DOI' })
const arxiv = (id: string): ItemIdentifier => ({ type: 'arxiv', id, source: 'archiveID' })

const ids = (input: ItemIdentifier[]): string[] => toS2PaperRefs(input).map((r) => r.paperId)

test('DOI uses the DOI: scheme; slash kept, reserved chars encoded', () => {
  assert.deepEqual(ids([doi('10.1/abc')]), ['DOI:10.1/abc'])
  assert.deepEqual(ids([doi('10.1/a b')]), ['DOI:10.1/a%20b'])
})

test('arXiv DOI extracts the arXiv id and uses ARXIV:', () => {
  assert.deepEqual(ids([doi('10.48550/arXiv.2201.02177')]), ['ARXIV:2201.02177'])
})

test('old-style arXiv id keeps its slash; leading arXiv: prefix stripped', () => {
  assert.deepEqual(ids([arxiv('hep-th/9901001')]), ['ARXIV:hep-th/9901001'])
  assert.deepEqual(ids([arxiv('arXiv:2201.02177')]), ['ARXIV:2201.02177'])
})

test('de-duplicates case-insensitively, preserving order', () => {
  assert.deepEqual(ids([doi('10.1/ABC'), doi('10.1/abc'), arxiv('2201.02177')]), ['DOI:10.1/ABC', 'ARXIV:2201.02177'])
})

test('blank/empty identifiers are dropped', () => {
  assert.deepEqual(toS2PaperRefs([doi('  '), arxiv('')]), [])
})
