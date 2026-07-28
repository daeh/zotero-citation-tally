import { getErrorName } from './errors'

/** Result of the bundle-realm capability self-test (consumed by the CI runtime smoke). */
export interface RuntimeSelfTestResult {
  ok: boolean
  provider: string
  checks: Record<string, boolean>
  error?: string
}

/**
 * Exercises the bridged Web APIs from inside the plugin bundle realm, which is
 * where production code runs and which a test-window realm can't stand in for.
 * The fetch gets a signal that is already aborted, so it rejects with AbortError
 * without touching the network. The `.invalid` host makes sure of that even if
 * the signal were somehow ignored.
 */
export async function runtimeSelfTest(): Promise<RuntimeSelfTestResult> {
  const provider = _globalThis.__runtimeBridgeReport?.provider ?? 'missing-report'
  const checks: Record<string, boolean> = {}
  try {
    const controller = new AbortController()
    checks.construct = controller.signal.aborted === false

    const dependent = AbortSignal.any([controller.signal])
    controller.abort(new DOMException('self-test', 'AbortError'))
    checks.anyPropagation = dependent.aborted === true && getErrorName(dependent.reason) === 'AbortError'

    const aborted = new AbortController()
    aborted.abort(new DOMException('self-test', 'AbortError'))
    let fetchRejected = false
    try {
      await fetch('https://example.invalid/citation-tally-self-test', { signal: aborted.signal })
    } catch (e) {
      fetchRejected = getErrorName(e) === 'AbortError'
    }
    checks.fetchAbort = fetchRejected

    return { ok: Object.values(checks).every(Boolean), provider, checks }
  } catch (e) {
    return { ok: false, provider, checks, error: String(e) }
  }
}
