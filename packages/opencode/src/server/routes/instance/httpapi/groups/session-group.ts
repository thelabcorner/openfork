import { SessionGroup } from "@opencode-ai/schema/session-group"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"
import { ApiNotFoundError, ConflictError } from "../errors"

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
  capabilities: `${root}/capabilities`,
  forSession: `${root}/for-session/:sessionID`,
  resolve: `${root}/resolve`,
  reorderMembers: `${root}/:groupID/members/reorder`,
  policy: `${root}/:groupID/policy`,
} as const

export const CreatePayload = Schema.Struct({
  name: Schema.String,
  kind: Schema.optionalKey(SessionGroup.Kind),
  anchorSessionID: Schema.optionalKey(Schema.String),
  ownerPlugin: Schema.optionalKey(Schema.String),
  policy: Schema.optionalKey(SessionGroup.Policy),
})

export const ResolvePayload = Schema.Struct({
  name: Schema.String,
  kind: SessionGroup.Kind,
  anchorSessionID: Schema.optionalKey(Schema.String),
  ownerPlugin: Schema.optionalKey(Schema.String),
  policy: Schema.optionalKey(SessionGroup.Policy),
})

export const RenamePayload = Schema.Struct({
  name: Schema.String,
})

export const ReorderPayload = Schema.Struct({
  position: Schema.Number,
})

export const AddSessionPayload = Schema.Struct({
  sessionId: Schema.String,
  locked: Schema.optionalKey(Schema.Boolean),
  origin: Schema.optionalKey(SessionGroup.MemberOrigin),
  originPlugin: Schema.optionalKey(Schema.String),
  originRef: Schema.optionalKey(Schema.String),
})

export const RemoveQuery = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["unlink_unlocked", "cascade_unlink"])),
  ownerPlugin: Schema.optionalKey(Schema.String),
})

export const RemoveSessionQuery = Schema.Struct({ ownerPlugin: Schema.optionalKey(Schema.String) })
export const ReorderMembersPayload = Schema.Struct({ sessionIds: Schema.Array(Schema.String) })
export const PolicyPayload = SessionGroup.Policy

const Capabilities = Schema.Struct({ version: Schema.Number, features: Schema.Array(Schema.String) })

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
          success: described(SessionGroup.Detail, "Session group with sessions"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.get",
            summary: "Get session group",
            description: "Get a session group with its sessions.",
          }),
        ),
        HttpApiEndpoint.get("listDetails", SessionGroupPaths.details, {
          success: described(Schema.Array(SessionGroup.Detail), "All session groups with their sessions"),
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
          query: RemoveQuery,
          success: described(HttpApiSchema.NoContent, "Successfully deleted session group"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.remove",
            summary: "Delete session group",
            description: "Delete a session group when its membership policy permits it.",
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
          query: RemoveSessionQuery,
          success: described(HttpApiSchema.NoContent, "Successfully removed session from group"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.removeSession",
            summary: "Remove session from group",
            description: "Remove a session from a group.",
          }),
        ),
        HttpApiEndpoint.get("capabilities", SessionGroupPaths.capabilities, {
          success: described(Capabilities, "Supported session-group capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.capabilities",
            summary: "Get session-group capabilities",
            description: "Get the versioned feature set supported by this server.",
          }),
        ),
        HttpApiEndpoint.get("forSession", SessionGroupPaths.forSession, {
          params: { sessionID: Schema.String },
          success: described(Schema.Array(SessionGroup.Detail), "Groups containing the session"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.forSession",
            summary: "Get groups for session",
            description: "Get every group membership for one session.",
          }),
        ),
        HttpApiEndpoint.post("resolve", SessionGroupPaths.resolve, {
          payload: ResolvePayload,
          success: described(SessionGroup.Info, "Resolved session group"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.resolve",
            summary: "Resolve or create session group",
            description: "Idempotently resolve a derived group or create it when absent.",
          }),
        ),
        HttpApiEndpoint.post("reorderMembers", SessionGroupPaths.reorderMembers, {
          params: { groupID: SessionGroup.ID },
          payload: ReorderMembersPayload,
          success: described(HttpApiSchema.NoContent, "Successfully reordered group members"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.reorderMembers",
            summary: "Reorder session-group members",
            description: "Set the member order for a session group.",
          }),
        ),
        HttpApiEndpoint.patch("setPolicy", SessionGroupPaths.policy, {
          params: { groupID: SessionGroup.ID },
          payload: PolicyPayload,
          success: described(HttpApiSchema.NoContent, "Successfully updated group policy"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session-group.setPolicy",
            summary: "Update session-group policy",
            description: "Update the automatic membership policy for a session group.",
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
