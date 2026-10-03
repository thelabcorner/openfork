import { describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import {
  ProviderRouteAccountStatsTable,
  ProviderRouteBindingTable,
  ProviderRoutePolicyCursorTable,
} from "@opencode-ai/core/provider-route.sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { tmpdir } from "../fixture/tmpdir"

const providerID = "opencode"
const affinityDomain = "opencode-hosted"
const projectID = ProjectV2.ID.global
const projectDirectory = AbsolutePath.make("/provider-route-policy")
const sessionDirectory = AbsolutePath.make("/provider-route-policy/workspace")

const nodes = () => LayerNode.group([Database.node, ProviderRoute.node])

function graph(databasePath: string) {
  return AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(databasePath)]])
}

function run<A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, ProviderRoute.Service | Database.Service>,
) {
  return Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(graph(databasePath))))
}

const seedSessions = (...sessionIDs: readonly SessionSchema.ID[]) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: projectDirectory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    for (const sessionID of sessionIDs) {
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: sessionID,
          directory: sessionDirectory,
          title: "Provider route atomic policy test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  })

function candidate(
  accountID: string,
  credentialHandle: string,
  overrides: Partial<ProviderRoute.AccountCommitInput["candidates"][number]> = {},
): ProviderRoute.AccountCommitInput["candidates"][number] {
  return {
    providerID,
    accountID,
    credentialHandle,
    admissible: true,
    healthRank: 0,
    ...overrides,
  }
}

function initial(
  sessionID: SessionSchema.ID,
  candidates: ProviderRoute.AccountCommitInput["candidates"],
  overrides: Partial<Omit<Extract<ProviderRoute.AccountCommitInput, { reason: "initial" }>, "sessionID" | "candidates" | "reason">> = {},
): Extract<ProviderRoute.AccountCommitInput, { reason: "initial" }> {
  return {
    sessionID,
    providerID,
    affinityDomain,
    mode: "session-round-robin",
    candidates,
    excludedCredentialHandles: new Set(),
    now: 1_000,
    reason: "initial",
    ...overrides,
  }
}

const snapshot = (domain = affinityDomain) =>
  Effect.gen(function* () {
    const { readDb } = yield* Database.Service
    const cursor = yield* readDb
      .select()
      .from(ProviderRoutePolicyCursorTable)
      .where(
        and(
          eq(ProviderRoutePolicyCursorTable.provider_id, providerID),
          eq(ProviderRoutePolicyCursorTable.affinity_domain, domain),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    const stats = yield* readDb
      .select()
      .from(ProviderRouteAccountStatsTable)
      .where(
        and(
          eq(ProviderRouteAccountStatsTable.provider_id, providerID),
          eq(ProviderRouteAccountStatsTable.affinity_domain, domain),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const bindings = yield* readDb
      .select()
      .from(ProviderRouteBindingTable)
      .where(eq(ProviderRouteBindingTable.affinity_domain, domain))
      .all()
      .pipe(Effect.orDie)
    return { cursor, stats, bindings }
  })

describe("ProviderRoute atomic account policy commit", () => {
  test("same-session initial race is first-commit-wins and advances policy exactly once", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "same-session-race.sqlite")
    const sessionID = SessionSchema.ID.make("ses_provider_policy_same_session")
    await run(databasePath, seedSessions(sessionID))

    const candidates = [candidate("acct-a", "cred_a"), candidate("acct-b", "cred_b")]
    const commit = () =>
      run(
        databasePath,
        Effect.gen(function* () {
          return yield* (yield* ProviderRoute.Service).commitAccountSelection(initial(sessionID, candidates))
        }),
      )

    const results = await Promise.all([commit(), commit()])
    expect(results.filter((result) => result.state === "committed")).toHaveLength(1)
    expect(results.filter((result) => result.state === "winner")).toHaveLength(1)

    const state = await run(databasePath, snapshot())
    expect(state.cursor).toMatchObject({ epoch: 1, last_assigned_handle: "cred_a" })
    expect(state.stats).toHaveLength(1)
    expect(state.stats[0]).toMatchObject({
      account_id: "acct-a",
      assignment_count: 1,
      last_assigned_at: 1_000,
    })
    expect(state.bindings).toHaveLength(1)
    expect(state.bindings[0]).toMatchObject({
      route_kind: "account",
      account_id: "acct-a",
      credential_handle: "cred_a",
      assignment_epoch: 1,
      route_revision: 1,
    })

    const retry = await commit()
    expect(retry.state).toBe("winner")
    const afterRetry = await run(databasePath, snapshot())
    expect(afterRetry.cursor?.epoch).toBe(1)
    expect(afterRetry.stats[0]?.assignment_count).toBe(1)
  })

  test("simultaneous binders cannot oversubscribe one-account capacity", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "capacity-race.sqlite")
    const sessionA = SessionSchema.ID.make("ses_provider_policy_capacity_a")
    const sessionB = SessionSchema.ID.make("ses_provider_policy_capacity_b")
    await run(databasePath, seedSessions(sessionA, sessionB))

    const only = [candidate("acct-cap", "cred_cap", { maxSessionBindings: 1 })]
    const commit = (sessionID: SessionSchema.ID) =>
      run(
        databasePath,
        Effect.gen(function* () {
          return yield* (yield* ProviderRoute.Service).commitAccountSelection(initial(sessionID, only))
        }),
      )

    const results = await Promise.all([commit(sessionA), commit(sessionB)])
    expect(results.filter((result) => result.state === "committed")).toHaveLength(1)
    expect(results.filter((result) => result.state === "no-eligible")).toHaveLength(1)

    const state = await run(databasePath, snapshot())
    expect(state.bindings.filter((row) => row.route_kind === "account")).toHaveLength(1)
    expect(state.cursor?.epoch).toBe(1)
    expect(state.stats).toEqual([
      expect.objectContaining({
        account_id: "acct-cap",
        assignment_count: 1,
      }),
    ])
  })

  test("failed-handle failover commits once while stale retry advances nothing", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "failover.sqlite")
    const sessionID = SessionSchema.ID.make("ses_provider_policy_failover")
    await run(databasePath, seedSessions(sessionID))

    const candidates = [candidate("acct-a", "cred_a"), candidate("acct-b", "cred_b")]
    const first = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(
          initial(sessionID, candidates, { mode: "session-round-robin" }),
        )
      }),
    )
    expect(first.state).toBe("committed")
    if (first.state !== "committed") throw new Error("expected initial account commit")

    const failoverInput: Extract<ProviderRoute.AccountCommitInput, { reason: "failover" }> = {
      sessionID,
      providerID,
      affinityDomain,
      mode: "session-round-robin",
      candidates,
      excludedCredentialHandles: new Set(["cred_a"]),
      now: 2_000,
      reason: "failover",
      current: first.binding,
    }
    const failover = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(failoverInput)
      }),
    )
    expect(failover.state).toBe("committed")
    if (failover.state !== "committed") throw new Error("expected failover commit")
    expect(failover.binding).toMatchObject({
      accountID: "acct-b",
      credentialHandle: "cred_b",
      routeRevision: 2,
      assignmentEpoch: 2,
      reason: "failover",
    })

    const staleRetry = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(failoverInput)
      }),
    )
    expect(staleRetry).toEqual({ state: "stale" })

    const state = await run(databasePath, snapshot())
    expect(state.cursor).toMatchObject({ epoch: 2, last_assigned_handle: "cred_b" })
    expect(
      state.stats
        .map((row) => [row.account_id, row.assignment_count] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ).toEqual([
      ["acct-a", 1],
      ["acct-b", 1],
    ])
  })

  test("round-robin cursor and stable-account statistics survive new connections and credential-row replacement", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "restart.sqlite")
    const sessionA = SessionSchema.ID.make("ses_provider_policy_restart_a")
    const sessionB = SessionSchema.ID.make("ses_provider_policy_restart_b")
    const sessionC = SessionSchema.ID.make("ses_provider_policy_restart_c")
    await run(databasePath, seedSessions(sessionA, sessionB, sessionC))

    const ring = [candidate("acct-a", "cred_a"), candidate("acct-b", "cred_b")]
    const commitInitial = (sessionID: SessionSchema.ID, candidates: readonly ProviderRoute.AccountCommitInput["candidates"][number][]) =>
      run(
        databasePath,
        Effect.gen(function* () {
          return yield* (yield* ProviderRoute.Service).commitAccountSelection(initial(sessionID, candidates))
        }),
      )

    const first = await commitInitial(sessionA, ring)
    expect(first.state).toBe("committed")
    const second = await commitInitial(sessionB, ring)
    expect(second.state).toBe("committed")
    if (first.state !== "committed" || second.state !== "committed") {
      throw new Error("expected first two round-robin commits")
    }
    expect(first.binding.credentialHandle).toBe("cred_a")
    expect(second.binding.credentialHandle).toBe("cred_b")

    // Same remote ProviderAccount, replacement local Credential.ID.
    const replacement = [
      candidate("acct-a", "cred_a_replacement"),
      candidate("acct-b", "cred_b", { admissible: false, ineligibleReason: "disabled" }),
    ]
    const third = await commitInitial(sessionC, replacement)
    expect(third.state).toBe("committed")
    if (third.state !== "committed") throw new Error("expected replacement-handle commit")
    expect(third.binding).toMatchObject({
      accountID: "acct-a",
      credentialHandle: "cred_a_replacement",
      assignmentEpoch: 3,
    })

    const state = await run(databasePath, snapshot())
    expect(state.cursor).toMatchObject({ epoch: 3, last_assigned_handle: "cred_a_replacement" })
    const accountA = state.stats.find((row) => row.account_id === "acct-a")
    expect(accountA?.assignment_count).toBe(2)
    expect(state.stats.find((row) => row.account_id === "acct-b")?.assignment_count).toBe(1)
  })

  test("policy cursor, history, and capacity are isolated by affinity domain", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "domain-isolation.sqlite")
    const sessionA = SessionSchema.ID.make("ses_provider_policy_domain_a")
    const sessionB = SessionSchema.ID.make("ses_provider_policy_domain_b")
    await run(databasePath, seedSessions(sessionA, sessionB))
    const only = [candidate("acct-a", "cred_a", { maxSessionBindings: 1 })]

    const first = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(initial(sessionA, only))
      }),
    )
    const secondDomain = "opencode-maintenance"
    const second = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(
          initial(sessionB, only, { affinityDomain: secondDomain }),
        )
      }),
    )
    expect(first.state).toBe("committed")
    expect(second.state).toBe("committed")

    const stateA = await run(databasePath, snapshot())
    const stateB = await run(databasePath, snapshot(secondDomain))
    expect(stateA.cursor?.epoch).toBe(1)
    expect(stateB.cursor?.epoch).toBe(1)
    expect(stateA.stats[0]?.assignment_count).toBe(1)
    expect(stateB.stats[0]?.assignment_count).toBe(1)
  })

  test("an existing Public winner advances no account policy state and secret extras are never persisted", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "public-secret.sqlite")
    const publicSession = SessionSchema.ID.make("ses_provider_policy_public")
    const accountSession = SessionSchema.ID.make("ses_provider_policy_secret")
    await run(databasePath, seedSessions(publicSession, accountSession))

    await run(
      databasePath,
      Effect.gen(function* () {
        yield* (yield* ProviderRoute.Service).bindIfAbsent({
          sessionID: publicSession,
          affinityDomain,
          route: { kind: "public", providerID },
          assignmentEpoch: 1,
          reason: "explicit",
          assignedAt: 500,
        })
      }),
    )

    const publicWinner = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(
          initial(publicSession, [candidate("acct-a", "cred_a")]),
        )
      }),
    )
    expect(publicWinner.state).toBe("winner")
    if (publicWinner.state !== "winner") throw new Error("expected Public winner")
    expect(publicWinner.binding.routeKind).toBe("public")

    const before = await run(databasePath, snapshot())
    expect(before.cursor).toBeUndefined()
    expect(before.stats).toEqual([])

    const secretCandidate = {
      ...candidate("acct-a", "cred_a"),
      access: "SECRET_ACCESS_SHOULD_NOT_PERSIST",
      refresh: "SECRET_REFRESH_SHOULD_NOT_PERSIST",
      Authorization: "Bearer SECRET_ACCESS_SHOULD_NOT_PERSIST",
      headers: { authorization: "Bearer SECRET_ACCESS_SHOULD_NOT_PERSIST" },
    } as ProviderRoute.AccountCommitInput["candidates"][number]
    const committed = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(
          initial(accountSession, [secretCandidate]),
        )
      }),
    )
    expect(committed.state).toBe("committed")

    const after = await run(databasePath, snapshot())
    const serialized = JSON.stringify(after)
    expect(serialized).toContain("acct-a")
    expect(serialized).toContain("cred_a")
    expect(serialized).not.toContain("SECRET_ACCESS_SHOULD_NOT_PERSIST")
    expect(serialized).not.toContain("SECRET_REFRESH_SHOULD_NOT_PERSIST")
    expect(serialized).not.toContain("Authorization")
    expect(serialized).not.toContain("headers")
  })

  test("real durable commit composes directly into the immutable route resolver lease", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "resolver-composition.sqlite")
    const sessionID = SessionSchema.ID.make("ses_provider_policy_resolver_composition")
    await run(databasePath, seedSessions(sessionID))

    const result = await run(
      databasePath,
      Effect.gen(function* () {
        const routes = yield* ProviderRoute.Service
        const resolver = ProviderRouteResolution.make({
          routes,
          commitAccountSelection: routes.commitAccountSelection,
          resolveCredentialRevision: ({ credentialHandle }) =>
            Effect.succeed(credentialHandle === "cred_a" ? 7 : undefined),
        })
        return yield* resolver.resolve({
          sessionID,
          providerID,
          affinityDomain,
          routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
          mode: "session-round-robin",
          freeRoutePreference: "account-first",
          allowPublic: false,
          publicEligible: false,
          candidates: [candidate("acct-a", "cred_a")],
          now: 4_000,
        })
      }),
    )

    expect(result.lease).toEqual({
      sessionID,
      affinityDomain,
      routeRevision: 1,
      route: {
        kind: "account",
        providerID,
        accountID: "acct-a",
        credentialHandle: "cred_a",
        credentialRevision: 7,
      },
    })
    expect(result.attribution).toEqual({
      sessionID,
      affinityDomain,
      providerID,
      routeRevision: 1,
      routeKind: "account",
      accountID: "acct-a",
    })
    expect(result.clientRouteIdentity).toEqual({
      providerID,
      route: {
        kind: "account",
        credentialHandle: "cred_a",
        credentialRevision: 7,
      },
    })
  })
})
