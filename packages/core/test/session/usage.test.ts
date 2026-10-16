import { afterAll, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { sql } from "drizzle-orm"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionUsage.node, Database.node])))
const file = await tmpdir()
const fileTest = testEffect(AppNodeBuilder.build(
  LayerNode.group([SessionUsage.node, Database.node]),
  [[Database.node, Database.layerFromPath(join(file.path, "usage-scan-isolation.sqlite"))]],
))
afterAll(async () => { await file[Symbol.asyncDispose]().catch(() => {}) })

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const seed = Effect.fn("seed")(function* (
  messages: ReadonlyArray<{ providerID: string; cost: number; createdMs: number }>,
) {
  const { db } = yield* Database.Service
  const cwd = process.cwd()
  yield* db
    .insert(ProjectTable)
    .values({ id: "prj_test" as never, worktree: cwd as never, sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: "ses_test" as never,
      project_id: "prj_test" as never,
      slug: "test",
      directory: cwd as never,
      title: "Test",
      version: "0.0.0",
    })
    .run()
    .pipe(Effect.orDie)
  yield* Effect.forEach(
    messages,
    (message, index) =>
      db
        .insert(MessageTable)
        .values({
          id: `msg_test_${index}` as never,
          session_id: "ses_test" as never,
          time_created: message.createdMs,
          data: {
            role: "assistant",
            providerID: message.providerID,
            cost: message.cost,
            time: { created: message.createdMs },
          } as never,
        })
        .run()
        .pipe(Effect.orDie),
    { discard: true },
  )
})

describe("SessionUsage", () => {
  fileTest.live("historical Go usage reads complete while the primary writer permit is held", () =>
    Effect.gen(function* () {
      const { db, readDb, scanDb } = yield* Database.Service
      const usage = yield* SessionUsage.Service
      const now = Date.now()
      yield* seed([{ providerID: "opencode-go", cost: 0.5, createdMs: now - HOUR_MS }])
      const scanner = yield* scanDb()
      expect(scanner).not.toBe(db)
      expect(scanner).not.toBe(readDb)

      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const writer = yield* db.transaction((tx) => Effect.gen(function* () {
        yield* tx.run(sql`UPDATE message SET time_updated = time_updated WHERE id = 'msg_test_0'`)
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }), { behavior: "immediate" }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      const history = yield* Effect.all([
        usage.rows(now - 2 * HOUR_MS),
        usage.windows(),
      ], { concurrency: "unbounded" }).pipe(Effect.forkScoped)
      const completedWithoutWriter = yield* Effect.race(
        Fiber.await(history).pipe(Effect.as(true)),
        Effect.sleep("350 millis").pipe(Effect.as(false)),
      )
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(writer)
      expect(completedWithoutWriter).toBe(true)
      const [rows, windows] = yield* Fiber.join(history)
      expect(rows).toHaveLength(1)
      expect(windows).toHaveLength(3)
    }),
  )

  it.effect("sums Go-plan spend within each window and excludes other providers", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed([
        // Within the 5h window.
        { providerID: "opencode-go", cost: 0.5, createdMs: now - HOUR_MS },
        // Outside the 5h window but within the week.
        { providerID: "opencode-go", cost: 1, createdMs: now - 6 * HOUR_MS },
        // Very old — outside the week (and effectively outside the month window too).
        { providerID: "opencode-go", cost: 2, createdMs: now - 40 * DAY_MS },
        // Different provider — must never count toward Go-plan spend.
        { providerID: "opencode", cost: 100, createdMs: now - HOUR_MS },
      ])

      const usage = yield* (yield* SessionUsage.Service).goPlan()
      const fiveHour = usage.find((window) => window.label === "5h")
      const week = usage.find((window) => window.label === "week")

      expect(fiveHour?.spentUSD).toBeCloseTo(0.5, 5)
      expect(fiveHour?.callsInWindow).toBe(1)
      expect(fiveHour?.limitUSD).toBe(12)

      expect(week?.spentUSD).toBeCloseTo(1.5, 5)
      expect(week?.callsInWindow).toBe(2)
      expect(week?.limitUSD).toBe(30)
    }),
  )

  it.effect("returns zeroed windows when there is no usage yet", () =>
    Effect.gen(function* () {
      const usage = yield* (yield* SessionUsage.Service).goPlan()
      expect(usage).toHaveLength(3)
      for (const window of usage) {
        expect(window.spentUSD).toBe(0)
        expect(window.callsInWindow).toBe(0)
      }
    }),
  )

  it.effect("predicts the 5h rolling reset from the oldest usage in the current window", () =>
    Effect.gen(function* () {
      const now = Date.now()
      yield* seed([
        { providerID: "opencode-go", cost: 0.5, createdMs: now - 3 * HOUR_MS },
        { providerID: "opencode-go", cost: 0.5, createdMs: now - HOUR_MS },
      ])

      const usage = yield* (yield* SessionUsage.Service).goPlan()
      const fiveHour = usage.find((window) => window.label === "5h")

      expect(fiveHour?.resetsAt).toBeGreaterThanOrEqual(now + 2 * HOUR_MS)
      expect(fiveHour?.resetsAt).toBeLessThan(now + 2 * HOUR_MS + 1000)
      expect(fiveHour?.clearsAt).toBeGreaterThanOrEqual(now + 4 * HOUR_MS)
      expect(fiveHour?.clearsAt).toBeLessThan(now + 4 * HOUR_MS + 1000)
    }),
  )
})
