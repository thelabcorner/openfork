/**
 * Project the server's sparse active-day rows onto a real local calendar.
 * A heatmap cell is a calendar day, not the next active record in the list.
 * Advancing with Date.setDate preserves 23/25-hour DST calendar transitions.
 */
export type UsageCalendarDay = {
  start: number
  cost: number
  tokens: number
  messages: number
  sessions: number
}

const localStart = (timestamp: number) => {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function usageCalendarWindow(
  days: readonly UsageCalendarDay[],
  since: number,
  until: number,
  maxDays = 120,
): UsageCalendarDay[] {
  if (days.length === 0 || until <= since || maxDays <= 0) return []
  const active = new Map(days.map((day) => [day.start, day]))
  const first = since === 0 ? -Infinity : localStart(since)
  const cursor = new Date(until - 1)
  cursor.setHours(0, 0, 0, 0)
  const output: UsageCalendarDay[] = []
  for (let i = 0; i < maxDays && cursor.getTime() >= first; i++) {
    const start = cursor.getTime()
    output.push(active.get(start) ?? { start, cost: 0, tokens: 0, messages: 0, sessions: 0 })
    cursor.setDate(cursor.getDate() - 1)
  }
  return output.reverse()
}
