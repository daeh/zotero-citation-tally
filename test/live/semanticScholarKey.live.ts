/**
 * Live Semantic Scholar checks against a real API key.
 *
 * Opt-in: run with `yarn test:live`. Excluded from `test:unit`, which stays
 * offline and deterministic — these tests need the network and the vault.
 *
 * The key is read from the vault once per run and held only in memory. It is
 * never written to disk, never placed in an environment variable, and never
 * logged: every assertion here is on a status code or on character *labels*, so
 * a failure message cannot carry key material.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import type { ItemIdentifier } from '../../src/modules/citationTypes.ts'
import {
  type KeyStateAccess,
  S2_PAPER_BASE,
  type S2CoreDeps,
  SemanticScholarClientCore,
} from '../../src/modules/semanticScholarClient.core.ts'
import {
  applyRejection,
  initialKeyState,
  isKeyedAttemptEligible,
  type KeyState,
  recordAuthAccepted,
  releaseHalfOpen,
  selectAttemptAuthority,
} from '../../src/modules/semanticScholarKeyState.ts'
import { normalizeApiKey } from '../../src/utils/apiKey.ts'
import { parseRetryAfterMs } from '../../src/utils/temporalParse.ts'

const execFileAsync = promisify(execFile)

/**
 * One paper addressed two ways: a raw Semantic Scholar paper-id path segment, and
 * a DOI that goes through the plugin's own identifier mapping. Pairing them lets
 * the suite check that both routes land on the same work.
 */
// Semantic Scholar accepts this prefix case-insensitively; `CorpusId:` is the
// documented spelling and both were verified to resolve to the same paper.
const PROBE_PAPER_ID = 'CorpusID:259065118'
const PROBE_DOI = '10.1098/rsta.2022.0047'

const USER_AGENT = 'Citation-Tally/live-test (+https://github.com/daeh/zotero-citation-tally)'
const VAULT_TIMEOUT_MS = 20_000
/** Comfortably above the keyed budget, so assertions land on answers not throttles. */
const KEYED_SPACING_MS = 2_000
const MAX_THROTTLE_RETRIES = 3
/** Spread the opening request, so runs launched close together do not collide. */
const LEAD_IN_JITTER_MS = 1_000

const VAULT_ARGS = ['item', 'view', '--vault-name', 'DaeMain', '--item-title', 'SemanticScholar', '--field', 'API Key']

let pending: Promise<string | null> | undefined

async function readVaultKey(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('pass-cli', VAULT_ARGS, {
      encoding: 'utf8',
      timeout: VAULT_TIMEOUT_MS,
    })
    // Strip only the CLI's own line ending; anything else is the key's problem.
    const raw = stdout.replace(/\r?\n$/, '')
    return raw === '' ? null : raw
  } catch {
    // Locked vault, missing item, or no pass-cli. Deliberately swallowed without
    // inspection so nothing from the failure path can surface key material.
    return null
  }
}

/** One vault read per run, shared by every test below. */
function vaultKey(): Promise<string | null> {
  pending ??= readVaultKey()
  return pending
}

const SKIP_REASON = 'no API key available (pass-cli missing, vault locked, or item not found)'

// Spacing is tracked across the whole file, because the keyed budget is per key,
// not per test, and node:test runs the tests in a file sequentially.
//
// `performance.now()` rather than a wall clock: this measures elapsed time, so a
// clock adjustment must not be able to collapse or inflate the spacing.
//
// Seeded as though a request had just been made, plus jitter, so the *first*
// request also waits: the budget is shared with any run started moments earlier,
// and back-to-back invocations would otherwise spend it immediately.
let lastRequestAt = performance.now() + Math.random() * LEAD_IN_JITTER_MS

async function pace(): Promise<void> {
  const since = performance.now() - lastRequestAt
  if (since < KEYED_SPACING_MS) await delay(KEYED_SPACING_MS - since)
  lastRequestAt = performance.now()
}

/**
 * Fetch with pacing and escalating retry on 429, so an assertion lands on a real
 * answer rather than a throttle. The keyed budget has a burst allowance that
 * repeated runs of this suite can exhaust, which otherwise makes the strict
 * assertions flaky for reasons that have nothing to do with the code under test.
 */
async function pacedFetch(paperId: string, fields: string, headers: Record<string, string>): Promise<Response> {
  const url = `${S2_PAPER_BASE}/${paperId}?fields=${fields}`
  for (let attempt = 0; ; attempt++) {
    await pace()
    const res = await fetch(url, { headers })
    if (res.status !== 429 || attempt >= MAX_THROTTLE_RETRIES) return res

    const retryAfterSeconds = Number(res.headers.get('retry-after') ?? '')
    res.body?.cancel().catch(() => undefined)
    const backoff = KEYED_SPACING_MS * 2 ** (attempt + 1)
    await delay(Math.max(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 0, backoff))
    lastRequestAt = performance.now()
  }
}

/** A 429 that outlives the retries says nothing about the assertion; skip rather than fail. */
function throttled(res: Response): boolean {
  return res.status === 429
}

const keyedHeaders = (key: string): Record<string, string> => ({ 'x-api-key': key, 'User-Agent': USER_AGENT })

/** The real state machine, so a live run exercises the production transitions. */
function liveKeyState(key: string) {
  let state: KeyState = initialKeyState()
  const rejected: string[] = []

  const access: KeyStateAccess = {
    isEligible: (ref, authority) => isKeyedAttemptEligible(state, ref, performance.now(), authority),
    reject: (ref, attempt) => {
      const outcome = applyRejection(state, ref, attempt, performance.now())
      state = outcome.state
      if (outcome.disposition === 'applied') rejected.push('rejected')
      return outcome.disposition
    },
    recordAuthAccepted: (ref) => {
      state = recordAuthAccepted(state, ref)
    },
    authEpoch: () => state.authEpoch,
    releaseHalfOpen: (ref, leaseId) => {
      state = releaseHalfOpen(state, ref, leaseId)
    },
    currentContext: () => {
      const generation = state.keyGeneration
      const picked = selectAttemptAuthority(state, key, performance.now())
      state = picked.state
      return picked.authority === null
        ? { mode: 'anonymous' }
        : { mode: 'keyed', key, generation, authority: picked.authority }
    },
  }

  return {
    access,
    rejected,
    get paused() {
      return state.rejection !== null
    },
  }
}

function liveCore(keyState: KeyStateAccess): SemanticScholarClientCore {
  const deps: S2CoreDeps = {
    fetch: (url, init) => fetch(url, init),
    paperBaseUrl: S2_PAPER_BASE,
    userAgent: USER_AGENT,
    monotonicNow: () => performance.now(),
    nowEpochMs: () => Temporal.Now.instant().epochMilliseconds,
    createTimeoutSignal: (ms) => ({ signal: AbortSignal.timeout(ms), dispose: () => {} }),
    combineSignals: (signals) => AbortSignal.any(signals),
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    random: () => Math.random(),
    getKeyState: keyState,
    getSpacingMs: (mode) => (mode === 'keyed' ? 1000 : 3000),
    parseRetryAfterMs,
    shutdownSignal: new AbortController().signal,
    log: () => undefined, // silent: the log line is safe, but keep the run quiet
  }
  return new SemanticScholarClientCore(deps)
}

test('the vault key is clean and can be sent as a header', async (t) => {
  const raw = await vaultKey()
  if (raw === null) return t.skip(SKIP_REASON)

  const normalized = normalizeApiKey(raw)
  // Labels only (`U+200B`), never the characters and never the key itself.
  assert.deepEqual(normalized.unusable, [], `key holds unsendable characters: ${normalized.unusable.join(', ')}`)
  assert.notEqual(normalized.key, '', 'vault returned an empty key')
  assert.doesNotThrow(() => new Headers({ 'x-api-key': normalized.key }))

  if (normalized.removed.length > 0) {
    t.diagnostic(`normalization stripped: ${normalized.removed.join(', ')}`)
  }
})

test('Semantic Scholar accepts the key', async (t) => {
  const raw = await vaultKey()
  if (raw === null) return t.skip(SKIP_REASON)

  const res = await pacedFetch(PROBE_PAPER_ID, 'citationCount', keyedHeaders(normalizeApiKey(raw).key))
  t.diagnostic(`status ${res.status}`)

  // API Gateway rejects an unrecognised key with 403 before it ever throttles, so
  // a 429 still proves the key was recognised. Only 401/403 condemn it.
  assert.notEqual(res.status, 403, 'API Gateway did not recognise this key')
  assert.notEqual(res.status, 401, 'the key was refused as unauthorized')
  assert.ok(res.status === 200 || res.status === 429, `unexpected status ${res.status}`)
})

test('the CorpusID and DOI forms address the same paper', async (t) => {
  const raw = await vaultKey()
  if (raw === null) return t.skip(SKIP_REASON)
  const headers = keyedHeaders(normalizeApiKey(raw).key)

  const byCorpus = await pacedFetch(PROBE_PAPER_ID, 'externalIds', headers)
  const byDoi = throttled(byCorpus) ? byCorpus : await pacedFetch(`DOI:${PROBE_DOI}`, 'externalIds', headers)
  if (throttled(byCorpus) || throttled(byDoi)) {
    // Still rate limited after the retries: this says nothing about the identifiers.
    return t.skip('rate limited by Semantic Scholar')
  }
  assert.equal(byCorpus.status, 200, `${PROBE_PAPER_ID} did not resolve (HTTP ${byCorpus.status})`)
  assert.equal(byDoi.status, 200, `DOI:${PROBE_DOI} did not resolve (HTTP ${byDoi.status})`)

  const corpus = (await byCorpus.json()) as { paperId?: string }
  const doi = (await byDoi.json()) as { paperId?: string }
  t.diagnostic(`both resolve to paperId ${corpus.paperId}`)
  assert.equal(corpus.paperId, doi.paperId, 'the two identifiers must address one paper')
})

test('the authored User-Agent does not break a keyed request', async (t) => {
  const raw = await vaultKey()
  if (raw === null) return t.skip(SKIP_REASON)
  const key = normalizeApiKey(raw).key

  const withAgent = await pacedFetch(PROBE_PAPER_ID, 'citationCount', keyedHeaders(key))
  const withoutAgent = await pacedFetch(PROBE_PAPER_ID, 'citationCount', { 'x-api-key': key })

  t.diagnostic(`with User-Agent ${withAgent.status}, without ${withoutAgent.status}`)
  assert.notEqual(withAgent.status, 403, 'the authored User-Agent caused a rejection')
  assert.equal(
    withAgent.status === 403,
    withoutAgent.status === 403,
    'the User-Agent changed whether the key is accepted',
  )
})

test('the production client completes a keyed lookup without pausing the key', async (t) => {
  const raw = await vaultKey()
  if (raw === null) return t.skip(SKIP_REASON)

  const key = normalizeApiKey(raw).key
  const state = liveKeyState(key)
  const core = liveCore(state.access)
  // A DOI Semantic Scholar indexes, with a slash in the path — so this exercises
  // the identifier encoding, not just the transport.
  const identifiers: ItemIdentifier[] = [{ type: 'doi', id: PROBE_DOI, source: 'DOI' }]

  await pace()
  const result = await core.lookupSemanticScholarCount(identifiers)
  t.diagnostic(`lookup status ${result.status}${result.status === 'success' ? ` count ${result.count}` : ''}`)

  assert.deepEqual(state.rejected, [], 'a valid key must never be paused')
  assert.equal(state.paused, false)
  assert.notEqual(result.status, 'api_error', result.message ?? '')
  assert.notEqual(result.status, 'not_found', 'this DOI is indexed; not_found means the lookup path is wrong')
  if (result.status === 'success') {
    assert.ok(Number.isSafeInteger(result.count) && result.count >= 0)
  }
})
