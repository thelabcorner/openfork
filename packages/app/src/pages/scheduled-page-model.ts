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

export function scheduledRunAttentionRank(input: { status: string; unread: boolean }) {
  if (input.unread && input.status === "waiting") return 0
  if (input.unread && (input.status === "failed" || input.status === "abandoned")) return 1
  if (input.unread) return 2
  if (input.status === "running") return 3
  return 4
}
