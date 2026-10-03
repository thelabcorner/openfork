import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { PermissionNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { SessionID } from "@/session/schema"
import { SessionPaths } from "./session"
import { described } from "./metadata"

const root = "/permission"
const ReplyPayload = Schema.Struct({
  reply: PermissionV1.Reply,
  message: Schema.optional(Schema.String),
})

export const PermissionResponsePayload = Schema.Struct({ response: PermissionV1.Reply })

export const PermissionApi = HttpApi.make("permission")
  .add(
    HttpApiGroup.make("permission")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(PermissionV1.Request), "List of pending permissions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.list",
            summary: "List pending permissions",
            description: "Get all pending permission requests across all sessions.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "permission",
          description: "Experimental HttpApi permission routes.",
        }),
      )
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

export const PermissionControlApi = HttpApi.make("permission-control").add(
  HttpApiGroup.make("permissionControl")
    .add(
      HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
        params: { requestID: PermissionV1.ID },
        query: WorkspaceRoutingQuery,
        payload: ReplyPayload,
        success: described(Schema.Boolean, "Permission processed successfully"),
        error: [HttpApiError.BadRequest, PermissionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "permission.reply",
          summary: "Respond to permission request",
          description: "Approve or deny a pending permission request without loading a workspace Instance.",
        }),
      ),
      HttpApiEndpoint.post("sessionReply", SessionPaths.permissions, {
        params: { sessionID: SessionID, permissionID: PermissionV1.ID },
        query: WorkspaceRoutingQuery,
        payload: PermissionResponsePayload,
        success: described(Schema.Boolean, "Permission processed successfully"),
        error: [HttpApiError.BadRequest, PermissionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "permission.respond",
          summary: "Respond to permission",
          description: "Approve or deny a permission request without loading a workspace Instance.",
        }),
      ),
    )
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
