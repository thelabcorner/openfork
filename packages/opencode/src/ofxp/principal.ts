export * as OfxpPrincipal from "./principal"

import { createHash } from "node:crypto"
import { Ofxp } from "@opencode-ai/schema/ofxp"

export function sourceRef(context: Ofxp.InvocationContext) {
  if (context.sourceSessionID) return `session:${context.sourceSessionID}`
  if (context.source?.kind === "session") return `session:${context.source.sessionID}`
  if (context.source?.kind === "external") return `external:${context.source.principal}`
  return "unknown"
}

/** Stable opaque principal key for one authenticated peer + parent lineage. */
export function key(peerID: Ofxp.PeerID, context: Ofxp.InvocationContext) {
  const digest = createHash("sha256").update(sourceRef(context), "utf8").digest("hex").slice(0, 24)
  return `ofxp:${peerID}:${digest}`
}

