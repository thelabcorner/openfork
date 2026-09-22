export type ScheduledCalendarRange = "day" | "week" | "month"

export type ScheduledCalendarWindow = {
  readonly from: number
  readonly to: number
  readonly range: ScheduledCalendarRange
}

function localDate(value: number) {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function scheduledCalendarWindow(range: ScheduledCalendarRange, anchor: number): ScheduledCalendarWindow {
  const day = localDate(anchor)
  if (range === "day") {
    const end = new Date(day)
    end.setDate(end.getDate() + 1)
    return { from: day.getTime(), to: end.getTime(), range }
  }

  if (range === "week") {
    const start = new Date(day)
    const mondayOffset = (start.getDay() + 6) % 7
    start.setDate(start.getDate() - mondayOffset)
    const end = new Date(start)
    end.setDate(end.getDate() + 7)
    return { from: start.getTime(), to: end.getTime(), range }
  }

  const end = new Date(day)
  end.setDate(end.getDate() + 30)
  return { from: day.getTime(), to: end.getTime(), range }
}

export function shiftScheduledCalendarAnchor(range: ScheduledCalendarRange, anchor: number, direction: -1 | 1) {
  const value = localDate(anchor)
  if (range === "day") value.setDate(value.getDate() + direction)
  else if (range === "week") value.setDate(value.getDate() + direction * 7)
  else value.setDate(value.getDate() + direction * 30)
  return value.getTime()
}

export function scheduledCalendarDays(window: Pick<ScheduledCalendarWindow, "from" | "to">) {
  const days: number[] = []
  const cursor = localDate(window.from)
  while (cursor.getTime() < window.to) {
    days.push(cursor.getTime())
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

export function scheduledLocalDayKey(value: number) {
  const date = new Date(value)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function scheduledLocalHourKey(value: number) {
  const date = new Date(value)
  return `${scheduledLocalDayKey(value)}-${date.getHours()}`
}

export function scheduledMonthGrid(anchor: number) {
  const window = scheduledCalendarWindow("month", anchor)
  const days = scheduledCalendarDays(window)
  const leading = (new Date(window.from).getDay() + 6) % 7
  const cells: Array<number | undefined> = Array.from({ length: leading }, () => undefined)
  cells.push(...days)
  while (cells.length % 7 !== 0) cells.push(undefined)
  return cells
}

export type ScheduledTemporalCluster<T> = {
  readonly at: number
  readonly startAt: number
  readonly endAt: number
  readonly items: readonly T[]
}

/**
 * Deterministically groups nearby point-in-time calendar events so a narrow
 * secondary rail never produces overlapping interactive targets.
 *
 * Clustering is presentation-only: it preserves every underlying event and
 * never changes its authoritative timestamp. A new cluster starts once the
 * gap from the previous event exceeds `maxGapMs`.
 */
export function scheduledTemporalClusters<T>(
  items: readonly T[],
  timestamp: (item: T) => number,
  maxGapMs: number,
): ScheduledTemporalCluster<T>[] {
  if (items.length === 0) return []
  const gap = Math.max(0, Number.isFinite(maxGapMs) ? maxGapMs : 0)
  const sorted = items
    .map((item, index) => ({ item, index, at: timestamp(item) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((left, right) => left.at - right.at || left.index - right.index)

  const result: ScheduledTemporalCluster<T>[] = []
  let current: { startAt: number; endAt: number; items: T[] } | undefined

  for (const entry of sorted) {
    if (!current || entry.at - current.endAt > gap) {
      if (current) {
        result.push({
          at: current.startAt,
          startAt: current.startAt,
          endAt: current.endAt,
          items: current.items,
        })
      }
      current = { startAt: entry.at, endAt: entry.at, items: [entry.item] }
      continue
    }

    current.endAt = entry.at
    current.items.push(entry.item)
  }

  if (current) {
    result.push({
      at: current.startAt,
      startAt: current.startAt,
      endAt: current.endAt,
      items: current.items,
    })
  }
  return result
}

export function scheduledRunAttentionRank(input: { status: string; unread: boolean }) {
  if (input.unread && input.status === "waiting") return 0
  if (input.unread && (input.status === "failed" || input.status === "abandoned")) return 1
  if (input.unread) return 2
  if (input.status === "running") return 3
  return 4
}
