export * as ForkCredentials from "./credentials"

import { sql } from "drizzle-orm"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { retrySqliteBusyCause } from "@opencode-ai/core/database/sqlite-busy"
import { make as makeCoalescedDrain } from "@/effect/coalesced-drain"
import { Auth } from "@/auth"
import { bumpUsageCache, GO_PROVIDER_ID, type UsageBucket, type WindowBounds } from "./usage-cache"

/**
 * Fork-owned, self-contained multi-key credential store for the OpenCode
 * (Zen/Go) provider, deliberately decoupled from the upstream Credential/
 * Integration V2 system (which isn't the live auth path for the legacy
 * runtime this desktop app actually runs). Tables live in the same SQLite
 * file as the shared schema (for cheap joins against `message`), bootstrapped
 * with our own `CREATE TABLE IF NOT EXISTS` rather than through the shared
 * Drizzle migration system, so it can't collide with upstream migrations.
 */

const PROVIDER_ID = "opencode"

// Bounded slice size for the durable single-credential attribution backfill.
export const SINGLE_CREDENTIAL_BACKFILL_SLICE = 400
const BACKFILL_SLICE_PAUSE = "12 millis"

type BackfillOutcome = "advanced" | "caught-up" | "ineligible" | "retry"

export interface Info {
  readonly id: string
  readonly label: string
  readonly key: string
  readonly active: boolean
  readonly timeCreated: number
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly active: () => Effect.Effect<Info | undefined>
  readonly add: (input: { readonly key: string; readonly label?: string }) => Effect.Effect<Info>
  readonly select: (id: string) => Effect.Effect<void>
  readonly rename: (id: string, label: string) => Effect.Effect<void>
  readonly remove: (id: string) => Effect.Effect<void>
  /** Records which credential produced a given assistant message, for per-key usage attribution. */
  readonly recordUsage: (input: { readonly messageID: string; readonly credentialID: string }) => Effect.Effect<void>
  /** Batch-resolves message -> credential mappings for a set of message IDs. */
  readonly credentialsForMessages: (messageIDs: readonly string[]) => Effect.Effect<Map<string, string>>
  /**
   * Per-credential local spend/calls for the given windows, computed in ONE
   * grouped SQL statement (LEFT JOIN to fork_message_credential) instead of the
   * old chunked IN-attribution path. Returns a map keyed by credential ID plus
   * the unattributed bucket (rows with no fork_message_credential row).
   */
  readonly usageByCredential: (bounds: readonly WindowBounds[]) => Effect.Effect<{
    readonly byCredential: ReadonlyMap<string, readonly UsageBucket[]>
    readonly unattributed: readonly UsageBucket[]
  }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/fork/Credentials") {}

type Row = { id: string; label: string; key: string; active: number; time_created: number }

const toInfo = (row: Row): Info => ({
  id: row.id,
  label: row.label,
  key: row.key,
  active: row.active === 1,
  timeCreated: row.time_created,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb, scanDb } = yield* Database.Service
    const auth = yield* Auth.Service
    const serviceScope = yield* Scope.Scope

    yield* db
      .run(
        sql`
      CREATE TABLE IF NOT EXISTS fork_credential (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        key TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        time_created INTEGER NOT NULL
      )
    `,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`
      CREATE TABLE IF NOT EXISTS fork_message_credential (
        message_id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        time_created INTEGER NOT NULL
      )
    `,
      )
      .pipe(Effect.orDie)
    // Fork-owned, self-bootstrapped state, same policy as the two tables above
    // (no generated migration/schema edits). One idempotent DDL statement per
    // layer build, not per UI call.
    yield* db
      .run(
        sql`
      CREATE TABLE IF NOT EXISTS fork_credential_backfill (
        credential_id TEXT PRIMARY KEY,
        cursor_rowid INTEGER NOT NULL DEFAULT 0,
        cursor_id TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      )
    `,
      )
      .pipe(Effect.orDie)

    // Lazy auth.json migration. The process-local "checked" flag is set only
    // after a successful decision (store already has a credential, no legacy
    // key, or the key was imported) and never on a failed/locked attempt, so an
    // error is retried by the next caller instead of permanently skipping the
    // import. Like the previous behavior, a successful no-op is final for this
    // process: keys added to auth.json later are not re-imported; the fork store
    // is the live path for new keys.
    let migrationChecked = false
    let migrationInFlight: Deferred.Deferred<void> | undefined

    const performMigration = Effect.fnUntraced(function* () {
      const existingCount = yield* db
        .get<{ count: number }>(sql`SELECT count(*) as count FROM fork_credential`)
        .pipe(Effect.orDie)
      if ((existingCount?.count ?? 0) > 0) {
        migrationChecked = true
        return
      }
      const legacy = yield* auth.get(PROVIDER_ID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (legacy?.type !== "api") {
        migrationChecked = true
        return
      }
      yield* db
        .run(
          sql`INSERT INTO fork_credential (id, label, key, active, time_created) VALUES (${crypto.randomUUID()}, ${"Migrated key"}, ${legacy.key}, 1, ${Date.now()})`,
        )
        .pipe(Effect.orDie)
      migrationChecked = true
    })

    const ensureMigrated = Effect.fn("ForkCredentials.ensureMigrated")(function* () {
      if (migrationChecked) return
      const running = migrationInFlight
      if (running) return yield* Deferred.await(running)
      const flight = yield* Deferred.make<void>()
      migrationInFlight = flight
      yield* performMigration().pipe(
        Effect.onExit((exit) => {
          if (migrationInFlight === flight) migrationInFlight = undefined
          return Deferred.done(flight, exit).pipe(Effect.asVoid)
        }),
        Effect.forkIn(serviceScope, { startImmediately: true }),
      )
      return yield* Deferred.await(flight)
    })

    // Durable incremental attribution for the single-credential store. Slices
    // are keyset pages of the message table's insertion-ordered rowid (the id
    // of the last scanned row is stored as a renumber witness), so late
    // imported/out-of-order ids below the persisted cursor are still covered.
    // Every slice commits its cursor in the SAME transaction; an interrupted or
    // failed slice re-runs from the last committed cursor. No process-local
    // flag can mark unattributed history as done.
    let chunkInFlight: { deferred: Deferred.Deferred<BackfillOutcome> } | undefined

    const performBackfillChunk = Effect.fnUntraced(function* () {
      const now = Date.now()
      // Retrying the whole transaction is convergent, not ambiguous: every write
      // is keyed-idempotent (INSERT OR IGNORE, conditional cursor advance), a
      // failed COMMIT leaves the transaction uncommitted and Drizzle rolls it
      // back, and a replay re-reads the durable cursor before writing.
      const outcome = yield* retrySqliteBusyCause(
        () =>
          db.transaction(
            (tx) =>
              Effect.gen(function* () {
                const candidates = yield* tx.all<{ id: string }>(
                  sql`SELECT id FROM fork_credential ORDER BY time_created ASC`,
                )
                if (candidates.length !== 1) return { kind: "ineligible" as const, inserted: 0 }
                const credentialID = candidates[0]!.id
                const state = yield* tx.get<{ cursor_rowid: number; cursor_id: string }>(
                  sql`SELECT cursor_rowid, cursor_id FROM fork_credential_backfill WHERE credential_id = ${credentialID}`,
                )
                const storedRowid = Number(state?.cursor_rowid ?? 0)
                let start = storedRowid
                let recovered = false
                if (storedRowid > 0) {
                  const witness = yield* tx.get<{ id: string }>(
                    sql`SELECT id FROM message WHERE rowid = ${storedRowid}`,
                  )
                  if (witness === undefined) {
                    // The last scanned row was deleted (session history removal):
                    // resume at the last surviving row below it. Rows at/above the
                    // witness were not scanned and stay covered.
                    const below = yield* tx.get<{ rowid: number | null }>(
                      sql`SELECT max(rowid) AS rowid FROM message WHERE rowid < ${storedRowid}`,
                    )
                    start = Number(below?.rowid ?? 0)
                    recovered = true
                  } else if (witness.id !== (state?.cursor_id ?? "")) {
                    // rowids were renumbered by an offline VACUUM/rebuild: restart
                    // the bounded scan instead of trusting the stale cursor.
                    start = 0
                    recovered = true
                    yield* tx.run(
                      sql`UPDATE fork_credential_backfill SET cursor_rowid = 0, cursor_id = '', updated_at = ${now} WHERE credential_id = ${credentialID}`,
                    )
                  }
                }
                const batch = yield* tx.all<{ id: string; rid: number }>(
                  sql`SELECT id, rowid AS rid FROM message WHERE rowid > ${start} ORDER BY rowid LIMIT ${SINGLE_CREDENTIAL_BACKFILL_SLICE}`,
                )
                if (batch.length === 0) return { kind: "caught-up" as const, inserted: 0 }
                const last = batch[batch.length - 1]!
                yield* tx.run(sql`
                  INSERT OR IGNORE INTO fork_message_credential (message_id, credential_id, time_created)
                  SELECT
                    message.id,
                    ${credentialID},
                    COALESCE(json_extract(message.data, '$.time.created'), ${now})
                  FROM message
                  WHERE message.rowid > ${start}
                    AND message.rowid <= ${last.rid}
                    AND json_extract(message.data, '$.providerID') = ${GO_PROVIDER_ID}
                    AND json_extract(message.data, '$.role') = 'assistant'
                `)
                const inserted = yield* tx.get<{ changes: number }>(sql`SELECT changes() AS changes`)
                if (recovered) {
                  yield* tx.run(
                    sql`UPDATE fork_credential_backfill SET cursor_rowid = ${last.rid}, cursor_id = ${last.id}, updated_at = ${now} WHERE credential_id = ${credentialID}`,
                  )
                } else {
                  yield* tx.run(
                    sql`UPDATE fork_credential_backfill SET cursor_rowid = ${last.rid}, cursor_id = ${last.id}, updated_at = ${now} WHERE credential_id = ${credentialID} AND cursor_rowid < ${last.rid}`,
                  )
                  const advanced = yield* tx.get<{ changes: number }>(sql`SELECT changes() AS changes`)
                  if ((advanced?.changes ?? 0) === 0) {
                    yield* tx.run(
                      sql`INSERT OR IGNORE INTO fork_credential_backfill (credential_id, cursor_rowid, cursor_id, updated_at) VALUES (${credentialID}, ${last.rid}, ${last.id}, ${now})`,
                    )
                  }
                }
                return {
                  kind: batch.length === SINGLE_CREDENTIAL_BACKFILL_SLICE ? ("advanced" as const) : ("caught-up" as const),
                  inserted: inserted?.changes ?? 0,
                }
              }),
            { behavior: "immediate" },
          ),
        { maxElapsedMs: 250, delayMs: 20, maxDelayMs: 75 },
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("ForkCredentials backfill slice failed", { cause })
            return { kind: "retry" as const, inserted: 0 }
          }),
        ),
      )
      if (outcome.inserted > 0) bumpUsageCache()
      return outcome.kind
    })

    const claimBackfillChunk = Effect.fnUntraced(function* () {
      const running = chunkInFlight
      if (running) return yield* Deferred.await(running.deferred)
      const flight = { deferred: yield* Deferred.make<BackfillOutcome>() }
      chunkInFlight = flight
      yield* performBackfillChunk().pipe(
        Effect.onExit((exit) => {
          if (chunkInFlight === flight) chunkInFlight = undefined
          return Deferred.done(flight.deferred, Exit.succeed(Exit.isSuccess(exit) ? exit.value : "retry")).pipe(Effect.asVoid)
        }),
        Effect.forkIn(serviceScope, { startImmediately: true }),
      )
      return yield* Deferred.await(flight.deferred)
    })

    let wakeBackfillDrain: (() => Effect.Effect<void>) | undefined
    const backfillDrain = yield* makeCoalescedDrain({
      name: "ForkCredentials.singleCredentialBackfill",
      drain: Effect.suspend(() =>
        Effect.gen(function* () {
          const outcome = yield* claimBackfillChunk()
          if (outcome !== "advanced") return
          yield* Effect.sleep(BACKFILL_SLICE_PAUSE)
          if (wakeBackfillDrain) yield* wakeBackfillDrain()
        }),
      ),
    })
    wakeBackfillDrain = backfillDrain.wake

    const backfillHasWork = Effect.fnUntraced(function* () {
      const candidates = yield* readDb
        .all<{ id: string }>(sql`SELECT id FROM fork_credential ORDER BY time_created ASC`)
        .pipe(Effect.orDie)
      if (candidates.length !== 1) return false
      const state = yield* readDb
        .get<{ cursor_rowid: number; cursor_id: string }>(
          sql`SELECT cursor_rowid, cursor_id FROM fork_credential_backfill WHERE credential_id = ${candidates[0]!.id}`,
        )
        .pipe(Effect.orDie)
      const storedRowid = Number(state?.cursor_rowid ?? 0)
      if (storedRowid > 0) {
        const witness = yield* readDb
          .get<{ id: string }>(sql`SELECT id FROM message WHERE rowid = ${storedRowid}`)
          .pipe(Effect.orDie)
        if (!witness || witness.id !== (state?.cursor_id ?? "")) return true
      }
      const next = yield* readDb
        .get<{ rowid: number }>(sql`SELECT rowid FROM message WHERE rowid > ${storedRowid} LIMIT 1`)
        .pipe(Effect.orDie)
      return next !== undefined
    })

    const ensureSingleCredentialBackfill = Effect.fnUntraced(function* () {
      // Bounded foreground cost: indexed read-side checks (cursor witness plus
      // next-row existence) and, only while work remains, at most ONE committed
      // slice of SINGLE_CREDENTIAL_BACKFILL_SLICE messages under a 250ms
      // busy-retry budget. The coalesced drain finishes the backlog in the
      // background; a caught-up store performs no writer work at all.
      if (!(yield* backfillHasWork())) return
      const outcome = yield* claimBackfillChunk()
      if (outcome === "advanced") yield* backfillDrain.wake()
    })

    const list = Effect.fn("ForkCredentials.list")(function* () {
      yield* ensureMigrated()
      yield* ensureSingleCredentialBackfill()
      return (
        yield* readDb.all<Row>(sql`SELECT * FROM fork_credential ORDER BY time_created ASC`).pipe(Effect.orDie)
      ).map(toInfo)
    })

    const active = Effect.fn("ForkCredentials.active")(function* () {
      yield* ensureMigrated()
      yield* ensureSingleCredentialBackfill()
      const row = yield* readDb.get<Row>(sql`SELECT * FROM fork_credential WHERE active = 1 LIMIT 1`).pipe(Effect.orDie)
      if (row) return toInfo(row)
      const newest = yield* readDb
        .get<Row>(sql`SELECT * FROM fork_credential ORDER BY time_created DESC LIMIT 1`)
        .pipe(Effect.orDie)
      return newest ? toInfo(newest) : undefined
    })

    const add = Effect.fn("ForkCredentials.add")(function* (input: { key: string; label?: string }) {
      const existing = yield* db
        .get<{ count: number }>(sql`SELECT count(*) as count FROM fork_credential`)
        .pipe(Effect.orDie)
      const id = crypto.randomUUID()
      const timeCreated = Date.now()
      const label = input.label?.trim() || "default"
      yield* db
        .run(
          sql`INSERT INTO fork_credential (id, label, key, active, time_created) VALUES (${id}, ${label}, ${input.key}, ${(existing?.count ?? 0) === 0 ? 1 : 0}, ${timeCreated})`,
        )
        .pipe(Effect.orDie)
      return { id, label, key: input.key, active: (existing?.count ?? 0) === 0, timeCreated }
    })

    const select = Effect.fn("ForkCredentials.select")(function* (id: string) {
      yield* db.run(sql`UPDATE fork_credential SET active = 0`).pipe(Effect.orDie)
      yield* db.run(sql`UPDATE fork_credential SET active = 1 WHERE id = ${id}`).pipe(Effect.orDie)
    })

    const rename = Effect.fn("ForkCredentials.rename")(function* (id: string, label: string) {
      yield* db.run(sql`UPDATE fork_credential SET label = ${label} WHERE id = ${id}`).pipe(Effect.orDie)
    })

    const remove = Effect.fn("ForkCredentials.remove")(function* (id: string) {
      const wasActive = yield* db
        .get<Row>(sql`SELECT * FROM fork_credential WHERE id = ${id} AND active = 1`)
        .pipe(Effect.orDie)
      yield* db.run(sql`DELETE FROM fork_credential WHERE id = ${id}`).pipe(Effect.orDie)
      yield* db.run(sql`DELETE FROM fork_credential_backfill WHERE credential_id = ${id}`).pipe(Effect.orDie)
      if (!wasActive) return
      const newest = yield* db
        .get<Row>(sql`SELECT * FROM fork_credential ORDER BY time_created DESC LIMIT 1`)
        .pipe(Effect.orDie)
      if (newest) yield* db.run(sql`UPDATE fork_credential SET active = 1 WHERE id = ${newest.id}`).pipe(Effect.orDie)
    })

    const recordUsage = Effect.fn("ForkCredentials.recordUsage")(function* (input: {
      messageID: string
      credentialID: string
    }) {
      yield* db
        .run(
          sql`INSERT OR REPLACE INTO fork_message_credential (message_id, credential_id, time_created) VALUES (${input.messageID}, ${input.credentialID}, ${Date.now()})`,
        )
        .pipe(Effect.orDie)
      // Local usage changed: invalidate the L2 aggregation cache so the next
      // /fork/usage recomputes fresh local numbers (no remote call involved).
      bumpUsageCache()
    })

    const credentialsForMessages = Effect.fn("ForkCredentials.credentialsForMessages")(function* (
      messageIDs: readonly string[],
    ) {
      const map = new Map<string, string>()
      yield* ensureMigrated()
      yield* ensureSingleCredentialBackfill()
      if (messageIDs.length === 0) return map
      // SQLite caps bound variables per statement, so the IN clause must be
      // chunked for large histories (the prod DB can have tens of thousands of
      // attributed opencode-go messages).
      for (let i = 0; i < messageIDs.length; i += 500) {
        const placeholders = sql.join(
          messageIDs.slice(i, i + 500).map((id) => sql`${id}`),
          sql`, `,
        )
         const rows = yield* readDb
           .all<{ message_id: string; credential_id: string }>(
            sql`SELECT message_id, credential_id FROM fork_message_credential WHERE message_id IN (${placeholders})`,
          )
          .pipe(Effect.orDie)
        for (const row of rows) map.set(row.message_id, row.credential_id)
      }
      return map
    })

    const usageByCredential = Effect.fn("ForkCredentials.usageByCredential")(function* (bounds: readonly WindowBounds[]) {
      if (bounds.length === 0) return { byCredential: new Map<string, readonly UsageBucket[]>(), unattributed: [] }
      const earliestStart = Math.min(...bounds.map((b) => b.startMs))
      // Full-history JSON aggregation belongs to the analytical WAL reader.
      // It must never reserve the foreground writer's connection permit.
      const analytics = yield* scanDb()
      // ONE grouped statement: per-window SUM/COUNT/MIN/MAX via CASE columns,
      // LEFT JOINing fork_message_credential so attribution costs no chunked
      // IN queries. The NULL bucket (rows without an attribution row) is
      // returned as `unattributed` and still counts toward the aggregate.
      const time = sql`json_extract(message.data,'$.time.created')`
      const cost = sql`json_extract(message.data,'$.cost')`
      const windowColumns = bounds.flatMap((bound, index) => [
        sql`SUM(CASE WHEN ${time} >= ${bound.startMs} AND ${time} < ${bound.endMs} THEN ${cost} ELSE 0 END) AS ${sql.raw(`w${index}_spent`)}`,
        sql`COUNT(CASE WHEN ${time} >= ${bound.startMs} AND ${time} < ${bound.endMs} THEN 1 END) AS ${sql.raw(`w${index}_calls`)}`,
        sql`MIN(CASE WHEN ${time} >= ${bound.startMs} AND ${time} < ${bound.endMs} THEN ${time} END) AS ${sql.raw(`w${index}_min`)}`,
        sql`MAX(CASE WHEN ${time} >= ${bound.startMs} AND ${time} < ${bound.endMs} THEN ${time} END) AS ${sql.raw(`w${index}_max`)}`,
      ])
      const rows = yield* analytics
        .all<{
          credential_id: string | null
          [key: string]: unknown
        }>(
          sql`
            SELECT
              fork_message_credential.credential_id AS credential_id,
              ${sql.join(windowColumns, sql`, `)}
            FROM message
            LEFT JOIN fork_message_credential ON fork_message_credential.message_id = message.id
            WHERE json_extract(message.data,'$.providerID') = ${GO_PROVIDER_ID}
              AND json_extract(message.data,'$.role') = 'assistant'
              AND json_extract(message.data,'$.time.created') >= ${earliestStart}
            GROUP BY fork_message_credential.credential_id
          `,
        )
        .pipe(Effect.orDie)

      const byCredential = new Map<string, readonly UsageBucket[]>()
      const unattributed: UsageBucket[] = []
      for (const row of rows) {
        const buckets = bounds.map((_, index) => {
          const minRaw = row[`w${index}_min`]
          const maxRaw = row[`w${index}_max`]
          return {
            spentUSD: Number(row[`w${index}_spent`]) || 0,
            callsInWindow: Number(row[`w${index}_calls`]) || 0,
            minCreatedMs: minRaw === null || minRaw === undefined ? null : Number(minRaw),
            maxCreatedMs: maxRaw === null || maxRaw === undefined ? null : Number(maxRaw),
          } satisfies UsageBucket
        })
        if (row.credential_id === null) unattributed.push(...buckets)
        else byCredential.set(row.credential_id, buckets)
      }
      return { byCredential, unattributed }
    })

    return Service.of({
      list,
      active,
      add,
      select,
      rename,
      remove,
      recordUsage,
      credentialsForMessages,
      usageByCredential,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, Auth.node] })
