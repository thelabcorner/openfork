export * as SessionExecutionBoundary from "./execution-boundary"

import { eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { SessionExecutionBoundaryTable } from "./execution-boundary.sql"
import { SessionV2 } from "../session"

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Permission.Boundary | undefined>
  readonly set: (
    sessionID: SessionSchema.ID,
    boundary: Permission.Boundary,
  ) => Effect.Effect<Permission.Boundary, SessionV2.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionExecutionBoundary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { readDb } = yield* Database.Service
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service

    const get = Effect.fn("SessionExecutionBoundary.get")(function* (sessionID: SessionSchema.ID) {
      const row = yield* readDb
        .select({ boundary: SessionExecutionBoundaryTable.boundary })
        .from(SessionExecutionBoundaryTable)
        .where(eq(SessionExecutionBoundaryTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row?.boundary
    })

    const set = Effect.fn("SessionExecutionBoundary.set")(function* (
      sessionID: SessionSchema.ID,
      boundary: Permission.Boundary,
    ) {
      if (!(yield* sessions.get(sessionID))) {
        return yield* new SessionV2.NotFoundError({ sessionID })
      }
      const timestamp = yield* DateTime.now
      yield* events.publish(SessionEvent.ExecutionBoundaryUpdated, { sessionID, timestamp, boundary })
      return boundary
    })

    return Service.of({ get, set })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionStore.node],
})
