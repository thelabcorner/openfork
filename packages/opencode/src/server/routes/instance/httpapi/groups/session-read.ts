import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageID, SessionID } from "@/session/schema"
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
    )
    .annotateMerge(OpenApi.annotations({ title: "sessionRead", description: "Bootstrap-free session read routes." }))
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
