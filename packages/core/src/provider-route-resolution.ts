export * as ProviderRouteResolution from "./provider-route-resolution"

import { Effect, Schema } from "effect"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { ProviderAccountPolicy } from "./provider-account-policy"
import { ProviderRoute } from "./provider-route"
import type { SessionSchema } from "./session/schema"

export const FreeRoutePreference = Schema.Literals(["account-first", "public-first-for-free"])
export type FreeRoutePreference = typeof FreeRoutePreference.Type

/**
 * Complete secret-free provider/account policy snapshot prepared before routing.
 *
 * Reuse P5A-P1's candidate contract so the future atomic durable commit can run
 * the pure policy without re-entering provider health, credential, or config I/O
 * while its SQLite transaction is open.
 */
export type AccountCandidate = ProviderAccountPolicy.Candidate

export type AccountRouteBinding = Extract<
  ProviderRoute.Binding,
  { readonly routeKind: "account" }
>

interface AccountCommitBaseInput {
  readonly sessionID: SessionSchema.ID
  readonly providerID: string
  readonly affinityDomain: string
  readonly mode: ProviderRoute.RoutingMode
  readonly candidates: readonly AccountCandidate[]
  readonly excludedCredentialHandles: ReadonlySet<string>
  readonly now?: number
}

export type AccountCommitInput =
  | (AccountCommitBaseInput & {
      readonly reason: "initial"
    })
  | (AccountCommitBaseInput & {
      readonly reason: "failover"
      readonly current: AccountRouteBinding
    })

export type AccountCommitResult =
  | {
      /**
       * This account selection won and its policy transition + route mutation
       * were committed atomically.
       */
      readonly state: "committed"
      readonly binding: AccountRouteBinding
    }
  | {
      /**
       * Initial-bind race only: another owner already committed this exact
       * durable route. The losing operation must not advance cursor/count state.
       */
      readonly state: "winner"
      readonly binding: ProviderRoute.Binding
    }
  /** No route or policy state was mutated. */
  | { readonly state: "no-eligible" }
  /** Failover CAS lost. No route or policy state was mutated. */
  | { readonly state: "stale" }

export interface ResolveCredentialInput {
  readonly providerID: string
  readonly accountID: string
  readonly credentialHandle: string
}

export interface ProviderRouteLease {
  readonly sessionID: SessionSchema.ID
  readonly affinityDomain: string
  readonly routeRevision: number
  readonly route:
    | {
        readonly kind: "public"
        readonly providerID: string
        readonly routeID: string
      }
    | {
        readonly kind: "account"
        readonly providerID: string
        readonly accountID: string
        readonly credentialHandle: string
        readonly credentialRevision: number
      }
}

export interface RouteAttribution {
  readonly sessionID: SessionSchema.ID
  readonly affinityDomain: string
  readonly providerID: string
  readonly routeRevision: number
  readonly routeKind: "public" | "account"
  readonly accountID?: string
}

export interface ClientRouteIdentity {
  readonly providerID: string
  readonly route:
    | { readonly kind: "public"; readonly routeID: string }
    | {
        readonly kind: "account"
        readonly credentialHandle: string
        readonly credentialRevision: number
      }
}

export interface Resolution {
  readonly lease: ProviderRouteLease
  readonly attribution: RouteAttribution
  /**
   * Secret-free route partition only. Provider adapters append protocol/config
   * identity before constructing SDK/language clients.
   */
  readonly clientRouteIdentity: ClientRouteIdentity
}

export interface ResolveInput {
  readonly sessionID: SessionSchema.ID
  readonly providerID: string
  readonly affinityDomain: string
  readonly routeIntent: ProviderRouteIntent.Info
  readonly mode: ProviderRoute.RoutingMode
  readonly freeRoutePreference: FreeRoutePreference
  readonly allowPublic: boolean
  readonly publicEligible: boolean
  readonly candidates: readonly AccountCandidate[]
  readonly now?: number
}

export interface Dependencies<CommitError = never, CredentialError = never> {
  readonly routes: ProviderRoute.Interface
  /**
   * Atomic provider-neutral account selection + route commit boundary.
   *
   * Candidate/config/health network work must finish before this hook. A durable
   * implementation re-reads policy state and route ownership inside one short
   * database transaction, applies the pure account policy, and commits both the
   * policy transition and route bind/CAS together. It returns the exact durable
   * binding observed after that transaction. The resolver never performs a
   * second account bind/CAS after this hook.
   */
  readonly commitAccountSelection: (
    input: AccountCommitInput,
  ) => Effect.Effect<AccountCommitResult, CommitError>
  /**
   * Exact-handle credential authority. Production adapters must implement this
   * through P2 CredentialResolver and return only its trusted revision here.
   */
  readonly resolveCredentialRevision: (
    input: ResolveCredentialInput,
  ) => Effect.Effect<number | undefined, CredentialError>
}

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()(
  "ProviderRouteResolution.InvalidInput",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export class ProviderMismatchError extends Schema.TaggedErrorClass<ProviderMismatchError>()(
  "ProviderRouteResolution.ProviderMismatch",
  {
    expectedProviderID: Schema.String,
    actualProviderID: Schema.String,
  },
) {}

export class PublicUnavailableError extends Schema.TaggedErrorClass<PublicUnavailableError>()(
  "ProviderRouteResolution.PublicUnavailable",
  {
    providerID: Schema.String,
  },
) {}

export class ExplicitAccountUnavailableError extends Schema.TaggedErrorClass<ExplicitAccountUnavailableError>()(
  "ProviderRouteResolution.ExplicitAccountUnavailable",
  {
    providerID: Schema.String,
    accountID: Schema.String,
  },
) {}

export class BoundRouteUnavailableError extends Schema.TaggedErrorClass<BoundRouteUnavailableError>()(
  "ProviderRouteResolution.BoundRouteUnavailable",
  {
    providerID: Schema.String,
    routeKind: Schema.Literals(["public", "account"]),
    accountID: Schema.optional(Schema.String),
    hardPin: Schema.Boolean,
  },
) {}

export class NoEligibleRouteError extends Schema.TaggedErrorClass<NoEligibleRouteError>()(
  "ProviderRouteResolution.NoEligibleRoute",
  {
    providerID: Schema.String,
  },
) {}

export class AmbiguousAccountError extends Schema.TaggedErrorClass<AmbiguousAccountError>()(
  "ProviderRouteResolution.AmbiguousAccount",
  {
    providerID: Schema.String,
    accountID: Schema.String,
  },
) {}

export class AccountCommitViolationError extends Schema.TaggedErrorClass<AccountCommitViolationError>()(
  "ProviderRouteResolution.AccountCommitViolation",
  {
    providerID: Schema.String,
    credentialHandle: Schema.optional(Schema.String),
    reason: Schema.Literals([
      "session-mismatch",
      "affinity-mismatch",
      "unknown-candidate",
      "provider-mismatch",
      "ineligible",
      "excluded",
      "unexpected-route-kind",
      "revision-mismatch",
      "metadata-mismatch",
      "unexpected-winner",
      "unexpected-stale",
    ]),
  },
) {}

export class CredentialUnavailableError extends Schema.TaggedErrorClass<CredentialUnavailableError>()(
  "ProviderRouteResolution.CredentialUnavailable",
  {
    providerID: Schema.String,
    accountID: Schema.String,
    credentialHandle: Schema.String,
  },
) {}

export class StaleRouteError extends Schema.TaggedErrorClass<StaleRouteError>()(
  "ProviderRouteResolution.StaleRoute",
  {
    providerID: Schema.String,
    affinityDomain: Schema.String,
    expectedRevision: Schema.Number,
  },
) {}

export type Error =
  | InvalidInputError
  | ProviderMismatchError
  | PublicUnavailableError
  | ExplicitAccountUnavailableError
  | BoundRouteUnavailableError
  | NoEligibleRouteError
  | AmbiguousAccountError
  | AccountCommitViolationError
  | CredentialUnavailableError
  | StaleRouteError
  | ProviderRoute.InvalidBindingError

function canonical(value: string) {
  const result = value.trim()
  return result.length > 0 ? result : undefined
}

function invalid(field: string, message: string) {
  return new InvalidInputError({ field, message })
}

function publicRoute(providerID: string): ProviderRoute.Route {
  return { kind: "public", providerID }
}

function accountRoute(
  providerID: string,
  candidate: AccountCandidate,
  mode: ProviderRoute.RoutingMode,
  pin?: ProviderRoute.Pin,
): ProviderRoute.Route {
  return {
    kind: "account",
    providerID,
    accountID: candidate.accountID,
    credentialHandle: candidate.credentialHandle,
    mode,
    ...(pin ? { pin } : {}),
  }
}

function sameRoute(binding: ProviderRoute.Binding, route: ProviderRoute.Route) {
  if (binding.providerID !== route.providerID) return false
  if (binding.routeKind !== route.kind) return false
  if (route.kind === "public") return true
  if (binding.routeKind !== "account") return false
  return (
    binding.accountID === route.accountID &&
    binding.credentialHandle === route.credentialHandle &&
    binding.mode === route.mode &&
    binding.pin === route.pin
  )
}

function candidateKey(candidate: AccountCandidate) {
  return `${candidate.providerID}\0${candidate.accountID}\0${candidate.credentialHandle}`
}

function safeCandidate(candidate: AccountCandidate): AccountCandidate {
  return {
    providerID: candidate.providerID,
    accountID: candidate.accountID,
    credentialHandle: candidate.credentialHandle,
    admissible: candidate.admissible,
    healthRank: candidate.healthRank,
    ...(candidate.ineligibleReason === undefined
      ? {}
      : { ineligibleReason: candidate.ineligibleReason }),
    ...(candidate.usedPercent === undefined
      ? {}
      : { usedPercent: candidate.usedPercent }),
    ...(candidate.resetAt === undefined ? {} : { resetAt: candidate.resetAt }),
    ...(candidate.maxSessionBindings === undefined
      ? {}
      : { maxSessionBindings: candidate.maxSessionBindings }),
  }
}

function policyCandidates(input: ResolveInput) {
  return input.candidates
    .filter((candidate) => candidate.providerID === input.providerID)
    .map(safeCandidate)
}

function eligibleCandidates(input: ResolveInput) {
  return policyCandidates(input).filter((candidate) => candidate.admissible)
}

function exactAccount(input: ResolveInput, accountID: string): Effect.Effect<AccountCandidate, Error> {
  const matches = eligibleCandidates(input).filter((candidate) => candidate.accountID === accountID)
  if (matches.length === 0) {
    return Effect.fail(new ExplicitAccountUnavailableError({ providerID: input.providerID, accountID }))
  }
  if (matches.length > 1) {
    return Effect.fail(new AmbiguousAccountError({ providerID: input.providerID, accountID }))
  }
  return Effect.succeed(matches[0]!)
}

function validateProvider(binding: ProviderRoute.Binding, providerID: string): Effect.Effect<void, ProviderMismatchError> {
  if (binding.providerID === providerID) return Effect.void
  return Effect.fail(
    new ProviderMismatchError({
      expectedProviderID: providerID,
      actualProviderID: binding.providerID,
    }),
  )
}

function accountCommitViolation(
  input: ResolveInput,
  reason: AccountCommitViolationError["reason"],
  credentialHandle?: string,
) {
  return new AccountCommitViolationError({
    providerID: input.providerID,
    ...(credentialHandle ? { credentialHandle } : {}),
    reason,
  })
}

function validateAccountCommitBinding(
  input: ResolveInput,
  binding: ProviderRoute.Binding,
  excluded: ReadonlySet<string>,
  reason: "initial" | "failover",
  outcome: "committed" | "winner",
  current?: AccountRouteBinding,
): Effect.Effect<ProviderRoute.Binding, AccountCommitViolationError> {
  if (binding.sessionID !== input.sessionID) {
    return Effect.fail(accountCommitViolation(input, "session-mismatch"))
  }
  if (binding.affinityDomain !== input.affinityDomain) {
    return Effect.fail(accountCommitViolation(input, "affinity-mismatch"))
  }
  if (binding.providerID !== input.providerID) {
    return Effect.fail(
      accountCommitViolation(
        input,
        "provider-mismatch",
        binding.routeKind === "account" ? binding.credentialHandle : undefined,
      ),
    )
  }
  if (binding.routeKind === "public") {
    if (reason === "initial" && outcome === "winner") return Effect.succeed(binding)
    return Effect.fail(accountCommitViolation(input, "unexpected-route-kind"))
  }

  if (excluded.has(binding.credentialHandle)) {
    return Effect.fail(
      accountCommitViolation(input, "excluded", binding.credentialHandle),
    )
  }
  const known = input.candidates.find(
    (item) =>
      candidateKey(item) ===
      candidateKey({
        providerID: binding.providerID,
        accountID: binding.accountID,
        credentialHandle: binding.credentialHandle,
        admissible: true,
        healthRank: 0,
      }),
  )
  if (!known) {
    return Effect.fail(
      accountCommitViolation(input, "unknown-candidate", binding.credentialHandle),
    )
  }
  if (!known.admissible) {
    return Effect.fail(
      accountCommitViolation(input, "ineligible", binding.credentialHandle),
    )
  }

  if (reason === "initial" && outcome === "committed") {
    if (
      binding.routeRevision !== 1 ||
      binding.reason !== "initial" ||
      binding.mode !== input.mode ||
      binding.pin !== undefined
    ) {
      return Effect.fail(accountCommitViolation(input, "metadata-mismatch", binding.credentialHandle))
    }
  }

  if (reason === "failover") {
    if (!current) {
      return Effect.fail(accountCommitViolation(input, "metadata-mismatch", binding.credentialHandle))
    }
    if (binding.routeRevision !== current.routeRevision + 1) {
      return Effect.fail(accountCommitViolation(input, "revision-mismatch", binding.credentialHandle))
    }
    if (
      binding.reason !== "failover" ||
      binding.mode !== (current.mode ?? input.mode) ||
      binding.pin !== current.pin
    ) {
      return Effect.fail(accountCommitViolation(input, "metadata-mismatch", binding.credentialHandle))
    }
  }

  return Effect.succeed(binding)
}

export function make<CommitError = never, CredentialError = never>(
  deps: Dependencies<CommitError, CredentialError>,
) {
  const publicAvailable = (input: ResolveInput) => input.allowPublic && input.publicEligible

  const commitAccount = (
    input: ResolveInput,
    reason: "initial" | "failover",
    excludedCredentialHandles: ReadonlySet<string>,
    mode = input.mode,
    current?: AccountRouteBinding,
  ) =>
    Effect.gen(function* () {
      const base = {
        sessionID: input.sessionID,
        providerID: input.providerID,
        affinityDomain: input.affinityDomain,
        mode,
        candidates: policyCandidates(input),
        excludedCredentialHandles,
        ...(input.now === undefined ? {} : { now: input.now }),
      }
      const result = yield* deps.commitAccountSelection(
        reason === "failover"
          ? {
              ...base,
              reason,
              current: current!,
            }
          : {
              ...base,
              reason,
            },
      )

      if (result.state === "no-eligible") return undefined
      if (result.state === "stale") {
        if (reason === "failover" && current) {
          return yield* new StaleRouteError({
            providerID: input.providerID,
            affinityDomain: input.affinityDomain,
            expectedRevision: current.routeRevision,
          })
        }
        return yield* accountCommitViolation(input, "unexpected-stale")
      }
      if (result.state === "winner" && reason !== "initial") {
        return yield* accountCommitViolation(
          input,
          "unexpected-winner",
          result.binding.routeKind === "account" ? result.binding.credentialHandle : undefined,
        )
      }

      return yield* validateAccountCommitBinding(
        input,
        result.binding,
        excludedCredentialHandles,
        reason,
        result.state,
        current,
      )
    })

  const compile = (input: ResolveInput, binding: ProviderRoute.Binding) =>
    Effect.gen(function* () {
      yield* validateProvider(binding, input.providerID)
      if (binding.affinityDomain !== input.affinityDomain) {
        return yield* invalid("affinityDomain", "committed route belongs to a different affinity domain")
      }

      if (binding.routeKind === "public") {
        if (!publicAvailable(input)) {
          return yield* new BoundRouteUnavailableError({
            providerID: input.providerID,
            routeKind: "public",
            hardPin: false,
          })
        }
        const routeID = `${input.providerID}:public`
        const lease = {
          sessionID: input.sessionID,
          affinityDomain: input.affinityDomain,
          routeRevision: binding.routeRevision,
          route: {
            kind: "public",
            providerID: input.providerID,
            routeID,
          },
        } satisfies ProviderRouteLease
        return {
          lease,
          attribution: {
            sessionID: input.sessionID,
            affinityDomain: input.affinityDomain,
            providerID: input.providerID,
            routeRevision: binding.routeRevision,
            routeKind: "public",
          },
          clientRouteIdentity: {
            providerID: input.providerID,
            route: { kind: "public", routeID },
          },
        } satisfies Resolution
      }

      const candidate = input.candidates.find(
        (item) =>
          item.providerID === input.providerID &&
          item.accountID === binding.accountID &&
          item.credentialHandle === binding.credentialHandle,
      )
      if (!candidate?.admissible) {
        return yield* new BoundRouteUnavailableError({
          providerID: input.providerID,
          routeKind: "account",
          accountID: binding.accountID,
          hardPin: binding.pin === "hard",
        })
      }

      const credentialRevision = yield* deps.resolveCredentialRevision({
        providerID: input.providerID,
        accountID: binding.accountID,
        credentialHandle: binding.credentialHandle,
      })
      if (
        credentialRevision === undefined ||
        !Number.isSafeInteger(credentialRevision) ||
        credentialRevision <= 0
      ) {
        return yield* new CredentialUnavailableError({
          providerID: input.providerID,
          accountID: binding.accountID,
          credentialHandle: binding.credentialHandle,
        })
      }

      const lease = {
        sessionID: input.sessionID,
        affinityDomain: input.affinityDomain,
        routeRevision: binding.routeRevision,
        route: {
          kind: "account",
          providerID: input.providerID,
          accountID: binding.accountID,
          credentialHandle: binding.credentialHandle,
          credentialRevision,
        },
      } satisfies ProviderRouteLease
      return {
        lease,
        attribution: {
          sessionID: input.sessionID,
          affinityDomain: input.affinityDomain,
          providerID: input.providerID,
          routeRevision: binding.routeRevision,
          routeKind: "account",
          accountID: binding.accountID,
        },
        clientRouteIdentity: {
          providerID: input.providerID,
          route: {
            kind: "account",
            credentialHandle: binding.credentialHandle,
            credentialRevision,
          },
        },
      } satisfies Resolution
    })

  const rebind = (
    input: ResolveInput,
    current: ProviderRoute.Binding,
    route: ProviderRoute.Route,
    reason: ProviderRoute.AssignmentReason,
  ) =>
    Effect.gen(function* () {
      if (sameRoute(current, route)) return current
      const next = yield* deps.routes.compareAndSwap({
        sessionID: input.sessionID,
        affinityDomain: input.affinityDomain,
        expectedRevision: current.routeRevision,
        route,
        assignmentEpoch: current.assignmentEpoch + 1,
        reason,
        ...(input.now === undefined ? {} : { assignedAt: input.now }),
      })
      if (!next) {
        return yield* new StaleRouteError({
          providerID: input.providerID,
          affinityDomain: input.affinityDomain,
          expectedRevision: current.routeRevision,
        })
      }
      return next
    })

  const bindDesired = (
    input: ResolveInput,
    route: ProviderRoute.Route,
    strongIntent: boolean,
  ) =>
    Effect.gen(function* () {
      const winner = yield* deps.routes.bindIfAbsent({
        sessionID: input.sessionID,
        affinityDomain: input.affinityDomain,
        route,
        assignmentEpoch: 1,
        reason: strongIntent ? "explicit" : "initial",
        ...(input.now === undefined ? {} : { assignedAt: input.now }),
      })
      yield* validateProvider(winner, input.providerID)
      if (sameRoute(winner, route)) return winner
      if (!strongIntent) return winner
      return yield* rebind(input, winner, route, "explicit")
    })

  const resolveExistingAuto = (
    input: ResolveInput,
    current: ProviderRoute.Binding,
  ) =>
    Effect.gen(function* () {
      yield* validateProvider(current, input.providerID)
      if (current.routeKind === "public") return yield* compile(input, current)

      const candidate = input.candidates.find(
        (item) =>
          item.providerID === input.providerID &&
          item.accountID === current.accountID &&
          item.credentialHandle === current.credentialHandle,
      )
      if (candidate?.admissible) return yield* compile(input, current)
      if (current.pin === "hard") {
        return yield* new BoundRouteUnavailableError({
          providerID: input.providerID,
          routeKind: "account",
          accountID: current.accountID,
          hardPin: true,
        })
      }

      const rebound = yield* commitAccount(
        input,
        "failover",
        new Set([current.credentialHandle]),
        current.mode ?? input.mode,
        current,
      )
      if (!rebound) {
        return yield* new BoundRouteUnavailableError({
          providerID: input.providerID,
          routeKind: "account",
          accountID: current.accountID,
          hardPin: false,
        })
      }
      return yield* compile(input, rebound)
    })

  const resolve = (input: ResolveInput) =>
    Effect.gen(function* () {
      const providerID = canonical(input.providerID)
      if (!providerID) return yield* invalid("providerID", "must be non-empty")
      const affinityDomain = canonical(input.affinityDomain)
      if (!affinityDomain) return yield* invalid("affinityDomain", "must be non-empty")
      if (providerID !== input.providerID || affinityDomain !== input.affinityDomain) {
        return yield* invalid("identity", "providerID and affinityDomain must already be canonical")
      }

      const current = yield* deps.routes.get(input.sessionID, input.affinityDomain)

      if (input.routeIntent.kind === "account") {
        const candidate = yield* exactAccount(input, input.routeIntent.accountID)
        const desired = accountRoute(
          input.providerID,
          candidate,
          current?.routeKind === "account" ? (current.mode ?? input.mode) : input.mode,
          input.routeIntent.pin ?? "hard",
        )
        const binding = current
          ? yield* rebind(input, current, desired, "explicit")
          : yield* bindDesired(input, desired, true)
        return yield* compile(input, binding)
      }

      if (input.routeIntent.kind === "public") {
        if (!publicAvailable(input)) {
          return yield* new PublicUnavailableError({ providerID: input.providerID })
        }
        const desired = publicRoute(input.providerID)
        const binding = current
          ? yield* rebind(input, current, desired, "explicit")
          : yield* bindDesired(input, desired, true)
        return yield* compile(input, binding)
      }

      if (current) return yield* resolveExistingAuto(input, current)

      if (input.freeRoutePreference === "public-first-for-free" && publicAvailable(input)) {
        const binding = yield* bindDesired(input, publicRoute(input.providerID), false)
        return yield* compile(input, binding)
      }

      const binding = yield* commitAccount(input, "initial", new Set())
      if (binding) {
        return yield* compile(input, binding)
      }

      if (publicAvailable(input)) {
        const binding = yield* bindDesired(input, publicRoute(input.providerID), false)
        return yield* compile(input, binding)
      }

      return yield* new NoEligibleRouteError({ providerID: input.providerID })
    })

  return { resolve, compile }
}
