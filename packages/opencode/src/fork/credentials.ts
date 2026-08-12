export * as ForkCredentials from "./credentials"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
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
    const { db } = yield* Database.Service
    const auth = yield* Auth.Service

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

    let migrationChecked = false
    let singleCredentialUsageBackfillChecked = false
    // One-time, lazy migration: if the store is empty but auth.json has an
    // existing "opencode" key, bring it in so the user doesn't lose their
    // connection. Deferred until first real use (rather than run eagerly at
    // layer construction) so tests that pull in this service transitively
    // (e.g. via Provider.node) don't all need a working Auth.Service mock.
    const ensureMigrated = Effect.fn("ForkCredentials.ensureMigrated")(function* () {
      if (migrationChecked) return
      migrationChecked = true
      const existingCount = yield* db
        .get<{ count: number }>(sql`SELECT count(*) as count FROM fork_credential`)
        .pipe(Effect.orDie)
      if ((existingCount?.count ?? 0) > 0) return
      const legacy = yield* auth.get(PROVIDER_ID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (legacy?.type !== "api") return
      yield* db
        .run(
          sql`INSERT INTO fork_credential (id, label, key, active, time_created) VALUES (${crypto.randomUUID()}, ${"Migrated key"}, ${legacy.key}, 1, ${Date.now()})`,
        )
        .pipe(Effect.orDie)
    })

    const backfillSingleCredentialUsage = Effect.fn("ForkCredentials.backfillSingleCredentialUsage")(function* () {
      if (singleCredentialUsageBackfillChecked) return
      singleCredentialUsageBackfillChecked = true
      const rows = yield* db
        .all<{ id: string }>(sql`SELECT id FROM fork_credential ORDER BY time_created ASC`)
        .pipe(Effect.orDie)
      if (rows.length !== 1) return
      yield* db
        .run(
          sql`
            INSERT OR IGNORE INTO fork_message_credential (message_id, credential_id, time_created)
            SELECT
              message.id,
              ${rows[0].id},
              COALESCE(json_extract(message.data, '$.time.created'), ${Date.now()})
            FROM message
            WHERE json_extract(message.data, '$.providerID') = 'opencode-go'
              AND json_extract(message.data, '$.role') = 'assistant'
              AND NOT EXISTS (
                SELECT 1 FROM fork_message_credential
                WHERE fork_message_credential.message_id = message.id
              )
          `,
        )
        .pipe(Effect.orDie)
    })

    const list = Effect.fn("ForkCredentials.list")(function* () {
      yield* ensureMigrated()
      yield* backfillSingleCredentialUsage()
      return (
        yield* db.all<Row>(sql`SELECT * FROM fork_credential ORDER BY time_created ASC`).pipe(Effect.orDie)
      ).map(toInfo)
    })

    const active = Effect.fn("ForkCredentials.active")(function* () {
      yield* ensureMigrated()
      yield* backfillSingleCredentialUsage()
      const row = yield* db.get<Row>(sql`SELECT * FROM fork_credential WHERE active = 1 LIMIT 1`).pipe(Effect.orDie)
      if (row) return toInfo(row)
      const newest = yield* db
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
      yield* backfillSingleCredentialUsage()
      if (messageIDs.length === 0) return map
      // SQLite caps bound variables per statement, so the IN clause must be
      // chunked for large histories (the prod DB can have tens of thousands of
      // attributed opencode-go messages).
      for (let i = 0; i < messageIDs.length; i += 500) {
        const placeholders = sql.join(
          messageIDs.slice(i, i + 500).map((id) => sql`${id}`),
          sql`, `,
        )
        const rows = yield* db
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
      const rows = yield* db
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
