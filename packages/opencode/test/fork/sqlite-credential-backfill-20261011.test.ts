import { expect, test } from "bun:test"
import { Database as BunSQLite } from "bun:sqlite"
import { sql } from "drizzle-orm"
import { Effect, Exit, Fiber, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Auth } from "../../src/auth"
import { ForkCredentials } from "../../src/fork/credentials"
import { usageCacheGeneration, type WindowBounds } from "../../src/fork/usage-cache"
import { pollWithTimeout } from "../lib/effect"

// Lane A RED/GREEN regression for the single-credential attribution backfill.
//
// The pre-fix implementation ran one unbounded `INSERT OR IGNORE ... SELECT
// FROM message` on the primary writer on the first list()/active()/
// credentialsForMessages() call, and marked a process-local flag before the SQL
// succeeded. These tests use a real file-backed WAL database, a real second
// SQLite connection holding the write lock, and real credential reads.

const CREATED_BASE = Date.UTC(2026, 0, 1)
// Production bound (SINGLE_CREDENTIAL_BACKFILL_SLICE). Histories below exceed it
// by a wide margin so "first trigger did not slurp the whole history" is a
// stable assertion even if the drain advances one extra slice before the count.
const SLICE_HINT = 400

const messageId = (index: number) => `msg_bf_${String(index).padStart(6, "0")}`

const makeDatabaseFile = async () => {
  const dir = await mkdtemp(join(tmpdir(), "openfork-credbackfill-"))
  return { dir, file: join(dir, "backfill.sqlite") }
}

const buildLayer = (file: string, legacyKey?: string) =>
  AppNodeBuilder.build(LayerNode.group([ForkCredentials.node, Database.node, Auth.node]), [
    [Database.node, Database.layerFromPath(file)],
    [
      Auth.node,
      Layer.mock(Auth.Service, {
        get: () => Effect.succeed(legacyKey ? new Auth.Api({ type: "api", key: legacyKey }) : undefined),
      }),
    ],
  ])

const runScoped = <A, E>(
  file: string,
  body: Effect.Effect<A, E, ForkCredentials.Service | Database.Service>,
  legacyKey?: string,
) => Effect.runPromise(Effect.scoped(Effect.provide(body, buildLayer(file, legacyKey))))

type Db = Database.Interface["db"]

const seedProjectAndSession = (db: Db) =>
  Effect.gen(function* () {
    yield* db
      .run(
        sql`INSERT INTO project (id, time_created, time_updated, worktree, sandboxes)
            VALUES (${"prj_lane_a"}, ${1}, ${1}, ${"C:/tmp/lane-a"}, ${JSON.stringify(["C:/tmp/lane-a"])})`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
            VALUES (${"ses_lane_a"}, ${"prj_lane_a"}, ${"lane-a"}, ${"C:/tmp/lane-a"}, ${"Lane A"}, ${"test"}, ${1}, ${1})`,
      )
      .pipe(Effect.orDie)
  })

const seedHistory = (
  db: Db,
  sessionID: string,
  count: number,
  options?: { readonly cost?: number; readonly startIndex?: number },
) =>
  Effect.gen(function* () {
    const cost = options?.cost ?? 1.25
    const start = options?.startIndex ?? 0
    const batchSize = 200
    for (let offset = 0; offset < count; offset += batchSize) {
      const size = Math.min(batchSize, count - offset)
      const tuples = Array.from({ length: size }, (_, i) => {
        const index = start + offset + i
        const created = CREATED_BASE + index
        return sql`(${messageId(index)}, ${sessionID}, ${created}, ${created}, ${JSON.stringify({
          id: messageId(index),
          sessionID,
          role: "assistant",
          providerID: "opencode-go",
          cost,
          time: { created },
        })})`
      })
      yield* db
        .run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ${sql.join(tuples, sql`, `)}`)
        .pipe(Effect.orDie)
    }
  })

const attributedCount = (db: Db, credentialID?: string) =>
  Effect.map(
    db
      .get<{ count: number }>(
        credentialID === undefined
          ? sql`SELECT count(*) AS count FROM fork_message_credential`
          : sql`SELECT count(*) AS count FROM fork_message_credential WHERE credential_id = ${credentialID}`,
      )
      .pipe(Effect.orDie),
    (row) => row?.count ?? 0,
  )

const maxMessageId = (db: Db) =>
  Effect.map(
    db.get<{ id: string }>(sql`SELECT id FROM message ORDER BY id DESC LIMIT 1`).pipe(Effect.orDie),
    (row) => row?.id ?? "",
  )

const backfillCursor = (db: Db, credentialID: string) =>
  Effect.map(
    db
      .get<{ cursor_id: string }>(
        sql`SELECT cursor_id FROM fork_credential_backfill WHERE credential_id = ${credentialID}`,
      )
      .pipe(Effect.orDie),
    (row) => row?.cursor_id,
  )

const backfillStateRows = (db: Db) =>
  Effect.map(
    db.get<{ count: number }>(sql`SELECT count(*) AS count FROM fork_credential_backfill`).pipe(Effect.orDie),
    (row) => row?.count ?? 0,
  )

const countScannedByCursor = (db: Db, cursor: string) =>
  Effect.map(
    db
      .get<{ count: number }>(sql`SELECT count(*) AS count FROM message WHERE id <= ${cursor}`)
      .pipe(Effect.orDie),
    (row) => row?.count ?? 0,
  )

// Real second connection holding SQLite's write reservation. WAL keeps reads
// available; any writer attempt by the service must wait or fail explicitly.
const holdExternalWriter = (file: string) => {
  const external = new BunSQLite(file)
  external.run("PRAGMA busy_timeout = 0")
  external.run("BEGIN IMMEDIATE")
  let released = false
  return {
    release() {
      if (released) return
      released = true
      try {
        external.run("COMMIT")
      } catch {}
      external.close()
    },
  }
}

const withDatabaseFile = async (body: (file: string) => Promise<void>) => {
  const { dir, file } = await makeDatabaseFile()
  try {
    await body(file)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test(
  "list() survives a competing writer and attribution completes after release (no process-local poisoning)",
  async () => {
    await withDatabaseFile(async (file) => {
      await runScoped(
        file,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const credentials = yield* ForkCredentials.Service
          const created = yield* credentials.add({ key: "sk-lane-a", label: "Lane A" })
          yield* seedProjectAndSession(database.db)
          yield* seedHistory(database.db, "ses_lane_a", 80)

          const lock = holdExternalWriter(file)
          const started = Date.now()
          const listed = yield* credentials.list()
          console.log(`[lane-a] list() under external writer lock resolved in ${Date.now() - started}ms`)
          expect(listed.map((item) => item.id)).toEqual([created.id])
          expect(yield* attributedCount(database.db)).toBe(0)
          expect(yield* backfillStateRows(database.db)).toBe(0)
          lock.release()

          const first = messageId(0)
          const mapping = yield* credentials.credentialsForMessages([first])
          expect(mapping.get(first)).toBe(created.id)
          yield* pollWithTimeout(
            Effect.map(attributedCount(database.db), (count) => (count === 80 ? count : undefined)),
            "single-credential backfill never completed after the writer lock was released",
            "20 seconds",
          )
          expect(yield* backfillCursor(database.db, created.id)).toBe(messageId(79))
        }),
      )
    })
  },
  30_000,
)

test(
  "a failed legacy auth migration is retried instead of being permanently skipped",
  async () => {
    await withDatabaseFile(async (file) => {
      await runScoped(
        file,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const credentials = yield* ForkCredentials.Service
          yield* seedProjectAndSession(database.db)
          yield* seedHistory(database.db, "ses_lane_a", 40)

          const lock = holdExternalWriter(file)
          const firstAttempt = yield* credentials.list().pipe(Effect.exit)
          console.log(`[lane-a] first list() under writer lock failed=${!Exit.isSuccess(firstAttempt)}`)
          expect(Exit.isFailure(firstAttempt)).toBe(true)
          lock.release()

          const listed = yield* credentials.list()
          expect(listed).toHaveLength(1)
          expect(listed[0]?.label).toBe("Migrated key")
          yield* pollWithTimeout(
            Effect.map(attributedCount(database.db), (count) => (count === 40 ? count : undefined)),
            "retried legacy migration never received historical attribution",
            "20 seconds",
          )
          expect(yield* attributedCount(database.db, listed[0]!.id)).toBe(40)
        }),
        "sk-legacy",
      )
    })
  },
  30_000,
)

test(
  "foreground trigger performs a bounded slice, not the entire history",
  async () => {
    await withDatabaseFile(async (file) => {
      await runScoped(
        file,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const credentials = yield* ForkCredentials.Service
          const created = yield* credentials.add({ key: "sk-lane-a", label: "Lane A" })
          yield* seedProjectAndSession(database.db)
          const total = 2_000
          yield* seedHistory(database.db, "ses_lane_a", total)

          const started = Date.now()
          yield* credentials.list()
          const firstCallMs = Date.now() - started
          const afterFirst = yield* attributedCount(database.db)
          console.log(`[lane-a] first list(): ${afterFirst}/${total} attributed in ${firstCallMs}ms`)
          expect(afterFirst).toBeGreaterThanOrEqual(SLICE_HINT)
          expect(afterFirst).toBeLessThanOrEqual(SLICE_HINT * 3)
          expect(afterFirst).toBeLessThan(total)

          yield* pollWithTimeout(
            Effect.map(attributedCount(database.db), (count) => (count === total ? count : undefined)),
            "background drain never completed the bounded slices",
            "20 seconds",
          )
          const steadyStarted = Date.now()
          yield* credentials.list()
          console.log(`[lane-a] steady-state list() after catch-up: ${Date.now() - steadyStarted}ms`)
          expect(yield* backfillCursor(database.db, created.id)).toBe(messageId(total - 1))
        }),
      )
    })
  },
  30_000,
)

test(
  "durable cursor resumes after an abrupt service disposal; cursor always matches committed slices",
  async () => {
    await withDatabaseFile(async (file) => {
      const total = 1_500
      await runScoped(
        file,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const credentials = yield* ForkCredentials.Service
          const created = yield* credentials.add({ key: "sk-lane-a", label: "Lane A" })
          yield* seedProjectAndSession(database.db)
          yield* seedHistory(database.db, "ses_lane_a", total)

          yield* credentials.list()
          const partial = yield* attributedCount(database.db)
          const cursor = yield* backfillCursor(database.db, created.id)
          console.log(`[lane-a] before abrupt disposal: ${partial}/${total}, cursor=${cursor}`)
          expect(partial).toBeGreaterThanOrEqual(SLICE_HINT)
          expect(partial).toBeLessThan(total)
          expect(cursor).toBeDefined()
          expect(yield* countScannedByCursor(database.db, cursor!)).toBe(partial)
        }),
      )

      await runScoped(
        file,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const credentials = yield* ForkCredentials.Service
          const [created] = yield* credentials.list()
          expect(created).toBeDefined()
          const mapping = yield* credentials.credentialsForMessages([messageId(0)])
          expect(mapping.get(messageId(0))).toBe(created!.id)
          yield* pollWithTimeout(
            Effect.map(attributedCount(database.db), (count) => (count === total ? count : undefined)),
            "restarted service never completed the durable backlog",
            "20 seconds",
          )
          expect(yield* backfillCursor(database.db, created!.id)).toBe(messageId(total - 1))
          expect(yield* attributedCount(database.db, created!.id)).toBe(total)
        }),
      )
    })
  },
  30_000,
)

test(
  "multiple credentials never attribute; removing one re-arms the single-credential backfill",
  async () => {
    await withDatabaseFile(async (file) => {
      await runScoped(
        file,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const credentials = yield* ForkCredentials.Service
          const first = yield* credentials.add({ key: "sk-lane-a", label: "Lane A" })
          const second = yield* credentials.add({ key: "sk-lane-b", label: "Lane B" })
          yield* seedProjectAndSession(database.db)
          yield* seedHistory(database.db, "ses_lane_a", 100)

          yield* credentials.list()
          const mapping = yield* credentials.credentialsForMessages([messageId(0)])
          expect(mapping.size).toBe(0)
          expect(yield* attributedCount(database.db)).toBe(0)

          yield* credentials.remove(second.id)
          const reread = yield* credentials.credentialsForMessages([messageId(0)])
          expect(reread.get(messageId(0))).toBe(first.id)
          yield* pollWithTimeout(
            Effect.map(attributedCount(database.db), (count) => (count === 100 ? count : undefined)),
            "single-credential attribution never resumed after the second credential was removed",
            "20 seconds",
          )
          expect(yield* attributedCount(database.db, first.id)).toBe(100)
          expect(yield* attributedCount(database.db, second.id)).toBe(0)
          expect(yield* backfillStateRows(database.db)).toBe(1)
          expect(yield* backfillCursor(database.db, first.id)).toBe(messageId(99))
        }),
      )
    })
  },
  30_000,
)

test(
  "late messages are caught after completion and explicit attribution is never overwritten",
  async () => {
    await withDatabaseFile(async (file) => {
      await runScoped(
        file,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const credentials = yield* ForkCredentials.Service
          const created = yield* credentials.add({ key: "sk-lane-a", label: "Lane A" })
          yield* seedProjectAndSession(database.db)
          yield* seedHistory(database.db, "ses_lane_a", 50)

          yield* credentials.list()
          yield* pollWithTimeout(
            Effect.map(attributedCount(database.db), (count) => (count === 50 ? count : undefined)),
            "initial history never completed",
            "20 seconds",
          )
          expect(yield* backfillCursor(database.db, created.id)).toBe(messageId(49))

          yield* seedHistory(database.db, "ses_lane_a", 5, { startIndex: 50 })
          yield* database.db
            .run(
              sql`INSERT INTO fork_message_credential (message_id, credential_id, time_created)
                  VALUES (${messageId(53)}, ${created.id}, ${111})`,
            )
            .pipe(Effect.orDie)
          yield* credentials.recordUsage({ messageID: messageId(54), credentialID: created.id })

          const mapping = yield* credentials.credentialsForMessages([messageId(50)])
          expect(mapping.get(messageId(50))).toBe(created.id)
          yield* pollWithTimeout(
            Effect.map(attributedCount(database.db), (count) => (count === 55 ? count : undefined)),
            "late historical messages were never attributed after catch-up",
            "20 seconds",
          )
          const preserved = yield* database.db
            .get<{ count: number; time_created: number }>(
              sql`SELECT count(*) AS count, min(time_created) AS time_created FROM fork_message_credential WHERE message_id = ${messageId(53)}`,
            )
            .pipe(Effect.orDie)
          expect(preserved?.count).toBe(1)
          expect(preserved?.time_created).toBe(111)
          expect(yield* attributedCount(database.db, created.id)).toBe(55)
          expect(yield* backfillCursor(database.db, created.id)).toBe(messageId(54))

          // Out-of-order import shape: a lower id inserted after the cursor has
          // already passed that id space. Insertion-ordered rowid scanning must
          // still attribute it instead of skipping it forever.
          const outOfOrder = "msg_bf_0000"
          yield* database.db
            .run(
              sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
                  VALUES (${outOfOrder}, ${"ses_lane_a"}, ${CREATED_BASE}, ${CREATED_BASE}, ${JSON.stringify({
                    id: outOfOrder,
                    sessionID: "ses_lane_a",
                    role: "assistant",
                    providerID: "opencode-go",
                    cost: 1.25,
                    time: { created: CREATED_BASE },
                  })})`,
            )
            .pipe(Effect.orDie)
          const outMapping = yield* credentials.credentialsForMessages([outOfOrder])
          expect(outMapping.get(outOfOrder)).toBe(created.id)
          yield* pollWithTimeout(
            Effect.map(attributedCount(database.db), (count) => (count === 56 ? count : undefined)),
            "out-of-order late import was permanently skipped",
            "20 seconds",
          )
          expect(yield* attributedCount(database.db, created.id)).toBe(56)
          expect(yield* backfillCursor(database.db, created.id)).toBe(outOfOrder)
        }),
      )
    })
  },
  30_000,
)

test(
  "usage aggregation sees exact backfilled amounts and the local cache generation is invalidated",
  async () => {
    await withDatabaseFile(async (file) => {
      await runScoped(
        file,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const credentials = yield* ForkCredentials.Service
          const created = yield* credentials.add({ key: "sk-lane-a", label: "Lane A" })
          yield* seedProjectAndSession(database.db)
          const calls = 30
          const cost = 2.5
          yield* seedHistory(database.db, "ses_lane_a", calls, { cost })
          const bounds: WindowBounds[] = [
            {
              label: "5h",
              startMs: CREATED_BASE - 1_000,
              endMs: CREATED_BASE + calls + 1_000,
              limitUSD: 10,
              resetsAt: CREATED_BASE + 5 * 60 * 60 * 1000,
            },
          ]

          const before = yield* credentials.usageByCredential(bounds)
          expect(before.byCredential.size).toBe(0)
          expect(before.unattributed[0]?.spentUSD).toBeCloseTo(calls * cost, 5)
          expect(before.unattributed[0]?.callsInWindow).toBe(calls)

          const generationBefore = usageCacheGeneration()
          const lock = holdExternalWriter(file)
          yield* credentials.list()
          expect(usageCacheGeneration()).toBe(generationBefore)
          lock.release()

          yield* credentials.list()
          yield* pollWithTimeout(
            Effect.map(attributedCount(database.db), (count) => (count === calls ? count : undefined)),
            "backfill never completed for the aggregation check",
            "20 seconds",
          )
          expect(usageCacheGeneration()).toBeGreaterThan(generationBefore)
          const after = yield* credentials.usageByCredential(bounds)
          const bucket = after.byCredential.get(created.id)
          expect(bucket?.[0]?.spentUSD).toBeCloseTo(calls * cost, 5)
          expect(bucket?.[0]?.callsInWindow).toBe(calls)
          expect(after.unattributed.reduce((total, entry) => total + entry.spentUSD, 0)).toBe(0)
          expect(after.unattributed.reduce((total, entry) => total + entry.callsInWindow, 0)).toBe(0)
        }),
      )
    })
  },
  30_000,
)

test(
  "caller cancellation and concurrent triggers leave consistent durable state",
  async () => {
    await withDatabaseFile(async (file) => {
      await runScoped(
        file,
        Effect.gen(function* () {
          const database = yield* Database.Service
          const credentials = yield* ForkCredentials.Service
          const created = yield* credentials.add({ key: "sk-lane-a", label: "Lane A" })
          yield* seedProjectAndSession(database.db)
          const total = 600
          yield* seedHistory(database.db, "ses_lane_a", total)

          const lock = holdExternalWriter(file)
          const first = yield* Effect.forkChild(credentials.credentialsForMessages([messageId(0)]))
          // Let the forked caller enter the blocked slice before cancelling it.
          yield* Effect.sleep("30 millis")
          yield* Fiber.interrupt(first)
          const listed = yield* credentials.list()
          expect(listed.map((item) => item.id)).toEqual([created.id])
          expect(yield* attributedCount(database.db)).toBe(0)
          expect(yield* backfillStateRows(database.db)).toBe(0)
          lock.release()

          const results = yield* Effect.all(
            [0, 1, 2, 3].map((offset) => credentials.credentialsForMessages([messageId(offset)])),
            { concurrency: "unbounded" },
          )
          console.log(
            `[lane-a] concurrent maps=${results.map((map) => map.size).join(",")} cursor=${(yield* backfillCursor(database.db, created.id)) ?? "none"}`,
          )
          expect(results.every((map, offset) => map.get(messageId(offset)) === created.id)).toBe(true)
          yield* pollWithTimeout(
            Effect.map(attributedCount(database.db), (count) => (count === total ? count : undefined)),
            "concurrent triggers never completed attribution",
            "20 seconds",
          )
          expect(yield* attributedCount(database.db, created.id)).toBe(total)
          expect(yield* backfillCursor(database.db, created.id)).toBe(messageId(total - 1))
        }),
      )
    })
  },
  30_000,
)
