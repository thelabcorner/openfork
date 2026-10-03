import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { Database } from "@opencode-ai/core/database/database"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Deferred, Effect, Layer, Ref } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionIngress } from "@/session/ingress"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SubagentSupervision, classifyWorker, type WorkerState } from "@/session/subagent-supervision"
import { SupervisorRegistryTag } from "@/session/subagent-supervision-contract"
import * as SubagentSupervisionMetadata from "@/session/subagent-supervision-metadata"
import type { HostPromptProvenance, SessionPromptOps } from "@/session/prompt-contract"
import { TaskTool } from "@/tool/task"
import { SessionTool } from "@/tool/session"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Project.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
    Permission.node,
    Question.node,
    SessionIngress.node,
    SubagentSupervision.node,
  ]),
  [
    [RuntimeFlags.node, RuntimeFlags.layer({})],
    [
      InstanceBootstrap.node,
      Layer.succeed(
        InstanceBootstrap.Service,
        InstanceBootstrap.Service.of({ gate: Effect.void, warmup: Effect.void }),
      ),
    ],
  ],
)

const it = testEffect(layer)

// ---------------------------------------------------------------------------
// Objective + scope partition (plan §28 step 1-2)
// ---------------------------------------------------------------------------

const OBJECTIVE = "Land the supervisor-mode supervision service end to end."

/**
 * The supervisor's partition of ONE objective into four NON-OVERLAPPING
 * scopes. Each scope names disjoint files so the hierarchy, not a claim
 * registry, prevents overlap (plan §24).
 */
const SCOPES = [
  {
    key: "A",
    description: "Scope A: delegation contract",
    prompt: "Own tool/task.ts and subagent-delegation.ts only.",
  },
  { key: "B", description: "Scope B: cohort inspection", prompt: "Own tool/session.ts children projection only." },
  { key: "C", description: "Scope C: safe steering", prompt: "Own core/session/input.ts steer lane only." },
  { key: "D", description: "Scope D: tests", prompt: "Own test/session only." },
] as const

function reply(input: { sessionID: SessionID; messageID?: MessageID }, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    } satisfies SessionV1.Assistant,
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

type SteerCall = { readonly sessionID: SessionID; readonly text: string }
type PromptCall = { readonly sessionID: SessionID; readonly text: string }

type PromptInputLike = {
  readonly sessionID: SessionID
  readonly messageID?: MessageID
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

type SteerInputLike = {
  readonly sessionID: SessionID
  readonly agent?: string
  readonly model?: {
    readonly providerID: string
    readonly modelID: string
    readonly accountID?: string
  }
  readonly variant?: string
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

type OpsLog = {
  prompts: PromptCall[]
  steers: SteerCall[]
  durableSteers?: Array<{ readonly id: string; readonly text: string }>
  /** Per-child latch the test releases to let a worker actually settle. */
  gates: Map<string, { readonly release: Effect.Effect<void>; readonly wait: Effect.Effect<void> }>
}

/**
 * A real `SessionPromptOps` shape. The worker `prompt` lane stands in for a
 * provider turn, but it is GATED so a launched worker stays genuinely in-flight
 * until the test releases it — otherwise a detached BackgroundJob would settle
 * instantly and there would be no live cohort to supervise, steer, or gate on.
 *
 * The `steer` lane is the REAL safe-boundary seam supervisor mode must route
 * through (and which must never be `BackgroundJob.extend`).
 */
function makeOps(log: OpsLog) {
  const durableSteers = log.durableSteers
  const gateFor = (sessionID: SessionID) => {
    const key = String(sessionID)
    const existing = log.gates.get(key)
    if (existing) return existing
    const deferred = Effect.runSync(Deferred.make<void>())
    const entry = {
      release: Deferred.succeed(deferred, undefined) as unknown as Effect.Effect<void>,
      wait: Deferred.await(deferred).pipe(Effect.asVoid) as unknown as Effect.Effect<void>,
    }
    log.gates.set(key, entry)
    return entry
  }

  return (): SessionPromptOps =>
    ({
      cancel: () => Effect.void,
      resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
      prompt: (input: PromptInputLike) =>
        Effect.gen(function* () {
          const text = input.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
          log.prompts.push({ sessionID: input.sessionID, text })
          // Hold the worker turn open until the test releases it.
          yield* gateFor(input.sessionID).wait
          return reply(input, "worker finished")
        }),
      steer: (input: SteerInputLike, _provenance?: HostPromptProvenance) =>
        durableSteers
          ? Effect.gen(function* () {
              const text = input.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
              const events = yield* EventV2Bridge.Service
              const { db } = yield* Database.Service
              const model = {
                id: ModelV2.ID.make(input.model?.modelID ?? ref.modelID),
                providerID: ProviderV2.ID.make(input.model?.providerID ?? ref.providerID),
                ...(input.model?.accountID ? { accountID: input.model.accountID } : {}),
                ...(input.variant ? { variant: ModelV2.VariantID.make(input.variant) } : {}),
              }
              const id = SessionMessage.ID.create()
              yield* SessionInput.admitSynthetic(db, events, {
                id,
                sessionID: input.sessionID,
                content: { text },
                origin: SessionInput.SyntheticOrigin.make({
                  producer: SessionTurnProvenance.Source.HostPrompt,
                  actor: { type: "host" },
                }),
                admissionClass: "host",
                delivery: "steer",
                userPreemptible: true,
                execution: { agent: input.agent ?? "general", model },
              })
              log.steers.push({ sessionID: input.sessionID, text })
              durableSteers.push({ id: String(id), text })
              return reply(input, "steered")
            })
          : Effect.sync(() => {
              const text = input.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
              log.steers.push({ sessionID: input.sessionID, text })
              return reply(input, "steered")
            }),
    }) as unknown as SessionPromptOps
}

function releaseWorker(log: OpsLog, sessionID: SessionID) {
  return Effect.gen(function* () {
    const gate = log.gates.get(String(sessionID))
    if (!gate) return
    yield* gate.release
  })
}

const releaseAllWorkers = (log: OpsLog) =>
  Effect.forEach([...log.gates.values()], (gate) => gate.release, { discard: true })

const waitForChildPrompts = (log: OpsLog, count: number) =>
  pollWithTimeout(
    Effect.sync(() => (log.prompts.length >= count ? true : undefined)),
    `expected ${count} supervised child prompts`,
  )

/**
 * Invoke the REAL Task tool for one supervisor-mode delegation. This goes
 * through `SubagentDelegation.execute`, which persists the durable
 * `taskDelegation` envelope and registers through `SupervisorRegistryTag`.
 */
function launch(input: {
  parentSessionID: SessionID
  assistantMessageID: MessageID
  promptOps: SessionPromptOps
  params: {
    description: string
    prompt?: string
    subagent_type: string
    mode: "supervisor"
    task_id?: string
  }
}) {
  return Effect.gen(function* () {
    const tool = yield* TaskTool
    const def = yield* tool.init()
    return yield* def.execute(input.params, {
      sessionID: input.parentSessionID,
      messageID: input.assistantMessageID,
      agent: "build",
      abort: new AbortController().signal,
      extra: { promptOps: input.promptOps, authorizedAgentNames: new Set(["general"]) },
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    } as never)
  })
}

const seedSupervisor = Effect.fn("SupervisorIntegration.seed")(function* (title = "Supervisor") {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

/** Count wakes the existing SessionIngress wake path delivered to a session. */
const installWakeObserver = () =>
  Effect.gen(function* () {
    const ingress = yield* SessionIngress.Service
    const observed = yield* Ref.make<ReadonlyArray<SessionID>>([])
    yield* ingress.registerWakeHandler((sessionID) => Ref.update(observed, (current) => [...current, sessionID]))
    return {
      all: () => Ref.get(observed),
      of: (id: SessionID) => Ref.get(observed).pipe(Effect.map((list) => list.filter((item) => item === id).length)),
    }
  })

const toolContext = (sessionID: SessionID, messageID: MessageID) => ({
  sessionID,
  messageID,
  agent: "build",
  abort: new AbortController().signal,
  messages: [] as SessionV1.WithParts[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

// ---------------------------------------------------------------------------
// Step 1-2: partition + launch four supervisor-mode workers in ONE turn
// ---------------------------------------------------------------------------

describe("supervisor integration :: launch and cohort grouping", () => {
  it.instance(
    "partitions one objective into four scopes and launches four supervisor-mode workers in ONE assistant turn",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSupervisor(OBJECTIVE)
        const log: OpsLog = { prompts: [], steers: [], gates: new Map() }
        const ops = makeOps(log)()

        expect(new Set(SCOPES.map((scope) => scope.description)).size).toBe(4)
        expect(SCOPES.map((scope) => scope.prompt)).toEqual([
          "Own tool/task.ts and subagent-delegation.ts only.",
          "Own tool/session.ts children projection only.",
          "Own core/session/input.ts steer lane only.",
          "Own test/session only.",
        ])

        const results = yield* Effect.all(
          SCOPES.map((scope) =>
            launch({
              parentSessionID: chat.id,
              assistantMessageID: assistant.id,
              promptOps: ops,
              params: {
                description: scope.description,
                prompt: scope.prompt,
                subagent_type: "general",
                mode: "supervisor",
              },
            }),
          ),
          { concurrency: "unbounded" },
        )

        // Detached execution: supervisor mode returns immediately, running.
        for (const result of results) {
          expect(result.output).toContain('state="running"')
          expect(result.metadata.background).toBe(true)
          expect(result.metadata.mode).toBe("supervisor")
        }

        // ONE supervisionGroupID, derived from the shared assistant turn.
        const groupIDs = new Set(results.map((result) => result.metadata.supervisionGroupId as string))
        expect(groupIDs.size).toBe(1)
        const supervisionGroupID = [...groupIDs][0]
        expect(supervisionGroupID).toBe(`sup:${assistant.id}`)

        // FOUR distinct child Sessions, each parented by the supervisor.
        const sessions = yield* Session.Service
        const children = yield* sessions.children(chat.id)
        expect(children).toHaveLength(4)
        expect(new Set(children.map((child) => child.id)).size).toBe(4)
        for (const child of children) {
          expect(child.parentID).toBe(chat.id)
          const envelope = SubagentSupervisionMetadata.taskDelegation(child.metadata)
          expect(envelope).toBeDefined()
          expect(envelope?.supervisionGroupID).toBe(supervisionGroupID)
          expect(envelope?.supervisorSessionID).toBe(chat.id)
        }
        // The child IDs in the result metadata are the four distinct sessions.
        expect(new Set(results.map((result) => result.metadata.sessionId as string)).size).toBe(4)

        const promptTargets = new Set(log.prompts.map((call) => call.sessionID))
        const childIDs = new Set(children.map((child) => child.id))
        for (const target of promptTargets) {
          expect(childIDs.has(target)).toBe(true)
        }
        expect(promptTargets.size).toBe(4)
        expect(JSON.stringify(children.map((child) => child.metadata))).not.toMatch(/swarm|blackboard|claim|peer/i)

        const tool = yield* Tool.init(yield* SessionTool)
        const inspection = yield* tool.execute(
          { action: "children", groupId: supervisionGroupID } as never,
          toolContext(chat.id, assistant.id) as never,
        )
        const cohort = JSON.parse(inspection.output) as {
          parentId: string
          groupId?: string
          workers: Array<Record<string, unknown>>
          truncated?: boolean
        }
        expect(cohort.parentId).toBe(String(chat.id))
        expect(cohort.groupId).toBe(supervisionGroupID)
        expect(cohort.workers).toHaveLength(4)
        expect(cohort.truncated).not.toBe(true)
        for (const worker of cohort.workers) {
          expect(childIDs.has(worker.sessionId as SessionID)).toBe(true)
          expect(worker.mode).toBe("supervisor")
          expect(worker.status).toBeDefined()
          expect(worker.blocked).toBeDefined()
          expect(worker).not.toHaveProperty("messages")
          expect(worker).not.toHaveProperty("parts")
        }

        const service = yield* SubagentSupervision.service
        const events = yield* EventV2Bridge.Service
        const wake = yield* installWakeObserver()
        for (const child of children) {
          yield* events.publish(
            { type: "session.next.tool.success", schema: {}, durable: undefined } as never,
            {
              timestamp: Date.now(),
              sessionID: child.id,
              assistantMessageID: assistant.id,
              callID: `low-${child.id}`,
              tool: "read",
              structured: {},
              content: [],
              provider: { executed: true },
            } as never,
          )
        }
        yield* Effect.sleep("400 millis")
        expect(yield* wake.of(chat.id)).toBe(0)
        const findingChild = results[2]!.metadata.sessionId as SessionID
        yield* events.publish(
          { type: "session.next.step.ended", schema: {}, durable: undefined } as never,
          {
            timestamp: Date.now(),
            sessionID: findingChild,
            assistantMessageID: assistant.id,
            finish: "stop",
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          } as never,
        )
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const count = yield* service.wakeCount(supervisionGroupID)
            return count >= 1 ? count : undefined
          }),
          "four-worker finding never woke the supervisor",
        )
        expect(yield* service.wakeCount(supervisionGroupID)).toBe(1)
        yield* releaseAllWorkers(log)
      }),
    { config: { agent: { general: { mode: "subagent" } } } },
  )
})

// ---------------------------------------------------------------------------
// Steps 3-5 + 8: drift, invalidating finding, observed change, steer
// ---------------------------------------------------------------------------

describe("supervisor integration :: drift detection and safe-boundary steering", () => {
  it.instance(
    "coalesces worker progress/drift, routes steering through the real steer seam, and never through BackgroundJob.extend",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSupervisor("Supervisor steering")
        const log: OpsLog = { prompts: [], steers: [], gates: new Map() }
        const ops = makeOps(log)()
        const service = yield* SubagentSupervision.service
        const background = yield* BackgroundJob.Service

        // Launch worker B (the drifting one) in supervisor mode.
        const launched = yield* launch({
          parentSessionID: chat.id,
          assistantMessageID: assistant.id,
          promptOps: ops,
          params: {
            description: SCOPES[1].description,
            prompt: SCOPES[1].prompt,
            subagent_type: "general",
            mode: "supervisor",
          },
        })
        const workerB = launched.metadata.sessionId as SessionID
        const group = launched.metadata.supervisionGroupId as string

        // Worker B is live and registered through the real SupervisorRegistryTag.
        const registry = yield* SupervisorRegistryTag
        expect(typeof registry.register).toBe("function")
        expect(typeof registry.unregister).toBe("function")
        const live = yield* service.snapshot({ supervisionGroupID: group })
        expect(live.workers.map((worker) => worker.sessionID)).toContain(workerB)
        expect(live.workers.find((worker) => worker.sessionID === workerB)?.runtime).toBe("live")

        // Step 3/4: ordinary low-level tool chatter from A and B (drift) must
        // NOT wake the supervisor. This is the real event path (EventV2Bridge).
        const events = yield* EventV2Bridge.Service
        const wake = yield* installWakeObserver()
        for (let i = 0; i < 20; i++) {
          yield* events.publish(
            { type: "session.next.tool.success", schema: {}, durable: undefined } as never,
            {
              timestamp: Date.now(),
              sessionID: workerB,
              assistantMessageID: assistant.id,
              callID: `call_${i}`,
              tool: "read",
              structured: {},
              content: [],
              provider: { executed: true },
            } as never,
          )
        }
        yield* Effect.sleep("400 millis")
        expect(yield* service.wakeCount(group)).toBe(0)
        expect(yield* wake.of(chat.id)).toBe(0)

        // Step 5/6/7: worker C's finding invalidates B's assumption. That is a
        // MEANINGFUL change and produces exactly ONE coalesced cohort wake.
        yield* events.publish(
          { type: "session.next.step.ended", schema: {}, durable: undefined } as never,
          {
            timestamp: Date.now(),
            sessionID: workerB,
            assistantMessageID: assistant.id,
            finish: "stop",
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          } as never,
        )
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const count = yield* service.wakeCount(group)
            return count >= 1 ? count : undefined
          }),
          "meaningful cohort change never woke the supervisor",
        )
        expect(yield* service.wakeCount(group)).toBe(1)
        expect(yield* wake.of(chat.id)).toBe(1)

        // Step 7: the supervisor inspects the cohort ONCE with one bounded
        // snapshot covering the whole cohort.
        const inspected = yield* service.snapshot({ supervisionGroupID: group })
        expect(inspected.bounded).toBe(true)
        expect(inspected.supervisorSessionID).toBe(chat.id)
        expect(inspected.workers).toHaveLength(1)

        // Step 8: steer B. Supervisor mode MUST route through SessionPromptOps.steer.
        const jobBefore = yield* background.get(workerB)
        const steerText = "Stop the custom parser. Reuse the existing AST layer instead."
        const steered = yield* launch({
          parentSessionID: chat.id,
          assistantMessageID: assistant.id,
          promptOps: ops,
          params: {
            description: SCOPES[1].description,
            subagent_type: "general",
            mode: "supervisor",
            task_id: workerB,
            prompt: steerText,
          },
        })
        expect(steered.output).toContain('state="running"')

        // The guidance went through the steer seam, NOT a queued prompt continuation.
        expect(log.steers).toHaveLength(1)
        expect(log.steers[0].sessionID).toBe(workerB)
        expect(log.steers[0].text).toContain("Reuse the existing AST layer")
        // The original launch prompt is the only prompt-lane call.
        expect(log.prompts).toHaveLength(1)
        expect(log.prompts[0].sessionID).toBe(workerB)

        // Steering did not create a second child or a new execution generation.
        const sessions = yield* Session.Service
        expect((yield* sessions.children(chat.id)).map((child) => child.id)).toEqual([workerB])
        const jobAfter = yield* background.get(workerB)
        expect(jobAfter?.generation).toBe(jobBefore?.generation)
      }),
    { config: { agent: { general: { mode: "subagent" } } } },
  )
})

describe("supervisor integration :: durable steering admission", () => {
  it.instance(
    "routes a running supervisor prompt to a durable host+steer SessionInput row without BackgroundJob.extend",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSupervisor("Supervisor durable steer")
        const log: OpsLog = { prompts: [], steers: [], durableSteers: [], gates: new Map() }
        const ops = makeOps(log)()
        const background = yield* BackgroundJob.Service
        const launched = yield* launch({
          parentSessionID: chat.id,
          assistantMessageID: assistant.id,
          promptOps: ops,
          params: {
            description: SCOPES[2].description,
            prompt: SCOPES[2].prompt,
            subagent_type: "general",
            mode: "supervisor",
          },
        })
        yield* waitForChildPrompts(log, 1)
        const worker = launched.metadata.sessionId as SessionID
        const before = yield* background.get(worker)
        const steered = yield* launch({
          parentSessionID: chat.id,
          assistantMessageID: assistant.id,
          promptOps: ops,
          params: {
            description: SCOPES[2].description,
            subagent_type: "general",
            mode: "supervisor",
            task_id: worker,
            prompt: "reuse the safe steering boundary",
          },
        })
        expect(steered.output).toContain('state="running"')
        expect(log.steers).toHaveLength(1)
        expect(log.durableSteers).toHaveLength(1)
        const durable = log.durableSteers![0]!
        const { db } = yield* Database.Service
        const entry = yield* SessionInput.findEntry(db, SessionMessage.ID.make(durable.id))
        expect(entry).toMatchObject({
          sessionID: worker,
          kind: "synthetic",
          admissionClass: "host",
          delivery: "steer",
          userPreemptible: true,
        })
        expect(entry?.item).toMatchObject({ type: "synthetic" })
        expect((entry?.item as any)?.origin?.actor).toEqual({ type: "host" })
        expect(entry?.promotedSeq).toBeUndefined()
        expect(entry?.revokedSeq).toBeUndefined()
        expect(log.prompts).toHaveLength(1)
        const after = yield* background.get(worker)
        expect(after?.generation).toBe(before?.generation)
        const sessions = yield* Session.Service
        expect((yield* sessions.children(chat.id)).filter((child) => child.id === worker)).toHaveLength(1)
        yield* background.cancel(worker)
      }),
    { config: { agent: { general: { mode: "subagent" } } } },
  )
})

// ---------------------------------------------------------------------------
// Step 9: blocker observation and response
// ---------------------------------------------------------------------------

describe("supervisor integration :: blocker observation", () => {
  it.instance(
    "observes a real permission blocker and a real question blocker through the live event path and classifies them",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSupervisor("Supervisor blockers")
        const log: OpsLog = { prompts: [], steers: [], gates: new Map() }
        const ops = makeOps(log)()
        const service = yield* SubagentSupervision.service
        const permission = yield* Permission.Service
        const question = yield* Question.Service
        const events = yield* EventV2Bridge.Service
        const wake = yield* installWakeObserver()

        const launched = yield* launch({
          parentSessionID: chat.id,
          assistantMessageID: assistant.id,
          promptOps: ops,
          params: {
            description: SCOPES[3].description,
            prompt: SCOPES[3].prompt,
            subagent_type: "general",
            mode: "supervisor",
          },
        })
        const workerD = launched.metadata.sessionId as SessionID
        const group = launched.metadata.supervisionGroupId as string

        // Worker D asks for an out-of-scope permission (REAL permission.asked).
        yield* permission
          .ask({
            sessionID: workerD,
            permission: "external_directory",
            patterns: ["/outside"],
            always: ["*"],
            metadata: { reason: "needs external fixture" },
            ruleset: [],
          })
          .pipe(Effect.forkScoped)

        const blocked = yield* pollWithTimeout(
          Effect.gen(function* () {
            const snap = yield* service.snapshot({ supervisionGroupID: group })
            const worker = snap.workers.find((item) => item.sessionID === workerD)
            return worker?.state === "blocked_permission" ? worker : undefined
          }),
          "real permission blocker never classified",
        )
        expect(blocked.state).toBe("blocked_permission")
        expect(blocked.evidenceBased).toBe(true)

        // The supervisor was woken by the real event, not by polling.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const count = yield* wake.of(chat.id)
            return count >= 1 ? count : undefined
          }),
          "permission blocker never woke the supervisor",
        )

        // Supervisor responds by steering D toward an authorized alternative.
        // It must NOT approve the permission itself.
        const pendingBefore = yield* permission.list()
        expect(pendingBefore.some((item) => item.sessionID === workerD)).toBe(true)
        yield* launch({
          parentSessionID: chat.id,
          assistantMessageID: assistant.id,
          promptOps: ops,
          params: {
            description: SCOPES[3].description,
            subagent_type: "general",
            mode: "supervisor",
            task_id: workerD,
            prompt: "Stay inside the assigned scope; do not read /outside.",
          },
        })
        expect(log.steers).toHaveLength(1)
        expect((yield* permission.list()).some((item) => item.sessionID === workerD)).toBe(true)
        const pending = pendingBefore.find((item) => item.sessionID === workerD)
        expect(pending).toBeDefined()
        if (!pending) throw new Error("expected pending permission request")
        yield* permission.reply({ requestID: pending.id, reply: "once" })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const rows = yield* permission.list()
            return rows.every((item) => item.sessionID !== workerD) ? true : undefined
          }),
          "permission blocker was not cleared",
        )

        // Now the question blocker path (REAL question.asked) classifies too.
        yield* question
          .askDetailed({
            sessionID: workerD,
            questions: [{ question: "Widen scope?", header: "Scope", options: [] }] as never,
          })
          .pipe(Effect.forkScoped)

        const questionBlocked = yield* pollWithTimeout(
          Effect.gen(function* () {
            const snap = yield* service.snapshot({ supervisionGroupID: group })
            const worker = snap.workers.find((item) => item.sessionID === workerD)
            return worker?.state === "blocked_question" ? worker : undefined
          }),
          "real question blocker never classified",
        )
        expect(questionBlocked.state).toBe("blocked_question")
        expect(questionBlocked.evidenceBased).toBe(true)
        // The classification agrees with the pure producer-side function.
        expect(
          classifyWorker({
            runtime: questionBlocked.runtime,
            sessionStatus: questionBlocked.sessionStatus,
            backgroundStatus: undefined,
            hasPermission: false,
            hasQuestion: true,
            activity: undefined,
          }).state,
        ).toBe("blocked_question")
        void events
      }),
    { config: { agent: { general: { mode: "subagent" } } } },
  )
})

// ---------------------------------------------------------------------------
// Steps 10-12: audit, integration check, finalization gate
// ---------------------------------------------------------------------------

describe("supervisor integration :: audit and finalization gate", () => {
  it.instance(
    "audits a completed worker instead of auto-accepting it and does not finalize an unresolved cohort",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seedSupervisor("Supervisor audit")
        const log: OpsLog = { prompts: [], steers: [], gates: new Map() }
        const ops = makeOps(log)()
        const service = yield* SubagentSupervision.service
        const events = yield* EventV2Bridge.Service
        const background = yield* BackgroundJob.Service

        const launchOne = (description: string, prompt: string) =>
          launch({
            parentSessionID: chat.id,
            assistantMessageID: assistant.id,
            promptOps: ops,
            params: { description, prompt, subagent_type: "general", mode: "supervisor" },
          })

        const a = yield* launchOne(SCOPES[0].description, SCOPES[0].prompt)
        const b = yield* launchOne(SCOPES[1].description, SCOPES[1].prompt)
        const workerA = a.metadata.sessionId as SessionID
        const workerB = b.metadata.sessionId as SessionID
        const group = a.metadata.supervisionGroupId as string
        expect(b.metadata.supervisionGroupId).toBe(group)

        // Step 12 gate: while B is still live, the cohort is NOT resolved, so a
        // completion event for A alone must not be treated as cohort completion.
        const beforeCompletion = yield* service.snapshot({ supervisionGroupID: group })
        expect(beforeCompletion.workers).toHaveLength(2)
        const unresolved = beforeCompletion.workers.filter(
          (worker) => worker.state === "working" || worker.state === "idle_with_pending_work",
        )
        expect(unresolved.length).toBeGreaterThan(0)
        expect(
          beforeCompletion.workers.every(
            (worker) => worker.state === "completed" || worker.state === "failed" || worker.state === "cancelled",
          ),
        ).toBe(false)

        // Step 10: worker A completes. Release its gated turn so the REAL
        // BackgroundJob settles, then publish the REAL session.idle event that
        // SessionStatus emits when the child turn ends.
        yield* releaseWorker(log, workerA)
        yield* events.publish(
          { type: "session.idle", schema: {}, durable: undefined } as never,
          { sessionID: workerA } as never,
        )
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const snap = yield* service.snapshot({ supervisionGroupID: group })
            const worker = snap.workers.find((item) => item.sessionID === workerA)
            return worker?.state === "completed" ? worker : undefined
          }),
          "worker A never reached a completed state",
        )
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const count = yield* service.wakeCount(group)
            return count >= 1 ? count : undefined
          }),
          "worker A completion never woke the supervisor",
        )
        expect(yield* service.wakeCount(group)).toBe(1)

        // Completion is EVIDENCE, not acceptance: the supervisor must audit.
        // A is terminal, but B is still live, so the cohort is NOT resolved and
        // auto-accepting A must not finalize the overarching objective.
        const afterCompletion = yield* service.snapshot({ supervisionGroupID: group })
        const audited = afterCompletion.workers.find((worker) => worker.sessionID === workerA)
        expect(audited?.state).toBe("completed")
        expect(audited?.evidenceBased).toBe(true)
        const stillLive = afterCompletion.workers.find((worker) => worker.sessionID === workerB)
        expect(stillLive).toBeDefined()
        expect(stillLive?.state === "completed" || stillLive?.state === "cancelled").toBe(false)
        expect(
          afterCompletion.workers.every(
            (worker) => worker.state === "completed" || worker.state === "failed" || worker.state === "cancelled",
          ),
        ).toBe(false)

        // A terminal event is classified as a meaningful, evidence-based state.
        const terminal = classifyWorker({
          runtime: "live",
          sessionStatus: { type: "idle" },
          backgroundStatus: "completed",
          hasPermission: false,
          hasQuestion: false,
          activity: undefined,
        })
        expect(terminal.state).toBe("completed")
        expect(terminal.evidenceBased).toBe(true)

        // Step 11/12: once BOTH settle, the cohort resolves and the supervisor
        // may finish. Cancellation is proven through the REAL BackgroundJob
        // cancel plus the aborted idle marker SessionStatus publishes.
        yield* background.cancel(workerB)
        yield* events.publish(
          { type: "session.idle", schema: {}, durable: undefined } as never,
          { sessionID: workerB, reason: "aborted" } as never,
        )
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const count = yield* service.wakeCount(group)
            return count >= 2 ? count : undefined
          }),
          "worker B cancellation never woke the supervisor",
        )
        // Two distinct debounce windows => two coalesced wakes, never a storm.
        expect(yield* service.wakeCount(group)).toBe(2)

        // Only now is every worker terminal, so the objective may be finalized.
        const resolved = yield* service.snapshot({ supervisionGroupID: group })
        const states: WorkerState[] = resolved.workers.map((worker) => worker.state)
        expect(states.every((state) => state === "completed" || state === "cancelled")).toBe(true)
      }),
    { config: { agent: { general: { mode: "subagent" } } } },
  )
})
