import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AbsolutePath } from "@opencode-ai/core/schema"
import {
  ScheduledTaskControlTable,
  ScheduledTaskLeaseTable,
  ScheduledTaskRunTable,
  ScheduledTaskTable,
} from "@opencode-ai/core/scheduled-task/sql"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"

const directory = path.join(os.tmpdir(), "opencode-scheduled-schema")

const task = {
  id: ScheduledTask.ID.make("stk_schema_test"),
  target_directory: AbsolutePath.make(directory),
  target: { kind: "directory" as const },
  name: "schema test",
  schedule: { kind: "daily" as const, times: [{ hour: 9, minute: 0 }] },
  action: { prompt: "hello" },
  policy: {
    catchUp: "skip" as const,
    catchUpMaxAgeMs: 6 * 60 * 60 * 1000,
    overrun: "skip" as const,
    jitterMs: 0,
    maxAttempts: 2,
    maxDurationMs: 30 * 60 * 1000,
    retentionRuns: 200,
    permission: "deny" as const,
    notify: "failure" as const,
  },
}

const run = {
  id: ScheduledTask.RunID.make("str_schema_test"),
  task_id: task.id,
  fire_for: 1_700_000_000_000,
  trigger: "schedule" as const,
  status: "succeeded" as const,
  started_at: 1_700_000_000_000,
}

describe("scheduled_task schema", () => {
  test("migration applies and the (task_id, fire_for) idempotency index rejects a duplicate instant", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.insert(ScheduledTaskTable).values(task).run().pipe(Effect.orDie)
        yield* db.insert(ScheduledTaskRunTable).values(run).run().pipe(Effect.orDie)

        // C3: the database itself refuses a second run for the same logical instant.
        const duplicate = yield* db
          .insert(ScheduledTaskRunTable)
          .values({ ...run, id: ScheduledTask.RunID.make("str_schema_test_2") })
          .run()
          .pipe(Effect.exit)
        expect(duplicate._tag).toBe("Failure")

        // A different instant is accepted.
        yield* db
          .insert(ScheduledTaskRunTable)
          .values({ ...run, id: ScheduledTask.RunID.make("str_schema_test_3"), fire_for: run.fire_for + 60_000 })
          .run()
          .pipe(Effect.orDie)

        const rows = yield* db.select().from(ScheduledTaskRunTable).all().pipe(Effect.orDie)
        expect(rows).toHaveLength(2)
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
    )
  })

  test("global task without a project, singleton control row, and cascade from the task row", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ScheduledTaskTable)
          .values({ ...task, id: ScheduledTask.ID.make("stk_schema_global"), project_id: null })
          .run()
          .pipe(Effect.orDie)

        // External run references are scalars: a session id that does not exist
        // must still be storable (session cleanup must not erase run history).
        yield* db
          .insert(ScheduledTaskRunTable)
          .values({
            ...run,
            id: ScheduledTask.RunID.make("str_schema_global"),
            task_id: ScheduledTask.ID.make("stk_schema_global"),
            session_id: "ses_does_not_exist",
            workspace_id: "wrk_does_not_exist",
          })
          .run()
          .pipe(Effect.orDie)

        yield* db.insert(ScheduledTaskLeaseTable).values({
          task_id: ScheduledTask.ID.make("stk_schema_global"),
          fire_for: run.fire_for,
          lease_id: "lease-1",
          acquired_at: run.started_at,
          heartbeat_at: run.started_at,
        }).run().pipe(Effect.orDie)

        // Reconciliation guarantees the singleton exists even on a fresh DB.
        // Mutate it in place and prove the durable generation trigger observes
        // control changes rather than recreating authoritative singleton state.
        const beforeControl = yield* db.select().from(ScheduledTaskControlTable).get().pipe(Effect.orDie)
        expect(beforeControl?.paused).toBe(false)
        yield* db
          .update(ScheduledTaskControlTable)
          .set({ paused: true })
          .where(eq(ScheduledTaskControlTable.id, "global"))
          .run()
          .pipe(Effect.orDie)
        const control = yield* db.select().from(ScheduledTaskControlTable).get().pipe(Effect.orDie)
        expect(control?.paused).toBe(true)
        expect(control!.generation).toBeGreaterThan(beforeControl!.generation)

        // Deleting the task removes its lease and run history (both cascade),
        // but the referenced session is untouched because there is no FK.
        yield* db
          .delete(ScheduledTaskTable)
          .where(eq(ScheduledTaskTable.id, ScheduledTask.ID.make("stk_schema_global")))
          .run()
          .pipe(Effect.orDie)
        expect(yield* db.select().from(ScheduledTaskRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
        expect(yield* db.select().from(ScheduledTaskLeaseTable).all().pipe(Effect.orDie)).toHaveLength(0)
      }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
    )
  })
})
