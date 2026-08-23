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
          success: described(KillResponse, "Shell kill result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.kill",
            summary: "Kill a shell execution",
            description:
              "Terminate one live shell execution: either the foreground tool call identified by callID (the command process tree is force-killed and the agent continues with an aborted result) or a background job identified by jobId.",
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
