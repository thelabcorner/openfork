import { Effect, Layer } from "effect"
import { OxpRuntimeV1 } from "./runtime-v1"
import { OxpWorkerControl } from "./worker-control"

async function runtimeModules() {
  const [
    { DelegatedWorker },
    { SessionGroup },
    { SessionID },
  ] = await Promise.all([
    import("@/session/delegated-worker"),
    import("@/session/group"),
    import("@/session/schema"),
  ])
  return { DelegatedWorker, SessionGroup, SessionID }
}

const guard = (target: OxpWorkerControl.Target) =>
  OxpRuntimeV1.commitGuard(
    target,
    "OXP delegation authority revalidation failed",
  )

const enter = <A>(
  target: OxpWorkerControl.Target,
  build: (
    runtime: Awaited<ReturnType<typeof runtimeModules>>,
  ) => Effect.Effect<A, unknown, any>,
) =>
  OxpRuntimeV1.enter(
    target,
    async () => build(await runtimeModules()),
    "Native delegated-worker operation failed",
  )

function mapWorkerError(
  runtime: Awaited<ReturnType<typeof runtimeModules>>,
  error: unknown,
): Error {
  if (error instanceof runtime.DelegatedWorker.InvalidWorker) {
    return new OxpWorkerControl.InvalidWorker()
  }
  if (error instanceof runtime.DelegatedWorker.SelectionMismatch) {
    return new OxpWorkerControl.SelectionUnavailable(
      error.message.includes("account"),
      error.message,
    )
  }
  if (error instanceof runtime.DelegatedWorker.StartCommitted) {
    return new OxpWorkerControl.StartCommitted(String(error.sessionID))
  }
  if (error instanceof runtime.DelegatedWorker.ContinueCommitted) {
    return new OxpWorkerControl.ContinueCommitted(String(error.sessionID))
  }
  return error instanceof Error
    ? error
    : new Error("Native delegated-worker operation failed")
}

function snapshot(
  value: import("@/session/delegated-worker").DelegatedWorker.Snapshot,
): OxpWorkerControl.Snapshot {
  return {
    workerID: String(value.sessionID),
    state: value.state,
    ...(value.generation !== undefined
      ? { generation: value.generation }
      : {}),
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
    ...(value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
    ...(value.completedAt !== undefined
      ? { completedAt: value.completedAt }
      : {}),
    recovered: value.recovered,
  }
}

const start: OxpWorkerControl.Interface["start"] = (target, input) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const worker = yield* runtime.DelegatedWorker.make
        const session = yield* worker
          .start({
            title: input.title,
            prompt: input.prompt,
            agent: input.agent,
            model: input.model,
            origin: input.origin,
            beforeCommit: guard(target),
          })
          .pipe(
            Effect.mapError((error) => mapWorkerError(runtime, error)),
          )
        return { workerID: String(session.id) }
      }),
  )

const continueWorker: OxpWorkerControl.Interface["continue"] = (
  target,
  input,
) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const worker = yield* runtime.DelegatedWorker.make
        yield* worker
          .continue({
            sessionID: runtime.SessionID.make(input.workerID),
            prompt: input.prompt,
            identity: input.identity,
            invocationRef: input.invocationRef,
            nestedDelegation: input.nestedDelegation,
            ...(input.expectedModel
              ? { expectedModel: input.expectedModel }
              : {}),
            ...(input.expectedAgent
              ? { expectedAgent: input.expectedAgent }
              : {}),
            beforeCommit: guard(target),
          })
          .pipe(
            Effect.mapError((error) => mapWorkerError(runtime, error)),
          )
        return snapshot(
          yield* worker
            .snapshot(
              runtime.SessionID.make(input.workerID),
              input.identity,
            )
            .pipe(
              Effect.mapError((error) => mapWorkerError(runtime, error)),
            ),
        )
      }),
  )

const wait: OxpWorkerControl.Interface["wait"] = (target, input) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const worker = yield* runtime.DelegatedWorker.make
        return snapshot(
          yield* worker
            .wait({
              sessionID: runtime.SessionID.make(input.workerID),
              identity: input.identity,
              ...(input.timeoutMs !== undefined
                ? { timeout: input.timeoutMs }
                : {}),
            })
            .pipe(
              Effect.mapError((error) => mapWorkerError(runtime, error)),
            ),
        )
      }),
  )

const result: OxpWorkerControl.Interface["result"] = (target, input) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const worker = yield* runtime.DelegatedWorker.make
        return snapshot(
          yield* worker
            .result({
              sessionID: runtime.SessionID.make(input.workerID),
              identity: input.identity,
            })
            .pipe(
              Effect.mapError((error) => mapWorkerError(runtime, error)),
            ),
        )
      }),
  )

const cancel: OxpWorkerControl.Interface["cancel"] = (target, input) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const worker = yield* runtime.DelegatedWorker.make
        yield* guard(target)
        return snapshot(
          yield* worker
            .cancel({
              sessionID: runtime.SessionID.make(input.workerID),
              identity: input.identity,
            })
            .pipe(
              Effect.mapError((error) => mapWorkerError(runtime, error)),
            ),
        )
      }),
  )

const batchStart: OxpWorkerControl.Interface["batchStart"] = (
  target,
  input,
) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const worker = yield* runtime.DelegatedWorker.make
        const groups = yield* runtime.SessionGroup.Service
        const workerIDs: string[] = []

        for (const item of input.workers) {
          const started = yield* worker
            .start({
              title: item.title,
              prompt: item.prompt,
              agent: item.agent,
              model: item.model,
              origin: item.origin,
              beforeCommit: guard(target),
            })
            .pipe(
              Effect.mapError((error) => {
                const mapped = mapWorkerError(runtime, error)
                if (mapped instanceof OxpWorkerControl.StartCommitted) {
                  return new OxpWorkerControl.BatchCommitted([
                    ...workerIDs,
                    mapped.workerID,
                  ])
                }
                return new OxpWorkerControl.BatchCommitted(
                  workerIDs,
                  undefined,
                  mapped.message,
                )
              }),
            )
          workerIDs.push(String(started.id))
        }

        const group = yield* Effect.gen(function* () {
          yield* guard(target)
          return yield* groups.create({
            name: input.name,
            kind: "delegation",
            ownerRef: input.ownerRef,
            policy: {
              autoAddDescendants: false,
              lockAdded: true,
              autoDeleteWhenEmpty: true,
            },
          })
        }).pipe(
          Effect.mapError(
            (error) =>
              new OxpWorkerControl.BatchCommitted(
                workerIDs,
                undefined,
                error instanceof Error ? error.message : String(error),
              ),
          ),
        )

        for (const workerID of workerIDs) {
          yield* Effect.gen(function* () {
            yield* guard(target)
            yield* groups.addSession({
              groupId: group.id,
              sessionId: workerID,
              locked: true,
              origin: "delegation",
              originRef: input.ownerRef,
            })
          }).pipe(
            Effect.mapError(
              (error) =>
                new OxpWorkerControl.BatchCommitted(
                  workerIDs,
                  String(group.id),
                  error instanceof Error ? error.message : String(error),
                ),
            ),
          )
        }

        return {
          batchID: String(group.id),
          workerIDs,
        }
      }),
  )

const batchContinue: OxpWorkerControl.Interface["batchContinue"] = (
  target,
  input,
) =>
  Effect.gen(function* () {
    const snapshots: OxpWorkerControl.Snapshot[] = []
    const committed: string[] = []
    for (const item of input.items) {
      const current = yield* continueWorker(target, {
        ...item,
        identity: input.identity,
      }).pipe(
        Effect.mapError((error) => {
          if (error instanceof OxpWorkerControl.ContinueCommitted) {
            return new OxpWorkerControl.BatchCommitted(
              [...committed, error.workerID],
              undefined,
              error.message,
            )
          }
          return committed.length > 0
            ? new OxpWorkerControl.BatchCommitted(
                committed,
                undefined,
                error.message,
              )
            : error
        }),
      )
      snapshots.push(current)
      committed.push(item.workerID)
    }
    return snapshots
  })

const batchWait: OxpWorkerControl.Interface["batchWait"] = (
  target,
  input,
) =>
  Effect.forEach(
    input.workerIDs,
    (workerID) =>
      wait(target, {
        workerID,
        identity: input.identity,
        ...(input.timeoutMs !== undefined
          ? { timeoutMs: input.timeoutMs }
          : {}),
      }),
    { concurrency: 4 },
  )

const batchCancel: OxpWorkerControl.Interface["batchCancel"] = (
  target,
  input,
) =>
  Effect.gen(function* () {
    const snapshots: OxpWorkerControl.Snapshot[] = []
    const committed: string[] = []
    for (const workerID of input.workerIDs) {
      const current = yield* cancel(target, {
        workerID,
        identity: input.identity,
      }).pipe(
        Effect.mapError((error) =>
          committed.length > 0
            ? new OxpWorkerControl.BatchCommitted(
                committed,
                undefined,
                error.message,
              )
            : error,
        ),
      )
      snapshots.push(current)
      committed.push(workerID)
    }
    return snapshots
  })

const resolveSelection: OxpWorkerControl.Interface["resolveSelection"] = (
  target,
  input,
) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const worker = yield* runtime.DelegatedWorker.make
        return yield* worker
          .resolveSelection(input.agent, input.model)
          .pipe(
            Effect.mapError((error) => mapWorkerError(runtime, error)),
          )
      }),
  )

export const layer = Layer.succeed(
  OxpWorkerControl.Service,
  OxpWorkerControl.Service.of({
    resolveSelection,
    start,
    continue: continueWorker,
    wait,
    result,
    cancel,
    batchStart,
    batchContinue,
    batchWait,
    batchCancel,
  }),
)

export * as OxpWorkerControlV1 from "./worker-control-v1"
