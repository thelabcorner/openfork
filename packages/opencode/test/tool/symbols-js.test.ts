import { describe, expect, test } from "bun:test"
import path from "path"
import { outlineFor } from "../../src/tool/symbols/outline"

describe("tool.symbols.js fixtures", () => {
  test("require + dynamic import parsed as imports (design §11 symbols-js)", async () => {
    const text = await Bun.file(
      path.join(__dirname, "../../src/tool/__fixtures__/ci/symbols-js/main.js"),
    ).text()
    const outline = await outlineFor(text, "js")
    expect(outline.fallback).toBe(false)
    const names = outline.imports.map((imp) => `${imp.from}:${imp.bindings.join(",")}`)
    expect(names).toContain("./dep:helper")
    // dynamic import() binds the declarator name
    expect(names).toContain("./lazy:lazy")
    expect(outline.symbols.some((s) => s.name === "run" && s.kind === "function")).toBe(true)
    expect(outline.symbols.some((s) => s.name === "VALUE" && s.kind === "const")).toBe(true)
  })

  test("jsx parses via javascript grammar", async () => {
    const text = await Bun.file(
      path.join(__dirname, "../../src/tool/__fixtures__/ci/symbols-js/App.jsx"),
    ).text()
    const outline = await outlineFor(text, "jsx")
    expect(outline.fallback).toBe(false)
    expect(outline.symbols.some((s) => s.name === "App" && s.kind === "function")).toBe(true)
  })
})
