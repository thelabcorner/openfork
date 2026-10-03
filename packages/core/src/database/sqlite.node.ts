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
import { SqliteWorkerClient } from "./sqlite-worker-client"

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
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly timeout?: number
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
    const native = (yield* Sqlite.Native) as SqliteWorkerClient

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
      return Effect.logError("SQLite statement execution failed", sqliteFailureLogFields(cause, query)).pipe(
        Effect.andThen(Effect.fail(error)),
      )
    }

    const execute = (query: string, params: ReadonlyArray<unknown>, arrays: boolean) =>
      Effect.withFiber<unknown, SqlError>((fiber) =>
        Effect.tryPromise({
          try: () => native.request({
            kind: "query", query, params, arrays,
            safeIntegers: Context.get(fiber.context, Client.SafeIntegers),
          }),
          catch: (cause) => cause,
        }).pipe(Effect.catch((cause) => failStatement(cause, query))),
      ).pipe(
        // Native SQL cannot be cancelled halfway through execution. Wait for
        // its acknowledgement before rollback/release, just as the synchronous
        // driver did, while letting the sidecar event loop serve control work.
        Effect.uninterruptible,
      )
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

    const semaphore = yield* Semaphore.make(1)
    // Statement acquisition is scoped by Effect SQL. Keep the permit through
    // asynchronous execution; releasing it after merely returning the connection
    // would allow another fiber's SQL to enter the same transaction.
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
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
      const native = new SqliteWorkerClient(config)
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
