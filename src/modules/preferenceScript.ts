import { config } from '../../package.json'
import { getPref, setPref } from '../utils/prefs'

// Get localized string in preferences context - using hardcoded strings since
// preferences window has different localization context that's hard to access
function getPrefsString(key: string): string {
  const strings: Record<string, string> = {
    'pref-database-valid': 'Valid database configuration',
    'pref-database-duplicate': 'Duplicate databases found',
    'pref-database-invalid': 'Invalid database(s): %s',
    'pref-database-count': 'Please enter 1-3 databases',
    'pref-database-empty': 'Please enter at least one database',
  }
  return strings[key] || key
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

export async function registerPrefsScripts(_window: Window) {
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
}
