export * as SessionContextEpochState from "./context-epoch-state"

import { Schema } from "effect"
import { SystemSurface } from "../system-surface"

export const VERSION = 1 as const

const InactiveProjection = Schema.Struct({
  historyActive: Schema.Literal(false),
})

const ActiveProjection = Schema.Struct({
  historyActive: Schema.Literal(true),
  /** Exact semantics under which retained chronological System rows were emitted. */
  history: Schema.Literals(["cumulative-privileged", "replace-complete"]),
})

export const Projection = Schema.Union([InactiveProjection, ActiveProjection])
export type Projection = typeof Projection.Type

/**
 * Durable semantic checkpoint for one Context Epoch.
 *
 * `surface` is provider-independent current privileged state. `projection`
 * records only the semantics needed to interpret chronological System rows that
 * remain above `baseline_seq`; model/provider/cache identity deliberately does
 * not become Session state.
 */
export const Checkpoint = Schema.Struct({
  version: Schema.Literal(VERSION),
  surface: SystemSurface.Snapshot,
  projection: Projection,
})
export type Checkpoint = typeof Checkpoint.Type

export const inactive = (surface: SystemSurface.Snapshot): Checkpoint => ({
  version: VERSION,
  surface,
  projection: { historyActive: false },
})

export const active = (
  surface: SystemSurface.Snapshot,
  history: "cumulative-privileged" | "replace-complete",
): Checkpoint => ({
  version: VERSION,
  surface,
  projection: { historyActive: true, history },
})
