export * as OfxpAttribution from "./attribution"

import path from "node:path"
import { ExchangeAttribution } from "@/exchange/attribution"
import type { Ofxp } from "@opencode-ai/schema/ofxp"
import type { PeerCertificateIdentity } from "./certificate"
import { OfxpPrincipal } from "./principal"
import type { OfxpRoot } from "./root"

/**
 * Canonical OFXP attribution for the single CodingActivity record the shared
 * Exchange producer already owns.
 *
 * Everything here comes from state the boundary has already proven, never from
 * caller input:
 *
 * - `project` is the canonical approved root's directory name. The operator-chosen
 *   alias, the caller's path spelling, and the kernel's display-path heuristic
 *   are all public spellings that can disagree with the real root (a file sitting
 *   directly in the root is the obvious case), so none of them may name a
 *   canonical root.
 * - `projectFolder` is the granted root's own `rootPath`, which
 *   `OfxpRoot.resolve` re-verified against the on-disk directory during this
 *   call's admission. It is the only directory this boundary may name: not the
 *   alias, not the `/alias/...` virtual path, and not the basename. A root file
 *   and a nested file under it therefore report one identical folder.
 * - `sourceRef` is the same stable opaque principal key OFXP already uses to scope
 *   per-principal read grounding, so attribution names the authenticated actor.
 *   The invocation ID is deliberately not used: it is a per-call receipt token,
 *   not a principal identity, and encoding it here would fragment the consuming
 *   activity stream one group per call.
 * - `replayToken` is deliberately the invocation ID for the opposite reason: it
 *   is the durable idempotency identity for this exact OFXP call. Keeping it in a
 *   separate field lets consumers suppress a replay without ever confusing the
 *   principal key with a per-event identity.
 *
 * The root ID is likewise omitted: it is authorization scope, already carried by
 * the receipt, and not an actor or a project.
 */
export function attribution(
  root: Pick<OfxpRoot.Resolved, "rootPath" | "alias">,
  peer: PeerCertificateIdentity,
  call: Ofxp.CapabilityCall,
): ExchangeAttribution.Attribution {
  const name = path.basename(root.rootPath)
  return {
    source: "ofxp",
    // An approved root is never a filesystem root, so a basename always exists;
    // the alias is a last resort rather than shipping an empty project.
    project: name.length > 0 ? name : root.alias,
    projectFolder: root.rootPath,
    sourceRef: OfxpPrincipal.key(peer.peerID, call.context),
    replayToken: call.context.invocationID,
  }
}
