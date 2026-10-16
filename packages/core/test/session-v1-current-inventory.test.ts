import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageID, PartID } from "@opencode-ai/core/v1/session"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { V1CurrentInventory } from "@opencode-ai/core/session/v1-current-inventory"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))

describe("V1 → current read-only migration inventory", () => {
  it.effect("enumerates all source kinds without inventing V2 parity or loading certified JSON", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_migration_inventory")
      const messageID = MessageID.make("msg_migration_inventory")
      yield* db.insert(ProjectTable).values({
        id: Project.ID.global, worktree: AbsolutePath.make("/inventory"), sandboxes: [],
      }).onConflictDoNothing().run()
      yield* db.insert(SessionTable).values({
        id: sessionID, project_id: Project.ID.global,
        slug: "inventory", directory: "/inventory", title: "inventory", version: "test",
      }).run()
      yield* db.insert(MessageTable).values({
        id: messageID, session_id: sessionID, data: { role: "assistant" } as never,
      }).run()
      const insert = (
        id: string, data: object, facts?: { kind: string; status?: string },
      ) => db.insert(PartTable).values({
        id: PartID.make(id), session_id: sessionID, message_id: messageID,
        data: data as never,
        ...(facts ? {
          context_projection_version: 1,
          context_kind: facts.kind,
          context_status: facts.status,
        } : {}),
      }).run()
      yield* insert("prt_a_tool", { type: "tool", callID: "call_a" }, { kind: "tool", status: "running" })
      yield* insert("prt_b_file", { type: "file", mime: "image/png", url: "data:test" })
      yield* insert("prt_c_text", { type: "text", text: "hello" }, { kind: "text" })
      yield* insert("prt_d_patch", { type: "patch", hash: "abc" })
      yield* insert("prt_e_future", { type: "future-part" })
      // A certified scalar projection is still usable after OPCL replaces
      // canonical JSON. This inventory deliberately never selects data.
      yield* db.run(sql`UPDATE part SET data='not-json' WHERE id='prt_a_tool'`)

      const first = yield* V1CurrentInventory.page(db, { sessionID, limit: 2 })
      expect(first).toMatchObject({
        more: true,
        counts: { candidates: 1, bridges: 1, unknown: 0, unsettled: 1 },
      })
      expect(first.items.map((x) => x.kind)).toEqual(["tool", "file"])
      const second = yield* V1CurrentInventory.page(db, {
        sessionID, limit: 2, after: first.cursor,
      })
      expect(second).toMatchObject({
        more: true,
        counts: { candidates: 1, bridges: 1, unknown: 0, unsettled: 0 },
      })
      expect(second.items.map((x) => x.kind)).toEqual(["text", "patch"])
      const last = yield* V1CurrentInventory.page(db, {
        sessionID, limit: 2, after: second.cursor,
      })
      expect(last).toMatchObject({
        more: false,
        counts: { candidates: 0, bridges: 0, unknown: 1, unsettled: 0 },
      })
      expect(last.items.map((x) => x.kind)).toEqual(["future-part"])
    }),
  )
})