export * as SessionDelegationInspection from "./delegation-inspection"

import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, isNull, like, lt, or, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionGroup } from "@opencode-ai/schema/session-group"
import { SessionMetadataOwnership } from "./metadata-ownership"
import { SessionExecutionOwnerTable } from "./execution-owner.sql"
import { SessionGroupMemberTable, SessionGroupTable, SessionTable } from "./sql"
import { SessionSchema } from "./schema"

const MAX_WORKERS = 200
const MAX_BATCHES = 100

export interface WorkerRow {
  readonly id: SessionSchema.ID
  readonly title: string
  /** Internal-only native location. Adapters must authorize/project before egress. */
  readonly directory: string
  readonly workspaceID?: string
  readonly agent?: string
  readonly model?: {
    readonly providerID: string
    readonly modelID: string
    readonly accountID?: string
    readonly variant?: string
  }
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt?: number
  readonly origin?: SessionMetadataOwnership.WorkerDelegationOrigin
  readonly malformedOrigin: boolean
  readonly execution: {
    readonly generation: number
    readonly running: boolean
    readonly acquiredAt?: number
    readonly interruptRequestedAt?: number
  }
}

export interface WorkerCursor {
  readonly updatedAt: number
  readonly id: SessionSchema.ID
}

export interface BatchRow {
  readonly id: SessionGroup.ID
  readonly name: string
  readonly ownerRef?: string
  readonly memberIDs: readonly SessionSchema.ID[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt?: number
}

export interface Interface {
  readonly listWorkers: (input?: {
    readonly producer?: string
    readonly principalRef?: string
    readonly rootRef?: string
    readonly limit?: number
    readonly includeArchived?: boolean
    readonly before?: WorkerCursor
  }) => Effect.Effect<readonly WorkerRow[]>
  readonly getWorker: (id: SessionSchema.ID) => Effect.Effect<WorkerRow | undefined>
  readonly listBatches: (input?: {
    readonly limit?: number
    readonly ownerRef?: string
    readonly ownerRefPrefix?: string
  }) => Effect.Effect<readonly BatchRow[]>
  readonly getBatch: (id: SessionGroup.ID) => Effect.Effect<BatchRow | undefined>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/v2/SessionDelegationInspection",
) {}

function limit(input: number | undefined, max: number, fallback: number) {
  if (input === undefined || !Number.isFinite(input)) return fallback
  return Math.max(1, Math.min(max, Math.floor(input)))
}

function projectWorker(input: {
  readonly session: typeof SessionTable.$inferSelect
  readonly generation: number | null
  readonly ownerID: string | null
  readonly acquiredAt: number | null
  readonly interruptRequestedAt: number | null
}): WorkerRow {
  const row = input.session
  const metadata = row.metadata ?? undefined
  const protectedOrigin = SessionMetadataOwnership.hasWorkerDelegationOrigin(metadata)
  const origin = SessionMetadataOwnership.workerDelegation(metadata)
  return {
    id: SessionSchema.ID.make(row.id),
    title: row.title,
    directory: row.directory,
    ...(row.workspace_id ? { workspaceID: row.workspace_id } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.model
      ? {
          model: {
            providerID: row.model.providerID,
            modelID: row.model.id,
            ...(row.model.accountID ? { accountID: row.model.accountID } : {}),
            ...(row.model.variant ? { variant: row.model.variant } : {}),
          },
        }
      : {}),
    createdAt: row.time_created,
    updatedAt: row.time_updated,
    ...(row.time_archived ? { archivedAt: row.time_archived } : {}),
    ...(origin ? { origin } : {}),
    malformedOrigin: protectedOrigin && !origin,
    execution: {
      generation: input.generation ?? 0,
      running: input.ownerID !== null,
      ...(input.acquiredAt === null ? {} : { acquiredAt: input.acquiredAt }),
      ...(input.interruptRequestedAt === null
        ? {}
        : { interruptRequestedAt: input.interruptRequestedAt }),
    },
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { readDb } = yield* Database.Service

    const getWorker = Effect.fn("SessionDelegationInspection.getWorker")(
      function* (id: SessionSchema.ID) {
        const row = yield* readDb
          .select({
            session: SessionTable,
            generation: SessionExecutionOwnerTable.generation,
            ownerID: SessionExecutionOwnerTable.owner_id,
            acquiredAt: SessionExecutionOwnerTable.acquired_at,
            interruptRequestedAt:
              SessionExecutionOwnerTable.interrupt_requested_at,
          })
          .from(SessionTable)
          .leftJoin(
            SessionExecutionOwnerTable,
            eq(SessionExecutionOwnerTable.session_id, SessionTable.id),
          )
          .where(eq(SessionTable.id, id))
          .get()
          .pipe(Effect.orDie)
        if (
          !row ||
          !SessionMetadataOwnership.hasWorkerDelegationOrigin(
            row.session.metadata ?? undefined,
          )
        )
          return
        return projectWorker(row)
      },
    )

    const listWorkers = Effect.fn("SessionDelegationInspection.listWorkers")(
      function* (
        input: {
          readonly producer?: string
          readonly principalRef?: string
          readonly rootRef?: string
          readonly limit?: number
          readonly includeArchived?: boolean
          readonly before?: WorkerCursor
        } = {},
      ) {
        const conditions = [
          sql`json_type(${SessionTable.metadata}, '$.workerDelegation') IS NOT NULL`,
        ]
        if (input.producer) {
          conditions.push(
            sql`json_extract(${SessionTable.metadata}, '$.workerDelegation.producer') = ${input.producer}`,
          )
        }
        if (input.principalRef) {
          conditions.push(
            sql`json_extract(${SessionTable.metadata}, '$.workerDelegation.principalRef') = ${input.principalRef}`,
          )
        }
        if (input.rootRef) {
          conditions.push(
            sql`json_extract(${SessionTable.metadata}, '$.workerDelegation.rootRef') = ${input.rootRef}`,
          )
        }
        if (!input.includeArchived) conditions.push(isNull(SessionTable.time_archived))
        if (input.before) {
          conditions.push(
            or(
              lt(SessionTable.time_updated, input.before.updatedAt),
              and(
                eq(SessionTable.time_updated, input.before.updatedAt),
                lt(SessionTable.id, input.before.id),
              ),
            )!,
          )
        }
        const rows = yield* readDb
          .select({
            session: SessionTable,
            generation: SessionExecutionOwnerTable.generation,
            ownerID: SessionExecutionOwnerTable.owner_id,
            acquiredAt: SessionExecutionOwnerTable.acquired_at,
            interruptRequestedAt:
              SessionExecutionOwnerTable.interrupt_requested_at,
          })
          .from(SessionTable)
          .leftJoin(
            SessionExecutionOwnerTable,
            eq(SessionExecutionOwnerTable.session_id, SessionTable.id),
          )
          .where(and(...conditions))
          .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
          .limit(limit(input.limit, MAX_WORKERS, 50))
          .all()
          .pipe(Effect.orDie)
        return rows.map(projectWorker)
      },
    )

    const batch = Effect.fnUntraced(function* (
      row: typeof SessionGroupTable.$inferSelect,
    ) {
      const members = yield* readDb
        .select({ sessionID: SessionGroupMemberTable.session_id })
        .from(SessionGroupMemberTable)
        .where(eq(SessionGroupMemberTable.group_id, row.id))
        .orderBy(asc(SessionGroupMemberTable.position), asc(SessionGroupMemberTable.time_added))
        .all()
        .pipe(Effect.orDie)
      return {
        id: SessionGroup.ID.make(row.id),
        name: row.name,
        ...(row.owner_ref ? { ownerRef: row.owner_ref } : {}),
        memberIDs: members.map((item) => SessionSchema.ID.make(item.sessionID)),
        createdAt: row.time_created,
        updatedAt: row.time_updated,
        ...(row.time_archived ? { archivedAt: row.time_archived } : {}),
      } satisfies BatchRow
    })

    const getBatch = Effect.fn("SessionDelegationInspection.getBatch")(
      function* (id: SessionGroup.ID) {
        const row = yield* readDb
          .select()
          .from(SessionGroupTable)
          .where(
            and(
              eq(SessionGroupTable.id, id),
              eq(SessionGroupTable.kind, "delegation"),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        return row ? yield* batch(row) : undefined
      },
    )

    const listBatches = Effect.fn("SessionDelegationInspection.listBatches")(
      function* (
        input: {
          readonly limit?: number
          readonly ownerRef?: string
          readonly ownerRefPrefix?: string
        } = {},
      ) {
        const conditions = [eq(SessionGroupTable.kind, "delegation")]
        if (input.ownerRef)
          conditions.push(eq(SessionGroupTable.owner_ref, input.ownerRef))
        if (input.ownerRefPrefix)
          conditions.push(
            like(
              SessionGroupTable.owner_ref,
              input.ownerRefPrefix.replaceAll("%", "\%").replaceAll("_", "\_") +
                "%",
            ),
          )
        const where = and(...conditions)
        const rows = yield* readDb
          .select()
          .from(SessionGroupTable)
          .where(where)
          .orderBy(desc(SessionGroupTable.time_updated), desc(SessionGroupTable.id))
          .limit(limit(input.limit, MAX_BATCHES, 50))
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, batch)
      },
    )

    return Service.of({ listWorkers, getWorker, listBatches, getBatch })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node],
})
