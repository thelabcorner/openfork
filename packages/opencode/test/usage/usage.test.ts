import { describe, expect } from "bun:test"
import path from "path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Usage } from "@/usage/usage"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const BASE = 1_700_000_000_000

const CATALOG: Record<string, ModelsDev.Provider> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: [],
    models: {
      "claude-3.5": {
        id: "claude-3.5",
        name: "Claude 3.5",
        family: "claude",
        release_date: "2024-01-01",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200000, output: 100000 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: [],
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        family: "gpt",
        release_date: "2024-05-01",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 64000 },
        cost: { input: 2.5, output: 10, cache_read: 0.25, cache_write: 2.5 },
      },
    },
  },
}

const modelsDevStub = Layer.succeed(
  ModelsDev.Service,
  ModelsDev.Service.of({
    get: () => Effect.succeed(CATALOG),
    refresh: () => Effect.void,
  }),
)

type SeedMessage = {
  id: string
  sessionID: string
  providerID: string
  modelID: string
  variant?: string
  created: number
  completed: number
  requestSentAt?: number
  firstTokenAt?: number
  cost?: number | null
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
}

const MESSAGES: SeedMessage[] = [
  {
    id: "m1",
    sessionID: "s1",
    providerID: "anthropic",
    modelID: "claude-3.5",
    created: BASE,
    completed: BASE + 10_000,
    requestSentAt: BASE,
    firstTokenAt: BASE + 400,
    cost: 0.003,
    tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 50, reasoning: 0 },
  },
  {
    id: "m2",
    sessionID: "s1",
    providerID: "anthropic",
    modelID: "claude-3.5",
    variant: "high",
    created: BASE + 60_000,
    completed: BASE + 70_000,
    requestSentAt: BASE + 60_000,
    firstTokenAt: BASE + 60_300,
    cost: 0.002,
    tokens: { input: 50, cacheRead: 150, cacheWrite: 30, output: 80, reasoning: 20 },
  },
  {
    id: "m3",
    sessionID: "s2",
    providerID: "openai",
    modelID: "gpt-4o",
    created: BASE + 3_600_000,
    completed: BASE + 3_601_000,
    cost: null,
    tokens: { input: 200, cacheRead: 100, cacheWrite: 0, output: 40, reasoning: 0 },
  },
  {
    id: "m4",
    sessionID: "s3",
    providerID: "openai",
    modelID: "gpt-4o",
    created: BASE + 7_200_000,
    completed: BASE + 7_201_000,
    cost: 0.0001,
    tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 },
  },
  {
    id: "m5",
    sessionID: "s3",
    providerID: "mystery",
    modelID: "unknown-model",
    created: BASE + 8_000_000,
    completed: BASE + 8_001_000,
    cost: null,
    tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 },
  },
]

function seedMessage(db: Database.Interface["db"], message: SeedMessage) {
  const data = {
    role: "assistant",
    time: {
      created: message.created,
      completed: message.completed,
      ...(message.requestSentAt !== undefined ? { requestSentAt: message.requestSentAt } : {}),
      ...(message.firstTokenAt !== undefined ? { firstTokenAt: message.firstTokenAt } : {}),
    },
    modelID: message.modelID,
    providerID: message.providerID,
    ...(message.variant !== undefined ? { variant: message.variant } : {}),
    cost: message.cost ?? null,
    tokens: {
      input: message.tokens.input,
      output: message.tokens.output,
      reasoning: message.tokens.reasoning,
      cache: { read: message.tokens.cacheRead, write: message.tokens.cacheWrite },
    },
    parentID: `parent-${message.id}`,
    mode: "primary",
    agent: "build",
    path: { cwd: "/cwd", root: "/root" },
  }
  return db.run(
    sql`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (${message.id}, ${message.sessionID}, ${message.created}, ${message.completed}, ${JSON.stringify(data)})
    `,
  )
}

const seedDatabase = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`
    INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
    VALUES ('p1', '/proj/a', 'proj-a', '[]', ${BASE}, ${BASE}),
           ('p2', '/proj/b', 'proj-b', '[]', ${BASE}, ${BASE})
  `)
  yield* db.run(sql`
    INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated)
    VALUES ('s1', 'p1', '/proj/a', 's1', 'Session 1', '1', ${BASE}, ${BASE}),
           ('s2', 'p1', '/proj/a', 's2', 'Session 2', '1', ${BASE}, ${BASE}),
           ('s3', 'p2', '/proj/b', 's3', 'Session 3', '1', ${BASE}, ${BASE})
  `)
  yield* Effect.forEach(MESSAGES, (message) => seedMessage(db, message))
})

await using tmp = await tmpdir()
const dbPath = path.join(tmp.path, "opencode.db")
const usageLayer = LayerNode.compile(Usage.node, [
  [Database.node, Database.layerFromPath(dbPath)],
  [ModelsDev.node, modelsDevStub],
])
await Effect.runPromise(seedDatabase.pipe(Effect.provide(Database.layerFromPath(dbPath))))

const it = testEffect(usageLayer)

describe("usage summary aggregation", () => {
  it.live("aggregates global totals, rates, and cost provenance", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const summary = yield* usage.summary({
        since: BASE,
        until: BASE + 8_002_000,
        resolution: "day",
        projectID: null,
      })

      expect(summary.totals.messages).toBe(5)
      expect(summary.totals.sessions).toBe(3)
      expect(summary.totals.cost).toBeCloseTo(0.0051, 6)
      expect(summary.totals.estimatedCost).toBeCloseTo(0.000925, 6)
      expect(summary.totals.pricedRecords).toBe(4)
      expect(summary.totals.unpricedRecords).toBe(1)

      const tokens = summary.totals.tokens
      expect(tokens.input).toBe(370)
      expect(tokens.cacheRead).toBe(250)
      expect(tokens.cacheWrite).toBe(30)
      expect(tokens.output).toBe(180)
      expect(tokens.reasoning).toBe(20)

      expect(summary.totals.durationMs).toBe(23_000)
      expect(summary.totals.durationRecords).toBe(5)
      expect(summary.totals.ttftMs).toBe(700)
      expect(summary.totals.ttftRecords).toBe(2)

      expect(summary.rates.tokensPerSecond).toBeCloseTo(200 / 23, 4)
      expect(summary.rates.avgTokensPerTurn).toBeCloseTo(850 / 5, 4)
      expect(summary.rates.avgCostPerTurn).toBeCloseTo(0.006025 / 5, 6)
      expect(summary.rates.cacheHitRate).toBeCloseTo(250 / 620, 4)
      expect(summary.rates.cacheSavings).toBeCloseTo(0.00063, 6)
      expect(summary.rates.cacheSavingsCoverage).toBeCloseTo(4 / 5, 4)

      expect(summary.pricing.mode).toBe("mixed")
      expect(summary.pricing.coverage).toBeCloseTo(4 / 5, 4)

      expect(summary.mostUsedModel?.providerID).toBe("anthropic")
      expect(summary.mostUsedModel?.modelID).toBe("claude-3.5")
      expect(summary.mostUsedModel?.messages).toBe(2)
      expect(summary.mostUsedModel?.share).toBeCloseTo(0.4, 4)

      const anthropic = summary.providers.find((p) => p.providerID === "anthropic")
      expect(anthropic?.messages).toBe(2)
      expect(anthropic?.sessions).toBe(1)
      expect(anthropic?.cost).toBeCloseTo(0.005, 6)
      expect(anthropic?.tokens.input).toBe(150)

      const openai = summary.providers.find((p) => p.providerID === "openai")
      expect(openai?.sessions).toBe(2)
      expect(openai?.estimatedCost).toBeCloseTo(0.000925, 6)

      const mystery = summary.providers.find((p) => p.providerID === "mystery")
      expect(mystery?.unpricedRecords).toBe(1)

      const claudeDefault = summary.models.find((m) => m.modelID === "claude-3.5" && m.variant === null)
      expect(claudeDefault?.messages).toBe(1)
      const claudeHigh = summary.models.find((m) => m.modelID === "claude-3.5" && m.variant === "high")
      expect(claudeHigh?.messages).toBe(1)
      expect(claudeHigh?.cacheSavings).toBeCloseTo(0.000405, 6)

      const defaultVariant = summary.variants.find((v) => v.variant === null)
      expect(defaultVariant?.messages).toBe(4)
      expect(defaultVariant?.share).toBeCloseTo(0.8, 4)
      const highVariant = summary.variants.find((v) => v.variant === "high")
      expect(highVariant?.share).toBeCloseTo(0.2, 4)

      const projA = summary.projects.find((p) => p.projectID === "p1")
      expect(projA?.name).toBe("proj-a")
      expect(projA?.sessions).toBe(2)
      expect(projA?.messages).toBe(3)
      expect(projA?.tokens).toBe(820)
      const projB = summary.projects.find((p) => p.projectID === "p2")
      expect(projB?.sessions).toBe(1)
      expect(projB?.tokens).toBe(30)
    }),
  )

  it.live("attributes messages to completion-time periods", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const summary = yield* usage.summary({
        since: BASE,
        until: BASE + 8_002_000,
        resolution: "day",
        projectID: null,
      })
      const utcDayStart = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000
      const period1 = summary.periods.find((p) => p.start === utcDayStart(BASE))
      expect(period1?.messages).toBe(3)
      const period2 = summary.periods.find((p) => p.start === utcDayStart(BASE + 7_201_000))
      expect(period2?.messages).toBe(2)
    }),
  )

  it.live("filters by project", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const summary = yield* usage.summary({
        since: BASE,
        until: BASE + 8_002_000,
        resolution: "day",
        projectID: "p1",
      })
      expect(summary.totals.messages).toBe(3)
      expect(summary.totals.sessions).toBe(2)
      expect(summary.projects.every((p) => p.projectID === "p1")).toBe(true)
    }),
  )

  it.live("excludes messages outside the window", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const summary = yield* usage.summary({
        since: BASE + 3_000_000,
        until: BASE + 3_700_000,
        resolution: "hour",
        projectID: null,
      })
      expect(summary.totals.messages).toBe(1)
      expect(summary.totals.estimatedCost).toBeCloseTo(0.000925, 6)
    }),
  )

  it.live("dow and hours total the window messages", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      const summary = yield* usage.summary({
        since: BASE,
        until: BASE + 8_002_000,
        resolution: "day",
        projectID: null,
      })
      const dowMessages = summary.dow.reduce((total, bucket) => total + bucket.messages, 0)
      const hourMessages = summary.hours.reduce((total, bucket) => total + bucket.messages, 0)
      expect(dowMessages).toBe(5)
      expect(hourMessages).toBe(5)
      expect(summary.dow.length).toBe(7)
      expect(summary.hours.length).toBe(24)
    }),
  )
})
