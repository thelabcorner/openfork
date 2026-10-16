import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageID, PartID, SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { V1CurrentAudit } from "@opencode-ai/core/session/v1-current-audit"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
))
const sid = SessionSchema.ID.make("ses_shadow_audit")
const uid = MessageID.make("msg_audit_user")
const aid = MessageID.make("msg_audit_assistant")
const badID = MessageID.make("msg_audit_unknown")
const modelID = ModelV2.ID.make("demo")
const providerID = ProviderV2.ID.make("test")

describe("V1 → current read-only replay differential audit", () => {
  it.effect("pages actual projections, tracks unsupported parts, rejects malformed rows and never writes current authority", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(ProjectTable).values({
        id: Project.ID.global, worktree: AbsolutePath.make("/audit"), sandboxes: [],
      }).onConflictDoNothing().run()
      yield* db.insert(SessionTable).values({
        id: sid, project_id: Project.ID.global, directory: "/audit",
        slug: "audit", title: "audit", version: "test",
      }).run()
      const user = SessionV1.User.make({
        id: uid, sessionID: sid, role: "user", time: { created: 1 },
        agent: "build", model: { modelID, providerID },
      })
      const assistant = SessionV1.Assistant.make({
        id: aid, sessionID: sid, role: "assistant", time: { created: 2 },
        parentID: uid, modelID, providerID, agent: "build", mode: "build",
        path: { cwd: "/audit", root: "/audit" }, cost: 0,
        tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      for (const [id, created, data] of [
        [uid, 1, user], [aid, 2, assistant], [badID, 3, { role: "unknown" }],
      ] as const) {
        yield* db.insert(MessageTable).values({
          id, session_id: sid, time_created: created, time_updated: created,
          data: data as never,
        }).run()
      }
      const put = (id: string, messageID: MessageID, data: object) =>
        db.insert(PartTable).values({
          id: PartID.make(id), session_id: sid, message_id: messageID,
          data: data as never,
        }).run()
      yield* put("prt_audit_text", uid, { type: "text", text: "hello" })
      yield* put("prt_audit_tool", aid, {
        type: "tool", callID: "call_exact", tool: "shell",
        state: { status: "running", input: { command: "ls" }, time: { start: 2 } },
      })
      yield* put("prt_audit_patch", aid, { type: "patch", hash: "sha", files: ["x.ts"] })

      const first = yield* V1CurrentAudit.page(db, { sessionID: sid, limit: 1 })
      expect(first).toMatchObject({
        more: true, cutoverSafe: false,
        counts: { messages: 1, parts: 1, blocked: 0, bridgedParts: 0, unresolvedTools: 0 },
      })
      expect(first.items[0]).toMatchObject({ messageID: uid, verdict: "shadow-verified", role: "user" })
      const second = yield* V1CurrentAudit.page(db, { sessionID: sid, after: first.cursor, limit: 1 })
      expect(second).toMatchObject({
        more: true, cutoverSafe: false,
        counts: { messages: 1, parts: 2, blocked: 0, bridgedParts: 1, unresolvedTools: 1 },
      })
      expect(second.items[0]?.blockers.some((s) => s.startsWith("unsupported-part:patch:"))).toBe(true)
      const last = yield* V1CurrentAudit.page(db, { sessionID: sid, after: second.cursor, limit: 1 })
      expect(last).toMatchObject({
        more: false, cutoverSafe: false,
        counts: { messages: 1, parts: 0, blocked: 1, bridgedParts: 0, unresolvedTools: 0 },
      })
      expect(last.items[0]).toMatchObject({
        messageID: badID, verdict: "blocked", blockers: expect.arrayContaining(["invalid-or-ambiguous-v1-source"]),
      })
      expect(yield* db.select().from(SessionMessageTable).all()).toEqual([])
      const summary = yield* V1CurrentAudit.summarize(db, {
        sessionID: sid, pageSize: 1, maxPages: 8,
      })
      expect(summary).toMatchObject({
        complete: true, cutoverSafe: false, pageCount: 3,
        counts: { messages: 3, parts: 3, blocked: 1, bridgedParts: 1, unresolvedTools: 1 },
      })
      expect(summary.blockerCounts["unsupported-part:patch"]).toBe(1)
      expect((yield* V1CurrentAudit.summarize(db, {
        sessionID: sid, pageSize: 1, maxPages: 1,
      }))).toMatchObject({
        complete: false, pageCount: 1, cursor: { messageID: uid, timeCreated: 1 },
      })

      // The read-only replay certificate changes on a source update: the page
      // digest may NOT be re-used as cutover evidence after concurrent writes.
      const previous = second.pageDigest
      yield* db.update(PartTable).set({
        data: { type: "tool", callID: "call_exact", tool: "shell",
          state: { status: "completed", input: { command: "ls" },
            output: "done", title: "shell", metadata: {}, time: { start: 2, end: 3 } } } as never,
      }).where(eq(PartTable.id, PartID.make("prt_audit_tool"))).run()
      const changed = yield* V1CurrentAudit.page(db, { sessionID: sid, after: first.cursor, limit: 1 })
      expect(changed.pageDigest).not.toBe(previous)
      expect(changed.counts.unresolvedTools).toBe(0)
      const next = yield* V1CurrentAudit.summarize(db, {
        sessionID: sid, pageSize: 1, maxPages: 8,
      })
      expect(next.digest).not.toBe(summary.digest)
      expect(next.counts.unresolvedTools).toBe(0)

      // Valid assistant schema is insufficient: parent ownership must be
      // grounded in the SAME session, or a historical V2 cutover would sever
      // V1 turn ancestry without raising an error.
      const orphanID = MessageID.make("msg_audit_orphan")
      yield* db.insert(MessageTable).values({
        id: orphanID, session_id: sid, time_created: 4, time_updated: 4,
        data: SessionV1.Assistant.make({
          id: orphanID, sessionID: sid, role: "assistant", time: { created: 4 },
          parentID: MessageID.make("msg_nonexistent"),
          modelID, providerID, agent: "build", mode: "build",
          path: { cwd: "/audit", root: "/audit" }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }) as never,
      }).run()
      const orphan = yield* V1CurrentAudit.page(db, {
        sessionID: sid, after: { messageID: badID, timeCreated: 3 },
      })
      expect(orphan.items[0]).toMatchObject({
        messageID: orphanID, verdict: "blocked", blockers: expect.arrayContaining(["orphan-parent"]),
      })
    }),
  )
})
