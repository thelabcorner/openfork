export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Duration, Effect, Exit, Layer, Scope, Semaphore } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { dirname, isAbsolute, join, resolve } from "path"
import { stat } from "node:fs/promises"
import { DatabaseMigration } from "./migration"
import { ensureChunkDB, CHUNKDB_PAGE_SIZE, CHUNKDB_AUTO_VACUUM } from "./chunkdb"
import { runSealerLoop } from "./chunk-sealer"
import { compactDatabase } from "./chunk-compact"
import { rebuildDatabase } from "./chunk-rebuild"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Flock } from "../util/flock"
import { makeLeasedReaderPool } from "./scan-read-pool"
import { DATABASE_BASENAME, RUNTIME_LOCK_DIRNAME, STORAGE_NAMESPACE } from "../storage-identity"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
export type DatabaseShape = Effect.Success<typeof makeDatabase>

export const WAL_PRESSURE_BYTES = 64 * 1024 * 1024
export const WAL_CHECK_INTERVAL_MS = 30_000
export const WAL_PRESSURE_CHECKPOINT_INTERVAL_MS = 60_000
export const WAL_NORMAL_CHECKPOINT_INTERVAL_MS = 5 * 60_000
/** Avoid repeated expensive PASSIVE scans when a long-lived reader has
 * stopped the checkpointer at the same WAL end mark. */
export function checkpointIntervalMs(walBytes: number, stalled: boolean, unchangedCleanWal = false): number {
  return stalled || unchangedCleanWal || walBytes < WAL_PRESSURE_BYTES
    ? WAL_NORMAL_CHECKPOINT_INTERVAL_MS
    : WAL_PRESSURE_CHECKPOINT_INTERVAL_MS
}

export interface WalFileMarker {
  readonly size: number
  readonly modifiedAt: number
}

/** Physical WAL size alone is NOT outstanding work: SQLite can reuse the
 * same large file after a complete checkpoint. A completed file marker is a
 * conservative optimization only. Unreadable/missing files stay eligible for
 * the ordinary five-minute safety pass. */
export function unchangedCleanWal(
  observed: WalFileMarker | undefined,
  lastComplete: WalFileMarker | undefined,
): boolean {
  return !!observed && !!lastComplete &&
    observed.size === lastComplete.size &&
    observed.modifiedAt === lastComplete.modifiedAt
}

/** SQLite can reset its WAL frame positions when restarting the log. Never
 * interpret a restarted/recycled log as a nonprogressing pinned reader. */
export function checkpointIsStalled(previous: WalCheckpointStatus | undefined, current: WalCheckpointStatus): boolean {
  return !!previous &&
    previous.pendingPages > 0 &&
    current.pendingPages > 0 &&
    current.log >= previous.log &&
    current.checkpointed <= previous.checkpointed
}

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
  /**
   * Lazily-created persistent query-only lane for expensive analytical scans.
   * It stays separate from readDb so aggregation cannot monopolize the
   * latency-sensitive reader's single SQLite permit.
   */
  scanDb: () => Effect.Effect<DatabaseShape>
  /**
   * Isolated writer for control-plane mutations (for example, RuntimeOwner
   * heartbeats). A slow primary SELECT must not block a liveness update from
   * acquiring a connection. SQLite still serializes WAL writers. In-memory
   * databases return the primary connection. Optional for injected fixtures.
   */
  controlDb?: () => Effect.Effect<DatabaseShape>
  /**
   * Low-priority, disposable-observability writer. Isolate optional OXP
   * activity transaction admission from the foreground 15-second BEGIN retry
   * path and from control-plane lease/heartbeat writes. In-memory aliases db.
   */
  activityDb?: () => Effect.Effect<DatabaseShape>
  /** Exclusively owns one read connection for all statements in a callback. */
  /** Optional on legacy injectable fixtures; the production Database always implements it. */
  withScanDb?: <A, E, R>(read: (connection: DatabaseShape) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  filename: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

/**
 * Stage a lazily acquired resource in a private scope. Failed or interrupted
 * setup closes partial acquisitions immediately; successful setup transfers
 * cleanup to the owner scope.
 */
export function acquireScopedResource<A, E, R>(
  owner: Scope.Scope,
  acquire: (candidate: Scope.Closeable) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const candidate = yield* Scope.make()
      const result = yield* Effect.exit(restore(acquire(candidate)))
      if (Exit.isFailure(result)) {
        yield* Scope.close(candidate, result)
        return yield* Effect.failCause(result.cause)
      }
      yield* Scope.addFinalizer(owner, Scope.close(candidate, Exit.void))
      return result.value
    }),
  )
}

const layer = (filename: string, scanReaders: number, asyncReadWorker: boolean) =>
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
        // Bun's native SQLite calls are synchronous and run on the JavaScript
        // thread. A multi-second native busy_timeout can deadlock two service
        // graphs in this very process: connection A holds BEGIN IMMEDIATE and
        // needs the event loop to finish its Effect transaction, while
        // connection B blocks that loop for five seconds awaiting A's writer
        // lock. Use a short native wait and yield between safe, atomic
        // application-level retries instead of freezing the owner.
        // The DB-local bootstrap lock already serializes migrations.
        yield* db.run("PRAGMA busy_timeout = 75")
        const journal = yield* db.get<{ journal_mode: string }>("PRAGMA journal_mode")
        if (journal?.journal_mode.toLowerCase() !== "wal") {
          yield* db.run("PRAGMA journal_mode = WAL")
        }
        // Native SQLite defaults to checkpointing in the SAME native thread
        // as whichever foreground COMMIT pushes WAL beyond 1000 pages. That
        // unpredictably extends Session.updatePart's acknowledged writer hold.
        // We already own a periodic, cross-process-elected async checkpoint
        // worker; never let foreground COMMIT do that I/O implicitly.
        if (filename !== ":memory:") yield* db.run("PRAGMA wal_autocheckpoint = 0")
        yield* db.run("PRAGMA synchronous = NORMAL")
        yield* db.run("PRAGMA cache_size = -64000")
        yield* db.run("PRAGMA foreign_keys = ON")
        // Do not checkpoint on the startup-critical writer: a large WAL can
        // require extensive I/O, and the schema-bootstrap lease is held until
        // this service becomes ready. Background maintenance has its own
        // admitted worker and cross-process checkpoint lease.
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
          sqliteLayer({
            filename,
            permitLane: "interactive",
            disableWAL: true,
            checkpointOnClose: false,
            // Native read-only isolation is always enforced. Whether to use
            // Bun's asynchronous worker for interactive history remains
            // configurable: previous 100-Session trials found a material
            // concurrency-throughput cost, despite much better timer latency.
            asyncWorker: asyncReadWorker,
            readonly: true,
            readwrite: false,
            create: false,
          }),
        )
        readDb = yield* makeDatabase.pipe(Effect.provide(readerContext))
        yield* readDb.run("PRAGMA query_only = ON")
        yield* readDb.run("PRAGMA busy_timeout = 250")
        yield* readDb.run("PRAGMA cache_size = -32000")
        yield* readDb.run("PRAGMA foreign_keys = ON")
      }
      // Heavy analytics need queue isolation without paying a fresh native
      // worker/open/configure cost on every request. Keep this lane lazy so
      // ordinary startup still creates only primary + interactive reader.
      // Binding the lazy layer to this service scope prevents the first caller's
      // request scope from owning (and prematurely closing) the connection.
      const lifetimeScope = yield* Effect.scope
      const scanAdmission = yield* Semaphore.make(1)
      let scanConnection: DatabaseShape | undefined
      const scanDb = Effect.fn("Database.scanDb")(function* () {
        if (filename === ":memory:") return db
        if (scanConnection) return scanConnection
        return yield* scanAdmission.withPermits(1)(
          Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
            if (scanConnection) return scanConnection
            // Scope transfer and cache publication are one ownership handoff.
            // Cancellation after setup must not strand a ready but uncached
            // connection in the service scope and let a retry open another.
            const connection = yield* acquireScopedResource<DatabaseShape, never, never>(lifetimeScope, (candidate) =>
              restore(Effect.gen(function* () {
                const scanContext = yield* Layer.buildWithScope(
                  sqliteLayer({
                    filename,
                    permitLane: "scan",
                    disableWAL: true,
                    checkpointOnClose: false,
                    asyncWorker: true,
                    readonly: true,
                    readwrite: false,
                    create: false,
                  }),
                  candidate,
                )
                const connection = yield* makeDatabase.pipe(Effect.provide(scanContext))
                yield* connection.run("PRAGMA query_only = ON")
                yield* connection.run("PRAGMA busy_timeout = 250")
                yield* connection.run("PRAGMA cache_size = -32000")
                yield* connection.run("PRAGMA foreign_keys = ON")
                return connection
              }).pipe(Effect.orDie, Effect.provideService(Scope.Scope, candidate))),
            )
            scanConnection = connection
            return connection
          })).pipe(Effect.orDie),
        )
      })
      // Keep scanDb() as the stable shared identity for existing consumers.
      // The leased API owns a connection until the entire multi-statement read
      // callback (and its WAL snapshot) completes. Opt-in workers only.
      const scanPool = yield* makeLeasedReaderPool(scanReaders, (slot) =>
        scanReaders === 1
          ? scanDb()
          : acquireScopedResource<DatabaseShape, never, never>(lifetimeScope, (candidate) =>
              Effect.gen(function* () {
                const context = yield* Layer.buildWithScope(
                  sqliteLayer({
                    filename,
                    permitLane: "scan-pool",
                    disableWAL: true,
                    checkpointOnClose: false,
                    asyncWorker: true,
                    readonly: true,
                    readwrite: false,
                    create: false,
                  }),
                  candidate,
                )
                const connection = yield* makeDatabase.pipe(Effect.provide(context))
                yield* connection.run("PRAGMA query_only = ON")
                yield* connection.run("PRAGMA busy_timeout = 20")
                yield* connection.run("PRAGMA cache_size = -16000")
                yield* connection.run("PRAGMA foreign_keys = ON")
                return connection
              }).pipe(Effect.orDie, Effect.provideService(Scope.Scope, candidate)),
            ),
      )
      // The process-liveness lane must not compete with foreground SELECTs
      // for the primary connection permit. Reuse one lazy SQLite worker for
      // this database's entire lifetime, not one worker per heartbeat.
      const controlAdmission = yield* Semaphore.make(1)
      let controlConnection: DatabaseShape | undefined
      const controlDb = Effect.fn("Database.controlDb")(function* () {
        if (filename === ":memory:") return db
        if (controlConnection) return controlConnection
        return yield* controlAdmission.withPermits(1)(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              if (controlConnection) return controlConnection
              const connection = yield* acquireScopedResource<DatabaseShape, never, never>(
                lifetimeScope,
                (candidate) =>
                  restore(
                    Effect.gen(function* () {
                      const context = yield* Layer.buildWithScope(
                        sqliteLayer({
                          filename,
                          permitLane: "control",
                          disableWAL: true,
                          checkpointOnClose: false,
                          // Do not block Bun's event loop on a peer WAL writer.
                          asyncWorker: true,
                        }),
                        candidate,
                      )
                       const connection = yield* makeDatabase.pipe(Effect.provide(context))
                       yield* connection.run("PRAGMA busy_timeout = 25")
                       yield* connection.run("PRAGMA wal_autocheckpoint = 0")
                       yield* connection.run("PRAGMA synchronous = NORMAL")
                      yield* connection.run("PRAGMA foreign_keys = ON")
                      return connection
                    }).pipe(Effect.orDie, Effect.provideService(Scope.Scope, candidate)),
                  ),
              )
              controlConnection = connection
              return connection
            }),
          ),
        )
      })
      // Unlike a foreground Session transaction, an OXP activity write is
      // optional observability. Its independent writer has a 350ms BEGIN
      // retry budget and may drop attribution under sustained WAL contention.
      // This separation also ensures a stalled activity transaction never
      // monopolizes the control lane used for leases and interrupts.
      const activityAdmission = yield* Semaphore.make(1)
      let activityConnection: DatabaseShape | undefined
      const activityDb = Effect.fn("Database.activityDb")(function* () {
        if (filename === ":memory:") return db
        if (activityConnection) return activityConnection
        return yield* activityAdmission.withPermits(1)(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              if (activityConnection) return activityConnection
              const connection = yield* acquireScopedResource<DatabaseShape, never, never>(
                lifetimeScope,
                (candidate) =>
                  restore(
                    Effect.gen(function* () {
                      const context = yield* Layer.buildWithScope(
                        sqliteLayer({
                          filename,
                          permitLane: "activity",
                          disableWAL: true,
                          checkpointOnClose: false,
                          asyncWorker: true,
                        }),
                        candidate,
                      )
                      const connection = yield* makeDatabase.pipe(Effect.provide(context))
                      yield* connection.run("PRAGMA busy_timeout = 25")
                      yield* connection.run("PRAGMA wal_autocheckpoint = 0")
                      yield* connection.run("PRAGMA synchronous = NORMAL")
                      yield* connection.run("PRAGMA foreign_keys = ON")
                      return connection
                    }).pipe(Effect.orDie, Effect.provideService(Scope.Scope, candidate)),
                  ),
              )
              activityConnection = connection
              return connection
            }),
          ),
        )
      })
      // The sealer intentionally owns a second SQLite connection so maintenance
      // cannot monopolize the foreground client's single permit. Plain
      // `:memory:` handles are independent databases, not shared connections;
      // forking the file-backed sealer topology here would therefore maintain an
      // empty unrelated database and fail on missing ChunkDB tables.
      if (Flag.OPENCODE_SEAL_ENABLED && filename !== ":memory:") {
        yield* Effect.forkScoped(runSealerLoop(filename).pipe(Effect.ignore))
      }

      // Checkpointing is maintenance owned by this database lifetime. Even a
      // PASSIVE checkpoint can copy many frames: never occupy the foreground
      // connection's admission permit while doing that work. A separate native
      // handle isolates its queue, and zero busy timeout makes maintenance yield
      // instead of waiting on an interactive writer. In-memory databases have
      // no WAL file and must not open a second unrelated database.
      // Multiple ACP/Desktop hosts can share this exact DB, so
      // elect one checkpoint owner per pass instead of multiplying identical
      // housekeeping by host count. The DB-local lock path deliberately avoids
      // XDG_STATE_HOME because Desktop and ACP may use different state roots.
      const checkpoint = checkpointWal(filename).pipe(Effect.exit)
      if (filename !== ":memory:") {
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            // Evaluate physical WAL pressure cheaply while the durable writer
            // runs. With foreground autocheckpoint disabled, five minutes can
            // allow a busy Session/Swarm host to grow a multi-gigabyte WAL.
            // Do not infer outstanding *logical* frames from file size alone:
            // WAL files are reused after successful checkpoints.
            let lastAttemptAt = Number.NEGATIVE_INFINITY
            let previousStatus: WalCheckpointStatus | undefined
            let lastCompleteMarker: WalFileMarker | undefined
            let stalled = false
            for (;;) {
              yield* Effect.sleep(Duration.millis(WAL_CHECK_INTERVAL_MS))
              const observed = yield* Effect.promise(
                () => stat(`${filename}-wal`)
                  .then((value) => ({ size: value.size, modifiedAt: value.mtimeMs }))
                  .catch(() => undefined),
              )
              const now = performance.now()
              if (now - lastAttemptAt < checkpointIntervalMs(
                observed?.size ?? 0,
                stalled,
                unchangedCleanWal(observed, lastCompleteMarker),
              )) continue
              const outcome = yield* checkpoint
              lastAttemptAt = now
              if (Exit.isFailure(outcome)) continue
              const status = outcome.value
              if (!status) continue
              // If the checkpoint cannot make progress, avoid hammering the
              // same pinned reader every minute: it needs a reader gap first.
              stalled = checkpointIsStalled(previousStatus, status)
              previousStatus = status
              if (status.pendingPages === 0 && status.busy === 0) {
                const afterCheckpoint = yield* Effect.promise(
                  () => stat(`${filename}-wal`)
                    .then((value) => ({ size: value.size, modifiedAt: value.mtimeMs }))
                    .catch(() => undefined),
                )
                // A peer can write immediately after our PASSIVE result, but
                // before we observe mtime. Do not mark those newly appended
                // frames as already checkpointed. A stable marker spanning
                // the operation is required to suppress pressure retries.
                lastCompleteMarker = unchangedCleanWal(observed, afterCheckpoint)
                  ? afterCheckpoint
                  : undefined
              } else lastCompleteMarker = undefined
            }
          }),
        )
        // A new, large database may have no sqlite_stat1 entries at all.
        // SQLite 3.46+ bounds PRAGMA optimize's ANALYZE work automatically.
        // Start AFTER migrations, on an isolated worker/connection and only
        // after the foreground has had time to become usable. A second host
        // must never pile a competing ANALYZE onto the primary SQL lane.
        // Missing sqlite_stat1 can cause expensive plans immediately after
        // startup; begin after a short grace period rather than waiting one
        // minute. A busy-writer miss must NOT defer this repair for 24 hours.
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.seconds(10))
            let consecutiveFailures = 0
            for (;;) {
              const result = yield* optimizePlannerStats(filename).pipe(Effect.exit)
              if (Exit.isSuccess(result)) consecutiveFailures = 0
              else {
                consecutiveFailures++
                if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0)
                  yield* Effect.logDebug("SQLite planner statistics maintenance deferred", {
                    failures: consecutiveFailures,
                    cause: result.cause,
                  })
              }
              // Never busy-loop on SQLite writer contention or another host's
              // cross-process maintenance lock; back off but retry well before
              // another 24-hour cycle. Successful runs remain at most daily.
              const delay = consecutiveFailures
                ? Duration.minutes(Math.min(30, 2 ** Math.min(consecutiveFailures - 1, 5)))
                : Duration.hours(24)
              yield* Effect.sleep(delay)
            }
          }),
        )
      }

      return { db, readDb, scanDb, controlDb, activityDb, withScanDb: scanPool.withLease, filename }
    }).pipe(Effect.orDie),
  )

export function layerFromPath(filename: string, options?: { scanReaders?: number; asyncReadWorker?: boolean }) {
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
  // Two lazily opened, independently permitted analytical readers are the
  // tested default. A pathological statement cannot monopolize the only
  // analytics reader; Node's read-only scan processes additionally have hard
  // termination deadlines. Operators can opt down to 1 or up to 4, and
  // :memory: continues to use the primary in-process handle.
  const requested = options?.scanReaders ?? Number(process.env["OPENFORK_EXPERIMENTAL_USAGE_READERS"] ?? 2)
  const scanReaders = filename !== ":memory:" && Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(4, requested))
    : 1
  // Fail-safe default: Bun's synchronous interactive reader can freeze the
  // entire HTTP/OXP event loop during a pathological native SELECT. Route
  // file-backed interactive reads through the bounded, killable async adapter
  // unless explicitly disabled for diagnostic benchmarking.
  const asyncReadWorker = options?.asyncReadWorker ??
    process.env.OPENFORK_SQLITE_ASYNC_READ_WORKER !== "0"
  const databaseLayer = layer(filename, scanReaders, asyncReadWorker).pipe(
    Layer.provide(
      sqliteLayer({
        filename,
        permitLane: "primary",
        // Bun's synchronous sqlite3_step() blocks the entire OXP/HTTP runtime
        // during writer lock waits, CHECKPOINT/DDL, and unexpected SELECT plans.
        // Keep writes acknowledgment-preserving, but execute their native SQL
        // on the existing async Bun worker rather than the event-loop thread.
        // Explicit diagnostic opt-out retains the previous driver.
        asyncWorker: filename !== ":memory:" && process.env.OPENFORK_SQLITE_ASYNC_PRIMARY !== "0",
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
          // A stalled but living peer may still be running a migration.
          // Never allow heartbeat age alone to admit a second schema owner.
          protectLiveProcess: true,
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
// File-backed maintenance defaults to a worker: separating native handles
// without separating execution threads still blocks the shared Session/HTTP
// event loop during heavy SQL. false is a diagnostic-only opt-out.
export function withBackfillDb<A, E, R>(
  filename: string,
  body: (db: DatabaseShape) => Effect.Effect<A, E, R>,
  options?: { readonly busyTimeoutMs?: number; readonly asyncWorker?: boolean },
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
    yield* db.run("PRAGMA wal_autocheckpoint = 0")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA foreign_keys = ON")
    return yield* body(db)
  }).pipe(Effect.provide(sqliteLayer({
    filename,
    permitLane: "maintenance",
    disableWAL: true,
    checkpointOnClose: false,
    asyncWorker: options?.asyncWorker !== false,
  })))
}

/**
 * Background planner statistics, separately admitted from interactive SQL.
 * SQLite's 0x10000 bit examines even tables this fresh connection has not
 * queried; 0x00002 enables bounded ANALYZE where statistics are absent/stale.
 * Never call this from startup bootstrap, a foreground transaction, or on an
 * in-memory handle (a second :memory: connection is a different database).
 */
export function optimizePlannerStats(filename: string): Effect.Effect<void, EffectDrizzleQueryError> {
  if (filename === ":memory:") return Effect.void
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Flock.effect(`planner-optimize:${filename}`, {
        dir: join(dirname(filename), RUNTIME_LOCK_DIRNAME),
        staleMs: 60_000,
        // ANALYZE may outlast heartbeat renewal under host CPU pressure.
        protectLiveProcess: true,
        timeoutMs: 100,
        baseDelayMs: 25,
        maxDelayMs: 50,
      })
      yield* withBackfillDb(
        filename,
        (maintenance) => Effect.gen(function* () {
          // Before SQLite 3.46, optimize could perform unbounded index scans.
          // Never run that older behavior over a multi-gigabyte production DB.
          const version = yield* maintenance.get<{ version: string }>("SELECT sqlite_version() AS version")
          const [major, minor] = (version?.version ?? "").split(".").map(Number)
          if (!(major! > 3 || (major === 3 && minor! >= 46))) return
          yield* maintenance.run("PRAGMA optimize=0x10002")
        }),
        { busyTimeoutMs: 0, asyncWorker: true },
      )
    }),
  )
}

/** Database-owned maintenance; never acquires the foreground connection. */
export interface WalCheckpointStatus {
  readonly busy: number
  readonly log: number
  readonly checkpointed: number
  readonly pendingPages: number
}

export function checkpointWal(
  filename: string,
): Effect.Effect<WalCheckpointStatus | undefined, EffectDrizzleQueryError> {
  if (filename === ":memory:") return Effect.succeed(undefined)
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Flock.effect(`wal-checkpoint:${filename}`, {
        dir: join(dirname(filename), RUNTIME_LOCK_DIRNAME),
        staleMs: 30_000,
        // A peer with a stalled event loop may still be checkpointing WAL.
        protectLiveProcess: true,
        timeoutMs: 100,
        baseDelayMs: 25,
        maxDelayMs: 50,
      })
      return yield* withBackfillDb(
        filename,
        (maintenance) =>
          Effect.gen(function* () {
            // PASSIVE is deliberately non-blocking, but can finish only part
            // of the WAL when long-lived readers pin earlier snapshots.
            // SQLite returns a result row even when a checkpoint is incomplete:
            // ignoring it concealed multi-GB checkpoint starvation.
            const row = yield* maintenance.get<{
              busy: number
              log: number
              checkpointed: number
            }>("PRAGMA wal_checkpoint(PASSIVE)")
            if (!row) return
            const pendingPages = Math.max(0, row.log - row.checkpointed)
            if (row.busy > 0 || pendingPages >= 16_384) {
              // Numeric-only telemetry; no DB paths, query text or binds.
              yield* Effect.logWarning("SQLite WAL checkpoint incomplete", {
                busy: row.busy,
                pages: row.log,
                checkpointed: row.checkpointed,
                pendingPages,
              })
            }
            return { ...row, pendingPages } satisfies WalCheckpointStatus
          }),
        // A checkpoint can scan gigabytes of accumulated WAL. A separate
        // connection alone does not prevent Bun's synchronous sqlite3_step()
        // from freezing the shared Session/HTTP/heartbeat event loop.
        { busyTimeoutMs: 0, asyncWorker: true },
      )
    }),
  )
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
