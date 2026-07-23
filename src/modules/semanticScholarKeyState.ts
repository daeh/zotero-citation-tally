/**
 * API-key state transitions. Eligibility is generation-scoped, while each
 * key's rate-limit backoff remains in the client core across key changes.
 */
export interface KeyRef {
  key: string
  generation: number
}

export interface KeyState {
  keyGeneration: number
  /** Key rejected by HTTP 401/403 in its recorded generation. */
  rejection: KeyRef | null
  warnedFor: KeyRef | null
  pendingWarning: KeyRef | null
}

export function initialKeyState(): KeyState {
  return { keyGeneration: 0, rejection: null, warnedFor: null, pendingWarning: null }
}

function sameRef(a: KeyRef | null, b: KeyRef): boolean {
  return a !== null && a.key === b.key && a.generation === b.generation
}

export function isKeyUsable(state: KeyState, key: string): boolean {
  const r = state.rejection
  return !(r !== null && r.generation === state.keyGeneration && r.key === key)
}

export function isKeyedAttemptEligible(state: KeyState, ref: KeyRef): boolean {
  return ref.generation === state.keyGeneration && isKeyUsable(state, ref.key)
}

/** Ignore stale rejections; otherwise reject the key and decide whether to warn. */
export function applyRejection(state: KeyState, ref: KeyRef): { state: KeyState; shouldWarn: boolean } {
  if (ref.generation !== state.keyGeneration) {
    return { state, shouldWarn: false }
  }
  const alreadyWarned = sameRef(state.warnedFor, ref) || sameRef(state.pendingWarning, ref)
  return { state: { ...state, rejection: ref }, shouldWarn: !alreadyWarned }
}

export function markWarned(state: KeyState, ref: KeyRef): KeyState {
  return { ...state, warnedFor: ref, pendingWarning: null }
}

export function markPendingWarning(state: KeyState, ref: KeyRef): KeyState {
  return { ...state, pendingWarning: ref }
}

export function isRejectionCurrent(state: KeyState, ref: KeyRef): boolean {
  return ref.generation === state.keyGeneration && sameRef(state.rejection, ref)
}

/** Advance the generation and clear rejection state after a normalized key change. */
export function changeKey(state: KeyState): KeyState {
  return { keyGeneration: state.keyGeneration + 1, rejection: null, warnedFor: null, pendingWarning: null }
}
