import { describe, expect, test } from "bun:test"
import { omittedSingleTokenScoreUpperBound, searchFileMentionsFast } from "../src/search/mention-fast"
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

  test("directory results never expose file-only metadata", () => {
    const paths: Matcher.PathEntry[] = [
      { path: "src/components", isDir: true, size: 0, mtime: 0, lineCount: 0 },
      { path: "src/components/empty.ts", isDir: false, size: 0, mtime: 123, lineCount: 0 },
    ]
    const page = searchFileMentionsFast(paths, { query: "components", limit: 20, offset: 0 })
    const directory = page.results.find((row) => row.path === "src/components")
    const file = page.results.find((row) => row.path === "src/components/empty.ts")

    expect(directory?.type).toBe("directory")
    expect(directory?.size).toBeUndefined()
    expect(directory?.mtime).toBeUndefined()
    expect(directory?.lineCount).toBeUndefined()
    expect(file?.size).toBe(0)
    expect(file?.mtime).toBe(123)
    expect(file?.lineCount).toBe(0)
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

  test("candidate omission bounds stay conservative and query-shape limited", () => {
    expect(omittedSingleTokenScoreUpperBound("sis", "path-substring+basename-boundary")).toBe(509)
    expect(omittedSingleTokenScoreUpperBound("vlccsc", "path-substring+basename-subsequence")).toBe(245)
    expect(omittedSingleTokenScoreUpperBound("a", "path-substring+basename-boundary")).toBeUndefined()
    expect(omittedSingleTokenScoreUpperBound("server session", "path-substring+basename-boundary")).toBeUndefined()
    expect(omittedSingleTokenScoreUpperBound("src/foo", "path-substring+basename-boundary")).toBeUndefined()
  })

  test("basename-subsequence omission bound dominates adversarial directory matches", () => {
    const alphabet = "abcdefgh"
    for (let length = 2; length <= 8; length++) {
      const token = alphabet.slice(0, length)
      const last = token.at(-1)!
      const omitted: Matcher.PathEntry[] = [
        { path: `${token}/x.ts`, isDir: false },
        { path: `${token.slice(0, -1)}/${last}.ts`, isDir: false },
        { path: `${token.split("").join("/")}/x.ts`, isDir: false },
        { path: `${token.slice(0, -1).split("").join("/")}/${last}.ts`, isDir: false },
      ]
      const bound = omittedSingleTokenScoreUpperBound(token, "path-substring+basename-subsequence")!
      for (const candidate of omitted) {
        const score = searchFileMentionsFast([candidate], { query: token, limit: 1, offset: 0 }).results[0]?.score
        expect(score).toBeLessThanOrEqual(bound)
      }
    }

    const camelDirectory: Matcher.PathEntry = { path: "aB/x.ts", isDir: false }
    const camelScore = searchFileMentionsFast([camelDirectory], { query: "ab", limit: 1, offset: 0 }).results[0]?.score
    expect(camelScore).toBe(68)
    expect(camelScore).toBeLessThanOrEqual(
      omittedSingleTokenScoreUpperBound("ab", "path-substring+basename-subsequence")!,
    )
  })
})
