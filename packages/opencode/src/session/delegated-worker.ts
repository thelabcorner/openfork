import { Clock, Effect } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Provider } from "@/provider/provider"
import { Session } from "./session"
import { SessionPrompt } from "./prompt"
import { SessionID } from "./schema"
import { DelegatedWorkerPolicy } from "./delegated-worker-policy"

export const JOB_TYPE = "delegated-worker"
const MAX_RESULT_BYTES = 256 * 1024
const RUNTIME_PROBE_JOB_ID = "__delegated-worker-runtime-probe__"

export interface ModelSelection {
  readonly providerID: string
  readonly modelID: string
  readonly accountID?: string
  readonly variant?: string
}

export interface Identity {
  readonly producer: string
  readonly principalRef: string
}

export interface StartInput {
  readonly title: string
  readonly prompt: string
  readonly agent: string
  readonly model: ModelSelection
  readonly origin: SessionMetadataOwnership.WorkerDelegationOrigin
  /** Caller-owned authority/CAS barrier run after validation and immediately before Session creation. */
  readonly beforeCommit?: Effect.Effect<void, Error>
}

export interface ContinueInput {
  readonly sessionID: SessionID
  readonly prompt: string
  readonly identity: Identity
  readonly invocationRef: string
  /** Live OXP grant snapshot for this newly admitted continuation. */
  readonly nestedDelegation: boolean
  readonly expectedModel?: ModelSelection
  readonly expectedAgent?: string
  /** Caller-owned authority/CAS barrier run immediately before durable prompt admission. */
  readonly beforeCommit?: Effect.Effect<void, Error>
}

export interface SetSelectionInput {
  readonly sessionID: SessionID
  readonly identity: Identity
  /** Full replacement selection for future admitted worker turns. */
  readonly model: ModelSelection
  /** Optional compare-and-set guard against a stale controller view. */
  readonly expectedModel?: ModelSelection
  /** Caller-owned authority/CAS barrier run immediately before durable selection mutation. */
  readonly beforeCommit?: Effect.Effect<void, Error>
}

export type State =
  | "running"
  | "completed"
  | "error"
  | "cancelled"
  | "recoverable"
  | "idle"

export interface Snapshot {
  readonly sessionID: SessionID
  readonly state: State
  readonly generation?: number
  readonly result?: string
  readonly error?: string
  readonly startedAt?: number
  readonly completedAt?: number
  readonly recovered: boolean
}

export interface SelectionChange {
  readonly previousModel: ModelSelection
  readonly model: ModelSelection
  readonly changed: boolean
  readonly snapshot: Snapshot
}

export class InvalidWorker extends Error {
  override readonly name = "DelegatedWorkerInvalid"
  constructor(message = "Session is not a delegated worker owned by this principal") {
    super(message)
  }
}

export class SelectionMismatch extends Error {
  override readonly name = "DelegatedWorkerSelectionMismatch"
  constructor(
    message: string,
    readonly explicitAccount = false,
  ) {
    super(message)
  }
}

export class StartCommitted extends Error {
  override readonly name = "DelegatedWorkerStartCommitted"
  constructor(
    readonly sessionID: SessionID,
    cause: unknown,
  ) {
    super("Delegated worker Session was created before execution setup failed", {
      cause,
    })
  }
}

export class ContinueCommitted extends Error {
  override readonly name = "DelegatedWorkerContinueCommitted"
  constructor(
    readonly sessionID: SessionID,
    cause: unknown,
  ) {
    super("Delegated worker continuation was durably admitted before execution setup failed", {
      cause,
    })
  }
}

function sameSelection(
  left: ModelSelection,
  right: ModelSelection,
) {
  const leftVariant =
    left.variant && left.variant !== "default" ? left.variant : undefined
  const rightVariant =
    right.variant && right.variant !== "default" ? right.variant : undefined
  return (
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    left.accountID === right.accountID &&
    leftVariant === rightVariant
  )
}

function bounded(text: string) {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= MAX_RESULT_BYTES) return text
  return bytes.subarray(bytes.length - MAX_RESULT_BYTES).toString("utf8")
}

function lastText(parts: readonly SessionV1.Part[]) {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part?.type === "text" && part.text.trim()) return bounded(part.text)
  }
  return undefined
}

function messageTime(message: SessionV1.WithParts) {
  return message.info.time.created
}

export const make = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const background = yield* BackgroundJob.Service
  const execution = yield* SessionExecutionOwner.Service

  const validateSelection = Effect.fn("DelegatedWorker.validateSelection")(
    function* (agentName: string, selection: ModelSelection) {
      const agent = (yield* agents.list()).find(
        (candidate) => candidate.name === agentName && candidate.hidden !== true,
      )
      if (!agent) {
        return yield* Effect.fail(
          new SelectionMismatch("Requested delegated-worker agent is unavailable"),
        )
      }
      const providerID = ProviderV2.ID.make(selection.providerID)
      const modelID = ModelV2.ID.make(selection.modelID)
      const accountID = selection.accountID
        ? yield* provider
            .resolveAccountID(providerID, selection.accountID)
            .pipe(
              Effect.mapError(
                (error) => new SelectionMismatch(error.message, true),
              ),
            )
        : undefined
      const resolved = yield* provider
        .getModel(providerID, modelID, accountID)
        .pipe(
          Effect.mapError(
            () =>
              new SelectionMismatch(
                accountID
                  ? "Requested delegated-worker provider account/model is unavailable"
                  : "Requested delegated-worker model is unavailable",
                accountID !== undefined,
              ),
          ),
        )
      if (!Provider.isLanguageModel(resolved)) {
        return yield* Effect.fail(
          new SelectionMismatch(
            "Requested delegated-worker model is not a conversational language model",
          ),
        )
      }
      if (
        selection.variant &&
        selection.variant !== "default" &&
        resolved.variants &&
        !(selection.variant in resolved.variants)
      ) {
        return yield* Effect.fail(
          new SelectionMismatch("Requested delegated-worker model variant is unavailable"),
        )
      }
      return {
        agent,
        model: {
          providerID,
          modelID,
          ...(accountID ? { accountID } : {}),
          ...(selection.variant ? { variant: selection.variant } : {}),
        },
      }
    },
  )

  const resolveSelection = Effect.fn("DelegatedWorker.resolveSelection")(
    function* (
      agentName?: string,
      selection?: ModelSelection,
    ) {
      const agentInfo = agentName
        ? (yield* agents.list()).find(
            (candidate) =>
              candidate.name === agentName && candidate.hidden !== true,
          )
        : yield* agents.defaultInfo()
      if (!agentInfo) {
        return yield* Effect.fail(
          new SelectionMismatch(
            "Requested delegated-worker agent is unavailable",
          ),
        )
      }
      const agent = agentInfo.name
      const model =
        selection ??
        (agentInfo.model
          ? {
              providerID: String(agentInfo.model.providerID),
              modelID: String(agentInfo.model.modelID),
              ...(agentInfo.model.accountID
                ? { accountID: agentInfo.model.accountID }
                : {}),
              ...(agentInfo.variant ? { variant: agentInfo.variant } : {}),
            }
          : yield* provider.defaultModel().pipe(
              Effect.map((fallback) => ({
                providerID: String(fallback.providerID),
                modelID: String(fallback.modelID),
              })),
              Effect.mapError(
                () =>
                  new SelectionMismatch(
                    "No delegated-worker language model is available from the live provider catalog",
                  ),
              ),
            ))
      const selected = yield* validateSelection(agent, model)
      return {
        agent: selected.agent.name,
        model: {
          providerID: String(selected.model.providerID),
          modelID: String(selected.model.modelID),
          ...(selected.model.accountID
            ? { accountID: selected.model.accountID }
            : {}),
          ...(selected.model.variant
            ? { variant: selected.model.variant }
            : {}),
        },
      } satisfies { agent: string; model: ModelSelection }
    },
  )

  const requireWorker = Effect.fn("DelegatedWorker.requireWorker")(
    function* (sessionID: SessionID, identity: Identity) {
      const session = yield* sessions
        .get(sessionID)
        .pipe(
          Effect.mapError(
            () => new InvalidWorker(),
          ),
        )
      const origin = SessionMetadataOwnership.workerDelegation(session.metadata)
      if (
        !origin ||
        origin.producer !== identity.producer ||
        origin.principalRef !== identity.principalRef
      ) {
        return yield* Effect.fail(new InvalidWorker())
      }
      return { session, origin }
    },
  )

  const admitPrompt = Effect.fn("DelegatedWorker.admitPrompt")(
    function* (input: {
      sessionID: SessionID
      promptText: string
      agent: string
      model: ModelSelection
      principalRef: string
      invocationRef: string
      nestedDelegation: boolean
    }) {
      return yield* prompt.hostPrompt(
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: {
            providerID: ProviderV2.ID.make(input.model.providerID),
            modelID: ModelV2.ID.make(input.model.modelID),
            ...(input.model.accountID ? { accountID: input.model.accountID } : {}),
          },
          ...(input.model.variant ? { variant: input.model.variant } : {}),
          noReply: true,
          parts: [
            {
              type: "text",
              text: input.promptText,
              metadata: DelegatedWorkerPolicy.turnMetadata({
                nestedDelegation: input.nestedDelegation,
              }),
            },
          ],
        },
        {
          source: SessionTurnProvenance.Source.OxpDelegation,
          ref: input.invocationRef,
          principalRef: input.principalRef,
        },
      )
    },
  )

  const drain = Effect.fn("DelegatedWorker.drain")(
    function* (sessionID: SessionID) {
      const result = yield* prompt.loop({ sessionID })
      if (result.info.role === "assistant" && result.info.error) {
        const detail =
          "message" in result.info.error.data &&
          typeof result.info.error.data.message === "string"
            ? result.info.error.data.message
            : result.info.error.name
        return yield* Effect.fail(new Error(detail))
      }
      return lastText(result.parts) ?? ""
    },
  )

  // BackgroundJob's V1 adapter owns an instance-scoped lazy runtime. Force its
  // InstanceState/Scope entry to materialize before any durable Session/prompt
  // mutation so registry bootstrap failure surfaces pre-commit. This probes the
  // InstanceRef/Scope edge only; it is not a general service-graph preflight.
  const ensureExecutionRuntime = Effect.fn("DelegatedWorker.ensureExecutionRuntime")(
    function* () {
      yield* background.get(RUNTIME_PROBE_JOB_ID)
    },
  )

  const start = Effect.fn("DelegatedWorker.start")(function* (input: StartInput) {
    const selected = yield* validateSelection(input.agent, input.model)
    if (
      input.origin.agent !== selected.agent.name ||
      !sameSelection(input.origin.model, input.model)
    ) {
      return yield* Effect.fail(
        new SelectionMismatch(
          "Delegated worker protected origin does not match the validated agent/model selection",
        ),
      )
    }
    const origin: SessionMetadataOwnership.WorkerDelegationOrigin = {
      ...input.origin,
      agent: selected.agent.name,
      model: {
        providerID: String(selected.model.providerID),
        modelID: String(selected.model.modelID),
        ...(selected.model.accountID ? { accountID: selected.model.accountID } : {}),
        ...(selected.model.variant ? { variant: selected.model.variant } : {}),
      },
    }
    yield* ensureExecutionRuntime()
    const permission = [
      ...selected.agent.permission,
      ...(origin.nestedDelegation
        ? []
        : [
            {
              permission: "task",
              pattern: "*",
              action: "deny" as const,
            },
          ]),
    ]

    return yield* Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        if (input.beforeCommit) yield* input.beforeCommit
        const session = yield* sessions.create({
          title: input.title,
          agent: selected.agent.name,
          model: {
            providerID: selected.model.providerID,
            id: selected.model.modelID,
            ...(selected.model.accountID
              ? { accountID: selected.model.accountID }
              : {}),
            ...(selected.model.variant
              ? { variant: selected.model.variant }
              : {}),
          },
          metadata: SessionMetadataOwnership.delegatedWorker(origin),
          permission,
        })

        yield* admitPrompt({
          sessionID: session.id,
          promptText: input.prompt,
          agent: selected.agent.name,
          model: selected.model,
          principalRef: origin.principalRef,
          invocationRef: origin.invocationRef,
          nestedDelegation: origin.nestedDelegation,
        }).pipe(
          Effect.mapError((cause) => new StartCommitted(session.id, cause)),
        )

        const attempt = yield* background
          .tryStart({
            id: session.id,
            type: JOB_TYPE,
            title: input.title,
            metadata: {
              sessionID: session.id,
              producer: origin.producer,
              principalRef: origin.principalRef,
            },
            continueOnFailure: true,
            run: drain(session.id).pipe(
              Effect.onInterrupt(() => prompt.cancel(session.id)),
            ),
          })
          .pipe(
            Effect.mapError(
              (cause) => new StartCommitted(session.id, cause),
            ),
          )
        if (!attempt.started) {
          return yield* Effect.fail(
            new StartCommitted(
              session.id,
              new Error("Delegated-worker execution handle collision"),
            ),
          )
        }
        return session
      }),
    )
  })

  const continueWorker = Effect.fn("DelegatedWorker.continue")(
    function* (input: ContinueInput) {
      const { session, origin } = yield* requireWorker(
        input.sessionID,
        input.identity,
      )
      if (input.expectedAgent && input.expectedAgent !== origin.agent) {
        return yield* Effect.fail(
          new SelectionMismatch(
            "Delegated worker is bound to a different agent",
          ),
        )
      }
      const expected = input.expectedModel
        ? yield* validateSelection(origin.agent, input.expectedModel)
        : undefined
      if (expected && !sameSelection(expected.model, origin.model)) {
        return yield* Effect.fail(
          new SelectionMismatch(
            "Delegated worker is bound to a different model/account selection",
            input.expectedModel?.accountID !== undefined,
          ),
        )
      }
      yield* validateSelection(origin.agent, origin.model)
      yield* ensureExecutionRuntime()

      return yield* Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          if (input.beforeCommit) yield* input.beforeCommit
          yield* admitPrompt({
            sessionID: session.id,
            promptText: input.prompt,
            agent: origin.agent,
            model: origin.model,
            principalRef: origin.principalRef,
            invocationRef: input.invocationRef,
            nestedDelegation:
              origin.nestedDelegation && input.nestedDelegation,
          })

          const run = () =>
            drain(session.id).pipe(
              Effect.onInterrupt(() => prompt.cancel(session.id)),
            )

          return yield* Effect.gen(function* () {
            while (true) {
              const current = yield* background.get(session.id)
              if (current?.status === "running") {
                if (current.type !== JOB_TYPE) {
                  return yield* Effect.fail(
                    new Error(
                      "Delegated worker is owned by another live background-job type",
                    ),
                  )
                }
                if (yield* background.extend({ id: session.id, run: run() })) {
                  return session
                }
                continue
              }

              const attempt = yield* background.tryStart({
                id: session.id,
                type: JOB_TYPE,
                title: session.title,
                metadata: {
                  sessionID: session.id,
                  producer: origin.producer,
                  principalRef: origin.principalRef,
                },
                continueOnFailure: true,
                run: run(),
              })
              if (attempt.started) return session
              if (attempt.info.type !== JOB_TYPE) {
                return yield* Effect.fail(
                  new Error(
                    "Delegated worker is owned by another live background-job type",
                  ),
                )
              }
            }
          }).pipe(
            Effect.mapError(
              (cause) => new ContinueCommitted(session.id, cause),
            ),
          )
        }),
      )
    },
  )

  const durableSnapshot = Effect.fn("DelegatedWorker.durableSnapshot")(
    function* (sessionID: SessionID, identity: Identity) {
      yield* requireWorker(sessionID, identity)
      const ownership = yield* execution.snapshot(sessionID)
      const messages = yield* sessions
        .messages({ sessionID, limit: 32 })
        .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])))
      const ordered = messages.toSorted((a, b) => messageTime(a) - messageTime(b))
      const latest = ordered.at(-1)
      const assistant = ordered.findLast((message) => message.info.role === "assistant")
      const result = assistant ? lastText(assistant.parts) : undefined
      const assistantError =
        assistant?.info.role === "assistant" && assistant.info.error
          ? ("message" in assistant.info.error.data &&
              typeof assistant.info.error.data.message === "string"
              ? assistant.info.error.data.message
              : assistant.info.error.name)
          : undefined
      const state: State = ownership.ownerID
        ? "running"
        : latest?.info.role === "user"
          ? "recoverable"
          : assistantError
            ? "error"
            : assistant
              ? "completed"
              : "idle"
      return {
        sessionID,
        state,
        ...(ownership.generation > 0
          ? { generation: ownership.generation }
          : {}),
        ...(ownership.acquiredAt !== undefined
          ? { startedAt: ownership.acquiredAt }
          : {}),
        ...(result ? { result } : {}),
        ...(assistantError ? { error: assistantError } : {}),
        recovered: true,
      } satisfies Snapshot
    },
  )

  const snapshot = Effect.fn("DelegatedWorker.snapshot")(
    function* (sessionID: SessionID, identity: Identity) {
      yield* requireWorker(sessionID, identity)
      const live = yield* background.get(sessionID)
      if (!live) return yield* durableSnapshot(sessionID, identity)
      const state: State =
        live.status === "running"
          ? "running"
          : live.status === "completed"
            ? "completed"
            : live.status === "error"
              ? "error"
              : "cancelled"
      return {
        sessionID,
        state,
        ...(live.generation !== undefined ? { generation: live.generation } : {}),
        ...(live.output ? { result: bounded(live.output) } : {}),
        ...(live.error ? { error: live.error } : {}),
        startedAt: live.started_at,
        ...(live.completed_at ? { completedAt: live.completed_at } : {}),
        recovered: false,
      } satisfies Snapshot
    },
  )

  const setSelection = Effect.fn("DelegatedWorker.setSelection")(
    function* (input: SetSelectionInput) {
      const { session, origin } = yield* requireWorker(
        input.sessionID,
        input.identity,
      )
      const expected = input.expectedModel
        ? yield* validateSelection(origin.agent, input.expectedModel)
        : undefined
      if (expected && !sameSelection(expected.model, origin.model)) {
        return yield* Effect.fail(
          new SelectionMismatch(
            "Delegated worker model selection changed before selection mutation",
            input.expectedModel?.accountID !== undefined,
          ),
        )
      }

      const selected = yield* validateSelection(origin.agent, input.model)
      const nextModel: ModelSelection = {
        providerID: String(selected.model.providerID),
        modelID: String(selected.model.modelID),
        ...(selected.model.accountID
          ? { accountID: selected.model.accountID }
          : {}),
        ...(selected.model.variant &&
        selected.model.variant !== "default"
          ? { variant: selected.model.variant }
          : {}),
      }
      if (sameSelection(nextModel, origin.model)) {
        return {
          previousModel: origin.model,
          model: nextModel,
          changed: false,
          snapshot: yield* snapshot(session.id, input.identity),
        } satisfies SelectionChange
      }

      return yield* Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          if (input.beforeCommit) yield* input.beforeCommit

          // Re-read immediately before the producer-owned update. Combined with
          // Session.setDelegatedWorkerModel's expected-model check, this gives
          // selection mutation compare-and-set semantics without weakening the
          // generic metadata immutability boundary.
          const latest = yield* requireWorker(session.id, input.identity)
          if (!sameSelection(latest.origin.model, origin.model)) {
            return yield* Effect.fail(
              new SelectionMismatch(
                "Delegated worker model selection changed before selection commit",
                input.expectedModel?.accountID !== undefined,
              ),
            )
          }
          yield* sessions
            .setDelegatedWorkerModel({
              sessionID: session.id,
              principalRef: origin.principalRef,
              expectedModel: origin.model,
              model: {
                providerID: selected.model.providerID,
                id: selected.model.modelID,
                ...(selected.model.accountID
                  ? { accountID: selected.model.accountID }
                  : {}),
                variant: selected.model.variant ?? "default",
              },
              time: Date.now(),
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new SelectionMismatch(
                    error.reason,
                    input.expectedModel?.accountID !== undefined,
                  ),
              ),
            )

          return {
            previousModel: origin.model,
            model: nextModel,
            changed: true,
            snapshot: yield* snapshot(session.id, input.identity),
          } satisfies SelectionChange
        }),
      )
    },
  )

  const wait = Effect.fn("DelegatedWorker.wait")(function* (input: {
    sessionID: SessionID
    identity: Identity
    timeout?: number
  }) {
    yield* requireWorker(input.sessionID, input.identity)
    const live = yield* background.get(input.sessionID)
    if (live) {
      if (live.status === "running") {
        yield* background.wait({
          id: input.sessionID,
          ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
        })
      }
      return yield* snapshot(input.sessionID, input.identity)
    }

    let current = yield* durableSnapshot(input.sessionID, input.identity)
    if (current.state !== "running") return current

    const startedAt = yield* Clock.currentTimeMillis
    const deadline =
      input.timeout === undefined
        ? undefined
        : startedAt + Math.max(0, input.timeout)
    while (current.state === "running") {
      if (deadline !== undefined) {
        const now = yield* Clock.currentTimeMillis
        if (now >= deadline) return current
        yield* Effect.sleep(Math.min(100, deadline - now))
      } else {
        yield* Effect.sleep(100)
      }
      current = yield* durableSnapshot(input.sessionID, input.identity)
    }
    return current
  })

  const cancel = Effect.fn("DelegatedWorker.cancel")(function* (input: {
    sessionID: SessionID
    identity: Identity
  }) {
    yield* requireWorker(input.sessionID, input.identity)
    yield* background.cancel(input.sessionID)
    yield* prompt.cancel(input.sessionID)
    return yield* snapshot(input.sessionID, input.identity)
  })

  const result = Effect.fn("DelegatedWorker.result")(function* (input: {
    sessionID: SessionID
    identity: Identity
  }) {
    yield* requireWorker(input.sessionID, input.identity)
    const live = yield* background.get(input.sessionID)
    if (!live) return yield* durableSnapshot(input.sessionID, input.identity)
    const current = yield* snapshot(input.sessionID, input.identity)
    if (current.result || current.error) return current
    const durable = yield* durableSnapshot(input.sessionID, input.identity)
    return {
      ...current,
      ...(durable.result !== undefined && current.result === undefined
        ? { result: durable.result }
        : {}),
      ...(durable.error !== undefined && current.error === undefined
        ? { error: durable.error }
        : {}),
    } satisfies Snapshot
  })

  return {
    validateSelection,
    resolveSelection,
    start,
    continue: continueWorker,
    setSelection,
    snapshot,
    wait,
    cancel,
    result,
  }
})

export type Interface = Effect.Success<typeof make>

export * as DelegatedWorker from "./delegated-worker"
