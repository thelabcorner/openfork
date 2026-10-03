import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { UsageRecord } from "@opencode-ai/core/usage/record"
import { UsageYield } from "@opencode-ai/core/usage/yield"
import { meanVector, momentsFor } from "@opencode-ai/core/usage/yield-statistics"
import { UsageRecordTable, UsageSessionTable } from "@opencode-ai/core/usage/sql"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, UsageYield.node, UsageRecord.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

const tokens = {
  input: 100,
  cacheRead: 200,
  cacheWrite: 10,
  output: 50,
  reasoning: 25,
}

describe("UsageRecord identity materialization", () => {
  it.live("snapshots Session attribution into an independent monotonic usage dimension", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const database = yield* Database.Service

      yield* database.db.run(sql`
        INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
        VALUES ('usage-project', '/usage/project', 'Usage Project', '[]', 1, 1)
      `)
      yield* database.db.run(sql`
        INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
        VALUES ('ses_usage_dimension', 'usage-project', '/usage/project', 'usage-dimension', 'Newer title', '1', 10, 20)
      `)

      yield* usage.record({
        messageID: "msg_usage_dimension_newer",
        sessionID: "ses_usage_dimension",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        completedAt: 500,
        cost: 0,
        tokens,
      })

      // A late settlement with an older completion timestamp must not roll the
      // accounting watermark backward.
      yield* usage.record({
        messageID: "msg_usage_dimension_older",
        sessionID: "ses_usage_dimension",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        completedAt: 400,
        cost: 0,
        tokens,
      })

      // Live metadata is a separate dimension: renames after the last response
      // must survive a later Session delete without changing the usage watermark.
      yield* database.db.run(sql`
        UPDATE session
        SET title = 'Latest title', time_updated = 30
        WHERE id = 'ses_usage_dimension'
      `)

      const dimension = yield* database.readDb
        .select({
          projectID: UsageSessionTable.project_id,
          directory: UsageSessionTable.directory,
          title: UsageSessionTable.title,
          projectName: UsageSessionTable.project_name,
          lastUsageAt: UsageSessionTable.last_usage_at,
        })
        .from(UsageSessionTable)
        .get()
        .pipe(Effect.orDie)

      expect(dimension).toEqual({
        projectID: "usage-project",
        directory: "/usage/project",
        title: "Latest title",
        projectName: "Usage Project",
        lastUsageAt: 500,
      })
    }),
  )

  it.live("retains attribution when the first Usage settlement arrives after Session deletion", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_late_usage")

      yield* database.db.run(sql`
        INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
        VALUES ('late-usage-project', '/usage/late', 'Late Usage Project', '[]', 1, 1)
      `)
      yield* database.db.run(sql`
        INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
        VALUES ('ses_late_usage', 'late-usage-project', '/usage/late', 'late-usage', 'Late Usage', '1', 100, 200)
      `)

      // A delete can win the race with the first scalar Usage settlement. Keep
      // a tiny attribution tombstone at the storage boundary so that settlement
      // remains project/title-addressable even after the live Session is gone.
      yield* database.db.run(sql`DELETE FROM session WHERE id = 'ses_late_usage'`)

      const tombstone = yield* database.readDb
        .select({
          projectID: UsageSessionTable.project_id,
          directory: UsageSessionTable.directory,
          title: UsageSessionTable.title,
          projectName: UsageSessionTable.project_name,
          lastUsageAt: UsageSessionTable.last_usage_at,
        })
        .from(UsageSessionTable)
        .where(eq(UsageSessionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)

      expect(tombstone).toEqual({
        projectID: "late-usage-project",
        directory: "/usage/late",
        title: "Late Usage",
        projectName: "Late Usage Project",
        lastUsageAt: 0,
      })

      yield* usage.record({
        messageID: "msg_late_usage",
        sessionID,
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        completedAt: 600,
        cost: 0,
        tokens,
      })

      const settled = yield* database.readDb
        .select({
          projectID: UsageSessionTable.project_id,
          directory: UsageSessionTable.directory,
          title: UsageSessionTable.title,
          projectName: UsageSessionTable.project_name,
          lastUsageAt: UsageSessionTable.last_usage_at,
        })
        .from(UsageSessionTable)
        .where(eq(UsageSessionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)

      expect(settled).toEqual({
        projectID: "late-usage-project",
        directory: "/usage/late",
        title: "Late Usage",
        projectName: "Late Usage Project",
        lastUsageAt: 600,
      })
    }),
  )

  it.live("preserves Usage attribution through project cascade deletion", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_project_cascade")

      yield* database.db.run(sql`
        INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
        VALUES ('cascade-project', '/usage/cascade', 'Cascade Project', '[]', 1, 1)
      `)
      yield* database.db.run(sql`
        INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
        VALUES ('ses_project_cascade', 'cascade-project', '/usage/cascade', 'cascade', 'Cascade Session', '1', 100, 200)
      `)
      yield* usage.record({
        messageID: "msg_project_cascade",
        sessionID,
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        completedAt: 700,
        cost: 0,
        tokens,
      })

      yield* database.db.run(sql`DELETE FROM project WHERE id = 'cascade-project'`)

      const liveSession = yield* database.readDb.get(sql`SELECT id FROM session WHERE id = 'ses_project_cascade'`)
      const usageRow = yield* database.readDb.get(sql`SELECT message_id FROM usage_record WHERE message_id = 'msg_project_cascade'`)
      const dimension = yield* database.readDb
        .select({
          projectID: UsageSessionTable.project_id,
          directory: UsageSessionTable.directory,
          title: UsageSessionTable.title,
          projectName: UsageSessionTable.project_name,
          lastUsageAt: UsageSessionTable.last_usage_at,
        })
        .from(UsageSessionTable)
        .where(eq(UsageSessionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)

      expect(liveSession).toBeUndefined()
      expect(usageRow).toEqual({ message_id: "msg_project_cascade" })
      expect(dimension).toEqual({
        projectID: "cascade-project",
        directory: "/usage/cascade",
        title: "Cascade Session",
        projectName: "Cascade Project",
        lastUsageAt: 700,
      })
    }),
  )

  it.live("persists raw, base-model, and suffix account identity", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const database = yield* Database.Service

      yield* usage.record({
        messageID: "msg_qualified",
        sessionID: "ses_identity",
        providerID: "workbuddy",
        modelID: "hy4-preview@wb-account-1",
        completedAt: 100,
        cost: 0,
        tokens,
      })

      const row = yield* database.readDb
        .select({
          modelID: UsageRecordTable.model_id,
          baseModelID: UsageRecordTable.base_model_id,
          accountID: UsageRecordTable.account_id,
        })
        .from(UsageRecordTable)
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({
        modelID: "hy4-preview@wb-account-1",
        baseModelID: "hy4-preview",
        accountID: "wb-account-1",
      })
    }),
  )

  it.live("keeps a bare model as its base identity", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const database = yield* Database.Service

      yield* usage.record({
        messageID: "msg_bare",
        sessionID: "ses_identity",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        completedAt: 200,
        cost: 0,
        tokens,
      })

      const row = yield* database.readDb
        .select({
          modelID: UsageRecordTable.model_id,
          baseModelID: UsageRecordTable.base_model_id,
          accountID: UsageRecordTable.account_id,
        })
        .from(UsageRecordTable)
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({
        modelID: "gpt-5.6-sol",
        baseModelID: "gpt-5.6-sol",
        accountID: null,
      })
    }),
  )

  it.live("duplicate settlement is append-once and does not double-count yield statistics", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const usageYield = yield* UsageYield.Service
      const database = yield* Database.Service

      yield* usage.record({
        messageID: "msg_duplicate",
        sessionID: "ses_identity",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        completedAt: 250,
        cost: 1,
        tokens,
      })
      yield* usage.record({
        messageID: "msg_duplicate",
        sessionID: "ses_other",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        completedAt: 999,
        cost: 999,
        tokens: { ...tokens, input: 999_999 },
      })

      const rows = yield* database.readDb
        .select({
          sessionID: UsageRecordTable.session_id,
          completedAt: UsageRecordTable.completed_at,
          input: UsageRecordTable.input_tokens,
        })
        .from(UsageRecordTable)
        .all()
        .pipe(Effect.orDie)
      expect(rows).toEqual([{ sessionID: SessionSchema.ID.make("ses_identity"), completedAt: 250, input: 100 }])

      const state = yield* usageYield.get({ providerID: "openai", baseModelID: "gpt-5.6-sol" })
      expect(state?.observations).toBe(1)
      expect(meanVector(momentsFor(state!, 8)!)?.[0]).toBeCloseTo(100, 10)
    }),
  )

  it.live("maintenance settlements stay in the ledger but never train personalized yield", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const usageYield = yield* UsageYield.Service
      const database = yield* Database.Service

      yield* usage.record({
        messageID: "msg_summary",
        sessionID: "ses_identity",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        agent: "summary",
        completedAt: 275,
        cost: 0,
        tokens,
      })

      const row = yield* database.readDb
        .select({ messageID: UsageRecordTable.message_id })
        .from(UsageRecordTable)
        .get()
        .pipe(Effect.orDie)
      expect(row?.messageID).toBe("msg_summary")
      expect(yield* usageYield.get({ providerID: "openai", baseModelID: "gpt-5.6-sol" })).toBeUndefined()
    }),
  )

  it.live("prefers an authoritative routed account over a transport suffix", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const database = yield* Database.Service

      yield* usage.record({
        messageID: "msg_routed",
        sessionID: "ses_identity",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash@zen-transport",
        accountID: "zen-authoritative",
        completedAt: 300,
        cost: 0,
        tokens,
      })

      const row = yield* database.readDb
        .select({
          modelID: UsageRecordTable.model_id,
          baseModelID: UsageRecordTable.base_model_id,
          accountID: UsageRecordTable.account_id,
        })
        .from(UsageRecordTable)
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({
        modelID: "deepseek-v4.1-flash@zen-transport",
        baseModelID: "deepseek-v4.1-flash",
        accountID: "zen-authoritative",
      })

      const usageYield = yield* UsageYield.Service
      const base = yield* usageYield.get({
        providerID: "opencode-go",
        baseModelID: "deepseek-v4.1-flash",
      })
      const account = yield* usageYield.get({
        providerID: "opencode-go",
        baseModelID: "deepseek-v4.1-flash",
        accountID: "zen-authoritative",
      })
      expect(base?.observations).toBe(1)
      expect(account?.observations).toBe(1)
    }),
  )
})
