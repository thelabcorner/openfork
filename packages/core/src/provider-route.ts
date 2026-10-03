export * as ProviderRoute from "./provider-route"

import { and, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { ProviderAccountPolicy } from "./provider-account-policy"
import type { SessionSchema } from "./session/schema"
import { SessionTable } from "./session/sql"
import {
  ProviderRouteAccountStatsTable,
  ProviderRouteBindingTable,
  ProviderRoutePolicyCursorTable,
} from "./provider-route.sql"

export const RouteKind = Schema.Literals(["public", "account"])
export type RouteKind = typeof RouteKind.Type

export const RoutingMode = Schema.Literals(["concentrate", "session-round-robin"])
export type RoutingMode = typeof RoutingMode.Type

export const Pin = Schema.Literals(["hard", "soft"])
export type Pin = typeof Pin.Type

export const AssignmentReason = Schema.Literals(["explicit", "initial", "failover", "model-selection"])
export type AssignmentReason = typeof AssignmentReason.Type

export type Route =
  | {
      readonly kind: "public"
      readonly providerID: string
    }
  | {
      readonly kind: "account"
      readonly providerID: string
      readonly accountID: string
      readonly credentialHandle: string
      readonly mode?: RoutingMode
      readonly pin?: Pin
    }

interface BindingBase {
  readonly sessionID: SessionSchema.ID
  readonly affinityDomain: string
  readonly providerID: string
  readonly routeRevision: number
  readonly assignedAt: number
  readonly assignmentEpoch: number
  readonly reason: AssignmentReason
}

export type Binding =
  | (BindingBase & {
      readonly routeKind: "public"
    })
  | (BindingBase & {
      readonly routeKind: "account"
      readonly accountID: string
      readonly credentialHandle: string
      readonly mode?: RoutingMode
      readonly pin?: Pin
    })

export interface BindInput {
  readonly sessionID: SessionSchema.ID
  readonly affinityDomain: string
  readonly route: Route
  readonly assignmentEpoch: number
  readonly reason: AssignmentReason
  readonly assignedAt?: number
}

export interface RebindInput extends BindInput {
  readonly expectedRevision: number
}

export type AccountBinding = Extract<Binding, { readonly routeKind: "account" }>

interface AccountCommitBaseInput {
  readonly sessionID: SessionSchema.ID
  readonly providerID: string
  readonly affinityDomain: string
  readonly mode: RoutingMode
  readonly candidates: readonly ProviderAccountPolicy.Candidate[]
  readonly excludedCredentialHandles: ReadonlySet<string>
  readonly now?: number
}

export type AccountCommitInput =
  | (AccountCommitBaseInput & {
      readonly reason: "initial"
    })
  | (AccountCommitBaseInput & {
      readonly reason: "failover"
      readonly current: AccountBinding
    })

export type AccountCommitResult =
  | { readonly state: "committed"; readonly binding: AccountBinding }
  | { readonly state: "winner"; readonly binding: Binding }
  | { readonly state: "no-eligible" }
  | { readonly state: "stale" }

export class InvalidBindingError extends Schema.TaggedErrorClass<InvalidBindingError>()(
  "ProviderRoute.InvalidBindingError",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export interface Interface {
  /** Indexed O(1)-shape lookup of the committed route for one Session/domain. */
  readonly get: (sessionID: SessionSchema.ID, affinityDomain: string) => Effect.Effect<Binding | undefined>
  /**
   * Commit an initial binding without replacing an existing one. Concurrent
   * creators all observe the one row that won the composite-key race.
   */
  readonly bindIfAbsent: (input: BindInput) => Effect.Effect<Binding, InvalidBindingError>
  /**
   * Rebind only if expectedRevision still owns the committed row. Success
   * increments routeRevision by exactly one; stale owners receive undefined.
   */
  readonly compareAndSwap: (input: RebindInput) => Effect.Effect<Binding | undefined, InvalidBindingError>
  /**
   * Atomically run P5A-P1 against durable policy state and commit the resulting
   * account route. No network/config/credential work occurs in this transaction.
   */
  readonly commitAccountSelection: (
    input: AccountCommitInput,
  ) => Effect.Effect<AccountCommitResult, InvalidBindingError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ProviderRoute") {}

type Prepared = {
  readonly sessionID: SessionSchema.ID
  readonly affinityDomain: string
  readonly providerID: string
  readonly routeKind: RouteKind
  readonly accountID: string | null
  readonly credentialHandle: string | null
  readonly mode: RoutingMode | null
  readonly pin: Pin | null
  readonly assignedAt: number
  readonly assignmentEpoch: number
  readonly reason: AssignmentReason
}

function invalid(field: string, message: string) {
  return new InvalidBindingError({ field, message })
}

function canonical(value: string) {
  const result = value.trim()
  return result.length > 0 ? result : undefined
}

function prepare(input: BindInput): Effect.Effect<Prepared, InvalidBindingError> {
  return Effect.gen(function* () {
    const affinityDomain = canonical(input.affinityDomain)
    if (!affinityDomain) return yield* invalid("affinityDomain", "must be non-empty")

    const providerID = canonical(input.route.providerID)
    if (!providerID) return yield* invalid("providerID", "must be non-empty")

    if (!Number.isSafeInteger(input.assignmentEpoch) || input.assignmentEpoch <= 0) {
      return yield* invalid("assignmentEpoch", "must be a positive safe integer")
    }

    const assignedAt = input.assignedAt ?? Date.now()
    if (!Number.isSafeInteger(assignedAt) || assignedAt < 0) {
      return yield* invalid("assignedAt", "must be a non-negative safe integer")
    }

    if (input.route.kind === "public") {
      return {
        sessionID: input.sessionID,
        affinityDomain,
        providerID,
        routeKind: "public",
        accountID: null,
        credentialHandle: null,
        mode: null,
        pin: null,
        assignedAt,
        assignmentEpoch: input.assignmentEpoch,
        reason: input.reason,
      }
    }

    const accountID = canonical(input.route.accountID)
    if (!accountID) return yield* invalid("accountID", "must be non-empty for an account route")
    const credentialHandle = canonical(input.route.credentialHandle)
    if (!credentialHandle) {
      return yield* invalid("credentialHandle", "must be non-empty for an account route")
    }

    return {
      sessionID: input.sessionID,
      affinityDomain,
      providerID,
      routeKind: "account",
      accountID,
      credentialHandle,
      mode: input.route.mode ?? null,
      pin: input.route.pin ?? null,
      assignedAt,
      assignmentEpoch: input.assignmentEpoch,
      reason: input.reason,
    }
  })
}

function binding(row: typeof ProviderRouteBindingTable.$inferSelect): Binding {
  const base: BindingBase = {
    sessionID: row.session_id,
    affinityDomain: row.affinity_domain,
    providerID: row.provider_id,
    routeRevision: row.route_revision,
    assignedAt: row.assigned_at,
    assignmentEpoch: row.assignment_epoch,
    reason: row.reason,
  }
  if (row.route_kind === "public") return { ...base, routeKind: "public" }
  if (!row.account_id || !row.credential_handle) {
    throw new Error("Persisted account provider route is missing its account identity")
  }
  return {
    ...base,
    routeKind: "account",
    accountID: row.account_id,
    credentialHandle: row.credential_handle,
    ...(row.mode ? { mode: row.mode } : {}),
    ...(row.pin ? { pin: row.pin } : {}),
  }
}

function routeValues(prepared: Prepared) {
  return {
    provider_id: prepared.providerID,
    route_kind: prepared.routeKind,
    account_id: prepared.accountID,
    credential_handle: prepared.credentialHandle,
    mode: prepared.mode,
    pin: prepared.pin,
    assigned_at: prepared.assignedAt,
    assignment_epoch: prepared.assignmentEpoch,
    reason: prepared.reason,
  } satisfies Partial<typeof ProviderRouteBindingTable.$inferInsert>
}

function insertValues(prepared: Prepared) {
  return {
    session_id: prepared.sessionID,
    affinity_domain: prepared.affinityDomain,
    ...routeValues(prepared),
  } satisfies typeof ProviderRouteBindingTable.$inferInsert
}

function sameAccountOwner(binding: Binding, current: AccountBinding) {
  return (
    binding.routeKind === "account" &&
    binding.sessionID === current.sessionID &&
    binding.affinityDomain === current.affinityDomain &&
    binding.providerID === current.providerID &&
    binding.routeRevision === current.routeRevision &&
    binding.accountID === current.accountID &&
    binding.credentialHandle === current.credentialHandle &&
    binding.mode === current.mode &&
    binding.pin === current.pin
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service

    const get = Effect.fn("ProviderRoute.get")(function* (sessionID: SessionSchema.ID, affinityDomain: string) {
      const canonicalDomain = canonical(affinityDomain)
      if (!canonicalDomain) return undefined
      const row = yield* readDb
        .select()
        .from(ProviderRouteBindingTable)
        .where(
          and(
            eq(ProviderRouteBindingTable.session_id, sessionID),
            eq(ProviderRouteBindingTable.affinity_domain, canonicalDomain),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? binding(row) : undefined
    })

    const bindIfAbsent = Effect.fn("ProviderRoute.bindIfAbsent")(function* (input: BindInput) {
      const prepared = yield* prepare(input)
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const session = yield* tx
                .select({ id: SessionTable.id })
                .from(SessionTable)
                .where(eq(SessionTable.id, prepared.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!session) return yield* invalid("sessionID", "session does not exist")

              const inserted = yield* tx
                .insert(ProviderRouteBindingTable)
                .values(insertValues(prepared))
                .onConflictDoNothing()
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (inserted) return binding(inserted)

              const current = yield* tx
                .select()
                .from(ProviderRouteBindingTable)
                .where(
                  and(
                    eq(ProviderRouteBindingTable.session_id, prepared.sessionID),
                    eq(ProviderRouteBindingTable.affinity_domain, prepared.affinityDomain),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (!current) {
                return yield* Effect.die(
                  "Provider route insert lost the composite-key race but no committed winner is visible",
                )
              }
              return binding(current)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const compareAndSwap = Effect.fn("ProviderRoute.compareAndSwap")(function* (input: RebindInput) {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) {
        return yield* invalid("expectedRevision", "must be a positive safe integer")
      }
      const prepared = yield* prepare(input)
      const updated = yield* db
        .transaction(
          (tx) =>
            tx
              .update(ProviderRouteBindingTable)
              .set({
                ...routeValues(prepared),
                route_revision: sql`${ProviderRouteBindingTable.route_revision} + 1`,
              })
              .where(
                and(
                  eq(ProviderRouteBindingTable.session_id, prepared.sessionID),
                  eq(ProviderRouteBindingTable.affinity_domain, prepared.affinityDomain),
                  eq(ProviderRouteBindingTable.route_revision, input.expectedRevision),
                ),
              )
              .returning()
              .get()
              .pipe(Effect.orDie),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      return updated ? binding(updated) : undefined
    })

    const commitAccountSelection: Interface["commitAccountSelection"] = Effect.fn(
      "ProviderRoute.commitAccountSelection",
    )(function* (input) {
      const providerID = canonical(input.providerID)
      if (!providerID) return yield* invalid("providerID", "must be non-empty")
      if (providerID !== input.providerID) {
        return yield* invalid("providerID", "must already be canonical")
      }
      const affinityDomain = canonical(input.affinityDomain)
      if (!affinityDomain) return yield* invalid("affinityDomain", "must be non-empty")
      if (affinityDomain !== input.affinityDomain) {
        return yield* invalid("affinityDomain", "must already be canonical")
      }
      if (input.mode !== "concentrate" && input.mode !== "session-round-robin") {
        return yield* invalid("mode", "must be a supported routing mode")
      }
      const now = input.now ?? Date.now()
      if (!Number.isSafeInteger(now) || now < 0) {
        return yield* invalid("now", "must be a non-negative safe integer")
      }

      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const session = yield* tx
                .select({ id: SessionTable.id })
                .from(SessionTable)
                .where(eq(SessionTable.id, input.sessionID))
                .get()
                .pipe(Effect.orDie)
              if (!session) return yield* invalid("sessionID", "session does not exist")

              const currentRow = yield* tx
                .select()
                .from(ProviderRouteBindingTable)
                .where(
                  and(
                    eq(ProviderRouteBindingTable.session_id, input.sessionID),
                    eq(ProviderRouteBindingTable.affinity_domain, affinityDomain),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              const persistedCurrent = currentRow ? binding(currentRow) : undefined

              if (input.reason === "initial" && persistedCurrent) {
                return { state: "winner", binding: persistedCurrent } as const
              }

              let failoverCurrent: AccountBinding | undefined
              if (input.reason === "failover") {
                if (!persistedCurrent || !sameAccountOwner(persistedCurrent, input.current)) {
                  return { state: "stale" } as const
                }
                if (persistedCurrent.routeKind !== "account") {
                  return { state: "stale" } as const
                }
                if (persistedCurrent.pin === "hard") {
                  return yield* invalid("current.pin", "hard-pinned account routes cannot fail over")
                }
                if (persistedCurrent.providerID !== providerID) {
                  return { state: "stale" } as const
                }
                failoverCurrent = persistedCurrent
              }

              const cursorRow = yield* tx
                .select()
                .from(ProviderRoutePolicyCursorTable)
                .where(
                  and(
                    eq(ProviderRoutePolicyCursorTable.provider_id, providerID),
                    eq(ProviderRoutePolicyCursorTable.affinity_domain, affinityDomain),
                  ),
                )
                .get()
                .pipe(Effect.orDie)

              const accountIDs = [
                ...new Set(
                  input.candidates
                    .filter((candidate) => candidate.providerID === providerID)
                    .map((candidate) => candidate.accountID),
                ),
              ]

              const persistedStats =
                accountIDs.length === 0
                  ? []
                  : yield* tx
                      .select()
                      .from(ProviderRouteAccountStatsTable)
                      .where(
                        and(
                          eq(ProviderRouteAccountStatsTable.provider_id, providerID),
                          eq(ProviderRouteAccountStatsTable.affinity_domain, affinityDomain),
                          inArray(ProviderRouteAccountStatsTable.account_id, accountIDs),
                        ),
                      )
                      .all()
                      .pipe(Effect.orDie)

              const activeRows =
                accountIDs.length === 0
                  ? []
                  : yield* tx
                      .select({
                        accountID: ProviderRouteBindingTable.account_id,
                        count: sql<number>`count(*)`,
                      })
                      .from(ProviderRouteBindingTable)
                      .where(
                        and(
                          eq(ProviderRouteBindingTable.provider_id, providerID),
                          eq(ProviderRouteBindingTable.affinity_domain, affinityDomain),
                          eq(ProviderRouteBindingTable.route_kind, "account"),
                          inArray(ProviderRouteBindingTable.account_id, accountIDs),
                        ),
                      )
                      .groupBy(ProviderRouteBindingTable.account_id)
                      .all()
                      .pipe(Effect.orDie)

              const historicalByAccount = new Map(
                persistedStats.map((row) => [row.account_id, row] as const),
              )
              const activeByAccount = new Map(
                activeRows.flatMap((row) =>
                  row.accountID === null ? [] : ([[row.accountID, Number(row.count)]] as const),
                ),
              )

              // A failover replaces this Session's current route rather than
              // adding another binding. Discount that one row when considering
              // another credential handle for the same stable account identity.
              if (failoverCurrent) {
                const active = activeByAccount.get(failoverCurrent.accountID)
                if (active !== undefined) {
                  activeByAccount.set(failoverCurrent.accountID, Math.max(0, active - 1))
                }
              }

              const stats = new Map<string, ProviderAccountPolicy.CandidateStats>()
              for (const candidate of input.candidates) {
                if (candidate.providerID !== providerID) continue
                const historical = historicalByAccount.get(candidate.accountID)
                stats.set(candidate.credentialHandle, {
                  activeBindings: activeByAccount.get(candidate.accountID) ?? 0,
                  assignmentCount: historical?.assignment_count ?? 0,
                  ...(historical?.last_assigned_at === null || historical?.last_assigned_at === undefined
                    ? {}
                    : { lastAssignedAt: historical.last_assigned_at }),
                })
              }

              const selected = ProviderAccountPolicy.select({
                providerID,
                affinityDomain,
                mode: input.mode,
                candidates: input.candidates,
                stats,
                cursor: cursorRow
                  ? {
                      epoch: cursorRow.epoch,
                      ...(cursorRow.last_assigned_handle === null
                        ? {}
                        : { lastAssignedHandle: cursorRow.last_assigned_handle }),
                    }
                  : { epoch: 0 },
                excludedCredentialHandles: input.excludedCredentialHandles,
                ...(failoverCurrent
                  ? { afterCredentialHandle: failoverCurrent.credentialHandle }
                  : {}),
              })
              if (!selected.ok) {
                return yield* invalid(`policy.${selected.error.field}`, selected.error.message)
              }
              if (!selected.selection.selected) return { state: "no-eligible" } as const

              const assignmentEpoch = selected.selection.assignmentEpoch
              const nextCursor = selected.selection.nextCursor
              if (!assignmentEpoch || !nextCursor || nextCursor.epoch !== assignmentEpoch) {
                return yield* Effect.die("Provider account policy selected without one cursor transition")
              }

              const account = selected.selection.selected
              const selectedStats = stats.get(account.credentialHandle)
              if (selectedStats?.assignmentCount === Number.MAX_SAFE_INTEGER) {
                return yield* invalid(
                  "policy.assignmentCount",
                  "cannot advance beyond Number.MAX_SAFE_INTEGER",
                )
              }
              const prepared = yield* prepare({
                sessionID: input.sessionID,
                affinityDomain,
                route: {
                  kind: "account",
                  providerID,
                  accountID: account.accountID,
                  credentialHandle: account.credentialHandle,
                  mode: failoverCurrent?.mode ?? input.mode,
                  ...(failoverCurrent?.pin ? { pin: failoverCurrent.pin } : {}),
                },
                assignmentEpoch,
                reason: input.reason,
                assignedAt: now,
              })

              let committedRow: typeof ProviderRouteBindingTable.$inferSelect | undefined
              if (input.reason === "initial") {
                committedRow = yield* tx
                  .insert(ProviderRouteBindingTable)
                  .values(insertValues(prepared))
                  .onConflictDoNothing()
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
                if (!committedRow) {
                  const winner = yield* tx
                    .select()
                    .from(ProviderRouteBindingTable)
                    .where(
                      and(
                        eq(ProviderRouteBindingTable.session_id, input.sessionID),
                        eq(ProviderRouteBindingTable.affinity_domain, affinityDomain),
                      ),
                    )
                    .get()
                    .pipe(Effect.orDie)
                  if (!winner) {
                    return yield* Effect.die(
                      "Provider route policy insert lost the race without a committed winner",
                    )
                  }
                  return { state: "winner", binding: binding(winner) } as const
                }
              } else {
                committedRow = yield* tx
                  .update(ProviderRouteBindingTable)
                  .set({
                    ...routeValues(prepared),
                    route_revision: sql`${ProviderRouteBindingTable.route_revision} + 1`,
                  })
                  .where(
                    and(
                      eq(ProviderRouteBindingTable.session_id, input.sessionID),
                      eq(ProviderRouteBindingTable.affinity_domain, affinityDomain),
                      eq(ProviderRouteBindingTable.route_revision, input.current.routeRevision),
                      eq(ProviderRouteBindingTable.route_kind, "account"),
                      eq(ProviderRouteBindingTable.provider_id, providerID),
                      eq(ProviderRouteBindingTable.account_id, input.current.accountID),
                      eq(ProviderRouteBindingTable.credential_handle, input.current.credentialHandle),
                    ),
                  )
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
                if (!committedRow) return { state: "stale" } as const
              }

              const committed = binding(committedRow)
              if (committed.routeKind !== "account") {
                return yield* Effect.die("Account policy committed a non-account ProviderRoute")
              }

              yield* tx
                .insert(ProviderRoutePolicyCursorTable)
                .values({
                  provider_id: providerID,
                  affinity_domain: affinityDomain,
                  epoch: nextCursor.epoch,
                  last_assigned_handle: nextCursor.lastAssignedHandle ?? null,
                })
                .onConflictDoUpdate({
                  target: [
                    ProviderRoutePolicyCursorTable.provider_id,
                    ProviderRoutePolicyCursorTable.affinity_domain,
                  ],
                  set: {
                    epoch: nextCursor.epoch,
                    last_assigned_handle: nextCursor.lastAssignedHandle ?? null,
                  },
                })
                .run()
                .pipe(Effect.orDie)

              yield* tx
                .insert(ProviderRouteAccountStatsTable)
                .values({
                  provider_id: providerID,
                  affinity_domain: affinityDomain,
                  account_id: account.accountID,
                  assignment_count: 1,
                  last_assigned_at: now,
                })
                .onConflictDoUpdate({
                  target: [
                    ProviderRouteAccountStatsTable.provider_id,
                    ProviderRouteAccountStatsTable.affinity_domain,
                    ProviderRouteAccountStatsTable.account_id,
                  ],
                  set: {
                    assignment_count: sql`${ProviderRouteAccountStatsTable.assignment_count} + 1`,
                    last_assigned_at: now,
                  },
                })
                .run()
                .pipe(Effect.orDie)

              return { state: "committed", binding: committed } as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    return Service.of({ get, bindIfAbsent, compareAndSwap, commitAccountSelection })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
