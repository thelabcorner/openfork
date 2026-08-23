import { SessionGroup } from "@opencode-ai/schema/session-group"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"
import { ApiNotFoundError } from "../errors"

const root = "/session-group"

export const SessionGroupPaths = {
  list: root,
  create: root,
  details: `${root}/details`,
  get: `${root}/:groupID`,
  rename: `${root}/:groupID`,
  remove: `${root}/:groupID`,
  reorder: `${root}/:groupID/reorder`,
  addSession: `${root}/:groupID/session`,
  removeSession: `${root}/:groupID/session/:sessionID`,
} as const

export const CreatePayload = Schema.Struct({
  name: Schema.String,
})

export const RenamePayload = Schema.Struct({
  name: Schema.String,
})

export const ReorderPayload = Schema.Struct({
  position: Schema.Number,
})

export const AddSessionPayload = Schema.Struct({
  sessionId: Schema.String,
})

const Detail = Schema.Struct({
  group: SessionGroup.Info,
  sessions: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
})

export const SessionGroupApi = HttpApi.make("session-group")
  .add(
    HttpApiGroup.make("session-group")
      .add(
        HttpApiEndpoint.get("list", SessionGroupPaths.list, {
          success: described(Schema.Array(SessionGroup.Info), "List of session groups"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.list",
            summary: "List session groups",
            description: "Get a list of all session groups, ordered by position.",
          }),
        ),
        HttpApiEndpoint.post("create", SessionGroupPaths.create, {
          payload: CreatePayload,
          success: described(SessionGroup.Info, "Created session group"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.create",
            summary: "Create session group",
            description: "Create a new session group with a name.",
          }),
        ),
        HttpApiEndpoint.get("get", SessionGroupPaths.get, {
          params: { groupID: SessionGroup.ID },
          success: described(Detail, "Session group with sessions"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.get",
            summary: "Get session group",
            description: "Get a session group with its sessions.",
          }),
        ),
        HttpApiEndpoint.get("listDetails", SessionGroupPaths.details, {
          success: described(Schema.Array(Detail), "All session groups with their sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.listDetails",
            summary: "List session groups with sessions",
            description: "Get every session group together with its member sessions in one response.",
          }),
        ),
        HttpApiEndpoint.patch("rename", SessionGroupPaths.rename, {
          params: { groupID: SessionGroup.ID },
          payload: RenamePayload,
          success: described(HttpApiSchema.NoContent, "Successfully renamed session group"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.rename",
            summary: "Rename session group",
            description: "Rename a session group.",
          }),
        ),
        HttpApiEndpoint.delete("remove", SessionGroupPaths.remove, {
          params: { groupID: SessionGroup.ID },
          success: described(HttpApiSchema.NoContent, "Successfully deleted session group"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.remove",
            summary: "Delete session group",
            description:
              "Delete a session group. Sessions in the group will be ungrouped.",
          }),
        ),
        HttpApiEndpoint.post("reorder", SessionGroupPaths.reorder, {
          params: { groupID: SessionGroup.ID },
          payload: ReorderPayload,
          success: described(HttpApiSchema.NoContent, "Successfully reordered session group"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.reorder",
            summary: "Reorder session group",
            description: "Change the position of a session group.",
          }),
        ),
        HttpApiEndpoint.post("addSession", SessionGroupPaths.addSession, {
          params: { groupID: SessionGroup.ID },
          payload: AddSessionPayload,
          success: described(HttpApiSchema.NoContent, "Successfully added session to group"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.addSession",
            summary: "Add session to group",
            description: "Add a session to a group.",
          }),
        ),
        HttpApiEndpoint.delete("removeSession", SessionGroupPaths.removeSession, {
          params: { groupID: SessionGroup.ID, sessionID: Schema.String },
          success: described(HttpApiSchema.NoContent, "Successfully removed session from group"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.removeSession",
            summary: "Remove session from group",
            description: "Remove a session from a group.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session-group",
          description: "Session group routes.",
        }),
      )
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
