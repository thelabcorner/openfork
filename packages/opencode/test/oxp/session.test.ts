import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { partSearchText } from "@opencode-ai/core/session/search-text"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { OxpConfig } from "@/oxp/config"
import { OxpRoot } from "@/oxp/root"
import { OxpSession } from "@/oxp/session"
import { OxpSessionControl } from "@/oxp/session-control"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-session-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
type ControlCall =
  | { action: "pause" | "resume" | "abort" | "archive" | "unarchive" | "delete"; target: OxpSessionControl.Target }
  | {
      action: "set_selection"
      target: OxpSessionControl.Target
      input: OxpSessionControl.SelectionInput
    }
  | {
      action: "send" | "turn"
      target: OxpSessionControl.Target
      input: OxpSessionControl.PromptInput
    }
  | {
      action: "background_subagents"
      target: OxpSessionControl.Target
    }
  | {
      action: "checkpoint"
      target: OxpSessionControl.Target
      input: OxpSessionControl.CheckpointInput
    }
  | {
      action: "goal"
      target: OxpSessionControl.Target
      input: Parameters<OxpSessionControl.Interface["goal"]>[1]
    }

const controlCalls: ControlCall[] = []
let cancelTurnWait = false
let turnFailure: Error | undefined
let goalFailure: Error | undefined
let supervisedTodos: Array<{ content: string; status: string; priority: string }> = []

const guarded = <A>(
  target: OxpSessionControl.Target,
  effect: Effect.Effect<A, Error>,
) =>
  Effect.tryPromise({
    try: () => target.commitGuard?.() ?? Promise.resolve(),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("test commit guard failed"),
  }).pipe(Effect.andThen(effect))

const controlLayer = Layer.succeed(
  OxpSessionControl.Service,
  OxpSessionControl.Service.of({
    pause: (target) =>
      guarded(target, Effect.sync(() => controlCalls.push({ action: "pause", target }))),
    resume: (target) =>
      guarded(target, Effect.sync(() => controlCalls.push({ action: "resume", target }))),
    abort: (target) =>
      guarded(target, Effect.sync(() => controlCalls.push({ action: "abort", target }))),
    archive: (target) =>
      guarded(target, Effect.sync(() => controlCalls.push({ action: "archive", target }))),
    unarchive: (target) =>
      guarded(target, Effect.sync(() => controlCalls.push({ action: "unarchive", target }))),
    delete: (target) =>
      guarded(target, Effect.sync(() => controlCalls.push({ action: "delete", target }))),
    setSelection: (target, input) =>
      guarded(
        target,
        Effect.sync(() => {
          controlCalls.push({ action: "set_selection", target, input })
        }),
      ),
    send: (target, input) =>
      guarded(
        target,
        Effect.sync(() => {
          controlCalls.push({ action: "send", target, input })
          return {
            admittedMessageID: "msg_oxp_send",
            paused: false,
          }
        }),
      ),
    turn: (target, input) =>
      guarded(
        target,
        Effect.gen(function* () {
          controlCalls.push({ action: "turn", target, input })
          if (turnFailure) return yield* Effect.fail(turnFailure)
          if (cancelTurnWait) {
            return yield* Effect.fail(
              new OxpSessionControl.WaitCancelled("msg_oxp_turn"),
            )
          }
          return {
            admittedMessageID: "msg_oxp_turn",
            paused: false,
            resultMessageID: "msg_oxp_result",
          }
        }),
      ),
    backgroundSubagents: (target) =>
      guarded(
        target,
        Effect.sync(() => {
          controlCalls.push({ action: "background_subagents", target })
          return { promoted: 2 }
        }),
      ),
    todoGet: (target) =>
      guarded(target, Effect.succeed(supervisedTodos.map((todo) => ({ ...todo })))),
    todoSet: (target, todos) =>
      guarded(
        target,
        Effect.sync(() => {
          supervisedTodos = todos.map((todo) => ({ ...todo }))
          return supervisedTodos.map((todo) => ({ ...todo }))
        }),
      ),
    checkpoint: (target, input) =>
      guarded(
        target,
        Effect.sync(() => {
          controlCalls.push({ action: "checkpoint", target, input })
          return {
            title: "checkpoint " + (input.mode ?? "list"),
            output: "<checkpoints count=\"0\" />",
            metadata: { mode: input.mode ?? "list", ok: true },
          }
        }),
      ),
    goal: (target, input) =>
      guarded(
        target,
        Effect.gen(function* () {
          controlCalls.push({ action: "goal", target, input })
          if (goalFailure) return yield* Effect.fail(goalFailure)
          return {
            action: input.action,
            goal: {
              goal: {
                id: "goal_fixture",
                projectID: "global",
                title: "Fixture",
                objective: "fixture",
                constraints: [],
                status: "active",
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
              },
              criteria: [],
              steps: [],
              evidence: [],
            },
          } as any
        }),
      ),
  }),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([OxpSession.node, OxpRoot.node, OxpConfig.node, Database.node]),
  [
    [Global.node, Global.layerWith({ config: configDir, state: stateDir })],
    [OxpSessionControl.node, controlLayer],
  ],
)
const it = testEffect(layer)

const approvedID = SessionSchema.ID.make("ses_oxp_approved")
const childID = SessionSchema.ID.make("ses_oxp_child")
const outsideID = SessionSchema.ID.make("ses_oxp_outside")

beforeEach(async () => {
  controlCalls.length = 0
  cancelTurnWait = false
  turnFailure = undefined
  goalFailure = undefined
  supervisedTodos = []
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

const seed = (approvedDir: string, outsideDir: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db
      .insert(ProjectTable)
      .values({
        id: Project.ID.global,
        worktree: AbsolutePath.make(approvedDir),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    yield* db
      .insert(SessionTable)
      .values([
        {
          id: approvedID,
          project_id: Project.ID.global,
          slug: "approved",
          directory: approvedDir,
          title: "Approved Session",
          version: "test",
          model: {
            providerID: "workbuddy",
            id: "deepseek-v4.1-flash@wb-test-account",
            variant: "max",
          },
          time_created: now - 30,
          time_updated: now - 10,
        },
        {
          id: childID,
          project_id: Project.ID.global,
          parent_id: approvedID,
          slug: "child",
          directory: approvedDir,
          title: "Approved Child",
          version: "test",
          time_created: now - 20,
          time_updated: now - 5,
        },
        {
          id: outsideID,
          project_id: Project.ID.global,
          slug: "outside",
          directory: outsideDir,
          title: "Outside Session",
          version: "test",
          time_created: now - 25,
          time_updated: now,
        },
      ])
      .run()
      .pipe(Effect.orDie)

    const messageID = SessionV1.MessageID.make("msg_oxp_supervision")
    const partID = SessionV1.PartID.make("prt_oxp_supervision")
    yield* db
      .insert(MessageTable)
      .values({
        id: messageID,
        session_id: approvedID,
        time_created: now,
        data: {
          role: "user",
          time: { created: now },
          agent: "build",
          model: { providerID: "workbuddy", modelID: "deepseek-v4.1-flash@wb-test-account" },
        } as never,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(PartTable)
      .values({
        id: partID,
        message_id: messageID,
        session_id: approvedID,
        data: { type: "text", text: "hello from supervised session", time: { start: now } } as never,
        search_text: "hello from supervised session",
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("OxpSession", () => {
  it.live("projects missing native runtime services without erasing the actionable dependency", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([fs.mkdir(approvedDir), fs.mkdir(outsideDir)]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })
    turnFailure = new Error("Service not found: @opencode/core/OfxpPeer")

    const error = yield* sessions.execute({
      action: "turn",
      sessionID: approvedID,
      rootID: root.id,
      text: "exercise dependency projection",
    }).pipe(Effect.flip)

    expect(error._tag).toBe("OXP_DEPENDENCY_UNAVAILABLE")
    expect(error.detail).toContain("@opencode/core/OfxpPeer")
    expect(error.metadata).toMatchObject({
      dependency: "@opencode/core/OfxpPeer",
      nativeError: "Error",
    })
  }))

  it.live("directs host-owned delegated Sessions to openfork_worker instead of retrying Session control", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([fs.mkdir(approvedDir), fs.mkdir(outsideDir)]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })
    turnFailure = new OxpSessionControl.HostOwned(
      String(approvedID),
      String(approvedID),
      "delegated_worker",
    )

    const error = yield* sessions.execute({
      action: "turn",
      sessionID: approvedID,
      rootID: root.id,
      text: "wrong control surface",
    }).pipe(Effect.flip)

    expect(error._tag).toBe("OXP_CONFLICT")
    expect(error.detail).toContain("openfork_worker continue")
    expect(error.metadata).toMatchObject({
      sessionID: approvedID,
      ownerKind: "delegated_worker",
      ownerSurface: "openfork_worker",
    })
  }))

  it.live("supervises checkpoint reads and independently gates restore commits on OXP write authority", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([fs.mkdir(approvedDir), fs.mkdir(outsideDir)]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })

    const listed = yield* sessions.execute({
      action: "checkpoint",
      sessionID: approvedID,
      rootID: root.id,
      checkpoint: { mode: "list" },
    })
    expect(listed.output).toContain("checkpoints")
    expect(controlCalls.at(-1)).toMatchObject({ action: "checkpoint", input: { mode: "list" } })

    const denied = yield* sessions.execute({
      action: "checkpoint",
      sessionID: approvedID,
      rootID: root.id,
      checkpoint: { mode: "restore", checkpointID: "cp_fixture", dryRun: false, confirm: "RESTORE_CHECKPOINT" },
    }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")

    yield* config.setGrant({ write: true })
    const restored = yield* sessions.execute({
      action: "checkpoint",
      sessionID: approvedID,
      rootID: root.id,
      checkpoint: { mode: "restore", checkpointID: "cp_fixture", dryRun: false, confirm: "RESTORE_CHECKPOINT" },
    })
    expect(restored.mutation).toEqual({ attempted: true, committed: true })
  }))

  it.live("routes Goal operations only through an explicitly supervised existing Session", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([fs.mkdir(approvedDir), fs.mkdir(outsideDir)]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })

    const status = yield* sessions.execute({
      action: "goal",
      sessionID: approvedID,
      rootID: root.id,
      goal: { action: "status" },
    })
    expect(status.structured).toMatchObject({ sessionID: approvedID, action: "status" })
    expect(controlCalls.at(-1)).toMatchObject({ action: "goal", input: { action: "status" } })

    goalFailure = new OxpSessionControl.GoalRevisionConflict("goal_fixture", 4, 7)
    const conflict = yield* sessions
      .execute({
        action: "goal",
        sessionID: approvedID,
        rootID: root.id,
        goal: { action: "request_verification", expectedRevision: 4 },
      })
      .pipe(Effect.flip)
    expect(conflict._tag).toBe("OXP_CONFLICT")
    expect(conflict.metadata).toMatchObject({
      goalID: "goal_fixture",
      expectedRevision: 4,
      actualRevision: 7,
    })
    goalFailure = undefined

    const requested = yield* sessions.execute({
      action: "goal",
      sessionID: approvedID,
      rootID: root.id,
      goal: { action: "request_verification", expectedRevision: 1 },
    })
    expect(requested.structured).toMatchObject({
      sessionID: approvedID,
      action: "request_verification",
      verificationDispatch: "scheduled",
    })

    const hidden = yield* sessions.execute({
      action: "goal",
      sessionID: outsideID,
      rootID: root.id,
      goal: { action: "status" },
    }).pipe(Effect.flip)
    expect(hidden._tag).toBe("OXP_NOT_FOUND")
  }))

  it.live("reads and replaces todo state only through an explicitly supervised real Session", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([fs.mkdir(approvedDir), fs.mkdir(outsideDir)]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })

    const empty = yield* sessions.execute({ action: "todo_get", sessionID: approvedID, rootID: root.id })
    expect(empty.structured).toEqual({ sessionID: approvedID, todos: [] })

    const todos = [
      { content: "prove OXP parity", status: "in_progress", priority: "high" },
      { content: "run regressions", status: "pending", priority: "medium" },
    ]
    const updated = yield* sessions.execute({ action: "todo_set", sessionID: approvedID, rootID: root.id, todos })
    expect(updated.structured).toEqual({ sessionID: approvedID, todos })
    expect(updated.mutation).toEqual({ attempted: true, committed: true })

    const hidden = yield* sessions.execute({ action: "todo_get", sessionID: outsideID, rootID: root.id }).pipe(Effect.flip)
    expect(hidden._tag).toBe("OXP_NOT_FOUND")
  }))

  it.live("keeps durable list/get/messages/children bootstrap-free and filters every row through approved-root supervision", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([
      fs.mkdir(approvedDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })

    const listed = yield* sessions.execute({ action: "list", roots: true })
    const listData = listed.structured as { sessions: Array<any> }
    expect(listData.sessions.map((item) => item.id)).toEqual([approvedID])
    expect(JSON.stringify(listed)).not.toContain(approvedDir)
    expect(JSON.stringify(listed)).not.toContain(outsideDir)
    expect(listData.sessions[0]?.location).toEqual({ rootID: root.id, path: "/" + root.alias })
    expect(listData.sessions[0]?.model).toMatchObject({
      providerID: "workbuddy",
      modelID: "deepseek-v4.1-flash",
      accountID: "wb-test-account",
      variant: "max",
    })

    const got = yield* sessions.execute({ action: "get", sessionID: approvedID })
    expect(JSON.stringify(got)).not.toContain(approvedDir)
    const messages = yield* sessions.execute({ action: "messages", sessionID: approvedID })
    expect(messages.output).toContain("hello from supervised session")
    expect(messages.output).toContain('"owner":"user"')
    const children = yield* sessions.execute({ action: "children", sessionID: approvedID })
    expect((children.structured as { sessions: Array<any> }).sessions.map((item) => item.id)).toEqual([childID])
    const selected = yield* sessions.execute({ action: "selection", sessionID: approvedID })
    expect(selected.structured).toMatchObject({
      sessionID: approvedID,
      model: {
        providerID: "workbuddy",
        modelID: "deepseek-v4.1-flash",
        accountID: "wb-test-account",
        variant: "max",
      },
    })

    // All five operations above are Tier 0/1 reads. A regression that enters
    // InstanceStore/SessionPrompt would hit this counter through the host port.
    expect(controlCalls).toEqual([])
  }))

  it.live("scopes Session search before FTS ranking and never leaks unauthorized native paths", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const { db } = yield* Database.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([
      fs.mkdir(approvedDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })

    const toolMessageID = SessionV1.MessageID.make("msg_oxp_search_tool")
    yield* db
      .insert(MessageTable)
      .values({
        id: toolMessageID,
        session_id: approvedID,
        time_created: Date.now(),
        data: { role: "assistant", time: { created: Date.now() } } as never,
      })
      .run()
      .pipe(Effect.orDie)
    const toolPart = SessionV1.ToolPart.make({
      id: SessionV1.PartID.make("prt_oxp_search_tool"),
      sessionID: approvedID,
      messageID: toolMessageID,
      type: "tool",
      callID: "call_oxp_search_read",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "needle.txt" },
        output: "ok",
        title: "read",
        metadata: {},
        time: { start: Date.now(), end: Date.now() + 1 },
      },
    })
    const { id: toolPartID, messageID: _, sessionID: __, ...toolData } = toolPart
    yield* db
      .insert(PartTable)
      .values({
        id: toolPartID,
        message_id: toolMessageID,
        session_id: approvedID,
        time_created: Date.now(),
        data: toolData as never,
        search_text: partSearchText(toolPart),
      })
      .run()
      .pipe(Effect.orDie)

    const outsideMessage = SessionV1.MessageID.make("msg_oxp_outside_rank")
    yield* db
      .insert(MessageTable)
      .values({
        id: outsideMessage,
        session_id: outsideID,
        time_created: Date.now() + 1_000,
        data: { role: "user", time: { created: Date.now() + 1_000 } } as never,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(PartTable)
      .values({
        id: SessionV1.PartID.make("prt_oxp_outside_rank"),
        message_id: outsideMessage,
        session_id: outsideID,
        time_created: Date.now() + 1_000,
        data: {
          type: "text",
          text: "supervised supervised supervised supervised supervised session",
          time: { start: Date.now() + 1_000 },
        } as never,
        search_text: "supervised supervised supervised supervised supervised session",
      })
      .run()
      .pipe(Effect.orDie)

    const result = yield* sessions.execute({
      action: "search",
      rootID: root.id,
      search: "supervised",
      limit: 1,
    })
    const structured = result.structured as {
      sessions: Array<{ sessionId: string; directory: string }>
      coverage: { complete: boolean }
    }

    expect(structured.sessions.map((item) => item.sessionId)).toEqual([approvedID])
    expect(structured.sessions[0]?.directory).toBe("/" + root.alias)
    expect(result.output).not.toContain(outsideID)
    expect(result.output).not.toContain(outsideDir)
    expect(result.output).not.toContain(approvedDir)
    expect(result.mutation).toEqual({ attempted: false, committed: false })
    expect(result.metadata).toMatchObject({ count: 1, authorizedRoots: 1 })
    expect(controlCalls).toEqual([])

    const toolOnly = yield* sessions.execute({
      action: "search",
      rootID: root.id,
      search: "tool:read needle",
      limit: 1,
    })
    expect(toolOnly.mutation).toEqual({ attempted: false, committed: false })
    expect((toolOnly.structured as {
      tool?: string
      hits: { tools: Array<{ partId?: string; tool: string }> }
    })).toMatchObject({
      tool: "read",
      hits: { tools: [{ partId: "prt_oxp_search_tool", tool: "read" }] },
    })
  }))

  it.live("keeps set_selection account identity first-class and attributes control to the OXP connector principal", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([
      fs.mkdir(approvedDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })
    const connector = (yield* config.get()).connector.id

    const updated = yield* sessions.execute({
      action: "set_selection",
      sessionID: approvedID,
      rootID: root.id,
      model: {
        providerID: "workbuddy",
        modelID: "deepseek-v4.1-flash",
        accountID: "wb-new-account",
        variant: "max",
      },
    })
    expect(updated.mutation).toEqual({ attempted: true, committed: true })
    expect(controlCalls).toHaveLength(1)
    expect(controlCalls[0]).toMatchObject({
      action: "set_selection",
      input: {
        actorRef: "oxp:" + connector,
        model: {
          providerID: "workbuddy",
          modelID: "deepseek-v4.1-flash",
          accountID: "wb-new-account",
          variant: "max",
        },
      },
    })
    expect(JSON.stringify(controlCalls[0])).not.toContain(
      "deepseek-v4.1-flash@wb-new-account",
    )

    const smuggled = yield* sessions
      .execute({
        action: "set_selection",
        sessionID: approvedID,
        model: {
          providerID: "workbuddy",
          modelID: "deepseek-v4.1-flash@wb-new-account",
        },
      })
      .pipe(Effect.flip)
    expect(smuggled._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(controlCalls).toHaveLength(1)
  }))

  it.live("admits send and turn as externally attributed Session supervision and distinguishes cancelled waiting from failed admission", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([
      fs.mkdir(approvedDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]))
    yield* seed(approvedDir, outsideDir)
    yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })
    const connector = (yield* config.get()).connector.id

    const sent = yield* sessions.execute({
      action: "send",
      sessionID: approvedID,
      text: "supervised work",
    })
    expect(sent.structured).toMatchObject({
      sessionID: approvedID,
      action: "send",
      admittedMessageID: "msg_oxp_send",
      paused: false,
    })
    expect(sent.mutation).toEqual({ attempted: true, committed: true })
    expect(controlCalls[0]).toMatchObject({
      action: "send",
      input: {
        text: "supervised work",
        actorRef: "oxp:" + connector,
      },
    })

    const turned = yield* sessions.execute({
      action: "turn",
      sessionID: approvedID,
      text: "finish this turn",
    })
    expect(turned.structured).toMatchObject({
      admittedMessageID: "msg_oxp_turn",
      resultMessageID: "msg_oxp_result",
    })

    cancelTurnWait = true
    const cancelled = yield* sessions
      .execute({
        action: "turn",
        sessionID: approvedID,
        text: "keep running after I stop waiting",
      })
      .pipe(Effect.flip)
    expect(cancelled._tag).toBe("OXP_CANCELLED")
    expect(cancelled.metadata).toMatchObject({
      admittedMessageID: "msg_oxp_turn",
      committed: true,
    })
  }))

  it.live("delegates background_subagents to native runtime ownership instead of inferring from child Sessions", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([
      fs.mkdir(approvedDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]))
    yield* seed(approvedDir, outsideDir)
    yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })

    const result = yield* sessions.execute({
      action: "background_subagents",
      sessionID: approvedID,
    })
    expect(result.structured).toEqual({
      sessionID: approvedID,
      promoted: 2,
    })
    expect(result.mutation).toEqual({ attempted: true, committed: true })
    expect(controlCalls).toHaveLength(1)
    expect(controlCalls[0]).toMatchObject({
      action: "background_subagents",
      target: { sessionID: approvedID, directory: approvedDir },
    })
  }))

  it.live("does not reveal whether an unauthorized Session exists", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([
      fs.mkdir(approvedDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]))
    yield* seed(approvedDir, outsideDir)
    yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })

    const outside = yield* sessions.execute({ action: "get", sessionID: outsideID }).pipe(Effect.flip)
    const missing = yield* sessions.execute({ action: "get", sessionID: "ses_missing" }).pipe(Effect.flip)
    expect(outside._tag).toBe("OXP_NOT_FOUND")
    expect(missing._tag).toBe("OXP_NOT_FOUND")
    expect(outside.message).toBe(missing.message)
    expect(controlCalls).toEqual([])
  }))

  it.live("refuses recursive delete when any descendant falls outside the approved OXP root", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const { db } = yield* Database.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([
      fs.mkdir(approvedDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })

    yield* db
      .update(SessionTable)
      .set({ parent_id: approvedID })
      .where(eq(SessionTable.id, outsideID))
      .run()
      .pipe(Effect.orDie)

    const error = yield* sessions.execute({
      action: "delete",
      sessionID: approvedID,
      rootID: root.id,
    }).pipe(Effect.flip)

    expect(error._tag).toBe("OXP_NOT_FOUND")
    expect(controlCalls).toEqual([])
  }))

  it.live("enters Tier-3 runtime control only after live grant/root revalidation", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([
      fs.mkdir(approvedDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })

    const paused = yield* sessions.execute({ action: "pause", sessionID: approvedID, rootID: root.id })
    expect(paused.mutation).toEqual({ attempted: true, committed: true })
    expect(controlCalls).toHaveLength(1)
    expect(controlCalls[0]).toMatchObject({
      action: "pause",
      target: { sessionID: approvedID, directory: approvedDir },
    })

    const archived = yield* sessions.execute({ action: "archive", sessionID: approvedID, rootID: root.id })
    const unarchived = yield* sessions.execute({ action: "unarchive", sessionID: approvedID, rootID: root.id })
    const deleted = yield* sessions.execute({ action: "delete", sessionID: approvedID, rootID: root.id })
    expect(archived.mutation).toEqual({ attempted: true, committed: true })
    expect(unarchived.mutation).toEqual({ attempted: true, committed: true })
    expect(deleted.mutation).toEqual({ attempted: true, committed: true })
    expect(controlCalls.map((call) => call.action)).toEqual(["pause", "archive", "unarchive", "delete"])

    yield* config.setGrant({ sessionSupervision: "none" })
    const denied = yield* sessions.execute({ action: "resume", sessionID: approvedID, rootID: root.id }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
    expect(controlCalls).toHaveLength(4)
  }))

  it.live("holds approved-root supervision under 1/3/6 concurrent reads and controls", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const sessions = yield* OxpSession.Service
    const approvedDir = path.join(suite, "approved")
    const outsideDir = path.join(suite, "outside")
    yield* Effect.promise(() => Promise.all([
      fs.mkdir(approvedDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]))
    yield* seed(approvedDir, outsideDir)
    const root = yield* roots.approve(approvedDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })

    for (const count of [1, 3, 6] as const) {
      const reads = yield* Effect.all(
        Array.from({ length: count }, () =>
          sessions.execute({ action: "get", sessionID: approvedID, rootID: root.id }),
        ),
        { concurrency: "unbounded" },
      )
      expect(reads).toHaveLength(count)
      for (const result of reads) {
        expect(JSON.stringify(result)).not.toContain(approvedDir)
      }

      controlCalls.length = 0
      const controls = yield* Effect.all(
        Array.from({ length: count }, () =>
          sessions.execute({ action: "pause", sessionID: approvedID, rootID: root.id }),
        ),
        { concurrency: "unbounded" },
      )
      expect(controls).toHaveLength(count)
      expect(controlCalls).toHaveLength(count)
      expect(controlCalls.every((call) => call.action === "pause")).toBe(true)
    }
  }))

  it.live("propagates request cancellation before durable scanning or runtime control", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const sessions = yield* OxpSession.Service
    yield* config.setEnabled(true)
    yield* config.setGrant({ sessionSupervision: "approved-roots" })
    const controller = new AbortController()
    controller.abort()

    const error = yield* sessions.execute({ action: "list" }, controller.signal).pipe(Effect.flip)
    expect(error._tag).toBe("OXP_CANCELLED")
    expect(controlCalls).toEqual([])
  }))
})
