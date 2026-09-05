export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { ensureChunkDB, CHUNKDB_PAGE_SIZE, CHUNKDB_AUTO_VACUUM } from "./chunkdb"
import { runSealerLoop } from "./chunk-sealer"
import { compactDatabase } from "./chunk-compact"
import { rebuildDatabase } from "./chunk-rebuild"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
export type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
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

      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
      yield* DatabaseMigration.apply(db)
      yield* ensureChunkDB(db)
      if (Flag.OPENCODE_SEAL_ENABLED) {
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
      // make progress); failures are swallowed so the loop keeps going.
      yield* Effect.forkScoped(
        db
          .run("PRAGMA wal_checkpoint(PASSIVE)")
          .pipe(Effect.ignore, Effect.repeat(Schedule.spaced(Duration.minutes(5)))),
      )

      return { db, filename }
    }).pipe(Effect.orDie),
  )

export function layerFromPath(filename: string) {
  // Create-time storage tuning (page_size + auto_vacuum=INCREMENTAL) for NEW
  // DBs. Applied by the native layer BEFORE `journal_mode = WAL` so it actually
  // takes effect; harmless no-op on existing DBs. Gated on the ChunkDB feature.
  const createTimePragmas = Flag.OPENCODE_SEAL_ENABLED
    ? { page_size: CHUNKDB_PAGE_SIZE, auto_vacuum: CHUNKDB_AUTO_VACUUM }
    : undefined
  return layer(filename).pipe(Layer.provide(sqliteLayer({ filename, createTimePragmas })))
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
): Effect.Effect<A, EffectDrizzleQueryError | E, R> {
  return Effect.gen(function* () {
    const db = yield* makeDatabase
    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA foreign_keys = ON")
    return yield* body(db)
  }).pipe(Effect.provide(sqliteLayer({ filename })))
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
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
