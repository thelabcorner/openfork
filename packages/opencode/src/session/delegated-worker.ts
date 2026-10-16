import { Clock, Duration, Effect, Option, Queue } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderRouteIntentRuntime } from "@opencode-ai/core/provider-route-intent"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { SessionInput } from "@opencode-ai/core/session/input"
import { Database } from "@opencode-ai/core/database/database"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionError } from "@opencode-ai/schema/session-error"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "./session"
import { SessionPrompt } from "./prompt"
import { SessionID } from "./schema"
import { DelegatedWorkerPolicy } from "./delegated-worker-policy"
import { SessionGroup } from "./group"

export const JOB_TYPE = "delegated-worker"
const MAX_RESULT_BYTES = 256 * 1024
const RUNTIME_PROBE_JOB_ID = "__delegated-worker-runtime-probe__"

export interface ModelSelection {
  readonly providerID: string
  readonly modelID: string
  readonly accountID?: string
  readonly variant?: string
  readonly routeIntent?: ProviderRouteIntent.Info
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
  readonly groupID?: string
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
  | "blocked"
  | "completed"
  | "error"
  | "cancelled"
  | "recoverable"
  | "idle"

export type Blocker =
  | {
      readonly type: "permission"
      readonly id: string
      readonly sessionID: SessionID
      readonly permission: string
      readonly externalDirectory: boolean
    }
  | {
      readonly type: "question"
      readonly id: string
      readonly sessionID: SessionID
      readonly questionCount: number
    }

export type Activity = "queued" | "awaiting_provider" | "streaming" | "stepping"

export interface Snapshot {
  readonly sessionID: SessionID
  readonly state: State
  readonly blockedBy?: readonly Blocker[]
  readonly generation?: number
  readonly result?: string
  readonly error?: string
  readonly startedAt?: number
  readonly completedAt?: number
  readonly recovered: boolean
  readonly activity?: Activity
}

const DEFERRED_ACTIVITY_OWNER = Symbol("delegated-worker-deferred-activity-owner")
type DeferredActivitySnapshot = Snapshot & { readonly [DEFERRED_ACTIVITY_OWNER]?: boolean }

export function projectActivity(input: {
  readonly phase?: SessionTelemetry.Phase
  readonly owner: boolean
  readonly queued: boolean
}): Activity | undefined {
  if (input.phase === "tool") return "stepping"
  if (input.phase === "reasoning" || input.phase === "generating") return "streaming"
  if (input.phase === "requesting" || input.phase === "retrying") return "awaiting_provider"
  if (input.queued && !input.owner) return "queued"
  if (input.owner) return "awaiting_provider"
}

/**
 * Is the recorded Session execution owner still *evidenced live*?
 *
 * A durable execution-owner row is authority to have executed, never proof that
 * execution is happening right now. The row outlives whatever wrote it: a hard
 * crash, a foreign runtime, or a half-finished recovery claim all leave a row
 * that is indistinguishable from a live one by inspection. So a liveness
 * projection may only rest on RuntimeOwner's own heartbeat evidence, using the
 * identical candidate gate SessionExecutionOwner applies before it is willing to
 * spend a local process probe. A missing runtime row is unproven, not live.
 *
 * This never infers death. Heartbeat age is only a reason to *stop* claiming
 * liveness; retiring a stale owner stays SessionExecutionOwner's
 * tryClaimRecovery/completeRecovery path, which additionally requires positive
 * local death proof plus negative containment. `age > X` is never reclaim
 * authority here or anywhere above it.
 */
export function ownerExecutionLive(
  ownership: SessionExecutionOwner.Snapshot,
  now: number,
): boolean {
  return (
    ownership.ownerID !== undefined &&
    ownership.runtime !== undefined &&
    now - ownership.runtime.heartbeatAt < SessionExecutionOwner.RUNTIME_OWNER_STALE_AFTER_MS
  )
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
  return SessionMetadataOwnership.sameWorkerDelegationModel(left, right)
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
  const permission = yield* Permission.Service
  const question = yield* Question.Service
  const eventsOption = yield* Effect.serviceOption(EventV2Bridge.Service)
  const telemetryOption = yield* Effect.serviceOption(SessionTelemetry.Service)
  const databaseOption = yield* Effect.serviceOption(Database.Service)
  const groupOption = yield* Effect.serviceOption(SessionGroup.Service)

  const activity = Effect.fnUntraced(function* (sessionID: SessionID, owner: boolean) {
    if (Option.isNone(telemetryOption) || Option.isNone(databaseOption)) return
    const telemetryInfo = (yield* telemetryOption.value.snapshot([String(sessionID)]))[String(sessionID)]
    const queued = yield* SessionInput.hasPendingLane(databaseOption.value.readDb, sessionID, {
      admissionClass: "host",
      delivery: "queue",
    })
    return projectActivity({ phase: telemetryInfo?.phase, owner, queued })
  })

  const activityBatch = Effect.fnUntraced(function* (items: readonly { sessionID: SessionID; owner: boolean }[]) {
    if (items.length === 0 || Option.isNone(telemetryOption) || Option.isNone(databaseOption)) {
      return new Map<SessionID, Activity | undefined>()
    }
    const ids = [...new Set(items.map((item) => item.sessionID))]
    const telemetry = yield* telemetryOption.value.snapshot(ids.map(String))
    const queued = yield* SessionInput.hasPendingLaneBatch(databaseOption.value.readDb, ids, {
      admissionClass: "host",
      delivery: "queue",
    })
    const owners = new Map(items.map((item) => [item.sessionID, item.owner]))
    return new Map(
      ids.map((id) => [
        id,
        projectActivity({ phase: telemetry[String(id)]?.phase, owner: owners.get(id) ?? false, queued: queued.has(id) }),
      ]),
    )
  })

  // One authoritative blocker projection for both singleton and batch reads.
  // Reuse the bounded parent-ID path instead of N descendant full-Session reads.
  const blockingRequests = Effect.fn("DelegatedWorker.blockingRequests")(function* (
    sessionID: SessionID,
    includeDescendants: boolean,
  ) {
    const matches = yield* blockingRequestsBatch([{ sessionID, nestedDelegation: includeDescendants }])
    return matches.get(sessionID) ?? []
  })

  const blockingRequestsBatch = Effect.fn("DelegatedWorker.blockingRequestsBatch")(function* (
    workers: readonly { readonly sessionID: SessionID; readonly nestedDelegation: boolean }[],
  ) {
    const result = new Map<SessionID, Blocker[]>()
    const unique = [...new Map(workers.map((worker) => [worker.sessionID, worker])).values()]
    const bySession = new Map(unique.map((worker) => [worker.sessionID, worker]))
    for (const worker of unique) result.set(worker.sessionID, [])
    if (unique.length === 0) return result

    const [permissions, questions] = yield* Effect.all([permission.list(), question.list()], { concurrency: 2 })
    const nested = new Set(unique.filter((worker) => worker.nestedDelegation).map((worker) => worker.sessionID))
    const candidates = new Map<string, SessionID>()
    const orderedBlockers: Blocker[] = []
    // Session parents are immutable. Pending permission/question requests from
    // siblings commonly share a long ancestry chain. Memoize each parent
    // lookup for THIS batch only; never cache blocker or owner state across
    // permission changes or worker generations.
    const parents = new Map<SessionID, SessionID | undefined>()

    for (const request of permissions) {
      const key = String(request.sessionID)
      candidates.set(key, request.sessionID)
      orderedBlockers.push({
        type: "permission",
        id: String(request.id),
        sessionID: request.sessionID,
        permission: request.permission,
        externalDirectory: request.permission === "external_directory",
      })
    }
    for (const request of questions) {
      const key = String(request.sessionID)
      candidates.set(key, request.sessionID)
      orderedBlockers.push({
        type: "question",
        id: String(request.id),
        sessionID: request.sessionID,
        questionCount: request.questions.length,
      })
    }

    if (nested.size > 0 && candidates.size > 0 && candidates.size <= 25 && Object.hasOwn(sessions, "ancestorParentIDsMany")) {
      // A bounded single SQL recursive walk is faster for small nested groups.
      // Retain the breadth-level batching below for broad groups: recursive
      // UNION ALL duplicates common ancestors and scales poorly above ~25.
      const starts = [...candidates.values()]
      const found = yield* sessions.ancestorParentIDsMany!(starts)
      for (const [id, parent] of found) parents.set(id, parent)
      // Missing seeds/parents are terminal; never hydrate their full Session
      // rows merely because the minimal projection found no matching row.
      for (const id of starts) if (!parents.has(id)) parents.set(id, undefined)
      for (const parent of [...parents.values()]) {
        if (parent && !parents.has(parent)) parents.set(parent, undefined)
      }
    } else if (nested.size > 0 && candidates.size > 0 && Object.hasOwn(sessions, "parentIDsMany")) {
      // Batch each ancestry LEVEL, not each worker or pending request. Many
      // siblings share ancestors, and selecting only id+parent_id avoids
      // decoding full Session rows on the hot blocker-resolution path.
      // Retain no ancestry cache after this one snapshot projection.
      let frontier = new Set<SessionID>(candidates.values())
      for (let depth = 0; depth < 64 && frontier.size > 0; depth++) {
        const unknown = [...frontier].filter((id) => !parents.has(id))
        if (unknown.length > 0) {
          const found = yield* sessions.parentIDsMany!(unknown)
          for (const id of unknown) parents.set(id, found.get(id))
        }
        const next = new Set<SessionID>()
        for (const id of frontier) {
          const parent = parents.get(id)
          if (parent && !parents.has(parent)) next.add(parent)
        }
        frontier = next
      }
    }

    // Preserve the producer's permission-first/question-second ordering even
    // though all parent lookups are grouped by Session for SQL efficiency.
    const matches = new Map<string, Set<SessionID>>()
    for (const candidate of candidates.values()) {
      const targets = new Set<SessionID>()
      const directWorker = bySession.get(candidate)
      if (directWorker && !nested.has(directWorker.sessionID)) {
        targets.add(directWorker.sessionID)
      }
      if (nested.size === 0) {
        matches.set(String(candidate), targets)
        continue
      }

      // Walk each pending request's ancestry once, matching every nested worker
      // on that path. This replaces one ancestry walk per worker per 100ms poll.
      let current: SessionID | undefined = candidate
      const seen = new Set<string>()
      for (let depth = 0; current && depth < 64; depth++) {
        const key = String(current)
        if (seen.has(key)) break
        seen.add(key)
        if (nested.has(current)) targets.add(current)
        if (!parents.has(current)) {
          const row: Session.Info | undefined = yield* sessions.get(current).pipe(Effect.catch(() => Effect.succeed(undefined)))
          parents.set(current, row?.parentID)
        }
        current = parents.get(current)
      }
      matches.set(String(candidate), targets)
    }
    for (const blocker of orderedBlockers) {
      for (const target of matches.get(String(blocker.sessionID)) ?? []) {
        result.get(target)!.push(blocker)
      }
    }
    return result
  })

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
      const routeIntent = yield* ProviderRouteIntentRuntime.normalize({
        ...(selection.routeIntent ? { routeIntent: selection.routeIntent } : {}),
        ...(selection.accountID ? { legacyAccountID: selection.accountID } : {}),
      }).pipe(
        Effect.mapError(
          (error) =>
            new SelectionMismatch(
              error instanceof Error ? error.message : String(error),
              selection.accountID !== undefined || selection.routeIntent?.kind === "account",
            ),
        ),
      )
      const requestedAccountID =
        routeIntent.kind === "account" ? routeIntent.accountID : undefined
      const accountID = requestedAccountID
        ? yield* provider
            .resolveAccountID(providerID, requestedAccountID)
            .pipe(
              Effect.mapError(
                (error) => new SelectionMismatch(error.message, true),
              ),
            )
        : undefined
      const canonicalRouteIntent: ProviderRouteIntent.Info =
        routeIntent.kind === "account"
          ? {
              kind: "account",
              accountID: accountID!,
              pin: routeIntent.pin ?? "hard",
            }
          : routeIntent
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
          routeIntent: canonicalRouteIntent,
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
          routeIntent: selected.model.routeIntent,
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

  const requireWorkers = Effect.fn("DelegatedWorker.requireWorkers")(function* (
    ids: readonly SessionID[],
    identity: Identity,
  ) {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    // The exact protected delegation origin is a two-column Session projection;
    // do not decode summary diffs, model/config, permissions or other mutable
    // Session fields just to authenticate an addressed worker batch.
    if (Object.hasOwn(sessions, "workerOriginsMany")) {
      const found = yield* sessions.workerOriginsMany!(unique)
      const verified: { sessionID: SessionID; origin: SessionMetadataOwnership.WorkerDelegationOrigin; nestedDelegation: boolean }[] = []
      for (const sessionID of unique) {
        const origin = found.get(sessionID)
        if (!origin || origin.producer !== identity.producer || origin.principalRef !== identity.principalRef) {
          return yield* Effect.fail(new InvalidWorker())
        }
        verified.push({ sessionID, origin, nestedDelegation: origin.nestedDelegation })
      }
      return verified
    }
    // Decode producer-owned metadata through the authoritative Session owner.
    // Every row is still checked against the caller's exact producer/principal.
    // Effect's partial Service mocks synthesize throwing functions for absent
    // method properties, so typeof alone would incorrectly invoke one.
    if (Object.hasOwn(sessions, "getMany")) {
      const found = yield* sessions.getMany!(unique)
      const verified: { sessionID: SessionID; origin: SessionMetadataOwnership.WorkerDelegationOrigin; nestedDelegation: boolean }[] = []
      for (const sessionID of unique) {
        const origin = SessionMetadataOwnership.workerDelegation(found.get(sessionID)?.metadata)
        if (!origin || origin.producer !== identity.producer || origin.principalRef !== identity.principalRef) {
          return yield* Effect.fail(new InvalidWorker())
        }
        verified.push({ sessionID, origin, nestedDelegation: origin.nestedDelegation })
      }
      return verified
    }
    // Old partial service mocks retain their prior semantics.
    return yield* Effect.forEach(unique, (sessionID) =>
      requireWorker(sessionID, identity).pipe(Effect.map(({ origin }) => ({
        sessionID, origin, nestedDelegation: origin.nestedDelegation,
      }))), { concurrency: 4 })
  })

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
        routeIntent: selected.model.routeIntent,
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

        if (input.groupID) {
          if (Option.isNone(groupOption)) {
            return yield* Effect.fail(new StartCommitted(session.id, new Error("Delegation group service is unavailable")))
          }
          yield* groupOption.value
            .addSession({
              groupId: SessionGroup.ID.make(input.groupID),
              sessionId: String(session.id),
              locked: true,
              origin: "delegation",
              originRef: origin.invocationRef,
            })
            .pipe(Effect.mapError((cause) => new StartCommitted(session.id, cause)))
        }

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
    function* (sessionID: SessionID, identity: Identity, deferActivity = false, sharedBlockers?: readonly Blocker[], verifiedOrigin?: SessionMetadataOwnership.WorkerDelegationOrigin, knownOwnership?: SessionExecutionOwner.Snapshot) {
      // snapshotMany has already authenticated this immutable producer-owned
      // origin. Avoid reloading the same Session row for each fallback path.
      const origin = verifiedOrigin ?? (yield* requireWorker(sessionID, identity)).origin
      const ownership = knownOwnership ?? (yield* execution.snapshot(sessionID))
      // Only heartbeat-evidenced owners may carry a live-progress projection on a
      // durable snapshot. `state` below is already derived purely from the
      // transcript, so a stale, foreign, or dead owner row must not reintroduce
      // liveness through `activity`.
      const ownerLive = ownerExecutionLive(ownership, Date.now())
      const blockedBy = sharedBlockers ?? (yield* blockingRequests(sessionID, origin.nestedDelegation))
      const messages = yield* sessions
        .messages({ sessionID, limit: 32 })
        .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])))
      const ordered = messages.toSorted((a, b) => messageTime(a) - messageTime(b))
      const latest = ordered.at(-1)
      const assistant = ordered.findLast((message) => message.info.role === "assistant")
      const resultText = assistant ? lastText(assistant.parts) : undefined
      const assistantError =
        assistant?.info.role === "assistant" && assistant.info.error
          ? ("message" in assistant.info.error.data &&
              typeof assistant.info.error.data.message === "string"
              ? assistant.info.error.data.message
              : assistant.info.error.name)
          : undefined
      if (assistantError) {
        yield* Effect.logError("session.error", {
          sessionID,
          error: SessionError.summary(
            assistant?.info.role === "assistant" ? assistant.info.error : undefined,
          ),
        })
      }
      const state: State =
        blockedBy.length > 0
          ? "blocked"
          : latest?.info.role === "user"
            ? "recoverable"
            : assistantError
              ? "error"
              : assistant
                ? "completed"
                : "idle"
      const projectedActivity = deferActivity ? undefined : yield* activity(sessionID, ownerLive)
      const snapshotResult = {
        sessionID,
        state,
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
        ...(ownership.generation > 0
          ? { generation: ownership.generation }
          : {}),
        ...(ownership.acquiredAt !== undefined
          ? { startedAt: ownership.acquiredAt }
          : {}),
        ...(resultText ? { result: resultText } : {}),
        ...(assistantError ? { error: assistantError } : {}),
        recovered: true,
        ...(projectedActivity ? { activity: projectedActivity } : {}),
      } satisfies Snapshot
      return deferActivity
        ? Object.assign(snapshotResult, { [DEFERRED_ACTIVITY_OWNER]: ownerLive })
        : snapshotResult
    },
  )

  const snapshot = Effect.fn("DelegatedWorker.snapshot")(
    function* (sessionID: SessionID, identity: Identity, deferActivity = false, sharedBlockers?: readonly Blocker[], verifiedOrigin?: SessionMetadataOwnership.WorkerDelegationOrigin, knownLive?: { readonly value: BackgroundJob.Info | undefined }, knownOwnership?: SessionExecutionOwner.Snapshot) {
      const origin = verifiedOrigin ?? (yield* requireWorker(sessionID, identity)).origin
      const live = knownLive ? knownLive.value : yield* background.get(sessionID)
      if (!live) return yield* durableSnapshot(sessionID, identity, deferActivity, sharedBlockers, origin, knownOwnership)
      let current = live
      let blockedBy: readonly Blocker[] = []
      if (live.status === "running") {
        const pending = sharedBlockers ?? (yield* blockingRequests(sessionID, origin.nestedDelegation))
        if (pending.length > 0) {
          // A request can be observed immediately before cancellation or
          // completion tears it down. Re-check the job only on this uncommon
          // path so terminal state always wins without adding a second read to
          // ordinary running snapshots.
          const refreshed = yield* background.get(sessionID)
          if (!refreshed) {
            return yield* durableSnapshot(sessionID, identity, deferActivity, sharedBlockers, origin, knownOwnership)
          }
          current = refreshed
          if (refreshed.status === "running") {
            // Confirm the request set as well as the job state. This avoids a
            // stale blocked projection when a supervisor resolves the request
            // during the job-state recheck.
            blockedBy = sharedBlockers ?? (yield* blockingRequests(sessionID, origin.nestedDelegation))
          }
        }
      }
      const ownership = knownOwnership ?? (yield* execution.snapshot(sessionID))
      const state: State =
        current.status === "running"
          ? blockedBy.length > 0
            ? "blocked"
            : "running"
          : current.status === "completed"
            ? "completed"
            : current.status === "error"
              ? "error"
              : "cancelled"
      const projectedActivity = live.status === "running" && !deferActivity
        ? yield* activity(sessionID, Boolean(ownership.ownerID))
        : undefined
      const result = {
        sessionID,
        state,
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
        ...(current.generation !== undefined ? { generation: current.generation } : {}),
        ...(current.output ? { result: bounded(current.output) } : {}),
        ...(current.error ? { error: current.error } : {}),
        startedAt: current.started_at,
        ...(current.completed_at ? { completedAt: current.completed_at } : {}),
        recovered: false,
        ...(projectedActivity ? { activity: projectedActivity } : {}),
      } satisfies Snapshot
      return deferActivity && live.status === "running"
        ? Object.assign(result, { [DEFERRED_ACTIVITY_OWNER]: Boolean(ownership.ownerID) })
        : result
    },
  )

  const ownerSnapshotsFor = Effect.fn("DelegatedWorker.ownerSnapshotsFor")(function* (
    ids: readonly SessionID[],
  ) {
    if (Object.hasOwn(execution, "snapshotMany")) return yield* execution.snapshotMany(ids)
    const states = yield* Effect.forEach([...new Set(ids)], (id) => execution.snapshot(id), { concurrency: 4 })
    return new Map(states.map((state) => [state.sessionID, state]))
  })

  const snapshotMany = Effect.fn("DelegatedWorker.snapshotMany")(function* (
    sessionIDs: readonly SessionID[],
    identity: Identity,
  ) {
    const workers = yield* requireWorkers(sessionIDs, identity)
    const blockers = yield* blockingRequestsBatch(workers)
    const liveJobs = yield* background.getMany(sessionIDs)
    const ownerSnapshots = yield* ownerSnapshotsFor(sessionIDs)
    let rows = (yield* Effect.forEach(
      workers,
      (worker) => snapshot(worker.sessionID, identity, true, blockers.get(worker.sessionID) ?? [], worker.origin, { value: liveJobs.get(worker.sessionID) }, ownerSnapshots.get(worker.sessionID)),
      { concurrency: 4 },
    )) as DeferredActivitySnapshot[]
    if (rows.some((item) => item.state === "blocked")) {
      // Re-read the shared pending sets once if a request resolved while the
      // worker states were being assembled. This preserves terminal/current
      // blocker precedence without restoring per-worker blocker scans.
      const latestBlockers = yield* blockingRequestsBatch(workers)
      const latestJobs = yield* background.getMany(sessionIDs)
      const latestOwners = yield* ownerSnapshotsFor(sessionIDs)
      rows = (yield* Effect.forEach(
        workers,
        (worker) => snapshot(worker.sessionID, identity, true, latestBlockers.get(worker.sessionID) ?? [], worker.origin, { value: latestJobs.get(worker.sessionID) }, latestOwners.get(worker.sessionID)),
        { concurrency: 4 },
      )) as DeferredActivitySnapshot[]
    }
    // Activity belongs to the selected final worker-state projection. Computing
    // it before the blocker revalidation wastes a DB batch and can pair freshly
    // rechecked owners with an earlier, now-stale activity snapshot.
    const activityInputs = rows.flatMap((row) =>
      row[DEFERRED_ACTIVITY_OWNER] === undefined
        ? []
        : [{ sessionID: row.sessionID, owner: row[DEFERRED_ACTIVITY_OWNER] }],
    )
    const activities = yield* activityBatch(activityInputs)
    return rows.map((row) => {
      const owner = row[DEFERRED_ACTIVITY_OWNER]
      const { [DEFERRED_ACTIVITY_OWNER]: _deferredOwner, ...snapshot } = row
      const projectedActivity = owner === undefined ? undefined : activities.get(row.sessionID)
      return { ...snapshot, ...(projectedActivity ? { activity: projectedActivity } : {}) } satisfies Snapshot
    })
  })

  const waitMany = Effect.fn("DelegatedWorker.waitMany")(function* (input: {
    readonly sessionIDs: readonly SessionID[]
    readonly identity: Identity
    readonly timeout?: number
  }) {
    const sessionIDs = [...new Set(input.sessionIDs)]
    if (sessionIDs.length === 0) return []

    const startedAt = yield* Clock.currentTimeMillis
    const deadline = input.timeout === undefined ? undefined : startedAt + Math.max(0, input.timeout)
    const workers = yield* requireWorkers(sessionIDs, input.identity)
    if (Option.isNone(eventsOption)) return yield* snapshotMany(sessionIDs, input.identity)
    const events = eventsOption.value
    const workerIDs = new Set(sessionIDs)
    const includesDescendants = workers.some((worker) => worker.nestedDelegation)
    const wake = yield* Queue.dropping<void>(1)
    const notify = () => Queue.offer(wake, undefined).pipe(Effect.asVoid)
    // A batch waiter knows its exact Session IDs. Register indexed observers
    // rather than five global type listeners that every other worker's
    // permission/question event must invoke and filter. Nested delegation is
    // the explicit exception: descendant IDs are not known at subscription.
    const subscriptions = includesDescendants
      ? [
          events.listenType(Permission.Event.Asked, notify),
          events.listenType(Permission.Event.Replied, notify),
          events.listenType(Question.Event.Asked, notify),
          events.listenType(Question.Event.Replied, notify),
          events.listenType(Question.Event.Rejected, notify),
        ]
      : Object.hasOwn(events, "listenSessionTypes")
        ? [events.listenSessionTypes(
            [
              Permission.Event.Asked,
              Permission.Event.Replied,
              Question.Event.Asked,
              Question.Event.Replied,
              Question.Event.Rejected,
            ],
            [...workerIDs],
            notify,
          )]
        : [...workerIDs].flatMap((sessionID) => [
            events.listenSessionType(Permission.Event.Asked, sessionID, notify),
            events.listenSessionType(Permission.Event.Replied, sessionID, notify),
            events.listenSessionType(Question.Event.Asked, sessionID, notify),
            events.listenSessionType(Question.Event.Replied, sessionID, notify),
            events.listenSessionType(Question.Event.Rejected, sessionID, notify),
          ])

    // Acquire and release are one bracketed Effect. Cancellation during an
    // N-worker registration must never strand partly installed observers.
    return yield* Effect.acquireUseRelease(
      Effect.all(subscriptions),
      () => Effect.gen(function* () {
        let current = yield* snapshotMany(sessionIDs, input.identity)
        while (true) {
          // Preserve the current batchWait contract: return on the first
          // blocker, terminal worker, or when the shared deadline expires.
          if (current.some((item) => item.state === "blocked") || current.every((item) => item.state !== "running")) {
            return current
          }

          const now = yield* Clock.currentTimeMillis
          if (deadline !== undefined && now >= deadline) return yield* snapshotMany(sessionIDs, input.identity)
           const running = current.filter((item) => item.state === "running")
           // One indexed completion suspension replaces an O(running workers)
           // Effect.raceFirst tree. Exact generation matching prevents a
           // recycled job ID from stealing an earlier generation's wait.
           const completion = background.waitAny({
             jobs: running.map(({ sessionID, generation }) => ({ id: sessionID, generation })),
           })
           const change = Effect.raceFirst(completion, Queue.take(wake))
          const wakeResult = deadline === undefined
            ? yield* change
            : yield* Effect.raceFirst(
                change,
                Effect.sleep(Duration.millis(Math.max(1, deadline - now))).pipe(Effect.as("timeout")),
              )
          if (wakeResult === "timeout") return yield* snapshotMany(sessionIDs, input.identity)
          current = yield* snapshotMany(sessionIDs, input.identity)
        }
      }),
      (unsubscribers) => Effect.forEach(unsubscribers, (unsubscribe) => unsubscribe, { discard: true }),
    )
  })

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
        routeIntent: selected.model.routeIntent,
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
              delegationModel: nextModel,
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
    deferActivity?: boolean
  }) {
    const { origin } = yield* requireWorker(
      input.sessionID,
      input.identity,
    )
    const live = yield* background.get(input.sessionID)
    const startedAt = yield* Clock.currentTimeMillis
    const deadline =
      input.timeout === undefined
        ? undefined
        : startedAt + Math.max(0, input.timeout)
    const deferActivity = input.deferActivity === true

    // Live delegated work has an efficient completion Deferred in BackgroundJob.
    // Keep using that primitive rather than polling the Session row. Permission
    // and Question pending sets are instance-local/in-memory, so a short bounded
    // probe between Deferred waits makes external decision points observable
    // without turning worker waits into a 10 Hz database workload.
    if (live) {
      if (live.status !== "running") {
        return yield* snapshot(input.sessionID, input.identity, deferActivity)
      }
      while (true) {
        const blockedBy = yield* blockingRequests(
          input.sessionID,
          origin.nestedDelegation,
        )
        if (blockedBy.length > 0) {
          // Re-read the authoritative snapshot so a completion racing the
          // blocker probe cannot be misreported as blocked. If the request
          // disappeared during that re-check, keep waiting instead of leaking
          // a transient `running` result to callers that asked us to wait.
          const current = yield* snapshot(input.sessionID, input.identity, deferActivity)
          if (current.state !== "running") return current
          continue
        }

        const now = yield* Clock.currentTimeMillis
        if (deadline !== undefined && now >= deadline) {
          return yield* snapshot(input.sessionID, input.identity, deferActivity)
        }
        const timeout =
          deadline === undefined
            ? 100
            : Math.min(100, Math.max(1, deadline - now))
        const waited = yield* background.wait({
          id: input.sessionID,
          timeout,
        })
        if (!waited.info || waited.info.status !== "running") {
          return yield* snapshot(input.sessionID, input.identity, deferActivity)
        }
      }
    }

    // Without a process-local delegated BackgroundJob there is nothing useful
    // to wait on. Durable state is therefore terminal/recoverable/blocked at
    // this observation point; returning it immediately prevents a stale
    // persisted execution-owner row from masquerading as live progress.
    return yield* durableSnapshot(input.sessionID, input.identity, deferActivity)
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
    snapshotMany,
    waitMany,
    wait,
    cancel,
    result,
  }
})

export type Interface = Effect.Success<typeof make>

export * as DelegatedWorker from "./delegated-worker"
