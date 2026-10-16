import { Cause, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { OxpSessionControl } from "./session-control"
import { OxpRuntimeV1 } from "./runtime-v1"
import { requireResumeReady } from "@/session/resume-recovery"

type BasicAction = "pause" | "resume" | "abort" | "archive" | "unarchive" | "delete"

type PromptWaitResult = {
  readonly paused: boolean
  readonly resultMessageID?: string
}

type StartedPrompt = {
  readonly admittedMessageID: string
  readonly paused: boolean
  readonly fiber?: Fiber.Fiber<PromptWaitResult, unknown>
}

async function runtimeModules() {
  const [
    { Session },
    { SessionPrompt },
    { SessionExecutionOwner },
    { SessionID },
    { SessionV2, SessionSchema },
    { ModelV2 },
    { ProviderV2 },
    { Provider },
    { Agent },
    { BackgroundJob },
     { Todo },
    { SessionTurnProvenance },
    { SessionInput },
    { SessionMessage },
    { SessionMetadataOwnership },
    { CheckpointTool },
    { GoalAgent },
    { MessageID },
  ] = await Promise.all([
    import("@/session/session"),
    import("@/session/prompt"),
    import("@opencode-ai/core/session/execution-owner"),
    import("@/session/schema"),
    import("@opencode-ai/core/session"),
    import("@opencode-ai/core/model"),
    import("@opencode-ai/core/provider"),
    import("@/provider/provider"),
    import("@/agent/agent"),
    import("@/background/job"),
    import("@/session/todo"),
    import("@opencode-ai/core/v1/session-turn-provenance"),
    import("@opencode-ai/core/session/input"),
    import("@opencode-ai/schema/session-message"),
    import("@opencode-ai/core/session/metadata-ownership"),
    import("@/tool/checkpoint"),
    import("@opencode-ai/core/goal/agent"),
    import("@/session/schema"),
  ])
  return {
    Session,
    SessionPrompt,
    SessionExecutionOwner,
    SessionID,
    SessionV2,
    SessionSchema,
    ModelV2,
    ProviderV2,
    Provider,
    Agent,
    BackgroundJob,
    Todo,
    SessionTurnProvenance,
    SessionInput,
    SessionMessage,
    SessionMetadataOwnership,
    CheckpointTool,
    GoalAgent,
    MessageID,
  }
}

const enter = <A>(
  target: OxpSessionControl.Target,
  build: (runtime: Awaited<ReturnType<typeof runtimeModules>>) => Effect.Effect<A, unknown, any>,
) =>
  OxpRuntimeV1.enter(
    target,
    async () => build(await runtimeModules()),
    "Native Session runtime control failed",
  )

function provenance(
  runtime: Awaited<ReturnType<typeof runtimeModules>>,
  actorRef: string,
) {
  return {
    owner: "host" as const,
    source: runtime.SessionTurnProvenance.Source.OxpSupervisor,
    ref: actorRef,
  }
}

const commitGuard = (target: OxpSessionControl.Target) =>
  OxpRuntimeV1.commitGuard(
    target,
    "OXP Session authority revalidation failed",
  )

const setSelection = (
  target: OxpSessionControl.Target,
  input: OxpSessionControl.SelectionInput,
) =>
  enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const sessions = yield* runtime.SessionV2.Service
        const provider = yield* runtime.Provider.Service
        const sessionID = runtime.SessionSchema.ID.make(target.sessionID)
        yield* sessions.get(sessionID)
        const actor = provenance(runtime, input.actorRef)

        const providerID = runtime.ProviderV2.ID.make(input.model.providerID)
        const modelID = runtime.ModelV2.ID.make(input.model.modelID)
        const accountID = input.model.accountID
          ? yield* provider
              .resolveAccountID(providerID, input.model.accountID)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new OxpSessionControl.SelectionUnavailable(
                      "provider-account",
                      error.message,
                    ),
                ),
              )
          : undefined
        const resolved = yield* provider
          .getModel(providerID, modelID, accountID)
          .pipe(
            Effect.mapError(
              () =>
                new OxpSessionControl.SelectionUnavailable(
                  accountID ? "provider-account" : "model",
                  accountID
                    ? "Requested provider account/model selection is unavailable"
                    : "Requested model selection is unavailable",
                ),
            ),
          )

        if (!runtime.Provider.isLanguageModel(resolved)) {
          return yield* Effect.fail(
            new OxpSessionControl.SelectionUnavailable(
              "model",
              "Requested model is not a conversational language model",
            ),
          )
        }

        if (
          input.model.variant &&
          input.model.variant !== "default" &&
          resolved.variants &&
          !(input.model.variant in resolved.variants)
        ) {
          return yield* Effect.fail(
            new OxpSessionControl.SelectionUnavailable(
              "model",
              "Requested model variant is unavailable",
            ),
          )
        }

        yield* commitGuard(target)
        yield* sessions.switchModel({
          sessionID,
          model: runtime.ModelV2.Ref.make({
            providerID,
            id: modelID,
            ...(accountID ? { accountID } : {}),
            ...(input.model.variant
              ? { variant: runtime.ModelV2.VariantID.make(input.model.variant) }
              : {}),
          }),
          provenance: actor,
        })
      }),
  )

const ensurePromptSelection = (
  runtime: Awaited<ReturnType<typeof runtimeModules>>,
  target: OxpSessionControl.Target,
  actorRef: string,
) =>
  Effect.gen(function* () {
    const sessions = yield* runtime.SessionV2.Service
    const provider = yield* runtime.Provider.Service
    const agents = yield* runtime.Agent.Service
    const sessionID = runtime.SessionSchema.ID.make(target.sessionID)
    let current = yield* sessions.get(sessionID)
    const actor = provenance(runtime, actorRef)

    let agent = current.agent ? String(current.agent) : undefined
    if (!agent) {
      agent = yield* agents.defaultAgent()
      yield* commitGuard(target)
      yield* sessions.switchAgent({ sessionID, agent, provenance: actor })
      current = yield* sessions.get(sessionID)
    }

    let model = current.model
    if (!model) {
      const fallback = yield* provider.defaultModel()
      model = runtime.ModelV2.Ref.make({
        providerID: fallback.providerID,
        id: fallback.modelID,
      })
      yield* commitGuard(target)
      yield* sessions.switchModel({ sessionID, model, provenance: actor })
    }

    return {
      agent,
      model: {
        providerID: model.providerID,
        modelID: model.id,
        ...(model.accountID ? { accountID: model.accountID } : {}),
        ...(model.variant ? { variant: model.variant } : {}),
      },
    }
  })

const assertOxpPromptable = (
  runtime: Awaited<ReturnType<typeof runtimeModules>>,
  session: { readonly id: string; readonly parentID?: string; readonly metadata?: Readonly<Record<string, unknown>> },
) =>
  Effect.gen(function* () {
    const metadata = session.metadata
    const specialAgent = runtime.SessionMetadataOwnership.specialAgentKind(metadata)
    const kind =
      specialAgent ??
      (runtime.SessionMetadataOwnership.hasScheduledTaskOrigin(metadata)
        ? "scheduled_task"
        : runtime.SessionMetadataOwnership.hasWorkerDelegationOrigin(metadata)
          ? "delegated_worker"
          : undefined)
    if (!kind) return
    return yield* Effect.fail(
      new OxpSessionControl.HostOwned(
        String(session.id),
        String(session.parentID ?? session.id),
        String(kind),
      ),
    )
  })

const selectedExecution = (
  runtime: Awaited<ReturnType<typeof runtimeModules>>,
  selected: {
    readonly agent: string
    readonly model: {
      readonly providerID: string
      readonly modelID: string
      readonly accountID?: string
      readonly variant?: string
    }
  },
) =>
  runtime.ModelV2.Ref.make({
    providerID: runtime.ProviderV2.ID.make(selected.model.providerID),
    id: runtime.ModelV2.ID.make(selected.model.modelID),
    ...(selected.model.accountID ? { accountID: selected.model.accountID } : {}),
    ...(selected.model.variant
      ? { variant: runtime.ModelV2.VariantID.make(selected.model.variant) }
      : {}),
  })

const startSteer = (
  target: OxpSessionControl.Target,
  input: OxpSessionControl.PromptInput,
) =>
  enter<OxpSessionControl.PromptResult>(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const v1Sessions = yield* runtime.Session.Service
        const prompt = yield* runtime.SessionPrompt.Service
        const sessionID = runtime.SessionID.make(target.sessionID)
        const before = yield* v1Sessions.get(sessionID)
        yield* assertOxpPromptable(runtime, before)

        const selected = yield* ensurePromptSelection(runtime, target, input.actorRef)
        yield* commitGuard(target)
        const admitted = yield* prompt
          .steer(
            {
              sessionID,
              agent: selected.agent,
              model: {
                providerID: runtime.ProviderV2.ID.make(selected.model.providerID),
                modelID: runtime.ModelV2.ID.make(selected.model.modelID),
                ...(selected.model.accountID ? { accountID: selected.model.accountID } : {}),
              },
              ...(selected.model.variant ? { variant: selected.model.variant } : {}),
              parts: [{ type: "text", text: input.text }],
            },
            {
              source: runtime.SessionTurnProvenance.Source.OxpSupervisor,
              ref: input.actorRef,
            },
          )
          .pipe(
            Effect.mapError((error) =>
              error instanceof runtime.SessionPrompt.HostOwnedSessionError
                ? new OxpSessionControl.HostOwned(
                    String(error.sessionID),
                    String(error.parentID),
                    String(error.kind),
                  )
                : error,
            ),
          )
        const current = yield* v1Sessions.get(sessionID)
        return {
          admittedMessageID: String(admitted.info.id),
          paused: current.pausedAt !== undefined,
        }
      }),
  )

const startQueuedPrompt = (
  scope: Scope.Scope,
  target: OxpSessionControl.Target,
  input: OxpSessionControl.PromptInput,
  waitForExactTurn: boolean,
) =>
  enter<StartedPrompt>(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const v1Sessions = yield* runtime.Session.Service
        const prompt = yield* runtime.SessionPrompt.Service
        const sessionID = runtime.SessionID.make(target.sessionID)
        const before = yield* v1Sessions.get(sessionID)
        yield* assertOxpPromptable(runtime, before)

        const selected = yield* ensurePromptSelection(runtime, target, input.actorRef)
        const executionModel = selectedExecution(runtime, selected)
        yield* commitGuard(target)
        const admitted = yield* prompt
          .admitSynthetic({
            id: runtime.SessionMessage.ID.create(),
            sessionID,
            content: { text: input.text },
            origin: runtime.SessionInput.SyntheticOrigin.make({
              producer: runtime.SessionTurnProvenance.Source.OxpSupervisor,
              actor: { type: "host" },
              ref: input.actorRef,
            }),
            admissionClass: "host",
            delivery: "queue",
            execution: {
              agent: selected.agent,
              model: executionModel,
            },
          })
          .pipe(
            Effect.mapError((error) =>
              error instanceof runtime.SessionPrompt.HostOwnedSessionError
                ? new OxpSessionControl.HostOwned(
                    String(error.sessionID),
                    String(error.parentID),
                    String(error.kind),
                  )
                : error,
            ),
          )

        const admittedMessageID = String(admitted.id)
        const current = yield* v1Sessions.get(sessionID)
        if (current.pausedAt !== undefined || !waitForExactTurn) {
          return {
            admittedMessageID,
            paused: current.pausedAt !== undefined,
          }
        }

        const exact = Effect.gen(function* () {
          while (true) {
            const completed = yield* v1Sessions.findMessage(
              sessionID,
              (message) =>
                message.info.role === "assistant" &&
                String(message.info.parentID) === admittedMessageID &&
                (message.info.time.completed !== undefined || message.info.error !== undefined),
            )
            if (Option.isSome(completed)) {
              return {
                paused: false,
                resultMessageID: String(completed.value.info.id),
              } satisfies PromptWaitResult
            }

            const state = yield* v1Sessions.get(sessionID)
            if (state.pausedAt !== undefined) {
              return { paused: true } satisfies PromptWaitResult
            }

            // admitSynthetic already owns durable wake/recovery semantics. Poll
            // only the exact assistant boundary so this waiter cannot accidentally
            // settle on an older run or over-wait for later queued turns.
            yield* Effect.sleep("50 millis")
          }
        })
        const fiber = yield* exact.pipe(Effect.forkIn(scope, { startImmediately: true }))
        return {
          admittedMessageID,
          paused: false,
          fiber,
        }
      }),
  )

async function waitForPrompt(
  started: StartedPrompt,
  signal?: AbortSignal,
): Promise<OxpSessionControl.PromptResult> {
  if (started.paused || !started.fiber) {
    return {
      admittedMessageID: started.admittedMessageID,
      paused: started.paused,
    }
  }

  const wait = Effect.runPromise(Fiber.await(started.fiber))
  if (!signal) {
    const exit = await wait
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    return {
      admittedMessageID: started.admittedMessageID,
      paused: exit.value.paused,
      ...(exit.value.resultMessageID ? { resultMessageID: exit.value.resultMessageID } : {}),
    }
  }

  if (signal.aborted) {
    throw new OxpSessionControl.WaitCancelled(started.admittedMessageID)
  }

  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(new OxpSessionControl.WaitCancelled(started.admittedMessageID))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    const exit = await Promise.race([wait, aborted])
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    return {
      admittedMessageID: started.admittedMessageID,
      paused: exit.value.paused,
      ...(exit.value.resultMessageID ? { resultMessageID: exit.value.resultMessageID } : {}),
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

function runBasic(
  scope: Scope.Scope,
  target: OxpSessionControl.Target,
  action: BasicAction,
): Effect.Effect<void, Error> {
  return enter(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const sessions = yield* runtime.Session.Service
        const prompt = yield* runtime.SessionPrompt.Service
        const sessionID = runtime.SessionID.make(target.sessionID)
        yield* sessions.get(sessionID)

        if (action === "pause") {
          yield* commitGuard(target)
          const current = yield* sessions.get(sessionID)
          yield* sessions.setPaused({
            sessionID,
            pausedAt: current.pausedAt ?? Date.now(),
          })
          yield* prompt.pause(sessionID)
          return
        }

        if (action === "abort") {
          const ownership = yield* runtime.SessionExecutionOwner.Service
          const before = yield* ownership.snapshot(sessionID)
          yield* commitGuard(target)
          yield* prompt.cancel(sessionID)
          const after = yield* ownership.snapshot(sessionID)
          if (
            before.ownerID &&
            before.ownerID === after.ownerID &&
            before.generation === after.generation
          ) {
            return yield* Effect.fail(new Error(
              "OXP Session abort could not quiesce the observed live execution generation; abort was not completed.",
            ))
          }
          return
        }

        if (action === "archive" || action === "unarchive") {
          yield* commitGuard(target)
          yield* sessions.setArchived({
            sessionID,
            time: action === "archive" ? Date.now() : null,
          })
          return
        }

        if (action === "delete") {
          // Quiesce the target before the final authorization gate so there is
          // no prompt-cancellation await between commit revalidation and native
          // recursive deletion.
          yield* prompt.cancel(sessionID)
          yield* commitGuard(target)
          // Match the user-facing destructive lifecycle and delegate recursive
          // cleanup to Session.remove. Usage history is independent of this
          // live Session lifecycle.
          yield* sessions.remove(sessionID)
          const stillPresent = yield* sessions
            .get(sessionID)
            .pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            )
          if (stillPresent) {
            return yield* Effect.fail(new Error("Native Session delete did not remove the target"))
          }
          return
        }

        // Distinguish healthy contention from a dead generation fenced by
        // unresolved effects before advertising a successful Resume.
        yield* commitGuard(target)
        yield* requireResumeReady(sessionID)
        yield* commitGuard(target)
        yield* sessions.setPaused({ sessionID, pausedAt: undefined })
        // A quiescent Session needs an explicit wake to drain work admitted
        // while paused. A busy Session is benign contention: its current
        // generation promotes pending inbox work (or releaseIfDrained observes
        // it atomically), so failure to acquire locally must not surface as a
        // failed resume.
        yield* prompt.loop({ sessionID }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            if (
              error instanceof runtime.Session.BusyError ||
              (typeof error === "object" && error !== null && "_tag" in error && error._tag === "SessionBusyError")
            ) {
              return Effect.logInfo("OXP Session resume wake coalesced with existing Session owner", {
                sessionID,
              })
            }
            return Effect.logWarning("OXP Session resume wake did not acquire/run locally", {
              sessionID,
              cause: Cause.pretty(cause),
            })
          }),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
      }),
  )
}

export const layer = Layer.effect(
  OxpSessionControl.Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    return OxpSessionControl.Service.of({
      pause: (target) => runBasic(scope, target, "pause"),
      resume: (target) => runBasic(scope, target, "resume"),
      abort: (target) => runBasic(scope, target, "abort"),
      archive: (target) => runBasic(scope, target, "archive"),
      unarchive: (target) => runBasic(scope, target, "unarchive"),
      delete: (target) => runBasic(scope, target, "delete"),
      setSelection,
      steer: startSteer,
      send: (target, input) =>
        startQueuedPrompt(scope, target, input, false).pipe(
          Effect.map((started) => ({
            admittedMessageID: started.admittedMessageID,
            paused: started.paused,
          })),
        ),
      turn: (target, input, signal) =>
        startQueuedPrompt(scope, target, input, true).pipe(
          Effect.flatMap((started) =>
            Effect.tryPromise({
              try: () => waitForPrompt(started, signal),
              catch: (cause) =>
                cause instanceof Error
                  ? cause
                  : new Error("Unable to wait for supervised Session turn"),
            }),
          ),
        ),
      backgroundSubagents: (target) =>
        enter(
          target,
          (runtime) =>
            Effect.gen(function* () {
              const background = yield* runtime.BackgroundJob.Service
              const jobs = (yield* background.list()).filter(
                (job) =>
                  job.type === "task" &&
                  job.status === "running" &&
                  job.metadata?.parentSessionId === target.sessionID &&
                  job.metadata.background !== true,
              )
              let promoted = 0
              for (const job of jobs) {
                yield* commitGuard(target)
                const result = yield* background.promote(job.id)
                if (result) promoted++
              }
              return { promoted }
            }),
        ),
      todoGet: (target) =>
        enter(
          target,
          (runtime) =>
            Effect.gen(function* () {
              const todo = yield* runtime.Todo.Service
              return yield* todo.get(runtime.SessionID.make(target.sessionID))
            }),
        ),
      todoSet: (target, todos) =>
        enter(
          target,
          (runtime) =>
            Effect.gen(function* () {
              const todo = yield* runtime.Todo.Service
              const sessionID = runtime.SessionID.make(target.sessionID)
              yield* commitGuard(target)
              yield* todo.update({ sessionID, todos })
              return yield* todo.get(sessionID)
            }),
        ),
      checkpoint: (target, input) =>
        enter(
          target,
          (runtime) =>
            Effect.gen(function* () {
              // Checkpoint is inherently Session-owned. Adapt the native
              // implementation inside the already-authorized *real* Session
              // runtime; never create a Session merely to obtain tool context.
              const info = yield* runtime.CheckpointTool
              const checkpoint = yield* info.init()
              return yield* checkpoint.execute(input, {
                sessionID: runtime.SessionID.make(target.sessionID),
                messageID: runtime.MessageID.ascending(),
                agent: "oxp-supervisor",
                abort: target.signal ?? new AbortController().signal,
                messages: [],
                metadata: () => Effect.void,
                ask: () => commitGuard(target).pipe(Effect.orDie),
              })
            }),
        ),
      goal: (target, input) =>
        enter(
          target,
          (runtime) =>
            Effect.gen(function* () {
              const goals = yield* runtime.GoalAgent.Service
              const sessionID = runtime.SessionSchema.ID.make(target.sessionID)

              if (input.action === "request_verification") {
                // request_verification is not merely a Goal lifecycle mutation.
                // The native host owns verification as an execution-preemption
                // command: latch durable audit work, quiesce any worker/tool
                // fiber, then launch the independent auditor. OXP must reuse
                // that owner rather than calling GoalAgent's conversational
                // transition directly, which would strand the Goal in
                // verifying with no auditor.
                const current = yield* goals.execute(sessionID, { action: "status" })
                const detail = current.goal
                const revision = detail.goal.revision
                if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
                  return yield* Effect.fail(
                    new OxpSessionControl.GoalRevisionConflict(
                      detail.goal.id,
                      input.expectedRevision,
                      revision,
                    ),
                  )
                }
                if (detail.goal.status !== "active" && detail.goal.status !== "verifying") {
                  return yield* Effect.fail(
                    new OxpSessionControl.GoalVerificationUnavailable(
                      detail.goal.id,
                      detail.goal.status,
                    ),
                  )
                }

                const prompt = yield* runtime.SessionPrompt.Service
                yield* commitGuard(target)
                yield* prompt
                  .requestGoalAudit(runtime.SessionID.make(target.sessionID))
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logError("OXP Goal verification dispatch failed", {
                        sessionID: target.sessionID,
                        goalID: detail.goal.id,
                        cause,
                      }),
                    ),
                    Effect.forkIn(scope, { startImmediately: true }),
                    Effect.asVoid,
                  )
                return { action: input.action, goal: detail }
              }

              // Deliberately omit TurnProvenance. Goal creation is user-owned and
              // GoalAgent will fail closed without a trusted current human turn;
              // all existing-Goal operations retain their native semantics.
              yield* commitGuard(target)
              return yield* goals.execute(sessionID, input)
            }),
        ),
    })
  }),
)

export * as OxpSessionControlV1 from "./session-control-v1"
