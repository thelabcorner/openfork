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
  contentStarts: Map<string, { readonly kind: ContentKind; readonly at: number }>
  toolStarts: Map<string, number>
  stepGeneratedMs: number
  stepToolMs: number
}

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
}

export type SettleInput = {
  readonly sessionID: string
  readonly assistantMessageID?: string
  readonly completedAt: number
  readonly cost?: number
  readonly tokens: TelemetrySchema.Tokens
}

export interface Interface {
  /** Begin one provider attempt. Never reads storage or location services. */
  readonly begin: (input: BeginInput) => Effect.Effect<void>
  /** Observe one already-produced provider event; O(1), memory-only. */
  readonly observe: (input: ObserveInput) => Effect.Effect<void>
  /** Provider response body ended; local tools may still be settling. */
  readonly streamed: (sessionID: string, at?: number) => Effect.Effect<void>
  /** Persist one compact settled step; no token/delta writes reach SQLite. */
  readonly settle: (input: SettleInput) => Effect.Effect<void>
  readonly retry: (sessionID: string, at?: number) => Effect.Effect<void>
  readonly idle: (sessionID: string, at?: number) => Effect.Effect<void>
  readonly fail: (sessionID: string, at?: number) => Effect.Effect<void>
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

function cloneInfo(info: MutableInfo): Info {
  return {
    ...info,
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
      const items = ids.flatMap((id) => {
        const value = states.get(id)
        return value ? [cloneInfo(value.info)] : []
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
          }
        : fresh(id, at)
      states.set(id, state)
      return state
    })

    const touch = (state: LiveState, at: number) => {
      const previous = state.info.phase
      state.info.updatedAt = at
      const next = derivePhase(state)
      state.info.phase = next
      if (next !== previous) state.info.phaseStartedAt = at
      pruneStates(at)
      return mark(state.info.sessionID)
    }

    const firstToken = (state: LiveState, at: number) => {
      const step = state.info.step!
      if (!step || step.firstTokenAt !== undefined) return
      step.firstTokenAt = at
    }

    const closeContent = (state: LiveState, key: string, at: number) => {
      const start = state.contentStarts.get(key)
      if (!start) return
      state.contentStarts.delete(key)
      if (at > start.at) {
        const elapsed = at - start.at
        state.stepGeneratedMs += elapsed
        state.info.generatedMs += elapsed
        if (state.info.step) state.info.step.generatedMs += elapsed
      }
    }

    const closeTool = (state: LiveState, key: string, at: number) => {
      const start = state.toolStarts.get(key)
      if (start === undefined) return
      state.toolStarts.delete(key)
      if (at > start) {
        const elapsed = at - start
        state.stepToolMs += elapsed
        state.info.toolMs += elapsed
        if (state.info.step) state.info.step.toolMs += elapsed
      }
    }

    const closeAllContent = (state: LiveState, at: number) => {
      for (const key of Array.from(state.contentStarts.keys())) closeContent(state, key, at)
    }

    const closeAllTools = (state: LiveState, at: number) => {
      for (const key of Array.from(state.toolStarts.keys())) closeTool(state, key, at)
    }

    const begin = Effect.fnUntraced(function* (input: BeginInput) {
      const at = input.requestSentAt
      const state = yield* loadState(input.sessionID, at)
      state.contentStarts.clear()
      state.toolStarts.clear()
      state.stepGeneratedMs = 0
      state.stepToolMs = 0
      state.info.phase = "requesting"
      state.info.phaseStartedAt = at
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
      const state = stateFor(input.sessionID, at)
      if (!state.info.step) {
        state.info.step = { visibleChars: 0, reasoningChars: 0, generatedMs: 0, toolMs: 0 }
      }
      const step = state.info.step
      const event = input.event
      switch (event.type) {
        case "reasoning-start": {
          firstToken(state, at)
          state.contentStarts.set(`reasoning:${event.id}`, { kind: "reasoning", at })
          break
        }
        case "reasoning-delta": {
          firstToken(state, at)
          step.reasoningChars += event.text.length
          if (!state.contentStarts.has(`reasoning:${event.id}`))
            state.contentStarts.set(`reasoning:${event.id}`, { kind: "reasoning", at })
          break
        }
        case "reasoning-end":
          closeContent(state, `reasoning:${event.id}`, at)
          break
        case "text-start": {
          firstToken(state, at)
          state.contentStarts.set(`text:${event.id}`, { kind: "text", at })
          break
        }
        case "text-delta": {
          firstToken(state, at)
          step.visibleChars += event.text.length
          if (!state.contentStarts.has(`text:${event.id}`))
            state.contentStarts.set(`text:${event.id}`, { kind: "text", at })
          break
        }
        case "text-end":
          closeContent(state, `text:${event.id}`, at)
          break
        case "tool-call":
          if (!state.toolStarts.has(event.id)) state.toolStarts.set(event.id, at)
          break
        case "tool-result":
        case "tool-error":
          closeTool(state, event.id, at)
          break
      }
      yield* touch(state, at)
    })

    const streamed = Effect.fnUntraced(function* (value: string, timestamp = Date.now()) {
      const state = stateFor(value, timestamp)
      closeAllContent(state, timestamp)
      if (state.info.step) state.info.step.streamedAt ??= timestamp
      yield* touch(state, timestamp)
    })

    const settle = Effect.fnUntraced(function* (input: SettleInput) {
      const id = sessionID(input.sessionID)
      const state = stateFor(input.sessionID, input.completedAt)
      const streamedAt = state.info.step?.streamedAt ?? input.completedAt
      closeAllContent(state, streamedAt)
      closeAllTools(state, input.completedAt)
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
      state.info.updatedAt = input.completedAt
      state.info.step = step
      if (model) state.info.context = { model: { ...model }, tokens: { ...input.tokens, cache: { ...input.tokens.cache } } }
      yield* mark(id)
    })

    const retry = Effect.fnUntraced(function* (value: string, timestamp = Date.now()) {
      const state = stateFor(value, timestamp)
      closeAllContent(state, timestamp)
      closeAllTools(state, timestamp)
      state.info.phase = "retrying"
      state.info.phaseStartedAt = timestamp
      state.info.updatedAt = timestamp
      yield* mark(state.info.sessionID)
    })

    const idle = Effect.fnUntraced(function* (value: string, timestamp = Date.now()) {
      const state = stateFor(value, timestamp)
      closeAllContent(state, timestamp)
      closeAllTools(state, timestamp)
      state.info.phase = "idle"
      state.info.phaseStartedAt = timestamp
      state.info.updatedAt = timestamp
      pruneStates(timestamp)
      yield* mark(state.info.sessionID)
    })

    const fail = Effect.fnUntraced(function* (value: string, timestamp = Date.now()) {
      yield* idle(value, timestamp)
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
      const result: Record<string, Info> = Object.fromEntries(rows.map((row) => [row.session_id, rowInfo(row)]))
      for (const id of ids) {
        const live = states.get(id)
        if (live) result[id] = cloneInfo(live.info)
      }
      return result
    })

    return Service.of({ begin, observe, streamed, settle, retry, idle, fail, snapshot })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
