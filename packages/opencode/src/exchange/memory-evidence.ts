export * as MemoryEvidence from "./memory-evidence"

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import { MemorySchema } from "@opencode-ai/core/memory/schema"
import { MessageTable, PartTable, SessionMessageTable, SessionMessageToolOverlayTable, SessionTable } from "@opencode-ai/core/session/sql"
import { legacyPartKind } from "@opencode-ai/core/session/legacy-part-query"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { SessionTurnProvenance as CurrentTurnProvenance } from "@opencode-ai/core/session/turn-provenance"
import type { SessionMessage } from "@opencode-ai/core/session/message"

type DB = Database.Interface["db"]
type Evidence = NonNullable<MemorySchema.RememberInput["evidence"]>[number]
const MESSAGE_SOURCES = new Set(["user_message", "assistant_message", "tool_output"])
const MAX_EVIDENCE = 32

/**
 * Verify that *claimed* Session evidence points to existing, authorized
 * records. It does NOT establish semantic entailment between the cited record
 * and the content being remembered. In particular, file/git/test references
 * still need a separate verifier before automatic memory promotion.
 *
 * No index repair, materialization, telemetry, or other storage mutations.
 */
export function verify(
  db: DB,
  context: MemorySchema.Context,
  evidence: readonly Evidence[],
  scope: MemorySchema.Scope = "project",
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if (evidence.length > MAX_EVIDENCE) {
      return yield* Effect.fail(new Error(`Memory evidence exceeds the ${MAX_EVIDENCE}-reference verification limit.`))
    }
    // Evidence commonly cites many messages in one Session. Session project /
    // workspace ownership is immutable within this verification; checking an
    // identical Session again adds round trips but no security information.
    // This is per-call only: no principal-wide or cross-request cache exists.
    const authorizedSessions = new Set<string>()

    for (const source of evidence) {
      const sessionID = source.session_id?.trim()
      const messageID = source.message_id?.trim()
      const partID = source.part_id?.trim()
      const isMessage = MESSAGE_SOURCES.has(source.source_type)
      if (source.source_type === "session" && !sessionID)
        return yield* Effect.fail(new Error("Session evidence requires session_id."))
      if (isMessage && (!sessionID || !messageID))
        return yield* Effect.fail(new Error(`${source.source_type} evidence requires session_id and message_id.`))
      if ((messageID && !sessionID) || (partID && (!messageID || !sessionID)))
        return yield* Effect.fail(new Error("Message/part evidence must include its owning session_id and message_id."))
      if (!sessionID) continue

      if (!authorizedSessions.has(sessionID)) {
        const session = yield* db.select({
          project: SessionTable.project_id, workspace: SessionTable.workspace_id,
        }).from(SessionTable).where(eq(SessionTable.id, sessionID as any)).get().pipe(Effect.orDie)
        if (!session || session.project !== context.projectID ||
            (scope === "workspace" && (!context.workspaceID || session.workspace !== context.workspaceID))) {
          return yield* Effect.fail(new Error("Memory evidence Session is missing or outside the authorized scope."))
        }
        authorizedSessions.add(sessionID)
      }
      if (!messageID) continue

      const legacy = yield* db.select({
        session: MessageTable.session_id, data: MessageTable.data,
      }).from(MessageTable).where(eq(MessageTable.id, messageID as any)).get().pipe(Effect.orDie)
      const modern = legacy ? undefined : yield* db.select({
        session: SessionMessageTable.session_id, type: SessionMessageTable.type, data: SessionMessageTable.data,
      }).from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID as any)).get().pipe(Effect.orDie)
      if (String(legacy?.session ?? modern?.session ?? "") !== sessionID)
        return yield* Effect.fail(new Error("Memory evidence message does not belong to the authorized Session."))
      const role = legacy?.data.role ?? modern?.type
      if (source.source_type === "user_message") {
        // The provider's `user` role can represent a host continuation or
        // synthetic state, NOT necessarily a user-authored turn. Consult the
        // durable message producer's provenance, per AGENTS.md, before
        // admitting evidence as a user correction/preference.
        const legacyProvenance = legacy ? SessionTurnProvenance.resolveInfo(legacy.data) : undefined
        const semanticUser = legacy
          ? legacyProvenance?.confidence === "explicit" && legacyProvenance.owner === "user" &&
            SessionTurnProvenance.isSemanticUserInfo(legacy.data)
          : modern?.type === "user" && CurrentTurnProvenance.semanticKind({
              ...modern.data,
              id: messageID,
              type: modern.type,
              // The SQL row stores id/type separately from the discriminated
              // message payload. Reassemble only for the shared classifier;
              // it reads type and producer-stamped provenance without hydration.
            } as unknown as SessionMessage.Message) === "user"
        if (!semanticUser)
          return yield* Effect.fail(new Error("Memory user_message evidence does not reference a user-owned turn."))
      }
      if ((source.source_type === "assistant_message" || source.source_type === "tool_output") && role !== "assistant")
        return yield* Effect.fail(new Error("Memory assistant/tool evidence does not reference an assistant turn."))

      if (source.source_type === "tool_output" && !partID)
        return yield* Effect.fail(new Error("tool_output requires an exact tool part_id, not just an assistant assertion."))
      if (!partID) continue
      if (modern) {
        // Current-model sessions do not write V1 parts. Their authoritative
        // Tool.Called projector creates an exact (message, callID) overlay in
        // the same event transaction; verify that durable identity directly.
        // A V1 part ID must never be used as a substitute for this proof.
        const call = yield* db.select({ callID: SessionMessageToolOverlayTable.call_id })
          .from(SessionMessageToolOverlayTable)
          .where(and(
            eq(SessionMessageToolOverlayTable.message_id, messageID as SessionMessage.ID),
            eq(SessionMessageToolOverlayTable.call_id, partID),
          ))
          .limit(1).get().pipe(Effect.orDie)
        if (source.source_type !== "tool_output" || !call)
          return yield* Effect.fail(new Error("Memory evidence does not reference a durable current-model tool call."))
        continue
      }
      const part = yield* db.select({
        message: PartTable.message_id, session: PartTable.session_id, kind: legacyPartKind,
      }).from(PartTable).where(eq(PartTable.id, partID as any)).get().pipe(Effect.orDie)
      if (!part || String(part.message) !== messageID || String(part.session) !== sessionID)
        return yield* Effect.fail(new Error("Memory evidence part does not belong to the cited message."))
      if (source.source_type === "tool_output" && part.kind !== "tool")
        return yield* Effect.fail(new Error("tool_output evidence must reference a tool part."))
    }
  })
}
