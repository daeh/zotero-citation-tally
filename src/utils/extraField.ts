/**
 * Reading and rewriting the citation lines this plugin stores in an item's
 * Extra field.
 *
 * Extracted from `citationTally.ts` so the pattern set can be tested directly:
 * the patterns are built from *localized* database names, and two defects lived
 * here undetected because there was no way to exercise them without Zotero.
 *
 * Keep this module free of runtime Zotero dependencies.
 */

/** The line format this plugin writes. */
export function formatCitationLine(title: string, count: number, isoDate: string): string {
  return `Citations: ${count} (${title}) [${isoDate}]`
}

/**
 * Escape a string for literal use inside a `RegExp`.
 *
 * Database display names come from FTL files, so a translator writing
 * `Semantic Scholar (S2)` or `Crossref+` would otherwise inject regex syntax
 * into every pattern below -- changing what they match, or throwing.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every citation-line format this plugin has ever written, so an update can
 * strip the previous line before appending the new one.
 *
 * `databaseTitles` are localized display names and are escaped before
 * interpolation.
 */
export function buildCitationLinePatterns(databaseTitles: readonly string[]): RegExp[] {
  const titlePattern = `(?:${databaseTitles.map((title) => escapeRegExp(title.trim())).join('|')})`
  const date = String.raw`\[\d{4}-\d{1,2}-\d{1,2}\]`

  return [
    // Current format.
    new RegExp(String.raw`^Citations: *\d+ *\(${titlePattern}\) *${date}`, 'i'),
    // Legacy formats, oldest last.
    new RegExp(String.raw`^Citation *Count: *\d+ *\(${titlePattern}\) *${date}`, 'i'),
    // The `\d+` here was written as `\d+` inside an untagged template literal,
    // where `\d` is an identity escape that cooks to a literal `d`. The pattern
    // therefore compiled as `d+` and matched runs of `d`, never a count, so
    // this legacy line was never stripped and accumulated alongside the
    // rewritten one.
    new RegExp(String.raw`^Citations \(${titlePattern}\): \d+`, 'i'),
    new RegExp(String.raw`^\d+ citations \(${titlePattern}\)`, 'i'),
    new RegExp(String.raw`^\d+ citations \(${titlePattern}\) ${date}`, 'i'),
    // Pre-localization names, which were never translated.
    new RegExp(
      String.raw`^\d+ citations \((?:Crossref\/DOI|Inspire\/DOI|Inspire\/arXiv|Semantic Scholar\/DOI|Semantic Scholar\/arXiv)\) ${date}`,
      'i',
    ),
  ]
}

/** Drop every line this plugin recognizes as one of its own citation stamps. */
export function stripCitationLines(
  lines: readonly string[],
  databaseTitles: readonly string[],
): { kept: string[]; removed: string[] } {
  const patterns = buildCitationLinePatterns(databaseTitles)
  const kept: string[] = []
  const removed: string[] = []
  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) {
      removed.push(line)
    } else {
      kept.push(line)
    }
  }
  return { kept, removed }
}

/**
 * Insert `newItem` before the first line matching `pattern`, or append it.
 *
 * Used to keep the citation stamp above a Better BibTeX `Citation Key:` line.
 */
export function insertBeforeMatch(lines: string[], pattern: RegExp, newItem: string): void {
  const index = lines.findIndex((line) => pattern.test(line))
  if (index === -1) {
    lines.push(newItem)
  } else {
    lines.splice(index, 0, newItem)
  }
}

/** Matches a Better BibTeX citation key line. */
export const CITATION_KEY_PATTERN = /^Citation Key: \S+/i
