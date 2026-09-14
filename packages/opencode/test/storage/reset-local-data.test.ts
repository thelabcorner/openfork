import { afterAll, describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { tmpdir } from "../fixture/fixture"
import {
  PRESERVED_TABLES,
  RESET_TABLES_IN_ORDER,
  SESSION_EVENT_TABLES,
  resetLocalData,
} from "@/storage/reset-local-data"

const tmp = await tmpdir()
const dbPath = path.join(tmp.path, "reset-local-data.db")
const layer = Database.layerFromPath(dbPath)

afterAll(async () => {
  await tmp[Symbol.asyncDispose]()
})

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(`CREATE TABLE IF NOT EXISTS fork_credential (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, key TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0, time_created INTEGER NOT NULL
  )`)
  yield* db.run(`CREATE TABLE IF NOT EXISTS fork_message_credential (
    message_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, time_created INTEGER NOT NULL
  )`)
  yield* db.run(`CREATE TABLE IF NOT EXISTS ocdb_seal (
    table_name TEXT NOT NULL, row_id TEXT NOT NULL, column_name TEXT NOT NULL,
    raw_bytes INTEGER NOT NULL, stored_bytes INTEGER NOT NULL, codec INTEGER NOT NULL,
    frame_version INTEGER NOT NULL, time_sealed INTEGER NOT NULL, reseal_needed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (table_name, row_id, column_name)
  )`)
  yield* db.run(`CREATE TABLE IF NOT EXISTS ocdb_meta (key TEXT PRIMARY KEY, value TEXT)`)

  yield* db.run(
    `INSERT INTO credential (id, label, value, time_created, time_updated) VALUES ('credential_keep', 'keep', '{}', 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES ('account_keep', 'keep@example.test', 'https://example.test', 'access', 'refresh', 1, 1)`,
  )
  yield* db.run(`INSERT INTO account_state (id, active_account_id) VALUES (1, 'account_keep')`)
  yield* db.run(
    `INSERT INTO device (id, name, token_hash, token_prefix, created_at) VALUES ('device_keep', 'keep', 'hash_keep', 'prefix', 1)`,
  )
  yield* db.run(
    `INSERT INTO fork_credential (id, label, key, active, time_created) VALUES ('fork_keep', 'keep', 'secret', 1, 1)`,
  )
  yield* db.run(`INSERT INTO data_migration (name, time_completed) VALUES ('migration_keep', 1)`)
  yield* db.run(`INSERT OR REPLACE INTO ocdb_meta (key, value) VALUES ('framing_epoch', '2'), ('semantic_epoch', '2')`)
  yield* db.run(`INSERT OR REPLACE INTO ocdb_meta (key, value) VALUES ('semantic_index_backfill_cursor_v2', '999')`)

  yield* db.run(
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project_reset', '/tmp/reset', 1, 1, '[]')`,
  )
  yield* db.run(
    `INSERT INTO project_directory (project_id, directory, type, strategy, time_created) VALUES ('project_reset', '/tmp/reset', 'main', 'git', 1)`,
  )
  yield* db.run(
    `INSERT INTO workspace (id, type, name, directory, project_id, time_used) VALUES ('workspace_keep', 'local', 'Keep me', '/tmp/reset', 'project_reset', 1)`,
  )
  yield* db.run(
    `INSERT INTO permission (id, project_id, action, resource, time_created, time_updated) VALUES ('permission_keep', 'project_reset', 'read', '/tmp/reset', 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session_reset', 'project_reset', 'reset', '/tmp/reset', 'Reset me', '1', 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data, search_text) VALUES ('message_reset', 'session_reset', 'user', 1, 1, 1, '{}', 'old history')`,
  )
  yield* db.run(`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session_reset', 1)`)
  yield* db.run(
    `INSERT INTO event_payload_meta (payload_id, chunk_count, refs, time_touched) VALUES ('payload_reset', 1, 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO event_payload_chunk (payload_id, chunk_index, text, time_created) VALUES ('payload_reset', 0, '{"reset":true}', 1)`,
  )
  yield* db.run(
    `INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('event_reset', 'session_reset', 1, 'session.updated.1', '{"$eventPayload":{"id":"payload_reset","count":1}}')`,
  )
  yield* db.run(
    `INSERT INTO event_value (aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)
     VALUES ('session_reset', 'value_reset', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 2, X'7B7D', 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO memory_topic (id, scope, key, title, description, time_created, time_updated) VALUES ('topic_reset', 'global', 'old', 'old', 'old', 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO memory_entry (id, topic_id, scope, kind, origin, title, content, search_text, status, valid_from, content_hash, time_created, time_updated, use_count) VALUES ('memory_reset', 'topic_reset', 'global', 'fact', 'session', 'old', 'old', 'old', 'active', 1, 'hash', 1, 1, 0)`,
  )
  yield* db.run(
    `INSERT INTO maintenance_usage (agent, provider_id, model_id, time_started, time_completed) VALUES ('title', 'provider', 'model', 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO fork_message_credential (message_id, credential_id, time_created) VALUES ('message_reset', 'fork_keep', 1)`,
  )
  yield* db.run(
    `INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed) VALUES ('event', 'event_reset', 'data', 10, 5, 1, 1, 1)`,
  )

  // Non-session durable aggregates are not used by today's production event
  // manifest, but the event store is generic. Seed one to prove a future
  // durable aggregate cannot be destroyed by this session-history reset.
  yield* db.run(`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('account_stream_keep', 0)`)
  yield* db.run(
    `INSERT INTO event_payload_meta (payload_id, chunk_count, refs, time_touched) VALUES ('payload_keep', 1, 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO event_payload_chunk (payload_id, chunk_index, text, time_created) VALUES ('payload_keep', 0, '{"keep":true}', 1)`,
  )
  yield* db.run(
    `INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('event_keep', 'account_stream_keep', 0, 'future.account.updated.1', '{"$eventPayload":{"id":"payload_keep","count":1}}')`,
  )
  yield* db.run(
    `INSERT INTO event_value (aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)
     VALUES ('account_stream_keep', 'value_keep', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 2, X'7B7D', 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO event_compaction (aggregate_id, bitmap, compacted_count, time_updated)
     VALUES ('account_stream_keep', X'01', 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed) VALUES ('event', 'event_keep', 'data', 10, 5, 1, 1, 1)`,
  )
  yield* db.run(
    `INSERT INTO ocdb_seal (table_name, row_id, column_name, raw_bytes, stored_bytes, codec, frame_version, time_sealed) VALUES ('event', 'event_already_orphaned', 'data', 10, 5, 1, 1, 1)`,
  )

  // Also model an orphaned session aggregate whose projection row is already
  // gone. Factory reset should still remove its durable history.
  yield* db.run(`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_orphan_reset', 0)`)
  yield* db.run(
    `INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('event_orphan_reset', 'ses_orphan_reset', 0, 'session.updated.1', '{}')`,
  )
})

await Effect.runPromise(setup.pipe(Effect.provide(layer)))

describe("resetLocalData", () => {
  test("removes history while preserving credentials, devices, migrations, and storage epochs", async () => {
    // Prime the process-local rehydration cache. A true wipe must invalidate it
    // as well as delete the backing event_value row.
    expect(
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* EventV2.resolveCdbRef(db, "session_reset", "value_reset")
        }).pipe(Effect.provide(layer)),
      ),
    ).toEqual({})

    const result = await Effect.runPromise(resetLocalData().pipe(Effect.provide(layer)))
    expect(result.sessionsDeleted).toBe(1)
    expect(result.memoriesDeleted).toBe(1)
    expect(result.compacted).toBe(true)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const existing = new Set(
          (yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name),
        )
        for (const table of RESET_TABLES_IN_ORDER) {
          if (!existing.has(table)) continue
          expect(yield* db.get<{ count: number }>(`SELECT count(*) AS count FROM "${table}"`)).toEqual({ count: 0 })
        }

        expect(yield* db.get(`SELECT id FROM event WHERE id = 'event_reset'`)).toBeUndefined()
        expect(yield* db.get(`SELECT payload_id FROM event_payload_meta WHERE payload_id = 'payload_reset'`)).toBeUndefined()
        expect(yield* db.get(`SELECT payload_id FROM event_payload_chunk WHERE payload_id = 'payload_reset'`)).toBeUndefined()
        expect(yield* db.get(`SELECT id FROM event WHERE id = 'event_orphan_reset'`)).toBeUndefined()
        expect(yield* db.get(`SELECT aggregate_id FROM event_sequence WHERE aggregate_id = 'ses_orphan_reset'`)).toBeUndefined()
        expect(yield* db.get(`SELECT id FROM event WHERE id = 'event_keep'`)).toEqual({ id: "event_keep" })
        expect(yield* db.get(`SELECT refs FROM event_payload_meta WHERE payload_id = 'payload_keep'`)).toEqual({ refs: 1 })
        expect(yield* db.get(`SELECT payload_id FROM event_payload_chunk WHERE payload_id = 'payload_keep'`)).toEqual({
          payload_id: "payload_keep",
        })
        expect(
          yield* db.get(`SELECT value_id FROM event_value WHERE aggregate_id = 'account_stream_keep' AND value_id = 'value_keep'`),
        ).toEqual({ value_id: "value_keep" })
        expect(
          yield* db.get(`SELECT compacted_count FROM event_compaction WHERE aggregate_id = 'account_stream_keep'`),
        ).toEqual({ compacted_count: 1 })
        expect(
          yield* db.get(`SELECT aggregate_id FROM event_sequence WHERE aggregate_id = 'account_stream_keep'`),
        ).toEqual({ aggregate_id: "account_stream_keep" })
        expect(yield* db.get(`SELECT row_id FROM ocdb_seal WHERE row_id = 'event_keep'`)).toEqual({ row_id: "event_keep" })
        expect(yield* db.get(`SELECT row_id FROM ocdb_seal WHERE row_id = 'event_reset'`)).toBeUndefined()
        expect(yield* db.get(`SELECT row_id FROM ocdb_seal WHERE row_id = 'event_already_orphaned'`)).toBeUndefined()

        expect(yield* db.get(`SELECT id FROM credential WHERE id = 'credential_keep'`)).toEqual({ id: "credential_keep" })
        expect(yield* db.get(`SELECT id FROM account WHERE id = 'account_keep'`)).toEqual({ id: "account_keep" })
        expect(yield* db.get(`SELECT active_account_id FROM account_state WHERE id = 1`)).toEqual({
          active_account_id: "account_keep",
        })
        expect(yield* db.get(`SELECT id FROM device WHERE id = 'device_keep'`)).toEqual({ id: "device_keep" })
        expect(yield* db.get(`SELECT id FROM fork_credential WHERE id = 'fork_keep'`)).toEqual({ id: "fork_keep" })
        expect(yield* db.get(`SELECT id FROM project WHERE id = 'project_reset'`)).toEqual({ id: "project_reset" })
        expect(yield* db.get(`SELECT project_id FROM project_directory WHERE directory = '/tmp/reset'`)).toEqual({
          project_id: "project_reset",
        })
        expect(yield* db.get(`SELECT id FROM workspace WHERE id = 'workspace_keep'`)).toEqual({ id: "workspace_keep" })
        expect(yield* db.get(`SELECT id FROM permission WHERE id = 'permission_keep'`)).toEqual({ id: "permission_keep" })
        expect(yield* db.get(`SELECT name FROM data_migration WHERE name = 'migration_keep'`)).toEqual({
          name: "migration_keep",
        })
        expect(yield* db.all(`SELECT key FROM ocdb_meta ORDER BY key`)).toEqual([
          { key: "framing_epoch" },
          { key: "semantic_epoch" },
          { key: "semantic_history_epoch_v1" },
        ])
        expect(yield* db.get(`SELECT value FROM ocdb_meta WHERE key = 'semantic_history_epoch_v1'`)).toEqual({ value: "1" })
        expect(yield* db.get<{ count: number }>(`SELECT count(*) AS count FROM session_message_fts WHERE session_message_fts MATCH 'old'`)).toEqual({
          count: 0,
        })
        expect(yield* db.get<{ count: number }>(`SELECT count(*) AS count FROM memory_entry_fts WHERE memory_entry_fts MATCH 'old'`)).toEqual({
          count: 0,
        })
        expect(yield* db.get<{ freelist_count: number }>("PRAGMA freelist_count")).toEqual({ freelist_count: 0 })
      }).pipe(Effect.provide(layer)),
    )

    const deletedCacheLookup = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* EventV2.resolveCdbRef(db, "session_reset", "value_reset")
      }).pipe(Effect.provide(layer), Effect.exit),
    )
    expect(deletedCacheLookup._tag).toBe("Failure")

    // Repeating the destructive action is intentionally safe. This matters for
    // clients retrying after a network response is lost after the commit.
    const second = await Effect.runPromise(resetLocalData().pipe(Effect.provide(layer)))
    expect(second.sessionsDeleted).toBe(0)
    expect(second.memoriesDeleted).toBe(0)
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect(yield* db.get(`SELECT value FROM ocdb_meta WHERE key = 'semantic_history_epoch_v1'`)).toEqual({ value: "2" })
      }).pipe(Effect.provide(layer)),
    )

    // Two callers may race from different app windows/devices. The IMMEDIATE
    // transaction must serialize them and the response metadata must describe
    // rows actually removed by each transaction, not a shared pre-lock count.
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(
          `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
           VALUES ('ses_concurrent_reset', 'project_reset', 'concurrent', '/tmp/reset', 'Concurrent reset', '1', 2, 2)`,
        )
      }).pipe(Effect.provide(layer)),
    )
    const concurrent = await Effect.runPromise(
      Effect.all([resetLocalData(), resetLocalData()], { concurrency: 2 }).pipe(Effect.provide(layer)),
    )
    expect(concurrent.map((item) => item.sessionsDeleted).sort()).toEqual([0, 1])
    expect(concurrent.reduce((total, item) => total + item.sessionsDeleted, 0)).toBe(1)
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect(yield* db.get<{ count: number }>(`SELECT count(*) AS count FROM session`)).toEqual({ count: 0 })
        expect(yield* db.get(`SELECT value FROM ocdb_meta WHERE key = 'semantic_history_epoch_v1'`)).toEqual({ value: "4" })
      }).pipe(Effect.provide(layer)),
    )
  })

  test("classifies every durable application table as resettable or preserved", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const tables = yield* db.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        const classified = new Set<string>([...RESET_TABLES_IN_ORDER, ...SESSION_EVENT_TABLES, ...PRESERVED_TABLES])
        const unclassified = tables
          .map((row) => row.name)
          .filter((name) => !name.includes("_fts") && !classified.has(name))
        expect(unclassified).toEqual([])
      }).pipe(Effect.provide(layer)),
    )
  })
})
