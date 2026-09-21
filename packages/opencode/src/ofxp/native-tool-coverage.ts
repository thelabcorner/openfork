export * as OfxpNativeToolCoverage from "./native-tool-coverage"

import { ExternalToolCoverage } from "@/exchange/tool-coverage"

export type Equivalent = ExternalToolCoverage.OfxpEquivalent & { readonly native: string; readonly rationale: string }

export const EQUIVALENTS: ReadonlyMap<string, Equivalent> = new Map(
  ExternalToolCoverage.ENTRIES.map((entry) => [
    entry.native,
    { native: entry.native, ...entry.ofxp, rationale: entry.note },
  ]),
)

export function get(nativeToolID: string): Equivalent | undefined {
  return EQUIVALENTS.get(nativeToolID)
}

export function assertCovered(nativeToolIDs: readonly string[]) {
  ExternalToolCoverage.assertNativeCovered(nativeToolIDs)
}

export function capabilityEquivalents() {
  return [...EQUIVALENTS.values()].filter((item) => item.mode === "capability" || item.mode === "alias")
}

