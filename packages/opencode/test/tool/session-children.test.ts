import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Project } from "@/project/project"
import { Question } from "@/question"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SubagentSupervisionMetadata } from "@/session/subagent-supervision-metadata"
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

type ChildrenOutput = {
  parentId: string
  groupId?: string
  workers: Array<{
    sessionId: string
    mode: string
    agent?: string
    description?: string
    status: string
    blocked: string
    latestActivity?: string
    lastTool?: string
    pendingPermission?: string
    pendingQuestion?: string
    tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
    cost: number
    updatedAt: number
    terminal?: { state: string; summary?: string; error?: string }
  }>
  truncated?: boolean
}

const ctx = (sessionID: SessionID, messageID: MessageID) => ({
  sessionID,
  messageID,
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [] as SessionV1.WithParts[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const supervisorEnvelope = (input: { parentID: SessionID; groupID: string; description: string }) =>
  SubagentSupervisionMetadata.withTaskDelegation({
    mode: "supervisor",
    supervisorSessionID: String(input.parentID),
    supervisionGroupID: input.groupID,
    description: input.description,
    createdFromMessageID: "msg_parent",
  })

type CreateInput = Parameters<Session.Interface["create"]>[0]

const createSession = Effect.fn("SessionChildrenTest.createSession")(function* (input: CreateInput) {
  const test = yield* TestInstance
  const sessions = yield* Session.Service
  return yield* provideInstance(test.directory)(sessions.create(input))
})

/** Create a child session with optional durable supervision metadata and a final assistant text. */
const makeChild = Effect.fn("SessionChildrenTest.makeChild")(function* (input: {
  parentID: SessionID
  title: string
  agent?: string
  metadata?: Record<string, unknown>
  finalText?: string
  tokens?: { input: number; output: number }
  cost?: number
}) {
  const sessions = yield* Session.Service
  const child = yield* createSession({
    parentID: input.parentID,
    title: input.title,
    agent: input.agent ?? "general",
    ...(input.metadata ? { metadata: input.metadata } : {}),
  })
  if (input.tokens || input.cost) {
    const database = yield* Database.Service
    yield* database.db
      .update(SessionTable)
      .set({
        tokens_input: input.tokens?.input ?? 0,
        tokens_output: input.tokens?.output ?? 0,
        cost: input.cost ?? 0,
      })
      .where(eq(SessionTable.id, child.id))
      .run()
      .pipe(Effect.orDie)
  }
  if (input.finalText !== undefined) {
    const assistant: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: child.id,
      mode: "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: "test-model" as any,
      providerID: "test" as any,
      time: { created: Date.now() },
    }
    yield* sessions.updateMessage(assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: child.id,
      messageID: assistant.id,
      type: "text",
      text: input.finalText,
    } as any)
  }
  return child
})

const runChildren = Effect.fn("SessionChildrenTest.runChildren")(function* (input: {
  parentID: SessionID
  params?: Record<string, unknown>
}) {
  const test = yield* TestInstance
  const toolInfo = yield* provideInstance(test.directory)(Tool.init(yield* SessionTool))
  const result = yield* provideInstance(test.directory)(
    toolInfo.execute(
      { action: "children", ...(input.params ?? {}) } as any,
      ctx(input.parentID, MessageID.ascending()),
    ),
  )
  return JSON.parse(result.output) as ChildrenOutput
})

type MessagesOutput = {
  sessionId: string
  status: { type: string }
  temporal: {
    retrievedAt: number
    retrievedAtIso: string
    order: "oldest_to_newest"
    window: string
    oldestAt?: number
    oldestAtIso?: string
    newestAt?: number
    newestAtIso?: string
  }
  messages: Array<{
    id: string
    role: "user" | "assistant"
    kind: string
    owner?: string
    source?: string
    createdAt: number
    createdAtIso: string
    ageMs: number
    completedAt?: number
    completedAtIso?: string
    agent?: string
    model?: string
    variant?: string
    synthetic?: boolean
    text: string
  }>
  truncated?: boolean
}

const runMessages = Effect.fn("SessionToolMessagesTest.runMessages")(function* (input: {
  sessionID: SessionID
  params?: Record<string, unknown>
  agent?: string
}) {
  const test = yield* TestInstance
  const toolInfo = yield* provideInstance(test.directory)(Tool.init(yield* SessionTool))
  const result = yield* provideInstance(test.directory)(
    toolInfo.execute(
      { action: "messages", sessionId: String(input.sessionID), ...(input.params ?? {}) } as any,
      { ...ctx(input.sessionID, MessageID.ascending()), agent: input.agent ?? "build" },
    ),
  )
  return JSON.parse(result.output) as MessagesOutput
})

/** Public Session creation strips producer-owned metadata, so stamp it like the real provisioner. */
const markSpecialAgent = Effect.fn("SessionToolMessagesTest.markSpecialAgent")(function* (input: {
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

const seedCurrentMessage = Effect.fn("SessionToolMessagesTest.seedCurrentMessage")(function* (input: {
  sessionID: SessionID
  seq: number
  type: "system" | "synthetic" | "assistant" | "user"
  data: Record<string, unknown>
}) {
  const database = yield* Database.Service
  yield* database.db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.create(),
      session_id: input.sessionID,
      type: input.type,
      seq: input.seq,
      data: input.data as any,
      search_text: "",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("session tool children action", () => {
  it.instance("returns all supervised workers of a parent in one call", () =>
    Effect.gen(function* () {
      const parent = yield* createSession({ title: "Supervisor" })

      yield* makeChild({
        parentID: parent.id,
        title: "worker a",
        metadata: supervisorEnvelope({ parentID: parent.id, groupID: "sup:cohort", description: "parser audit" }),
        finalText: "Found a race in TaskRegistry while auditing.",
        tokens: { input: 100, output: 40 },
        cost: 0.25,
      })
      yield* makeChild({
        parentID: parent.id,
        title: "worker b",
        metadata: supervisorEnvelope({ parentID: parent.id, groupID: "sup:cohort", description: "fixture review" }),
        finalText: "Need an external fixture to continue.",
      })

      const out = yield* runChildren({ parentID: parent.id })
      expect(out.parentId).toBe(String(parent.id))
      expect(out.workers.length).toBe(2)
      for (const worker of out.workers) {
        expect(worker.mode).toBe("supervisor")
        expect(worker.status).toBeDefined()
        expect(worker.blocked).toBeDefined()
        expect(worker.updatedAt).toBeGreaterThan(0)
      }
      const byDescription = new Map(out.workers.map((w) => [w.description, w]))
      expect(byDescription.get("parser audit")?.agent).toBe("general")
      expect(byDescription.get("parser audit")?.latestActivity).toContain("TaskRegistry")
      expect(byDescription.get("parser audit")?.tokens.input).toBe(100)
      expect(byDescription.get("parser audit")?.cost).toBe(0.25)
    }),
  )

  it.instance("defaults parentId to the current session", () =>
    Effect.gen(function* () {
      const parent = yield* createSession({ title: "Current supervisor" })
      yield* makeChild({
        parentID: parent.id,
        title: "worker",
        metadata: supervisorEnvelope({ parentID: parent.id, groupID: "sup:default", description: "default parent" }),
        finalText: "working",
      })

      const out = yield* runChildren({ parentID: parent.id, params: {} })
      expect(out.parentId).toBe(String(parent.id))
      expect(out.workers.length).toBe(1)
      expect(out.workers[0]!.description).toBe("default parent")
    }),
  )

  it.instance("groupId filters to exactly one supervision cohort", () =>
    Effect.gen(function* () {
      const parent = yield* createSession({ title: "Supervisor" })

      yield* makeChild({
        parentID: parent.id,
        title: "g1-a",
        metadata: supervisorEnvelope({ parentID: parent.id, groupID: "sup:one", description: "cohort one a" }),
      })
      yield* makeChild({
        parentID: parent.id,
        title: "g1-b",
        metadata: supervisorEnvelope({ parentID: parent.id, groupID: "sup:one", description: "cohort one b" }),
      })
      yield* makeChild({
        parentID: parent.id,
        title: "g2-a",
        metadata: supervisorEnvelope({ parentID: parent.id, groupID: "sup:two", description: "cohort two a" }),
      })

      const one = yield* runChildren({ parentID: parent.id, params: { groupId: "sup:one" } })
      expect(one.groupId).toBe("sup:one")
      expect(one.workers.map((w) => w.description).sort()).toEqual(["cohort one a", "cohort one b"])

      const two = yield* runChildren({ parentID: parent.id, params: { groupId: "sup:two" } })
      expect(two.workers.map((w) => w.description)).toEqual(["cohort two a"])

      const none = yield* runChildren({ parentID: parent.id, params: { groupId: "sup:missing" } })
      expect(none.workers.length).toBe(0)
    }),
  )

  it.instance("reports legacy background children with mode background", () =>
    Effect.gen(function* () {
      const parent = yield* createSession({ title: "Supervisor" })
      // Legacy background child: no supervision envelope, only the legacy
      // background metadata flag.
      yield* makeChild({
        parentID: parent.id,
        title: "legacy background",
        metadata: { background: true },
        finalText: "legacy worker result",
      })

      const out = yield* runChildren({ parentID: parent.id })
      expect(out.workers.length).toBe(1)
      expect(out.workers[0]!.mode).toBe("background")
      expect(out.workers[0]!.description).toBe("legacy background")
    }),
  )

  it.instance("marks foreground children and completed terminal state", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const parent = yield* createSession({ title: "Supervisor" })
      const child = yield* makeChild({
        parentID: parent.id,
        title: "worker done",
        finalText: "Completed the audit; no issues found in the parser layer.",
      })
      // A completed foreground job carries the terminal summary. Use the job id
      // as the worker session id, matching the delegation runtime convention.
      yield* background.start({
        id: String(child.id),
        type: "delegated-worker",
        title: "worker done",
        metadata: { sessionID: String(child.id), background: false },
        run: Effect.succeed("Completed the audit; no issues found in the parser layer."),
      })
      yield* background.wait({ id: String(child.id), timeout: 1000 })

      const out = yield* runChildren({ parentID: parent.id })
      const worker = out.workers.find((w) => w.sessionId === String(child.id))
      expect(worker?.mode).toBe("foreground")
      expect(worker?.blocked).toBe("completed")
      expect(worker?.terminal?.state).toBe("completed")
      expect(worker?.terminal?.summary).toContain("Completed the audit")
    }),
  )

  it.instance("surfaces live busy status and working classification for a running supervised worker", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const statuses = yield* SessionStatus.Service
      const parent = yield* createSession({ title: "Supervisor" })
      const child = yield* makeChild({
        parentID: parent.id,
        title: "worker live",
        metadata: supervisorEnvelope({ parentID: parent.id, groupID: "sup:live", description: "live worker" }),
        finalText: "Auditing the registry now.",
      })
      yield* statuses.set(child.id, { type: "busy" })
      yield* background.start({
        id: String(child.id),
        type: "delegated-worker",
        title: "worker live",
        metadata: { sessionID: String(child.id), background: true },
        run: Effect.never,
      })

      const out = yield* runChildren({ parentID: parent.id })
      const worker = out.workers.find((w) => w.sessionId === String(child.id))
      expect(worker?.mode).toBe("supervisor")
      expect(worker?.status).toBe("busy")
      expect(worker?.blocked).toBe("working")
      expect(worker?.terminal).toBeUndefined()
      expect(worker?.latestActivity).toContain("Auditing the registry")
    }),
  )

  it.instance("bounds the snapshot and truncates activity", () =>
    Effect.gen(function* () {
      const parent = yield* createSession({ title: "Supervisor" })
      const longText = "x".repeat(5_000)
      for (let i = 0; i < 6; i++) {
        yield* makeChild({
          parentID: parent.id,
          title: `worker ${i}`,
          metadata: supervisorEnvelope({ parentID: parent.id, groupID: "sup:bounded", description: `worker ${i}` }),
          finalText: longText,
        })
      }

      const out = yield* runChildren({ parentID: parent.id, params: { limit: 2 } })
      expect(out.workers.length).toBe(2)
      expect(out.truncated).toBe(true)
      for (const worker of out.workers) {
        expect(worker.latestActivity!.length).toBeLessThanOrEqual(620)
        expect(worker.latestActivity).not.toBe(longText)
      }
    }),
  )

  it.instance("keeps completed workers inspectable and never returns full transcripts", () =>
    Effect.gen(function* () {
      const parent = yield* createSession({ title: "Supervisor" })
      const marker = "TRANSCRIPT_MARKER_0123456789"
      yield* makeChild({
        parentID: parent.id,
        title: "completed worker",
        metadata: supervisorEnvelope({ parentID: parent.id, groupID: "sup:done", description: "completed worker" }),
        finalText: `short summary ${marker}`,
      })

      const out = yield* runChildren({ parentID: parent.id })
      expect(out.workers.length).toBe(1)
      expect(out.workers[0]!.latestActivity).toContain("short summary")
      expect((out.workers[0]!.latestActivity ?? "").length).toBeLessThanOrEqual(620)
      // No transcript / history array of any kind is present in the payload.
      expect(out).not.toHaveProperty("messages")
      expect((out as any).workers[0]).not.toHaveProperty("messages")
      expect((out as any).workers[0]).not.toHaveProperty("parts")
    }),
  )

  it.instance("rejects groupId on actions other than children", () =>
    Effect.gen(function* () {
      const toolInfo = yield* Tool.init(yield* SessionTool)
      const exit = yield* toolInfo
        .execute({ action: "list", groupId: "sup:x" } as any, ctx(SessionID.make("ses_x"), MessageID.ascending()))
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})

describe("session tool messages action", () => {
  it.instance("Dreamer real Session leaf excerpts oversized history with accountable omissions", () =>
    Effect.gen(function* () {
      const parent = yield* createSession({ title: "Historical owner" })
      const full = "CLAIM_START " + "x".repeat(75_000) + " VERIFIED_END"
      const child = yield* makeChild({ parentID: parent.id, title: "Historical evidence", agent: "dreamer", finalText: full })
      const inspected = yield* runMessages({ sessionID: child.id, agent: "dreamer" })
      expect(inspected.truncated).toBe(true)
      expect(inspected.status).toMatchObject({ type: "unobserved" })
      expect(inspected.messages).toHaveLength(1)
      expect(inspected.messages[0]!.id).toBeString()
      expect(Buffer.byteLength(JSON.stringify(inspected.messages[0]!.text), "utf8") - 2).toBeLessThanOrEqual(6_000)
      expect(inspected.messages[0]!.text.startsWith("CLAIM_START")).toBe(true)
      expect(inspected.messages[0]!.text.endsWith("VERIFIED_END")).toBe(true)
      expect((inspected.messages[0] as any).textTruncated).toBe(true)
      expect((inspected.messages[0] as any).omittedCharacters).toBeGreaterThan(full.length - 6_000)
      const capped = yield* runMessages({ sessionID: child.id, agent: "dreamer", params: { limit: 100 } })
      expect((capped as any).limitCapped).toBe(true)
      expect((capped as any).requestedMessageLimit).toBe(100)
      expect((capped as any).effectiveMessageLimit).toBe(12)
      expect(capped.messages).toHaveLength(1)
    }),
  )

  it.instance("reads a special-agent transcript that only exists in session_message rows", () =>
    Effect.gen(function* () {
      const parent = yield* createSession({ title: "Owner" })
      const transcript = yield* createSession({ title: "Prompt Revisor" })
      yield* markSpecialAgent({ sessionID: transcript.id, ownerID: parent.id })

      const now = Date.now()
      yield* seedCurrentMessage({
        sessionID: transcript.id,
        seq: 1,
        type: "system",
        data: { time: { created: now }, text: "SYSTEM_INSTRUCTION" },
      })
      yield* seedCurrentMessage({
        sessionID: transcript.id,
        seq: 2,
        type: "synthetic",
        data: {
          time: { created: now + 1 },
          provenance: { owner: "host", source: "special-agent.prompt-revisor" },
          sessionID: transcript.id,
          text: "HOST_CONTEXT",
        },
      })
      yield* seedCurrentMessage({
        sessionID: transcript.id,
        seq: 3,
        type: "assistant",
        data: {
          time: { created: now + 2, completed: now + 3 },
          agent: "prompt_revisor",
          model: { id: "test-model", providerID: "test" },
          content: [{ type: "reasoning", id: "reasoning-0", text: "HIDDEN_REASONING" }],
        },
      })
      yield* seedCurrentMessage({
        sessionID: transcript.id,
        seq: 4,
        type: "assistant",
        data: {
          time: { created: now + 4 },
          agent: "prompt_revisor",
          model: { id: "test-model", providerID: "test" },
          content: [{ type: "text", id: "text-0", text: "REVISED_DRAFT" }],
        },
      })

      const withSynthetic = yield* runMessages({ sessionID: transcript.id, params: { includeSynthetic: true } })
      expect(withSynthetic.status).toMatchObject({ type: "idle" })
      expect(withSynthetic.temporal).toMatchObject({
        retrievedAt: expect.any(Number),
        retrievedAtIso: expect.any(String),
        order: "oldest_to_newest",
        window: "latest_matching_messages",
        oldestAt: now,
        oldestAtIso: new Date(now).toISOString(),
        newestAt: now + 4,
        newestAtIso: new Date(now + 4).toISOString(),
      })
      expect(withSynthetic.messages.map((m) => m.text)).toEqual([
        "SYSTEM_INSTRUCTION",
        "HOST_CONTEXT",
        "REVISED_DRAFT",
      ])
      expect(withSynthetic.messages[0]).toMatchObject({ role: "user", kind: "synthetic", synthetic: true })
      expect(withSynthetic.messages[1]).toMatchObject({
        role: "user",
        kind: "synthetic",
        owner: "host",
        source: "special-agent.prompt-revisor",
        synthetic: true,
      })
      expect(withSynthetic.messages[2]).toMatchObject({
        role: "assistant",
        kind: "assistant",
        model: "test/test-model",
        createdAtIso: new Date(now + 4).toISOString(),
        ageMs: expect.any(Number),
      })
      expect(withSynthetic.messages.some((m) => m.text.includes("HIDDEN_REASONING"))).toBe(false)

      const withoutSynthetic = yield* runMessages({ sessionID: transcript.id })
      expect(withoutSynthetic.messages.map((m) => m.text)).toEqual(["REVISED_DRAFT"])

      const assistants = yield* runMessages({
        sessionID: transcript.id,
        params: { role: "assistant", includeSynthetic: true },
      })
      expect(assistants.messages.map((m) => m.text)).toEqual(["REVISED_DRAFT"])

      const users = yield* runMessages({ sessionID: transcript.id, params: { role: "user", includeSynthetic: true } })
      expect(users.messages.length).toBe(0)
    }),
  )

  it.instance("keeps ordinary V1 session message reads unchanged", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* createSession({ title: "Ordinary" })

      const hostTurn: SessionV1.User = {
        id: MessageID.ascending(),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test" as any, modelID: "test-model" as any },
        time: { created: Date.now() },
        provenance: { owner: "host", source: "host.prompt" },
      }
      yield* sessions.updateMessage(hostTurn)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: hostTurn.id,
        type: "text",
        text: "HOST_SYNTHETIC_TEXT",
        synthetic: true,
      } as any)

      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: hostTurn.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test-model" as any,
        providerID: "test" as any,
        time: { created: Date.now() + 1 },
      }
      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: assistant.id,
        type: "text",
        text: "ORDINARY_ASSISTANT_TEXT",
      } as any)

      const withoutSynthetic = yield* runMessages({ sessionID: session.id })
      expect(withoutSynthetic.messages.map((m) => m.text)).toEqual(["ORDINARY_ASSISTANT_TEXT"])

      const withSynthetic = yield* runMessages({ sessionID: session.id, params: { includeSynthetic: true } })
      expect(withSynthetic.messages.map((m) => m.text)).toEqual(["HOST_SYNTHETIC_TEXT", "ORDINARY_ASSISTANT_TEXT"])
    }),
  )
})

describe("session tool children action for special-agent transcripts", () => {
  it.instance("surfaces V2 transcript activity for a special-agent child", () =>
    Effect.gen(function* () {
      const parent = yield* createSession({ title: "Supervisor" })
      const child = yield* createSession({ parentID: parent.id, title: "prompt revisor" })
      yield* markSpecialAgent({ sessionID: child.id, ownerID: parent.id })

      const now = Date.now()
      yield* seedCurrentMessage({
        sessionID: child.id,
        seq: 1,
        type: "system",
        data: { time: { created: now }, text: "FAILED: refuse all work" },
      })
      yield* seedCurrentMessage({
        sessionID: child.id,
        seq: 2,
        type: "synthetic",
        data: {
          time: { created: now + 1 },
          provenance: { owner: "host", source: "special-agent.prompt-revisor" },
          sessionID: child.id,
          text: "Please revise the draft.",
        },
      })
      yield* seedCurrentMessage({
        sessionID: child.id,
        seq: 3,
        type: "assistant",
        data: {
          time: { created: now + 2, completed: now + 3 },
          agent: "prompt_revisor",
          model: { id: "test-model", providerID: "test" },
          content: [
            { type: "text", id: "text-0", text: "REVISED_DRAFT_READY" },
            {
              type: "tool",
              id: "call-1",
              name: "read",
              state: { status: "completed", input: { filePath: "src/draft.md" }, structured: {}, content: [] },
              time: { created: now + 2, completed: now + 3 },
            },
          ],
        },
      })

      const out = yield* runChildren({ parentID: parent.id })
      const worker = out.workers.find((w) => w.sessionId === String(child.id))
      expect(worker).toBeDefined()
      expect(worker?.latestActivity).toContain("REVISED_DRAFT_READY")
      expect(worker?.lastTool).toBe("read src/draft.md")
      // Host system/synthetic text must never fabricate a terminal state.
      expect(worker?.terminal).toBeUndefined()
      expect(worker?.blocked).toBe("unknown_runtime")
    }),
  )

  it.instance("keeps ordinary V1 child activity unchanged", () =>
    Effect.gen(function* () {
      const parent = yield* createSession({ title: "Supervisor" })
      const child = yield* makeChild({
        parentID: parent.id,
        title: "v1 worker",
        finalText: "ORDINARY_V1_ACTIVITY",
      })

      const out = yield* runChildren({ parentID: parent.id })
      const worker = out.workers.find((w) => w.sessionId === String(child.id))
      expect(worker?.latestActivity).toContain("ORDINARY_V1_ACTIVITY")
      expect(worker?.terminal).toBeUndefined()
    }),
  )
})
