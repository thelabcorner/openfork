import type { SessionMessageInfo as VendorSessionMessageInfo } from "@opencode-ai/client/promise"
import { SessionTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import type { ProvenanceLike } from "@opencode-ai/schema/session-turn-provenance"

/**
 * Compatibility shape for the hybrid app's current-session bridge.
 *
 * The vendored transitional client owns transient presentation lifecycle fields
 * (for example running/failed compaction) while Schema owns OpenFork's durable
 * provenance contract. Enrich only the variants that may carry provenance so
 * runtime payloads remain byte-for-byte unchanged and the stale vendor type
 * cannot erase semantic metadata from the browser model.
 */
type WithCurrentSemanticFields<T> = T extends { readonly type: "synthetic" }
  ? T & { readonly provenance?: ProvenanceLike; readonly sessionID?: string }
  : T extends { readonly type: "user" | "compaction" }
    ? T & { readonly provenance?: ProvenanceLike }
    : T

export type SessionMessageInfo = WithCurrentSemanticFields<VendorSessionMessageInfo>

export function isSessionMessageStateProjection(message: SessionMessageInfo) {
  if (message.type !== "user" && message.type !== "synthetic" && message.type !== "compaction") return false
  return SessionTurnProvenance.isStateProjectionInfo({ role: "user", provenance: message.provenance })
}

export function hasSessionMessageStateSemantics(message: SessionMessageInfo) {
  if (message.type !== "user" && message.type !== "synthetic" && message.type !== "compaction") return false
  const provenance = message.provenance
  return provenance?.owner === "host" && SessionTurnProvenance.isStateKind(provenance.source)
}
