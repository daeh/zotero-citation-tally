function requiredDaysFor(count: number): number | null {
  if (count === 1) return 7
  if (count === 2) return 30
  if (count === 3) return 90
  if (count > 3) return 180
  return null // Retry immediately for zero or invalid counts.
}

/** Return true when a failure is old enough to retry; retry missing or invalid timestamps immediately. */
export function retryAgeExceeded(count: number, lastChecked: Temporal.Instant | null, now: Temporal.Instant): boolean {
  if (lastChecked === null) return true
  const requiredDays = requiredDaysFor(count)
  if (requiredDays === null) return true
  const daysElapsed = now.since(lastChecked).total({ unit: 'day' })
  return daysElapsed > requiredDays
}
