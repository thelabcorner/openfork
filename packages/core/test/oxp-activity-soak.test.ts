import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OxpActivityInspection } from "@opencode-ai/core/oxp-activity/inspection"
import { OxpActivitySchema } from "@opencode-ai/core/oxp-activity/schema"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, OxpActivityInspection.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

const digits = [
  "WITH digits(n) AS (",
  "  VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)",
  ")",
].join("\n")

describe("OxpActivity high-cardinality inspection", () => {
  it.live(
    "keeps indexed warm first-page reads inside Gate-P acceptance targets at 10k parents / 100k spans",
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const inspection = yield* OxpActivityInspection.Service

      yield* db.run(
        sql.raw(
          [
            digits + ",",
            "seq(n) AS (",
            "  SELECT a.n + b.n * 10 + c.n * 100 + d.n * 1000",
            "  FROM digits a",
            "  CROSS JOIN digits b",
            "  CROSS JOIN digits c",
            "  CROSS JOIN digits d",
            ")",
            "INSERT INTO oxp_parent_activity (",
            "  id, title, first_seen_at, last_seen_at,",
            "  call_count, failure_count, augmentation_calls,",
            "  supervision_calls, delegation_calls, observed_epoch_count,",
            "  last_tool, last_root_alias, time_archived",
            ")",
            "SELECT",
            "  printf('oxpa_soak_%05d', n),",
            "  NULL, n, n, 1, 0, 1, 0, 0, 1, 'read', 'soak', NULL",
            "FROM seq",
            "WHERE n < 10000",
          ].join("\n"),
        ),
      )

      const activityID = OxpActivitySchema.ActivityID.make("oxpa_soak_09999")
      yield* db.run(
        sql.raw(
          [
            digits + ",",
            "seq(n) AS (",
            "  SELECT a.n + b.n * 10 + c.n * 100 + d.n * 1000 + e.n * 10000",
            "  FROM digits a",
            "  CROSS JOIN digits b",
            "  CROSS JOIN digits c",
            "  CROSS JOIN digits d",
            "  CROSS JOIN digits e",
            ")",
            "INSERT INTO oxp_invocation (",
            "  id, activity_id, host_run_id, observed_epoch, plane,",
            "  tool, action, root_id, root_alias, status, error_code,",
            "  mutation_attempted, mutation_committed, safe_summary,",
            "  time_started, time_completed",
            ")",
            "SELECT",
            "  printf('oxpi_soak_%06d', n),",
            "  'oxpa_soak_09999', 'runtime-owner:soak', 1, 'augmentation',",
            "  'read', NULL, NULL, 'soak', 'success', NULL, 0, 0, NULL, n, n + 1",
            "FROM seq",
            "WHERE n < 100000",
          ].join("\n"),
        ),
      )

      yield* inspection.list({ limit: 50 })
      yield* inspection.invocations({ activityID, limit: 50 })

      const listStart = performance.now()
      const parents = yield* inspection.list({ limit: 50 })
      const listMs = performance.now() - listStart

      const invocationStart = performance.now()
      const invocations = yield* inspection.invocations({
        activityID,
        limit: 50,
      })
      const invocationMs = performance.now() - invocationStart

      const parentPlan = yield* db.all<{ detail: string }>(
        sql.raw(
          "EXPLAIN QUERY PLAN SELECT * FROM oxp_parent_activity " +
            "WHERE time_archived IS NULL " +
            "ORDER BY last_seen_at DESC, id DESC LIMIT 50",
        ),
      )
      const invocationPlan = yield* db.all<{ detail: string }>(
        sql.raw(
          "EXPLAIN QUERY PLAN SELECT * FROM oxp_invocation " +
            "WHERE activity_id = 'oxpa_soak_09999' " +
            "ORDER BY time_started DESC, id DESC LIMIT 51",
        ),
      )
      const epochPlan = yield* db.all<{ detail: string }>(
        sql.raw(
          "EXPLAIN QUERY PLAN SELECT id FROM oxp_invocation " +
            "WHERE activity_id = 'oxpa_soak_09999' " +
            "AND host_run_id = 'runtime-owner:soak' " +
            "AND observed_epoch = 1 LIMIT 1",
        ),
      )

      expect(parents).toHaveLength(50)
      expect(invocations.items).toHaveLength(50)
      expect(invocations.more).toBe(true)
      expect(parentPlan.map((row) => row.detail).join("\n")).toContain(
        "oxp_parent_activity_last_seen_idx",
      )
      expect(invocationPlan.map((row) => row.detail).join("\n")).toContain(
        "oxp_invocation_activity_started_idx",
      )
      expect(epochPlan.map((row) => row.detail).join("\n")).toContain(
        "oxp_invocation_activity_host_epoch_idx",
      )

      console.info(
        "Gate P warm soak: parent list " +
          listMs.toFixed(2) +
          "ms / 10k rows; invocation first page " +
          invocationMs.toFixed(2) +
          "ms / 100k rows",
      )
      expect(listMs).toBeLessThan(20)
      expect(invocationMs).toBeLessThan(25)
    }),
  )
})
