import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivitySchema } from "@opencode-ai/core/oxp-activity/schema"
import { OxpInvocationTable } from "@opencode-ai/core/oxp-activity/sql"
import { OxpAttribution } from "@opencode-ai/core/oxp-attribution/attribution"
import { OxpWorkload } from "@opencode-ai/core/oxp-attribution/workload"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, OxpActivity.node, OxpAttribution.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

describe("OXP workload projection", () => {
  it.live("classifies outcomes, exact quantiles and coverage on one bounded invocation cohort", Effect.gen(function* () {
    const activity = yield* OxpActivity.Service
    const attribution = yield* OxpAttribution.Service
    const statuses = ["success", "committed", "failed", "conflict", "denied", "cancelled_before_commit", "interrupted", "ambiguous_external_result", "running"] as const
    let activityID: OxpActivitySchema.ActivityID | undefined
    for (let i = 0; i < 25; i++) {
      const startedAt = 100_000 + i * 100
      const started = yield* activity.begin({
        correlation: { scheme: "openai/session", digest: "workload-one", scope: "conversation" },
        hostRunID: "workload", plane: "augmentation", tool: "read", startedAt,
        detail: { args: { path: `secret-${i}` } },
      })
      activityID = started.activityID
      const status = i < 17 ? "success" : statuses[i - 17]!
      if (status !== "running") {
        expect(yield* activity.settle({ invocationID: started.invocationID, status, completedAt: startedAt + (i + 1) * 10 })).toBe(true)
        expect(yield* activity.settle({ invocationID: started.invocationID, status, completedAt: startedAt + 999 })).toBe(false)
      }
    }
    // Detail JSON is intentionally unreadable. A profiling request must never
    // join/decode invocation request or result transcripts.
    const database = yield* Database.Service
    yield* database.db.run("UPDATE oxp_invocation_detail SET request = '{invalid json'")
    const input = { since: 100_000, until: 102_400, includeWorkload: true }
    const first = yield* attribution.snapshot(input)
    const profile = first.workload!
    expect(first.totals.calls).toBe(25)
    expect(profile.totals).toMatchObject({
      calls: 25, successes: 19, failures: 2, denied: 1, cancelled: 1,
      interrupted: 1, unknown: 1, running: 0, measuredDurations: 25,
      missingDurations: 0, failureRate: 2 / 21, toolWallMs: 3250,
      p50Ms: 130, p95Ms: 240,
    })
    expect(profile.tools).toHaveLength(1)
    expect(profile.tools[0]?.tool).toBe("read")
    expect(profile.buckets.length).toBeLessThanOrEqual(120)
    expect(profile.buckets.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(25)
    expect((yield* attribution.snapshot(input)).workload).toBe(profile)
    expect((yield* attribution.snapshot({ ...input, activityID })).workload?.totals.calls).toBe(25)
    expect((yield* attribution.snapshot({ since: 102_401, until: 103_000, includeWorkload: true })).workload?.totals)
      .toMatchObject({ calls: 0, failureRate: null, p50Ms: null, p95Ms: null })
    expect((yield* attribution.snapshot({ since: 100_000, until: 100_000 })).workload).toBeUndefined()
    expect(yield* activity.deleteHistory(activityID!)).toBe(true)
    expect((yield* attribution.snapshot(input)).workload?.totals.calls).toBe(0)
  }))

  it.live("bounds tool and bucket output, preserves unknown duration, and uses indexed scalar reads", Effect.gen(function* () {
    const activity = yield* OxpActivity.Service
    const attribution = yield* OxpAttribution.Service
    const database = yield* Database.Service
    for (let i = 0; i < 16; i++) {
      const started = yield* activity.begin({
        correlation: { scheme: "openai/session", digest: `workload-${i}`, scope: "conversation" },
        hostRunID: "workload", plane: "supervision", tool: `tool-${String(i).padStart(2, "0")}`,
        startedAt: 200_000 + i * 1_000,
      })
      if (i % 2 === 0) yield* activity.settle({
        invocationID: started.invocationID, status: i === 14 ? "failed" : "denied",
        completedAt: 200_005 + i * 1_000,
      })
    }
    const profile = (yield* attribution.snapshot({ since: 200_000, until: 220_000, includeWorkload: true })).workload!
    expect(profile.tools).toHaveLength(12)
    expect(profile.tools.map((tool) => tool.tool)).toEqual(Array.from({ length: 12 }, (_, i) => `tool-${String(i).padStart(2, "0")}`))
    expect(profile.otherTools).toBe(4)
    expect(profile.otherCalls).toBe(4)
    expect(profile.topFailures.map((row) => row.tool)).toEqual(["tool-14"])
    expect(profile.totals).toMatchObject({ calls: 16, failures: 1, denied: 7, running: 8, measuredDurations: 8, missingDurations: 8, toolWallMs: 40, p50Ms: 5, p95Ms: null })
    const plan = yield* database.db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT tool, status, time_started, time_completed FROM oxp_invocation WHERE time_started >= 200000 AND time_started <= 220000")
    expect(plan.map((step) => step.detail).join(" ")).toContain("oxp_invocation_started_idx")
    expect(() => OxpWorkload.validate({ since: 0, until: OxpWorkload.MAX_RANGE_MS + 1 })).toThrow()
  }))

  it.live("keeps the large-range response bounded and suppresses capped percentiles", Effect.gen(function* () {
    const database = yield* Database.Service
    const activity = yield* OxpActivity.Service
    const parent = yield* activity.begin({
      correlation: { scheme: "openai/session", digest: "workload-perf", scope: "conversation" },
      hostRunID: "workload-perf", plane: "augmentation", tool: "tool-00", startedAt: 300_000,
    })
    // Seed terminal scalar rows directly: producer tests above exercise begin/settle;
    // this fixture isolates the indexed analytic read from writer/event costs.
    const seedStart = performance.now()
    for (let base = 0; base < 6_000; base += 200) {
      yield* database.db.insert(OxpInvocationTable).values(Array.from({ length: 200 }, (_, offset) => {
        const index = base + offset
        return {
          id: OxpActivitySchema.nextInvocationID(), activity_id: parent.activityID,
          host_run_id: "workload-perf", plane: "augmentation" as const,
          tool: `tool-${String(index % 20).padStart(2, "0")}`,
          status: index % 10 === 0 ? "failed" as const : "success" as const,
          time_started: 300_001 + index * 1_000,
          time_completed: 300_011 + index * 1_000,
        }
      })).run()
    }
    const input = { since: 300_000, until: 6_301_000 }
    const coldStart = performance.now()
    const cold = yield* OxpWorkload.read(database, input)
    const coldMs = performance.now() - coldStart
    const warmStart = performance.now()
    const warm = yield* OxpWorkload.read(database, input)
    const warmMs = performance.now() - warmStart
    expect(cold.totals).toMatchObject({ calls: 6_001, failures: 600, measuredDurations: 6_000, missingDurations: 1, p50Ms: null, p95Ms: null })
    expect(warm.totals).toEqual(cold.totals)
    expect(cold.tools).toHaveLength(12)
    expect(cold.otherTools).toBe(8)
    expect(cold.buckets.length).toBeLessThanOrEqual(120)
    expect(cold.buckets.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(6_001)
    console.info(`OXP workload 6k scalar rows: seed=${Math.round(coldStart - seedStart)}ms cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms`)
  }))
})
