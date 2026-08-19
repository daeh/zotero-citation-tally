/**
 * Add the last compatible Zotero 7, 8, and 9 releases to the scaffold-generated
 * `update.json` or `update-beta.json`.
 *
 * These entries must stay identical to `LEGACY_UPDATE_ENTRIES` in
 * `scripts/release_simple.py`; `scripts/test_release_simple.py` asserts the parity.
 */

import console from 'node:console'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

export const LEGACY_ENTRIES = [
  {
    version: '0.0.16',
    update_link: 'https://github.com/daeh/zotero-citation-tally/releases/download/v0.0.16/citation-tally.xpi',
    update_hash:
      'sha512:2af6f782ad5a5360ab2914c8c42c9d915f11fd65f52207930dfea1f9b48fb472008fd63accf68c8466efe5a295ac495ba54f8d969cbd8ef0e613d4cb4afb9841',
    applications: {
      zotero: { strict_min_version: '8.999', strict_max_version: '9.*' },
    },
  },
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

function patchBuiltManifests() {
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
}

// Guarded so `LEGACY_ENTRIES` can be imported (by the parity test) without
// patching anything.
if (import.meta.main) {
  patchBuiltManifests()
}
