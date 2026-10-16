import { describe, expect, test } from "bun:test"
import type { SessionGroupMember } from "@opencode-ai/sdk/v2/client"
import { sessionGroupMemberSession } from "./session-group-member-projection"

const member = (): SessionGroupMember =>
  ({
    id: "s1",
    slug: "s1",
    projectID: "p1",
    directory: "/repo",
    parentID: "parent",
    title: "Original",
    version: "1.0",
    time: { created: 10, updated: 20 },
    origin: "delegation",
    locked: false,
    position: 0,
    timeAdded: 10,
  }) as SessionGroupMember

describe("sessionGroupMemberSession immutable projection cache", () => {
  test("same member identity and semantics reuse a Session object", () => {
    const row = member()
    const first = sessionGroupMemberSession(row)
    expect(first).toBeDefined()
    expect(sessionGroupMemberSession(row)).toBe(first)
    row.position = 17
    row.locked = true
    expect(sessionGroupMemberSession(row)).toBe(first)
  })

  test("changes to an in-place reconciled proxy invalidate the snapshot", () => {
    const row = member()
    const first = sessionGroupMemberSession(row)!
    row.title = "Updated"
    const second = sessionGroupMemberSession(row)!
    expect(second).not.toBe(first)
    expect(second.title).toBe("Updated")
    expect(first.title).toBe("Original")
    row.time!.updated += 1
    const third = sessionGroupMemberSession(row)!
    expect(third).not.toBe(second)
    expect(third.time.updated).toBe(21)
    expect(second.time.updated).toBe(20)
    row.time!.archived = 123
    expect(sessionGroupMemberSession(row)!.time.archived).toBe(123)
    row.time!.archived = undefined
    expect(sessionGroupMemberSession(row)!.time.archived).toBeUndefined()
  })

  test("identity, directory, model-version and archive validity", () => {
    const row = member()
    const first = sessionGroupMemberSession(row)!
    row.id = "replacement"
    expect(sessionGroupMemberSession(row)!.id).toBe("replacement")
    expect(first.id).toBe("s1")
    row.directory = "/different"
    expect(sessionGroupMemberSession(row)).not.toBe(first)
    row.version = "2.0"
    expect(sessionGroupMemberSession(row)!.version).toBe("2.0")
    row.slug = undefined
    expect(sessionGroupMemberSession(row)).toBeUndefined()
    row.slug = "s1"
    expect(sessionGroupMemberSession(row)).toBeDefined()
  })

  test("distinct roster objects do not share mutable projection identity", () => {
    const one = member()
    const two = member()
    expect(sessionGroupMemberSession(one)).not.toBe(sessionGroupMemberSession(two))
  })
})