import { describe, expect, test } from "bun:test"
import { OXP_STATIC_TRANSPORT } from "../../src/oxp/transport-manifest"
import { paginateToolList } from "../../src/oxp/transport-pagination"
import { OxpSurface } from "../../src/oxp/surface"

function decoded(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    v: number; offset: number; fingerprint: string
  }
}

describe("OXP independent transport pagination and stale-schema fences", () => {
  test("canonical list caches the generated manifest fingerprint across small pages", () => {
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const current = paginateToolList(OXP_STATIC_TRANSPORT.tools, cursor, 1_500)
      expect(current.tools.length).toBeGreaterThan(0)
      seen.push(...current.tools.map((tool) => tool.name))
      cursor = current.nextCursor
      if (cursor) {
        expect(decoded(cursor).fingerprint).toBe(OXP_STATIC_TRANSPORT.fingerprint)
        expect(decoded(cursor).offset).toBe(seen.length)
      }
    } while (cursor)
    expect(seen).toEqual(OXP_STATIC_TRANSPORT.tools.map((tool) => tool.name).sort())
    expect(new Set(seen).size).toBe(OXP_STATIC_TRANSPORT.tools.length)
  })

  test("shallow-frozen mutable custom projections do not obtain permanent cache entries", () => {
    const fake = Object.freeze(Array.from({ length: 8 }, (_, i) => ({
      ...OXP_STATIC_TRANSPORT.tools[0]!,
      name: `fake_${i}`,
      description: "original",
      inputSchema: { type: "object" as const, properties: { query: { type: "string" } } },
    })))
    const first = paginateToolList(fake, undefined, 250)
    expect(first.nextCursor).toBeDefined()
    fake[3]!.inputSchema.properties.query.type = "number"
    expect(() => paginateToolList(fake, first.nextCursor, 250)).toThrow(/stale/)
  })

  test("rejects malformed, forged and out-of-range cursors without disclosure", () => {
    const tools = OXP_STATIC_TRANSPORT.tools
    const first = paginateToolList(tools, undefined, 1_500)
    const cursor = decoded(first.nextCursor!)
    for (const invalid of [
      "",
      "%bad",
      "a".repeat(1_025),
      Buffer.from(JSON.stringify({ ...cursor, offset: -1 })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...cursor, offset: tools.length + 1 })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...cursor, v: 2 })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...cursor, fingerprint: "bad" })).toString("base64url"),
    ]) {
      expect(() => paginateToolList(tools, invalid, 1_500)).toThrow()
    }
  })

  test("arbitrary catalog fingerprints retain source-owner canonical ordering", () => {
    const tools = OXP_STATIC_TRANSPORT.tools.slice(0, 6).map((tool, i) => ({
      ...tool,
      name: `custom-${i}`,
    }))
    const first = paginateToolList(tools, undefined, 300)
    expect(first.nextCursor).toBeDefined()
    expect(decoded(first.nextCursor!).fingerprint).toBe(OxpSurface.toolProjectionFingerprint(tools))
    expect(paginateToolList(tools, undefined, 1).tools).toHaveLength(1)
  })
})
