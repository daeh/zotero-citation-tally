import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ItemIdentifier } from '../src/modules/citationTypes.ts'
import {
  type AttemptMode,
  type KeyStateAccess,
  S2_PAPER_BASE,
  type S2CoreConfig,
  type S2CoreDeps,
  SemanticScholarClientCore,
} from '../src/modules/semanticScholarClient.core.ts'
import {
  applyRejection,
  initialKeyState,
  isKeyedAttemptEligible,
  type KeyState,
  recordAuthAccepted,
  releaseHalfOpen,
  selectAttemptAuthority,
} from '../src/modules/semanticScholarKeyState.ts'
import { parseRetryAfterMs } from '../src/utils/temporalParse.ts'

interface Step {
  status?: number
  body?: string
  headers?: Record<string, string>
  throw?: 'AbortError' | 'TypeError'
  rejectWith?: unknown
  /** Fires while the response body is being read, to race the caller. */
  onBodyRead?: () => void
  /** Observe how the body is disposed of instead of returning a real Response. */
  spy?: BodySpy
}

interface BodySpy {
  cancelled: boolean
  textRead: boolean
}

const oneDoi: ItemIdentifier[] = [{ type: 'doi', id: '10.1/x', source: 'DOI' }]
const twoIds: ItemIdentifier[] = [
  { type: 'doi', id: '10.1/x', source: 'DOI' },
  { type: 'arxiv', id: '2201.02177', source: 'archiveID' },
]
const ok = (count: number): Step => ({ status: 200, body: JSON.stringify({ citationCount: count }) })
/** API Gateway's actual shape for an unrecognised key. */
const forbidden = (): Step => ({
  status: 403,
  body: '{"message":"Forbidden"}',
  headers: { 'content-length': '23' },
})

function anonState(): KeyStateAccess {
  return {
    isEligible: () => true,
    reject: () => 'stale',
    recordAuthAccepted: () => undefined,
    authEpoch: () => 0,
    releaseHalfOpen: () => undefined,
    currentContext: () => ({ mode: 'anonymous' }),
  }
}

/**
 * Drives the real key-state machine, so these tests exercise the true transitions
 * instead of a double that could drift from them.
 */
function keyedState(key: string, clock: () => number) {
  let state: KeyState = initialKeyState()
  const rejected: string[] = []
  const accepted: string[] = []

  const access: KeyStateAccess = {
    isEligible: (ref, authority) => isKeyedAttemptEligible(state, ref, clock(), authority),
    reject: (ref, attempt) => {
      const outcome = applyRejection(state, ref, attempt, clock())
      state = outcome.state
      if (outcome.disposition === 'applied') rejected.push(ref.key)
      return outcome.disposition
    },
    recordAuthAccepted: (ref) => {
      accepted.push(ref.key)
      state = recordAuthAccepted(state, ref)
    },
    authEpoch: () => state.authEpoch,
    releaseHalfOpen: (ref, leaseId) => {
      state = releaseHalfOpen(state, ref, leaseId)
    },
    currentContext: (): AttemptMode => {
      const generation = state.keyGeneration
      const picked = selectAttemptAuthority(state, key, clock())
      state = picked.state
      return picked.authority === null
        ? { mode: 'anonymous' }
        : { mode: 'keyed', key, generation, authority: picked.authority }
    },
  }

  return {
    access,
    rejected,
    accepted,
    get state() {
      return state
    },
    get paused() {
      return state.rejection !== null
    },
    /** Stand in for another concurrent operation seeing an accepted response. */
    acceptElsewhere: () => {
      state = recordAuthAccepted(state, { key, generation: state.keyGeneration })
    },
  }
}

function makeCore(opts: {
  script: Step[]
  /** Supply a key to drive the real key-state machine; omit for anonymous. */
  keyed?: string
  random?: number
  shutdownSignal?: AbortSignal
  onFetch?: (callIndex: number) => void
  config?: Partial<S2CoreConfig>
}) {
  const state = { clock: 0, calls: [] as { keyed: boolean; userAgent?: string; url: string }[], i: 0 }
  const key = opts.keyed === undefined ? null : keyedState(opts.keyed, () => state.clock)

  const deps: S2CoreDeps = {
    fetch: (url, init) => {
      const headers = init.headers as Record<string, string> | undefined
      const callIndex = state.calls.length
      state.calls.push({ keyed: Boolean(headers?.['x-api-key']), userAgent: headers?.['User-Agent'], url })
      const step = opts.script[state.i++]
      if (step === undefined) return Promise.reject(new Error('script exhausted'))
      opts.onFetch?.(callIndex)
      if ('rejectWith' in step) return Promise.reject(step.rejectWith)
      if (step.throw === 'AbortError') {
        const e = new Error('aborted')
        e.name = 'AbortError'
        return Promise.reject(e)
      }
      if (step.throw === 'TypeError') return Promise.reject(new TypeError('network'))
      if (step.spy !== undefined) {
        const spy = step.spy
        const observed = {
          status: step.status ?? 200,
          headers: new Headers(step.headers),
          body: {
            cancel: () => {
              spy.cancelled = true
              return Promise.resolve()
            },
          },
          text: async () => {
            spy.textRead = true
            return step.body ?? ''
          },
        }
        return Promise.resolve(observed as unknown as Response)
      }
      const response = new Response(step.body ?? '', { status: step.status ?? 200, headers: step.headers })
      if (step.onBodyRead === undefined) return Promise.resolve(response)
      // Response-shaped stand-in whose body read is observable, to race the caller.
      const racing = {
        status: response.status,
        headers: response.headers,
        body: response.body,
        text: async () => {
          step.onBodyRead!()
          return response.text()
        },
      }
      return Promise.resolve(racing as unknown as Response)
    },
    paperBaseUrl: S2_PAPER_BASE,
    userAgent: 'Citation-Tally/test',
    monotonicNow: () => state.clock,
    nowEpochMs: () => 1_700_000_000_000 + state.clock,
    createTimeoutSignal: () => ({ signal: new AbortController().signal, dispose: () => {} }),
    combineSignals: (signals) => AbortSignal.any(signals),
    sleep: (ms, signal) => {
      if (signal?.aborted === true) return Promise.reject(new DOMException('Aborted', 'AbortError'))
      state.clock += ms
      return Promise.resolve()
    },
    random: () => opts.random ?? 0,
    getKeyState: key?.access ?? anonState(),
    getSpacingMs: (mode) => (mode === 'keyed' ? 1000 : 3000),
    parseRetryAfterMs,
    shutdownSignal: opts.shutdownSignal ?? new AbortController().signal,
    log: () => undefined,
    config: opts.config,
  }
  return { core: new SemanticScholarClientCore(deps), state, key }
}

const keyedCtx = (key: string, generation = 0): AttemptMode => ({
  mode: 'keyed',
  key,
  generation,
  authority: { kind: 'ordinary' },
})

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

test('every request identifies the client, keyed or not', async () => {
  const { core, state } = makeCore({ script: [ok(1)], keyed: 'K' })
  await core.lookupSemanticScholarCount(oneDoi)
  assert.equal(state.calls[0].userAgent, 'Citation-Tally/test')

  const anon = makeCore({ script: [ok(1)] })
  await anon.core.lookupSemanticScholarCount(oneDoi)
  assert.equal(anon.state.calls[0].userAgent, 'Citation-Tally/test')
})

// --- Authentication: corroboration ------------------------------------------

test('a single keyed 403 does not pause the key — it is retried and can succeed', async () => {
  const { core, state, key } = makeCore({ script: [forbidden(), ok(7)], keyed: 'GOODKEY' })
  assert.deepEqual(await core.lookupSemanticScholarCount(oneDoi), { count: 7, status: 'success' })
  assert.deepEqual(key!.rejected, [], 'one 403 must never pause the key')
  assert.equal(key!.paused, false)
  assert.equal(state.calls[0].keyed, true)
  assert.equal(state.calls[1].keyed, true, 'the confirming request must still carry the key')
})

test('two adjacent keyed 403s pause the key and fall back to anonymous', async () => {
  const { core, state, key } = makeCore({ script: [forbidden(), forbidden(), ok(7)], keyed: 'BADKEY' })
  assert.deepEqual(await core.lookupSemanticScholarCount(oneDoi), { count: 7, status: 'success' })
  assert.deepEqual(key!.rejected, ['BADKEY'])
  assert.equal(key!.paused, true)
  assert.equal(state.calls[0].keyed, true)
  assert.equal(state.calls[1].keyed, true)
  assert.equal(state.calls[2].keyed, false, 'the paused key must not be resent')
})

test('403 → 429 → 403 does not pause the key (the pair is not adjacent)', async () => {
  const { core, key } = makeCore({
    script: [forbidden(), { status: 429 }, forbidden(), ok(5)],
    keyed: 'GOODKEY',
  })
  const result = await core.lookupSemanticScholarCount(oneDoi)
  assert.equal(result.status, 'transient_error')
  assert.deepEqual(key!.rejected, [])
  assert.equal(key!.paused, false)
})

test('401 never pauses the key, however often it repeats', async () => {
  for (const script of [[{ status: 401 }], [{ status: 401 }, { status: 401 }, { status: 401 }]]) {
    const { core, key } = makeCore({ script, keyed: 'GOODKEY' })
    const result = await core.lookupSemanticScholarCount(oneDoi)
    assert.equal(result.status, 'transient_error')
    assert.deepEqual(key!.rejected, [], '401 is not Semantic Scholar’s unrecognised-key signal')
  }
})

test('an accepted response between the two 403s invalidates the pair', async () => {
  // Stands in for another operation succeeding after the first 403 is recorded.
  let acceptElsewhere: (() => void) | null = null
  const { core, key } = makeCore({
    script: [forbidden(), forbidden()],
    keyed: 'GOODKEY',
    onFetch: (i) => {
      if (i === 1) acceptElsewhere?.()
    },
  })
  acceptElsewhere = () => key!.acceptElsewhere()

  const result = await core.requestS2('paper', keyedCtx('GOODKEY'), undefined, { maxRetries: 0 })
  // A declined transition is not a rejection: reporting it as one is exactly how a
  // valid key gets shown as rejected, which is the bug this change exists to fix.
  assert.equal(result.kind, 'auth_unconfirmed')
  assert.deepEqual(key!.rejected, [], 'the epoch bump must invalidate the half-finished pair')
  assert.equal(key!.paused, false)
})

test('the epoch is sampled at header arrival, not after the body read', async () => {
  let acceptElsewhere: (() => void) | null = null
  const racingFirst: Step = { ...forbidden(), onBodyRead: () => acceptElsewhere?.() }
  const { core, key } = makeCore({ script: [racingFirst, forbidden()], keyed: 'GOODKEY' })
  acceptElsewhere = () => key!.acceptElsewhere()

  const result = await core.requestS2('paper', keyedCtx('GOODKEY'), undefined, { maxRetries: 0 })
  assert.equal(result.kind, 'auth_unconfirmed')
  assert.deepEqual(key!.rejected, [], 'an acceptance during the body read still breaks the pair')
})

test('revalidating an already-paused key still reports the rejection', async () => {
  // Pause the key, then bypass-validate it while the cooldown is live. The pause
  // needs no further change, but the evidence is sound — reporting "could not
  // validate" here would hide a genuinely bad key behind an inconclusive result.
  const { core, key } = makeCore({
    script: [forbidden(), forbidden(), forbidden(), forbidden()],
    keyed: 'BADKEY',
  })
  await core.requestS2('paper', keyedCtx('BADKEY'), undefined, { maxRetries: 0 })
  assert.equal(key!.paused, true)

  const revalidation = await core.requestS2(
    'paper',
    { mode: 'keyed', key: 'BADKEY', generation: 0, authority: { kind: 'bypass' } },
    undefined,
    { maxRetries: 0 },
  )
  assert.equal(revalidation.kind, 'auth_rejected')
  assert.equal(key!.state.rejection!.strikes, 1, 'an already-covered incident must not advance the ladder')
})

test('the auth-confirmation request does not spend a transient retry', async () => {
  // 403 (confirm) → 429 (transient retry) → success, all within maxRetries: 1.
  const { core, state, key } = makeCore({
    script: [forbidden(), { status: 429 }, ok(5)],
    keyed: 'GOODKEY',
    config: { maxRetries: 1 },
  })
  const result = await core.requestS2('paper', keyedCtx('GOODKEY'), undefined, { maxRetries: 1 })
  assert.equal(result.kind, 'response')
  assert.equal(state.calls.length, 3, 'the budgets must be independent')
  assert.deepEqual(key!.rejected, [])
})

test('the 403 body is captured, JSON message preferred', async () => {
  const { core } = makeCore({ script: [forbidden(), forbidden()], keyed: 'BADKEY' })
  const result = await core.requestS2('paper', keyedCtx('BADKEY'), undefined, { maxRetries: 0 })
  assert.equal(result.kind, 'auth_rejected')
  assert.equal(result.kind === 'auth_rejected' ? result.detail : undefined, 'Forbidden')
})

test('an oversized or compressed error body is skipped, but the status survives', async () => {
  const oversized: Step = { status: 403, body: 'x', headers: { 'content-length': '999999' } }
  const compressed: Step = {
    status: 403,
    body: 'x',
    headers: { 'content-length': '23', 'content-encoding': 'gzip' },
  }
  for (const step of [oversized, compressed]) {
    const { core } = makeCore({ script: [step, step], keyed: 'BADKEY' })
    const result = await core.requestS2('paper', keyedCtx('BADKEY'), undefined, { maxRetries: 0 })
    assert.equal(result.kind, 'auth_rejected')
    assert.equal(result.kind === 'auth_rejected' ? result.detail : 'unset', undefined)
  }
})

test('a body failing the size guard is cancelled, never read', async () => {
  // Reading it to drain would defeat the bound — the skipped bodies are the
  // unbounded ones. Two steps because one 403 only triggers the confirming retry.
  const cases: [string, Record<string, string>][] = [
    ['oversized', { 'content-length': '999999' }],
    ['compressed', { 'content-length': '23', 'content-encoding': 'gzip' }],
    ['no content-length', {}],
  ]
  for (const [label, headers] of cases) {
    const spy: BodySpy = { cancelled: false, textRead: false }
    const step: Step = { status: 403, body: '{"message":"Forbidden"}', headers, spy }
    const { core } = makeCore({ script: [step, step], keyed: 'BADKEY' })
    await core.requestS2('paper', keyedCtx('BADKEY'), undefined, { maxRetries: 0 })
    assert.equal(spy.textRead, false, `${label}: the body must not be allocated`)
    assert.equal(spy.cancelled, true, `${label}: the body must be cancelled`)
  }
})

test('a body within the size guard is read rather than cancelled', async () => {
  const spy: BodySpy = { cancelled: false, textRead: false }
  const step: Step = { status: 403, body: '{"message":"Forbidden"}', headers: { 'content-length': '23' }, spy }
  const { core } = makeCore({ script: [step, step], keyed: 'BADKEY' })
  const result = await core.requestS2('paper', keyedCtx('BADKEY'), undefined, { maxRetries: 0 })
  assert.equal(spy.textRead, true)
  assert.equal(spy.cancelled, false)
  assert.equal(result.kind === 'auth_rejected' ? result.detail : undefined, 'Forbidden')
})

test('a missing content-length means status only', async () => {
  const noLength: Step = { status: 403, body: '{"message":"Forbidden"}' }
  const { core } = makeCore({ script: [noLength, noLength], keyed: 'BADKEY' })
  const result = await core.requestS2('paper', keyedCtx('BADKEY'), undefined, { maxRetries: 0 })
  assert.equal(result.kind, 'auth_rejected')
  assert.equal(result.kind === 'auth_rejected' ? result.detail : 'unset', undefined)
})

test('the key is redacted out of an echoing error body', async () => {
  const echo: Step = {
    status: 403,
    body: JSON.stringify({ message: 'key SECRET123 is not valid' }),
    headers: { 'content-length': '42' },
  }
  const { core } = makeCore({ script: [echo, echo], keyed: 'SECRET123' })
  const result = await core.requestS2('paper', keyedCtx('SECRET123'), undefined, { maxRetries: 0 })
  const detail = result.kind === 'auth_rejected' ? (result.detail ?? '') : ''
  assert.ok(!detail.includes('SECRET123'), `key leaked into detail: ${detail}`)
  assert.ok(detail.includes('[redacted]'))
})

// --- Authentication: acceptance ---------------------------------------------

test('a routed non-auth response proves acceptance; an edge throttle does not', async () => {
  const accepted = makeCore({ script: [{ status: 404 }], keyed: 'K' })
  await accepted.core.requestS2('paper', keyedCtx('K'), undefined, { maxRetries: 0 })
  assert.deepEqual(accepted.key!.accepted, ['K'], '404 is routed, so the key was authenticated')

  const throttled = makeCore({ script: [{ status: 429 }], keyed: 'K' })
  await throttled.core.requestS2('paper', keyedCtx('K'), undefined, { maxRetries: 0 })
  assert.deepEqual(throttled.key!.accepted, [], '429 can precede key validation at the edge')

  const serverError = makeCore({ script: [{ status: 503 }], keyed: 'K' })
  await serverError.core.requestS2('paper', keyedCtx('K'), undefined, { maxRetries: 0 })
  assert.deepEqual(serverError.key!.accepted, [])
})

test('a success after a pause clears it', async () => {
  const { core, key } = makeCore({ script: [forbidden(), forbidden(), ok(1)], keyed: 'K' })
  await core.requestS2('paper', keyedCtx('K'), undefined, { maxRetries: 0 })
  assert.equal(key!.paused, true)

  // Validate-style bypass: reaches the network even though the key is paused.
  const result = await core.requestS2(
    'paper',
    { mode: 'keyed', key: 'K', generation: 0, authority: { kind: 'bypass' } },
    undefined,
    { maxRetries: 0 },
  )
  assert.equal(result.kind, 'response')
  assert.equal(key!.paused, false, 'an accepted response must clear the pause')
})

// --- Authority ---------------------------------------------------------------

test('bypass waives only the cooldown, never a generation mismatch', async () => {
  const { core, state, key } = makeCore({ script: [forbidden(), forbidden()], keyed: 'K' })
  await core.requestS2('paper', keyedCtx('K'), undefined, { maxRetries: 0 })
  assert.equal(key!.paused, true)
  const callsBefore = state.calls.length

  const stale = await core.requestS2(
    'paper',
    { mode: 'keyed', key: 'K', generation: 99, authority: { kind: 'bypass' } },
    undefined,
    { maxRetries: 0 },
  )
  assert.equal(stale.kind, 'ineligible')
  assert.equal(state.calls.length, callsBefore, 'a superseded key must never reach the wire')
})

test('ordinary traffic is refused while the key is paused', async () => {
  const { core, state, key } = makeCore({ script: [forbidden(), forbidden()], keyed: 'K' })
  await core.requestS2('paper', keyedCtx('K'), undefined, { maxRetries: 0 })
  assert.equal(key!.paused, true)
  const callsBefore = state.calls.length

  const refused = await core.requestS2('paper', keyedCtx('K'), undefined, { maxRetries: 0 })
  assert.equal(refused.kind, 'ineligible')
  assert.equal(state.calls.length, callsBefore)
})

// --- Everything else ---------------------------------------------------------

test('anonymous 403 → transient_error (a service condition, not an item one)', async () => {
  const { core } = makeCore({ script: [{ status: 403 }] })
  assert.equal((await core.lookupSemanticScholarCount(oneDoi)).status, 'transient_error')
})

test('429s trigger escalating quota backoff, then succeed', async () => {
  const { core, state } = makeCore({
    script: [{ status: 429 }, { status: 429 }, ok(3)],
    keyed: 'K',
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
    keyed: 'K',
    random: 0, // Let Retry-After determine the delay.
  })
  assert.deepEqual(await core.lookupSemanticScholarCount(oneDoi), { count: 5, status: 'success' })
  assert.equal(state.clock, 10_000)
})
