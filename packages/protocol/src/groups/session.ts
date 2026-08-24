import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { Session } from "@opencode-ai/schema/session"
import { Project } from "@opencode-ai/schema/project"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath, statics } from "@opencode-ai/schema/schema"
import { Workspace } from "@opencode-ai/schema/workspace"
import { Context, Effect, Encoding, Result, Schema, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  CheckpointEpochError,
  CheckpointNotFoundError,
  CheckpointUnsupportedError,
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../errors"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Location } from "@opencode-ai/schema/location"
import { Revert } from "@opencode-ai/schema/revert"
import { SessionEvent } from "@opencode-ai/schema/session-event"

const CheckpointKind = Schema.Literals(["baseline", "turn", "manual", "pre-revert"])
const CheckpointStatus = Schema.Literals(["capturing", "ready", "partial", "error", "aborted"])

const CheckpointExcluded = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
  size: Schema.optional(Schema.Number),
})

const CheckpointInfo = Schema.Struct({
  id: Schema.String,
  sessionID: Session.ID,
  ordinal: Schema.Number,
  kind: CheckpointKind,
  status: CheckpointStatus,
  userMessageID: Schema.optional(Schema.String),
  assistantMessageID: Schema.optional(Schema.String),
  beforeSnapshot: Schema.String,
  afterSnapshot: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  finalizedAt: Schema.optional(Schema.Number),
  summary: Schema.Struct({
    files: Schema.Number,
    additions: Schema.Number,
    deletions: Schema.Number,
  }),
  excluded: Schema.optional(Schema.Array(CheckpointExcluded)),
  epochMismatch: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "CheckpointInfo" })

const CheckpointListQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  status: Schema.optional(CheckpointStatus),
  kind: Schema.optional(CheckpointKind),
})

const CheckpointDiffQuery = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["turn", "session"])),
})

const CheckpointRevertPayload = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["discard-current", "preserve-current"])),
})

const CheckpointCreatePayload = Schema.Struct({
  kind: Schema.Literals(["manual"]),
  label: Schema.optional(Schema.String),
})

const CheckpointDiffResponse = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  mode: Schema.Literals(["turn", "session"]),
  files: Schema.Array(Revert.FileDiff),
  excluded: Schema.optional(Schema.Array(CheckpointExcluded)),
  partial: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "CheckpointDiff" })

const SessionsQueryFields = {
  workspace: Workspace.ID.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.optional(Schema.String),
}

const SessionsDirectoryQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath,
})

const SessionsProjectQuery = Schema.Struct({
  ...SessionsQueryFields,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const SessionsAllQuery = Schema.Struct(SessionsQueryFields)

const withCursor = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => ({
    ...Struct.omit(fields, ["limit"]),
    anchor: Session.ListAnchor,
  }))

const SessionsCursorInput = Schema.Union([
  withCursor(SessionsDirectoryQuery),
  withCursor(SessionsProjectQuery),
  withCursor(SessionsAllQuery),
])
const SessionsCursorJson = Schema.fromJsonString(SessionsCursorInput)
const encodeSessionsCursor = Schema.encodeSync(SessionsCursorJson)
const decodeSessionsCursor = Schema.decodeUnknownEffect(SessionsCursorJson)
const invalidCursor = "Invalid cursor" as const

export const SessionsCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  statics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof SessionsCursorInput.Type) => make(Encoding.encodeBase64Url(encodeSessionsCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Encoding.decodeBase64UrlString(input)
          return Result.isFailure(result)
            ? Effect.fail(invalidCursor)
            : decodeSessionsCursor(result.success).pipe(Effect.mapError(() => invalidCursor))
        }),
    }
  }),
)
export type SessionsCursor = typeof SessionsCursor.Type

const SessionActive = Schema.Struct({
  type: Schema.Literals(["running", "paused"]),
}).annotate({ identifier: "SessionActive" })

const SessionHistoryLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))

export const SessionHistoryQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SessionHistoryLimit), Schema.optional),
  after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
})

const SessionSearchLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))

export const SessionSearchQuery = Schema.Struct({
  query: Schema.String,
  directory: AbsolutePath.pipe(Schema.optional),
  workspace: Workspace.ID.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SessionSearchLimit), Schema.optional),
}).annotate({ identifier: "SessionSearchQuery" })

export interface SessionSearchMessageMatch extends Schema.Schema.Type<typeof SessionSearchMessageMatch> {}
export const SessionSearchMessageMatch = Schema.Struct({
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
  sessionTitle: Schema.String,
  directory: Schema.String,
  projectID: Project.ID,
  time: Schema.Struct({ created: Schema.Number }),
  type: Schema.Literals([
    "user",
    "assistant",
    "shell",
    "synthetic",
    "system",
    "compaction",
    "agent-switched",
    "model-switched",
  ]),
  snippet: Schema.String,
  matchedTerms: Schema.Array(Schema.String),
}).annotate({ identifier: "SessionSearchMessageMatch" })

export const SessionSearchResponse = Schema.Struct({
  titleMatches: Schema.Array(Session.Info),
  messageMatches: Schema.Array(SessionSearchMessageMatch),
}).annotate({ identifier: "SessionSearchResponse" })

const SessionsQueryCursor = SessionsCursor.annotate({
  description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
  cursor: SessionsQueryCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

export const makeSessionGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.session")
    .add(
      HttpApiEndpoint.get("session.list", "/api/session", {
        query: SessionsQuery,
        success: Schema.Struct({
          data: Schema.Array(Session.Info),
          cursor: Schema.Struct({
            previous: SessionsCursor.pipe(Schema.optional),
            next: SessionsCursor.pipe(Schema.optional),
          }),
        }).annotate({ identifier: "SessionsResponse" }),
        error: [InvalidCursorError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.list",
          summary: "List sessions",
          description:
            "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.search", "/api/session/search", {
        query: SessionSearchQuery,
        success: Schema.Struct({ data: SessionSearchResponse }),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.search",
          summary: "Search sessions and messages",
          description:
            "Search session titles (LIKE, back-compatible) and session message content (FTS5, BM25-ranked). Message content matches require a query of at least 3 characters.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.create", "/api/session", {
        payload: Schema.Struct({
          id: Session.ID.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          location: Location.Ref.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Session.Info }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.create",
          summary: "Create session",
          description: "Create a session at the requested location.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.active", "/api/session/active", {
        success: Schema.Struct({ data: Schema.Record(Session.ID, SessionActive) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.active",
          summary: "List active sessions",
          description:
            "Retrieve active sessions: foreground drains currently owned by this OpenCode process (type: running) and durable-paused sessions (type: paused). Sessions absent from the result are inactive.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.get", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Session.Info }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.get",
            summary: "Get session",
            description: "Retrieve a session by ID.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ agent: Agent.ID }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchAgent",
            summary: "Switch session agent",
            description: "Switch the agent used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchModel", "/api/session/:sessionID/model", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ model: Model.Ref }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchModel",
            summary: "Switch session model",
            description: "Switch the model used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          prompt: PromptInput.Prompt,
          delivery: SessionInput.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInput.Admitted }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.prompt",
            summary: "Send message",
            description: "Durably admit one session input and schedule agent-loop execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.compact", "/api/session/:sessionID/compact", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.compact",
            summary: "Compact session",
            description: "Compact a session conversation.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.wait", "/api/session/:sessionID/wait", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.wait",
            summary: "Wait for session",
            description: "Wait for a session agent loop to become idle.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.stage", "/api/session/:sessionID/revert/stage", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ messageID: SessionMessage.ID, files: Schema.Boolean.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Revert.State }),
        error: [MessageNotFoundError, SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.revert.stage",
            summary: "Stage session revert",
            description: "Stage or move a reversible session boundary and optionally apply its file changes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.clear", "/api/session/:sessionID/revert/clear", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.session.revert.clear", summary: "Clear staged revert" })),
    )
    .add(
      HttpApiEndpoint.post("session.revert.commit", "/api/session/:sessionID/revert/commit", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.session.revert.commit", summary: "Commit staged revert" }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.context", "/api/session/:sessionID/context", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionMessage.Message) }),
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.context",
            summary: "Get session context",
            description: "Retrieve the active context messages for a session (all messages after the last compaction).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.history", "/api/session/:sessionID/history", {
        params: { sessionID: Session.ID },
        query: SessionHistoryQuery,
        success: Schema.Struct({
          data: Schema.Array(SessionEvent.Durable),
          hasMore: Schema.Boolean,
        }).annotate({ identifier: "SessionHistory" }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.history",
            summary: "Get session history",
            description:
              "Read one finite page of public durable Session events after an exclusive aggregate sequence. Newly committed events may appear on later pages.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.events", "/api/session/:sessionID/event", {
        params: { sessionID: Session.ID },
        query: {
          after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
        },
        success: HttpApiSchema.StreamSse({ data: SessionEvent.Durable }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.events",
            summary: "Subscribe to session events",
            description: "Replay durable events after an aggregate sequence, then continue with new durable events.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.interrupt", "/api/session/:sessionID/interrupt", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.interrupt",
            summary: "Interrupt session execution",
            description: "Interrupt active execution owned by this OpenCode process. Idle interruption is a no-op.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.pause", "/api/session/:sessionID/pause", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.pause",
            summary: "Pause session",
            description:
              "Set the durable paused state and interrupt active execution. Idempotent: pausing an already paused session is a no-op. While paused, no drain provider turn may start; held inputs stay held and drain on resume.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.resume", "/api/session/:sessionID/resume", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.resume",
            summary: "Resume session",
            description:
              "Clear the durable paused state and wake the session so held inputs drain one at a time. The interrupted turn is never auto-retried.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.regenerateTitle", "/api/session/:sessionID/title/regenerate", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          model: Model.Ref.pipe(Schema.optional),
          prompt: Schema.String.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ConflictError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.regenerateTitle",
            summary: "Regenerate session title",
            description:
              "Accept a background title regeneration and return immediately. The generated title is applied only if the session title is unchanged since the request was accepted (a manual rename always wins); failures never overwrite an existing title.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.message", "/api/session/:sessionID/message/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        success: Schema.Struct({ data: SessionMessage.Message }),
        error: [SessionNotFoundError, MessageNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.message",
          summary: "Get session message",
          description: "Retrieve one projected message owned by the Session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.checkpoint.list", "/api/session/:sessionID/checkpoint", {
        params: { sessionID: Session.ID },
        query: CheckpointListQuery,
        success: Schema.Struct({ data: Schema.Array(CheckpointInfo) }),
        error: [SessionNotFoundError, CheckpointUnsupportedError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.checkpoint.list",
            summary: "List checkpoints",
            description:
              "List durable per-turn checkpoints for a session, ordered by ordinal. Returns 422 when the project is not Git or snapshots are disabled.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.checkpoint.get", "/api/session/:sessionID/checkpoint/:checkpointID", {
        params: { sessionID: Session.ID, checkpointID: Schema.String },
        success: CheckpointInfo,
        error: [SessionNotFoundError, CheckpointNotFoundError, CheckpointEpochError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.checkpoint.get",
            summary: "Get checkpoint",
            description: "Retrieve a single checkpoint by ID. Rejects cross-epoch targets.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.checkpoint.diff", "/api/session/:sessionID/checkpoint/:checkpointID/diff", {
        params: { sessionID: Session.ID, checkpointID: Schema.String },
        query: CheckpointDiffQuery,
        success: CheckpointDiffResponse,
        error: [SessionNotFoundError, CheckpointNotFoundError, CheckpointEpochError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.checkpoint.diff",
            summary: "Checkpoint diff",
            description:
              "Structured FileDiff[] for a checkpoint. mode=turn (default) diffs before→after of the checkpoint; mode=session diffs baseline→target.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.checkpoint.diffRaw", "/api/session/:sessionID/checkpoint/:checkpointID/diff/raw", {
        params: { sessionID: Session.ID, checkpointID: Schema.String },
        query: CheckpointDiffQuery,
        success: Schema.String,
        error: [SessionNotFoundError, CheckpointNotFoundError, CheckpointEpochError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.checkpoint.diffRaw",
            summary: "Checkpoint raw diff",
            description: "Joined unified patch text for a checkpoint diff. Bounded by Snapshot size controls.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.checkpoint.revert", "/api/session/:sessionID/checkpoint/:checkpointID/revert", {
        params: { sessionID: Session.ID, checkpointID: Schema.String },
        payload: CheckpointRevertPayload,
        success: CheckpointInfo,
        error: [SessionNotFoundError, CheckpointNotFoundError, CheckpointEpochError, ConflictError, CheckpointUnsupportedError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.checkpoint.revert",
            summary: "Revert to checkpoint",
            description:
              "Restore the filesystem to the checkpoint's after-snapshot and truncate later turns. Captures a pre-revert undo point. mode=discard-current overwrites uncommitted working-tree changes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.checkpoint.create", "/api/session/:sessionID/checkpoint", {
        params: { sessionID: Session.ID },
        payload: CheckpointCreatePayload,
        success: CheckpointInfo,
        error: [SessionNotFoundError, CheckpointUnsupportedError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.checkpoint.create",
            summary: "Create manual checkpoint",
            description: "Create a manual checkpoint capturing the current worktree state.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "sessions",
        description: "Experimental session routes.",
      }),
    )
