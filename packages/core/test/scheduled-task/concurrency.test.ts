import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskLease } from "@opencode-ai/core/scheduled-task/lease"
import { ScheduledTaskRunTable } from "@opencode-ai/core/scheduled-task/sql"
import { Flag } from "@opencode-ai/core/flag/flag"
import { eq } from "drizzle-orm"

/**
 * Tier C: C1 and C2 with TWO REAL PROCESSES against one SQLite file.
 *
 * Two fibers in one process cannot detect a missing claim guard: in-process
 * scheduling serializes them by accident. These tests spawn the fixture as
 * separate OS processes.
 */
const coreDir = path.resolve(import.meta.dir, "../..")
const fixture = "test/scheduled-task/fixtures/two-process.ts"

const layerFor = (dbPath: string) =>
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, ScheduledTask.node, ScheduledTaskLease.node]),
    [[Database.node, Database.layerFromPath(dbPath)]],
  )

async function withDatabase<A>(
  dbPath: string,
  body: (services: {
    tasks: ScheduledTask.Interface
    leases: ScheduledTaskLease.Interface
    db: Database.DatabaseShape
  }) => Effect.Effect<A, ScheduledTask.Error, never>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layerFor(dbPath))
        return yield* Effect.provide(
          Effect.gen(function* () {
            const tasks = yield* ScheduledTask.Service
            const leases = yield* ScheduledTaskLease.Service
            const { db } = yield* Database.Service
            return yield* body({ tasks, leases, db })
          }),
          context,
        )
      }),
    ),
  )
}

async function runFixture(dbPath: string, startAt: number, mode: string) {
  const proc = Bun.spawn(["bun", fixture, dbPath, String(startAt), mode], {
    cwd: coreDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const lines = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
  const parsed = lines.length > 0 ? (JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>) : undefined
  return { code, out, err, parsed }
}

async function seedTask(dbPath: string, name: string) {
  await withDatabase(dbPath, ({ tasks }) =>
    tasks.create({
      targetDirectory: "/scheduled/concurrency",
      name,
      enabled: true,
      schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
      timezone: "America/New_York",
      action: { prompt: "hello" },
      now: Date.parse("2026-06-01T00:00:00Z"),
    }),
  )
}

describe("scheduled task concurrency across real processes", () => {
  test("C1/C3: two processes racing one due task produce exactly one claim and one run row", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-st-race-"))
    const dbPath = path.join(directory, "race.sqlite")
    try {
      await seedTask(dbPath, "race-task")
      const startAt = Date.now() + 4000
      const [first, second] = await Promise.all([
        runFixture(dbPath, startAt, "race"),
        runFixture(dbPath, startAt, "race"),
      ])
      expect(first.err).not.toContain("error")
      expect(second.err).not.toContain("error")
      const claimed = [first.parsed, second.parsed].filter((result) => result?.claimed === true)
      expect(claimed).toHaveLength(1)
      const rows = await withDatabase(dbPath, ({ db }) =>
        db.select().from(ScheduledTaskRunTable).all().pipe(Effect.orDie),
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe("running")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  test("C2: a killed runner's lease is recovered by a second process and its run becomes abandoned", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-st-recover-"))
    const dbPath = path.join(directory, "recover.sqlite")
    try {
      const created = await withDatabase(dbPath, ({ tasks }) =>
        tasks.create({
          targetDirectory: "/scheduled/concurrency",
          name: "recover-task",
          enabled: true,
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          timezone: "America/New_York",
          action: { prompt: "hello" },
          now: Date.parse("2026-06-01T00:00:00Z"),
        }),
      )

      // Process A claims and dies without settling.
      const hold = await runFixture(dbPath, Date.now() + 2000, "hold")
      expect(hold.parsed).toMatchObject({ claimed: true })

      // Process B runs the startup recovery with an advanced clock.
      const recover = await runFixture(dbPath, Date.now() - 1000, "recover")
      expect(recover.parsed?.reclaimed).toContain(created.id)

      const after = await withDatabase(dbPath, ({ db, leases }) =>
        Effect.gen(function* () {
          const run = yield* db
            .select()
            .from(ScheduledTaskRunTable)
            .where(eq(ScheduledTaskRunTable.task_id, created.id))
            .get()
            .pipe(Effect.orDie)
          const reacquired = yield* leases.claim({
            taskID: created.id,
            fireFor: created.nextRunAt!,
            now: Date.now(),
          })
          return { run, reacquired }
        }),
      )
      expect(after.run?.status).toBe("abandoned")
      // Reacquisition carries the incremented attempt.
      expect(after.reacquired?.attempt).toBe(2)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  test("C9-storage: a peer queued-run commit advances the durable generation across processes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-st-generation-"))
    const dbPath = path.join(directory, "generation.sqlite")
    try {
      await withDatabase(dbPath, ({ tasks }) =>
        tasks.create({
          targetDirectory: "/scheduled/concurrency",
          name: "generation-task",
          enabled: false,
          schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
          timezone: "UTC",
          action: { prompt: "hello" },
          now: 0,
        }),
      )
      const before = await withDatabase(dbPath, ({ tasks }) => tasks.generation())
      const peer = await runFixture(dbPath, Date.now(), "queue")
      expect(peer.code).toBe(0)
      expect(peer.err).not.toContain("error")
      expect(peer.parsed?.before).toBe(before)
      expect(Number(peer.parsed?.after)).toBeGreaterThan(before)

      // This read occurs through a separately opened Database service after the
      // writer process has exited. It proves the invalidation epoch is durable
      // cross-process state, not a connection-local notification.
      const observed = await withDatabase(dbPath, ({ tasks }) => tasks.generation())
      expect(observed).toBe(Number(peer.parsed?.after))
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  test.serial("C10: foreground scheduler writes do not snapshot-upgrade under live ChunkDB semantic pruning", async () => {
    const previous = {
      enabled: process.env.OPENCODE_SEAL_ENABLED,
      dedup: process.env.OPENCODE_SEAL_DEDUP,
      prune: process.env.OPENCODE_SEAL_PRUNE,
      workers: process.env.OPENCODE_SEAL_WORKERS,
      delta: process.env.OPENCODE_SEAL_DELTA,
    }
    process.env.OPENCODE_SEAL_ENABLED = "1"
    process.env.OPENCODE_SEAL_DEDUP = "1"
    process.env.OPENCODE_SEAL_PRUNE = "1"
    process.env.OPENCODE_SEAL_WORKERS = "0"
    process.env.OPENCODE_SEAL_DELTA = "0"

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-st-chunkdb-contention-"))
    const dbPath = path.join(directory, "contention.sqlite")
    try {
      expect(Flag.OPENCODE_SEAL_PRUNE).toBe(true)
      const count = 256
      const created = await withDatabase(dbPath, ({ tasks }) =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            Array.from({ length: count }, (_, index) => index),
            (index) =>
              tasks.create({
                targetDirectory: "/scheduled/concurrency",
                name: `chunkdb-contention-${index}`,
                enabled: true,
                schedule: { kind: "daily", times: [{ hour: 9, minute: 0 }] },
                timezone: "America/New_York",
                action: { prompt: "hello" },
                now: Date.parse("2026-06-01T00:00:00Z"),
              }),
            { concurrency: 1, discard: true },
          )
          return (yield* tasks.list()).length
        }),
      )
      expect(created).toBe(count)
    } finally {
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      restore("OPENCODE_SEAL_ENABLED", previous.enabled)
      restore("OPENCODE_SEAL_DEDUP", previous.dedup)
      restore("OPENCODE_SEAL_PRUNE", previous.prune)
      restore("OPENCODE_SEAL_WORKERS", previous.workers)
      restore("OPENCODE_SEAL_DELTA", previous.delta)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
