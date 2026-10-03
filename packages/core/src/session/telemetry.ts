export * as SessionTelemetry from "./telemetry"

import type { LLMEvent } from "@opencode-ai/llm"
import { SessionTelemetry as TelemetrySchema } from "@opencode-ai/schema/session-telemetry"
import { eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer, Queue } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionTelemetryTable } from "./sql"

export const Info = TelemetrySchema.Info
export type Info = TelemetrySchema.Info
export const Phase = TelemetrySchema.Phase
export type Phase = TelemetrySchema.Phase
export const Updated = TelemetrySchema.Updated

const FLUSH_DELAY_MS = 75
const IDLE_TTL_MS = 15 * 60_000
const MAX_LIVE_STATES = 2048
const monotonicNow = () => performance.now()

type ContentKind = "text" | "reasoning"

type MutableStep = {
  assistantMessageID?: string
  requestSentAt?: number
  firstTokenAt?: number
  streamedAt?: number
  completedAt?: number
  visibleChars: number
  reasoningChars: number
  generatedMs: number
  toolMs: number
  cost?: number
  tokens?: TelemetrySchema.Tokens
}

type MutableInfo = {
  sessionID: SessionSchema.ID
  phase: Phase
  turnStartedAt?: number
  phaseStartedAt?: number
  updatedAt: number
  model?: {
    providerID: string
    modelID: string
    name?: string
    variant?: string
    contextLimit?: number
  }
  context?: {
    model: {
      providerID: string
      modelID: string
      name?: string
      variant?: string
      contextLimit?: number
    }
    tokens: TelemetrySchema.Tokens
  }
  step?: MutableStep
  generatedMs: number
  toolMs: number
}

type LiveState = {
  info: MutableInfo
  contentStarts: Map<string, { readonly kind: ContentKind; readonly monotonicAt: number }>
  toolStarts: Map<string, number>
  /** Process-local monotonic anchors for live elapsed-time projection. */
  turnStartedMonotonic?: number
  phaseStartedMonotonic?: number
  stepGeneratedMs: number
  stepToolMs: number
  /** Provider events observed for the currently active physical attempt. Live-only. */
  providerEvents: number
  /** Linearization bit: newer transcript work claimed this still-unproven attempt. */
  providerPreempted: boolean
}

export type ProviderAttempt = {
  readonly assistantMessageID?: string
  readonly requestSentAt: number
  readonly observedEvents: number
  readonly streamedAt?: number
  readonly completedAt?: number
}

export type ProviderExecutionClaim =
  | { readonly kind: "retry"; readonly assistantMessageID?: string }
  | ({ readonly kind: "attempt" } & ProviderAttempt)

export type BeginInput = {
  readonly sessionID: string
  readonly assistantMessageID?: string
  readonly requestSentAt: number
  readonly model: {
    readonly providerID: string
    readonly modelID: string
    readonly name?: string
    readonly variant?: string
    readonly contextLimit?: number
  }
}

export type ObserveInput = {
  readonly sessionID: string
  readonly event: LLMEvent
  readonly at?: number
  /** Deterministic test/adapter override; production defaults to performance.now(). */
  readonly monotonicAt?: number
}

export type SettleInput = {
  readonly sessionID: string
  readonly assistantMessageID?: string
  readonly completedAt: number
  readonly cost?: number
  readonly tokens: TelemetrySchema.Tokens
}

export interface Interface {
  /**
   * Start a fresh user-visible turn before provider dispatch. This is the
   * semantic clock boundary; provider retries/tool loops call begin() without
   * resetting it.
   */
  readonly startTurn: (sessionID: string, at?: number, monotonicAt?: number) => Effect.Effect<void>
  /** Begin one provider attempt. Never reads storage or location services. */
  readonly begin: (input: BeginInput) => Effect.Effect<void>
  /**
   * Observe one provider event. Returns false when a zero-progress preemption
   * claim already owns this attempt, in which case the caller must not perform
   * event-specific side effects.
   */
  readonly observe: (input: ObserveInput) => Effect.Effect<boolean>
  /** Provider response body ended; local tools may still be settling. */
  readonly streamed: (sessionID: string, at?: number) => Effect.Effect<void>
  /** Persist one compact settled step; no token/delta writes reach SQLite. */
  readonly settle: (input: SettleInput) => Effect.Effect<void>
  readonly retry: (sessionID: string, at?: number) => Effect.Effect<void>
  readonly idle: (sessionID: string, at?: number) => Effect.Effect<void>
  readonly fail: (sessionID: string, at?: number) => Effect.Effect<void>
  /**
   * Snapshot the currently active physical provider attempt, if this process
   * owns one. This is descriptive liveness state, not admission/preemption
   * policy, and intentionally disappears when the process dies.
   */
  readonly providerAttempt: (sessionID: string) => Effect.Effect<ProviderAttempt | undefined>
  /**
   * Atomically claims zero-progress provider execution: either retry recovery
   * before its next physical request, or a live physical attempt that has
   * produced zero provider events. The optional assistant ID generation-fences
   * the claim. This is liveness synchronization only; callers own policy.
   */
  readonly claimUnprovenProviderExecution: (
    sessionID: string,
    assistantMessageID?: string,
  ) => Effect.Effect<ProviderExecutionClaim | undefined>
  /**
   * Snapshot the process-global live set without touching durable history or
   * materializing a Location/Instance. This intentionally reports only
   * non-idle in-memory telemetry states; durable rows are settled history.
   */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Bootstrap-free batched read. Storage only; never creates a Location/Instance. */
  readonly snapshot: (sessionIDs: readonly string[]) => Effect.Effect<Record<string, Info>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/SessionTelemetry") {}

function sessionID(value: string) {
  return SessionSchema.ID.make(value)
}

function messageID(value: string | undefined) {
  return value === undefined ? undefined : SessionMessage.ID.make(value)
}

function rowInfo(row: typeof SessionTelemetryTable.$inferSelect): Info {
  const hasStep =
    row.assistant_message_id !== null ||
    row.request_sent_at !== null ||
    row.first_token_at !== null ||
    row.streamed_at !== null ||
    row.completed_at !== null
  const hasModel = row.provider_id !== null || row.model_id !== null
  return {
    sessionID: row.session_id,
    phase: "idle",
    updatedAt: row.updated_at,
    model:
      hasModel && row.provider_id !== null && row.model_id !== null
        ? {
            providerID: row.provider_id,
            modelID: row.model_id,
            ...(row.model_name === null ? {} : { name: row.model_name }),
            ...(row.variant === null ? {} : { variant: row.variant }),
            ...(row.context_limit === null ? {} : { contextLimit: row.context_limit }),
          }
        : undefined,
    step: hasStep
      ? {
          ...(row.assistant_message_id === null ? {} : { assistantMessageID: row.assistant_message_id }),
          ...(row.request_sent_at === null ? {} : { requestSentAt: row.request_sent_at }),
          ...(row.first_token_at === null ? {} : { firstTokenAt: row.first_token_at }),
          ...(row.streamed_at === null ? {} : { streamedAt: row.streamed_at }),
          ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
          visibleChars: 0,
          reasoningChars: 0,
          generatedMs: 0,
          toolMs: 0,
          ...(row.cost_usd === null ? {} : { cost: row.cost_usd }),
          tokens: {
            input: row.tokens_input,
            output: row.tokens_output,
            reasoning: row.tokens_reasoning,
            cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
          },
        }
      : undefined,
    context:
      hasModel && row.provider_id !== null && row.model_id !== null
        ? {
            model: {
              providerID: row.provider_id,
              modelID: row.model_id,
              ...(row.model_name === null ? {} : { name: row.model_name }),
              ...(row.variant === null ? {} : { variant: row.variant }),
              ...(row.context_limit === null ? {} : { contextLimit: row.context_limit }),
            },
            tokens: {
              input: row.tokens_input,
              output: row.tokens_output,
              reasoning: row.tokens_reasoning,
              cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
            },
          }
        : undefined,
    generatedMs: row.generated_ms,
    toolMs: row.tool_ms,
  }
}

function cloneInfo(state: LiveState, sampledAt: number, sampledMonotonic: number): Info {
  const info = state.info
  return {
    ...info,
    sampledAt,
    ...(info.turnStartedAt === undefined || state.turnStartedMonotonic === undefined
      ? {}
      : { turnElapsedMs: Math.max(0, sampledMonotonic - state.turnStartedMonotonic) }),
    ...(info.phase === "idle" || info.phaseStartedAt === undefined || state.phaseStartedMonotonic === undefined
      ? {}
      : { phaseElapsedMs: Math.max(0, sampledMonotonic - state.phaseStartedMonotonic) }),
    model: info.model && { ...info.model },
    context: info.context && {
      model: { ...info.context.model },
      tokens: { ...info.context.tokens, cache: { ...info.context.tokens.cache } },
    },
    step: info.step && {
      ...info.step,
      tokens: info.step.tokens && { ...info.step.tokens, cache: { ...info.step.tokens.cache } },
    },
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const events = yield* EventV2.Service
    const states = new Map<SessionSchema.ID, LiveState>()
    const dirty = new Set<SessionSchema.ID>()
    const wake = yield* Queue.dropping<void>(1)

    const derivePhase = (state: LiveState): Phase => {
      if (state.info.phase === "retrying") return "retrying"
      if (state.toolStarts.size > 0) return "tool"
      for (const value of state.contentStarts.values()) if (value.kind === "reasoning") return "reasoning"
      for (const value of state.contentStarts.values()) if (value.kind === "text") return "generating"
      return state.info.step ? "requesting" : "idle"
    }

    const pruneStates = (now: number) => {
      for (const [id, state] of states) {
        if (state.info.phase !== "idle") continue
        if (now - state.info.updatedAt <= IDLE_TTL_MS) continue
        states.delete(id)
      }
      if (states.size <= MAX_LIVE_STATES) return
      const idle = Array.from(states.entries())
        .filter(([, state]) => state.info.phase === "idle")
        .sort((a, b) => a[1].info.updatedAt - b[1].info.updatedAt)
      for (const [id] of idle) {
        states.delete(id)
        if (states.size <= MAX_LIVE_STATES) break
      }
    }

    const mark = (id: SessionSchema.ID) =>
      Effect.sync(() => {
        dirty.add(id)
        Queue.offerUnsafe(wake, undefined)
      })

    const flush = Effect.fnUntraced(function* () {
      const ids = Array.from(dirty)
      dirty.clear()
      if (ids.length === 0) return
      const sampledAt = Date.now()
      const sampledMonotonic = monotonicNow()
      const items = ids.flatMap((id) => {
        const value = states.get(id)
        return value ? [cloneInfo(value, sampledAt, sampledMonotonic)] : []
      })
      if (items.length === 0) return
      yield* events.publish(TelemetrySchema.Updated, { items }).pipe(Effect.ignore)
    })

    // One process-global wake-driven flusher. It sleeps only after a producer
    // marks telemetry dirty; idle OpenCode pays no periodic timer cost.
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(wake).pipe(
          Effect.andThen(Effect.sleep(`${FLUSH_DELAY_MS} millis`)),
          Effect.andThen(flush()),
        ),
      ),
    )

    const fresh = (id: SessionSchema.ID, at: number): LiveState => ({
      info: {
        sessionID: id,
        phase: "idle",
        updatedAt: at,
        generatedMs: 0,
        toolMs: 0,
      },
      contentStarts: new Map(),
      toolStarts: new Map(),
      stepGeneratedMs: 0,
      stepToolMs: 0,
      providerEvents: 0,
      providerPreempted: false,
    })

    const stateFor = (value: string, at = Date.now()) => {
      const id = sessionID(value)
      let state = states.get(id)
      if (!state) {
        state = fresh(id, at)
        states.set(id, state)
      }
      return state
    }

    const loadState = Effect.fnUntraced(function* (value: string, at: number) {
      const id = sessionID(value)
      const existing = states.get(id)
      if (existing) return existing
      const row = yield* readDb
        .select()
        .from(SessionTelemetryTable)
        .where(eq(SessionTelemetryTable.session_id, id))
        .get()
        .pipe(Effect.orDie)
      const state: LiveState = row
        ? {
            info: rowInfo(row),
            contentStarts: new Map(),
            toolStarts: new Map(),
            stepGeneratedMs: 0,
            stepToolMs: 0,
            providerEvents: 0,
            providerPreempted: false,
          }
        : fresh(id, at)
      states.set(id, state)
      return state
    })

    const touch = (state: LiveState, at: number, monotonicAt: number) => {
      const previous = state.info.phase
      state.info.updatedAt = at
      const next = derivePhase(state)
      state.info.phase = next
      if (next !== previous) {
        state.info.phaseStartedAt = at
        state.phaseStartedMonotonic = monotonicAt
      }
      pruneStates(at)
      return mark(state.info.sessionID)
    }

    const firstToken = (state: LiveState, at: number) => {
      const step = state.info.step!
      if (!step || step.firstTokenAt !== undefined) return
      step.firstTokenAt = at
    }

    const closeContent = (state: LiveState, key: string, monotonicAt: number) => {
      const start = state.contentStarts.get(key)
      if (!start) return
      state.contentStarts.delete(key)
      if (monotonicAt > start.monotonicAt) {
        const elapsed = monotonicAt - start.monotonicAt
        state.stepGeneratedMs += elapsed
        state.info.generatedMs += elapsed
        if (state.info.step) state.info.step.generatedMs += elapsed
      }
    }

    const closeTool = (state: LiveState, key: string, monotonicAt: number) => {
      const start = state.toolStarts.get(key)
      if (start === undefined) return
      state.toolStarts.delete(key)
      if (monotonicAt > start) {
        const elapsed = monotonicAt - start
        state.stepToolMs += elapsed
        state.info.toolMs += elapsed
        if (state.info.step) state.info.step.toolMs += elapsed
      }
    }

    const closeAllContent = (state: LiveState, monotonicAt: number) => {
      for (const key of Array.from(state.contentStarts.keys())) closeContent(state, key, monotonicAt)
    }

    const closeAllTools = (state: LiveState, monotonicAt: number) => {
      for (const key of Array.from(state.toolStarts.keys())) closeTool(state, key, monotonicAt)
    }

    const startTurn = Effect.fnUntraced(function* (
      value: string,
      timestamp = Date.now(),
      monotonicAt = monotonicNow(),
    ) {
      const state = yield* loadState(value, timestamp)
      // A semantic turn boundary may follow a completed provider/tool cycle
      // without the Session itself becoming idle (queued input, Goal
      // continuation). Reset only live attempt state; full-session counters and
      // the latest settled context remain intact.
      closeAllContent(state, monotonicAt)
      closeAllTools(state, monotonicAt)
      state.contentStarts.clear()
      state.toolStarts.clear()
      state.stepGeneratedMs = 0
      state.stepToolMs = 0
      state.providerEvents = 0
      state.providerPreempted = false
      state.info.turnStartedAt = timestamp
      state.turnStartedMonotonic = monotonicAt
      state.info.phase = "requesting"
      state.info.phaseStartedAt = timestamp
      state.phaseStartedMonotonic = monotonicAt
      state.info.updatedAt = timestamp
      state.info.step = undefined
      pruneStates(timestamp)
      yield* mark(state.info.sessionID)
    })

    const begin = Effect.fnUntraced(function* (input: BeginInput) {
      const at = input.requestSentAt
      const monotonicAt = monotonicNow()
      const state = yield* loadState(input.sessionID, at)
      state.contentStarts.clear()
      state.toolStarts.clear()
      const preservePreemption = state.info.phase === "retrying" && state.providerPreempted
      state.stepGeneratedMs = 0
      state.stepToolMs = 0
      state.providerEvents = 0
      state.providerPreempted = preservePreemption
      // `begin` is provider-step scoped and may run repeatedly inside one
      // user-visible turn (tool loops, retries, continuations). startTurn() owns
      // semantic resets; begin() is only the compatibility fallback for callers
      // that have not established the turn boundary explicitly.
      if (state.info.turnStartedAt === undefined) {
        state.info.turnStartedAt = at
        state.turnStartedMonotonic = monotonicAt
      } else {
        // Defensive recovery for a state created before monotonic anchors were
        // introduced; never replace an established turn anchor.
        state.turnStartedMonotonic ??= monotonicAt
      }
      state.info.phase = "requesting"
      state.info.phaseStartedAt = at
      state.phaseStartedMonotonic = monotonicAt
      state.info.updatedAt = at
      state.info.model = { ...input.model }
      state.info.step = {
        ...(input.assistantMessageID === undefined ? {} : { assistantMessageID: input.assistantMessageID }),
        requestSentAt: input.requestSentAt,
        visibleChars: 0,
        reasoningChars: 0,
        generatedMs: 0,
        toolMs: 0,
      }
      pruneStates(at)
      yield* mark(state.info.sessionID)
    })

    const observe = Effect.fnUntraced(function* (input: ObserveInput) {
      const at = input.at ?? Date.now()
      const monotonicAt = input.monotonicAt ?? monotonicNow()
      const state = stateFor(input.sessionID, at)
      if (!state.info.step) {
        state.info.step = { visibleChars: 0, reasoningChars: 0, generatedMs: 0, toolMs: 0 }
      }
      const step = state.info.step
      const event = input.event
      if (state.providerPreempted) return false
      state.providerEvents++
      switch (event.type) {
        case "reasoning-start": {
          firstToken(state, at)
          state.contentStarts.set(`reasoning:${event.id}`, { kind: "reasoning", monotonicAt })
          break
        }
        case "reasoning-delta": {
          firstToken(state, at)
          step.reasoningChars += event.text.length
          if (!state.contentStarts.has(`reasoning:${event.id}`))
            state.contentStarts.set(`reasoning:${event.id}`, { kind: "reasoning", monotonicAt })
          break
        }
        case "reasoning-end":
          closeContent(state, `reasoning:${event.id}`, monotonicAt)
          break
        case "text-start": {
          firstToken(state, at)
          state.contentStarts.set(`text:${event.id}`, { kind: "text", monotonicAt })
          break
        }
        case "text-delta": {
          firstToken(state, at)
          step.visibleChars += event.text.length
          if (!state.contentStarts.has(`text:${event.id}`))
            state.contentStarts.set(`text:${event.id}`, { kind: "text", monotonicAt })
          break
        }
        case "text-end":
          closeContent(state, `text:${event.id}`, monotonicAt)
          break
        case "tool-call":
          if (!state.toolStarts.has(event.id)) state.toolStarts.set(event.id, monotonicAt)
          break
        case "tool-result":
        case "tool-error":
          closeTool(state, event.id, monotonicAt)
          break
      }
      yield* touch(state, at, monotonicAt)
      return true
    })

    const streamed = Effect.fnUntraced(function* (value: string, timestamp = Date.now()) {
      const monotonicAt = monotonicNow()
      const state = stateFor(value, timestamp)
      closeAllContent(state, monotonicAt)
      if (state.info.step) state.info.step.streamedAt ??= timestamp
      yield* touch(state, timestamp, monotonicAt)
    })

    const settle = Effect.fnUntraced(function* (input: SettleInput) {
      const id = sessionID(input.sessionID)
      const monotonicAt = monotonicNow()
      const state = stateFor(input.sessionID, input.completedAt)
      closeAllContent(state, monotonicAt)
      closeAllTools(state, monotonicAt)
      const model = state.info.model
      const step: MutableStep = state.info.step ?? {
        visibleChars: 0,
        reasoningChars: 0,
        generatedMs: 0,
        toolMs: 0,
      }
      step.assistantMessageID = input.assistantMessageID ?? step.assistantMessageID
      step.completedAt = input.completedAt
      step.cost = input.cost
      step.tokens = input.tokens

      const stored = yield* db
        .insert(SessionTelemetryTable)
        .values({
          session_id: id,
          assistant_message_id: messageID(step.assistantMessageID),
          provider_id: model?.providerID,
          model_id: model?.modelID,
          model_name: model?.name,
          variant: model?.variant,
          context_limit: model?.contextLimit,
          request_sent_at: step.requestSentAt,
          first_token_at: step.firstTokenAt,
          streamed_at: step.streamedAt,
          completed_at: step.completedAt,
          cost_usd: input.cost,
          tokens_input: input.tokens.input,
          tokens_output: input.tokens.output,
          tokens_reasoning: input.tokens.reasoning,
          tokens_cache_read: input.tokens.cache.read,
          tokens_cache_write: input.tokens.cache.write,
          generated_ms: state.stepGeneratedMs,
          tool_ms: state.stepToolMs,
          updated_at: input.completedAt,
        })
        .onConflictDoUpdate({
          target: SessionTelemetryTable.session_id,
          set: {
            assistant_message_id: messageID(step.assistantMessageID),
            provider_id: model?.providerID,
            model_id: model?.modelID,
            model_name: model?.name,
            variant: model?.variant,
            context_limit: model?.contextLimit,
            request_sent_at: step.requestSentAt,
            first_token_at: step.firstTokenAt,
            streamed_at: step.streamedAt,
            completed_at: step.completedAt,
            cost_usd: input.cost,
            tokens_input: input.tokens.input,
            tokens_output: input.tokens.output,
            tokens_reasoning: input.tokens.reasoning,
            tokens_cache_read: input.tokens.cache.read,
            tokens_cache_write: input.tokens.cache.write,
            generated_ms: sql`CASE WHEN ${SessionTelemetryTable.assistant_message_id} = excluded.assistant_message_id THEN ${SessionTelemetryTable.generated_ms} ELSE ${SessionTelemetryTable.generated_ms} + excluded.generated_ms END`,
            tool_ms: sql`CASE WHEN ${SessionTelemetryTable.assistant_message_id} = excluded.assistant_message_id THEN ${SessionTelemetryTable.tool_ms} ELSE ${SessionTelemetryTable.tool_ms} + excluded.tool_ms END`,
            updated_at: input.completedAt,
          },
        })
        .returning({ generatedMs: SessionTelemetryTable.generated_ms, toolMs: SessionTelemetryTable.tool_ms })
        .get()
        .pipe(Effect.orDie)

      state.stepGeneratedMs = 0
      state.stepToolMs = 0
      state.contentStarts.clear()
      state.toolStarts.clear()
      state.info.generatedMs = stored?.generatedMs ?? state.info.generatedMs
      state.info.toolMs = stored?.toolMs ?? state.info.toolMs
      state.info.phase = "requesting"
      state.info.phaseStartedAt = input.completedAt
      state.phaseStartedMonotonic = monotonicAt
      state.info.updatedAt = input.completedAt
      state.info.step = step
      if (model) state.info.context = { model: { ...model }, tokens: { ...input.tokens, cache: { ...input.tokens.cache } } }
      yield* mark(id)
    })

    const retry = Effect.fnUntraced(function* (value: string, timestamp = Date.now()) {
      const monotonicAt = monotonicNow()
      const state = stateFor(value, timestamp)
      closeAllContent(state, monotonicAt)
      closeAllTools(state, monotonicAt)
      state.info.phase = "retrying"
      state.info.phaseStartedAt = timestamp
      state.phaseStartedMonotonic = monotonicAt
      state.info.updatedAt = timestamp
      yield* mark(state.info.sessionID)
    })

    const idle = Effect.fnUntraced(function* (value: string, timestamp = Date.now()) {
      const monotonicAt = monotonicNow()
      const state = stateFor(value, timestamp)
      closeAllContent(state, monotonicAt)
      closeAllTools(state, monotonicAt)
      state.info.phase = "idle"
      state.providerPreempted = false
      state.info.turnStartedAt = undefined
      state.turnStartedMonotonic = undefined
      state.info.phaseStartedAt = timestamp
      state.phaseStartedMonotonic = monotonicAt
      state.info.updatedAt = timestamp
      pruneStates(timestamp)
      yield* mark(state.info.sessionID)
    })

    const fail = Effect.fnUntraced(function* (value: string, timestamp = Date.now()) {
      yield* idle(value, timestamp)
    })

    const providerAttempt = Effect.fnUntraced(function* (value: string) {
      const state = states.get(sessionID(value))
      const step = state?.info.step
      if (!state || state.info.phase === "idle" || state.info.phase === "retrying" || step?.requestSentAt === undefined)
        return undefined
      return {
        ...(step.assistantMessageID === undefined ? {} : { assistantMessageID: step.assistantMessageID }),
        requestSentAt: step.requestSentAt,
        observedEvents: state.providerEvents,
        ...(step.streamedAt === undefined ? {} : { streamedAt: step.streamedAt }),
        ...(step.completedAt === undefined ? {} : { completedAt: step.completedAt }),
      } satisfies ProviderAttempt
    })

    const claimUnprovenProviderExecution = Effect.fnUntraced(function* (
      value: string,
      expectedAssistantMessageID?: string,
    ) {
      const state = states.get(sessionID(value))
      const step = state?.info.step
      if (
        !state ||
        state.info.phase === "idle" ||
        state.providerPreempted ||
        (expectedAssistantMessageID !== undefined && step?.assistantMessageID !== expectedAssistantMessageID)
      )
        return undefined

      if (state.info.phase === "retrying") {
        state.providerPreempted = true
        return {
          kind: "retry",
          ...(step?.assistantMessageID === undefined ? {} : { assistantMessageID: step.assistantMessageID }),
        } satisfies ProviderExecutionClaim
      }

      if (
        step?.requestSentAt === undefined ||
        state.providerEvents !== 0 ||
        step.streamedAt !== undefined ||
        step.completedAt !== undefined
      )
        return undefined

      state.providerPreempted = true
      return {
        kind: "attempt",
        ...(step.assistantMessageID === undefined ? {} : { assistantMessageID: step.assistantMessageID }),
        requestSentAt: step.requestSentAt,
        observedEvents: 0,
      } satisfies ProviderExecutionClaim
    })

    const active = Effect.sync(() => {
      const result = new Set<SessionSchema.ID>()
      for (const [id, state] of states) {
        if (state.info.phase !== "idle") result.add(id)
      }
      return result as ReadonlySet<SessionSchema.ID>
    })

    const snapshot = Effect.fn("SessionTelemetry.snapshot")(function* (values: readonly string[]) {
      const ids = Array.from(new Set(values.map(sessionID)))
      if (ids.length === 0) return {} as Record<string, Info>
      const rows = yield* readDb
        .select()
        .from(SessionTelemetryTable)
        .where(inArray(SessionTelemetryTable.session_id, ids))
        .all()
        .pipe(Effect.orDie)
      // Capture the projection sample after storage I/O so a slow cold read
      // cannot make a reconnect snapshot under-report a quiet live interval.
      const sampledAt = Date.now()
      const sampledMonotonic = monotonicNow()
      const result: Record<string, Info> = Object.fromEntries(
        rows.map((row) => [row.session_id, { ...rowInfo(row), sampledAt }]),
      )
      for (const id of ids) {
        const live = states.get(id)
        if (live) result[id] = cloneInfo(live, sampledAt, sampledMonotonic)
      }
      return result
    })

    return Service.of({
      startTurn,
      begin,
      observe,
      streamed,
      settle,
      retry,
      idle,
      fail,
      providerAttempt,
      claimUnprovenProviderExecution,
      active,
      snapshot,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
