export * as SystemProjection from "./system-projection"

import type { EffectiveSystemMessageCapability } from "@opencode-ai/llm"
import { Hash } from "./util/hash"
import { SystemSurface } from "./system-surface"

/**
 * A sealed, machine-checkable witness for one provider-neutral System-surface
 * transition.
 *
 * The witness deliberately stops before provider wire encoding. It is the
 * single construction artifact that both durable System-history publication and
 * request assembly should consume. That prevents two call sites from
 * independently reconstructing "equivalent" privileged text and drifting.
 */

export const VERSION = 1 as const

export interface Digests {
  /** Exact complete composed bytes, independent of section identity/version. */
  readonly modelBytes: string
  /** Ordered semantic section identities + exact bytes. */
  readonly surfaceState: string
  /** Projection/checkpoint version + ordered semantic state. */
  readonly checkpoint: string
  /** Capability + placement + exact emitted privileged bytes. */
  readonly projection: string
}

export interface Witness {
  readonly version: typeof VERSION
  readonly capability: EffectiveSystemMessageCapability
  readonly plan: SystemSurface.ProjectionPlan
  readonly digests: Digests
}

const utf8 = new TextEncoder()

/** Length-prefix framing avoids delimiter/escaping ambiguity in durable hashes. */
const frame = (value: string) => `${utf8.encode(value).byteLength}:${value}`

const hash = (parts: ReadonlyArray<string>) => Hash.sha256(parts.map(frame).join(""))

export const modelBytesDigest = (snapshot: SystemSurface.Snapshot) => Hash.sha256(SystemSurface.render(snapshot))

export const surfaceStateDigest = (snapshot: SystemSurface.Snapshot) =>
  hash(snapshot.order.flatMap((key) => [String(key), snapshot.sections[key]]))

export const checkpointDigest = (snapshot: SystemSurface.Snapshot) =>
  hash([String(snapshot.projectionVersion), surfaceStateDigest(snapshot)])

const capabilityParts = (capability: EffectiveSystemMessageCapability) => [
  capability.history,
  capability.turnScoped ? "turn-scoped" : "persistent",
]

const planParts = (plan: SystemSurface.ProjectionPlan): ReadonlyArray<string> => {
  switch (plan.type) {
    case "none":
      return [plan.type, plan.reason]
    case "head":
      return [plan.type, plan.reason, plan.text]
    case "append-additive":
      return [plan.type, ...plan.keys.map(String), plan.text]
    case "append-complete":
      return [plan.type, plan.text]
  }
}

export const projectionDigest = (input: {
  readonly capability: EffectiveSystemMessageCapability
  readonly plan: SystemSurface.ProjectionPlan
  readonly surfaceState: string
}) => hash([String(VERSION), ...capabilityParts(input.capability), input.surfaceState, ...planParts(input.plan)])

export const seal = (input: {
  readonly result: SystemSurface.Ready
  readonly capability: EffectiveSystemMessageCapability
  readonly previous?: SystemSurface.Snapshot
}): Witness => {
  const plan = SystemSurface.planProjection(input.result, input.capability, input.previous)
  const modelBytes = modelBytesDigest(input.result.snapshot)
  const surfaceState = surfaceStateDigest(input.result.snapshot)
  const checkpoint = checkpointDigest(input.result.snapshot)
  const projection = projectionDigest({ capability: input.capability, plan, surfaceState })
  return {
    version: VERSION,
    capability: input.capability,
    plan,
    digests: { modelBytes, surfaceState, checkpoint, projection },
  }
}

/**
 * Cheap translation-validation check for a persisted/transferred witness.
 * Returns false rather than throwing so diagnostics can classify corruption or
 * stale compilation without turning verification itself into a failure source.
 */
export const verify = (witness: Witness, snapshot: SystemSurface.Snapshot) => {
  const modelBytes = modelBytesDigest(snapshot)
  const surfaceState = surfaceStateDigest(snapshot)
  const checkpoint = checkpointDigest(snapshot)
  const projection = projectionDigest({ capability: witness.capability, plan: witness.plan, surfaceState })
  return (
    witness.version === VERSION &&
    witness.digests.modelBytes === modelBytes &&
    witness.digests.surfaceState === surfaceState &&
    witness.digests.checkpoint === checkpoint &&
    witness.digests.projection === projection
  )
}

/** Exact provider-neutral chronological System text introduced by this transition. */
export const historyText = (witness: Witness): string | undefined =>
  witness.plan.type === "append-additive" || witness.plan.type === "append-complete" ? witness.plan.text : undefined

/** Exact provider-neutral complete System-surface text when this transition requires a head rebaseline. */
export const headText = (witness: Witness): string | undefined =>
  witness.plan.type === "head" ? witness.plan.text : undefined
