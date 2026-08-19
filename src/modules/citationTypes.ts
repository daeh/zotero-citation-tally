/** Types shared by the plugin and Node tests. Keep this module free of runtime Zotero dependencies. */
export type LookupStatus = 'success' | 'not_found' | 'no_identifier' | 'rate_limited' | 'transient_error' | 'api_error'

/** Outcome of validating an API key. Lives here so `preferenceMessages` can use it too. */
export type ValidationStatus = 'valid' | 'invalid' | 'indeterminate' | 'empty' | 'client_error' | 'aborted'

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
 * can't support it. `transient_error` is the honest classification: the item
 * was never actually checked. (Neither status is persisted any more -- see
 * `getIgnorePolicy`, where only an authoritative 404 earns a persistent
 * entry -- but the distinction still drives logging and retry behaviour.)
 */
export function semanticScholarUnavailableResult(): LookupResult {
  return { count: -1, status: 'transient_error', message: 'Semantic Scholar is unavailable in this Zotero runtime' }
}

/**
 * The databases that request-eligibility and scheduling code may act on. When
 * the runtime can't support Semantic Scholar it drops out everywhere, so nothing
 * fires a request that is bound to fail. Display code (the column, stored
 * counts) doesn't use this filter, so old counts stay visible.
 */
export function effectiveDatabases(configured: readonly string[], s2Available: boolean): string[] {
  return configured.filter((database) => database !== SEMANTIC_SCHOLAR_DATABASE || s2Available)
}
