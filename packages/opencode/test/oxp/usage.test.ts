import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Usage } from "@/usage/usage"
import { OxpAttribution } from "@opencode-ai/core/oxp-attribution/attribution"
import { SessionTelemetry } from "@opencode-ai/core/session/telemetry"
import { OxpUsage } from "@/oxp/usage"
import { OxpSupervision } from "@/oxp/supervision"
import { OxpAuthority } from "@/oxp/authority"
import { OxpError } from "@/oxp/error"
import { OxpSchema } from "@/oxp/schema"
import { testEffect } from "../lib/effect"

const sessionID = "ses_usage_authorized"
const rootID = OxpSchema.RootID.make("61741854-3c6e-4cd0-9417-acc25c5ade56")

let workloadFixture: unknown = {}
let summaryFixture: unknown = {}
const fakeAttribution = Layer.mock(OxpAttribution.Service, {
  snapshot: (request) => Effect.succeed({ generatedAt: 1, scope: request, totals: { estimatedTokens: 32_228_100_000 }, coverage: { complete: false }, workload: { totals: { calls: 11 } }, model: { kind: "empirical-tool-usage" } } as never),
})
const tokens = { input: 22, cacheRead: 8, cacheWrite: 0, output: 5, reasoning: 2 }
const breakdown = { system: 1, user: 2, synthetic: 0, shell: 0, compaction: 0, assistant: 1, tool: 3, other: 0 }
const history = {
  sessionID,
  createdAt: 100,
  updatedAt: 200,
  counts: { all: 3, user: 2, assistant: 1 },
  systemPrompt: "PRIVATE: never cross OXP",
  totals: {
    messages: 1,
    toolCalls: 3,
    cost: 0.002,
    freeMessages: 0,
    tokens,
    freeTokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    generatedMs: 100,
    toolMs: 20,
    ttftMs: 10,
    ttftRecords: 1,
    upstreamTTFTMs: 8,
    upstreamTTFTRecords: 1,
  },
  models: [],
  latest: {
    providerID: "openai",
    modelID: "gpt-context-test",
    providerName: "OpenAI",
    modelName: "GPT Context",
    contextLimit: 100,
    completedAt: 190,
    tokens,
  },
  breakdown,
} as Usage.SessionContextHistory

const admission = {
  connectorID: "ec9bd749-267f-4f99-a525-b2b7d20be664",
  authority: "sessionSupervision",
  revision: 1,
  request: { plane: "supervision", operation: "session.get", phase: "supervise", rootID },
} as OxpAuthority.Admission

let events: string[] = []
let resolveFailure = false
let revoked = false
let noLiveTelemetry = false
let missingHistory = false
let denyGlobal = false
let workloadCalls: Usage.WorkloadRequest[] = []
let summaryCalls: Usage.UsageSummaryRequest[] = []
let duringWorkload: (() => void) | undefined

const fakeTelemetry = Layer.mock(SessionTelemetry.Service, {
  snapshot: (ids: readonly string[]) =>
    Effect.sync(() => {
      events.push("telemetry:" + ids.join(","))
      const projection: Record<string, SessionTelemetry.Info> = {}
      if (noLiveTelemetry) return projection
      projection[sessionID] = {
        sessionID: sessionID as SessionTelemetry.Info["sessionID"],
        phase: "idle" as const,
        updatedAt: 200,
        generatedMs: 0,
        toolMs: 0,
        context: {
          model: {
            providerID: "openai",
            modelID: "gpt-context-test",
            contextLimit: 200,
            name: "GPT Context",
            accountID: "PRIVATE_ACCOUNT_ID",
          },
          tokens: { input: 40, output: 20, reasoning: 10, cache: { read: 80, write: 10 } },
        },
      }
      return projection
    }),
})

const fakeUsage = Layer.succeed(
  Usage.Service,
  Usage.Service.of({
    summary: (request) => Effect.sync(() => { events.push("summary"); summaryCalls.push(request); return summaryFixture as Usage.UsageSummary }),
    inspect: () => Effect.die("usage test must not inspect global history"),
    workload: (request) => Effect.sync(() => { events.push("workload"); workloadCalls.push(request); duringWorkload?.(); return workloadFixture as Usage.WorkloadSnapshot }),
    modelProfile: () => Effect.die("usage test must not read global model profile"),
    pricingCatalog: () => Effect.die("usage test must not read global pricing"),
    recordMaintenance: () => Effect.die("usage test must not record maintenance"),
    sessionContext: (id) =>
      Effect.sync(() => {
        events.push("usage:" + id)
        return missingHistory ? undefined : history
      }),
  }),
)

const fakeSupervision = Layer.succeed(
  OxpSupervision.Service,
  OxpSupervision.Service.of({
    authorizeRow: () => Effect.die("usage should resolve Session via the supervision owner"),
    resolve: (id, action, root) =>
      Effect.gen(function* () {
        events.push("supervise:" + id)
        if (resolveFailure || id !== sessionID || root !== rootID || action !== "session.get") {
          return yield* new OxpError.NotFound({ detail: "Session is not available to OXP supervision" })
        }
        return {
          row: { id: sessionID, directory: "C:/fixture" } as OxpSupervision.Target["row"],
          admission,
        }
      }),
    runtimeTarget: () => {
      throw new Error("usage must not create runtime targets")
    },
    actorRef: () => "oxp:test",
  }),
)

const fakeAuthority = Layer.succeed(
  OxpAuthority.Service,
  OxpAuthority.Service.of({
    discover: () => Effect.succeed(true),
    authorize: (request) => request.operation === "usage.global" && denyGlobal
      ? Effect.fail(new OxpError.AuthDenied({ detail: "Global usage disabled" }))
      : Effect.succeed(admission),
    revalidate: (_admission, phase) =>
      Effect.gen(function* () {
        events.push("revalidate:" + phase)
        if (revoked) return yield* new OxpError.AuthRevoked({ detail: "Revoked before egress" })
        return admission
      }),
  }),
)

const layer = AppNodeBuilder.build(LayerNode.group([OxpUsage.node]), [
  [Usage.node, fakeUsage],
  [SessionTelemetry.node, fakeTelemetry],
  [OxpSupervision.node, fakeSupervision],
  [OxpAuthority.node, fakeAuthority],
  [OxpAttribution.node, fakeAttribution],
])
const it = testEffect(layer)

beforeEach(() => {
  events = []
  resolveFailure = false
  revoked = false
  noLiveTelemetry = false
  missingHistory = false
  denyGlobal = false
  workloadCalls = []
  summaryCalls = []
  duringWorkload = undefined
  workloadFixture = {}
  summaryFixture = {}
})

describe("OxpUsage shared native owner", () => {
  it.live("denies global workload before service read, enforces 90 days, and forwards bounded filters", Effect.gen(function* () {
    const usage = yield* OxpUsage.Service
    denyGlobal = true
    const denied = yield* usage.execute({ action: "workload", window: "7d" }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
    expect(workloadCalls).toHaveLength(0)

    denyGlobal = false
    const now = Date.now()
    const tooWide = yield* usage.execute({ action: "workload", since: now - 91 * 86_400_000, until: now }).pipe(Effect.flip)
    expect(tooWide._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(workloadCalls).toHaveLength(0)

    const result = yield* usage.execute({ action: "workload", window: "30d", providerID: "prov", modelID: "model", projectID: "project", limit: 10 })
    expect(workloadCalls[0]).toMatchObject({ providerID: "prov", modelID: "model", projectID: "project", limit: 10 })
    expect(result.metadata?.provenance).toContain("historical tool calls may be missing")
    expect(result.metadata?.precision).toContain("tool wall time overlaps")
    expect(events).toEqual(["workload", "revalidate:egress"])

    revoked = true
    const revokedResult = yield* usage.execute({ action: "workload", window: "1d" }).pipe(Effect.flip)
    expect(revokedResult._tag).toBe("OXP_AUTH_REVOKED")
    expect(events.slice(-2)).toEqual(["workload", "revalidate:egress"])

    revoked = false
    const controller = new AbortController()
    duringWorkload = () => controller.abort()
    const cancelled = yield* usage.execute({ action: "workload", window: "1d" }, controller.signal).pipe(Effect.flip)
    expect(cancelled._tag).toBe("OXP_CANCELLED")
    expect(events.slice(-1)).toEqual(["workload"])
  }))

  it.live("returns selected summary sections and reuses the OXP attribution estimate with provenance", Effect.gen(function* () {
    const usage = yield* OxpUsage.Service
    summaryFixture = {
      since: 10, until: 20, resolution: "hour", projectID: null, totals: { messages: 4 },
      rates: { cacheHitRate: 0.5 }, pricing: { coverage: 0.8, mode: "mixed" },
      activity: { activeDays: 2, longestStreak: 2, busiestDay: { start: 10, messages: 3 } },
      days: Array.from({ length: 40 }, (_, start) => ({ start })), dow: [], hours: [], punchcard: Array(168).fill({ messages: 1 }),
      sessions: Array.from({ length: 30 }, (_, sessionID) => ({ sessionID })), providers: Array.from({ length: 30 }, (_, providerID) => ({ providerID })),
      models: Array.from({ length: 40 }, (_, modelID) => ({ modelID })), mostUsedModel: { modelID: "top" }, periods: [], providerSeries: [], modelSeries: [],
    }
    const result = yield* usage.execute({ action: "summary", window: "7d", sections: ["activity", "economics", "models"], limit: 5 })
    expect(summaryCalls).toHaveLength(1)
    expect(result.structured).toMatchObject({ economics: { rates: { cacheHitRate: 0.5 } }, models: { totalModels: 40, truncated: true }, activity: { punchcard: expect.any(Array), totalSessions: 30 } })
    expect((result.structured as { series?: unknown }).series).toBeUndefined()

    const oxp = yield* usage.execute({ action: "oxpContext", window: "30d" })
    expect(oxp.structured).toMatchObject({ totals: { estimatedTokens: 32_228_100_000 }, coverage: { complete: false }, workload: { totals: { calls: 11 } } })
    expect(oxp.metadata).toMatchObject({ source: "oxp-attribution", provenance: "empirical OXP invocation attribution; estimates and source coverage are explicit" })
  }))

  it.live(
    "authorizes a real supervised Session before reading durable usage",
    Effect.gen(function* () {
      const usage = yield* OxpUsage.Service
      const result = yield* usage.execute({ action: "context", sessionID, rootID })
      expect(events).toEqual([
        "supervise:" + sessionID,
        "usage:" + sessionID,
        "telemetry:" + sessionID,
        "revalidate:egress",
      ])
      expect(result.structured).toMatchObject({
        kind: "context",
        source: "durable-usage",
        sessionID,
        breakdown,
        contextWindowUtilization: 80,
        contextWindowUtilizationSource: "latest-settled-telemetry",
        liveContextWindowUtilization: null,
        settledContext: { total: 160, limit: 200, usage: 80 },
      })
      expect(JSON.stringify(result)).not.toContain("PRIVATE: never cross OXP")
      expect(JSON.stringify(result)).not.toContain("PRIVATE_ACCOUNT_ID")
      expect(result.output).toContain("Latest settled provider context: 160/200 tokens (80%)")
      expect(result.output).toContain("Live in-flight context-window occupancy: unavailable")
    }),
  )

  it.live(
    "falls back to the indexed last settled provider generation without telemetry",
    Effect.gen(function* () {
      noLiveTelemetry = true
      const usage = yield* OxpUsage.Service
      const result = yield* usage.execute({ action: "context", sessionID, rootID })
      expect(result.structured).toMatchObject({
        contextWindowUtilization: 37,
        contextWindowUtilizationSource: "latest-settled-history",
        settledContext: { total: 37, limit: 100, usage: 37 },
      })
      expect(events).toEqual([
        "supervise:" + sessionID,
        "usage:" + sessionID,
        "telemetry:" + sessionID,
        "revalidate:egress",
      ])
    }),
  )

  it.live(
    "does not request telemetry or manufacture a context number when durable usage is missing",
    Effect.gen(function* () {
      missingHistory = true
      const usage = yield* OxpUsage.Service
      const result = yield* usage.execute({ action: "context", sessionID, rootID })
      expect(result.structured).toMatchObject({
        missing: true,
        contextWindowUtilization: null,
        settledContext: null,
        contextWindowUtilizationSource: "not-available",
      })
      expect(events).toEqual(["supervise:" + sessionID, "usage:" + sessionID, "revalidate:egress"])
    }),
  )

  it.live(
    "does not touch Usage when supervision rejects a root/session",
    Effect.gen(function* () {
      resolveFailure = true
      const usage = yield* OxpUsage.Service
      const exit = yield* usage.execute({ action: "context", sessionID, rootID }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(events).toEqual(["supervise:" + sessionID])
    }),
  )

  it.live(
    "fails closed if authority is revoked between read and egress",
    Effect.gen(function* () {
      revoked = true
      const usage = yield* OxpUsage.Service
      const exit = yield* usage.execute({ action: "context", sessionID, rootID }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(events).toEqual([
        "supervise:" + sessionID,
        "usage:" + sessionID,
        "telemetry:" + sessionID,
        "revalidate:egress",
      ])
    }),
  )

  it.live(
    "cancels before a Session or database lookup",
    Effect.gen(function* () {
      const usage = yield* OxpUsage.Service
      const controller = new AbortController()
      controller.abort()
      const exit = yield* usage.execute({ action: "context", sessionID, rootID }, controller.signal).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(events).toEqual([])
    }),
  )
})
