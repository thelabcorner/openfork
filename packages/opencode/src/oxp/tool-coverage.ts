import { ExternalToolCoverage } from "@/exchange/tool-coverage"
import { ToolExposure } from "@/tool/exposure"

export type CoverageKind = ExternalToolCoverage.CoverageKind
export type Entry = Pick<ExternalToolCoverage.Entry, "native" | "kind" | "oxp" | "note">

export const ENTRIES: readonly Entry[] = ExternalToolCoverage.ENTRIES.map(({ native, kind, oxp, note }) => ({
  native,
  kind,
  ...(oxp ? { oxp } : {}),
  note,
}))
export const BY_NATIVE: ReadonlyMap<string, Entry> = new Map(ENTRIES.map((entry) => [entry.native, entry]))

/** The only native tools without an OXP executor. Each needs an explicit
 * architectural reason; adding a native tool cannot silently omit OXP. */
export const EXPLICIT_EXCEPTIONS = Object.freeze([
  "invalid", // Transport schema rejection is intrinsic, not an executable tool.
  "github", // Never forward ambient local GitHub credentials to an OXP principal.
  "quota", // Never forward ambient provider-account credentials or quotas.
  "plan_exit", // Interactive, local plan-mode transition; no remote Session action exists.
] as const)

export function unmappedNativeTools() {
  const exempt = new Set<string>(EXPLICIT_EXCEPTIONS)
  return ENTRIES.filter((entry) => !entry.oxp && !exempt.has(entry.native))
    .map((entry) => entry.native)
    .sort()
}

export function unknownExceptions() {
  return EXPLICIT_EXCEPTIONS.filter((id) => !BY_NATIVE.has(id) || BY_NATIVE.get(id)?.oxp !== undefined)
}

/**
 * Action-level differences must never be disguised by a successful
 * capability-name parity check. Record native-only action spellings and
 * transport-specific aliases as explicit, tested constraints instead of
 * treating two different operation enums as equivalent.
 *
 * The regression suite compares these lists to the actual native and OXP
 * schemas. Adding an action on either side forces an explicit audit.
 */
export const ACTION_SCOPES = Object.freeze({
  code: Object.freeze({
    exposed: ["search", "describe", "run"],
    unavailable: ["save", "call"],
    externalOnly: [],
    reason: "Native saved-run publication and invocation require the real Session capability inventory.",
  }),
  project: Object.freeze({
    exposed: ["snapshot", "summary", "structure", "recent", "toolchain"],
    unavailable: [],
    externalOnly: ["structure"],
    reason:
      "Native/OXP snapshot supports summary, structure and full tiers through shared metadata inspection; OXP additionally requires process authority for toolchain.",
  }),
  read: Object.freeze({
    exposed: ["read", "tail", "grep", "outline", "around"],
    unavailable: [],
    externalOnly: [],
    reason:
      "Native/OXP grep shares bounded read/search; outline and around reuse shared Symbols AST/cache, with around snippets never granting edit grounding.",
  }),
  usage: Object.freeze({
    exposed: ["context"],
    unavailable: ["totals", "breakdown", "timeline", "maintenance", "profile"],
    externalOnly: [],
    reason: "Global and cross-project usage analytics require separately authorized accounting access.",
  }),
} as const)

export function markdownActionScopes() {
  return [
    "| Native tool | OXP actions | Native-only actions or aliases | OXP-only actions | Boundary |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(ACTION_SCOPES)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([native, scope]) =>
          `| \`@${native}\` | ${scope.exposed.map((action) => `\`${action}\``).join(", ")} | ${scope.unavailable.length ? scope.unavailable.map((action) => `\`${action}\``).join(", ") : "—"} | ${scope.externalOnly.length ? scope.externalOnly.map((action) => `\`${action}\``).join(", ") : "—"} | ${scope.reason} |`,
      ),
  ].join("\n")
}

/**
 * Deterministic human-readable projection of the one transport mapping ledger.
 * The architecture document is tested against this renderer so additions,
 * aliases, lazy policies and explicit gaps cannot silently drift from source.
 */
export function markdownParityMatrix() {
  const exceptions = new Set<string>(EXPLICIT_EXCEPTIONS)
  const rows = [...ENTRIES].sort((a, b) => a.native.localeCompare(b.native))
  return [
    "| Native tool | OXP equivalent | Semantic boundary | Load policy |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (entry) =>
        `| \`@${entry.native}\` | ${entry.oxp ? `\`${entry.oxp}\`` : exceptions.has(entry.native) ? "**Explicit exception**" : "**UNMAPPED**"} | ${entry.kind} | ${ToolExposure.loadPolicy(entry.native)} |`,
    ),
  ].join("\n")
}

/**
 * Return declared OXP targets that do not have a proven executable owner.
 * The caller supplies the live target set (brokered capability ids plus
 * supervision/delegation semantic targets). This deliberately treats
 * `openfork_session.goal` as distinct from `openfork_session`: a broad meta
 * tool may not claim parity for an action family it does not actually expose.
 */
export function missingExecutableTargets(available: ReadonlySet<string>) {
  return [...new Set(ENTRIES.flatMap((entry) => (entry.oxp && !available.has(entry.oxp) ? [entry.oxp] : [])))].sort()
}

export * as OxpToolCoverage from "./tool-coverage"
