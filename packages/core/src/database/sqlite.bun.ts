import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Sqlite } from "./sqlite"
import { sqliteExecutionFailureMessage, sqliteFailureLogFields } from "./sqlite-diagnostics"
import { makeSqlitePermitTracker } from "./sqlite-permit-tracker"
import { sqliteQueryOrigin } from "./sqlite-query-origin"
import { isSqliteBusy, retrySqliteBusyCause, sqliteBeginRetryElapsedMs, sqliteRetryableBegin } from "./sqlite-busy"
import { layer as asyncWorkerLayer } from "./sqlite.bun-worker"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@opencode-ai/core/database/SqliteBun" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  /** Select the existing worker-backed driver for this connection only. */
  readonly asyncWorker?: boolean
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  /** Skip the best-effort TRUNCATE checkpoint performed when this handle closes. */
  readonly checkpointOnClose?: boolean
  /** Maximum wait for this process's SQLite connection permit. Not SQLite busy_timeout. */
  readonly acquireTimeoutMs?: number
  readonly permitLane?: string
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
  /**
   * CREATE-TIME-ONLY pragmas applied BEFORE `journal_mode = WAL` on a fresh
   * connection. `page_size` and `auto_vacuum` can only be set before any table
   * exists and before WAL is enabled, so they MUST run here (setting them after
   * WAL is a silent no-op). On an existing DB they are harmless no-ops. Populated
   * by the storage layer (ChunkDB) when its feature flag is on.
   */
  readonly createTimePragmas?: { readonly page_size: number; readonly auto_vacuum: number }
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as Database
    const semaphore = yield* Semaphore.make(1)
    const permit = makeSqlitePermitTracker(semaphore, options.acquireTimeoutMs, options.permitLane)

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined
    const failStatement = (cause: unknown, query: string) => {
      const error = new SqlError({
        reason: classifySqliteError(cause, {
          message: sqliteExecutionFailureMessage(cause, query),
          operation: "execute",
        }),
      })
      const log = isSqliteBusy(cause) ? Effect.logDebug : Effect.logError
      return log("SQLite statement execution failed", sqliteFailureLogFields(cause, query)).pipe(
        Effect.andThen(Effect.fail(error)),
      )
    }

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const endStatement = permit.statement(query, sqliteQueryOrigin(fiber.context))
        // BEGIN is the only SQL operation that can be retried here without
        // replaying user-visible work. If a peer WAL writer owns the SQLite
        // writer slot, a 75-ms native busy_timeout alone turns concurrent
        // Session starts into failures. Keep the same acquired connection
        // permit throughout bounded, Effect-scheduled attempts and never
        // retry statements inside a transaction (especially side effects).
        if (sqliteRetryableBegin(query)) {
          const begin = () => Effect.try({
            try: () => {
              const statement = native.query(query)
              // @ts-ignore bun-types missing safeIntegers method
              statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
              return (statement.all(...(params as any)) ?? []) as Array<Record<string, unknown>>
            },
            catch: (cause) => cause,
          })
          return retrySqliteBusyCause(begin, {
             maxElapsedMs: sqliteBeginRetryElapsedMs(options.permitLane),
            delayMs: 30,
            maxDelayMs: 160,
          }).pipe(
            Effect.catchCause((cause) => failStatement(Cause.squash(cause), query)),
            Effect.ensuring(Effect.sync(endStatement)),
          )
        }
        try {
          const statement = native.query(query)
          // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
          statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
          return Effect.succeed((statement.all(...(params as any)) ?? []) as Array<Record<string, unknown>>)
        } catch (cause) {
          return failStatement(cause, query)
        } finally {
          endStatement()
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) => {
        const endStatement = permit.statement(query, sqliteQueryOrigin(fiber.context))
        try {
          const statement = native.query(query)
          // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
          statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
          return Effect.succeed((statement.values(...(params as any)) ?? []) as Array<unknown[]>)
        } catch (cause) {
          return failStatement(cause, query)
        } finally {
          endStatement()
        }
      })

    const connection = identity<SqliteConnection>({
      execute(query, params, transformRows) {
        return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
      },
      executeRaw(query, params) {
        return run(query, params)
      },
      executeValues(query, params) {
        return runValues(query, params)
      },
      executeUnprepared(query, params, transformRows) {
        return this.execute(query, params, transformRows)
      },
      executeStream() {
        return Stream.die("executeStream not implemented")
      },
      export: Effect.try({
        try: () => native.serialize(),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }),
          }),
      }),
      loadExtension: (path) =>
        Effect.try({
          try: () => native.loadExtension(path),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
            }),
        }),
    })

    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      // An Effect semaphore wait happens BEFORE SQLite sees the statement, so
      // native busy_timeout cannot interrupt a reentrant/cyclic acquisition.
      // Bound that wait independently. Cancellation removes the pending taker;
      // a timeout must never register a release finalizer for a permit it did
      // not acquire.
      // Restore interruptibility around the ENTIRE wait+deadline, not merely
      // semaphore.take(). Otherwise Fiber.interrupt of a queued Session parks
      // until the timeout while the uninterruptible timeout wrapper runs.
      const acquire = restore(permit.take)
      return Effect.as(
        Effect.tap(acquire, () => Scope.addFinalizer(scope, permit.release)),
        connection,
      )
    })
    // Connection admission must own the permit for the entire Effect SQL
    // statement scope. withPermits(1)(Effect.succeed(connection)) releases
    // BEFORE execute() and allows a second Session's query to run inside
    // another fiber's open BEGIN IMMEDIATE transaction on this same handle.
    // Align the synchronous Bun driver with the worker/Node scoped contract.
    const acquirer = transactionAcquirer

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.scoped(Effect.flatMap(acquirer, (_) => _.export)),
        loadExtension: (path: string) => Effect.scoped(Effect.flatMap(acquirer, (_) => _.loadExtension(path))),
      },
    )

    return client
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new Database(config.filename, {
        readonly: config.readonly,
        readwrite: config.readwrite ?? true,
        create: config.create ?? true,
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (config.checkpointOnClose !== false) {
            try {
              native.run("PRAGMA wal_checkpoint(TRUNCATE)")
            } catch {}
          }
          try {
            native.close()
          } catch {}
          try {
            // drizzle-orm/bun-sqlite caches prepared statements that keep the file handle alive on Windows
            // until GC. Force a GC so the handle is released before a pending compact swap tries to rename.
            const maybeBun = (globalThis as unknown as { Bun?: { gc: (force: boolean) => void } }).Bun
            maybeBun?.gc(true)
          } catch {}
        }),
      )
      // Create-time-only pragmas MUST precede WAL: page_size/auto_vacuum are
      // silent no-ops once WAL is enabled or any table exists. On existing DBs
      // they are harmless no-ops, so applying unconditionally is safe. Two
      // embedded hosts can still open the same brand-new path concurrently
      // before DatabaseMigration's higher-level semaphore exists. In that tiny
      // window one handle can report SQLITE_BUSY while the other owns the file
      // header transition. These pragmas are storage tuning, not correctness;
      // the winning initializer applies them. Do not turn that race into a
      // startup failure for the losing handle.
      if (config.createTimePragmas) {
        const runCreateTime = (statement: string) => {
          try {
            native.run(statement)
          } catch (error) {
            const sqlite = error as { code?: string; errno?: number }
            if (sqlite?.code === "SQLITE_BUSY" || sqlite?.errno === 5) return
            throw error
          }
        }
        runCreateTime(`PRAGMA page_size = ${config.createTimePragmas.page_size}`)
        runCreateTime(`PRAGMA auto_vacuum = ${config.createTimePragmas.auto_vacuum}`)
      }
      if (config.disableWAL !== true) native.run("PRAGMA journal_mode = WAL;")
      return native
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Sqlite.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Sqlite.Native) as Database })
  }),
)

export const synchronousLayer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(sqliteLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}

// Explicit migration gate: validate source-mode and the packaged single-file
// worker entrypoint before selecting the asynchronous storage driver in release
// builds. The existing synchronous driver remains the safe default for now.
// Both implement the same Effect SqlClient and transaction-lifetime contract.
export const layer = (config: Config) =>
  config.asyncWorker === true || process.env.OPENFORK_SQLITE_ASYNC_WORKER === "1"
    ? asyncWorkerLayer(config)
    : synchronousLayer(config)
