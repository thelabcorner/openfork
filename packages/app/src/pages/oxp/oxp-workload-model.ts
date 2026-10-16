import type { IconProps } from "@opencode-ai/ui/icon"
import type { OxpWorkloadMetrics } from "./oxp-workload-panel"

/**
 * Presentation model for the OXP workload inspector.
 *
 * Pure by design so the leaderboard's icon/label mapping, failure-rate
 * denominator and ranking are testable without a renderer. Everything here
 * reads the already-materialized per-tool scalar profile — never an invocation
 * transcript — which is what keeps the inspector fetch-free.
 */

export type WorkloadRank = "calls" | "failures" | "failureRate" | "toolWallMs" | "p95Ms"
export type WorkloadBoard = "volume" | "failures" | "time"

/**
 * Tool name → icon, reusing the transcript's family vocabulary so a column of
 * workload rows scans like a column of OXP invocation rows. Unknown tools fall
 * back to the same generic mark the transcript uses.
 */
export function workloadIcon(tool: string): IconProps["name"] {
  switch (tool) {
    case "read":
      return "glasses"
    case "find":
      return "magnifying-glass-menu"
    case "edit":
    case "write":
    case "patch":
      return "code-lines"
    case "process":
      return "console"
    case "git":
      return "branch"
    case "openfork_worker":
      return "subagent"
    case "openfork_session":
      return "speech-bubble"
    case "openfork_request":
      return "bubble-5"
    case "openfork_info":
      return "status"
    case "openai_files":
      return "cloud-upload"
    case "capability":
      return "mcp"
    default:
      return "mcp"
  }
}

/** Humanized leaderboard label; unknown tool names degrade to title case. */
export function workloadLabel(tool: string) {
  return tool
    .replace(/^openfork_/, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

/** The failure-rate denominator: settled = successes + failures. */
export function settledCalls(metrics: OxpWorkloadMetrics) {
  return metrics.successes + metrics.failures
}

/**
 * Mirrors the server's failure-rate semantics: `failed / (failed + succeeded)`,
 * null when nothing has settled. Denial, cancellation, interruption, running
 * and unknown never enter the denominator.
 */
export function failureRateOf(metrics: OxpWorkloadMetrics): number | null {
  const settled = settledCalls(metrics)
  return settled > 0 ? metrics.failures / settled : null
}

/** Null-safe scalar for a rank column; withheld percentiles rank last. */
export function rankValue(metrics: OxpWorkloadMetrics, rank: WorkloadRank): number {
  switch (rank) {
    case "calls":
      return metrics.calls
    case "failures":
      return metrics.failures
    case "toolWallMs":
      return metrics.toolWallMs
    case "p95Ms":
      return metrics.p95Ms ?? -1
    case "failureRate":
      return failureRateOf(metrics) ?? -1
  }
}

/** Descending sort on the selected rank, tool name as a deterministic tiebreak. */
export function rankTools<T extends OxpWorkloadMetrics & { tool: string }>(
  rows: readonly T[],
  rank: WorkloadRank,
): T[] {
  return rows.slice().sort((left, right) => {
    const diff = rankValue(right, rank) - rankValue(left, rank)
    return diff || left.tool.localeCompare(right.tool)
  })
}
