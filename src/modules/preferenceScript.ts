import { config } from '../../package.json'
import { normalizeApiKey } from '../utils/apiKey'
import { getLocaleID } from '../utils/locale'
import { getPref, setPref } from '../utils/prefs'

import { SEMANTIC_SCHOLAR_DATABASE } from './citationTypes'
import { notifySemanticScholarUnavailable } from './degradedNotice'
import {
  apiKeyStatusMessage,
  apiKeyStatusTone,
  type ApiKeyUiStatus,
  cleanedCharactersMessage,
  type PrefsMessage,
  type StatusTone,
  validateDatabaseOrder,
} from './preferenceMessages'
import { type CommitResult, getSemanticScholarClient, isSemanticScholarAvailable } from './semanticScholarClient'

const prefPrefix = `zotero-prefpane-${config.addonRef}`

const apiKeyInputId = `${prefPrefix}-semanticScholarApiKey`
const apiKeyStatusId = `${apiKeyInputId}-status`
const apiKeyStatusTextId = `${apiKeyStatusId}-text`
const apiKeyStatusDetailId = `${apiKeyStatusId}-detail`
const apiKeyStatusCleanedId = `${apiKeyStatusId}-cleaned`
const apiKeyValidateId = `${apiKeyInputId}-validate`
const apiKeyGroupId = `${apiKeyInputId}-group`
const databaseInputId = `${prefPrefix}-databaseOrderExposed`
const databaseStatusId = `${prefPrefix}-database-status`

const TONE_COLORS: Record<StatusTone, string> = {
  ok: '#008000',
  error: '#d70022',
  warn: '#b8860b',
  none: '',
}

// Draft state is shared by the single preferences pane.
let apiKeyDirty = false
let apiKeyDraftRevision = 0
let apiKeyProbeController: AbortController | null = null
let apiKeyOpSeq = 0

// `Element` rather than `HTMLElement`, because the pane mixes XUL and HTML, and
// XULButtonElement is not an HTMLElement.
function byId<T extends Element = Element>(window: Window, id: string): T | null {
  return window.document?.querySelector<T>(`#${id}`) ?? null
}

function getApiKeyInput(window: Window): HTMLInputElement | null {
  return byId<HTMLInputElement>(window, apiKeyInputId)
}

/**
 * The pane's own Fluent context, resolved on every call. Closing and reopening
 * preferences creates a new document, so a module-level cache would bind to a
 * dead one. Throws rather than degrading, since skipping localization silently
 * would ship blank labels.
 */
function localization(window: Window) {
  const l10n = window.document?.l10n
  if (!l10n) throw new Error('Citation Tally: the preferences document has no Fluent localization')
  return l10n
}

/**
 * Bind or clear a localized element. Arguments reach Fluent as data, so anything
 * the user typed is rendered with text semantics and can never become markup.
 *
 * `DocumentL10n` has `setAttributes` but no `removeAttributes`, so clearing is
 * done by hand.
 */
function applyMessage(window: Window, elementId: string, message: PrefsMessage | null): void {
  const el = byId(window, elementId)
  if (!el) return
  if (message === null) {
    el.removeAttribute('data-l10n-id')
    el.removeAttribute('data-l10n-args')
    el.textContent = ''
    return
  }
  localization(window).setAttributes(el, getLocaleID(message.id), 'args' in message ? message.args : undefined)
}

function setStatusTone(window: Window, containerId: string, tone: StatusTone): void {
  const container = byId<HTMLElement>(window, containerId)
  if (container) container.style.color = TONE_COLORS[tone]
}

/** Extra context shown beside the outcome: what the server said, and what we stripped. */
interface ApiKeyStatusDetail {
  detail?: string
  removed?: string[]
}

function renderApiKeyStatus(window: Window, status: ApiKeyUiStatus, extra?: ApiKeyStatusDetail): void {
  const detailEl = byId(window, apiKeyStatusDetailId)

  // Clear every part first, so a stale translation can't sit beside a pending one.
  applyMessage(window, apiKeyStatusTextId, null)
  applyMessage(window, apiKeyStatusCleanedId, null)
  if (detailEl) detailEl.textContent = ''

  applyMessage(window, apiKeyStatusTextId, apiKeyStatusMessage(status))
  // Semantic Scholar's own wording. Not localizable, and written as text.
  if (detailEl && extra?.detail !== undefined && extra.detail !== '') detailEl.textContent = `— ${extra.detail}`
  applyMessage(window, apiKeyStatusCleanedId, cleanedCharactersMessage(extra?.removed ?? []))

  setStatusTone(window, apiKeyStatusId, apiKeyStatusTone(status))
}

function setValidateEnabled(window: Window, enabled: boolean): void {
  const btn = byId<XULButtonElement>(window, apiKeyValidateId)
  if (btn) btn.disabled = !enabled
}

/** Validation acts on the field's text, so a field that normalizes to nothing has nothing to check. */
function syncValidateEnabled(window: Window): void {
  const input = getApiKeyInput(window)
  setValidateEnabled(window, input !== null && normalizeApiKey(input.value).key !== '')
}

/** Store and validate the field unless its value changes while the request is pending. */
async function commitAndRender(window: Window): Promise<void> {
  const input = getApiKeyInput(window)
  if (!input) return
  if (!isSemanticScholarAvailable()) {
    // Degraded runtime. No controller, no request, and dirty/op/probe state untouched.
    renderApiKeyStatus(window, 'unavailable')
    return
  }
  const revisionAtStart = apiKeyDraftRevision
  const op = ++apiKeyOpSeq
  // Repeated validation of the same value shares one live request. Editing the field aborts it.
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
        if (op === apiKeyOpSeq) syncValidateEnabled(window)
      })
  } catch (e) {
    // The pane must never stick at "Checking…". Same stale-op guards as the success path.
    ztoolkit.log(`API key validation failed unexpectedly: ${String(e)}`)
    if (op === apiKeyOpSeq) syncValidateEnabled(window)
    if (op !== apiKeyOpSeq) return
    if (apiKeyDraftRevision !== revisionAtStart) return
    renderApiKeyStatus(window, 'client_error')
    return
  }

  // Ignore results superseded by a newer request or edit.
  if (op !== apiKeyOpSeq) return
  if (apiKeyDraftRevision !== revisionAtStart) return
  if (normalizeApiKey(input.value).key !== result.normalizedKey) return
  if (result.status === 'aborted') return
  apiKeyDirty = false
  // Show the cleaned key, so the field matches what actually gets sent.
  if (input.value !== result.normalizedKey) input.value = result.normalizedKey
  renderApiKeyStatus(window, result.status, { detail: result.detail, removed: result.removedCharacters })
}

export function validateApiKeyUI(window: Window): Promise<void> {
  return commitAndRender(window)
}

function bindApiKeyField(window: Window): void {
  const input = getApiKeyInput(window)
  if (!input) return

  // Load the stored key before blur handling can persist the field.
  input.value = normalizeApiKey(getPref('semanticScholarApiKey')).key
  apiKeyDirty = false
  apiKeyDraftRevision++

  if (!isSemanticScholarAvailable()) {
    // Degraded runtime. The key can't be validated or used, so disable the
    // controls and skip the edit and validate listeners entirely.
    input.disabled = true
    setValidateEnabled(window, false)
    renderApiKeyStatus(window, 'unavailable')
    return
  }

  renderApiKeyStatus(window, input.value === '' ? 'empty' : 'neutral')
  syncValidateEnabled(window)

  input.addEventListener('input', () => {
    apiKeyDirty = true
    apiKeyDraftRevision++
    apiKeyProbeController?.abort()
    // Emptying the field also disables Validate, so say why instead of leaving the row blank.
    renderApiKeyStatus(window, normalizeApiKey(input.value).key === '' ? 'empty' : 'neutral')
    syncValidateEnabled(window)
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
        if (el) setPref('semanticScholarApiKey', normalizeApiKey(el.value).key)
      }
    },
    { once: true },
  )
}

/**
 * Validate the database-order field and, when asked, save it. Saving is the
 * caller's job rather than the validator's, so the validator stays pure and
 * returns a message id rather than rendered text.
 */
export function validateDatabaseOrderUI(window: Window, andSave: boolean = true): void {
  const input = byId<HTMLInputElement>(window, databaseInputId)
  if (!input) return

  const validation = validateDatabaseOrder(input.value || '')
  applyMessage(window, databaseStatusId, validation.message)
  setStatusTone(window, databaseStatusId, validation.valid ? 'ok' : 'error')

  if (!andSave || !validation.valid) return
  setPref('databaseOrder', validation.databases.join(','))
  // Someone saving an order that includes Semantic Scholar on a runtime that
  // can't support it should hear about it right away, not at the next startup.
  if (validation.databases.includes(SEMANTIC_SCHOLAR_DATABASE)) notifySemanticScholarUnavailable()
}

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

  const databaseOrderElement = byId<HTMLInputElement>(window, databaseInputId)
  if (databaseOrderElement) {
    databaseOrderElement.value = getPref('databaseOrder') || 'crossref'
    databaseOrderElement.addEventListener('focusout', () => {
      validateDatabaseOrderUI(window)
    })
  }

  // Refresh the item tree columns so a colour change applies without a restart.
  const useColorsRadioGroup = window.document?.querySelector(`#${prefPrefix}-useColors`)
  useColorsRadioGroup?.addEventListener('command', () => {
    Zotero.ItemTreeManager.refreshColumns()
  })

  bindApiKeyField(window)
}
