import { Effect, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageID, SessionID } from "./schema"

/**
 * Protocol-neutral Session prompt contract shared by trusted host producers.
 *
 * Keep this module free of SessionPrompt runtime implementation dependencies.
 * Delegation, background delivery, and other host producers may depend on this
 * contract without importing the giant prompt runtime or a model-facing tool.
 */
export const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  accountID: Schema.optional(Schema.String),
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  subProvider: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

/** Trusted producer attribution for host-authored conversational turns. */
export type HostPromptProvenance =
  | {
      readonly source: typeof SessionTurnProvenance.Source.OxpDelegation
      readonly sourceMessageID?: MessageID
      /** Durable per-turn correlation persisted in message provenance. */
      readonly ref: string
      /**
       * Trusted producer principal used only for host-admission authorization.
       * This is intentionally not persisted into message provenance: OXP worker
       * turns keep ref available for the per-invocation correlation identity.
       */
      readonly principalRef: string
    }
  | {
      readonly source: Exclude<
        SessionTurnProvenance.CanonicalHostSource,
        typeof SessionTurnProvenance.Source.OxpDelegation
      >
      readonly sourceMessageID?: MessageID
      readonly ref?: string
      readonly principalRef?: never
    }

/** Trusted producer attribution for first-party user-owned actions. */
export interface UserActionPromptProvenance {
  readonly source: SessionTurnProvenance.CanonicalUserSource
}

/**
 * Session-owned runtime control contract injected into host producers.
 * No model-facing tool owns this interface.
 */
export interface SessionPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<PromptInput["parts"]>
  prompt(input: PromptInput, provenance?: HostPromptProvenance): Effect.Effect<SessionV1.WithParts>
  dispatch?(
    input: PromptInput,
    options?: { wait?: boolean; provenance?: HostPromptProvenance },
  ): Effect.Effect<{ admitted: SessionV1.WithParts; paused: boolean; result?: SessionV1.WithParts }>
}

export * as SessionPromptContract from "./prompt-contract"
