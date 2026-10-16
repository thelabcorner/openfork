import { describe, expect, test } from "bun:test"
import { visibleChatSidebarGroups } from "./chat-sidebar-group-scope"

type G = { id: string; kind: string; anchorSessionID?: string; sessions: { id: string }[] }

describe("visibleChatSidebarGroups", () => {
  test("excludes unrelated projects' delegations and user groups", () => {
    const groups: G[] = [
      { id: "our-workers", kind: "delegation", sessions: [{ id: "our-root" }, { id: "child" }] },
      { id: "foreign-workers", kind: "delegation", sessions: [{ id: "other-root" }, { id: "worker" }] },
      { id: "our-manual", kind: "user", sessions: [{ id: "our-root" }] },
    ]
    expect(visibleChatSidebarGroups(new Set(["our-root"]), groups).map((group) => group.id))
      .toEqual(["our-workers", "our-manual"])
  })

  test("keeps explicitly anchored structural groups and directly visible plugin memberships", () => {
    const groups: G[] = [
      { id: "sub", kind: "subagent", anchorSessionID: "root", sessions: [{ id: "child" }] },
      { id: "plugin", kind: "plugin", anchorSessionID: "root", sessions: [{ id: "worker" }] },
      { id: "unanchored", kind: "subagent", sessions: [{ id: "root" }] },
      { id: "plugin-foreign", kind: "plugin", anchorSessionID: "foreign", sessions: [{ id: "root" }] },
    ]
    expect(visibleChatSidebarGroups(new Set(["root"]), groups).map((group) => group.id))
      .toEqual(["sub", "plugin", "plugin-foreign"])
  })

  test("matches the legacy selector for randomized rosters", () => {
    let seed = 4102
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const kinds = ["delegation", "user", "subagent", "plugin", "swarm"]
    for (let iteration = 0; iteration < 250; iteration++) {
      const roots = new Set(Array.from({ length: random(30) }, () => `s${random(200)}`))
      const groups: G[] = Array.from({ length: random(85) }, (_, i) => ({
        id: `g${i}`,
        kind: kinds[random(kinds.length)]!,
        anchorSessionID: random(3) === 0 ? `s${random(200)}` : undefined,
        sessions: Array.from({ length: random(25) }, () => ({ id: `s${random(200)}` })),
      }))
      const previous = groups.filter((group) =>
        (group.kind !== "subagent" && group.sessions.some((member) => roots.has(member.id))) ||
        ((group.kind === "subagent" || group.kind === "plugin") &&
          !!group.anchorSessionID && roots.has(group.anchorSessionID)),
      )
      // Legacy plugin memberships were also eligible through a visible direct
      // member, even without an anchor; preserve that behavior.
      const actual = visibleChatSidebarGroups(roots, groups)
      expect(actual.map((group) => group.id)).toEqual(previous.map((group) => group.id))
    }
  })
})