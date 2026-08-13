import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionUsage.node, Database.node])))

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
