import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Session } from "@/session/session"
import { Authorization } from "../middleware/authorization"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { SessionPaths } from "./session"
import { described } from "./metadata"

// Session admission is durable Tier-1 metadata and must remain independent of
// Instance bootstrap. Execution services are acquired only when a later prompt
// is admitted for this explicit location.
export const SessionCreateApi = HttpApi.make("session-create").add(
  HttpApiGroup.make("sessionCreate")
    .add(
      HttpApiEndpoint.post("create", SessionPaths.create, {
        query: WorkspaceRoutingQuery,
        payload: [HttpApiSchema.NoContent, Session.CreateInput],
        success: described(Session.Info, "Successfully created session"),
        error: [HttpApiError.BadRequest, HttpApiError.InternalServerError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.create",
          summary: "Create session",
          description: "Create a new OpenFork session for interacting with AI assistants and managing conversations.",
        }),
      ),
    )
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
