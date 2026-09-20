export * as SessionTurnProvenance from "./turn-provenance"

import { SessionTurnProvenance as Shared } from "@opencode-ai/schema/session-turn-provenance"
import { SessionMessage } from "./message"

export const Source = Shared.Source
export type Source = Shared.Source

export type Resolved = SessionMessage.Provenance & {
  readonly confidence: "explicit" | "legacy-inferred"
}

type ProvenanceMessage = SessionMessage.User | SessionMessage.Synthetic | SessionMessage.Compaction

function carriesProvenance(message: SessionMessage.Message): message is ProvenanceMessage {
  return message.type === "user" || message.type === "synthetic" || message.type === "compaction"
}

export function resolve(message: SessionMessage.Message): Resolved | undefined {
  if (!carriesProvenance(message)) return undefined
  if (message.provenance) return { ...message.provenance, confidence: "explicit" }
  if (message.type === "user") return { owner: "user", source: "legacy.user", confidence: "legacy-inferred" }
  return {
    owner: "host",
    source: message.type === "compaction" ? "legacy.compaction" : "legacy.synthetic",
    confidence: "legacy-inferred",
  }
}

export function user(source: string): SessionMessage.Provenance {
  Shared.assertCanonicalOwner(source, "user")
  return { owner: "user", source }
}

export function host(
  source: string,
  input?: { readonly sourceMessageID?: SessionMessage.ID; readonly ref?: string },
): SessionMessage.Provenance {
  Shared.assertCanonicalOwner(source, "host")
  if (Shared.requiresCausalRoot(source) && !input?.sourceMessageID)
    throw new Error(`Host turn source ${source} requires a canonical sourceMessageID`)
  if (Shared.requiresCorrelation(source) && !input?.ref)
    throw new Error(`Host turn source ${source} requires a durable correlation ref`)
  return {
    owner: "host",
    source,
    ...(input?.sourceMessageID ? { sourceMessageID: input.sourceMessageID } : {}),
    ...(input?.ref ? { ref: input.ref } : {}),
  }
}

export function semanticKind(message: SessionMessage.Message): Shared.SemanticKind | "assistant" | "system" {
  if (message.type === "assistant") return "assistant"
  if (message.type === "system" || message.type === "agent-switched" || message.type === "model-switched") return "system"
  if (message.type === "shell") return "shell"
  if (message.type === "compaction") return "compaction"
  if (message.type === "synthetic") return "synthetic"
  const provenance = resolve(message)
  if (!provenance || provenance.confidence === "legacy-inferred") return "user"
  const policy = Shared.policy(provenance.source)
  return policy?.owner === provenance.owner ? policy.kind : provenance.owner === "user" ? "user" : "synthetic"
}

export function isSemanticUserTurn(message: SessionMessage.Message): message is SessionMessage.User {
  return message.type === "user" && semanticKind(message) === "user"
}

/**
 * A worker root may establish model/tool/Goal execution context. Human prompts
 * and trusted host prompts qualify; derived automation never does.
 */
export function isWorkerPromptTurn(
  message: SessionMessage.Message,
): message is SessionMessage.User | SessionMessage.Synthetic {
  if (message.type !== "user" && message.type !== "synthetic") return false
  const provenance = resolve(message)
  // Only historical User rows inherit the narrow compatibility fallback.
  // Native Synthetic work must always carry explicit trusted provenance.
  if (!provenance) return message.type === "user"
  if (provenance.confidence === "legacy-inferred") return true
  if (Shared.isHistorical(provenance)) return false
  const policy = Shared.policy(provenance.source)
  return policy?.workerPrompt === true && policy.owner === provenance.owner
}

export function isDurableUserActionAuthorizationTurn(
  message: SessionMessage.Message,
): message is SessionMessage.User {
  if (message.type !== "user") return false
  const provenance = resolve(message)
  if (!provenance) return false
  if (provenance.confidence === "legacy-inferred") return provenance.owner === "user"
  if (Shared.isHistorical(provenance)) return false
  const policy = Shared.policy(provenance.source)
  return (
    provenance.owner === "user" &&
    policy?.owner === "user" &&
    policy.durableUserActionAuthorization === true
  )
}

/** @deprecated Goal is one consumer of the generic durable user-action fence. */
export function isGoalAuthorizationTurn(message: SessionMessage.Message): message is SessionMessage.User {
  return isDurableUserActionAuthorizationTurn(message)
}

/**
 * Resolve a message's already-flattened canonical worker root without scanning
 * history. A root User owns itself; a derived host turn names its root directly.
 */
export function causalRootMessageID(message: SessionMessage.Message | undefined): SessionMessage.ID | undefined {
  if (!message || !carriesProvenance(message)) return undefined
  const provenance = resolve(message)
  if (!provenance) return undefined
  if (Shared.isHistorical(provenance)) return undefined
  if (provenance.confidence === "explicit" && provenance.owner === "host" && provenance.sourceMessageID)
    return provenance.sourceMessageID
  return isWorkerPromptTurn(message) ? message.id : undefined
}

/**
 * Resolve the active worker root in one reverse pass over the already-loaded
 * history. Legacy synthetic/compaction rows may fall back to the preceding
 * worker root; explicit modern derived rows never use adjacency as authority.
 */
export function currentWorkerRootMessageID(
  messages: readonly SessionMessage.Message[],
): SessionMessage.ID | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type === "user") {
      const provenance = resolve(message)
      // Imported/historical rows preserve authorship/presentation, but they do
      // not form a live worker boundary. Keep scanning for the prior live root.
      if (provenance?.confidence === "explicit" && Shared.isHistorical(provenance)) continue
      if (!isWorkerPromptTurn(message)) continue
      return causalRootMessageID(message)
    }
    if (message.type !== "synthetic" && message.type !== "compaction") continue
    const provenance = resolve(message)
    if (provenance?.confidence === "explicit") {
      if (Shared.isHistorical(provenance)) continue
      if (Shared.isStateKind(provenance.source)) continue
      return causalRootMessageID(message)
    }
    // Historical current/V2 rows predate provenance. Preserve the old
    // adjacency interpretation only for those rows.
  }
  return undefined
}

/** True only when the active boundary is a pre-provenance derived row. */
export function requiresLegacyWorkerRootLookup(messages: readonly SessionMessage.Message[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type === "user") {
      const provenance = resolve(message)
      if (provenance?.confidence === "explicit" && Shared.isHistorical(provenance)) continue
      return false
    }
    if (message.type !== "synthetic" && message.type !== "compaction") continue
    const provenance = resolve(message)
    if (provenance?.confidence === "explicit" && Shared.isHistorical(provenance)) continue
    if (provenance?.confidence === "explicit" && Shared.isStateKind(provenance.source)) continue
    return provenance?.confidence === "legacy-inferred"
  }
  return false
}

/** STATE-shaped semantic source, including historical/imported records. */
export function hasStateSemantics(message: SessionMessage.Message) {
  if (!carriesProvenance(message)) return false
  const provenance = resolve(message)
  return (
    provenance?.confidence === "explicit" &&
    provenance.owner === "host" &&
    Shared.isStateKind(provenance.source)
  )
}

/** Current mutable STATE projection. Historical STATE-shaped records are excluded. */
export function isStateProjection(message: SessionMessage.Message) {
  const provenance = resolve(message)
  return hasStateSemantics(message) && !Shared.isHistorical(provenance)
}

export function hostDerived(
  source: string,
  parent: SessionMessage.Message,
  input?: { readonly ref?: string },
): SessionMessage.Provenance {
  if (!Shared.requiresCausalRoot(source)) throw new Error(`Host turn source ${source} is not a derived causal source`)
  const sourceMessageID = causalRootMessageID(parent)
  if (!sourceMessageID) throw new Error(`Host turn source ${source} requires a causal worker-root parent`)
  return host(source, { sourceMessageID, ...(input?.ref ? { ref: input.ref } : {}) })
}

export function hasHostCorrelation(message: SessionMessage.Message, source: string, ref: string) {
  if (!carriesProvenance(message)) return false
  const provenance = message.provenance
  return provenance?.owner === "host" && !Shared.isHistorical(provenance) && provenance.source === source && provenance.ref === ref
}
