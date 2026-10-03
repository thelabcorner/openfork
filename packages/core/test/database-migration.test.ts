import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { eq, inArray, sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import workspaceNameMigration from "@opencode-ai/core/database/migration/20260410174513_workspace-name"
import sessionUsageMigration from "@opencode-ai/core/database/migration/20260510033149_session_usage"
import normalizeStoragePathsMigration from "@opencode-ai/core/database/migration/20260601010001_normalize_storage_paths"
import sessionMessageProjectionOrderMigration from "@opencode-ai/core/database/migration/20260603040000_session_message_projection_order"
import eventSourcedSessionInputMigration from "@opencode-ai/core/database/migration/20260604172448_event_sourced_session_input"
import contextEpochAgentMigration from "@opencode-ai/core/database/migration/20260605042240_add_context_epoch_agent"
import simplifyIntegrationCredentialsMigration from "@opencode-ai/core/database/migration/20260611192811_lush_chimera"
import simplifySessionInputMigration from "@opencode-ai/core/database/migration/20260622202450_simplify_session_input"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import sessionMetadataMigration from "@opencode-ai/core/database/migration/20260511173437_session-metadata"
import sessionGroupMembershipMigration from "@opencode-ai/core/database/migration/20260904000000_add_session_group_membership"
import workspaceTimeUsedDefaultMigration from "@opencode-ai/core/database/migration/20260920035341_workspace_time_used_default"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

type TestDatabase = Effect.Success<typeof makeDb>

function normalizePartialIndex(sqlText: string | null) {
  if (!sqlText) return null
  const where = sqlText.match(/\bWHERE\b([\s\S]*)$/i)?.[1]
  if (!where) return null
  return where
    .replaceAll(/[`\"]/g, "")
    .replaceAll(/\b[a-zA-Z_][a-zA-Z0-9_]*\./g, "")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function normalizeDefault(value: string | null) {
  if (value === null) return null
  const normalized = value.trim().toLowerCase()
  if (normalized === "false") return "0"
  if (normalized === "true") return "1"
  return value.trim()
}

function schemaShape(db: TestDatabase) {
  return Effect.gen(function* () {
    const tables = yield* db.all<{
      name: string
      type: string
      ncol: number
      wr: number
      strict: number
    }>(sql`
      SELECT name, type, ncol, wr, strict
      FROM pragma_table_list
      WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)

    const columns = (
      yield* db.all<{
        table_name: string
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
        hidden: number
      }>(sql`
        SELECT master.name AS table_name, info.cid, info.name, info.type, info."notnull",
               info.dflt_value, info.pk, info.hidden
        FROM sqlite_master AS master, pragma_table_xinfo(master.name) AS info
        WHERE master.type = 'table' AND master.name NOT LIKE 'sqlite_%'
        ORDER BY master.name, info.cid
      `)
    )
      .map(({ cid: _cid, ...column }) => ({
        ...column,
        // INTEGER PRIMARY KEY aliases SQLite ROWID: inserting NULL allocates a
        // non-null rowid even when PRAGMA reports notnull=0. Treat explicit
        // NOT NULL and the implicit ROWID invariant as structurally equivalent.
        // Do not normalize TEXT primary keys; SQLite really can store NULL there.
        notnull:
          column.notnull || (column.pk > 0 && column.type.toUpperCase() === "INTEGER")
            ? 1
            : 0,
        dflt_value: normalizeDefault(column.dflt_value),
      }))
      .sort((a, b) => `${a.table_name}\0${a.name}`.localeCompare(`${b.table_name}\0${b.name}`))

    const foreignKeys = yield* db.all<{
      table_name: string
      id: number
      seq: number
      ref_table: string
      from_column: string
      to_column: string | null
      on_update: string
      on_delete: string
      match: string
    }>(sql`
      SELECT master.name AS table_name, fk.id, fk.seq, fk."table" AS ref_table,
             fk."from" AS from_column, fk."to" AS to_column, fk.on_update, fk.on_delete, fk.match
      FROM sqlite_master AS master, pragma_foreign_key_list(master.name) AS fk
      WHERE master.type = 'table' AND master.name NOT LIKE 'sqlite_%'
      ORDER BY master.name, fk.id, fk.seq
    `)

    const indexRows = yield* db.all<{
      table_name: string
      index_name: string
      unique_index: number
      origin: string
      partial: number
      index_sql: string | null
      seqno: number
      cid: number
      column_name: string | null
      desc: number
      coll: string
      key: number
    }>(sql`
      SELECT master.name AS table_name, indexes.name AS index_name, indexes."unique" AS unique_index,
             indexes.origin, indexes.partial, definition.sql AS index_sql,
             info.seqno, info.cid, info.name AS column_name, info."desc", info.coll, info."key"
      FROM sqlite_master AS master,
           pragma_index_list(master.name) AS indexes,
           pragma_index_xinfo(indexes.name) AS info
      LEFT JOIN sqlite_master AS definition ON definition.type = 'index' AND definition.name = indexes.name
      WHERE master.type = 'table' AND master.name NOT LIKE 'sqlite_%'
      ORDER BY master.name, indexes.name, info.seqno
    `)
    const indexes = new Map<
      string,
      {
        table_name: string
        name: string | null
        unique: number
        origin: string
        partial: number
        where: string | null
        columns: Array<{ seqno: number; name: string | null; desc: number; coll: string; key: number }>
      }
    >()
    for (const row of indexRows) {
      const key = `${row.table_name}\0${row.index_name}`
      let index = indexes.get(key)
      if (!index) {
        index = {
          table_name: row.table_name,
          name: row.index_name.startsWith("sqlite_autoindex_") ? null : row.index_name,
          unique: row.unique_index,
          origin: row.origin,
          partial: row.partial,
          where: normalizePartialIndex(row.index_sql),
          columns: [],
        }
        indexes.set(key, index)
      }
      index.columns.push({
        seqno: row.seqno,
        name: row.column_name,
        desc: row.desc,
        coll: row.coll,
        key: row.key,
      })
    }

    const normalizedIndexes = [...indexes.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    )
    const triggers = yield* db.all<{ name: string; table_name: string }>(sql`
      SELECT name, tbl_name AS table_name
      FROM sqlite_master
      WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)

    return { tables, columns, foreignKeys, indexes: normalizedIndexes, triggers }
  })
}

describe("DatabaseMigration", () => {
  test("converges the pre-acquisition directory guard without granting legacy authority", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const target = migrations.find((migration) => migration.id === "20260924042906_directory_maintenance_guard")
        expect(target).toBeDefined()
        if (!target) return

        yield* db.run(sql`
          CREATE TABLE runtime_owner (
            id text PRIMARY KEY
          )
        `)
        yield* db.run(sql`
          CREATE TABLE directory_maintenance_guard (
            directory text PRIMARY KEY,
            guard_id text NOT NULL,
            owner_id text NOT NULL,
            generation integer NOT NULL,
            state text NOT NULL,
            acquired_at integer NOT NULL,
            released_at integer,
            updated_at integer NOT NULL,
            FOREIGN KEY (owner_id) REFERENCES runtime_owner(id),
            CHECK(state in ('active', 'released', 'reconcile_required')),
            CHECK((state = 'released' and released_at is not null)
              or (state <> 'released' and released_at is null))
          )
        `)
        yield* db.run(sql`CREATE INDEX directory_maintenance_guard_guard_idx ON directory_maintenance_guard (guard_id,state)`)
        yield* db.run(sql`CREATE INDEX directory_maintenance_guard_owner_idx ON directory_maintenance_guard (owner_id,state)`)
        yield* db.run(sql`
          CREATE TABLE migration (
            id text PRIMARY KEY,
            time_completed integer NOT NULL,
            checksum text
          )
        `)
        yield* db.run(sql`INSERT INTO runtime_owner (id) VALUES ('owner_legacy')`)
        yield* db.run(sql`
          INSERT INTO directory_maintenance_guard
            (directory, guard_id, owner_id, generation, state, acquired_at, released_at, updated_at)
          VALUES
            ('/a', 'guard-a', 'owner_legacy', 3, 'active', 10, NULL, 12),
            ('/b', 'guard-b', 'owner_legacy', 4, 'released', 20, 30, 31)
        `)
        yield* db.run(sql`
          INSERT INTO migration (id, time_completed, checksum)
          VALUES ('20260924022626_directory_maintenance_guard', 1, 'legacy-dev-checksum')
        `)

        yield* DatabaseMigration.applyOnly(db, [target])
        yield* DatabaseMigration.applyOnly(db, [target])

        const columns = (yield* db.all<{ name: string }>(sql`PRAGMA table_info(directory_maintenance_guard)`)).map(
          (column) => column.name,
        )
        expect(columns).toEqual([
          "directory",
          "guard_id",
          "owner_id",
          "acquisition_id",
          "generation",
          "state",
          "acquired_at",
          "released_at",
          "updated_at",
        ])

        expect(
          yield* db.all(sql`
            SELECT directory, guard_id, owner_id, acquisition_id, generation, state,
                   acquired_at, released_at, updated_at
            FROM directory_maintenance_guard
            ORDER BY directory
          `),
        ).toEqual([
          {
            directory: "/a",
            guard_id: "guard-a",
            owner_id: "owner_legacy",
            acquisition_id: "directory-maintenance:legacy:2f61",
            generation: 3,
            state: "reconcile_required",
            acquired_at: 10,
            released_at: null,
            updated_at: 12,
          },
          {
            directory: "/b",
            guard_id: "guard-b",
            owner_id: "owner_legacy",
            acquisition_id: "directory-maintenance:legacy:2f62",
            generation: 4,
            state: "released",
            acquired_at: 20,
            released_at: 30,
            updated_at: 31,
          },
        ])

        expect(
          yield* db.all<{ id: string; checksum: string | null }>(sql`
            SELECT id, checksum
            FROM migration
            WHERE id IN (
              '20260924022626_directory_maintenance_guard',
              '20260924042906_directory_maintenance_guard'
            )
            ORDER BY id
          `),
        ).toEqual([
          {
            id: "20260924022626_directory_maintenance_guard",
            checksum: "legacy-dev-checksum",
          },
          {
            id: target.id,
            checksum: target.checksum,
          },
        ])

        const indexes = (yield* db.all<{ name: string }>(sql`
          SELECT name
          FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'directory_maintenance_guard'
          ORDER BY name
        `)).map((row) => row.name)
        expect(indexes).toContain("directory_maintenance_guard_acquisition_idx")
      }),
    )
  })

  test("backfills session-group memberships and remains re-runnable", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE session (
            id text PRIMARY KEY,
            group_id text
          )
        `)
        yield* db.run(sql`
          CREATE TABLE session_group (
            id text PRIMARY KEY,
            name text NOT NULL,
            position integer NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL
          )
        `)
        yield* db.run(sql`INSERT INTO session_group VALUES ('grp_test', 'Test', 0, 1, 1)`)
        yield* db.run(sql`INSERT INTO session VALUES ('ses_test', 'grp_test')`)

        yield* DatabaseMigration.applyOnly(db, [sessionGroupMembershipMigration])
        yield* db.run(sql`DELETE FROM migration WHERE id = ${sessionGroupMembershipMigration.id}`)
        yield* DatabaseMigration.applyOnly(db, [sessionGroupMembershipMigration])

        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_group)`)).map((column) => column.name),
        ).toEqual([
          "id",
          "name",
          "position",
          "time_created",
          "time_updated",
          "kind",
          "owner_plugin",
          "anchor_session_id",
          "policy",
          "time_archived",
        ])
        expect(yield* db.all(sql`SELECT group_id, session_id, locked, origin FROM session_group_member`)).toEqual([
          { group_id: "grp_test", session_id: "ses_test", locked: 0, origin: "user" },
        ])
      }),
    )
  })

  test("defaults missing workspace names while preserving legacy workspace data", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE workspace (
            id text PRIMARY KEY,
            type text NOT NULL,
            branch text,
            directory text,
            extra text,
            project_id text NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO workspace (id, type, branch, directory, extra, project_id)
          VALUES ('wrk_legacy', 'remote', 'main', '/repo', '{}', 'proj_legacy')
        `)

        yield* DatabaseMigration.applyOnly(db, [workspaceNameMigration])

        expect(yield* db.get(sql`SELECT id, name, branch, directory, extra FROM workspace`)).toEqual({
          id: "wrk_legacy",
          name: "",
          branch: "main",
          directory: "/repo",
          extra: "{}",
        })
      }),
    )
  })

  test("imports unnamed legacy Drizzle journal entries by their actual migration timestamps", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text, created_at integer)`)
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at)
          VALUES ('', ${Date.UTC(2026, 3, 10, 17, 45, 13)})
        `)

        yield* DatabaseMigration.applyOnly(db, [workspaceNameMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260410174513_workspace-name" }])
      }),
    )
  })

  test("rejects unknown legacy Drizzle journal timestamps instead of guessing completed migrations", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text, created_at integer)`)
          yield* db.run(sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', 1234567890000)`)
          yield* DatabaseMigration.applyOnly(db, [workspaceNameMigration])
        }),
      ),
    ).rejects.toThrow("does not match any known migration")
  })

  test("preserves workspace foreign-key associations while adding the SQL default", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(sql`
          CREATE TABLE workspace (
            id text PRIMARY KEY,
            type text NOT NULL,
            name text DEFAULT '' NOT NULL,
            branch text,
            directory text,
            extra text,
            project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            time_used integer NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE goal (
            id text PRIMARY KEY,
            workspace_id text REFERENCES workspace(id) ON DELETE SET NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE swarm (
            id text PRIMARY KEY,
            workspace_id text REFERENCES workspace(id) ON DELETE SET NULL
          )
        `)
        yield* db.run(sql`INSERT INTO project (id) VALUES ('project_test')`)
        yield* db.run(
          sql`INSERT INTO workspace (id, type, project_id, time_used) VALUES ('workspace_test', 'local', 'project_test', 123)`,
        )
        yield* db.run(sql`INSERT INTO goal (id, workspace_id) VALUES ('goal_test', 'workspace_test')`)
        yield* db.run(sql`INSERT INTO swarm (id, workspace_id) VALUES ('swarm_test', 'workspace_test')`)

        yield* DatabaseMigration.applyOnly(db, [workspaceTimeUsedDefaultMigration])

        expect(yield* db.get(sql`SELECT workspace_id FROM goal WHERE id = 'goal_test'`)).toEqual({
          workspace_id: "workspace_test",
        })
        expect(yield* db.get(sql`SELECT workspace_id FROM swarm WHERE id = 'swarm_test'`)).toEqual({
          workspace_id: "workspace_test",
        })
        expect(
          yield* db.get(sql`SELECT dflt_value FROM pragma_table_info('workspace') WHERE name = 'time_used'`),
        ).toEqual({ dflt_value: "0" })
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  })

  test("rejects mutation of a checksummed completed migration", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const original: DatabaseMigration.Migration = {
          id: "20990101000000_checksum_test",
          checksum: "aaaaaaaa",
          up: (tx) => tx.run(sql`CREATE TABLE checksum_test (id text PRIMARY KEY)`),
        }
        yield* DatabaseMigration.applyOnly(db, [original])

        const mutated: DatabaseMigration.Migration = {
          ...original,
          checksum: "bbbbbbbb",
        }
        const exit = yield* Effect.exit(DatabaseMigration.applyOnly(db, [mutated]))
        if (exit._tag === "Success") throw new Error("expected migration checksum mismatch")
        expect(String(exit.cause)).toContain("Migration checksum mismatch for 20990101000000_checksum_test")
      }),
    )
  })

  test("repairs only the known stale checksums from the checksum rollout", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL, checksum TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO migration (id, time_completed, checksum) VALUES
            ('20260919235500_oxp_parent_activity', 1, '357ae708c1e188cd672b39bbac599ab1a6c2d6851bd8774015518cdf080c479c'),
            ('20260920034100_schema_convergence', 1, 'b2ef21144060c67f7a5d9f33c97c83e5fa186357464f354b230b9ee8aacda23c')
        `)

        const canonical: DatabaseMigration.Migration[] = [
          {
            id: "20260919235500_oxp_parent_activity",
            checksum: "e010f3f0a9b9e5b457e5e38cc91dcb08e3555d02b9fc5753434abdc5461d13ef",
            up: () => Effect.die("completed migration must not replay"),
          },
          {
            id: "20260920034100_schema_convergence",
            checksum: "b757a6bd6c240aea8dba0bb88abffeefd13fe6690759c4166ebe5d2b1735ab56",
            up: () => Effect.die("completed migration must not replay"),
          },
        ]

        yield* DatabaseMigration.applyOnly(db, canonical)
        expect(yield* db.all(sql`SELECT id, checksum FROM migration ORDER BY id`)).toEqual([
          {
            id: "20260919235500_oxp_parent_activity",
            checksum: "e010f3f0a9b9e5b457e5e38cc91dcb08e3555d02b9fc5753434abdc5461d13ef",
          },
          {
            id: "20260920034100_schema_convergence",
            checksum: "b757a6bd6c240aea8dba0bb88abffeefd13fe6690759c4166ebe5d2b1735ab56",
          },
        ])

        yield* db.run(sql`
          UPDATE migration
          SET checksum = '357ae708c1e188cd672b39bbac599ab1a6c2d6851bd8774015518cdf080c479c'
          WHERE id = '20260919235500_oxp_parent_activity'
        `)
        const mutated: DatabaseMigration.Migration = {
          ...canonical[0]!,
          checksum: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        }
        const exit = yield* Effect.exit(DatabaseMigration.applyOnly(db, [mutated]))
        if (exit._tag === "Success") throw new Error("expected unknown checksum mutation to fail")
        expect(String(exit.cause)).toContain("Migration checksum mismatch for 20260919235500_oxp_parent_activity")
      }),
    )
  })

  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layerFromPath(filename), Database.layerFromPath(filename)]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })

  test("serializes concurrent initialization across processes before SQLite opens", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "multiprocess.sqlite")
    const helper = fileURLToPath(new URL("./fixture/database-open.ts", import.meta.url))
    // Exercise materially more contention than normal Desktop/ACP/CLI startup.
    // The original race happened before migration DDL, while native handles
    // contended over first-open SQLite/WAL initialization.
    const processes = Array.from({ length: 24 }, () =>
      Bun.spawn(["bun", helper, filename], {
        stdout: "ignore",
        stderr: "pipe",
      }),
    )
    const results = await Promise.all(
      processes.map(async (process) => ({
        exitCode: await process.exited,
        stderr: await new Response(process.stderr).text(),
      })),
    )

    for (const result of results) {
      expect(result.exitCode, result.stderr).toBe(0)
    }
  }, 30_000)

  test("serializes concurrent initialization with the Node SQLite driver", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "multiprocess-node.sqlite")
    const helper = fileURLToPath(new URL("./fixture/database-open.ts", import.meta.url))
    const bundled = path.join(tmp.path, "database-open-node.mjs")
    const build = await $`bun build ${helper} --target=node --format=esm --outfile=${bundled}`.quiet().nothrow()
    expect(build.exitCode, build.stderr.toString()).toBe(0)

    const processes = Array.from({ length: 8 }, () =>
      Bun.spawn(["node", bundled, filename], {
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdout: "ignore",
        stderr: "pipe",
      }),
    )
    const results = await Promise.all(
      processes.map(async (process) => ({
        exitCode: await process.exited,
        stderr: await new Response(process.stderr).text(),
      })),
    )

    for (const result of results) {
      expect(result.exitCode, result.stderr).toBe(0)
    }
  }, 30_000)

  test("declared schema has no ungenerated migrations", async () => {
    const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
      .quiet()
      .nothrow()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
  }, 30_000)

  test("replays the complete tracked migration chain from zero", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM migration`)).toEqual({
          count: migrations.length,
        })
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_value'`)).toEqual({
          name: "event_value",
        })
        expect(
          yield* db.get<{ unique: number }>(
            sql`SELECT "unique" FROM pragma_index_list('session_checkpoint') WHERE name = 'session_checkpoint_session_ordinal_idx'`,
          ),
        ).toEqual({ unique: 1 })
        expect(yield* db.get<{ integrity_check: string }>(sql`PRAGMA integrity_check`)).toEqual({
          integrity_check: "ok",
        })
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  }, 30_000)

  test("fresh schema structurally matches the complete migration chain", async () => {
    const fresh = await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        return yield* schemaShape(db)
      }),
    )
    const upgraded = await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.applyOnly(db, migrations)
        return yield* schemaShape(db)
      }),
    )

    expect(upgraded).toEqual(fresh)
  }, 30_000)

  test("applies tracked migrations to an empty database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)).toEqual({
          name: "session",
        })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_input'`),
        ).toEqual({ name: "session_input" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_context_epoch'`),
        ).toEqual({ name: "session_context_epoch" })
        expect(
          yield* db.get(
            sql`SELECT name FROM pragma_table_info('session_context_epoch') WHERE name IN ('agent', 'replacement_seq', 'revision')`,
          ),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual({ count: migrations.length })
        const sessionFtsTrigger = yield* db.get<{ sql: string }>(
          sql`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'session_message_fts_au'`,
        )
        const partFtsTrigger = yield* db.get<{ sql: string }>(
          sql`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'part_fts_au'`,
        )
        expect(sessionFtsTrigger?.sql).toContain("AFTER UPDATE OF `search_text` ON `session_message`")
        expect(partFtsTrigger?.sql).toContain("AFTER UPDATE OF `search_text` ON `part`")
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('event_aggregate_seq_idx', 'event_aggregate_type_seq_idx', 'session_input_session_pending_class_delivery_seq_idx', 'session_input_session_latest_user_idx', 'session_input_session_preemptible_seq_idx', 'session_input_session_admitted_seq_idx', 'session_input_session_promoted_seq_idx', 'session_message_session_idx', 'session_message_session_type_idx', 'session_message_session_seq_idx', 'session_message_session_type_seq_idx', 'session_message_session_time_created_id_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "event_aggregate_seq_idx" },
          { name: "event_aggregate_type_seq_idx" },
          { name: "session_input_session_admitted_seq_idx" },
          { name: "session_input_session_latest_user_idx" },
          { name: "session_input_session_pending_class_delivery_seq_idx" },
          { name: "session_input_session_preemptible_seq_idx" },
          { name: "session_input_session_promoted_seq_idx" },
          { name: "session_message_session_seq_idx" },
          { name: "session_message_session_time_created_id_idx" },
          { name: "session_message_session_type_seq_idx" },
        ])
      }),
    )
  })

  test("rejects a non-empty database without a session table", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE unrelated (id text PRIMARY KEY)`)
          yield* DatabaseMigration.apply(db)
        }),
      ),
    ).rejects.toThrow("Database is not empty and has no session table")
  })

  test("backfills existing Context Epoch rows to the build agent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE session_context_epoch (session_id text PRIMARY KEY, baseline text NOT NULL, snapshot text NOT NULL, baseline_seq integer NOT NULL, replacement_seq integer, revision integer DEFAULT 0 NOT NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('ses_existing', 'baseline', '{}', 0)`,
        )

        yield* DatabaseMigration.applyOnly(db, [contextEpochAgentMigration])

        expect(yield* db.get(sql`SELECT agent FROM session_context_epoch WHERE session_id = 'ses_existing'`)).toEqual({
          agent: "build",
        })
      }),
    )
  })

  test("keeps legacy credential fields nullable", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE credential (id text PRIMARY KEY, connector_id text NOT NULL, method_id text NOT NULL, label text NOT NULL, value text NOT NULL, active integer DEFAULT false NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE UNIQUE INDEX credential_connector_active_idx ON credential (connector_id) WHERE active = 1`,
        )
        yield* DatabaseMigration.applyOnly(db, [simplifyIntegrationCredentialsMigration])

        yield* db.run(
          sql`INSERT INTO credential (id, connector_id, method_id, label, value, active, time_created, time_updated) VALUES ('legacy', 'openai', 'oauth', 'Legacy', '{}', 1, 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('current', 'anthropic', 'Current', '{}', 2, 2)`,
        )
        expect(yield* db.get(sql`SELECT connector_id, method_id, active FROM credential WHERE id = 'current'`)).toEqual(
          { connector_id: null, method_id: null, active: null },
        )
      }),
    )
  })

  test("resets beta history and rebuilds event-sourced Session input storage", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, workspace_id text)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE part (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq)`)
        yield* db.run(sql`CREATE INDEX event_aggregate_type_seq_idx ON event (aggregate_id, type, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_input (seq integer PRIMARY KEY AUTOINCREMENT, id text NOT NULL UNIQUE, session_id text NOT NULL, prompt text NOT NULL, delivery text NOT NULL, promoted_seq integer, time_created integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_input_session_pending_delivery_seq_idx ON session_input (session_id, promoted_seq, delivery, seq)`,
        )
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('session', 'wrk_old')`)
        yield* db.run(sql`INSERT INTO workspace (id) VALUES ('wrk_old')`)
        yield* db.run(sql`INSERT INTO message (id) VALUES ('message')`)
        yield* db.run(sql`INSERT INTO part (id) VALUES ('part')`)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 0)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_old', 'session', 0, 'old.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_old', 'session', 'user', 0, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, time_created) VALUES ('msg_pending', 'session', '{}', 'steer', 1)`,
        )

        yield* DatabaseMigration.applyOnly(db, [eventSourcedSessionInputMigration])

        expect(yield* db.all(sql`SELECT id, workspace_id FROM session`)).toEqual([
          { id: "session", workspace_id: null },
        ])
        expect(yield* db.all(sql`SELECT id FROM workspace`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM message`)).toEqual([{ id: "message" }])
        expect(yield* db.all(sql`SELECT id FROM part`)).toEqual([{ id: "part" }])
        expect(yield* db.all(sql`SELECT id FROM event`)).toEqual([])
        expect(yield* db.all(sql`SELECT aggregate_id FROM event_sequence`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_input`)).toEqual([])
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_input)`)).map((column) => column.name),
        ).toEqual(["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_message)`)).find(
            (index) => index.name === "session_message_session_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(event)`)).find(
            (index) => index.name === "event_aggregate_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_input)`)).filter((index) =>
            ["session_input_session_admitted_seq_idx", "session_input_session_promoted_seq_idx"].includes(index.name),
          ),
        ).toEqual([
          expect.objectContaining({ name: "session_input_session_promoted_seq_idx", unique: 1 }),
          expect.objectContaining({ name: "session_input_session_admitted_seq_idx", unique: 1 }),
        ])
      }),
    )
  })

  test("preserves canonical V1 state and restarts its event stream", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO workspace (id, type, project_id, time_used) VALUES ('workspace', 'local', 'global', 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, workspace_id, slug, directory, title, version, time_created, time_updated) VALUES ('session', 'global', 'workspace', 'session', '/project', 'Before', 'test', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('message', 'session', 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part', 'message', 'session', 1, 1, '{}')`,
        )
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 9)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('event', 'session', 9, 'session.updated.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created) VALUES ('input', 'session', '{}', 'steer', 9, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('projected', 'session', 'user', 9, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('session', 'baseline', '{}', 9)`,
        )
        yield* db.run(sql`DELETE FROM migration WHERE id = ${simplifySessionInputMigration.id}`)
        yield* DatabaseMigration.applyOnly(db, [simplifySessionInputMigration])

        const database = Layer.succeed(Database.Service, {
          db,
          readDb: db,
          scanDb: () => Effect.succeed(db),
          filename: ":memory:",
        })
        yield* EventV2.Service.use((service) =>
          service.publish(SessionV1.Event.Updated, {
            sessionID: SessionSchema.ID.make("session"),
            info: {
              id: SessionSchema.ID.make("session"),
              slug: "session",
              projectID: ProjectV2.ID.global,
              directory: "/project",
              title: "After",
              version: "test",
              time: { created: 1, updated: 2 },
            },
          }),
        ).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([EventV2.node, SessionProjector.node]), [[Database.node, database]]),
          ),
        )

        expect(
          yield* db.get(sql`
            SELECT
              (SELECT title FROM session WHERE id = 'session') AS title,
              (SELECT workspace_id FROM session WHERE id = 'session') AS workspaceID,
              (SELECT COUNT(*) FROM message WHERE id = 'message') AS messages,
              (SELECT COUNT(*) FROM part WHERE id = 'part') AS parts,
              (SELECT COUNT(*) FROM workspace) AS workspaces,
              (SELECT COUNT(*) FROM session_input) AS sessionInputs,
              (SELECT COUNT(*) FROM session_message) AS sessionMessages,
              (SELECT COUNT(*) FROM session_context_epoch) AS contextEpochs,
              (SELECT seq FROM event_sequence WHERE aggregate_id = 'session') AS seq,
              (SELECT type FROM event WHERE aggregate_id = 'session') AS eventType
          `),
        ).toEqual({
          title: "After",
          workspaceID: null,
          messages: 1,
          parts: 1,
          workspaces: 0,
          sessionInputs: 0,
          sessionMessages: 0,
          contextEpochs: 0,
          seq: 0,
          eventType: "session.updated.1",
        })
      }),
    )
  })

  test("resets incompatible projected Session messages before adding sequence order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE TABLE event (id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_type_time_created_id_idx ON session_message (session_id, type, time_created, id)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('legacy_message', 'session', 1, 1, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('legacy_part', 'legacy_message', 'session', 1, 1, '{"type":"text","text":"hello"}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES ('stale_projection', 'session', 'user', 1, 1, '{}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionMessageProjectionOrderMigration])

        expect(yield* db.all(sql`SELECT id, session_id, data FROM message`)).toEqual([
          { id: "legacy_message", session_id: "session", data: '{"role":"user"}' },
        ])
        expect(yield* db.all(sql`SELECT id, message_id, session_id, data FROM part`)).toEqual([
          {
            id: "legacy_part",
            message_id: "legacy_message",
            session_id: "session",
            data: '{"type":"text","text":"hello"}',
          },
        ])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])

        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('fresh_projection', 'session', 'user', 7, 2, 2, '{}')`,
        )
        expect(yield* db.get(sql`SELECT id, seq FROM session_message`)).toEqual({ id: "fresh_projection", seq: 7 })
      }),
    )
  })

  test("runs session usage backfill in order with schema changes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id, time_updated) VALUES ('session_1', 1)`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES ('message_1', 'session_1', '{"role":"assistant","cost":1.25,"tokens":{"input":2,"output":3,"reasoning":4,"cache":{"read":5,"write":6}}}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionUsageMigration])

        expect(
          yield* db.get(
            sql`SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = 'session_1'`,
          ),
        ).toEqual({
          cost: 1.25,
          tokens_input: 2,
          tokens_output: 3,
          tokens_reasoning: 4,
          tokens_cache_read: 5,
          tokens_cache_write: 6,
        })
      }),
    )
  })

  test("normalizes Windows storage paths and leaves POSIX paths untouched", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, path text)`)
        // Windows-shaped rows (drive + backslash) must be normalized.
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"win"}, ${"C:\\Repo\\Thing"}, ${JSON.stringify([
            "C:\\Repo\\Thing\\sandbox",
          ])})`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"win"}, ${"C:\\Repo\\Thing\\packages\\api"}, ${"packages\\api"})`,
        )
        // UNC worktrees and their sandboxes must normalize too (not just drive paths).
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"unc"}, ${"\\\\server\\share"}, ${JSON.stringify([
            "\\\\server\\share\\sandbox",
          ])})`,
        )
        // The "/" worktree sentinel and POSIX paths (including a pathological
        // backslash in a POSIX filename) must survive byte-for-byte.
        yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"global"}, ${"/"}, ${"[]"})`)
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"posix"}, ${"/home/me/we\\ird"}, ${"src\\weird"})`,
        )

        yield* DatabaseMigration.applyOnly(db, [normalizeStoragePathsMigration])

        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'win'`)).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'win'`)).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })
        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'unc'`)).toEqual({
          worktree: "//server/share",
          sandboxes: JSON.stringify(["//server/share/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT worktree FROM project WHERE id = 'global'`)).toEqual({ worktree: "/" })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'posix'`)).toEqual({
          directory: "/home/me/we\\ird",
          path: "src\\weird",
        })
      }),
    )
  })

  test("maps native Windows paths through database columns", async () => {
    if (process.platform !== "win32") return
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const projectID = ProjectV2.ID.make("codec_project")
        const worktree = AbsolutePath.make("C:\\Repo\\Thing")
        const sandbox = AbsolutePath.make("C:\\Repo\\Thing\\sandbox")
        const directory = "C:\\Repo\\Thing\\packages\\api"
        const sessionID = SessionSchema.ID.make("ses_codec")

        expect(() =>
          Effect.runSync(
            db
              .insert(ProjectTable)
              .values({
                id: ProjectV2.ID.make("invalid_path"),
                worktree: AbsolutePath.make("not-absolute"),
                sandboxes: [],
                time_created: 1,
                time_updated: 1,
              })
              .run(),
          ),
        ).toThrow()

        yield* db
          .insert(ProjectTable)
          .values({
            id: projectID,
            worktree,
            sandboxes: [sandbox],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "codec",
            directory,
            path: "packages\\api",
            title: "Codec",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()

        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(
          yield* db.get<{ directory: string; path: string }>(
            sql`SELECT directory, path FROM session WHERE id = ${sessionID}`,
          ),
        ).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })

        const project = yield* db.select().from(ProjectTable).where(eq(ProjectTable.worktree, worktree)).get()
        const session = yield* db.select().from(SessionTable).where(eq(SessionTable.directory, directory)).get()
        expect(project?.worktree).toBe(worktree)
        expect(project?.sandboxes).toEqual([sandbox])
        expect(session?.directory).toBe(directory)
        expect(session?.path).toBe("packages/api")

        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.path, "packages\\api")).get())?.id).toBe(
          sessionID,
        )

        const moved = AbsolutePath.make("D:\\Moved\\Thing")
        const updated = yield* db
          .update(ProjectTable)
          .set({ worktree: moved, sandboxes: [moved] })
          .where(eq(ProjectTable.id, projectID))
          .returning()
          .get()
        expect(updated?.worktree).toBe(moved)
        expect(updated?.sandboxes).toEqual([moved])
        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({ worktree: "D:/Moved/Thing", sandboxes: JSON.stringify(["D:/Moved/Thing"]) })
        expect(
          (yield* db
            .select()
            .from(ProjectTable)
            .where(inArray(ProjectTable.worktree, [moved]))
            .get())?.id,
        ).toBe(projectID)

        yield* db.run(sql`UPDATE project SET worktree = ${"not-absolute"} WHERE id = ${projectID}`)
        expect(() =>
          Effect.runSync(db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()),
        ).toThrow()
      }),
    )
  })

  test("imports existing drizzle migration state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.get(sql`SELECT id FROM migration`)).toEqual({ id: "20260127222353_familiar_lady_ursula" })
      }),
    )
  })

  test("does not replay a migrated session metadata column", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260511173437_session-metadata', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260511173437_session-metadata" }])
      }),
    )
  })

  test("accepts the temporary replacement session metadata migration id", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('20260530232709_lovely_romulus', 1)`)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([
          { id: "20260511173437_session-metadata" },
          { id: "20260530232709_lovely_romulus" },
        ])
      }),
    )
  })

  test("skips drizzle import when migration table already has state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }])
      }),
    )
  })
})
