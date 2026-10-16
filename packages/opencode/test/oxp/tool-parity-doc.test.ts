import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { OxpToolCoverage } from "@/oxp/tool-coverage"
import { ToolExposure } from "@/tool/exposure"
import { runUsage as nativeRunUsage } from "@/tool/usage"
import { runUsage as sharedRunUsage } from "@/usage/inspection-contract"

const docPath = resolve(import.meta.dir, "../../../../docs/architecture/oxp-native-tool-parity.md")
const start = "<!-- OXP-NATIVE-PARITY-MATRIX:START -->"
const end = "<!-- OXP-NATIVE-PARITY-MATRIX:END -->"

describe("native/OXP parity architecture contract", () => {
  test("native usage delegates to the shared domain execution contract", () => {
    expect(nativeRunUsage).toBe(sharedRunUsage)
  })

  test("the documented matrix exactly matches the shared executable mapping ledger", () => {
    const doc = readFileSync(docPath, "utf8")
    const from = doc.indexOf(start)
    const to = doc.indexOf(end)
    expect(from).toBeGreaterThanOrEqual(0)
    expect(to).toBeGreaterThan(from)
    const matrix = doc.slice(from + start.length, to).trim()
    expect(matrix).toBe(OxpToolCoverage.markdownParityMatrix())
    expect(matrix.split("\n")).toHaveLength(OxpToolCoverage.ENTRIES.length + 2)
  })

  test("every native builtin has one reviewed OXP disposition", () => {
    expect(OxpToolCoverage.unmappedNativeTools()).toEqual([])
    expect(OxpToolCoverage.unknownExceptions()).toEqual([])
    // A new exception is a policy change, not a way to silence parity CI:
    // reviewers must deliberately update this independent expectation.
    expect(OxpToolCoverage.EXPLICIT_EXCEPTIONS).toEqual([
      "invalid",
      "github",
      "quota",
      "plan_exit",
    ])
    const ids = OxpToolCoverage.ENTRIES.map((entry) => entry.native)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of OxpToolCoverage.ENTRIES) {
      if (entry.oxp) {
        expect(entry.oxp.trim().length).toBeGreaterThan(0)
        continue
      }
      expect(OxpToolCoverage.EXPLICIT_EXCEPTIONS).toContain(entry.native as never)
      expect(entry.note.length).toBeGreaterThan(50)
    }
  })

  test("native lazy exposure classification is reused by the OXP matrix", () => {
    const matrix = OxpToolCoverage.markdownParityMatrix()
    for (const entry of OxpToolCoverage.ENTRIES) {
      const policy = ToolExposure.loadPolicy(entry.native)
      const line = matrix.split("\n").find((line) => line.startsWith(`| \`@${entry.native}\` |`))
      expect(line).toBeDefined()
      expect(line).toEndWith(`| ${policy} |`)
    }
  })
})
