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

export const KillPayload = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "Session that owns the execution" }),
  callID: Schema.optional(
    Schema.String.annotate({ description: "Tool call id of a running foreground execution" }),
  ),
  jobId: Schema.optional(
    Schema.String.annotate({ description: "Background job id previously launched by the bash tool" }),
  ),
}).annotate({ identifier: "ToolKillPayload" })

export const KillResponse = Schema.Struct({
  killed: Schema.Boolean.annotate({ description: "Whether a live execution was found and terminated" }),
  status: Schema.optional(Schema.String.annotate({ description: "Background job status when jobId was targeted" })),
  generation: Schema.optional(Schema.Number),
}).annotate({ identifier: "ToolKillResponse" })

export const ToolPaths = {
  reload: `${root}/reload`,
  kill: `${root}/kill`,
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
      .add(
        HttpApiEndpoint.post("kill", ToolPaths.kill, {
          query: WorkspaceRoutingQuery,
          payload: KillPayload,
          success: described(KillResponse, "Tool stop result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.kill",
            summary: "Stop a tool execution",
            description:
              "Request cancellation of a foreground tool call or background job. Stop reconciles an unresolved call whose executor is proven dead by pausing the Session, recording unfinished results as unknown, and releasing only its exact execution generation. Live owners receive a durable interrupt request.",
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
      title: "OpenFork experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
