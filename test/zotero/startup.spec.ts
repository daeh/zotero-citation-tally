/**
 * Real-Zotero runtime smoke: fails when the plugin cannot fully start on this
 * platform. Linux (CI) has no hidden DOM window — the exact condition that
 * bricked v0.0.14 — so a full-capability startup here is the release gate.
 *
 * Runs inside the scaffold's Zotero test window (mocha). Assertions are
 * dependency-free throws; this file is bundled by the scaffold, not by the
 * Node test runner (`.spec.ts` keeps it out of the `*.test.ts` glob), and is
 * excluded from tsconfig.test.json.
 */

import { config } from '../../package.json'

declare const Zotero: any
declare function describe(title: string, fn: (this: { timeout: (ms: number) => void }) => void): void
declare function it(title: string, fn: () => void | Promise<void>): void

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

describe('Citation Tally runtime', function () {
  this.timeout(30000)

  it('initializes fully', () => {
    const addon = Zotero[config.addonInstance]
    ok(addon, 'addon instance missing')
    ok(addon.data.initialized === true, 'plugin did not initialize')
  })

  it('resolved full Web API capabilities without a hidden window', () => {
    const addon = Zotero[config.addonInstance]
    const report = addon.data.runtimeBridge
    ok(report, 'runtime bridge report missing')
    Zotero.debug(
      `[runtime-smoke] provider=${String(report.provider)} zotero=${String(Zotero.version)} platform=${String(
        Zotero.platformVersion,
      )}`,
    )
    ok(report.semanticScholarAvailable === true, `degraded runtime: provider=${String(report.provider)}`)
    ok(
      report.provider === 'import-global-properties' || report.provider === 'bootstrap-global',
      `unexpected provider: ${String(report.provider)}`,
    )
  })

  it('bundle-realm signals integrate with fetch (self-test)', async () => {
    const addon = Zotero[config.addonInstance]
    const result = await addon.api.runtimeSelfTest()
    ok(result.ok === true, `runtime self-test failed: ${JSON.stringify(result)}`)
  })
})
