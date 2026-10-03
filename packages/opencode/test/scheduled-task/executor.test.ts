import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Goal } from "@opencode-ai/core/goal"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AppProcess } from "@opencode-ai/core/process"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Worktree } from "@/worktree"
import { ScheduledTaskExecutor } from "@/scheduled-task/executor"
import { ScheduledTaskSessionAdmission } from "@/scheduled-task/session-admission"
import { ScheduledTask as ScheduledTaskModel } from "@opencode-ai/schema/scheduled-task"
import { NotFoundError } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const T0 = Date.parse("2026-06-01T00:00:00Z")

const taskInfo = (overrides: Partial<ScheduledTaskModel.Info> = {}): ScheduledTaskModel.Info =>
  ({
    id: ScheduledTaskModel.ID.make("stk_executor_test"),
    targetDirectory: "/scheduled/executor",
    target: { kind: "directory" },
    sessionPolicy: { kind: "new" },
    name: "executor-test",
    enabled: true,
    revision: 0,
    schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
    timezone: "America/New_York",
    action: { prompt: "hello" },
    policy: {
      catchUp: "skip",
      catchUpMaxAgeMs: 6 * 60 * 60 * 1000,
      overrun: "skip",
      jitterMs: 0,
      maxAttempts: 2,
      maxDurationMs: 30 * 60 * 1000,
      retentionRuns: 200,
      permission: "deny",
      notify: "failure",
    },
    consecutiveFailures: 0,
    source: "api",
    time: {
      created: DateTime.makeUnsafe(T0),
      updated: DateTime.makeUnsafe(T0),
    },
    ...overrides,
  }) as ScheduledTaskModel.Info

// Mutable per-test wiring for the mocked boundary services.
let targetIsDirectory = true
let hostPromptOutcome: "succeeded" | "timeout" | "quota-error" = "succeeded"
let providedDirectories: string[] = []
let cancelledSessions: string[] = []
let createdSessions = 0
let hostPromptCalls = 0
let hostPromptProvenance: unknown
let attachedRunSessions: Array<{ runID: string; attempt: number; sessionID: string; directory: string }> = []
let goalPrepareInputs: unknown[] = []
let focusedGoal: Goal.Focused | undefined
const readFocusedGoal = () => focusedGoal
let goalCounter = 0
let goalDetails = new Map<string, Goal.Detail>()
let goalOwners = new Map<string, { runID: string; taskID: string }>()
let runGoals = new Map<string, string>()
let attachedRunGoals: Array<{ runID: string; attempt: number; goalID: string }> = []
let attachRunGoalAllowed = true
let unfocusedSessions: string[] = []
let executionOrder: string[] = []
let sessionRegistry = new Map<string, Session.Info>()
let bindingState: ScheduledTaskSessionBinding.Binding | undefined
let autoUserChanged = false
let autoLatestUserSeq: number | undefined
let admissionFenceFailures = 0
let admissionInputs: ScheduledTaskSessionAdmission.DispatchInput[] = []
let providerModelUnavailable = false

const instanceStoreMock = Layer.mock(InstanceStore.Service, {
  provide: (_input, effect) => {
    providedDirectories.push(_input.directory)
    return effect
  },
})

const fsMock = Layer.mock(FSUtil.Service, {
  isDir: () => Effect.sync(() => targetIsDirectory),
} as never)

const sessionMock = Layer.mock(Session.Service, {
  create: (input: Parameters<Session.Interface["create"]>[0]) =>
    Effect.sync(() => {
      createdSessions++
      executionOrder.push("session")
      const id = createdSessions === 1 ? "ses_scheduled_executor" : `ses_scheduled_executor_${createdSessions}`
      const value = {
        id,
        projectID: "prj",
        directory: "/scheduled/executor",
        agent: input?.agent,
        model: input?.model,
        metadata: input?.metadata,
      } as unknown as Session.Info
      sessionRegistry.set(id, value)
      return value
    }),
  get: (sessionID: Parameters<Session.Interface["get"]>[0]) =>
    Effect.suspend(() => {
      const value = sessionRegistry.get(sessionID)
      return value
        ? Effect.succeed(value)
        : Effect.fail(new NotFoundError({ message: `Session not found: ${sessionID}` }))
    }),
  setAgentModel: (input: Parameters<Session.Interface["setAgentModel"]>[0]) =>
    Effect.sync(() => {
      const value = sessionRegistry.get(input.sessionID)
      if (value) sessionRegistry.set(input.sessionID, { ...value, agent: input.agent, model: input.model })
    }),
  remove: (sessionID: string) =>
    Effect.sync(() => {
      sessionRegistry.delete(sessionID)
    }),
  touch: () => Effect.void,
} as never)

const promptMock = Layer.mock(SessionPrompt.Service, {
  resolvePromptParts: () => Effect.succeed([{ type: "text" as const, text: "hello" }]),
  cancel: (sessionID: string) =>
    Effect.sync(() => {
      cancelledSessions.push(sessionID)
    }),
} as never)

const admissionMock = Layer.mock(ScheduledTaskSessionAdmission.Service, {
  admit: (input) =>
    Effect.suspend(() => {
      hostPromptCalls++
      hostPromptProvenance = input
      admissionInputs.push(input)
      if (admissionFenceFailures > 0) {
        admissionFenceFailures--
        return Effect.fail(
          new SessionInput.AdmissionFenceConflict(
            input.sessionID,
            input.userFence?.expectedLatestUserSeq,
            23,
          ),
        )
      }
      return Effect.succeed({} as never)
    }),
  run: () =>
    Effect.suspend(() => {
      executionOrder.push("prompt")
      if (hostPromptOutcome === "timeout") return Effect.never
      if (hostPromptOutcome === "quota-error") return Effect.die(new Error("429 rate limit exceeded"))
      return Effect.succeed({
        info: { role: "assistant", id: "msg_test", sessionID: "ses_scheduled_executor", time: {} },
        parts: [],
      } as never)
    }),
  revoke: () => Effect.succeed(undefined),
})

const bindingMock = Layer.mock(ScheduledTaskSessionBinding.Service, {
  get: () => Effect.sync(() => bindingState),
  inspectAuto: () =>
    Effect.sync(() =>
      bindingState
        ? {
            binding: bindingState,
            latestUserSeq: autoLatestUserSeq,
            userChanged: autoUserChanged,
          }
        : undefined,
    ),
  install: (input) =>
    Effect.sync(() => {
      if (bindingState ? bindingState.generation !== input.expectedGeneration : input.expectedGeneration !== undefined) {
        return undefined
      }
      bindingState = {
        taskID: input.taskID,
        sessionID: input.sessionID,
        taskRevision: input.taskRevision,
        userSeqFence: autoLatestUserSeq,
        generation: (bindingState?.generation ?? 0) + 1,
        timeUpdated: DateTime.makeUnsafe(T0),
      }
      autoUserChanged = false
      return bindingState
    }),
  ownerOf: () => Effect.succeed(undefined),
  clear: () => Effect.succeed(false),
})

const agentMock = Layer.mock(Agent.Service, {
  defaultInfo: () =>
    Effect.succeed({
      name: "build",
      mode: "primary",
      permission: [],
      options: {},
    } as never),
  get: () => Effect.die(new Error("unused")),
})

const providerMock = Layer.mock(Provider.Service, {
  defaultModel: () => Effect.succeed({ providerID: "test", modelID: "test-model" } as never),
  getModel: () =>
    providerModelUnavailable
      ? Effect.fail(
          new Provider.ModelNotFoundError({
            providerID: ProviderV2.ID.make("test"),
            modelID: ModelV2.ID.make("test-model"),
          }),
        )
      : Effect.succeed({ id: "test-model", providerID: "test", variants: {} } as never),
})

const toolRegistryMock = Layer.mock(ToolRegistry.Service, {
  named: () => Effect.succeed({ read: { execute: () => Effect.die(new Error("unused")) } } as never),
} as never)

const permissionMock = Layer.mock(Permission.Service, {
  reply: () => Effect.void,
  ask: () => Effect.void,
  list: () => Effect.succeed([]),
})

const goalMock = Layer.mock(Goal.Service, {
  focused: () => Effect.sync(() => focusedGoal),
  get: (goalID) =>
    Effect.suspend(() => {
      const detail = goalDetails.get(goalID)
      return detail ? Effect.succeed(detail) : Effect.die(new Error(`Goal not found: ${goalID}`))
    }),
  unfocus: (input) =>
    Effect.sync(() => {
      unfocusedSessions.push(input.sessionID)
      focusedGoal = undefined
    }),
  unfocusExpected: (input) =>
    Effect.sync(() => {
      if (focusedGoal?.detail.goal.id !== input.goalID) return false
      unfocusedSessions.push(input.sessionID)
      focusedGoal = undefined
      return true
    }),
  focus: (input) =>
    Effect.sync(() => {
      if (input.expectedCurrentGoalID !== undefined) {
        const actual = focusedGoal?.detail.goal.id ?? null
        if (actual !== input.expectedCurrentGoalID) throw new Error("Goal focus changed")
      }
      const detail = goalDetails.get(input.goalID)
      if (!detail) throw new Error(`Goal not found: ${input.goalID}`)
      const next: Goal.Focused = {
        focus: Goal.Focus.make({
          sessionID: input.sessionID,
          goalID: input.goalID,
          role: input.role ?? "owner",
          focusedAt: DateTime.makeUnsafe(T0),
        }),
        detail,
      }
      focusedGoal = next
      return next.focus
    }),
  transition: (input) =>
    Effect.sync(() => {
      const detail = goalDetails.get(input.id)
      if (!detail) throw new Error(`Goal not found: ${input.id}`)
      const status = input.action === "start" ? "active" : input.action === "cancel" ? "cancelled" : detail.goal.status
      const next = {
        ...detail,
        goal: { ...detail.goal, status, revision: detail.goal.revision + 1 },
      } as Goal.Detail
      goalDetails.set(input.id, next)
      if (focusedGoal?.detail.goal.id === input.id) focusedGoal = { ...focusedGoal, detail: next }
      return next
    }),
  prepareForSession: (input) =>
    Effect.sync(() => {
      executionOrder.push("goal")
      goalPrepareInputs.push(input)
      if (focusedGoal) return focusedGoal
      goalCounter++
      const goalID = Goal.ID.make(`gol_scheduled_${goalCounter}`)
      const detail = Goal.Detail.make({
        goal: Goal.Info.make({
          id: goalID,
          projectID: Project.ID.make("prj"),
          title: input.title,
          objective: input.objective,
          constraints: [...(input.constraints ?? [])],
          status: "active",
          revision: 1,
          auditorRuns: 0,
          auditorPolicy: input.auditorPolicy ?? {},
          time: { created: DateTime.makeUnsafe(T0), updated: DateTime.makeUnsafe(T0) },
        }),
        criteria: [],
        steps: [],
      })
      const next: Goal.Focused = {
        focus: Goal.Focus.make({
          sessionID: input.sessionID,
          goalID,
          role: "owner",
          focusedAt: DateTime.makeUnsafe(T0),
        }),
        detail,
      }
      focusedGoal = next
      goalDetails.set(goalID, next.detail)
      return next
    }),
})

const worktreeMock = Layer.mock(Worktree.Service, {
  list: () => Effect.succeed([]),
  create: () => Effect.die(new Error("worktree creation failed")),
  reset: () => Effect.die(new Error("unused")),
  remove: () => Effect.die(new Error("unused")),
  makeWorktreeInfo: () => Effect.die(new Error("unused")),
  createFromInfo: () => Effect.die(new Error("unused")),
})

const appProcessMock = Layer.mock(AppProcess.Service, {})

const eventsMock = Layer.mock(EventV2.Service, {
  listen: () => Effect.succeed(Effect.void),
})

const scheduledTaskMock = Layer.mock(ScheduledTask.Service, {
  markRunStatus: () => Effect.succeed(true),
  attachRunSession: (input) =>
    Effect.sync(() => {
      executionOrder.push("attach")
      attachedRunSessions.push(input as never)
      return true
    }),
  attachRunGoal: (input) =>
    Effect.sync(() => {
      if (!attachRunGoalAllowed) return false
      attachedRunGoals.push(input as never)
      goalOwners.set(input.goalID, { runID: input.runID, taskID: "stk_executor_test" })
      runGoals.set(input.runID, input.goalID)
      return true
    }),
  runGoal: (runID) =>
    Effect.sync(() => {
      const goalID = runGoals.get(runID)
      return goalID === undefined ? undefined : Goal.ID.make(goalID)
    }),
  goalOwner: (goalID) =>
    Effect.sync(() => {
      const owner = goalOwners.get(goalID)
      return owner === undefined
        ? undefined
        : {
            runID: ScheduledTaskModel.RunID.make(owner.runID),
            taskID: ScheduledTaskModel.ID.make(owner.taskID),
          }
    }),
})

const it = testEffect(
  Layer.provide(
    ScheduledTaskExecutor.layer,
    Layer.mergeAll(
      instanceStoreMock,
      fsMock,
      sessionMock,
      promptMock,
      admissionMock,
      bindingMock,
      agentMock,
      providerMock,
      toolRegistryMock,
      permissionMock,
      goalMock,
      worktreeMock,
      appProcessMock,
      eventsMock,
      scheduledTaskMock,
    ),
  ),
)

const reset = () => {
  targetIsDirectory = true
  hostPromptOutcome = "succeeded"
  providedDirectories = []
  cancelledSessions = []
  createdSessions = 0
  hostPromptCalls = 0
  hostPromptProvenance = undefined
  attachedRunSessions = []
  goalPrepareInputs = []
  focusedGoal = undefined
  goalCounter = 0
  goalDetails = new Map()
  goalOwners = new Map()
  runGoals = new Map()
  attachedRunGoals = []
  attachRunGoalAllowed = true
  unfocusedSessions = []
  executionOrder = []
  sessionRegistry = new Map()
  bindingState = undefined
  autoUserChanged = false
  autoLatestUserSeq = undefined
  admissionFenceFailures = 0
  admissionInputs = []
  providerModelUnavailable = false
}

describe("ScheduledTaskExecutor", () => {
  it.effect("D5/N6: a missing target directory is skipped with ZERO instance loads", () =>
    Effect.gen(function* () {
      reset()
      targetIsDirectory = false
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo(),
        runID: ScheduledTaskModel.RunID.make("str_executor_test"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-test",
      })
      expect(outcome).toMatchObject({ status: "skipped", skipReason: "target_missing" })
      expect(providedDirectories).toHaveLength(0)
      expect(hostPromptCalls).toBe(0)
    }),
  )

  it.effect("originates a session and prompts headlessly, returning the session reference on success", () =>
    Effect.gen(function* () {
      reset()
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo(),
        runID: ScheduledTaskModel.RunID.make("str_executor_test"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-test",
      })
      expect(outcome).toMatchObject({ status: "succeeded", sessionID: "ses_scheduled_executor" })
      expect(outcome).not.toHaveProperty("workspaceID")
      expect(createdSessions).toBe(1)
      expect(hostPromptCalls).toBe(1)
      expect(hostPromptProvenance).toMatchObject({
        runID: "str_executor_test",
        attempt: 1,
        sessionID: "ses_scheduled_executor",
        content: { text: "hello" },
      })
      expect(attachedRunSessions).toEqual([
        {
          runID: "str_executor_test",
          attempt: 1,
          sessionID: "ses_scheduled_executor",
          directory: "/scheduled/executor",
        },
      ])
      expect(providedDirectories).toEqual(["/scheduled/executor"])
    }),
  )

  it.effect("binds the run attempt before delegating scheduled Goal composition and prompting", () =>
    Effect.gen(function* () {
      reset()
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({
          action: {
            prompt: "pursue the scheduled objective",
            goal: {
              title: "Scheduled Goal",
              objective: "Complete the scheduled objective",
              criteria: ["the objective is complete"],
            },
          },
        }),
        runID: ScheduledTaskModel.RunID.make("str_executor_goal"),
        attempt: 3,
        fireFor: T0,
        leaseID: "lease-goal",
      })

      expect(outcome).toMatchObject({ status: "succeeded", sessionID: "ses_scheduled_executor" })
      expect(executionOrder).toEqual(["session", "attach", "goal", "prompt"])
      expect(attachedRunSessions[0]).toMatchObject({ runID: "str_executor_goal", attempt: 3 })
      expect(attachedRunGoals).toEqual([
        { runID: "str_executor_goal", attempt: 3, goalID: "gol_scheduled_1" },
      ])
      expect(goalPrepareInputs[0]).toMatchObject({
        sessionID: "ses_scheduled_executor",
        title: "Scheduled Goal",
        objective: "Complete the scheduled objective",
        criteria: ["the objective is complete"],
        start: true,
        actor: "system",
      })
      expect(hostPromptProvenance).toMatchObject({
        runID: "str_executor_goal",
        attempt: 3,
        sessionID: "ses_scheduled_executor",
        content: { text: "hello" },
      })
    }),
  )

  it.effect("D32: never steals an unrelated focused Goal from the execution Session", () =>
    Effect.gen(function* () {
      reset()
      focusedGoal = {
        focus: { sessionID: "ses_scheduled_executor", goalID: "gol_human", role: "owner", focusedAt: T0 },
        detail: {
          goal: {
            id: "gol_human",
            projectID: "prj",
            title: "Human Goal",
            objective: "Human-owned work",
            constraints: [],
            status: "active",
            revision: 1,
            auditorPolicy: {},
            time: { created: DateTime.makeUnsafe(T0), updated: DateTime.makeUnsafe(T0) },
          },
          criteria: [],
          steps: [],
        },
      } as never

      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({
          action: {
            prompt: "scheduled work",
            goal: { title: "Scheduled Goal", objective: "Scheduled objective", criteria: ["done"] },
          },
        }),
        runID: ScheduledTaskModel.RunID.make("str_goal_no_steal"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-goal-no-steal",
      })

      expect(outcome).toMatchObject({ status: "failed", errorKind: "config" })
      expect(unfocusedSessions).toHaveLength(0)
      expect(goalPrepareInputs).toHaveLength(0)
      expect(attachedRunGoals).toHaveLength(0)
      expect(executionOrder).not.toContain("prompt")
    }),
  )

  it.effect("D32: replaces only a terminal Goal proven to belong to an earlier run of the same task", () =>
    Effect.gen(function* () {
      reset()
      focusedGoal = {
        focus: { sessionID: "ses_scheduled_executor", goalID: "gol_previous", role: "owner", focusedAt: T0 },
        detail: {
          goal: {
            id: "gol_previous",
            projectID: "prj",
            title: "Previous Scheduled Goal",
            objective: "Previous objective",
            constraints: [],
            status: "completed",
            revision: 4,
            auditorPolicy: {},
            time: { created: DateTime.makeUnsafe(T0), updated: DateTime.makeUnsafe(T0) },
          },
          criteria: [],
          steps: [],
        },
      } as never
      goalOwners.set("gol_previous", { runID: "str_previous", taskID: "stk_executor_test" })

      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({
          action: {
            prompt: "scheduled work",
            goal: { title: "Next Scheduled Goal", objective: "Next objective", criteria: ["done"] },
          },
        }),
        runID: ScheduledTaskModel.RunID.make("str_goal_next"),
        attempt: 1,
        fireFor: T0 + 1,
        leaseID: "lease-goal-next",
      })

      expect(outcome).toMatchObject({ status: "succeeded" })
      expect(unfocusedSessions).toEqual(["ses_scheduled_executor"])
      expect(attachedRunGoals).toEqual([
        { runID: "str_goal_next", attempt: 1, goalID: "gol_scheduled_1" },
      ])
      expect(executionOrder).toContain("prompt")
    }),
  )

  it.effect("D32: retrying one logical run reuses its correlated Goal even after focus was released", () =>
    Effect.gen(function* () {
      reset()
      const executor = yield* ScheduledTaskExecutor.Service
      const task = taskInfo({
        sessionPolicy: { kind: "reuse" },
        action: {
          prompt: "scheduled work",
          goal: { title: "Retryable Goal", objective: "Finish once", criteria: ["done"] },
        },
      })
      const runID = ScheduledTaskModel.RunID.make("str_goal_retry_same_logical")
      const first = yield* executor.execute({
        task,
        runID,
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-goal-retry-1",
      })
      expect(first.status).toBe("succeeded")
      expect(runGoals.get(runID)).toBe("gol_scheduled_1")
      expect(goalCounter).toBe(1)

      // Simulate focus release between attempts while the durable run->Goal
      // correlation and active Goal both survive.
      focusedGoal = undefined
      const second = yield* executor.execute({
        task,
        runID,
        attempt: 2,
        fireFor: T0,
        leaseID: "lease-goal-retry-2",
      })

      expect(second.status).toBe("succeeded")
      expect(goalCounter).toBe(1)
      expect(goalPrepareInputs).toHaveLength(1)
      expect(attachedRunGoals).toEqual([
        { runID: "str_goal_retry_same_logical", attempt: 1, goalID: "gol_scheduled_1" },
      ])
      expect(readFocusedGoal()?.detail.goal.id).toBe(Goal.ID.make("gol_scheduled_1"))
      expect(hostPromptCalls).toBe(2)
    }),
  )

  it.effect("D32: losing run ownership after Goal creation removes the exact focus and cancels the orphan Goal", () =>
    Effect.gen(function* () {
      reset()
      attachRunGoalAllowed = false
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({
          action: {
            prompt: "scheduled work",
            goal: { title: "Raced Goal", objective: "Do not leak", criteria: ["done"] },
          },
        }),
        runID: ScheduledTaskModel.RunID.make("str_goal_attach_race"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-goal-attach-race",
      })

      expect(outcome).toMatchObject({ status: "failed", errorKind: "config" })
      expect(attachedRunGoals).toHaveLength(0)
      expect(focusedGoal).toBeUndefined()
      expect(goalDetails.get("gol_scheduled_1")?.goal.status).toBe("cancelled")
      expect(unfocusedSessions).toEqual(["ses_scheduled_executor"])
      expect(executionOrder).not.toContain("prompt")
    }),
  )

  it.effect("reuse converges consecutive runs onto one durable task-owned Session", () =>
    Effect.gen(function* () {
      reset()
      const executor = yield* ScheduledTaskExecutor.Service
      const task = taskInfo({ sessionPolicy: { kind: "reuse" } })
      const first = yield* executor.execute({
        task,
        runID: ScheduledTaskModel.RunID.make("str_reuse_1"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-reuse-1",
      })
      const second = yield* executor.execute({
        task,
        runID: ScheduledTaskModel.RunID.make("str_reuse_2"),
        attempt: 1,
        fireFor: T0 + 1,
        leaseID: "lease-reuse-2",
      })

      expect(String(first.sessionID)).toBe("ses_scheduled_executor")
      expect(second.sessionID).toBe(first.sessionID)
      expect(createdSessions).toBe(1)
      expect(bindingState).toMatchObject({
        taskID: "stk_executor_test",
        sessionID: "ses_scheduled_executor",
        generation: 1,
      })
    }),
  )

  it.effect("reuse survives prompt/spec revision drift without rotating the operational Session binding", () =>
    Effect.gen(function* () {
      reset()
      const executor = yield* ScheduledTaskExecutor.Service
      const original = taskInfo({ sessionPolicy: { kind: "reuse" }, revision: 0 })
      const first = yield* executor.execute({
        task: original,
        runID: ScheduledTaskModel.RunID.make("str_reuse_revision_1"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-reuse-revision-1",
      })
      const revised = taskInfo({
        sessionPolicy: { kind: "reuse" },
        revision: 7,
        action: { prompt: "edited prompt only" },
      })
      const second = yield* executor.execute({
        task: revised,
        runID: ScheduledTaskModel.RunID.make("str_reuse_revision_2"),
        attempt: 1,
        fireFor: T0 + 1,
        leaseID: "lease-reuse-revision-2",
      })

      expect(second.sessionID).toBe(first.sessionID)
      expect(createdSessions).toBe(1)
      expect(bindingState).toMatchObject({
        sessionID: first.sessionID,
        taskRevision: 0,
        generation: 1,
      })
    }),
  )

  it.effect("auto reuses an untouched Session, then rotates after semantic User input and carries an admission fence", () =>
    Effect.gen(function* () {
      reset()
      const executor = yield* ScheduledTaskExecutor.Service
      const task = taskInfo({ sessionPolicy: { kind: "auto" } })

      const first = yield* executor.execute({
        task,
        runID: ScheduledTaskModel.RunID.make("str_auto_1"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-auto-1",
      })
      const second = yield* executor.execute({
        task,
        runID: ScheduledTaskModel.RunID.make("str_auto_2"),
        attempt: 1,
        fireFor: T0 + 1,
        leaseID: "lease-auto-2",
      })
      expect(second.sessionID).toBe(first.sessionID)
      expect(createdSessions).toBe(1)

      autoLatestUserSeq = 17
      autoUserChanged = true
      const third = yield* executor.execute({
        task,
        runID: ScheduledTaskModel.RunID.make("str_auto_3"),
        attempt: 1,
        fireFor: T0 + 2,
        leaseID: "lease-auto-3",
      })
      expect(String(third.sessionID)).toBe("ses_scheduled_executor_2")
      expect(createdSessions).toBe(2)
      expect(bindingState).toMatchObject({ sessionID: "ses_scheduled_executor_2", generation: 2, userSeqFence: 17 })
      expect(hostPromptProvenance).toMatchObject({
        runID: "str_auto_3",
        sessionID: "ses_scheduled_executor_2",
        userFence: { expectedLatestUserSeq: 17 },
      })
    }),
  )

  it.effect("D22: Auto closes the final User-fence TOCTOU race by rotating and reattaching the same run", () =>
    Effect.gen(function* () {
      reset()
      admissionFenceFailures = 1
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({ sessionPolicy: { kind: "auto" } }),
        runID: ScheduledTaskModel.RunID.make("str_auto_final_fence"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-auto-final-fence",
      })

      expect(outcome).toMatchObject({
        status: "succeeded",
        sessionID: "ses_scheduled_executor_2",
      })
      expect(createdSessions).toBe(2)
      expect(bindingState).toMatchObject({
        sessionID: "ses_scheduled_executor_2",
        generation: 2,
      })
      expect(admissionInputs).toHaveLength(2)
      expect(admissionInputs.map((input) => String(input.sessionID))).toEqual([
        "ses_scheduled_executor",
        "ses_scheduled_executor_2",
      ])
      expect(attachedRunSessions.map((input) => input.sessionID)).toEqual([
        "ses_scheduled_executor",
        "ses_scheduled_executor_2",
      ])
    }),
  )

  it.effect("D24: Existing executes in the pinned user-owned Session without creating or claiming task ownership", () =>
    Effect.gen(function* () {
      reset()
      sessionRegistry.set(
        "ses_pinned",
        {
          id: "ses_pinned",
          projectID: "prj",
          directory: "/pinned/session-directory",
          agent: "build",
          model: { id: "test-model", providerID: "test" },
          metadata: { callerOwned: true },
        } as unknown as Session.Info,
      )
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({
          sessionPolicy: { kind: "existing", sessionID: "ses_pinned" as never },
          targetDirectory: "/pinned/session-directory",
        }),
        runID: ScheduledTaskModel.RunID.make("str_existing"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-existing",
      })

      expect(outcome).toMatchObject({
        status: "succeeded",
        sessionID: "ses_pinned",
        directory: "/pinned/session-directory",
      })
      expect(createdSessions).toBe(0)
      expect(bindingState).toBeUndefined()
      expect(providedDirectories).toEqual(["/pinned/session-directory"])
      expect(sessionRegistry.get("ses_pinned")?.metadata).toEqual({ callerOwned: true })
    }),
  )

  it.effect("D24/D31: Existing directory mismatch fails config with no fallback", () =>
    Effect.gen(function* () {
      reset()
      sessionRegistry.set(
        "ses_pinned_mismatch",
        {
          id: "ses_pinned_mismatch",
          projectID: "prj",
          directory: "/somewhere-else",
          agent: "build",
          model: { id: "test-model", providerID: "test" },
        } as unknown as Session.Info,
      )
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({
          sessionPolicy: { kind: "existing", sessionID: "ses_pinned_mismatch" as never },
          targetDirectory: "/scheduled/executor",
        }),
        runID: ScheduledTaskModel.RunID.make("str_existing_mismatch"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-existing-mismatch",
      })

      expect(outcome).toMatchObject({
        status: "failed",
        errorKind: "config",
        sessionID: "ses_pinned_mismatch",
        directory: "/scheduled/executor",
      })
      expect(outcome.errorMessage).toContain("Session directory mismatch")
      expect(createdSessions).toBe(0)
      expect(admissionInputs).toHaveLength(0)
      expect(providedDirectories).toHaveLength(0)
    }),
  )

  it.effect("D24: a missing pinned Session fails config without creating a replacement", () =>
    Effect.gen(function* () {
      reset()
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({
          sessionPolicy: { kind: "existing", sessionID: "ses_missing_pinned" as never },
          targetDirectory: "/scheduled/executor",
        }),
        runID: ScheduledTaskModel.RunID.make("str_existing_missing"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-existing-missing",
      })

      expect(outcome).toMatchObject({ status: "failed", errorKind: "config" })
      expect(outcome.errorMessage).toContain("pinned Session not found")
      expect(createdSessions).toBe(0)
      expect(admissionInputs).toHaveLength(0)
      expect(providedDirectories).toHaveLength(0)
    }),
  )

  it.effect("D31: Existing project mismatch is revalidated at fire time and never falls back", () =>
    Effect.gen(function* () {
      reset()
      sessionRegistry.set(
        "ses_pinned_project_mismatch",
        {
          id: "ses_pinned_project_mismatch",
          projectID: "other-project",
          directory: "/scheduled/executor",
          agent: "build",
          model: { id: "test-model", providerID: "test" },
        } as unknown as Session.Info,
      )
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({
          projectID: "prj" as never,
          sessionPolicy: { kind: "existing", sessionID: "ses_pinned_project_mismatch" as never },
        }),
        runID: ScheduledTaskModel.RunID.make("str_existing_project_mismatch"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-existing-project-mismatch",
      })

      expect(outcome).toMatchObject({ status: "failed", errorKind: "config" })
      expect(outcome.errorMessage).toContain("Session project mismatch")
      expect(createdSessions).toBe(0)
      expect(admissionInputs).toHaveLength(0)
      expect(providedDirectories).toHaveLength(0)
    }),
  )

  it.effect("forwards the exact explicit provider/model/account/variant as trusted Synthetic execution identity", () =>
    Effect.gen(function* () {
      reset()
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({
          action: {
            prompt: "use the selected model",
            model: {
              id: "explicit-model" as never,
              providerID: "explicit-provider" as never,
              accountID: "account-42",
              variant: "high" as never,
            },
          },
        }),
        runID: ScheduledTaskModel.RunID.make("str_explicit_model"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-explicit-model",
      })

      expect(outcome.status).toBe("succeeded")
      expect(admissionInputs).toHaveLength(1)
      expect(admissionInputs[0]?.execution).toEqual({
        agent: "build",
        model: {
          id: ModelV2.ID.make("explicit-model"),
          providerID: ProviderV2.ID.make("explicit-provider"),
          accountID: "account-42",
          variant: ModelV2.VariantID.make("high"),
        },
        routeIntent: { kind: "account", accountID: "account-42", pin: "hard" },
      })
      expect(sessionRegistry.get("ses_scheduled_executor")?.model).toMatchObject({
        id: "explicit-model",
        providerID: "explicit-provider",
        accountID: "account-42",
        variant: "high",
      })
    }),
  )

  it.effect("D27: an unavailable explicit execution model fails config without falling back", () =>
    Effect.gen(function* () {
      reset()
      providerModelUnavailable = true
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({
          action: {
            prompt: "use only the explicitly selected model",
            model: {
              id: "missing-model" as never,
              providerID: "explicit-provider" as never,
              accountID: "account-42",
              variant: "high" as never,
            },
          },
        }),
        runID: ScheduledTaskModel.RunID.make("str_explicit_model_missing"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-explicit-model-missing",
      })

      expect(outcome).toMatchObject({ status: "failed", errorKind: "config" })
      expect(outcome.errorMessage).toContain("model unavailable: explicit-provider/missing-model")
      expect(admissionInputs).toHaveLength(0)
      expect(hostPromptCalls).toBe(0)
    }),
  )

  it.effect("the wall-clock ceiling aborts the session and settles as failed/timeout", () =>
    Effect.gen(function* () {
      reset()
      hostPromptOutcome = "timeout"
      const executor = yield* ScheduledTaskExecutor.Service
      const fiber = yield* executor
        .execute({
          task: taskInfo({ policy: { ...taskInfo().policy, maxDurationMs: 60_000 } }),
          runID: ScheduledTaskModel.RunID.make("str_executor_test"),
          attempt: 1,
          fireFor: T0,
          leaseID: "lease-test",
        })
        .pipe(Effect.forkScoped)
      yield* TestClock.adjust("61 seconds")
      const outcome = yield* Fiber.join(fiber)
      expect(outcome).toMatchObject({ status: "failed", errorKind: "timeout", sessionID: "ses_scheduled_executor" })
      expect(cancelledSessions).toEqual(["ses_scheduled_executor"])
    }),
  )

  it.effect("classifies a quota failure into a retryable error kind", () =>
    Effect.gen(function* () {
      reset()
      hostPromptOutcome = "quota-error"
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo(),
        runID: ScheduledTaskModel.RunID.make("str_executor_test"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-test",
      })
      expect(outcome).toMatchObject({ status: "failed", errorKind: "quota" })
    }),
  )

  it.effect("worktree preparation failure is a failure, never a silent demotion", () =>
    Effect.gen(function* () {
      reset()
      const executor = yield* ScheduledTaskExecutor.Service
      const outcome = yield* executor.execute({
        task: taskInfo({ target: { kind: "worktree", reuse: true } }),
        runID: ScheduledTaskModel.RunID.make("str_executor_test"),
        attempt: 1,
        fireFor: T0,
        leaseID: "lease-test",
      })
      expect(outcome.status).toBe("failed")
      expect(outcome.errorKind).toBe("internal")
      expect(outcome.errorMessage).toContain("worktree preparation failed")
      expect(hostPromptCalls).toBe(0)
    }),
  )
})
