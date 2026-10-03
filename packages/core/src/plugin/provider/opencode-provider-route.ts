export * as OpencodeProviderRoute from "./opencode-provider-route"

import { Effect } from "effect"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import type { Credential } from "../../credential"
import { ProviderRoute } from "../../provider-route"
import { ProviderRouteResolution } from "../../provider-route-resolution"
import { ProviderAccountPolicy } from "../../provider-account-policy"
import type { SessionSchema } from "../../session/schema"
import {
  OpencodeRouteCandidates,
  make as makeRouteCandidates,
} from "./opencode-route-candidates"

export interface CandidateSource<CredentialError = unknown> {
  readonly list: (input: {
    readonly providerID: string
    readonly modelID: string
  }) => Effect.Effect<OpencodeRouteCandidates.ListResult>
  readonly resolveCredentialRevision: (
    input: OpencodeRouteCandidates.RevisionInput,
  ) => Effect.Effect<number | undefined, CredentialError>
  readonly invalidate?: (credentialID: Credential.ID) => void
  readonly cacheSize?: () => number
}

export interface ResolveInput {
  readonly sessionID: SessionSchema.ID
  readonly providerID: string
  readonly modelID: string
  readonly affinityDomain: string
  readonly routeIntent: ProviderRouteIntent.Info
  readonly mode: ProviderRoute.RoutingMode
  readonly freeRoutePreference: ProviderRouteResolution.FreeRoutePreference
  readonly allowPublic: boolean
  readonly publicEligible: boolean
  readonly now?: number
}

export interface Resolution extends ProviderRouteResolution.Resolution {
  /** Secret-free diagnostics from candidate preparation. */
  readonly candidateIssues: readonly OpencodeRouteCandidates.AccountIssue[]
}

/**
 * One-call provider route used by non-Session primitives such as System One.
 * This deliberately is not a ProviderRouteLease: no Session row, route revision,
 * cursor, assignment count, or sticky affinity is created.
 */
export interface TransientResolveInput {
  readonly providerID: string
  readonly modelID: string
  readonly routeIntent: ProviderRouteIntent.Info
  readonly mode: ProviderRoute.RoutingMode
  readonly freeRoutePreference: ProviderRouteResolution.FreeRoutePreference
  readonly allowPublic: boolean
  readonly publicEligible: boolean
}

export type TransientRoute = ProviderRouteResolution.ProviderRouteLease["route"]

export interface TransientResolution {
  readonly route: TransientRoute
  readonly clientRouteIdentity: ProviderRouteResolution.ClientRouteIdentity
  readonly candidateIssues: readonly OpencodeRouteCandidates.AccountIssue[]
}

export interface CompileExistingInput extends ResolveInput {
  /**
   * Secret-free parent-dispatch authority. compileExisting never binds,
   * rebinds, fails over, or runs account selection; the durable row must still
   * be this exact route generation or the maintenance dispatch fails closed.
   */
  readonly expected: ProviderRouteResolution.RouteAttribution
}

export type OptionalResolution = Resolution | undefined

export interface CompositionOptions<CredentialError = unknown> {
  readonly routes: ProviderRoute.Interface
  readonly source: CandidateSource<CredentialError>
}

export interface Options<HealthError = never> extends OpencodeRouteCandidates.Options<HealthError> {
  readonly routes: ProviderRoute.Interface
}

/**
 * Stable provider-scoped route-affinity namespace shared by the current/Core
 * and mature V1 runtimes. ProviderRoute owns one binding per Session/domain,
 * so provider identity belongs in the domain while runtime generation does not.
 */
export const affinityDomain = (providerID: string) => `opencode-provider/${providerID}`

function resolutionInput(
  input: ResolveInput,
  candidates: readonly ProviderRouteResolution.AccountCandidate[],
): ProviderRouteResolution.ResolveInput {
  return {
    sessionID: input.sessionID,
    providerID: input.providerID,
    affinityDomain: input.affinityDomain,
    routeIntent: input.routeIntent,
    mode: input.mode,
    freeRoutePreference: input.freeRoutePreference,
    allowPublic: input.allowPublic,
    publicEligible: input.publicEligible,
    candidates,
    ...(input.now === undefined ? {} : { now: input.now }),
  }
}

/**
 * Production composition boundary for OpenCode provider routing.
 *
 * A2 owns credential refresh/account config/provider health preparation. The
 * provider-neutral resolver owns durable route semantics. ProviderRoute owns
 * the one transactional account-policy mutation. This layer performs no
 * second selection after a route has committed.
 */
export function compose<CredentialError = unknown>(
  options: CompositionOptions<CredentialError>,
) {
  const resolver = ProviderRouteResolution.make({
    routes: options.routes,
    commitAccountSelection: options.routes.commitAccountSelection,
    resolveCredentialRevision: options.source.resolveCredentialRevision,
  })

  const withPreparedCandidates = (
    input: ResolveInput,
    prepared: OpencodeRouteCandidates.ListResult,
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolver.resolve(
        resolutionInput(
          input,
          prepared.candidates.map((entry) => entry.candidate),
        ),
      )
      return {
        ...resolved,
        candidateIssues: prepared.issues,
      } satisfies Resolution
    })

  const prepare = (input: ResolveInput) =>
    options.source.list({
      providerID: input.providerID,
      modelID: input.modelID,
    })

  const withCandidates = (input: ResolveInput) =>
    prepare(input).pipe(
      Effect.flatMap((prepared) => withPreparedCandidates(input, prepared)),
    )

  const withoutCandidates = (input: ResolveInput) =>
    resolver.resolve(resolutionInput(input, [])).pipe(
      Effect.map(
        (resolved) =>
          ({
            ...resolved,
            candidateIssues: [],
          }) satisfies Resolution,
      ),
    )

  const resolve = (input: ResolveInput) =>
    Effect.gen(function* () {
      // Public must stay a genuine credential-free route. Do not enumerate,
      // refresh, or fetch account config just to prove an explicit Public
      // selection or an already-committed sticky Public binding.
      if (input.routeIntent.kind === "public") {
        return yield* withoutCandidates(input)
      }

      const current = yield* options.routes.get(input.sessionID, input.affinityDomain)
      if (input.routeIntent.kind === "auto" && current?.routeKind === "public") {
        return yield* withoutCandidates(input)
      }

      if (
        input.routeIntent.kind === "auto" &&
        current === undefined &&
        input.freeRoutePreference === "public-first-for-free" &&
        input.allowPublic &&
        input.publicEligible
      ) {
        // Fast Public bind has no credential work. If another writer commits an
        // account in the tiny race after our read, re-enter once with prepared
        // candidates so the resolver can compile that durable winner instead of
        // treating the absent candidate snapshot as account ineligibility.
        return yield* withoutCandidates(input).pipe(
          Effect.catch((error) =>
            error instanceof ProviderRouteResolution.BoundRouteUnavailableError &&
            error.routeKind === "account"
              ? withCandidates(input)
              : Effect.fail(error),
          ),
        )
      }

      return yield* withCandidates(input)
    })

  /**
   * Resolve only when this provider/model is actually owned by the OpenCode
   * routing domain.
   *
   * This is the production migration seam for generic provider runtimes. It
   * prevents an Auto route from hijacking an unrelated direct API-key provider
   * merely because the OpenCode account integration is installed, while still
   * failing closed when account discovery is ambiguous or unhealthy.
   *
   * Candidate/config/health work happens exactly once and remains outside the
   * ProviderRoute transaction.
   */
  const resolveIfApplicable = (input: ResolveInput) =>
    Effect.gen(function* () {
      if (input.routeIntent.kind !== "auto") return yield* resolve(input)

      const current = yield* options.routes.get(input.sessionID, input.affinityDomain)
      if (current !== undefined) return yield* resolve(input)

      if (input.allowPublic && input.publicEligible) return yield* resolve(input)

      const prepared = yield* prepare(input)
      const ownsModel = prepared.candidates.some(
        (entry) =>
          entry.candidate.admissible ||
          entry.candidate.ineligibleReason !== "model-unsupported",
      )

      // No credential/config ambiguity and every known account positively says
      // this model is unsupported: this provider/model belongs to the legacy
      // direct-provider path, not the OpenCode account router.
      if (!ownsModel && prepared.issues.length === 0) return undefined

      return yield* withPreparedCandidates(input, prepared)
    })

  const transientPublic = (input: TransientResolveInput): TransientResolution => ({
    route: {
      kind: "public",
      providerID: input.providerID,
      routeID: `${input.providerID}:public`,
    },
    clientRouteIdentity: {
      providerID: input.providerID,
      route: {
        kind: "public",
        routeID: `${input.providerID}:public`,
      },
    },
    candidateIssues: [],
  })

  const transientAccount = (
    input: TransientResolveInput,
    prepared: OpencodeRouteCandidates.ListResult,
    selected: ProviderAccountPolicy.SelectedAccount,
  ): Effect.Effect<
    TransientResolution,
    ProviderRouteResolution.NoEligibleRouteError
  > => {
    const snapshot = prepared.candidates.find(
      (entry) =>
        entry.candidate.providerID === selected.providerID &&
        entry.candidate.accountID === selected.accountID &&
        entry.candidate.credentialHandle === selected.credentialHandle,
    )
    if (!snapshot) {
      return Effect.fail(new ProviderRouteResolution.NoEligibleRouteError({ providerID: input.providerID }))
    }
    return Effect.succeed({
      route: {
        kind: "account",
        providerID: input.providerID,
        accountID: snapshot.candidate.accountID,
        credentialHandle: snapshot.candidate.credentialHandle,
        credentialRevision: snapshot.credentialRevision,
      },
      clientRouteIdentity: {
        providerID: input.providerID,
        route: {
          kind: "account",
          credentialHandle: snapshot.candidate.credentialHandle,
          credentialRevision: snapshot.credentialRevision,
        },
      },
      candidateIssues: prepared.issues,
    })
  }

  /**
   * Resolve a one-call route without creating durable Session affinity.
   *
   * This mirrors the initial durable route ordering but intentionally supplies
   * no durable cursor/stats to P1: each call stands alone. Candidate/config/
   * health preparation still comes from A2 and account ranking still comes from
   * P1; this layer owns no second policy implementation.
   */
  const resolveTransient = (input: TransientResolveInput) =>
    Effect.gen(function* () {
      const publicAvailable = input.allowPublic && input.publicEligible

      if (input.routeIntent.kind === "public") {
        if (!publicAvailable) {
          return yield* new ProviderRouteResolution.PublicUnavailableError({
            providerID: input.providerID,
          })
        }
        return transientPublic(input)
      }

      if (
        input.routeIntent.kind === "auto" &&
        input.freeRoutePreference === "public-first-for-free" &&
        publicAvailable
      ) {
        return transientPublic(input)
      }

      const prepared = yield* prepare({
        ...input,
        affinityDomain: affinityDomain(input.providerID),
      } as ResolveInput)

      if (input.routeIntent.kind === "account") {
        const accountID = input.routeIntent.accountID
        const matches = prepared.candidates.filter(
          (entry) =>
            entry.candidate.providerID === input.providerID &&
            entry.candidate.accountID === accountID &&
            entry.candidate.admissible,
        )
        if (matches.length === 0) {
          return yield* new ProviderRouteResolution.ExplicitAccountUnavailableError({
            providerID: input.providerID,
            accountID: input.routeIntent.accountID,
          })
        }
        if (matches.length > 1) {
          return yield* new ProviderRouteResolution.AmbiguousAccountError({
            providerID: input.providerID,
            accountID: input.routeIntent.accountID,
          })
        }
        return yield* transientAccount(input, prepared, {
          providerID: matches[0]!.candidate.providerID,
          accountID: matches[0]!.candidate.accountID,
          credentialHandle: matches[0]!.candidate.credentialHandle,
        })
      }

      const ownsModel = prepared.candidates.some(
        (entry) =>
          entry.candidate.admissible ||
          entry.candidate.ineligibleReason !== "model-unsupported",
      )
      if (!ownsModel && prepared.issues.length === 0 && !publicAvailable) {
        return undefined
      }

      const policy = ProviderAccountPolicy.select({
        providerID: input.providerID,
        affinityDomain: affinityDomain(input.providerID),
        mode: input.mode,
        candidates: prepared.candidates.map((entry) => entry.candidate),
      })
      if (!policy.ok) return yield* policy.error
      if (policy.selection.selected) {
        return yield* transientAccount(input, prepared, policy.selection.selected)
      }

      if (publicAvailable) return transientPublic(input)
      if (!ownsModel && prepared.issues.length === 0) return undefined

      return yield* new ProviderRouteResolution.NoEligibleRouteError({
        providerID: input.providerID,
      })
    })

  const compileExisting = (input: CompileExistingInput) =>
    Effect.gen(function* () {
      const current = yield* options.routes.get(input.sessionID, input.affinityDomain)
      const expected = input.expected
      const matches =
        current !== undefined &&
        expected.sessionID === input.sessionID &&
        expected.affinityDomain === input.affinityDomain &&
        expected.providerID === input.providerID &&
        expected.routeRevision === current.routeRevision &&
        expected.routeKind === current.routeKind &&
        (current.routeKind === "public" ||
          (expected.routeKind === "account" && expected.accountID === current.accountID))

      if (!matches || !current) {
        return yield* new ProviderRouteResolution.StaleRouteError({
          providerID: input.providerID,
          affinityDomain: input.affinityDomain,
          expectedRevision: expected.routeRevision,
        })
      }

      if (current.routeKind === "public") {
        const resolved = yield* resolver.compile(resolutionInput(input, []), current)
        return {
          ...resolved,
          candidateIssues: [],
        } satisfies Resolution
      }

      const prepared = yield* prepare(input)
      const resolved = yield* resolver.compile(
        resolutionInput(
          input,
          prepared.candidates.map((entry) => entry.candidate),
        ),
        current,
      )
      return {
        ...resolved,
        candidateIssues: prepared.issues,
      } satisfies Resolution
    })

  return {
    resolve,
    resolveIfApplicable,
    resolveTransient,
    compileExisting,
    invalidate: options.source.invalidate,
    cacheSize: options.source.cacheSize,
  }
}

/**
 * Construct the long-lived production resolver from the trusted A2 source.
 * The caller owns the authority realm and provider-specific health policy.
 */
export function make<HealthError = never>(options: Options<HealthError>) {
  const source = makeRouteCandidates(options)
  return {
    ...compose({ routes: options.routes, source }),
    /** Final transport-only exact-handle materialization from the same A2/P2 source/cache. */
    resolveExecution: source.resolveExecution,
  }
}
