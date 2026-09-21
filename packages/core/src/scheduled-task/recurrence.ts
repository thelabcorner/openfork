export * as ScheduledTaskRecurrence from "./recurrence"

import { DateTime, IANAZone } from "luxon"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"

/**
 * Pure recurrence engine. No database, no Effect services, no I/O, and no
 * `Date.now()`: `after` is always supplied by the caller. That is what makes
 * the deterministic clock harness possible and DST fixtures instant.
 *
 * Contract (02-scheduling-semantics.md § 2.2):
 *   1. pure;
 *   2. `nextOccurrence({ after: T }) > T` strictly;
 *   3. total — malformed input returns `undefined`, never throws;
 *   4. bounded search — a schedule with no occurrence within the horizon
 *      (`0 0 30 2 *`) returns `undefined` instead of spinning.
 */

const MINUTE = 60_000
const DAY = 86_400_000

/**
 * 4 years + leap day: covers `0 0 29 2 *` across a full leap cycle.
 * Exported for tests that assert the bound explicitly.
 */
export const SEARCH_HORIZON_DAYS = 1461

const MAX_DAILY_SCAN_DAYS = 7
const MAX_WEEKLY_SCAN_DAYS = 14

export interface Candidate {
  readonly instant: number
  /** The requested wall-clock time falls in a DST gap; fired at the boundary. */
  readonly shifted: boolean
  /** The requested wall-clock time occurs twice; the first instant wins. */
  readonly ambiguous: boolean
}

export interface NextOccurrenceInput {
  readonly schedule: ScheduledTask.Schedule
  /** IANA zone id. `undefined` resolves the host zone at every computation. */
  readonly timezone: string | undefined
  /** Epoch millis, exclusive lower bound. */
  readonly after: number
}

export type Validation = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export type ScheduleInputResolution =
  | { readonly ok: true; readonly schedule: ScheduledTask.Schedule }
  | { readonly ok: false; readonly reason: string }

/**
 * Normalize boundary-friendly timing input into durable scheduler truth.
 * Relative input is resolved exactly once against the caller's captured `now`.
 */
export function resolveScheduleInput(input: ScheduledTask.ScheduleInput, now: number): ScheduleInputResolution {
  if (!Number.isFinite(now)) return { ok: false, reason: "schedule resolution requires a finite current timestamp" }
  switch (input.kind) {
    case "relative": {
      if (!Number.isFinite(input.delayMs) || input.delayMs <= 0) {
        return { ok: false, reason: "relative.delayMs must be a positive finite duration" }
      }
      const at = now + input.delayMs
      if (!Number.isFinite(at) || at <= now) {
        return { ok: false, reason: "relative.delayMs resolves outside the supported timestamp range" }
      }
      return { ok: true, schedule: { kind: "once", at } }
    }
    case "timestamp":
      return { ok: true, schedule: { kind: "once", at: input.at } }
    case "recurring":
      return { ok: true, schedule: input.schedule }
    default:
      return { ok: true, schedule: input }
  }
}

export function nextOccurrence(input: NextOccurrenceInput): number | undefined {
  return nextCandidate(input)?.instant
}

export function nextCandidate(input: NextOccurrenceInput): Candidate | undefined {
  try {
    if (!Number.isFinite(input.after)) return undefined
    const zone = resolveZone(input.timezone)
    if (!zone) return undefined
    return candidateFor(zone, input.schedule, input.after)
  } catch {
    // Property 3: a parse/zone failure inside the scan loop must never stall
    // every other task. Invalid input simply has no next occurrence.
    return undefined
  }
}

export function occurrencesBetween(input: {
  readonly schedule: ScheduledTask.Schedule
  readonly timezone: string | undefined
  /** Inclusive lower bound. */
  readonly from: number
  /** Inclusive upper bound. */
  readonly to: number
  readonly limit: number
}): ReadonlyArray<number> {
  if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.limit <= 0) return []
  if (input.to < input.from) return []
  try {
    const zone = resolveZone(input.timezone)
    if (!zone) return []
    switch (input.schedule.kind) {
      case "once":
        return input.schedule.at >= input.from && input.schedule.at <= input.to ? [input.schedule.at].slice(0, input.limit) : []
      case "daily":
        return occurrencesFromLocalDaysBetween(zone, input.from, input.to, input.limit, input.schedule.times, undefined)
      case "weekly":
        return occurrencesFromLocalDaysBetween(
          zone,
          input.from,
          input.to,
          input.limit,
          input.schedule.times,
          new Set(input.schedule.weekdays),
        )
      case "cron": {
        const fields = parseCron(input.schedule.expression)
        if (!fields) return []
        return occurrencesFromCronBetween(zone, input.from, input.to, input.limit, fields)
      }
    }
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Zone helpers
// ---------------------------------------------------------------------------

export function resolveZone(timezone: string | undefined): string | undefined {
  const explicit = timezone?.trim()
  if (explicit) return IANAZone.isValidZone(explicit) ? explicit : undefined
  // Point 2 of 02 § 3.1: resolve the host zone at every computation rather
  // than snapshotting it at create time.
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (host && IANAZone.isValidZone(host)) return host
  return "UTC"
}

function localParts(zone: string, instant: number) {
  const value = DateTime.fromMillis(instant, { zone })
  return { year: value.year, month: value.month, day: value.day, hour: value.hour, minute: value.minute }
}

function wallValue(parts: { year: number; month: number; day: number; hour: number; minute: number }) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

function offsetAt(zone: string, instant: number) {
  return DateTime.fromMillis(instant, { zone }).offset
}

/**
 * Resolve one local wall-clock time in a zone to its canonical instant.
 *
 * - Normal time -> the single valid instant.
 * - Ambiguous time (fall-back) -> the FIRST valid instant (02 § 3.2 Case B).
 * - Nonexistent time (spring-forward gap) -> the gap boundary, i.e. the first
 *   instant whose local wall clock is at or after the requested time
 *   (02 § 3.2 Case A).
 */
function resolveLocal(
  zone: string,
  target: { year: number; month: number; day: number; hour: number; minute: number },
): Candidate | undefined {
  const utcGuess = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute)
  // Sample offsets around the target instant (transitions are always local
  // perturbations; ±1 day brackets both sides of an overlap or gap), then
  // refine each sampled offset through its own instant. This finds BOTH
  // instants of an ambiguous time, which the naive two-probe algorithm misses.
  const offsets = new Set<number>()
  for (const probe of [utcGuess - DAY, utcGuess, utcGuess + DAY]) offsets.add(offsetAt(zone, probe))
  for (const offset of [...offsets]) offsets.add(offsetAt(zone, utcGuess - offset * MINUTE))
  const candidates = [...offsets].map((offset) => utcGuess - offset * MINUTE)
  const targetWall = wallValue(target)
  const valid = [...new Set(candidates)]
    .filter((instant) => wallValue(localParts(zone, instant)) === targetWall)
    .sort((left, right) => left - right)
  if (valid.length > 0) {
    return { instant: valid[0]!, shifted: false, ambiguous: valid.length > 1 }
  }

  // Gap: binary search the first instant whose local wall clock is >= target.
  let low = Math.min(...candidates)
  let high = Math.max(...candidates)
  for (let step = 0; step < 4 && wallValue(localParts(zone, low)) >= targetWall; step++) low -= DAY
  for (let step = 0; step < 4 && wallValue(localParts(zone, high)) < targetWall; step++) high += DAY
  if (!(wallValue(localParts(zone, low)) < targetWall && wallValue(localParts(zone, high)) >= targetWall)) {
    return undefined
  }
  while (high - low > MINUTE) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE
    if (middle <= low) break
    if (wallValue(localParts(zone, middle)) >= targetWall) high = middle
    else low = middle
  }
  return { instant: high, shifted: true, ambiguous: false }
}

// ---------------------------------------------------------------------------
// Schedule evaluation
// ---------------------------------------------------------------------------

function candidateFor(zone: string, schedule: ScheduledTask.Schedule, after: number): Candidate | undefined {
  switch (schedule.kind) {
    case "once": {
      if (!Number.isFinite(schedule.at)) return undefined
      return schedule.at > after ? { instant: schedule.at, shifted: false, ambiguous: false } : undefined
    }
    case "daily":
      return nextFromLocalDays(zone, after, MAX_DAILY_SCAN_DAYS, schedule.times, undefined)
    case "weekly":
      return nextFromLocalDays(zone, after, MAX_WEEKLY_SCAN_DAYS, schedule.times, new Set(schedule.weekdays))
    case "cron": {
      const fields = parseCron(schedule.expression)
      if (!fields) return undefined
      return nextFromCron(zone, after, fields)
    }
  }
}

function nextFromLocalDays(
  zone: string,
  after: number,
  horizonDays: number,
  times: ReadonlyArray<ScheduledTask.TimeOfDay>,
  weekdays: ReadonlySet<number> | undefined,
): Candidate | undefined {
  if (times.length === 0) return undefined
  const ordered = [...times].sort((left, right) => left.hour * 60 + left.minute - (right.hour * 60 + right.minute))
  const start = DateTime.fromMillis(after, { zone }).startOf("day")
  for (let offset = 0; offset <= horizonDays; offset++) {
    const day = start.plus({ days: offset })
    if (weekdays && !weekdays.has(day.weekday % 7)) continue
    for (const time of ordered) {
      const resolved = resolveLocal(zone, {
        year: day.year,
        month: day.month,
        day: day.day,
        hour: time.hour,
        minute: time.minute,
      })
      if (resolved && resolved.instant > after) return resolved
    }
  }
  return undefined
}

function occurrencesFromLocalDaysBetween(
  zone: string,
  from: number,
  to: number,
  limit: number,
  times: ReadonlyArray<ScheduledTask.TimeOfDay>,
  weekdays: ReadonlySet<number> | undefined,
): ReadonlyArray<number> {
  if (times.length === 0 || limit <= 0) return []
  const result: number[] = []
  const seen = new Set<number>()
  const ordered = [...times].sort((left, right) => left.hour * 60 + left.minute - (right.hour * 60 + right.minute))
  let day = DateTime.fromMillis(from, { zone }).startOf("day")
  const end = DateTime.fromMillis(to, { zone }).startOf("day")
  while (day.isValid && end.isValid && day.toMillis() <= end.toMillis()) {
    if (!weekdays || weekdays.has(day.weekday % 7)) {
      for (const time of ordered) {
        const resolved = resolveLocal(zone, {
          year: day.year,
          month: day.month,
          day: day.day,
          hour: time.hour,
          minute: time.minute,
        })
        if (!resolved || resolved.instant < from || resolved.instant > to || seen.has(resolved.instant)) continue
        seen.add(resolved.instant)
        result.push(resolved.instant)
        if (result.length >= limit) return result
      }
    }
    day = day.plus({ days: 1 })
  }
  return result
}

function cronDayMatches(fields: CronFields, day: DateTime) {
  if (!fields.months.has(day.month)) return false
  const domMatch = fields.doms.has(day.day)
  const dowMatch = fields.dows.has(day.weekday % 7)
  return fields.domRestricted && fields.dowRestricted ? domMatch || dowMatch : domMatch && dowMatch
}

function occurrencesFromCronBetween(
  zone: string,
  from: number,
  to: number,
  limit: number,
  fields: CronFields,
): ReadonlyArray<number> {
  const result: number[] = []
  const seen = new Set<number>()
  let day = DateTime.fromMillis(from, { zone }).startOf("day")
  const end = DateTime.fromMillis(to, { zone }).startOf("day")
  while (day.isValid && end.isValid && day.toMillis() <= end.toMillis()) {
    if (cronDayMatches(fields, day)) {
      for (const hour of fields.hours) {
        for (const minute of fields.minutes) {
          const resolved = resolveLocal(zone, {
            year: day.year,
            month: day.month,
            day: day.day,
            hour,
            minute,
          })
          if (!resolved || resolved.instant < from || resolved.instant > to || seen.has(resolved.instant)) continue
          seen.add(resolved.instant)
          result.push(resolved.instant)
          if (result.length >= limit) return result
        }
      }
    }
    day = day.plus({ days: 1 })
  }
  return result
}

function nextFromCron(zone: string, after: number, fields: CronFields): Candidate | undefined {
  const afterLocal = DateTime.fromMillis(after, { zone })
  const start = afterLocal.startOf("day")
  const afterWallMinutes = afterLocal.hour * 60 + afterLocal.minute
  for (let offset = 0; offset <= SEARCH_HORIZON_DAYS; offset++) {
    const day = start.plus({ days: offset })
    if (!cronDayMatches(fields, day)) continue
    for (const hour of fields.hours) {
      for (const minute of fields.minutes) {
        // On the starting day, later candidates than `after` cannot precede it;
        // skipping certain-loser pairs keeps `* * * * *` to one resolve.
        if (offset === 0 && hour * 60 + minute <= afterWallMinutes) continue
        const resolved = resolveLocal(zone, {
          year: day.year,
          month: day.month,
          day: day.day,
          hour,
          minute,
        })
        if (resolved && resolved.instant > after) return resolved
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Cron parsing (5-field standard; 02 § 2.3 rejections enforced)
// ---------------------------------------------------------------------------

interface CronFields {
  readonly minutes: ReadonlyArray<number>
  readonly hours: ReadonlyArray<number>
  readonly doms: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly dows: ReadonlySet<number>
  readonly domRestricted: boolean
  readonly dowRestricted: boolean
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
}

const DAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}

export function parseCron(expression: string): CronFields | undefined {
  const trimmed = expression.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith("@")) return undefined
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return undefined
  const minutes = parseField(parts[0]!, 0, 59, undefined)
  const hours = parseField(parts[1]!, 0, 23, undefined)
  const doms = parseField(parts[2]!, 1, 31, undefined)
  const months = parseField(parts[3]!, 1, 12, MONTH_NAMES)
  const dows = parseField(parts[4]!, 0, 7, DAY_NAMES)
  if (!minutes || !hours || !doms || !months || !dows) return undefined
  return {
    minutes: minutes.values,
    hours: hours.values,
    doms: new Set(doms.values),
    months: new Set(months.values),
    dows: new Set(dows.values.map((value) => (value === 7 ? 0 : value))),
    domRestricted: !doms.full,
    dowRestricted: !dows.full,
  }
}

function parseField(
  field: string,
  minimum: number,
  maximum: number,
  names: Record<string, number> | undefined,
): { values: number[]; full: boolean } | undefined {
  const values = new Set<number>()
  let sawFullRange = true
  for (const term of field.split(",")) {
    if (term === "") return undefined
    const [rangeText, stepText, ...rest] = term.split("/")
    if (rest.length > 0) return undefined
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return undefined
      step = Number(stepText)
      if (step <= 0) return undefined
      sawFullRange = false
    }
    let start: number
    let end: number
    if (rangeText === "*") {
      start = minimum
      end = maximum
    } else if (rangeText!.includes("-")) {
      const [left, right, ...extra] = rangeText!.split("-")
      if (extra.length > 0) return undefined
      const parsedLeft = parseValue(left!, names)
      const parsedRight = parseValue(right!, names)
      if (parsedLeft === undefined || parsedRight === undefined) return undefined
      start = parsedLeft
      end = parsedRight
      if (start > end) return undefined
      sawFullRange = false
    } else {
      const parsed = parseValue(rangeText!, names)
      if (parsed === undefined) return undefined
      start = parsed
      end = stepText === undefined ? parsed : maximum
      if (stepText === undefined) sawFullRange = false
    }
    if (start < minimum || end > maximum) return undefined
    for (let value = start; value <= end; value += step) values.add(value)
  }
  if (values.size === 0) return undefined
  // A field is "unrestricted" only when its expansion covers the whole domain,
  // so `*` and `*/1` behave identically for the DOM/DOW OR rule.
  const full = values.size === maximum - minimum + 1
  if (full) sawFullRange = true
  return { values: [...values].sort((left, right) => left - right), full: sawFullRange && full }
}

function parseValue(text: string, names: Record<string, number> | undefined): number | undefined {
  if (/^\d+$/.test(text)) return Number(text)
  const named = names?.[text.toUpperCase()]
  return named
}

// ---------------------------------------------------------------------------
// Validation and description (server-owned; the client never parses schedules)
// ---------------------------------------------------------------------------

export function validateSchedule(
  schedule: ScheduledTask.Schedule,
  options?: { readonly now?: number; readonly timezone?: string },
): Validation {
  if (options?.timezone?.trim() && !IANAZone.isValidZone(options.timezone.trim())) {
    return { ok: false, reason: `unknown IANA timezone: ${options.timezone}` }
  }
  switch (schedule.kind) {
    case "once": {
      if (!Number.isFinite(schedule.at)) return { ok: false, reason: "once.at must be a finite epoch millis value" }
      if (options?.now !== undefined && schedule.at <= options.now) {
        return { ok: false, reason: "once.at is in the past" }
      }
      return { ok: true }
    }
    case "daily": {
      if (schedule.times.length === 0) return { ok: false, reason: "daily schedule needs at least one time" }
      if (schedule.times.length > 24) return { ok: false, reason: "daily schedule supports at most 24 times" }
      return duplicateTimes(schedule.times)
    }
    case "weekly": {
      if (schedule.weekdays.length === 0) return { ok: false, reason: "weekly schedule needs at least one weekday" }
      if (schedule.times.length === 0) return { ok: false, reason: "weekly schedule needs at least one time" }
      if (new Set(schedule.weekdays).size !== schedule.weekdays.length) {
        return { ok: false, reason: "weekly schedule has duplicate weekdays" }
      }
      return duplicateTimes(schedule.times)
    }
    case "cron": {
      const expression = schedule.expression.trim()
      if (!expression) return { ok: false, reason: "cron expression is empty" }
      if (expression.startsWith("@")) {
        return { ok: false, reason: "@-directives such as @reboot are not time schedules and are rejected" }
      }
      if (expression.split(/\s+/).length === 6) {
        return { ok: false, reason: "6-field cron with a seconds field is rejected; the minimum interval is one minute" }
      }
      if (/[LW#]/i.test(expression)) {
        return { ok: false, reason: "L/W/# cron extensions are not supported" }
      }
      const parsed = parseCron(expression)
      if (!parsed) return { ok: false, reason: `invalid cron expression: ${expression}` }
      // A bounded search catches schedules that can never match (`0 0 30 2 *`).
      if (nextOccurrence({ schedule, timezone: options?.timezone, after: Date.UTC(2026, 0, 1) }) === undefined) {
        return { ok: false, reason: `cron expression never matches: ${expression}` }
      }
      return { ok: true }
    }
  }
}

function duplicateTimes(times: ReadonlyArray<ScheduledTask.TimeOfDay>): Validation {
  const seen = new Set<string>()
  for (const time of times) {
    const key = `${time.hour}:${time.minute}`
    if (seen.has(key)) return { ok: false, reason: `duplicate time: ${formatTime(time.hour, time.minute)}` }
    seen.add(key)
  }
  return { ok: true }
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

function formatTime(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

/** Human summary for the editor and preview. Server-owned; no client parsing. */
export function describeSchedule(schedule: ScheduledTask.Schedule): string {
  switch (schedule.kind) {
    case "once":
      return `once at ${new Date(schedule.at).toISOString()}`
    case "daily": {
      const times = [...schedule.times]
        .sort((left, right) => left.hour * 60 + left.minute - (right.hour * 60 + right.minute))
        .map((time) => formatTime(time.hour, time.minute))
      return `daily at ${times.join(", ")}`
    }
    case "weekly": {
      const days = [...schedule.weekdays]
        .sort((left, right) => left - right)
        .map((day) => WEEKDAY_NAMES[day]!)
      const times = [...schedule.times]
        .sort((left, right) => left.hour * 60 + left.minute - (right.hour * 60 + right.minute))
        .map((time) => formatTime(time.hour, time.minute))
      return `weekly on ${days.join(", ")} at ${times.join(", ")}`
    }
    case "cron":
      return `cron ${schedule.expression.trim()}`
  }
}

export interface PreviewInput {
  readonly schedule: ScheduledTask.Schedule
  readonly timezone: string | undefined
  readonly after: number
  readonly count?: number
}

/**
 * Next instants plus human-readable DST warnings. One implementation feeds the
 * HTTP preview endpoint, catch-up, and tests (04 § 1.1).
 */
export function preview(input: PreviewInput): { next: number[]; warnings: string[] } {
  const count = input.count ?? 5
  const next: number[] = []
  const warnings: string[] = []
  const warned = new Set<string>()
  let cursor = input.after
  for (let index = 0; index < count; index++) {
    const candidate = nextCandidate({ schedule: input.schedule, timezone: input.timezone, after: cursor })
    if (!candidate) break
    next.push(candidate.instant)
    cursor = candidate.instant
    if (candidate.shifted || candidate.ambiguous) {
      const zone = resolveZone(input.timezone)!
      const local = DateTime.fromMillis(candidate.instant, { zone }).toFormat("yyyy-MM-dd HH:mm")
      const reason = candidate.shifted
        ? "requested local time does not exist (DST spring-forward); firing at the gap boundary"
        : "requested local time occurs twice (DST fall-back); firing only at the first occurrence"
      const key = `${candidate.shifted ? "gap" : "overlap"}:${local}`
      if (!warned.has(key)) {
        warned.add(key)
        warnings.push(`${local} (${zone}): ${reason}`)
      }
    }
  }
  return { next, warnings }
}

/** Deterministic per-(task, fireFor) jitter; two processes always agree. */
export function jitterFor(taskID: string, fireFor: number, jitterMs: number): number {
  if (!Number.isFinite(jitterMs) || jitterMs <= 0) return 0
  let hash = 2166136261
  const input = `${taskID}:${fireFor}`
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.floor((hash >>> 0) % (Math.floor(jitterMs) + 1))
}
