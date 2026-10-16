import { expect, test } from "bun:test"
import type { SessionGroupInfo, SessionGroupDetail } from "@opencode-ai/sdk/v2/client"
import { mergeSessionGroupDetails, projectSessionGroupEntries } from "./session-group-entries"

test("selected and inactive server group projections preserve identical roster metadata semantics", () => {
  const metadata = [{
    id: "grp_1",
    name: "Workers",
    kind: "subagent",
    position: 5,
    anchorSessionID: "ses_parent",
    ownerPlugin: "plugin",
    time: { created: 1, updated: 2 },
  }, {
    id: "grp_2",
    name: "Manual",
    kind: "user",
    time: { created: 3, updated: 4 },
  }] as SessionGroupInfo[]
  const details = {
    grp_1: {
      group: metadata[0]!,
      sessions: [{ id: "ses_a", title: "A", locked: false, origin: "auto_subagent", position: 0, timeAdded: 1 }],
    } as SessionGroupDetail,
  }
  const projected = projectSessionGroupEntries(metadata, details)
  expect(projected.map((entry) => entry.id)).toEqual(["grp_1", "grp_2"])
  expect(projected[0]?.sessionIds).toEqual(["ses_a"])
  expect(projected[0]?.sessions[0]?.title).toBe("A")
  expect(projected[0]?.ownerPlugin).toBe("plugin")
  expect(projected[0]?.anchorSessionID).toBe("ses_parent")
  expect(projected[0]?.position).toBe(5)
  expect(projected[1]?.sessionIds).toEqual([])
  expect(projected[1]?.sessions).toEqual([])
  expect(projected[1]?.position).toBe(0)
})

test("one legacy detail batch preserves previously cached groups when some requests fail", () => {
  const value = (id: string, title: string): SessionGroupDetail => ({
    group: { id, name: title, kind: "user", time: { created: 0, updated: 0 } } as SessionGroupInfo,
    sessions: [],
  })
  const old = { a: value("a", "old"), b: value("b", "available") }
  const next = mergeSessionGroupDetails(old, [value("a", "new"), value("c", "added")])
  expect(next).toEqual({ a: value("a", "new"), b: old.b, c: value("c", "added") })
  expect(old.a.group.name).toBe("old")
  expect(next.b).toBe(old.b)
  expect(mergeSessionGroupDetails(old, [])).toBe(old)
  expect(mergeSessionGroupDetails(old, [value("a", "first"), value("a", "latest")]).a.group.name).toBe("latest")
  expect(mergeSessionGroupDetails(old, [value("c", "not-in-roster")], new Set(["a"]))).toEqual({
    a: old.a,
  })
  expect(mergeSessionGroupDetails(old, [], new Set(["b"]))).toEqual({ b: old.b })
})