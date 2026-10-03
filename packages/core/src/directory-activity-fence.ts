export * as DirectoryActivityFence from "./directory-activity-fence"

import { Context, Effect, Layer } from "effect"
import { DirectoryMaintenanceGuard } from "./directory-maintenance-guard"
import { makeGlobalNode } from "./effect/app-node"

export type Handle = DirectoryMaintenanceGuard.Token
export type AcquireResult = DirectoryMaintenanceGuard.AcquireResult
export type HealthResult = DirectoryMaintenanceGuard.HealthResult
export type ReleaseResult = DirectoryMaintenanceGuard.ReleaseResult
export type Error = DirectoryMaintenanceGuard.Error

/**
 * Internal two-directory activity-exclusion request.
 *
 * G3 deliberately carries no donor/target or repository semantics. Those belong
 * to the later adapter boundary. OpenFork owns only the exact guard identity and
 * physical directory set.
 */
export interface AcquireInput {
  readonly guardId: string
  readonly directories: readonly [string, string]
}

export interface Interface {
  readonly acquire: (input: AcquireInput) => Effect.Effect<AcquireResult, Error>
  readonly assertHealthy: (handle: Handle) => Effect.Effect<HealthResult>
  readonly release: (handle: Handle) => Effect.Effect<ReleaseResult>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/v2/DirectoryActivityFence",
) {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const guard = yield* DirectoryMaintenanceGuard.Service

    const acquire = Effect.fn("DirectoryActivityFence.acquire")(function* (
      input: AcquireInput,
    ) {
      return yield* guard.acquire({
        guardId: input.guardId,
        // Preserve the complete runtime value defensively. The public TypeScript
        // contract is exactly two directories, but a dynamic caller must never
        // be silently under-fenced if it escapes that tuple type.
        directories: [...input.directories],
      })
    })

    const assertHealthy = Effect.fn("DirectoryActivityFence.assertHealthy")(
      function* (handle: Handle) {
        return yield* guard.assertHealthy(handle)
      },
    )

    const release = Effect.fn("DirectoryActivityFence.release")(function* (
      handle: Handle,
    ) {
      return yield* guard.release(handle)
    })

    return Service.of({ acquire, assertHealthy, release })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [DirectoryMaintenanceGuard.node],
})
