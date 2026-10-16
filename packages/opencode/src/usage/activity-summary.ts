/**
 * Exact activity facts over the entire requested window, independent of the
 * bounded calendar heatmap payload. Rows are chronological active local days.
 *
 * A local calendar successor is NOT necessarily 86,400,000 milliseconds
 * later (DST, historical offset reforms, entire skipped civil dates).
 */
export type UsageActivityDay = { readonly start: number; readonly messages: number }

export type UsageActivitySummary = {
  activeDays: number
  longestStreak: number
  busiestDay: { start: number; messages: number } | null
}

export function summarizeUsageActivity(days: Iterable<UsageActivityDay>): UsageActivitySummary {
  let activeDays = 0
  let longestStreak = 0
  let streak = 0
  let previous: number | undefined
  let busiestDay: UsageActivitySummary["busiestDay"] = null

  for (const day of days) {
    if (day.messages <= 0) continue
    activeDays++
    if (previous === undefined) streak = 1
    else {
      const next = new Date(previous)
      next.setDate(next.getDate() + 1)
      next.setHours(0, 0, 0, 0)
      streak = next.getTime() === day.start ? streak + 1 : 1
    }
    if (streak > longestStreak) longestStreak = streak
    // Chronologically earliest busiest day wins on equal message counts.
    if (!busiestDay || day.messages > busiestDay.messages) {
      busiestDay = { start: day.start, messages: day.messages }
    }
    previous = day.start
  }
  return { activeDays, longestStreak, busiestDay }
}
