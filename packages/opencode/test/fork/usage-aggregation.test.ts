import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { ForkCredentials } from "../../src/fork/credentials"
import { buildAggregateWindows, buildLocalWindows, FIVE_HOURS_MS, type WindowBounds } from "../../src/fork/usage-cache"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ForkCredentials.node, SessionUsage.node, Database.node])))

const HOUR_MS = 60 * 60 * 1000

// Seeds the message table with opencode-go assistant rows at fixed offsets from
// now, and attributes some of them to fork credentials. Returns the createdMs
// per message id so the reference aggregation can reproduce the old behavior.
function seed(db: Database.Interface["db"], rows: ReadonlyArray<{ id: string; offsetH: number; cost: number; credentialID?: string }>) {
  const now = Date.now()
  return Effect.gen(function* () {
    yield* db
      .run(
        sql`INSERT INTO project (id, time_created, time_updated, worktree, sandboxes)
            VALUES (${"prj_usage"}, ${1}, ${1}, ${"C:/tmp/usage"}, ${JSON.stringify(["C:/tmp/usage"])})`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
            VALUES (${"ses_usage"}, ${"prj_usage"}, ${"usage"}, ${"C:/tmp/usage"}, ${"Usage"}, ${"test"}, ${1}, ${1})`,
      )
      .pipe(Effect.orDie)
    for (const row of rows) {
      const createdMs = now - row.offsetH * HOUR_MS
      yield* db
        .run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
              VALUES (
                ${row.id}, ${"ses_usage"}, ${createdMs}, ${createdMs},
                ${JSON.stringify({
                  id: row.id,
                  sessionID: "ses_usage",
                  role: "assistant",
                  providerID: "opencode-go",
                  cost: row.cost,
                  time: { created: createdMs },
                })}
              )`,
        )
        .pipe(Effect.orDie)
      if (row.credentialID) {
        yield* db
          .run(
            sql`INSERT INTO fork_message_credential (message_id, credential_id, time_created)
                VALUES (${row.id}, ${row.credentialID}, ${createdMs})`,
          )
          .pipe(Effect.orDie)
      }
    }
    return { now, createdBy: new Map(rows.map((row) => [row.id, now - row.offsetH * HOUR_MS])) }
  })
}

// The OLD (pre-optimization) JS aggregation: rows via SessionUsage.rows,
// attribution via credentialsForMessages, then per-window filter+reduce.
const referenceAggregation = Effect.fn("referenceAggregation")(function* (
  credentials: ForkCredentials.Interface,
  usage: SessionUsage.Interface,
  bounds: readonly WindowBounds[],
) {
  const earliestStart = Math.min(...bounds.map((b) => b.startMs))
  const rows = yield* usage.rows(earliestStart)
  const attribution = yield* credentials.credentialsForMessages(rows.map((row) => row.messageID))
  const allCredentials = yield* credentials.list()

  const sumFor = (predicate: (messageID: string) => boolean) =>
    bounds.map((bound) => {
      const inWindow = rows.filter(
        (row) => row.createdMs >= bound.startMs && row.createdMs < bound.endMs && predicate(row.messageID),
      )
      const lastUsedAt = Math.max(...inWindow.map((row) => row.createdMs))
      const resetAt =
        bound.label === "5h"
          ? Math.min(...inWindow.map((row) => row.createdMs), bound.endMs) + FIVE_HOURS_MS
          : bound.resetsAt
      return {
        label: bound.label,
        spentUSD: inWindow.reduce((total, row) => total + row.cost, 0),
        callsInWindow: inWindow.length,
        lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : undefined,
        resetsAt: resetAt,
        clearsAt: bound.label === "5h" && Number.isFinite(lastUsedAt) ? lastUsedAt + FIVE_HOURS_MS : resetAt,
      }
    })

  return {
    aggregate: sumFor(() => true),
    byCredential: allCredentials.map((credential) => ({
      credentialID: credential.id,
      windows: sumFor((messageID) => attribution.get(messageID) === credential.id),
    })),
  }
})

describe("usageByCredential grouped SQL", () => {
  it.effect("matches the old JS aggregation for mixed attribution", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const usage = yield* SessionUsage.Service
      const database = yield* Database.Service

      const credA = yield* credentials.add({ key: "sk-a", label: "A" })
      const credB = yield* credentials.add({ key: "sk-b", label: "B" })
      const { now, createdBy } = yield* seed(database.db, [
        { id: "m1", offsetH: 1, cost: 1.5, credentialID: credA.id }, // 5h + week + month
        { id: "m2", offsetH: 2, cost: 2, credentialID: credA.id }, // 5h + week + month
        { id: "m3", offsetH: 26, cost: 4, credentialID: credB.id }, // week + month only
        { id: "m4", offsetH: 200, cost: 8, credentialID: credA.id }, // month only
        { id: "m5", offsetH: 1, cost: 16 }, // unattributed: aggregate only
      ])

      const bounds = yield* usage.windows()
      expect(bounds.length).toBe(3)
      const earliestStart = Math.min(...bounds.map((b) => b.startMs))

      const grouped = yield* credentials.usageByCredential(bounds)
      const reference = yield* referenceAggregation(credentials, usage, bounds)

      // Every attributed message lands inside at least the month window.
      expect(createdBy.get("m1")!).toBeGreaterThanOrEqual(earliestStart)
      expect(createdBy.get("m4")!).toBeGreaterThanOrEqual(earliestStart)

      // New aggregate == old aggregate (per window: spend + calls + reset).
      const newAggregate = buildAggregateWindows(bounds, grouped.byCredential, grouped.unattributed)
      expect(newAggregate.map((w) => ({ label: w.label, spentUSD: w.spentUSD, callsInWindow: w.callsInWindow }))).toEqual(
        reference.aggregate.map((w) => ({ label: w.label, spentUSD: w.spentUSD, callsInWindow: w.callsInWindow })),
      )
      expect(newAggregate.map((w) => w.resetsAt)).toEqual(reference.aggregate.map((w) => w.resetsAt))

      // New per-credential == old per-credential, for both credentials.
      for (const credential of [credA, credB]) {
        const newWindows = buildLocalWindows(bounds, grouped.byCredential.get(credential.id) ?? [])
        const refWindows = reference.byCredential.find((entry) => entry.credentialID === credential.id)?.windows ?? []
        expect(
          newWindows.map((w) => ({
            label: w.label,
            spentUSD: w.spentUSD,
            callsInWindow: w.callsInWindow,
            lastUsedAt: w.lastUsedAt,
            resetsAt: w.resetsAt,
            clearsAt: w.clearsAt,
          })),
        ).toEqual(
          refWindows.map((w) => ({
            label: w.label,
            spentUSD: w.spentUSD,
            callsInWindow: w.callsInWindow,
            lastUsedAt: w.lastUsedAt,
            resetsAt: w.resetsAt,
            clearsAt: w.clearsAt,
          })),
        )
      }
    }),
  )

  it.effect("unattributed rows count toward aggregate only, not per-credential", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const usage = yield* SessionUsage.Service
      const database = yield* Database.Service

      const credA = yield* credentials.add({ key: "sk-a", label: "A" })
      yield* seed(database.db, [
        { id: "m1", offsetH: 1, cost: 3, credentialID: credA.id },
        { id: "m2", offsetH: 2, cost: 7 }, // unattributed
      ])

      const bounds = yield* usage.windows()
      const grouped = yield* credentials.usageByCredential(bounds)

      const aggregate = buildAggregateWindows(bounds, grouped.byCredential, grouped.unattributed)
      const month = aggregate.find((w) => w.label === "month")!
      expect(month.spentUSD).toBe(10) // 3 + 7
      expect(month.callsInWindow).toBe(2)

      const credAWindows = buildLocalWindows(bounds, grouped.byCredential.get(credA.id) ?? [])
      const credAMonth = credAWindows.find((w) => w.label === "month")!
      expect(credAMonth.spentUSD).toBe(3)
      expect(credAMonth.callsInWindow).toBe(1)
    }),
  )

  it.effect("empty bounds return empty buckets (no SQL)", () =>
    Effect.gen(function* () {
      const credentials = yield* ForkCredentials.Service
      const grouped = yield* credentials.usageByCredential([])
      expect(grouped.byCredential.size).toBe(0)
      expect(grouped.unattributed).toEqual([])
    }),
  )
})
