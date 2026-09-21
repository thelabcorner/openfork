import { beforeEach, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Layer, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskLease } from "@opencode-ai/core/scheduled-task/lease"
import {
  ScheduledTaskLeaseTable,
  ScheduledTaskRunTable,
  ScheduledTaskTable,
} from "@opencode-ai/core/scheduled-task/sql"
import { ScheduledTask as ScheduledTaskModel } from "@opencode-ai/schema/scheduled-task"
import { ScheduledTaskExecutor, type ExecutionOutcome } from "@/scheduled-task/executor"
import { ScheduledTaskRunner } from "@/scheduled-task/runner"
import { testEffect } from "../lib/effect"

type ExecutorCall = {
  readonly taskID: string
  readonly runID: string
  readonly fireFor: number
  readonly leaseID: string
}

let executorHook: ((call: ExecutorCall) => Effect.Effect<ExecutionOutcome>) | undefined
let executorCalls: ExecutorCall[] = []

const fakeExecutorLayer = Layer.succeed(
  ScheduledTaskExecutor.Service,
  ScheduledTaskExecutor.Service.of({
    execute: (input) =>
      Effect.suspend(() => {
        const call: ExecutorCall = {
          taskID: input.task.id,
          runID: input.runID,
          fireFor: input.fireFor,
          leaseID: input.leaseID,
        }
        executorCalls.push(call)
        if (executorHook) return executorHook(call)
        return Effect.succeed<ExecutionOutcome>({ status: "succeeded" })
      }),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      ScheduledTask.node,
      ScheduledTaskLease.node,
      ScheduledTaskRunner.node,
    ]),
    [
      [Database.node, Database.layerFromPath(":memory:")],
      [ScheduledTaskExecutor.node, fakeExecutorLayer],
    ],
  ),
)

// Runner/lease tests intentionally use TestClock's epoch. Calendar/DST behavior
// belongs to recurrence.test.ts; keeping this suite near zero prevents a virtual
// wall-clock jump from replaying years of the 60s liveness reconciliation floor.
const T0 = 0
const NEXT_DAILY_AFTER_FIRST_FIRE = 33 * 60 * 60 * 1000

beforeEach(() => {
  executorHook = undefined
  executorCalls = []
})

const daily = (...times: Array<[number, number]>): ScheduledTaskModel.Schedule => ({
  kind: "daily",
  times: times.map(([hour, minute]) => ({ hour, minute })),
})

const createInput = (overrides: Partial<ScheduledTask.CreateInput> = {}): ScheduledTask.CreateInput => ({
  targetDirectory: "/scheduled/tests",
  name: `task-${Math.random().toString(36).slice(2)}`,
  enabled: true,
  schedule: daily([9, 0]),
  timezone: "UTC",
  action: { prompt: "hello" },
  now: T0,
  ...overrides,
})

const waitFor = <A>(effect: Effect.Effect<A | undefined, unknown, never>) =>
  Effect.gen(function* () {
    for (let index = 0; index < 2000; index++) {
      const value = yield* effect
      if (value !== undefined) return value
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("waitFor timed out"))
  })

describe("ScheduledTaskRunner", () => {
  it.effect("D4/N2: 200 tasks and the idle reconciliation floor still own exactly one timer", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const runner = yield* ScheduledTaskRunner.Service
      yield* TestClock.setTime(T0)
      for (let index = 0; index < 200; index++) {
        yield* tasks.create(createInput({ name: `bulk-${index}`, schedule: daily([9, 0]) }))
      }
      yield* runner.start({ startupGraceMs: 0 })
      expect(yield* runner.activeTimerCount()).toBe(1)

      // All tasks deleted -> the same single timer becomes the cheap generation
      // reconciliation floor; timer fanout remains impossible.
      const { db } = yield* Database.Service
      yield* db.delete(ScheduledTaskTable).run().pipe(Effect.orDie)
      yield* runner.poke()
      expect(yield* runner.activeTimerCount()).toBe(1)
    }),
  )

  it.effect("D3: an idle runner performs no dispatch work when the durable generation is unchanged", () =>
    Effect.gen(function* () {
      const runner = yield* ScheduledTaskRunner.Service
      yield* TestClock.setTime(T0)
      yield* runner.start({ startupGraceMs: 0 })
      expect(yield* runner.activeTimerCount()).toBe(1)
      yield* TestClock.adjust("60 minutes")
      expect(yield* runner.activeTimerCount()).toBe(1)
      expect(executorCalls).toHaveLength(0)
    }),
  )

  it.effect("fires a due task exactly once, settles it, advances the cursor, and releases the lease", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const leases = yield* ScheduledTaskLease.Service
      const runner = yield* ScheduledTaskRunner.Service
      yield* TestClock.setTime(T0)
      const created = yield* tasks.create(createInput())
      yield* runner.start({ startupGraceMs: 0 })

      yield* TestClock.setTime(created.nextRunAt!)
      yield* runner.poke()
      const runs = yield* waitFor(
        Effect.gen(function* () {
          const rows = yield* tasks.listRuns({ taskID: created.id })
          return rows.length > 0 ? rows : undefined
        }),
      )
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ status: "succeeded", trigger: "schedule", fireFor: created.nextRunAt })
      expect(executorCalls).toHaveLength(1)
      expect(executorCalls[0]!.fireFor).toBe(created.nextRunAt!)
      const after = yield* tasks.get(created.id)
      expect(after.nextRunAt).toBe(NEXT_DAILY_AFTER_FIRST_FIRE)
      expect(yield* leases.activeCount()).toBe(0)
    }),
  )

  it.effect("C6: dispatch concurrency is bounded while 100 tasks are simultaneously due", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const runner = yield* ScheduledTaskRunner.Service
      yield* TestClock.setTime(T0)
      const created: ScheduledTask.Info[] = []
      for (let index = 0; index < 100; index++) {
        created.push(yield* tasks.create(createInput({ name: `due-${index}`, schedule: daily([9, 0]) })))
      }
      const release = yield* Deferred.make<void>()
      const inFlight = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      executorHook = () =>
        Effect.gen(function* () {
          const current = yield* Ref.updateAndGet(inFlight, (value) => value + 1)
          yield* Ref.update(peak, (value) => Math.max(value, current))
          yield* Deferred.await(release)
          yield* Ref.update(inFlight, (value) => value - 1)
          return { status: "succeeded" as const }
        })

      yield* runner.start({ startupGraceMs: 0 })
      yield* TestClock.setTime(created[0]!.nextRunAt!)
      yield* runner.poke()
      yield* waitFor(
        Ref.get(peak).pipe(
          Effect.map((value) => (value >= 2 ? value : undefined)),
        ),
      )
      expect(yield* runner.activeRuns()).toBeLessThanOrEqual(2)
      expect(yield* Ref.get(peak)).toBe(2)

      yield* Deferred.succeed(release, undefined)
      yield* waitFor(
        Effect.gen(function* () {
          const rows = yield* tasks.listRuns({ taskID: created[0]!.id })
          return rows.length > 0 ? rows : undefined
        }),
      )
      expect(yield* Ref.get(peak)).toBeLessThanOrEqual(2)
      expect(executorCalls.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("C7: a backward clock jump cannot duplicate an already-fired logical instant", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const runner = yield* ScheduledTaskRunner.Service
      const { db } = yield* Database.Service
      yield* TestClock.setTime(T0)
      const created = yield* tasks.create(createInput())
      const fireFor = created.nextRunAt!
      yield* runner.start({ startupGraceMs: 0 })
      yield* TestClock.setTime(fireFor)
      yield* runner.poke()
      yield* waitFor(
        Effect.gen(function* () {
          const rows = yield* tasks.listRuns({ taskID: created.id })
          return rows.length > 0 ? rows : undefined
        }),
      )

      // Simulate a clock step backward / stale cursor: the same logical instant
      // becomes due again. The unique index is the backstop.
      yield* db
        .update(ScheduledTaskTable)
        .set({ next_run_at: fireFor })
        .where(eq(ScheduledTaskTable.id, created.id))
        .run()
        .pipe(Effect.orDie)
      yield* TestClock.setTime(fireFor + 1000)
      yield* runner.poke()
      yield* waitFor(
        Effect.gen(function* () {
          const after = yield* tasks.get(created.id)
          return after.nextRunAt !== fireFor ? after : undefined
        }),
      )
      const runs = yield* tasks.listRuns({ taskID: created.id })
      expect(runs).toHaveLength(1)
      expect(executorCalls).toHaveLength(1)
    }),
  )

  it.effect("C2: startup recovery reclaims a stale lease and abandons its run without re-executing it", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const runner = yield* ScheduledTaskRunner.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const settledRuns: ScheduledTaskModel.Run[] = []
      const unsubscribe = yield* events.listenType(ScheduledTaskModel.Event.RunSettled, (event) =>
        Effect.sync(() => settledRuns.push(event.data.run)),
      )
      yield* TestClock.setTime(T0)
      const created = yield* tasks.create(createInput())
      const fireFor = created.nextRunAt!
      const deadRunID = ScheduledTaskModel.RunID.create()

      // A dead peer held the lease and died mid-run.
      yield* db
        .insert(ScheduledTaskLeaseTable)
        .values({
          task_id: created.id,
          fire_for: fireFor,
          lease_id: "dead-peer-lease",
          owner: "other-process",
          acquired_at: T0 - 600_000,
          heartbeat_at: T0 - 600_000,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ScheduledTaskRunTable)
        .values({
          id: deadRunID,
          task_id: created.id,
          fire_for: fireFor,
          trigger: "schedule",
          status: "running",
          started_at: T0 - 600_000,
        })
        .run()
        .pipe(Effect.orDie)

      yield* TestClock.setTime(T0)
      yield* runner.start({ startupGraceMs: 0 })
      const run = yield* waitFor(
        Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(ScheduledTaskRunTable)
            .where(eq(ScheduledTaskRunTable.task_id, created.id))
            .get()
            .pipe(Effect.orDie)
          return row?.status === "abandoned" ? row : undefined
        }),
      )
      expect(run.status).toBe("abandoned")
      expect(settledRuns).toEqual([
        expect.objectContaining({
          id: deadRunID,
          taskID: created.id,
          fireFor,
          status: "abandoned",
          attempt: 1,
        }),
      ])
      yield* unsubscribe
      // The recovered logical instant is never re-executed: once the instant
      // becomes due the terminal row wins and the cursor advances.
      yield* TestClock.setTime(fireFor)
      yield* runner.poke()
      const after = yield* waitFor(
        Effect.gen(function* () {
          const current = yield* tasks.get(created.id)
          return current.nextRunAt !== fireFor ? current : undefined
        }),
      )
      expect(after.nextRunAt).toBe(NEXT_DAILY_AFTER_FIRST_FIRE)
      expect(executorCalls).toHaveLength(0)
    }),
  )

  it.effect("executes a queued manual run and keeps the overrun policy for busy tasks", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const runner = yield* ScheduledTaskRunner.Service
      yield* TestClock.setTime(T0)
      const created = yield* tasks.create(createInput({ schedule: daily([9, 0]) }))
      yield* runner.start({ startupGraceMs: 0 })

      const manual = yield* tasks.enqueueManualRun({ taskID: created.id, now: T0 })
      const rows = yield* waitFor(
        Effect.gen(function* () {
          const all = yield* tasks.listRuns({ taskID: created.id })
          const found = all.find((row) => row.id === manual.id)
          return found && found.status === "succeeded" ? all : undefined
        }),
      )
      expect(rows.find((row) => row.id === manual.id)).toMatchObject({ trigger: "manual", status: "succeeded" })
      expect(executorCalls.map((call) => call.runID)).toContain(manual.id)
    }),
  )

  it.effect("recovers a durable queued manual run on startup without an ephemeral poke", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const runner = yield* ScheduledTaskRunner.Service
      const { db } = yield* Database.Service
      yield* TestClock.setTime(T0)
      const created = yield* tasks.create(createInput({ enabled: false }))
      const runID = ScheduledTaskModel.RunID.create()
      yield* db
        .insert(ScheduledTaskRunTable)
        .values({
          id: runID,
          task_id: created.id,
          fire_for: T0,
          trigger: "manual",
          status: "queued",
          started_at: T0,
        })
        .run()
        .pipe(Effect.orDie)

      yield* runner.start({ startupGraceMs: 0 })
      const run = yield* waitFor(
        Effect.gen(function* () {
          const rows = yield* tasks.listRuns({ taskID: created.id })
          const found = rows.find((row) => row.id === runID)
          return found?.status === "succeeded" ? found : undefined
        }),
      )
      expect(run).toMatchObject({ id: runID, trigger: "manual", status: "succeeded" })
      expect(executorCalls.map((call) => call.runID)).toContain(runID)
    }),
  )

  it.effect("C9: idle generation reconciliation recovers peer-committed queued work after a lost wake", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const runner = yield* ScheduledTaskRunner.Service
      const { db } = yield* Database.Service
      yield* TestClock.setTime(T0)
      const created = yield* tasks.create(createInput({ enabled: false }))
      yield* runner.start({ startupGraceMs: 0 })
      const before = yield* tasks.generation()

      // Direct SQL deliberately bypasses EventV2 and models a peer process that
      // committed the row and died before it could publish/wake this runner.
      const runID = ScheduledTaskModel.RunID.create()
      yield* db
        .insert(ScheduledTaskRunTable)
        .values({
          id: runID,
          task_id: created.id,
          fire_for: T0,
          trigger: "manual",
          status: "queued",
          started_at: T0,
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* tasks.generation()).toBeGreaterThan(before)
      expect(executorCalls).toHaveLength(0)

      yield* TestClock.adjust(ScheduledTaskRunner.MAX_SLEEP_MS)
      const run = yield* waitFor(
        Effect.gen(function* () {
          const rows = yield* tasks.listRuns({ taskID: created.id })
          const found = rows.find((row) => row.id === runID)
          return found?.status === "succeeded" ? found : undefined
        }),
      )
      expect(run).toMatchObject({ id: runID, trigger: "manual", status: "succeeded" })
      expect(executorCalls.map((call) => call.runID)).toContain(runID)
    }),
  )

  it.effect("re-arms immediately when a task is created (mutation wake signal)", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const runner = yield* ScheduledTaskRunner.Service
      yield* TestClock.setTime(T0)
      yield* runner.start({ startupGraceMs: 0 })
      expect(yield* runner.activeTimerCount()).toBe(1)
      yield* tasks.create(
        createInput({
          schedule: { kind: "once", at: T0 + 30_000 },
        }),
      )
      yield* TestClock.adjust("30 seconds")
      yield* waitFor(Effect.sync(() => (executorCalls.length === 1 ? true : undefined)))
      expect(executorCalls).toHaveLength(1)
      expect(yield* runner.activeTimerCount()).toBe(1)
    }),
  )

  it.effect("D6-adjacent: removing a task deletes its run history but is a scalar-only session reference", () =>
    Effect.gen(function* () {
      const tasks = yield* ScheduledTask.Service
      const runner = yield* ScheduledTaskRunner.Service
      const { db } = yield* Database.Service
      yield* TestClock.setTime(T0)
      const created = yield* tasks.create(createInput())
      yield* runner.start({ startupGraceMs: 0 })
      yield* TestClock.setTime(created.nextRunAt!)
      yield* runner.poke()
      yield* waitFor(
        Effect.gen(function* () {
          const rows = yield* tasks.listRuns({ taskID: created.id })
          return rows.length > 0 ? rows : undefined
        }),
      )
      // Scalar session reference, exactly like goal_evidence: deleting the task
      // removes its own history rows and nothing else.
      yield* db
        .update(ScheduledTaskRunTable)
        .set({ session_id: "ses_survives" })
        .where(eq(ScheduledTaskRunTable.task_id, created.id))
        .run()
        .pipe(Effect.orDie)
      yield* tasks.remove(created.id)
      expect(
        yield* db
          .select()
          .from(ScheduledTaskRunTable)
          .where(eq(ScheduledTaskRunTable.task_id, created.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
    }),
  )
})
