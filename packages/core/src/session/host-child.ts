export * as SessionHostChild from "./host-child"

import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { InstallationVersion } from "../installation/version"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { SessionV1 } from "../v1/session"
import { Slug } from "../util/slug"
import { SessionProjector } from "./projector"
import { SessionSchema } from "./schema"
import { fromRow } from "./info"
import { SessionTable } from "./sql"
import { AbsolutePath } from "../schema"

export class ParentNotFoundError extends Error {
  readonly _tag = "SessionHostChild.ParentNotFoundError"
  constructor(readonly parentSessionID: SessionSchema.ID) {
    super(`Parent Session not found: ${parentSessionID}`)
  }
}

export interface EnsureInput {
  readonly id: SessionSchema.ID
  readonly parentSessionID: SessionSchema.ID
  readonly title: string
  readonly model?: ModelV2.Ref
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface Interface {
  /**
   * Idempotently provision one host-owned child Session using the parent's
   * durable project/location identity. This is Tier-1 metadata work: it never
   * materializes a workspace runtime merely to create the relationship row.
   */
  readonly ensure: (input: EnsureInput) => Effect.Effect<SessionSchema.Info, ParentNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/SessionHostChild") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const { db, readDb } = database

    const ensure = Effect.fn("SessionHostChild.ensure")(function* (input: EnsureInput) {
      const existing = yield* readDb
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (existing) return fromRow(existing)

      const parent = yield* readDb
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.parentSessionID))
        .get()
        .pipe(Effect.orDie)
      if (!parent) return yield* Effect.fail(new ParentNotFoundError(input.parentSessionID))
      const now = Date.now()
      const info = SessionV1.SessionInfo.make({
        id: input.id,
        slug: Slug.create(),
        projectID: parent.project_id,
        workspaceID: parent.workspace_id ?? undefined,
        directory: parent.directory,
        path: parent.path ?? undefined,
        parentID: input.parentSessionID,
        title: input.title,
        model: input.model
          ? { id: input.model.id, providerID: input.model.providerID, variant: input.model.variant }
          : undefined,
        version: InstallationVersion,
        metadata: input.metadata ? { ...input.metadata } : undefined,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      })
      const location = Location.Ref.make({
        directory: AbsolutePath.make(parent.directory),
        ...(parent.workspace_id ? { workspaceID: parent.workspace_id } : {}),
      })
      const projected = yield* events
        .publish(SessionV1.Event.Created, { sessionID: input.id, info }, { location })
        .pipe(
          Effect.as("created" as const),
          Effect.catchDefect((defect) =>
            defect instanceof SessionProjector.SessionAlreadyProjected ? Effect.succeed("existing" as const) : Effect.die(defect),
          ),
        )
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, input.id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(`Host child Session projection missing after ${projected}: ${input.id}`)
      return fromRow(row)
    })

    return Service.of({ ensure })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionProjector.node],
})
