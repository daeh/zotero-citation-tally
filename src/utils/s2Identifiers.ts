import type { ItemIdentifier } from '../modules/citationTypes.ts'

export interface S2PaperRef {
  /** Encoded Semantic Scholar paper path, such as `DOI:10.1234/x`. */
  paperId: string
  identifier: ItemIdentifier
}

/**
 * Encode a paper ID for a URL path while preserving slashes used by DOI and
 * old-style arXiv identifiers.
 */
function encodePathId(id: string): string {
  return encodeURIComponent(id).replace(/%2F/gi, '/')
}

function schemeAndId(identifier: ItemIdentifier): { scheme: 'DOI' | 'ARXIV'; id: string } | null {
  const raw = identifier.id.trim()
  if (raw === '') return null

  if (identifier.type === 'arxiv') {
    const id = raw.replace(/^arxiv:/i, '').trim()
    return id === '' ? null : { scheme: 'ARXIV', id }
  }

  // Semantic Scholar resolves arXiv DOIs only through the ARXIV scheme.
  const arxivIdx = raw.toLowerCase().lastIndexOf('arxiv.')
  if (arxivIdx !== -1) {
    const id = raw.slice(arxivIdx + 'arxiv.'.length).trim()
    if (id !== '') return { scheme: 'ARXIV', id }
  }
  return { scheme: 'DOI', id: raw }
}

/** Preserve identifier order while removing case-insensitive duplicate scheme/ID pairs. */
export function toS2PaperRefs(identifiers: readonly ItemIdentifier[]): S2PaperRef[] {
  const out: S2PaperRef[] = []
  const seen = new Set<string>()
  for (const identifier of identifiers) {
    const resolved = schemeAndId(identifier)
    if (resolved === null) continue
    const dedupeKey = `${resolved.scheme}:${resolved.id.toLowerCase()}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({ paperId: `${resolved.scheme}:${encodePathId(resolved.id)}`, identifier })
  }
  return out
}
