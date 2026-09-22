import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { UsageRecord } from "@opencode-ai/core/usage/record"
import { STATE_VERSION, UsageYield } from "@opencode-ai/core/usage/yield"
import { statisticalKeyID } from "@opencode-ai/core/usage/yield-statistics"
import { UsageYieldMetaTable, UsageYieldStatTable } from "@opencode-ai/core/usage/sql"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, UsageYield.node, UsageRecord.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  reasoning,
})

function normalizeEntries(entries: readonly UsageYield.Entry[]) {
  return [...entries]
    .map((entry) => ({
      key: entry.key,
      state: entry.state,
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => statisticalKeyID(a.key).localeCompare(statisticalKeyID(b.key)))
}

describe("UsageYield rebuild equivalence", () => {
  it.live("rebuilds the exact incremental statistical projection from chronological usage history", () =>
    Effect.gen(function* () {
      const usage = yield* UsageRecord.Service
      const usageYield = yield* UsageYield.Service
      const database = yield* Database.Service

      yield* usage.record({
        messageID: "msg_a1",
        sessionID: "ses_a",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash@zen-transport-a",
        accountID: "zen-a",
        completedAt: 100,
        cost: 0.1,
        tokens: tokens(100, 10, 40, 2, 3),
      })
      yield* usage.record({
        messageID: "msg_a2",
        sessionID: "ses_a",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash@zen-transport-a",
        accountID: "zen-a",
        completedAt: 200,
        cost: 0.2,
        tokens: tokens(200, 20, 80, 4, 6),
      })
      yield* usage.record({
        messageID: "msg_maintenance",
        sessionID: "ses_a",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash@zen-transport-a",
        accountID: "zen-a",
        agent: "summary",
        completedAt: 250,
        cost: 50,
        tokens: tokens(999_999, 999_999),
      })
      yield* usage.record({
        messageID: "msg_b1",
        sessionID: "ses_b",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
        accountID: "zen-a",
        completedAt: 300,
        cost: 0.3,
        tokens: tokens(300, 30, 120, 6, 9),
      })
      yield* usage.record({
        messageID: "msg_c1",
        sessionID: "ses_c",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash@zen-b",
        completedAt: 400,
        cost: 0.4,
        tokens: tokens(400, 40, 160, 8, 12),
      })

      const incremental = normalizeEntries(yield* usageYield.list())
      expect(incremental).toHaveLength(3)

      const baseKey = { providerID: "opencode-go", baseModelID: "deepseek-v4.1-flash" } as const
      const accountAKey = { ...baseKey, accountID: "zen-a" } as const
      const accountBKey = { ...baseKey, accountID: "zen-b" } as const

      const incrementalBase = yield* usageYield.get(baseKey)
      const incrementalA = yield* usageYield.get(accountAKey)
      const incrementalB = yield* usageYield.get(accountBKey)

      expect(incrementalBase?.observations).toBe(4)
      expect(incrementalA?.observations).toBe(3)
      expect(incrementalB?.observations).toBe(1)
      expect(incrementalBase?.recent.map((row) => row.completedAt)).toEqual([100, 200, 300, 400])
      expect(incrementalBase?.recent.some((row) => row.tokens[0] === 999_999)).toBe(false)

      yield* database.db.delete(UsageYieldStatTable).run().pipe(Effect.orDie)
      expect(yield* usageYield.list()).toEqual([])

      const result = yield* usageYield.rebuild()
      const rebuilt = normalizeEntries(yield* usageYield.list())
      const rebuiltBase = yield* usageYield.get(baseKey)

      expect(result).toEqual({ sourceRows: 4, states: 3 })
      expect(rebuilt).toEqual(incremental)
      expect(rebuiltBase?.recent.map((row) => row.completedAt)).toEqual([100, 200, 300, 400])

      const meta = yield* database.readDb
        .select()
        .from(UsageYieldMetaTable)
        .where(eq(UsageYieldMetaTable.id, "global"))
        .get()
        .pipe(Effect.orDie)

      expect(meta?.version).toBe(STATE_VERSION)
      expect(meta?.source_rows).toBe(4)
      expect(meta?.rebuilt_at).toBeGreaterThan(0)
    }),
  )
})
