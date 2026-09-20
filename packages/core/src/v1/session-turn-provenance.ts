export * as SessionTurnProvenance from "./session-turn-provenance"

import type {
  Info,
  MessageID,
  UserTurnProvenance,
  WithParts,
} from "@opencode-ai/schema/session-v1"
import { UserTurnSource } from "@opencode-ai/schema/session-v1"
import { SessionTurnProvenance as SharedTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"

/**
 * Stable semantic sources for durable V1 user-role turns. `owner` is the
 * security/ownership boundary; `source` is attribution/correlation only.
 */
export const Source = UserTurnSource

export type Source = UserTurnSource
export type CanonicalHostSource = SharedTurnProvenance.CanonicalHostSource
export type CanonicalUserSource = SharedTurnProvenance.CanonicalUserSource

export type Resolved = UserTurnProvenance & {
  /** Explicit means the producer stamped ownership. Legacy inference is best-effort only. */
  readonly confidence: "explicit" | "legacy-inferred"
}

/**
 * V1 compatibility view of the current/V2 semantic message taxonomy. V1 stores
 * several host/runtime messages with `role: "user"`; consumers that care about
 * conversational ownership should use this classifier instead of provider role.
 */
export type SemanticKind = "user" | "synthetic" | "shell" | "compaction" | "assistant"

type InfoProvenance =
  | { readonly owner: "user"; readonly source: string; readonly lifetime?: "historical" }
  | {
      readonly owner: "host"
      readonly source: string
      readonly sourceMessageID?: string
      readonly ref?: string
      readonly lifetime?: "historical"
    }

type TurnInfo = {
  readonly id?: MessageID
  readonly role?: Info["role"]
  readonly provenance?: InfoProvenance
}

type ClassificationInfo = SharedTurnProvenance.InfoLike

type ResolvedInfo = InfoProvenance & {
  readonly confidence: "explicit" | "legacy-inferred"
}

const policy = SharedTurnProvenance.policy
const LEGACY_SHELL_SOURCE = "legacy.shell"
const LEGACY_SHELL_SYNTHETIC_USER_TEXT = "The following tool was executed by the user"

export function user(source: string): UserTurnProvenance {
  SharedTurnProvenance.assertCanonicalOwner(source, "user")
  return { owner: "user", source }
}

/** Host producers that continue an existing worker turn must preserve its canonical causal root. */
export function requiresCausalRoot(source: string) {
  return SharedTurnProvenance.requiresCausalRoot(source)
}

export function host(
  source: string,
  input?: { sourceMessageID?: MessageID; ref?: string },
): UserTurnProvenance {
  SharedTurnProvenance.assertCanonicalOwner(source, "host")
  if (requiresCausalRoot(source) && !input?.sourceMessageID) {
    throw new Error(`Host turn source ${source} requires a canonical sourceMessageID`)
  }
  if (SharedTurnProvenance.requiresCorrelation(source) && !input?.ref) {
    throw new Error(`Host turn source ${source} requires a durable correlation ref`)
  }
  return {
    owner: "host",
    source,
    ...(input?.sourceMessageID ? { sourceMessageID: input.sourceMessageID } : {}),
    ...(input?.ref ? { ref: input.ref } : {}),
  }
}

/**
 * Canonical causal root from message metadata alone. New explicit host
 * provenance is already root-flattened; legacy/independent worker roots
 * resolve to their own durable message id.
 */
export function causalRootMessageIDInfo(info: TurnInfo | undefined): MessageID | undefined {
  if (!info || info.role !== "user" || !info.id) return undefined
  const provenance = info.provenance
  if (SharedTurnProvenance.isHistorical(provenance)) return undefined
  if (provenance?.owner === "host" && SharedTurnProvenance.isStateProjection(provenance.source)) return undefined
  if (provenance?.owner === "host" && provenance.sourceMessageID) return provenance.sourceMessageID as MessageID
  return info.id
}

/** Construct a host-derived turn while flattening any host predecessor to its canonical worker root. */
export function hostDerived(
  source: string,
  parent: TurnInfo,
  input?: { ref?: string },
): UserTurnProvenance {
  if (!requiresCausalRoot(source)) throw new Error(`Host turn source ${source} is not a derived causal source`)
  const sourceMessageID = causalRootMessageIDInfo(parent)
  if (!sourceMessageID) throw new Error(`Host turn source ${source} requires a user-role causal parent`)
  return host(source, { sourceMessageID, ...(input?.ref ? { ref: input.ref } : {}) })
}

/**
 * Compatibility resolver for persisted messages predating message-level
 * provenance. All new code should stamp provenance at the producer; only this
 * module is allowed to infer legacy ownership from parts.
 */
export function resolve(message: WithParts): Resolved | undefined {
  if (message.info.role !== "user") return undefined
  if (message.info.provenance) return { ...message.info.provenance, confidence: "explicit" }

  // Very old direct-shell turns predate message-level provenance and were
  // represented as a synthetic-only user row with this host-generated sentinel.
  // Keep this one shape compatibility rule here so replay/CLI/UI consumers never
  // infer it independently.
  const legacyShell = message.parts.some(
    (part) =>
      part.type === "text" &&
      part.synthetic === true &&
      part.text === LEGACY_SHELL_SYNTHETIC_USER_TEXT,
  )
  if (legacyShell) {
    return { owner: "user", source: LEGACY_SHELL_SOURCE, confidence: "legacy-inferred" }
  }

  // Preserve the old worker-prompt heuristic for legacy rows. File/agent/subtask
  // turns are also user-owned inputs when no explicit provenance exists. A
  // compaction or synthetic-only text turn is treated as host-owned. Replay rows
  // from very old databases can be intrinsically ambiguous; confidence exposes
  // that limitation rather than pretending the inference is authoritative.
  const userOwned = message.parts.some((part) => {
    if (part.type === "text") return part.synthetic !== true && part.ignored !== true
    return part.type === "file" || part.type === "agent" || part.type === "subtask"
  })
  return userOwned
    ? { owner: "user", source: "legacy.user", confidence: "legacy-inferred" }
    : { owner: "host", source: "legacy.synthetic", confidence: "legacy-inferred" }
}

/**
 * Info-only compatibility resolver for consumers that intentionally do not
 * hydrate message parts. Explicit provenance remains authoritative. Old V1
 * user-role rows cannot be disambiguated without parts, so preserve the
 * historical user interpretation and expose that uncertainty through
 * `confidence`.
 */
export function resolveInfo(info: ClassificationInfo): ResolvedInfo | undefined {
  if (info.role !== "user") return undefined
  if (info.provenance) return { ...info.provenance, confidence: "explicit" }
  return { owner: "user", source: "legacy.user", confidence: "legacy-inferred" }
}

export function isUserOwnedTurn(message: WithParts) {
  return resolve(message)?.owner === "user"
}

export function isHostOwnedTurn(message: WithParts) {
  return resolve(message)?.owner === "host"
}

/**
 * Replaceable host conversational state is provider-user content but not a
 * conversational turn boundary. Keep this lifetime semantic explicit so V1
 * structural consumers do not accidentally parent assistants/checkpoints to a
 * state snapshot merely because its wire role is `user`.
 */
/** STATE-shaped semantic source, including historical/imported records. */
export function hasStateSemanticsInfo(info: ClassificationInfo) {
  const provenance = resolveInfo(info)
  return (
    provenance?.confidence === "explicit" &&
    provenance.owner === "host" &&
    SharedTurnProvenance.isStateKind(provenance.source)
  )
}

export function hasStateSemanticsTurn(message: WithParts) {
  return hasStateSemanticsInfo(message.info)
}

/** Current mutable STATE projection. Historical STATE-shaped records are excluded. */
export function isStateProjectionInfo(info: ClassificationInfo) {
  const provenance = resolveInfo(info)
  return hasStateSemanticsInfo(info) && !SharedTurnProvenance.isHistorical(provenance)
}

export function isStateProjectionTurn(message: WithParts) {
  return isStateProjectionInfo(message.info)
}

export function semanticKind(message: WithParts): SemanticKind {
  if (message.info.role === "assistant") return "assistant"
  if (message.parts.some((part) => part.type === "compaction")) return "compaction"

  const provenance = resolve(message)
  if (!provenance) return "synthetic"
  if (provenance.confidence === "legacy-inferred")
    return provenance.source === LEGACY_SHELL_SOURCE ? "shell" : provenance.owner === "user" ? "user" : "synthetic"
  const source = policy(provenance.source)
  return source?.owner === provenance.owner ? source.kind : provenance.owner === "user" ? "user" : "synthetic"
}

export function semanticKindInfo(info: ClassificationInfo): SemanticKind {
  if (info.role === "assistant") return "assistant"
  const provenance = resolveInfo(info)
  if (!provenance) return "synthetic"
  if (provenance.confidence === "legacy-inferred") return "user"
  const source = policy(provenance.source)
  return source?.owner === provenance.owner ? source.kind : provenance.owner === "user" ? "user" : "synthetic"
}

export function isSemanticUserTurn(message: WithParts) {
  return semanticKind(message) === "user"
}

export function isSemanticUserInfo(info: ClassificationInfo) {
  return semanticKindInfo(info) === "user"
}

export function isHistoricalInfo(info: ClassificationInfo) {
  const provenance = resolveInfo(info)
  return provenance?.confidence === "explicit" && SharedTurnProvenance.isHistorical(provenance)
}

export function isHistoricalTurn(message: WithParts) {
  return isHistoricalInfo(message.info)
}

/**
 * A worker prompt is a turn that can authoritatively supply the worker's model,
 * objective/provenance and Goal-creation context. Host prompt admission is
 * included because scheduled tasks/subagent dispatch legitimately start worker
 * Sessions; host continuations/recovery/compaction are deliberately excluded.
 */
export function isWorkerPromptTurn(message: WithParts) {
  if (message.info.role !== "user") return false
  const provenance = resolve(message)
  if (!provenance) return false
  if (provenance.confidence === "legacy-inferred")
    return provenance.owner === "user" && provenance.source !== LEGACY_SHELL_SOURCE
  if (SharedTurnProvenance.isHistorical(provenance)) return false
  const source = policy(provenance.source)
  return source?.workerPrompt === true && source.owner === provenance.owner
}

export function isWorkerPromptInfo(info: ClassificationInfo) {
  if (info.role !== "user") return false
  const provenance = resolveInfo(info)
  if (!provenance) return false
  if (provenance.confidence === "legacy-inferred") return true
  if (SharedTurnProvenance.isHistorical(provenance)) return false
  const source = policy(provenance.source)
  return source?.workerPrompt === true && source.owner === provenance.owner
}

/**
 * Turns whose content may authorize creation of durable user-owned domain
 * state. This proves the authorizing *actor* only; each domain must separately
 * prove that the turn text authorized its specific action.
 */
export function isDurableUserActionAuthorizationTurn(message: WithParts) {
  if (message.info.role !== "user") return false
  const provenance = resolve(message)
  if (!provenance) return false
  if (provenance.confidence === "legacy-inferred")
    return provenance.owner === "user" && provenance.source !== LEGACY_SHELL_SOURCE
  if (SharedTurnProvenance.isHistorical(provenance)) return false
  const source = policy(provenance.source)
  return (
    provenance.owner === "user" &&
    source?.owner === "user" &&
    source.durableUserActionAuthorization === true
  )
}

/** @deprecated Goal is one consumer of the generic durable user-action fence. */
export function isGoalAuthorizationTurn(message: WithParts) {
  return isDurableUserActionAuthorizationTurn(message)
}

/** Exact first-party host worker-root producer; presentation may label this separately from other Synthetic turns. */
export function isHostPromptInfo(info: ClassificationInfo) {
  const provenance = resolveInfo(info)
  return (
    provenance?.confidence === "explicit" &&
    provenance.owner === "host" &&
    !SharedTurnProvenance.isHistorical(provenance) &&
    provenance.source === Source.HostPrompt
  )
}

export function isHostPromptTurn(message: WithParts) {
  const provenance = resolve(message)
  return (
    provenance?.confidence === "explicit" &&
    provenance.owner === "host" &&
    !SharedTurnProvenance.isHistorical(provenance) &&
    provenance.source === Source.HostPrompt
  )
}

const LEGACY_GOAL_CONTINUATION_RESERVATION_METADATA = "goalContinuationReservationID"
const LEGACY_GOAL_CONTINUATION_SOURCE_MESSAGE_METADATA = "goalContinuationSourceMessageID"

function legacyGoalContinuationSourceMessageID(message: WithParts): MessageID | undefined {
  if (message.info.role !== "user" || message.info.provenance) return undefined
  for (const part of message.parts) {
    if (part.type !== "text" || part.synthetic !== true) continue
    const value = part.metadata?.[LEGACY_GOAL_CONTINUATION_SOURCE_MESSAGE_METADATA]
    if (typeof value === "string" && value.length > 0) return value as MessageID
  }
  return undefined
}

/**
 * Root causal turn for a host-authored continuation. Legacy Goal metadata is
 * resolved here so causal consumers never need producer-specific fallback
 * logic; new explicit provenance remains authoritative.
 */
export function causalRootMessageID(message: WithParts | undefined): MessageID | undefined {
  if (!message) return undefined
  return legacyGoalContinuationSourceMessageID(message) ?? causalRootMessageIDInfo(message.info)
}

/** Root checkpoint turn for a host-authored continuation. */
export function checkpointRootMessageID(message: WithParts | undefined): MessageID | undefined {
  return causalRootMessageID(message)
}

/** Exact host correlation for idempotent automation materialization. */
export function hasHostCorrelation(message: WithParts, source: string, ref: string) {
  if (message.info.role !== "user") return false
  const provenance = message.info.provenance
  return (
    provenance?.owner === "host" &&
    !SharedTurnProvenance.isHistorical(provenance) &&
    provenance.source === source &&
    provenance.ref === ref
  )
}

/**
 * Goal-continuation correlation with legacy-row compatibility quarantined here.
 * New rows use message-level provenance; no producer should write these part
 * metadata keys anymore.
 */
export function hasGoalContinuationReservation(message: WithParts, reservationID: string) {
  if (hasHostCorrelation(message, Source.GoalContinuation, reservationID)) return true
  if (message.info.role !== "user" || message.info.provenance) return false
  return message.parts.some(
    (part) =>
      part.type === "text" &&
      part.synthetic === true &&
      part.metadata?.[LEGACY_GOAL_CONTINUATION_RESERVATION_METADATA] === reservationID,
  )
}

/**
 * Resolve the original causal/root user turn for a Goal continuation. Explicit
 * provenance is authoritative; part metadata is read only for persisted rows
 * predating the provenance contract.
 */
export function goalContinuationSourceMessageID(message: WithParts | undefined): MessageID | undefined {
  if (!message || message.info.role !== "user") return undefined
  const provenance = message.info.provenance
  if (provenance) {
    if (provenance.owner !== "host" || provenance.source !== Source.GoalContinuation) return undefined
    return causalRootMessageIDInfo(message.info)
  }
  return legacyGoalContinuationSourceMessageID(message)
}
