import { startAutomaticUpdate } from './modules/citationAutoupdate'
import { BasicRegistrar, scheduleMonthlyCleanup, UIRegistrar, UX } from './modules/citationTally'
import { registerPrefsScripts, validateDatabaseOrder } from './modules/preferenceScript'
import { getString, initLocale } from './utils/locale'
// import { getPref } from './utils/prefs'
import { createZToolkit } from './utils/ztoolkit'

async function onStartup() {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise])

  initLocale()

  BasicRegistrar.registerPrefs()

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

  // Start automatic citation updates if enabled
  void startAutomaticUpdate()

  // Schedule monthly cleanup of ignored items
  scheduleMonthlyCleanup()
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit()

  // @ts-ignore This is a moz feature
  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-mainWindow.ftl`)

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

  await Zotero.Promise.delay(1000)
  popupWin.changeLine({
    progress: 30,
    text: getString('startup-progress', { args: { percent: 30, message: getString('startup-begin') } }),
  })

  // Register citation count update menu item
  UIRegistrar.registerCitationCountMenuItem()

  // Register retally outdated citations menubar item
  UIRegistrar.registerRetallyCitationsMenuItem()

  // await Zotero.Promise.delay(1000)

  popupWin.changeLine({
    progress: 100,
    text: getString('startup-progress', { args: { percent: 100, message: getString('startup-finish') } }),
  })
  popupWin.startCloseTimer(1000)

  // addon.hooks.onDialogEvents('dialogExample')
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll()
  addon.data.dialog?.window?.close()
}

function onShutdown(): void {
  ztoolkit.unregisterAll()
  addon.data.dialog?.window?.close()
  // Remove addon object
  addon.data.alive = false
  // @ts-ignore - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance]
}

/**
 * Dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this function clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: Record<string, any>) {
  switch (type) {
    case 'load':
      registerPrefsScripts(data.window)
      break
    case 'validateDatabases':
      validateDatabaseOrder(data.window)
      break
    default:
      return
  }
}

function onDialogEvents(type: string) {
  switch (type) {
    case 'updateCitationCounts':
      UX.updateSelectedItemsCitationCounts()
      break
    case 'retallyOutdatedCitations':
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
  onPrefsEvent,
  onDialogEvents,
}
