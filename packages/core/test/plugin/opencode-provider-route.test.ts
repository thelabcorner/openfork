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
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "../lib/effect"

const nodes = () => LayerNode.group([Database.node, ProviderRoute.node])
const layer = AppNodeBuilder.build(nodes(), [[Database.node, Database.layerFromPath(":memory:")]])
const it = testEffect(layer)

const providerID = "opencode"
const affinityDomain = "opencode-hosted"
const projectID = ProjectV2.ID.global
const projectDirectory = AbsolutePath.make("/opencode-provider-route-project")
const sessionDirectory = AbsolutePath.make("/opencode-provider-route-project/workspace")

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
        title: "OpenCode provider route composition test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

function fakeSource() {
  const calls = {
    list: 0,
    revision: 0,
  }

  const credentialID = Credential.ID.make("cred-console-a")
  const account = ProviderAccount.Info.make({
    providerID: ProviderV2.ID.make(providerID),
    credentialID,
    accountID: "acct-console-a",
    label: "Console A",
    active: true,
    authType: "oauth",
    source: "credential",
  })
  const snapshot: OpencodeRouteCandidates.CandidateSnapshot = {
    account,
    credentialRevision: 7,
    configVersion: 3,
    providerConfigIdentity: "cfg-a",
    candidate: {
      providerID,
      accountID: account.accountID,
      credentialHandle: credentialID,
      admissible: true,
      healthRank: 0,
      maxSessionBindings: 4,
    },
  }

  const source: OpencodeProviderRoute.CandidateSource = {
    list: () => {
      calls.list++
      return Effect.succeed({
        candidates: [snapshot],
        issues: [],
      })
    },
    resolveCredentialRevision: (input) => {
      calls.revision++
      return Effect.succeed(
        input.accountID === account.accountID &&
          input.credentialHandle === credentialID
          ? 7
          : undefined,
      )
    },
  }

  return { source, calls, account, credentialID, snapshot }
}

function resolveInput(
  sessionID: SessionSchema.ID,
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

describe("OpenCode production provider-route composition", () => {
  it.effect("uses one stable provider-scoped affinity namespace across runtimes", () =>
    Effect.sync(() => {
      expect(OpencodeProviderRoute.affinityDomain("opencode")).toBe("opencode-provider/opencode")
      expect(OpencodeProviderRoute.affinityDomain("anthropic")).toBe("opencode-provider/anthropic")
      expect(OpencodeProviderRoute.affinityDomain("opencode")).not.toBe(
        OpencodeProviderRoute.affinityDomain("anthropic"),
      )
    }),
  )

  it.effect("explicit Public never enumerates or resolves account credentials", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_opencode_route_public")
      yield* seedSession(sessionID)
      const routes = yield* ProviderRoute.Service
      const fake = fakeSource()
      const runtime = compose({ routes, source: fake.source })

      const result = yield* runtime.resolve(
        resolveInput(sessionID, {
          routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
        }),
      )

      expect(result.lease.route).toEqual({
        kind: "public",
        providerID,
        routeID: "opencode:public",
      })
      expect(result.attribution.routeKind).toBe("public")
      expect(result.attribution.accountID).toBeUndefined()
      expect(fake.calls.list).toBe(0)
      expect(fake.calls.revision).toBe(0)
    }),
  )

  it.effect("Auto account-first prepares A2 candidates once and returns the exact committed lease", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_opencode_route_account")
      yield* seedSession(sessionID)
      const routes = yield* ProviderRoute.Service
      const fake = fakeSource()
      const runtime = compose({ routes, source: fake.source })

      const result = yield* runtime.resolve(resolveInput(sessionID))

      expect(result.lease.route).toEqual({
        kind: "account",
        providerID,
        accountID: fake.account.accountID,
        credentialHandle: fake.credentialID,
        credentialRevision: 7,
      })
      expect(result.attribution).toMatchObject({
        sessionID,
        affinityDomain,
        providerID,
        routeRevision: 1,
        routeKind: "account",
        accountID: fake.account.accountID,
      })
      expect(result.clientRouteIdentity).toEqual({
        providerID,
        route: {
          kind: "account",
          credentialHandle: fake.credentialID,
          credentialRevision: 7,
        },
      })
      expect(fake.calls.list).toBe(1)
      expect(fake.calls.revision).toBe(1)

      const persisted = yield* routes.get(sessionID, affinityDomain)
      expect(persisted?.routeKind).toBe("account")
      if (persisted?.routeKind !== "account") throw new Error("expected account binding")
      expect(persisted.accountID).toBe(fake.account.accountID)
      expect(persisted.credentialHandle).toBe(fake.credentialID)
    }),
  )

  it.effect("a sticky Public Auto route remains credential-free even when policy later becomes account-first", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_opencode_route_sticky_public")
      yield* seedSession(sessionID)
      const routes = yield* ProviderRoute.Service
      const fake = fakeSource()
      const runtime = compose({ routes, source: fake.source })

      const initial = yield* runtime.resolve(
        resolveInput(sessionID, {
          freeRoutePreference: "public-first-for-free",
        }),
      )
      expect(initial.lease.route.kind).toBe("public")
      expect(fake.calls.list).toBe(0)
      expect(fake.calls.revision).toBe(0)

      const again = yield* runtime.resolve(
        resolveInput(sessionID, {
          freeRoutePreference: "account-first",
          now: 200,
        }),
      )
      expect(again.lease.route.kind).toBe("public")
      expect(again.lease.routeRevision).toBe(initial.lease.routeRevision)
      expect(fake.calls.list).toBe(0)
      expect(fake.calls.revision).toBe(0)
    }),
  )

  it.effect("explicit account resolves through the stable ProviderAccount identity and exact opaque handle", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_opencode_route_explicit_account")
      yield* seedSession(sessionID)
      const routes = yield* ProviderRoute.Service
      const fake = fakeSource()
      const runtime = compose({ routes, source: fake.source })

      const result = yield* runtime.resolve(
        resolveInput(sessionID, {
          routeIntent: ProviderRouteIntent.Info.make({
            kind: "account",
            accountID: fake.account.accountID,
            pin: "hard",
          }),
        }),
      )

      expect(result.lease.route.kind).toBe("account")
      if (result.lease.route.kind !== "account") throw new Error("expected account lease")
      expect(result.lease.route.accountID).toBe(fake.account.accountID)
      expect(result.lease.route.credentialHandle).toBe(fake.credentialID)
      expect(result.lease.route.credentialRevision).toBe(7)
      expect(fake.calls.list).toBe(1)
      expect(fake.calls.revision).toBe(1)

      const persisted = yield* routes.get(sessionID, affinityDomain)
      expect(persisted?.routeKind).toBe("account")
      if (persisted?.routeKind !== "account") throw new Error("expected account route")
      expect(persisted.pin).toBe("hard")
    }),
  )

  it.effect("compileExisting inherits the exact committed account route without reselection or mutation", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_opencode_route_inherited_account")
      yield* seedSession(sessionID)
      const routes = yield* ProviderRoute.Service
      const fake = fakeSource()
      const runtime = compose({ routes, source: fake.source })

      const committed = yield* runtime.resolve(resolveInput(sessionID))
      expect(committed.attribution.routeKind).toBe("account")
      expect(fake.calls.list).toBe(1)
      expect(fake.calls.revision).toBe(1)

      const inherited = yield* runtime.compileExisting({
        ...resolveInput(sessionID, { modelID: "maintenance-model", now: 200 }),
        expected: committed.attribution,
      })

      expect(inherited.attribution).toEqual(committed.attribution)
      expect(inherited.lease.route.kind).toBe("account")
      expect(fake.calls.list).toBe(2)
      expect(fake.calls.revision).toBe(2)
      const persisted = yield* routes.get(sessionID, affinityDomain)
      expect(persisted?.routeRevision).toBe(committed.attribution.routeRevision)
      expect(persisted?.reason).toBe("initial")
    }),
  )

  it.effect("compileExisting fails closed when the durable route no longer matches parent authority", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_opencode_route_inherited_stale")
      yield* seedSession(sessionID)
      const routes = yield* ProviderRoute.Service
      const fake = fakeSource()
      const runtime = compose({ routes, source: fake.source })

      const committed = yield* runtime.resolve(resolveInput(sessionID))
      const rebound = yield* routes.compareAndSwap({
        sessionID,
        affinityDomain,
        expectedRevision: committed.attribution.routeRevision,
        route: { kind: "public", providerID },
        assignmentEpoch: 2,
        reason: "explicit",
        assignedAt: 200,
      })
      expect(rebound?.routeKind).toBe("public")

      const exit = yield* runtime
        .compileExisting({
          ...resolveInput(sessionID, { now: 300 }),
          expected: committed.attribution,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(fake.calls.list).toBe(1)
      expect(fake.calls.revision).toBe(1)
      const persisted = yield* routes.get(sessionID, affinityDomain)
      expect(persisted?.routeKind).toBe("public")
      expect(persisted?.routeRevision).toBe(2)
    }),
  )

  it.effect("standalone explicit Public resolves without account work or a durable route row", () =>
    Effect.gen(function* () {
      const routes = yield* ProviderRoute.Service
      const fake = fakeSource()
      const runtime = compose({ routes, source: fake.source })

      const result = yield* runtime.resolveTransient({
        providerID,
        modelID: "jev-1.13-free",
        routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
        mode: "concentrate",
        freeRoutePreference: "public-first-for-free",
        allowPublic: true,
        publicEligible: true,
      })

      expect(result?.route).toEqual({
        kind: "public",
        providerID,
        routeID: "opencode:public",
      })
      expect(fake.calls.list).toBe(0)
      expect(fake.calls.revision).toBe(0)
    }),
  )

  it.effect("standalone explicit account selects the exact A2 snapshot without persisting affinity", () =>
    Effect.gen(function* () {
      const routes = yield* ProviderRoute.Service
      const fake = fakeSource()
      const runtime = compose({ routes, source: fake.source })

      const result = yield* runtime.resolveTransient({
        providerID,
        modelID: "gpt-5",
        routeIntent: ProviderRouteIntent.Info.make({
          kind: "account",
          accountID: fake.account.accountID,
          pin: "hard",
        }),
        mode: "concentrate",
        freeRoutePreference: "account-first",
        allowPublic: true,
        publicEligible: true,
      })

      expect(result?.route).toEqual({
        kind: "account",
        providerID,
        accountID: fake.account.accountID,
        credentialHandle: fake.credentialID,
        credentialRevision: 7,
      })
      expect(result?.clientRouteIdentity).toEqual({
        providerID,
        route: {
          kind: "account",
          credentialHandle: fake.credentialID,
          credentialRevision: 7,
        },
      })
      expect(fake.calls.list).toBe(1)
      expect(fake.calls.revision).toBe(0)
    }),
  )

  it.effect("standalone Auto mirrors initial public-first then P1 account ordering without sticky state", () =>
    Effect.gen(function* () {
      const routes = yield* ProviderRoute.Service
      const fake = fakeSource()
      const runtime = compose({ routes, source: fake.source })

      const free = yield* runtime.resolveTransient({
        providerID,
        modelID: "gpt-5",
        routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
        mode: "concentrate",
        freeRoutePreference: "public-first-for-free",
        allowPublic: true,
        publicEligible: true,
      })
      expect(free?.route.kind).toBe("public")
      expect(fake.calls.list).toBe(0)

      const paid = yield* runtime.resolveTransient({
        providerID,
        modelID: "gpt-5",
        routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }),
        mode: "concentrate",
        freeRoutePreference: "account-first",
        allowPublic: true,
        publicEligible: true,
      })
      expect(paid?.route.kind).toBe("account")
      expect(fake.calls.list).toBe(1)
    }),
  )

  it.effect("Auto leaves an unrelated direct provider unbound when every known account says model-unsupported", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_opencode_route_unowned_direct")
      yield* seedSession(sessionID)
      const routes = yield* ProviderRoute.Service
      const fake = fakeSource()
      let listCalls = 0
      const source: OpencodeProviderRoute.CandidateSource = {
        ...fake.source,
        list: () => {
          listCalls++
          return Effect.succeed({
            candidates: [
              {
                ...fake.snapshot,
                candidate: {
                  ...fake.snapshot.candidate,
                  admissible: false,
                  ineligibleReason: "model-unsupported",
                },
              },
            ],
            issues: [],
          })
        },
      }
      const runtime = compose({ routes, source })

      const result = yield* runtime.resolveIfApplicable(
        resolveInput(sessionID, {
          providerID: "direct-provider",
          modelID: "direct-model",
          allowPublic: false,
          publicEligible: false,
        }),
      )

      expect(result).toBeUndefined()
      expect(listCalls).toBe(1)
      expect(fake.calls.revision).toBe(0)
      expect(yield* routes.get(sessionID, affinityDomain)).toBeUndefined()
    }),
  )
})
