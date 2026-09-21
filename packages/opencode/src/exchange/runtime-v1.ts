export * as ExchangeRuntimeV1 from "./runtime-v1"

import { Effect } from "effect"

/**
 * Protocol-neutral lazy entry into one V1 OpenFork Instance.
 *
 * External transports supply their own principal/authority before entering;
 * this owner only addresses the target Instance and cancellation lifetime.
 */
export interface Target {
  readonly directory: string
  readonly workspaceID?: string
  readonly signal?: AbortSignal
  readonly commitGuard?: () => Promise<void>
}

export interface SessionTarget extends Target {
  readonly sessionID: string
}

async function baseModules() {
  const [{ AppRuntime }, { WorkspaceRef }, { InstanceStore }] = await Promise.all([
    import("@/effect/app-runtime"),
    import("@/effect/instance-ref"),
    import("@/project/instance-store"),
  ])
  return { AppRuntime, WorkspaceRef, InstanceStore }
}

export function enter<A>(
  target: Target,
  build: () => Promise<Effect.Effect<A, unknown, any>>,
  failureMessage = "Native OpenFork runtime operation failed",
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: async () => {
      // Establish the authoritative host runtime before importing the consumer.
      // Some consumers (for example Memory) are also members of AppRuntime's
      // graph; evaluating both sides concurrently can race Bun's cyclic ESM
      // initialization and expose an uninitialized node binding.
      const runtime = await baseModules()
      const effect = await build()
      return runtime.AppRuntime.runPromise(
        runtime.InstanceStore.Service.use((instances) =>
          instances.provide(
            { directory: target.directory },
            effect.pipe(
              Effect.provideService(runtime.WorkspaceRef, target.workspaceID as never),
            ),
          ),
        ) as never,
        target.signal ? { signal: target.signal } : undefined,
      ) as Promise<A>
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(failureMessage)),
  })
}

export const commitGuard = (
  target: Target,
  failureMessage = "External authority revalidation failed",
) =>
  target.commitGuard
    ? Effect.tryPromise({
        try: target.commitGuard,
        catch: (cause) => (cause instanceof Error ? cause : new Error(failureMessage)),
      })
    : Effect.void

