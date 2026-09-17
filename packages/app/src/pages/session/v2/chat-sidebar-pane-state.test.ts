import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  chatSidebarAggregateMetrics,
  chatSidebarRootSessionVisible,
  shouldAutoHydrateChatSidebarMetrics,
} from "./chat-sidebar-pane-state"

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

describe("chatSidebarRootSessionVisible", () => {
  const session = (input: Partial<Session> & Pick<Session, "id" | "directory">) =>
    ({
      projectID: input.projectID ?? "chats",
      title: "",
      version: "v2",
      time: { created: 1, updated: 1 },
      ...input,
    }) as Session

  test("keeps project-associated scratch sessions under the canonical root", () => {
    const scratch = session({ id: "scratch", directory: "/chat-root/sessions/scratch", projectID: "chats" })
    expect(chatSidebarRootSessionVisible(scratch, "/chat-root", "chats")).toBe(true)
    expect(chatSidebarRootSessionVisible(scratch, "/chat-root/sandbox")).toBe(false)
  })

  test("still rejects children and archived roots", () => {
    expect(
      chatSidebarRootSessionVisible(
        session({ id: "child", directory: "/chat-root/sessions/child", parentID: "parent" }),
        "/chat-root",
        "chats",
      ),
    ).toBe(false)
    expect(
      chatSidebarRootSessionVisible(
        session({ id: "archived", directory: "/chat-root/sessions/archived", time: { created: 1, updated: 1, archived: 2 } }),
        "/chat-root",
        "chats",
      ),
    ).toBe(false)
  })
})
