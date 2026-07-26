import { config } from '../../package.json'
import { getPref, setPref } from '../utils/prefs'

import { SEMANTIC_SCHOLAR_DATABASE } from './citationTypes'
import { notifySemanticScholarUnavailable } from './degradedNotice'
import {
  type CommitResult,
  getSemanticScholarClient,
  isSemanticScholarAvailable,
  type ValidationStatus,
} from './semanticScholarClient'

/** Statuses shown in the API-key row beyond validation outcomes. */
type ApiKeyUiStatus = ValidationStatus | 'checking' | 'neutral' | 'unavailable'

// Preferences use a separate localization context, so these strings are local.
function getPrefsString(key: string): string {
  const strings: Record<string, string> = {
    'pref-database-valid': 'Valid database configuration',
    'pref-database-duplicate': 'Duplicate databases found',
    'pref-database-invalid': 'Invalid database(s): %s',
    'pref-database-count': 'Please enter 1-3 databases',
    'pref-database-empty': 'Please enter at least one database',
    'pref-apikey-valid': '✓ API key is valid',
    'pref-apikey-invalid': '✗ API key was rejected',
    'pref-apikey-indeterminate': 'Could not validate right now — try again',
    'pref-apikey-empty': 'No key set (using shared, unauthenticated access)',
    'pref-apikey-error': 'Semantic Scholar returned an unexpected error',
    'pref-apikey-checking': 'Checking…',
    'pref-apikey-unavailable': 'Semantic Scholar is unavailable in this Zotero runtime',
  }
  return strings[key] || key
}

const apiKeyInputId = `zotero-prefpane-${config.addonRef}-semanticScholarApiKey`
const apiKeyStatusId = `${apiKeyInputId}-status`
const apiKeyShowId = `${apiKeyInputId}-show`
const apiKeyValidateId = `${apiKeyInputId}-validate`
const apiKeyGroupId = `${apiKeyInputId}-group`

// Draft state is shared by the single preferences pane.
let apiKeyDirty = false
let apiKeyDraftRevision = 0
let apiKeyProbeController: AbortController | null = null
let apiKeyOpSeq = 0

function getApiKeyInput(window: Window): HTMLInputElement | null {
  return window.document?.querySelector<HTMLInputElement>(`#${apiKeyInputId}`) ?? null
}

function statusPresentation(status: ApiKeyUiStatus): { text: string; color: string } {
  switch (status) {
    case 'valid':
      return { text: getPrefsString('pref-apikey-valid'), color: '#008000' }
    case 'invalid':
      return { text: getPrefsString('pref-apikey-invalid'), color: '#d70022' }
    case 'unavailable':
      return { text: getPrefsString('pref-apikey-unavailable'), color: '#d70022' }
    case 'client_error':
      return { text: getPrefsString('pref-apikey-error'), color: '#b8860b' }
    case 'indeterminate':
      return { text: getPrefsString('pref-apikey-indeterminate'), color: '#b8860b' }
    case 'empty':
      return { text: getPrefsString('pref-apikey-empty'), color: '' }
    case 'checking':
      return { text: getPrefsString('pref-apikey-checking'), color: '' }
    default:
      return { text: '', color: '' } // neutral / aborted
  }
}

function renderApiKeyStatus(window: Window, status: ApiKeyUiStatus): void {
  const el = window.document?.querySelector<HTMLElement>(`#${apiKeyStatusId}`)
  if (!el) return
  const { text, color } = statusPresentation(status)
  el.textContent = text
  el.style.color = color
}

function setValidateEnabled(window: Window, enabled: boolean): void {
  const btn = window.document?.querySelector<XULButtonElement>(`#${apiKeyValidateId}`)
  if (btn) btn.disabled = !enabled
}

/** Store and validate the field unless its value changes while the request is pending. */
async function commitAndRender(window: Window): Promise<void> {
  const input = getApiKeyInput(window)
  if (!input) return
  if (!isSemanticScholarAvailable()) {
    // Degraded runtime: no controller, no request; dirty/op/probe state untouched.
    renderApiKeyStatus(window, 'unavailable')
    return
  }
  const revisionAtStart = apiKeyDraftRevision
  const op = ++apiKeyOpSeq
  // Repeated validation of the same value shares a live request; editing the field aborts it.
  const controller = apiKeyProbeController?.signal.aborted === false ? apiKeyProbeController : new AbortController()
  apiKeyProbeController = controller

  renderApiKeyStatus(window, 'checking')
  setValidateEnabled(window, false)
  let result: CommitResult
  try {
    result = await getSemanticScholarClient()
      .commitAndValidate(input.value, controller.signal)
      .finally(() => {
        // Controllers can outlive their requests, so only the newest operation may re-enable the button.
        if (op === apiKeyOpSeq) setValidateEnabled(window, true)
      })
  } catch (e) {
    // The pane must never stick at "Checking…"; apply the same stale-op guards as the success path.
    ztoolkit.log(`API key validation failed unexpectedly: ${String(e)}`)
    if (op === apiKeyOpSeq) setValidateEnabled(window, true)
    if (op !== apiKeyOpSeq) return
    if (apiKeyDraftRevision !== revisionAtStart) return
    renderApiKeyStatus(window, 'client_error')
    return
  }

  // Ignore results superseded by a newer request or edit.
  if (op !== apiKeyOpSeq) return
  if (apiKeyDraftRevision !== revisionAtStart) return
  if (input.value.trim() !== result.normalizedKey) return
  if (result.status === 'aborted') return
  apiKeyDirty = false
  renderApiKeyStatus(window, result.status)
}

export function validateApiKeyUI(window: Window): Promise<void> {
  return commitAndRender(window)
}

export function toggleApiKeyVisibility(window: Window): void {
  const input = getApiKeyInput(window)
  const btn = window.document?.querySelector<XULButtonElement>(`#${apiKeyShowId}`)
  if (!input || !btn) return
  const revealed = input.type === 'text'
  input.type = revealed ? 'password' : 'text'
  btn.setAttribute('aria-pressed', String(!revealed))
  btn.setAttribute('label', revealed ? 'Show' : 'Hide')
}

function bindApiKeyField(window: Window): void {
  const input = getApiKeyInput(window)
  if (!input) return

  // Load the stored key before blur handling can persist the field.
  input.value = (getPref('semanticScholarApiKey') || '').trim()
  apiKeyDirty = false
  apiKeyDraftRevision++

  if (!isSemanticScholarAvailable()) {
    // Degraded runtime: the key can be neither validated nor used — disable
    // the controls and skip the edit/validate listeners entirely.
    input.disabled = true
    setValidateEnabled(window, false)
    const showBtn = window.document?.querySelector<XULButtonElement>(`#${apiKeyShowId}`)
    if (showBtn) showBtn.disabled = true
    renderApiKeyStatus(window, 'unavailable')
    return
  }

  renderApiKeyStatus(window, input.value === '' ? 'empty' : 'neutral')
  setValidateEnabled(window, true)

  input.addEventListener('input', () => {
    apiKeyDirty = true
    apiKeyDraftRevision++
    apiKeyProbeController?.abort()
    renderApiKeyStatus(window, 'neutral')
  })

  // Validate after focus leaves the whole group, not while it moves between these controls.
  const group = window.document?.querySelector(`#${apiKeyGroupId}`)
  group?.addEventListener('focusout', (event: Event) => {
    const related = (event as FocusEvent).relatedTarget as Node | null
    // No related target means focus left the document.
    if (related && group.contains(related)) return
    if (apiKeyDirty) void commitAndRender(window)
  })

  input.addEventListener('keydown', (event: Event) => {
    if ((event as KeyboardEvent).key === 'Enter') {
      event.preventDefault()
      void commitAndRender(window)
    }
  })

  // Save pending edits during teardown without starting a request.
  window.addEventListener(
    'unload',
    () => {
      if (apiKeyDirty) {
        const el = getApiKeyInput(window)
        if (el) setPref('semanticScholarApiKey', el.value.trim())
      }
    },
    { once: true },
  )
}

// export registerStyleSheet(_window: Window) {
//   const doc = win.document
//   const styles = ztoolkit.UI.createElement(doc, 'link', {
//     properties: {
//       type: 'text/css',
//       rel: 'stylesheet',
//       href: `chrome://${addon.data.config.addonRef}/content/zoteroPrefsPane.css`,
//     },
//   })
//   doc.documentElement?.appendChild(styles)
//   // doc.getElementById('zotero-item-pane-content')?.classList.add('makeItRed')
// }

export function registerPrefsScripts(_window: Window) {
  // See addon/content/preferences.xhtml onpaneload
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
    }
  } else {
    addon.data.prefs.window = _window
  }
  bindPrefEvents()
}

function bindPrefEvents() {
  const window = addon.data.prefs?.window
  if (!window) return

  // Initialize the database order textbox
  const databaseOrderElement = window.document?.querySelector(
    `#zotero-prefpane-${config.addonRef}-databaseOrderExposed`,
  )

  if (databaseOrderElement) {
    // Set initial value from preference
    const currentValue = getPref('databaseOrder') || 'crossref'
    ;(databaseOrderElement as HTMLInputElement).value = currentValue

    // Add change listener to save preference and refresh column
    // databaseOrderElement.addEventListener('change', () => {
    //   const value = databaseOrderElement.value.trim()
    //   if (value) {
    //     setPref('databaseOrderExposed', value)
    //     // Don't automatically save to databaseOrder - only do that on validation
    //   }
    // })
    databaseOrderElement.addEventListener('focusout', () => {
      validateDatabaseOrder(window)
    })
  }

  const autoUpdateRadioGroup = window.document?.querySelector(`#zotero-prefpane-${config.addonRef}-autoUpdate`)
  const cutoffDropdown = window.document?.querySelector(`#zotero-prefpane-${config.addonRef}-autoUpdateCutoff`)

  function updateCutoffState() {
    const selectedValue = getPref('autoUpdate') || 'never'
    if (cutoffDropdown) {
      ;(cutoffDropdown as any).disabled = selectedValue === 'never'
    }
  }

  // Initial state
  updateCutoffState()

  // Add listener to radiogroup
  if (autoUpdateRadioGroup) {
    autoUpdateRadioGroup.addEventListener('command', updateCutoffState)
  }

  // Add listener for color preference changes to refresh columns immediately
  const useColorsRadioGroup = window.document?.querySelector(`#zotero-prefpane-${config.addonRef}-useColors`)
  if (useColorsRadioGroup) {
    useColorsRadioGroup.addEventListener('command', () => {
      // Refresh the item tree columns to apply new color settings
      const manager = Zotero.ItemTreeManager as { refreshColumns?: () => void }
      manager.refreshColumns?.()
    })
  }

  bindApiKeyField(window)
}

interface Validation {
  valid: boolean
  message: string
  // constructor(valid: boolean, message: string) {
  //   this.valid = valid
  //   this.message = message
  // }
}

export function validateDatabaseOrderValue(inputValue: string, andSave: boolean = true): Validation {
  const validDatabases = ['crossref', 'semanticscholar', 'inspire']

  // Parse comma-separated values
  const databases = inputValue
    .split(',')
    .map((db: string) => db.trim())
    .filter((db: string) => db.length > 0)

  // Check for duplicates
  const uniqueDatabases = [...new Set(databases)]
  if (uniqueDatabases.length !== databases.length) {
    return { valid: false, message: getPrefsString('pref-database-duplicate') }
  }

  // Check if all databases are valid
  const invalidDatabases = databases.filter((db: string) => !validDatabases.includes(db))
  if (invalidDatabases.length > 0) {
    return { valid: false, message: getPrefsString('pref-database-invalid').replace('%s', invalidDatabases.join(', ')) }
  }

  // Check length (1-3 databases)
  if (databases.length === 0 || databases.length > 3) {
    return { valid: false, message: getPrefsString('pref-database-count') }
  }

  // Save the validated order to hidden preference
  if (andSave) {
    setPref('databaseOrder', databases.join(','))
  }

  return { valid: true, message: getPrefsString('pref-database-valid') }
}

export function validationMarkup(validation: Validation, inputElement: Element, statusElement: Element) {
  if (!inputElement || !statusElement) return

  // Clear status
  statusElement.innerHTML = ''
  ;(statusElement as HTMLElement).style.color = ''

  statusElement.innerHTML = validation.message
  ;(statusElement as HTMLElement).style.color = validation.valid ? '#008000' : '#d70022'
}

export function validateDatabaseOrder(window: Window, andSave: boolean = true) {
  const inputElement = window.document?.querySelector(`#zotero-prefpane-${config.addonRef}-databaseOrderExposed`)
  const statusElement = window.document?.querySelector(`#zotero-prefpane-${config.addonRef}-database-status`)

  if (!inputElement || !statusElement) return

  // Clear status
  statusElement.innerHTML = ''
  ;(statusElement as HTMLElement).style.color = ''

  const inputValue = ((inputElement as HTMLInputElement).value || '').trim().toLowerCase()

  const validation: Validation = validateDatabaseOrderValue(inputValue, andSave)

  validationMarkup(validation, inputElement, statusElement)

  // Saving an order that includes Semantic Scholar while the runtime cannot
  // support it warrants an immediate notice (configure-after-startup path).
  if (andSave && validation.valid && inputValue.includes(SEMANTIC_SCHOLAR_DATABASE)) {
    notifySemanticScholarUnavailable()
  }
}
