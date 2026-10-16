import { describe, expect, test } from "bun:test"
import { canonicalToolID, selectMcpTool } from "../../src/oxp/mcp-selector"

const fixture = [
  { server: "one/server", name: "lookup/item" },
  { server: "writer", name: "publish" },
  { server: "other", name: "publish" },
] as const

describe("OXP external MCP selection hot path", () => {
  test("canonical IDs round-trip arbitrary separators and take precedence", () => {
    expect(canonicalToolID(fixture[0])).toBe("one%2Fserver/lookup%2Fitem")
    expect(selectMcpTool(fixture, "one%2Fserver/lookup%2Fitem")).toEqual({ kind: "found", tool: fixture[0] })
    expect(selectMcpTool(fixture, "lookup/item")).toEqual({ kind: "found", tool: fixture[0] })
    expect(selectMcpTool(fixture, "one%2fserver/lookup%2Fitem")).toEqual({ kind: "missing" })
    expect(selectMcpTool(fixture, "one%ZZserver/lookup%2Fitem")).toEqual({ kind: "missing" })
    expect(selectMcpTool([{ server: "raw", name: "bad%ZZ/escape" }], "bad%ZZ/escape")).toEqual({
      kind: "found",
      tool: { server: "raw", name: "bad%ZZ/escape" },
    })
  })

  test("ambiguous bare names retain bounded, ordered repair candidates", () => {
    const result = selectMcpTool(fixture, "publish")
    expect(result).toEqual({ kind: "ambiguous", candidates: ["writer/publish", "other/publish"] })
    const many = Array.from({ length: 32 }, (_, i) => ({ server: `server${i}`, name: "publish" }))
    const big = selectMcpTool(many, "publish")
    expect(big.kind).toBe("ambiguous")
    if (big.kind === "ambiguous") expect(big.candidates).toHaveLength(8)
  })

  test("duplicated canonical identities do not select an arbitrary duplicate", () => {
    expect(selectMcpTool([fixture[1], fixture[1]], "writer/publish")).toEqual({ kind: "missing" })
    expect(selectMcpTool([], "publish")).toEqual({ kind: "missing" })
  })
})