import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyRejection,
  changeKey,
  initialKeyState,
  isKeyedAttemptEligible,
  isKeyUsable,
  markWarned,
} from '../src/modules/semanticScholarKeyState.ts'

test('A→B→A re-enables A (rejection is generation-scoped)', () => {
  let s = initialKeyState()
  s = applyRejection(s, { key: 'A', generation: 0 }).state
  assert.equal(isKeyUsable(s, 'A'), false)
  s = changeKey(s)
  assert.equal(isKeyUsable(s, 'A'), true)
  assert.equal(isKeyUsable(s, 'B'), true)
  s = changeKey(s)
  assert.equal(isKeyUsable(s, 'A'), true)
})

test('a stale rejection neither disables the current key nor warns', () => {
  const s = changeKey(initialKeyState())
  const r = applyRejection(s, { key: 'A', generation: 0 })
  assert.equal(r.shouldWarn, false)
  assert.equal(isKeyUsable(r.state, 'A'), true)
})

test('warn only once per rejection', () => {
  let s = initialKeyState()
  const first = applyRejection(s, { key: 'A', generation: 0 })
  assert.equal(first.shouldWarn, true)
  s = markWarned(first.state, { key: 'A', generation: 0 })
  assert.equal(applyRejection(s, { key: 'A', generation: 0 }).shouldWarn, false)
})

test('eligibility requires the current generation and a usable key', () => {
  let s = initialKeyState()
  assert.equal(isKeyedAttemptEligible(s, { key: 'A', generation: 0 }), true)
  assert.equal(isKeyedAttemptEligible(s, { key: 'A', generation: 5 }), false)
  s = applyRejection(s, { key: 'A', generation: 0 }).state
  assert.equal(isKeyedAttemptEligible(s, { key: 'A', generation: 0 }), false)
})
