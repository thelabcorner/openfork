import { beforeEach, describe, expect, mock } from "bun:test"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectSchema } from "@opencode-ai/core/project/schema"
import { SessionInput } from "@opencode-ai/core/session/input"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTurnProvenance } from "@opencode-ai/core/session/turn-provenance"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskProvenance } from "@opencode-ai/core/scheduled-task/provenance"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { testEffect } from "./lib/effect"

type Sent = {
  readonly body: string
  readonly options?: { readonly TTL?: number; readonly urgency?: string; readonly topic?: string }
}

const sent: Sent[] = []

void mock.module("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "test-public", privateKey: "test-private" }),
    setVapidDetails: () => undefined,
    sendNotification: async (
      _subscription: unknown,
      body: string,
      options?: { TTL?: number; urgency?: string; topic?: string },
    ) => {
      sent.push({ body, options })
      return { statusCode: 201 }
    },
  },
}))

const { PushV2 } = await import("@opencode-ai/core/push")

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, ScheduledTask.node, PushV2.node]),
  [[Database.node, Database.layerFromPath(":memory:")]],
)
const it = testEffect(layer)

const NOW = Date.parse("2026-09-18T20:00:00-05:00")

function decode(index: number) {
  return JSON.parse(sent[index]!.body) as {
    notification: {
      title: string
      navigate: string
      data?: Record<string, unknown>
    }
  }
}

const waitFor = Effect.fnUntraced(function* (count: number) {
  while (sent.length < count) yield* Effect.yieldNow
})

const subscribe = Effect.fnUntraced(function* () {
  const push = yield* PushV2.Service
  yield* push.subscribe({
    endpoint: "https://push.example.test/device",
    keys: { p256dh: "p256dh", auth: "auth" },
    userAgentHint: "scheduled-task-test",
  })
})

const insertSession = Effect.fnUntraced(function* (input: {
  readonly id: SessionSchema.ID
  readonly projectID: ProjectSchema.ID
  readonly metadata?: Record<string, unknown>
}) {
  const { db } = yield* Database.Service
  yield* db
    .insert(SessionTable)
    .values({
      id: input.id,
      project_id: input.projectID,
      slug: input.id,
      directory: "/scheduled/push-test" as never,
      title: input.id,
      version: "test",
      metadata: input.metadata,
      time_created: NOW,
      time_updated: NOW,
    })
    .run()
    .pipe(Effect.orDie)
})

const promoteScheduledRoot = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  runID: import("@opencode-ai/schema/scheduled-task").ScheduledTask.RunID,
) {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const messageID = SessionMessage.ID.make(`msg_scheduled_root_${runID}`)
  yield* SessionInput.admitSynthetic(db, events, {
    id: messageID,
    sessionID,
    content: SessionInput.SyntheticContent.make({ text: "scheduled work" }),
    origin: SessionInput.SyntheticOrigin.make({
      producer: SessionTurnProvenance.Source.ScheduledTaskRun,
      actor: { type: "host" },
      ref: runID,
    }),
    admissionClass: "host",
    delivery: "queue",
    userPreemptible: true,
  })
  expect(yield* SessionInput.promoteNextQueued(db, events, sessionID)).toBe(true)
  return messageID
})

const promoteGoalContinuation = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  rootMessageID: SessionMessage.ID,
  suffix: string,
) {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  yield* SessionInput.admitSynthetic(db, events, {
    id: SessionMessage.ID.make(`msg_goal_continuation_${suffix}`),
    sessionID,
    content: SessionInput.SyntheticContent.make({ text: "continue scheduled Goal" }),
    origin: SessionInput.SyntheticOrigin.make({
      producer: SessionTurnProvenance.Source.GoalContinuation,
      actor: { type: "host" },
      ref: `goal-reservation-${suffix}`,
      cause: { sessionID, messageID: rootMessageID },
    }),
    admissionClass: "automatic",
    delivery: "queue",
    expectedLatestUserSeq: undefined,
  })
  expect(yield* SessionInput.promoteNextQueued(db, events, sessionID)).toBe(true)
})

const promoteHumanRoot = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, suffix: string) {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  yield* SessionInput.admit(db, events, {
    id: SessionMessage.ID.make(`msg_human_root_${suffix}`),
    sessionID,
    prompt: Prompt.make({ text: "human follow-up" }),
    delivery: "queue",
    provenance: SessionTurnProvenance.user(SessionTurnProvenance.Source.Prompt),
  })
  expect(yield* SessionInput.promoteNextQueued(db, events, sessionID)).toBe(true)
})

describe("PushV2 scheduled-task ownership", () => {
  beforeEach(() => {
    sent.length = 0
  })

  it.live("suppresses generic Session failure pushes for scheduler-owned Sessions", () =>
    Effect.gen(function* () {
      yield* subscribe()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const projectID = ProjectSchema.ID.make("prj_push_scheduled")
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: "/scheduled/push-test" as never,
          name: "Push test",
          sandboxes: [],
          time_created: NOW,
          time_updated: NOW,
        })
        .run()
        .pipe(Effect.orDie)

      const scheduledSessionID = SessionSchema.ID.descending("ses_scheduled_push")
      const normalSessionID = SessionSchema.ID.descending("ses_normal_push")
      const tasks = yield* ScheduledTask.Service
      const scheduledTask = yield* tasks.create({
        targetDirectory: "/scheduled/push-test",
        name: "Active failure",
        enabled: true,
        schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
        timezone: "America/Chicago",
        action: { prompt: "hello" },
        now: NOW,
      })
      yield* insertSession({
        id: scheduledSessionID,
        projectID,
        metadata: ScheduledTaskProvenance.taskSessionMetadata({ taskID: scheduledTask.id }),
      })
      yield* insertSession({ id: normalSessionID, projectID })
      const started = yield* tasks.recordRunStart({
        taskID: scheduledTask.id,
        fireFor: scheduledTask.nextRunAt!,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: NOW + 1,
      })
      if (started.kind !== "started") return
      yield* tasks.attachRunSession({
        runID: started.run.id,
        attempt: 1,
        sessionID: scheduledSessionID,
        directory: "/scheduled/push-test",
      })
      const scheduledRootID = yield* promoteScheduledRoot(scheduledSessionID, started.run.id)

      const error = { type: "unknown" as const, message: "boom" }
      yield* events.publish(SessionEvent.Step.Failed, {
        sessionID: scheduledSessionID,
        assistantMessageID: SessionMessage.ID.make("msg_scheduled_push"),
        timestamp: DateTime.makeUnsafe(NOW),
        error,
      })
      // Same subscriber, later event: observing this push proves the scheduled
      // event above was already evaluated rather than merely racing the assert.
      yield* events.publish(SessionEvent.Step.Failed, {
        sessionID: normalSessionID,
        assistantMessageID: SessionMessage.ID.make("msg_normal_push"),
        timestamp: DateTime.makeUnsafe(NOW + 1),
        error,
      })
      yield* waitFor(1)
      yield* Effect.yieldNow

      expect(sent).toHaveLength(1)
      expect(decode(0).notification.data).toMatchObject({
        kind: "session-failed",
        sessionID: normalSessionID,
      })
    }),
  )

  it.live("suppresses generic Session completion pushes for scheduler-owned Sessions", () =>
    Effect.gen(function* () {
      yield* subscribe()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const projectID = ProjectSchema.ID.make("prj_push_scheduled_done")
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: "/scheduled/push-test" as never,
          name: "Push test",
          sandboxes: [],
          time_created: NOW,
          time_updated: NOW,
        })
        .run()
        .pipe(Effect.orDie)

      const scheduledSessionID = SessionSchema.ID.descending("ses_scheduled_push_done")
      const normalSessionID = SessionSchema.ID.descending("ses_normal_push_done")
      const tasks = yield* ScheduledTask.Service
      const scheduledTask = yield* tasks.create({
        targetDirectory: "/scheduled/push-test",
        name: "Active completion",
        enabled: true,
        schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
        timezone: "America/Chicago",
        action: { prompt: "hello" },
        now: NOW,
      })
      yield* insertSession({
        id: scheduledSessionID,
        projectID,
        metadata: ScheduledTaskProvenance.taskSessionMetadata({ taskID: scheduledTask.id }),
      })
      yield* insertSession({ id: normalSessionID, projectID })
      const started = yield* tasks.recordRunStart({
        taskID: scheduledTask.id,
        fireFor: scheduledTask.nextRunAt!,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: NOW + 1,
      })
      if (started.kind !== "started") return
      yield* tasks.attachRunSession({
        runID: started.run.id,
        attempt: 1,
        sessionID: scheduledSessionID,
        directory: "/scheduled/push-test",
      })
      const scheduledRootID = yield* promoteScheduledRoot(scheduledSessionID, started.run.id)

      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: scheduledSessionID,
        status: { type: "busy" },
      })
      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: scheduledSessionID,
        status: { type: "idle" },
      })
      // Same status subscriber: the later normal idle push is our barrier.
      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: normalSessionID,
        status: { type: "busy" },
      })
      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: normalSessionID,
        status: { type: "idle" },
      })
      yield* waitFor(1)
      yield* Effect.yieldNow

      expect(sent).toHaveLength(1)
      expect(decode(0).notification.data).toMatchObject({
        kind: "session-done",
        sessionID: normalSessionID,
      })

      // D26: a derived Goal continuation remains causally rooted in the
      // Scheduled worker root. It must not manufacture a generic Session-done
      // push merely because its immediate producer is goal.continuation.
      yield* promoteGoalContinuation(scheduledSessionID, scheduledRootID, "completion")
      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: scheduledSessionID,
        status: { type: "busy" },
      })
      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: scheduledSessionID,
        status: { type: "idle" },
      })
      // Same subscriber barrier after the derived Scheduled cycle.
      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: normalSessionID,
        status: { type: "busy" },
      })
      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: normalSessionID,
        status: { type: "idle" },
      })
      yield* waitFor(2)
      expect(sent).toHaveLength(2)
      expect(decode(1).notification.data).toMatchObject({
        kind: "session-done",
        sessionID: normalSessionID,
      })

      // D26: the logical Scheduled run deliberately remains active. Once a
      // human root becomes the latest promoted worker root, aggregate/task
      // ownership must not suppress the human turn's generic completion push.
      yield* promoteHumanRoot(scheduledSessionID, "completion")
      expect((yield* tasks.listRuns({ taskID: scheduledTask.id }))[0]?.status).toBe("running")
      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: scheduledSessionID,
        status: { type: "busy" },
      })
      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: scheduledSessionID,
        status: { type: "idle" },
      })
      yield* waitFor(3)
      expect(decode(2).notification.data).toMatchObject({
        kind: "session-done",
        sessionID: scheduledSessionID,
      })
    }),
  )

  it.live("D26: a promoted human root regains generic failure ownership while the Scheduled run is still active", () =>
    Effect.gen(function* () {
      yield* subscribe()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const projectID = ProjectSchema.ID.make("prj_push_scheduled_human_failure")
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: "/scheduled/push-test" as never,
          name: "Push test",
          sandboxes: [],
          time_created: NOW,
          time_updated: NOW,
        })
        .run()
        .pipe(Effect.orDie)

      const sessionID = SessionSchema.ID.descending("ses_scheduled_human_failure")
      const tasks = yield* ScheduledTask.Service
      const task = yield* tasks.create({
        targetDirectory: "/scheduled/push-test",
        name: "Human failure ownership",
        enabled: true,
        schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
        timezone: "America/Chicago",
        action: { prompt: "hello" },
        now: NOW,
      })
      yield* insertSession({
        id: sessionID,
        projectID,
        metadata: ScheduledTaskProvenance.taskSessionMetadata({ taskID: task.id }),
      })
      const started = yield* tasks.recordRunStart({
        taskID: task.id,
        fireFor: task.nextRunAt!,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: NOW + 1,
      })
      if (started.kind !== "started") return
      yield* tasks.attachRunSession({
        runID: started.run.id,
        attempt: 1,
        sessionID,
        directory: "/scheduled/push-test",
      })
      yield* promoteScheduledRoot(sessionID, started.run.id)

      const error = { type: "unknown" as const, message: "scheduled root failed" }
      yield* events.publish(SessionEvent.Step.Failed, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_scheduled_owned_failure"),
        timestamp: DateTime.makeUnsafe(NOW + 2),
        error,
      })

      yield* promoteHumanRoot(sessionID, "failure")
      expect((yield* tasks.listRuns({ taskID: task.id }))[0]?.status).toBe("running")
      yield* events.publish(SessionEvent.Step.Failed, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_human_owned_failure"),
        timestamp: DateTime.makeUnsafe(NOW + 3),
        error: { type: "unknown", message: "human turn failed" },
      })
      yield* waitFor(1)
      yield* Effect.yieldNow

      expect(sent).toHaveLength(1)
      expect(decode(0).notification.data).toMatchObject({
        kind: "session-failed",
        sessionID,
      })
    }),
  )

  it.live("honors never/failure policy from durable run truth without duplicate generic pushes", () =>
    Effect.gen(function* () {
      yield* subscribe()
      const tasks = yield* ScheduledTask.Service

      const create = (name: string, notify: "never" | "failure") =>
        tasks.create({
          targetDirectory: "/scheduled/push-test",
          name,
          enabled: true,
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          timezone: "America/Chicago",
          action: { prompt: "hello" },
          policy: { notify, maxAttempts: 1 },
          now: NOW,
        })

      const silentTask = yield* create("Silent task", "never")
      const failureTask = yield* create("Failure task", "failure")
      const silentStart = yield* tasks.recordRunStart({
        taskID: silentTask.id,
        fireFor: silentTask.nextRunAt!,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: NOW + 1,
      })
      const failureStart = yield* tasks.recordRunStart({
        taskID: failureTask.id,
        fireFor: failureTask.nextRunAt!,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: NOW + 2,
      })
      expect(silentStart.kind).toBe("started")
      expect(failureStart.kind).toBe("started")
      if (silentStart.kind !== "started" || failureStart.kind !== "started") return

      yield* tasks.settleRun({
        taskID: silentTask.id,
        runID: silentStart.run.id,
        fireFor: silentTask.nextRunAt!,
        status: "failed",
        errorKind: "config",
        errorMessage: "silent failure",
        now: NOW + 3,
        attempt: 1,
      })
      // Same RunSettled subscriber; when this later event sends, the silent
      // settlement has already been consumed and suppressed.
      yield* tasks.settleRun({
        taskID: failureTask.id,
        runID: failureStart.run.id,
        fireFor: failureTask.nextRunAt!,
        status: "failed",
        errorKind: "config",
        errorMessage: "visible failure",
        sessionID: SessionSchema.ID.descending("ses_scheduled_outcome"),
        now: NOW + 4,
        attempt: 1,
      })
      yield* waitFor(1)
      yield* Effect.yieldNow

      expect(sent).toHaveLength(1)
      const notification = decode(0).notification
      expect(notification.title).toBe("Failed · Failure task")
      expect(notification.navigate).toBe("/session/ses_scheduled_outcome")
      expect(notification.data).toMatchObject({
        kind: "scheduled-task-run",
        taskID: failureTask.id,
        runID: failureStart.run.id,
        status: "failed",
      })
    }),
  )

  it.live("suppresses an intermediate retry failure and notifies only the exhausted logical run", () =>
    Effect.gen(function* () {
      yield* subscribe()
      const tasks = yield* ScheduledTask.Service
      const task = yield* tasks.create({
        targetDirectory: "/scheduled/push-test",
        name: "Retry task",
        enabled: true,
        schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
        timezone: "America/Chicago",
        action: { prompt: "hello" },
        policy: { notify: "failure", maxAttempts: 2 },
        now: NOW,
      })
      const fireFor = task.nextRunAt!
      const first = yield* tasks.recordRunStart({
        taskID: task.id,
        fireFor,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: NOW + 1,
      })
      expect(first.kind).toBe("started")
      if (first.kind !== "started") return

      const firstSettle = yield* tasks.settleRun({
        taskID: task.id,
        runID: first.run.id,
        fireFor,
        status: "failed",
        errorKind: "provider",
        errorMessage: "retry me",
        now: NOW + 2,
        attempt: 1,
      })
      expect(firstSettle.retryAt).toBeDefined()

      const second = yield* tasks.recordRunStart({
        taskID: task.id,
        fireFor,
        trigger: "retry",
        attempt: 2,
        acceptExisting: "retry",
        now: firstSettle.retryAt!,
      })
      expect(second.kind).toBe("started")
      if (second.kind !== "started") return

      yield* tasks.settleRun({
        taskID: task.id,
        runID: second.run.id,
        fireFor,
        status: "failed",
        errorKind: "provider",
        errorMessage: "retry exhausted",
        now: firstSettle.retryAt! + 1,
        attempt: 2,
      })
      yield* waitFor(1)
      yield* Effect.yieldNow

      expect(sent).toHaveLength(1)
      const notification = decode(0).notification
      expect(notification.navigate).toBe("/")
      expect(notification.data).toMatchObject({
        kind: "scheduled-task-run",
        taskID: task.id,
        runID: second.run.id,
        status: "failed",
      })
    }),
  )
})
