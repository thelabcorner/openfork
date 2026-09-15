import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { chatSidebarAggregateMetrics, shouldAutoHydrateChatSidebarMetrics } from "./chat-sidebar-pane-state"

describe("chatSidebarAggregateMetrics", () => {
  test("derives full-session cost and cache hit ratio from materialized session aggregates", () => {
    const session = {
      cost: 1.25,
      tokens: {
        input: 300,
        output: 100,
        reasoning: 50,
        cache: { read: 700, write: 25 },
      },
      model: { id: "gpt-5.6-sol", providerID: "openai", variant: "high" },
    } as Pick<Session, "cost" | "tokens" | "model">

    expect(chatSidebarAggregateMetrics(session)).toEqual({
      cost: 1.25,
      cacheHitPercent: 70,
      model: { modelID: "gpt-5.6-sol", variant: "high" },
    })
  })

  test("distinguishes no token evidence from unavailable aggregate tokens", () => {
    expect(
      chatSidebarAggregateMetrics({
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ).toEqual({ cost: 0, cacheHitPercent: null, model: undefined })

    expect(chatSidebarAggregateMetrics({})).toEqual({
      cost: undefined,
      cacheHitPercent: undefined,
      model: undefined,
    })
  })
})

describe("shouldAutoHydrateChatSidebarMetrics", () => {
  test("hydrates only selected or working rows automatically", () => {
    expect(shouldAutoHydrateChatSidebarMetrics({ selected: false, working: false })).toBe(false)
    expect(shouldAutoHydrateChatSidebarMetrics({ selected: true, working: false })).toBe(true)
    expect(shouldAutoHydrateChatSidebarMetrics({ selected: false, working: true })).toBe(true)
  })
})
