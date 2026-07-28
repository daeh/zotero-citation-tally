/**
 * API-key normalization.
 *
 * Keys travel as the `x-api-key` header, whose values are WebIDL `ByteString`s.
 * A code unit above 255 throws at `Headers` construction instead of reaching the
 * wire, so a key pasted out of an email or web page can fail every request
 * without ever producing an HTTP status. Code points at or below 255 (U+00A0 in
 * particular) do reach the server, which just rejects them. So strip a known set
 * of offenders, and report what was stripped.
 */

/** Code points removed on sight. Labels are derived, so they can't drift. */
const STRIPPED = new Set<number>([
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0xfeff, // byte order mark
  0x00a0, // no-break space
  0x000d, // carriage return, from line-wrapped mail
  0x000a, // line feed
])

function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

export interface NormalizedApiKey {
  key: string
  changed: boolean
  /** Labels such as `U+200B`, never the raw characters: this reaches the UI and logs. */
  removed: string[]
  /**
   * Labels of characters that survived normalization but can't go in a header
   * value. Without this they throw at `Headers` construction on every request,
   * which looks to the user like an unexplained network failure.
   */
  unusable: string[]
}

/**
 * Only what a header value genuinely cannot carry. Checked against `Headers`:
 * NUL, LF, CR, and anything above U+00FF throw, while other C0 controls and DEL
 * are accepted. LF and CR are stripped above, so NUL is the only survivor below
 * U+0100. Flagging anything more would condemn key bytes that might be valid,
 * and Semantic Scholar publishes no key alphabet.
 */
function unusableCodePoints(key: string): string[] {
  const bad = new Set<string>()
  for (const character of key) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    if (codePoint > 0xff || codePoint === 0x00) bad.add(codePointLabel(codePoint))
  }
  return [...bad]
}

/**
 * Remove the paste artifacts listed above, then trim. Everything else is left
 * intact, since Semantic Scholar publishes no key alphabet and a broader filter
 * could quietly rewrite a legitimate key.
 *
 * @example
 * // A key pasted from email, carrying a zero-width space and stray blanks.
 * const pasted = `  abc${String.fromCodePoint(0x200b)}def `
 * normalizeApiKey(pasted) // { key: 'abcdef', changed: true, removed: ['U+200B'] }
 */
export function normalizeApiKey(raw: unknown): NormalizedApiKey {
  if (typeof raw !== 'string') return { key: '', changed: false, removed: [], unusable: [] }

  const removed = new Set<string>()
  let kept = ''
  for (const character of raw) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && STRIPPED.has(codePoint)) {
      removed.add(codePointLabel(codePoint))
      continue
    }
    kept += character
  }

  const key = kept.trim()
  return { key, changed: key !== raw, removed: [...removed], unusable: unusableCodePoints(key) }
}
