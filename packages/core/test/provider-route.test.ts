import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { join } from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import { ProviderRouteBindingTable } from "@opencode-ai/core/provider-route.sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const nodes = () => LayerNode.group([Database.node, ProviderRoute.node])
const layer = AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(":memory:")]])
const it = testEffect(layer)

const projectID = ProjectV2.ID.global
const projectDirectory = AbsolutePath.make("/provider-route-project")
const sessionDirectory = AbsolutePath.make("/provider-route-project/workspace")

const seedSession = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: projectDirectory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: sessionID,
        directory: sessionDirectory,
        title: "Provider route ledger test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const publicBinding = (sessionID: SessionSchema.ID, overrides: Partial<ProviderRoute.BindInput> = {}) =>
  ({
    sessionID,
    affinityDomain: "opencode-hosted",
    route: { kind: "public", providerID: "opencode" },
    assignmentEpoch: 1,
    reason: "initial",
    assignedAt: 100,
    ...overrides,
  }) satisfies ProviderRoute.BindInput

const accountRoute = (accountID: string, credentialHandle: string): ProviderRoute.Route => ({
  kind: "account",
  providerID: "opencode",
  accountID,
  credentialHandle,
  mode: "session-round-robin",
  pin: "soft",
})

describe("ProviderRoute durable ledger", () => {
  it.effect("binds once per Session/domain and preserves the first committed route", () =>
    Effect.gen(function* () {
      const routes = yield* ProviderRoute.Service
      const sessionID = SessionSchema.ID.make("ses_provider_route_bind_once")
      yield* seedSession(sessionID)

      const first = yield* routes.bindIfAbsent(publicBinding(sessionID))
      expect(first).toEqual({
        sessionID,
        affinityDomain: "opencode-hosted",
        providerID: "opencode",
        routeKind: "public",
        routeRevision: 1,
        assignedAt: 100,
        assignmentEpoch: 1,
        reason: "initial",
      })

      const competing = yield* routes.bindIfAbsent({
        sessionID,
        affinityDomain: "opencode-hosted",
        route: accountRoute("acct_loser", "cred_loser"),
        assignmentEpoch: 2,
        reason: "explicit",
        assignedAt: 200,
      })

      expect(competing).toEqual(first)
      expect(yield* routes.get(sessionID, "opencode-hosted")).toEqual(first)

      const secondDomain = yield* routes.bindIfAbsent({
        ...publicBinding(sessionID),
        affinityDomain: "another-provider-domain",
        route: { kind: "public", providerID: "another-provider" },
      })
      expect(secondDomain.affinityDomain).toBe("another-provider-domain")
      expect(secondDomain.providerID).toBe("another-provider")
    }),
  )

  it.effect("rebinds through exact revision CAS and rejects a stale owner", () =>
    Effect.gen(function* () {
      const routes = yield* ProviderRoute.Service
      const sessionID = SessionSchema.ID.make("ses_provider_route_cas")
      yield* seedSession(sessionID)
      const initial = yield* routes.bindIfAbsent(publicBinding(sessionID))

      const rebound = yield* routes.compareAndSwap({
        sessionID,
        affinityDomain: initial.affinityDomain,
        expectedRevision: initial.routeRevision,
        route: accountRoute("acct_a", "cred_a"),
        assignmentEpoch: 2,
        reason: "explicit",
        assignedAt: 200,
      })

      expect(rebound).toEqual({
        sessionID,
        affinityDomain: "opencode-hosted",
        providerID: "opencode",
        routeKind: "account",
        accountID: "acct_a",
        credentialHandle: "cred_a",
        mode: "session-round-robin",
        pin: "soft",
        routeRevision: 2,
        assignedAt: 200,
        assignmentEpoch: 2,
        reason: "explicit",
      })

      const stale = yield* routes.compareAndSwap({
        sessionID,
        affinityDomain: initial.affinityDomain,
        expectedRevision: initial.routeRevision,
        route: accountRoute("acct_stale", "cred_stale"),
        assignmentEpoch: 3,
        reason: "failover",
        assignedAt: 300,
      })
      expect(stale).toBeUndefined()
      expect(yield* routes.get(sessionID, initial.affinityDomain)).toEqual(rebound)
    }),
  )

  it.effect("returns typed validation errors before persistence", () =>
    Effect.gen(function* () {
      const routes = yield* ProviderRoute.Service
      const missingSessionID = SessionSchema.ID.make("ses_provider_route_missing")

      const missing = yield* routes.bindIfAbsent(publicBinding(missingSessionID)).pipe(Effect.flip)
      expect(missing._tag).toBe("ProviderRoute.InvalidBindingError")
      expect(missing.field).toBe("sessionID")

      const sessionID = SessionSchema.ID.make("ses_provider_route_validation")
      yield* seedSession(sessionID)
      const malformed = yield* routes
        .bindIfAbsent({
          sessionID,
          affinityDomain: "opencode-hosted",
          route: accountRoute("acct_valid", "   "),
          assignmentEpoch: 1,
          reason: "explicit",
        })
        .pipe(Effect.flip)
      expect(malformed._tag).toBe("ProviderRoute.InvalidBindingError")
      expect(malformed.field).toBe("credentialHandle")
    }),
  )

  it.effect("enforces public/account identity invariants in SQLite", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_provider_route_constraints")
      yield* seedSession(sessionID)

      const invalidPublic = yield* db
        .insert(ProviderRouteBindingTable)
        .values({
          session_id: sessionID,
          affinity_domain: "invalid-public",
          provider_id: "opencode",
          route_kind: "public",
          account_id: "acct_should_not_exist",
          credential_handle: "cred_should_not_exist",
          route_revision: 1,
          assigned_at: 1,
          assignment_epoch: 1,
          reason: "initial",
        })
        .run()
        .pipe(Effect.orDie, Effect.exit)
      expect(Exit.isFailure(invalidPublic)).toBe(true)

      const invalidAccount = yield* db
        .insert(ProviderRouteBindingTable)
        .values({
          session_id: sessionID,
          affinity_domain: "invalid-account",
          provider_id: "opencode",
          route_kind: "account",
          account_id: "acct_without_handle",
          credential_handle: null,
          route_revision: 1,
          assigned_at: 1,
          assignment_epoch: 1,
          reason: "initial",
        })
        .run()
        .pipe(Effect.orDie, Effect.exit)
      expect(Exit.isFailure(invalidAccount)).toBe(true)
    }),
  )

  it.effect("survives Session archive and cascades only when the Session is deleted", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const routes = yield* ProviderRoute.Service
      const sessionID = SessionSchema.ID.make("ses_provider_route_lifecycle")
      yield* seedSession(sessionID)
      const bound = yield* routes.bindIfAbsent(publicBinding(sessionID))

      yield* db
        .update(SessionTable)
        .set({ time_archived: 1234 })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* routes.get(sessionID, bound.affinityDomain)).toEqual(bound)

      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      expect(yield* routes.get(sessionID, bound.affinityDomain)).toBeUndefined()
    }),
  )

  test("two independent SQLite connections cannot both win the same route revision", async () => {
    await using tmp = await tmpdir()
    const databasePath = join(tmp.path, "provider-route.sqlite")
    const graph = () => AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(databasePath)]])
    const run = <A, E>(effect: Effect.Effect<A, E, ProviderRoute.Service | Database.Service>) =>
      Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(graph())))

    const sessionID = SessionSchema.ID.make("ses_provider_route_cross_connection")
    const initial = await run(
      Effect.gen(function* () {
        yield* seedSession(sessionID)
        return yield* (yield* ProviderRoute.Service).bindIfAbsent(publicBinding(sessionID))
      }),
    )

    const rebind = (accountID: string, credentialHandle: string) =>
      run(
        Effect.gen(function* () {
          const routes = yield* ProviderRoute.Service
          return yield* routes.compareAndSwap({
            sessionID,
            affinityDomain: initial.affinityDomain,
            expectedRevision: initial.routeRevision,
            route: accountRoute(accountID, credentialHandle),
            assignmentEpoch: 2,
            reason: "failover",
            assignedAt: 200,
          })
        }),
      )

    const results = await Promise.all([rebind("acct_a", "cred_a"), rebind("acct_b", "cred_b")])
    expect(results.filter((result) => result !== undefined)).toHaveLength(1)
    expect(results.filter((result) => result === undefined)).toHaveLength(1)

    const current = await run(
      Effect.gen(function* () {
        return yield* (yield* ProviderRoute.Service).get(sessionID, initial.affinityDomain)
      }),
    )
    expect(current?.routeRevision).toBe(2)
    expect(current?.routeKind).toBe("account")
    if (current?.routeKind !== "account") throw new Error("expected account route after CAS winner")
    expect(["acct_a", "acct_b"]).toContain(current.accountID)
    expect(["cred_a", "cred_b"]).toContain(current.credentialHandle)
  })
})
