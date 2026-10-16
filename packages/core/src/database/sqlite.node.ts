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
import { sqlitePlanProbeFingerprint } from "./sqlite-query-forensics"
import { sqliteQueryOrigin } from "./sqlite-query-origin"
import { isSqliteBusy, retrySqliteBusyCause, sqliteBeginRetryElapsedMs, sqliteRetryableBegin } from "./sqlite-busy"
import { SqliteWorkerClient } from "./sqlite-worker-client"
import { SqliteScanProcessClient } from "./sqlite-scan-process"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@opencode-ai/core/database/SqliteNode" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  /** Bun-only lane selection; Node already executes SQLite on a worker. */
  readonly asyncWorker?: boolean
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly timeout?: number
  readonly acquireTimeoutMs?: number
  readonly permitLane?: string
  /** Deadline for a disposable read-only analytical query, never writes. */
  readonly queryTimeoutMs?: number
  readonly allowExtension?: boolean
  /** Skip the best-effort TRUNCATE checkpoint performed when this handle closes. */
  readonly checkpointOnClose?: boolean
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
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as SqliteWorkerClient & {
      cancelActive?: () => void
    }
    const killableScan = options.readonly === true &&
      (options.permitLane === "scan" || options.permitLane === "scan-pool" ||
        options.permitLane === "interactive") &&
      options.filename !== ":memory:"
    const semaphore = yield* Semaphore.make(1)
    const permit = makeSqlitePermitTracker(semaphore, options.acquireTimeoutMs, options.permitLane, {
      worker: () => native.activitySnapshot(),
    })

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

    const execute = (query: string, params: ReadonlyArray<unknown>, arrays: boolean) => {
      const statement = Effect.withFiber<unknown, SqlError>((fiber) => {
        const endStatement = permit.statement(query, sqliteQueryOrigin(fiber.context))
        const request = () => Effect.tryPromise({
          try: () => native.request({
            kind: "query", query, params, arrays,
            diagnosePlan: sqlitePlanProbeFingerprint(query),
            safeIntegers: Context.get(fiber.context, Client.SafeIntegers),
          }),
          catch: (cause) => cause,
        })
        // SQLite BEGIN is safe to retry without replaying transaction work.
        // Never replay writes or terminal COMMIT/ROLLBACK operations.
        return (sqliteRetryableBegin(query)
          ? retrySqliteBusyCause(request, {
              maxElapsedMs: sqliteBeginRetryElapsedMs(options.permitLane),
              delayMs: 30,
              maxDelayMs: 160,
            })
          : request()).pipe(
          Effect.catch((cause) => failStatement(cause, query)),
          Effect.ensuring(Effect.sync(endStatement)),
        )
      })
      // A disposable read-only subprocess can be killed *before* the permit
      // is released. Writable transactions still wait for native ACK because
      // losing their COMMIT/ROLLBACK outcome would corrupt ownership.
      return killableScan
        ? statement.pipe(Effect.onInterrupt(() => Effect.sync(() => native.cancelActive?.())))
        : statement.pipe(Effect.uninterruptible)
    }
    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      execute(query, params, false) as Effect.Effect<Array<Record<string, unknown>>, SqlError>
    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      execute(query, params, true) as Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>

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
      loadExtension: (path) =>
        Effect.tryPromise({
          try: () => native.request({ kind: "extension", path }).then(() => undefined),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
            }),
        }).pipe(Effect.uninterruptible),
    })

    // Statement acquisition is scoped by Effect SQL. Keep the permit through
    // asynchronous execution; releasing it after merely returning the connection
    // would allow another fiber's SQL to enter the same transaction.
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(permit.take), () =>
          Scope.addFinalizer(scope, permit.release)),
        connection,
      )
    })
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
        loadExtension: (path: string) => Effect.scoped(Effect.flatMap(acquirer, (_) => _.loadExtension(path))),
      },
    )

    return client
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      // Only explicitly read-only connections can be discarded without risking
      // an unacknowledged write or transaction. Interactive history and scans
      // are killable OS subprocesses; the primary writer and control writers
      // keep their acknowledgment-preserving native workers.
      const killableScan = config.readonly === true &&
        (config.permitLane === "scan" || config.permitLane === "scan-pool" ||
          config.permitLane === "interactive") &&
        config.filename !== ":memory:"
      const native = killableScan
        ? new SqliteScanProcessClient(config)
        : new SqliteWorkerClient(config)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => native.close()).pipe(Effect.ignore),
      )
      yield* Effect.tryPromise({
        try: () => native.ready,
        catch: (cause) => new SqlError({ reason: classifySqliteError(cause, { message: "Failed to open SQLite worker", operation: "open" }) }),
      })
      return native
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, sqliteLayer(config).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}
