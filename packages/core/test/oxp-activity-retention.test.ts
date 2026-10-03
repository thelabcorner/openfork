import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { pruneInvocationDetails } from "@opencode-ai/core/oxp-activity/retention"
import { OxpInvocationTable } from "@opencode-ai/core/oxp-activity/sql"
import { eq } from "drizzle-orm"
import type { OxpActivity as OxpActivityContract } from "@opencode-ai/schema/oxp-activity"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, OxpActivity.node, OxpActivityInspection.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

describe("OxpActivity rich-detail retention", () => {
  it.live(
    "rejects one request/outcome detail object above the 4 KiB persistence budget",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const exit = yield* Effect.exit(
        activity.begin({
          correlation: {
            scheme: "mcp-session-id",
            digest: "oversized-detail-parent",
            scope: "unknown",
          },
          hostRunID: "host-detail-budget",
          plane: "augmentation",
          tool: "process",
          detail: { args: { command: "x".repeat(5 * 1024) } },
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* inspection.list()).toEqual([])
    }),
  )

  it.live(
    "prunes oldest rich detail while preserving invocation rows and parent counters",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const inspection = yield* OxpActivityInspection.Service
      const { db } = yield* Database.Service
      const invocationIDs: OxpActivityContract.InvocationID[] = []

      for (let index = 0; index < 12; index++) {
        const started = yield* activity.begin({
          correlation: {
            scheme: "mcp-session-id",
            digest: "retention-parent",
            scope: "unknown",
          },
          hostRunID: "host-retention",
          plane: "augmentation",
          tool: "process",
          startedAt: 1_000 + index,
          detail: { args: { ordinal: index } },
        })
        invocationIDs.push(started.invocationID)
        yield* activity.settle({
          invocationID: started.invocationID,
          status: "success",
          completedAt: 2_000 + index,
        })
      }

      const result = yield* pruneInvocationDetails(db, {
        now: 20_000,
        maxRows: 5,
        maxAgeMs: 1_000_000,
        batchSize: 3,
        maxRowsPerPass: 100,
      })

      expect(result).toEqual({
        before: 12,
        after: 5,
        removed: 7,
        hitPassLimit: false,
      })
      expect(yield* inspection.invocationDetail(invocationIDs[0]!)).toBeUndefined()
      const projected = yield* db
        .select({
          chars: OxpInvocationTable.context_request_chars,
          source: OxpInvocationTable.context_request_source,
          schema: OxpInvocationTable.context_request_schema,
        })
        .from(OxpInvocationTable)
        .where(eq(OxpInvocationTable.id, invocationIDs[0]!))
        .get()
        .pipe(Effect.orDie)
      expect(projected).toMatchObject({
        source: "historical_detail",
        schema: "oxp-primary-args-output-error/v1",
      })
      expect(projected?.chars).toBeGreaterThan(0)
      expect(yield* inspection.invocationDetail(invocationIDs[11]!)).toMatchObject({
        request: { args: { ordinal: 11 } },
      })

      const parents = yield* inspection.list()
      expect(parents).toHaveLength(1)
      expect(parents[0]?.call_count).toBe(12)
      const page = yield* inspection.invocations({
        activityID: parents[0]!.id,
        limit: 20,
      })
      expect(page.items).toHaveLength(12)
      const prunedOldest = page.items.find((row) => row.id === invocationIDs[0])
      expect(prunedOldest).toMatchObject({
        context_request_source: "historical_detail",
        context_request_schema: "oxp-primary-args-output-error/v1",
      })
      expect(prunedOldest?.context_request_chars).toBeGreaterThan(0)
    }),
  )

  it.live(
    "bounds each maintenance pass instead of creating insert-prune churn on the hot path",
    Effect.gen(function* () {
      const activity = yield* OxpActivity.Service
      const { db } = yield* Database.Service

      for (let index = 0; index < 20; index++) {
        yield* activity.begin({
          correlation: {
            scheme: "mcp-session-id",
            digest: "bounded-pass-parent",
            scope: "unknown",
          },
          hostRunID: "host-bounded-pass",
          plane: "augmentation",
          tool: "process",
          startedAt: 1_000 + index,
          detail: { args: { ordinal: index } },
        })
      }

      const first = yield* pruneInvocationDetails(db, {
        now: 20_000,
        maxRows: 5,
        maxAgeMs: 1_000_000,
        batchSize: 2,
        maxRowsPerPass: 4,
      })
      expect(first).toEqual({
        before: 20,
        after: 16,
        removed: 4,
        hitPassLimit: true,
      })
    }),
  )
})
