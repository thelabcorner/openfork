export * as SystemSurface from "./system-surface"

import { Schema } from "effect"
import type { EffectiveSystemMessageCapability } from "@opencode-ai/llm"

/**
 * Pure semantic state for the exact privileged text currently owned by OpenCode.
 *
 * This module deliberately knows nothing about provider wire roles, Context
 * Epoch storage, Session history, or AI SDK/native runtime selection. It answers
 * only: which exact rendered sections are admitted now, did the semantic surface
 * change, and did checkpoint metadata change?
 */

export const Key = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/)).pipe(
  Schema.brand("SystemSurface.Key"),
)
export type Key = typeof Key.Type

export const ProjectionVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export type ProjectionVersion = typeof ProjectionVersion.Type

export const CURRENT_PROJECTION_VERSION = ProjectionVersion.make(1)

export const Snapshot = Schema.Struct({
  projectionVersion: ProjectionVersion,
  order: Schema.Array(Key),
  sections: Schema.Record(Key, Schema.NonEmptyString),
})
export type Snapshot = typeof Snapshot.Type

export type Availability = "required" | "optional"

interface ObservationBase {
  readonly key: Key
  readonly availability: Availability
}

export interface Present extends ObservationBase {
  readonly type: "present"
  readonly rendered: string
}

export interface Absent extends ObservationBase {
  readonly type: "absent"
}

export interface Unavailable extends ObservationBase {
  readonly type: "unavailable"
}

export type Observation = Present | Absent | Unavailable

export type Change =
  | {
      readonly type: "replace"
      readonly key: Key
      /** Undefined only when the section is newly introduced. */
      readonly previous?: string
      readonly rendered: string
    }
  | { readonly type: "remove"; readonly key: Key; readonly previous: string }

export interface Ready {
  readonly _tag: "Ready"
  readonly snapshot: Snapshot
  /** Exact section-level operations relative to the previously admitted bytes. */
  readonly changes: ReadonlyArray<Change>
  /** True only when the complete model-visible privileged bytes changed. */
  readonly surfaceChanged: boolean
  /** True when persisted checkpoint state/version/order/bytes changed. */
  readonly checkpointChanged: boolean
  /** True when relative ordering of sections present in both generations changed. */
  readonly orderChanged: boolean
}

export interface Blocked {
  readonly _tag: "Blocked"
  readonly keys: ReadonlyArray<Key>
}

export type Result = Ready | Blocked

export type ProjectionPlan =
  | { readonly type: "none"; readonly reason: "surface-unchanged" }
  | {
      readonly type: "head"
      readonly text: string
      readonly reason:
        | "initial"
        | "head-only"
        | "empty-surface"
        | "cumulative-nonmonotonic"
        | "cumulative-order-change"
    }
  | { readonly type: "append-additive"; readonly text: string; readonly keys: ReadonlyArray<Key> }
  | { readonly type: "append-complete"; readonly text: string }

export class DuplicateKeyError extends Error {
  constructor(readonly key: Key) {
    super(`Duplicate System surface key: ${key}`)
    this.name = "SystemSurface.DuplicateKeyError"
  }
}

export class InvalidOrderError extends Error {
  constructor(readonly details: string) {
    super(`Invalid System surface order: ${details}`)
    this.name = "SystemSurface.InvalidOrderError"
  }
}

export class EmptySectionError extends Error {
  constructor(readonly key: Key) {
    super(`System surface section ${key} rendered empty text; use absent instead`)
    this.name = "SystemSurface.EmptySectionError"
  }
}

export interface ReconcileInput {
  readonly projectionVersion?: ProjectionVersion
  readonly observations: ReadonlyArray<Observation>
  /**
   * Framework-owned semantic order. When omitted, keys are canonicalized
   * lexicographically so registration/discovery timing cannot affect prompt bytes.
   */
  readonly order?: ReadonlyArray<Key>
}

export const present = (key: Key, rendered: string, availability: Availability = "required"): Present => ({
  type: "present",
  key,
  availability,
  rendered,
})

export const absent = (key: Key, availability: Availability = "required"): Absent => ({
  type: "absent",
  key,
  availability,
})

export const unavailable = (key: Key, availability: Availability = "required"): Unavailable => ({
  type: "unavailable",
  key,
  availability,
})

const sameArray = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index])

const sameSections = (left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>) => {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return sameArray(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key])
}

const observationOrder = (observations: ReadonlyArray<Observation>, requested?: ReadonlyArray<Key>) => {
  const keys = observations.map((item) => item.key)
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) throw new DuplicateKeyError(key)
    seen.add(key)
  }
  if (!requested) return keys.toSorted()

  const orderSeen = new Set<string>()
  for (const key of requested) {
    if (orderSeen.has(key)) throw new InvalidOrderError(`duplicate key ${key}`)
    orderSeen.add(key)
  }
  const expected = [...seen].sort()
  const actual = [...orderSeen].sort()
  if (!sameArray(expected, actual))
    throw new InvalidOrderError("order must contain every observed key exactly once and no unknown keys")
  return [...requested]
}

const validateSnapshot = (snapshot: Snapshot) => {
  const keys = Object.keys(snapshot.sections).sort()
  const order = [...snapshot.order]
  if (new Set(order).size !== order.length) throw new InvalidOrderError("snapshot order contains duplicate keys")
  if (!sameArray([...order].sort(), keys))
    throw new InvalidOrderError("snapshot order must contain every admitted section key exactly once")
}

export const render = (snapshot: Snapshot) => {
  validateSnapshot(snapshot)
  return snapshot.order.map((key) => snapshot.sections[key]).join("\n\n")
}

const relativeOrderChanged = (previous: Snapshot | undefined, current: Snapshot) => {
  if (!previous) return false
  const previousKeys = new Set(Object.keys(previous.sections))
  const currentKeys = new Set(Object.keys(current.sections))
  const previousCommon = previous.order.filter((key) => currentKeys.has(key))
  const currentCommon = current.order.filter((key) => previousKeys.has(key))
  return !sameArray(previousCommon, currentCommon)
}

const diff = (previous: Snapshot | undefined, current: Snapshot): ReadonlyArray<Change> => {
  if (!previous)
    return current.order.map((key) => ({ type: "replace", key, rendered: current.sections[key] }) satisfies Change)

  const changes: Change[] = []
  for (const key of previous.order) {
    if (current.sections[key] === undefined) changes.push({ type: "remove", key, previous: previous.sections[key] })
  }
  for (const key of current.order) {
    if (previous.sections[key] !== current.sections[key])
      changes.push({
        type: "replace",
        key,
        ...(previous.sections[key] === undefined ? {} : { previous: previous.sections[key] }),
        rendered: current.sections[key],
      })
  }
  return changes
}

export function reconcile(input: ReconcileInput, previous?: Snapshot): Result {
  if (previous) validateSnapshot(previous)
  const projectionVersion = input.projectionVersion ?? CURRENT_PROJECTION_VERSION
  const orderedKeys = observationOrder(input.observations, input.order)
  const observations = new Map(input.observations.map((item) => [item.key, item] as const))
  const compatiblePrevious = previous?.projectionVersion === projectionVersion ? previous : undefined
  const sections: Record<string, string> = {}
  const blocked: Key[] = []

  for (const key of orderedKeys) {
    const observation = observations.get(key)!
    if (observation.type === "present") {
      if (observation.rendered.length === 0) throw new EmptySectionError(key)
      sections[key] = observation.rendered
      continue
    }
    if (observation.type === "absent") continue

    const admitted = compatiblePrevious?.sections[key]
    if (admitted !== undefined) {
      sections[key] = admitted
      continue
    }
    if (observation.availability === "required") blocked.push(key)
  }

  if (blocked.length > 0) return { _tag: "Blocked", keys: blocked.toSorted() }

  const snapshot: Snapshot = {
    projectionVersion,
    order: orderedKeys.filter((key) => sections[key] !== undefined),
    sections,
  }
  const changes = diff(previous, snapshot)
  const surfaceChanged = previous === undefined ? snapshot.order.length > 0 : render(previous) !== render(snapshot)
  const checkpointChanged =
    previous === undefined ||
    previous.projectionVersion !== snapshot.projectionVersion ||
    !sameArray(previous.order, snapshot.order) ||
    !sameSections(previous.sections, snapshot.sections)

  return {
    _tag: "Ready",
    snapshot,
    changes,
    surfaceChanged,
    checkpointChanged,
    orderChanged: relativeOrderChanged(previous, snapshot),
  }
}

/**
 * Chooses the strongest mechanically equivalent provider-neutral projection.
 *
 * `cumulative-privileged` is intentionally conservative: only suffix additions
 * are append-safe without inventing an application-level replace/remove protocol.
 * Existing-section replacement, removal, or relative reordering falls back to a
 * complete privileged head. `replace-complete` is stronger because the provider
 * contract itself defines the later message as the whole effective prompt.
 */
export function planProjection(
  result: Ready,
  capability: EffectiveSystemMessageCapability,
  previous?: Snapshot,
): ProjectionPlan {
  if (!result.surfaceChanged) return { type: "none", reason: "surface-unchanged" }

  const currentText = render(result.snapshot)
  if (!previous) return { type: "head", text: currentText, reason: "initial" }
  if (currentText.length === 0) return { type: "head", text: currentText, reason: "empty-surface" }
  if (capability.history === "head-only") return { type: "head", text: currentText, reason: "head-only" }
  if (capability.history === "replace-complete") return { type: "append-complete", text: currentText }

  if (result.orderChanged)
    return { type: "head", text: currentText, reason: "cumulative-order-change" }

  const additions = result.changes.filter(
    (change): change is Extract<Change, { readonly type: "replace" }> =>
      change.type === "replace" && change.previous === undefined,
  )
  const onlyAdditions = additions.length === result.changes.length
  const prefixUnchanged =
    result.snapshot.order.length >= previous.order.length &&
    previous.order.every((key, index) => result.snapshot.order[index] === key)

  if (!onlyAdditions || !prefixUnchanged)
    return { type: "head", text: currentText, reason: "cumulative-nonmonotonic" }

  const added = new Set(additions.map((change) => change.key))
  const keys = result.snapshot.order.filter((key) => added.has(key))
  return {
    type: "append-additive",
    keys,
    text: keys.map((key) => result.snapshot.sections[key]).join("\n\n"),
  }
}
