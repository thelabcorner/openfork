import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OxpSession } from "@/oxp/session"

/**
 * Agent-facing direct OXP inputs must retain the same executable read
 * parameters as the shared Session adapter. A broker-only field silently
 * degrades exact tool searches and can make long inventories unpageable.
 */
describe("direct OXP Session AX contract", () => {
  const decode = Schema.decodeUnknownSync(OxpSession.DirectParameters)

  test("accepts exact tool identity without a magic search string", () => {
    expect(decode({ action: "search", tool: "swarm_member", limit: 30 })).toMatchObject({
      action: "search",
      tool: "swarm_member",
      limit: 30,
    })
    expect(decode({ action: "search", search: "timeout", tool: "session" })).toMatchObject({
      search: "timeout",
      tool: "session",
    })
  })

  test("accepts stable continuation cursors on the direct list surface", () => {
    expect(decode({ action: "list", limit: 100, cursor: "WzEwMCwic2VzX2EiXQ" })).toMatchObject({
      action: "list",
      cursor: "WzEwMCwic2VzX2EiXQ",
    })
  })

  test("rejects overlong tool names and cursors before any database access", () => {
    expect(() => decode({ action: "search", tool: "x".repeat(129) })).toThrow()
    expect(() => decode({ action: "list", cursor: "x".repeat(513) })).toThrow()
    expect(() => decode({ action: "list", cursor: "" })).toThrow()
  })

  test("does not accidentally expand direct action authority", () => {
    expect(() => decode({ action: "checkpoint" })).toThrow()
    expect(() => decode({ action: "foobar" })).toThrow()
  })
})
