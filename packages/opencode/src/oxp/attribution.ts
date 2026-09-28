export * as OxpAttribution from "./attribution"

import path from "node:path"
import { ExchangeAttribution } from "@/exchange/attribution"
import type { OxpRoot } from "./root"

/**
 * Canonical project identity for the approved root that already proved a file.
 *
 * `OxpRoot.resolvePath`/`resolveRoot` resolved the target against one specific
 * approved root and re-verified that root on disk before returning, so
 * `canonicalPath` is the only truthful project label: a file sitting directly in
 * the root and a file nested several directories under it name the same project.
 * This is the same rule OFXP attribution already applies to a canonical root.
 *
 * The exchange kernel's display-path heuristic is deliberately NOT reused. An OXP
 * virtual path is an absolute `/alias/...` spelling, never a root-relative one, so
 * feeding it back to that heuristic cannot identify a root at all and instead
 * names a containing directory: `/repo/src/a.ts` resolved under
 * `/home/dev/repo` was reported as `src`, and a file sitting directly in the root
 * was reported as the root's own parent.
 *
 * The alias is not a substitute either. It is an operator-chosen, renameable
 * public spelling, while project identity in this architecture is the canonical
 * root path, so the alias is only an unreachable-by-construction last resort (an
 * approved root is never a whole drive or filesystem, so a basename always
 * exists) rather than a silent fallback.
 */
export function project(canonicalRootPath: string, alias?: string) {
  const name = path.basename(canonicalRootPath)
  return name.length > 0 ? name : alias
}

/**
 * Canonical OXP attribution for the single CodingActivity record the shared
 * Exchange producer already owns.
 *
 * Everything here comes from state the OXP boundary has already proven, never
 * from caller input or from a path spelling:
 * - `project` is the canonical approved root's own directory name, for the
 *   reasons `project` documents.
 * - `projectFolder` is that same approved root's `canonicalPath`. The resolve
 *   re-verified it against the on-disk directory before returning, so it is the
 *   only directory this boundary may name. It is deliberately the full canonical
 *   path and never the alias, the `/alias/...` virtual spelling, or the
 *   basename: a consumer needs the directory, and a renameable public spelling
 *   is not one.
 * - `sourceRef` is deliberately absent. OXP has no authenticated per-call or
 *   per-peer principal at this boundary: `OxpAuthority` authorizes against the
 *   locally configured connector and its grant, and a call carries no peer
 *   identity. The configured connector ID is local configuration scope, not a
 *   principal, and synthesizing one here (per call, or per connector) would
 *   invent an identity the boundary never authenticated and fragment the
 *   consuming activity stream one group per call. Omit it rather than guess.
 *
 * Attribution is folded into the record the Exchange producer already emits. It
 * never adds a second record, so a file operation stays attributed exactly once
 * no matter how many boundaries observe it — `@/oxp/server` stays silent for
 * `read` for that reason.
 */
export function attribution(
  resolved: Pick<OxpRoot.ResolvedRoot, "root" | "canonicalPath">,
): ExchangeAttribution.Attribution {
  return {
    source: "oxp",
    // The alias is always present on an approved root, so this `??` is
    // unreachable: it exists so a project identity can never be empty.
    project: project(resolved.canonicalPath, resolved.root.alias) ?? resolved.root.alias,
    projectFolder: resolved.canonicalPath,
  }
}
