import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NativeToolSettlementTable } from "@opencode-ai/core/session/native-tool-settlement.sql"
import { NativeToolSettlement } from "@/session/native-tool-settlement"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

describe("native terminal tool settlement", () => {
  it.live("is durable, idempotent on retries and preserves measured model/provider/outcome", Effect.gen(function* () {
    const database = yield* Database.Service
    const record = {
      id: "tool-part-one",
      session_id: "s-1",
      project_id: "p-1",
      provider_id: "openai",
      model_id: "gpt-6-sol",
      tool: "read",
      status: "success" as const,
      started_at: 1_000,
      completed_at: 1_075,
      duration_ms: 75,
    }
    yield* NativeToolSettlement.record(database, record)
    yield* NativeToolSettlement.record(database, record)
    const rows = yield* database.db.select().from(NativeToolSettlementTable).all()
    expect(rows).toEqual([record])
  }))
})
