export type GoalLifecycleStatus =
  | "draft"
  | "active"
  | "paused"
  | "blocked"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed"

export type GoalLifecycleAction = "start" | "pause" | "resume"

export function isGoalTerminal(status: GoalLifecycleStatus | string) {
  return status === "completed" || status === "cancelled" || status === "failed"
}

export function goalLifecycleAction(status: GoalLifecycleStatus | string): GoalLifecycleAction | undefined {
  if (status === "draft") return "start"
  if (status === "active") return "pause"
  if (status === "paused" || status === "blocked") return "resume"
  return undefined
}

/**
 * Manual criterion cycle used by the Goal popover. Completion is gated on every
 * criterion passing with evidence attached, so the UI has to be able to walk a
 * criterion all the way around without a separate menu.
 */
export function nextCriterionStatus(status: string) {
  if (status === "pending") return "passed" as const
  if (status === "passed") return "failed" as const
  return "pending" as const
}

export function goalProgress(input: {
  criteria: ReadonlyArray<{ status: string }>
  steps: ReadonlyArray<{ status: string }>
}) {
  const criteriaDone = input.criteria.reduce((count, item) => count + (item.status === "passed" ? 1 : 0), 0)
  const stepsDone = input.steps.reduce((count, item) => count + (item.status === "completed" ? 1 : 0), 0)
  const total = input.criteria.length + input.steps.length
  const done = criteriaDone + stepsDone
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

export function formatGoalElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds === 0) return "0s"
  const MINUTE = 60
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR
  const WEEK = 7 * DAY
  const MONTH = 30 * DAY
  let rest = totalSeconds
  const months = Math.floor(rest / MONTH)
  rest -= months * MONTH
  const weeks = Math.floor(rest / WEEK)
  rest -= weeks * WEEK
  const days = Math.floor(rest / DAY)
  rest -= days * DAY
  const hours = Math.floor(rest / HOUR)
  rest -= hours * HOUR
  const minutes = Math.floor(rest / MINUTE)
  rest -= minutes * MINUTE
  const seconds = rest
  const parts: string[] = []
  if (months) parts.push(`${months}mo`)
  if (weeks) parts.push(`${weeks}w`)
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  if (seconds) parts.push(`${seconds}s`)
  return parts.join(" ") || "0s"
}
