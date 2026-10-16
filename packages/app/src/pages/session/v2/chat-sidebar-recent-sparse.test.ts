import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { buildChatSidebarSections, type ChatSidebarClusterGroup, type ChatSidebarTreeInput } from "./chat-sidebar-tree"
import { indexChatSidebarGroupedStatusSource } from "./chat-sidebar-status-grouped"
import { buildChatSidebarSparseRecentSection } from "./chat-sidebar-recent-sparse"
import { compareChatSidebarSessionTime } from "./chat-sidebar-session-merge"

const session = (id: string, updated: number): Session =>
  ({ id, title: `Session ${id}`, time: { created: updated, updated } }) as Session

describe("sparse Recent projector with working pinning", () => {
  test("empty roster yields no section", () => {
    const source = indexChatSidebarGroupedStatusSource([], () => undefined)!
    expect(buildChatSidebarSparseRecentSection({
      source, working: new Set(), limit: 50, pinWorking: (rows) => rows, titleOf: (row) => row.title,
    })).toBeUndefined()
  })

  test("randomized exact parity with full Recent builder across pinned/grouped/ungrouped rows", () => {
    let seed = 0x65ae71
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let trial = 0; trial < 600; trial++) {
      const size = random(210)
      const rows = Array.from({ length: size }, (_, i) => session(`s${i}`, random(55)))
        .sort(compareChatSidebarSessionTime)
      const groups = new Map<string, ChatSidebarClusterGroup>()
      const rosters = new Map<string, Session[]>()
      const kinds = ["user", "delegation", "plugin"]
      for (const row of rows) {
        if (random(4) === 0) continue
        const groupID = `group-${random(25)}`
        const group: ChatSidebarClusterGroup = { id: groupID, name: groupID, kind: kinds[random(kinds.length)]! }
        // One unique identity per group ID, as required by source verification.
        const original = rosters.get(groupID)
        groups.set(row.id, original?.length ? {
          id: groupID, name: groupID, kind: "user",
        } : { id: groupID, name: groupID, kind: "user" })
        if (original) original.push(row)
        else rosters.set(groupID, [row])
      }
      for (const members of rosters.values()) if (random(2) === 0) members.reverse()
      const working = new Set(rows.filter(() => random(6) === 0).map((row) => row.id))
      const pin = (list: Session[]) => {
        const busy = list.filter((row) => working.has(row.id))
        const idle = list.filter((row) => !working.has(row.id))
        return [...busy.reverse(), ...idle]
      }
      const groupOf = (row: Session) => groups.get(row.id)
      const groupMembersOf = (group: ChatSidebarClusterGroup) => rosters.get(group.id) ?? []
      const limit = random(size + 45)
      const baselineInput: ChatSidebarTreeInput = {
        mode: "recent", sort: "updated", recent: rows, projects: [],
        groupOf, groupMembersOf, stateOf: () => "idle",
        titleOf: (row) => row.title, pin, cluster: true, limit,
      }
      const baseline = buildChatSidebarSections(baselineInput)[0]
      const source = indexChatSidebarGroupedStatusSource(rows, groupOf)!
      const sparse = buildChatSidebarSparseRecentSection({
        source, working, limit, pinWorking: pin,
        titleOf: (row) => row.title, groupMembersOf,
      })
      try {
        expect(sparse).toEqual(baseline)
      } catch (error) {
        throw new Error(`Recent parity failure trial=${trial} size=${size} limit=${limit} working=${working.size}: ${error}`)
      }
    }
  })

  test("12k historical roots with a visible large group return exact Show More", () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => session(`s${i}`, 12_000 - i))
    const group: ChatSidebarClusterGroup = { id: "batch", name: "batch", kind: "delegation" }
    const of = (row: Session) => Number(row.id.slice(1)) >= 20 ? group : undefined
    const source = indexChatSidebarGroupedStatusSource(rows, of)!
    const working = new Set(["s100", "s200", "s900"])
    const pinned = (list: Session[]) => [...list.filter((row) => working.has(row.id)).reverse(),
      ...list.filter((row) => !working.has(row.id))]
    const projected = buildChatSidebarSparseRecentSection({
      source, working, pinWorking: pinned, limit: 5,
      titleOf: (row) => row.title,
      groupMembersOf: () => rows.slice(20),
    })!
    expect(projected.total).toBe(12_000)
    expect(projected.items.length).toBe(5)
    expect(projected.items[0]?.type).toBe("cluster")
    expect(projected.hiddenItems).toBe(16)
  })
})