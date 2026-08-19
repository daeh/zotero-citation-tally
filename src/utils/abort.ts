/**
 * Cancellation and deadline helpers shared by every provider client.
 *
 * These were private to `semanticScholarClient`, so Crossref and INSPIRE ran
 * with no deadline at all: a hung connection blocked the update queue
 * indefinitely -- and because the queue is serialized, one stalled request
 * stalled every subsequent item until Zotero restarted.
 *
 * **The abort primitives are not always real.** On Firefox 140 Zotero only
 * creates a hidden DOM window on macOS, so the bootstrap bridge harvests
 * `AbortController` and `DOMException` and installs *throwing stubs* when it
 * cannot. `typeof AbortController === 'function'` is true for those stubs, so
 * capability must come from the bridge's report, not a typeof probe. Semantic
 * Scholar is dropped entirely in that mode, but Crossref and INSPIRE keep
 * working -- so anything they depend on must degrade rather than throw.
 *
 * Keep this module free of runtime Zotero dependencies.
 */

/** A timeout signal plus the disposer that stops its timer. */
export interface TimeoutSignal {
  signal: AbortSignal
  /**
   * Clear the pending timer. Must be called once the request settles: the
   * previous inline implementation never did, leaking one timer per request
   * that fired long after the response had arrived.
   */
  dispose: () => void
}

/**
 * A timeout signal built from `setTimeout`.
 *
 * `AbortSignal.timeout` is `Exposed=(Window,Worker)` and therefore absent from
 * the plugin's sandbox realm, so it cannot be used here.
 */
export function createTimeoutSignal(ms: number): TimeoutSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out', 'TimeoutError'))
  }, ms)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
    },
  }
}

export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals)
}

/** Sleep that rejects with `AbortError` as soon as `signal` aborts. */
export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface DeadlineOptions {
  timeoutMs: number
  /** Aborted on plugin shutdown, when the runtime supports it. */
  shutdownSignal?: AbortSignal
  /**
   * Whether the runtime's abort primitives were verified by the bootstrap
   * bridge. When false, the request cannot be cancelled and the deadline only
   * releases the caller.
   */
  canAbort: boolean
  fetchImpl?: typeof fetch
}

/**
 * `fetch` with a deadline, degrading safely when the runtime has no usable
 * `AbortController`.
 *
 * With abort support the request is genuinely cancelled and shutdown propagates
 * into it. Without it, the caller is released on time and the in-flight request
 * is abandoned -- worse, but far better than blocking the queue forever, and it
 * keeps Crossref and INSPIRE working in degraded mode.
 */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit | undefined,
  options: DeadlineOptions,
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch

  if (!options.canAbort) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Request timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)
    })
    const request = doFetch(url, init)
    // The abandoned request must not surface as an unhandled rejection.
    request.catch(() => undefined)
    try {
      return await Promise.race([request, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  const timeout = createTimeoutSignal(options.timeoutMs)
  const signals = options.shutdownSignal ? [options.shutdownSignal, timeout.signal] : [timeout.signal]
  try {
    return await doFetch(url, { ...init, signal: combineAbortSignals(signals) })
  } finally {
    timeout.dispose()
  }
}
