import type { LookupStatus } from './citationTypes.ts'

/** Storage policy for a lookup result. */
export type IgnorePolicy = 'persistent' | 'session' | 'none'

/**
 * Persist missing records and API errors from automatic updates. Cache missing
 * identifiers for the session; do not cache successful or transient results.
 */
export function getIgnorePolicy(status: LookupStatus, isAutoUpdate: boolean): IgnorePolicy {
  switch (status) {
    case 'not_found':
      return 'persistent'
    case 'no_identifier':
      return 'session'
    case 'api_error':
      return isAutoUpdate ? 'persistent' : 'none'
    default:
      return 'none'
  }
}
