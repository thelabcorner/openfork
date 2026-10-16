import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Quota } from "@/quota/quota"
import { Usage } from "@/usage/usage"
import { QuotaTool } from "@/tool/quota"
import { UsageTool } from "@/tool/usage"
import { toolMayMutateWorkspace } from "@/tool/registry"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import * as Tool from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node])))

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_accounting_tools"),
  messageID: MessageID.make("msg_accounting_tools"),
  callID: "call_accounting_tools",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const tokens = { input: 10, cacheRead: 2, cacheWrite: 1, output: 4, reasoning: 1 }

describe("accounting lazy-tool context budgets", () => {
  it.effect("keeps quota and usage descriptors compact when explicitly loaded", () =>
    Effect.gen(function* () {
      const quota = Quota.Service.of({
        providers: () => Effect.succeed({ providers: [] }),
        get: () => Effect.die("unused"),
        resetsForProvider: () => Effect.die("unused"),
        resets: () => Effect.succeed({ from: 0, to: 1, generatedAt: 0, occurrences: [], failures: [] }),
      })
      const usage = Usage.Service.of({
        summary: () => Effect.die("unused"),
        inspect: () => Effect.die("unused"),
        workload: () => Effect.die("unused"),
        modelProfile: () => Effect.succeed({ models: [] }),
        pricingCatalog: () => Effect.succeed({ models: [] }),
        sessionContext: () => Effect.succeed(undefined),
        recordMaintenance: () => Effect.void,
      })
      const quotaTool = yield* Effect.gen(function* () {
        return yield* Tool.init(yield* QuotaTool)
      }).pipe(Effect.provide(Layer.succeed(Quota.Service, quota)))
      const usageTool = yield* Effect.gen(function* () {
        return yield* Tool.init(yield* UsageTool)
      }).pipe(Effect.provide(Layer.succeed(Usage.Service, usage)))
      const quotaBytes = Buffer.byteLength(quotaTool.description) + Buffer.byteLength(JSON.stringify(ToolJsonSchema.fromTool(quotaTool)))
      const usageBytes = Buffer.byteLength(usageTool.description) + Buffer.byteLength(JSON.stringify(ToolJsonSchema.fromTool(usageTool)))
      expect(quotaTool.exposure).toBe("lazy")
      expect(usageTool.exposure).toBe("lazy")
      expect(quotaBytes).toBeLessThan(4 * 1024)
      expect(usageBytes).toBeLessThan(5 * 1024)
    }),
  )
})

describe("tool.quota", () => {
  it.effect("provider discovery stays cheap and never fetches provider quota", () => {
    let gets = 0
    const quota = Quota.Service.of({
      providers: () =>
        Effect.succeed({
          providers: [
            { providerId: "demo", providerName: "Demo", aliases: ["d"], configured: true },
            { providerId: "off", providerName: "Off", aliases: [], configured: false },
          ],
        }),
      get: () => Effect.sync(() => {
        gets += 1
        return {
          providerId: "demo",
          providerName: "Demo",
          ok: true,
          configured: true,
          usage: null,
          fetchedAt: 1,
        }
      }),
      resetsForProvider: () =>
        Effect.succeed({ from: 0, to: 1, generatedAt: 0, occurrences: [], failures: [] }),
      resets: () =>
        Effect.succeed({ from: 0, to: 1, generatedAt: 0, occurrences: [], failures: [] }),
    })

    return Effect.gen(function* () {
      const tool = yield* Tool.init(yield* QuotaTool)
      const result = yield* tool.execute({ action: "providers" }, ctx)
      expect(gets).toBe(0)
      expect(result.metadata.action).toBe("providers")
      expect(result.output).toContain("demo: configured")
      expect(result.output).toContain("off: not configured")
    }).pipe(Effect.provide(Layer.succeed(Quota.Service, quota)))
  })

  it.effect("summary projection is bounded and account labels require explicit account detail", () => {
    const quota = Quota.Service.of({
      providers: () => Effect.succeed({ providers: [] }),
      get: () =>
        Effect.succeed({
          providerId: "workbuddy",
          providerName: "WorkBuddy",
          ok: true,
          configured: true,
          planLabel: "Pro",
          usage: {
            windows: {
              weekly: {
                usedPercent: 25,
                remainingPercent: 75,
                windowSeconds: 604800,
                resetAt: 2_000,
                resetAfterSeconds: 100,
                valueLabel: null,
              },
            },
            workbuddyAccounts: [
              {
                accountId: "wb-opaque",
                label: "private@example.test",
                models: [
                  {
                    model: "hy4-preview",
                    canonical: "hy4-preview",
                    unit: "credits",
                    usedObserved: 1,
                    limitEstimate: 10,
                    remainingEstimate: 9,
                    remainingPercent: 90,
                    status: "healthy",
                    confidence: "high",
                    accuracy: "observed",
                    exhaustedObserved: false,
                    serverCode: null,
                    resetAt: 3_000,
                    resetSource: "unknown",
                    windowType: "unknown",
                    windowStartedAt: null,
                    secondsUntilReset: null,
                    lastObservationAt: null,
                    burnPerHour: null,
                    estimatedExhaustionAt: null,
                    willLikelyExhaustBeforeReset: false,
                    creditsObserved: 1,
                    tokensInput: 0,
                    tokensOutput: 0,
                    tokensCacheHit: 0,
                    tokensCacheMiss: 0,
                    creditsPersonalized: false,
                    coverage: "opencode-only",
                  },
                ],
              },
            ],
          },
          fetchedAt: 1_000,
          nextRefreshAt: 2_000,
        }),
      resetsForProvider: () =>
        Effect.succeed({ from: 0, to: 1, generatedAt: 0, occurrences: [], failures: [] }),
      resets: () =>
        Effect.succeed({ from: 0, to: 1, generatedAt: 0, occurrences: [], failures: [] }),
    })

    return Effect.gen(function* () {
      const tool = yield* Tool.init(yield* QuotaTool)
      const summary = yield* tool.execute({ action: "get", providerID: "workbuddy" }, ctx)
      expect(summary.output).not.toContain("private@example.test")
      expect(JSON.stringify(summary.metadata)).not.toContain("private@example.test")

      const accounts = yield* tool.execute(
        { action: "get", providerID: "workbuddy", detail: "accounts" },
        ctx,
      )
      expect(JSON.stringify(accounts.metadata)).toContain("private@example.test")
    }).pipe(Effect.provide(Layer.succeed(Quota.Service, quota)))
  })

  it.effect("overview canonicalizes aliases and reset projections keep account labels private", () => {
    let gets = 0
    const quota = Quota.Service.of({
      providers: () =>
        Effect.succeed({
          providers: [
            { providerId: "kimi-for-coding", providerName: "Kimi", aliases: ["kimi"], configured: true },
          ],
        }),
      get: ({ providerID }) =>
        Effect.sync(() => {
          gets += 1
          return {
            providerId: providerID === "kimi" ? "kimi-for-coding" : providerID,
            providerName: "Kimi",
            ok: true,
            configured: true,
            usage: null,
            fetchedAt: 1,
          }
        }),
      resetsForProvider: ({ from, to }) =>
        Effect.succeed({
          from,
          to,
          generatedAt: from,
          occurrences: [
            {
              id: "reset-1",
              providerId: "workbuddy",
              providerName: "WorkBuddy",
              resetAt: from + 1,
              observedAt: from,
              scope: "account" as const,
              accountId: "wb-opaque",
              accountLabel: "private@example.test",
              windows: [
                {
                  key: "weekly",
                  usedPercent: 25,
                  remainingPercent: 75,
                  valueLabel: null,
                  source: "provider" as const,
                },
              ],
            },
          ],
          failures: [],
        }),
      resets: ({ from, to }) => Effect.succeed({ from, to, generatedAt: from, occurrences: [], failures: [] }),
    })

    return Effect.gen(function* () {
      const tool = yield* Tool.init(yield* QuotaTool)
      const overview = yield* tool.execute(
        { action: "overview", providerIDs: ["kimi", "kimi-for-coding"] },
        ctx,
      )
      expect(gets).toBe(1)
      expect(overview.output.match(/Kimi \(kimi-for-coding\)/g)?.length).toBe(1)

      const resets = yield* tool.execute(
        { action: "resets", providerID: "workbuddy", from: 1_000, to: 2_000 },
        ctx,
      )
      const encoded = JSON.stringify(resets)
      expect(encoded).not.toContain("private@example.test")
      expect(encoded).toContain("wb-opaque")
    }).pipe(Effect.provide(Layer.succeed(Quota.Service, quota)))
  })
})

describe("tool.usage", () => {
  it.effect("range analytics call compact inspect and never rich summary", () => {
    let inspections = 0
    const usage = Usage.Service.of({
      summary: () => Effect.die("usage tool must not call rich summary"),
      inspect: (request) =>
        Effect.sync(() => {
          inspections += 1
          return {
            action: "totals" as const,
            since: request.since,
            until: request.until,
            projectID: request.projectID,
            totals: {
              sessions: 2,
              messages: 5,
              cost: 0.5,
              estimatedCost: 0.1,
              pricedRecords: 5,
              unpricedRecords: 0,
              tokens,
              durationMs: 1_000,
              durationRecords: 5,
              ttftMs: 100,
              ttftRecords: 5,
            },
            rates: {
              tokensPerSecond: 5,
              avgTokensPerTurn: 3.6,
              avgCostPerTurn: 0.12,
              cacheHitRate: 0.2,
              cacheSavings: 0.02,
              cacheSavingsCoverage: 1,
            },
            pricing: { coverage: 1, mode: "mixed" as const },
            mostUsedModel: {
              providerID: "demo",
              modelID: "model",
              messages: 5,
              cost: 0.6,
              share: 1,
            },
          }
        }),
      modelProfile: () => Effect.succeed({ models: [] }),
      pricingCatalog: () => Effect.succeed({ models: [] }),
      sessionContext: () => Effect.succeed(undefined),
      workload: () => Effect.die("unused"),
      recordMaintenance: () => Effect.void,
    })

    return Effect.gen(function* () {
      const tool = yield* Tool.init(yield* UsageTool)
      const result = yield* tool.execute(
        { action: "totals", since: 1_000, until: 2_000 },
        ctx,
      )
      expect(inspections).toBe(1)
      expect(result.metadata.action).toBe("totals")
      expect(result.output).toContain("Spend: $0.60")
      expect(result.output).toContain("Tokens: 18")
    }).pipe(Effect.provide(Layer.succeed(Usage.Service, usage)))
  })

  it.effect("context omits system prompt and unused latest payload", () => {
    const usage = Usage.Service.of({
      summary: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      workload: () => Effect.die("unused"),
      modelProfile: () => Effect.succeed({ models: [] }),
      pricingCatalog: () => Effect.succeed({ models: [] }),
      sessionContext: (sessionID) =>
        Effect.succeed({
          sessionID,
          createdAt: 1,
          updatedAt: 2,
          counts: { all: 3, user: 1, assistant: 1 },
          systemPrompt: "TOP SECRET SYSTEM PROMPT",
          totals: {
            messages: 1,
            toolCalls: 0,
            cost: 0.01,
            freeMessages: 0,
            tokens,
            freeTokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
            generatedMs: 50,
            toolMs: 0,
            ttftMs: 5,
            ttftRecords: 1,
            upstreamTTFTMs: 4,
            upstreamTTFTRecords: 1,
          },
          models: [],
          latest: {
            providerID: "demo",
            modelID: "model",
            providerName: "Demo",
            modelName: "Model",
            completedAt: 2,
            tokens,
          },
          breakdown: {
            system: 10,
            user: 20,
            synthetic: 0,
            shell: 0,
            compaction: 0,
            assistant: 30,
            tool: 0,
            other: 0,
          },
        }),
      recordMaintenance: () => Effect.void,
    })

    return Effect.gen(function* () {
      const tool = yield* Tool.init(yield* UsageTool)
      const result = yield* tool.execute({ action: "context", sessionID: "ses_target" }, ctx)
      const encoded = JSON.stringify(result)
      expect(encoded).not.toContain("TOP SECRET SYSTEM PROMPT")
      expect(encoded).not.toContain('"latest"')
      expect(result.output).toContain("Session ses_target")
    }).pipe(Effect.provide(Layer.succeed(Usage.Service, usage)))
  })
})


describe("quota/usage workspace mutation classification", () => {
  it.effect("keeps both accounting tools outside worktree snapshot mutation coordination", () =>
    Effect.sync(() => {
      expect(toolMayMutateWorkspace("quota", { action: "overview" })).toBe(false)
      expect(toolMayMutateWorkspace("usage", { action: "breakdown" })).toBe(false)
    }),
  )
})
