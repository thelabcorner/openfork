import { describe, expect, test } from "bun:test"
import { parseMarkdownTarget } from "./markdown-target"

describe("parseMarkdownTarget paths", () => {
  test("keeps a plain posix path untouched", () => {
    expect(parseMarkdownTarget("path", "packages/app/src/index.ts")).toMatchObject({
      value: "packages/app/src/index.ts",
      raw: "packages/app/src/index.ts",
    })
  })

  test("keeps a windows absolute path, drive colon included", () => {
    const target = parseMarkdownTarget("path", "C:\\Users\\slooshied\\.local\\share\\opencode\\handoff.md")
    expect(target?.value).toBe("C:\\Users\\slooshied\\.local\\share\\opencode\\handoff.md")
    expect(target?.line).toBeUndefined()
  })

  test("splits an editor-style line suffix off the path", () => {
    expect(parseMarkdownTarget("path", "src/app.ts:42")).toMatchObject({ value: "src/app.ts", line: 42 })
  })

  test("splits line and column", () => {
    expect(parseMarkdownTarget("path", "src/app.ts:42:7")).toMatchObject({
      value: "src/app.ts",
      line: 42,
      column: 7,
    })
  })

  test("splits a line suffix off a windows path without eating the drive", () => {
    expect(parseMarkdownTarget("path", "C:\\repo\\main.rs:120")).toMatchObject({
      value: "C:\\repo\\main.rs",
      line: 120,
    })
  })

  test("drops trailing sentence punctuation", () => {
    expect(parseMarkdownTarget("path", "src/app.ts.")?.value).toBe("src/app.ts")
    expect(parseMarkdownTarget("path", "src/app.ts,")?.value).toBe("src/app.ts")
    expect(parseMarkdownTarget("path", "(src/app.ts)")?.value).toBe("(src/app.ts")
  })

  test("keeps a trailing separator so directories stay directories", () => {
    expect(parseMarkdownTarget("path", "packages/app/")?.value).toBe("packages/app/")
    expect(parseMarkdownTarget("path", "C:\\repo\\")?.value).toBe("C:\\repo\\")
  })

  test("preserves filesystem roots and windows drive designators", () => {
    expect(parseMarkdownTarget("path", "/")?.value).toBe("/")
    expect(parseMarkdownTarget("path", "C:\\")?.value).toBe("C:\\")
    expect(parseMarkdownTarget("path", "C:")?.value).toBe("C:")
  })

  test("strips surrounding quotes while copy keeps them", () => {
    const target = parseMarkdownTarget("path", '"src/app.ts"')
    expect(target?.value).toBe("src/app.ts")
    expect(target?.raw).toBe('"src/app.ts"')
  })

  test("leaves a bare line reference alone rather than emptying it", () => {
    expect(parseMarkdownTarget("path", ":42")?.value).toBe(":42")
  })

  test("rejects blank input", () => {
    expect(parseMarkdownTarget("path", "   ")).toBeUndefined()
    expect(parseMarkdownTarget("path", "")).toBeUndefined()
  })
})

describe("parseMarkdownTarget urls", () => {
  test("keeps the url intact", () => {
    expect(parseMarkdownTarget("url", "https://example.com/a/b")?.value).toBe("https://example.com/a/b")
  })

  test("drops trailing prose punctuation", () => {
    expect(parseMarkdownTarget("url", "https://example.com/docs.")?.value).toBe("https://example.com/docs")
  })

  test("preserves a query string", () => {
    expect(parseMarkdownTarget("url", "https://example.com/s?q=1&b=2")?.value).toBe("https://example.com/s?q=1&b=2")
  })

  test("copy keeps the original text even when the value is cleaned", () => {
    const target = parseMarkdownTarget("url", "https://example.com/docs.")
    expect(target?.raw).toBe("https://example.com/docs.")
  })
})
