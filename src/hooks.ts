import { cancelAutomaticUpdate, startAutomaticUpdate } from './modules/citationAutoupdate'
import {
  abortInFlightLookups,
  BasicRegistrar,
  cancelManualUpdate,
  cancelMonthlyCleanup,
  scheduleMonthlyCleanup,
  UIRegistrar,
  UX,
} from './modules/citationTally'
import {
  closeDegradedNotice,
  maybeShowProactiveDegradedNotice,
  notifySemanticScholarUnavailable,
} from './modules/degradedNotice'
import { registerPrefsScripts, validateApiKeyUI, validateDatabaseOrderUI } from './modules/preferenceScript'
import {
  closeSemanticScholarWarning,
  flushPendingSemanticScholarWarning,
  getSemanticScholarClient,
  isSemanticScholarAvailable,
  shutdownSemanticScholarClient,
} from './modules/semanticScholarClient'
import { getString, initLocale } from './utils/locale'

async function onStartup() {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise])
  // A disable during the waits above must not initialize anything.
  if (!addon.data.alive) return

  initLocale()

  addon.data.runtimeBridge = _globalThis.__runtimeBridgeReport

  BasicRegistrar.registerPrefs()

  // Key changes must be observed before any lookup can start. In the degraded
  // runtime the client is never constructed, but startup still has to finish.
  if (isSemanticScholarAvailable()) {
    getSemanticScholarClient().registerObserver()
  }

  // Register citation count notifier to detect new items
  UIRegistrar.registerNotifier()

  // Register custom column for citation counts
  UIRegistrar.registerCitationColumn()

  // Process-wide registrations. These used to live in onMainWindowLoad, which
  // runs once per main window, so a second window re-registered the menus and
  // orphaned the first window's preference-observer ids.
  UIRegistrar.registerCitationCountMenuItem()
  UIRegistrar.registerRetallyCitationsMenuItem()
  UIRegistrar.registerThemeObservers()

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
  // The toolkit is process-wide and is created once in the Addon constructor.
  // Re-creating it here simply replaced the shared instance on every window.
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
    // Woken late, after shutdown. Close the popup this hook created and register nothing.
    popupWin.close()
    return
  }
  popupWin.changeLine({
    progress: 30,
    text: getString('startup-progress', { args: { percent: 30, message: getString('startup-begin') } }),
  })

  // Per-window: system theme changes are observed through this window's
  // MediaQueryList, and removed again when it unloads.
  UIRegistrar.registerWindowThemeListener(win)

  popupWin.changeLine({
    progress: 100,
    text: getString('startup-progress', { args: { percent: 100, message: getString('startup-finish') } }),
  })
  popupWin.startCloseTimer(1000)

  // Display a key-rejection warning that was deferred until a window existed.
  flushPendingSemanticScholarWarning()

  // Tell users whose configuration includes Semantic Scholar when this runtime
  // can't support it. Does nothing in the normal full-capability runtime.
  maybeShowProactiveDegradedNotice()
}

function onMainWindowUnload(win: Window): void {
  // Only this window's resources. `ztoolkit.unregisterAll()` used to run here,
  // which tore down registrations still needed by any other open window; it now
  // runs once, at shutdown.
  UIRegistrar.unregisterWindowThemeListener(win)
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
  // Cancel work before unregistering UI. Every step has to run: if one throws and
  // the delete below is skipped, the stale Zotero[addonInstance] makes the
  // index.ts guard keep the old instance when the plugin is re-enabled.
  runTeardownSteps([
    () => cancelAutomaticUpdate(),
    () => cancelMonthlyCleanup(),
    () => cancelManualUpdate(),
    // Cancel in-flight Crossref/INSPIRE requests too; without a deadline they
    // could otherwise outlive the plugin.
    () => abortInFlightLookups(),
    () => UIRegistrar.unregisterNotifier(),
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
      validateDatabaseOrderUI(data.window)
      break
    case 'validateApiKey':
      void validateApiKeyUI(data.window)
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
      // Surface the degraded runtime at action time. Does nothing in full mode.
      notifySemanticScholarUnavailable()
      void startAutomaticUpdate(false, 'manual') // false = show progress UI
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
