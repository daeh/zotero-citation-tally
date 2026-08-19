/**
 * Parsing, migration, and serialization for the persistent ignore cache.
 *
 * The cache records items a database has authoritatively reported as missing,
 * so repeat scans can skip them for a while. Three call sites read the
 * underlying preference, two of them previously parsing it by hand, so this
 * module exists to give them one shape and one migration.
 *
 * Keep this module free of runtime Zotero dependencies.
 */

import { retryAgeExceeded } from './retryAge.ts'
import { parseLastCheckedInstant } from './temporalParse.ts'

/** Bumped whenever stored entries must be discarded rather than reinterpreted. */
export const IGNORE_STORE_VERSION = 2

export interface IgnoreRecord {
  /** Consecutive authoritative not-found results; drives the retry ladder. */
  count: number
  /** ISO instant of the last check. */
  lastChecked: string
}

/** database -> item id -> record. */
export type IgnoreEntries = Record<string, Record<string, IgnoreRecord>>

export interface IgnoreStore {
  version: number
  entries: IgnoreEntries
}

export function emptyIgnoreStore(): IgnoreStore {
  return { version: IGNORE_STORE_VERSION, entries: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coerceEntries(raw: unknown): IgnoreEntries {
  if (!isRecord(raw)) return {}
  const entries: IgnoreEntries = {}
  for (const [database, items] of Object.entries(raw)) {
    if (!isRecord(items)) continue
    const perItem: Record<string, IgnoreRecord> = {}
    for (const [itemId, record] of Object.entries(items)) {
      if (!isRecord(record)) continue
      const { count, lastChecked } = record
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) continue
      if (typeof lastChecked !== 'string' || lastChecked === '') continue
      perItem[itemId] = { count, lastChecked }
    }
    if (Object.keys(perItem).length > 0) entries[database] = perItem
  }
  return entries
}

/**
 * Read the stored cache.
 *
 * **Version 1 entries are discarded, not migrated.** A v1 record stored only a
 * count and a timestamp -- never *why* the item was ignored -- and the previous
 * policy persisted provider failures alongside genuine not-found results. The
 * two are therefore indistinguishable on disk, and keeping them would leave
 * already-affected items silenced for up to 180 more days by the very release
 * that fixes the cause. Dropping the cache costs one re-lookup per item.
 *
 * Corrupt or unparseable data **fails open**: the cache reads as empty, so
 * nothing is suppressed. Failing closed would silence an entire library on one
 * bad JSON blob.
 */
export function parseIgnoreStore(raw: string | undefined | null): IgnoreStore {
  if (!raw) return emptyIgnoreStore()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyIgnoreStore()
  }

  if (!isRecord(parsed)) return emptyIgnoreStore()

  // v2+: { version, entries }
  if (typeof parsed.version === 'number') {
    if (parsed.version !== IGNORE_STORE_VERSION) return emptyIgnoreStore()
    return { version: IGNORE_STORE_VERSION, entries: coerceEntries(parsed.entries) }
  }

  // v1: the bare database -> item map, with no version key. Discard it.
  return emptyIgnoreStore()
}

export function serializeIgnoreStore(store: IgnoreStore): string {
  return JSON.stringify({ version: IGNORE_STORE_VERSION, entries: store.entries })
}

/** Look up a single record, or `undefined`. */
export function getIgnoreRecord(store: IgnoreStore, database: string, itemId: number): IgnoreRecord | undefined {
  return store.entries[database]?.[String(itemId)]
}

/**
 * Whether enough time has passed to look this item up again.
 *
 * Previously defined identically in both `citationTally.ts` and
 * `citationAutoupdate.ts`, where the two copies could drift apart.
 */
export function shouldRetryIgnoredItem(record: IgnoreRecord, now: Temporal.Instant): boolean {
  return retryAgeExceeded(record.count, parseLastCheckedInstant(record.lastChecked), now)
}
