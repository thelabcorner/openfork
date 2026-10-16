import { describe, expect, test } from "bun:test"
import { paginateToolList } from "@/oxp/server"
import { DIRECT_TOOL_DESCRIPTIONS } from "@/oxp/prose"
import { OxpSurface } from "@/oxp/surface"

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
const p95 = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)] ?? 0

describe("OXP Gate C surface/performance proof", () => {
  test("measures the richer ChatGPT contract and keeps it bounded", () => {
    const canonical = JSON.stringify({
      instructions: OxpSurface.SERVER_INSTRUCTIONS,
      tools: OxpSurface.TOOLS,
    })
    const bytes = Buffer.byteLength(canonical, "utf8")
    const report = {
      directTools: OxpSurface.TOOLS.length,
      manifestBytes: bytes,
      priorStandalonePlanningBaselineChars: 23_400,
      ratioToPriorBaseline: bytes / 23_400,
    }
    console.log("OXP_GATE_C_SURFACE", JSON.stringify(report))

    expect(OxpSurface.TOOLS.length).toBeLessThanOrEqual(14)
    // Titles, outputSchema, security metadata, invocation UX, native file
    // parameters, and Swarm are intentional permanent-contract bytes. Guard
    // against accidental growth while reporting the older pre-contract baseline.
    // The current executable contract includes focused broker guidance and
    // richer Session supervision metadata. Retain an explicit budget with
    // headroom rather than claiming the obsolete 2025-era 40 KiB envelope.
    // Any future expansion must justify its recurring model/context cost.
    expect(bytes).toBeLessThanOrEqual(47_000)
  })

  test("keeps every permanent OXP tool description canonical, concise, and decision-useful", () => {
    const canonical = DIRECT_TOOL_DESCRIPTIONS as Record<string, string>
    expect(OxpSurface.TOOLS.map((tool) => tool.name).toSorted()).toEqual(Object.keys(canonical).toSorted())
    for (const tool of OxpSurface.TOOLS) {
      const description = tool.description
      expect(description).toBe(canonical[tool.name])
      if (description === undefined) throw new Error(`OXP tool ${tool.name} has no description`)
      expect(description.length).toBeGreaterThanOrEqual(90)
      // Session supervision needs blocked-request/continuation guidance on the
      // permanent tool; broker guidance is intentionally more explicit than
      // ordinary direct tools. Bound each reviewed exception separately.
      const maxLength = tool.name === "openfork_session" ? 500
        : tool.name === "capability" ? 220
        : tool.name === "openfork_diagnostics" ? 200
        : 180
      expect(description.length).toBeLessThanOrEqual(maxLength)
      expect(description).not.toContain("\n")
    }
  })

  test("keeps native-lazy capability schemas out of the permanent MCP manifest", () => {
    const names = OxpSurface.TOOLS.map((tool) => tool.name)
    expect(names).not.toContain("archive")
    expect(names).not.toContain("json")
    expect(names).not.toContain("test")

    const broker = OxpSurface.TOOLS.find((tool) => tool.name === "capability")
    expect(broker).toBeDefined()
    const schema = broker!.inputSchema as { properties?: Record<string, unknown> }
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ["action", "args", "capability", "contract", "focusAction", "guidanceMode", "load", "namespace", "query", "rootID", "source_file"].sort(),
    )
    const encoded = JSON.stringify(broker!.inputSchema)
    expect(encoded).not.toContain("compareJsonText")
    expect(encoded).not.toContain("testNamePattern")
    expect(encoded).not.toContain("compareFilePath")
  })

  test("keeps fixed-manifest pagination negligible on a warm path", () => {
    const samples: number[] = []
    for (let index = 0; index < 2_000; index++) {
      const start = performance.now()
      const page = paginateToolList(OxpSurface.TOOLS)
      samples.push(performance.now() - start)
      expect(page.nextCursor).toBeUndefined()
    }
    const report = { medianMs: median(samples), p95Ms: p95(samples), samples: samples.length }
    console.log("OXP_GATE_C_PERF", JSON.stringify(report))
    // The canonical manifest list is immutable: warm listing must not redo
    // schema serialization or sorting. This detects accidental O(N*schema)
    // regressions that the old 1ms ceiling would silently permit.
    expect(report.medianMs).toBeLessThan(0.05)
    expect(report.p95Ms).toBeLessThan(5)
  })
})
