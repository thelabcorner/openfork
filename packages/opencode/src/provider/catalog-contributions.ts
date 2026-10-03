import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ServerEvent } from "@opencode-ai/schema/server-event"
import { Cause, Context, Effect, Layer, Scope } from "effect"
import type { Info } from "./provider"

export interface Snapshot {
  readonly revision: number
  readonly status: "partial" | "ready"
  readonly providers: Record<string, Info>
}

export interface Interface {
  readonly get: (directory: string) => Snapshot | undefined
  readonly publish: (input: {
    readonly directory: string
    readonly providers: Record<string, Info>
    readonly status?: "partial" | "ready"
  }) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderCatalogContributions") {}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== "object") return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/^(key|apiKey|token|secret|authorization)$/i.test(key)) continue
    output[key] = redact(item)
  }
  return output
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const ownerScope = yield* Scope.Scope
    const values = new Map<string, Snapshot>()
    const pending = new Map<string, { readonly directory: string; readonly revision: number; readonly status: Snapshot["status"] }>()
    const MAX_LOCATIONS = 32
    let revisionCounter = 0
    let drainRunning = false
    let drainGeneration = 0

    const touch = <T>(map: Map<string, T>, key: string, value: T) => {
      map.delete(key)
      map.set(key, value)
      while (map.size > MAX_LOCATIONS) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
        pending.delete(oldest)
      }
    }

    // A single scoped worker keeps notification work out of the provider
    // selection path. Updates replace the pending value for their directory,
    // so a blocked event subscriber retains at most one notification per
    // recently active catalog location.
    const drain = (generation: number): Effect.Effect<void> => Effect.suspend(() => {
      const next = pending.entries().next()
      if (next.done) {
        if (drainGeneration === generation) drainRunning = false
        return Effect.void
      }
      const [key, event] = next.value
      pending.delete(key)
      return events
        .publish(ServerEvent.ProviderCatalogUpdated, event)
        .pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logWarning("provider catalog notification failed", { cause }),
          ),
          Effect.andThen(drain(generation)),
        )
    })

    return Service.of({
      get: (directory) => {
        const value = values.get(directory)
        if (value) touch(values, directory, value)
        return value
      },
      publish: (input) =>
        Effect.gen(function* () {
          const providers = redact(input.providers) as Record<string, Info>
          // Provider runtime state does not contain the separately-owned T3
          // account/model projection. It is therefore only a partial catalog
          // until that projection is materialized by its owner.
          const status = input.status ?? "partial"
          const previous = values.get(input.directory)
          if (previous && previous.status === status && JSON.stringify(previous.providers) === JSON.stringify(providers)) {
            touch(values, input.directory, previous)
            return previous.revision
          }
          const revision = ++revisionCounter
          touch(values, input.directory, { revision, status, providers })
          touch(pending, input.directory, { directory: input.directory, revision, status })
          if (!drainRunning) {
            drainRunning = true
            const generation = ++drainGeneration
            yield* drain(generation).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (drainGeneration === generation) drainRunning = false
                }),
              ),
              Effect.forkIn(ownerScope),
            )
          }
          return revision
        }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [EventV2.node] })
