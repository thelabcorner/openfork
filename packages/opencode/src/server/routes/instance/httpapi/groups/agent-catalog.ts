import { Agent } from "@/agent/agent"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

/** The retained V1 agent catalog contract, served without InstanceContext. */
export const AgentCatalogApi = HttpApi.make("agent-catalog").add(
  HttpApiGroup.make("agent-catalog")
    .add(
      HttpApiEndpoint.get("list", "/agent", {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(Agent.Info), "List of configured agents"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "app.agents",
          summary: "List agents",
          description: "Get the resolved OpenFork agent catalog for an explicit workspace location.",
        }),
      ),
    )
    .middleware(WorkspaceRoutingMiddleware),
)
