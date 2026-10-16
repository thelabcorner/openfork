import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { legacyPartKind, legacyPartOpaque, legacyPartSigned, legacyPartStatus, unsettledLegacyToolPredicate } from "@opencode-ai/core/session/legacy-part-query"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))

describe("V1 compatibility part facts", () => {
  it.effect("uses certified facts without JSON and reverts to authoritative JSON for every other version", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_part_facts_probe")
      const messageID = "msg_part_facts_probe"
      yield* db.insert(ProjectTable).values({
        id: Project.ID.global, worktree: AbsolutePath.make("/facts"), sandboxes: [],
      }).onConflictDoNothing().run()
      yield* db.insert(SessionTable).values({
        id: sessionID, project_id: Project.ID.global,
        slug: "facts", directory: "/facts", title: "facts", version: "test",
      }).run()
      yield* db.insert(MessageTable).values({
        id: messageID as never, session_id: sessionID, data: { role: "assistant" } as never,
      }).run()
      const rows = [
        {
          id: "prt_fact_certified", data: { type: "tool", state: { status: "running" } },
          context_projection_version: 1, context_kind: "tool", context_status: "running",
          context_signed: false, context_opaque: true,
        },
        {
          id: "prt_fact_historical", data: {
            type: "reasoning", metadata: { anthropic: { signature: "signed" } },
          },
          context_projection_version: 0, context_kind: "text", context_status: "completed",
          context_signed: false, context_opaque: false,
        },
        {
          id: "prt_fact_future", data: { type: "tool", state: { status: "pending" } },
          context_projection_version: 99, context_kind: "text", context_status: "completed",
          context_signed: false, context_opaque: false,
        },
      ] as const
      for (const row of rows) {
        yield* db.insert(PartTable).values({
          ...row, id: row.id as never, message_id: messageID as never, session_id: sessionID,
          data: row.data as never,
        }).run()
      }
      // The physical OPCL representation is not JSON; current scalar facts
      // remain authoritative. An accidental json_extract would now fail.
      yield* db.run(sql`UPDATE part SET data = 'not-json' WHERE id='prt_fact_certified'`)
      const read = (id: string) => db.select({
        kind: legacyPartKind,
        status: legacyPartStatus,
        signed: legacyPartSigned,
        opaque: legacyPartOpaque,
      }).from(PartTable).where(eq(PartTable.id, id as never)).get()
      expect(yield* read("prt_fact_certified")).toEqual({
        kind: "tool", status: "running", signed: 0, opaque: 1,
      })
      expect(yield* read("prt_fact_historical")).toEqual({
        kind: "reasoning", status: null, signed: 1, opaque: 0,
      })
      expect(yield* read("prt_fact_future")).toEqual({
        kind: "tool", status: "pending", signed: 0, opaque: 0,
      })
      expect((yield* db.select({ id: PartTable.id }).from(PartTable)
        .where(unsettledLegacyToolPredicate).all()).map((row) => String(row.id)).sort())
        .toEqual(["prt_fact_certified", "prt_fact_future"])

      // An unknown-version row with malformed JSON is *not* silently treated
      // as safe: unverified metadata can never authorize a context mutation.
      yield* db.run(sql`UPDATE part SET data = 'not-json' WHERE id='prt_fact_future'`)
      expect(Exit.isFailure(yield* read("prt_fact_future").pipe(Effect.exit))).toBe(true)
    }),
  )
})