import { Cause, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { OxpSessionControl } from "./session-control"
import { OxpRuntimeV1 } from "./runtime-v1"

type BasicAction = "pause" | "resume" | "abort"

type StartedPrompt = {
  readonly admittedMessageID: string
  readonly paused: boolean
  readonly fiber?: Fiber.Fiber<{ readonly info: { readonly id: string } }, never>
}

async function runtimeModules() {
  const [
    { Session },
    { SessionPrompt },
    { SessionID },
    { SessionV2, SessionSchema },
    { ModelV2 },
    { ProviderV2 },
    { Provider },
    { Agent },
    { BackgroundJob },
     { Todo },
    { SessionTurnProvenance },
     { CheckpointTool },
     { GoalAgent },
     { MessageID },
  ] = await Promise.all([
    import("@/session/session"),
    import("@/session/prompt"),
    import("@/session/schema"),
    import("@opencode-ai/core/session"),
    import("@opencode-ai/core/model"),
    import("@opencode-ai/core/provider"),
    import("@/provider/provider"),
    import("@/agent/agent"),
    import("@/background/job"),
     import("@/session/todo"),
    import("@opencode-ai/core/v1/session-turn-provenance"),
      import("@/tool/checkpoint"),
      import("@opencode-ai/core/goal/agent"),
      import("@/session/schema"),
  ])
  return {
    Session,
    SessionPrompt,
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
        const resolved = yield* provider
          .getModel(providerID, modelID, input.model.accountID)
          .pipe(
            Effect.mapError(
              () =>
                new OxpSessionControl.SelectionUnavailable(
                  input.model.accountID ? "provider-account" : "model",
                  input.model.accountID
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
            ...(input.model.accountID ? { accountID: input.model.accountID } : {}),
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

const startPrompt = (
  target: OxpSessionControl.Target,
  input: OxpSessionControl.PromptInput,
) =>
  enter<StartedPrompt>(
    target,
    (runtime) =>
      Effect.gen(function* () {
        const v1Sessions = yield* runtime.Session.Service
        const prompt = yield* runtime.SessionPrompt.Service
        const scope = yield* Scope.Scope
        const sessionID = runtime.SessionID.make(target.sessionID)
        const selected = yield* ensurePromptSelection(runtime, target, input.actorRef)
        yield* commitGuard(target)
        const admitted = yield* prompt.hostPrompt(
          {
            sessionID,
            agent: selected.agent,
            model: {
              providerID: runtime.ProviderV2.ID.make(selected.model.providerID),
              modelID: runtime.ModelV2.ID.make(selected.model.modelID),
              ...(selected.model.accountID ? { accountID: selected.model.accountID } : {}),
            },
            ...(selected.model.variant ? { variant: selected.model.variant } : {}),
            noReply: true,
            parts: [{ type: "text", text: input.text }],
          },
          {
            source: runtime.SessionTurnProvenance.Source.OxpSupervisor,
            ref: input.actorRef,
          },
        )
        const current = yield* v1Sessions.get(sessionID)
        if (current.pausedAt !== undefined) {
          return {
            admittedMessageID: admitted.info.id,
            paused: true,
          }
        }

        const run = prompt.loop({ sessionID }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("OXP Session supervised turn failed", {
              sessionID,
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        )
        const fiber = yield* run.pipe(
          Effect.forkIn(scope, { startImmediately: true }),
        )
        return {
          admittedMessageID: admitted.info.id,
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
      paused: false,
      resultMessageID: exit.value.info.id,
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
      paused: false,
      resultMessageID: exit.value.info.id,
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

function runBasic(
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
          yield* prompt.cancel(sessionID)
          const current = yield* sessions.get(sessionID)
          yield* sessions.setPaused({
            sessionID,
            pausedAt: current.pausedAt ?? Date.now(),
          })
          return
        }

        if (action === "abort") {
          yield* commitGuard(target)
          yield* prompt.cancel(sessionID)
          return
        }

        yield* commitGuard(target)
        yield* sessions.setPaused({ sessionID, pausedAt: undefined })
        const scope = yield* Scope.Scope
        yield* prompt.loop({ sessionID }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("OXP Session resume drain failed", {
              sessionID,
              cause,
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
      }),
  )
}

export const layer = Layer.succeed(
  OxpSessionControl.Service,
  OxpSessionControl.Service.of({
    pause: (target) => runBasic(target, "pause"),
    resume: (target) => runBasic(target, "resume"),
    abort: (target) => runBasic(target, "abort"),
    setSelection,
    send: (target, input) =>
      startPrompt(target, input).pipe(
        Effect.map((started) => ({
          admittedMessageID: started.admittedMessageID,
          paused: started.paused,
        })),
      ),
    turn: (target, input, signal) =>
      startPrompt(target, input).pipe(
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
            // Deliberately omit TurnProvenance. Goal creation is user-owned and
            // GoalAgent will fail closed without a trusted current human turn;
            // all existing-Goal operations retain their native semantics.
            yield* commitGuard(target)
            return yield* goals.execute(runtime.SessionSchema.ID.make(target.sessionID), input)
          }),
      ),
  }),
)

export * as OxpSessionControlV1 from "./session-control-v1"
