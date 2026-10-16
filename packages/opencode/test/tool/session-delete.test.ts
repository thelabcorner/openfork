import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Project } from "@/project/project"
import { Question } from "@/question"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { SessionTool } from "@/tool/session"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    Project.node,
    Question.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
  ]),
)

const it = testEffect(layer)

const ctx = (sessionID: SessionID, messageID: MessageID) => ({
  sessionID,
  messageID,
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [] as SessionV1.WithParts[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

type CreateInput = Parameters<Session.Interface["create"]>[0]

const createSession = Effect.fn("SessionDeleteTest.createSession")(function* (input: CreateInput) {
  const test = yield* TestInstance
  const sessions = yield* Session.Service
  return yield* provideInstance(test.directory)(sessions.create(input))
})

/** Public Session creation strips producer-owned metadata, so stamp it like the real provisioner. */
const markSpecialAgent = Effect.fn("SessionDeleteTest.markSpecialAgent")(function* (input: {
  sessionID: SessionID
  ownerID: SessionID
}) {
  const database = yield* Database.Service
  yield* database.db
    .update(SessionTable)
    .set({
      metadata: SessionMetadataOwnership.specialAgent({
        agent: "prompt_revisor",
        ownerKind: "session",
        ownerID: String(input.ownerID),
      }),
    })
    .where(eq(SessionTable.id, input.sessionID))
    .run()
    .pipe(Effect.orDie)
})

const runDelete = Effect.fn("SessionDeleteTest.runDelete")(function* (input: {
  callerID: SessionID
  params?: Record<string, unknown>
}) {
  const test = yield* TestInstance
  const toolInfo = yield* provideInstance(test.directory)(Tool.init(yield* SessionTool))
  const result = yield* provideInstance(test.directory)(
    toolInfo.execute({ action: "delete", ...(input.params ?? {}) } as any, ctx(input.callerID, MessageID.ascending())),
  )
  return { result, output: JSON.parse(result.output) as { deleted: boolean; sessionId: string; title: string; deletedChildren: number } }
})

const deleteMessage = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")

describe("session tool delete action", () => {
  it.instance("Dreamer caps broad discovery requests and marks historical status as unobserved", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const caller = yield* createSession({ title: "Dreamer discovery" })
      const other = yield* createSession({ title: "Historical decision" })
      const tool = yield* provideInstance(test.directory)(Tool.init(yield* SessionTool))
      const context = { ...ctx(caller.id, MessageID.ascending()), agent: "dreamer" }
      const listed = yield* provideInstance(test.directory)(tool.execute({
        action: "list", scope: "project", limit: 100,
      } as any, context))
      expect(JSON.parse(listed.output)).toMatchObject({ limitCapped: true, effectiveLimit: 20 })
      const found = yield* provideInstance(test.directory)(tool.execute({
        action: "search", scope: "project", query: "Historical decision", limit: 100,
      } as any, context))
      expect(JSON.parse(found.output)).toMatchObject({ limitCapped: true, effectiveLimit: 20 })
      const historical = yield* provideInstance(test.directory)(tool.execute({
        action: "get", sessionId: other.id,
      } as any, context))
      expect(JSON.parse(historical.output).session).toMatchObject({ id: other.id, status: "unobserved" })
    }),
  )

  it.instance("Dreamer rejects bulk live-status fanout and waiting through the real Session leaf", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const caller = yield* createSession({ title: "Dreamer bounded inspection" })
      const target = yield* createSession({ title: "Existing historical Session" })
      const tool = yield* provideInstance(test.directory)(Tool.init(yield* SessionTool))
      const context = { ...ctx(caller.id, MessageID.ascending()), agent: "dreamer" }
      for (const params of [
        { action: "list", scope: "project", withStatus: true },
        { action: "status", sessionId: target.id },
        { action: "messages", sessionId: target.id, wait: true },
      ] as const) {
        const denied = yield* provideInstance(test.directory)(tool.execute(params as any, context)).pipe(Effect.exit)
        expect(Exit.isFailure(denied)).toBe(true)
        if (Exit.isFailure(denied)) expect(Cause.pretty(denied.cause)).toContain("Dreamer may only inspect")
      }
    }),
  )

  it.instance("Dreamer cannot delete a Session despite direct leaf invocation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const caller = yield* createSession({ title: "Dreamer caller" })
      const target = yield* createSession({ title: "Preserve target" })
      const tool = yield* provideInstance(test.directory)(Tool.init(yield* SessionTool))
      const context = { ...ctx(caller.id, MessageID.ascending()), agent: "dreamer" }
      const exit = yield* provideInstance(test.directory)(
        tool.execute({ action: "delete", sessionId: String(target.id) } as any, context),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(deleteMessage(exit)).toContain("Dreamer may only inspect")
      const preserved = yield* provideInstance(test.directory)((yield* Session.Service).get(target.id))
      expect(preserved.id).toBe(target.id)
    }),
  )
  it.instance("Dreamer refuses global search, index repair, and non-inspection Session actions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const caller = yield* createSession({ title: "Read-only Dreamer" })
      const tool = yield* provideInstance(test.directory)(Tool.init(yield* SessionTool))
      const context = { ...ctx(caller.id, MessageID.ascending()), agent: "dreamer" }
      for (const params of [
        { action: "search", query: "prior decisions", scope: "global" },
        { action: "search", query: "prior decisions", scope: "project", repairIndex: true },
        { action: "children" },
        { action: "oxp" },
      ]) {
        const exit = yield* provideInstance(test.directory)(tool.execute(params as any, context)).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(deleteMessage(exit)).toContain("Dreamer may only inspect")
      }
    }),
  )
  it.instance("deletes a session and reports its direct children", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const caller = yield* createSession({ title: "Caller" })
      const parent = yield* createSession({ title: "Old parent" })
      const child = yield* createSession({ title: "Old child", parentID: parent.id })

      const { result, output } = yield* runDelete({ callerID: caller.id, params: { sessionId: String(parent.id) } })
      expect(result.title).toBe("Delete session")
      expect(result.metadata).toMatchObject({ action: "delete", sessionId: parent.id, count: 1 })
      expect(output).toMatchObject({ deleted: true, sessionId: parent.id, title: "Old parent", deletedChildren: 1 })

      const sessions = yield* Session.Service
      for (const id of [parent.id, child.id]) {
        const gone = yield* Effect.exit(provideInstance(test.directory)(sessions.get(id)))
        expect(Exit.isFailure(gone)).toBe(true)
      }
      const survivor = yield* provideInstance(test.directory)(sessions.get(caller.id))
      expect(survivor.id).toBe(caller.id)
    }),
  )

  it.instance("refuses to delete the calling session", () =>
    Effect.gen(function* () {
      const caller = yield* createSession({ title: "Caller" })
      const exit = yield* Effect.exit(runDelete({ callerID: caller.id, params: { sessionId: String(caller.id) } }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(deleteMessage(exit)).toContain("Refusing to delete the calling session")
    }),
  )

  it.instance("refuses producer-owned sessions", () =>
    Effect.gen(function* () {
      const caller = yield* createSession({ title: "Caller" })
      const owned = yield* createSession({ title: "Special agent transcript" })
      yield* markSpecialAgent({ sessionID: owned.id, ownerID: caller.id })
      const exit = yield* Effect.exit(runDelete({ callerID: caller.id, params: { sessionId: String(owned.id) } }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(deleteMessage(exit)).toContain("producer-owned")
    }),
  )

  it.instance("reports not found for an unknown session", () =>
    Effect.gen(function* () {
      const caller = yield* createSession({ title: "Caller" })
      const exit = yield* Effect.exit(runDelete({ callerID: caller.id, params: { sessionId: "ses_missing" } }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(deleteMessage(exit)).toContain("Session not found")
    }),
  )

  it.instance("requires sessionId and rejects unrelated params", () =>
    Effect.gen(function* () {
      const caller = yield* createSession({ title: "Caller" })
      const missing = yield* Effect.exit(runDelete({ callerID: caller.id }))
      expect(Exit.isFailure(missing)).toBe(true)
      expect(deleteMessage(missing)).toContain("sessionId is required for delete")

      const limited = yield* Effect.exit(runDelete({ callerID: caller.id, params: { sessionId: String(caller.id), limit: 5 } }))
      expect(Exit.isFailure(limited)).toBe(true)
      expect(deleteMessage(limited)).toContain("limit is not valid for delete")
    }),
  )
})
