/**
 * Contract for the build guard that keeps zotero-plugin-toolkit's bridge links out of the XPI.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { findForbidden, scanBuild } from '../utils/check-toolkit-bridges.ts'

const BUNDLE = 'content/scripts/plugin.js'

function makeTree(t: TestContext, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'toolkit-bridges-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [file, text] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  return root
}

test('findForbidden reports both keys and the accessor with 1-based lines', () => {
  const text = [
    'ok',
    '_extensions["zotero://plugin"] = x',
    'Services.io.getProtocolHandler("zotero")',
    'k = "zotero://ztoolkit-debug";',
  ].join('\n')
  assert.deepEqual(findForbidden(text), [
    { line: 2, match: 'zotero://plugin' },
    { line: 3, match: 'getProtocolHandler' },
    { line: 4, match: 'zotero://ztoolkit-debug' },
  ])
})

test('findForbidden ignores other zotero:// links and empty input', () => {
  assert.deepEqual(findForbidden('zotero://plugins/x zotero://select/library'), [])
  assert.deepEqual(findForbidden(''), [])
})

test('scanBuild passes a clean tree', (t) => {
  const root = makeTree(t, { [BUNDLE]: 'console.log(1)\n', 'bootstrap.js': 'var x = 1\n' })
  assert.deepEqual(scanBuild(root, BUNDLE), [])
})

test('scanBuild reports hits outside the bundle', (t) => {
  const root = makeTree(t, { [BUNDLE]: 'clean\n', 'bootstrap.js': 'a\nb\n"zotero://ztoolkit-debug"\n' })
  assert.deepEqual(scanBuild(root, BUNDLE), [{ file: 'bootstrap.js', line: 3, match: 'zotero://ztoolkit-debug' }])
})

test('scanBuild throws when the expected bundle is missing', (t) => {
  const root = makeTree(t, { 'bootstrap.js': 'clean\n' })
  assert.throws(() => scanBuild(root, BUNDLE), /expected bundle is not a regular file/)
})

test('scanBuild throws when the expected bundle is a directory', (t) => {
  const root = makeTree(t, { [`${BUNDLE}/inner.js`]: 'clean\n' })
  assert.throws(() => scanBuild(root, BUNDLE), /expected bundle is not a regular file/)
})
