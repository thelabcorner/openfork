import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpAttribution } from "@opencode-ai/core/oxp-attribution/attribution"
import { projectHistoricalContext } from "@opencode-ai/core/oxp-attribution/backfill"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    OxpActivity.node,
    OxpAttribution.node,
  ]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)

const it = testEffect(layer)

const correlation = (digest: string) => ({
  scheme: "openai/session",
  digest,
  scope: "conversation" as const,
})

describe("OxpAttribution", () => {
  it.live(
    "converges after six concurrent settlements and overlapping global snapshot reads",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const attribution = yield* OxpAttribution.Service
      const observed = (chars: number) => ({
        chars, source: "observed_boundary" as const, schema: "oxp-boundary-primary-text/v1" as const,
      })
      const started = []
      for (let i = 0; i < 6; i++) {
        started.push(yield* activity.begin({
          correlation: correlation(`concurrent-attribution-${i}`),
          hostRunID: `concurrent-${i}`, plane: "augmentation", tool: "read",
          startedAt: 400_000 + i * 1_000, contextRequest: observed(100 + i),
        }))
      }
      expect((yield* attribution.snapshot()).totals.calls).toBe(6)
      const mutations = started.map((row, i) =>
        activity.settle({
          invocationID: row.invocationID,
          status: "success",
          completedAt: 400_100 + i * 1_000,
          contextResult: observed(200 + i),
        }),
      )
      const readers = Array.from({ length: 6 }, () => attribution.snapshot())
      yield* Effect.all([...mutations, ...readers], { concurrency: 12 })
      const final = yield* attribution.snapshot()
      expect(final.totals.calls).toBe(6)
      expect(final.totals.requestChars).toBe(615)
      expect(final.totals.resultChars).toBe(1_215)
      expect(final.coverage.complete).toBe(true)
      expect((yield* attribution.snapshot()).totals).toBe(final.totals)
    }),
  )

  it.live(
    "applies bulk multi-activity settlements and deletions without losing attribution",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const attribution = yield* OxpAttribution.Service
      const observed = (chars: number) => ({
        chars, source: "observed_boundary" as const, schema: "oxp-boundary-primary-text/v1" as const,
      })
      const created: Array<{
        activityID: Parameters<typeof activity.deleteHistory>[0]
        invocationID: Parameters<typeof activity.settle>[0]["invocationID"]
        index: number
      }> = []
      for (let index = 0; index < 40; index++) {
        const started = yield* activity.begin({
          correlation: correlation(`bulk-attribution-${index}`),
          hostRunID: `bulk-${index}`,
          plane: "augmentation",
          tool: "read",
          startedAt: 300_000 + index * 1_000,
          contextRequest: observed(100 + index),
        })
        created.push({ ...started, index })
      }
      const before = yield* attribution.snapshot()
      expect(before.totals.calls).toBe(40)
      expect(before.totals.resultChars).toBe(0)

      for (const row of created) {
        yield* activity.settle({
          invocationID: row.invocationID,
          status: "success",
          completedAt: 300_500 + row.index * 1_000,
          contextResult: observed(300 + row.index),
        })
      }
      const settled = yield* attribution.snapshot()
      expect(settled.totals.calls).toBe(40)
      expect(settled.totals.requestChars).toBe(4_780)
      expect(settled.totals.resultChars).toBe(12_780)
      expect(settled.coverage.complete).toBe(true)
      expect(settled.totals.estimatedTotalTokens).toBeGreaterThanOrEqual(settled.totals.tokens)

      for (const row of created.filter((item) => item.index % 4 === 0)) {
        expect(yield* activity.deleteHistory(row.activityID)).toBe(true)
      }
      const after = yield* attribution.snapshot()
      const retained = created.filter((row) => row.index % 4 !== 0)
      expect(after.totals.calls).toBe(retained.length)
      expect(after.totals.requestChars).toBe(retained.reduce((sum, row) => sum + 100 + row.index, 0))
      expect(after.totals.resultChars).toBe(retained.reduce((sum, row) => sum + 300 + row.index, 0))
      expect(after.coverage.complete).toBe(true)
    }),
  )

  it.live(
    "updates the global projection for one changed activity without changing untouched contributions",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const attribution = yield* OxpAttribution.Service
      const observed = (chars: number) => ({
        chars,
        source: "observed_boundary" as const,
        schema: "oxp-boundary-primary-text/v1" as const,
      })
      const first = yield* activity.begin({
        correlation: correlation("incremental-global-first"), hostRunID: "first", plane: "augmentation",
        tool: "read", startedAt: 100_000, contextRequest: observed(101),
      })
      const second = yield* activity.begin({
        correlation: correlation("incremental-global-second"), hostRunID: "second", plane: "supervision",
        tool: "process", startedAt: 120_000, contextRequest: observed(203),
      })

      const initial = yield* attribution.snapshot()
      expect(initial.totals.calls).toBe(2)
      expect(initial.totals.activities).toBe(2)
      expect(initial.totals.requestChars).toBe(304)
      const repeated = yield* attribution.snapshot()
      expect(repeated.totals).toBe(initial.totals)
      expect(repeated.coverage).toBe(initial.coverage)

      yield* activity.settle({ invocationID: second.invocationID, status: "success", completedAt: 120_300,
        contextResult: observed(401) })
      const settled = yield* attribution.snapshot()
      expect(settled.totals.calls).toBe(2)
      expect(settled.totals.requestChars).toBe(304)
      expect(settled.totals.resultChars).toBe(401)
      expect(settled.coverage.result.observed_boundary).toBe(1)

      yield* activity.settle({ invocationID: first.invocationID, status: "success", completedAt: 105_000,
        contextResult: observed(107) })
      const completed = yield* attribution.snapshot()
      expect(completed.totals.calls).toBe(2)
      expect(completed.totals.resultChars).toBe(508)
      expect(completed.coverage.complete).toBe(true)
      expect(completed.totals.estimatedTotalTokens).toBeGreaterThanOrEqual(completed.totals.tokens)

      // The sliding-window endpoint must preserve inclusive started-at bounds
      // while pushing its filter into SQLite instead of post-filtering history.
      const window = yield* attribution.snapshot({ since: 120_000, until: 120_000 })
      expect(window.totals.calls).toBe(1)
      expect(window.totals.requestChars).toBe(203)
      expect(window.totals.resultChars).toBe(401)
      expect((yield* attribution.snapshot({ since: 120_001, until: 130_000 })).totals.calls).toBe(0)
      expect((yield* attribution.snapshot({ since: 100_000, until: 119_999 })).totals.requestChars).toBe(101)

      expect(yield* activity.deleteHistory(first.activityID)).toBe(true)
      const deleted = yield* attribution.snapshot()
      const remaining = yield* attribution.snapshot({ activityID: second.activityID })
      expect(deleted.totals).toEqual(remaining.totals)
      expect(deleted.coverage).toEqual(remaining.coverage)
      expect(deleted.totals.calls).toBe(1)
    }),
  )

  it.live(
    "projects exact observed boundary evidence with explicit provenance",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const attribution = yield* OxpAttribution.Service

      const started = yield* activity.begin({
        correlation: correlation("attribution-observed"),
        hostRunID: "host-attribution-observed",
        plane: "augmentation",
        tool: "read",
        startedAt: 10_000,
        contextRequest: {
          chars: 333,
          source: "observed_boundary",
          schema: "oxp-boundary-primary-text/v1",
        },
      })
      yield* activity.settle({
        invocationID: started.invocationID,
        status: "success",
        completedAt: 10_100,
        contextResult: {
          chars: 777,
          source: "observed_boundary",
          schema: "oxp-boundary-primary-text/v1",
        },
      })

      const snapshot = yield* attribution.snapshot({
        activityID: started.activityID,
      })
      const again = yield* attribution.snapshot({ activityID: started.activityID })
      // A repeated open panel/poll must not re-filter, resolve or regress an
      // unchanged invocation history. generatedAt remains per request.
      expect(again.totals).toBe(snapshot.totals)
      expect(again.coverage).toBe(snapshot.coverage)
      const scoped = yield* attribution.snapshot({ activityID: started.activityID, since: 10_000 })
      const scopedAgain = yield* attribution.snapshot({ activityID: started.activityID, since: 10_000 })
      expect(scopedAgain.totals).toBe(scoped.totals)
      expect(scoped.totals).not.toBe(snapshot.totals)
      expect(snapshot.totals.calls).toBe(1)
      expect(snapshot.totals.requestChars).toBe(333)
      expect(snapshot.totals.resultChars).toBe(777)
      expect(snapshot.model.kind).toBe("empirical-tool-usage")
      expect(snapshot.model.components.geometricResidency).toBe(false)
      expect(snapshot.coverage.complete).toBe(true)
      expect(snapshot.coverage.request.observed_boundary).toBe(1)
      expect(snapshot.coverage.result.observed_boundary).toBe(1)
      expect(snapshot.totals.bySource).toEqual([
        expect.objectContaining({
          source: "observed_boundary",
          requestCalls: 1,
          resultCalls: 1,
        }),
      ])
      // The empirical upstream estimate is separate from direct OXP payload
      // accounting and must never fall below the observed OXP payload mass.
      expect(snapshot.totals.estimatedTotalTokens).toBeGreaterThanOrEqual(snapshot.totals.tokens)
      expect(snapshot.totals.estimatedSurroundingTokens).toBe(
        snapshot.totals.estimatedTotalTokens - snapshot.totals.tokens,
      )
      const next = yield* activity.begin({
        correlation: correlation("attribution-observed"),
        hostRunID: "host-attribution-observed",
        plane: "augmentation",
        tool: "read",
        startedAt: 11_000,
        contextRequest: { chars: 20, source: "observed_boundary", schema: "oxp-boundary-primary-text/v1" },
      })
      const updated = yield* attribution.snapshot({ activityID: started.activityID })
      expect(updated.totals.calls).toBe(2)
      expect(updated.totals).not.toBe(snapshot.totals)
      yield* activity.settle({
        invocationID: next.invocationID,
        status: "success",
        completedAt: 11_100,
        contextResult: { chars: 30, source: "observed_boundary", schema: "oxp-boundary-primary-text/v1" },
      })
      const settled = yield* attribution.snapshot({ activityID: started.activityID })
      expect(settled.totals.resultChars).toBe(807)
      expect(settled.totals).not.toBe(updated.totals)
    }),
  )

  it.live(
    "backfills recoverable calibration-era detail as historical exact evidence",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const attribution = yield* OxpAttribution.Service
      const { db } = yield* Database.Service

      const started = yield* activity.begin({
        correlation: correlation("attribution-history"),
        hostRunID: "host-attribution-history",
        plane: "augmentation",
        tool: "read",
        startedAt: 20_000,
        detail: { args: { path: "/tmp/example.ts", limit: 20 } },
      })
      yield* activity.settle({
        invocationID: started.invocationID,
        status: "success",
        completedAt: 20_100,
        detail: { output: "hello" },
      })

      expect(
        yield* projectHistoricalContext(db, {
          ids: [started.invocationID],
          limit: 1,
        }),
      ).toEqual({ projected: 1, more: false })

      const snapshot = yield* attribution.snapshot({
        activityID: started.activityID,
      })
      expect(snapshot.coverage.complete).toBe(true)
      expect(snapshot.coverage.request.historical_detail).toBe(1)
      expect(snapshot.coverage.result.historical_detail).toBe(1)
      expect(snapshot.totals.requestChars).toBeGreaterThan(0)
      expect(snapshot.totals.resultChars).toBe(5)
    }),
  )

  it.live(
    "keeps unknown response semantics unavailable instead of inventing result mass",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const attribution = yield* OxpAttribution.Service

      const started = yield* activity.begin({
        correlation: correlation("attribution-unknown-status"),
        hostRunID: "host-attribution-unknown-status",
        plane: "augmentation",
        tool: "read",
        startedAt: 30_000,
      })
      yield* activity.settle({
        invocationID: started.invocationID,
        status: "ambiguous_external_result",
        completedAt: 30_100,
      })

      const snapshot = yield* attribution.snapshot({
        activityID: started.activityID,
      })
      expect(snapshot.coverage.result.unavailable).toBe(1)
      expect(snapshot.coverage.complete).toBe(false)
      expect(snapshot.totals.resultChars).toBe(0)
    }),
  )

  it.live(
    "invalidates a scoped cache after same-connection history deletion",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const attribution = yield* OxpAttribution.Service

      const started = yield* activity.begin({
        correlation: correlation("attribution-delete"),
        hostRunID: "host-attribution-delete",
        plane: "augmentation",
        tool: "find",
        startedAt: 40_000,
        contextRequest: {
          chars: 100,
          source: "observed_boundary",
          schema: "oxp-boundary-primary-text/v1",
        },
      })
      yield* activity.settle({
        invocationID: started.invocationID,
        status: "success",
        completedAt: 40_100,
        contextResult: {
          chars: 200,
          source: "observed_boundary",
          schema: "oxp-boundary-primary-text/v1",
        },
      })

      const before = yield* attribution.snapshot({ activityID: started.activityID })
      expect(before.totals.calls).toBe(1)
      expect(yield* activity.deleteHistory(started.activityID)).toBe(true)
      const after = yield* attribution.snapshot({ activityID: started.activityID })
      expect(after.totals.calls).toBe(0)
      expect(after.totals).not.toBe(before.totals)
    }),
  )
})