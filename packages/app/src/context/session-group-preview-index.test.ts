import { expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import type { SessionGroupEntry } from "./session-groups"
import {
  buildSessionPreviewIndex,
  createSessionPreviewIndexCache,
  previewGroupScopeMatches,
} from "./session-group-preview-index"
import type { ServerConnection } from "./server"

function group(id: string, sessionIds: string[], kind: SessionGroupEntry["kind"], anchorSessionID?: string): SessionGroupEntry {
  return {
    id, name: id, sessionIds, kind, anchorSessionID,
    position: 0, sessions: [], time: { created: 0, updated: 0 },
  }
}

test("preview index retains all direct memberships, source order and only structural anchors", () => {
  const a = group("a", ["ses_1", "ses_2"], "subagent", "root")
  const b = group("b", ["ses_2"], "plugin", "root")
  const manual = group("manual", ["ses_2"], "user", "root")
  const index = buildSessionPreviewIndex([a, b, manual])
  expect(index.membership.get("ses_1")).toEqual([a])
  expect(index.membership.get("ses_2")).toEqual([a, b, manual])
  expect(index.anchoredBy.get("root")).toEqual([a, b])
  expect(index.anchoredBy.has("ses_2")).toBe(false)
  expect(buildSessionPreviewIndex([]).membership.size).toBe(0)
})

test("a preview cannot borrow another server's active SessionGroup snapshot", () => {
  const local = "local" as ServerConnection.Key
  const remote = "remote" as ServerConnection.Key
  expect(previewGroupScopeMatches(local, local)).toBe(true)
  expect(previewGroupScopeMatches(undefined, local)).toBe(true)
  expect(previewGroupScopeMatches(local, remote)).toBe(false)
  expect(previewGroupScopeMatches(remote, local)).toBe(false)
})

test("a shared reactive snapshot is computed once for many readers and invalidates on group replacement", () => {
  createRoot((dispose) => {
    const first = group("first", ["ses_a"], "plugin", "root")
    const second = group("second", ["ses_b"], "subagent", "root")
    const [groups, setGroups] = createSignal<SessionGroupEntry[]>([first])
    const cache = createSessionPreviewIndexCache()
    const snapshot = createMemo(() => cache.get(groups()))
    try {
      const readers = Array.from({ length: 64 }, () => snapshot())
      expect(readers.every((entry) => entry === readers[0])).toBe(true)
      setGroups([second])
      expect(snapshot().membership.has("ses_a")).toBe(false)
      expect(snapshot().membership.get("ses_b")).toEqual([second])
    } finally {
      dispose()
    }
  })
})

test("idle cache reads do not subscribe to group changes or rebuild until requested", () => {
  const cache = createSessionPreviewIndexCache()
  const a = [group("a", ["ses_1"], "plugin")]
  const b = [group("b", ["ses_2"], "subagent")]
  const first = cache.get(a)
  expect(cache.get(a)).toBe(first)
  // Replacing the producer snapshot does no work in this nonreactive owner.
  // A later inspector request observes exactly the current group generation.
  const second = cache.get(b)
  expect(second).not.toBe(first)
  expect(second.membership.has("ses_1")).toBe(false)
  expect(second.membership.has("ses_2")).toBe(true)
  expect(cache.get(b)).toBe(second)
})