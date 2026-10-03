export * as CodingActivity from "./coding-activity"

import { Clock, Context, Effect, Layer, PubSub, Stream } from "effect"
import { makeGlobalNode } from "./effect/app-node"

export type Kind = "read" | "write"

export type Source = "session" | "special-agent" | "oxp" | "ofxp" | "http" | "core"

export interface Model {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export interface Input {
  readonly entity: string
  readonly kind: Kind
  readonly time?: number
  readonly aiLineChanges?: number
  readonly aiSession?: string
  readonly project?: string
  /**
   * Canonical directory of the project the observation belongs to, when the
   * producer can prove one. Optional on purpose: Core never invents a folder
   * from a project display name, a session, or a process working directory, so
   * an absent folder stays absent.
   */
  readonly projectFolder?: string
  readonly projectRootCount?: number
  readonly branch?: string
  readonly language?: string
  readonly model?: Model
  readonly source: Source
  /**
   * Stable identity of the actor/origin named by the producer, when it has one.
   * This is attribution metadata, not an idempotency token: the same principal
   * may legitimately produce many observations with the same sourceRef.
   */
  readonly sourceRef?: string
  /**
   * Optional producer-proven identity for exactly one logical observation.
   * Consumers may use this to suppress a replay of that same observation. It
   * must never be synthesized from an actor/principal identity merely because
   * one is available; absence means "not safely replay-deduplicable".
   */
  readonly replayToken?: string
}

export interface Activity extends Input {
  readonly time: number
}

export const SLIDING_CAPACITY = 1024

let canonical: PubSub.PubSub<Activity> | undefined

// Tier-0 process-global ownership: one sliding bus shared by module identity,
// materialized lazily on first use and never shut down by a Layer build or a
// single runtime scope.
const bus = () => (canonical ??= Effect.runSync(PubSub.sliding<Activity>(SLIDING_CAPACITY)))

const optionalString = (value: string | undefined) => (typeof value === "string" ? value : undefined)

/**
 * A directory the producer actually observed. A blank string names no directory
 * at all, so it is dropped rather than forwarded as an empty path; nothing here
 * derives a value the producer did not supply.
 */
const optionalFolder = (value: string | undefined) => {
  const folder = optionalString(value)?.trim()
  return folder ? folder : undefined
}

const optionalInteger = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined

const optionalCount = (value: number | undefined) => {
  const integer = optionalInteger(value)
  return integer === undefined ? undefined : Math.max(0, integer)
}

function sanitizeModel(model: Model | undefined): Model | undefined {
  if (model === undefined) return undefined
  const providerID = optionalString(model.providerID)
  const modelID = optionalString(model.modelID)
  if (!providerID || !modelID) return undefined
  const variant = optionalString(model.variant)
  return variant === undefined ? { providerID, modelID } : { providerID, modelID, variant }
}

function sanitize(input: Input, entity: string, time: number): Activity {
  return {
    entity,
    kind: input.kind,
    time,
    aiLineChanges: optionalInteger(input.aiLineChanges),
    aiSession: optionalString(input.aiSession),
    project: optionalString(input.project),
    projectFolder: optionalFolder(input.projectFolder),
    projectRootCount: optionalCount(input.projectRootCount),
    branch: optionalString(input.branch),
    language: optionalString(input.language),
    model: sanitizeModel(input.model),
    source: input.source,
    sourceRef: optionalString(input.sourceRef),
    replayToken: optionalString(input.replayToken),
  }
}

export interface Interface {
  readonly record: (input: Input) => Effect.Effect<boolean>
  readonly stream: () => Stream.Stream<Activity>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodingActivity") {}

export const record = Effect.fn("CodingActivity.record")(function* (input: Input) {
  if (typeof input.entity !== "string" || input.entity.trim().length === 0) return false
  const time =
    typeof input.time === "number" && Number.isFinite(input.time)
      ? input.time
      : (yield* Clock.currentTimeMillis) / 1000
  return yield* PubSub.publish(bus(), sanitize(input, input.entity, time))
})

export const stream = (): Stream.Stream<Activity> => Stream.fromPubSub(bus())

const layer = Layer.succeed(Service, Service.of({ record, stream }))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
