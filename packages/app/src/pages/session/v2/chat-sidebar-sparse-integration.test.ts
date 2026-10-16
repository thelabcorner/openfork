import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  buildChatSidebarSections,
  compareChatSidebarSessions,
  chatSidebarStatusBucket,
  mergeChatSidebarRecent,
  sortChatSidebarSessions,
  type ChatSidebarClusterGroup,
  type ChatSidebarClusterScope,
  type ChatSidebarRowState,
  type ChatSidebarTreeInput,
} from "./chat-sidebar-tree"
import { indexChatSidebarGroupedStatusSource, buildChatSidebarGroupedSparseStatusSections } from "./chat-sidebar-status-grouped"
import { buildChatSidebarSparseRecentSection } from "./chat-sidebar-recent-sparse"
import { compareChatSidebarSessionTime } from "./chat-sidebar-session-merge"

const row = (id: string, updated: number, parentID?: string): Session => ({
  id, parentID, title: `Session ${id}`, directory: "/test",
  time: { created: updated, updated },
}) as Session

describe("end-to-end sparse vs full projection with parented workers", () => {
  test("250 randomized source merges, child rosters and mixed semantic buckets", () => {
    let seed = 0x845f21
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const states: ChatSidebarRowState[] = ["attention", "error", "working", "unread", "idle", "idle", "idle"]
    for (let trial = 0; trial < 250; trial++) {
      const count = 1 + random(100)
      const roots = Array.from({ length: count }, (_, i) => row(`root-${i}`, random(150)))
        .sort(compareChatSidebarSessionTime)
      const roster = new Map<string, Session[]>()
      const membership = new Map<string, ChatSidebarClusterGroup>()
      const groups = Array.from({ length: 1 + random(14) }, (_, i) => ({
        id: `g-${i}`, name: `group ${i}`, kind: i % 2 ? "delegation" : "user",
      }))
      const children: Session[] = []
      for (const root of roots) {
        if (random(3) === 0) continue
        const group = groups[random(groups.length)]!
        membership.set(root.id, group)
        if (!roster.has(group.id)) roster.set(group.id, [])
        roster.get(group.id)!.push(root)
        for (let i = 0, n = random(6); i < n; i++) {
          const worker = row(`${root.id}-worker-${i}`, random(150), root.id)
          membership.set(worker.id, group)
          children.push(worker)
          roster.get(group.id)!.push(worker)
        }
      }
      for (const entries of roster.values()) if (random(2) === 0) entries.reverse()
      const merged = mergeChatSidebarRecent(roots, children)
      const stateByID = new Map<string, ChatSidebarRowState>()
      for (const session of merged) {
        const state = states[random(states.length)]!
        if (state !== "idle") stateByID.set(session.id, state)
      }
      const working = new Set(merged.filter((session) =>
        stateByID.get(session.id) === "working" ||
        ((stateByID.get(session.id) === "attention" || stateByID.get(session.id) === "error") && random(3) === 0),
      ).map((session) => session.id))
      const pin = (sessions: Session[]) => [
        ...sessions.filter((session) => working.has(session.id)).reverse(),
        ...sessions.filter((session) => !working.has(session.id)),
      ]
      const groupOf = (session: Session) => membership.get(session.id)
      const groupMembersOf = (group: ChatSidebarClusterGroup, scope: ChatSidebarClusterScope) =>
        (roster.get(group.id) ?? []).filter((session) => scope.kind !== "status" ||
          chatSidebarStatusBucket(stateByID.get(session.id) ?? "idle") === scope.status)
      const supplemental = (scope: ChatSidebarClusterScope) =>
        scope.kind === "status"
          ? children.filter((session) => chatSidebarStatusBucket(stateByID.get(session.id) ?? "idle") === scope.status)
          : children
      const base: Omit<ChatSidebarTreeInput, "mode"> = {
        sort: "updated", recent: merged, projects: [], groupOf, groupMembersOf,
        stateOf: (session) => stateByID.get(session.id) ?? "idle",
        titleOf: (session) => session.title,
        pin, limit: random(count + 20), cluster: true, sessionsForScope: supplemental,
      }
      const source = indexChatSidebarGroupedStatusSource(merged, groupOf)!
      const statusFull = buildChatSidebarSections({ ...base, mode: "status" })
      const statusSparse = buildChatSidebarGroupedSparseStatusSections({
        source, states: stateByID, pin, limit: base.limit,
        titleOf: base.titleOf, groupMembersOf,
      })
      expect(statusSparse).toEqual(statusFull)

      const recentFull = buildChatSidebarSections({ ...base, mode: "recent" })[0]
      const recentSparse = buildChatSidebarSparseRecentSection({
        source, working, pinWorking: pin, titleOf: base.titleOf,
        groupMembersOf: (group) => groupMembersOf(group, { kind: "recent" }), limit: base.limit,
      })
      expect(recentSparse).toEqual(recentFull)

      // Created-time and locale-aware numeric-title sorts must be equally
      // correct, but must NEVER use working-first pinning.
      for (const sort of ["created", "title"] as const) {
        const compare = compareChatSidebarSessions(sort, base.titleOf)
        const ordered = sortChatSidebarSessions(merged, sort, base.titleOf)
        const sortedSource = indexChatSidebarGroupedStatusSource(ordered, groupOf, compare, true)!
        const noPin = (rows: Session[]) => rows
        const fullStatus = buildChatSidebarSections({ ...base, mode: "status", sort })
        const optimizedStatus = buildChatSidebarGroupedSparseStatusSections({
          source: sortedSource, states: stateByID, limit: base.limit,
          titleOf: base.titleOf, groupMembersOf, compare, pin: noPin,
        })
        expect(optimizedStatus).toEqual(fullStatus)

        const fullRecent = buildChatSidebarSections({ ...base, mode: "recent", sort })[0]
        const optimizedRecent = buildChatSidebarSparseRecentSection({
          source: sortedSource, working: new Set(), pinWorking: noPin, compare,
          titleOf: base.titleOf, groupMembersOf: (group) => groupMembersOf(group, { kind: "recent" }),
          limit: base.limit,
        })
        expect(optimizedRecent).toEqual(fullRecent)
      }
    }
  })
})