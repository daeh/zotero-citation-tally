import { getString } from '../utils/locale'
import { getPref } from '../utils/prefs'

import { Helpers, updateItem } from './citationTally'

// Ignored items data type
type IgnoredItemsData = Record<
  string, // Database ID
  Record<
    string, // Item ID
    {
      count: number // Number of times that the database returned "not_found" for the item
      lastChecked: string // ISO date of last check
    }
  >
>

// Helper function to check if item should be retried
function shouldRetryIgnoredItem(count: number, lastChecked: string): boolean {
  const now = new Date()
  const lastCheck = new Date(lastChecked)
  const timeDiff = now.getTime() - lastCheck.getTime()
  const daysDiff = timeDiff / (1000 * 3600 * 24)

  let requiredDays = 0
  if (count === 1) {
    requiredDays = 7 // 1 week
  } else if (count === 2) {
    requiredDays = 30 // 1 month
  } else if (count === 3) {
    requiredDays = 90 // 3 months
  } else if (count > 3) {
    requiredDays = 180 // 6 months
  } else {
    return true // Should retry if count is 0 or unexpected
  }

  const shouldRetry = daysDiff > requiredDays
  // Removed verbose retry debug - info available in summary

  return shouldRetry
}

// Check if item is ignored for any database we'll be checking
function isItemIgnoredForAutoupdate(itemId: number): boolean {
  const databaseOrder = getPref('databaseOrder') || 'crossref'
  const databases = databaseOrder.split(',').map((db: string) => db.trim())

  // Check if item is ignored across all databases

  const ignoredData = getPref('ignoredItems')
  if (!ignoredData) {
    // No ignored items data
    return false
  }

  // Load ignored items data

  let data: IgnoredItemsData
  try {
    data = JSON.parse(ignoredData)
  } catch (error) {
    // Failed to parse ignored items JSON
    return false
  }

  const itemKey = itemId.toString()

  // Count how many databases we can check vs how many are configured
  let checkableDatabases = 0
  let blockedDatabases = 0

  for (const database of databases) {
    if (data[database]?.[itemKey]) {
      const itemData = data[database][itemKey]
      const shouldRetry = shouldRetryIgnoredItem(itemData.count, itemData.lastChecked)
      // Check retry eligibility for this database

      if (shouldRetry) {
        checkableDatabases++
        // Item eligible for retry
      } else {
        blockedDatabases++
        // Item blocked for this database
      }
    } else {
      // If no ignore data for this database, we can check it
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
  const nameMap: Record<string, string> = {
    crossref: 'database-crossref',
    inspire: 'database-inspire',
    semanticscholar: 'database-semanticscholar',
  }
  return getString(nameMap[key] || key)
}

// Automatic update state
let autoUpdateInProgress = false
let autoUpdateQueue: Zotero.Item[] = []
let autoUpdateIndex = 0
let autoUpdateProgressWindow: any = null
let autoUpdateRetryCount = 0
const MAX_RETRIES = 3
const RETRY_DELAY = 5000 // 5 seconds

/**
 * Check if citation data is outdated based on user preferences
 * Only considers databases that aren't currently blocked by the ignored items system
 * @param item Zotero item
 * @returns true if data is outdated or missing for any checkable database
 */
function isCitationDataOutdated(item: Zotero.Item): [boolean, string] {
  const extra = item.getField('extra')
  if (!extra) {
    return [true, 'no_extra_field']
  }

  const databaseOrder = getPref('databaseOrder') || 'crossref'
  const databases = databaseOrder.split(',').map((db: string) => db.trim())

  const cutoffMonths = parseInt(getPref('autoUpdateCutoff') || '6')
  const cutoffDate = new Date()
  cutoffDate.setMonth(cutoffDate.getMonth() - cutoffMonths)

  // Get item identifier to determine which databases are applicable
  const identifier = Helpers.getItemIdentifier(item)
  if (!identifier) {
    return [false, 'no_identifier']
  }

  // Check if this is an arXiv DOI (which Crossref won't have data for)
  const isArxivDoi = identifier.type === 'doi' && identifier.id.includes('arXiv')

  // Get ignored items data to filter out blocked databases
  const ignoredData = getPref('ignoredItems')
  let ignoredItemsData: IgnoredItemsData = {}
  if (ignoredData) {
    try {
      ignoredItemsData = JSON.parse(ignoredData)
    } catch {
      // Continue with empty ignored data
    }
  }

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
      const shouldRetry = shouldRetryIgnoredItem(itemData.count, itemData.lastChecked)
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
    const patt_date = new RegExp(`^Citations: *\\d+ *\\(${dbTitle}\\) *\\[(\\d{4}-\\d{1,2}-\\d{1,2})\\]`, 'i')

    const lines = extra.split('\n')
    let found = false

    for (const line of lines) {
      const match = patt_date.exec(line)
      if (match) {
        const citationDate = new Date(match[1])
        const daysDiff = Math.floor((new Date().getTime() - citationDate.getTime()) / (1000 * 3600 * 24))

        if (citationDate < cutoffDate) {
          reasons.push(`${database}_outdated_${match[1]}_${daysDiff}days`)
          hasAnyCheckableOutdatedData = true
        } else {
          reasons.push(`${database}_recent_${match[1]}_${daysDiff}days`)
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
  const s = new Zotero.Search()

  // @ts-ignore - userLibraryID is not properly typed in Zotero API
  s.libraryID = Zotero.Libraries.userLibraryID
  s.addCondition('deleted', 'false', '')
  s.addCondition('itemType', 'isNot', 'attachment')
  s.addCondition('itemType', 'isNot', 'note')

  const itemIds = await s.search()
  const allItems = await Zotero.Items.getAsync(itemIds)

  ztoolkit.log(`Auto update debug: Found ${allItems.length} total library items`)

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

  ztoolkit.log('Auto update debug: Item filtering summary:')
  ztoolkit.log(`  - Total items: ${allItems.length}`)
  ztoolkit.log(`  - Regular items: ${regularItemCount}`)
  ztoolkit.log(`  - Items with identifier: ${itemsWithIdentifierCount}`)
  ztoolkit.log(`  - Items ignored: ${ignoredItemCount}`)
  ztoolkit.log(`  - Items outdated: ${outdatedItemCount}`)
  ztoolkit.log(`  - Final items needing update: ${itemsNeedingUpdate.length}`)

  ztoolkit.log('*** DETAILED DEBUG REASONS FOR AUTOUPDATE SELECTION ***')
  ztoolkit.log(JSON.stringify(debugReasons, null, 2))
  ztoolkit.log('*** END DETAILED DEBUG REASONS ***')

  // Sort by date added (newest first)
  itemsNeedingUpdate.sort((a, b) => {
    const dateA = new Date(a.getField('dateAdded'))
    const dateB = new Date(b.getField('dateAdded'))
    return dateB.getTime() - dateA.getTime()
  })

  return itemsNeedingUpdate
}

function checkIfRunnable(): boolean {
  // if (autoUpdateInProgress) {
  //   ztoolkit.log('Auto update: Already in progress, not starting another instance')
  //   return false
  // }

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
 * Start automatic update process on startup if enabled
 */
async function startAutomaticUpdate(silent: boolean = false) {
  const autoUpdateMode = getPref('autoUpdate') || 'never'

  if (autoUpdateMode !== 'startup') {
    return
  }

  if (autoUpdateInProgress) {
    return
  }

  try {
    const itemsToUpdate = await getItemsNeedingUpdate()

    if (itemsToUpdate.length === 0) {
      ztoolkit.log('Auto update: No items need updating')
      return
    }

    ztoolkit.log(`Auto update: Found ${itemsToUpdate.length} items needing updates`)

    // Item queue details available in detailed debug reasons output above

    autoUpdateInProgress = true
    autoUpdateQueue = itemsToUpdate
    autoUpdateIndex = 0
    autoUpdateRetryCount = 0

    if (!checkIfRunnable()) {
      ztoolkit.log('Auto update: Not runnable, stopping')
      return
    }

    // Start processing with a delay to allow Zotero to fully initialize
    setTimeout(() => {
      if (!silent) {
        // Show progress window
        autoUpdateProgressWindow = new ztoolkit.ProgressWindow(
          getString('auto-update-title', { args: { addonName: addon.data.config.addonName } }),
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
  }
}

/**
 * Process the automatic update queue with robust error handling
 */
async function processAutoUpdateQueue(silent: boolean = false) {
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

  ztoolkit.log(`[${autoUpdateIndex + 1}/${autoUpdateQueue.length}] Processing: ${title} (${progress}%)`)

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

    await updateItem(item, undefined, true, true) // Pass isAutoUpdate=true

    autoUpdateIndex++

    // No additional delay needed - adaptive rate limiting is handled in the database methods
    setTimeout(() => void processAutoUpdateQueue(silent), 100)
  } catch (error) {
    ztoolkit.log('Auto update error:', error)

    // Check if it's a rate limit error
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
      ztoolkit.log('Auto update: Rate limited, retrying...')
      setTimeout(() => void processAutoUpdateQueue(silent), RETRY_DELAY)
      return
    }

    // For other errors, try to continue with next item
    autoUpdateIndex++
    setTimeout(() => void processAutoUpdateQueue(silent), 100)
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

  setTimeout(() => void processAutoUpdateQueue(silent), RETRY_DELAY)
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

  const updatedCount = autoUpdateIndex
  const totalCount = autoUpdateQueue.length

  // Show completion message
  if (!silent) {
    const completionWindow = new ztoolkit.ProgressWindow('Citation Tally - Auto Update')

    if (errorMessage) {
      completionWindow.createLine({
        text: getString('auto-update-stopped', { args: { error: errorMessage } }),
        type: 'fail',
        progress: 100,
      })
    } else {
      completionWindow.createLine({
        text: getString('auto-update-completed', { args: { updated: updatedCount, total: totalCount } }),
        type: 'success',
        progress: 100,
      })
    }
    completionWindow.show()
    completionWindow.startCloseTimer(5000)
  }

  // Reset state
  autoUpdateQueue = []
  autoUpdateIndex = 0
  autoUpdateRetryCount = 0

  ztoolkit.log(`Auto update completed: ${updatedCount}/${totalCount} items updated`)
}

export { startAutomaticUpdate }
