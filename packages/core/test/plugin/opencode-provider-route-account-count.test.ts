import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ProviderAccount } from "@opencode-ai/schema/provider-account"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import {
  OpencodeProviderRoute,
  compose,
} from "@opencode-ai/core/plugin/provider/opencode-provider-route"
import type { OpencodeRouteCandidates } from "@opencode-ai/core/plugin/provider/opencode-route-candidates"
import { UsageRouteAttribution } from "@opencode-ai/core/usage/route-attribution"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "../lib/effect"

const nodes = () => LayerNode.group([Database.node, ProviderRoute.node])
const layer = AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(":memory:")]])
const it = testEffect(layer)

const providerID = "opencode"
const projectID = ProjectV2.ID.global
const projectDirectory = AbsolutePath.make("/opencode-provider-route-account-count-project")
const sessionDirectory = AbsolutePath.make("/opencode-provider-route-account-count-project/workspace")

const ACCOUNT_COUNTS = [0, 1, 3] as const

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
        title: "OpenCode provider route account-count matrix",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

function fakeSourceN(count: number) {
  const calls = { list: 0, revision: 0 }
  const revisions = new Map<string, number>()

  const snapshots: OpencodeRouteCandidates.CandidateSnapshot[] = Array.from({ length: count }, (_, index) => {
    const credentialID = Credential.ID.make(`cred-console-${index}`)
    const accountID = `acct-console-${index}`
    const account = ProviderAccount.Info.make({
      providerID: ProviderV2.ID.make(providerID),
      credentialID,
      accountID,
      label: `Console ${index}`,
      active: true,
      authType: "oauth",
      source: "credential",
    })
    revisions.set(accountID, 7)
    return {
      account,
      credentialRevision: 7,
      configVersion: 3,
      providerConfigIdentity: `cfg-${index}`,
      candidate: {
        providerID,
        accountID,
        credentialHandle: credentialID,
        admissible: true,
        healthRank: index,
        maxSessionBindings: 4,
      },
    }
  })

  const source: OpencodeProviderRoute.CandidateSource = {
    list: () => {
      calls.list++
      return Effect.succeed({ candidates: snapshots, issues: [] })
    },
    resolveCredentialRevision: (input) => {
      calls.revision++
      const found = revisions.get(input.accountID)
      return Effect.succeed(found)
    },
  }

  return { source, calls, snapshots }
}

function resolveInput(
  sessionID: SessionSchema.ID,
  affinityDomain: string,
  overrides: Partial<OpencodeProviderRoute.ResolveInput> = {},
): OpencodeProviderRoute.ResolveInput {
  return {
    sessionID,
    providerID,
    modelID: "gpt-5",
    affinityDomain,
    routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
    mode: "session-round-robin",
    freeRoutePreference: "account-first",
    allowPublic: true,
    publicEligible: true,
    now: 100,
    ...overrides,
  }
}

describe("OpenCode provider route account-count matrix (plan 26 same-build cut line)", () => {
  for (const count of ACCOUNT_COUNTS) {
    it.effect(`explicit Public stays credential-free and account-free with ${count} configured account(s)`, () =>
      Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(`ses_route_count_public_${count}`)
        yield* seedSession(sessionID)
        const routes = yield* ProviderRoute.Service
        const fake = fakeSourceN(count)
        const domain = OpencodeProviderRoute.affinityDomain(providerID)
        const runtime = compose({ routes, source: fake.source })

        const result = yield* runtime.resolve(
          resolveInput(sessionID, domain, {
            routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
          }),
        )

        expect(result.lease.route).toEqual({ kind: "public", providerID, routeID: "opencode:public" })
        expect(result.attribution.routeKind).toBe("public")
        expect(result.attribution.accountID).toBeUndefined()
        expect(result.attribution.routeRevision).toBe(1)
        expect(result.clientRouteIdentity).toEqual({
          providerID,
          route: { kind: "public", routeID: "opencode:public" },
        })
        expect(fake.calls.list).toBe(0)
        expect(fake.calls.revision).toBe(0)

        const persisted = yield* routes.get(sessionID, domain)
        expect(persisted?.routeKind).toBe("public")
        const identity = persisted as { accountID?: string; credentialHandle?: string } | undefined
        expect(identity?.accountID ?? null).toBeNull()
        expect(identity?.credentialHandle ?? null).toBeNull()

        const settled = UsageRouteAttribution.settle({ route: result.attribution })
        expect(settled.attribution).toEqual({ kind: "public" })
        expect(settled.accountID).toBeUndefined()
      }),
    )

    it.effect(`public-first-for-free keeps the free lane with ${count} configured account(s)`, () =>
      Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(`ses_route_count_public_first_${count}`)
        yield* seedSession(sessionID)
        const routes = yield* ProviderRoute.Service
        const fake = fakeSourceN(count)
        const domain = OpencodeProviderRoute.affinityDomain(providerID)
        const runtime = compose({ routes, source: fake.source })

        const result = yield* runtime.resolve(
          resolveInput(sessionID, domain, { freeRoutePreference: "public-first-for-free" }),
        )

        expect(result.lease.route).toEqual({ kind: "public", providerID, routeID: "opencode:public" })
        expect(result.attribution.routeKind).toBe("public")
        expect(result.attribution.accountID).toBeUndefined()
        expect(fake.calls.revision).toBe(0)

        const settled = UsageRouteAttribution.settle({ route: result.attribution })
        expect(settled.attribution).toEqual({ kind: "public" })
        expect(settled.accountID).toBeUndefined()
      }),
    )

    if (count > 0) {
      it.effect(`account-first selects a real seeded account, never a fabricated one, with ${count} account(s)`, () =>
        Effect.gen(function* () {
          const sessionID = SessionSchema.ID.make(`ses_route_count_account_${count}`)
          yield* seedSession(sessionID)
          const routes = yield* ProviderRoute.Service
          const fake = fakeSourceN(count)
          const domain = OpencodeProviderRoute.affinityDomain(providerID)
          const runtime = compose({ routes, source: fake.source })

          const result = yield* runtime.resolve(resolveInput(sessionID, domain))

          expect(result.lease.route.kind).toBe("account")
          if (result.lease.route.kind !== "account") throw new Error("expected an account lease")
          const seeded = new Set(fake.snapshots.map((entry) => entry.account.accountID))
          expect(seeded.has(result.lease.route.accountID)).toBe(true)
          expect(result.attribution.routeKind).toBe("account")
          expect(result.attribution.accountID).toBe(result.lease.route.accountID)

          const settled = UsageRouteAttribution.settle({ route: result.attribution })
          expect(settled.attribution.kind).toBe("account")
          expect(settled.accountID).toBe(result.lease.route.accountID)
        }),
      )
    }
  }

  it.effect("no configured account can claim a public settlement, at any account count", () =>
    Effect.gen(function* () {
      for (const count of ACCOUNT_COUNTS) {
        const sessionID = SessionSchema.ID.make(`ses_route_count_public_settle_${count}`)
        yield* seedSession(sessionID)
        const routes = yield* ProviderRoute.Service
        const fake = fakeSourceN(count)
        const domain = OpencodeProviderRoute.affinityDomain(providerID)
        const runtime = compose({ routes, source: fake.source })

        const result = yield* runtime.resolve(
          resolveInput(sessionID, domain, {
            routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
          }),
        )
        expect(result.attribution.routeKind).toBe("public")

        for (const snapshot of fake.snapshots) {
          const settled = UsageRouteAttribution.settle({
            route: result.attribution,
            observedAccountID: snapshot.account.accountID,
            modelAccountID: snapshot.account.accountID,
          })
          expect(settled.attribution).toEqual({ kind: "public" })
          expect(settled.accountID).toBeUndefined()
        }
      }
    }),
  )
})
