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
      expect(snapshot.totals.calls).toBe(1)
      expect(snapshot.totals.uniqueRequestChars).toBe(333)
      expect(snapshot.totals.uniqueResultChars).toBe(777)
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
      expect(snapshot.causalAttribution).toEqual({
        available: false,
        reason: "trace-chain-unavailable",
      })
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
      expect(snapshot.totals.uniqueRequestChars).toBeGreaterThan(0)
      expect(snapshot.totals.uniqueResultChars).toBe(5)
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
      expect(snapshot.totals.uniqueResultChars).toBe(0)
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

      expect(
        (yield* attribution.snapshot({ activityID: started.activityID })).totals
          .calls,
      ).toBe(1)
      expect(yield* activity.deleteHistory(started.activityID)).toBe(true)
      expect(
        (yield* attribution.snapshot({ activityID: started.activityID })).totals
          .calls,
      ).toBe(0)
    }),
  )
})