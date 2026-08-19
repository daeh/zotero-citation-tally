/**
 * Per-service request pacing.
 *
 * The previous implementation read the last-request timestamp, awaited, and
 * only then wrote the new one:
 *
 *     const last = lastRequestTime[db]
 *     if (now - last < delay) await sleep(delay - (now - last))
 *     lastRequestTime[db] = now()
 *
 * Two callers reaching it together read the same timestamp, slept the same
 * interval, and issued their requests simultaneously -- so the configured rate
 * limit bounded nothing. That is reachable in normal use, because the manual
 * queue and the automatic queue both drive `updateItem` independently.
 *
 * `reserveSlot` fixes it by allocating the next departure time *before* the
 * caller awaits, so concurrent callers queue behind one another.
 *
 * Keep this module free of runtime Zotero dependencies.
 */

export interface SlotReservation {
  /** How long this caller must wait before issuing its request. */
  waitMs: number
  /** The state to store back; the earliest time the *next* caller may depart. */
  nextAvailableMs: number
}

/**
 * Claim the next departure slot for a service.
 *
 * @param nextAvailableMs the previously reserved value, or `undefined` on the
 *   first request -- which departs immediately rather than waiting one full
 *   interval.
 * @param nowMs a monotonic clock reading.
 * @param delayMs the minimum spacing between departures.
 */
export function reserveSlot(nextAvailableMs: number | undefined, nowMs: number, delayMs: number): SlotReservation {
  const spacing = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0
  // An unset or stale reservation means the service is idle: depart now.
  const departAt = nextAvailableMs === undefined ? nowMs : Math.max(nowMs, nextAvailableMs)
  return { waitMs: departAt - nowMs, nextAvailableMs: departAt + spacing }
}
