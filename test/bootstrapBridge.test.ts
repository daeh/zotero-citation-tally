/**
 * Control-flow/contract tests of the raw addon/bootstrap.js runtime bridge.
 * These run the exact shipped source in a node:vm context with stubbed
 * Zotero/Services/Components. They cannot model Gecko WebIDL realm semantics,
 * caller-realm import behavior, or real fetch — the real-Zotero runtime smoke
 * covers those. Host-Node constructors installed into the vm are not realm
 * evidence; they exercise the bridge's decision logic only.
 *
 * The Services.appShell getter throws in every scenario (the Windows/Linux
 * condition: no hidden window) and the harness asserts it is never accessed —
 * the regression that bricked v0.0.14.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bootstrapSource = readFileSync(join(repoRoot, 'addon', 'bootstrap.js'), 'utf8')

class FakeAbortSignal {
  aborted = false
  reason: unknown = undefined
  private listeners = new Set<() => void>()
  addEventListener(type: string, listener: () => void): void {
    if (type === 'abort') this.listeners.add(listener)
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.listeners.delete(listener)
  }
  dispatchAbort(reason: unknown): void {
    if (this.aborted) return
    this.aborted = true
    this.reason = reason
    for (const listener of [...this.listeners]) listener()
  }
  static any(signals: readonly FakeAbortSignal[]): FakeAbortSignal {
    const dependent = new FakeAbortSignal()
    for (const signal of signals) {
      if (signal.aborted) {
        dependent.dispatchAbort(signal.reason)
        break
      }
      signal.addEventListener('abort', () => dependent.dispatchAbort(signal.reason))
    }
    return dependent
  }
}

class FakeAbortController {
  signal = new FakeAbortSignal()
  abort(reason?: unknown): void {
    this.signal.dispatchAbort(reason)
  }
}

class FakeDOMException extends Error {
  constructor(message?: string, name = 'Error') {
    super(message)
    this.name = name
  }
}

/** A signal class whose derived interface has a broken `any` composition. */
class BrokenAnyAbortSignal extends FakeAbortSignal {
  static override any(_signals: readonly FakeAbortSignal[]): FakeAbortSignal {
    throw new Error('composition broken')
  }
}

class BrokenAnyAbortController {
  signal = new BrokenAnyAbortSignal()
  abort(reason?: unknown): void {
    this.signal.dispatchAbort(reason)
  }
}

interface HarnessOptions {
  globals?: Record<string, unknown>
  onImport?: (names: readonly string[], vmGlobal: Record<string, unknown>) => void
}

function installWorkingPair(names: readonly string[], vmGlobal: Record<string, unknown>): void {
  for (const name of names) {
    if (name === 'AbortController') vmGlobal.AbortController = FakeAbortController
    if (name === 'DOMException') vmGlobal.DOMException = FakeDOMException
  }
}

function createHarness(options: HarnessOptions = {}) {
  const importCalls: string[][] = []
  const logErrors: unknown[] = []
  const counters = { appShellAccesses: 0, loadSubScript: 0, onStartup: 0, destruct: 0 }
  const capturedCtxs: Record<string, any>[] = []

  const hooks = {
    onStartup: async () => {
      counters.onStartup++
    },
    onShutdown: async () => {},
  }

  const zotero: Record<string, any> = {
    initializationPromise: Promise.resolve(),
    debug: () => {},
    logError: (error: unknown) => {
      logErrors.push(error)
    },
    Prefs: { get: () => undefined },
  }

  const servicesTarget: Record<string, any> = {
    io: { newURI: (uri: string) => ({ spec: uri }) },
    scriptloader: {
      loadSubScript: (_uri: string, scope: Record<string, any>) => {
        counters.loadSubScript++
        capturedCtxs.push(scope)
        // The bundle installs the addon instance; the startup hook call needs it.
        zotero.__addonInstance__ = { hooks }
      },
    },
    scriptSecurityManager: { getSystemPrincipal: () => ({}) },
  }
  const services = new Proxy(servicesTarget, {
    get(target, property, receiver) {
      if (property === 'appShell') {
        counters.appShellAccesses++
        throw new Error('NS_ERROR_FAILURE')
      }
      return Reflect.get(target, property, receiver)
    },
  })

  const vmGlobal: Record<string, any> = {
    Services: services,
    Zotero: zotero,
    APP_SHUTDOWN: 'APP_SHUTDOWN',
    ADDON_DISABLE: 'ADDON_DISABLE',
    ...options.globals,
  }
  vmGlobal.Components = {
    classes: {
      '@mozilla.org/addons/addon-manager-startup;1': {
        getService: () => ({
          registerChrome: () => ({
            destruct: () => {
              counters.destruct++
            },
          }),
        }),
      },
    },
    interfaces: { amIAddonManagerStartup: {} },
    utils: {
      importGlobalProperties: (names: readonly string[]) => {
        importCalls.push([...names])
        options.onImport?.(names, vmGlobal)
      },
      now: () => 123.456,
    },
  }

  vm.createContext(vmGlobal)
  new vm.Script(bootstrapSource, { filename: 'addon/bootstrap.js' }).runInContext(vmGlobal)

  const params = { id: 'dev@daeh.info', version: '0.0.15', resourceURI: null, rootURI: 'root/' }
  return {
    vmGlobal,
    importCalls,
    logErrors,
    counters,
    hooks,
    latestCtx: (): Record<string, any> => {
      assert.ok(capturedCtxs.length > 0, 'loadSubScript was never called')
      return capturedCtxs[capturedCtxs.length - 1]
    },
    ctxCount: () => capturedCtxs.length,
    startup: (): Promise<void> => vmGlobal.startup(params, 'APP_STARTUP'),
    shutdown: (reason: string): Promise<void> => vmGlobal.shutdown(params, reason),
  }
}

test('static invariant: bootstrap never references the hidden window', () => {
  assert.ok(!bootstrapSource.includes('hiddenDOMWindow'))
})

test('static invariant: src never calls AbortSignal.timeout', () => {
  const srcRoot = join(repoRoot, 'src')
  const entries = readdirSync(srcRoot, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const content = readFileSync(join(entry.parentPath, entry.name), 'utf8')
    assert.ok(
      !/AbortSignal\.timeout\s*\(/.test(content),
      `AbortSignal.timeout call in ${entry.parentPath}/${entry.name}`,
    )
  }
})

test('working globals already on the bootstrap scope are used without import', async () => {
  const harness = createHarness({ globals: { AbortController: FakeAbortController, DOMException: FakeDOMException } })
  await harness.startup()

  const ctx = harness.latestCtx()
  assert.equal(ctx.__runtimeBridgeReport.provider, 'bootstrap-global')
  assert.equal(ctx.__runtimeBridgeReport.semanticScholarAvailable, true)
  assert.equal(ctx.AbortController, FakeAbortController)
  assert.equal(ctx.DOMException, FakeDOMException)
  assert.equal(ctx.AbortSignal, FakeAbortSignal)
  assert.equal(harness.importCalls.length, 0)
  assert.equal(harness.counters.onStartup, 1)
  assert.equal(harness.counters.appShellAccesses, 0)
  assert.equal(harness.logErrors.length, 0)
})

test('absent globals are imported and verified', async () => {
  const harness = createHarness({ onImport: installWorkingPair })
  await harness.startup()

  const ctx = harness.latestCtx()
  assert.equal(ctx.__runtimeBridgeReport.provider, 'import-global-properties')
  assert.equal(ctx.__runtimeBridgeReport.semanticScholarAvailable, true)
  assert.deepEqual(harness.importCalls, [['AbortController', 'DOMException']])
  assert.equal(ctx.AbortController, FakeAbortController)
  assert.equal(harness.counters.appShellAccesses, 0)
})

test('partial-native: only the absent name is imported', async () => {
  const harness = createHarness({ globals: { DOMException: FakeDOMException }, onImport: installWorkingPair })
  await harness.startup()

  const ctx = harness.latestCtx()
  assert.equal(ctx.__runtimeBridgeReport.provider, 'import-global-properties')
  assert.deepEqual(harness.importCalls, [['AbortController']])
})

test('present-but-malformed constructors are never re-imported; startup degrades', async () => {
  const malformedController = function MalformedAbortController(this: unknown) {
    // Constructs, but yields no working signal.
  }
  const harness = createHarness({
    globals: { AbortController: malformedController, DOMException: FakeDOMException },
    onImport: installWorkingPair,
  })
  await harness.startup()

  const ctx = harness.latestCtx()
  assert.equal(ctx.__runtimeBridgeReport.provider, 'unavailable')
  assert.equal(ctx.__runtimeBridgeReport.semanticScholarAvailable, false)
  // The present (broken) name must not be re-imported — we don't assume Gecko repairs it.
  assert.equal(harness.importCalls.length, 0)
  assert.equal(harness.counters.loadSubScript, 1)
  assert.equal(harness.counters.onStartup, 1)
  assert.equal(harness.logErrors.length, 1)
})

test('ineffective imports degrade: no-op, throwing, and non-callable installs', async () => {
  for (const onImport of [
    undefined,
    () => {
      throw new Error('import refused')
    },
    (names: readonly string[], vmGlobal: Record<string, unknown>) => {
      for (const name of names) vmGlobal[name] = 42
    },
  ]) {
    const harness = createHarness({ onImport })
    await harness.startup()

    const ctx = harness.latestCtx()
    assert.equal(ctx.__runtimeBridgeReport.provider, 'unavailable')
    assert.equal(harness.counters.loadSubScript, 1, 'bundle must still load')
    assert.equal(harness.counters.onStartup, 1, 'startup hook must still run')
    assert.equal(harness.logErrors.length, 1, 'degradation is logged exactly once')
  }
})

test('broken .any composition fails behavioral verification', async () => {
  const harness = createHarness({
    globals: { AbortController: BrokenAnyAbortController, DOMException: FakeDOMException },
  })
  await harness.startup()

  assert.equal(harness.latestCtx().__runtimeBridgeReport.provider, 'unavailable')
})

test('all-fail floor: startup completes with diagnostic stubs and working shims', async () => {
  const harness = createHarness()
  await harness.startup()

  const ctx = harness.latestCtx()
  assert.equal(ctx.__runtimeBridgeReport.provider, 'unavailable')
  assert.throws(() => new ctx.AbortController(), /AbortController is unavailable in this Zotero runtime/)
  assert.throws(() => new ctx.DOMException('x', 'AbortError'), /DOMException is unavailable in this Zotero runtime/)
  assert.equal(typeof ctx.AbortSignal.any, 'function', 'typeof probes must not throw')
  assert.throws(() => ctx.AbortSignal.any([]), /AbortSignal\.any is unavailable in this Zotero runtime/)
  assert.throws(() => ctx.AbortSignal.timeout(1), /AbortSignal\.timeout is unavailable in this Zotero runtime/)
  assert.equal(typeof ctx.performance.now(), 'number')

  let ran = false
  ctx.queueMicrotask(() => {
    ran = true
  })
  assert.equal(ran, false, 'queueMicrotask must be asynchronous')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ran, true)
})

test('scope reuse across disable/enable: persisted imports are not repeated', async () => {
  const harness = createHarness({ onImport: installWorkingPair })
  await harness.startup()
  assert.equal(harness.latestCtx().__runtimeBridgeReport.provider, 'import-global-properties')

  await harness.shutdown('ADDON_DISABLE')
  assert.equal(harness.counters.destruct, 1)

  await harness.startup()
  assert.equal(harness.ctxCount(), 2, 'each startup evaluates the bundle into a fresh ctx')
  assert.equal(harness.latestCtx().__runtimeBridgeReport.provider, 'bootstrap-global')
  assert.equal(harness.importCalls.length, 1, 'no duplicate import on the reused scope')
  assert.equal(harness.counters.appShellAccesses, 0)
})

test('a rejecting shutdown hook still destructs the chrome handle', async () => {
  const harness = createHarness({ onImport: installWorkingPair })
  await harness.startup()

  harness.hooks.onShutdown = async () => {
    throw new Error('teardown failure')
  }
  await assert.rejects(harness.shutdown('ADDON_DISABLE'), /teardown failure/)
  assert.equal(harness.counters.destruct, 1)
})
