import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"

export const SessionControlPaths = {
  abort: "/session/:sessionID/abort",
} as const

// Session abort is a control-plane action. It must resolve durable session
// ownership and signal an existing execution handle without loading a workspace
// Instance or waiting for config/plugin/tool bootstrap.
export const SessionControlApi = HttpApi.make("session-control").add(
  HttpApiGroup.make("sessionControl")
    .add(
      HttpApiEndpoint.post("abort", SessionControlPaths.abort, {
        params: { sessionID: SessionID },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Boolean, "Abort request accepted"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.abort",
          summary: "Abort session",
          description: "Abort a session without waiting for workspace instance bootstrap.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "sessionControl", description: "Bootstrap-free session control." }))
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
