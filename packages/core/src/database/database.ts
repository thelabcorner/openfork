export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Duration, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { dirname, isAbsolute, join, resolve } from "path"
import { DatabaseMigration } from "./migration"
import { ensureChunkDB, CHUNKDB_PAGE_SIZE, CHUNKDB_AUTO_VACUUM } from "./chunkdb"
import { runSealerLoop } from "./chunk-sealer"
import { compactDatabase } from "./chunk-compact"
import { rebuildDatabase } from "./chunk-rebuild"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Flock } from "../util/flock"
import { DATABASE_BASENAME, RUNTIME_LOCK_DIRNAME, STORAGE_NAMESPACE } from "../storage-identity"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
export type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
  /**
   * Dedicated query-only connection for interactive/history reads. File-backed
   * databases use a second native SQLite handle so reads do not queue behind a
   * long transaction holding the primary connection's single permit. In-memory
   * databases alias this to `db` because separate `:memory:` handles are
   * independent databases.
   */
  readDb: DatabaseShape
  filename: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = (filename: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      // Epoch-3 (#9): opt-in shrink of EXISTING databases (auto_vacuum=0 files
      // never reclaim space on their own). Must run BEFORE the main connection
      // is acquired — on Windows the main Native handle keeps the file locked
      // (WAL mode) and the compact swap (rename original -> .bak) would fail
      // with EBUSY if the main handle is open. Gated on OPENCODE_SEAL_COMPACT.
      // Uses raw SQLite connections with deterministic close(), so it is safe
      // to run here with no main db yet; errors are logged and do not block startup.
      // Epoch-3 (#8): one-shot REBUILD that extends the #9 file-swap to also
      // collapse projections (session_message.data / message.data /
      // session.summary_diffs / event message.updated+session.updated) into
      // event_value $cdbRef indexes (same table, no second scan). R2/Q1/Q4.
      // Flag-gated OPENCODE_SEAL_REBUILD (default-off); takes precedence over
      // COMPACT because the rebuild already does VACUUM + dedup.
      if (Flag.OPENCODE_SEAL_REBUILD) {
        yield* rebuildDatabase(filename).pipe(Effect.logError)
      } else if (Flag.OPENCODE_SEAL_COMPACT) {
        yield* compactDatabase(filename).pipe(Effect.logError)
      }

      const db = yield* makeDatabase
      const configurePrimary = Effect.gen(function* () {
        // Install the wait policy before any pragma that may need a SQLite lock.
        // In particular, journal_mode can transiently contend with another
        // already-running host even after bootstrap creation itself is
        // serialized.
        yield* db.run("PRAGMA busy_timeout = 5000")
        const journal = yield* db.get<{ journal_mode: string }>("PRAGMA journal_mode")
        if (journal?.journal_mode.toLowerCase() !== "wal") {
          yield* db.run("PRAGMA journal_mode = WAL")
        }
        yield* db.run("PRAGMA synchronous = NORMAL")
        yield* db.run("PRAGMA cache_size = -64000")
        yield* db.run("PRAGMA foreign_keys = ON")
        yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
      })
      if (filename === ":memory:") {
        yield* configurePrimary
        yield* DatabaseMigration.apply(db)
        yield* ensureChunkDB(db)
      } else {
        // layerFromPath acquires the DB-local bootstrap lease *before this
        // connection exists*. That ordering matters: merely locking around DDL
        // after opening every contender still lets their native handles prevent
        // the winner from changing journal_mode on a brand-new database.
        yield* configurePrimary
        yield* DatabaseMigration.apply(db)
        yield* ensureChunkDB(db)
      }

      // WAL allows readers to observe the last committed snapshot while a
      // writer transaction is active, but that concurrency is lost if reads and
      // writes share our native client's single-permit semaphore. Keep one
      // persistent query-only connection for latency-sensitive reads. Build it
      // only after migrations so a fresh database never races schema creation.
      let readDb = db
      if (filename !== ":memory:") {
        const readerContext = yield* Layer.build(
          sqliteLayer({ filename, disableWAL: true, checkpointOnClose: false }),
        )
        readDb = yield* makeDatabase.pipe(Effect.provide(readerContext))
        yield* readDb.run("PRAGMA query_only = ON")
        yield* readDb.run("PRAGMA busy_timeout = 250")
        yield* readDb.run("PRAGMA cache_size = -32000")
        yield* readDb.run("PRAGMA foreign_keys = ON")
      }
      // The sealer intentionally owns a second SQLite connection so maintenance
      // cannot monopolize the foreground client's single permit. Plain
      // `:memory:` handles are independent databases, not shared connections;
      // forking the file-backed sealer topology here would therefore maintain an
      // empty unrelated database and fail on missing ChunkDB tables.
      if (Flag.OPENCODE_SEAL_ENABLED && filename !== ":memory:") {
        yield* Effect.forkScoped(runSealerLoop(filename).pipe(Effect.ignore))
      }

      // Periodically checkpoint the WAL so it doesn't grow unbounded during
      // long runs. PASSIVE checkpoints whatever frames it can WITHOUT taking
      // the EXCLUSIVE lock, so it can never stall live queries: the native
      // driver calls are synchronous (they block the single event loop), and
      // a TRUNCATE checkpoint contending with concurrent sessions' writes can
      // hold the shared connection — bounded only by the 5s busy_timeout —
      // long enough to starve the 10s SSE heartbeat and flip the UI red.
      // PASSIVE still bounds WAL growth (idle moments between queries let it
      // make progress). Multiple ACP/Desktop hosts can share this exact DB, so
      // elect one checkpoint owner per pass instead of multiplying identical
      // housekeeping by host count. The DB-local lock path deliberately avoids
      // XDG_STATE_HOME because Desktop and ACP may use different state roots.
      const checkpointLockDir = join(dirname(filename), RUNTIME_LOCK_DIRNAME)
      const checkpoint = Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(`wal-checkpoint:${filename}`, {
            dir: checkpointLockDir,
            staleMs: 30_000,
            timeoutMs: 100,
            baseDelayMs: 25,
            maxDelayMs: 50,
          })
          yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
        }),
      ).pipe(Effect.ignore)
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(Duration.minutes(5))
            yield* checkpoint
          }
        }),
      )

      return { db, readDb, filename }
    }).pipe(Effect.orDie),
  )

export function layerFromPath(filename: string) {
  // Create-time storage tuning (page_size + auto_vacuum=INCREMENTAL) for NEW
  // DBs. Applied by the native layer BEFORE `journal_mode = WAL` so it actually
  // takes effect; harmless no-op on existing DBs. Gated on the ChunkDB feature.
  const createTimePragmas = Flag.OPENCODE_SEAL_ENABLED
    ? { page_size: CHUNKDB_PAGE_SIZE, auto_vacuum: CHUNKDB_AUTO_VACUUM }
    : undefined
  // The Database service owns cooperative PASSIVE checkpointing while alive.
  // A connection-finalizer TRUNCATE is not safe for a shared database: one
  // Desktop/ACP process can exit while another is migrating and turn the
  // latter's first write into SQLITE_BUSY. Never perform that uncoordinated
  // exclusive-ish checkpoint on the production primary handle.
  //
  // Likewise, do not let the native layer switch journal_mode to WAL before the
  // DB-local bootstrap lock is acquired. journal_mode mutates the database
  // header and participates in SQLite's lock graph; doing it eagerly would leave
  // a pre-lock race even though the actual migration body is serialized below.
  const databaseLayer = layer(filename).pipe(
    Layer.provide(
      sqliteLayer({
        filename,
        createTimePragmas,
        disableWAL: filename !== ":memory:",
        checkpointOnClose: false,
      }),
    ),
  )
  if (filename === ":memory:") return databaseLayer

  // Acquire admission before the native SQLite handle exists. SQLite requires
  // an exclusive-ish header transition when a new database first enters WAL
  // mode, so opening all contenders first and locking only the migration body
  // is insufficient: the idle losing handles can make the winning
  // PRAGMA journal_mode = WAL fail with SQLITE_BUSY.
  //
  // Layer.effectContext supplies the caller's Scope to Layer.build, so the
  // database resources remain alive after the bootstrap lease is released. The
  // lease protects construction only, not the lifetime of the process.
  const databaseFile = resolve(filename)
  const bootstrapLockDir = join(dirname(databaseFile), RUNTIME_LOCK_DIRNAME)
  return Layer.effectContext(
    Effect.acquireUseRelease(
      Effect.promise(() =>
        Flock.acquire(`database-schema-bootstrap:${databaseFile}`, {
          dir: bootstrapLockDir,
          staleMs: 60_000,
          timeoutMs: 5 * 60_000,
          baseDelayMs: 25,
          maxDelayMs: 500,
        }),
      ),
      () => Layer.build(databaseLayer),
      (lease) => Effect.promise(() => lease.release()),
    ),
  )
}

// Runs `body` with a dedicated second SQLite connection to the same database
// file, built through the same sqlite layer factory: its own native connection
// and its own single-permit semaphore, completely separate from the shared
// client that serializes live queries — so a long-running maintenance pass can
// never starve them. Same PRAGMAs as the primary connection; migrations are
// skipped (already applied by the Database layer). The connection stays open
// for the whole `body` and is closed when the effect completes.
export function withBackfillDb<A, E, R>(
  filename: string,
  body: (db: DatabaseShape) => Effect.Effect<A, E, R>,
  options?: { readonly busyTimeoutMs?: number },
): Effect.Effect<A, EffectDrizzleQueryError | E, R> {
  return Effect.gen(function* () {
    const db = yield* makeDatabase
    // Background maintenance is lower priority than interactive writes. Install
    // its wait policy before *any* pragma that can participate in SQLite's lock
    // graph. In particular, changing journal_mode can need a header/write lock.
    // The native layer is also told not to switch to WAL eagerly, otherwise that
    // transition would still happen before this timeout exists.
    const busyTimeoutMs = Math.max(0, Math.floor(options?.busyTimeoutMs ?? 100))
    yield* db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    const journal = yield* db.get<{ journal_mode: string }>("PRAGMA journal_mode")
    if (journal?.journal_mode.toLowerCase() !== "wal") {
      yield* db.run("PRAGMA journal_mode = WAL")
    }
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA foreign_keys = ON")
    return yield* body(db)
  }).pipe(Effect.provide(sqliteLayer({ filename, disableWAL: true, checkpointOnClose: false })))
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, DATABASE_BASENAME)
  return join(Global.Path.data, `${STORAGE_NAMESPACE}-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
