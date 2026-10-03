import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  nativeSystemMessageCapability,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Deferred, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { and, desc, eq, lt } from "drizzle-orm"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionMessageProjection } from "../message-projection"
import { SessionRecovery } from "../recovery"
import { SessionSchema } from "../schema"
import { SessionMessageTable } from "../sql"
import { SessionStore } from "../store"
import { SessionTelemetry } from "../telemetry"
import { SessionTitle } from "../title"
import { SessionTurnProvenance } from "../turn-provenance"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { makeRunnerHistoryProjection, type RunnerHistoryProjection } from "./history-projection"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { GoalContext } from "../../goal/context"
import { GoalProjection } from "../../goal/projection"
import { GoalAutomation } from "../../goal/automation"
import { GoalAuditor } from "../../goal/auditor"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { UsageRecord } from "../../usage/record"

import { providerRequestHeaders } from "./provider-request-headers"

// Re-exported so existing runner-hosted-identity proof keeps its import path.
export { providerRequestHeaders } from "./provider-request-headers"

function tokenCount(tokens: {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}) {
  // Goal token budgets are safety ceilings rather than billing estimates. Count
  // every provider-reported token class so caching cannot accidentally make an
  // unattended run appear cheaper than the context it is actually consuming.
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

// Goal reservation ids are durable, globally unique cursors. Reuse the cursor
// as the V2 Synthetic message identity so publication converges across provider
// failures and process restarts instead of appending another continuation turn.
function goalContinuationMessageID(reservationID: string) {
  return SessionMessage.ID.make(`msg_goal_continuation_${reservationID}`)
}

type WorkerTurn = {
  readonly message: SessionMessage.User | SessionMessage.Synthetic
  readonly previousAssistantText?: string
}

type PersistedWorkerRoot = {
  readonly row: typeof SessionMessageTable.$inferSelect
  readonly message: SessionMessage.User | SessionMessage.Synthetic
}

function assistantText(message: SessionMessage.Message | undefined) {
  if (message?.type !== "assistant") return ""
  return message.content
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function toolUserTurn(worker: WorkerTurn | undefined) {
  if (!worker || !SessionTurnProvenance.isGoalAuthorizationTurn(worker.message)) return undefined
  return {
    userMessageID: worker.message.id,
    userText: worker.message.text,
    ...(worker.previousAssistantText ? { previousAssistantText: worker.previousAssistantText } : {}),
  }
}

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const telemetry = yield* SessionTelemetry.Service
    const usageRecord = yield* UsageRecord.Service
    const title = yield* SessionTitle.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const goalContext = yield* GoalContext.Service
    const goalProjection = yield* GoalProjection.Service
    const goalAutomation = yield* GoalAutomation.Service
    const goalAuditor = yield* GoalAuditor.Service
    const database = yield* Database.Service
    const db = database.db
    const readDb = database.readDb
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const persistedWorkerRoot = Effect.fn("SessionRunner.persistedWorkerRoot")(function* (
      sessionID: SessionSchema.ID,
      messageID?: SessionMessage.ID,
    ) {
      const query = readDb
        .select()
        .from(SessionMessageTable)
        .where(
          messageID
            ? and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID))
            : and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")),
        )
      const row = yield* (messageID ? query.get() : query.orderBy(desc(SessionMessageTable.seq)).limit(1).get()).pipe(
        Effect.orDie,
      )
      if (!row) return undefined
      const message = yield* SessionMessageProjection.decodeBaseRow(readDb, row).pipe(Effect.orDie)
      if (!SessionTurnProvenance.isWorkerPromptTurn(message)) return undefined
      return { row, message }
    })

    const materializeGoalContinuation = Effect.fn("SessionRunner.materializeGoalContinuation")(function* (
      reservation: GoalAutomation.Reservation,
    ) {
      const messageID = goalContinuationMessageID(reservation.id)
      const requestedSource = reservation.sourceMessageID
        ? SessionMessage.ID.make(reservation.sourceMessageID)
        : undefined
      const source = yield* persistedWorkerRoot(SessionSchema.ID.make(reservation.sessionID), requestedSource)
      if (!source)
        return yield* Effect.die(
          requestedSource
            ? `Goal continuation causal worker root ${requestedSource} is missing or invalid`
            : "Goal continuation cannot recover a legacy worker root",
        )
      const existing = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        if (existing.session_id !== reservation.sessionID)
          return yield* Effect.die(
            `Goal continuation message ${messageID} already belongs to another Session`,
          )
        const message = yield* SessionMessageProjection.decodeRow(db, existing)
        if (message.type !== "synthetic" || message.text !== reservation.prompt)
          return yield* Effect.die(
            `Goal continuation message ${messageID} conflicts with reservation ${reservation.id}`,
          )
        if (
          message.provenance &&
          (!SessionTurnProvenance.hasHostCorrelation(
            message,
            SessionTurnProvenance.Source.GoalContinuation,
            reservation.id,
          ) ||
            SessionTurnProvenance.causalRootMessageID(message) !== source.message.id)
        )
          return yield* Effect.die(
            `Goal continuation message ${messageID} has conflicting causal provenance`,
          )
        return { state: "promoted" as const }
      }

      const sessionID = SessionSchema.ID.make(reservation.sessionID)
      const entry = yield* SessionInput.admitSynthetic(db, events, {
        id: messageID,
        sessionID,
        content: SessionInput.SyntheticContent.make({ text: reservation.prompt }),
        origin: SessionInput.SyntheticOrigin.make({
          producer: SessionTurnProvenance.Source.GoalContinuation,
          actor: { type: "host" },
          ref: reservation.id,
          cause: { sessionID, messageID: source.message.id },
        }),
        admissionClass: "automatic",
        delivery: "queue",
        expectedLatestUserSeq: reservation.expectedLatestUserSeq,
      })
      if (entry.revokedSeq !== undefined) return { state: "revoked" as const, entry }
      if (entry.promotedSeq !== undefined) return { state: "promoted" as const, entry }
      return { state: "pending" as const, entry }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    type RunState = {
      readonly history: RunnerHistoryProjection
      readonly workerTurns: Map<SessionMessage.ID, WorkerTurn>
      recoveredInterruptedTools: boolean
      baselineSeq: number
    }

    type RunPromotion = {
      readonly lane: SessionInput.PendingLane
      /** The cycle was selected because this lane was runnable; zero promotion means re-arbitrate. */
      readonly required: boolean
    }

    const reconcileGoalProjection = Effect.fn("SessionRunner.reconcileGoalProjection")(function* (
      state: RunState,
      sessionID: SessionSchema.ID,
    ) {
      return yield* goalProjection.reconcile({
        sessionID,
        effective: yield* state.history.stateProjections(state.baselineSeq),
      })
    })

    const resolveWorkerTurn = Effect.fn("SessionRunner.resolveWorkerTurn")(function* (
      state: RunState,
      sessionID: SessionSchema.ID,
      entries: readonly { readonly seq: number; readonly message: SessionMessage.Message }[],
    ) {
      const context = entries.map((entry) => entry.message)
      let rootID = SessionTurnProvenance.currentWorkerRootMessageID(context)
      let persisted: PersistedWorkerRoot | undefined
      if (!rootID) {
        if (!SessionTurnProvenance.requiresLegacyWorkerRootLookup(context)) return undefined
        persisted = yield* persistedWorkerRoot(sessionID)
        rootID = persisted?.message.id
      }
      if (!rootID) return undefined
      const cached = state.workerTurns.get(rootID)
      if (cached) return cached

      const rootIndex = entries.findIndex((entry) => entry.message.id === rootID)
      let root: SessionMessage.Message | undefined
      let rootSeq: number | undefined
      if (rootIndex >= 0) {
        root = entries[rootIndex]!.message
        rootSeq = entries[rootIndex]!.seq
      } else {
        persisted ??= yield* persistedWorkerRoot(sessionID, rootID)
        root = persisted?.message
        rootSeq = persisted?.row.seq
      }
      if (!root || !SessionTurnProvenance.isWorkerPromptTurn(root)) return undefined

      let previousAssistantText = ""
      if (SessionTurnProvenance.isGoalAuthorizationTurn(root)) {
        if (rootIndex >= 0) {
          previousAssistantText = assistantText(
            entries.slice(0, rootIndex).findLast((entry) => entry.message.type === "assistant")?.message,
          )
        } else if (rootSeq !== undefined) {
          const previous = yield* readDb
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, sessionID),
                eq(SessionMessageTable.type, "assistant"),
                lt(SessionMessageTable.seq, rootSeq),
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (previous)
            previousAssistantText = assistantText(
              yield* SessionMessageProjection.decodeBaseRow(readDb, previous).pipe(Effect.orDie),
            )
        }
      }
      const worker: WorkerTurn = {
        message: root,
        ...(previousAssistantText ? { previousAssistantText } : {}),
      }
      state.workerTurns.set(rootID, worker)
      return worker
    })

    const loadSystemContext = (sessionID: SessionSchema.ID, agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load(), goalContext.forSession(sessionID)], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    const loadSystemSurface = (sessionID: SessionSchema.ID, agent: AgentV2.Selection) =>
      loadSystemContext(sessionID, agent).pipe(Effect.flatMap(SystemContext.observeSurface))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      state: RunState,
      sessionID: SessionSchema.ID,
      cycleSource: SessionInput.AdmissionClass,
      promotion: RunPromotion | undefined,
      step: number,
      semanticStartedAt: number | undefined,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(
        db,
        loadSystemSurface(session.id, agent),
        session.id,
        readDb,
      )
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      // This is the structural conversation boundary: prior assistant/tools are
      // settled before entering this function, while queued human input has not
      // yet been promoted. Publish current mutable Goal state here so a later
      // real user steer remains the newer conversational instruction.
      yield* reconcileGoalProjection(state, session.id)
      const pendingRouteEntry = promotion
        ? yield* SessionInput.firstPendingEntry(db, session.id, promotion.lane)
        : undefined
      if (promotion) {
        if (promotion.lane.admissionClass !== cycleSource)
          return yield* Effect.die(
            `Session cycle source ${cycleSource} cannot promote ${promotion.lane.admissionClass} input`,
          )
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        const promoted = yield* SessionInput.promoteLane(db, events, session.id, promotion.lane, cutoff)
        if (promotion.required && promoted.promoted === 0)
          return { state: "yielded" as const, reason: "promotion-lost" as const }
        if (promoted.promoted > 0) currentStep = 1
      }
      const routeIntent =
        pendingRouteEntry?.item.type === "synthetic"
          ? pendingRouteEntry.item.execution?.routeIntent
          : undefined
      const resolvedModel = yield* models.resolveWithInfo(session, routeIntent)
      const model = resolvedModel.model
      const system =
        initialized ??
        (yield* SessionContextEpoch.prepare(
          db,
          events,
          loadSystemSurface(session.id, agent),
          session.id,
          nativeSystemMessageCapability(model),
          readDb,
        ))
      // History is a committed-state read and can be large. Keep it off the
      // primary writer connection so another Session's durable projection does
      // not delay provider dispatch.
      state.baselineSeq = system.baselineSeq
      let entries = yield* state.history.entries(system.baselineSeq)
      if (!state.recoveredInterruptedTools) {
        // Interrupted local tools are recovery work for the current active
        // projection, not a reason to perform a second full history read before
        // dispatch. Publish their failures once, let the aggregate-local
        // projection consume those commits inline, then refresh the cheap view.
        yield* SessionRecovery.failInterruptedEntries(events, session.id, entries)
        state.recoveredInterruptedTools = true
        entries = yield* state.history.entries(system.baselineSeq)
      }
      const context = entries.map((entry) => entry.message)
      const workerTurn = yield* resolveWorkerTurn(state, session.id, entries)
      if (!workerTurn) return yield* Effect.die("Provider turn has no provenance-qualified worker root")
      const userTurn = toolUserTurn(workerTurn)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const request = LLM.request({
        model,
        http: {
          headers: providerRequestHeaders({
            providerID: model.provider,
            projectID: session.projectID,
            sessionID: session.id,
            requestID: workerTurn.message.id,
            parentSessionID: session.parentID,
          }),
        },
        providerOptions: { openai: { promptCacheKey } },
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (
        yield* compaction.compactIfNeeded({
          sessionID: session.id,
          entries,
          model,
          request,
          sourceMessageID: workerTurn.message.id,
        })
      )
        return yield* Effect.die(continueAfterCompaction(currentStep))

      // Admission and provider dispatch are separate boundaries. Revalidate the
      // fixed authority order immediately before spending a provider request so
      // a User arriving after host/automatic selection wins the next safe cycle.
      if (yield* SessionInput.hasHigherPriorityPending(db, session.id, cycleSource))
        return { state: "yielded" as const, reason: "higher-priority-input" as const }

      // Publish the semantic turn clock only after final admission revalidation,
      // but preserve the timestamp captured before preflight/compaction so the
      // user-visible elapsed time includes that accepted turn's preparation.
      // Recursive compaction recovery carries the same timestamp and therefore
      // cannot restart the clock.
      if (semanticStartedAt !== undefined) yield* telemetry.startTurn(session.id, semanticStartedAt)

      // Start filesystem capture before consuming the provider, but do not make
      // network/model generation wait for Git. Bridge the child through a
      // Deferred rather than joining an unresolved Fiber from the provider hot
      // path: Effect 4 beta's unresolved Fiber.join can monopolize the scheduler
      // in this shape. The Deferred wait remains cooperative while preserving
      // the same failure/interruption Exit.
      const startSnapshot = yield* Deferred.make<Snapshot.ID | undefined>()
      yield* snapshots.capture().pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(startSnapshot, exit)),
        Effect.forkChild,
      )
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: Deferred.await(startSnapshot),
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      let firstTokenAt: number | undefined
      let streamedAt: number | undefined
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(
          publisher.publish(event, outputPaths).pipe(
            Effect.andThen(telemetry.observe({ sessionID: session.id, event })),
          ),
        )
      let overflowFailure: ProviderErrorEvent | undefined
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            // Yield between provider events so one session's synchronous durable
            // commits (node:sqlite blocks the single event loop) do not starve other
            // sessions' LLM event processing, SSE delivery, or IPC. Scheduling-only;
            // per-session publication order is preserved by the withPublication semaphore.
            yield* Effect.yieldNow
            if (overflowFailure || publisher.hasProviderError()) return
            if (
              firstTokenAt === undefined &&
              (event.type === "text-start" ||
                event.type === "text-delta" ||
                event.type === "reasoning-start" ||
                event.type === "reasoning-delta")
            )
              firstTokenAt = DateTime.toEpochMillis(yield* DateTime.now)
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  userTurn,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Explicit dispatch origin for throughput windows, captured before
          // the provider stream is consumed. Start-of-turn snapshot work is
          // intentionally concurrent with provider generation and therefore is
          // not part of provider throughput.
          // The lazily published Step.Started event can arrive after the
          // provider spent most of the request generating, so it must not
          // anchor rate denominators.
          const requestSentAt = yield* DateTime.now
          publisher.setRequestSentAt(requestSentAt)
          yield* telemetry.begin({
            sessionID: session.id,
            requestSentAt: DateTime.toEpochMillis(requestSentAt),
            model: {
              providerID: model.provider,
              modelID: model.id,
              name: resolvedModel.name,
              ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
              ...(model.defaults?.limits?.context === undefined ? {} : { contextLimit: model.defaults.limits.context }),
            },
          })
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield*
              restore(
                recoverOverflow({
                  sessionID: session.id,
                  entries,
                  model,
                  request,
                  sourceMessageID: workerTurn.message.id,
                }),
              ))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          // Response-body boundary: the provider stream is exhausted here
          // while local tool fibers may still be settling below, so this
          // stamp brackets provider time without absorbing tool execution.
          if (
            stream._tag === "Success" &&
            !overflowFailure &&
            !publisher.hasProviderError() &&
            publisher.hasAssistantStarted()
          ) {
            streamedAt = DateTime.toEpochMillis(yield* DateTime.now)
            yield* withPublication(publisher.streamed())
            yield* telemetry.streamed(session.id, streamedAt)
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const resolvedStartSnapshot = yield* Deferred.await(startSnapshot)
            const files =
              resolvedStartSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: resolvedStartSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            const completedAt = yield* DateTime.now
            const assistantMessageID = yield* publisher.startAssistant()
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: completedAt,
                assistantMessageID,
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
            yield* telemetry.settle({
              sessionID: session.id,
              assistantMessageID,
              completedAt: DateTime.toEpochMillis(completedAt),
              cost: 0,
              tokens: stepSettlement.tokens,
            })
            yield* usageRecord.record({
              messageID: assistantMessageID,
              sessionID: session.id,
              providerID: model.provider,
              modelID: model.id,
              ...(resolvedModel.route ? { route: resolvedModel.route } : {}),
              variant: session.model?.variant,
              agent: agent.id,
              createdAt: DateTime.toEpochMillis(requestSentAt),
              requestSentAt: DateTime.toEpochMillis(requestSentAt),
              firstTokenAt,
              streamedAt,
              completedAt: DateTime.toEpochMillis(completedAt),
              cost: 0,
              tokens: {
                input: stepSettlement.tokens.input,
                cacheRead: stepSettlement.tokens.cache.read,
                cacheWrite: stepSettlement.tokens.cache.write,
                output: stepSettlement.tokens.output,
                reasoning: stepSettlement.tokens.reasoning,
              },
            })
          }
          if (publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            yield* telemetry.fail(session.id)
          }
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") {
            yield* telemetry.fail(session.id)
            return yield* Effect.failCause(stream.cause)
          }
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* telemetry.fail(session.id).pipe(Effect.andThen(Effect.failCause(settled.cause)))
          return {
            state: "executed" as const,
            needsContinuation: !publisher.hasProviderError() && needsContinuation,
            step: currentStep,
            tokens: stepSettlement ? tokenCount(stepSettlement.tokens) : 0,
            sourceMessageID: workerTurn.message.id,
            // Authoritative success bit. `executed` alone is NOT proof of a
            // successful provider cycle: a provider-error path still returns
            // `executed` with continuation forced false. Only this bit may
            // authorize recording cycle completion for the exact input.
            completedWithoutProviderError: !publisher.hasProviderError(),
          }
        }),
      )
    }, Effect.scoped)
    type RunTurnResult =
      | {
          readonly state: "yielded"
          readonly reason: "promotion-lost" | "higher-priority-input"
        }
      | {
          readonly state: "executed"
          readonly needsContinuation: boolean
          readonly step: number
          readonly tokens: number
          readonly sourceMessageID: SessionMessage.ID
          readonly completedWithoutProviderError: boolean
        }

    type RunTurn = (
      state: RunState,
      sessionID: SessionSchema.ID,
      cycleSource: SessionInput.AdmissionClass,
      promotion: RunPromotion | undefined,
      step: number,
      semanticStartedAt?: number,
    ) => Effect.Effect<RunTurnResult, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(
      function* (state, sessionID, cycleSource, promotion, step, semanticStartedAt) {
        return yield* runTurnAttempt(state, sessionID, cycleSource, promotion, step, semanticStartedAt).pipe(
          Effect.catchDefect(
            Effect.fnUntraced(function* (defect) {
              if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
              if (defect.transition._tag === "ContinueAfterOverflowCompaction")
                return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
              yield* Effect.yieldNow
              return yield* runAfterOverflowCompaction(
                state,
                sessionID,
                cycleSource,
                undefined,
                defect.transition.step,
                semanticStartedAt,
              )
            }),
          ),
        )
      },
    )

    const runTurn: RunTurn = Effect.fnUntraced(function* (
      state,
      sessionID,
      cycleSource,
      promotion,
      step,
      semanticStartedAt,
    ) {
      const startedAt =
        semanticStartedAt ?? (step === 1 ? DateTime.toEpochMillis(yield* DateTime.now) : undefined)
      return yield* runTurnAttempt(
        state,
        sessionID,
        cycleSource,
        promotion,
        step,
        startedAt,
        compaction.compactAfterOverflow,
      ).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(
                state,
                sessionID,
                cycleSource,
                undefined,
                defect.transition.step,
                startedAt,
              )
            return yield* runTurn(state, sessionID, cycleSource, undefined, defect.transition.step, startedAt)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const session = yield* getSession(input.sessionID)
      // Pause gate: a paused session never promotes or starts a provider turn,
      // regardless of the wake path (prompt wake, coalesced follow-up, queue
      // promotion). SessionStore.get reads fresh from the DB, so the gate is
      // sound with no cache staleness.
      if (session.pausedAt !== undefined) return
      const automationRuntime = yield* goalAutomation.runtime(input.sessionID)
      const auditRecovery =
        automationRuntime?.phase === "audit_requested"
          ? yield* goalAutomation.claimAuditRecovery(input.sessionID)
          : undefined
      const initialLane = yield* SessionInput.nextPendingLane(db, input.sessionID)
      let claimedAutomatic =
        !auditRecovery && (!initialLane || initialLane.admissionClass === "automatic")
          ? yield* goalAutomation.claim(input.sessionID)
          : undefined
      if (!input.force && !initialLane && !claimedAutomatic && !auditRecovery) return
      const history = yield* makeRunnerHistoryProjection({ events, readDb, sessionID: input.sessionID })
      const state: RunState = { history, workerTurns: new Map(), recoveredInterruptedTools: false, baselineSeq: -1 }
      return yield* Effect.gen(function* () {
        if (auditRecovery) {
          // The worker cycle already settled before the interruption/restart.
          // Re-audit that durable work; never rematerialize/re-execute its
          // continuation merely because the auditor lease was lost.
          const activeEntries = yield* state.history.entries(state.baselineSeq)
          const workerTurn = yield* resolveWorkerTurn(state, input.sessionID, activeEntries)
          if (!workerTurn) {
            yield* goalAutomation.failAudit({
              sessionID: input.sessionID,
              error: "Goal audit recovery cannot resolve the completed worker cycle.",
            })
          } else {
            const reservation = auditRecovery.reservation
            const audit = yield* goalAuditor.evaluate({
              sessionID: input.sessionID,
              session,
              latestWork: SessionTitle.assembleContext(activeEntries.map((entry) => entry.message)),
              ...(reservation ? { reservationID: reservation.id } : {}),
            })
            const pendingUser =
              (yield* SessionInput.pendingLanes(db, input.sessionID, [
                { admissionClass: "user", delivery: "steer" },
                { admissionClass: "user", delivery: "queue" },
              ])).size > 0
            yield* goalAutomation.afterTurn({
              sessionID: input.sessionID,
              origin: reservation ? "automatic" : "user",
              ...(reservation ? { reservationID: reservation.id } : {}),
              sourceMessageID: reservation?.sourceMessageID
                ? SessionMessage.ID.make(reservation.sourceMessageID)
                : workerTurn.message.id,
              expectedLatestUserSeq:
                reservation?.expectedLatestUserSeq ?? (yield* SessionInput.latestUserSeq(db, input.sessionID)),
              ...(reservation && pendingUser ? { supersededByUser: true } : {}),
              audit,
              requireAuditCursor: audit.auditorSessionID !== undefined,
            })
            yield* reconcileGoalProjection(state, input.sessionID)
            yield* telemetry.idle(input.sessionID)
          }
        }

        let nextLane = initialLane
        let forceAvailable = input.force
        while (true) {
          nextLane ??= yield* SessionInput.nextPendingLane(db, input.sessionID)
          // afterTurn may have created a fresh autonomous reservation in the
          // previous cycle. Re-check SessionInput first, then acquire that
          // reservation only when no user/host work is already ahead of it.
          if (!nextLane && !claimedAutomatic) claimedAutomatic = yield* goalAutomation.claim(input.sessionID)

          // A higher-class Session input that arrived after a Goal reservation
          // claim wins arbitration. User input invalidates autonomous work;
          // host input merely releases the process claim so the reservation can
          // be reconsidered after host work settles.
          if (nextLane && nextLane.admissionClass !== "automatic" && claimedAutomatic) {
            if (nextLane.admissionClass === "user") yield* goalAutomation.cancel(input.sessionID)
            else
              yield* goalAutomation.release({
                sessionID: input.sessionID,
                reservationID: claimedAutomatic.id,
              })
            claimedAutomatic = undefined
          }

          let cycleSource: SessionInput.AdmissionClass
          let cyclePromotion: RunPromotion | undefined
          let cycleAutomatic: GoalAutomation.Reservation | undefined

          if (nextLane?.admissionClass === "automatic" || (!nextLane && claimedAutomatic)) {
            cycleAutomatic = claimedAutomatic ?? (yield* goalAutomation.claim(input.sessionID))
            claimedAutomatic = undefined
            if (!cycleAutomatic) {
              // SessionInput is the runnable authority. An orphaned automatic
              // row whose Goal correlation no longer exists is terminal policy
              // garbage, not a reason to keep a Session permanently runnable.
              if (nextLane?.admissionClass === "automatic") {
                const stale = yield* SessionInput.firstPendingEntry(db, input.sessionID, nextLane)
                if (stale?.kind === "synthetic")
                  yield* SessionInput.revokeSynthetic(db, events, {
                    sessionID: input.sessionID,
                    id: stale.id,
                    reason: "policy",
                  })
                nextLane = undefined
                continue
              }
              if (!forceAvailable) break
              cycleSource = (yield* SessionInput.latestPromotedAdmissionClass(db, input.sessionID)) ?? "user"
              cyclePromotion = undefined
            } else {
              // Current Goal state must precede the continuation event it
              // authorizes. The continuation itself is now ordinary automatic
              // SessionInput, not a direct transcript append.
              yield* reconcileGoalProjection(state, input.sessionID)
              const materialized = yield* materializeGoalContinuation(cycleAutomatic).pipe(
                Effect.catchDefect((defect) =>
                  defect instanceof SessionInput.AdmissionFenceConflict
                    ? goalAutomation
                        // The frozen User fence is terminal for this automatic
                        // continuation. Releasing it would make claim() return
                        // the same stale reservation on the next loop turn,
                        // producing an unbounded admit/rollback retry loop.
                        .cancel(input.sessionID, cycleAutomatic!.id)
                        .pipe(Effect.as({ state: "superseded" as const }))
                    : Effect.die(defect),
                ),
                Effect.onError(() =>
                  goalAutomation.release({ sessionID: input.sessionID, reservationID: cycleAutomatic!.id }),
                ),
              )
              if (materialized.state === "superseded") {
                cycleAutomatic = undefined
                nextLane = undefined
                continue
              }
              if (materialized.state === "revoked") {
                yield* goalAutomation.cancel(input.sessionID)
                cycleAutomatic = undefined
                nextLane = undefined
                continue
              }
              cycleSource = "automatic"
              cyclePromotion =
                materialized.state === "pending"
                  ? {
                      lane: { admissionClass: "automatic", delivery: "queue" },
                      required: true,
                    }
                  : undefined
            }
          } else if (nextLane) {
            cycleSource = nextLane.admissionClass
            if (cycleSource === "user") yield* goalAutomation.cancel(input.sessionID)
            cyclePromotion = { lane: nextLane, required: true }
          } else if (forceAvailable) {
            cycleSource = (yield* SessionInput.latestPromotedAdmissionClass(db, input.sessionID)) ?? "user"
            cyclePromotion = undefined
          } else {
            break
          }

          forceAvailable = false
          nextLane = undefined
          // Freeze the User-admission fence at this cycle boundary. Non-user
          // cycles never advance it: a User arriving while they run must make
          // any later autonomous handoff stale. A user cycle may legitimately
          // absorb same-class steers, so refresh only after those promotions.
          let cycleUserFence =
            cycleAutomatic?.expectedLatestUserSeq ?? (yield* SessionInput.latestUserSeq(db, input.sessionID))
          let cycleTokens = 0
          let cycleSourceMessageID: SessionMessage.ID | undefined
          let spentProvider = false
          // A cycle that yielded after already spending a provider step is not
          // a completed cycle, and neither is one whose provider reported an
          // error. Both are tracked explicitly so partially executed work can
          // never be recorded as cycle completion for its exact input.
          let cycleYielded = false
          let cycleProviderFailed = false
          let needsContinuation = true
          let step = 1
          let promotion = cyclePromotion
          while (needsContinuation) {
            const result = yield* runTurn(state, input.sessionID, cycleSource, promotion, step).pipe(
              Effect.onError(() =>
                cycleAutomatic
                  ? goalAutomation.release({ sessionID: input.sessionID, reservationID: cycleAutomatic.id })
                  : Effect.void,
              ),
            )
            if (result.state === "yielded") {
              cycleYielded = true
              break
            }
            spentProvider = true
            if (!result.completedWithoutProviderError) cycleProviderFailed = true
            if (cycleSource === "user") cycleUserFence = yield* SessionInput.latestUserSeq(db, input.sessionID)
            cycleTokens += result.tokens
            cycleSourceMessageID = result.sourceMessageID
            if (
              cycleAutomatic?.sourceMessageID &&
              result.sourceMessageID !== SessionMessage.ID.make(cycleAutomatic.sourceMessageID)
            )
              return yield* Effect.die(
                `Goal continuation causal root changed from ${cycleAutomatic.sourceMessageID} to ${result.sourceMessageID}`,
              )
            needsContinuation = result.needsContinuation
            step = result.step + 1
            promotion =
              cycleSource === "automatic"
                ? undefined
                : {
                    lane: { admissionClass: cycleSource, delivery: "steer" },
                    required: false,
                  }
            if (!needsContinuation) {
              needsContinuation =
                cycleSource !== "automatic" &&
                (yield* SessionInput.hasPendingLane(db, input.sessionID, {
                  admissionClass: cycleSource,
                  delivery: "steer",
                }))
            }
          }

          const pendingUser =
            (yield* SessionInput.pendingLanes(db, input.sessionID, [
              { admissionClass: "user", delivery: "steer" },
              { admissionClass: "user", delivery: "queue" },
            ])).size > 0

          if (!spentProvider) {
            if (cycleAutomatic) {
              if (pendingUser) yield* goalAutomation.cancel(input.sessionID)
              else
                yield* goalAutomation.release({
                  sessionID: input.sessionID,
                  reservationID: cycleAutomatic.id,
                })
            }
            continue
          }

          const activeEntries = yield* state.history.entries(state.baselineSeq)
          const audit = yield* goalAuditor.evaluate({
            sessionID: input.sessionID,
            session,
            latestWork: SessionTitle.assembleContext(activeEntries.map((entry) => entry.message)),
            ...(cycleAutomatic ? { reservationID: cycleAutomatic.id } : {}),
          })
          const pendingUserAfterAudit =
            pendingUser ||
            (yield* SessionInput.pendingLanes(db, input.sessionID, [
              { admissionClass: "user", delivery: "steer" },
              { admissionClass: "user", delivery: "queue" },
            ])).size > 0
          const decision = yield* goalAutomation.afterTurn({
            sessionID: input.sessionID,
            origin: cycleSource,
            ...(cycleAutomatic ? { reservationID: cycleAutomatic.id } : {}),
            ...(cycleSourceMessageID ? { sourceMessageID: cycleSourceMessageID } : {}),
            expectedLatestUserSeq: cycleUserFence,
            ...(cycleSource !== "user" && pendingUserAfterAudit ? { supersededByUser: true } : {}),
            audit,
            requireAuditCursor: audit.auditorSessionID !== undefined,
          })

          // The auditor may have changed lifecycle status, blocker, criteria, or
          // step progress. Persist that authoritative state at this settled
          // boundary even when automation stops here; if a late human steer is
          // waiting, this also guarantees the human turn is promoted after the
          // state it is responding to.
          yield* reconcileGoalProjection(state, input.sessionID)
          // Exact cycle completion for the single input this cycle ran from.
          // The marker lives on that SessionInput row alone, so a later peer
          // turn or a new execution generation can never make it cover work
          // that never completed. This is execution-ended truth, never a
          // semantic Swarm settlement.
          if (cycleSourceMessageID && !cycleYielded && !cycleProviderFailed) {
            const completion = yield* SessionInput.complete(db, events, {
              sessionID: input.sessionID,
              id: cycleSourceMessageID,
            })
            if (completion.state !== "completed")
              yield* Effect.logDebug("Session cycle completion was not recorded for its exact input", {
                sessionID: input.sessionID,
                messageID: cycleSourceMessageID,
                state: completion.state,
              })
          }
          // This cycle is the semantic user-visible turn boundary. A single
          // cycle may contain many provider steps/tool loops. Clear the settled
          // clock here; the next accepted cycle establishes its fresh clock via
          // startTurn() before provider dispatch (begin() remains a fallback).
          yield* telemetry.idle(input.sessionID)
          // `decision.reservation` is intentionally not claimed here. The next
          // loop iteration re-runs SessionInput priority first, so a user/host
          // arrival between audit settlement and continuation cannot lose to a
          // pre-claimed automatic cycle.
          void decision
        }
        // Post-run maintenance (S6 auto-title parity): runs only on non-interrupted
        // drain completion. An interrupt-driven exit (exactly what pause triggers)
        // propagates interruption before this hook, so a paused session never
        // auto-titles. Reuse the active projection instead of decoding the same
        // history a third time at the end of the drain.
        yield* title.autoTitle({
          session: yield* getSession(input.sessionID),
          messages: (yield* state.history.entries(state.baselineSeq)).map((entry) => entry.message),
        })
      }).pipe(
        // Interrupts and defects can leave before the normal cycle boundary.
        // Always release the live turn latch so a later run cannot inherit an
        // old turn start timestamp.
        Effect.ensuring(goalAutomation.requeueClaim(input.sessionID)),
        Effect.ensuring(telemetry.idle(input.sessionID)),
        Effect.ensuring(history.close),
      )
    })

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    GoalContext.node,
    GoalProjection.node,
    GoalAutomation.node,
    GoalAuditor.node,
    Database.node,
    SessionTelemetry.node,
    UsageRecord.node,
    SessionTitle.node,
  ],
})
