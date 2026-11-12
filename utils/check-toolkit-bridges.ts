/**
 * Fail the build if the packaged addon could register zotero-plugin-toolkit's bridge links.
 *
 * Toolkit 5.x registered `zotero://plugin` (installs an add-on from a link without asking) and
 * `zotero://ztoolkit-debug` (runs code from a link) for the whole Zotero installation whenever
 * `new ZoteroToolkit()` ran. Citation Tally uses neither. Toolkit 6 removed the automatic
 * registration; this guard keeps the shipped files from regaining it.
 *
 * The match is deliberately conservative: any occurrence of either key, or of
 * `getProtocolHandler` (the accessor every toolkit version registers through, however the key is
 * spelled), fails the build, including occurrences in comments. It is a text guard; the runtime
 * smoke test in `test/zotero/startup.spec.ts` checks the registry itself.
 *
 * @example
 * node utils/check-toolkit-bridges.ts   # scans .scaffold/build/addon; exits 1 on any hit
 */

import console from 'node:console'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

const FORBIDDEN = /zotero:\/\/(?:plugin|ztoolkit-debug)(?![\w-])|\bgetProtocolHandler\b/g

export interface Match {
  line: number
  match: string
}

export interface Hit extends Match {
  file: string
}

/**
 * Every forbidden occurrence in `text`, with 1-based line numbers.
 *
 * @example
 * findForbidden('a\nzotero://plugin') // [{ line: 2, match: 'zotero://plugin' }]
 */
export function findForbidden(text: string): Match[] {
  const matches: Match[] = []
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const found of line.matchAll(FORBIDDEN)) {
      matches.push({ line: index + 1, match: found[0] })
    }
  }
  return matches
}

/**
 * Scan every regular file under `addonDir`. Throws unless `expectedBundle` (relative to
 * `addonDir`) is a regular file, so an empty or misplaced build cannot pass; read and traversal
 * errors propagate.
 *
 * @example
 * scanBuild('.scaffold/build/addon', 'content/scripts/citationtally.js') // [] when clean
 */
export function scanBuild(addonDir: string, expectedBundle: string): Hit[] {
  const bundlePath = join(addonDir, expectedBundle)
  if (!statSync(bundlePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`expected bundle is not a regular file: ${bundlePath}`)
  }

  const hits: Hit[] = []
  const entries = readdirSync(addonDir, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const file = relative(addonDir, path)
    for (const found of findForbidden(readFileSync(path, 'utf-8'))) {
      hits.push({ file, ...found })
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

function main(): void {
  const root = resolve(import.meta.dirname, '..')
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')) as { config: { addonRef: string } }
  const addonDir = resolve(root, '.scaffold/build/addon')

  const hits = scanBuild(addonDir, `content/scripts/${pkg.config.addonRef}.js`)
  if (hits.length === 0) {
    console.log('No zotero-plugin-toolkit bridge links in the build.')
    return
  }
  for (const hit of hits) console.error(`${hit.file}:${hit.line}: ${hit.match}`)
  console.error(`Found ${hits.length} forbidden toolkit bridge reference(s) in ${addonDir}.`)
  process.exitCode = 1
}

if (import.meta.main) main()
