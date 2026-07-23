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
