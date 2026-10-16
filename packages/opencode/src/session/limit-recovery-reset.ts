/** Failure-local Retry-After parsing shared by retry UX and durable recovery. */
const MONTH = new Map(
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((value, index) => [
    value,
    index,
  ]),
)
const DAY = new Map(
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((value, index) => [value, index]),
)
const LONG_DAY = new Map(
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((value, index) => [
    value,
    index,
  ]),
)

function utcDate(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
  weekday: number | undefined,
) {
  const month = MONTH.get(monthName)
  if (
    month === undefined ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 60
  )
    return undefined

  // ECMAScript has no leap-second representation. Validate the civil date at
  // :59, then represent :60 as the immediately following millisecond instant.
  const baseSecond = Math.min(second, 59)
  const base = Date.UTC(year, month, day, hour, minute, baseSecond)
  if (!Number.isSafeInteger(base) || base < 0) return undefined
  const date = new Date(base)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== baseSecond ||
    (weekday !== undefined && date.getUTCDay() !== weekday)
  )
    return undefined
  const at = base + (second === 60 ? 1000 : 0)
  return Number.isSafeInteger(at) ? at : undefined
}

/** RFC 9110 HTTP-date parser: IMF-fixdate plus both required obsolete forms, always UTC. */
function httpDate(value: string, now: number) {
  let match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
    value,
  )
  if (match) {
    return utcDate(
      Number(match[4]),
      match[3]!,
      Number(match[2]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7]),
      DAY.get(match[1]!),
    )
  }

  match =
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value,
    )
  if (match) {
    const currentYear = new Date(now).getUTCFullYear()
    let year = Math.floor(currentYear / 100) * 100 + Number(match[4])
    if (year > currentYear + 50) year -= 100
    return utcDate(
      year,
      match[3]!,
      Number(match[2]),
      Number(match[5]),
      Number(match[6]),
      Number(match[7]),
      LONG_DAY.get(match[1]!),
    )
  }

  match =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:([0-9]{2})| ([0-9])) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
      value,
    )
  if (!match) return undefined
  return utcDate(
    Number(match[8]),
    match[2]!,
    Number(match[3] ?? match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
    DAY.get(match[1]!),
  )
}

export function retryAfterAt(headers: Record<string, string> | undefined, now = Date.now()) {
  if (!headers || !Number.isSafeInteger(now) || now < 0) return undefined
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after-ms")?.[1]?.trim()
  if (value !== undefined) {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return undefined
    const at = now + Math.ceil(Number(value))
    return Number.isSafeInteger(at) ? at : undefined
  }

  const retryAfter = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1]?.trim()
  if (!retryAfter) return undefined
  // RFC 9110 delay-seconds = 1*DIGIT. Decimal values are not authoritative
  // Retry-After evidence and must not arm unattended continuation.
  if (/^\d+$/.test(retryAfter)) {
    const at = now + Number(retryAfter) * 1000
    return Number.isSafeInteger(at) ? at : undefined
  }
  return httpDate(retryAfter, now)
}

export * as LimitRecoveryReset from "./limit-recovery-reset"
