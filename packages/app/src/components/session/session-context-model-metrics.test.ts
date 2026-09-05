import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2/client"
import { aggregateSessionContextByModel, liveGenerationProgress } from "./session-context-model-metrics"

const assistant = (
  id: string,
  args: {
    providerID?: string
    modelID?: string
    input: number
    output: number
    reasoning: number
    read: number
    write: number
    cost: number
    created: number
    completed?: number
  },
) => {
  return {
    id,
    role: "assistant",
    providerID: args.providerID ?? "openai",
    modelID: args.modelID ?? "gpt-4.1",
    cost: args.cost,
    tokens: {
      input: args.input,
      output: args.output,
      reasoning: args.reasoning,
      cache: { read: args.read, write: args.write },
    },
    time: { created: args.created, completed: args.completed },
  } as unknown as Message
}

const user = (id: string) => ({ id, role: "user", time: { created: 1 } }) as unknown as Message

const toolPart = (id: string) => ({ type: "tool", id }) as unknown as Part

const timedTextPart = (id: string, args: { start: number; end?: number; synthetic?: boolean; ignored?: boolean }) =>
  ({
    type: "text",
    id,
    text: "hi",
    synthetic: args.synthetic,
    ignored: args.ignored,
    time: args.end === undefined ? undefined : { start: args.start, end: args.end },
  }) as unknown as Part

const timedReasoningPart = (id: string, args: { start: number; end?: number }) =>
  ({
    type: "reasoning",
    id,
    text: "thinking",
    time: { start: args.start, end: args.end },
  }) as unknown as Part

const timedToolPart = (id: string, args: { start: number; end: number }) =>
  ({
    type: "tool",
    id,
    callID: id,
    tool: "bash",
    state: { status: "completed", time: { start: args.start, end: args.end } },
  }) as unknown as Part

describe("aggregateSessionContextByModel", () => {
  test("groups messages by provider+model and sums token/cost fields", () => {
    const messages = [
      user("u1"),
      assistant("a1", {
        providerID: "openai",
        modelID: "gpt-4.1",
        input: 100,
        output: 50,
        reasoning: 10,
        read: 20,
        write: 5,
        cost: 0.1,
        created: 1000,
      }),
      assistant("a2", {
        providerID: "anthropic",
        modelID: "claude",
        input: 200,
        output: 80,
        reasoning: 0,
        read: 0,
        write: 0,
        cost: 0.4,
        created: 2000,
      }),
      assistant("a3", {
        providerID: "openai",
        modelID: "gpt-4.1",
        input: 40,
        output: 20,
        reasoning: 0,
        read: 10,
        write: 0,
        cost: 0.05,
        created: 3000,
      }),
    ]

    const { session, models } = aggregateSessionContextByModel(messages, {}, [])

    expect(models).toHaveLength(2)
    const gpt = models.find((m) => m.key === "openai:gpt-4.1")!
    expect(gpt.messageCount).toBe(2)
    expect(gpt.input).toBe(140)
    expect(gpt.output).toBe(70)
    expect(gpt.cacheRead).toBe(30)
    expect(gpt.cost).toBeCloseTo(0.15)
    expect(gpt.freeMessageCount).toBe(0)
    expect(gpt.freeTokens).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

    expect(session.messageCount).toBe(3)
    expect(session.input).toBe(340)
    expect(session.cost).toBeCloseTo(0.55)
  })

  test("accumulates free-turn tokens exactly within a mixed model history", () => {
    const messages = [
      assistant("free", {
        input: 100,
        output: 20,
        reasoning: 5,
        read: 80,
        write: 10,
        cost: 0,
        created: 1,
      }),
      assistant("paid", {
        input: 900,
        output: 180,
        reasoning: 45,
        read: 720,
        write: 90,
        cost: 1,
        created: 2,
      }),
    ]

    const model = aggregateSessionContextByModel(messages, {}, []).models[0]
    expect(model.freeMessageCount).toBe(1)
    expect(model.freeTokens).toEqual({ input: 100, output: 20, reasoning: 5, cacheRead: 80, cacheWrite: 10 })
  })

  test("sorts models by total tokens descending", () => {
    const messages = [
      assistant("a1", {
        providerID: "small",
        modelID: "m",
        input: 10,
        output: 10,
        reasoning: 0,
        read: 0,
        write: 0,
        cost: 0,
        created: 1,
      }),
      assistant("a2", {
        providerID: "big",
        modelID: "m",
        input: 1000,
        output: 500,
        reasoning: 0,
        read: 0,
        write: 0,
        cost: 0,
        created: 2,
      }),
    ]

    const { models } = aggregateSessionContextByModel(messages, {}, [])
    expect(models[0].providerID).toBe("big")
    expect(models[1].providerID).toBe("small")
  })

  test("counts tool parts per message toward toolCallCount", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 0, read: 0, write: 0, cost: 0, created: 1 })]
    const parts = {
      a1: [toolPart("t1"), toolPart("t2"), timedTextPart("txt", { start: 0, end: 1 })],
    }

    const { session, models } = aggregateSessionContextByModel(messages, parts, [])
    expect(session.toolCallCount).toBe(2)
    expect(models[0].toolCallCount).toBe(2)
  })

  test("uses provider/model display names when metadata is available", () => {
    const messages = [
      assistant("a1", {
        providerID: "openai",
        modelID: "gpt-4.1",
        input: 10,
        output: 10,
        reasoning: 0,
        read: 0,
        write: 0,
        cost: 0,
        created: 1,
      }),
    ]
    const providers = [
      { id: "openai", name: "OpenAI", models: { "gpt-4.1": { name: "GPT-4.1", limit: { context: 1000 } } } },
    ]

    const { models } = aggregateSessionContextByModel(messages, {}, providers)
    expect(models[0].providerLabel).toBe("OpenAI")
    expect(models[0].modelLabel).toBe("GPT-4.1")
  })

  test("skips assistant messages with zero recorded tokens", () => {
    const messages = [
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0, cost: 0, created: 1 }),
      assistant("a2", { input: 5, output: 5, reasoning: 0, read: 0, write: 0, cost: 0, created: 2 }),
    ]

    const { session, models } = aggregateSessionContextByModel(messages, {}, [])
    expect(session.messageCount).toBe(1)
    expect(models[0].messageCount).toBe(1)
  })

  describe("cache-hit percent", () => {
    test("is null when there is no input and no cache reads (no evidence)", () => {
      const messages = [assistant("a1", { input: 0, output: 10, reasoning: 0, read: 0, write: 0, cost: 0, created: 1 })]
      const { session, models } = aggregateSessionContextByModel(messages, {}, [])
      expect(session.cacheHitPercent).toBeNull()
      expect(models[0].cacheHitPercent).toBeNull()
    })

    test("computes read / (read + input)", () => {
      const messages = [
        assistant("a1", { input: 25, output: 10, reasoning: 0, read: 75, write: 0, cost: 0, created: 1 }),
      ]
      const { session, models } = aggregateSessionContextByModel(messages, {}, [])
      expect(session.cacheHitPercent).toBe(75)
      expect(models[0].cacheHitPercent).toBe(75)
    })

    test("is 0 (not null) when there are fresh input tokens but zero cache reads", () => {
      const messages = [
        assistant("a1", { input: 100, output: 10, reasoning: 0, read: 0, write: 0, cost: 0, created: 1 }),
      ]
      const { session } = aggregateSessionContextByModel(messages, {}, [])
      expect(session.cacheHitPercent).toBe(0)
    })
  })

  describe("tokens per second", () => {
    test("is null when the message has no text/reasoning parts with timing", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 1000 }),
      ]
      const { session, models } = aggregateSessionContextByModel(messages, {}, [])
      expect(session.tokensPerSecond).toBeNull()
      expect(models[0].tokensPerSecond).toBeNull()
    })

    test("is null when a text part is missing its end timestamp (still streaming/aborted)", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 1000 }),
      ]
      const parts = { a1: [timedTextPart("t1", { start: 1000 })] }
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.tokensPerSecond).toBeNull()
    })

    test("computes tokens/sec from the text part's own generation span, not message.time", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 0 }),
      ]
      // message spans 0-10000ms, but the text was only streamed over 2000ms of it
      const parts = { a1: [timedTextPart("t1", { start: 0, end: 2000 })] }
      const { session, models } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.tokensPerSecond).toBe(50)
      expect(models[0].tokensPerSecond).toBe(50)
    })

    test("excludes tool-call execution time even when it falls between text parts", () => {
      const messages = [
        assistant("a1", { input: 10, output: 200, reasoning: 0, read: 0, write: 0, cost: 0, created: 0 }),
      ]
      const parts = {
        a1: [
          timedTextPart("t1", { start: 0, end: 1000 }),
          // a slow shell/batch tool call running for 30s in between generation steps
          timedToolPart("tool1", { start: 1000, end: 31000 }),
          timedTextPart("t2", { start: 31000, end: 32000 }),
        ],
      }
      // 200 output tokens over 1000ms + 1000ms = 2s of *generation* time = 100 tok/s,
      // NOT 200 tokens over the full 32s wall-clock span (~6.25 tok/s)
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.tokensPerSecond).toBe(100)
    })

    test("counts reasoning tokens and reasoning-part time toward the estimate", () => {
      const messages = [
        assistant("a1", { input: 10, output: 50, reasoning: 50, read: 0, write: 0, cost: 0, created: 0 }),
      ]
      const parts = {
        a1: [timedReasoningPart("r1", { start: 0, end: 500 }), timedTextPart("t1", { start: 500, end: 1000 })],
      }
      // (50 output + 50 reasoning) tokens over 1s = 100 tok/s
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.tokensPerSecond).toBe(100)
    })

    test("excludes synthetic and ignored text parts (e.g. compaction summaries)", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 0 }),
      ]
      const parts = {
        a1: [
          timedTextPart("synthetic", { start: 0, end: 5000, synthetic: true }),
          timedTextPart("ignored", { start: 5000, end: 10000, ignored: true }),
          timedTextPart("real", { start: 10000, end: 11000 }),
        ],
      }
      // only the real 1s span counts: 100 tokens / 1s = 100 tok/s
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.tokensPerSecond).toBe(100)
    })

    test("computes weighted average across messages, not an average of per-message rates", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 0 }),
        assistant("a2", { input: 10, output: 300, reasoning: 0, read: 0, write: 0, cost: 0, created: 2000 }),
      ]
      const parts = {
        a1: [timedTextPart("t1", { start: 0, end: 1000 })],
        a2: [timedTextPart("t2", { start: 2000, end: 3000 })],
      }
      // total 400 tokens over 2s = 200 tok/s (not the mean of 100 and 300 tok/s)
      const { session, models } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.tokensPerSecond).toBe(200)
      expect(models[0].tokensPerSecond).toBe(200)
    })

    test("excludes messages with no measurable generation time from the average, uses the rest", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 0 }),
        assistant("a2", { input: 10, output: 50, reasoning: 0, read: 0, write: 0, cost: 0, created: 1000 }),
      ]
      const parts = { a2: [timedTextPart("t2", { start: 1000, end: 2000 })] }
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.tokensPerSecond).toBe(50)
    })

    test("excludes a turn whose implied rate is physically implausible (transport burst), not just averages it in", () => {
      const messages = [
        // 3467 tokens "streamed" in 3ms implies ~1.16M tok/s — a burst-delivery artifact, not real speed
        assistant("a1", { input: 10, output: 3064, reasoning: 403, read: 0, write: 0, cost: 0, created: 0 }),
      ]
      const parts = { a1: [timedTextPart("t1", { start: 0, end: 3 })] }
      const { session, models } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.tokensPerSecond).toBeNull()
      expect(models[0].tokensPerSecond).toBeNull()
    })

    test("a single implausible turn does not pollute the weighted average of otherwise-plausible turns", () => {
      const messages = [
        assistant("a1", { input: 10, output: 3064, reasoning: 403, read: 0, write: 0, cost: 0, created: 0 }),
        assistant("a2", { input: 10, output: 200, reasoning: 0, read: 0, write: 0, cost: 0, created: 5000 }),
      ]
      const parts = {
        a1: [timedTextPart("t1", { start: 0, end: 3 })], // burst artifact, excluded
        a2: [timedTextPart("t2", { start: 5000, end: 7000 })], // 200 tokens / 2s = 100 tok/s
      }
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.tokensPerSecond).toBe(100)
    })

    test("accepts a turn right at the plausibility ceiling", () => {
      const messages = [
        assistant("a1", { input: 10, output: 1000, reasoning: 0, read: 0, write: 0, cost: 0, created: 0 }),
      ]
      // exactly 1000 tokens/sec
      const parts = { a1: [timedTextPart("t1", { start: 0, end: 1000 })] }
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.tokensPerSecond).toBe(1000)
    })

    describe("fallback to turn window minus tool time", () => {
      test("falls back to message.time window minus tool time when no part timing exists at all", () => {
        // provider/proxy that never streams deltas — no text/reasoning `time` on any part —
        // would otherwise always read "unavailable" even though we still know the turn took 4s
        const messages = [
          assistant("a1", {
            input: 10,
            output: 400,
            reasoning: 0,
            read: 0,
            write: 0,
            cost: 0,
            created: 0,
            completed: 4000,
          }),
        ]
        const { session } = aggregateSessionContextByModel(messages, {}, [])
        expect(session.tokensPerSecond).toBe(100)
      })

      test("subtracts tool execution time from the fallback window", () => {
        const messages = [
          assistant("a1", {
            input: 10,
            output: 400,
            reasoning: 0,
            read: 0,
            write: 0,
            cost: 0,
            created: 0,
            completed: 10_000,
          }),
        ]
        // 10s total window, 6s of which was a shell tool call -> 4s of actual generation
        const parts = { a1: [timedToolPart("tool1", { start: 2000, end: 8000 })] }
        const { session } = aggregateSessionContextByModel(messages, parts, [])
        expect(session.tokensPerSecond).toBe(100)
      })

      test("falls back when the precise part-level measurement fails the plausibility check", () => {
        const messages = [
          assistant("a1", {
            input: 10,
            output: 3064,
            reasoning: 403,
            read: 0,
            write: 0,
            cost: 0,
            created: 0,
            completed: 3467,
          }),
        ]
        const parts = {
          // burst-delivery artifact: 3467 tokens "streamed" in 3ms
          a1: [timedTextPart("t1", { start: 0, end: 3 })],
        }
        // falls back to the 3467ms turn window (no tool calls) -> 1000 tok/s, not ~1.16M
        const { session } = aggregateSessionContextByModel(messages, parts, [])
        expect(session.tokensPerSecond).toBe(1000)
      })

      test("is null when there is no completion timestamp for the fallback to use either", () => {
        const messages = [
          assistant("a1", { input: 10, output: 3064, reasoning: 403, read: 0, write: 0, cost: 0, created: 0 }),
        ]
        const parts = { a1: [timedTextPart("t1", { start: 0, end: 3 })] }
        const { session } = aggregateSessionContextByModel(messages, parts, [])
        expect(session.tokensPerSecond).toBeNull()
      })

      test("is null when the fallback window itself is still implausible", () => {
        const messages = [
          assistant("a1", {
            input: 10,
            output: 1_000_000,
            reasoning: 0,
            read: 0,
            write: 0,
            cost: 0,
            created: 0,
            completed: 100,
          }),
        ]
        const { session } = aggregateSessionContextByModel(messages, {}, [])
        expect(session.tokensPerSecond).toBeNull()
      })
    })
  })

  test("returns empty totals and no models for an empty session", () => {
    const { session, models } = aggregateSessionContextByModel([], {}, [])
    expect(models).toEqual([])
    expect(session.messageCount).toBe(0)
    expect(session.total).toBe(0)
    expect(session.cacheHitPercent).toBeNull()
    expect(session.tokensPerSecond).toBeNull()
  })

  describe("cost breakdown", () => {
    const providersWithRates = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
            cost: { input: 2, output: 8, cache: { read: 0.5, write: 2.5 } },
          },
        },
      },
    ]

    test("derives per-category cost from the model rate card and token counts", () => {
      const messages = [
        assistant("a1", {
          input: 1_000_000,
          output: 500_000,
          reasoning: 0,
          read: 2_000_000,
          write: 100_000,
          cost: 0,
          created: 1,
        }),
      ]

      const { models } = aggregateSessionContextByModel(messages, {}, providersWithRates)
      const breakdown = models[0].costBreakdown!
      expect(breakdown.input).toBeCloseTo(2)
      expect(breakdown.output).toBeCloseTo(4)
      expect(breakdown.cacheRead).toBeCloseTo(1)
      expect(breakdown.cacheWrite).toBeCloseTo(0.25)
      expect(breakdown.total).toBeCloseTo(7.25)
    })

    test("is undefined for a model when no rate card is available", () => {
      const messages = [
        assistant("a1", {
          providerID: "unknown",
          modelID: "mystery",
          input: 100,
          output: 100,
          reasoning: 0,
          read: 0,
          write: 0,
          cost: 0.5,
          created: 1,
        }),
      ]

      const { models } = aggregateSessionContextByModel(messages, {}, [])
      expect(models[0].costBreakdown).toBeUndefined()
      expect(models[0].costRate).toBeUndefined()
    })

    test("session breakdown sums available per-model breakdowns and flags completeness", () => {
      const messages = [
        assistant("a1", {
          providerID: "openai",
          modelID: "gpt-4.1",
          input: 1_000_000,
          output: 0,
          reasoning: 0,
          read: 0,
          write: 0,
          cost: 2,
          created: 1,
        }),
        assistant("a2", {
          providerID: "unrated",
          modelID: "mystery",
          input: 100,
          output: 100,
          reasoning: 0,
          read: 0,
          write: 0,
          cost: 0.3,
          created: 2,
        }),
      ]

      const { session } = aggregateSessionContextByModel(messages, {}, providersWithRates)
      expect(session.costBreakdown!.input).toBeCloseTo(2)
      expect(session.costBreakdown!.total).toBeCloseTo(2)
      expect(session.costBreakdownComplete).toBe(false)
    })

    test("session breakdown is complete when every used model has a rate card", () => {
      const messages = [
        assistant("a1", {
          providerID: "openai",
          modelID: "gpt-4.1",
          input: 1_000_000,
          output: 0,
          reasoning: 0,
          read: 0,
          write: 0,
          cost: 2,
          created: 1,
        }),
      ]

      const { session } = aggregateSessionContextByModel(messages, {}, providersWithRates)
      expect(session.costBreakdownComplete).toBe(true)
    })

    test("session breakdown is undefined when no used model has a rate card", () => {
      const messages = [
        assistant("a1", { input: 100, output: 100, reasoning: 0, read: 0, write: 0, cost: 0.1, created: 1 }),
      ]

      const { session } = aggregateSessionContextByModel(messages, {}, [])
      expect(session.costBreakdown).toBeUndefined()
      expect(session.costBreakdownComplete).toBe(false)
    })
  })

  describe("cache savings", () => {
    const providersWithRates = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
            cost: { input: 2, output: 8, cache: { read: 0.5, write: 2.5 } },
          },
        },
      },
    ]

    test("is the delta between the fresh-input rate and the cache-read rate for cached tokens", () => {
      const messages = [
        assistant("a1", {
          providerID: "openai",
          modelID: "gpt-4.1",
          input: 0,
          output: 0,
          reasoning: 0,
          read: 1_000_000,
          write: 0,
          cost: 0,
          created: 1,
        }),
      ]
      // 1M cached tokens at $0.50/M instead of $2.00/M input rate = $1.50 saved
      const { models, session } = aggregateSessionContextByModel(messages, {}, providersWithRates)
      expect(models[0].cacheSavings).toBeCloseTo(1.5)
      expect(session.cacheSavings).toBeCloseTo(1.5)
    })

    test("is 0 (not undefined) when there is a rate card but no cache reads", () => {
      const messages = [
        assistant("a1", {
          providerID: "openai",
          modelID: "gpt-4.1",
          input: 100,
          output: 10,
          reasoning: 0,
          read: 0,
          write: 0,
          cost: 0,
          created: 1,
        }),
      ]
      const { models } = aggregateSessionContextByModel(messages, {}, providersWithRates)
      expect(models[0].cacheSavings).toBe(0)
    })

    test("is undefined for a model with no rate card", () => {
      const messages = [
        assistant("a1", {
          providerID: "unknown",
          modelID: "mystery",
          input: 0,
          output: 0,
          reasoning: 0,
          read: 1000,
          write: 0,
          cost: 0,
          created: 1,
        }),
      ]
      const { models } = aggregateSessionContextByModel(messages, {}, [])
      expect(models[0].cacheSavings).toBeUndefined()
    })

    test("session total sums only the models with a rate card, ignoring the rest", () => {
      const messages = [
        assistant("a1", {
          providerID: "openai",
          modelID: "gpt-4.1",
          input: 0,
          output: 0,
          reasoning: 0,
          read: 1_000_000,
          write: 0,
          cost: 0,
          created: 1,
        }),
        assistant("a2", {
          providerID: "unrated",
          modelID: "mystery",
          input: 0,
          output: 0,
          reasoning: 0,
          read: 1_000_000,
          write: 0,
          cost: 0,
          created: 2,
        }),
      ]
      const { session } = aggregateSessionContextByModel(messages, {}, providersWithRates)
      expect(session.cacheSavings).toBeCloseTo(1.5)
    })

    test("session total is undefined when no used model has a rate card", () => {
      const messages = [
        assistant("a1", { input: 0, output: 0, reasoning: 0, read: 1000, write: 0, cost: 0, created: 1 }),
      ]
      const { session } = aggregateSessionContextByModel(messages, {}, [])
      expect(session.cacheSavings).toBeUndefined()
    })

    test("is clamped at 0 rather than going negative if a rate card ever prices cache reads at/above input", () => {
      const providers = [
        {
          id: "odd",
          name: "Odd",
          models: {
            m: { name: "M", limit: { context: 1000 }, cost: { input: 1, output: 1, cache: { read: 5, write: 0 } } },
          },
        },
      ]
      const messages = [
        assistant("a1", {
          providerID: "odd",
          modelID: "m",
          input: 0,
          output: 0,
          reasoning: 0,
          read: 1_000_000,
          write: 0,
          cost: 0,
          created: 1,
        }),
      ]
      const { models } = aggregateSessionContextByModel(messages, {}, providers)
      expect(models[0].cacheSavings).toBe(0)
    })
  })

  describe("timing metrics", () => {
    test("generatedSeconds tracks measured generation time from text parts", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 0 }),
      ]
      const parts = { a1: [timedTextPart("t1", { start: 0, end: 2000 })] }
      const { session, models } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.generatedSeconds).toBeCloseTo(2)
      expect(models[0].generatedSeconds).toBeCloseTo(2)
    })

    test("generatedSeconds falls back to approximate generation when part timing is absent", () => {
      const messages = [
        assistant("a1", {
          input: 10,
          output: 100,
          reasoning: 0,
          read: 0,
          write: 0,
          cost: 0,
          created: 0,
          completed: 5000,
        }),
      ]
      const { session } = aggregateSessionContextByModel(messages, {}, [])
      expect(session.generatedSeconds).toBeCloseTo(5)
    })

    test("approximate fallback anchors on firstTokenAt (not created) so TTFT isn't counted as generation time", () => {
      const messages = [
        {
          id: "a1",
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-4.1",
          cost: 0,
          tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          // 2s of TTFT (created -> firstTokenAt) that must NOT be folded into generation time
          time: { created: 0, firstTokenAt: 2000, completed: 5000 },
        } as unknown as Message,
      ]
      const { session } = aggregateSessionContextByModel(messages, {}, [])
      // window is firstTokenAt(2000) -> completed(5000) = 3s, not created(0) -> completed(5000) = 5s
      expect(session.generatedSeconds).toBeCloseTo(3)
    })

    test("approximate fallback subtracts tool time from a firstTokenAt-anchored window", () => {
      const messages = [
        {
          id: "a1",
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-4.1",
          cost: 0,
          tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, firstTokenAt: 1000, completed: 9000 },
        } as unknown as Message,
      ]
      // 8s window (firstTokenAt -> completed), 3s of which was a tool call
      const parts = { a1: [timedToolPart("tool1", { start: 2000, end: 5000 })] }
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.generatedSeconds).toBeCloseTo(5)
    })

    test("toolSeconds tracks tool execution time from completed tool parts", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 0 }),
      ]
      const parts = {
        a1: [
          timedTextPart("t1", { start: 0, end: 1000 }),
          timedToolPart("tool1", { start: 1000, end: 4000 }),
          timedTextPart("t2", { start: 4000, end: 5000 }),
        ],
      }
      const { session, models } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.toolSeconds).toBeCloseTo(3)
      expect(models[0].toolSeconds).toBeCloseTo(3)
    })

    test("toolSeconds sums across multiple messages", () => {
      const messages = [
        assistant("a1", { input: 10, output: 50, reasoning: 0, read: 0, write: 0, cost: 0, created: 0 }),
        assistant("a2", { input: 10, output: 50, reasoning: 0, read: 0, write: 0, cost: 0, created: 5000 }),
      ]
      const parts = {
        a1: [timedToolPart("tool1", { start: 0, end: 2000 })],
        a2: [timedToolPart("tool2", { start: 5000, end: 8000 })],
      }
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.toolSeconds).toBeCloseTo(5)
    })

    test("toolSeconds is 0 when no tool parts have timing", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 0 }),
      ]
      const parts = { a1: [toolPart("t1")] }
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.toolSeconds).toBe(0)
    })

    test("ttftSeconds computes average time to first token across messages", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 1000 }),
        assistant("a2", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 5000 }),
      ]
      const parts = {
        a1: [timedTextPart("t1", { start: 1500, end: 2500 })], // ttft = 0.5s
        a2: [timedTextPart("t2", { start: 6200, end: 7200 })], // ttft = 1.2s
      }
      const { session, models } = aggregateSessionContextByModel(messages, parts, [])
      // average of 0.5 and 1.2 = 0.85
      expect(session.ttftSeconds).toBeCloseTo(0.85)
      expect(models[0].ttftSeconds).toBeCloseTo(0.85)
    })

    test("ttftSeconds is null when no text parts have timing", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 1000 }),
      ]
      const { session, models } = aggregateSessionContextByModel(messages, {}, [])
      expect(session.ttftSeconds).toBeNull()
      expect(models[0].ttftSeconds).toBeNull()
    })

    test("ttftSeconds prefers the authoritative firstTokenAt field over part-scanning", () => {
      const messages = [
        {
          id: "a1",
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-4.1",
          cost: 0,
          tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1000, firstTokenAt: 1500 }, // 0.5s via the authoritative field
        } as unknown as Message,
      ]
      // part timing disagrees (would imply 2s) — firstTokenAt should win, not the part scan
      const parts = { a1: [timedTextPart("t1", { start: 3000, end: 4000 })] }
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.ttftSeconds).toBeCloseTo(0.5)
    })

    test("ttftSeconds falls back to part-scanning when firstTokenAt is absent", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 1000 }),
      ]
      const parts = { a1: [timedTextPart("t1", { start: 1800, end: 2800 })] }
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      expect(session.ttftSeconds).toBeCloseTo(0.8)
    })

    test("ttftSeconds excludes synthetic text parts", () => {
      const messages = [
        assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 1000 }),
      ]
      const parts = {
        a1: [
          timedTextPart("synth", { start: 1000, end: 2000, synthetic: true }),
          timedTextPart("real", { start: 2500, end: 3500 }),
        ],
      }
      const { session } = aggregateSessionContextByModel(messages, parts, [])
      // only the real part counts: 2500 - 1000 = 1.5s
      expect(session.ttftSeconds).toBeCloseTo(1.5)
    })

    test("returns zero timing for empty session", () => {
      const { session } = aggregateSessionContextByModel([], {}, [])
      expect(session.generatedSeconds).toBe(0)
      expect(session.toolSeconds).toBe(0)
      expect(session.ttftSeconds).toBeNull()
      expect(session.upstreamTTFTSeconds).toBeNull()
    })

    describe("upstreamTTFTSeconds", () => {
      test("is null when the message lacks requestSentAt/firstTokenAt", () => {
        const messages = [
          assistant("a1", { input: 10, output: 100, reasoning: 0, read: 0, write: 0, cost: 0, created: 1000 }),
        ]
        const { session, models } = aggregateSessionContextByModel(messages, {}, [])
        expect(session.upstreamTTFTSeconds).toBeNull()
        expect(models[0].upstreamTTFTSeconds).toBeNull()
      })

      test("computes upstream TTFT from requestSentAt and firstTokenAt", () => {
        const messages = [
          {
            id: "a1",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-4.1",
            cost: 0,
            tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1000, requestSentAt: 1500, firstTokenAt: 2000 },
          } as unknown as Message,
        ]
        const { session, models } = aggregateSessionContextByModel(messages, {}, [])
        // upstreamTTFT = (2000 - 1500) / 1000 = 0.5s
        expect(session.upstreamTTFTSeconds).toBeCloseTo(0.5)
        expect(models[0].upstreamTTFTSeconds).toBeCloseTo(0.5)
      })

      test("averages upstream TTFT across multiple messages", () => {
        const messages = [
          {
            id: "a1",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-4.1",
            cost: 0,
            tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1000, requestSentAt: 1500, firstTokenAt: 2000 }, // 0.5s
          } as unknown as Message,
          {
            id: "a2",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-4.1",
            cost: 0,
            tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 5000, requestSentAt: 5200, firstTokenAt: 5900 }, // 0.7s
          } as unknown as Message,
        ]
        const { session, models } = aggregateSessionContextByModel(messages, {}, [])
        // average of 0.5 and 0.7 = 0.6s
        expect(session.upstreamTTFTSeconds).toBeCloseTo(0.6)
        expect(models[0].upstreamTTFTSeconds).toBeCloseTo(0.6)
      })

      test("excludes messages where firstTokenAt <= requestSentAt", () => {
        const messages = [
          {
            id: "a1",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-4.1",
            cost: 0,
            tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1000, requestSentAt: 2000, firstTokenAt: 1500 }, // inverted
          } as unknown as Message,
          {
            id: "a2",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-4.1",
            cost: 0,
            tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 5000, requestSentAt: 5200, firstTokenAt: 5900 }, // 0.7s
          } as unknown as Message,
        ]
        const { session } = aggregateSessionContextByModel(messages, {}, [])
        // only the valid message counts
        expect(session.upstreamTTFTSeconds).toBeCloseTo(0.7)
      })

      test("excludes messages where only one timing field is present", () => {
        const messages = [
          {
            id: "a1",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-4.1",
            cost: 0,
            tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1000, requestSentAt: 1500 }, // missing firstTokenAt
          } as unknown as Message,
        ]
        const { session } = aggregateSessionContextByModel(messages, {}, [])
        expect(session.upstreamTTFTSeconds).toBeNull()
      })
    })
  })

  describe("upstream TTFT serialization round-trip", () => {
    test("requestSentAt and firstTokenAt survive SessionMessage.Assistant schema encode/decode", async () => {
      const { SessionMessage } = await import("@opencode-ai/schema/session-message")
      const { Schema } = await import("effect")

      // Simulate the wire format that arrives from the processor: plain millisecond numbers.
      // decodeUnknownSync converts wire → Type (numbers → DateTime.Utc).
      // encodeUnknownSync converts Type → wire (DateTime.Utc → numbers).
      // If requestSentAt/firstTokenAt survive this round-trip, the schema supports them.
      const wireData = {
        id: "msg_test123",
        type: "assistant" as const,
        agent: "code",
        model: { id: "gpt-4.1", providerID: "openai" },
        content: [],
        time: {
          created: 1000,
          completed: 5000,
          requestSentAt: 1500,
          firstTokenAt: 2000,
        },
      }

      // Wire → Type → Wire round-trip
      const decoded = Schema.decodeUnknownSync(SessionMessage.Assistant)(wireData)
      const reEncoded = Schema.encodeUnknownSync(SessionMessage.Assistant)(decoded)

      expect(reEncoded.time.requestSentAt).toBe(1500)
      expect(reEncoded.time.firstTokenAt).toBe(2000)
    })

    test("requestSentAt/firstTokenAt omitted when undefined survive encode/decode", async () => {
      const { SessionMessage } = await import("@opencode-ai/schema/session-message")
      const { Schema } = await import("effect")

      const wireData = {
        id: "msg_test456",
        type: "assistant" as const,
        agent: "code",
        model: { id: "gpt-4.1", providerID: "openai" },
        content: [],
        time: {
          created: 1000,
          completed: 5000,
        },
      }

      const decoded = Schema.decodeUnknownSync(SessionMessage.Assistant)(wireData)
      const reEncoded = Schema.encodeUnknownSync(SessionMessage.Assistant)(decoded)

      expect(reEncoded.time.requestSentAt).toBeUndefined()
      expect(reEncoded.time.firstTokenAt).toBeUndefined()
    })

    test("upstreamTTFTSeconds computed correctly after schema round-trip", async () => {
      const { SessionMessage } = await import("@opencode-ai/schema/session-message")
      const { Schema } = await import("effect")

      const wireData = {
        id: "msg_test789",
        type: "assistant" as const,
        agent: "code",
        model: { id: "gpt-4.1", providerID: "openai" },
        cost: 0,
        tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        content: [],
        time: {
          created: 1000,
          completed: 5000,
          requestSentAt: 1500,
          firstTokenAt: 2000,
        },
      }

      // Full round-trip: wire → Type → wire
      const decoded = Schema.decodeUnknownSync(SessionMessage.Assistant)(wireData)
      const reEncoded = Schema.encodeUnknownSync(SessionMessage.Assistant)(decoded)

      // Simulate how the app reconstructs the Message from re-encoded wire data
      const message = {
        id: reEncoded.id,
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-4.1",
        cost: 0,
        tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        time: reEncoded.time,
      } as unknown as Message

      const { session } = aggregateSessionContextByModel([message], {}, [])
      // (2000 - 1500) / 1000 = 0.5s
      expect(session.upstreamTTFTSeconds).toBeCloseTo(0.5)
    })
  })
})

describe("liveGenerationProgress", () => {
  const inFlight = (time: { created: number; firstTokenAt?: number; completed?: number }) =>
    ({
      id: "live",
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-4.1",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time,
    }) as unknown as AssistantMessage

  test("is 0/0 before the first token has arrived (TTFT, not generation, is elapsing)", () => {
    const msg = inFlight({ created: 0 })
    expect(liveGenerationProgress(msg, undefined, 5000)).toEqual({ generatedSeconds: 0, toolSeconds: 0 })
  })

  test("ticks up generatedSeconds from firstTokenAt to now once the first token has arrived", () => {
    const msg = inFlight({ created: 0, firstTokenAt: 1000 })
    expect(liveGenerationProgress(msg, undefined, 4000).generatedSeconds).toBeCloseTo(3)
  })

  test("is 0/0 once the message has actually completed (no longer 'live')", () => {
    const msg = inFlight({ created: 0, firstTokenAt: 1000, completed: 4000 })
    expect(liveGenerationProgress(msg, undefined, 4000)).toEqual({ generatedSeconds: 0, toolSeconds: 0 })
  })

  test("excludes a currently-running tool call's elapsed time from generatedSeconds", () => {
    const msg = inFlight({ created: 0, firstTokenAt: 1000 })
    const parts = [
      {
        type: "tool",
        state: { status: "running", input: {}, time: { start: 2000 } },
      } as unknown as Part,
    ]
    // window is firstTokenAt(1000) -> now(6000) = 5s, minus 4s of an in-progress tool call = 1s
    const progress = liveGenerationProgress(msg, parts, 6000)
    expect(progress.toolSeconds).toBeCloseTo(4)
    expect(progress.generatedSeconds).toBeCloseTo(1)
  })

  test("also counts already-finished tool calls within the live window", () => {
    const msg = inFlight({ created: 0, firstTokenAt: 0 })
    const parts = [
      {
        type: "tool",
        state: {
          status: "completed",
          input: {},
          output: "",
          title: "",
          metadata: {},
          time: { start: 1000, end: 3000 },
        },
      } as unknown as Part,
    ]
    const progress = liveGenerationProgress(msg, parts, 5000)
    expect(progress.toolSeconds).toBeCloseTo(2)
    expect(progress.generatedSeconds).toBeCloseTo(3)
  })

  test("never goes negative when now is very close to firstTokenAt", () => {
    const msg = inFlight({ created: 0, firstTokenAt: 1000 })
    expect(liveGenerationProgress(msg, undefined, 1000).generatedSeconds).toBe(0)
  })
})
