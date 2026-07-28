/**
 * Tells the user when Semantic Scholar is off because the bootstrap bridge
 * couldn't resolve the Web APIs it needs. The bridge report decides
 * availability; this module is only how that shows up in the UI.
 */

import { getString } from '../utils/locale'
import { getPref } from '../utils/prefs'

import { SEMANTIC_SCHOLAR_DATABASE } from './citationTypes'
import { isSemanticScholarAvailable } from './semanticScholarClient'

const NOTICE_CLOSE_MS = 8000

let proactiveNoticeShown = false
let degradedLogged = false
let noticeToast: { close: () => void } | null = null

function semanticScholarConfigured(): boolean {
  const raw = getPref('databaseOrder')
  if (typeof raw !== 'string') return false
  return raw
    .split(',')
    .map((database) => database.trim())
    .includes(SEMANTIC_SCHOLAR_DATABASE)
}

function logDegradedOnce(): void {
  if (degradedLogged) return
  degradedLogged = true
  Zotero.logError(new Error('Citation Tally: Semantic Scholar is unavailable in this Zotero runtime'))
}

function showNoticeToast(): boolean {
  const win = Zotero.getMainWindow() as Window | null | undefined
  if (!win) return false
  closeDegradedNotice()
  const toast = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    window: win,
    closeOnClick: true,
    closeTime: NOTICE_CLOSE_MS,
  })
  toast.createLine({ text: getString('semantic-scholar-unavailable'), type: 'fail' }).show()
  noticeToast = toast
  return true
}

/**
 * Shown once per bundle, at first main-window load, when Semantic Scholar is
 * configured but unavailable, so that someone who only ever uses background
 * updates finds out why nothing is happening. The flag is set only if the toast
 * actually shows.
 */
export function maybeShowProactiveDegradedNotice(): void {
  try {
    if (proactiveNoticeShown) return
    if (isSemanticScholarAvailable()) return
    if (!semanticScholarConfigured()) return
    logDegradedOnce()
    if (showNoticeToast()) proactiveNoticeShown = true
  } catch (e) {
    ztoolkit.log(`Citation Tally: degraded notice failed: ${String(e)}`)
  }
}

/**
 * Shown at user action time: update-selected, retally, or saving a database
 * order that includes Semantic Scholar. A notice must never break the action.
 */
export function notifySemanticScholarUnavailable(): void {
  try {
    if (isSemanticScholarAvailable()) return
    if (!semanticScholarConfigured()) return
    logDegradedOnce()
    showNoticeToast()
  } catch (e) {
    ztoolkit.log(`Citation Tally: degraded notice failed: ${String(e)}`)
  }
}

/** Drop the window reference (main-window unload and shutdown). */
export function closeDegradedNotice(): void {
  if (noticeToast !== null) {
    try {
      noticeToast.close()
    } catch {
      // The window may already be destroyed.
    }
    noticeToast = null
  }
}
