/**
 * Append legacy update entries to the scaffold-generated update JSON so older Zotero versions auto-update to the last compatible release.
 *
 * Patches whichever of update.json / update-beta.json exists in .scaffold/build/.
 * Runs after `zotero-plugin build`.
 */

import console from 'node:console'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const LEGACY_ENTRIES = [
  {
    version: '0.0.12',
    update_link: 'https://github.com/daeh/zotero-citation-tally/releases/download/v0.0.12/citation-tally.xpi',
    applications: {
      zotero: { strict_min_version: '7.999', strict_max_version: '8.*' },
    },
  },
  {
    version: '0.0.11',
    update_link: 'https://github.com/daeh/zotero-citation-tally/releases/download/v0.0.11/citation-tally.xpi',
    applications: {
      zotero: { strict_min_version: '6.999', strict_max_version: '7.*' },
    },
  },
]

const root = resolve(import.meta.dirname, '..')
const buildDir = resolve(root, '.scaffold/build')

const candidates = ['update.json', 'update-beta.json']
let patched = 0

for (const filename of candidates) {
  const filepath = resolve(buildDir, filename)
  if (!existsSync(filepath)) continue

  const data = JSON.parse(readFileSync(filepath, 'utf-8'))
  const addonId = Object.keys(data.addons)[0]

  data.addons[addonId].updates.push(...LEGACY_ENTRIES)

  writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  console.log(`Injected ${LEGACY_ENTRIES.length} legacy update entries into ${filename}`)
  patched++
}

if (patched === 0) {
  console.error('No update JSON found in .scaffold/build/')
  process.exit(1)
}
