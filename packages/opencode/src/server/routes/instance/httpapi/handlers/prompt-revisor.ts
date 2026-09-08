import { InstanceState } from "@/effect/instance-state"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { PromptRevisor } from "@opencode-ai/core/prompt-revisor"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MCP } from "@/mcp"
import { makeRuntime } from "@/prompt-revisor/runtime"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"

export const promptRevisorHandlers = HttpApiBuilder.group(InstanceHttpApi, "prompt-revisor", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const mcp = yield* MCP.Service
    const runtime = makeRuntime(provider, llm, mcp)

    const revise = Effect.fn("PromptRevisorHttpApi.revise")(function* (ctx) {
      if (!ctx.payload.prompt.trim()) {
        return yield* new InvalidRequestError({ message: "Prompt cannot be empty", field: "prompt" })
      }
      const instance = yield* InstanceState.context
      const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }))
      return yield* PromptRevisor.Service.use((service) => service.reviseWithRuntime(ctx.payload, runtime)).pipe(
        Effect.provide(services),
        Effect.mapError(
          (error) =>
            new ServiceUnavailableError({
              service: "prompt-revisor",
              message: error.message,
            }),
        ),
      )
    })

    return handlers.handle("revise", revise)
  }),
)
