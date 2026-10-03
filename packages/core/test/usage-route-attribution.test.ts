import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { UsageRecord } from "@opencode-ai/core/usage/record"
import { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import { UsageYield } from "@opencode-ai/core/usage/yield"
import { MaintenanceUsageTable, UsageRecordTable } from "@opencode-ai/core/usage/sql"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, UsageYield.node, UsageRecord.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

const tokens = { input: 100, cacheRead: 200, cacheWrite: 10, output: 50, reasoning: 25 }

const readRow = (messageID: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.readDb
      .select({
        messageID: UsageRecordTable.message_id,
        modelID: UsageRecordTable.model_id,
        baseModelID: UsageRecordTable.base_model_id,
        routeKind: UsageRecordTable.route_kind,
        accountID: UsageRecordTable.account_id,
      })
      .from(UsageRecordTable)
      .where(sql`message_id = ${messageID}`)
      .get()
      .pipe(Effect.orDie)
  })

const seedSession = (sessionID: string, projectID: string) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.run(sql`
      INSERT OR IGNORE INTO project (id, worktree, name, sandboxes, time_created, time_updated)
      VALUES (${projectID}, ${"/usage/" + projectID}, ${projectID}, '[]', 1, 1)
    `)
    yield* database.db.run(sql`
      INSERT OR IGNORE INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
      VALUES (${sessionID}, ${projectID}, ${"/usage/" + projectID}, ${sessionID}, ${sessionID}, '1', 1, 1)
    `)
  })

describe("UsageRouteAttribution committed-route contract", () => {
  test("keeps public and unknown attribution distinct in the settlement contract", () => {
    expect(UsageRouteAttribution.settle({ route: { routeKind: "public" } })).toEqual({
      attribution: { kind: "public" },
      accountID: undefined,
    })
    expect(UsageRouteAttribution.settle({})).toEqual({
      attribution: { kind: "unknown" },
      accountID: undefined,
    })
    expect(UsageRouteAttribution.settle({ route: undefined })).toEqual({
      attribution: { kind: "unknown" },
      accountID: undefined,
    })
  })

  test("settles an account route to its own stable account identity", () => {
    expect(
      UsageRouteAttribution.settle({
        route: { routeKind: "account", accountID: "acct-committed" },
        observedAccountID: "acct-observed",
        modelAccountID: "acct-suffix",
      }),
    ).toEqual({ attribution: { kind: "account", accountID: "acct-committed" }, accountID: "acct-committed" })
  })

  test("keeps a public route account-free even against transport and suffix evidence", () => {
    const settled = UsageRouteAttribution.settle({
      route: { routeKind: "public" },
      observedAccountID: "acct-observed",
      modelAccountID: "acct-suffix",
    })
    expect(settled).toEqual({ attribution: { kind: "public" }, accountID: undefined })
    // Never invent `accountID = "public"`.
    expect(settled.accountID).toBeUndefined()
  })

  test("refuses credential handle, revision, and secret material at settlement", () => {
    for (const key of UsageRouteAttribution.FORBIDDEN_KEYS) {
      const result = UsageRouteAttribution.normalize({
        routeKind: "account",
        accountID: "acct-1",
        [key]: "sensitive",
      })
      expect(result).toEqual({
        ok: false,
        rejection: "secret-material",
        attribution: { kind: "unknown" },
      })
      expect(Object.keys(result.attribution)).toEqual(["kind"])
    }
  })

  test("fails closed on a public route that carries an account", () => {
    expect(UsageRouteAttribution.normalize({ routeKind: "public", accountID: "acct-1" })).toEqual({
      ok: false,
      rejection: "public-with-account",
      attribution: { kind: "unknown" },
    })
  })

  test("fails closed on an account route with no stable account identity", () => {
    expect(UsageRouteAttribution.normalize({ routeKind: "account" })).toEqual({
      ok: false,
      rejection: "account-without-account",
      attribution: { kind: "unknown" },
    })
    expect(UsageRouteAttribution.normalize({ routeKind: "account", accountID: "" })).toEqual({
      ok: false,
      rejection: "account-without-account",
      attribution: { kind: "unknown" },
    })
  })

  test("never falls back to transport data for a refused committed attribution", () => {
    expect(
      UsageRouteAttribution.settle({
        route: { routeKind: "public", accountID: "acct-fabricated" },
        observedAccountID: "acct-observed",
        modelAccountID: "acct-suffix",
      }),
    ).toEqual({
      attribution: { kind: "unknown" },
      accountID: undefined,
      rejection: "public-with-account",
    })
  })

  test("preserves the exact legacy derivation when no route was committed", () => {
    expect(UsageRouteAttribution.settle({ observedAccountID: "acct-observed" }).accountID).toBe("acct-observed")
    expect(UsageRouteAttribution.settle({ modelAccountID: "acct-suffix" }).accountID).toBe("acct-suffix")
    expect(
      UsageRouteAttribution.settle({ observedAccountID: "acct-observed", modelAccountID: "acct-suffix" }).accountID,
    ).toBe("acct-observed")
  })
})

describe("UsageRecord durable route attribution", () => {
  it.live("persists a committed account route and never the transport or suffix account", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      yield* seedSession("ses_route_account", "route-account-project")

      yield* usage.record({
        messageID: "msg_route_account",
        sessionID: SessionSchema.ID.make("ses_route_account"),
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash@zen-transport",
        accountID: "zen-transport-observed",
        route: { routeKind: "account", accountID: "zen-committed" },
        completedAt: 1000,
        cost: 0,
        tokens,
      })

      const row = yield* readRow("msg_route_account")
      expect(row).toEqual({
        messageID: "msg_route_account",
        modelID: "deepseek-v4.1-flash@zen-transport",
        baseModelID: "deepseek-v4.1-flash",
        routeKind: "account",
        accountID: "zen-committed",
      })

      // Personalization must be attributed to the committed account, not to the
      // transport suffix, so per-account quality cannot silently split.
      const usageYield = yield* UsageYield.Service
      const committed = yield* usageYield.get({
        providerID: "opencode-go",
        baseModelID: "deepseek-v4.1-flash",
        accountID: "zen-committed",
      })
      const transport = yield* usageYield.get({
        providerID: "opencode-go",
        baseModelID: "deepseek-v4.1-flash",
        accountID: "zen-transport",
      })
      expect(committed?.observations).toBe(1)
      expect(transport).toBeUndefined()
    }),
  )

  it.live("persists a public route as account-free and unknown as account-free", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      yield* seedSession("ses_route_public", "route-public-project")

      yield* usage.record({
        messageID: "msg_route_public",
        sessionID: SessionSchema.ID.make("ses_route_public"),
        providerID: "opencode",
        modelID: "gpt-5.6-sol@zen-legacy-suffix",
        accountID: "zen-transport-observed",
        route: { routeKind: "public" },
        completedAt: 2000,
        cost: 0,
        tokens,
      })
      yield* usage.record({
        messageID: "msg_route_unknown",
        sessionID: SessionSchema.ID.make("ses_route_public"),
        providerID: "opencode",
        modelID: "gpt-5.6-sol",
        completedAt: 2001,
        cost: 0,
        tokens,
      })

      const publicRow = yield* readRow("msg_route_public")
      const unknownRow = yield* readRow("msg_route_unknown")

      // A committed public route must not inherit the account that transport or
      // a legacy model-id suffix would otherwise have produced.
      expect(publicRow?.accountID).toBeNull()
      expect(publicRow?.routeKind).toBe("public")
      expect(unknownRow?.accountID).toBeNull()
      expect(unknownRow?.routeKind).toBe("unknown")

      // `public` is never encoded as a fake account identity.
      const database = yield* Database.Service
      const fabricated = yield* database.readDb.get<{ hits: number }>(sql`
        SELECT count(*) as hits FROM usage_record WHERE account_id = 'public'
      `)
      expect(fabricated?.hits).toBe(0)

      const columns = yield* database.readDb.all<{ name: string }>(sql`PRAGMA table_info('usage_record')`)
      expect(columns.map((column) => column.name)).toContain("route_kind")
    }),
  )

  it.live("drops a refused committed attribution to NULL instead of trusting transport", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      yield* seedSession("ses_route_refused", "route-refused-project")

      yield* usage.record({
        messageID: "msg_route_refused",
        sessionID: SessionSchema.ID.make("ses_route_refused"),
        providerID: "opencode",
        modelID: "gpt-5.6-sol@zen-legacy-suffix",
        accountID: "zen-transport-observed",
        route: {
          routeKind: "account",
          accountID: "zen-committed",
          credentialHandle: "cred_secret_handle",
        } as never,
        completedAt: 3000,
        cost: 0,
        tokens,
      })

      const row = yield* readRow("msg_route_refused")
      expect(row?.accountID).toBeNull()
      expect(row?.routeKind).toBe("unknown")

      const database = yield* Database.Service
      const leaked = yield* database.readDb.get<{ hits: number }>(sql`
        SELECT count(*) as hits
        FROM usage_record
        WHERE message_id = 'msg_route_refused'
          AND (account_id LIKE '%cred_%' OR model_id LIKE '%cred_%' OR base_model_id LIKE '%cred_%')
      `)
      expect(leaked?.hits).toBe(0)
    }),
  )

  it.live("retains settled route attribution after the live Session and route binding are deleted", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const database = yield* Database.Service
      yield* seedSession("ses_route_history", "route-history-project")

      yield* usage.record({
        messageID: "msg_route_history",
        sessionID: SessionSchema.ID.make("ses_route_history"),
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash@zen-transport",
        route: { routeKind: "account", accountID: "zen-committed" },
        completedAt: 4000,
        cost: 0,
        tokens,
      })

      // Deleting the Session cascades its durable ProviderRoute binding away.
      // Accounting history must not cascade with it.
      yield* database.db.run(sql`DELETE FROM session WHERE id = 'ses_route_history'`)

      const liveSession = yield* database.readDb.get(sql`SELECT id FROM session WHERE id = 'ses_route_history'`)
      expect(liveSession).toBeUndefined()

      const row = yield* readRow("msg_route_history")
      expect(row).toEqual({
        messageID: "msg_route_history",
        modelID: "deepseek-v4.1-flash@zen-transport",
        baseModelID: "deepseek-v4.1-flash",
        routeKind: "account",
        accountID: "zen-committed",
      })

      // Structural proof of the tombstone property: usage_record carries no
      // foreign key at all, so no live-table cascade can ever rewrite or erase
      // settled attribution.
      const foreignKeys = yield* database.readDb.all(sql`PRAGMA foreign_key_list('usage_record')`)
      expect(foreignKeys).toEqual([])
    }),
  )

  it.live("keeps legacy inferred account identity while route provenance stays unknown", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const database = yield* Database.Service

      yield* usage.record({
        messageID: "msg_route_legacy_account",
        sessionID: SessionSchema.ID.make("ses_route_legacy"),
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash@zen-legacy",
        completedAt: 5000,
        cost: 0,
        tokens,
      })

      const legacy = yield* readRow("msg_route_legacy_account")
      expect(legacy?.accountID).toBe("zen-legacy")
      expect(legacy?.routeKind).toBe("unknown")

      // Additive migration compatibility: rows written before route_kind existed
      // remain NULL rather than being fabricated as Public or account routes.
      yield* database.db.run(sql`
        INSERT INTO usage_record (
          message_id, session_id, provider_id, model_id, completed_at
        ) VALUES (
          'msg_pre_route_kind', 'ses_pre_route_kind', 'openai', 'gpt-5.6-sol', 5001
        )
      `)
      const historical = yield* database.readDb.get<{ routeKind: string | null }>(sql`
        SELECT route_kind as routeKind
        FROM usage_record
        WHERE message_id = 'msg_pre_route_kind'
      `)
      expect(historical?.routeKind).toBeNull()
    }),
  )

  it.live("persists maintenance route kind and stable account without credential material", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const database = yield* Database.Service
      const maintenance = (agent: string, route?: UsageRouteAttribution.Committed, accountID?: string) =>
        usage.recordMaintenance({
          agent,
          providerID: "opencode",
          modelID: "gpt-5.6-sol",
          route,
          accountID,
          tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
          totalTokens: 2,
          startedAt: 10,
          completedAt: 20,
        })

      yield* maintenance("route-account", { routeKind: "account", accountID: "acct-committed" }, "acct-observed")
      yield* maintenance("route-public", { routeKind: "public" }, "acct-observed")
      yield* maintenance("route-unknown", undefined, "acct-legacy-observed")
      yield* maintenance(
        "route-refused",
        { routeKind: "account", accountID: "acct-committed", credentialHandle: "cred_secret" } as never,
        "acct-observed",
      )

      const rows = yield* database.readDb
        .select({
          agent: MaintenanceUsageTable.agent,
          routeKind: MaintenanceUsageTable.route_kind,
          accountID: MaintenanceUsageTable.account_id,
        })
        .from(MaintenanceUsageTable)
        .orderBy(MaintenanceUsageTable.id)
        .all()
        .pipe(Effect.orDie)

      expect(rows).toEqual([
        { agent: "route-account", routeKind: "account", accountID: "acct-committed" },
        { agent: "route-public", routeKind: "public", accountID: null },
        { agent: "route-unknown", routeKind: "unknown", accountID: "acct-legacy-observed" },
        { agent: "route-refused", routeKind: "unknown", accountID: null },
      ])
      const leaked = yield* database.readDb.get<{ hits: number }>(sql`
        SELECT count(*) as hits
        FROM maintenance_usage
        WHERE account_id LIKE '%cred_%' OR account_id = 'public'
      `)
      expect(leaked?.hits).toBe(0)
    }),
  )
})
