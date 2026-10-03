import { afterAll, describe, expect } from "bun:test"
import path from "path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Usage } from "@/usage/usage"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const BASE = 1_800_000_000_000

const modelsDevStub = Layer.succeed(
  ModelsDev.Service,
  ModelsDev.Service.of({
    getCached: () => Effect.succeed({}),
    getForSelectedProvider: () => Effect.succeed({}),
    get: () =>
      Effect.succeed({
        openai: {
          id: "openai",
          name: "OpenAI",
          env: [],
          models: {
            "gpt-test": {
              id: "gpt-test",
              name: "GPT Test",
              family: "gpt",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: true,
              temperature: true,
              tool_call: true,
              limit: { context: 128_000, output: 32_000 },
              cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
            },
          },
        },
      } satisfies Record<string, ModelsDev.Provider>),
    getDecisionModels: () => Effect.succeed({}),
    refresh: () => Effect.void,
  }),
)

const tmp = await tmpdir()
const dbPath = path.join(tmp.path, "openfork.db")
const usageLayer = LayerNode.compile(Usage.node, [
  [Database.node, Database.layerFromPath(dbPath)],
  [ModelsDev.node, modelsDevStub],
])

const message = (input: {
  id: string
  role: "user" | "assistant"
  created: number
  provenance?: { owner: "user" | "host"; source: string }
  system?: string
}) => ({
  id: input.id,
  role: input.role,
  time: { created: input.created, ...(input.role === "assistant" ? { completed: input.created + 500 } : {}) },
  ...(input.provenance ? { provenance: input.provenance } : {}),
  ...(input.system ? { system: input.system } : {}),
  ...(input.role === "assistant"
    ? {
        parentID: "u1",
        modelID: "gpt-test",
        providerID: "openai",
        cost: 0.25,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 10 } },
        mode: "primary",
        agent: "build",
        path: { cwd: "/ctx", root: "/ctx" },
      }
    : {}),
})

const part = (type: string, extra: Record<string, unknown>) => ({ type, ...extra })

await Effect.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`
      INSERT INTO project (id, worktree, name, sandboxes, time_created, time_updated)
      VALUES ('pctx', '/ctx', 'ctx-project', '[]', ${BASE}, ${BASE})
    `)
    yield* db.run(sql`
      INSERT INTO session (
        id, project_id, directory, slug, title, version,
        cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
        time_created, time_updated
      ) VALUES (
        'ctx', 'pctx', '/ctx', 'ctx', 'Context projection', '1',
        0.25, 100, 20, 5, 40, 10,
        ${BASE}, ${BASE + 10_000}
      )
    `)

    const messages = [
      message({
        id: "u1",
        role: "user",
        created: BASE + 100,
        provenance: { owner: "user", source: "prompt" },
        system: "human-system",
      }),
      message({
        id: "goal1",
        role: "user",
        created: BASE + 200,
        provenance: { owner: "host", source: "goal.continuation" },
        system: "newer-host-system-must-not-win",
      }),
      message({
        id: "shell1",
        role: "user",
        created: BASE + 300,
        provenance: { owner: "user", source: "shell" },
      }),
      message({
        id: "compact1",
        role: "user",
        created: BASE + 400,
        provenance: { owner: "host", source: "compaction" },
      }),
      message({ id: "a1", role: "assistant", created: BASE + 500 }),
    ] as const

    for (const item of messages) {
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (
          ${item.id},
          'ctx',
          ${item.time.created},
          ${item.time.created},
          ${JSON.stringify(item)}
        )
      `)
    }

    const parts = [
      ["p-u", "u1", part("text", { text: "12345678", synthetic: false })],
      // search_text is deliberately empty: synthetic text is excluded from the
      // FTS projection but must still contribute to provider-visible context.
      ["p-goal", "goal1", part("text", { text: "abcdefgh", synthetic: true })],
      ["p-shell", "shell1", part("text", { text: "1234", synthetic: true })],
      ["p-compact", "compact1", part("text", { text: "abcdefgh", synthetic: true })],
      ["p-a-text", "a1", part("text", { text: "abcdefgh" })],
      ["p-a-reason", "a1", part("reasoning", { text: "1234" })],
      [
        "p-tool",
        "a1",
        part("tool", {
          tool: "example",
          state: {
            status: "completed",
            input: { q: "abcdefgh" },
            output: "abcdefghijkl",
            time: { start: BASE + 600, end: BASE + 900 },
          },
        }),
      ],
    ] as const

    for (const [id, messageID, data] of parts) {
      yield* db.run(sql`
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, search_text)
        VALUES (${id}, ${messageID}, 'ctx', ${BASE + 600}, ${BASE + 600}, ${JSON.stringify(data)}, '')
      `)
    }

    yield* db.run(sql`
      INSERT INTO usage_record (
        message_id, session_id, provider_id, model_id, variant, agent, mode,
        created_at, request_sent_at, first_token_at, streamed_at, completed_at,
        cost_usd, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
      ) VALUES (
        'a1', 'ctx', 'openai', 'gpt-test', 'high', 'build', 'primary',
        ${BASE + 500}, ${BASE + 510}, ${BASE + 550}, ${BASE + 850}, ${BASE + 1000},
        0.25, 100, 40, 10, 20, 5
      )
    `)
  }).pipe(Effect.provide(Database.layerFromPath(dbPath))),
)

const it = testEffect(usageLayer)

afterAll(async () => {
  await tmp[Symbol.asyncDispose]()
})

describe("usage session context projection", () => {
  it.live("projects the whole durable session without hydrating transcript rows into JS", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const usage = yield* Usage.Service
      const context = yield* usage.sessionContext("ctx")

      expect(context).toBeDefined()
      expect(context?.counts).toEqual({ all: 5, user: 1, assistant: 1 })
      expect(context?.systemPrompt).toBe("human-system")
      expect(context?.totals.tokens).toEqual({
        input: 100,
        cacheRead: 40,
        cacheWrite: 10,
        output: 20,
        reasoning: 5,
      })
      expect(context?.totals.toolCalls).toBe(1)
      expect(context?.totals.toolMs).toBe(300)

      expect(context?.models).toHaveLength(1)
      expect(context?.models[0]?.providerName).toBe("OpenAI")
      expect(context?.models[0]?.modelName).toBe("GPT Test")
      expect(context?.models[0]?.messages).toBe(1)
      expect(context?.models[0]?.variant).toBe("high")
      expect(context?.latest).toEqual({
        providerID: "openai",
        modelID: "gpt-test",
        variant: "high",
        providerName: "OpenAI",
        modelName: "GPT Test",
        contextLimit: 128_000,
        completedAt: BASE + 1000,
        tokens: { input: 100, cacheRead: 40, cacheWrite: 10, output: 20, reasoning: 5 },
      })

      // Empty/aborted settlements are valid durable usage records, but they
      // contain no provider context observation and must not erase the most
      // recent meaningful occupancy fallback.
      yield* db.run(sql`
        INSERT INTO usage_record (
          message_id, session_id, provider_id, model_id, variant, agent, mode,
          created_at, completed_at, cost_usd,
          input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
        ) VALUES (
          'a-empty', 'ctx', 'openai', 'gpt-empty', 'high', 'build', 'primary',
          ${BASE + 1100}, ${BASE + 1200}, 0,
          0, 0, 0, 0, 0
        )
      `)
      const afterEmptySettlement = yield* usage.sessionContext("ctx")
      expect(afterEmptySettlement?.latest).toEqual(context?.latest)

      expect(context?.breakdown.system).toBe(3)
      expect(context?.breakdown.user).toBe(2)
      expect(context?.breakdown.synthetic).toBe(2)
      expect(context?.breakdown.shell).toBe(1)
      expect(context?.breakdown.compaction).toBe(2)
      expect(context?.breakdown.assistant).toBe(3)
      expect(context?.breakdown.tool).toBeGreaterThan(0)
    }).pipe(Effect.provide(Database.layerFromPath(dbPath))),
  )

  it.live("invalidates the compact projection on session events and post-event usage settlement", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const usage = yield* Usage.Service

      yield* db.run(sql`
        INSERT INTO session (
          id, project_id, directory, slug, title, version,
          cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          time_created, time_updated
        ) VALUES (
          'ctx-cache', 'pctx', '/ctx', 'ctx-cache', 'Context cache', '1',
          0, 0, 0, 0, 0, 0,
          ${BASE}, ${BASE}
        )
      `)
      yield* db.run(sql`
        INSERT INTO event_sequence (aggregate_id, seq)
        VALUES ('ctx-cache', 1)
      `)
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (
          'cache-u1',
          'ctx-cache',
          ${BASE + 1},
          ${BASE + 1},
          ${JSON.stringify(
            message({
              id: "cache-u1",
              role: "user",
              created: BASE + 1,
              provenance: { owner: "user", source: "prompt" },
            }),
          )}
        )
      `)

      const first = yield* usage.sessionContext("ctx-cache")
      expect(first?.counts).toEqual({ all: 1, user: 1, assistant: 0 })
      expect(first?.latest).toBeUndefined()

      // A normal durable Session mutation advances event_sequence. The next
      // read must reject the cached compact projection even without Usage data.
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (
          'cache-a1',
          'ctx-cache',
          ${BASE + 2},
          ${BASE + 2},
          ${JSON.stringify(message({ id: "cache-a1", role: "assistant", created: BASE + 2 }))}
        )
      `)
      yield* db.run(sql`UPDATE event_sequence SET seq = 2 WHERE aggregate_id = 'ctx-cache'`)

      const afterMessage = yield* usage.sessionContext("ctx-cache")
      expect(afterMessage?.counts).toEqual({ all: 2, user: 1, assistant: 1 })
      expect(afterMessage?.latest).toBeUndefined()

      // UsageRecord is persisted after the final message event during cleanup,
      // so event_sequence may already be stable. Latest settled usage identity
      // is the second watermark that closes that race.
      yield* db.run(sql`
        INSERT INTO usage_record (
          message_id, session_id, provider_id, model_id, variant, agent, mode,
          created_at, request_sent_at, first_token_at, streamed_at, completed_at,
          cost_usd, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens
        ) VALUES (
          'cache-a1', 'ctx-cache', 'openai', 'gpt-test', 'high', 'build', 'primary',
          ${BASE + 2}, ${BASE + 3}, ${BASE + 4}, ${BASE + 5}, ${BASE + 6},
          0.25, 100, 40, 10, 20, 5
        )
      `)
      yield* db.run(sql`
        UPDATE session
        SET
          cost = 0.25,
          tokens_input = 100,
          tokens_output = 20,
          tokens_reasoning = 5,
          tokens_cache_read = 40,
          tokens_cache_write = 10
        WHERE id = 'ctx-cache'
      `)

      const afterUsage = yield* usage.sessionContext("ctx-cache")
      expect(afterUsage?.counts).toEqual({ all: 2, user: 1, assistant: 1 })
      expect(afterUsage?.latest).toMatchObject({
        providerID: "openai",
        modelID: "gpt-test",
        completedAt: BASE + 6,
      })
      expect(afterUsage?.totals.tokens).toEqual({
        input: 100,
        cacheRead: 40,
        cacheWrite: 10,
        output: 20,
        reasoning: 5,
      })
    }).pipe(Effect.provide(Database.layerFromPath(dbPath))),
  )

  it.live("projects current-only special-agent sessions from their durable transcript", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const usage = yield* Usage.Service
      const sessionID = "ctx-special"
      const failedID = "msg_special_failed"
      const assistantID = "msg_special_assistant"

      yield* db.run(sql`
        INSERT INTO session (
          id, project_id, directory, slug, title, version, metadata,
          cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          time_created, time_updated
        ) VALUES (
          ${sessionID}, 'pctx', '/ctx', 'ctx-special', 'Goal Auditor · Context projection', '1',
          ${JSON.stringify({
            specialAgent: "goal_auditor",
            specialAgentOwnerKind: "goal",
            specialAgentOwnerID: "ctx\u0000goal",
          })},
          0, 0, 0, 0, 0, 0,
          ${BASE + 20_000}, ${BASE + 20_000}
        )
      `)
      yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES (${sessionID}, 7)`)

      const rows = [
        {
          id: "msg_special_prompt",
          type: "synthetic",
          seq: 1,
          created: BASE + 20_010,
          data: {
            time: { created: BASE + 20_010 },
            provenance: { owner: "host", source: "special-agent.goal-auditor" },
            sessionID,
            text: "Audit the release evidence",
          },
        },
        {
          id: "msg_special_system",
          type: "system",
          seq: 2,
          created: BASE + 20_020,
          data: { time: { created: BASE + 20_020 }, text: "[GOAL AUDIT CYCLE] Read-only verification." },
        },
        {
          id: failedID,
          type: "assistant",
          seq: 3,
          created: BASE + 20_030,
          data: {
            time: { created: BASE + 20_030, requestSentAt: BASE + 20_031 },
            agent: "goal_auditor",
            model: { providerID: "openai", id: "gpt-test@zen-account-1", variant: "high" },
            content: [],
          },
        },
        {
          id: assistantID,
          type: "assistant",
          seq: 4,
          created: BASE + 21_000,
          data: {
            time: {
              created: BASE + 21_000,
              requestSentAt: BASE + 21_010,
              firstTokenAt: BASE + 21_050,
            },
            agent: "goal_auditor",
            model: { providerID: "openai", id: "gpt-test@zen-account-1", variant: "high" },
            content: [
              { type: "reasoning", id: "r1", text: "Checking evidence." },
              { type: "text", id: "t1", text: "The evidence is internally consistent." },
              {
                type: "tool",
                id: "call-1",
                name: "read",
                state: {
                  status: "completed",
                  input: { path: "evidence.md" },
                  content: [{ type: "text", text: "evidence payload" }],
                  structured: {},
                },
                time: { created: BASE + 21_250, ran: BASE + 21_300, completed: BASE + 21_325 },
              },
            ],
          },
        },
      ] as const

      for (const row of rows) {
        yield* db.run(sql`
          INSERT INTO session_message (
            id, session_id, type, seq, time_created, time_updated, data, search_text
          ) VALUES (
            ${row.id}, ${sessionID}, ${row.type}, ${row.seq},
            ${row.created}, ${row.created}, ${JSON.stringify(row.data)}, ''
          )
        `)
      }

      yield* db.run(sql`
        INSERT INTO session_message_lifecycle (message_id, streamed_at, settlement)
        VALUES (
          ${failedID},
          NULL,
          ${JSON.stringify({
            type: "failed",
            completed: BASE + 20_040,
            error: { type: "unknown", message: "provider turn failed" },
          })}
        )
      `)
      yield* db.run(sql`
        INSERT INTO session_message_lifecycle (message_id, streamed_at, settlement)
        VALUES (
          ${assistantID},
          ${BASE + 21_200},
          ${JSON.stringify({
            type: "ended",
            completed: BASE + 21_330,
            finish: "tool-calls",
            cost: 0,
            tokens: { input: 12, output: 4, reasoning: 2, cache: { read: 30, write: 3 } },
          })}
        )
      `)
      yield* db.run(sql`
        INSERT INTO session_message_tool_overlay (message_id, call_id)
        VALUES (${assistantID}, 'call-1')
      `)

      // Intentionally no legacy message/part rows, usage_record rows, or
      // session_telemetry row. This is the historical special-agent shape that
      // used to render an entirely empty Context pane.
      const context = yield* usage.sessionContext(sessionID)

      expect(context).toBeDefined()
      expect(context?.counts).toEqual({ all: 4, user: 0, assistant: 2 })
      expect(context?.totals.messages).toBe(1)
      expect(context?.totals.toolCalls).toBe(1)
      expect(context?.totals.toolMs).toBe(25)
      expect(context?.totals.cost).toBe(0)
      expect(context?.totals.tokens).toEqual({
        input: 12,
        cacheRead: 30,
        cacheWrite: 3,
        output: 4,
        reasoning: 2,
      })
      expect(context?.totals.ttftMs).toBe(50)
      expect(context?.totals.upstreamTTFTMs).toBe(40)
      expect(context?.totals.generatedMs).toBe(150)
      expect(context?.latest).toMatchObject({
        providerID: "openai",
        modelID: "gpt-test@zen-account-1",
        providerName: "OpenAI",
        modelName: "GPT Test",
        contextLimit: 128_000,
        completedAt: BASE + 21_330,
      })
      expect(context?.models).toHaveLength(1)
      expect(context?.models[0]).toMatchObject({
        providerID: "openai",
        modelID: "gpt-test@zen-account-1",
        modelName: "GPT Test",
        messages: 1,
        toolCalls: 1,
      })
      expect(context?.breakdown.system).toBe(0)
      expect(context?.breakdown.other).toBeGreaterThan(0)
      expect(context?.breakdown.synthetic).toBeGreaterThan(0)
      expect(context?.breakdown.assistant).toBeGreaterThan(0)
      expect(context?.breakdown.tool).toBeGreaterThan(0)
    }).pipe(Effect.provide(Database.layerFromPath(dbPath))),
  )

  it.live("keeps special-agent metrics populated when OPCL externalizes assistant payload JSON", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const usage = yield* Usage.Service
      const sessionID = "ctx-special-opcl"
      const assistantID = "msg_special_opcl_assistant"

      yield* db.run(sql`
        INSERT INTO session (
          id, project_id, directory, slug, title, version, metadata, model,
          cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          time_created, time_updated
        ) VALUES (
          ${sessionID}, 'pctx', '/ctx', 'ctx-special-opcl', 'Goal Auditor · OPCL projection', '1',
          ${JSON.stringify({
            specialAgent: "goal_auditor",
            specialAgentOwnerKind: "goal",
            specialAgentOwnerID: "ctx-opcl\u0000goal",
          })},
          ${JSON.stringify({ providerID: "openai", id: "gpt-test@zen-opcl", variant: "high" })},
          0, 0, 0, 0, 0, 0,
          ${BASE + 30_000}, ${BASE + 31_000}
        )
      `)
      yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES (${sessionID}, 3)`)
      yield* db.run(sql`
        INSERT INTO session_message (
          id, session_id, type, seq, time_created, time_updated, data, search_text
        ) VALUES (
          ${assistantID}, ${sessionID}, 'assistant', 1,
          ${BASE + 30_100}, ${BASE + 30_100},
          ${JSON.stringify({ $cdbRef: "event-value-opcl-test" })},
          'Externalized assistant reasoning and response'
        )
      `)
      yield* db.run(sql`
        INSERT INTO session_message_lifecycle (message_id, streamed_at, settlement)
        VALUES (
          ${assistantID},
          ${BASE + 30_800},
          ${JSON.stringify({
            type: "ended",
            completed: BASE + 30_900,
            finish: "stop",
            cost: 0.125,
            tokens: { input: 20, output: 8, reasoning: 3, cache: { read: 40, write: 2 } },
          })}
        )
      `)

      const context = yield* usage.sessionContext(sessionID)

      expect(context?.counts).toEqual({ all: 1, user: 0, assistant: 1 })
      expect(context?.totals.messages).toBe(1)
      expect(context?.totals.cost).toBe(0.125)
      expect(context?.totals.tokens).toEqual({
        input: 20,
        cacheRead: 40,
        cacheWrite: 2,
        output: 8,
        reasoning: 3,
      })
      expect(context?.latest).toMatchObject({
        providerID: "openai",
        modelID: "gpt-test@zen-opcl",
        modelName: "GPT Test",
        contextLimit: 128_000,
      })
      expect(context?.models[0]).toMatchObject({
        providerID: "openai",
        modelID: "gpt-test@zen-opcl",
        modelName: "GPT Test",
        messages: 1,
      })
      expect(context?.breakdown.assistant).toBeGreaterThan(0)
    }).pipe(Effect.provide(Database.layerFromPath(dbPath))),
  )

  it.live("falls back to maintenance usage for pre-ledger special-agent sessions", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const usage = yield* Usage.Service
      const sessionID = "ctx-special-maintenance"

      yield* db.run(sql`
        INSERT INTO session (
          id, project_id, directory, slug, title, version, metadata, model,
          cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          time_created, time_updated
        ) VALUES (
          ${sessionID}, 'pctx', '/ctx', 'ctx-special-maintenance', 'Goal Auditor · historical maintenance only', '1',
          ${JSON.stringify({
            specialAgent: "goal_auditor",
            specialAgentOwnerKind: "goal",
            specialAgentOwnerID: "ctx-maintenance\u0000goal",
          })},
          ${JSON.stringify({ providerID: "openai", id: "gpt-test", variant: "high" })},
          0, 0, 0, 0, 0, 0,
          ${BASE + 40_000}, ${BASE + 41_000}
        )
      `)
      yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES (${sessionID}, 1)`)
      yield* db.run(sql`
        INSERT INTO maintenance_usage (
          agent, provider_id, model_id, variant, session_id, project_id,
          requests, cost_usd, cost_estimated,
          input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens,
          time_started, time_completed
        ) VALUES (
          'goal_auditor', 'openai', 'gpt-test', 'high', ${sessionID}, 'pctx',
          2, 0.5, 0,
          100, 60, 10, 20, 5, 195,
          ${BASE + 40_100}, ${BASE + 40_900}
        )
      `)

      const context = yield* usage.sessionContext(sessionID)

      expect(context?.totals.messages).toBe(2)
      expect(context?.totals.cost).toBe(0.5)
      expect(context?.totals.tokens).toEqual({
        input: 100,
        cacheRead: 60,
        cacheWrite: 10,
        output: 20,
        reasoning: 5,
      })
      expect(context?.latest).toMatchObject({
        providerID: "openai",
        modelID: "gpt-test",
        variant: "high",
        contextLimit: 128_000,
        completedAt: BASE + 40_900,
      })
      expect(context?.models).toHaveLength(1)
      expect(context?.models[0]).toMatchObject({
        providerID: "openai",
        modelID: "gpt-test",
        messages: 2,
        cost: 0.5,
      })
    }).pipe(Effect.provide(Database.layerFromPath(dbPath))),
  )

  it.live("returns undefined for a missing session", () =>
    Effect.gen(function* () {
      const usage = yield* Usage.Service
      expect(yield* usage.sessionContext("missing")).toBeUndefined()
    }),
  )
})
