import { expect, test } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit, Fiber } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { OxpActivity } from "../src/oxp-activity/activity"
import { sqliteBusyCode } from "../src/database/sqlite-busy"

const LINK_BUDGET = 64

const correlation = (value: string) => ({ scheme: "mcp-session-id", digest: value, scope: "unknown" }) as const

function activityGraph(filename: string) {
  return AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, OxpActivity.node]),
    [[Database.node, Database.layerFromPath(filename)]],
  )
}

function exitFailure(exit: Exit.Exit<unknown, unknown>): Error {
  if (Exit.isSuccess(exit)) return new Error("expected failure but the operation succeeded")
  const squashed = Cause.squash(exit.cause)
  const message = (squashed as { message?: unknown } | undefined)?.message
  const safe =
    typeof message === "string" && !/(?:select|insert|update|delete|from|where|values)/i.test(message)
      ? message
      : "SQL-class failure suppressed"
  return new Error(safe, { cause: squashed })
}

function defectOf(exit: Exit.Exit<unknown, unknown>): unknown {
  if (Exit.isSuccess(exit)) throw new Error("expected a failed exit")
  return Cause.squash(exit.cause)
}

interface UnwrappedSqliteFailure {
  readonly top: string
  readonly sqlError: string
  readonly sqlReason: string
  readonly nativeCode: unknown
  readonly nativeErrno: unknown
  readonly operation: unknown
  readonly retryable: unknown
}

/** Walk the exact production chain: EffectDrizzleQueryError > Cause.reasons[0] > SqlError > reason > native. */
function unwrapSqliteFailure(error: unknown): UnwrappedSqliteFailure {
  const tagOf = (value: unknown) =>
    value && typeof value === "object"
      ? (((value as Record<string, unknown>)._tag as string) ??
        ((value as { constructor?: { name?: string } }).constructor?.name ?? "(anonymous)"))
      : typeof value
  const cause = (error as Record<string, unknown> | undefined)?.cause as Record<string, unknown> | undefined
  const reasons = cause?.reasons as readonly Record<string, unknown>[] | undefined
  const fail = reasons?.[0]
  const sqlError = fail?.error as Record<string, unknown> | undefined
  const sqlReason = sqlError?.reason as Record<string, unknown> | undefined
  const native = sqlReason?.cause as Record<string, unknown> | undefined
  return {
    top: tagOf(error),
    sqlError: tagOf(sqlError),
    sqlReason: tagOf(sqlReason),
    nativeCode: native?.code,
    nativeErrno: native?.errno,
    operation: sqlReason?.operation,
    retryable: sqlReason?.isRetryable,
  }
}

async function withFixtureDir<A>(label: string, scenario: (filename: string) => Promise<A>): Promise<A> {
  const dir = await mkdtemp(join(tmpdir(), `openfork-oxp-link-${label}-`))
  const filename = join(dir, "activity.sqlite")
  let result: A | undefined
  let scenarioError: unknown
  try {
    result = await scenario(filename)
  } catch (error) {
    scenarioError = error
  }
  let cleanupError: unknown
  const cleanupAt = performance.now()
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 })
    console.log(`[fixture ${label}] disposable database removed in ${Math.round(performance.now() - cleanupAt)}ms`)
  } catch (error) {
    cleanupError = new Error(
      `[fixture ${label}] disposable database removal failed code=${(error as NodeJS.ErrnoException).code ?? "unknown"} after ${Math.round(performance.now() - cleanupAt)}ms`,
      { cause: error },
    )
  }
  if (scenarioError && cleanupError) console.log(`[fixture ${label}] cleanup failure did not mask the scenario result`)
  if (scenarioError) throw scenarioError
  if (cleanupError) throw cleanupError
  return result!
}

async function withActivityDb(
  label: string,
  scenario: (services: { activity: OxpActivity.Interface; database: Database.Interface }, filename: string) => Effect.Effect<void, unknown>,
): Promise<void> {
  await withFixtureDir(label, async (filename) => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const activity = yield* OxpActivity.Service
            const database = yield* Database.Service
            yield* scenario({ activity, database }, filename)
          }).pipe(Effect.provide(activityGraph(filename))),
        ),
      ),
    )
    if (Exit.isFailure(exit)) throw exitFailure(exit)
  })
}

test("linkMany under a held writer fails with genuine SQLITE_BUSY (errno 5) and succeeds idempotently after release", async () => {
  await withActivityDb("busy", (services, filename) =>
    Effect.gen(function* () {
      const started = yield* services.activity.begin({
        correlation: correlation("busy-writer"),
        hostRunID: "host-busy",
        plane: "augmentation",
        tool: "read",
      })
      const peer = new Native(filename)
      const startedAt = performance.now()
      try {
        peer.exec("BEGIN IMMEDIATE")
        const exit = yield* Effect.exit(
          services.activity.linkMany([
            { invocationID: started.invocationID, kind: "root", ref: "root-busy", relation: "target" },
          ]),
        )
        const elapsed = performance.now() - startedAt
        expect(Exit.isFailure(exit)).toBe(true)
        const defect = defectOf(exit)
        const unwrapped = unwrapSqliteFailure(defect)
        expect(unwrapped.top).toBe("EffectDrizzleQueryError")
        expect(unwrapped.sqlError).toBe("SqlError")
        expect(unwrapped.sqlReason).toBe("LockTimeoutError")
        expect(unwrapped.nativeCode).toBe("SQLITE_BUSY")
        expect(unwrapped.nativeErrno).toBe(5)
        expect(unwrapped.operation).toBe("execute")
        expect(unwrapped.retryable).toBe(true)
        expect(sqliteBusyCode(defect)).toBe("SQLITE_BUSY")
        expect(elapsed).toBeGreaterThan(0)
        peer.exec("COMMIT")
      } finally {
        try {
          if (peer.inTransaction) peer.exec("ROLLBACK")
        } catch {}
        peer.close()
      }
      const retry = yield* Effect.exit(
        services.activity.linkMany([
          { invocationID: started.invocationID, kind: "root", ref: "root-busy", relation: "target" },
        ]),
      )
      expect(Exit.isSuccess(retry)).toBe(true)
      const repeat = yield* Effect.exit(
        services.activity.linkMany([
          { invocationID: started.invocationID, kind: "root", ref: "root-busy", relation: "target" },
        ]),
      )
      expect(Exit.isSuccess(repeat)).toBe(true)
      const count = yield* services.database.db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id = ${started.invocationID} AND ref = ${'root-busy'}`,
      )
      expect(count?.count).toBe(1)
    }),
  )
})

test("stale invocation link rejects with SQLITE_CONSTRAINT_FOREIGNKEY (787), is not busy, and leaves no orphan", async () => {
  await withActivityDb("stale-fk", (services) =>
    Effect.gen(function* () {
      const started = yield* services.activity.begin({
        correlation: correlation("stale-fk"),
        hostRunID: "host-stale",
        plane: "augmentation",
        tool: "read",
      })
      yield* services.activity.deleteHistory(started.activityID)
      const exit = yield* Effect.exit(
        services.activity.linkMany([
          { invocationID: started.invocationID, kind: "root", ref: "root-stale", relation: "target" },
        ]),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const defect = defectOf(exit)
      const unwrapped = unwrapSqliteFailure(defect)
      expect(unwrapped.top).toBe("EffectDrizzleQueryError")
      expect(unwrapped.sqlReason).toBe("ConstraintError")
      expect(unwrapped.nativeCode).toBe("SQLITE_CONSTRAINT_FOREIGNKEY")
      expect(unwrapped.nativeErrno).toBe(787)
      expect(unwrapped.operation).toBe("execute")
      expect(unwrapped.retryable).toBe(false)
      expect(sqliteBusyCode(defect)).toBeUndefined()
      const orphans = yield* services.database.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id NOT IN (SELECT id FROM oxp_invocation)",
      )
      expect(orphans?.count).toBe(0)
      const violations = yield* services.database.db.all("PRAGMA foreign_key_check")
      expect(violations).toEqual([])
    }),
  )
})

test("44 concurrent begin/linkMany/settle across 11 activities keeps exactly-once links and settlements", async () => {
  await withActivityDb("many-sessions", (services) =>
    Effect.gen(function* () {
      const workers = Array.from({ length: 44 }, (_, index) => ({
        digest: `many-${index % 11}`,
        workerID: `wrk_${index}`,
      }))
      const handles = yield* Effect.forEach(
        workers,
        (worker) =>
          services.activity.begin({
            correlation: correlation(worker.digest),
            hostRunID: "host-many",
            plane: "delegation",
            tool: "openfork_worker",
          }),
        { concurrency: 12 },
      )
      const batches = workers.map((worker, index) => [
        { invocationID: handles[index]!.invocationID, kind: "worker_session" as const, ref: worker.workerID, relation: "target" },
        { invocationID: handles[index]!.invocationID, kind: "worker_group" as const, ref: `batch_${index % 11}`, relation: "target" },
      ])
      yield* Effect.forEach(batches, (batch) => services.activity.linkMany(batch), { concurrency: 12, discard: true })
      yield* Effect.forEach(batches, (batch) => services.activity.linkMany(batch), { concurrency: 12, discard: true })
      yield* Effect.forEach(
        handles,
        (handle) => services.activity.settle({ invocationID: handle.invocationID, status: "success" }),
        { concurrency: 12, discard: true },
      )
      const links = yield* services.database.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM oxp_invocation_link")
      expect(links?.count).toBe(88)
      const settled = yield* services.database.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM oxp_invocation WHERE status = 'success'",
      )
      expect(settled?.count).toBe(44)
      const activities = yield* services.database.db.get<{ count: number }>(
        "SELECT COUNT(DISTINCT activity_id) AS count FROM oxp_invocation",
      )
      expect(activities?.count).toBe(11)
      const parents = yield* services.database.db.get<{ calls: number }>(
        "SELECT SUM(call_count) AS calls FROM oxp_parent_activity",
      )
      expect(parents?.calls).toBe(44)
      const violations = yield* services.database.db.all("PRAGMA foreign_key_check")
      expect(violations).toEqual([])
    }),
  )
})

test("cancellation during a contended linkMany cannot duplicate or orphan a link and a later write succeeds", async () => {
  await withActivityDb("cancellation", (services, filename) =>
    Effect.gen(function* () {
      const started = yield* services.activity.begin({
        correlation: correlation("cancel-link"),
        hostRunID: "host-cancel",
        plane: "augmentation",
        tool: "read",
      })
      const peer = new Native(filename)
      try {
        peer.exec("BEGIN IMMEDIATE")
        const fiber = yield* Effect.forkChild(
          services.activity.linkMany([
            { invocationID: started.invocationID, kind: "root", ref: "root-cancel", relation: "target" },
          ]),
        )
        yield* Effect.sleep("40 millis")
        yield* Effect.exit(Fiber.interrupt(fiber))
        peer.exec("ROLLBACK")
      } finally {
        try {
          if (peer.inTransaction) peer.exec("ROLLBACK")
        } catch {}
        peer.close()
      }
      const finish = yield* Effect.exit(
        services.activity.linkMany([
          { invocationID: started.invocationID, kind: "root", ref: "root-cancel", relation: "target" },
        ]),
      )
      expect(Exit.isSuccess(finish)).toBe(true)
      const count = yield* services.database.db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id = ${started.invocationID} AND ref = ${'root-cancel'}`,
      )
      expect(count?.count).toBe(1)
      const violations = yield* services.database.db.all("PRAGMA foreign_key_check")
      expect(violations).toEqual([])
    }),
  )
})

test("links and settlements survive scoped close and reopen of the same file-backed database", async () => {
  await withFixtureDir("reopen", async (filename) => {
    const writeExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const activity = yield* OxpActivity.Service
            const started = yield* activity.begin({
              correlation: correlation("reopen"),
              hostRunID: "host-reopen",
              plane: "augmentation",
              tool: "read",
            })
            yield* activity.linkMany([
              { invocationID: started.invocationID, kind: "root", ref: "root-reopen", relation: "target" },
            ])
            yield* activity.settle({ invocationID: started.invocationID, status: "success" })
          }).pipe(Effect.provide(activityGraph(filename))),
        ),
      ),
    )
    expect(Exit.isSuccess(writeExit)).toBe(true)

    const readExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const database = yield* Database.Service
            const links = yield* database.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM oxp_invocation_link")
            expect(links?.count).toBe(1)
            const settled = yield* database.db.get<{ count: number }>(
              "SELECT COUNT(*) AS count FROM oxp_invocation WHERE status = 'success'",
            )
            expect(settled?.count).toBe(1)
          }).pipe(Effect.provide(activityGraph(filename))),
        ),
      ),
    )
    expect(Exit.isSuccess(readExit)).toBe(true)
  })
})

test("one writer acquisition persists a full 64-link batch and repeated batches stay idempotent", async () => {
  await withActivityDb("link-budget", (services) =>
    Effect.gen(function* () {
      const started = yield* services.activity.begin({
        correlation: correlation("link-budget"),
        hostRunID: "host-budget",
        plane: "augmentation",
        tool: "openfork_worker",
      })
      const batch = Array.from({ length: LINK_BUDGET }, (_, index) => ({
        invocationID: started.invocationID,
        kind: "worker_session" as const,
        ref: `wrk_budget_${index}`,
        relation: "target",
      }))
      const first = yield* Effect.exit(services.activity.linkMany(batch))
      expect(Exit.isSuccess(first)).toBe(true)
      const second = yield* Effect.exit(services.activity.linkMany(batch))
      expect(Exit.isSuccess(second)).toBe(true)
      const count = yield* services.database.db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id = ${started.invocationID}`,
      )
      expect(count?.count).toBe(64)
      const oversize = yield* Effect.exit(
        services.activity.linkMany(
          Array.from({ length: 65 }, (_, index) => ({
            invocationID: started.invocationID,
            kind: "worker_session" as const,
            ref: `wrk_oversize_${index}`,
            relation: "target",
          })),
        ),
      )
      expect(Exit.isFailure(oversize)).toBe(true)
    }),
  )
})
