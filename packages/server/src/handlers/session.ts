import { SessionV2 } from "@opencode-ai/core/session"
import { Checkpoint } from "@opencode-ai/core/checkpoint"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { EventV2 } from "@opencode-ai/core/event"
import { DateTime, Effect, Schema, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "@opencode-ai/protocol/groups/session"
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
} from "@opencode-ai/protocol/errors"
import { AbsolutePath } from "@opencode-ai/core/schema"

const CheckpointReverted = EventV2.define({
  type: "session.checkpoint.reverted",
  durable: { version: 1, aggregate: "sessionID" },
  schema: {
    sessionID: Schema.String,
    checkpointID: Schema.String,
    ordinal: Schema.Number,
    afterSnapshot: Schema.optional(Schema.String),
  },
})

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

function toCheckpointInfo(cp: Checkpoint.SessionCheckpoint) {
  return {
    id: cp.id,
    sessionID: cp.sessionID,
    ordinal: cp.ordinal,
    kind: cp.kind,
    status: cp.status,
    userMessageID: cp.userMessageID ?? undefined,
    assistantMessageID: cp.assistantMessageID ?? undefined,
    beforeSnapshot: cp.beforeSnapshot ?? "",
    afterSnapshot: cp.afterSnapshot ?? undefined,
    createdAt: cp.createdAt,
    finalizedAt: cp.finalizedAt ?? undefined,
    summary: { files: cp.files, additions: cp.additions, deletions: cp.deletions },
    excluded: cp.excluded.length > 0 ? cp.excluded : undefined,
    epochMismatch: cp.epochMismatch,
  }
}

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const events = yield* EventV2.Service
    // Checkpoint/Snapshot are Location-scoped: they are provided per-request by
    // SessionLocationMiddleware (LocationServices), never at group-construction
    // time — requesting them here crashes the server at startup.
    const locationDeps = Effect.gen(function* () {
      return { checkpoint: yield* Checkpoint.Service, snapshot: yield* Snapshot.Service }
    })

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const sessions = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.create({
              id: ctx.payload.id,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
              location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
            }),
          }
        }),
      )
      .handle(
        "session.search",
        Effect.fn(function* (ctx) {
          const query = ctx.query.query.trim()
          if (query.length === 0) return yield* new InvalidRequestError({ message: "Search query must not be empty" })
          const startedAt = Date.now()
          const result = yield* session
            .search({
              query,
              directory: ctx.query.directory,
              workspaceID: ctx.query.workspace,
              project: ctx.query.project,
              limit: ctx.query.limit,
            })
            .pipe(
              Effect.catchTag("Session.SearchError", (error) =>
                Effect.fail(
                  new InvalidRequestError({
                    message: `Search query is not valid: ${error.message}`,
                    kind: "search",
                  }),
                ),
              ),
            )
          const elapsedMs = Date.now() - startedAt
          if (elapsedMs >= 1_000) {
            yield* Effect.logInfo("session search completed slowly", {
              elapsedMs,
              queryLength: query.length,
              limit: ctx.query.limit,
              directory: ctx.query.directory,
              workspace: ctx.query.workspace,
              project: ctx.query.project,
              titleMatches: result.titleMatches.length,
              messageMatches: result.messageMatches.length,
            })
          }
          return {
            data: result,
          }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          // A paused session has no drain, so union the durable-paused IDs with
          // the live-drain set; paused wins in the transient overlap window.
          const paused = yield* session.paused
          const data = new Map<string, { type: "running" | "paused" }>(
            Array.from(yield* session.active, (sessionID) => [sessionID, { type: "running" as const }]),
          )
          for (const sessionID of paused) data.set(sessionID, { type: "paused" as const })
          return { data: Object.fromEntries(data) }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt: ctx.payload.prompt,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.history",
        Effect.fn(function* (ctx) {
          return yield* session
            .history({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
              })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.events",
        Effect.fn((ctx) =>
          Effect.succeed(
            session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie),
          ),
        ),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* session.interrupt(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.pause",
        Effect.fn(function* (ctx) {
          yield* session.pause(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.resume",
        Effect.fn(function* (ctx) {
          yield* session.resume(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.regenerateTitle",
        Effect.fn(function* (ctx) {
          yield* session.regenerateTitle({ sessionID: ctx.params.sessionID, ...ctx.payload }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("SessionTitle.UnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Title generation is not available: ${error.message}`,
                  service: "session.title",
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
      .handle(
        "session.checkpoint.list",
        Effect.fn(function* (ctx) {
          const { checkpoint } = yield* locationDeps
          const checkpoints = yield* checkpoint.list({ sessionID: ctx.params.sessionID })
          let result = checkpoints
          if (ctx.query.status) result = result.filter((c) => c.status === ctx.query.status)
          if (ctx.query.kind) result = result.filter((c) => c.kind === ctx.query.kind)
          if (ctx.query.limit !== undefined) result = result.slice(0, ctx.query.limit)
          return { data: result.map(toCheckpointInfo) }
        }),
      )
      .handle(
        "session.checkpoint.get",
        Effect.fn(function* (ctx) {
          const { checkpoint, snapshot } = yield* locationDeps
          const cp = yield* checkpoint.get({
            sessionID: ctx.params.sessionID,
            checkpointID: Checkpoint.ID.make(ctx.params.checkpointID),
          })
          if (!cp)
            return yield* new CheckpointNotFoundError({
              sessionID: ctx.params.sessionID,
              checkpointID: ctx.params.checkpointID,
              message: `Checkpoint not found: ${ctx.params.checkpointID}`,
            })
          if (cp.epochMismatch)
            return yield* new CheckpointEpochError({
              sessionID: ctx.params.sessionID,
              checkpointID: ctx.params.checkpointID,
              expected: cp.epoch,
              actual: yield* snapshot.epoch(),
              message: `Checkpoint epoch mismatch: expected ${cp.epoch}, got current snapshot epoch`,
            })
          return toCheckpointInfo(cp)
        }),
      )
      .handle(
        "session.checkpoint.diff",
        Effect.fn(function* (ctx) {
          const { checkpoint, snapshot } = yield* locationDeps
          const cp = yield* checkpoint.get({
            sessionID: ctx.params.sessionID,
            checkpointID: Checkpoint.ID.make(ctx.params.checkpointID),
          })
          if (!cp)
            return yield* new CheckpointNotFoundError({
              sessionID: ctx.params.sessionID,
              checkpointID: ctx.params.checkpointID,
              message: `Checkpoint not found: ${ctx.params.checkpointID}`,
            })
          if (cp.epochMismatch)
            return yield* new CheckpointEpochError({
              sessionID: ctx.params.sessionID,
              checkpointID: ctx.params.checkpointID,
              expected: cp.epoch,
              actual: yield* snapshot.epoch(),
              message: `Checkpoint epoch mismatch: expected ${cp.epoch}, got current snapshot epoch`,
            })
          const mode = ctx.query.mode ?? "turn"
          const files = yield* checkpoint
            .diff({ sessionID: ctx.params.sessionID, checkpointID: cp.id, mode })
            .pipe(
              Effect.catchTag(["SessionCheckpoint.EpochMismatch"], (error) =>
                Effect.fail(
                  new CheckpointEpochError({
                    sessionID: ctx.params.sessionID,
                    checkpointID: ctx.params.checkpointID,
                    expected: error.expected,
                    actual: error.actual,
                    message: `Checkpoint epoch mismatch: expected ${error.expected}, got ${error.actual}`,
                  }),
                ),
              ),
            )
          const excluded = cp.excluded.length > 0 ? cp.excluded : undefined
          return {
            from: cp.beforeSnapshot ?? "",
            to: cp.afterSnapshot ?? "",
            mode,
            files,
            excluded,
            partial: cp.status === "partial" ? true : undefined,
          }
        }),
      )
      .handle(
        "session.checkpoint.diffRaw",
        Effect.fn(function* (ctx) {
          const { checkpoint, snapshot } = yield* locationDeps
          const cp = yield* checkpoint.get({
            sessionID: ctx.params.sessionID,
            checkpointID: Checkpoint.ID.make(ctx.params.checkpointID),
          })
          if (!cp)
            return yield* new CheckpointNotFoundError({
              sessionID: ctx.params.sessionID,
              checkpointID: ctx.params.checkpointID,
              message: `Checkpoint not found: ${ctx.params.checkpointID}`,
            })
          if (cp.epochMismatch)
            return yield* new CheckpointEpochError({
              sessionID: ctx.params.sessionID,
              checkpointID: ctx.params.checkpointID,
              expected: cp.epoch,
              actual: yield* snapshot.epoch(),
              message: `Checkpoint epoch mismatch: expected ${cp.epoch}, got current snapshot epoch`,
            })
          const mode = ctx.query.mode ?? "turn"
          const files = yield* checkpoint
            .diff({ sessionID: ctx.params.sessionID, checkpointID: cp.id, mode })
            .pipe(
              Effect.catchTag(["SessionCheckpoint.EpochMismatch"], (error) =>
                Effect.fail(
                  new CheckpointEpochError({
                    sessionID: ctx.params.sessionID,
                    checkpointID: ctx.params.checkpointID,
                    expected: error.expected,
                    actual: error.actual,
                    message: `Checkpoint epoch mismatch: expected ${error.expected}, got ${error.actual}`,
                  }),
                ),
              ),
            )
          return files.map((f) => f.patch ?? "").join("\n")
        }),
      )
      .handle(
        "session.checkpoint.revert",
        Effect.fn(function* (ctx) {
          const { checkpoint, snapshot } = yield* locationDeps
          const cp = yield* checkpoint.get({
            sessionID: ctx.params.sessionID,
            checkpointID: Checkpoint.ID.make(ctx.params.checkpointID),
          })
          if (!cp)
            return yield* new CheckpointNotFoundError({
              sessionID: ctx.params.sessionID,
              checkpointID: ctx.params.checkpointID,
              message: `Checkpoint not found: ${ctx.params.checkpointID}`,
            })
          if (cp.epochMismatch)
            return yield* new CheckpointEpochError({
              sessionID: ctx.params.sessionID,
              checkpointID: ctx.params.checkpointID,
              expected: cp.epoch,
              actual: yield* snapshot.epoch(),
              message: `Checkpoint epoch mismatch: expected ${cp.epoch}, got current snapshot epoch`,
            })
          if (!cp.afterSnapshot)
            return yield* new CheckpointUnsupportedError({
              sessionID: ctx.params.sessionID,
              reason: "checkpoint has no after-snapshot",
              message: `Checkpoint ${ctx.params.checkpointID} has no after-snapshot to revert to`,
            })
          // Capture a pre-revert undo point so the revert itself is reversible.
          const preRevertSnapshot = yield* snapshot.capture()
          const targetSnapshot = Snapshot.ID.make(cp.afterSnapshot)
          // The pre-revert row must not collide with the target's ordinal
          // (UNIQUE(session_id, ordinal)); place it past the current maximum so
          // the following removeAfter(ordinal: cp.ordinal) keeps it.
          const existing = yield* checkpoint.list({ sessionID: ctx.params.sessionID })
          const preRevertOrdinal = existing.length > 0 ? Math.max(...existing.map((c) => c.ordinal)) + 1 : 1
          yield* checkpoint.create({
            sessionID: ctx.params.sessionID,
            ordinal: preRevertOrdinal,
            kind: "pre-revert",
            beforeSnapshot: targetSnapshot,
            afterSnapshot: preRevertSnapshot ?? undefined,
          })
          // TODO: acquire per-worktree capture lock (CheckpointLifecycle.withCaptureLock) once available.
          yield* snapshot.checkout(targetSnapshot)
          yield* checkpoint.removeAfter({ sessionID: ctx.params.sessionID, ordinal: cp.ordinal })
          const info = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", () =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: ctx.params.sessionID,
                  message: `Session not found: ${ctx.params.sessionID}`,
                }),
              ),
            ),
          )
          yield* events.publish(
            CheckpointReverted,
            {
              sessionID: ctx.params.sessionID,
              checkpointID: ctx.params.checkpointID,
              ordinal: cp.ordinal,
              afterSnapshot: preRevertSnapshot ?? undefined,
            },
            { location: { directory: info.location.directory } },
          )
          const updated = yield* checkpoint.get({
            sessionID: ctx.params.sessionID,
            checkpointID: cp.id,
          })
          return updated ? toCheckpointInfo(updated) : toCheckpointInfo(cp)
        }),
      )
      .handle(
        "session.checkpoint.create",
        Effect.fn(function* (ctx) {
          const { checkpoint, snapshot } = yield* locationDeps
          const info = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", () =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: ctx.params.sessionID,
                  message: `Session not found: ${ctx.params.sessionID}`,
                }),
              ),
            ),
          )
          const beforeSnapshot = yield* snapshot.capture()
          const existing = yield* checkpoint.list({ sessionID: ctx.params.sessionID })
          const ordinal = existing.length > 0 ? Math.max(...existing.map((c) => c.ordinal)) + 1 : 1
          const epoch = yield* snapshot.epoch().pipe(Effect.orDie)
          const cp = yield* checkpoint.create({
            sessionID: ctx.params.sessionID,
            ordinal,
            kind: "manual",
            beforeSnapshot: beforeSnapshot ?? null,
            afterSnapshot: beforeSnapshot ?? undefined,
            epoch,
          }).pipe(
            Effect.mapError((error) =>
              new CheckpointUnsupportedError({
                sessionID: ctx.params.sessionID,
                reason: "checkpoint creation failed",
                message: error.message,
              }),
            ),
          )
          return toCheckpointInfo(cp)
        }),
      )
  }),
)
