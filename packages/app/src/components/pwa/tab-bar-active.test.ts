import { describe, expect, test } from "bun:test"
import { resolveActiveTab } from "./tab-bar-active"

describe("resolveActiveTab", () => {
  test("home route highlights sessions", () => {
    expect(resolveActiveTab("/")).toBe("sessions")
  })

  test("session chat and group routes highlight sessions", () => {
    expect(resolveActiveTab("/server/local/session/s1")).toBe("sessions")
    expect(resolveActiveTab("/server/local/group/g1")).toBe("sessions")
    expect(resolveActiveTab("/server/local/group/g1/session/s1")).toBe("sessions")
  })

  test("draft route highlights sessions", () => {
    expect(resolveActiveTab("/new-session")).toBe("sessions")
  })

  test("legacy directory session route highlights sessions", () => {
    expect(resolveActiveTab("/some-dir/session/abc")).toBe("sessions")
  })

  test("prefix lookalikes do not highlight sessions", () => {
    expect(resolveActiveTab("/serverfoo")).toBeUndefined()
    expect(resolveActiveTab("/new-sessionish")).toBeUndefined()
  })

  test("unknown paths highlight nothing", () => {
    expect(resolveActiveTab("/somewhere-else")).toBeUndefined()
  })
})
