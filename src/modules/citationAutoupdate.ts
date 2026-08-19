import { getErrorMessage, isErrorNamed } from '../utils/errors'
import { escapeRegExp } from '../utils/extraField'
import { parseIgnoreStore, shouldRetryIgnoredItem } from '../utils/ignoreStore'
import { getString } from '../utils/locale'
import { debugLog, debugLogLazy } from '../utils/log'
import { getPref } from '../utils/prefs'
import { parseCitationStampDate, parseDateAddedInstant } from '../utils/temporalParse'

import { Helpers, updateItem } from './citationTally'
import { effectiveDatabases } from './citationTypes'
import { isSemanticScholarAvailable } from './semanticScholarClient'

// Preference values outside the menu options fall back to six months.
const ALLOWED_CUTOFF_MONTHS: ReadonlySet<number> = new Set([3, 6, 12, 24])
function parseCutoffMonths(raw: string): number {
  const n = Number(raw)
  return Number.isInteger(n) && ALLOWED_CUTOFF_MONTHS.has(n) ? n : 6
}

/** Sort newest first; place missing or invalid dates last. */
function compareByDateAddedDesc(a: Zotero.Item, b: Zotero.Item): number {
  const ia = parseDateAddedInstant(a.getField('dateAdded'))
  const ib = parseDateAddedInstant(b.getField('dateAdded'))
  if (ia === null && ib === null) return 0
  if (ia === null) return 1
  if (ib === null) return -1
  return Temporal.Instant.compare(ib, ia)
}

// Check if item is ignored for any configured database
function isItemIgnoredForAutoupdate(itemId: number): boolean {
  const databaseOrder = getPref('databaseOrder') || 'crossref'
  const databases = effectiveDatabases(
    databaseOrder.split(',').map((db: string) => db.trim()),
    isSemanticScholarAvailable(),
  )
  // With no runtime-supported database, nothing is checkable for any item.
  if (databases.length === 0) {
    return true
  }

  // Check if item is ignored across all databases

  // One shared parser for every reader of this pref, so the schema migration in
  // `parseIgnoreStore` cannot be bypassed by a hand-rolled parse.
  const store = parseIgnoreStore(getPref('ignoredItems'))
  const data = store.entries

  const itemKey = itemId.toString()

  // Count how many databases are available vs configured
  let checkableDatabases = 0
  let blockedDatabases = 0

  for (const database of databases) {
    if (data[database]?.[itemKey]) {
      const itemData = data[database][itemKey]
      const shouldRetry = shouldRetryIgnoredItem(itemData, Temporal.Now.instant())
      // Check retry eligibility for this database

      if (shouldRetry) {
        checkableDatabases++
        // Item eligible for retry
      } else {
        blockedDatabases++
        // Item blocked for this database
      }
    } else {
      // If no ignore data for this database, it can be checked
      checkableDatabases++
      // No ignore data - can check this database
    }
  }

  // Skip item only if ALL databases are blocked (no checkable databases remaining)
  const shouldSkip = checkableDatabases === 0
  // Final ignore decision made

  return shouldSkip
}

// Operation display names (lazy-loaded to avoid startup issues)
function getOperationName(key: string): string {
  const nameMap = {
    crossref: 'database-crossref',
    inspire: 'database-inspire',
    semanticscholar: 'database-semanticscholar',
  } as const
  const fluentId = nameMap[key as keyof typeof nameMap]
  return fluentId ? getString(fluentId) : key
}

/** What kicked off a library scan. Startup runs are gated on the preference; manual runs are not. */
type UpdateTrigger = 'startup' | 'manual'

// Automatic update state
let autoUpdateInProgress = false
let autoUpdateStarting = false
let autoUpdateQueue: Zotero.Item[] = []
let autoUpdateIndex = 0
let autoUpdateSuccessCount = 0
let autoUpdateTrigger: UpdateTrigger = 'startup'
let autoUpdateProgressWindow: any = null
let autoUpdateRetryCount = 0
let autoUpdateTimer: ReturnType<typeof setTimeout> | null = null
const MAX_RETRIES = 3
const RETRY_DELAY = 5000 // 5 seconds

/** Schedule one queue step and retain its timer so shutdown can cancel it. */
function scheduleNext(silent: boolean, delay: number): void {
  if (!addon.data.alive) {
    finishAutomaticUpdate(undefined, silent)
    return
  }
  autoUpdateTimer = setTimeout(() => {
    autoUpdateTimer = null
    void processAutoUpdateQueue(silent)
  }, delay)
}

/** Cancel the queued step and settle the current run. */
function cancelAutomaticUpdate(): void {
  if (autoUpdateTimer !== null) {
    clearTimeout(autoUpdateTimer)
    autoUpdateTimer = null
  }
  if (autoUpdateInProgress) {
    finishAutomaticUpdate(undefined, true)
  }
}

/**
 * Check if citation data is outdated based on user preferences
 * Only considers databases that aren't currently blocked by the ignored items system
 * @param item Zotero item
 * @returns true if data is outdated or missing for any checkable database
 */
function isCitationDataOutdated(item: Zotero.Item): [boolean, string] {
  const databaseOrder = getPref('databaseOrder') || 'crossref'
  const databases = effectiveDatabases(
    databaseOrder.split(',').map((db: string) => db.trim()),
    isSemanticScholarAvailable(),
  )
  // With no supported database, nothing can be outdated. This has to come before
  // the empty-`extra` return below, or such items would still get queued.
  if (databases.length === 0) {
    return [false, 'no_effective_databases']
  }

  const extra = item.getField('extra')
  if (!extra) {
    return [true, 'no_extra_field']
  }

  // A stamp on the cutoff date still counts as current. Temporal handles the
  // month-end arithmetic.
  const cutoffDate = Temporal.Now.plainDateISO().subtract({
    months: parseCutoffMonths(getPref('autoUpdateCutoff') || '6'),
  })

  // Get item identifier to determine which databases are applicable
  const identifier = Helpers.getItemIdentifier(item)
  if (!identifier) {
    return [false, 'no_identifier']
  }

  // Check if this is an arXiv DOI (which Crossref won't have data for)
  const isArxivDoi = identifier.type === 'doi' && identifier.id.includes('arXiv')

  // Get ignored items data to filter out blocked databases
  const ignoredItemsData = parseIgnoreStore(getPref('ignoredItems')).entries

  const itemKey = item.id.toString()
  const reasons: string[] = []
  let hasAnyCheckableOutdatedData = false
  let checkableDatabases = 0

  // Helper function to check if database is applicable for this item
  function isDatabaseApplicable(database: string, identifierType: string, isArxivDoi: boolean): boolean {
    if (database === 'crossref') {
      // Crossref only works with regular DOIs, not arXiv DOIs
      return identifierType === 'doi' && !isArxivDoi
    }
    if (database === 'semanticscholar') {
      // Semantic Scholar works with DOI, arXiv, and arXiv DOIs
      return identifierType === 'doi' || identifierType === 'arxiv'
    }
    if (database === 'inspire') {
      // INSPIRE works with DOI, arXiv, and arXiv DOIs
      return identifierType === 'doi' || identifierType === 'arxiv'
    }
    return false
  }

  // Check each database individually
  for (const database of databases) {
    // Skip databases that don't support this identifier type
    if (!isDatabaseApplicable(database, identifier.type, isArxivDoi)) {
      if (isArxivDoi) {
        reasons.push(`${database}_not_applicable_for_arxiv_doi`)
      } else {
        reasons.push(`${database}_not_applicable_for_${identifier.type}`)
      }
      continue
    }

    // Skip if this database is currently blocked for this item
    if (ignoredItemsData[database]?.[itemKey]) {
      const itemData = ignoredItemsData[database][itemKey]
      const shouldRetry = shouldRetryIgnoredItem(itemData, Temporal.Now.instant())
      if (!shouldRetry) {
        reasons.push(`${database}_blocked_until_retry`)
        continue
      } else {
        reasons.push(`${database}_retry_eligible`)
      }
    }

    checkableDatabases++

    // Look for citation data for this specific database
    const dbTitle = getOperationName(database)
    // Escaped: display names come from FTL, so a translator using `(`, `.`,
    // or `+` would otherwise change what this matches, or throw.
    const patt_date = new RegExp(
      `^Citations: *\\d+ *\\(${escapeRegExp(dbTitle)}\\) *\\[(\\d{4}-\\d{1,2}-\\d{1,2})\\]`,
      'i',
    )

    const lines = extra.split('\n')
    let found = false

    for (const line of lines) {
      const match = patt_date.exec(line)
      if (match) {
        const citationDate = parseCitationStampDate(match[1])
        if (citationDate === null) {
          // Retry malformed stored dates instead of leaving the item blocked.
          reasons.push(`${database}_malformed_${match[1]}`)
          hasAnyCheckableOutdatedData = true
        } else {
          const daysDiff = Math.floor(Temporal.Now.plainDateISO().since(citationDate).total({ unit: 'day' }))
          if (Temporal.PlainDate.compare(citationDate, cutoffDate) < 0) {
            reasons.push(`${database}_outdated_${match[1]}_${daysDiff}days`)
            hasAnyCheckableOutdatedData = true
          } else {
            reasons.push(`${database}_recent_${match[1]}_${daysDiff}days`)
          }
        }
        found = true
        break
      }
    }

    if (!found) {
      reasons.push(`${database}_no_data`)
      hasAnyCheckableOutdatedData = true
    }
  }

  if (checkableDatabases === 0) {
    return [false, 'no_applicable_databases']
  }

  const finalReason = reasons.join('|')
  return [hasAnyCheckableOutdatedData, finalReason]
}

/**
 * Get items that need citation updates from local library only
 * @returns Array of items that need updates, sorted by date added (newest first)
 */
async function getItemsNeedingUpdate(): Promise<Zotero.Item[]> {
  // `libraryID` is read-only on the instance; the constructor is the supported
  // way to set it (`Zotero.Search` passes `name` and `libraryID` through
  // `assignProps`). The previous `s.libraryID = ...` needed a `@ts-ignore`
  // whose comment misattributed the error to `userLibraryID` being untyped.
  const s = new Zotero.Search({ libraryID: Zotero.Libraries.userLibraryID })

  s.addCondition('deleted', 'false', '')
  s.addCondition('itemType', 'isNot', 'attachment')
  s.addCondition('itemType', 'isNot', 'note')

  const itemIds = await s.search()
  const allItems = await Zotero.Items.getAsync(itemIds)

  debugLog(`Auto update debug: Found ${allItems.length} total library items`)

  const itemsNeedingUpdate: Zotero.Item[] = []
  const debugReasons: { id: number; title: string; identifier: any; extra: string; reason: string }[] = []
  let regularItemCount = 0
  let itemsWithIdentifierCount = 0
  let ignoredItemCount = 0
  let outdatedItemCount = 0

  for (const item of allItems) {
    if (!item.isRegularItem()) {
      continue
    }
    regularItemCount++

    // Skip items without DOI or arXiv ID
    const identifier = Helpers.getItemIdentifier(item)
    if (!identifier) {
      continue
    }
    itemsWithIdentifierCount++

    // Skip items that are ignored for autoupdate (respects time-based retry logic)
    if (isItemIgnoredForAutoupdate(item.id)) {
      ignoredItemCount++
      continue
    }

    const [isOutdated, reason] = isCitationDataOutdated(item)
    if (isOutdated) {
      const title = item.getField('title') || 'No title'
      const extra = item.getField('extra') || 'No extra field'

      debugReasons.push({
        id: item.id,
        title: title.substring(0, 60),
        identifier,
        extra: extra.substring(0, 100),
        reason,
      })

      itemsNeedingUpdate.push(item)
      outdatedItemCount++
    }
  }

  debugLog('Auto update debug: Item filtering summary:')
  debugLog(`  - Total items: ${allItems.length}`)
  debugLog(`  - Regular items: ${regularItemCount}`)
  debugLog(`  - Items with identifier: ${itemsWithIdentifierCount}`)
  debugLog(`  - Items ignored: ${ignoredItemCount}`)
  debugLog(`  - Items outdated: ${outdatedItemCount}`)
  debugLog(`  - Final items needing update: ${itemsNeedingUpdate.length}`)

  // Lazy: this serialized the whole scan -- item ids, titles, identifiers, and
  // Extra-field excerpts -- on every library scan, whether or not anyone was
  // reading the log.
  debugLogLazy(() => ['Citation debug - autoupdate selection:', JSON.stringify(debugReasons, null, 2)])

  // Sort by date added (newest first)
  itemsNeedingUpdate.sort(compareByDateAddedDesc)

  return itemsNeedingUpdate
}

function checkIfRunnable(): boolean {
  const window = Zotero.getMainWindow()

  if (!window) {
    ztoolkit.log('Auto update: No Zotero window available, stopping')
    return false
  }

  if (!window?.navigator?.onLine) {
    ztoolkit.log('Auto update: No network connection, stopping')
    return false
  }

  return true
}

/**
 * Scan My Library and update outdated citations. Startup runs are gated on the
 * `autoUpdate` preference; the Tools menu passes `manual` and always runs.
 *
 * Queue state is committed only after every early return, and a start-phase flag
 * covers the awaited library scan, so two invocations cannot both install a queue
 * and a failed start cannot leave `autoUpdateInProgress` latched.
 */
async function startAutomaticUpdate(silent: boolean = false, trigger: UpdateTrigger = 'startup') {
  if (trigger === 'startup' && (getPref('autoUpdate') || 'never') !== 'startup') {
    return
  }

  if (autoUpdateStarting || autoUpdateInProgress) {
    return
  }

  autoUpdateStarting = true
  try {
    const itemsToUpdate = await getItemsNeedingUpdate()

    // The library scan can straddle a disable, so schedule nothing after it.
    if (!addon.data.alive) return

    if (itemsToUpdate.length === 0) {
      ztoolkit.log('Auto update: No items need updating')
      return
    }

    ztoolkit.log(`Auto update: Found ${itemsToUpdate.length} items needing updates`)

    // Item queue details available in detailed debug reasons output above

    if (!checkIfRunnable()) {
      ztoolkit.log('Auto update: Not runnable, stopping')
      return
    }

    autoUpdateInProgress = true
    autoUpdateTrigger = trigger
    autoUpdateQueue = itemsToUpdate
    autoUpdateIndex = 0
    autoUpdateSuccessCount = 0
    autoUpdateRetryCount = 0

    // Start processing with a delay to allow Zotero to fully initialize
    autoUpdateTimer = setTimeout(() => {
      autoUpdateTimer = null
      if (!addon.data.alive) {
        finishAutomaticUpdate(undefined, silent)
        return
      }
      if (!silent) {
        // Show progress window
        autoUpdateProgressWindow = new ztoolkit.ProgressWindow(
          trigger === 'manual'
            ? addon.data.config.addonName
            : getString('auto-update-title', { args: { addonName: addon.data.config.addonName } }),
          {
            closeOnClick: true,
            closeTime: -1,
          },
        )

        autoUpdateProgressWindow
          .createLine({
            text: getString('auto-update-updating-outdated', { args: { count: itemsToUpdate.length } }),
            type: 'default',
            progress: 0,
          })
          .show()
      }

      void processAutoUpdateQueue(silent)
    }, 3000)
  } catch (error) {
    ztoolkit.log('Auto update: Error getting items to update:', error)
  } finally {
    autoUpdateStarting = false
  }
}

/**
 * Process the automatic update queue with robust error handling
 */
async function processAutoUpdateQueue(silent: boolean = false) {
  if (!addon.data.alive) {
    finishAutomaticUpdate(undefined, silent)
    return
  }

  const window = Zotero.getMainWindow()

  if (!window) {
    ztoolkit.log('Auto update: No Zotero window available, stopping')
    finishAutomaticUpdate(undefined, silent)
    return
  }

  if (!autoUpdateInProgress || autoUpdateIndex >= autoUpdateQueue.length) {
    finishAutomaticUpdate(undefined, silent)
    return
  }

  const item = autoUpdateQueue[autoUpdateIndex]
  const progress = Math.round((autoUpdateIndex / autoUpdateQueue.length) * 100)
  const title = item?.getField('title') || 'No title'

  // Includes the item title, and fires once per item.
  debugLog(`[${autoUpdateIndex + 1}/${autoUpdateQueue.length}] Processing: ${title} (${progress}%)`)

  if (autoUpdateQueue.length === 0) {
    ztoolkit.log('Auto update: No items in queue, stopping')
    finishAutomaticUpdate(undefined, silent)
    return
  }

  if (!window?.navigator?.onLine) {
    ztoolkit.log('Auto update: No network connection, stopping')
    finishAutomaticUpdate(undefined, silent)
    return
  }

  if (!silent && autoUpdateProgressWindow) {
    autoUpdateProgressWindow?.changeLine({
      text: getString('auto-update-updating-item', {
        args: { current: autoUpdateIndex + 1, total: autoUpdateQueue.length },
      }),
      progress: progress,
    })
  }

  try {
    // Check network connectivity
    if (!window?.navigator?.onLine) {
      ztoolkit.log('Auto update: No network connection, retrying...')
      scheduleRetry(silent)
      return
    }

    const updated = await updateItem(item, undefined, true)

    // A shutdown during the item's fetches must not advance or reschedule the queue.
    if (!addon.data.alive) {
      finishAutomaticUpdate(undefined, silent)
      return
    }

    autoUpdateIndex++
    if (updated) autoUpdateSuccessCount++

    // Database clients apply their own request pacing.
    scheduleNext(silent, 100)
  } catch (error) {
    // Cancellation ends the queue without scheduling another item.
    if (isErrorNamed(error, 'AbortError')) {
      finishAutomaticUpdate(undefined, silent)
      return
    }
    ztoolkit.log('Auto update error:', error)

    // Check if it's a rate limit error
    const errorMessage = getErrorMessage(error)
    if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
      ztoolkit.log('Auto update: Rate limited, retrying...')
      scheduleNext(silent, RETRY_DELAY)
      return
    }

    // For other errors, try to continue with next item
    autoUpdateIndex++
    scheduleNext(silent, 100)
  }
}

/**
 * Schedule a retry for auto update processing
 */
function scheduleRetry(silent: boolean = false) {
  autoUpdateRetryCount++

  if (autoUpdateRetryCount >= MAX_RETRIES) {
    ztoolkit.log('Auto update: Max retries reached, stopping')
    finishAutomaticUpdate('Max retries reached. Please check your connection.', silent)
    return
  }

  ztoolkit.log(`Auto update: Retry ${autoUpdateRetryCount}/${MAX_RETRIES}`)

  if (!silent && autoUpdateProgressWindow) {
    autoUpdateProgressWindow?.changeLine({
      text: getString('auto-update-connection-retry', { args: { current: autoUpdateRetryCount, max: MAX_RETRIES } }),
      type: 'default',
    })
  }

  scheduleNext(silent, RETRY_DELAY)
}

/**
 * Finish the automatic update process
 */
function finishAutomaticUpdate(errorMessage?: string, silent: boolean = false) {
  autoUpdateInProgress = false

  if (autoUpdateProgressWindow) {
    autoUpdateProgressWindow.close()
    autoUpdateProgressWindow = null
  }

  const updatedCount = autoUpdateSuccessCount
  const totalCount = autoUpdateQueue.length
  const manual = autoUpdateTrigger === 'manual'

  // Show completion message
  if (!silent) {
    const completionWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName)

    if (errorMessage) {
      completionWindow.createLine({
        // `auto-update-stopped` is startup wording; a manual run reports the error plainly.
        text: manual ? errorMessage : getString('auto-update-stopped', { args: { error: errorMessage } }),
        type: 'fail',
        progress: 100,
      })
    } else {
      completionWindow.createLine({
        text: manual
          ? getString('progress-items-updated', { args: { count: updatedCount } })
          : getString('auto-update-completed', { args: { updated: updatedCount, total: totalCount } }),
        type: 'success',
        progress: 100,
      })
    }
    completionWindow.show()
    completionWindow.startCloseTimer(5000)
  }

  // Reset state
  if (autoUpdateTimer !== null) {
    clearTimeout(autoUpdateTimer)
    autoUpdateTimer = null
  }
  autoUpdateQueue = []
  autoUpdateIndex = 0
  autoUpdateSuccessCount = 0
  autoUpdateRetryCount = 0

  ztoolkit.log(`Auto update completed: ${updatedCount}/${totalCount} items updated`)
}

export { cancelAutomaticUpdate, startAutomaticUpdate }
