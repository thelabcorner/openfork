export * as SpecialAgentSession from "./special-agent-session"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { LLMEvent, LLMResponse, type ToolResultValue } from "@opencode-ai/llm"
import { makeGlobalNode } from "./effect/app-node"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { ModelV2 } from "./model"
import { SessionEvent } from "./session/event"
import { SessionHostChild } from "./session/host-child"
import { SessionMessage } from "./session/message"
import { SessionSchema } from "./session/schema"
import { SessionTable } from "./session/sql"
import { UsageRecord } from "./usage/record"
import { createLLMEventPublisher } from "./session/runner/publish-llm-event"
import { Hash } from "./util/hash"

/**
 * Host-owned special agents that execute their own provider turns instead of
 * routing through the normal Session runner. They share one durable transcript
 * contract so their work is inspectable exactly like ordinary chat:
 *
 * - one durable child Session per (owner, agent) pair, created through
 *   `SessionHostChild.ensure`;
 * - every provider turn published through `createLLMEventPublisher`, the same
 *   publication seam the normal Session runner uses;
 * - mid-conversation system instructions published as `SessionEvent.ContextUpdated`;
 * - physical provider requests recorded through the shared `UsageRecord`.
 *
 * The set is deliberately closed: adding a special agent means extending this
 * union and the session-group/V1 guards that key off it, not inventing a second
 * execution contract.
 */
export const Kind = Schema.Literals(["goal_auditor", "prompt_revisor", "session_title", "spad_auditor"]).annotate({
  identifier: "SpecialAgentSession.Kind",
})
export type Kind = typeof Kind.Type

export const METADATA_KEY = "specialAgent"
export const OWNER_KIND_KEY = "specialAgentOwnerKind"
export const OWNER_ID_KEY = "specialAgentOwnerID"

export const OWNER_GOAL = "goal"
export const OWNER_SESSION = "session"

export interface ProvisionInput {
  readonly ownerKind: string
  readonly ownerID: string
  readonly agent: Kind
  /** Durable parent that supplies project/workspace/location identity. */
  readonly parentSessionID: SessionSchema.ID
  readonly title: string
  readonly model?: ModelV2.Ref
  /** Extra metadata merged into the child Session row (for example `goalID`). */
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface Interface {
  /** Idempotently provision the durable transcript for one (owner, agent) pair. */
  readonly provision: (input: ProvisionInput) => Effect.Effect<SessionSchema.ID, SessionHostChild.ParentNotFoundError>
  /** Deterministic Session id for an owner/agent pair, without touching storage. */
  readonly sessionFor: (input: { readonly ownerKind: string; readonly ownerID: string; readonly agent: Kind }) => SessionSchema.ID
  /** Whether a Session id is any host-owned special-agent transcript. */
  readonly is: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Publish one durable mid-conversation system instruction into the transcript. */
  readonly publishSystem: (input: { readonly sessionID: SessionSchema.ID; readonly text: string }) => Effect.Effect<void>
  /** Shared provider-turn publisher for this transcript. */
  readonly publisher: (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: Kind
    readonly model: ModelV2.Ref
  }) => ReturnType<typeof createLLMEventPublisher>
  /**
   * Close one published provider turn exactly like the normal Session runner:
   * settle any local tool results, flush the publisher, start the assistant
   * message, and publish the terminal `Step.Ended` settlement. Every special
   * agent must call this once per completed provider turn.
   */
  readonly settleTurn: (input: {
    readonly sessionID: SessionSchema.ID
    readonly publisher: ReturnType<typeof createLLMEventPublisher>
    readonly response: LLMResponse
    readonly toolResults?: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly result: ToolResultValue
    }>
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly finish?: string
    readonly cost?: number
  }) => Effect.Effect<SessionMessage.ID>
  /** Shared maintenance accounting for host-owned support-agent requests. */
  readonly recordMaintenance: (input: UsageRecord.MaintenanceRecordInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/SpecialAgentSession") {}

const shortAgent = (agent: Kind) => agent.replace(/[^a-z0-9]/g, "")

/**
 * Deterministic id keeps provisioning idempotent under concurrency without a
 * linkage table: two racing callers derive the same id, and `SessionHostChild.ensure`
 * returns the already-projected row for the loser.
 */
export const sessionIDFor = (input: { readonly ownerKind: string; readonly ownerID: string; readonly agent: Kind }) =>
  SessionSchema.ID.make(
    `ses_sa_${shortAgent(input.agent)}_${Hash.sha256(`${input.ownerKind}\u0000${input.ownerID}\u0000${input.agent}`).slice(0, 32)}`,
  )

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const children = yield* SessionHostChild.Service
    const usage = yield* UsageRecord.Service

    const sessionFor: Interface["sessionFor"] = (input) => sessionIDFor(input)

    const provision = Effect.fn("SpecialAgentSession.provision")(function* (input: ProvisionInput) {
      const sessionID = sessionFor(input)
      yield* children.ensure({
        id: sessionID,
        parentSessionID: input.parentSessionID,
        title: input.title,
        ...(input.model ? { model: input.model } : {}),
        metadata: {
          [METADATA_KEY]: input.agent,
          [OWNER_KIND_KEY]: input.ownerKind,
          [OWNER_ID_KEY]: input.ownerID,
          ...input.metadata,
        },
      })
      return sessionID
    })

    const is = Effect.fn("SpecialAgentSession.is")(function* (sessionID: SessionSchema.ID) {
      const row = yield* database.readDb
        .select({ sessionID: SessionTable.id })
        .from(SessionTable)
        .where(sql`${SessionTable.id} = ${sessionID} AND json_extract(${SessionTable.metadata}, '$.specialAgent') IS NOT NULL`)
        .get()
        .pipe(Effect.orDie)
      return row !== undefined
    })

    const publishSystem = Effect.fn("SpecialAgentSession.publishSystem")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly text: string
    }) {
      yield* events.publish(SessionEvent.ContextUpdated, {
        sessionID: input.sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        text: input.text,
      })
    })

    const publisher: Interface["publisher"] = (input) =>
      createLLMEventPublisher(events, { sessionID: input.sessionID, agent: input.agent, model: input.model })

    const settleTurn = Effect.fn("SpecialAgentSession.settleTurn")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly publisher: ReturnType<typeof createLLMEventPublisher>
      readonly response: LLMResponse
      readonly toolResults?: ReadonlyArray<{
        readonly id: string
        readonly name: string
        readonly result: ToolResultValue
      }>
      readonly tokens: {
        readonly input: number
        readonly output: number
        readonly reasoning: number
        readonly cache: { readonly read: number; readonly write: number }
      }
      readonly finish?: string
      readonly cost?: number
    }) {
      for (const result of input.toolResults ?? []) {
        yield* input.publisher.publish(LLMEvent.toolResult({ id: result.id, name: result.name, result: result.result }))
      }
      yield* input.publisher.flush()
      const assistantMessageID = yield* input.publisher.startAssistant()
      const settlement = input.publisher.stepSettlement()
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        finish: settlement?.finish ?? input.finish ?? input.response.finishReason,
        cost: input.cost ?? 0,
        tokens: settlement?.tokens ?? input.tokens,
      })
      return assistantMessageID
    })

    return Service.of({
      provision,
      sessionFor,
      is,
      publishSystem,
      publisher,
      settleTurn,
      recordMaintenance: usage.recordMaintenance,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionHostChild.node, UsageRecord.node],
})
