/**
 * Based on Zotero team's Make It Red example[1] and the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle

// Bootstrap scopes omit these Web APIs; copy them from Zotero's hidden window before loading the bundle.
var runtimeBridgeRequirements = [
  ['AbortController', 'function'],
  ['AbortSignal', 'function'],
  ['AbortSignal.any', 'function'],
  ['AbortSignal.timeout', 'function'],
  ['DOMException', 'function'],
  ['performance.now', 'function'],
  ['queueMicrotask', 'function'],
]

function getRuntimeCapabilityType(provider, path) {
  if (provider === null || provider === undefined) {
    return 'provider-unavailable'
  }

  try {
    var value = provider
    for (const property of path.split('.')) {
      if (value === null || value === undefined) {
        return 'undefined'
      }
      value = value[property]
    }
    return typeof value
  } catch {
    return 'throws'
  }
}

function getHiddenDOMWindow() {
  try {
    return Services.appShell.hiddenDOMWindow
  } catch {
    return null
  }
}

function installRuntimeBridge(context, hiddenDOMWindow) {
  for (const [path, expectedType] of runtimeBridgeRequirements) {
    var actualType = getRuntimeCapabilityType(hiddenDOMWindow, path)
    if (actualType !== expectedType) {
      var detail = `hidden DOM window capability ${path} has type ${actualType}`
      throw new Error(`Citation Tally cannot start: ${detail}; expected ${expectedType}`)
    }
  }

  context.AbortController = hiddenDOMWindow.AbortController
  context.AbortSignal = hiddenDOMWindow.AbortSignal
  context.DOMException = hiddenDOMWindow.DOMException
  context.performance = hiddenDOMWindow.performance
  context.queueMicrotask = hiddenDOMWindow.queueMicrotask.bind(hiddenDOMWindow)
}

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  await Zotero.initializationPromise

  var aomStartup = Components.classes['@mozilla.org/addons/addon-manager-startup;1'].getService(
    Components.interfaces.amIAddonManagerStartup,
  )
  var manifestURI = Services.io.newURI(rootURI + 'manifest.json')
  chromeHandle = aomStartup.registerChrome(manifestURI, [['content', '__addonRef__', rootURI + 'content/']])

  var hiddenDOMWindow = getHiddenDOMWindow()

  /**
   * Global variables for plugin code.
   * The `_globalThis` is the global root variable of the plugin sandbox environment
   * and all child variables assigned to it is globally accessible.
   * See `src/index.ts` for details.
   */
  const ctx = {
    rootURI,
  }
  installRuntimeBridge(ctx, hiddenDOMWindow)
  ctx._globalThis = ctx

  Services.scriptloader.loadSubScript(`${rootURI}/content/scripts/__addonRef__.js`, ctx)
  await Zotero.__addonInstance__.hooks.onStartup()
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window)
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window)
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return
  }

  await Zotero.__addonInstance__?.hooks.onShutdown()

  if (chromeHandle) {
    chromeHandle.destruct()
    chromeHandle = null
  }
}

async function uninstall(data, reason) {}
