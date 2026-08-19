import type { LookupStatus } from './citationTypes.ts'

/** Storage policy for a lookup result. */
export type IgnorePolicy = 'persistent' | 'session' | 'none'

/**
 * Decide how long a lookup result may suppress future lookups.
 *
 * **Only an authoritative 404 is persistent.** A persistent entry silences the
 * item for 7, then 30, 90, and 180 days (see `retryAgeExceeded`), so anything
 * that might not be about the item itself must not earn one.
 *
 * `api_error` used to persist on automatic updates. That was wrong twice over:
 * every non-404 failure was collapsed into `api_error` at the call site, and
 * the Crossref client did not check response status before parsing, so a 5xx
 * returning a JSON error body read as "no citation count". One transient
 * provider outage could therefore silence an item for months. Provider health
 * says nothing about whether an item has citations.
 *
 * `isAutoUpdate` is retained because callers pass it and the distinction is
 * still meaningful for logging, but it no longer changes any policy.
 */
export function getIgnorePolicy(status: LookupStatus, _isAutoUpdate: boolean): IgnorePolicy {
  switch (status) {
    case 'not_found':
      return 'persistent'
    case 'no_identifier':
      return 'session'
    // 'api_error', 'rate_limited', 'transient_error', and 'success' all fall
    // through: none of them justifies suppressing the item.
    default:
      return 'none'
  }
}
