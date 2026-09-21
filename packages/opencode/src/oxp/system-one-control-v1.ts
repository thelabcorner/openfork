import { Effect, Layer } from "effect"
import { OxpRuntimeV1 } from "./runtime-v1"
import { OxpSystemOneControl } from "./system-one-control"

async function runtimeModules() {
  const { SystemOne } = await import("@/system-one/system-one")
  return { SystemOne }
}

const infer: OxpSystemOneControl.Interface["infer"] = (target, input) =>
  OxpRuntimeV1.enter(
    target,
    async () => {
      const { SystemOne } = await runtimeModules()
      return Effect.gen(function* () {
        // Instance bootstrap can be materially expensive. Re-check the caller's
        // live integrations authority immediately before the provider request.
        yield* OxpRuntimeV1.commitGuard(
          target,
          "OXP System One integrations authority revalidation failed",
        )
        const systemOne = yield* SystemOne.Service
        return yield* systemOne.infer(input)
      })
    },
    "Native System One inference failed",
  )

export const layer = Layer.succeed(
  OxpSystemOneControl.Service,
  OxpSystemOneControl.Service.of({ infer }),
)

export * as OxpSystemOneControlV1 from "./system-one-control-v1"
