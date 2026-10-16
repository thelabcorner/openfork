import { InstanceState } from "@/effect/instance-state"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { PromptRevisor } from "@opencode-ai/core/prompt-revisor"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MCP } from "@/mcp"
import { Agent } from "@/agent/agent"
import { PromptRevisorRuns } from "@/prompt-revisor/run-registry"
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
    const agents = yield* Agent.Service
    const routes = yield* ProviderRoute.Service
    const runtime = makeRuntime(provider, llm, agents, mcp, routes)

    const revise = Effect.fn("PromptRevisorHttpApi.revise")(function* (ctx) {
      if (!ctx.payload.prompt.trim()) {
        return yield* new InvalidRequestError({ message: "Prompt cannot be empty", field: "prompt" })
      }
      const instance = yield* InstanceState.context
      const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }))
      const run = PromptRevisor.Service.use((service) => service.reviseWithRuntime(ctx.payload, runtime)).pipe(
        Effect.provide(services),
      )
      // With a durable target the run is owned by the process-global registry:
      // this request merely awaits it, so a composer that navigates away only
      // abandons the waiter and the artifact still commits to the mailbox.
      // Without a target there is no identity to recover or cancel by, so the
      // legacy request-scoped behavior is preserved byte-for-byte.
      const target = ctx.payload.target
      return yield* PromptRevisorRuns.runDetached(
        target === undefined
          ? {}
          : {
              locator: { kind: target.kind, key: target.key },
              sourceFingerprint: target.sourceFingerprint,
              ...(ctx.payload.operationID === undefined ? {} : { operationID: ctx.payload.operationID }),
            },
        run,
      ).pipe(
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
