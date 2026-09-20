import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageProjection } from "@opencode-ai/core/session/message-projection"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { SessionMessageTable, SessionMessageToolOverlayTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

const timestamp = DateTime.makeUnsafe(1)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const sessionA = SessionV2.ID.make("ses_recovery_a")
const sessionB = SessionV2.ID.make("ses_recovery_b")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionA,
        project_id: Project.ID.global,
        slug: "recovery-a",
        directory: "/project",
        title: "recovery a",
        version: "test",
      },
      {
        id: sessionB,
        project_id: Project.ID.global,
        slug: "recovery-b",
        directory: "/project",
        title: "recovery b",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
  return { db, events }
})

const startAssistant = (events: EventV2.Interface, sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      timestamp,
      agent: "build",
      model,
    })
    return assistantMessageID
  })

const callTool = (
  events: EventV2.Interface,
  sessionID: SessionV2.ID,
  assistantMessageID: SessionMessage.ID,
  callID: string,
  executed: boolean,
) =>
  Effect.gen(function* () {
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      timestamp,
      assistantMessageID,
      callID,
      name: "bash",
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID,
      timestamp,
      assistantMessageID,
      callID,
      tool: "bash",
      input: { command: "pwd" },
      provider: { executed },
    })
  })

const readAssistant = (
  db: Effect.Success<typeof setup>["db"],
  assistantMessageID: SessionMessage.ID,
) =>
  Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, assistantMessageID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* Effect.die("missing assistant")
    return yield* SessionMessageProjection.decodeRow(db, row).pipe(Effect.orDie)
  })

describe("SessionRecovery", () => {
  it.effect("seals only unresolved tools for the claimed Session and is idempotent", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      const assistantA = yield* startAssistant(events, sessionA)
      yield* callTool(events, sessionA, assistantA, "call-unresolved", true)
      yield* callTool(events, sessionA, assistantA, "call-settled", false)
      const settled = yield* events.publish(SessionEvent.Tool.Success, {
        sessionID: sessionA,
        timestamp,
        assistantMessageID: assistantA,
        callID: "call-settled",
        structured: { ok: true },
        content: [{ type: "text", text: "done" }],
        provider: { executed: false },
      })

      const assistantB = yield* startAssistant(events, sessionB)
      yield* callTool(events, sessionB, assistantB, "call-other-session", false)

      expect(
        yield* db
          .select()
          .from(SessionMessageToolOverlayTable)
          .where(eq(SessionMessageToolOverlayTable.call_id, "call-unresolved"))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ settlement_event_id: null })

      expect(yield* SessionRecovery.failInterruptedTools(db, events, sessionA)).toEqual({
        candidates: 1,
        settled: 1,
      })

      const repaired = yield* readAssistant(db, assistantA)
      expect(repaired.type).toBe("assistant")
      if (repaired.type !== "assistant") return
      const unresolved = repaired.content.find(
        (part): part is SessionMessage.AssistantTool => part.type === "tool" && part.id === "call-unresolved",
      )
      const alreadySettled = repaired.content.find(
        (part): part is SessionMessage.AssistantTool => part.type === "tool" && part.id === "call-settled",
      )
      expect(unresolved).toMatchObject({
        provider: { executed: true },
        state: {
          status: "error",
          error: { type: "unknown", message: "Tool execution interrupted" },
        },
      })
      expect(alreadySettled).toMatchObject({ state: { status: "completed" } })
      expect(
        yield* db
          .select()
          .from(SessionMessageToolOverlayTable)
          .where(eq(SessionMessageToolOverlayTable.call_id, "call-settled"))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ settlement_event_id: settled.id })
      expect(
        yield* db
          .select()
          .from(SessionMessageToolOverlayTable)
          .where(eq(SessionMessageToolOverlayTable.call_id, "call-other-session"))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ settlement_event_id: null })

      expect(yield* SessionRecovery.failInterruptedTools(db, events, sessionA)).toEqual({
        candidates: 0,
        settled: 0,
      })
    }),
  )

  it.effect("has an indexed unresolved-tool recovery path", () =>
    Effect.gen(function* () {
      const { db } = yield* setup
      const plan = yield* db.all<{ detail: string }>(sql`
        EXPLAIN QUERY PLAN
        SELECT overlay.message_id, overlay.call_id
        FROM session_message_tool_overlay AS overlay
          INDEXED BY session_message_tool_overlay_unsettled_idx
        INNER JOIN session_message AS message ON message.id = overlay.message_id
        WHERE overlay.settlement_event_id IS NULL
          AND message.session_id = ${sessionA}
          AND message.type = 'assistant'
        ORDER BY overlay.message_id, overlay.call_id
      `)
      expect(plan.map((row) => row.detail).join("\n")).toContain(
        "session_message_tool_overlay_unsettled_idx",
      )
    }),
  )
})
