import { describe, expect, test } from "bun:test"
import {
  healLegacyFindCall,
  isCanonicalFindToolMap,
  markCanonicalFindToolMap,
  preserveCanonicalFindToolMap,
} from "@/session/llm/tool-call-heal"

const findOnly = () => markCanonicalFindToolMap({ find: {} })

function casingVariants(value: string) {
  let variants = [""]
  for (const char of value) variants = variants.flatMap((prefix) => [prefix + char.toLowerCase(), prefix + char.toUpperCase()])
  return [...new Set(variants)]
}

describe("legacy find tool-call healing", () => {
  test("rewrites upstream glob object input", () => {
    expect(healLegacyFindCall("glob", { pattern: "**/*.ts", path: "src" }, findOnly())).toEqual({
      name: "find",
      input: { glob: "**/*.ts", path: "src" },
      healed: true,
      legacyName: "glob",
    })
  })

  test("rewrites upstream grep object input", () => {
    expect(
      healLegacyFindCall("grep", { pattern: "SessionIngress", path: "src", include: "*.{ts,tsx}" }, findOnly()),
    ).toEqual({
      name: "find",
      input: { grep: "SessionIngress", path: "src", include: "*.{ts,tsx}" },
      healed: true,
      legacyName: "grep",
    })
  })

  test("preserves JSON-string input encoding for AI SDK repair", () => {
    const healed = healLegacyFindCall("Glob", JSON.stringify({ pattern: "*.md" }), findOnly())
    expect(healed.name).toBe("find")
    expect(healed.healed).toBe(true)
    expect(JSON.parse(healed.input as string)).toEqual({ glob: "*.md" })
  })

  test("heals every casing variant of upstream glob and grep names", () => {
    for (const legacy of ["glob", "grep"] as const) {
      for (const name of casingVariants(legacy)) {
        const healed = healLegacyFindCall(name, { pattern: "needle" }, findOnly())
        expect(healed).toMatchObject({
          name: "find",
          healed: true,
          legacyName: legacy,
          input: { [legacy]: "needle" },
        })
      }
    }
  })

  test("does not shadow a genuinely registered legacy tool", () => {
    expect(healLegacyFindCall("grep", { pattern: "x" }, markCanonicalFindToolMap({ find: {}, grep: {} })).healed).toBe(
      false,
    )
    expect(healLegacyFindCall("gLoB", { pattern: "*" }, markCanonicalFindToolMap({ find: {}, GLOB: {} })).healed).toBe(
      false,
    )
  })

  test("does not heal malformed upstream arguments", () => {
    const tools = findOnly()
    expect(healLegacyFindCall("grep", { pattern: "x", path: 123 }, tools).healed).toBe(false)
    expect(healLegacyFindCall("glob", { path: "src" }, tools).healed).toBe(false)
    expect(healLegacyFindCall("glob", { pattern: "*", include: "*.ts" }, tools).healed).toBe(false)
    expect(healLegacyFindCall("grep", { pattern: "" }, tools).healed).toBe(false)
    expect(healLegacyFindCall("grep", { pattern: "x", include: 1 }, tools).healed).toBe(false)
    expect(healLegacyFindCall("grep", { pattern: "x", extra: true }, tools).healed).toBe(false)
    expect(healLegacyFindCall("grep", null, tools).healed).toBe(false)
    expect(healLegacyFindCall("grep", [], tools).healed).toBe(false)
    expect(healLegacyFindCall("grep", "not json", tools).healed).toBe(false)
  })

  test("does not heal when find is unavailable", () => {
    expect(healLegacyFindCall("glob", { pattern: "*" }, {}).healed).toBe(false)
  })

  test("does not heal an unmarked or unrelated find tool", () => {
    expect(healLegacyFindCall("glob", { pattern: "*" }, { find: {} }).healed).toBe(false)

    const spoofed = { find: {} } as Record<string | symbol, unknown>
    Object.defineProperty(spoofed, Symbol.for("@opencode/session/llm/canonical-find"), { value: true })
    expect(healLegacyFindCall("glob", { pattern: "*" }, spoofed as any).healed).toBe(false)
  })

  test("marker is non-enumerable and survives request filtering copies", () => {
    const source = findOnly()
    expect(Object.keys(source)).toEqual(["find"])
    expect(isCanonicalFindToolMap(source)).toBe(true)

    const target = preserveCanonicalFindToolMap(source, { find: {}, read: {} })
    expect(Object.keys(target)).toEqual(["find", "read"])
    expect(isCanonicalFindToolMap(target)).toBe(true)

    const withoutFind = preserveCanonicalFindToolMap(source, { read: {} })
    expect(isCanonicalFindToolMap(withoutFind)).toBe(false)
  })

  test("rejects non-plain runtime objects and never executes accessor payloads", () => {
    const inheritedPattern = Object.create({ pattern: "**/*.ts" }) as Record<string, unknown>
    expect(healLegacyFindCall("glob", inheritedPattern, findOnly()).healed).toBe(false)

    let getterRead = false
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "pattern", {
      enumerable: true,
      get() {
        getterRead = true
        throw new Error("must not execute")
      },
    })
    expect(healLegacyFindCall("glob", accessor, findOnly()).healed).toBe(false)
    expect(getterRead).toBe(false)

    const hostile = new Proxy(
      { pattern: "*.ts" },
      {
        ownKeys() {
          throw new Error("unreadable keys")
        },
      },
    )
    expect(healLegacyFindCall("glob", hostile, findOnly()).healed).toBe(false)

    const nullPrototype = Object.assign(Object.create(null), { pattern: "*.ts" }) as Record<string, unknown>
    expect(healLegacyFindCall("glob", nullPrototype, findOnly())).toMatchObject({
      healed: true,
      input: { glob: "*.ts" },
    })
  })

  test("preserves upstream strings byte-for-byte, including unicode and Windows paths", () => {
    expect(
      healLegacyFindCall(
        "GREP",
        { pattern: "Δelta\\s+✓", path: "C:\\repo\\src", include: "*.{ts,tsx}" },
        findOnly(),
      ),
    ).toMatchObject({
      name: "find",
      healed: true,
      legacyName: "grep",
      input: { grep: "Δelta\\s+✓", path: "C:\\repo\\src", include: "*.{ts,tsx}" },
    })
  })
})
