export * as SystemContext from "./index"

import { Effect, Schema } from "effect"
import { SystemSurface } from "../system-surface"

/**
 * Owns independently refreshable producers of complete privileged sections.
 *
 * A source knows only how to observe its authoritative current value and render
 * the exact complete section for that value. Comparison, replacement/removal,
 * ordering changes, projection capability, and durable admission belong to
 * `SystemSurface` / `SessionContextEpoch`, never to the producer.
 *
 * Returning `unavailable` means observation failed temporarily. It differs from
 * removing a source from the context; `SystemSurface` decides whether compatible
 * admitted bytes can be retained according to the source availability policy.
 *
 * @module
 */

/** Stable namespaced identity for one independently refreshable context source. */
export const Key = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/)).pipe(
  Schema.brand("SystemContext.Key"),
)
export type Key = typeof Key.Type

/** Indicates that a source could not be observed without treating it as removed. */
export const unavailable = Symbol.for("@opencode/SystemContext.Unavailable")
export type Unavailable = typeof unavailable

/** The source is authoritatively absent and any previously admitted section must be removed. */
export const absent = Symbol.for("@opencode/SystemContext.Absent")
export type Absent = typeof absent

/** Defines one typed source before its value type is hidden by `make`. */
export interface Source<A> {
  readonly key: Key
  readonly load: Effect.Effect<A | Unavailable | Absent>
  readonly availability?: SystemSurface.Availability
  /** Exact complete model-visible section for the current authoritative value. */
  readonly render: (current: A) => string
}

const ContextTypeId: unique symbol = Symbol.for("@opencode/SystemContext")

/** Opaque carrier for composable system context sources. */
export interface SystemContext {
  readonly [ContextTypeId]: ReadonlyArray<PackedSource>
}

/** Pre-SystemSurface row format; retained only for lazy durable migration. */
export const LegacySourceSnapshot = Schema.Struct({
  value: Schema.Json,
  removed: Schema.optional(Schema.NonEmptyString),
})
export type LegacySourceSnapshot = typeof LegacySourceSnapshot.Type

export const LegacySnapshot = Schema.Record(Key, LegacySourceSnapshot)
export type LegacySnapshot = Readonly<Record<string, LegacySourceSnapshot>>

export class InitializationBlocked extends Schema.TaggedErrorClass<InitializationBlocked>()(
  "SystemContext.InitializationBlocked",
  { keys: Schema.Array(Key) },
) {
  override get message() {
    return `System context initialization blocked by unavailable sources: ${this.keys.join(", ")}`
  }
}

export class DuplicateKeyError extends Schema.TaggedErrorClass<DuplicateKeyError>()("SystemContext.DuplicateKeyError", {
  key: Key,
}) {
  override get message() {
    return `Duplicate system context key: ${this.key}`
  }
}

interface PackedSource {
  readonly key: Key
  readonly availability: SystemSurface.Availability
  readonly load: Effect.Effect<string | Unavailable | Absent>
}

/** The identity context. */
export const empty = context([])

/** Closes a typed source into a context that composes with differently typed sources. */
export function make<A>(source: Source<A>): SystemContext {
  return context([
    {
      key: source.key,
      availability: source.availability ?? "required",
      load: source.load.pipe(
        Effect.map((value) => {
          if (isUnavailable(value)) return value
          if (isAbsent(value)) return value
          return requireText(source.key, source.render(value))
        }),
      ),
    },
  ])
}

/** Combines contexts in order and rejects duplicate source keys immediately. */
export function combine(values: ReadonlyArray<SystemContext>): SystemContext {
  const sources = values.flatMap((value) => value[ContextTypeId])
  assertUniqueKeys(sources)
  return context(sources)
}

export interface SurfaceObservation {
  readonly observations: ReadonlyArray<SystemSurface.Observation>
  readonly order: ReadonlyArray<SystemSurface.Key>
}

/**
 * Observe every registered source once and project exact complete current
 * sections into the shared SystemSurface semantic engine. Source order is
 * preserved exactly; registry-level discovery owns any sorting before combine.
 */
export const observeSurface = (value: SystemContext): Effect.Effect<SurfaceObservation> =>
  Effect.forEach(
    value[ContextTypeId],
    (source) =>
      source.load.pipe(
        Effect.map((result): SystemSurface.Observation => {
          const surfaceKey = SystemSurface.Key.make(String(source.key))
          return result === unavailable
            ? SystemSurface.unavailable(surfaceKey, source.availability)
            : result === absent
              ? SystemSurface.absent(surfaceKey, source.availability)
            : SystemSurface.present(surfaceKey, result, source.availability)
        }),
      ),
    { concurrency: 8 },
  ).pipe(Effect.map((observations) => ({ observations, order: observations.map((item) => item.key) })))

function context(sources: ReadonlyArray<PackedSource>): SystemContext {
  return { [ContextTypeId]: sources }
}

function isUnavailable(value: unknown): value is Unavailable {
  return value === unavailable
}

function isAbsent(value: unknown): value is Absent {
  return value === absent
}

function requireText(key: Key, text: string) {
  if (text.length === 0) throw new Error(`System context source ${key} rendered an empty section`)
  return text
}

function assertUniqueKeys(sources: ReadonlyArray<PackedSource>) {
  const keys = new Set<Key>()
  for (const source of sources) {
    if (keys.has(source.key)) throw new DuplicateKeyError({ key: source.key })
    keys.add(source.key)
  }
}
