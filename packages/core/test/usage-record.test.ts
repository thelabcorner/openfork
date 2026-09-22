import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { UsageRecord } from "@opencode-ai/core/usage/record"
import { UsageYield } from "@opencode-ai/core/usage/yield"
import { meanVector, momentsFor } from "@opencode-ai/core/usage/yield-statistics"
import { UsageRecordTable } from "@opencode-ai/core/usage/sql"
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
