/**
 * Based on Zotero team's Make It Red example[1] and the Zotero 7 documentation[2].
 * [1] https://github.com/zotero/make-it-red
 * [2] https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle

/**
 * Web APIs the bundle needs but Zotero's plugin sandbox omits. We resolve them
 * onto this plugin's own sandbox global, not from a window: Zotero 9 (Gecko 140)
 * only creates the hidden DOM window on macOS, so anything window-based bricks
 * Windows and Linux.
 */
var runtimeCapabilityNames = ['AbortController', 'DOMException']

/** Dev-only escape hatch: force the degraded path without editing source. */
var forceDegradedPref = 'extensions.zotero.citationtally.forceDegradedRuntime'

function isForcedDegraded() {
  // `__buildEnv__` is substituted at build time; the branch is inert in production builds.
  var buildEnv = '__buildEnv__'
  if (buildEnv !== 'development') return false
  try {
    return Zotero.Prefs.get(forceDegradedPref, true) === true
  } catch (e) {
    return false
  }
}

/**
 * A guarded value read (triggers lazy resolvers, unlike hasOwnProperty).
 * States: 'absent' (undefined), 'function', or 'broken' (non-function or throwing).
 */
function classifyGlobal(name) {
  try {
    var value = globalThis[name]
    if (value === undefined) return { state: 'absent', value: null }
    if (typeof value === 'function') return { state: 'function', value }
    return { state: 'broken', value: null }
  } catch (e) {
    return { state: 'broken', value: null }
  }
}

/**
 * Accept constructors only after exercising the behavior the bundle relies on:
 * construction, signal flags, listeners, `AbortSignal.any` composition with
 * synchronous propagation, and DOMException naming.
 */
function verifyCapabilityPair(AbortControllerCtor, DOMExceptionCtor) {
  try {
    if (typeof AbortControllerCtor !== 'function' || typeof DOMExceptionCtor !== 'function') return null

    if (new DOMExceptionCtor('probe', 'AbortError').name !== 'AbortError') return null

    var controller = new AbortControllerCtor()
    var signal = controller.signal
    if (signal.aborted !== false) return null
    if (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') return null

    var AbortSignalInterface = Object.getPrototypeOf(signal).constructor
    if (typeof AbortSignalInterface !== 'function' || typeof AbortSignalInterface.any !== 'function') return null

    var dependent = AbortSignalInterface.any([signal])
    if (dependent.aborted !== false) return null
    var listenerFired = false
    var onAbort = function () {
      listenerFired = true
    }
    dependent.addEventListener('abort', onAbort)
    controller.abort(new DOMExceptionCtor('probe', 'AbortError'))
    dependent.removeEventListener('abort', onAbort)
    if (dependent.aborted !== true || !listenerFired) return null
    if (!dependent.reason || dependent.reason.name !== 'AbortError') return null

    return { AbortController: AbortControllerCtor, DOMException: DOMExceptionCtor, AbortSignal: AbortSignalInterface }
  } catch (e) {
    return null
  }
}

function resolveRuntimeCapabilities() {
  if (isForcedDegraded()) {
    return { provider: 'unavailable', capabilities: null }
  }

  var initial = {}
  for (const name of runtimeCapabilityNames) {
    initial[name] = classifyGlobal(name)
  }

  var native = verifyCapabilityPair(initial.AbortController.value, initial.DOMException.value)
  if (native) return { provider: 'bootstrap-global', capabilities: native }

  // Import only the missing names. A present-but-broken binding is left alone;
  // Gecko won't overwrite a global that already exists.
  var absent = runtimeCapabilityNames.filter(function (name) {
    return initial[name].state === 'absent'
  })
  if (absent.length > 0) {
    try {
      Components.utils.importGlobalProperties(absent)
    } catch (e) {
      Zotero.debug('Citation Tally: importGlobalProperties failed: ' + String(e))
    }
    var imported = verifyCapabilityPair(classifyGlobal('AbortController').value, classifyGlobal('DOMException').value)
    if (imported) return { provider: 'import-global-properties', capabilities: imported }
  }

  return { provider: 'unavailable', capabilities: null }
}

function makeUnavailableStub(name) {
  return function citationTallyUnavailableCapability() {
    throw new Error('Citation Tally: ' + name + ' is unavailable in this Zotero runtime')
  }
}

function makeUnavailableSignalStub() {
  // Plain data properties holding throwing functions — `typeof` probes must not throw.
  var stub = makeUnavailableStub('AbortSignal')
  stub.any = makeUnavailableStub('AbortSignal.any')
  stub.timeout = makeUnavailableStub('AbortSignal.timeout')
  return stub
}

/**
 * Defines every bridged name on the bundle scope — working value or throwing
 * stub — so bare references never throw ReferenceError, and defines the report
 * `src` reads to decide whether Semantic Scholar is available. It cannot throw:
 * a missing capability disables Semantic Scholar, it must not stop the bundle
 * from loading. The stubs only catch a gate that `src` forgot to check.
 */
function installRuntimeBridge(context) {
  var resolution = resolveRuntimeCapabilities()
  var capabilities = resolution.capabilities

  context.AbortController = capabilities ? capabilities.AbortController : makeUnavailableStub('AbortController')
  context.DOMException = capabilities ? capabilities.DOMException : makeUnavailableStub('DOMException')
  context.AbortSignal = capabilities ? capabilities.AbortSignal : makeUnavailableSignalStub()
  // Only `.now()` is consumed by the bundle; Cu.now() is monotonic ms.
  context.performance = {
    now: function () {
      return Components.utils.now()
    },
  }
  // Realm-independent microtask; a throwing callback surfaces as an unhandled
  // rejection instead of a window error event.
  context.queueMicrotask = function (callback) {
    Promise.resolve().then(callback)
  }
  context.__runtimeBridgeReport = {
    provider: resolution.provider,
    semanticScholarAvailable: capabilities !== null,
  }

  Zotero.debug('Citation Tally runtime bridge provider: ' + resolution.provider)
  if (!capabilities) {
    Zotero.logError(
      new Error('Citation Tally: runtime Web API capabilities unavailable; Semantic Scholar features are disabled'),
    )
  }
}

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  await Zotero.initializationPromise

  var aomStartup = Components.classes['@mozilla.org/addons/addon-manager-startup;1'].getService(
    Components.interfaces.amIAddonManagerStartup,
  )
  var manifestURI = Services.io.newURI(rootURI + 'manifest.json')
  chromeHandle = aomStartup.registerChrome(manifestURI, [['content', '__addonRef__', rootURI + 'content/']])

  /**
   * Global variables for plugin code.
   * The `_globalThis` is the global root variable of the plugin sandbox environment
   * and all child variables assigned to it is globally accessible.
   * See `src/index.ts` for details.
   */
  const ctx = {
    rootURI,
  }
  installRuntimeBridge(ctx)
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

  try {
    await Zotero.__addonInstance__?.hooks.onShutdown()
  } finally {
    if (chromeHandle) {
      chromeHandle.destruct()
      chromeHandle = null
    }
  }
}

async function uninstall(data, reason) {}
