import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import type { Session } from "@/session/session"
import { SessionV2 } from "@opencode-ai/core/session"
import type { SessionID } from "@/session/schema"
import { Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

/** Maps storage NotFoundError to the public V1 `SessionNotFoundError` (with the sessionID). */
export function mapStorageNotFoundSession<A, R>(sessionID: SessionID, self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(
    Effect.mapError((error) =>
      new ApiError.SessionNotFoundError({
        sessionID,
        message: error.message,
      }),
    ),
  )
}

/** Maps core `Session.NotFoundError` to the public V1 `SessionNotFoundError`. */
export function mapSessionNotFound<A, R>(self: Effect.Effect<A, SessionV2.NotFoundError, R>) {
  return self.pipe(
    Effect.catchTag("Session.NotFoundError", (error) =>
      Effect.fail(
        new ApiError.SessionNotFoundError({
          sessionID: error.sessionID,
          message: `Session not found: ${error.sessionID}`,
        }),
      ),
    ),
  )
}

export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
  )
}
