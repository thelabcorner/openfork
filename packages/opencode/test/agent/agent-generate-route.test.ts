import { expect } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OpenCodeHostedUserAgent } from "@opencode-ai/core/installation/version"
import { ModelV2 } from "@opencode-ai/core/model"
import { Npm } from "@opencode-ai/core/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { Usage as UsageAnalytics } from "@/usage/usage"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderTest } from "../fake/provider"
import { SkillTest } from "../fake/skill"
import { testEffect } from "../lib/effect"

type MaintenanceInput = Parameters<UsageAnalytics.Interface["recordMaintenance"]>[0]

const model = ProviderTest.model({
  providerID: ProviderV2.ID.make("opencode"),
  id: ModelV2.ID.make("agent-generate-model"),
  api: {
    id: ModelV2.ID.make("agent-generate-model"),
    url: "https://opencode.ai/zen/v1",
    npm: "@ai-sdk/openai-compatible",
  },
})

const routedModel = { ...model, name: "Routed Agent Generator" }
const generateCalls: LanguageModelV3CallOptions[] = []
const routeInputs: Parameters<Provider.Interface["resolveTransientRoutedModel"]>[0][] = []
const maintenance: MaintenanceInput[] = []

const language: LanguageModelV3 = {
  specificationVersion: "v3",
  provider: "opencode",
  modelId: "agent-generate-model",
  supportedUrls: {},
  doGenerate: async (options) => {
    generateCalls.push(options)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            identifier: "routed-agent",
            whenToUse: "Use for routed generation tests.",
            systemPrompt: "Follow the routed generation contract.",
          }),
        },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 12, noCache: 10, cacheRead: 2, cacheWrite: 0 },
        outputTokens: { total: 8, text: 6, reasoning: 2 },
      },
      warnings: [],
    }
  },
  doStream: async () => ({
    stream: new ReadableStream(),
  }),
}

const provider = ProviderTest.fake({
  model,
  resolveTransientRoutedModel: (input) =>
    Effect.sync(() => {
      routeInputs.push(input)
      return {
        model: routedModel,
        transport: { baseURL: "https://opencode.ai/zen/v1", apiKey: "account-agent-a-secret", headers: {} },
        route: {
          route: {
            kind: "account",
            providerID: "opencode",
            accountID: "account-agent-a",
            credentialHandle: "cred-agent-a",
            credentialRevision: 11,
          },
          clientRouteIdentity: {
            providerID: "opencode",
            route: {
              kind: "account",
              credentialHandle: "cred-agent-a",
              credentialRevision: 11,
            },
          },
          candidateIssues: [],
        },
      } as Provider.TransientRoutedModel
    }),
  getLanguage: () => Effect.succeed(language),
})

const usageLayer = Layer.succeed(
  UsageAnalytics.Service,
  UsageAnalytics.Service.of({
    summary: () => Effect.die("unused"),
    modelProfile: () => Effect.die("unused"),
    pricingCatalog: () => Effect.die("unused"),
    sessionContext: () => Effect.die("unused"),
    recordMaintenance: (input) =>
      Effect.sync(() => {
        maintenance.push(input)
      }),
  }),
)

const layer = AppNodeBuilder.build(LayerNode.group([Agent.node, Plugin.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [Provider.node, provider.layer],
  [Skill.node, SkillTest.empty],
  [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  [UsageAnalytics.node, usageLayer],
])

const it = testEffect(layer)

it.instance("routes hosted Agent.generate once, emits canonical hosted identity, and settles the same stable account", () =>
  Effect.gen(function* () {
    generateCalls.length = 0
    routeInputs.length = 0
    maintenance.length = 0

    const result = yield* Agent.use.generate({
      description: "Create a route-aware helper agent",
      model: {
        providerID: ProviderV2.ID.make("opencode"),
        modelID: ModelV2.ID.make("agent-generate-model"),
        accountID: "account-agent-a",
      },
    })

    expect(result.identifier).toBe("routed-agent")
    expect(routeInputs).toHaveLength(1)
    expect(routeInputs[0]).toMatchObject({
      providerID: "opencode",
      modelID: "agent-generate-model",
      accountID: "account-agent-a",
    })
    expect(routeInputs[0]?.routeIntent).toBeUndefined()

    expect(generateCalls).toHaveLength(1)
    const headers = generateCalls[0]?.headers as Record<string, string>
    expect(headers["user-agent"]).toBe(OpenCodeHostedUserAgent())
    expect(headers["x-opencode-session"]).toMatch(/^ses_/)
    expect(headers["x-opencode-request"]).toMatch(/^msg_/)
    expect(headers["x-opencode-client"]).toBeTruthy()
    expect(headers["x-opencode-project"]).toBeTruthy()
    expect(headers["user-agent"]).not.toContain(" ai/")

    expect(maintenance).toHaveLength(1)
    expect(maintenance[0]).toMatchObject({
      agent: "agent_generator",
      providerID: "opencode",
      modelID: "agent-generate-model",
      route: {
        routeKind: "account",
        accountID: "account-agent-a",
      },
      tokens: {
        input: 10,
        cacheRead: 2,
        cacheWrite: 0,
        output: 6,
        reasoning: 2,
      },
      totalTokens: 20,
    })
    expect(JSON.stringify(maintenance[0]?.route)).not.toContain("cred-agent-a")
  }),
)
