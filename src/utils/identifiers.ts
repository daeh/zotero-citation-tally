/**
 * Canonical identifier handling shared by every citation provider.
 *
 * Crossref, INSPIRE, and Semantic Scholar each used to normalize (or not
 * normalize) identifiers their own way, so the same malformed DOI behaved
 * differently depending on which database was selected. This module is the one
 * place that decides what an identifier *is*; provider-specific URL
 * construction stays with each provider, because their path rules differ.
 *
 * Keep this module free of runtime Zotero dependencies so it stays testable
 * under `node --test`.
 */

/**
 * arXiv identifier grammar.
 *
 * New style is `YYMM.NNNNN` (4 digits, dot, 4-5 digits). Old style is
 * `archive[.subclass]/YYMMNNN`, where the subclass is the part the previous
 * `[a-z-]+` pattern could not express: `math.GT/0309136` matched only as
 * `GT/0309136`, silently producing a *wrong* identifier rather than none.
 *
 * Both accept an optional `vN` version suffix.
 *
 * The digit counts are deliberately exact. The old `\d+\.\d+` alternative
 * matched any decimal, so an unrelated `1.2` in a text field was extracted as
 * an arXiv ID.
 */
const ARXIV_NEW_STYLE = String.raw`\d{4}\.\d{4,5}`
// Archive and subclass are both hyphenatable: `cond-mat.str-el`,
// `physics.flu-dyn`, `astro-ph.CO`, `q-bio.PE`.
const ARXIV_WORD = String.raw`[A-Za-z]+(?:-[A-Za-z]+)*`
const ARXIV_OLD_STYLE = String.raw`${ARXIV_WORD}(?:\.${ARXIV_WORD})?\/\d{7}`
const ARXIV_BODY = `(?:${ARXIV_OLD_STYLE}|${ARXIV_NEW_STYLE})(?:v\\d+)?`

/** Matches a bare or `arXiv:`-prefixed identifier anywhere in a text field. */
const ARXIV_IN_TEXT = new RegExp(String.raw`(?:arXiv:\s*)?(${ARXIV_BODY})`, 'i')

/** Matches an identifier in an arxiv.org URL (`/abs/`, `/pdf/`). */
const ARXIV_IN_URL = new RegExp(String.raw`arxiv\.org\/(?:abs|pdf)\/(${ARXIV_BODY})`, 'i')

/** DOI resolver hosts whose path is the DOI itself. */
const DOI_RESOLVER_HOSTS = new Set(['doi.org', 'dx.doi.org', 'www.doi.org'])

/**
 * Extract an arXiv identifier from free text, or `null` when the text holds
 * none.
 *
 * The version suffix is preserved *here* so the grammar recognizes
 * `2301.12345v2` as an identifier at all. It must be stripped again before
 * building a provider URL — see `stripArxivVersion`.
 */
export function extractArxivId(text: string): string | null {
  const match = ARXIV_IN_TEXT.exec(text)
  return match ? match[1] : null
}

/**
 * Drop a trailing `vN` from an arXiv identifier.
 *
 * **INSPIRE 404s versioned identifiers.** Measured against the live API:
 *
 *     /api/arxiv/1607.01652        -> 200
 *     /api/arxiv/1607.01652v1      -> 404
 *     /api/arxiv/hep-th/9711200    -> 200
 *     /api/arxiv/hep-th/9711200v3  -> 404
 *
 * A 404 is authoritative, so a versioned-only item would exhaust its
 * identifiers, be recorded `not_found`, and enter the persistent ignore ladder
 * for a paper INSPIRE actually has.
 *
 * Citation counts are per paper, not per revision, so the version carries no
 * information for this use and the versionless form is the canonical one every
 * provider accepts.
 *
 * Only applied on the arXiv branch: a DOI suffix is opaque and may legitimately
 * end in something shaped like `v2`.
 */
export function stripArxivVersion(id: string): string {
  return id.replace(/v\d+$/i, '')
}

/** Extract an arXiv identifier from an arxiv.org URL, or `null`. */
export function extractArxivIdFromUrl(url: string): string | null {
  const match = ARXIV_IN_URL.exec(url)
  return match ? match[1] : null
}

/**
 * Reduce a DOI to its bare name (`10.xxxx/suffix`), or `null` when the input is
 * not one.
 *
 * The `#` and `?` handling is the subtle part. A DOI *suffix is opaque* and may
 * legally contain both — the DOI Handbook's own example is `10.1000/456#789`.
 * So they mean different things depending on the input:
 *
 * - In a **resolver URL** they are URL syntax, and the DOI ends before them.
 *   `https://doi.org/10.1000/456#789` is the DOI `10.1000/456`.
 * - In a **raw DOI** they are content and must survive.
 *   `10.1000/456#789` is the DOI `10.1000/456#789`.
 *
 * Stripping them unconditionally corrupts valid DOIs; keeping them
 * unconditionally corrupts URLs. Hence the branch.
 */
export function normalizeDoi(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  let candidate = trimmed

  if (/^https?:\/\//i.test(candidate)) {
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      return null
    }
    if (!DOI_RESOLVER_HOSTS.has(url.hostname.toLowerCase())) return null
    // `pathname` already excludes the query and fragment. Decode it, because a
    // DOI containing `#` is transported as `%23`.
    try {
      candidate = decodeURIComponent(url.pathname.replace(/^\//, ''))
    } catch {
      candidate = url.pathname.replace(/^\//, '')
    }
  } else {
    // Accept `doi:10.x/y`, `DOI: 10.x/y`, and the bare form.
    candidate = candidate.replace(/^doi:\s*/i, '')
  }

  candidate = candidate.trim()
  // A DOI name is always `10.<registrant>/<suffix>`.
  if (!/^10\.[^/\s]+\/.+$/.test(candidate)) return null
  return candidate
}

/**
 * Percent-encode an identifier for use as URL *path* segments, preserving the
 * `/` that separates a DOI's registrant from its suffix and an old-style arXiv
 * archive from its number.
 *
 * Crossref and INSPIRE both accept a percent-encoded `/` as well, verified
 * against the live services; slashes are preserved because it keeps the
 * resulting URLs readable in logs and matches what Semantic Scholar expects.
 */
export function encodeIdentifierPath(id: string): string {
  return encodeURIComponent(id).replace(/%2F/gi, '/')
}
