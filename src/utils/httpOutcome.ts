/**
 * Mapping HTTP responses and thrown errors onto `LookupStatus`.
 *
 * The Crossref client used to do `fetch(url).then((r) => r.json())` with no
 * `r.ok` check. A 5xx that returns a JSON error body therefore parsed fine,
 * yielded `undefined` for the count field, and was reported as `not_found` --
 * which the ignore cache then persisted. One transient provider outage could
 * silence an item for months.
 *
 * Keep this module free of runtime Zotero dependencies.
 */

import type { LookupStatus } from '../modules/citationTypes.ts'

/** A response status that is not a success, classified for the caller. */
export type FailureStatus = Exclude<LookupStatus, 'success' | 'no_identifier'>

/**
 * Classify a non-2xx HTTP status.
 *
 * Only a 404 is authoritative about the *item*; everything else is about the
 * request or the service, and must not be persisted. See `getIgnorePolicy`.
 */
export function classifyHttpStatus(status: number): FailureStatus {
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  // 408 Request Timeout and 5xx are retryable service conditions.
  if (status === 408 || status >= 500) return 'transient_error'
  // Any other 4xx is a client error: a malformed identifier, a bad key, a
  // blocked user agent. Real, worth surfacing, but never a statement that the
  // item has no citations.
  return 'api_error'
}

/**
 * Classify a thrown value from `fetch` or from parsing its body.
 *
 * Cancellation is deliberately **not** handled here: callers must inspect their
 * own abort signals first and rethrow, so a preempted run is never mistaken for
 * a retryable failure. This mirrors `semanticScholarClient.core`.
 */
export function classifyThrown(): FailureStatus {
  // A network failure, a DNS failure, or a malformed body. All retryable, none
  // of them evidence about the item.
  return 'transient_error'
}

/**
 * Validate a citation count from a provider payload.
 *
 * Accepts a number or a numeric string, and requires a non-negative safe
 * integer. `parseInt` alone accepted `NaN`, negatives, and `1e21`.
 */
export function parseCitationCount(raw: unknown): number | null {
  let value: number
  if (typeof raw === 'number') {
    value = raw
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    value = Number(raw)
  } else {
    return null
  }
  if (!Number.isSafeInteger(value) || value < 0) return null
  return value
}
