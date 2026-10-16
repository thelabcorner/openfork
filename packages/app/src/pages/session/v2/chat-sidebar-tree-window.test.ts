import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  clusterChatSidebarRows,
  clusterChatSidebarRowsWindow,
  type ChatSidebarClusterGroup,
  type ChatSidebarClusterScope,
  type ChatSidebarTreeInput,
} from "./chat-sidebar-tree"

const session = (id: string, title = id, updated = 0) =>
  ({ id, title, time: { created: updated, updated } }) as Session
const group = (id: string): ChatSidebarClusterGroup => ({ id, name: id, kind: "user" })

describe("windowed sidebar clustering", () => {
  test("hidden group rosters are never expanded or labeled", () => {
    const assigned = group("group")
    const rows = Array.from({ length: 1000 }, (_, index) => session(`s${index}`, `prefix ${index}`, 1000 - index))
    let calls = 0
    let titles = 0
    const input = {
      cluster: true,
      groupOf: (row: Session) => Number(row.id.slice(1)) < 10 ? undefined : assigned,
      titleOf: (row: Session) => {
        titles++
        return row.title
      },
      groupMembersOf: () => {
        calls++
        return rows.slice(10)
      },
    }
    const page = clusterChatSidebarRowsWindow(rows, input, "recent", { kind: "recent" }, 5)
    expect(page.items.map((row) => row.key)).toEqual(["s:s0", "s:s1", "s:s2", "s:s3", "s:s4"])
    expect(page.hiddenItems).toBe(6)
    expect(calls).toBe(0)
    expect(titles).toBe(0)
  })

  test("randomized paging agrees with complete clustering across group scopes", () => {
    let seed = 48761
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let iteration = 0; iteration < 270; iteration++) {
      const count = random(170)
      const rows = Array.from({ length: count }, (_, i) => session(`s${i}`, `Title ${i}`, count - i))
      const roster = new Map<string, Session[]>()
      const memberships = new Map<string, ChatSidebarClusterGroup>()
      for (const row of rows) {
        if (random(4) === 0) continue
        const assigned = group(`g${random(18)}`)
        memberships.set(row.id, assigned)
        if (!roster.has(assigned.id)) roster.set(assigned.id, [])
        roster.get(assigned.id)!.push(row)
      }
      for (const [id, members] of roster) {
        if (random(3) === 0) members.push(session(`remote:${id}`, "Remote"))
      }
      const scope: ChatSidebarClusterScope = { kind: "recent" }
      const input: Pick<ChatSidebarTreeInput, "cluster" | "groupOf" | "titleOf" | "groupMembersOf"> = {
        cluster: random(4) !== 0,
        groupOf: (row) => memberships.get(row.id),
        titleOf: (row) => row.title,
        groupMembersOf: (assigned) => roster.get(assigned.id) ?? [],
      }
      const full = clusterChatSidebarRows(rows, input, "recent", scope)
      for (const limit of [0, 1, 2, 10, 50, count, count + 4, Number.POSITIVE_INFINITY]) {
        const result = clusterChatSidebarRowsWindow(rows, input, "recent", scope, limit)
        const expected = full.slice(0, Math.max(0, limit))
        expect(result.items).toEqual(expected)
        expect(result.hiddenItems).toBe(full.length - expected.length)
      }
    }
  })
})