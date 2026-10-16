import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { Authorization } from "../middleware/authorization"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"
import { MessagesQuery } from "./session"

export { MessagesQuery as SessionReadMessagesQuery } from "./session"

const root = "/session"

export const SessionReadPaths = {
  get: `${root}/:sessionID`,
  children: `${root}/:sessionID/children`,
  todo: `${root}/:sessionID/todo`,
  messages: `${root}/:sessionID/message`,
  message: `${root}/:sessionID/message/:messageID`,
  timelineParts: `${root}/:sessionID/timeline-parts`,
  toolOutput: `${root}/:sessionID/message/:messageID/tool-output/:partID`,
} as const

export const SessionReadApi = HttpApi.make("session-read").add(
  HttpApiGroup.make("sessionRead")
    .add(
      HttpApiEndpoint.get("get", SessionReadPaths.get, {
        params: { sessionID: SessionID },
        query: WorkspaceRoutingQuery,
        success: described(Session.Info, "Get session"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.get",
          summary: "Get session",
          description: "Retrieve detailed information about a specific OpenFork session.",
        }),
      ),
      HttpApiEndpoint.get("children", SessionReadPaths.children, {
        params: { sessionID: SessionID },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(Session.Info), "List of children"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.children",
          summary: "Get session children",
          description: "Retrieve all child sessions that were forked from the specified parent session.",
        }),
      ),
      HttpApiEndpoint.get("todo", SessionReadPaths.todo, {
        params: { sessionID: SessionID },
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(Todo.Info), "Todo list"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.todo",
          summary: "Get session todos",
          description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
        }),
      ),
      HttpApiEndpoint.get("messages", SessionReadPaths.messages, {
        params: { sessionID: SessionID },
        query: MessagesQuery,
        success: described(Schema.Array(SessionV1.WithParts), "List of messages"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.messages",
          summary: "Get session messages",
          description: "Retrieve all messages in a session, including user prompts and AI responses.",
        }),
      ),
      HttpApiEndpoint.get("message", SessionReadPaths.message, {
        params: { sessionID: SessionID, messageID: MessageID },
        query: WorkspaceRoutingQuery,
        success: described(SessionV1.WithParts, "Message"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.message",
          summary: "Get message",
          description: "Retrieve a specific message from a session by its message ID.",
        }),
      ),
      HttpApiEndpoint.get("messageParts", `${SessionReadPaths.message}/parts`, {
        params: { sessionID: SessionID, messageID: MessageID },
        query: Schema.Struct({ cursor: Schema.optional(Schema.String) }),
        success: described(
          Schema.Struct({
            data: Schema.Array(
              Schema.Struct({
                partID: SessionV1.PartID,
                type: Schema.String,
                offset: Schema.Number,
                totalChars: Schema.Number,
                text: Schema.String,
              }),
            ),
            nextCursor: Schema.optional(Schema.String),
          }),
          "Bounded message part inspection page",
        ),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.message.parts",
          summary: "Inspect message content progressively",
          description:
            "Return bounded slices of stored part JSON for an explicitly opened detail surface. Pages contain at most 16 1,024-code-point slices, and oversized parts continue by Unicode code-point offset without entering the shared session timeline store.",
        }),
      ),
      HttpApiEndpoint.get("timelineParts", `${SessionReadPaths.message}/timeline-parts`, {
        params: { sessionID: SessionID, messageID: MessageID },
        query: Schema.Struct({ cursor: Schema.optional(SessionV1.PartID) }),
        success: described(
          Schema.Struct({
            data: Schema.Array(SessionV1.Part),
            nextCursor: Schema.optional(SessionV1.PartID),
          }),
          "Complete structured timeline content page",
        ),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.message.timelineParts",
          summary: "Load complete timeline content progressively",
          description:
            "Return complete stored timeline parts in bounded pages. Pages are capped by item count and encoded bytes; a single oversized part is returned alone so every stored part remains reachable.",
        }),
      ),
      HttpApiEndpoint.get("timelinePartsBatch", SessionReadPaths.timelineParts, {
        params: { sessionID: SessionID },
        query: Schema.Struct({
          messageIDs: Schema.Array(MessageID),
          cursor: Schema.optional(Schema.String),
        }),
        success: described(
          Schema.Struct({
            data: Schema.Array(Schema.Struct({ messageID: MessageID, part: SessionV1.Part })),
            nextCursor: Schema.optional(Schema.String),
            completeMessageIDs: Schema.Array(MessageID),
          }),
          "Bounded session-page timeline recovery page",
        ),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.timelinePartsBatch",
          summary: "Recover complete timeline parts for a loaded session page",
          description:
            "Return complete stored parts for an explicit bounded message set, globally ordered by PartID and capped at 512 parts or 2 MiB per page (one oversized part may be returned alone). Each part carries its owning message ID.",
        }),
      ),
      HttpApiEndpoint.get("toolOutput", SessionReadPaths.toolOutput, {
        params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
        query: Schema.Struct({ offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) }),
        success: described(
          Schema.Struct({
            text: Schema.String,
            offset: Schema.Number,
            totalChars: Schema.Number,
            totalLines: Schema.Number,
            complete: Schema.Boolean,
            nextOffset: Schema.optional(Schema.Number),
          }),
          "Lossless bounded page from the durable session-owned tool output",
        ),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.message.toolOutput",
          summary: "Read a durable tool output page",
          description:
            "Return one bounded Unicode-code-point page of the full tool output retained for this persisted tool part. The session/message/part ownership is checked before reading; pages remain available for the lifetime of the owning session message.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "sessionRead", description: "Bootstrap-free session read routes." }))
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
