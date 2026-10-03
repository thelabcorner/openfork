import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { generateProjectCopyName } from "@/server/routes/instance/httpapi/handlers/project-copy"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { Usage } from "@/usage/usage"
import { ProviderTest } from "../fake/provider"
import { it } from "../lib/effect"

type MaintenanceInput = Parameters<Usage.Interface["recordMaintenance"]>[0]

const completion = () =>
  Stream.fromIterable([
    LLMEvent.textStart({ id: "project-copy-name" }),
    LLMEvent.textDelta({ id: "project-copy-name", text: "Routed Project Name" }),
    LLMEvent.textEnd({ id: "project-copy-name" }),
    LLMEvent.finish({ reason: "stop" }),
  ])

function harness(kind: "public" | "account" | "direct") {
  const candidate = ProviderTest.model({
    providerID: ProviderV2.ID.make(kind === "direct" ? "anthropic" : "opencode"),
    id: ModelV2.ID.make("copy-model"),
  })
  const routedModel = { ...candidate, name: "Route materialized copy model" }
  const routeInputs: Parameters<Provider.Interface["resolveTransientRoutedModel"]>[0][] = []
  const streamInputs: LLM.StreamInput[] = []
  const maintenance: MaintenanceInput[] = []

  const routed =
    kind === "direct"
      ? undefined
      : ({
          model: routedModel,
          transport: { baseURL: "https://opencode.ai/zen/v1", apiKey: "copy-route-secret", headers: {} },
          route: {
            route:
              kind === "account"
                ? {
                    kind: "account",
                    providerID: "opencode",
                    accountID: "account-copy-a",
                    credentialHandle: "cred-copy-a",
                    credentialRevision: 7,
                  }
                : {
                    kind: "public",
                    providerID: "opencode",
                    routeID: "opencode:public",
                  },
            clientRouteIdentity:
              kind === "account"
                ? {
                    providerID: "opencode",
                    route: { kind: "account", credentialHandle: "cred-copy-a", credentialRevision: 7 },
                  }
                : { providerID: "opencode", route: { kind: "public" } },
            candidateIssues: [],
          },
        } as Provider.TransientRoutedModel)

  const provider: Provider.Interface = {
    list: () => Effect.succeed({}),
    listAccountModelProjections: () => Effect.succeed([]),
    getProvider: () => Effect.die("unused"),
    resolveAccountID: () => Effect.die("unused"),
    getModel: () => Effect.succeed(candidate),
    resolveRoutedModel: () => Effect.die("unused"),
    resolveInheritedRoutedModel: () => Effect.die("unused"),
    resolveTransientRoutedModel: (input) =>
      Effect.sync(() => {
        routeInputs.push(input)
        return routed
      }),
    getLanguage: () => Effect.die("unused"),
    closest: () => Effect.succeed(undefined),
    getSmallModel: () => Effect.succeed(candidate),
    defaultModel: () =>
      Effect.succeed({
        providerID: candidate.providerID,
        modelID: candidate.id,
      }),
  }

  const llm: LLM.Interface = {
    stream: (input) => {
      streamInputs.push(input)
      return completion()
    },
  }

  const usage: Usage.Interface = {
    summary: () => Effect.die("unused"),
    modelProfile: () => Effect.die("unused"),
    pricingCatalog: () => Effect.die("unused"),
    sessionContext: () => Effect.die("unused"),
    recordMaintenance: (input) =>
      Effect.sync(() => {
        maintenance.push(input)
      }),
  }

  return { candidate, routedModel, provider, llm, usage, routeInputs, streamInputs, maintenance }
}

describe("Project Copy standalone provider route authority", () => {
  it.effect("uses one transient Public route for transport and maintenance settlement", () =>
    Effect.gen(function* () {
      const h = harness("public")
      const name = yield* generateProjectCopyName({
        context: "route the copy name",
        projectID: "project-copy-public",
        provider: h.provider,
        llm: h.llm,
        usage: h.usage,
      })

      expect(name).toBe("routed-project-name")
      expect(h.routeInputs).toHaveLength(1)
      expect(h.routeInputs[0]).toMatchObject({
        providerID: "opencode",
        modelID: "copy-model",
        routeIntent: { kind: "auto" },
      })
      expect(h.streamInputs).toHaveLength(1)
      expect(h.streamInputs[0]?.model).toBe(h.routedModel)
      expect(h.streamInputs[0]?.route).toEqual({ routeKind: "public" })
      expect(h.maintenance).toHaveLength(1)
      expect(h.maintenance[0]).toMatchObject({
        agent: "project-copy-name",
        providerID: "opencode",
        modelID: "copy-model",
        route: { routeKind: "public" },
        projectID: "project-copy-public",
      })
      expect(JSON.stringify(h.maintenance[0])).not.toContain("accountID")
    }),
  )

  it.effect("preserves the exact transient account identity through transport and settlement", () =>
    Effect.gen(function* () {
      const h = harness("account")
      yield* generateProjectCopyName({
        context: "account-routed copy",
        projectID: "project-copy-account",
        provider: h.provider,
        llm: h.llm,
        usage: h.usage,
      })

      expect(h.streamInputs[0]?.model).toBe(h.routedModel)
      expect(h.streamInputs[0]?.route).toEqual({
        routeKind: "account",
        accountID: "account-copy-a",
      })
      expect(h.maintenance[0]?.route).toEqual({
        routeKind: "account",
        accountID: "account-copy-a",
      })
      expect(JSON.stringify(h.streamInputs[0]?.route)).not.toContain("cred-copy-a")
      expect(JSON.stringify(h.maintenance[0]?.route)).not.toContain("cred-copy-a")
    }),
  )

  it.effect("keeps non-OpenCode direct providers on the legacy direct path without fabricating route authority", () =>
    Effect.gen(function* () {
      const h = harness("direct")
      yield* generateProjectCopyName({
        context: "third party copy",
        projectID: "project-copy-direct",
        provider: h.provider,
        llm: h.llm,
        usage: h.usage,
      })

      expect(h.routeInputs).toHaveLength(1)
      expect(h.streamInputs[0]?.model).toBe(h.candidate)
      expect(h.streamInputs[0]?.route).toBeUndefined()
      expect(h.maintenance[0]?.route).toBeUndefined()
    }),
  )
})
