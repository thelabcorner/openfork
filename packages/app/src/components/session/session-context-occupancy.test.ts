import { describe, expect, test } from "bun:test"
import type { UsageSessionContextResponse } from "@opencode-ai/sdk/v2/client"
import {
  newestSessionContextTelemetry,
  normalizeSessionContextResponse,
  projectSessionContextOccupancy,
} from "./session-context-occupancy"

const base = () =>
  ({
    history: {
      sessionID: "ses_test",
      createdAt: 1,
      updatedAt: 10,
      counts: { all: 1, user: 0, assistant: 1 },
      systemPrompt: null,
      totals: {
        messages: 1,
        toolCalls: 0,
        cost: 0,
        freeMessages: 0,
        tokens: { input: 20, cacheRead: 30, cacheWrite: 5, output: 10, reasoning: 5 },
        freeTokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        generatedMs: 0,
        toolMs: 0,
        ttftMs: 0,
        ttftRecords: 0,
        upstreamTTFTMs: 0,
        upstreamTTFTRecords: 0,
      },
      models: [],
      latest: {
        providerID: "openai",
        modelID: "gpt-old",
        providerName: "OpenAI",
        modelName: "GPT Old",
        contextLimit: 100,
        completedAt: 9,
        tokens: { input: 20, cacheRead: 30, cacheWrite: 5, output: 10, reasoning: 5 },
      },
      breakdown: { system: 0, user: 0, synthetic: 0, shell: 0, compaction: 0, assistant: 0, tool: 0, other: 0 },
    },
    telemetry: null,
  }) as unknown as UsageSessionContextResponse

describe("normalizeSessionContextResponse", () => {
  test("keeps the current wrapped response shape", () => {
    const snapshot = base()
    expect(normalizeSessionContextResponse(snapshot)).toBe(snapshot)
  })

  test("wraps the previous bare-history response shape at the fetch boundary", () => {
    const snapshot = base()
    const normalized = normalizeSessionContextResponse(snapshot.history)

    expect(normalized.history).toBe(snapshot.history)
    expect((normalized as any).telemetry).toBeNull()
  })

  test("rejects malformed responses before Context presentation code can dereference them", () => {
    expect(() => normalizeSessionContextResponse({ sessionID: "ses_test" })).toThrow("Invalid session context response")
  })
})

describe("newestSessionContextTelemetry", () => {
  const telemetry = (updatedAt: number, phase: "idle" | "generating", sampledAt?: number) =>
    ({
      sessionID: "ses_test",
      phase,
      updatedAt,
      ...(sampledAt === undefined ? {} : { sampledAt }),
      generatedMs: 0,
      toolMs: 0,
    }) as any

  test("keeps the HTTP snapshot when the streamed store is older", () => {
    const snapshot = telemetry(20, "idle")
    const streamed = telemetry(10, "generating")
    expect(newestSessionContextTelemetry(snapshot, streamed)).toBe(snapshot)
  })

  test("uses streamed telemetry once its authoritative watermark is newer", () => {
    const snapshot = telemetry(20, "idle")
    const streamed = telemetry(30, "generating")
    expect(newestSessionContextTelemetry(snapshot, streamed)).toBe(streamed)
  })

  test("keeps the later HTTP snapshot at an equal watermark", () => {
    const snapshot = telemetry(20, "idle")
    const streamed = telemetry(20, "generating")
    expect(newestSessionContextTelemetry(snapshot, streamed)).toBe(snapshot)
  })

  test("uses sampledAt to resolve equal semantic watermarks", () => {
    const snapshot = telemetry(20, "idle", 100)
    const streamed = telemetry(20, "generating", 101)
    expect(newestSessionContextTelemetry(snapshot, streamed)).toBe(streamed)
    expect(newestSessionContextTelemetry(telemetry(20, "idle", 102), streamed)).toEqual(
      telemetry(20, "idle", 102),
    )
  })
})

describe("projectSessionContextOccupancy", () => {
  test("uses indexed latest settled usage for a historical session without telemetry", () => {
    const result = projectSessionContextOccupancy(base())

    expect(result).toEqual({
      providerLabel: "OpenAI",
      modelLabel: "GPT Old",
      limit: 100,
      total: 70,
      usage: 70,
      updatedAt: 9,
    })
  })

  test("prefers authoritative telemetry context over historical fallback", () => {
    const snapshot = base()
    ;(snapshot as any).telemetry = {
      sessionID: "ses_test",
      phase: "idle",
      updatedAt: 20,
      generatedMs: 0,
      toolMs: 0,
      context: {
        model: { providerID: "anthropic", modelID: "claude-live", name: "Claude Live", contextLimit: 200 },
        tokens: { input: 40, output: 20, reasoning: 10, cache: { read: 80, write: 10 } },
      },
    }

    expect(projectSessionContextOccupancy(snapshot)).toEqual({
      providerLabel: "anthropic",
      modelLabel: "Claude Live",
      limit: 200,
      total: 160,
      usage: 80,
      updatedAt: 20,
    })
  })

  test("returns no occupancy when neither telemetry nor historical usage exists", () => {
    const snapshot = base()
    delete (snapshot.history as any).latest
    expect(projectSessionContextOccupancy(snapshot)).toBeUndefined()
  })
})
