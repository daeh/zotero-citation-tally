import { cancelAutomaticUpdate, startAutomaticUpdate } from './modules/citationAutoupdate'
import {
  BasicRegistrar,
  cancelManualUpdate,
  cancelMonthlyCleanup,
  scheduleMonthlyCleanup,
  UIRegistrar,
  UX,
} from './modules/citationTally'
/* PUBIGNORE 
import {
  BasicExampleFactory,
  HelperExampleFactory,
  KeyExampleFactory,
  PromptExampleFactory,
  UIExampleFactory,
} from './modules/examples'
*/
import {
  closeDegradedNotice,
  maybeShowProactiveDegradedNotice,
  notifySemanticScholarUnavailable,
} from './modules/degradedNotice'
import {
  registerPrefsScripts,
  toggleApiKeyVisibility,
  validateApiKeyUI,
  validateDatabaseOrder,
} from './modules/preferenceScript'
import {
  closeSemanticScholarWarning,
  flushPendingSemanticScholarWarning,
  getSemanticScholarClient,
  isSemanticScholarAvailable,
  shutdownSemanticScholarClient,
} from './modules/semanticScholarClient'
import { getString, initLocale } from './utils/locale'
// import { getPref } from './utils/prefs'
import { createZToolkit } from './utils/ztoolkit'

async function onStartup() {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise])
  // A disable during the waits above must not initialize anything.
  if (!addon.data.alive) return

  initLocale()

  addon.data.runtimeBridge = _globalThis.__runtimeBridgeReport

  BasicRegistrar.registerPrefs()

  // Key changes must be observed before any lookup can start. In the degraded
  // runtime the client is never constructed; startup must still complete.
  if (isSemanticScholarAvailable()) {
    getSemanticScholarClient().registerObserver()
  }

  // Register citation count notifier to detect new items
  UIRegistrar.registerNotifier()

  // Register custom column for citation counts
  UIRegistrar.registerCitationColumn()

  // KeyExampleFactory.registerShortcuts()

  // await UIExampleFactory.registerExtraColumn()

  // await UIExampleFactory.registerExtraColumnWithCustomCell()

  // UIExampleFactory.registerItemPaneCustomInfoRow()

  // UIExampleFactory.registerItemPaneSection()

  // UIExampleFactory.registerReaderItemPaneSection()

  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)))

  // A disable during window setup must not start background work.
  if (!addon.data.alive) return

  // Start automatic citation updates if enabled
  void startAutomaticUpdate()

  // Schedule cleanup of ignored items
  scheduleMonthlyCleanup()

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit()

  // @ts-ignore This is a moz feature
  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-mainWindow.ftl`)
  // @ts-ignore This is a moz feature
  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-addon.ftl`)

  const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString('startup-begin'),
      type: 'default',
      progress: 0,
    })
    .show()

  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (!addon.data.alive) {
    // Late wake after shutdown: close the popup this hook created, register nothing.
    popupWin.close()
    return
  }
  popupWin.changeLine({
    progress: 30,
    text: getString('startup-progress', { args: { percent: 30, message: getString('startup-begin') } }),
  })

  // UIExampleFactory.registerStyleSheet(win) // PUBIGNORE

  // UIExampleFactory.registerRightClickMenuItem() // PUBIGNORE

  // UIExampleFactory.registerRightClickMenuPopup(win) // PUBIGNORE

  // UIExampleFactory.registerWindowMenuWithSeparator() // PUBIGNORE

  // Register citation count update menu item
  UIRegistrar.registerCitationCountMenuItem()

  // Register retally outdated citations menubar item
  UIRegistrar.registerRetallyCitationsMenuItem()

  // Register theme change observers to update column colors
  UIRegistrar.registerThemeObservers()

  // PromptExampleFactory.registerNormalCommandExample() // PUBIGNORE

  // PromptExampleFactory.registerAnonymousCommandExample(win) // PUBIGNORE

  // PromptExampleFactory.registerConditionalCommandExample() // PUBIGNORE

  // await Zotero.Promise.delay(1000)

  popupWin.changeLine({
    progress: 100,
    text: getString('startup-progress', { args: { percent: 100, message: getString('startup-finish') } }),
  })
  popupWin.startCloseTimer(1000)

  // Display a key-rejection warning that was deferred until a window existed.
  flushPendingSemanticScholarWarning()

  // Tell users whose configuration includes Semantic Scholar when the runtime
  // cannot support it (no-op in the normal full-capability runtime).
  maybeShowProactiveDegradedNotice()

  // addon.hooks.onDialogEvents('dialogExample')
}

function onMainWindowUnload(win: Window): void {
  ztoolkit.unregisterAll()
  closeSemanticScholarWarning()
  closeDegradedNotice()
  addon.data.dialog?.window?.close()
}

/** Run every teardown step even when one throws; log failures and continue. */
function runTeardownSteps(steps: readonly (() => void)[]): void {
  for (const step of steps) {
    try {
      step()
    } catch (e) {
      ztoolkit.log('Citation Tally teardown step failed', e)
    }
  }
}

function onShutdown(): void {
  // Set before teardown so reentrant callbacks already see the plugin as dead.
  addon.data.alive = false
  // Cancel work before unregistering UI. If a step throws and the delete below
  // is skipped, the stale Zotero[addonInstance] makes the index.ts guard keep
  // the old instance on re-enable — so every step runs, come what may.
  runTeardownSteps([
    () => cancelAutomaticUpdate(),
    () => cancelMonthlyCleanup(),
    () => cancelManualUpdate(),
    () => shutdownSemanticScholarClient(),
    () => closeDegradedNotice(),
    () => ztoolkit.unregisterAll(),
    () => UIRegistrar.unregisterThemeObservers(),
    () => addon.data.dialog?.window?.close(),
  ])
  // Remove addon object
  // @ts-expect-error addon instance is injected at runtime
  delete Zotero[addon.data.config.addonInstance]
}

/** PUBIGNORE
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this function clear.
 */
/* PUBIGNORE
async function onNotify(event: string, type: string, ids: (string | number)[], extraData: Record<string, any>) {
  // Add code to the corresponding notify type
  ztoolkit.log('notify', event, type, ids, extraData)
  if (event == 'select' && type == 'tab' && extraData[ids[0]].type == 'reader') {
    BasicExampleFactory.exampleNotifierCallback()
  } else {
    return
  }
}
*/

/**
 * Dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this function clear.
 * @param type event type
 * @param data event data
 */
function onPrefsEvent(type: string, data: Record<string, any>) {
  switch (type) {
    case 'load':
      void registerPrefsScripts(data.window)
      break
    case 'validateDatabases':
      validateDatabaseOrder(data.window)
      break
    case 'validateApiKey':
      void validateApiKeyUI(data.window)
      break
    case 'toggleApiKeyVisibility':
      toggleApiKeyVisibility(data.window)
      break
    default:
      return
  }
}

/* PUBIGNORE 
function onShortcuts(type: string) {
  switch (type) {
    case 'larger':
      KeyExampleFactory.exampleShortcutLargerCallback()
      break
    case 'smaller':
      KeyExampleFactory.exampleShortcutSmallerCallback()
      break
    default:
      break
  }
  return
}
*/

function onDialogEvents(type: string) {
  switch (type) {
    /* PUBIGNORE 
    case 'dialogExample':
      HelperExampleFactory.dialogExample()
      break
    case 'clipboardExample':
      HelperExampleFactory.clipboardExample()
      break
    case 'filePickerExample':
      HelperExampleFactory.filePickerExample()
      break
    case 'progressWindowExample':
      HelperExampleFactory.progressWindowExample()
      break
    case 'vtableExample':
      HelperExampleFactory.vtableExample()
      break
    */
    case 'updateCitationCounts':
      UX.updateSelectedItemsCitationCounts()
      break
    case 'retallyOutdatedCitations':
      // Surface the runtime-degraded state at action time (no-op in full mode).
      notifySemanticScholarUnavailable()
      void startAutomaticUpdate(false) // false = show progress UI
      break
    default:
      break
  }
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  // onNotify, // PUBIGNORE
  onPrefsEvent,
  // onShortcuts, // PUBIGNORE
  onDialogEvents,
}
