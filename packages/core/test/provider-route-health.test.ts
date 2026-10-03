import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderRouteHealth } from "@opencode-ai/core/provider-route-health"
import {
  ProviderAccountRouteHealthTable,
  ProviderPublicRouteHealthTable,
} from "@opencode-ai/core/provider-route-health.sql"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { tmpdir } from "./fixture/tmpdir"

const graph = (path: string) =>
  AppNodeBuilder.build(
    LayerNode.group([Database.node, ProviderRouteHealth.node]),
    [[Database.node, Database.layerFromPath(path)]],
  )

const run = <A, E>(
  path: string,
  effect: Effect.Effect<A, E, ProviderRouteHealth.Service | Database.Service>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(graph(path))))

const publicLease = (providerID = "opencode"): ProviderRouteResolution.ProviderRouteLease => ({
  sessionID: SessionSchema.ID.make("ses_health_public"),
  affinityDomain: "opencode-provider/opencode",
  routeRevision: 1,
  route: {
    kind: "public",
    providerID,
    routeID: providerID + ":public",
  },
})

const accountLease = (
  credentialRevision = 7,
  accountID = "acct-a",
): ProviderRouteResolution.ProviderRouteLease => ({
  sessionID: SessionSchema.ID.make("ses_health_account"),
  affinityDomain: "opencode-provider/opencode",
  routeRevision: 1,
  route: {
    kind: "account",
    providerID: "opencode",
    accountID,
    credentialHandle: "cred-local-opaque",
    credentialRevision,
  },
})

describe("ProviderRouteHealth", () => {
  test("persists known-expiry Public quota across fresh connections and expires without account contamination", async () => {
    await using dir = await tmpdir()
    const path = join(dir.path, "health.sqlite")

    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service
        yield* health.observeFailure({
          lease: publicLease(),
          modelID: "space-bunny-free",
          effect: "public-quota-exhausted",
          resetAt: 5_000,
          now: 1_000,
        })
        expect(
          yield* health.assessPublic({
            providerID: "opencode",
            modelID: "space-bunny-free",
            now: 2_000,
          }),
        ).toEqual({
          available: false,
          state: "quota-exhausted",
          resetAt: 5_000,
        })
      }),
    )

    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service
        expect(
          yield* health.assessPublic({
            providerID: "opencode",
            modelID: "space-bunny-free",
            now: 2_500,
          }),
        ).toEqual({
          available: false,
          state: "quota-exhausted",
          resetAt: 5_000,
        })
        expect(
          yield* health.assessAccount({
            providerID: "opencode",
            accountID: "acct-a",
            modelID: "space-bunny-free",
            credentialRevision: 7,
            now: 2_500,
          }),
        ).toEqual({
          admissible: true,
          healthRank: 0,
          state: "ready",
        })
        expect(
          yield* health.assessPublic({
            providerID: "opencode",
            modelID: "space-bunny-free",
            now: 5_001,
          }),
        ).toEqual({
          available: true,
          state: "ready",
        })
      }),
    )
  })

  test("keeps unknown-expiry Public and account cooldowns process-local only", async () => {
    await using dir = await tmpdir()
    const path = join(dir.path, "ephemeral.sqlite")

    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service
        yield* health.observeFailure({
          lease: publicLease(),
          modelID: "space-bunny-free",
          effect: "public-quota-exhausted",
          now: 10_000,
        })
        yield* health.observeFailure({
          lease: accountLease(),
          modelID: "deepseek-v4",
          effect: "account-cooldown",
          now: 10_000,
        })
        expect(
          (yield* health.assessPublic({
            providerID: "opencode",
            modelID: "space-bunny-free",
            now: 10_001,
          })).available,
        ).toBe(false)
        expect(
          (yield* health.assessAccount({
            providerID: "opencode",
            accountID: "acct-a",
            modelID: "deepseek-v4",
            credentialRevision: 7,
            now: 10_001,
          })).state,
        ).toBe("cooling-down")

        const { readDb } = yield* Database.Service
        expect(yield* readDb.select().from(ProviderPublicRouteHealthTable).all()).toEqual([])
        expect(yield* readDb.select().from(ProviderAccountRouteHealthTable).all()).toEqual([])
      }),
    )

    // A fresh service instance against the same durable DB has no unknown-expiry
    // state to recover: it was deliberately process-local.
    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service
        expect(
          yield* health.assessPublic({
            providerID: "opencode",
            modelID: "space-bunny-free",
            now: 10_002,
          }),
        ).toEqual({ available: true, state: "ready" })
        expect(
          yield* health.assessAccount({
            providerID: "opencode",
            accountID: "acct-a",
            modelID: "deepseek-v4",
            credentialRevision: 7,
            now: 10_002,
          }),
        ).toEqual({ admissible: true, healthRank: 0, state: "ready" })
      }),
    )
  })

  test("persists auth-invalid only for the exact credential revision and success cannot erase another generation", async () => {
    await using dir = await tmpdir()
    const path = join(dir.path, "revision.sqlite")

    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service
        yield* health.observeFailure({
          lease: accountLease(7),
          modelID: "deepseek-v4",
          effect: "account-auth-invalid",
          now: 20_000,
        })
      }),
    )

    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service
        expect(
          yield* health.assessAccount({
            providerID: "opencode",
            accountID: "acct-a",
            modelID: "deepseek-v4",
            credentialRevision: 7,
            now: 20_100,
          }),
        ).toEqual({
          admissible: false,
          healthRank: 1_000_000,
          state: "auth-invalid",
          ineligibleReason: "auth-invalid",
        })
        expect(
          yield* health.assessAccount({
            providerID: "opencode",
            accountID: "acct-a",
            modelID: "deepseek-v4",
            credentialRevision: 8,
            now: 20_100,
          }),
        ).toEqual({
          admissible: true,
          healthRank: 0,
          state: "ready",
        })

        // P2 revision advance makes the old auth failure inapplicable, but a
        // success from revision 8 must not erase revision 7's evidence. The
        // exact failed generation may still be concurrently observable.
        yield* health.observeSuccess({
          lease: accountLease(8),
          modelID: "deepseek-v4",
          now: 20_200,
        })
        const { readDb } = yield* Database.Service
        expect(
          (yield* readDb.select().from(ProviderAccountRouteHealthTable).all()).map((row) => ({
            state: row.state,
            credentialRevision: row.credential_revision,
          })),
        ).toEqual([
          {
            state: "auth-invalid",
            credentialRevision: 7,
          },
        ])

        yield* health.observeSuccess({
          lease: accountLease(7),
          modelID: "deepseek-v4",
          now: 20_300,
        })
        expect(yield* readDb.select().from(ProviderAccountRouteHealthTable).all()).toEqual([])
      }),
    )
  })

  test("persists known account quota independently from Public and success clears only the exact route/model", async () => {
    await using dir = await tmpdir()
    const path = join(dir.path, "account-quota.sqlite")

    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service
        yield* health.observeFailure({
          lease: accountLease(4, "acct-b"),
          modelID: "model-q",
          effect: "account-quota-exhausted",
          resetAt: 90_000,
          now: 30_000,
        })
        expect(
          yield* health.assessAccount({
            providerID: "opencode",
            accountID: "acct-b",
            modelID: "model-q",
            credentialRevision: 99,
            now: 30_001,
          }),
        ).toEqual({
          admissible: false,
          healthRank: 1_000_000,
          state: "quota-exhausted",
          ineligibleReason: "quota-exhausted",
          resetAt: 90_000,
        })
        expect(
          yield* health.assessPublic({
            providerID: "opencode",
            modelID: "model-q",
            now: 30_001,
          }),
        ).toEqual({ available: true, state: "ready" })

        yield* health.observeSuccess({
          lease: accountLease(5, "acct-b"),
          modelID: "model-q",
          now: 31_000,
        })
        expect(
          yield* health.assessAccount({
            providerID: "opencode",
            accountID: "acct-b",
            modelID: "model-q",
            credentialRevision: 5,
            now: 31_001,
          }),
        ).toEqual({ admissible: true, healthRank: 0, state: "ready" })
      }),
    )
  })

  test("stale success cannot clear a newer durable or process-local health observation", async () => {
    await using dir = await tmpdir()
    const path = join(dir.path, "stale-success.sqlite")

    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service

        yield* health.observeFailure({
          lease: publicLease(),
          modelID: "public-newer-failure",
          effect: "public-quota-exhausted",
          resetAt: 90_000,
          now: 70_000,
        })
        yield* health.observeSuccess({
          lease: publicLease(),
          modelID: "public-newer-failure",
          now: 69_999,
        })
        expect(
          yield* health.assessPublic({
            providerID: "opencode",
            modelID: "public-newer-failure",
            now: 70_001,
          }),
        ).toEqual({
          available: false,
          state: "quota-exhausted",
          resetAt: 90_000,
        })

        yield* health.observeFailure({
          lease: accountLease(),
          modelID: "account-newer-local-failure",
          effect: "account-cooldown",
          now: 70_000,
        })
        yield* health.observeSuccess({
          lease: accountLease(),
          modelID: "account-newer-local-failure",
          now: 69_999,
        })
        expect(
          yield* health.assessAccount({
            providerID: "opencode",
            accountID: "acct-a",
            modelID: "account-newer-local-failure",
            credentialRevision: 7,
            now: 70_001,
          }),
        ).toMatchObject({
          admissible: false,
          state: "cooling-down",
          ineligibleReason: "cooldown",
        })
      }),
    )
  })

  test("does not quarantine a route when an explicit trustworthy reset has already elapsed", async () => {
    await using dir = await tmpdir()
    const path = join(dir.path, "elapsed-reset.sqlite")

    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service
        yield* health.observeFailure({
          lease: publicLease(),
          modelID: "public-expired",
          effect: "public-quota-exhausted",
          resetAt: 59_999,
          now: 60_000,
        })
        yield* health.observeFailure({
          lease: accountLease(),
          modelID: "account-expired",
          effect: "account-cooldown",
          resetAt: 59_000,
          now: 60_000,
        })

        expect(
          yield* health.assessPublic({
            providerID: "opencode",
            modelID: "public-expired",
            now: 60_001,
          }),
        ).toEqual({ available: true, state: "ready" })
        expect(
          yield* health.assessAccount({
            providerID: "opencode",
            accountID: "acct-a",
            modelID: "account-expired",
            credentialRevision: 7,
            now: 60_001,
          }),
        ).toEqual({ admissible: true, healthRank: 0, state: "ready" })

        const { readDb } = yield* Database.Service
        expect(yield* readDb.select().from(ProviderPublicRouteHealthTable).all()).toEqual([])
        expect(yield* readDb.select().from(ProviderAccountRouteHealthTable).all()).toEqual([])
      }),
    )
  })

  test("fails closed on cross-kind health effects without writing durable state", async () => {
    await using dir = await tmpdir()
    const path = join(dir.path, "cross-kind.sqlite")

    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service
        const publicExit = yield* Effect.exit(
          health.observeFailure({
            lease: publicLease(),
            modelID: "model-a",
            effect: "account-auth-invalid",
            now: 40_000,
          }),
        )
        const accountExit = yield* Effect.exit(
          health.observeFailure({
            lease: accountLease(),
            modelID: "model-a",
            effect: "public-quota-exhausted",
            // Even stale reset evidence cannot bypass route/effect validation.
            resetAt: 39_000,
            now: 40_000,
          }),
        )
        expect(Exit.isFailure(publicExit)).toBe(true)
        expect(Exit.isFailure(accountExit)).toBe(true)

        const { readDb } = yield* Database.Service
        expect(yield* readDb.select().from(ProviderPublicRouteHealthTable).all()).toEqual([])
        expect(yield* readDb.select().from(ProviderAccountRouteHealthTable).all()).toEqual([])
      }),
    )
  })

  test("durable rows contain only stable route/model health identity and bounded state", async () => {
    await using dir = await tmpdir()
    const path = join(dir.path, "secret-boundary.sqlite")

    await run(
      path,
      Effect.gen(function* () {
        const health = yield* ProviderRouteHealth.Service
        yield* health.observeFailure({
          lease: publicLease(),
          modelID: "public-model",
          effect: "public-quota-exhausted",
          resetAt: 80_000,
          now: 50_000,
        })
        yield* health.observeFailure({
          lease: accountLease(12, "stable-account"),
          modelID: "account-model",
          effect: "account-auth-invalid",
          now: 50_000,
        })

        const { readDb } = yield* Database.Service
        const rows = [
          ...(yield* readDb.select().from(ProviderPublicRouteHealthTable).all()),
          ...(yield* readDb.select().from(ProviderAccountRouteHealthTable).all()),
        ]
        const serialized = JSON.stringify(rows)
        for (const forbidden of [
          "credential_handle",
          "cred-local-opaque",
          "session_id",
          "ses_health",
          "token",
          "apiKey",
          "authorization",
        ]) {
          expect(serialized).not.toContain(forbidden)
        }
        expect(serialized).toContain("stable-account")
        expect(serialized).toContain('"credential_revision":12')
      }),
    )
  })
})
