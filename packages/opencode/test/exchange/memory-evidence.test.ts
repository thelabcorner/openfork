import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MemorySchema } from "@opencode-ai/core/memory/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageTable, PartTable, SessionMessageTable, SessionMessageToolOverlayTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MemoryEvidence } from "../../src/exchange/memory-evidence"
import { testEffect } from "../lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)
const scope = MemorySchema.Context.make({ projectID: String(ProjectV2.ID.global), workspaceID: null })

describe("Dreamer memory evidence boundary", () => {
  it.effect("accepts authorized real Session records but rejects forged, cross-scope, and role-confused references", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = SessionSchema.ID.make("ses_dream_evidence")
      const messageID = SessionMessage.ID.make("msg_dream_evidence")
      yield* db.insert(ProjectTable).values({
        id: ProjectV2.ID.global,
        worktree: AbsolutePath.make("/native/dream"),
        sandboxes: [],
      }).run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values({
        id: session, project_id: ProjectV2.ID.global,
        slug: "dream", directory: "/native/dream",
        title: "Dream evidence", version: "test",
      }).run().pipe(Effect.orDie)
      const message = SessionMessage.User.make({
        id: messageID, type: "user", text: "Remember the original decision.",
        time: { created: DateTime.makeUnsafe(1) },
      })
      const encoded = Schema.encodeSync(SessionMessage.Message)(message)
      const { id, type, ...data } = encoded
      yield* db.insert(SessionMessageTable).values({
        id: SessionMessage.ID.make(id), session_id: session, type, seq: 1, data,
      }).run().pipe(Effect.orDie)

      const valid = [{ source_type: "user_message" as const, session_id: session, message_id: messageID }]
      yield* MemoryEvidence.verify(db, scope, valid)
      yield* MemoryEvidence.verify(db, scope, [{ source_type: "session", session_id: session }])
      // Provider role is not semantic ownership. Current and legacy host
      // continuations can both be serialized as user-role messages.
      const hostModern = SessionMessage.ID.make("msg_host_continuation")
      yield* db.insert(SessionMessageTable).values({
        id: hostModern, session_id: session, type: "user", seq: 2,
        data: { text: "Host generated an instruction, not the human", provenance: {
          owner: "host", source: "goal.continuation",
        } } as any,
      }).run().pipe(Effect.orDie)
      const hostLegacy = "msg_host_continuation_legacy"
      yield* db.insert(MessageTable).values({
        id: hostLegacy as any, session_id: session,
        data: { role: "user", provenance: { owner: "host", source: "goal.continuation" } } as any,
      }).run().pipe(Effect.orDie)
      const ambiguousLegacy = "msg_legacy_unattributed"
      yield* db.insert(MessageTable).values({
        id: ambiguousLegacy as any, session_id: session,
        data: { role: "user" } as any,
      }).run().pipe(Effect.orDie)
      for (const hostMessage of [hostModern, hostLegacy, ambiguousLegacy]) {
        const citedAsUser = yield* MemoryEvidence.verify(db, scope, [{
          source_type: "user_message", session_id: session, message_id: hostMessage,
        }]).pipe(Effect.exit)
        expect(Exit.isFailure(citedAsUser)).toBe(true)
      }
      // Host-authored turns can be cited as historical Session evidence,
      // but must not masquerade as human preferences or corrections.
      yield* MemoryEvidence.verify(db, scope, [{ source_type: "session", session_id: session, message_id: hostLegacy }])
      const toolMessage = "msg_verified_tool"
      const toolPart = "prt_verified_tool"
      yield* db.insert(MessageTable).values({
        id: toolMessage as any, session_id: session, data: { role: "assistant" } as any,
      }).run().pipe(Effect.orDie)
      yield* db.insert(PartTable).values({
        id: toolPart as any, message_id: toolMessage as any, session_id: session,
        data: { type: "tool" } as any,
      }).run().pipe(Effect.orDie)
      yield* MemoryEvidence.verify(db, scope, [{
        source_type: "tool_output", session_id: session, message_id: toolMessage, part_id: toolPart,
      }])
      const currentAssistant = SessionMessage.ID.make("msg_current_tool_evidence")
      yield* db.insert(SessionMessageTable).values({
        id: currentAssistant, session_id: session, type: "assistant", seq: 3,
        data: {} as any,
      }).run().pipe(Effect.orDie)
      yield* db.insert(SessionMessageToolOverlayTable).values({
        message_id: currentAssistant, call_id: "call_current_real",
      }).run().pipe(Effect.orDie)
      // A current-model Tool.Called event owns an overlay, not a V1 Part row.
      // Exact durable call identity must be sufficient for the same evidence
      // boundary without fabricating a duplicate legacy tool part.
      yield* MemoryEvidence.verify(db, scope, [{
        source_type: "tool_output", session_id: session, message_id: currentAssistant, part_id: "call_current_real",
      }])
      expect(Exit.isFailure(yield* MemoryEvidence.verify(db, scope, [{
        source_type: "tool_output", session_id: session, message_id: currentAssistant, part_id: "call_forged",
      }]).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* MemoryEvidence.verify(db, scope, [{
        source_type: "tool_output", session_id: session, message_id: messageID, part_id: "call_current_real",
      }]).pipe(Effect.exit))).toBe(true)
      for (const invalid of [
        [{ source_type: "user_message" as const }],
        [{ source_type: "user_message" as const, session_id: session, message_id: "msg_does_not_exist" }],
        [{ source_type: "assistant_message" as const, session_id: session, message_id: messageID }],
        [{ source_type: "tool_output" as const, session_id: session, message_id: messageID, part_id: "prt_forged" }],
        [{ source_type: "tool_output" as const, session_id: session, message_id: toolMessage, part_id: "prt_forged" }],
        [{ source_type: "session" as const, session_id: "ses_missing" }],
        [{ source_type: "file" as const, path: "whatever", session_id: "ses_missing" }],
      ]) {
        const exit = yield* MemoryEvidence.verify(db, scope, invalid).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }
      const outside = MemorySchema.Context.make({ projectID: "another-project", workspaceID: null })
      const crossProject = yield* MemoryEvidence.verify(db, outside, valid).pipe(Effect.exit)
      expect(Exit.isFailure(crossProject)).toBe(true)
      const otherWorkspace = MemorySchema.Context.make({ projectID: scope.projectID, workspaceID: "another-workspace" })
      const crossWorkspace = yield* MemoryEvidence.verify(db, otherWorkspace, valid, "workspace").pipe(Effect.exit)
      expect(Exit.isFailure(crossWorkspace)).toBe(true)
      const many = Array.from({ length: 33 }, () => ({ source_type: "session" as const, session_id: session }))
      expect(Exit.isFailure(yield* MemoryEvidence.verify(db, scope, many).pipe(Effect.exit))).toBe(true)
      // The upper allowed bound can reuse one verified Session; the verifier
      // must still enforce all references and never leak another project.
      const bounded = many.slice(0, 32)
      yield* MemoryEvidence.verify(db, scope, bounded)
      expect(Exit.isFailure(yield* MemoryEvidence.verify(db, outside, bounded).pipe(Effect.exit))).toBe(true)
    }),
  )
})
