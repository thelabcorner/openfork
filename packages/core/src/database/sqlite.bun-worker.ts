/**
 * Worker-backed Bun SQLite adapter. Native calls are synchronous *inside the
 * worker*, never on the HTTP/ACP/Effect runtime's main JS thread. The scoped
 * connection permit stays held until the native SQL acknowledgement arrives,
 * including during cancellation and transaction rollback.
 */
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
import { SqliteBunWorkerClient } from "./sqlite-bun-worker-client"
import { SqliteScanProcessClient } from "./sqlite-scan-process"
import { sqliteExecutionFailureMessage, sqliteFailureLogFields } from "./sqlite-diagnostics"
import { isSqliteBusy, retrySqliteBusyCause, sqliteBeginRetryElapsedMs, sqliteRetryableBegin } from "./sqlite-busy"
import { makeSqlitePermitTracker } from "./sqlite-permit-tracker"
import { sqlitePlanProbeFingerprint } from "./sqlite-query-forensics"
import { sqliteQueryOrigin } from "./sqlite-query-origin"
import type { SqliteWorkerOptions } from "./sqlite-worker-client"

const TypeId = "~@opencode-ai/core/database/SqliteBunWorker" as const
interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: typeof TypeId
  readonly config: SqliteWorkerOptions
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

const make = (options: SqliteWorkerOptions) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as SqliteBunWorkerClient & {
      cancelActive?: () => void
    }
    const killableRead = options.readonly === true &&
      ["scan", "scan-pool", "interactive"].includes(options.permitLane ?? "") &&
      options.filename !== ":memory:"
    const semaphore = yield* Semaphore.make(1)
    const permit = makeSqlitePermitTracker(semaphore, options.acquireTimeoutMs, options.permitLane)
    const compiler = Statement.makeCompilerSqlite()

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
            kind: "query",
            query,
            params,
            arrays,
            diagnosePlan: sqlitePlanProbeFingerprint(query),
            safeIntegers: Context.get(fiber.context, Client.SafeIntegers),
          }),
          catch: (cause) => cause,
        })
        // A failed BEGIN has not performed any user work. A second WAL writer
        // can legitimately hold the slot while our worker is waiting; retry
        // *only* this atomic admission operation on the Effect scheduler.
        // Never retry writes or COMMIT/ROLLBACK, whose outcomes are ambiguous.
        // Use one acquired connection permit for the full bounded retry so
        // another transaction cannot interleave on this native worker.
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
      return killableRead
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
      executeRaw(query, params) { return run(query, params) },
      executeValues(query, params) { return runValues(query, params) },
      executeUnprepared(query, params, transformRows) { return this.execute(query, params, transformRows) },
      executeStream() { return Stream.die("executeStream not implemented") },
      export: Effect.tryPromise({
        try: () => native.request<Uint8Array>({ kind: "serialize" }),
        catch: (cause) =>
          new SqlError({ reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }) }),
      }).pipe(Effect.uninterruptible),
      loadExtension: (path: string) =>
        Effect.tryPromise({
          try: () => native.request({ kind: "extension", path }).then(() => undefined),
          catch: (cause) =>
            new SqlError({ reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }) }),
        }).pipe(Effect.uninterruptible),
    })

    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      // Worker RPC is asynchronous, but connection admission can still park
      // on an Effect semaphore indefinitely before SQLite sees a statement.
      // Restore interruptibility around the entire deadline+wait so a caller
      // can cancel without waiting for the entire timeout to elapse.
      const acquire = restore(permit.take)
      return Effect.as(
        Effect.tap(acquire, () => Scope.addFinalizer(scope, permit.release)),
        connection,
      )
    })
    const acquirer = transactionAcquirer

    return Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [["db.system.name", "sqlite"]],
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.scoped(Effect.flatMap(acquirer, (_) => _.export)),
        loadExtension: (path: string) => Effect.scoped(Effect.flatMap(acquirer, (_) => _.loadExtension(path))),
      },
    )
  })

const nativeLayer = (config: SqliteWorkerOptions) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const killableRead = config.readonly === true &&
        ["scan", "scan-pool", "interactive"].includes(config.permitLane ?? "") &&
        config.filename !== ":memory:"
      const native = killableRead
        ? new SqliteScanProcessClient(config)
        : new SqliteBunWorkerClient(config)
      yield* Effect.addFinalizer(() => Effect.promise(() => native.close()).pipe(Effect.ignore))
      yield* Effect.tryPromise({
        try: () => native.ready,
        catch: (cause) => new SqlError({
          reason: classifySqliteError(cause, { message: "Failed to open Bun SQLite worker", operation: "open" }),
        }),
      })
      return native
    }).pipe(Effect.orDie),
  )

export const layer = (config: SqliteWorkerOptions) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}