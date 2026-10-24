import { expect, test } from "bun:test"
import { Database as Native } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { OxpActivity } from "@opencode-ai/core/oxp-activity/activity"
import { Global } from "@opencode-ai/core/global"
import { sqliteBusyCode } from "@opencode-ai/core/database/sqlite-busy"
import { OxpActivityIdentity } from "@/oxp/activity-identity"
import { OxpActivityRecorder } from "@/oxp/activity-recorder"
import { OxpDiagnostics } from "@/oxp/diagnostics"

const fakeIdentity = Layer.succeed(
  OxpActivityIdentity.Service,
  OxpActivityIdentity.Service.of({
    pseudonymize: (correlation) =>
      Effect.succeed({
        scheme: correlation.scheme,
        digest: "digest:" + Buffer.from(correlation.scheme + "\0" + correlation.value).toString("base64url"),
        scope: correlation.scope,
      }),
  }),
)

const correlation = (value: string) => ({ scheme: "openai/session", value, scope: "conversation" }) as const

const activityCorrelation = (value: string) => ({ scheme: "mcp-session-id", digest: value, scope: "unknown" }) as const

function recorderGraph(filename: string, globalRoot: string) {
  return AppNodeBuilder.build(
    LayerNode.group([Database.node, OxpActivity.node, OxpActivityRecorder.node]),
    [
      [Database.node, Database.layerFromPath(filename)],
      [Global.node, Global.layerWith({ config: join(globalRoot, "config"), state: join(globalRoot, "state") })],
      [OxpActivityIdentity.node, fakeIdentity],
    ],
  )
}

function defectOf(exit: Exit.Exit<unknown, unknown>): unknown {
  if (Exit.isSuccess(exit)) throw new Error("expected a failed exit")
  return Cause.squash(exit.cause)
}

function incidentsSince(timestamp: number) {
  return OxpDiagnostics.list({ limit: 20 })
    .slice()
    .reverse()
    .filter((incident) => incident.at >= timestamp)
    .map((incident) => ({
      phase: incident.phase,
      activityOperation: incident.activityOperation,
      errorName: incident.errorName,
      errorCode: incident.errorCode,
      serialized: JSON.stringify(incident),
    }))
}

/** Mirror of the surgical classifier patch proposed in B-activity-link.md: accept the
 * Drizzle wrapper and traverse Cause.reasons explicitly. Validates patch semantics
 * without editing another contributor's untracked diagnostics implementation. */
function proposedSqliteIncidentCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const top = error as { _tag?: unknown; constructor?: { name?: unknown }; name?: unknown }
  const name = top._tag ?? top.constructor?.name ?? top.name
  if (name !== "SqlError" && name !== "SQLITE_ERROR" && name !== "EffectDrizzleQueryError") return undefined
  const stack: unknown[] = [error]
  const seen = new Set<object>()
  while (stack.length > 0 && seen.size < 24) {
    const current = stack.pop()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    const node = current as Record<string, unknown>
    if (typeof node.code === "string" && /^SQLITE_[A-Z0-9_]+$/.test(node.code)) return node.code
    const errno = node.errno ?? node.errcode
    if (typeof errno === "number" && Number.isSafeInteger(errno) && errno >= 0) {
      const base = errno & 255
      if (errno === 517) return "SQLITE_BUSY_SNAPSHOT"
      if (base === 5) return "SQLITE_BUSY"
      if (base === 19) return "SQLITE_CONSTRAINT"
      if (base === 1) return "SQLITE_ERROR"
      if (base === 6) return "SQLITE_LOCKED"
    }
    if (typeof node.message === "string") {
      const match = /^Failed to execute statement class=[A-Z]+ sqlite=(SQLITE_[A-Z0-9_]+)$/.exec(node.message)
      if (match) return match[1]
    }
    for (const field of ["reason", "cause", "error", "defect", "failure"] as const) {
      try {
        if (node[field] && typeof node[field] === "object") stack.push(node[field])
      } catch {}
    }
    try {
      if (Array.isArray(node.reasons)) {
        for (let index = 0; index < Math.min(node.reasons.length, 8); index++) {
          const reason = node.reasons[index]
          if (reason && typeof reason === "object") stack.push(reason)
        }
      }
    } catch {}
  }
  return "SQLITE_UNCLASSIFIED"
}

async function withRecorderDb(
  label: string,
  scenario: (
    services: { recorder: OxpActivityRecorder.Interface; activity: OxpActivity.Interface; database: Database.Interface },
    filename: string,
  ) => Effect.Effect<void, unknown>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `openfork-oxp-recorder-${label}-`))
  const filename = join(dir, "recorder.sqlite")
  let scenarioError: unknown
  try {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* OxpActivityRecorder.Service
            const activity = yield* OxpActivity.Service
            const database = yield* Database.Service
            yield* scenario({ recorder, activity, database }, filename)
          }).pipe(Effect.provide(recorderGraph(filename, dir))),
        ),
      ),
    )
    if (Exit.isFailure(exit)) {
      const squashed = Cause.squash(exit.cause)
      const message = (squashed as { message?: unknown } | undefined)?.message
      scenarioError = new Error(typeof message === "string" ? message : `recorder scenario ${label} failed`, { cause: squashed })
    }
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
}

test("contention released inside the bounded retry budget recovers silently with one durable link set", async () => {
  await withRecorderDb("recover", (services, filename) =>
    Effect.gen(function* () {
      const input = {
        parentCorrelation: correlation("recorder-recover"),
        tool: "openfork_worker",
        args: { action: "status", workerID: "wrk_recover" },
      } as const
      const handle = yield* services.recorder.begin(input)
      expect(handle).toBeDefined()
      const peer = new Native(filename)
      try {
        peer.exec("BEGIN IMMEDIATE")
        const release = yield* Effect.forkChild(
          Effect.sleep("280 millis").pipe(Effect.tap(() => Effect.sync(() => peer.exec("COMMIT")))),
        )
        const startedAt = Date.now()
        const at = performance.now()
        yield* services.recorder.success(handle, input, { output: "ok", structured: { workerID: "wrk_recover" } })
        const elapsed = performance.now() - at
        yield* Fiber.join(release)
        expect(elapsed).toBeGreaterThanOrEqual(250)
        const incidents = incidentsSince(startedAt)
        expect(incidents).toEqual([])
      } finally {
        try {
          if (peer.inTransaction) peer.exec("ROLLBACK")
        } catch {}
        peer.close()
      }
      const settled = yield* services.database.db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM oxp_invocation WHERE status = ${'success'}`,
      )
      expect(settled?.count).toBe(1)
      const links = yield* services.database.db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id = ${handle!.invocationID}`,
      )
      expect(links?.count).toBe(2)
    }),
  )
})

test("sustained contention beyond the budget records a fixed-operation link incident and preserves tool flow", async () => {
  await withRecorderDb("sustained", (services, filename) =>
    Effect.gen(function* () {
      expect(services.database.activityDb).toBeDefined()
      const activityLane = yield* services.database.activityDb!()
      expect(activityLane).not.toBe(services.database.db)
      const input = {
        parentCorrelation: correlation("recorder-sustained"),
        tool: "openfork_worker",
        args: { action: "status", workerID: "wrk_sustained" },
      } as const
      const handle = yield* services.recorder.begin(input)
      expect(handle).toBeDefined()
      const peer = new Native(filename)
      const at = performance.now()
      try {
        peer.exec("BEGIN IMMEDIATE")
        yield* services.recorder.success(handle, input, { output: "ok", structured: { workerID: "wrk_sustained" } })
        const elapsed = performance.now() - at
        expect(elapsed).toBeGreaterThanOrEqual(450)
        // A primary-lane BEGIN can retry for 15 seconds. Optional OXP
        // attribution must use its isolated bounded writer and never inherit
        // that foreground retry policy on a contended SQLite WAL.
        expect(elapsed).toBeLessThan(3_000)
      } finally {
        try {
          if (peer.inTransaction) peer.exec("COMMIT")
        } catch {}
        peer.close()
      }
      const incidents = incidentsSince(Date.now() - 60_000)
      const linkIncidents = incidents.filter((incident) => incident.activityOperation === "link")
      expect(linkIncidents.length).toBeGreaterThanOrEqual(1)
      for (const incident of linkIncidents) {
        expect(incident.phase).toBe("activity_recording")
        expect(incident.errorName).toBe("EffectDrizzleQueryError")
      }
      for (const incident of incidents) {
        expect(incident.serialized).not.toContain("INSERT")
        expect(incident.serialized).not.toContain("SELECT")
        expect(incident.serialized).not.toContain("oxp_invocation")
      }
      const settleIncidents = incidents.filter((incident) => incident.activityOperation === "settle")
      expect(settleIncidents.some((incident) => incident.errorCode === "SQLITE_BUSY")).toBe(true)
    }),
  )
}, 15_000)

test("stale invocation link failures are non-busy and do not replay", async () => {
  await withRecorderDb("stale", (services) =>
    Effect.gen(function* () {
      const input = {
        parentCorrelation: correlation("recorder-stale"),
        tool: "openfork_worker",
        args: { action: "status", workerID: "wrk_stale" },
      } as const
      const handle = yield* services.recorder.begin(input)
      expect(handle).toBeDefined()
      yield* services.activity.deleteHistory(handle!.activityID)
      const at = Date.now()
      const startedAt = performance.now()
      yield* services.recorder.success(handle, input, { output: "ok", structured: { workerID: "wrk_stale" } })
      const elapsed = performance.now() - startedAt
      const incidents = incidentsSince(at).filter((incident) => incident.activityOperation === "link")
      expect(incidents.length).toBeGreaterThanOrEqual(1)
      expect(incidents[0]!.errorName).toBe("EffectDrizzleQueryError")
      expect(elapsed).toBeGreaterThan(0)
      const violations = yield* services.database.db.all("PRAGMA foreign_key_check")
      expect(violations).toEqual([])
    }),
  )
})

test("production classifier unwraps genuine busy and foreign-key link defects without leakage", async () => {
  await withRecorderDb("shim", (services, filename) =>
    Effect.gen(function* () {
      const busyHandle = yield* services.activity.begin({
        correlation: activityCorrelation("shim-busy"),
        hostRunID: "host-shim",
        plane: "augmentation",
        tool: "read",
      })
      const peer = new Native(filename)
      const busyExit = yield* Effect.gen(function* () {
        peer.exec("BEGIN IMMEDIATE")
        return yield* Effect.exit(
          services.activity.linkMany([
            { invocationID: busyHandle.invocationID, kind: "root", ref: "root-shim", relation: "target" },
          ]),
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            try {
              if (peer.inTransaction) peer.exec("ROLLBACK")
            } catch {}
            peer.close()
          }),
        ),
      )
      expect(Exit.isFailure(busyExit)).toBe(true)
      const busyDefect = defectOf(busyExit)
      expect(sqliteBusyCode(busyDefect)).toBe("SQLITE_BUSY")
      expect(proposedSqliteIncidentCode(busyDefect)).toBe("SQLITE_BUSY")
      expect(OxpDiagnostics.sqliteIncidentCode(busyDefect)).toBe("SQLITE_BUSY")

      const staleHandle = yield* services.activity.begin({
        correlation: activityCorrelation("shim-stale"),
        hostRunID: "host-shim",
        plane: "augmentation",
        tool: "read",
      })
      yield* services.activity.deleteHistory(staleHandle.activityID)
      const fkExit = yield* Effect.exit(
        services.activity.linkMany([
          { invocationID: staleHandle.invocationID, kind: "root", ref: "root-shim", relation: "target" },
        ]),
      )
      expect(Exit.isFailure(fkExit)).toBe(true)
      const fkDefect = defectOf(fkExit)
      expect(sqliteBusyCode(fkDefect)).toBeUndefined()
      expect(proposedSqliteIncidentCode(fkDefect)).toBe("SQLITE_CONSTRAINT_FOREIGNKEY")
      expect(OxpDiagnostics.sqliteIncidentCode(fkDefect)).toBe("SQLITE_CONSTRAINT_FOREIGNKEY")
    }),
  )
})


test("44 concurrent recorder invocations under a competing writer settle exactly once with intact lineage", async () => {
  await withRecorderDb("concurrent", (services, filename) =>
    Effect.gen(function* () {
      const inputs = Array.from({ length: 44 }, (_, index) => ({
        parentCorrelation: correlation(`recorder-concurrent-${index % 11}`),
        tool: "openfork_worker",
        args: { action: "status", workerID: `wrk_conc_${index}` },
      }))
      const peer = new Native(filename)
      try {
        peer.exec("BEGIN IMMEDIATE")
        const release = yield* Effect.forkChild(
          Effect.sleep("250 millis").pipe(Effect.tap(() => Effect.sync(() => peer.exec("COMMIT")))),
        )
        const handles = yield* Effect.forEach(inputs, (input) => services.recorder.begin(input), { concurrency: 12 })
        yield* Effect.forEach(
          inputs,
          (input, index) => services.recorder.success(handles[index], input, { output: "ok", structured: { workerID: input.args.workerID } }),
          { concurrency: 12, discard: true },
        )
        yield* Fiber.join(release)
      } finally {
        try {
          if (peer.inTransaction) peer.exec("ROLLBACK")
        } catch {}
        peer.close()
      }
      const invocations = yield* services.database.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM oxp_invocation",
      )
      expect(invocations?.count).toBe(44)
      const settled = yield* services.database.db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM oxp_invocation WHERE status = ${'success'}`,
      )
      expect(settled?.count).toBe(44)
      const links = yield* services.database.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM oxp_invocation_link")
      expect(links?.count).toBe(88)
      const violations = yield* services.database.db.all("PRAGMA foreign_key_check")
      expect(violations).toEqual([])
      const orphanLinks = yield* services.database.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id NOT IN (SELECT id FROM oxp_invocation)",
      )
      expect(orphanLinks?.count).toBe(0)
    }),
  )
})

test("repeated recorder completion after a contended start is idempotent and leaves one settle", async () => {
  await withRecorderDb("repeat", (services, filename) =>
    Effect.gen(function* () {
      const input = {
        parentCorrelation: correlation("recorder-repeat"),
        tool: "openfork_worker",
        args: { action: "status", workerID: "wrk_repeat" },
      } as const
      const handle = yield* services.recorder.begin(input)
      expect(handle).toBeDefined()
      const peer = new Native(filename)
      peer.exec("BEGIN IMMEDIATE")
      const fiber = yield* Effect.forkChild(
        services.recorder.success(handle, input, { output: "ok", structured: { workerID: "wrk_repeat" } }),
      )
      yield* Effect.sleep("40 millis")
      yield* Effect.exit(Fiber.interrupt(fiber))
      peer.exec("ROLLBACK")
      peer.close()
      yield* services.recorder.success(handle, input, { output: "ok", structured: { workerID: "wrk_repeat" } })
      yield* services.recorder.success(handle, input, { output: "ok", structured: { workerID: "wrk_repeat" } })
      const links = yield* services.database.db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM oxp_invocation_link WHERE invocation_id = ${handle!.invocationID}`,
      )
      expect(links?.count).toBe(2)
      const firstSettle = yield* services.database.db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM oxp_invocation WHERE id = ${handle!.invocationID} AND status = ${'success'}`,
      )
      expect(firstSettle?.count).toBe(1)
      const violations = yield* services.database.db.all("PRAGMA foreign_key_check")
      expect(violations).toEqual([])
    }),
  )
})
