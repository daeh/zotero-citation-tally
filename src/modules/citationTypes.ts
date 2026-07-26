/** Types shared by the plugin and Node tests. Keep this module free of runtime Zotero dependencies. */
export type LookupStatus = 'success' | 'not_found' | 'no_identifier' | 'rate_limited' | 'transient_error' | 'api_error'

export interface LookupResult {
  /** Citation count on success; otherwise -1 or 0. */
  count: number
  status: LookupStatus
  message?: string
}

export interface ItemIdentifier {
  type: 'doi' | 'arxiv'
  id: string
  /** Zotero field that supplied the identifier. */
  source: string
}

export const SEMANTIC_SCHOLAR_DATABASE = 'semanticscholar'

/**
 * Result for a Semantic Scholar lookup that reaches dispatch while the runtime
 * can't support it. The status is `transient_error`, not `api_error`: auto-update
 * persists `api_error` as a per-item ignore (see getIgnorePolicy), and a runtime
 * limitation says nothing about the item.
 */
export function semanticScholarUnavailableResult(): LookupResult {
  return { count: -1, status: 'transient_error', message: 'Semantic Scholar is unavailable in this Zotero runtime' }
}

/**
 * The databases request-eligibility and scheduling code may act on. Semantic
 * Scholar drops out for every origin when the runtime can't support it, so no
 * path fires a doomed request or reports a fake result. Display code (the
 * column, stored counts) does not use this filter — old counts stay visible.
 */
export function effectiveDatabases(configured: readonly string[], s2Available: boolean): string[] {
  return configured.filter((database) => database !== SEMANTIC_SCHOLAR_DATABASE || s2Available)
}
