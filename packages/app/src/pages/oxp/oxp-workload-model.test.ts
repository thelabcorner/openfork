import { describe, expect, test } from "bun:test"
import type { OxpWorkloadMetrics } from "./oxp-workload-panel"
import {
  failureRateOf,
  rankTools,
  rankValue,
  settledCalls,
  workloadIcon,
  workloadLabel,
  type WorkloadRank,
} from "./oxp-workload-model"

function metrics(over: Partial<OxpWorkloadMetrics> = {}): OxpWorkloadMetrics {
  return {
    calls: 0,
    successes: 0,
    failures: 0,
    denied: 0,
    cancelled: 0,
    interrupted: 0,
    running: 0,
    unknown: 0,
    failureRate: null,
    measuredDurations: 0,
    missingDurations: 0,
    toolWallMs: 0,
    p50Ms: null,
    p95Ms: null,
    ...over,
  }
}

function row(tool: string, over: Partial<OxpWorkloadMetrics> = {}) {
  return { tool, ...metrics(over) }
}

describe("tool icon mapping", () => {
  test("families reuse the transcript's vocabulary", () => {
    expect(workloadIcon("read")).toBe("glasses")
    expect(workloadIcon("find")).toBe("magnifying-glass-menu")
    expect(workloadIcon("edit")).toBe("code-lines")
    expect(workloadIcon("write")).toBe("code-lines")
    expect(workloadIcon("patch")).toBe("code-lines")
    expect(workloadIcon("process")).toBe("console")
    expect(workloadIcon("git")).toBe("branch")
    expect(workloadIcon("openfork_worker")).toBe("subagent")
    expect(workloadIcon("openfork_session")).toBe("speech-bubble")
    expect(workloadIcon("openfork_request")).toBe("bubble-5")
    expect(workloadIcon("openfork_info")).toBe("status")
    expect(workloadIcon("openai_files")).toBe("cloud-upload")
    expect(workloadIcon("capability")).toBe("mcp")
  })

  test("unknown tools fall back to the generic mark", () => {
    expect(workloadIcon("openfork_mystery_thing")).toBe("mcp")
    expect(workloadIcon("")).toBe("mcp")
  })
})

describe("tool label", () => {
  test("strips the openfork prefix and title-cases", () => {
    expect(workloadLabel("openfork_worker")).toBe("Worker")
    expect(workloadLabel("openai_files")).toBe("Openai Files")
    expect(workloadLabel("read")).toBe("Read")
  })
})

describe("failure rate", () => {
  test("null when nothing has settled", () => {
    expect(failureRateOf(metrics({ calls: 3, denied: 2, running: 1 }))).toBeNull()
  })

  test("denial, cancellation and running never enter the denominator", () => {
    const value = metrics({ calls: 5, successes: 3, failures: 1, denied: 1, running: 1 })
    expect(settledCalls(value)).toBe(4)
    expect(failureRateOf(value)).toBeCloseTo(0.25)
  })

  test("a fully failing cohort is 100%, not null", () => {
    expect(failureRateOf(metrics({ successes: 0, failures: 7 }))).toBe(1)
  })
})

describe("ranking", () => {
  const rows = [
    row("read", { calls: 10, failures: 2, toolWallMs: 500, p95Ms: 40 }),
    row("find", { calls: 30, failures: 0, toolWallMs: 100, p95Ms: null }),
    row("git", { calls: 10, failures: 1, toolWallMs: 900, p95Ms: 200 }),
  ]

  test("sorts descending by the selected rank", () => {
    expect(rankTools(rows, "calls").map((row) => row.tool)).toEqual(["find", "git", "read"])
    expect(rankTools(rows, "failures").map((row) => row.tool)).toEqual(["read", "git", "find"])
    expect(rankTools(rows, "toolWallMs").map((row) => row.tool)).toEqual(["git", "read", "find"])
  })

  test("a withheld percentile ranks last", () => {
    expect(rankTools(rows, "p95Ms").map((row) => row.tool)).toEqual(["git", "read", "find"])
  })

  test("ties break on tool name for a stable order", () => {
    const tied = [row("b", { calls: 5 }), row("a", { calls: 5 })]
    expect(rankTools(tied, "calls").map((row) => row.tool)).toEqual(["a", "b"])
  })

  test("does not mutate its input", () => {
    const original = rows.map((entry) => entry.tool)
    rankTools(rows, "calls")
    expect(rows.map((entry) => entry.tool)).toEqual(original)
  })

  test("rankValue covers every rank without throwing", () => {
    const ranks: WorkloadRank[] = ["calls", "failures", "failureRate", "toolWallMs", "p95Ms"]
    for (const rank of ranks) {
      for (const entry of rows) expect(Number.isFinite(rankValue(entry, rank))).toBe(true)
    }
  })
})
