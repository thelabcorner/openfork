import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { SessionInput } from "@opencode-ai/core/session/input"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionID } from "@opencode-ai/schema/session-id"
import { eq } from "drizzle-orm"
import { SessionPrompt } from "@/session/prompt"
import { ScheduledTaskSessionAdmission } from "@/scheduled-task/session-admission"
import { testEffect } from "../lib/effect"

const T0 = Date.parse("2026-09-19T23:45:00Z")
const directory = "/scheduled/admission"
const sessionA = SessionID.make("ses_scheduled_admission_a")
const sessionB = SessionID.make("ses_scheduled_admission_b")

const promptLayer = Layer.effect(
  SessionPrompt.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    return SessionPrompt.Service.of({
      admitSynthetic: (input: Parameters<SessionPrompt.Interface["admitSynthetic"]>[0]) =>
        SessionInput.admitSynthetic(db, events, input),
      loop: (input: Parameters<SessionPrompt.Interface["loop"]>[0]) =>
        Effect.succeed({
          info: {
            role: "assistant",
            id: "msg_scheduled_admission_assistant",
            sessionID: input.sessionID,
            time: { created: T0 },
          },
          parts: [],
        } as never),
    } as never)
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      ScheduledTask.node,
      ScheduledTaskSessionAdmission.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [SessionPrompt.node, promptLayer],
    ],
  ),
)

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({
      id: Project.ID.global,
      worktree: directory as never,
      sandboxes: [],
      time_created: T0,
      time_updated: T0,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionA,
        project_id: Project.ID.global,
        slug: "scheduled-admission-a",
        directory,
        title: "scheduled admission a",
        version: "test",
        time_created: T0,
        time_updated: T0,
      },
      {
        id: sessionB,
        project_id: Project.ID.global,
        slug: "scheduled-admission-b",
        directory,
        title: "scheduled admission b",
        version: "test",
        time_created: T0,
        time_updated: T0,
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

const createStarted = (name: string, sessionID = sessionA) =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTask.Service
    const task = yield* tasks.create({
      targetDirectory: directory,
      name,
      enabled: false,
      schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
      action: { prompt: "scheduled work" },
      sessionPolicy: { kind: "new" },
      now: T0,
    })
    const started = yield* tasks.recordRunStart({
      taskID: task.id,
      fireFor: T0,
      trigger: "manual",
      attempt: 1,
      acceptExisting: "none",
      now: T0,
    })
    if (started.kind !== "started") return yield* Effect.die("run did not start")
    const attached = yield* tasks.attachRunSession({
      runID: started.run.id,
      attempt: 1,
      sessionID,
      directory,
    })
    if (!attached) return yield* Effect.die("run did not attach")
    return { task, run: started.run }
  })

const dispatchInput = (
  runID: ScheduledTask.RunID,
  sessionID: SessionID,
  attempt = 1,
  userFence?: { expectedLatestUserSeq: number | undefined },
): ScheduledTaskSessionAdmission.DispatchInput => ({
  runID,
  attempt,
  sessionID,
  content: { text: "scheduled work" },
  execution: {
    agent: "build",
    model: { id: "test-model" as never, providerID: "test-provider" as never },
  },
  ...(userFence ? { userFence } : {}),
})

describe("ScheduledTaskSessionAdmission", () => {
  it.effect("D25: atomically authorizes host admission from exact durable run/session/attempt correlation", () =>
    Effect.gen(function* () {
      yield* seed
      const admission = yield* ScheduledTaskSessionAdmission.Service
      const { run } = yield* createStarted("successful-admission")

      const entry = yield* admission.admit(dispatchInput(run.id, sessionA))
      expect(entry).toMatchObject({
        id: ScheduledTaskSessionAdmission.inputID(run.id, 1),
        sessionID: sessionA,
        kind: "synthetic",
        admissionClass: "host",
        item: {
          type: "synthetic",
          origin: { producer: "scheduled-task.run", ref: run.id },
          execution: {
            agent: "build",
            model: { id: "test-model", providerID: "test-provider" },
          },
        },
      })
    }),
  )

  it.effect("D25: rejects a wrong Session before admission and leaves no durable input row", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const admission = yield* ScheduledTaskSessionAdmission.Service
      const { run } = yield* createStarted("wrong-session")

      const error = yield* admission.admit(dispatchInput(run.id, sessionB)).pipe(Effect.flip)
      expect(error._tag).toBe("ScheduledTask.ValidationError")
      expect(yield* SessionInput.findEntry(db, ScheduledTaskSessionAdmission.inputID(run.id, 1))).toBeUndefined()
    }),
  )

  it.effect("rolls back the Synthetic admission when the exact User frontier changed", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const admission = yield* ScheduledTaskSessionAdmission.Service
      const { run } = yield* createStarted("user-fence")

      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.make("msg_scheduled_admission_user"),
        sessionID: sessionA,
        prompt: Prompt.make({ text: "human intervened" }),
        delivery: "steer",
        provenance: SessionMessage.Provenance.make({ owner: "user", source: "prompt" }),
      })
      const error = yield* admission
        .admit(dispatchInput(run.id, sessionA, 1, { expectedLatestUserSeq: undefined }))
        .pipe(Effect.flip)
      expect((error as { _tag?: string })._tag).toBe("SessionInput.AdmissionFenceConflict")
      expect(yield* SessionInput.findEntry(db, ScheduledTaskSessionAdmission.inputID(run.id, 1))).toBeUndefined()
    }),
  )

  it.effect("rejects a stale retry attempt and never admits its stale Session turn", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const tasks = yield* ScheduledTask.Service
      const admission = yield* ScheduledTaskSessionAdmission.Service
      const { task, run } = yield* createStarted("stale-attempt")
      const settled = yield* tasks.settleRun({
        taskID: task.id,
        runID: run.id,
        fireFor: T0,
        status: "failed",
        errorKind: "quota",
        now: T0 + 1,
        attempt: 1,
      })
      const second = yield* tasks.recordRunStart({
        taskID: task.id,
        fireFor: T0,
        trigger: "retry",
        attempt: 2,
        acceptExisting: "retry",
        now: settled.retryAt ?? T0 + 60_000,
      })
      if (second.kind !== "started") return yield* Effect.die("retry did not start")
      expect(
        yield* tasks.attachRunSession({
          runID: run.id,
          attempt: 2,
          sessionID: sessionB,
          directory,
        }),
      ).toBe(true)

      const error = yield* admission.admit(dispatchInput(run.id, sessionA, 1)).pipe(Effect.flip)
      expect(error._tag).toBe("ScheduledTask.RunAttemptConflictError")
      expect(yield* SessionInput.findEntry(db, ScheduledTaskSessionAdmission.inputID(run.id, 1))).toBeUndefined()
    }),
  )

  it.effect("a retry revokes a still-pending predecessor input before admitting the new attempt", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const tasks = yield* ScheduledTask.Service
      const admission = yield* ScheduledTaskSessionAdmission.Service
      const { task, run } = yield* createStarted("retry-revokes")
      yield* admission.admit(dispatchInput(run.id, sessionA, 1))

      const settled = yield* tasks.settleRun({
        taskID: task.id,
        runID: run.id,
        fireFor: T0,
        status: "failed",
        errorKind: "quota",
        now: T0 + 1,
        attempt: 1,
      })
      const second = yield* tasks.recordRunStart({
        taskID: task.id,
        fireFor: T0,
        trigger: "retry",
        attempt: 2,
        acceptExisting: "retry",
        now: settled.retryAt ?? T0 + 60_000,
      })
      if (second.kind !== "started") return yield* Effect.die("retry did not start")
      expect(
        yield* tasks.attachRunSession({
          runID: run.id,
          attempt: 2,
          sessionID: sessionB,
          directory,
        }),
      ).toBe(true)

      yield* admission.admit(dispatchInput(run.id, sessionB, 2))
      expect(yield* SessionInput.findEntry(db, ScheduledTaskSessionAdmission.inputID(run.id, 1))).toMatchObject({
        revokedReason: "cancelled",
      })
      const current = yield* SessionInput.findEntry(db, ScheduledTaskSessionAdmission.inputID(run.id, 2))
      expect(current?.sessionID).toBe(sessionB)
      expect(current?.revokedSeq).toBeUndefined()

      const rows = yield* db
        .select({ id: SessionInputTable.id })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionB))
        .all()
        .pipe(Effect.orDie)
      expect(rows.some((row) => row.id === ScheduledTaskSessionAdmission.inputID(run.id, 2))).toBe(true)
    }),
  )
})
