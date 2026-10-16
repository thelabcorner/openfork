import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  buildChatSidebarSections,
  chatSidebarStatusBucket,
  type ChatSidebarClusterGroup,
  type ChatSidebarRowState,
  type ChatSidebarTreeInput,
} from "./chat-sidebar-tree"
import {
  buildChatSidebarGroupedSparseStatusSections,
  indexChatSidebarGroupedStatusSource,
} from "./chat-sidebar-status-grouped"
import { compareChatSidebarSessionTime } from "./chat-sidebar-session-merge"

const session = (id: string, updated: number): Session =>
  ({ id, title: `session ${id}`, time: { created: updated, updated } }) as Session

describe("group-aware sparse Status projection", () => {
  test("validates sorted root indexing rather than silently misordering it", () => {
    expect(indexChatSidebarGroupedStatusSource(
      [session("a", 1), session("b", 5)], () => undefined,
    )).toBeUndefined()
    expect(indexChatSidebarGroupedStatusSource(
      [session("a", 5), session("a", 2)], () => undefined,
    )).toBeUndefined()
  })

  test("randomized complete-section parity with the general Status builder", () => {
    let seed = 0xcaa713
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const candidateStates: ChatSidebarRowState[] = [
      "attention", "error", "working", "unread", "idle", "idle", "idle", "idle",
    ]

    for (let trial = 0; trial < 500; trial++) {
      const count = 1 + random(160)
      const rows = Array.from({ length: count }, (_, i) => session(`s${i}`, random(50)))
        .sort(compareChatSidebarSessionTime)
      const identities = new Map<string, ChatSidebarClusterGroup>()
      const groups = new Map<string, Session[]>()
      const groupCount = 1 + random(30)
      const metadata = Array.from({ length: groupCount }, (_, i) => ({
        id: `group-${i}`, name: `group ${i}`, kind: "user",
      }))
      for (const row of rows) {
        if (random(3) === 0) continue
        const group = metadata[random(metadata.length)]!
        identities.set(row.id, group)
        const members = groups.get(group.id)
        if (members) members.push(row)
        else groups.set(group.id, [row])
      }
      // Roster order intentionally differs from chronological row order.
      for (const members of groups.values()) if (random(2) === 0) members.reverse()
      const states = new Map<string, ChatSidebarRowState>()
      for (const row of rows) {
        const state = candidateStates[random(candidateStates.length)]!
        if (state !== "idle") states.set(row.id, state)
      }
      const working = new Set(rows.filter((row) => {
        const state = states.get(row.id)
        return state === "working" ||
          ((state === "attention" || state === "error") && random(3) === 0)
      }).map((row) => row.id))
      const rank = new Map(rows.map((row, index) => [row.id, index]))
      const pin = (input: Session[]) => [
        ...input.filter((row) => working.has(row.id)).reverse(),
        ...input.filter((row) => !working.has(row.id)),
      ]
      const groupOf = (row: Session) => identities.get(row.id)
      const memberOf = (group: ChatSidebarClusterGroup, scope: { kind: string; status?: string }) =>
        (groups.get(group.id) ?? []).filter((row) =>
          scope.kind !== "status" || chatSidebarStatusBucket(states.get(row.id) ?? "idle") === scope.status,
        )
      const limit = random(count + 30)
      const fullInput: ChatSidebarTreeInput = {
        mode: "status", sort: "updated", recent: rows, projects: [],
        groupOf, groupMembersOf: memberOf, stateOf: (row) => states.get(row.id) ?? "idle",
        titleOf: (row) => row.title, pin, limit, cluster: true,
        sessionsForScope: (scope) => scope.kind === "status" ? [] : [],
      }
      const baseline = buildChatSidebarSections(fullInput)
      const source = indexChatSidebarGroupedStatusSource(rows, groupOf)!
      const next = buildChatSidebarGroupedSparseStatusSections({
        source, states, limit, pin, groupMembersOf: memberOf, titleOf: (row) => row.title,
      })
      try {
        expect(next).toEqual(baseline)
      } catch (error) {
        throw new Error(`grouped Status differential failed trial ${trial}, limit ${limit}, roots ${count}, groups ${groupCount}, rank ${rank.size}: ${error}`)
      }
    }
  })

  test("huge collapsed group counts as one visible idle item without rendering all historical rows", () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => session(`s${i}`, 12_000 - i))
    const group: ChatSidebarClusterGroup = { id: "big", name: "big", kind: "delegation" }
    const of = (row: Session) => Number(row.id.slice(1)) >= 100 ? group : undefined
    const source = indexChatSidebarGroupedStatusSource(rows, of)!
    const states = new Map<string, ChatSidebarRowState>([
      ["s5", "attention"], ["s100", "working"], ["s210", "unread"],
    ])
    const output = buildChatSidebarGroupedSparseStatusSections({
      source, states, limit: 105, pin: (input) => input, titleOf: (row) => row.title,
      groupMembersOf: () => rows.slice(100).filter((row) => !states.has(row.id)),
    })
    const idle = output.find((section) => section.status === "idle")!
    expect(idle.total).toBe(11_997)
    expect(idle.hiddenItems).toBe(0)
    expect(idle.items.length).toBe(100)
    expect(idle.items.at(-1)?.type).toBe("cluster")
    const last = idle.items.at(-1)
    if (last?.type === "cluster") expect(last.members.length).toBe(11_898)
  })
})