import { describe, expect, test } from "bun:test"
import {
  decodeSegment,
  encodeSegment,
  identityFromRef,
  mcpIdentity,
  mcpResourceIdentity,
  nativeIdentity,
  savedIdentity,
} from "@/tool/capability"

describe("Capability identity", () => {
  test("encodes RFC3986-unreserved bytes verbatim and everything else canonically", () => {
    expect(encodeSegment("AZaz09-._~")).toBe("AZaz09-._~")
    expect(encodeSegment("issue/search:100% ✓")).toBe("issue%2Fsearch%3A100%25%20%E2%9C%93")
    expect(decodeSegment("issue%2Fsearch%3A100%25%20%E2%9C%93")).toBe("issue/search:100% ✓")
  })

  test("rejects alternate or ambiguous segment spellings", () => {
    expect(() => decodeSegment("%2f")).toThrow("uppercase hex")
    expect(() => decodeSegment("raw/slash")).toThrow("unescaped reserved")
    expect(() => decodeSegment("%FF")).toThrow("invalid UTF-8")
    expect(() => decodeSegment("%7E")).toThrow("not canonical")
  })

  test("native refs round trip without conflating exposure policy with identity", () => {
    const identity = nativeIdentity("sqlite")
    expect(identity.ref).toBe("native:sqlite")
    expect(identityFromRef(identity.ref)).toEqual(identity)
  })

  test("MCP identity preserves original server and tool segments", () => {
    const identity = mcpIdentity("corp.github/a:b", "issue.search/%")
    expect(identity.ref).toBe("mcp:corp.github%2Fa%3Ab/issue.search%2F%25")
    expect(identityFromRef(identity.ref)).toEqual(identity)
    expect(identity.segments).toEqual(["corp.github/a:b", "issue.search/%"])
  })

  test("MCP flattened-name collision candidates remain different canonical identities", () => {
    const left = mcpIdentity("a_b", "c")
    const right = mcpIdentity("a", "b_c")
    expect(left.ref).not.toBe(right.ref)
    expect(left.key).not.toBe(right.key)

    const dotted = mcpIdentity("srv", "issue.search")
    const underscored = mcpIdentity("srv", "issue_search")
    expect(dotted.ref).not.toBe(underscored.ref)
    expect(dotted.key).not.toBe(underscored.key)
  })

  test("MCP resource refs use their own namespace", () => {
    const identity = mcpResourceIdentity("read/resource")
    expect(identity.ref).toBe("mcp-resource:read%2Fresource")
    expect(identityFromRef(identity.ref)).toEqual(identity)
  })

  test("saved refs carry scope, id, and immutable sha256 revision", () => {
    const project = savedIdentity("project", "find/todos", "sha256:abc:def")
    expect(project.ref).toBe("saved:project/find%2Ftodos@sha256:abc%3Adef")
    expect(identityFromRef(project.ref)).toEqual(project)
    expect(project.segments).toEqual(["project", "find/todos", "sha256:abc:def"])

    const global = savedIdentity("global", "find_todos", "sha256:deadbeef")
    expect(identityFromRef(global.ref)).toEqual(global)
    expect(global.ref).toBe("saved:global/find_todos@sha256:deadbeef")
  })

  test("rejects malformed and noncanonical refs", () => {
    expect(() => identityFromRef("mcp:server")).toThrow("Invalid MCP")
    expect(() => identityFromRef("mcp:server/tool/extra")).toThrow("Invalid MCP")
    expect(() => identityFromRef("native:raw/slash")).toThrow("Invalid native")
    expect(() => identityFromRef("saved:workspace/tool@sha256:abc")).toThrow("scope")
    expect(() => identityFromRef("saved:project/tool@sha256:")).toThrow("Invalid saved")
    expect(() => identityFromRef("unknown:anything")).toThrow("Unknown capability")
  })
})
