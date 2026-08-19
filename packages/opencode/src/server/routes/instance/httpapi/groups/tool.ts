import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/tool"

export const ReloadResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    added: Schema.Array(Schema.String),
    updated: Schema.Array(Schema.String),
    removed: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
  }),
]).annotate({ identifier: "ToolReloadResponse" })

export const ToolPaths = {
  reload: `${root}/reload`,
} as const

export const ToolApi = HttpApi.make("tool")
  .add(
    HttpApiGroup.make("tool")
      .add(
        HttpApiEndpoint.post("reload", ToolPaths.reload, {
          query: WorkspaceRoutingQuery,
          success: described(ReloadResponse, "Tool reload result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.reload",
            summary: "Reload tools",
            description: "Trigger a manual reload of the instance's tool registry from tool files on disk.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "tool", description: "Experimental HttpApi tool routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
