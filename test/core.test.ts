import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ItemIdentifier } from '../src/modules/citationTypes.ts'
import {
  type AttemptMode,
  type KeyStateAccess,
  type S2CoreConfig,
  type S2CoreDeps,
  SemanticScholarClientCore,
} from '../src/modules/semanticScholarClient.core.ts'
import type { KeyRef } from '../src/modules/semanticScholarKeyState.ts'
import { parseRetryAfterMs } from '../src/utils/temporalParse.ts'

interface Step {
  status?: number
  body?: string
  headers?: Record<string, string>
  throw?: 'AbortError' | 'TypeError'
  rejectWith?: unknown
}

const oneDoi: ItemIdentifier[] = [{ type: 'doi', id: '10.1/x', source: 'DOI' }]
const twoIds: ItemIdentifier[] = [
  { type: 'doi', id: '10.1/x', source: 'DOI' },
  { type: 'arxiv', id: '2201.02177', source: 'archiveID' },
]
const ok = (count: number): Step => ({ status: 200, body: JSON.stringify({ citationCount: count }) })

function anonState(): KeyStateAccess {
  return { isEligible: () => true, reject: () => undefined, currentContext: () => ({ mode: 'anonymous' }) }
}

/** Switch to anonymous after the keyed context is rejected. */
function keyedState(key: string): KeyStateAccess & { rejected: string[] } {
  const rejected: string[] = []
  const rejectedSet = new Set<string>()
  return {
    rejected,
    isEligible: (ref: KeyRef) => ref.generation === 0 && ref.key === key && !rejectedSet.has(ref.key),
    reject: (ref: KeyRef) => {
      rejected.push(ref.key)
      rejectedSet.add(ref.key)
    },
    currentContext: (): AttemptMode =>
      rejectedSet.has(key) ? { mode: 'anonymous' } : { mode: 'keyed', key, generation: 0 },
  }
}

function makeCore(opts: {
  script: Step[]
  keyState?: KeyStateAccess
  random?: number
  shutdownSignal?: AbortSignal
  onFetch?: () => void
  config?: Partial<S2CoreConfig>
}) {
  const state = { clock: 0, calls: [] as { keyed: boolean }[], i: 0 }
  const deps: S2CoreDeps = {
    fetch: (_url, init) => {
      const keyed = Boolean((init.headers as Record<string, string> | undefined)?.['x-api-key'])
      state.calls.push({ keyed })
      const step = opts.script[state.i++]
      if (step === undefined) return Promise.reject(new Error('script exhausted'))
      opts.onFetch?.()
      if ('rejectWith' in step) return Promise.reject(step.rejectWith)
      if (step.throw === 'AbortError') {
        const e = new Error('aborted')
        e.name = 'AbortError'
        return Promise.reject(e)
      }
      if (step.throw === 'TypeError') return Promise.reject(new TypeError('network'))
      return Promise.resolve(new Response(step.body ?? '', { status: step.status ?? 200, headers: step.headers }))
    },
    monotonicNow: () => state.clock,
    nowEpochMs: () => 1_700_000_000_000 + state.clock,
    createTimeoutSignal: () => new AbortController().signal,
    combineSignals: (signals) => AbortSignal.any(signals),
    sleep: (ms, signal) => {
      if (signal?.aborted === true) return Promise.reject(new DOMException('Aborted', 'AbortError'))
      state.clock += ms
      return Promise.resolve()
    },
    random: () => opts.random ?? 0,
    getKeyState: opts.keyState ?? anonState(),
    getSpacingMs: (mode) => (mode === 'keyed' ? 1000 : 3000),
    parseRetryAfterMs,
    shutdownSignal: opts.shutdownSignal ?? new AbortController().signal,
    log: () => undefined,
    config: opts.config,
  }
  return { core: new SemanticScholarClientCore(deps), state }
}

test('success returns the parsed citation count', async () => {
  const { core } = makeCore({ script: [ok(42)] })
  assert.deepEqual(await core.lookupSemanticScholarCount(oneDoi), { count: 42, status: 'success' })
})

test('empty identifiers → no_identifier (never a vacuous not_found)', async () => {
  const { core } = makeCore({ script: [] })
  assert.equal((await core.lookupSemanticScholarCount([])).status, 'no_identifier')
})

test('global 1-RPS spacing: the second anonymous request waits ≥3000ms', async () => {
  const { core, state } = makeCore({ script: [ok(1), ok(2)] })
  await core.lookupSemanticScholarCount(oneDoi)
  const before = state.clock
  await core.lookupSemanticScholarCount(oneDoi)
  assert.ok(state.clock - before >= 3000, `spacing not enforced: ${state.clock - before}`)
})

test('keyed 403 disables the key, warns, and falls back to anonymous', async () => {
  const keyState = keyedState('BADKEY')
  const { core, state } = makeCore({ script: [{ status: 403 }, ok(7)], keyState })
  const result = await core.lookupSemanticScholarCount(oneDoi)
  assert.deepEqual(result, { count: 7, status: 'success' })
  assert.deepEqual(keyState.rejected, ['BADKEY'])
  assert.equal(state.calls[0].keyed, true)
  assert.equal(state.calls[1].keyed, false)
})

test('keyed 401 disables the key and falls back to anonymous (same as 403)', async () => {
  const keyState = keyedState('BADKEY')
  const { core, state } = makeCore({ script: [{ status: 401 }, ok(7)], keyState })
  const result = await core.lookupSemanticScholarCount(oneDoi)
  assert.deepEqual(result, { count: 7, status: 'success' })
  assert.deepEqual(keyState.rejected, ['BADKEY'])
  assert.equal(state.calls[0].keyed, true)
  assert.equal(state.calls[1].keyed, false)
})

test('anonymous 403 → api_error and stop', async () => {
  const { core } = makeCore({ script: [{ status: 403 }] })
  assert.equal((await core.lookupSemanticScholarCount(oneDoi)).status, 'api_error')
})

test('429s trigger escalating quota backoff, then succeed', async () => {
  const { core, state } = makeCore({
    script: [{ status: 429 }, { status: 429 }, ok(3)],
    keyState: keyedState('K'),
    random: 1,
  })
  const result = await core.lookupSemanticScholarCount(oneDoi)
  assert.deepEqual(result, { count: 3, status: 'success' })
  // Backoff advances the clock by 1 second, then 2 seconds; request spacing is already satisfied.
  assert.equal(state.clock, 3000)
  assert.equal(state.calls.length, 3)
})

test('exhausted 5xx → transient_error (not ignored)', async () => {
  const { core, state } = makeCore({
    script: [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }],
    config: { maxRetries: 4 },
  })
  assert.equal((await core.lookupSemanticScholarCount(oneDoi)).status, 'transient_error')
  assert.equal(state.calls.length, 5)
})

test('exhausted 429 → rate_limited (distinct from other transients)', async () => {
  const { core, state } = makeCore({
    script: [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }],
    config: { maxRetries: 4 },
  })
  assert.equal((await core.lookupSemanticScholarCount(oneDoi)).status, 'rate_limited')
  assert.equal(state.calls.length, 5)
})

test('malformed 2xx → transient_error (never not_found)', async () => {
  const { core } = makeCore({ script: [{ status: 200, body: 'not json' }] })
  assert.equal((await core.lookupSemanticScholarCount(oneDoi)).status, 'transient_error')
})

test('negative citationCount is rejected as malformed', async () => {
  const { core } = makeCore({ script: [{ status: 200, body: '{"citationCount":-1}' }] })
  assert.equal((await core.lookupSemanticScholarCount(oneDoi)).status, 'transient_error')
})

test('genuine 404 across all identifiers → not_found', async () => {
  const { core } = makeCore({ script: [{ status: 404 }, { status: 404 }] })
  assert.equal((await core.lookupSemanticScholarCount(twoIds)).status, 'not_found')
})

test('aggregate: 404 then success on the next identifier → success', async () => {
  const { core } = makeCore({ script: [{ status: 404 }, ok(9)] })
  assert.deepEqual(await core.lookupSemanticScholarCount(twoIds), { count: 9, status: 'success' })
})

test('aggregate: 400 + 404 → api_error (client error outranks not_found)', async () => {
  const { core } = makeCore({ script: [{ status: 400 }, { status: 404 }] })
  assert.equal((await core.lookupSemanticScholarCount(twoIds)).status, 'api_error')
})

test('shutdown before fetching → AbortError propagates', async () => {
  const controller = new AbortController()
  controller.abort()
  const { core, state } = makeCore({ script: [ok(1)], shutdownSignal: controller.signal })
  await assert.rejects(
    core.lookupSemanticScholarCount(oneDoi),
    (e: unknown) => e instanceof Error && e.name === 'AbortError',
  )
  assert.equal(state.calls.length, 0)
})

test('cross-realm-shaped TimeoutError is transient and retried', async () => {
  const timeoutError = { name: 'TimeoutError', message: 'The operation timed out' }
  assert.equal(timeoutError instanceof Error, false)

  const { core, state } = makeCore({
    script: [{ rejectWith: timeoutError }, ok(8)],
    config: { maxRetries: 1 },
  })

  assert.deepEqual(await core.lookupSemanticScholarCount(oneDoi), { count: 8, status: 'success' })
  assert.equal(state.calls.length, 2)
})

test('cross-realm-shaped AbortError without caller cancellation is a timeout', async () => {
  const { core } = makeCore({
    script: [{ rejectWith: { name: 'AbortError', message: 'Composite signal aborted' } }],
  })

  assert.deepEqual(await core.requestS2('paper-id', { mode: 'anonymous' }, undefined, { maxRetries: 0 }), {
    kind: 'transient',
    cause: 'timeout',
  })
})

test('cross-realm-shaped TypeError is a network transient', async () => {
  const { core } = makeCore({
    script: [{ rejectWith: { name: 'TypeError', message: 'Network request failed' } }],
  })

  assert.deepEqual(await core.requestS2('paper-id', { mode: 'anonymous' }, undefined, { maxRetries: 0 }), {
    kind: 'transient',
    cause: 'network',
  })
})

test('caller cancellation takes precedence over a timeout-shaped rejection', async () => {
  const caller = new AbortController()
  const { core } = makeCore({
    script: [{ rejectWith: { name: 'TimeoutError', message: 'The operation timed out' } }],
    onFetch: () => caller.abort(),
  })

  assert.deepEqual(await core.requestS2('paper-id', { mode: 'anonymous' }, caller.signal, { maxRetries: 0 }), {
    kind: 'aborted',
  })
})

test('unknown and null fetch rejections are rethrown unchanged', async () => {
  const unknownError = { name: 'RangeError', message: 'Unexpected failure' }
  const { core: unknownCore } = makeCore({ script: [{ rejectWith: unknownError }] })
  await assert.rejects(
    unknownCore.requestS2('paper-id', { mode: 'anonymous' }, undefined, { maxRetries: 0 }),
    (error: unknown) => error === unknownError,
  )

  const { core: nullCore } = makeCore({ script: [{ rejectWith: null }] })
  let fulfilled = true
  let rejection: unknown
  try {
    await nullCore.requestS2('paper-id', { mode: 'anonymous' }, undefined, { maxRetries: 0 })
  } catch (error) {
    fulfilled = false
    rejection = error
  }
  assert.equal(fulfilled, false)
  assert.equal(rejection, null)
})

test('Retry-After header is honored as a floor on 429', async () => {
  const { core, state } = makeCore({
    script: [{ status: 429, headers: { 'retry-after': '10' } }, ok(5)],
    keyState: keyedState('K'),
    random: 0, // Let Retry-After determine the delay.
  })
  assert.deepEqual(await core.lookupSemanticScholarCount(oneDoi), { count: 5, status: 'success' })
  assert.equal(state.clock, 10_000)
})
