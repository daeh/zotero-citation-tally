import { getString } from '../utils/locale'
import { getPref, setPref } from '../utils/prefs'

// Default rate limits per database (in milliseconds)
const DEFAULT_RATE_LIMITS: Record<string, number> = {
  crossref: 1000,
  inspire: 1000,
  semanticscholar: 3000,
}

const MAX_RATE_LIMIT_MULTIPLIER = 10

// Adaptive rate limiting state
class RateLimitManager {
  private static multipliers: Record<string, number> = {}
  private static lastRequestTime: Record<string, number> = {}

  static getDelay(database: string): number {
    const baseLimits = getPref('rateLimits')
    let baseDelay: number

    if (baseLimits && typeof baseLimits === 'string') {
      try {
        const parsed = JSON.parse(baseLimits) as Record<string, number>
        baseDelay = parsed[database] || DEFAULT_RATE_LIMITS[database] || 1000
      } catch {
        baseDelay = DEFAULT_RATE_LIMITS[database] || 1000
      }
    } else {
      baseDelay = DEFAULT_RATE_LIMITS[database] || 1000
    }

    const multiplier = this.multipliers[database] || 1
    return baseDelay * multiplier
  }

  static handleRateLimit(database: string): void {
    const currentMultiplier = this.multipliers[database] || 1
    const newMultiplier = Math.min(currentMultiplier * 1.5, MAX_RATE_LIMIT_MULTIPLIER)
    this.multipliers[database] = newMultiplier

    ztoolkit.log(`Rate limit detected for ${database}: increasing multiplier to ${newMultiplier.toFixed(1)}x`)
  }

  static handleSuccess(database: string): void {
    const currentMultiplier = this.multipliers[database] || 1
    if (currentMultiplier > 1) {
      // Gradually decrease multiplier on success
      const newMultiplier = Math.max(currentMultiplier * 0.9, 1)
      this.multipliers[database] = newMultiplier

      if (newMultiplier < currentMultiplier) {
        ztoolkit.log(`Success for ${database}: decreasing multiplier to ${newMultiplier.toFixed(1)}x`)
      }
    }
  }

  static async waitForRateLimit(database: string): Promise<void> {
    const delay = this.getDelay(database)
    const lastRequest = this.lastRequestTime[database] || 0
    const now = Date.now()
    const timeSinceLastRequest = now - lastRequest

    if (timeSinceLastRequest < delay) {
      const waitTime = delay - timeSinceLastRequest
      ztoolkit.log(`Rate limiting ${database}: waiting ${waitTime}ms (${this.multipliers[database] || 1}x multiplier)`)
      await new Promise((resolve) => setTimeout(resolve, waitTime))
    }

    this.lastRequestTime[database] = Date.now()
  }
}

// Citation source operations

// Ignored items tracking
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

interface LookupResult {
  count: number
  status: 'success' | 'not_found' | 'api_error' | 'no_identifier' | 'rate_limited'
  message?: string
}

class IgnoredItemsManager {
  private static memoryCache = new Map<number, { databases: string[] }>() // Session-only cache for no_identifier
  private static loaded = false

  private static loadPersistentData(): IgnoredItemsData {
    if (!this.loaded) {
      this.loaded = true
    }
    const data = getPref('ignoredItems')
    return data ? JSON.parse(data) : {}
  }

  private static savePersistentData(data: IgnoredItemsData): void {
    setPref('ignoredItems', JSON.stringify(data))
  }

  private static shouldRetryItem(count: number, lastChecked: string): boolean {
    const now = new Date()
    const lastCheck = new Date(lastChecked)
    const timeDiff = now.getTime() - lastCheck.getTime()
    const daysDiff = timeDiff / (1000 * 3600 * 24)

    if (count === 1) {
      return daysDiff > 7 // 1 week
    } else if (count === 2) {
      return daysDiff > 30 // 1 month
    } else if (count === 3) {
      return daysDiff > 90 // 3 months
    } else if (count > 3) {
      return daysDiff > 180 // 6 months
    }
    return true // Should retry if count is 0 or unexpected
  }

  static markAsIgnored(
    itemId: number,
    database: string,
    reason: 'not_found' | 'no_identifier' | 'api_error',
    persistent = true,
  ): void {
    if (reason === 'no_identifier') {
      // Store in memory cache only for missing identifiers
      const memoryInfo = this.memoryCache.get(itemId) || { databases: [] }
      if (!memoryInfo.databases.includes(database)) {
        memoryInfo.databases.push(database)
      }
      this.memoryCache.set(itemId, memoryInfo)
      return
    }

    // Only track 'not_found' status persistently
    if (persistent && reason === 'not_found') {
      const data = this.loadPersistentData()
      const itemKey = itemId.toString()

      // Initialize database if not exists
      if (!data[database]) {
        data[database] = {}
      }

      // Initialize or update item data
      if (!data[database][itemKey]) {
        data[database][itemKey] = {
          count: 1,
          lastChecked: new Date().toISOString(),
        }
      } else {
        data[database][itemKey].count++
        data[database][itemKey].lastChecked = new Date().toISOString()
      }

      this.savePersistentData(data)
    }
  }

  static isIgnored(itemId: number, database: string, autoUpdateOnly = false): boolean {
    // If this is manual update, never skip
    if (!autoUpdateOnly) {
      return false
    }

    // Check memory cache first (for no_identifier items)
    if (this.memoryCache.has(itemId)) {
      return this.memoryCache.get(itemId)!.databases.includes(database)
    }

    // Check persistent storage for not_found items
    const data = this.loadPersistentData()
    const itemKey = itemId.toString()

    if (data[database]?.[itemKey]) {
      const itemData = data[database][itemKey]
      // Check if enough time has passed to retry based on failure count
      return !this.shouldRetryItem(itemData.count, itemData.lastChecked)
    }

    return false
  }

  static clearIgnoredItem(itemId: number, database?: string): void {
    // Clear from memory cache
    if (database) {
      const memoryInfo = this.memoryCache.get(itemId)
      if (memoryInfo) {
        memoryInfo.databases = memoryInfo.databases.filter((db) => db !== database)
        if (memoryInfo.databases.length === 0) {
          this.memoryCache.delete(itemId)
        }
      }
    } else {
      this.memoryCache.delete(itemId)
    }

    // Clear from persistent storage
    const data = this.loadPersistentData()
    const itemKey = itemId.toString()

    if (database) {
      // Clear specific database-item combination
      if (data[database]?.[itemKey]) {
        delete data[database][itemKey]
        // Clean up empty database objects
        if (Object.keys(data[database]).length === 0) {
          delete data[database]
        }
        this.savePersistentData(data)
      }
    } else {
      // Clear item from all databases
      let modified = false
      for (const dbKey of Object.keys(data)) {
        if (data[dbKey][itemKey]) {
          delete data[dbKey][itemKey]
          modified = true
          // Clean up empty database objects
          if (Object.keys(data[dbKey]).length === 0) {
            delete data[dbKey]
          }
        }
      }
      if (modified) {
        this.savePersistentData(data)
      }
    }
  }

  static cleanupNonExistentItems(): void {
    const data = this.loadPersistentData()
    let modified = false

    for (const database of Object.keys(data)) {
      for (const itemKey of Object.keys(data[database])) {
        const itemId = parseInt(itemKey)
        try {
          const item = Zotero.Items.get(itemId)
          if (!item || item.deleted) {
            delete data[database][itemKey]
            modified = true
          }
        } catch (e) {
          // Item doesn't exist, remove it
          delete data[database][itemKey]
          modified = true
        }
      }

      // Clean up empty database objects
      if (Object.keys(data[database]).length === 0) {
        delete data[database]
        modified = true
      }
    }

    if (modified) {
      this.savePersistentData(data)
      ztoolkit.log('Citation debug - Cleaned up ignored items for non-existent library items')
    }
  }
}

// Schedule monthly cleanup
let cleanupTimer: NodeJS.Timeout | null = null

function scheduleMonthlyCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
  }

  // Run cleanup every 30 days (30 * 24 * 60 * 60 * 1000 ms)
  cleanupTimer = setInterval(
    () => {
      void IgnoredItemsManager.cleanupNonExistentItems()
    },
    30 * 24 * 60 * 60 * 1000,
  )

  // Also run cleanup on startup
  setTimeout(() => {
    void IgnoredItemsManager.cleanupNonExistentItems()
  }, 5000) // Delay 5 seconds after startup
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

// Database colors
const databaseColors: Record<string, string> = {
  crossref: '#1a73e8', // Blue
  inspire: '#0f9d58', // Green
  semanticscholar: '#ea4335', // Red
}

function insertBeforeMatch(arr: string[], pattern: RegExp, newItem: string): void {
  const index = arr.findIndex((item) => pattern.test(item))
  if (index !== -1) {
    arr.splice(index, 0, newItem)
  } else {
    arr.push(newItem) // If no match, append at the end
  }
}

class Helpers {
  /**
   * Get DOI or arXiv ID from item
   * @param item Zotero item
   * @returns Object with type and id, or null if neither found
   */
  static getItemIdentifier(item: Zotero.Item): { type: string; id: string } | null {
    const doi = item.getField('DOI')
    if (doi) {
      return { type: 'doi', id: doi }
    }

    // Check for arXiv ID in Extra field
    const extra = item.getField('extra')
    if (extra) {
      const arXivMatch = /arXiv:\s*([\w.-]+\/\d+|\d+\.\d+)/i.exec(extra)
      if (arXivMatch) {
        return { type: 'arxiv', id: arXivMatch[1] }
      }
    }

    return null
  }

  static getDatabasePrefArray(): string[] {
    const databaseOrder = getPref('databaseOrder') || 'crossref'
    const databaseArray = databaseOrder.split(',').map((db: string) => db.trim())
    if (databaseArray.length === 0) {
      ztoolkit.log('Citation debug - No databases configured in preferences')
    }
    return databaseArray
  }

  static getDatabaseArray(operations: string[] | string | undefined): string[] {
    if (operations === undefined) {
      return Helpers.getDatabasePrefArray()
    } else if (typeof operations === 'string') {
      return operations.split(',').map((db: string) => db.trim())
    } else if (Array.isArray(operations)) {
      return operations.map((db: string) => db.trim())
    }
    ztoolkit.log('Citation debug - No databases found')
    return []
  }
}
interface CountInfo {
  title: string // Database tag (e.g., 'crossref')
  count: number // Citation count
}
type CountArray = CountInfo[]

class Core {
  /**
   * Store citation count in the Extra field
   * @param item Zotero item
   * @param tag Citation source tag
   * @param count Citation count number
   */
  static async setCitationCount(item: Zotero.Item, data: CountArray) {
    let extra = item.getField('extra')
    if (!extra) {
      extra = ''
    }

    ztoolkit.log('Citation debug - Setting citation count for item:', item.id, 'count:', data)
    ztoolkit.log('Citation debug - Original Extra field:', extra)

    const extras = extra.split('\n')

    const dbTitles: string[] = data.map((d) => d.title.trim())

    const titlePattern = `(?:${dbTitles.join('|')})`

    const patt_this = new RegExp(`^Citations: *\\d+ *\\(${titlePattern}\\) *\\[\\d{4}-\\d{1,2}-\\d{1,2}\\]`, 'i') ///REGEXP

    const patt0 = new RegExp(`^Citation *Count: *\\d+ *\\(${titlePattern}\\) *\\[\\d{4}-\\d{1,2}-\\d{1,2}\\]`, 'i')
    const patt1 = new RegExp(`^Citations \\(${titlePattern}\\): \d+`, 'i')
    const patt2 = new RegExp(`^\\d+ citations \\(${titlePattern}\\)`, 'i')
    const patt3 = new RegExp(`^\\d+ citations \\(${titlePattern}\\) \\[\\d{4}-\\d{1,2}-\\d{1,2}\\]`, 'i')
    const patt4 = new RegExp('^Citations: *\\d+ \\(citationtally-database-\\w+\\) \\[\\d{4}-\\d{1,2}-\\d{1,2}\\]', 'i') // TEMP
    const patt_old = new RegExp(
      '^\\d+ citations \\((?:Crossref\\/DOI|Inspire\\/DOI|Inspire\\/arXiv|Semantic Scholar\\/DOI|Semantic Scholar\\/arXiv)\\) \\[\\d{4}-\\d{1,2}-\\d{1,2}\\]',
      'i',
    )

    const patterns: RegExp[] = [patt_this, patt0, patt1, patt2, patt3, patt4, patt_old]
    ztoolkit.log('Citation debug - Search patterns NEW:', patterns)

    // Remove old lines that match any of the patterns
    const filteredExtras: string[] = extras.filter((line) => {
      // const matches = patt0.test(ex) || patt1.test(ex) || patt2.test(ex) || patt3.test(ex) || patt_old.test(ex)
      let match = false

      for (const pattern of patterns) {
        if (pattern.test(line)) {
          match = true
          break
        }
      }

      if (match) {
        ztoolkit.log('Citation debug - Removing old entry:', line)
      }
      return !match
    })

    // Format date
    const today = new Date()
    const dd = String(today.getDate()).padStart(2, '0')
    const mm = String(today.getMonth() + 1).padStart(2, '0') // January is 0!
    const yyyy = today.getFullYear()
    const date = `${yyyy}-${mm}-${dd}`

    // Add new counts
    for (const { title, count } of data) {
      const newEntry = `Citations: ${count} (${title}) [${date}]` ///REGEXP

      // Insert as low as possible but before the BBT citation
      const bbtcitekeypattern = new RegExp('^Citation Key: \\S+', 'i')
      insertBeforeMatch(filteredExtras, bbtcitekeypattern, newEntry)
      ztoolkit.log('Citation debug - Added new entry:', newEntry)
    }

    // Join and set
    const newExtra = filteredExtras.join('\n')
    item.setField('extra', newExtra)
    await item.saveTx()
    ztoolkit.log('Citation debug - New Extra field:', newExtra)
  }

  /**
   * Extract citation count from the Extra field for display in custom column
   * @param item Zotero item
   * @returns Object with counts and databases for rendering
   */
  static getCitationCountForColumn(item: Zotero.Item): { counts: string[]; databases: string[] } | null {
    // Get user's preferred database order
    const databaseOrder = getPref('databaseOrder') || 'crossref'
    const operationsIncluded = databaseOrder.split(',').map((db: string) => db.trim())

    const extra = item.getField('extra')
    if (!extra) {
      return null
    }

    const extras = extra.split('\n')
    const found: Record<string, number> = {}

    for (const tag_ of operationsIncluded) {
      found[tag_] = -1 // Initialize with -1 to indicate not found
    }

    for (const tag_ of operationsIncluded) {
      const tagName = getOperationName(tag_)
      const patt0 = new RegExp(`^Citations: *(\\d+) *\\(${tagName}\\) *\\[\\d{4}-\\d{1,2}-\\d{1,2}\\]`, 'i') ///REGEXP
      const patt1 = new RegExp(`^Citations: *(\\d+) *\\(${tagName}\\)`, 'i') ///REGEXP

      for (const ex of extras) {
        let match = patt0.exec(ex)
        if (!match) {
          match = patt1.exec(ex)
        }

        if (match?.[1]) {
          found[tag_] = parseInt(match[1])
          break
        }
      }
    }

    // Format output
    const counts: string[] = []
    const databases: string[] = []

    for (const tag of operationsIncluded) {
      const count = found[tag]
      counts.push(count >= 0 ? count.toString() : '-')
      databases.push(tag)
    }

    // Only return if at least one count was found
    const hasAnyCount = counts.some((count) => count !== '-')
    return hasAnyCount ? { counts, databases } : null
  }

  /**
   * Extract citation count from Extra field
   * @param item Zotero item
   * @param tag Citation source tag
   * @returns Citation count or -1 if not found
   */
}

class DBInterface {
  /**
   * Get citation count from Crossref
   * @param item Zotero item
   * @returns Citation count or -1 if not found/error
   */
  static async getCrossrefCount(item: Zotero.Item): Promise<number> {
    const result = await this.getCrossrefCountEnhanced(item)
    return result.count
  }

  /**
   * Get citation count from Crossref with enhanced status information
   * @param item Zotero item
   * @returns LookupResult with count and status
   */
  static async getCrossrefCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    const identifier = Helpers.getItemIdentifier(item)
    if (!identifier || identifier.type !== 'doi') {
      ztoolkit.log('Citation debug - No DOI found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI found' }
    }
    const edoi = encodeURIComponent(identifier.id)
    ztoolkit.log('Citation debug - Encoded DOI:', edoi)

    // Apply adaptive rate limiting
    await RateLimitManager.waitForRateLimit('crossref')

    let response: any = null

    try {
      const style = 'vnd.citationstyles.csl+json'
      const xform = `transform/application/${style}`
      const url = `https://api.crossref.org/works/${edoi}/${xform}`
      ztoolkit.log('Citation debug - Fetching from Crossref API:', url)

      response = await fetch(url)
        .then((response) => {
          ztoolkit.log('Citation debug - Crossref API response status:', response.status)
          return response.json()
        })
        .catch((error) => {
          ztoolkit.log('Citation debug - Crossref API fetch error:', error)
          return null
        })

      if (response === null) {
        ztoolkit.log('Citation debug - Crossref API failed, trying DOI.org')
        const url = `https://doi.org/${edoi}`
        const doiResponse = await fetch(url, {
          headers: {
            Accept: `application/${style}`,
          },
        })

        if (doiResponse.status === 404) {
          return { count: 0, status: 'not_found', message: 'DOI not found in Crossref' }
        }

        if (doiResponse.status === 429) {
          RateLimitManager.handleRateLimit('crossref')
          return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
        }

        response = await doiResponse.json().catch((error) => {
          ztoolkit.log('Citation debug - DOI.org fetch error:', error)
          return null
        })
      }

      if (response === null) {
        // Something went wrong
        ztoolkit.log('Citation debug - Both API requests failed')
        return { count: -1, status: 'api_error', message: 'API requests failed' }
      }

      ztoolkit.log('Citation debug - API response:', JSON.stringify(response).substring(0, 500) + '...')

      const count: unknown = response['is-referenced-by-count']
      if (count === undefined) {
        ztoolkit.log('Citation debug - No is-referenced-by-count field in response')
        return { count: 0, status: 'not_found', message: 'No citation count field in response' }
      }
      if (typeof count === 'number') {
        ztoolkit.log('Citation debug - is-referenced-by-count is not a number:', count)
        RateLimitManager.handleSuccess('crossref')
        return { count, status: 'success' }
      }
      if (typeof count === 'string') {
        ztoolkit.log('Citation debug - is-referenced-by-count is a string:', count)
        ztoolkit.log('Citation debug - Citation count from API:', count)
        RateLimitManager.handleSuccess('crossref')
        return { count: parseInt(count), status: 'success' }
      }
      return { count: -1, status: 'api_error', message: 'Invalid response format' }
    } catch (err) {
      ztoolkit.log('Error getting citation count from Crossref', err)
      return { count: -1, status: 'api_error', message: (err as Error).message }
    }
  }

  /**
   * Get citation count from INSPIRE
   * @param item Zotero item
   * @returns Citation count or -1 if not found/error
   */
  static async getInspireCount(item: Zotero.Item): Promise<number> {
    const result = await this.getInspireCountEnhanced(item)
    return result.count
  }

  /**
   * Get citation count from INSPIRE with enhanced status information
   * @param item Zotero item
   * @returns LookupResult with count and status
   */
  static async getInspireCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    const identifier = Helpers.getItemIdentifier(item)
    if (!identifier) {
      ztoolkit.log('Citation debug - No DOI or arXiv ID found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI or arXiv ID found' }
    }

    // Apply adaptive rate limiting
    await RateLimitManager.waitForRateLimit('inspire')

    let response: any = null

    try {
      const type = identifier.type === 'doi' ? 'dois' : 'arxiv'
      const url = `https://inspirehep.net/api/${type}/${identifier.id}`
      ztoolkit.log('Citation debug - Fetching from INSPIRE API:', url)

      const fetchResponse = await fetch(url)

      if (fetchResponse.status === 404) {
        return { count: 0, status: 'not_found', message: 'Item not found in INSPIRE' }
      }

      if (fetchResponse.status === 429) {
        RateLimitManager.handleRateLimit('inspire')
        return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
      }

      response = await fetchResponse.json().catch((error) => {
        ztoolkit.log('Citation debug - INSPIRE API fetch error:', error)
        return null
      })

      if (response === null) {
        ztoolkit.log('Citation debug - INSPIRE API request failed')
        return { count: -1, status: 'api_error', message: 'API request failed' }
      }

      ztoolkit.log('Citation debug - INSPIRE API response:', JSON.stringify(response).substring(0, 500) + '...')

      const count = response?.metadata?.citation_count
      if (count === undefined) {
        ztoolkit.log('Citation debug - No citation_count field in INSPIRE response')
        return { count: 0, status: 'not_found', message: 'No citation count field' }
      }
      if (typeof count === 'number') {
        ztoolkit.log('Citation debug - INSPIRE citation count:', count)
        RateLimitManager.handleSuccess('inspire')
        return { count, status: 'success' }
      }
      if (typeof count === 'string') {
        ztoolkit.log('Citation debug - INSPIRE citation count (string):', count)
        RateLimitManager.handleSuccess('inspire')
        return { count: parseInt(count), status: 'success' }
      }
      return { count: -1, status: 'api_error', message: 'Invalid response format' }
    } catch (err) {
      ztoolkit.log('Error getting citation count from INSPIRE', err)
      return { count: -1, status: 'api_error', message: (err as Error).message }
    }
  }

  /**
   * Get citation count from Semantic Scholar
   * @param item Zotero item
   * @returns Citation count or -1 if not found/error
   */
  static async getSemanticScholarCount(item: Zotero.Item): Promise<number> {
    const result = await this.getSemanticScholarCountEnhanced(item)
    return result.count
  }

  /**
   * Get citation count from Semantic Scholar with enhanced status information
   * @param item Zotero item
   * @returns LookupResult with count and status
   */
  static async getSemanticScholarCountEnhanced(item: Zotero.Item): Promise<LookupResult> {
    const identifier = Helpers.getItemIdentifier(item)
    if (!identifier) {
      ztoolkit.log('Citation debug - No DOI or arXiv ID found for item:', item.id)
      return { count: -1, status: 'no_identifier', message: 'No DOI or arXiv ID found' }
    }

    // Apply adaptive rate limiting
    await RateLimitManager.waitForRateLimit('semanticscholar')

    let response: any = null

    try {
      const prefix = identifier.type === 'doi' ? '' : 'arXiv:'
      const url = `https://api.semanticscholar.org/graph/v1/paper/${prefix}${identifier.id}?fields=citationCount`
      ztoolkit.log('Citation debug - Fetching from Semantic Scholar API:', url)

      const fetchResponse = await fetch(url)

      if (fetchResponse.status === 404) {
        return { count: 0, status: 'not_found', message: 'Item not found in Semantic Scholar' }
      }

      if (fetchResponse.status === 429) {
        RateLimitManager.handleRateLimit('semanticscholar')
        return { count: -1, status: 'rate_limited', message: 'API rate limit exceeded' }
      }

      response = await fetchResponse.json().catch((error) => {
        ztoolkit.log('Citation debug - Semantic Scholar API fetch error:', error)
        return null
      })

      if (response === null) {
        ztoolkit.log('Citation debug - Semantic Scholar API request failed')
        return { count: -1, status: 'api_error', message: 'API request failed' }
      }

      ztoolkit.log(
        'Citation debug - Semantic Scholar API response:',
        JSON.stringify(response).substring(0, 500) + '...',
      )

      const count = response?.citationCount
      if (count === undefined) {
        ztoolkit.log('Citation debug - No citationCount field in Semantic Scholar response')
        return { count: 0, status: 'not_found', message: 'No citation count field' }
      }

      if (typeof count === 'number') {
        ztoolkit.log('Citation debug - Semantic Scholar citation count:', count)
        RateLimitManager.handleSuccess('semanticscholar')
        return { count, status: 'success' }
      }
      if (typeof count === 'string') {
        ztoolkit.log('Citation debug - Semantic Scholar citation count (string):', count)
        RateLimitManager.handleSuccess('semanticscholar')
        return { count: parseInt(count), status: 'success' }
      }
      return { count: -1, status: 'api_error', message: 'Invalid response format' }
    } catch (err) {
      ztoolkit.log('Error getting citation count from Semantic Scholar', err)
      return { count: -1, status: 'api_error', message: (err as Error).message }
    }
  }
}

// Notifier callback to detect newly added items
const notifierCallback = {
  notify: function (event: string, type: string, ids: number[] | string[], extraData: any) {
    if (event === 'add' && type === 'item') {
      const items = ids
        .map((id) => Zotero.Items.get(id as number))
        .filter((item) => !item.isFeedItem && item.isRegularItem())
      if (items.length > 0) {
        ztoolkit.log(
          'New regular items added with IDs:',
          items.map((item) => item.id),
        )
        updateItems(items)
      }
    }
  },
}

// Progress window tracking
let progressWindow: any
let currentIndex = -1
let totalItems = 0
let itemsToUpdate: Zotero.Item[] = []
let updatedCount = 0

/**
 * Reset the state of the citation count update process
 */
function resetState() {
  if (progressWindow) {
    progressWindow.close()
    progressWindow = null
  }
  currentIndex = -1
  totalItems = 0
  itemsToUpdate = []
  updatedCount = 0
}

/**
 * Update citation counts for an array of items
 * @param items Array of Zotero items to update
 * @param operation Citation source to use (e.g., 'crossref')
 */
function updateItems(items: Zotero.Item[], operations?: string[] | string, silent: boolean = false) {
  // Filter out non-regular items
  const regularItems = items.filter((item) => item.isRegularItem())

  if (regularItems.length === 0) {
    if (!silent) {
      // Show message if no regular items are selected
      new ztoolkit.ProgressWindow('Citation Counts', {
        closeOnClick: true,
      })
        .createLine({
          text: getString('progress-no-valid-items'),
          type: 'error',
        })
        .show()
        .startCloseTimer(3000)
    }
    return
  }

  resetState()
  totalItems = regularItems.length
  itemsToUpdate = regularItems

  if (!silent) {
    // Create progress window
    progressWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName)

    progressWindow.createLine({
      text: getString('progress-getting-citation-tallies'),
      type: 'default',
      progress: 0,
    })
  }

  updateNextItem(operations, silent)
}

/**
 * Process the next item in the queue
 * @param operation Citation source to use
 */
function updateNextItem(operations?: string[] | string, silent: boolean = false) {
  // Move to next item
  currentIndex++

  // Check if we're done
  if (currentIndex >= totalItems) {
    if (progressWindow) {
      progressWindow.close()
      progressWindow = null
    }
    if (!silent) {
      const successWindow = new ztoolkit.ProgressWindow(addon.data.config.addonName)

      successWindow.createLine({
        text: getString('progress-items-updated', { args: { count: updatedCount } }),
        type: 'success',
        progress: 100,
      })
      successWindow.show()
      successWindow.startCloseTimer(4000)
    }
    return
  }

  // Update progress
  const percent = Math.round((currentIndex / totalItems) * 100)
  if (!silent && progressWindow) {
    progressWindow.changeLine({
      text: getString('progress-item-counter', { args: { current: currentIndex + 1, total: totalItems } }),
      progress: percent,
    })
    progressWindow.show()
  }

  // Process current item
  const item = itemsToUpdate[currentIndex]

  void updateItem(item, operations, silent, false) // Manual updates don't respect unlisted cache
}

/**
 * Update a single item's citation count
 * @param item Zotero item to update
 * @param operation Citation source to use
 * @param isAutoUpdate Whether this is called from auto-update (to respect unlisted cache)
 */
async function updateItem(
  item: Zotero.Item,
  operations?: string[] | string,
  silent: boolean = false,
  isAutoUpdate: boolean = false,
) {
  try {
    ztoolkit.log('Citation debug - Updating item:', item.id, 'title:', item.getField('title'))

    const databases = Helpers.getDatabaseArray(operations)
    if (databases.length === 0) {
      ztoolkit.log('Citation debug - No databases configured, skipping item:', item.id)
      return
    }

    const data: CountArray = []
    for (const operation of databases) {
      // Check if this item is marked as ignored for this database (auto-update only)
      if (isAutoUpdate && IgnoredItemsManager.isIgnored(item.id, operation, true)) {
        ztoolkit.log(`Citation debug - Skipping ${operation} for item ${item.id} (marked as ignored)`)
        continue
      }

      let result: LookupResult
      let displayName = ''
      if (operation === 'crossref') {
        ztoolkit.log('Citation debug - DOI:', item.getField('DOI'))
        result = await DBInterface.getCrossrefCountEnhanced(item)
        displayName = getOperationName(operation)
      } else if (operation === 'inspire') {
        result = await DBInterface.getInspireCountEnhanced(item)
        displayName = getOperationName(operation)
      } else if (operation === 'semanticscholar') {
        result = await DBInterface.getSemanticScholarCountEnhanced(item)
        displayName = getOperationName(operation)
      } else {
        continue
      }

      // Handle the result and update tracking
      if (result.status === 'not_found') {
        ztoolkit.log(`Citation debug - ${operation} confirmed item ${item.id} as not found`)
        IgnoredItemsManager.markAsIgnored(item.id, operation, 'not_found', true)
      } else if (result.status === 'no_identifier') {
        ztoolkit.log(`Citation debug - ${operation} no identifier for item ${item.id}`)
        IgnoredItemsManager.markAsIgnored(item.id, operation, 'no_identifier', false)
      } else if (result.status === 'success' && result.count >= 0) {
        // Clear any previous ignored status if we got a successful result
        IgnoredItemsManager.clearIgnoredItem(item.id, operation)
        data.push({ title: displayName, count: result.count })
      } else if (result.status === 'api_error' || result.status === 'rate_limited') {
        ztoolkit.log(`Citation debug - ${operation} API error for item ${item.id}: ${result.message}`)
        // Don't mark as ignored for API errors, just skip
      }
    }

    ztoolkit.log('Citation debug - Retrieved count:', data)

    if (data.length > 0) {
      await Core.setCitationCount(item, data)
      ztoolkit.log('Citation debug - Item saved with new citation count')
      updatedCount++
    } else {
      ztoolkit.log('Citation debug - No valid count retrieved, skipping update')
    }
  } catch (e) {
    ztoolkit.log('Error updating citation count for item', e)
  }

  // Process next item
  updateNextItem(operations, silent)
}

class BasicRegistrar {
  static registerPrefs() {
    Zotero.PreferencePanes.register({
      pluginID: addon.data.config.addonID,
      src: rootURI + 'content/preferences.xhtml',
      label: getString('prefs-title'),
      image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    })
  }
}

class UIRegistrar {
  /**
   * Register custom column to display citation counts
   */
  static registerCitationColumn() {
    ztoolkit.log('Citation debug - Registering citation count column')
    Zotero.ItemTreeManager.registerColumn({
      pluginID: addon.data.config.addonID,
      dataKey: 'citationCount',
      label: getString('column-citations'),
      dataProvider: (item: Zotero.Item) => {
        ztoolkit.log('Citation debug - Data provider called for item:', item.id)

        // Debug the raw item info
        try {
          ztoolkit.log('Citation debug - Item fields available:', Object.keys(item))
          ztoolkit.log('Citation debug - Item type:', item.itemTypeID, item.itemType)

          // // Log all available fields for this item
          // const fields = Zotero.ItemFields.getItemTypeFields(item.itemTypeID)
          // ztoolkit.log('Citation debug - Available fields:', fields)

          // // Check if the item has extra field data
          // if (item.hasOwnProperty('_extraFields')) {
          //   ztoolkit.log('Citation debug - Extra fields:', JSON.stringify(item._extraFields))
          // } else {
          //   ztoolkit.log('Citation debug - Extra fields - not found')
          // }

          // // Check for the DCounts field mentioned in the error
          // if (item.hasOwnProperty('_fieldData')) {
          //   ztoolkit.log('Citation debug - Field data:', JSON.stringify(item._fieldData))
          // } else {
          //   ztoolkit.log('Citation debug - Field data - not found')
          // }

          // Check for parent item if this is a child item
          if (item.isAttachment() || item.isNote()) {
            const parentItemID = item.parentItemID
            ztoolkit.log('Citation debug - Parent item ID:', parentItemID)
            if (parentItemID) {
              const parentItem = Zotero.Items.get(parentItemID)
              ztoolkit.log('Citation debug - Parent item type:', parentItem.itemTypeID)
            }
          }
        } catch (error) {
          ztoolkit.log('Citation debug - Error inspecting item:', error)
        }

        const result = Core.getCitationCountForColumn(item)
        // Return JSON string that renderCell will parse
        return result ? JSON.stringify(result) : ''
      },
      // iconPath: 'chrome://zotero/skin/citations.png',
      renderCell(index, data: any, column, isFirstColumn, doc) {
        ztoolkit.log('Citation debug - Rendering cell with data:', data)
        const span = doc.createElement('span')
        span.className = `cell ${column.className}`
        span.style.textAlign = 'center'

        // Parse JSON data if it's a string
        let parsedData: { counts: string[]; databases: string[] } | null = null
        if (data && typeof data === 'string') {
          try {
            parsedData = JSON.parse(data)
          } catch (e) {
            // If not JSON, just display as text
            span.innerText = data
            return span
          }
        } else if (!data) {
          span.innerText = ''
          return span
        }

        // Create colored spans for each count
        const dataToUse = parsedData || data
        const useColors = getPref('useColors') === 'color' && dataToUse.databases.length > 1

        dataToUse.counts.forEach((count: string, idx: number) => {
          if (idx > 0) {
            const separator = doc.createElement('span')
            separator.innerText = ' | '
            separator.style.color = '#666'
            span.appendChild(separator)
          }

          const countSpan = doc.createElement('span')
          countSpan.innerText = count
          if (useColors) {
            countSpan.style.color = databaseColors[dataToUse.databases[idx]] || '#000'
            countSpan.style.fontWeight = '500'
          }
          span.appendChild(countSpan)
        })

        // Add tooltip with database names
        const tooltip = dataToUse.databases
          .map((db: string, idx: number) => {
            const displayName = getOperationName(db)
            return getString('tooltip-citation-tallies', { args: { displayName, count: dataToUse.counts[idx] } })
          })
          .join(', ')
        span.title = tooltip

        return span
      },
    })
    ztoolkit.log('Citation debug - Column registration complete')
  }

  /**
   * Register the notifier to detect new items
   */
  static registerNotifier() {
    const notifierID = Zotero.Notifier.registerObserver(notifierCallback, ['item'])

    // Unregister when the addon is disabled/uninstalled
    Zotero.Plugins.addObserver({
      shutdown: ({ id }: { id: string }) => {
        if (id === addon.data.config.addonID) {
          Zotero.Notifier.unregisterObserver(notifierID)
        }
      },
    })
  }

  /**
   * Register a context menu item to update citation counts for selected items
   */
  static registerCitationCountMenuItem() {
    const menuIcon = 'chrome://zotero/skin/toolbar-advanced-search.png'

    // context menu item for updating citation counts
    ztoolkit.Menu.register('item', {
      tag: 'menuitem',
      id: 'zotero-itemmenu-update-citation-counts',
      label: getString('menuitem-update-citation-tallies'),
      commandListener: (ev) => addon.hooks.onDialogEvents('updateCitationCounts'),
      icon: menuIcon,
      // Only show menu item when there are valid items that can be updated
      getVisibility: () => {
        try {
          const zoteroPane = Zotero.getActiveZoteroPane()
          if (!zoteroPane) return false

          const selectedItems = zoteroPane.getSelectedItems()
          if (!selectedItems || selectedItems.length === 0) return false

          // Check if any selected items are regular items (not attachments, notes, etc.)
          const hasRegularItems = selectedItems.some((item) => item.isRegularItem())
          return hasRegularItems
        } catch (error) {
          // If there's an error checking, don't show the menu item
          return false
        }
      },
    })
  }

  /**
   * Register a menubar item to retally outdated item citations
   */
  static registerRetallyCitationsMenuItem() {
    // Add separator before our menu item
    ztoolkit.Menu.register('menuTools', {
      tag: 'menuseparator',
    })

    // Register in Tools menu
    ztoolkit.Menu.register('menuTools', {
      tag: 'menuitem',
      id: 'zotero-toolsmenu-retally-outdated-citations',
      label: getString('menuitem-retally-outdated-citations'),
      oncommand: "Zotero.__addonInstance__.hooks.onDialogEvents('retallyOutdatedCitations')",
    })
  }
}

class UX {
  /**
   * Update citation counts for all selected items
   */
  static updateSelectedItemsCitationCounts() {
    // Get selected items
    const items = Zotero.getActiveZoteroPane().getSelectedItems()

    // // Log diagnostic info about the selected items
    // ztoolkit.log('Citation debug - Selected items count:', items.length)
    // for (const item of items) {
    //   ztoolkit.log('Citation debug - Selected item ID:', item.id, 'Type:', item.itemType)

    //   // Check Extra field content
    //   const extra = item.getField('extra')
    //   ztoolkit.log('Citation debug - Extra field content:', extra)

    //   // Check for the DCounts field mentioned in the error
    //   try {
    //     // Attempt to access raw item data to debug the "DCounts" field
    //     const itemData = item.toJSON()
    //     ztoolkit.log('Citation debug - Item JSON data:', JSON.stringify(itemData).substring(0, 500))

    //     // Check for custom fields/properties
    //     ztoolkit.log('Citation debug - Item field names:', Object.getOwnPropertyNames(item))

    //     // Check if this is a library item
    //     const libraryID = item.libraryID
    //     ztoolkit.log('Citation debug - Item library ID:', libraryID)

    //     // Check if the item has a DOI
    //     const doi = item.getField('DOI')
    //     ztoolkit.log('Citation debug - Item DOI:', doi)
    //   } catch (error) {
    //     ztoolkit.log('Citation debug - Error inspecting selected item:', error)
    //   }
    // }

    // Filter for regular items
    // const regularItems = items.filter((item) => item.isRegularItem())
    // ztoolkit.log('Citation debug - Regular items count:', regularItems.length)

    // if (regularItems.length === 0) {
    //   // Show message if no regular items are selected
    //   new ztoolkit.ProgressWindow('Citation Counts', {
    //     closeOnClick: true,
    //   })
    //     .createLine({
    //       text: 'No valid items selected for citation count update.',
    //       type: 'error',
    //     })
    //     .show()
    //     .startCloseTimer(3000)
    //   return
    // }

    // Update citation counts for selected items using the existing function

    // new ztoolkit.ProgressWindow('DEBUG', {
    //   closeOnClick: true,
    // })
    //   .createLine({
    //     text: getPref('databaseOrder'),
    //     type: 'error',
    //   })
    //   .show()
    //   .startCloseTimer(3000)
    // return

    updateItems(items)
  }
}

// Export functions needed by autoupdate module
export { DBInterface, Core, Helpers, UIRegistrar, BasicRegistrar, UX, updateItem, scheduleMonthlyCleanup }
