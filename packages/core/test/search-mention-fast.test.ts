import { describe, expect, test } from "bun:test"
import { searchFileMentionsFast } from "../src/search/mention-fast"
import type { Matcher } from "../src/search/matcher"

const PATHS: Matcher.PathEntry[] = [
  { path: "src/components", isDir: true },
  { path: "src/components/Button.tsx", isDir: false },
  { path: "src/search/matcher.ts", isDir: false },
  { path: "packages/core/src/filesystem/search.ts", isDir: false },
  { path: "docs/components-guide.md", isDir: false },
  { path: "src/user/getUserById.ts", isDir: false },
  { path: "packages/app/src/components/dialog-select-model.tsx", isDir: false },
  { path: "packages/app/src/components/DialogSelectModel.tsx", isDir: false },
]

const query = (value: string, limit = 20, offset = 0) =>
  searchFileMentionsFast(PATHS, { query: value, limit, offset })

describe("fast file mention search", () => {
  test("basename relevance beats a dirname-only match", () => {
    const results = query("search").results.map((row) => row.path)
    expect(results[0]).toBe("packages/core/src/filesystem/search.ts")
    expect(results.indexOf("packages/core/src/filesystem/search.ts")).toBeLessThan(results.indexOf("src/search/matcher.ts"))
    expect(results).toContain("packages/core/src/filesystem/search.ts")
  })

  test("boundary acronym finds kebab and camel names", () => {
    const results = query("dsm").results.map((row) => row.path)
    expect(results).toContain("packages/app/src/components/dialog-select-model.tsx")
    expect(results).toContain("packages/app/src/components/DialogSelectModel.tsx")
  })

  test("multi-token queries require every term", () => {
    const results = query("filesystem search").results.map((row) => row.path)
    expect(results).toEqual(["packages/core/src/filesystem/search.ts"])
    expect(query("filesystem zzzqqq").results).toEqual([])
  })

  test("trailing slash switches to directory completion", () => {
    const page = query("src/")
    expect(page.results.length).toBeGreaterThan(0)
    expect(page.results.every((row) => row.type === "directory")).toBe(true)
  })

  test("paging is deterministic and non-overlapping", () => {
    const paths = Array.from({ length: 500 }, (_, i): Matcher.PathEntry => ({ path: `src/file-${i}.ts`, isDir: false }))
    const p1 = searchFileMentionsFast(paths, { query: "file", limit: 100, offset: 0 })
    const p2 = searchFileMentionsFast(paths, { query: "file", limit: 100, offset: 100 })
    expect(p1.hasMore).toBe(true)
    const seen = new Set(p1.results.map((row) => row.path))
    expect(p2.results.every((row) => !seen.has(row.path))).toBe(true)
  })

  test("highlight positions are ascending and in bounds", () => {
    for (const row of query("dsm").results) {
      const positions = row.positions ?? []
      expect(positions.length).toBeGreaterThan(0)
      for (let i = 0; i < positions.length; i++) {
        expect(positions[i]!).toBeLessThan(row.path!.length)
        if (i > 0) expect(positions[i]!).toBeGreaterThan(positions[i - 1]!)
      }
    }
  })
})
