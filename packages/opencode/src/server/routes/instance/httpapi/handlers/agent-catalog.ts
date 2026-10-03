import { Agent } from "@/agent/agent"
import * as AgentCatalog from "@opencode-ai/core/agent/catalog"
import { Agent as AgentContract } from "@opencode-ai/schema/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { AgentCatalogApi } from "../groups/agent-catalog"

function v1Agent(info: AgentContract.Info): Agent.Info {
  return {
    name: info.id,
    description: info.description,
    mode: info.mode,
    native: AgentContract.isBuiltInID(info.id),
    hidden: info.hidden,
    color: info.color,
    permission: info.permissions.map((rule) => ({
      permission: rule.action,
      pattern: rule.resource,
      action: rule.effect,
    })),
    model: info.model
      ? {
          providerID: info.model.providerID,
          modelID: info.model.id,
          ...(info.model.accountID ? { accountID: info.model.accountID } : {}),
        }
      : undefined,
    variant: info.model?.variant,
    prompt: info.system,
    options: info.request.body,
    steps: info.steps,
  }
}

export const agentCatalogHandlers = HttpApiBuilder.group(AgentCatalogApi, "agent-catalog", (handlers) =>
  handlers.handle(
    "list",
    Effect.fn("AgentCatalogHttpApi.list")(function* () {
      const route = yield* WorkspaceRouteContext
      const location = Location.Ref.make({
        directory: AbsolutePath.make(route.directory),
        workspaceID: route.workspaceID,
      })
      const context = yield* AgentCatalog.MapService.contextEffect(location)
      const agents = yield* AgentCatalog.Service.use((catalog) => catalog.list()).pipe(Effect.provideContext(context))
      return agents.map(v1Agent)
    }),
  ),
)
