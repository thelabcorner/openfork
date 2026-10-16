import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { OxpToolCoverage } from "@/oxp/tool-coverage"
import { ToolExposure } from "@/tool/exposure"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Parameters as NativeUsage } from "@/usage/inspection-contract"
import { Parameters as ExternalUsage } from "@/oxp/usage"
import { Parameters as NativeCode } from "@/code/schema"
import { Parameters as ExternalCode } from "@/oxp/code"
import { Parameters as NativeProject } from "@/tool/project"
import { Parameters as ExternalProject } from "@/oxp/project"
import { Parameters as NativeRead } from "@/tool/read"
import { Parameters as ExternalRead } from "@/oxp/read"
import { Parameters as NativeBrowser } from "@/tool/browser"
import { Parameters as ExternalBrowser } from "@/oxp/browser"
import type { Schema } from "effect"

function schemaActions(schema: Schema.Top) {
  const value = ToolJsonSchema.fromSchema(schema).properties?.action
  if (!value || typeof value !== "object" || !("enum" in value) || !Array.isArray(value.enum)) {
    throw new Error("Expected a statically enumerable action schema")
  }
  return [...value.enum].map(String).sort()
}

/**
 * The prose table is generated from code, not a second manually maintained
 * source of truth. A new native tool / changed lazy policy must update both
 * the executable transport mapping and the human-readable contract.
 */
describe("OXP native parity architecture contract", () => {
  const docPath = resolve(import.meta.dir, "../../../../docs/architecture/oxp-native-tool-parity.md")
  const begin = "<!-- OXP-NATIVE-PARITY-MATRIX:START -->"
  const end = "<!-- OXP-NATIVE-PARITY-MATRIX:END -->"

  test("documents precisely the mapping and loading policy in the authoritative ledger", () => {
    const doc = readFileSync(docPath, "utf8")
    const start = doc.indexOf(begin)
    const finish = doc.indexOf(end, start + begin.length)
    expect(start).toBeGreaterThan(-1)
    expect(finish).toBeGreaterThan(start)
    expect(doc.indexOf(begin, start + begin.length)).toBe(-1)
    expect(doc.indexOf(end, finish + end.length)).toBe(-1)
    const actual = doc.slice(start + begin.length, finish).trim()
    expect(actual).toBe(OxpToolCoverage.markdownParityMatrix())
    expect(actual.split("\n").length).toBe(OxpToolCoverage.ENTRIES.length + 2)
  })

  test("documents exact action-level exceptions, not just matching capability names", () => {
    const doc = readFileSync(docPath, "utf8")
    const begin = "<!-- OXP-NATIVE-ACTION-SCOPES:START -->"
    const end = "<!-- OXP-NATIVE-ACTION-SCOPES:END -->"
    const start = doc.indexOf(begin)
    const finish = doc.indexOf(end, start + begin.length)
    expect(start).toBeGreaterThan(-1)
    expect(finish).toBeGreaterThan(start)
    expect(doc.slice(start + begin.length, finish).trim()).toBe(OxpToolCoverage.markdownActionScopes())
    expect(doc.indexOf(begin, start + begin.length)).toBe(-1)
  })

  test("fails if native/OXP action enums drift from any explicitly documented difference", () => {
    const checks = [
      { id: "usage", native: NativeUsage, external: ExternalUsage },
      { id: "code", native: NativeCode, external: ExternalCode },
      { id: "project", native: NativeProject, external: ExternalProject },
      { id: "read", native: NativeRead, external: ExternalRead },
    ] as const
    for (const { id, native, external } of checks) {
      const scope = OxpToolCoverage.ACTION_SCOPES[id]
      const nativeActions = schemaActions(native)
      const externalActions = schemaActions(external)
      expect(externalActions).toEqual([...scope.exposed].sort())
      const nativeEquivalent = scope.exposed.filter(
        (action) => !(scope.externalOnly as readonly string[]).includes(action),
      )
      expect(nativeActions).toEqual([...nativeEquivalent, ...scope.unavailable].sort())
      expect(new Set([...nativeEquivalent, ...scope.unavailable]).size).toBe(nativeActions.length)
    }
  })

  test("exposes every native browser operation through OXP's typed operation union", () => {
    const native = ToolJsonSchema.fromSchema(NativeBrowser) as { properties?: { operation?: { enum?: unknown[] } } }
    const oxp = ToolJsonSchema.fromSchema(ExternalBrowser) as {
      anyOf?: Array<{ properties?: { operation?: { enum?: unknown[] } } }>
    }
    const expected = [...(native.properties?.operation?.enum ?? [])].map(String).sort()
    const actual = (oxp.anyOf ?? [])
      .flatMap((item) => item.properties?.operation?.enum ?? [])
      .map(String)
      .sort()
    expect(expected.length).toBeGreaterThan(20)
    expect(actual).toEqual(expected)
    expect(new Set(actual).size).toBe(actual.length)
  })

  test("keeps shared-action tool families synchronized across native and OXP schemas", async () => {
    // Import the actual runtime parameter schemas, never merely two static
    // coverage declarations claiming that a family has parity.
    const names = [
      "archive",
      "json",
      "memory",
      "sqlite",
      "git",
      "web",
      "symbols",
      "test",
      "refactor",
      "typecheck",
      "ofxp",
      "skill",
    ] as const
    for (const name of names) {
      const native = await import(`../../src/tool/${name}.ts`)
      const oxp = await import(`../../src/oxp/${name}.ts`)
      const actions = (schema: Schema.Top) => {
        const props = ToolJsonSchema.fromSchema(schema).properties
        const field = props?.action ?? props?.mode
        const selected =
          field && typeof field === "object" && "enum" in field && Array.isArray(field.enum) ? field.enum : undefined
        if (!Array.isArray(selected) || selected.length === 0) {
          throw new Error(`Missing enumerable action/mode contract for ${name}`)
        }
        return [...selected].map(String).sort()
      }
      expect(actions(oxp.Parameters)).toEqual(actions(native.Parameters))
    }
  })

  test("rejects implicit exceptions and duplicate native registrations", () => {
    expect(OxpToolCoverage.unmappedNativeTools()).toEqual([])
    expect(OxpToolCoverage.unknownExceptions()).toEqual([])
    expect(new Set(OxpToolCoverage.ENTRIES.map((item) => item.native)).size).toBe(OxpToolCoverage.ENTRIES.length)
    const exceptions = new Set<string>(OxpToolCoverage.EXPLICIT_EXCEPTIONS)
    for (const item of OxpToolCoverage.ENTRIES) {
      expect(Boolean(item.oxp) !== exceptions.has(item.native)).toBe(true)
      expect(ToolExposure.loadPolicy(item.native)).toMatch(/^(default|lazy)$/)
    }
  })

  test("reports missing executable mappings without trusting the declaration itself", () => {
    const native = OxpToolCoverage.ENTRIES.find((item) => item.native === "read")
    expect(native?.oxp).toBe("read")
    expect(OxpToolCoverage.missingExecutableTargets(new Set())).toContain("read")
    expect(OxpToolCoverage.missingExecutableTargets(new Set(["read"]))).not.toContain("read")
  })
})
