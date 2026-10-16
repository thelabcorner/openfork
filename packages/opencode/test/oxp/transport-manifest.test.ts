import { describe, expect, test } from "bun:test"
import { OxpSurface } from "../../src/oxp/surface"
import { OXP_STATIC_TRANSPORT } from "../../src/oxp/transport-manifest"

describe("build-generated OXP transport manifest parity", () => {
  test("reproduces every real direct-tool schema, annotation, and instruction", () => {
    expect(OXP_STATIC_TRANSPORT.fingerprint).toBe(OxpSurface.FINGERPRINT)
    expect(OXP_STATIC_TRANSPORT.majorVersion).toBe(OxpSurface.MAJOR_VERSION)
    expect(OXP_STATIC_TRANSPORT.instructions).toBe(OxpSurface.SERVER_INSTRUCTIONS)
    expect(OXP_STATIC_TRANSPORT.tools).toEqual(OxpSurface.TOOLS)
    expect(OXP_STATIC_TRANSPORT.outputSchema).toEqual(OxpSurface.OUTPUT_SCHEMA)
    expect(OXP_STATIC_TRANSPORT.legacyOutputSchema).toEqual(OxpSurface.LEGACY_OUTPUT_SCHEMA)
  })

  test("cannot poison the next list call by mutating a nested schema", () => {
    expect(Object.isFrozen(OXP_STATIC_TRANSPORT.tools)).toBe(true)
    const first = OXP_STATIC_TRANSPORT.tools[0]!
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.inputSchema)).toBe(true)
    const original = JSON.stringify(first.inputSchema)
    try {
      // A model-origin MCP call must not modify the server-owned static schema.
      ;(first.inputSchema as { properties?: unknown }).properties = {}
    } catch {}
    expect(JSON.stringify(first.inputSchema)).toBe(original)
  })
})
