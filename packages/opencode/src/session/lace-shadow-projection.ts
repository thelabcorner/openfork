/**
 * LACE v14.7: read-only, reversible history-projection prototype.
 *
 * This module NEVER defines authority or owns history. The V1 semantic owner
 * classifies each already-admitted source as required/privileged/atomic.
 * The caller retains complete originals and owns all retrieval authorization.
 * A structurally valid projection is NOT a proof of semantic task fidelity.
 */
export interface ProjectionSource {
  readonly id: string
  readonly revision: string
  readonly raw: string
  readonly privileged: boolean
  readonly required: boolean
  /** Unresolved / inseparable tool-call-history components remain RAW together. */
  readonly atomicGroup?: string
}

export type ProjectionChoice =
  | { readonly id: string; readonly mode: "raw" }
  | { readonly id: string; readonly mode: "omit" }
  | { readonly id: string; readonly mode: "abstract"; readonly text: string; readonly validatedRevision: string; readonly independentlyVerified: boolean }
  | { readonly id: string; readonly mode: "reference"; readonly text: string; readonly validatedRevision: string; readonly retrievable: boolean }

export interface ShadowProjection {
  readonly parts: ReadonlyArray<{ readonly sourceID: string; readonly mode: ProjectionChoice["mode"]; readonly text: string }>
  readonly sourceCount: number
  readonly originalCharacters: number
  readonly projectedCharacters: number
  readonly omittedSourceIDs: ReadonlyArray<string>
}

/**
 * Builds only a candidate provider-visible projection. It cannot be dispatched
 * until separate System, reasoning continuity, tool and task-fidelity guards
 * approve it at a safe admission boundary.
 */
export function buildShadowProjection(
  sources: ReadonlyArray<ProjectionSource>,
  choices: ReadonlyArray<ProjectionChoice>,
  maxCharacters: number,
): ShadowProjection {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0) {
    throw new RangeError("maxCharacters must be a nonnegative safe integer")
  }
  if (sources.length > 10000 || choices.length > 10000) throw new RangeError("projection batch exceeds bound")
  const originals = new Map<string, ProjectionSource>()
  for (const source of sources) {
    if (!source.id || !source.revision || originals.has(source.id)) {
      throw new Error("duplicate or incomplete original source identity")
    }
    originals.set(source.id, source)
  }
  const chosen = new Map<string, ProjectionChoice>()
  for (const choice of choices) {
    if (!originals.has(choice.id) || chosen.has(choice.id)) {
      throw new Error("unknown or duplicate projection choice")
    }
    chosen.set(choice.id, choice)
  }
  const parts: Array<{ sourceID: string; mode: ProjectionChoice["mode"]; text: string }> = []
  const omittedSourceIDs: string[] = []
  let originalCharacters = 0
  let projectedCharacters = 0
  for (const source of sources) {
    originalCharacters += source.raw.length
    const choice = chosen.get(source.id) ?? { id: source.id, mode: "raw" as const }
    if (choice.mode !== "raw" && (source.privileged || source.required || source.atomicGroup !== undefined)) {
      throw new Error("cannot abstract required, privileged, or unresolved atomic source: " + source.id)
    }
    if (choice.mode === "omit") {
      omittedSourceIDs.push(source.id)
      continue
    }
    let text = source.raw
    if (choice.mode === "abstract" || choice.mode === "reference") {
      if (choice.validatedRevision !== source.revision || !choice.text.trim()) {
        throw new Error("projection evidence is stale or empty: " + source.id)
      }
      if (choice.mode === "abstract" && !choice.independentlyVerified) {
        throw new Error("unverified abstraction: " + source.id)
      }
      if (choice.mode === "reference" && !choice.retrievable) {
        throw new Error("unrecoverable reference: " + source.id)
      }
      text = choice.text
    }
    projectedCharacters += text.length
    if (projectedCharacters > maxCharacters) throw new RangeError("shadow projection exceeds character budget")
    parts.push({ sourceID: source.id, mode: choice.mode, text })
  }
  return { parts, sourceCount: sources.length, originalCharacters, projectedCharacters, omittedSourceIDs }
}

export * as LaceShadowProjection from "./lace-shadow-projection"
