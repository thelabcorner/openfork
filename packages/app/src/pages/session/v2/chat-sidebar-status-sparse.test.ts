import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { buildChatSidebarSections, type ChatSidebarRowState, type ChatSidebarTreeInput } from "./chat-sidebar-tree"
import {
  buildChatSidebarSparseStatusSections,
  indexChatSidebarSparseSource,
} from "./chat-sidebar-status-sparse"
import { compareChatSidebarSessionTime } from "./chat-sidebar-session-merge"

const row = (id: string, updated: number): Session =>
  ({ id, title: id, time: { created: updated, updated } }) as Session

describe("sparse Status projection (ungrouped, updated sort)", () => {
  test("rejects out-of-order and duplicate index sources", () => {
    expect(indexChatSidebarSparseSource([row("b", 1), row("a", 2)])).toBeUndefined()
    expect(indexChatSidebarSparseSource([row("a", 2), row("a", 1)])).toBeUndefined()
    expect(indexChatSidebarSparseSource([row("b", 2), row("a", 2)])).toBeUndefined()
    expect(indexChatSidebarSparseSource([row("a", 2), row("b", 2)])).toBeDefined()
    expect(indexChatSidebarSparseSource([])).toBeDefined()
    // Even when the trusted sorter has already established chronological
    // order, duplicate-ID inputs must never be admitted to the sparse cache.
    expect(indexChatSidebarSparseSource([row("same", 2), row("same", 1)],
      compareChatSidebarSessionTime, true)).toBeUndefined()
  })

  test("pages idle without losing hidden counts or urgent sessions", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(`s${i}`, 1000 - i))
    const states = new Map<string, ChatSidebarRowState>([
      ["s0", "attention"], ["s2", "error"], ["s100", "working"], ["s300", "unread"],
      ["foreign", "working"],
    ])
    const source = indexChatSidebarSparseSource(rows)!
    const sections = buildChatSidebarSparseStatusSections({
      source, states, limit: 3, pin: (items) => items,
    })
    expect(sections.map((section) => section.key)).toEqual([
      "status:attention", "status:working", "status:unread", "status:idle",
    ])
    expect(sections[0]!.items.map((item) => item.key)).toEqual(["s:s0", "s:s2"])
    expect(sections[3]!.items.map((item) => item.key)).toEqual(["s:s1", "s:s3", "s:s4"])
    expect(sections[3]!.total).toBe(996)
    expect(sections[3]!.hiddenItems).toBe(993)
  })

  test("randomized parity with full builder including working-first reordering", () => {
    let seed = 64912
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const statuses: ChatSidebarRowState[] = ["attention", "error", "working", "unread", "idle"]
    for (let trial = 0; trial < 500; trial++) {
      const count = random(220)
      const rows = Array.from({ length: count }, (_, i) => row(`s${i}`, random(50)))
        .sort(compareChatSidebarSessionTime)
      const states = new Map<string, ChatSidebarRowState>()
      for (const session of rows) if (random(8) === 0) {
        const state = statuses[random(statuses.length)]!
        if (state !== "idle") states.set(session.id, state)
      }
      states.set("out-of-scope", "attention")
      const workingIDs = new Set(
        rows.filter((session) => {
          const state = states.get(session.id)
          // Execution may coexist with attention/error, but cannot be "idle"
          // or "unread": the canonical row-state priority would report working.
          return state === "working" ||
            ((state === "attention" || state === "error") && random(10) === 0)
        }).map((session) => session.id),
      )
      const pin = (items: Session[]) => {
        const head = items.filter((session) => workingIDs.has(session.id))
        const tail = items.filter((session) => !workingIDs.has(session.id))
        return [...head.reverse(), ...tail]
      }
      const limit = random(count + 20)
      const fullInput: ChatSidebarTreeInput = {
        mode: "status",
        sort: "updated",
        recent: rows,
        projects: [],
        groupOf: () => undefined,
        stateOf: (session) => states.get(session.id) ?? "idle",
        titleOf: (session) => session.title,
        pin,
        cluster: true,
        limit,
      }
      const baseline = buildChatSidebarSections(fullInput)
      const source = indexChatSidebarSparseSource(rows)!
      const optimized = buildChatSidebarSparseStatusSections({ source, states, pin, limit })
      expect(optimized).toEqual(baseline)
    }
  })
})