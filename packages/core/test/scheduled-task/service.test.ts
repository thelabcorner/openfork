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
import { ScheduledTaskLease } from "@opencode-ai/core/scheduled-task/lease"
import { jitterFor, occurrencesBetween } from "@opencode-ai/core/scheduled-task/recurrence"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "@opencode-ai/core/scheduled-task/sql"
import { ScheduledTask as ScheduledTaskModel } from "@opencode-ai/schema/scheduled-task"
import { Goal as GoalModel } from "@opencode-ai/schema/goal"
import { SessionID } from "@opencode-ai/schema/session-id"
import { testEffect } from "../lib/effect"
import { assertCursorConsistent } from "./support/cursor"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, ScheduledTask.node, ScheduledTaskLease.node]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

const T0 = Date.parse("2026-06-01T00:00:00Z")
const projectA = ProjectV2.ID.make("scheduled-project-a")

const daily = (...times: Array<[number, number]>): ScheduledTaskModel.Schedule => ({
  kind: "daily",
  times: times.map(([hour, minute]) => ({ hour, minute })),
})

const cron = (expression: string): ScheduledTaskModel.Schedule => ({ kind: "cron", expression })

const seedProject = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values([{ id: projectA, worktree: AbsolutePath.make("/scheduled/project-a"), sandboxes: [] }])
    .run()
    .pipe(Effect.orDie)
})

function createInput(overrides: Partial<ScheduledTask.CreateInput> = {}): ScheduledTask.CreateInput {
  return {
    projectID: projectA,
    targetDirectory: "/scheduled/project-a",
    name: "nightly",
    enabled: true,
    schedule: daily([9, 0]),
    timezone: "America/New_York",
    action: { prompt: "summarize" },
    now: T0,
    ...overrides,
  }
}

const createTask = (overrides: Partial<ScheduledTask.CreateInput> = {}) =>
  ScheduledTask.Service.use((tasks) => tasks.create(createInput(overrides)))

describe("ScheduledTask service — CRUD and the due cursor invariant", () => {
  it.effect("normalizes relative, timestamp, and recurring inputs before durable persistence", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service

      const relative = yield* createTask({
        name: "relative-once",
        schedule: { kind: "relative", delayMs: 90_000 },
        timezone: undefined,
        now: T0,
      })
      expect(relative.schedule).toEqual({ kind: "once", at: T0 + 90_000 })
      expect(relative.nextRunAt).toBe(T0 + 90_000)

      const timestamp = yield* createTask({
        name: "timestamp-once",
        schedule: { kind: "timestamp", at: T0 + 120_000 },
        timezone: undefined,
        now: T0,
      })
      expect(timestamp.schedule).toEqual({ kind: "once", at: T0 + 120_000 })

      const recurring = yield* createTask({
        name: "recurring-wrapper",
        schedule: {
          kind: "recurring",
          schedule: { kind: "daily", times: [{ hour: 11, minute: 15 }] },
        },
        timezone: "UTC",
        now: T0,
      })
      expect(recurring.schedule).toEqual(daily([11, 15]))

      const updated = yield* tasks.update({
        id: recurring.id,
        expectedRevision: recurring.revision,
        schedule: { kind: "relative", delayMs: 45_000 },
        timezone: null,
        now: T0 + 1_000,
      })
      expect(updated.schedule).toEqual({ kind: "once", at: T0 + 46_000 })
      expect(updated.nextRunAt).toBe(T0 + 46_000)
    }),
  )

  it.effect("creates, enables, edits, and disables with the cursor recomputed in the same transaction", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask()
      expect(created.nextRunAt).toBe(Date.parse("2026-06-01T13:00:00Z"))
      expect(created.sessionPolicy).toEqual({ kind: "new" })
      assertCursorConsistent(created, T0)

      const disabled = yield* tasks.setEnabled({ id: created.id, enabled: false, now: T0 + 60_000 })
      expect(disabled.nextRunAt).toBeUndefined()
      assertCursorConsistent(disabled, T0 + 60_000)

      const enabledAt = Date.parse("2026-06-01T14:00:00Z")
      const enabled = yield* tasks.setEnabled({ id: created.id, enabled: true, now: enabledAt })
      expect(enabled.nextRunAt).toBe(Date.parse("2026-06-02T13:00:00Z"))
      assertCursorConsistent(enabled, enabledAt)

      const edited = yield* tasks.update({
        id: created.id,
        expectedRevision: enabled.revision,
        schedule: daily([17, 30]),
        now: enabledAt,
      })
      expect(edited.nextRunAt).toBe(Date.parse("2026-06-01T21:30:00Z"))
      assertCursorConsistent(edited, enabledAt)

      const renamed = yield* tasks.update({
        id: created.id,
        expectedRevision: edited.revision,
        name: "nightly-two",
        now: Date.parse("2026-06-02T00:00:00Z"),
      })
      expect(renamed.nextRunAt).toBe(edited.nextRunAt)
      assertCursorConsistent(renamed, enabledAt)
    }),
  )

  it.effect("projects a bounded calendar agenda across recurring tasks without run/history hydration", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const morning = yield* createTask({
        name: "morning",
        schedule: daily([9, 0], [17, 30]),
        timezone: "UTC",
      })
      expect(morning.schedule).toEqual(daily([9, 0], [17, 30]))
      expect((yield* tasks.get(morning.id)).schedule).toEqual(daily([9, 0], [17, 30]))
      yield* createTask({
        name: "disabled",
        enabled: false,
        schedule: daily([10, 0]),
        timezone: "UTC",
      })
      const agenda = yield* tasks.agenda({
        projectID: projectA,
        from: Date.parse("2026-06-01T00:00:00Z"),
        to: Date.parse("2026-06-02T23:59:59Z"),
        limit: 20,
      })
      expect(agenda).toHaveLength(4)
      expect(agenda.every((entry) => entry.taskID === morning.id)).toBe(true)
      expect(agenda.map((entry) => entry.scheduledAt)).toEqual([
        Date.parse("2026-06-01T09:00:00Z"),
        Date.parse("2026-06-01T17:30:00Z"),
        Date.parse("2026-06-02T09:00:00Z"),
        Date.parse("2026-06-02T17:30:00Z"),
      ])
      expect(agenda.every((entry) => entry.effectiveAt === entry.scheduledAt)).toBe(true)
    }),
  )

  it.effect("agenda jitter overfetch is lossless even when jitter spans many minute-level recurrences", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const jitterMs = 15 * 60 * 1000
      const task = yield* createTask({
        name: "jitter-agenda",
        schedule: cron("* * * * *"),
        timezone: "UTC",
        policy: { jitterMs },
      })
      const from = T0 + 60 * 60 * 1000
      const to = from + 10 * 60 * 1000
      const limit = 5
      const raw = occurrencesBetween({
        schedule: task.schedule,
        timezone: task.timezone,
        from: from - jitterMs,
        to,
        limit: 64,
      })
      const expected = raw
        .map((scheduledAt) => ({
          taskID: task.id,
          scheduledAt,
          effectiveAt: scheduledAt + jitterFor(task.id, scheduledAt, jitterMs),
        }))
        .filter((item) => item.effectiveAt >= from && item.effectiveAt <= to)
        .sort((left, right) => left.effectiveAt - right.effectiveAt || left.taskID.localeCompare(right.taskID))
        .slice(0, limit)

      expect(yield* tasks.agenda({ from, to, limit })).toEqual(expected)
    }),
  )

  it.effect("agenda limit selects the globally earliest effective event rather than task iteration order", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const jitterMs = 59_000
      const first = yield* createTask({
        name: "candidate-one",
        schedule: cron("* * * * *"),
        timezone: "UTC",
        policy: { jitterMs },
      })
      const second = yield* createTask({
        name: "candidate-two",
        schedule: cron("* * * * *"),
        timezone: "UTC",
        policy: { jitterMs },
      })
      const from = T0 + 60 * 60 * 1000
      const firstJitter = jitterFor(first.id, from, jitterMs)
      const secondJitter = jitterFor(second.id, from, jitterMs)
      const later = firstJitter >= secondJitter ? first : second
      const earlier = later.id === first.id ? second : first
      yield* tasks.update({ id: later.id, expectedRevision: later.revision, name: "a-later-effective", now: T0 })
      yield* tasks.update({ id: earlier.id, expectedRevision: earlier.revision, name: "b-earlier-effective", now: T0 })

      const agenda = yield* tasks.agenda({ from, to: from + 2 * 60_000, limit: 1 })
      expect(agenda).toHaveLength(1)
      expect(agenda[0]?.taskID).toBe(earlier.id)
      expect(agenda[0]?.scheduledAt).toBe(from)
    }),
  )

  it.effect("optimized agenda heap/cache matches a brute-force recurrence+jitter oracle across mixed schedules", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const minuteJitter = 15 * 60 * 1000
      const created = yield* Effect.forEach(
        [
          { name: "oracle-minute-a", schedule: cron("* * * * *"), jitterMs: minuteJitter },
          { name: "oracle-minute-b", schedule: cron("* * * * *"), jitterMs: minuteJitter },
          { name: "oracle-two-minute", schedule: cron("*/2 * * * *"), jitterMs: 5 * 60 * 1000 },
          { name: "oracle-daily", schedule: daily([0, 5], [12, 30], [23, 55]), jitterMs: 20 * 60 * 1000 },
          {
            name: "oracle-weekly",
            schedule: {
              kind: "weekly" as const,
              weekdays: [1, 3, 5],
              times: [
                { hour: 0, minute: 2 },
                { hour: 18, minute: 45 },
              ],
            },
            jitterMs: 30 * 60 * 1000,
          },
        ],
        (spec) =>
          createTask({
            name: spec.name,
            schedule: spec.schedule,
            timezone: "UTC",
            policy: { jitterMs: spec.jitterMs },
          }),
        { concurrency: 1 },
      )

      const from = T0 + 6 * 60 * 60 * 1000
      const to = from + 3 * 24 * 60 * 60 * 1000
      const expected = created
        .flatMap((task) => {
          const jitterMs = Math.max(0, Number(task.policy.jitterMs) || 0)
          return occurrencesBetween({
            schedule: task.schedule,
            timezone: task.timezone,
            from: from - jitterMs,
            to,
            limit: 10_000,
          })
            .map((scheduledAt) => ({
              taskID: task.id,
              scheduledAt,
              effectiveAt: scheduledAt + jitterFor(task.id, scheduledAt, jitterMs),
            }))
            .filter((item) => item.effectiveAt >= from && item.effectiveAt <= to)
        })
        .sort(
          (left, right) =>
            left.effectiveAt - right.effectiveAt ||
            left.taskID.localeCompare(right.taskID) ||
            left.scheduledAt - right.scheduledAt,
        )

      for (const limit of [1, 2, 7, 31, 128, 500]) {
        expect(yield* tasks.agenda({ projectID: projectA, from, to, limit })).toEqual(expected.slice(0, limit))
      }
    }),
  )

  it.effect("rejects invalid input explicitly (missing/relative directory, bad cron, past once, duplicate name)", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const cases: Array<Partial<ScheduledTask.CreateInput>> = [
        { targetDirectory: "" },
        { targetDirectory: "relative/path" },
        { schedule: cron("0 0 9 * * *") },
        { schedule: cron("not a cron") },
        { schedule: { kind: "once", at: T0 - 1 } },
        { timezone: "Not/AZone" },
        { name: "   " },
        { action: { prompt: "  " } },
      ]
      for (const override of cases) {
        const error = yield* createTask(override).pipe(Effect.flip)
        expect(error._tag).toBe("ScheduledTask.ValidationError")
      }
      yield* createTask()
      const duplicate = yield* createTask({ schedule: daily([10, 0]) }).pipe(Effect.flip)
      expect(duplicate._tag).toBe("ScheduledTask.ValidationError")
      // A global task may share a name with a project task.
      const global = yield* createTask({ projectID: undefined, name: "nightly" })
      expect(global.projectID).toBeUndefined()
    }),
  )

  it.effect("uses SQL CAS revisions to reject stale writers and normalizes policy defaults", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask({ policy: { catchUp: "run_once" } })
      expect(created.policy).toMatchObject({
        catchUp: "run_once",
        catchUpMaxAgeMs: 6 * 60 * 60 * 1000,
        overrun: "skip",
        jitterMs: 0,
        maxAttempts: 2,
        maxDurationMs: 30 * 60 * 1000,
        retentionRuns: 200,
        permission: "deny",
        notify: "failure",
      })
      const updated = yield* tasks.update({ id: created.id, expectedRevision: 0, name: "renamed", now: T0 })
      expect(updated.revision).toBe(1)
      const stale = yield* tasks
        .update({ id: created.id, expectedRevision: 0, name: "other", now: T0 })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("ScheduledTask.StaleRevisionError")
      assertCursorConsistent(updated, T0)
    }),
  )

  it.effect("D31: continuity policy rejects unstable/per-run directories while stable reuse persists", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service

      const auto = yield* createTask({ name: "auto-session", sessionPolicy: { kind: "auto" } })
      expect(auto.sessionPolicy).toEqual({ kind: "auto" })

      const existingID = SessionID.make("ses_existing_policy_roundtrip")
      const existing = yield* createTask({
        name: "existing-session",
        sessionPolicy: { kind: "existing", sessionID: existingID },
      })
      expect(existing.sessionPolicy).toEqual({ kind: "existing", sessionID: existingID })

      for (const sessionPolicy of [{ kind: "reuse" as const }, { kind: "auto" as const }]) {
        const error = yield* createTask({
          name: `unstable-${sessionPolicy.kind}`,
          sessionPolicy,
          target: { kind: "worktree", reuse: false },
        }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "ScheduledTask.ValidationError" })
      }

      const pinnedWorktree = yield* createTask({
        name: "pinned-worktree",
        sessionPolicy: { kind: "existing", sessionID: existingID },
        target: { kind: "worktree", reuse: true },
      }).pipe(Effect.flip)
      expect(pinnedWorktree).toMatchObject({ _tag: "ScheduledTask.ValidationError" })

      const stable = yield* createTask({
        name: "stable-reuse",
        sessionPolicy: { kind: "reuse" },
        target: { kind: "worktree", reuse: true },
      })
      expect(stable.sessionPolicy).toEqual({ kind: "reuse" })
    }),
  )

  it.effect("removing a task deletes its rows but never the sessions its runs created", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const { db } = yield* Database.Service
      const created = yield* createTask()
      yield* tasks.recordRunStart({
        taskID: created.id,
        fireFor: created.nextRunAt!,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: T0,
      })
      yield* db
        .insert(ScheduledTaskRunTable)
        .values({
          id: ScheduledTaskModel.RunID.create(),
          task_id: created.id,
          fire_for: created.nextRunAt! + 1,
          trigger: "schedule",
          status: "succeeded",
          session_id: "ses_scheduled_evidence",
          started_at: T0,
        })
        .run()
        .pipe(Effect.orDie)
      yield* tasks.remove(created.id)
      expect(yield* tasks.get(created.id).pipe(Effect.flip)).toMatchObject({ _tag: "ScheduledTask.NotFoundError" })
      const rows = yield* db.select().from(ScheduledTaskRunTable).all().pipe(Effect.orDie)
      expect(rows).toHaveLength(0)
    }),
  )

  it.effect("enforces project scope filters in list()", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const projectTask = yield* createTask({ name: "project-task" })
      const globalTask = yield* createTask({ projectID: undefined, name: "global-task" })
      expect((yield* tasks.list()).map((task) => task.id).sort()).toEqual([projectTask.id, globalTask.id].sort())
      expect((yield* tasks.list({ projectID: projectA })).map((task) => task.id)).toEqual([projectTask.id])
    }),
  )
})

describe("ScheduledTask service — lease protocol and idempotency", () => {
  it.effect("C1: two claimants over one due task produce exactly one lease", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const leases = yield* ScheduledTaskLease.Service
      const created = yield* createTask()
      const fireFor = created.nextRunAt!
      const first = yield* leases.claim({ taskID: created.id, fireFor, now: T0 })
      expect(first).toBeDefined()
      const second = yield* leases.claim({ taskID: created.id, fireFor, now: T0 })
      expect(second).toBeUndefined()
      expect(yield* leases.activeCount()).toBe(1)
      yield* leases.release({ leaseID: first!.leaseID })
      expect(yield* leases.activeCount()).toBe(0)
      const reacquired = yield* leases.claim({ taskID: created.id, fireFor, now: T0 })
      expect(reacquired).toBeDefined()
    }),
  )

  it.effect("C3: the same (task_id, fire_for) never produces two run rows", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask()
      const fireFor = created.nextRunAt!
      const first = yield* tasks.recordRunStart({
        taskID: created.id,
        fireFor,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: T0,
      })
      expect(first.kind).toBe("started")
      const second = yield* tasks.recordRunStart({
        taskID: created.id,
        fireFor,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: T0,
      })
      expect(second.kind).toBe("exists")
      const { db } = yield* Database.Service
      expect(yield* db.select().from(ScheduledTaskRunTable).all().pipe(Effect.orDie)).toHaveLength(1)
    }),
  )

  it.effect("recoverStale reclaims expired leases, abandons their runs, and honors fresh heartbeats", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const leases = yield* ScheduledTaskLease.Service
      const { db } = yield* Database.Service
      const created = yield* createTask()
      const fireFor = created.nextRunAt!
      const lease = yield* leases.claim({ taskID: created.id, fireFor, now: T0 })
      yield* tasks.recordRunStart({
        taskID: created.id,
        fireFor,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: T0,
      })

      // A fresh peer lease is never stolen (the owner is not us and it is warm).
      expect(yield* leases.recoverStale({ now: T0 + 60_000 })).toHaveLength(0)
      expect(yield* leases.held()).toHaveLength(1)

      // After the TTL the same sweep must reclaim and abandon.
      const reclaimed = yield* leases.recoverStale({ now: T0 + 151_000 })
      expect(reclaimed).toHaveLength(1)
      expect(reclaimed[0]).toMatchObject({ taskID: created.id, fireFor })
      const run = yield* db
        .select()
        .from(ScheduledTaskRunTable)
        .where(eq(ScheduledTaskRunTable.task_id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(run?.status).toBe("abandoned")
      expect(lease).toBeDefined()
      const reacquired = yield* leases.claim({ taskID: created.id, fireFor, now: T0 + 152_000 })
      expect(reacquired?.attempt).toBe(2)
    }),
  )
})

describe("ScheduledTask service — catch-up, settlement, retry", () => {
  it.effect("E5: catchUp=skip advances past the missed instant and records one stale skip", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask({
        schedule: cron("0 3 * * *"),
        policy: { catchUp: "skip" },
      })
      expect(created.nextRunAt).toBe(Date.parse("2026-06-01T07:00:00Z"))
      const now = Date.parse("2026-06-01T10:00:00Z")
      const plans = yield* tasks.planDue(now)
      expect(plans).toHaveLength(0)
      const after = yield* tasks.get(created.id)
      expect(after.nextRunAt).toBe(Date.parse("2026-06-02T07:00:00Z"))
      assertCursorConsistent(after, now)
      const runs = yield* tasks.listRuns({ taskID: created.id })
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ status: "skipped", skipReason: "stale", fireFor: created.nextRunAt })
    }),
  )

  it.effect("E6: catchUp=run_once fires one catch-up and collapses the rest", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask({ schedule: cron("0 3 * * *"), policy: { catchUp: "run_once", catchUpMaxAgeMs: 30 * 24 * 60 * 60 * 1000 } })
      const now = Date.parse("2026-06-01T10:00:00Z")
      const plans = yield* tasks.planDue(now)
      expect(plans).toHaveLength(1)
      expect(plans[0]).toMatchObject({ fireFor: created.nextRunAt, trigger: "catchup" })

      const lease = yield* (yield* ScheduledTaskLease.Service).claim({
        taskID: created.id,
        fireFor: plans[0]!.fireFor,
        now,
      })
      const started = yield* tasks.recordRunStart({
        taskID: created.id,
        fireFor: plans[0]!.fireFor,
        trigger: "catchup",
        attempt: 1,
        acceptExisting: "none",
        now,
      })
      expect(started.kind).toBe("started")
      yield* tasks.settleRun({
        taskID: created.id,
        runID: started.kind === "started" ? started.run.id : ScheduledTaskModel.RunID.make("missing"),
        fireFor: plans[0]!.fireFor,
        status: "succeeded",
        now,
        attempt: 1,
        leaseID: lease?.leaseID,
        collapseAfterNow: true,
      })
      const after = yield* tasks.get(created.id)
      expect(after.nextRunAt).toBe(Date.parse("2026-06-02T07:00:00Z"))
      assertCursorConsistent(after, now)
    }),
  )

  it.effect("E7: catchUp=run_all collapses beyond the cap and then fires the newest ten", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask({
        schedule: cron("0 * * * *"),
        policy: { catchUp: "run_all", catchUpMaxAgeMs: 30 * 24 * 60 * 60 * 1000 },
      })
      const now = Date.parse("2026-06-15T00:00:00Z") // 14 days later
      const plans = yield* tasks.planDue(now)
      expect(plans).toHaveLength(0)
      const after = yield* tasks.get(created.id)
      const runs = yield* tasks.listRuns({ taskID: created.id, limit: 5 })
      expect(runs.filter((run) => run.status === "skipped")).toHaveLength(1)
      // The cursor jumped to the eleventh-newest miss so exactly ten instants
      // fire one lease-serialized run at a time.
      expect(after.nextRunAt).toBeGreaterThan(created.nextRunAt!)
      expect(after.nextRunAt! <= now).toBe(true)
      expect(runs[0]!.fireFor).toBe(created.nextRunAt!)
      const remaining = yield* tasks.planDue(now)
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toMatchObject({ trigger: "catchup", fireFor: after.nextRunAt })
    }),
  )

  it.effect("E12/E13/E14: disable mid-run, edit mid-run, and timezone change stay coherent", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask()
      const fireFor = created.nextRunAt!

      // E12: disable while a run is in flight -> settle leaves the cursor null.
      const started = yield* tasks.recordRunStart({
        taskID: created.id,
        fireFor,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: T0,
      })
      yield* tasks.setEnabled({ id: created.id, enabled: false, now: T0 })
      yield* tasks.settleRun({
        taskID: created.id,
        runID: started.kind === "started" ? started.run.id : ScheduledTaskModel.RunID.make("missing"),
        fireFor,
        status: "succeeded",
        now: T0 + 1000,
        attempt: 1,
      })
      const disabled = yield* tasks.get(created.id)
      expect(disabled.nextRunAt).toBeUndefined()
      expect(disabled.enabled).toBe(false)

      // E14: timezone change recomputes the cursor immediately.
      const reenabled = yield* tasks.setEnabled({ id: created.id, enabled: true, now: T0 })
      const rezoned = yield* tasks.update({
        id: created.id,
        expectedRevision: reenabled.revision,
        timezone: "Europe/Kyiv",
        now: T0,
      })
      expect(rezoned.nextRunAt).toBe(Date.parse("2026-06-01T06:00:00Z"))
      assertCursorConsistent(rezoned, T0)

      // E13: edit while a run is in flight; settlement recomputes from the new spec.
      const fireForTwo = rezoned.nextRunAt!
      const inFlight = yield* tasks.recordRunStart({
        taskID: created.id,
        fireFor: fireForTwo,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: T0 + 2000,
      })
      yield* tasks.update({
        id: created.id,
        expectedRevision: rezoned.revision,
        schedule: daily([20, 0]),
        now: T0 + 3000,
      })
      yield* tasks.settleRun({
        taskID: created.id,
        runID: inFlight.kind === "started" ? inFlight.run.id : ScheduledTaskModel.RunID.make("missing"),
        fireFor: fireForTwo,
        status: "succeeded",
        now: T0 + 4000,
        attempt: 1,
      })
      const edited = yield* tasks.get(created.id)
      expect(edited.nextRunAt).toBe(Date.parse("2026-06-01T17:00:00Z"))
      assertCursorConsistent(edited, fireForTwo)
    }),
  )

  it.effect("counts consecutive failures, trips the circuit breaker, and retries quota errors with backoff", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask({ schedule: daily([9, 0]) })
      let fireFor = created.nextRunAt!
      let now = T0
      for (let attempt = 1; attempt <= 5; attempt++) {
        const started = yield* tasks.recordRunStart({
          taskID: created.id,
          fireFor,
          trigger: "schedule",
          attempt: 1,
          acceptExisting: "none",
          now,
        })
        expect(started.kind).toBe("started")
        yield* tasks.settleRun({
          taskID: created.id,
          runID: started.kind === "started" ? started.run.id : ScheduledTaskModel.RunID.make("missing"),
          fireFor,
          status: "failed",
          errorKind: "internal",
          errorMessage: "boom",
          now,
          attempt: 1,
        })
        now += 60_000
        const current = yield* tasks.get(created.id)
        if (attempt < 5) {
          expect(current.consecutiveFailures).toBe(attempt)
          fireFor = current.nextRunAt!
        } else {
          expect(current.consecutiveFailures).toBe(5)
          expect(current.enabled).toBe(false)
          expect(current.nextRunAt).toBeUndefined()
        }
      }

      const retryTask = yield* createTask({ name: "quota-task", schedule: daily([10, 0]) })
      const retryFireFor = retryTask.nextRunAt!
      const started = yield* tasks.recordRunStart({
        taskID: retryTask.id,
        fireFor: retryFireFor,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now,
      })
      const settled = yield* tasks.settleRun({
        taskID: retryTask.id,
        runID: started.kind === "started" ? started.run.id : ScheduledTaskModel.RunID.make("missing"),
        fireFor: retryFireFor,
        status: "failed",
        errorKind: "quota",
        now,
        attempt: 1,
      })
      expect(settled.retryAt).toBe(now + 60_000)
      const pending = yield* tasks.get(retryTask.id)
      expect(pending.nextRunAt).toBe(now + 60_000)
      expect(pending.consecutiveFailures).toBe(0)

      const plans = yield* tasks.planDue(now + 61_000)
      expect(plans).toHaveLength(1)
      expect(plans[0]).toMatchObject({ trigger: "retry", fireFor: retryFireFor, acceptExisting: "retry" })
      const repossession = yield* (yield* ScheduledTaskLease.Service).claim({
        taskID: retryTask.id,
        fireFor: retryFireFor,
        now: now + 61_000,
      })
      expect(repossession?.attempt).toBe(2)
      const resumed = yield* tasks.recordRunStart({
        taskID: retryTask.id,
        fireFor: retryFireFor,
        trigger: "retry",
        attempt: 2,
        acceptExisting: "retry",
        now: now + 61_000,
      })
      expect(resumed.kind).toBe("started")
      if (resumed.kind === "started") expect(resumed.run.attempt).toBe(2)
    }),
  )

  it.effect("attempt-fences the durable run-to-Session binding across retries", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask({ name: "session-binding", schedule: daily([11, 0]) })
      const fireFor = created.nextRunAt!
      const first = yield* tasks.recordRunStart({
        taskID: created.id,
        fireFor,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: T0,
      })
      expect(first.kind).toBe("started")
      if (first.kind !== "started") return

      expect(
        yield* tasks.attachRunSession({
          runID: first.run.id,
          attempt: 1,
          sessionID: SessionID.make("ses_attempt_1"),
          directory: "/scheduled/attempt-1",
        }),
      ).toBe(true)
      expect((yield* tasks.listRuns({ taskID: created.id }))[0]).toMatchObject({
        sessionID: "ses_attempt_1",
        directory: "/scheduled/attempt-1",
        attempt: 1,
      })
      const goalID = GoalModel.ID.make("gol_attempt_1")
      expect(
        yield* tasks.attachRunGoal({
          runID: first.run.id,
          attempt: 1,
          goalID,
        }),
      ).toBe(true)
      expect((yield* tasks.listRuns({ taskID: created.id }))[0]?.goalID).toBe(goalID)
      expect(yield* tasks.runGoal(first.run.id)).toBe(goalID)
      expect(yield* tasks.goalOwner(goalID)).toEqual({ runID: first.run.id, taskID: created.id })
      expect(
        yield* tasks.authorizeRunSession({
          runID: first.run.id,
          attempt: 1,
          sessionID: SessionID.make("ses_attempt_1"),
        }),
      ).toEqual({ taskID: created.id })
      const wrongSession = yield* tasks
        .authorizeRunSession({
          runID: first.run.id,
          attempt: 1,
          sessionID: SessionID.make("ses_wrong"),
        })
        .pipe(Effect.flip)
      expect(wrongSession._tag).toBe("ScheduledTask.ValidationError")

      const settled = yield* tasks.settleRun({
        taskID: created.id,
        runID: first.run.id,
        fireFor,
        status: "failed",
        errorKind: "quota",
        now: T0 + 1_000,
        attempt: 1,
      })
      expect(settled.retryAt).toBeDefined()

      const second = yield* tasks.recordRunStart({
        taskID: created.id,
        fireFor,
        trigger: "retry",
        attempt: 2,
        acceptExisting: "retry",
        now: settled.retryAt!,
      })
      expect(second.kind).toBe("started")
      if (second.kind !== "started") return
      expect(second.run.sessionID).toBeUndefined()
      expect(second.run.directory).toBeUndefined()
      expect(second.run.goalID).toBe(goalID)
      expect(yield* tasks.runGoal(first.run.id)).toBe(goalID)

      // A delayed attempt-1 executor must never overwrite attempt 2.
      expect(
        yield* tasks.attachRunSession({
          runID: first.run.id,
          attempt: 1,
          sessionID: SessionID.make("ses_stale"),
          directory: "/scheduled/stale",
        }),
      ).toBe(false)
      expect(
        yield* tasks.attachRunSession({
          runID: first.run.id,
          attempt: 2,
          sessionID: SessionID.make("ses_attempt_2"),
          directory: "/scheduled/attempt-2",
        }),
      ).toBe(true)
      expect(
        yield* tasks.attachRunGoal({
          runID: first.run.id,
          attempt: 1,
          goalID: GoalModel.ID.make("gol_stale"),
        }),
      ).toBe(false)
      expect(
        yield* tasks.attachRunGoal({
          runID: first.run.id,
          attempt: 2,
          goalID,
        }),
      ).toBe(true)
      expect(
        yield* tasks.attachRunGoal({
          runID: first.run.id,
          attempt: 2,
          goalID: GoalModel.ID.make("gol_conflict"),
        }),
      ).toBe(false)
      expect((yield* tasks.listRuns({ taskID: created.id }))[0]).toMatchObject({
        sessionID: "ses_attempt_2",
        goalID: "gol_attempt_1",
        directory: "/scheduled/attempt-2",
        attempt: 2,
      })

      expect(
        yield* tasks.markRunStatus({
          runID: first.run.id,
          attempt: 1,
          status: "waiting",
          now: settled.retryAt! + 1,
        }),
      ).toBe(false)

      const conflict = yield* tasks
        .settleRun({
          taskID: created.id,
          runID: first.run.id,
          fireFor,
          status: "succeeded",
          now: settled.retryAt! + 2,
          attempt: 1,
        })
        .pipe(Effect.flip)
      expect(conflict._tag).toBe("ScheduledTask.RunAttemptConflictError")
      expect((yield* tasks.listRuns({ taskID: created.id }))[0]).toMatchObject({
        status: "running",
        sessionID: "ses_attempt_2",
        attempt: 2,
      })
      const staleAdmission = yield* tasks
        .authorizeRunSession({
          runID: first.run.id,
          attempt: 1,
          sessionID: SessionID.make("ses_attempt_2"),
        })
        .pipe(Effect.flip)
      expect(staleAdmission._tag).toBe("ScheduledTask.RunAttemptConflictError")
      expect(
        yield* tasks.authorizeRunSession({
          runID: first.run.id,
          attempt: 2,
          sessionID: SessionID.make("ses_attempt_2"),
        }),
      ).toEqual({ taskID: created.id })

      yield* tasks.settleRun({
        taskID: created.id,
        runID: first.run.id,
        fireFor,
        status: "succeeded",
        now: settled.retryAt! + 3,
        attempt: 2,
      })
      const terminalAdmission = yield* tasks
        .authorizeRunSession({
          runID: first.run.id,
          attempt: 2,
          sessionID: SessionID.make("ses_attempt_2"),
        })
        .pipe(Effect.flip)
      expect(terminalAdmission._tag).toBe("ScheduledTask.RunAttemptConflictError")
      expect((yield* tasks.listRuns({ taskID: created.id }))[0]).toMatchObject({
        status: "succeeded",
        sessionID: "ses_attempt_2",
        attempt: 2,
      })
    }),
  )

  it.effect("manual runs enqueue, clear overrun against an active lease, and prune retained history", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask({ policy: { retentionRuns: 3 } })
      const manual = yield* tasks.enqueueManualRun({ taskID: created.id, now: T0 })
      expect(manual).toMatchObject({ status: "queued", trigger: "manual" })
      expect(yield* tasks.inbox({ unreadOnly: true })).toHaveLength(0)

      // Hold the task's lease: the queued manual run is skipped as overrun by default.
      yield* (yield* ScheduledTaskLease.Service).claim({
        taskID: created.id,
        fireFor: created.nextRunAt!,
        now: T0,
      })
      yield* tasks.planDue(T0 + 1000)
      const runs = yield* tasks.listRuns({ taskID: created.id })
      const manualRun = runs.find((run) => run.trigger === "manual")!
      expect(manualRun.status).toBe("skipped")
      expect(manualRun.skipReason).toBe("overrun")

      // Retention keeps the newest N acknowledged rows.
      for (let index = 0; index < 6; index++) {
        const started = yield* tasks.recordRunStart({
          taskID: created.id,
          fireFor: T0 + 100_000 + index,
          trigger: "schedule",
          attempt: 1,
          acceptExisting: "none",
          now: T0 + index,
        })
        if (started.kind === "started") {
          yield* tasks.settleRun({
            taskID: created.id,
            runID: started.run.id,
            fireFor: T0 + 100_000 + index,
            status: "succeeded",
            now: T0 + index + 1,
            attempt: 1,
          })
        }
      }
      const retained = yield* tasks.listRuns({ taskID: created.id, limit: 50 })
      expect(retained.length).toBeLessThanOrEqual(3)
    }),
  )

  it.effect("inbox unread count and acknowledgement are server-owned and task-scoped before limit", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask()
      const other = yield* createTask({ name: "other-inbox-task" })
      const started = yield* tasks.recordRunStart({
        taskID: created.id,
        fireFor: created.nextRunAt!,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: T0,
      })
      yield* tasks.settleRun({
        taskID: created.id,
        runID: started.kind === "started" ? started.run.id : ScheduledTaskModel.RunID.make("missing"),
        fireFor: created.nextRunAt!,
        status: "failed",
        errorKind: "config",
        now: T0,
        attempt: 1,
      })
      const otherStarted = yield* tasks.recordRunStart({
        taskID: other.id,
        fireFor: other.nextRunAt!,
        trigger: "schedule",
        attempt: 1,
        acceptExisting: "none",
        now: T0 + 10,
      })
      yield* tasks.settleRun({
        taskID: other.id,
        runID: otherStarted.kind === "started" ? otherStarted.run.id : ScheduledTaskModel.RunID.make("missing-other"),
        fireFor: other.nextRunAt!,
        status: "failed",
        errorKind: "config",
        now: T0 + 10,
        attempt: 1,
      })
      expect(yield* tasks.unreadCount()).toBe(2)
      expect(yield* tasks.unreadCount({ taskIDs: [created.id] })).toBe(1)
      expect(yield* tasks.unreadCount({ taskIDs: [] })).toBe(0)
      const unread = yield* tasks.inbox({ unreadOnly: true, taskIDs: [created.id] })
      expect(unread).toHaveLength(1)
      expect(unread[0]?.taskID).toBe(created.id)
      expect(yield* tasks.inbox({ unreadOnly: true, taskIDs: [] })).toEqual([])

      const bumped = yield* tasks.update({
        id: created.id,
        expectedRevision: created.revision,
        name: "nightly-inbox-renamed",
      })
      const stale = yield* tasks
        .acknowledgeChecked({
          taskID: created.id,
          runID: unread[0]!.id,
          expectedRevision: created.revision,
          now: T0 + 1,
        })
        .pipe(Effect.flip)
      expect(stale._tag).toBe("ScheduledTask.StaleRevisionError")

      const wrongTask = yield* tasks
        .acknowledgeChecked({
          taskID: other.id,
          runID: unread[0]!.id,
          expectedRevision: other.revision,
          now: T0 + 1,
        })
        .pipe(Effect.flip)
      expect(wrongTask._tag).toBe("ScheduledTask.RunNotFoundError")

      yield* tasks.acknowledgeChecked({
        taskID: created.id,
        runID: unread[0]!.id,
        expectedRevision: bumped.revision,
        now: T0 + 1,
      })
      expect(yield* tasks.unreadCount({ taskIDs: [created.id] })).toBe(0)
      expect(yield* tasks.unreadCount({ taskIDs: [other.id] })).toBe(1)
    }),
  )

  it.effect("the global kill switch stops due planning and resumes cleanly", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const created = yield* createTask()
      const paused = yield* tasks.setPaused({ paused: true, now: T0 })
      expect(paused.paused).toBe(true)
      expect(yield* tasks.nextDueAt(T0)).toBeUndefined()
      expect(yield* tasks.planDue(Date.parse("2026-06-02T00:00:00Z"))).toHaveLength(0)
      expect(yield* tasks.due(Date.parse("2026-06-02T00:00:00Z"))).toHaveLength(0)
      const resumed = yield* tasks.setPaused({ paused: false, now: T0 })
      expect(resumed.paused).toBe(false)
      expect(yield* tasks.nextDueAt(T0)).toBe(created.nextRunAt!)
      expect(yield* tasks.planDue(created.nextRunAt!)).toHaveLength(1)
    }),
  )

  it.effect("scheduler generation advances atomically with runnable-state mutations", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const initial = yield* tasks.generation()
      const created = yield* createTask({ enabled: false })
      const afterCreate = yield* tasks.generation()
      expect(afterCreate).toBeGreaterThan(initial)

      yield* tasks.enqueueManualRun({ taskID: created.id, now: T0 })
      const afterQueue = yield* tasks.generation()
      expect(afterQueue).toBeGreaterThan(afterCreate)

      yield* tasks.setPaused({ paused: true, now: T0 + 1 })
      expect(yield* tasks.generation()).toBeGreaterThan(afterQueue)
    }),
  )

  it.effect("recomputeAll self-heals cursor drift without bumping user revisions", () =>
    Effect.gen(function* () {
      yield* seedProject
      const tasks = yield* ScheduledTask.Service
      const { db } = yield* Database.Service
      const created = yield* createTask()
      yield* db
        .update(ScheduledTaskTable)
        .set({ next_run_at: created.nextRunAt! + 123_456 })
        .where(eq(ScheduledTaskTable.id, created.id))
        .run()
        .pipe(Effect.orDie)
      const now = Date.parse("2026-06-01T08:00:00Z")
      const changed = yield* tasks.recomputeAll(now)
      expect(changed).toBe(1)
      const healed = yield* tasks.get(created.id)
      expect(healed.nextRunAt).toBe(Date.parse("2026-06-01T13:00:00Z"))
      expect(healed.revision).toBe(created.revision)
      assertCursorConsistent(healed, now)
    }),
  )
})
