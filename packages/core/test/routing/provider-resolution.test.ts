import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import {
  ProviderRouteResolution,
  type AccountCandidate,
  type ResolveInput,
} from "@opencode-ai/core/provider-route-resolution"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"

const sessionID = SessionSchema.ID.make("ses_provider_resolution")
const providerID = "opencode"
const affinityDomain = "opencode-hosted"

const accountA: AccountCandidate = {
  providerID,
  accountID: "acct-a",
  credentialHandle: "cred_a",
  admissible: true,
  healthRank: 0,
}
const accountB: AccountCandidate = {
  providerID,
  accountID: "acct-b",
  credentialHandle: "cred_b",
  admissible: true,
  healthRank: 0,
}

function binding(
  route: ProviderRoute.Route,
  overrides: Partial<ProviderRoute.Binding> = {},
): ProviderRoute.Binding {
  const base = {
    sessionID,
    affinityDomain,
    providerID: route.providerID,
    routeRevision: 1,
    assignedAt: 100,
    assignmentEpoch: 1,
    reason: "initial" as const,
  }
  if (route.kind === "public") {
    return { ...base, routeKind: "public", ...overrides } as ProviderRoute.Binding
  }
  return {
    ...base,
    routeKind: "account",
    accountID: route.accountID,
    credentialHandle: route.credentialHandle,
    ...(route.mode ? { mode: route.mode } : {}),
    ...(route.pin ? { pin: route.pin } : {}),
    ...overrides,
  } as ProviderRoute.Binding
}

function accountBinding(
  route: Extract<ProviderRoute.Route, { readonly kind: "account" }>,
  overrides: Partial<ProviderRoute.Binding> = {},
): ProviderRouteResolution.AccountRouteBinding {
  return binding(route, overrides) as ProviderRouteResolution.AccountRouteBinding
}

function memoryRoutes(
  initial?: ProviderRoute.Binding,
  overrides?: Partial<Pick<ProviderRoute.Interface, "bindIfAbsent" | "compareAndSwap">>,
) {
  let current = initial
  const calls = {
    get: 0,
    bind: 0,
    cas: 0,
  }
  const bindIfAbsent: ProviderRoute.Interface["bindIfAbsent"] = (input) => {
    calls.bind++
    if (overrides?.bindIfAbsent) return overrides.bindIfAbsent(input)
    if (current) return Effect.succeed(current)
    current = binding(input.route, {
      assignmentEpoch: input.assignmentEpoch,
      reason: input.reason,
      assignedAt: input.assignedAt ?? 100,
    })
    return Effect.succeed(current)
  }
  const compareAndSwap: ProviderRoute.Interface["compareAndSwap"] = (input) => {
    calls.cas++
    if (overrides?.compareAndSwap) return overrides.compareAndSwap(input)
    if (!current || current.routeRevision !== input.expectedRevision) {
      return Effect.succeed(undefined)
    }
    current = binding(input.route, {
      routeRevision: current.routeRevision + 1,
      assignmentEpoch: input.assignmentEpoch,
      reason: input.reason,
      assignedAt: input.assignedAt ?? 100,
    })
    return Effect.succeed(current)
  }
  const service: ProviderRoute.Interface = {
    get: () => {
      calls.get++
      return Effect.succeed(current)
    },
    bindIfAbsent,
    compareAndSwap,
    commitAccountSelection: () =>
      Effect.die("resolver test harness must use its injected atomic commit boundary"),
  }
  return {
    service,
    calls,
    current: () => current,
    set: (next: ProviderRoute.Binding | undefined) => {
      current = next
    },
  }
}

const auto = ProviderRouteIntent.Info.make({ kind: "auto" })
const explicitPublic = ProviderRouteIntent.Info.make({ kind: "public" })
const explicitAccount = (accountID: string, pin: "hard" | "soft" = "hard") =>
  ProviderRouteIntent.Info.make({ kind: "account", accountID, pin })

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    sessionID,
    providerID,
    affinityDomain,
    routeIntent: auto,
    mode: "session-round-robin",
    freeRoutePreference: "public-first-for-free",
    allowPublic: true,
    publicEligible: true,
    candidates: [accountA, accountB],
    now: 1_000,
    ...overrides,
  }
}

function harness(options?: {
  initial?: ProviderRoute.Binding
  revisions?: Readonly<Record<string, number | undefined>>
  commit?: (
    input: ProviderRouteResolution.AccountCommitInput,
    routes: ReturnType<typeof memoryRoutes>,
  ) => ProviderRouteResolution.AccountCommitResult | undefined
}) {
  const routes = memoryRoutes(options?.initial)
  const commits: ProviderRouteResolution.AccountCommitInput[] = []
  const credentialCalls: ProviderRouteResolution.ResolveCredentialInput[] = []
  const resolver = ProviderRouteResolution.make({
    routes: routes.service,
    commitAccountSelection: (request) => {
      commits.push(request)
      const override = options?.commit?.(request, routes)
      if (override) return Effect.succeed(override)

      const live = routes.current()
      if (request.reason === "initial" && live) {
        return Effect.succeed({ state: "winner", binding: live } as const)
      }

      const selected = request.candidates.find(
        (candidate) =>
          candidate.admissible && !request.excludedCredentialHandles.has(candidate.credentialHandle),
      )
      if (!selected) return Effect.succeed({ state: "no-eligible" } as const)

      if (request.reason === "failover") {
        if (!live || live.routeRevision !== request.current.routeRevision) {
          return Effect.succeed({ state: "stale" } as const)
        }
        const next = accountBinding(
          {
            kind: "account",
            providerID: request.providerID,
            accountID: selected.accountID,
            credentialHandle: selected.credentialHandle,
            mode: request.mode,
            ...(request.current.pin ? { pin: request.current.pin } : {}),
          },
          {
            routeRevision: request.current.routeRevision + 1,
            assignmentEpoch: request.current.assignmentEpoch + 1,
            reason: "failover",
            assignedAt: request.now ?? 100,
          },
        )
        routes.set(next)
        return Effect.succeed({ state: "committed", binding: next } as const)
      }

      const next = accountBinding(
        {
          kind: "account",
          providerID: request.providerID,
          accountID: selected.accountID,
          credentialHandle: selected.credentialHandle,
          mode: request.mode,
        },
        {
          assignmentEpoch: 1,
          reason: "initial",
          assignedAt: request.now ?? 100,
        },
      )
      routes.set(next)
      return Effect.succeed({ state: "committed", binding: next } as const)
    },
    resolveCredentialRevision: (request) => {
      credentialCalls.push(request)
      const revision = options?.revisions?.[request.credentialHandle] ?? 1
      return Effect.succeed(revision)
    },
  })
  return { routes, resolver, commits, credentialCalls }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("ProviderRouteResolution", () => {
  test("new Auto free route defaults to Public even when eligible accounts exist", async () => {
    const h = harness({
      commit: () => {
        throw new Error("account commit must not run for public-first eligible free route")
      },
    })
    const result = await run(h.resolver.resolve(input()))

    expect(result.lease.route).toEqual({
      kind: "public",
      providerID,
      routeID: "opencode:public",
    })
    expect(result.attribution.routeKind).toBe("public")
    expect("accountID" in result.attribution).toBe(false)
    expect(h.routes.current()?.routeKind).toBe("public")
    expect(h.commits).toHaveLength(0)
  })

  test("account-first compatibility chooses an eligible account before Public", async () => {
    const h = harness()
    const result = await run(
      h.resolver.resolve(
        input({
          freeRoutePreference: "account-first",
        }),
      ),
    )

    expect(result.lease.route).toEqual({
      kind: "account",
      providerID,
      accountID: "acct-a",
      credentialHandle: "cred_a",
      credentialRevision: 1,
    })
    expect(result.attribution).toMatchObject({ routeKind: "account", accountID: "acct-a" })
    expect(h.commits).toHaveLength(1)
    expect(h.routes.calls.bind).toBe(0)
    expect(h.routes.calls.cas).toBe(0)
  })

  test("existing Public binding remains Public after accounts are added or preferred", async () => {
    const h = harness({
      initial: binding({ kind: "public", providerID }),
      commit: () => {
        throw new Error("existing Public binding must not consult account commit")
      },
    })
    const result = await run(
      h.resolver.resolve(
        input({
          freeRoutePreference: "account-first",
          candidates: [accountA, accountB],
        }),
      ),
    )

    expect(result.lease.route.kind).toBe("public")
    expect(result.lease.routeRevision).toBe(1)
    expect(h.routes.calls.cas).toBe(0)
    expect(h.commits).toHaveLength(0)
  })

  test("existing account binding remains exact account when Public becomes available", async () => {
    const initial = binding({
      kind: "account",
      providerID,
      accountID: accountA.accountID,
      credentialHandle: accountA.credentialHandle,
      mode: "session-round-robin",
    })
    const h = harness({ initial, revisions: { cred_a: 7 } })
    const result = await run(h.resolver.resolve(input()))

    expect(result.lease.route).toEqual({
      kind: "account",
      providerID,
      accountID: "acct-a",
      credentialHandle: "cred_a",
      credentialRevision: 7,
    })
    expect(result.lease.routeRevision).toBe(1)
    expect(h.routes.calls.cas).toBe(0)
  })

  test("explicit Public fails closed when the provider authority or model disallows Public", async () => {
    const h = harness()
    const unavailable = await run(
      h.resolver
        .resolve(
          input({
            routeIntent: explicitPublic,
            allowPublic: false,
          }),
        )
        .pipe(Effect.flip),
    )

    expect(unavailable._tag).toBe("ProviderRouteResolution.PublicUnavailable")
    expect(h.routes.current()).toBeUndefined()
  })

  test("explicit account resolves exactly and crosses Public -> account only through CAS", async () => {
    const h = harness({ initial: binding({ kind: "public", providerID }), revisions: { cred_b: 9 } })
    const result = await run(
      h.resolver.resolve(
        input({
          routeIntent: explicitAccount("acct-b", "hard"),
        }),
      ),
    )

    expect(result.lease.route).toEqual({
      kind: "account",
      providerID,
      accountID: "acct-b",
      credentialHandle: "cred_b",
      credentialRevision: 9,
    })
    expect(result.lease.routeRevision).toBe(2)
    expect(h.routes.calls.cas).toBe(1)
    expect(h.routes.current()).toMatchObject({
      routeKind: "account",
      accountID: "acct-b",
      credentialHandle: "cred_b",
      pin: "hard",
      reason: "explicit",
    })
  })

  test("explicit account is fail-closed when its safe account identity is missing", async () => {
    const h = harness()
    const result = await run(
      h.resolver
        .resolve(
          input({
            routeIntent: explicitAccount("acct-missing"),
          }),
        )
        .pipe(Effect.flip),
    )

    expect(result._tag).toBe("ProviderRouteResolution.ExplicitAccountUnavailable")
    expect(h.routes.current()).toBeUndefined()
  })

  test("removed hard-pinned account fails closed without account commit or cross-kind fallback", async () => {
    const initial = binding({
      kind: "account",
      providerID,
      accountID: "acct-a",
      credentialHandle: "cred_a",
      mode: "session-round-robin",
      pin: "hard",
    })
    const h = harness({ initial })
    const result = await run(
      h.resolver
        .resolve(
          input({
            candidates: [accountB],
          }),
        )
        .pipe(Effect.flip),
    )

    expect(result._tag).toBe("ProviderRouteResolution.BoundRouteUnavailable")
    if (result._tag !== "ProviderRouteResolution.BoundRouteUnavailable") return
    expect(result.hardPin).toBe(true)
    expect(h.commits).toHaveLength(0)
    expect(h.routes.calls.cas).toBe(0)
  })

  test("soft account failover stays account-kind and excludes the failed handle", async () => {
    const initial = binding({
      kind: "account",
      providerID,
      accountID: "acct-a",
      credentialHandle: "cred_a",
      mode: "session-round-robin",
      pin: "soft",
    })
    const h = harness({
      initial,
      revisions: { cred_b: 4 },
      commit: (request) => {
        expect(request.reason).toBe("failover")
        expect(request.excludedCredentialHandles.has("cred_a")).toBe(true)
        return undefined
      },
    })
    const result = await run(
      h.resolver.resolve(
        input({
          candidates: [{ ...accountA, admissible: false }, accountB],
        }),
      ),
    )

    expect(result.lease.route).toEqual({
      kind: "account",
      providerID,
      accountID: "acct-b",
      credentialHandle: "cred_b",
      credentialRevision: 4,
    })
    expect(result.lease.routeRevision).toBe(2)
    expect(h.routes.current()).toMatchObject({
      routeKind: "account",
      accountID: "acct-b",
      reason: "failover",
    })
    expect(h.commits).toHaveLength(1)
    expect(h.routes.calls.cas).toBe(0)
  })

  test("stale atomic failover does not retry through the route ledger", async () => {
    const initial = binding({
      kind: "account",
      providerID,
      accountID: "acct-a",
      credentialHandle: "cred_a",
      mode: "concentrate",
      pin: "soft",
    })
    const h = harness({
      initial,
      commit: (request) =>
        request.reason === "failover" ? { state: "stale" } : undefined,
    })

    const result = await run(
      h.resolver
        .resolve(
          input({
            mode: "concentrate",
            candidates: [{ ...accountA, admissible: false }, accountB],
          }),
        )
        .pipe(Effect.flip),
    )

    expect(result._tag).toBe("ProviderRouteResolution.StaleRoute")
    expect(h.routes.current()).toBe(initial)
    expect(h.routes.calls.bind).toBe(0)
    expect(h.routes.calls.cas).toBe(0)
    expect(h.commits).toHaveLength(1)
  })

  test("atomic account commit cannot return an excluded candidate", async () => {
    const initial = binding({
      kind: "account",
      providerID,
      accountID: "acct-a",
      credentialHandle: "cred_a",
      mode: "concentrate",
      pin: "soft",
    })
    const h = harness({
      initial,
      commit: (request) => {
        if (request.reason !== "failover") return undefined
        return {
          state: "committed",
          binding: accountBinding(
            {
              kind: "account",
              providerID,
              accountID: accountA.accountID,
              credentialHandle: accountA.credentialHandle,
              mode: request.mode,
              pin: "soft",
            },
            {
              routeRevision: request.current.routeRevision + 1,
              assignmentEpoch: request.current.assignmentEpoch + 1,
              reason: "failover",
            },
          ),
        }
      },
    })
    const result = await run(
      h.resolver
        .resolve(
          input({
            candidates: [{ ...accountA, admissible: false }, accountB],
          }),
        )
        .pipe(Effect.flip),
    )

    expect(result._tag).toBe("ProviderRouteResolution.AccountCommitViolation")
    if (result._tag !== "ProviderRouteResolution.AccountCommitViolation") return
    expect(result.reason).toBe("excluded")
    expect(h.routes.calls.cas).toBe(0)
  })

  test("atomic initial commit rejects a committed account outside the validated candidate set", async () => {
    const h = harness({
      commit: () => ({
        state: "committed",
        binding: accountBinding({
          kind: "account",
          providerID,
          accountID: "acct-c",
          credentialHandle: "cred_c",
          mode: "concentrate",
        }),
      }),
    })

    const result = await run(
      h.resolver
        .resolve(
          input({
            freeRoutePreference: "account-first",
            mode: "concentrate",
          }),
        )
        .pipe(Effect.flip),
    )

    expect(result._tag).toBe("ProviderRouteResolution.AccountCommitViolation")
    if (result._tag !== "ProviderRouteResolution.AccountCommitViolation") return
    expect(result.reason).toBe("unknown-candidate")
    expect(h.routes.calls.bind).toBe(0)
    expect(h.routes.calls.cas).toBe(0)
  })

  test("account policy cannot claim Public as its committed mutation", async () => {
    const forged = {
      state: "committed",
      binding: binding({ kind: "public", providerID }),
    } as unknown as ProviderRouteResolution.AccountCommitResult
    const h = harness({
      commit: () => forged,
    })

    const result = await run(
      h.resolver
        .resolve(
          input({
            freeRoutePreference: "account-first",
          }),
        )
        .pipe(Effect.flip),
    )

    expect(result._tag).toBe("ProviderRouteResolution.AccountCommitViolation")
    if (result._tag !== "ProviderRouteResolution.AccountCommitViolation") return
    expect(result.reason).toBe("unexpected-route-kind")
    expect(h.routes.calls.bind).toBe(0)
    expect(h.routes.calls.cas).toBe(0)
  })

  test("failover cannot report a concurrent winner instead of stale CAS", async () => {
    const initial = accountBinding({
      kind: "account",
      providerID,
      accountID: accountA.accountID,
      credentialHandle: accountA.credentialHandle,
      mode: "concentrate",
      pin: "soft",
    })
    const h = harness({
      initial,
      commit: (request) =>
        request.reason === "failover"
          ? { state: "winner", binding: request.current }
          : undefined,
    })

    const result = await run(
      h.resolver
        .resolve(
          input({
            mode: "concentrate",
            candidates: [{ ...accountA, admissible: false }, accountB],
          }),
        )
        .pipe(Effect.flip),
    )

    expect(result._tag).toBe("ProviderRouteResolution.AccountCommitViolation")
    if (result._tag !== "ProviderRouteResolution.AccountCommitViolation") return
    expect(result.reason).toBe("unexpected-winner")
    expect(h.routes.calls.bind).toBe(0)
    expect(h.routes.calls.cas).toBe(0)
  })

  test("atomic commit preserves safe P1 policy facts while stripping structural secret extras", async () => {
    const secretCandidate = {
      ...accountA,
      healthRank: 7,
      usedPercent: 81,
      resetAt: 9_999,
      maxSessionBindings: 3,
      access: "secret-access",
      refresh: "secret-refresh",
      Authorization: "Bearer secret-access",
      headers: { authorization: "Bearer secret-access" },
    }
    let serializedCommit = ""
    const h = harness({
      commit: (request) => {
        serializedCommit = JSON.stringify(request)
        return { state: "no-eligible" }
      },
    })

    const result = await run(
      h.resolver
        .resolve(
          input({
            freeRoutePreference: "account-first",
            allowPublic: false,
            publicEligible: false,
            candidates: [secretCandidate],
          }),
        )
        .pipe(Effect.flip),
    )

    expect(result._tag).toBe("ProviderRouteResolution.NoEligibleRoute")
    expect(serializedCommit).toContain('"credentialHandle":"cred_a"')
    expect(serializedCommit).toContain('"healthRank":7')
    expect(serializedCommit).toContain('"usedPercent":81')
    expect(serializedCommit).toContain('"resetAt":9999')
    expect(serializedCommit).toContain('"maxSessionBindings":3')
    expect(serializedCommit).not.toContain("secret-access")
    expect(serializedCommit).not.toContain("secret-refresh")
    expect(serializedCommit).not.toContain("Authorization")
    expect(serializedCommit).not.toContain("headers")
  })

  test("atomic commit receives inadmissibility diagnostics without making them executable", async () => {
    const blocked: AccountCandidate = {
      ...accountA,
      admissible: false,
      healthRank: 11,
      ineligibleReason: "quota-exhausted",
      usedPercent: 100,
      resetAt: 12_345,
      maxSessionBindings: 1,
    }
    let observed: readonly AccountCandidate[] = []
    const h = harness({
      commit: (request) => {
        observed = request.candidates
        return { state: "no-eligible" }
      },
    })

    const result = await run(
      h.resolver
        .resolve(
          input({
            freeRoutePreference: "account-first",
            allowPublic: false,
            publicEligible: false,
            candidates: [blocked],
          }),
        )
        .pipe(Effect.flip),
    )

    expect(result._tag).toBe("ProviderRouteResolution.NoEligibleRoute")
    expect(observed).toEqual([
      {
        providerID,
        accountID: "acct-a",
        credentialHandle: "cred_a",
        admissible: false,
        healthRank: 11,
        ineligibleReason: "quota-exhausted",
        usedPercent: 100,
        resetAt: 12_345,
        maxSessionBindings: 1,
      },
    ])
  })

  test("stale explicit rebind fails instead of overwriting the newer committed route", async () => {
    const routes = memoryRoutes(binding({ kind: "public", providerID }), {
      compareAndSwap: () => Effect.succeed(undefined),
    })
    const resolver = ProviderRouteResolution.make({
      routes: routes.service,
      commitAccountSelection: () => Effect.succeed({ state: "no-eligible" } as const),
      resolveCredentialRevision: () => Effect.succeed(1),
    })

    const result = await run(
      resolver
        .resolve(
          input({
            routeIntent: explicitAccount("acct-a"),
          }),
        )
        .pipe(Effect.flip),
    )

    expect(result._tag).toBe("ProviderRouteResolution.StaleRoute")
    expect(routes.current()?.routeKind).toBe("public")
  })

  test("Auto initial bind race compiles the committed winner instead of overwriting it", async () => {
    const winner = binding({
      kind: "account",
      providerID,
      accountID: "acct-b",
      credentialHandle: "cred_b",
      mode: "concentrate",
    })
    const h = harness({
      revisions: { cred_b: 12 },
      commit: (_request, routes) => {
        routes.set(winner)
        return { state: "winner", binding: winner }
      },
    })

    const result = await run(
      h.resolver.resolve(
        input({
          freeRoutePreference: "account-first",
          mode: "concentrate",
        }),
      ),
    )

    expect(result.lease.route).toEqual({
      kind: "account",
      providerID,
      accountID: "acct-b",
      credentialHandle: "cred_b",
      credentialRevision: 12,
    })
    expect(result.lease.routeRevision).toBe(1)
    expect(h.commits).toHaveLength(1)
    expect(h.routes.calls.bind).toBe(0)
    expect(h.routes.calls.cas).toBe(0)
  })

  test("credential revision changes lease/client identity without rebinding route revision", async () => {
    let revision = 2
    const initial = binding({
      kind: "account",
      providerID,
      accountID: "acct-a",
      credentialHandle: "cred_a",
      mode: "concentrate",
    })
    const routes = memoryRoutes(initial)
    const resolver = ProviderRouteResolution.make({
      routes: routes.service,
      commitAccountSelection: () => Effect.succeed({ state: "no-eligible" } as const),
      resolveCredentialRevision: () => Effect.succeed(revision),
    })

    const first = await run(resolver.resolve(input({ mode: "concentrate" })))
    revision = 3
    const second = await run(resolver.resolve(input({ mode: "concentrate" })))

    expect(first.lease.routeRevision).toBe(1)
    expect(second.lease.routeRevision).toBe(1)
    expect(first.clientRouteIdentity).not.toEqual(second.clientRouteIdentity)
    expect(first.lease.route.kind).toBe("account")
    expect(second.lease.route.kind).toBe("account")
    if (first.lease.route.kind !== "account" || second.lease.route.kind !== "account") return
    expect(first.lease.route.credentialRevision).toBe(2)
    expect(second.lease.route.credentialRevision).toBe(3)
    expect(routes.calls.cas).toBe(0)
  })

  test("provider mismatch is rejected before compiling a committed route", async () => {
    const h = harness({
      initial: binding({ kind: "public", providerID: "other-provider" }),
    })
    const result = await run(h.resolver.resolve(input()).pipe(Effect.flip))

    expect(result._tag).toBe("ProviderRouteResolution.ProviderMismatch")
    if (result._tag !== "ProviderRouteResolution.ProviderMismatch") return
    expect(result.expectedProviderID).toBe(providerID)
    expect(result.actualProviderID).toBe("other-provider")
  })

  test("lease and attribution contain no credential secret, label, email, or Authorization fields", async () => {
    const h = harness({
      initial: binding({
        kind: "account",
        providerID,
        accountID: "acct-a",
        credentialHandle: "cred_a",
        mode: "concentrate",
      }),
      revisions: { cred_a: 8 },
    })
    const result = await run(h.resolver.resolve(input({ mode: "concentrate" })))
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("cred_a")
    expect(serialized).toContain('"accountID":"acct-a"')
    expect(serialized).not.toContain("access")
    expect(serialized).not.toContain("refresh")
    expect(serialized).not.toContain("Authorization")
    expect(serialized).not.toContain("email")
    expect(serialized).not.toContain("label")
  })
})
