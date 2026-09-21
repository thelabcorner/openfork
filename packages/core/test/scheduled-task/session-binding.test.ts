import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { ScheduledTaskSessionBindingTable } from "@opencode-ai/core/scheduled-task/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@opencode-ai/schema/session-id"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, ScheduledTask.node, ScheduledTaskSessionBinding.node]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

const T0 = Date.parse("2026-09-19T22:45:00Z")
const projectID = ProjectV2.ID.make("scheduled-binding-project")
const directory = AbsolutePath.make("/scheduled/binding-project")
const sessionA = SessionID.make("ses_scheduled_binding_a")
const sessionB = SessionID.make("ses_scheduled_binding_b")

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: directory, sandboxes: [], time_created: T0, time_updated: T0 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionA,
        project_id: projectID,
        slug: "binding-a",
        directory,
        title: "binding a",
        version: "test",
        time_created: T0,
        time_updated: T0,
      },
      {
        id: sessionB,
        project_id: projectID,
        slug: "binding-b",
        directory,
        title: "binding b",
        version: "test",
        time_created: T0,
        time_updated: T0,
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

const createTask = (name: string, kind: "reuse" | "auto" = "auto") =>
  ScheduledTask.Service.use((tasks) =>
    tasks.create({
      projectID,
      targetDirectory: directory,
      name,
      enabled: false,
      schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
      timezone: "UTC",
      action: { prompt: "run" },
      sessionPolicy: { kind },
      now: T0,
    }),
  )

describe("ScheduledTaskSessionBinding", () => {
  it.effect("D30: returns only history-free eligible user-drivable root Session candidates", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const bindings = yield* ScheduledTaskSessionBinding.Service
      const child = SessionID.make("ses_scheduled_candidate_child")
      const special = SessionID.make("ses_scheduled_candidate_special")
      const scheduled = SessionID.make("ses_scheduled_candidate_owned")
      const delegated = SessionID.make("ses_scheduled_candidate_delegated")
      const archived = SessionID.make("ses_scheduled_candidate_archived")
      const wrongDirectory = SessionID.make("ses_scheduled_candidate_elsewhere")

      yield* db
        .insert(SessionTable)
        .values([
          {
            id: child,
            project_id: projectID,
            parent_id: sessionA,
            slug: "candidate-child",
            directory,
            title: "child",
            version: "test",
            time_created: T0,
            time_updated: T0 + 10,
          },
          {
            id: special,
            project_id: projectID,
            slug: "candidate-special",
            directory,
            title: "special",
            version: "test",
            metadata: { specialAgent: "prompt_revisor" },
            time_created: T0,
            time_updated: T0 + 9,
          },
          {
            id: scheduled,
            project_id: projectID,
            slug: "candidate-scheduled",
            directory,
            title: "scheduled",
            version: "test",
            metadata: { scheduledTaskID: "task_foreign" },
            time_created: T0,
            time_updated: T0 + 8,
          },
          {
            id: delegated,
            project_id: projectID,
            slug: "candidate-delegated",
            directory,
            title: "delegated",
            version: "test",
            metadata: { workerDelegation: { producer: "oxp" } },
            time_created: T0,
            time_updated: T0 + 7,
          },
          {
            id: archived,
            project_id: projectID,
            slug: "candidate-archived",
            directory,
            title: "archived",
            version: "test",
            time_created: T0,
            time_updated: T0 + 6,
            time_archived: T0 + 6,
          },
          {
            id: wrongDirectory,
            project_id: projectID,
            slug: "candidate-elsewhere",
            directory: AbsolutePath.make("/scheduled/elsewhere"),
            title: "elsewhere",
            version: "test",
            time_created: T0,
            time_updated: T0 + 5,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      // A large input payload must not be needed to build the picker row. The
      // candidate projection reads SessionTable only and returns no history.
      yield* db
        .insert(SessionInputTable)
        .values({
          id: SessionMessage.ID.make("msg_scheduled_candidate_history"),
          session_id: sessionA,
          kind: "user",
          admission_class: "user",
          user_preemptible: false,
          input: null,
          prompt: Prompt.make({ text: "x".repeat(32_768) }),
          delivery: "queue",
          admitted_seq: 1,
          time_created: T0 + 1,
        })
        .run()
        .pipe(Effect.orDie)

      const candidates = yield* bindings.candidates({ targetDirectory: directory, projectID, limit: 100 })
      expect(new Set(candidates.map((candidate) => candidate.id))).toEqual(new Set([sessionA, sessionB]))
      for (const candidate of candidates) {
        expect(Object.keys(candidate).sort()).toEqual(["directory", "id", "projectID", "timeUpdated", "title"])
        expect(candidate.directory).toBe(directory)
        expect(candidate.projectID).toBe(projectID)
      }
    }),
  )

  it.effect("D21: Auto compares SessionInput.latestUserSeq semantics without transcript scans", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const bindings = yield* ScheduledTaskSessionBinding.Service
      const task = yield* createTask("auto")

      const first = yield* bindings.install({
        taskID: task.id,
        taskRevision: task.revision,
        sessionID: sessionA,
        expectedGeneration: undefined,
        now: T0,
      })
      expect(first).toMatchObject({
        taskID: task.id,
        sessionID: sessionA,
        taskRevision: 0,
        generation: 1,
      })
      expect(first?.userSeqFence).toBeUndefined()
      expect(yield* bindings.inspectAuto(task.id)).toMatchObject({ userChanged: false })

      yield* db
        .insert(SessionInputTable)
        .values({
          id: SessionMessage.ID.make("msg_scheduled_binding_user"),
          session_id: sessionA,
          kind: "user",
          admission_class: "user",
          user_preemptible: false,
          input: null,
          prompt: Prompt.make({ text: "human follow-up" }),
          delivery: "queue",
          admitted_seq: 7,
          time_created: T0 + 1,
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* bindings.inspectAuto(task.id)).toMatchObject({
        latestUserSeq: 7,
        userChanged: true,
      })

      const second = yield* bindings.install({
        taskID: task.id,
        taskRevision: task.revision,
        sessionID: sessionB,
        expectedGeneration: first!.generation,
        now: T0 + 2,
      })
      expect(second).toMatchObject({ sessionID: sessionB, generation: 2 })
      expect(second?.userSeqFence).toBeUndefined()

      const stale = yield* bindings.install({
        taskID: task.id,
        taskRevision: task.revision,
        sessionID: sessionA,
        expectedGeneration: first!.generation,
        now: T0 + 3,
      })
      expect(stale).toBeUndefined()
      expect((yield* bindings.get(task.id))?.sessionID).toBe(sessionB)
    }),
  )

  it.effect("D23: task-revision/generation CAS rejects stale binding installation", () =>
    Effect.gen(function* () {
      yield* seed
      const tasks = yield* ScheduledTask.Service
      const bindings = yield* ScheduledTaskSessionBinding.Service
      const firstTask = yield* createTask("first")
      const secondTask = yield* createTask("second")

      const first = yield* bindings.install({
        taskID: firstTask.id,
        taskRevision: firstTask.revision,
        sessionID: sessionA,
        expectedGeneration: undefined,
        now: T0,
      })
      expect(first).toBeDefined()
      expect(yield* bindings.ownerOf(sessionA)).toBe(firstTask.id)

      const conflict = yield* bindings
        .install({
          taskID: secondTask.id,
          taskRevision: secondTask.revision,
          sessionID: sessionA,
          expectedGeneration: undefined,
          now: T0 + 1,
        })
        .pipe(Effect.flip)
      expect(conflict).toMatchObject({ _tag: "ScheduledTask.ValidationError" })

      const revised = yield* tasks.update({
        id: firstTask.id,
        expectedRevision: firstTask.revision,
        name: "first revised",
        now: T0 + 2,
      })
      expect(revised.revision).toBe(1)
      const staleRevision = yield* bindings.install({
        taskID: firstTask.id,
        taskRevision: 0,
        sessionID: sessionB,
        expectedGeneration: first!.generation,
        now: T0 + 3,
      })
      expect(staleRevision).toBeUndefined()
      expect((yield* bindings.get(firstTask.id))?.sessionID).toBe(sessionA)
    }),
  )

  it.effect("target/session-policy edits invalidate the binding; task deletion cascades binding but never Session", () =>
    Effect.gen(function* () {
      yield* seed
      const { db } = yield* Database.Service
      const tasks = yield* ScheduledTask.Service
      const bindings = yield* ScheduledTaskSessionBinding.Service
      const task = yield* createTask("lifecycle", "reuse")
      const binding = yield* bindings.install({
        taskID: task.id,
        taskRevision: task.revision,
        sessionID: sessionA,
        expectedGeneration: undefined,
        now: T0,
      })
      expect(binding).toBeDefined()

      const promptOnly = yield* tasks.update({
        id: task.id,
        expectedRevision: task.revision,
        action: { prompt: "changed prompt" },
        now: T0 + 1,
      })
      expect(yield* bindings.get(task.id)).toBeDefined()

      const changedPolicy = yield* tasks.update({
        id: task.id,
        expectedRevision: promptOnly.revision,
        sessionPolicy: { kind: "new" },
        now: T0 + 2,
      })
      expect(changedPolicy.sessionPolicy).toEqual({ kind: "new" })
      expect(yield* bindings.get(task.id)).toBeUndefined()

      const reboundTask = yield* tasks.update({
        id: task.id,
        expectedRevision: changedPolicy.revision,
        sessionPolicy: { kind: "reuse" },
        now: T0 + 3,
      })
      const rebound = yield* bindings.install({
        taskID: task.id,
        taskRevision: reboundTask.revision,
        sessionID: sessionA,
        expectedGeneration: undefined,
        now: T0 + 4,
      })
      expect(rebound).toBeDefined()

      yield* tasks.remove(task.id)
      expect(yield* db.select().from(ScheduledTaskSessionBindingTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(
        yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, sessionA)).get().pipe(Effect.orDie),
      ).toEqual({ id: sessionA })
    }),
  )

})
