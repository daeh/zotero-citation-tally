/** Return `null` instead of throwing on unparseable input. */
export function parseLastCheckedInstant(value: string): Temporal.Instant | null {
  try {
    return Temporal.Instant.from(value)
  } catch {
    return null
  }
}

/** Parse the one- or two-digit month/day format accepted in citation stamps. */
export function parseCitationStampDate(value: string): Temporal.PlainDate | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim())
  if (!m) return null
  try {
    return Temporal.PlainDate.from(
      { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
      { overflow: 'reject' },
    )
  } catch {
    return null
  }
}

/** Parse Zotero's UTC SQL `dateAdded` value by converting it to ISO 8601 first. */
export function parseDateAddedInstant(value: string): Temporal.Instant | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const iso = `${trimmed.replace(' ', 'T')}Z`
  try {
    return Temporal.Instant.from(iso)
  } catch {
    return null
  }
}

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
}

/**
 * RFC 9110 §5.6.7: a two-digit year that appears to be more than 50 years in the
 * future is interpreted as the most recent past year with those two digits.
 */
function rollover2DigitYear(yy: number, nowYear: number): number {
  const century = Math.floor(nowYear / 100) * 100
  let year = century + yy
  if (year > nowYear + 50) year -= 100
  return year
}

/** Build a UTC `Instant` from validated components, normalizing a leap second. */
function buildUtcInstant(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Temporal.Instant | null {
  const month = MONTHS[monthName]
  if (month === undefined) return null
  // A legal HTTP leap second (`:60`) is normalized to `:59` + 1s, since
  // `Temporal` with `overflow: 'reject'` rejects second 60.
  let sec = second
  let addSecond = false
  if (sec === 60) {
    sec = 59
    addSecond = true
  }
  try {
    const zdt = Temporal.ZonedDateTime.from(
      { year, month, day, hour, minute, second: sec, timeZone: 'UTC' },
      { overflow: 'reject' },
    )
    const instant = zdt.toInstant()
    return addSecond ? instant.add({ seconds: 1 }) : instant
  } catch {
    return null
  }
}

/** Parse the three RFC 9110 HTTP-date forms. Returns `null` on any doubt. */
function parseHttpDate(value: string, nowYear: number): Temporal.Instant | null {
  // IMF-fixdate: "Sun, 06 Nov 1994 08:49:37 GMT"
  let m = /^[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value)
  if (m) return buildUtcInstant(Number(m[3]), m[2], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
  // RFC 850: "Sunday, 06-Nov-94 08:49:37 GMT"
  m = /^[A-Za-z]+, (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value)
  if (m) {
    const year = rollover2DigitYear(Number(m[3]), nowYear)
    return buildUtcInstant(year, m[2], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
  }
  // asctime: "Sun Nov  6 08:49:37 1994" (single-digit day is space-padded)
  m = /^[A-Za-z]{3} ([A-Za-z]{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value)
  if (m) return buildUtcInstant(Number(m[6]), m[1], Number(m[2].trim()), Number(m[3]), Number(m[4]), Number(m[5]))
  return null
}

/**
 * Parse delta-seconds or an RFC 9110 HTTP date into a nonnegative delay.
 * Return `null` for invalid values so the caller can use computed backoff.
 */
export function parseRetryAfterMs(headerValue: string, nowEpochMs: number): number | null {
  const v = headerValue.trim()
  if (v === '') return null
  if (/^\d+$/.test(v)) {
    const secs = Number(v)
    if (!Number.isSafeInteger(secs) || secs < 0) return null
    const ms = secs * 1000
    return Number.isSafeInteger(ms) ? ms : Number.MAX_SAFE_INTEGER
  }
  let nowYear: number
  try {
    nowYear = Temporal.Instant.fromEpochMilliseconds(nowEpochMs).toZonedDateTimeISO('UTC').year
  } catch {
    return null
  }
  const instant = parseHttpDate(v, nowYear)
  if (instant === null) return null
  const deltaMs = instant.epochMilliseconds - nowEpochMs
  if (!Number.isFinite(deltaMs)) return null
  return deltaMs <= 0 ? 0 : deltaMs
}
