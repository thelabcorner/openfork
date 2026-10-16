import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProviderRoute } from "@opencode-ai/core/provider-route"
import type { ProviderRouteResolution } from "@opencode-ai/core/provider-route-resolution"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import {
  accountAttributionFromBinding,
  resolveMaintenanceModel,
  type RecoveryBindingSource,
} from "@/session/maintenance-route"
import type { Provider } from "@/provider/provider"

const parentProviderID = ProviderV2.ID.make("opencode")
const parentModelID = ModelV2.ID.make("gpt-5-nano")
const otherProviderID = ProviderV2.ID.make("third-party")
const otherModelID = ModelV2.ID.make("other-model")

const accountBinding = (sessionID: SessionSchema.ID): ProviderRoute.Binding => ({
    sessionID,
    affinityDomain: `opencode-provider/${parentProviderID}`,
    providerID: parentProviderID,
    routeRevision: 5,
    routeKind: "account",
    accountID: "account-parent",
    credentialHandle: "cred-parent",
    assignedAt: 1,
    assignmentEpoch: 1,
    reason: "initial",
  })

const publicBinding = (sessionID: SessionSchema.ID): ProviderRoute.Binding => ({
    sessionID,
    affinityDomain: `opencode-provider/${parentProviderID}`,
    providerID: parentProviderID,
    routeRevision: 2,
    routeKind: "public",
    assignedAt: 1,
    assignmentEpoch: 1,
    reason: "initial",
  })

describe("maintenance route recovery for out-of-turn entry points", () => {
  test("recovers a committed account route with its account identity", async () => {
    const sessionID = SessionSchema.ID.make("ses_maintenance_route_account")
    const source: RecoveryBindingSource = {
      get: (id, domain) =>
        Effect.succeed(id === sessionID ? accountBinding(sessionID) : undefined) as never,
    }
    const result = await Effect.runPromise(
      accountAttributionFromBinding(source, {
        sessionID,
        providerID: parentProviderID,
      }),
    )
    expect(result).toEqual({
      sessionID,
      affinityDomain: `opencode-provider/${parentProviderID}`,
      providerID: parentProviderID,
      routeRevision: 5,
      routeKind: "account",
      accountID: "account-parent",
    } satisfies ProviderRouteResolution.RouteAttribution)
  })

  test("recovers a committed Public route without inventing an account", async () => {
    const sessionID = SessionSchema.ID.make("ses_maintenance_route_public")
    const source: RecoveryBindingSource = {
      get: (id) => Effect.succeed(id === sessionID ? publicBinding(sessionID) : undefined) as never,
    }
    const result = await Effect.runPromise(
      accountAttributionFromBinding(source, {
        sessionID,
        providerID: parentProviderID,
      }),
    )
    expect(result).toEqual({
      sessionID,
      affinityDomain: `opencode-provider/${parentProviderID}`,
      providerID: parentProviderID,
      routeRevision: 2,
      routeKind: "public",
    } satisfies ProviderRouteResolution.RouteAttribution)
    expect(result?.accountID).toBeUndefined()
  })

  test("returns undefined when the Session has no committed route", async () => {
    const sessionID = SessionSchema.ID.make("ses_maintenance_route_none")
    const source: RecoveryBindingSource = {
      get: () => Effect.succeed(undefined) as never,
    }
    const result = await Effect.runPromise(
      accountAttributionFromBinding(source, {
        sessionID,
        providerID: parentProviderID,
      }),
    )
    expect(result).toBeUndefined()
  })

  test("a Public committed route never leaks an account onto the title model ref", async () => {
    const sessionID = SessionSchema.ID.make("ses_maintenance_route_ref")
    const source: RecoveryBindingSource = {
      get: () => Effect.succeed(publicBinding(sessionID)) as never,
    }
    const route = await Effect.runPromise(
      accountAttributionFromBinding(source, {
        sessionID,
        providerID: parentProviderID,
      }),
    )
    const ref = ModelV2.Ref.make({
      providerID: parentProviderID,
      id: parentModelID,
      ...(route?.routeKind === "account" ? { accountID: route.accountID! } : {}),
    })
    expect(ref.accountID).toBeUndefined()
    expect(ref.providerID).toBe(parentProviderID)
  })
})

describe("maintenance model resolution never owns a durable route", () => {
  const sessionID = SessionSchema.ID.make("ses_maintenance_model")
  const isHostedProvider = (providerID: string) => providerID === "opencode" || providerID === "opencode-go"
  const committedRoute: ProviderRouteResolution.RouteAttribution = {
    sessionID,
    affinityDomain: `opencode-provider/${parentProviderID}`,
    providerID: parentProviderID,
    routeRevision: 5,
    routeKind: "account",
    accountID: "account-parent",
  }

  test("a committed same-provider route is inherited exactly and never re-bound", async () => {
    const model = { providerID: parentProviderID, id: parentModelID } as never
    const seenRoutes: unknown[] = []
    const provider = {
      resolveInheritedRoutedModel: (input: { route: ProviderRouteResolution.RouteAttribution }) => {
        seenRoutes.push(input.route)
        return Effect.succeed({ model, route: { attribution: committedRoute } })
      },
      resolveTransientRoutedModel: () => Effect.die("a committed route must be inherited, not resolved transiently"),
      getModel: () => Effect.die("a committed route must not use direct lookup"),
    } as unknown as Provider.Interface

    const result = await Effect.runPromise(
      resolveMaintenanceModel(provider, isHostedProvider, {
        sessionID,
        providerID: parentProviderID,
        modelID: parentModelID,
        route: committedRoute,
      }),
    )

    expect(seenRoutes).toEqual([committedRoute])
    expect(result?.model).toBe(model)
    expect(result?.route).toEqual({ routeKind: "account", accountID: "account-parent" })
  })

  test("an explicit cross-provider override uses a transient route and never binds", async () => {
    const model = { providerID: otherProviderID, id: otherModelID } as never
    const transientCalls: Array<{ providerID: string; modelID: string; routeIntent?: unknown; executionPurpose?: "special-agent" }> = []
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("a cross-provider override cannot inherit the parent route"),
      resolveTransientRoutedModel: (input: { providerID: string; modelID: string; routeIntent?: unknown }) => {
        transientCalls.push(input)
        return Effect.succeed({
          model,
          route: { route: { kind: "public" as const, providerID: input.providerID, routeID: "other:public" } },
        })
      },
      getModel: () => Effect.die("a transient override must not use direct lookup"),
    } as unknown as Provider.Interface

    const result = await Effect.runPromise(
      resolveMaintenanceModel(provider, isHostedProvider, {
        sessionID,
        providerID: otherProviderID,
        modelID: otherModelID,
        explicitOverride: true,
        route: committedRoute,
      }),
    )

    expect(transientCalls).toEqual([
      { providerID: otherProviderID, modelID: otherModelID, routeIntent: { kind: "auto" }, executionPurpose: "special-agent" },
    ])
    expect(result?.model).toBe(model)
    expect(result?.route).toEqual({ routeKind: "public" })
  })

  test("an explicit same-provider title override honors an alternate account without rebinding the parent", async () => {
    const accountID = "account-title-override"
    const calls: Array<{ accountID?: string; providerID: string; modelID: string; executionPurpose?: "special-agent" }> = []
    const model = { providerID: parentProviderID, id: parentModelID } as never
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("explicit override must never inherit the parent account"),
      resolveTransientRoutedModel: (input: { accountID?: string; providerID: string; modelID: string }) => {
        calls.push(input)
        return Effect.succeed({
          model,
          route: {
            route: { kind: "account" as const, accountID, providerID: input.providerID, routeID: "title:account" },
          },
        })
      },
      getModel: () => Effect.die("a hosted explicit override cannot fall back to ambient credentials"),
    } as unknown as Provider.Interface
    const result = await Effect.runPromise(
      resolveMaintenanceModel(provider, isHostedProvider, {
        sessionID,
        providerID: parentProviderID,
        modelID: parentModelID,
        accountID,
        explicitAccount: true,
        explicitOverride: true,
        route: committedRoute,
      }),
    )
    expect(calls).toEqual([{ providerID: parentProviderID, modelID: parentModelID, accountID, executionPurpose: "special-agent" }])
    expect(result?.model).toBe(model)
    expect(result?.route).toEqual({ routeKind: "account", accountID })
  })

  test("an automatic cross-provider candidate is skipped when a parent route exists", async () => {
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("must not be reached"),
      resolveTransientRoutedModel: () => Effect.die("must not be reached"),
      getModel: () => Effect.die("must not be reached"),
    } as unknown as Provider.Interface

    const result = await Effect.runPromise(
      resolveMaintenanceModel(provider, isHostedProvider, {
        sessionID,
        providerID: otherProviderID,
        modelID: otherModelID,
        route: committedRoute,
      }),
    )

    expect(result).toBeUndefined()
  })

  test("an explicit account that conflicts with the committed route fails closed", async () => {
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("must not be reached"),
      resolveTransientRoutedModel: () => Effect.die("must not be reached"),
      getModel: () => Effect.die("must not be reached"),
    } as unknown as Provider.Interface

    const result = await Effect.runPromise(
      resolveMaintenanceModel(provider, isHostedProvider, {
        sessionID,
        providerID: parentProviderID,
        modelID: parentModelID,
        accountID: "another-account",
        explicitAccount: true,
        route: committedRoute,
      }),
    )

    expect(result).toBeUndefined()
  })

  test("a legacy hosted Session without a binding resolves a one-call title route", async () => {
    const model = { providerID: parentProviderID, id: parentModelID } as never
    const calls: Array<{ providerID: string; modelID: string; routeIntent?: unknown; executionPurpose?: "special-agent" }> = []
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("no parent route exists"),
      resolveTransientRoutedModel: (input: { providerID: string; modelID: string; routeIntent?: unknown }) => {
        calls.push(input)
        return Effect.succeed({
          model,
          route: { route: { kind: "account" as const, accountID: "account-auto", providerID: input.providerID } },
        })
      },
      getModel: () => Effect.die("hosted maintenance must not use ambient credentials"),
    } as unknown as Provider.Interface

    const result = await Effect.runPromise(
      resolveMaintenanceModel(provider, isHostedProvider, {
        sessionID,
        providerID: parentProviderID,
        modelID: parentModelID,
      }),
    )
    expect(calls).toEqual([{ providerID: parentProviderID, modelID: parentModelID, routeIntent: { kind: "auto" }, executionPurpose: "special-agent" }])
    expect(result?.model).toBe(model)
    expect(result?.route).toEqual({ routeKind: "account", accountID: "account-auto" })
  })

  test("a legacy hosted title request preserves an available account pin without binding", async () => {
    const accountID = "account-pinned"
    const model = { providerID: parentProviderID, id: parentModelID } as never
    const calls: Array<{ providerID: string; modelID: string; accountID?: string; routeIntent?: unknown; executionPurpose?: "special-agent" }> = []
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("no parent route exists"),
      resolveTransientRoutedModel: (input: { providerID: string; modelID: string; accountID?: string; routeIntent?: unknown }) => {
        calls.push(input)
        return Effect.succeed({
          model,
          route: { route: { kind: "account" as const, accountID, providerID: input.providerID } },
        })
      },
      getModel: () => Effect.die("hosted maintenance must not use ambient credentials"),
    } as unknown as Provider.Interface

    const result = await Effect.runPromise(
      resolveMaintenanceModel(provider, isHostedProvider, {
        sessionID,
        providerID: parentProviderID,
        modelID: parentModelID,
        accountID,
      }),
    )
    expect(calls).toEqual([{ providerID: parentProviderID, modelID: parentModelID, accountID, executionPurpose: "special-agent" }])
    expect(result?.route).toEqual({ routeKind: "account", accountID })
  })

  test("a hosted provider without a binding or eligible transient route still fails closed", async () => {
    let directCalled = false
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("no parent route exists"),
      resolveTransientRoutedModel: () => Effect.succeed(undefined),
      getModel: () => {
        directCalled = true
        return Effect.die("hosted maintenance must not use ambient credentials")
      },
    } as unknown as Provider.Interface
    const result = await Effect.runPromise(
      resolveMaintenanceModel(provider, isHostedProvider, {
        sessionID,
        providerID: parentProviderID,
        modelID: parentModelID,
      }),
    )
    expect(result).toBeUndefined()
    expect(directCalled).toBe(false)
  })

  test("a hosted provider with no authoritative transient route fails closed", async () => {
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("there is no committed route to inherit"),
      resolveTransientRoutedModel: () => Effect.succeed(undefined),
      getModel: () => Effect.die("a hosted provider must not fall back to ambient auth"),
    } as unknown as Provider.Interface

    const result = await Effect.runPromise(
      resolveMaintenanceModel(provider, isHostedProvider, {
        sessionID,
        providerID: parentProviderID,
        modelID: parentModelID,
        explicitOverride: true,
      }),
    )

    expect(result).toBeUndefined()
  })

  test("a non-hosted provider with no route keeps the legacy direct path", async () => {
    const model = { providerID: otherProviderID, id: otherModelID } as never
    const provider = {
      resolveInheritedRoutedModel: () => Effect.die("there is no committed route"),
      resolveTransientRoutedModel: () => Effect.die("a legacy provider must not force a route"),
      getModel: () => Effect.succeed(model),
    } as unknown as Provider.Interface

    const result = await Effect.runPromise(
      resolveMaintenanceModel(provider, isHostedProvider, {
        sessionID,
        providerID: otherProviderID,
        modelID: otherModelID,
      }),
    )

    expect(result?.model).toBe(model)
    expect(result?.route).toBeUndefined()
  })
})
