import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CITATION_KEY_PATTERN,
  buildCitationLinePatterns,
  escapeRegExp,
  formatCitationLine,
  insertBeforeMatch,
  stripCitationLines,
} from '../src/utils/extraField.ts'

const TITLES = ['Crossref', 'INSPIRE', 'Semantic Scholar']

function strip(line: string): { kept: string[]; removed: string[] } {
  return stripCitationLines([line], TITLES)
}

test('formatCitationLine writes the current format', () => {
  assert.equal(formatCitationLine('Crossref', 42, '2026-08-19'), 'Citations: 42 (Crossref) [2026-08-19]')
})

test('the current format round-trips through the strip patterns', () => {
  const line = formatCitationLine('Crossref', 42, '2026-08-19')
  assert.deepEqual(strip(line).removed, [line])
})

test('legacy format: "Citations (Crossref): 42" is stripped (regression)', () => {
  // This is the `\d` identity-escape bug. The pattern compiled as `d+`, so this
  // line survived every rewrite and accumulated in the Extra field.
  const line = 'Citations (Crossref): 42'
  assert.deepEqual(strip(line).removed, [line], 'legacy count line must be stripped')
})

test('the `\\d` patterns match digits, not the letter d', () => {
  // Guards the specific failure: `d+` matched runs of `d`, so a line of `d`s
  // was removed while a real count was kept -- exactly inverted.
  assert.deepEqual(strip('Citations (Crossref): ddd').removed, [], 'letters are not a count')
  assert.deepEqual(strip('Citations (Crossref): 7').removed, ['Citations (Crossref): 7'])
})

test('every historical citation-line format is stripped', () => {
  const lines = [
    'Citations: 42 (Crossref) [2026-08-19]',
    'Citation Count: 42 (INSPIRE) [2026-08-19]',
    'Citations (Semantic Scholar): 42',
    '42 citations (Crossref)',
    '42 citations (INSPIRE) [2026-08-19]',
    '7 citations (Semantic Scholar/arXiv) [2025-01-02]',
  ]
  const { kept, removed } = stripCitationLines(lines, TITLES)
  assert.deepEqual(kept, [])
  assert.equal(removed.length, lines.length)
})

test('unrelated Extra content is preserved', () => {
  const lines = [
    'Citation Key: smith2020',
    'PMID: 12345678',
    'tex.ids: something',
    'A note mentioning citations in prose.',
    'Citations are discussed on page 4.',
  ]
  const { kept, removed } = stripCitationLines(lines, TITLES)
  assert.deepEqual(removed, [])
  assert.deepEqual(kept, lines)
})

test('database names containing regex metacharacters are escaped', () => {
  // Names come from FTL, so a translator can legitimately introduce these.
  const titles = ['Semantic Scholar (S2)', 'Crossref+', 'a.b']
  const line = 'Citations: 42 (Semantic Scholar (S2)) [2026-08-19]'
  assert.deepEqual(stripCitationLines([line], titles).removed, [line])

  // Unescaped, `a.b` would match `axb`; escaped, it must not.
  assert.deepEqual(stripCitationLines(['Citations: 1 (axb) [2026-08-19]'], titles).removed, [])
  assert.deepEqual(stripCitationLines(['Citations: 1 (a.b) [2026-08-19]'], titles).removed, [
    'Citations: 1 (a.b) [2026-08-19]',
  ])
})

test('a name with unbalanced parens does not throw', () => {
  // Unescaped this is a syntax error, not merely a wrong match.
  assert.doesNotThrow(() => buildCitationLinePatterns(['Crossref )(']))
})

test('insertBeforeMatch places the stamp above a Better BibTeX citation key', () => {
  const lines = ['PMID: 1', 'Citation Key: smith2020']
  insertBeforeMatch(lines, CITATION_KEY_PATTERN, 'Citations: 5 (Crossref) [2026-08-19]')
  assert.deepEqual(lines, ['PMID: 1', 'Citations: 5 (Crossref) [2026-08-19]', 'Citation Key: smith2020'])
})

test('insertBeforeMatch appends when there is no citation key', () => {
  const lines = ['PMID: 1']
  insertBeforeMatch(lines, CITATION_KEY_PATTERN, 'Citations: 5 (Crossref) [2026-08-19]')
  assert.deepEqual(lines, ['PMID: 1', 'Citations: 5 (Crossref) [2026-08-19]'])
})

test('escapeRegExp escapes every metacharacter it claims to', () => {
  assert.equal(
    escapeRegExp('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o'),
    'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o',
  )
  assert.equal(escapeRegExp('plain'), 'plain')
})
