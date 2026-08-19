import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTimeoutSignal, fetchWithDeadline, interruptibleSleep } from '../src/utils/abort.ts'

function neverResolves(): Promise<Response> {
  return new Promise<Response>(() => {
    /* deliberately never settles */
  })
}

function okResponse(): Response {
  return new Response('{}', { status: 200 })
}

test('createTimeoutSignal aborts with TimeoutError', async () => {
  const { signal } = createTimeoutSignal(5)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(signal.aborted, true)
  assert.equal((signal.reason as DOMException).name, 'TimeoutError')
})

test('dispose stops the timer from firing (leak regression)', async () => {
  // The previous inline implementation never cleared its timer, so every
  // request left one pending that fired after the response had arrived.
  const { signal, dispose } = createTimeoutSignal(5)
  dispose()
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(signal.aborted, false, 'a disposed timeout must never abort')
})

test('interruptibleSleep resolves normally', async () => {
  const started = Date.now()
  await interruptibleSleep(10)
  assert.ok(Date.now() - started >= 8)
})

test('interruptibleSleep rejects promptly when the signal aborts', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(() => interruptibleSleep(10_000, controller.signal), { name: 'AbortError' })
})

test('interruptibleSleep rejects immediately if already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => interruptibleSleep(10_000, controller.signal), { name: 'AbortError' })
})

test('fetchWithDeadline returns the response when it arrives in time', async () => {
  const response = await fetchWithDeadline('https://example.invalid/', undefined, {
    timeoutMs: 1000,
    canAbort: true,
    fetchImpl: async () => okResponse(),
  })
  assert.equal(response.status, 200)
})

test('fetchWithDeadline cancels a hung request when abort is available', async () => {
  let observed: AbortSignal | undefined
  await assert.rejects(
    () =>
      fetchWithDeadline('https://example.invalid/', undefined, {
        timeoutMs: 10,
        canAbort: true,
        fetchImpl: (_url, init) => {
          observed = (init as RequestInit | undefined)?.signal ?? undefined
          return new Promise<Response>((_resolve, reject) => {
            observed?.addEventListener('abort', () => reject(observed?.reason as Error), { once: true })
          })
        },
      }),
    { name: 'TimeoutError' },
  )
  assert.ok(observed, 'a signal must be passed to fetch when abort is available')
})

test('shutdown propagates into the request', async () => {
  const shutdown = new AbortController()
  setTimeout(() => shutdown.abort(new DOMException('Aborted', 'AbortError')), 5)
  await assert.rejects(
    () =>
      fetchWithDeadline('https://example.invalid/', undefined, {
        timeoutMs: 10_000,
        canAbort: true,
        shutdownSignal: shutdown.signal,
        fetchImpl: (_url, init) => {
          const signal = (init as RequestInit | undefined)?.signal
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
          })
        },
      }),
    { name: 'AbortError' },
  )
})

test('the caller is still released on time without abort support (degraded mode)', async () => {
  // Crossref and INSPIRE keep running when the bridge could not supply real
  // abort primitives, so the deadline must not depend on them.
  const started = Date.now()
  await assert.rejects(
    () =>
      fetchWithDeadline('https://example.invalid/', undefined, {
        timeoutMs: 15,
        canAbort: false,
        fetchImpl: neverResolves,
      }),
    /timed out/,
  )
  assert.ok(Date.now() - started < 5000, 'must not wait on the abandoned request')
})

test('no signal is handed to fetch in degraded mode', async () => {
  // Constructing an AbortController would throw against the bootstrap's stubs.
  let sawInit: RequestInit | undefined
  const response = await fetchWithDeadline(
    'https://example.invalid/',
    { method: 'GET' },
    {
      timeoutMs: 1000,
      canAbort: false,
      fetchImpl: async (_url, init) => {
        sawInit = init as RequestInit | undefined
        return okResponse()
      },
    },
  )
  assert.equal(response.status, 200)
  assert.equal(sawInit?.signal, undefined)
  assert.equal(sawInit?.method, 'GET', 'caller init must still be forwarded')
})
