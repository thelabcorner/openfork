import { describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderAccountPolicy } from "@opencode-ai/core/provider-account-policy"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import {
  ProviderRouteAccountStatsTable,
  ProviderRouteBindingTable,
  ProviderRoutePolicyCursorTable,
} from "@opencode-ai/core/provider-route.sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { tmpdir } from "../fixture/tmpdir"

const providerID = "opencode"
const affinityDomain = "opencode-hosted"
const projectID = ProjectV2.ID.global
const projectDirectory = AbsolutePath.make("/provider-route-policy-project")
const sessionDirectory = AbsolutePath.make("/provider-route-policy-project/workspace")

const nodes = () => LayerNode.group([Database.node, ProviderRoute.node])
const graphFor = (databasePath: string) =>
  AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(databasePath)]])

const run = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, ProviderRoute.Service | Database.Service>,
) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(graphFor(databasePath))))

const seedSessions = (sessionIDs: readonly SessionSchema.ID[]) =>
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

const candidate = (
  handle: string,
  overrides: Partial<ProviderAccountPolicy.Candidate> = {},
): ProviderAccountPolicy.Candidate => ({
  providerID,
  accountID: `acct-${handle}`,
  credentialHandle: handle,
  admissible: true,
  healthRank: 0,
  ...overrides,
})

const initial = (
  sessionID: SessionSchema.ID,
  candidates: readonly ProviderAccountPolicy.Candidate[],
  overrides: Partial<Omit<ProviderRoute.AccountCommitInput, "reason" | "sessionID" | "candidates">> = {},
): ProviderRoute.AccountCommitInput => ({
  reason: "initial",
  sessionID,
  providerID,
  affinityDomain,
  mode: "session-round-robin",
  candidates,
  excludedCredentialHandles: new Set(),
  now: 100,
  ...overrides,
})

const policyState = (databasePath: string) =>
  run(
    databasePath,
    Effect.gen(function* () {
      const { readDb } = yield* Database.Service
      const cursors = yield* readDb
        .select()
        .from(ProviderRoutePolicyCursorTable)
        .all()
        .pipe(Effect.orDie)
      const stats = yield* readDb
        .select()
        .from(ProviderRouteAccountStatsTable)
        .all()
        .pipe(Effect.orDie)
      const routes = yield* readDb
        .select()
        .from(ProviderRouteBindingTable)
        .all()
        .pipe(Effect.orDie)
      return { cursors, stats, routes }
    }),
  )

describe("ProviderRoute atomic account policy", () => {
  test("two independent connections racing initial Auto bind commit one route and one policy transition", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "atomic-initial.sqlite")
    const sessionID = SessionSchema.ID.make("ses_route_atomic_initial")
    await run(databasePath, seedSessions([sessionID]))

    const race = (entry: ProviderAccountPolicy.Candidate) =>
      run(
        databasePath,
        Effect.gen(function* () {
          const routes = yield* ProviderRoute.Service
          return yield* routes.commitAccountSelection(initial(sessionID, [entry]))
        }),
      )

    const [left, right] = await Promise.all([
      race(candidate("cred-a", { accountID: "acct-a" })),
      race(candidate("cred-b", { accountID: "acct-b" })),
    ])

    expect([left.state, right.state].sort()).toEqual(["committed", "winner"])

    const durable = await policyState(databasePath)
    expect(durable.routes).toHaveLength(1)
    expect(durable.cursors).toHaveLength(1)
    expect(durable.cursors[0]?.epoch).toBe(1)
    expect(durable.stats).toHaveLength(1)
    expect(durable.stats[0]?.assignment_count).toBe(1)

    const committed = left.state === "committed" ? left.binding : right.state === "committed" ? right.binding : undefined
    expect(committed).toBeDefined()
    if (!committed) throw new Error("expected exactly one committed account route")
    expect(durable.routes[0]?.account_id).toBe(committed.accountID)
    expect(durable.cursors[0]?.last_assigned_handle).toBe(committed.credentialHandle)
  })

  test("idempotent initial retry observes the winner without advancing cursor or assignment count", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "atomic-idempotent.sqlite")
    const sessionID = SessionSchema.ID.make("ses_route_atomic_idempotent")
    const only = candidate("cred-a", { accountID: "acct-a" })
    await run(databasePath, seedSessions([sessionID]))

    const first = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(initial(sessionID, [only]))
      }),
    )
    expect(first.state).toBe("committed")
    const before = await policyState(databasePath)

    const retry = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(
          initial(sessionID, [only], { now: 999 }),
        )
      }),
    )
    expect(retry.state).toBe("winner")
    expect(await policyState(databasePath)).toEqual(before)
  })

  test("stale failover cannot overwrite the winner or advance cursor/stat state", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "atomic-stale.sqlite")
    const sessionID = SessionSchema.ID.make("ses_route_atomic_stale")
    const a = candidate("cred-a", { accountID: "acct-a" })
    const b = candidate("cred-b", { accountID: "acct-b" })
    const c = candidate("cred-c", { accountID: "acct-c" })
    await run(databasePath, seedSessions([sessionID]))

    const first = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(initial(sessionID, [a, b, c]))
      }),
    )
    if (first.state !== "committed") throw new Error("expected initial account commit")

    const successful = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection({
          reason: "failover",
          sessionID,
          providerID,
          affinityDomain,
          mode: "session-round-robin",
          candidates: [a, b, c],
          excludedCredentialHandles: new Set([first.binding.credentialHandle]),
          current: first.binding,
          now: 200,
        })
      }),
    )
    expect(successful.state).toBe("committed")
    const afterWinner = await policyState(databasePath)

    const stale = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection({
          reason: "failover",
          sessionID,
          providerID,
          affinityDomain,
          mode: "session-round-robin",
          candidates: [a, b, c],
          excludedCredentialHandles: new Set([first.binding.credentialHandle]),
          current: first.binding,
          now: 300,
        })
      }),
    )
    expect(stale).toEqual({ state: "stale" })
    expect(await policyState(databasePath)).toEqual(afterWinner)
  })

  test("simultaneous sessions cannot oversubscribe a hard account capacity", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "atomic-capacity.sqlite")
    const sessionA = SessionSchema.ID.make("ses_route_capacity_a")
    const sessionB = SessionSchema.ID.make("ses_route_capacity_b")
    const capped = candidate("cred-capped", {
      accountID: "acct-capped",
      maxSessionBindings: 1,
    })
    await run(databasePath, seedSessions([sessionA, sessionB]))

    const assign = (sessionID: SessionSchema.ID) =>
      run(
        databasePath,
        Effect.gen(function* () {
          return yield* (yield* ProviderRoute.Service).commitAccountSelection(initial(sessionID, [capped]))
        }),
      )

    const results = await Promise.all([assign(sessionA), assign(sessionB)])
    expect(results.filter((result) => result.state === "committed")).toHaveLength(1)
    expect(results.filter((result) => result.state === "no-eligible")).toHaveLength(1)

    const durable = await policyState(databasePath)
    expect(durable.routes).toHaveLength(1)
    expect(durable.stats).toHaveLength(1)
    expect(durable.stats[0]?.assignment_count).toBe(1)
    expect(durable.cursors[0]?.epoch).toBe(1)
  })

  test("an existing Public route wins Auto account contention without creating account policy state", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "atomic-public.sqlite")
    const sessionID = SessionSchema.ID.make("ses_route_public_winner")
    await run(databasePath, seedSessions([sessionID]))

    await run(
      databasePath,
      Effect.gen(function* () {
        const routes = yield* ProviderRoute.Service
        return yield* routes.bindIfAbsent({
          sessionID,
          affinityDomain,
          route: { kind: "public", providerID },
          assignmentEpoch: 1,
          reason: "initial",
          assignedAt: 50,
        })
      }),
    )

    const attempt = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(
          initial(sessionID, [candidate("cred-a", { accountID: "acct-a" })]),
        )
      }),
    )
    expect(attempt.state).toBe("winner")
    if (attempt.state !== "winner") throw new Error("expected existing route winner")
    expect(attempt.binding.routeKind).toBe("public")

    const durable = await policyState(databasePath)
    expect(durable.routes).toHaveLength(1)
    expect(durable.routes[0]?.route_kind).toBe("public")
    expect(durable.cursors).toHaveLength(0)
    expect(durable.stats).toHaveLength(0)
  })

  test("restart preserves secret-free cursor/stats and stable account history across credential-handle replacement", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "atomic-restart.sqlite")
    const sessionID = SessionSchema.ID.make("ses_route_atomic_restart")
    const oldHandle = candidate("cred-old", { accountID: "acct-stable" })
    const newHandle = candidate("cred-new", { accountID: "acct-stable" })
    ;(oldHandle as ProviderAccountPolicy.Candidate & {
      access?: string
      refresh?: string
      headers?: Record<string, string>
    }).access = "SECRET_ACCESS"
    ;(oldHandle as ProviderAccountPolicy.Candidate & {
      refresh?: string
      headers?: Record<string, string>
    }).refresh = "SECRET_REFRESH"
    ;(oldHandle as ProviderAccountPolicy.Candidate & {
      headers?: Record<string, string>
    }).headers = { Authorization: "Bearer SECRET_HEADER" }

    await run(databasePath, seedSessions([sessionID]))
    const first = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(initial(sessionID, [oldHandle]))
      }),
    )
    if (first.state !== "committed") throw new Error("expected initial account commit")

    const replaced = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection({
          reason: "failover",
          sessionID,
          providerID,
          affinityDomain,
          mode: "session-round-robin",
          candidates: [newHandle],
          excludedCredentialHandles: new Set([oldHandle.credentialHandle]),
          current: first.binding,
          now: 200,
        })
      }),
    )
    expect(replaced.state).toBe("committed")
    if (replaced.state !== "committed") throw new Error("expected replacement account commit")
    expect(replaced.binding.accountID).toBe("acct-stable")
    expect(replaced.binding.credentialHandle).toBe("cred-new")
    expect(replaced.binding.routeRevision).toBe(2)

    // A fresh graph/new SQLite connection must see exactly the same durable state.
    const restarted = await policyState(databasePath)
    expect(restarted.cursors[0]?.epoch).toBe(2)
    expect(restarted.cursors[0]?.last_assigned_handle).toBe("cred-new")
    expect(restarted.stats).toHaveLength(1)
    expect(restarted.stats[0]?.account_id).toBe("acct-stable")
    expect(restarted.stats[0]?.assignment_count).toBe(2)

    const serialized = JSON.stringify(restarted)
    expect(serialized).not.toContain("SECRET_ACCESS")
    expect(serialized).not.toContain("SECRET_REFRESH")
    expect(serialized).not.toContain("SECRET_HEADER")
    expect(serialized).not.toContain("Authorization")

    const current = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).get(sessionID, affinityDomain)
      }),
    )
    expect(current).toEqual(replaced.binding)
  })

  test("assignment history is affinity-scoped while active capacity is enforced within that routing domain", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "atomic-affinity.sqlite")
    const sessionA = SessionSchema.ID.make("ses_route_affinity_a")
    const sessionB = SessionSchema.ID.make("ses_route_affinity_b")
    const shared = candidate("cred-shared", { accountID: "acct-shared", maxSessionBindings: 1 })
    await run(databasePath, seedSessions([sessionA, sessionB]))

    const domainA = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(
          initial(sessionA, [shared], { affinityDomain: "hosted-a" }),
        )
      }),
    )
    const domainB = await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(
          initial(sessionB, [shared], { affinityDomain: "hosted-b" }),
        )
      }),
    )
    expect(domainA.state).toBe("committed")
    expect(domainB.state).toBe("committed")

    const durable = await policyState(databasePath)
    expect(durable.cursors.map((row) => row.affinity_domain).sort()).toEqual(["hosted-a", "hosted-b"])
    expect(durable.stats.map((row) => [row.affinity_domain, row.assignment_count]).sort()).toEqual([
      ["hosted-a", 1],
      ["hosted-b", 1],
    ])
  })

  test("raw durable policy rows contain only safe identity/counter fields", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "atomic-shape.sqlite")
    const sessionID = SessionSchema.ID.make("ses_route_atomic_shape")
    await run(databasePath, seedSessions([sessionID]))
    await run(
      databasePath,
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).commitAccountSelection(
          initial(sessionID, [candidate("cred-safe", { accountID: "acct-safe" })]),
        )
      }),
    )

    const durable = await policyState(databasePath)
    expect(Object.keys(durable.cursors[0] ?? {}).sort()).toEqual([
      "affinity_domain",
      "epoch",
      "last_assigned_handle",
      "provider_id",
    ])
    expect(Object.keys(durable.stats[0] ?? {}).sort()).toEqual([
      "account_id",
      "affinity_domain",
      "assignment_count",
      "last_assigned_at",
      "provider_id",
    ])

    const accountRoute = durable.routes.find(
      (row) =>
        row.provider_id === providerID &&
        row.affinity_domain === affinityDomain &&
        row.route_kind === "account",
    )
    expect(accountRoute?.account_id).toBe("acct-safe")
    expect(accountRoute?.credential_handle).toBe("cred-safe")

    const matchingStats = durable.stats.find(
      (row) =>
        row.provider_id === providerID &&
        row.affinity_domain === affinityDomain &&
        row.account_id === "acct-safe",
    )
    expect(matchingStats?.assignment_count).toBe(1)

    const matchingCursor = durable.cursors.find(
      (row) =>
        row.provider_id === providerID &&
        row.affinity_domain === affinityDomain,
    )
    expect(matchingCursor?.epoch).toBe(1)

    // The predicates above also exercise the composite durable owner explicitly.
    expect(
      durable.routes.filter(
        (row) =>
          row.provider_id === providerID &&
          row.affinity_domain === affinityDomain &&
          row.account_id === "acct-safe",
      ),
    ).toHaveLength(1)
  })
})
