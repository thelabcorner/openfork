import { ExternalToolCoverage } from "@/exchange/tool-coverage"

export type CoverageKind = ExternalToolCoverage.CoverageKind
export type Entry = Pick<ExternalToolCoverage.Entry, "native" | "kind" | "oxp" | "note">

export const ENTRIES: readonly Entry[] = ExternalToolCoverage.ENTRIES.map(({ native, kind, oxp, note }) => ({
  native,
  kind,
  ...(oxp ? { oxp } : {}),
  note,
}))
export const BY_NATIVE: ReadonlyMap<string, Entry> = new Map(ENTRIES.map((entry) => [entry.native, entry]))

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
