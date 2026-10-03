export * as ProviderRouteHealth from "./provider-route-health"

import { and, eq, lte, ne, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import type { ProviderAccountPolicy } from "./provider-account-policy"
import type { ProviderRouteResolution } from "./provider-route-resolution"
import {
  ProviderAccountRouteHealthTable,
  ProviderPublicRouteHealthTable,
} from "./provider-route-health.sql"

export const UNKNOWN_EXPIRY_TTL_MS = 60_000
export const MAX_EPHEMERAL_HEALTH_ENTRIES = 256
const UNHEALTHY_RANK = 1_000_000

export type AccountState = "ready" | "auth-invalid" | "cooling-down" | "quota-exhausted"
export type PublicState = "ready" | "cooling-down" | "quota-exhausted"
export type RouteEffect =
  | "account-auth-invalid"
  | "account-cooldown"
  | "account-quota-exhausted"
  | "public-quota-exhausted"

export interface AccountAssessment {
  readonly admissible: boolean
  readonly healthRank: number
  readonly state: AccountState
  readonly ineligibleReason?: ProviderAccountPolicy.IneligibilityReason
  readonly resetAt?: number
}

export interface PublicAssessment {
  readonly available: boolean
  readonly state: PublicState
  readonly resetAt?: number
}

export interface AssessAccountInput {
  readonly providerID: string
  readonly accountID: string
  readonly modelID: string
  readonly credentialRevision: number
  readonly now?: number
}

export interface AssessPublicInput {
  readonly providerID: string
  readonly modelID: string
  readonly now?: number
}

export interface ObserveFailureInput {
  readonly lease: ProviderRouteResolution.ProviderRouteLease
  readonly modelID: string
  readonly effect: RouteEffect
  /**
   * Absolute trustworthy reset timestamp. Cooldown/quota with no future reset
   * remains process-local and is never written durably.
   */
  readonly resetAt?: number
  readonly now?: number
}

export interface ObserveSuccessInput {
  readonly lease: ProviderRouteResolution.ProviderRouteLease
  readonly modelID: string
  readonly now?: number
}

export class InvalidHealthInputError extends Schema.TaggedErrorClass<InvalidHealthInputError>()(
  "ProviderRouteHealth.InvalidHealthInputError",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export interface Interface {
  readonly assessAccount: (
    input: AssessAccountInput,
  ) => Effect.Effect<AccountAssessment, InvalidHealthInputError>
  readonly assessPublic: (
    input: AssessPublicInput,
  ) => Effect.Effect<PublicAssessment, InvalidHealthInputError>
  readonly observeFailure: (
    input: ObserveFailureInput,
  ) => Effect.Effect<void, InvalidHealthInputError>
  readonly observeSuccess: (
    input: ObserveSuccessInput,
  ) => Effect.Effect<void, InvalidHealthInputError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ProviderRouteHealth") {}

type EphemeralState = "cooling-down" | "quota-exhausted"
type Ephemeral = {
  readonly state: EphemeralState
  readonly observedAt: number
  readonly expiresAt: number
}

type ActiveAccount = {
  readonly state: Exclude<AccountState, "ready">
  readonly observedAt: number
  readonly resetAt?: number
}

type ActivePublic = {
  readonly state: Exclude<PublicState, "ready">
  readonly observedAt: number
  readonly resetAt: number
}

function invalid(field: string, message: string) {
  return new InvalidHealthInputError({ field, message })
}

function canonical(field: string, value: string): Effect.Effect<string, InvalidHealthInputError> {
  const next = value.trim()
  if (!next) return Effect.fail(invalid(field, "must be non-empty"))
  if (next !== value) return Effect.fail(invalid(field, "must already be canonical"))
  return Effect.succeed(next)
}

function timestamp(
  field: string,
  value: number,
): Effect.Effect<number, InvalidHealthInputError> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return Effect.fail(invalid(field, "must be a non-negative safe integer"))
  }
  return Effect.succeed(value)
}

function revision(value: number): Effect.Effect<number, InvalidHealthInputError> {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return Effect.fail(invalid("credentialRevision", "must be a positive safe integer"))
  }
  return Effect.succeed(value)
}

function accountKey(providerID: string, accountID: string, modelID: string) {
  return JSON.stringify(["account", providerID, accountID, modelID])
}

function publicKey(providerID: string, modelID: string) {
  return JSON.stringify(["public", providerID, modelID])
}

function stateReason(
  state: Exclude<AccountState, "ready">,
): ProviderAccountPolicy.IneligibilityReason {
  if (state === "auth-invalid") return "auth-invalid"
  if (state === "cooling-down") return "cooldown"
  return "quota-exhausted"
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const ephemeral = new Map<string, Ephemeral>()

    const pruneMemory = (now: number) => {
      for (const [key, value] of ephemeral) {
        if (value.expiresAt <= now) ephemeral.delete(key)
      }
    }

    const setMemory = (key: string, value: Ephemeral) => {
      pruneMemory(value.observedAt)
      if (!ephemeral.has(key) && ephemeral.size >= MAX_EPHEMERAL_HEALTH_ENTRIES) {
        let oldestKey: string | undefined
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [candidateKey, candidate] of ephemeral) {
          if (candidate.observedAt < oldestAt) {
            oldestAt = candidate.observedAt
            oldestKey = candidateKey
          }
        }
        if (oldestKey) ephemeral.delete(oldestKey)
      }
      ephemeral.set(key, value)
    }

    const memory = (key: string, now: number) => {
      const value = ephemeral.get(key)
      if (!value) return undefined
      if (value.expiresAt <= now) {
        ephemeral.delete(key)
        return undefined
      }
      return value
    }

    const clearMemoryThrough = (key: string, observedAt: number) => {
      const value = ephemeral.get(key)
      if (value && value.observedAt <= observedAt) ephemeral.delete(key)
    }

    const assessAccount: Interface["assessAccount"] = Effect.fn(
      "ProviderRouteHealth.assessAccount",
    )(function* (input) {
      const providerID = yield* canonical("providerID", input.providerID)
      const accountID = yield* canonical("accountID", input.accountID)
      const modelID = yield* canonical("modelID", input.modelID)
      const credentialRevision = yield* revision(input.credentialRevision)
      const now = yield* timestamp("now", input.now ?? Date.now())

      const row = yield* readDb
        .select()
        .from(ProviderAccountRouteHealthTable)
        .where(
          and(
            eq(ProviderAccountRouteHealthTable.provider_id, providerID),
            eq(ProviderAccountRouteHealthTable.account_id, accountID),
            eq(ProviderAccountRouteHealthTable.model_id, modelID),
          ),
        )
        .get()
        .pipe(Effect.orDie)

      let durable: ActiveAccount | undefined
      if (row?.state === "auth-invalid") {
        if (row.credential_revision === credentialRevision) {
          durable = { state: "auth-invalid", observedAt: row.observed_at }
        }
      } else if (
        row &&
        row.expires_at !== null &&
        row.expires_at > now
      ) {
        durable = {
          state: row.state,
          observedAt: row.observed_at,
          resetAt: row.expires_at,
        }
      }

      const local = memory(accountKey(providerID, accountID, modelID), now)
      const active: ActiveAccount | undefined =
        local && (!durable || local.observedAt >= durable.observedAt)
          ? {
              state: local.state,
              observedAt: local.observedAt,
              resetAt: local.expiresAt,
            }
          : durable

      if (!active) {
        return {
          admissible: true,
          healthRank: 0,
          state: "ready",
        }
      }

      return {
        admissible: false,
        healthRank: UNHEALTHY_RANK,
        state: active.state,
        ineligibleReason: stateReason(active.state),
        ...(active.resetAt === undefined ? {} : { resetAt: active.resetAt }),
      }
    })

    const assessPublic: Interface["assessPublic"] = Effect.fn(
      "ProviderRouteHealth.assessPublic",
    )(function* (input) {
      const providerID = yield* canonical("providerID", input.providerID)
      const modelID = yield* canonical("modelID", input.modelID)
      const now = yield* timestamp("now", input.now ?? Date.now())

      const row = yield* readDb
        .select()
        .from(ProviderPublicRouteHealthTable)
        .where(
          and(
            eq(ProviderPublicRouteHealthTable.provider_id, providerID),
            eq(ProviderPublicRouteHealthTable.model_id, modelID),
          ),
        )
        .get()
        .pipe(Effect.orDie)

      const durable: ActivePublic | undefined =
        row && row.expires_at > now
          ? {
              state: row.state,
              observedAt: row.observed_at,
              resetAt: row.expires_at,
            }
          : undefined
      const local = memory(publicKey(providerID, modelID), now)
      const active: ActivePublic | undefined =
        local && (!durable || local.observedAt >= durable.observedAt)
          ? {
              state: local.state,
              observedAt: local.observedAt,
              resetAt: local.expiresAt,
            }
          : durable

      return active
        ? {
            available: false,
            state: active.state,
            resetAt: active.resetAt,
          }
        : {
            available: true,
            state: "ready",
          }
    })

    const observeFailure: Interface["observeFailure"] = Effect.fn(
      "ProviderRouteHealth.observeFailure",
    )(function* (input) {
      const providerID = yield* canonical("providerID", input.lease.route.providerID)
      const modelID = yield* canonical("modelID", input.modelID)
      const now = yield* timestamp("now", input.now ?? Date.now())
      const resetAt =
        input.resetAt === undefined
          ? undefined
          : yield* timestamp("resetAt", input.resetAt)

      if (input.lease.route.kind === "public") {
        if (input.effect !== "public-quota-exhausted") {
          return yield* invalid(
            "effect",
            "public routes accept only public-quota-exhausted health effects",
          )
        }
        // A supplied reset that already elapsed is trustworthy evidence that
        // the route is no longer quarantined. Only an absent reset has unknown
        // lifetime and receives the bounded process-local fallback.
        if (resetAt !== undefined && resetAt <= now) return
        const key = publicKey(providerID, modelID)
        if (resetAt === undefined) {
          setMemory(key, {
            state: "quota-exhausted",
            observedAt: now,
            expiresAt: Math.min(Number.MAX_SAFE_INTEGER, now + UNKNOWN_EXPIRY_TTL_MS),
          })
          return
        }
        ephemeral.delete(key)
        yield* db
          .insert(ProviderPublicRouteHealthTable)
          .values({
            provider_id: providerID,
            model_id: modelID,
            state: "quota-exhausted",
            expires_at: resetAt,
            observed_at: now,
          })
          .onConflictDoUpdate({
            target: [
              ProviderPublicRouteHealthTable.provider_id,
              ProviderPublicRouteHealthTable.model_id,
            ],
            set: {
              state: "quota-exhausted",
              expires_at: resetAt,
              observed_at: now,
            },
          })
          .run()
          .pipe(Effect.orDie)
        return
      }

      if (input.effect === "public-quota-exhausted") {
        return yield* invalid(
          "effect",
          "account routes cannot mutate Public route health",
        )
      }

      const accountID = yield* canonical("accountID", input.lease.route.accountID)
      const credentialRevision = yield* revision(input.lease.route.credentialRevision)
      const key = accountKey(providerID, accountID, modelID)

      if (input.effect === "account-auth-invalid") {
        if (input.resetAt !== undefined) {
          return yield* invalid(
            "resetAt",
            "account-auth-invalid is credential-revision scoped, not expiry scoped",
          )
        }
        ephemeral.delete(key)
        yield* db
          .insert(ProviderAccountRouteHealthTable)
          .values({
            provider_id: providerID,
            account_id: accountID,
            model_id: modelID,
            state: "auth-invalid",
            credential_revision: credentialRevision,
            expires_at: null,
            observed_at: now,
          })
          .onConflictDoUpdate({
            target: [
              ProviderAccountRouteHealthTable.provider_id,
              ProviderAccountRouteHealthTable.account_id,
              ProviderAccountRouteHealthTable.model_id,
            ],
            set: {
              state: "auth-invalid",
              credential_revision: credentialRevision,
              expires_at: null,
              observed_at: now,
            },
          })
          .run()
          .pipe(Effect.orDie)
        return
      }

      const state: EphemeralState =
        input.effect === "account-cooldown" ? "cooling-down" : "quota-exhausted"
      if (resetAt !== undefined && resetAt <= now) return
      if (resetAt === undefined) {
        setMemory(key, {
          state,
          observedAt: now,
          expiresAt: Math.min(Number.MAX_SAFE_INTEGER, now + UNKNOWN_EXPIRY_TTL_MS),
        })
        return
      }

      ephemeral.delete(key)
      yield* db
        .insert(ProviderAccountRouteHealthTable)
        .values({
          provider_id: providerID,
          account_id: accountID,
          model_id: modelID,
          state,
          credential_revision: null,
          expires_at: resetAt,
          observed_at: now,
        })
        .onConflictDoUpdate({
          target: [
            ProviderAccountRouteHealthTable.provider_id,
            ProviderAccountRouteHealthTable.account_id,
            ProviderAccountRouteHealthTable.model_id,
          ],
          set: {
            state,
            credential_revision: null,
            expires_at: resetAt,
            observed_at: now,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const observeSuccess: Interface["observeSuccess"] = Effect.fn(
      "ProviderRouteHealth.observeSuccess",
    )(function* (input) {
      const providerID = yield* canonical("providerID", input.lease.route.providerID)
      const modelID = yield* canonical("modelID", input.modelID)
      const observedAt = yield* timestamp("now", input.now ?? Date.now())

      if (input.lease.route.kind === "public") {
        clearMemoryThrough(publicKey(providerID, modelID), observedAt)
        yield* db
          .delete(ProviderPublicRouteHealthTable)
          .where(
            and(
              eq(ProviderPublicRouteHealthTable.provider_id, providerID),
              eq(ProviderPublicRouteHealthTable.model_id, modelID),
              lte(ProviderPublicRouteHealthTable.observed_at, observedAt),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        return
      }

      const accountID = yield* canonical("accountID", input.lease.route.accountID)
      const credentialRevision = yield* revision(input.lease.route.credentialRevision)
      clearMemoryThrough(accountKey(providerID, accountID, modelID), observedAt)
      yield* db
        .delete(ProviderAccountRouteHealthTable)
        .where(
          and(
            eq(ProviderAccountRouteHealthTable.provider_id, providerID),
            eq(ProviderAccountRouteHealthTable.account_id, accountID),
            eq(ProviderAccountRouteHealthTable.model_id, modelID),
            lte(ProviderAccountRouteHealthTable.observed_at, observedAt),
            or(
              ne(ProviderAccountRouteHealthTable.state, "auth-invalid"),
              eq(ProviderAccountRouteHealthTable.credential_revision, credentialRevision),
            ),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    return Service.of({
      assessAccount,
      assessPublic,
      observeFailure,
      observeSuccess,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node],
})
