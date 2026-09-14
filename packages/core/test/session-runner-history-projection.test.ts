import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { makeRunnerHistoryProjection } from "@opencode-ai/core/session/runner/history-projection"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const projectDir = AbsolutePath.make("/project")

const setup = Effect.fnUntraced(function* (sessionID: SessionV2.ID) {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: projectDir, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: projectDir,
      title: "test",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return { ...database, events }
})

const prompt = (events: EventV2.Interface, sessionID: SessionV2.ID, id: string, text: string, timestamp: number) =>
  events.publish(SessionEvent.Prompted, {
    sessionID,
    messageID: SessionMessage.ID.make(id),
    timestamp: DateTime.makeUnsafe(timestamp),
    prompt: Prompt.make({ text }),
    delivery: "steer",
  })

describe("active runner history projection", () => {
  it.effect("buffers pre-snapshot commits exactly once and then appends aggregate-local commits inline", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_runner_history_buffer")
      const { readDb, events } = yield* setup(sessionID)
      const history = yield* makeRunnerHistoryProjection({ events, readDb, sessionID })

      // The listener is active before the first authoritative snapshot. This
      // commit is both present in SQLite and buffered by the listener; the
      // frontier handshake must not duplicate it.
      yield* prompt(events, sessionID, "msg_one", "one", 1)
      expect((yield* history.entries(-1)).map((entry) => entry.message.id)).toEqual([
        SessionMessage.ID.make("msg_one"),
      ])

      // Once warm, publication updates the active Session projection inline.
      yield* prompt(events, sessionID, "msg_two", "two", 2)
      expect((yield* history.entries(-1)).map((entry) => entry.message.id)).toEqual([
        SessionMessage.ID.make("msg_one"),
        SessionMessage.ID.make("msg_two"),
      ])

      yield* history.close
    }),
  )

  it.effect("updates the current assistant without reloading historical rows", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_runner_history_assistant")
      const otherID = SessionV2.ID.make("ses_runner_history_other")
      const { readDb, events } = yield* setup(sessionID)
      yield* setup(otherID)
      yield* prompt(events, sessionID, "msg_user", "hello", 1)
      const assistantID = SessionMessage.ID.make("msg_assistant")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(2),
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(3),
        textID: "text_one",
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(4),
        textID: "text_one",
        text: "first",
      })

      const history = yield* makeRunnerHistoryProjection({ events, readDb, sessionID })
      expect((yield* history.entries(-1)).map((entry) => entry.message.id)).toEqual([
        SessionMessage.ID.make("msg_user"),
        assistantID,
      ])

      yield* events.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(5),
        textID: "text_two",
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(6),
        textID: "text_two",
        text: "second",
      })
      // A different Session's durable commit must never enter this projection.
      yield* prompt(events, otherID, "msg_other", "other", 7)

      const assistant = (yield* history.entries(-1)).find((entry) => entry.message.id === assistantID)?.message
      expect(assistant?.type).toBe("assistant")
      if (assistant?.type !== "assistant") throw new Error("assistant missing")
      expect(assistant.content.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
        "first",
        "second",
      ])
      expect((yield* history.entries(-1)).some((entry) => entry.message.id === "msg_other")).toBe(false)

      yield* history.close
    }),
  )

  it.effect("tracks compaction and reverts without losing pre-compaction rows held by the active drain", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_runner_history_revert")
      const { readDb, events } = yield* setup(sessionID)
      yield* prompt(events, sessionID, "msg_a", "a", 1)
      yield* prompt(events, sessionID, "msg_b", "b", 2)
      yield* prompt(events, sessionID, "msg_c", "c", 3)
      const history = yield* makeRunnerHistoryProjection({ events, readDb, sessionID })
      expect((yield* history.entries(-1)).map((entry) => entry.message.id)).toEqual([
        SessionMessage.ID.make("msg_a"),
        SessionMessage.ID.make("msg_b"),
        SessionMessage.ID.make("msg_c"),
      ])

      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_compaction"),
        timestamp: DateTime.makeUnsafe(4),
        reason: "manual",
        text: "summary",
        recent: "recent",
      })
      expect((yield* history.entries(-1)).map((entry) => entry.message.type)).toEqual(["compaction"])

      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_b"),
        timestamp: DateTime.makeUnsafe(5),
      })
      expect((yield* history.entries(-1)).map((entry) => entry.message.id)).toEqual([
        SessionMessage.ID.make("msg_a"),
        SessionMessage.ID.make("msg_b"),
      ])

      yield* history.close
    }),
  )
})
