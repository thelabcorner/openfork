export * as OxpActivityInspection from "./inspection"

import { and, desc, eq, isNull, lt, or } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { OxpActivitySchema } from "./schema"
import {
  OxpInvocationLinkTable,
  OxpInvocationTable,
  OxpParentActivityTable,
} from "./sql"

const MAX_ACTIVITY_LIST = 100
const MAX_INVOCATIONS = 200
const MAX_RESOURCE_PROVENANCE = 50

export type ParentSummary = typeof OxpParentActivityTable.$inferSelect
export type Invocation = typeof OxpInvocationTable.$inferSelect
export type InvocationLink = typeof OxpInvocationLinkTable.$inferSelect
export interface ResourceProvenance {
  readonly activityID: OxpActivitySchema.ActivityID
  readonly invocationID: OxpActivitySchema.InvocationID
  readonly kind: OxpActivitySchema.LinkKind
  readonly ref: string
  readonly relation: string
  readonly label?: string
  readonly tool: string
  readonly action?: string
  readonly startedAt: number
}

export interface ParentListInput {
  readonly limit?: number
  readonly includeArchived?: boolean
  readonly before?: {
    readonly lastSeenAt: number
    readonly id: OxpActivitySchema.ActivityID
  }
}

export interface InvocationPage {
  readonly items: readonly Invocation[]
  readonly links: readonly InvocationLink[]
  readonly more: boolean
  readonly before?: {
    readonly startedAt: number
    readonly id: OxpActivitySchema.InvocationID
  }
}

function limit(
  value: number | undefined,
  fallback: number,
  maximum: number,
) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(maximum, Math.floor(value!)))
}

export interface Interface {
  readonly list: (
    input?: ParentListInput,
  ) => Effect.Effect<readonly ParentSummary[]>
  readonly get: (
    id: OxpActivitySchema.ActivityID,
  ) => Effect.Effect<ParentSummary | undefined>
  readonly invocations: (input: {
    readonly activityID: OxpActivitySchema.ActivityID
    readonly limit?: number
    readonly before?: {
      readonly startedAt: number
      readonly id: OxpActivitySchema.InvocationID
    }
  }) => Effect.Effect<InvocationPage>
  readonly resource: (input: {
    readonly kind: OxpActivitySchema.LinkKind
    readonly ref: string
    readonly limit?: number
  }) => Effect.Effect<readonly ResourceProvenance[]>
}

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/core/OxpActivityInspection",
) {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { readDb } = yield* Database.Service

    const list = Effect.fn("OxpActivityInspection.list")(function* (
      input: ParentListInput = {},
    ) {
      const conditions = []
      if (!input.includeArchived)
        conditions.push(isNull(OxpParentActivityTable.time_archived))
      if (input.before) {
        conditions.push(
          or(
            lt(
              OxpParentActivityTable.last_seen_at,
              input.before.lastSeenAt,
            ),
            and(
              eq(
                OxpParentActivityTable.last_seen_at,
                input.before.lastSeenAt,
              ),
              lt(OxpParentActivityTable.id, input.before.id),
            ),
          )!,
        )
      }
      return yield* readDb
        .select()
        .from(OxpParentActivityTable)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(
          desc(OxpParentActivityTable.last_seen_at),
          desc(OxpParentActivityTable.id),
        )
        .limit(limit(input.limit, 50, MAX_ACTIVITY_LIST))
        .all()
        .pipe(Effect.orDie)
    })

    const get = Effect.fn("OxpActivityInspection.get")(function* (
      id: OxpActivitySchema.ActivityID,
    ) {
      return yield* readDb
        .select()
        .from(OxpParentActivityTable)
        .where(eq(OxpParentActivityTable.id, id))
        .get()
        .pipe(Effect.orDie)
    })

    const invocations = Effect.fn("OxpActivityInspection.invocations")(
      function* (input: {
        readonly activityID: OxpActivitySchema.ActivityID
        readonly limit?: number
        readonly before?: {
          readonly startedAt: number
          readonly id: OxpActivitySchema.InvocationID
        }
      }) {
        const wanted = limit(input.limit, 50, MAX_INVOCATIONS)
        const conditions = [
          eq(OxpInvocationTable.activity_id, input.activityID),
        ]
        if (input.before) {
          conditions.push(
            or(
              lt(OxpInvocationTable.time_started, input.before.startedAt),
              and(
                eq(
                  OxpInvocationTable.time_started,
                  input.before.startedAt,
                ),
                lt(OxpInvocationTable.id, input.before.id),
              ),
            )!,
          )
        }
        const rows = yield* readDb
          .select()
          .from(OxpInvocationTable)
          .where(and(...conditions))
          .orderBy(
            desc(OxpInvocationTable.time_started),
            desc(OxpInvocationTable.id),
          )
          .limit(wanted + 1)
          .all()
          .pipe(Effect.orDie)
        const more = rows.length > wanted
        const items = more ? rows.slice(0, wanted) : rows
        const ids = items.map((row) => row.id)
        const links =
          ids.length === 0
            ? []
            : yield* readDb
                .select()
                .from(OxpInvocationLinkTable)
                .where(
                  // Avoid importing inArray into list hot path unless history is
                  // explicitly requested.
                  or(
                    ...ids.map((id) =>
                      eq(OxpInvocationLinkTable.invocation_id, id),
                    ),
                  )!,
                )
                .all()
                .pipe(Effect.orDie)
        const tail = items.at(-1)
        return {
          items,
          links,
          more,
          ...(more && tail
            ? {
                before: {
                  startedAt: tail.time_started,
                  id: tail.id,
                },
              }
            : {}),
        } satisfies InvocationPage
      },
    )

    const resource = Effect.fn("OxpActivityInspection.resource")(function* (input: {
      readonly kind: OxpActivitySchema.LinkKind
      readonly ref: string
      readonly limit?: number
    }) {
      const rows = yield* readDb
        .select({
          activityID: OxpInvocationTable.activity_id,
          invocationID: OxpInvocationTable.id,
          kind: OxpInvocationLinkTable.kind,
          ref: OxpInvocationLinkTable.ref,
          relation: OxpInvocationLinkTable.relation,
          label: OxpInvocationLinkTable.label,
          tool: OxpInvocationTable.tool,
          action: OxpInvocationTable.action,
          startedAt: OxpInvocationTable.time_started,
        })
        .from(OxpInvocationLinkTable)
        .innerJoin(
          OxpInvocationTable,
          eq(OxpInvocationLinkTable.invocation_id, OxpInvocationTable.id),
        )
        .where(
          and(
            eq(OxpInvocationLinkTable.kind, input.kind),
            eq(OxpInvocationLinkTable.ref, input.ref),
          ),
        )
        .orderBy(
          desc(OxpInvocationTable.time_started),
          desc(OxpInvocationTable.id),
        )
        .limit(limit(input.limit, 10, MAX_RESOURCE_PROVENANCE))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        activityID: row.activityID,
        invocationID: row.invocationID,
        kind: row.kind,
        ref: row.ref,
        relation: row.relation,
        ...(row.label ? { label: row.label } : {}),
        tool: row.tool,
        ...(row.action ? { action: row.action } : {}),
        startedAt: row.startedAt,
      }))
    })

    return Service.of({ list, get, invocations, resource })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node],
})

