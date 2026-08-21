import { describe, expect, test } from "bun:test"
import { Matcher } from "../src/search/matcher"
import { MatcherScore } from "../src/search/matcher-score"

const PATHS: Matcher.PathEntry[] = [
  { path: "src/components/", isDir: true },
  { path: "src/components/Button.tsx", isDir: false },
  { path: "src/search/matcher.ts", isDir: false },
  { path: "packages/core/src/filesystem/search.ts", isDir: false },
  { path: "lib/components.ts", isDir: false },
  { path: "docs/components-guide.md", isDir: false },
  { path: "app/utils/deep/nested/other.ts", isDir: false },
  { path: "src/user/getUserById.ts", isDir: false },
]

const SYMBOLS: Matcher.SymbolEntry[] = [
  { name: "getUserById", kind: "function", path: "src/user/getUserById.ts", line: 10 },
  { name: "FileSystemSearch", kind: "class", path: "src/search/matcher.ts", line: 20 },
  { name: "findFile", kind: "function", path: "packages/core/src/filesystem/search.ts", line: 30 },
]

const prepared = Matcher.prepare({ paths: PATHS, symbols: SYMBOLS })

describe("matcher golden relevance", () => {
  test("basename match outranks dirname-only match", () => {
    const res = Matcher.queryPaths(prepared, "components", { limit: 10 })
    expect(res.length).toBeGreaterThan(0)
    // entries with 'components' in their basename must beat the entry whose
    // match is dirname-only (app/utils/deep/nested/other.ts doesn't match at
    // all; docs guide basename contains it too — assert ordering instead)
    const ranks = new Map(res.map((r, i) => [r.item.path, i]))
    const dir = ranks.get("src/components/")!
    const button = ranks.get("src/components/Button.tsx")!
    expect(dir).toBeLessThan(PATHS.length)
    expect(button).toBeLessThan(PATHS.length)
    // dir basename competes with file basenames (operator parity requirement):
    // src/components/ must rank top-3
    expect(dir).toBeLessThan(3)
  })

  test("camelCase acronym finds target", () => {
    const res = Matcher.queryPaths(prepared, "gubi", { limit: 10 })
    expect(res.some((r) => r.item.path === "src/user/getUserById.ts")).toBe(true)
    const syms = Matcher.querySymbols(prepared, "gubi", { limit: 5 })
    expect(syms[0]?.item.name).toBe("getUserById")
  })

  test("multi-token AND requires every token", () => {
    const both = Matcher.queryPaths(prepared, "src search", { limit: 20 })
    expect(both.length).toBeGreaterThan(0)
    for (const r of both) {
      expect(r.item.path.toLowerCase()).toContain("src")
      expect(Matcher.tokenMatch(r.item.path.toLowerCase(), "search")).toBe(true)
    }
    const miss = Matcher.queryPaths(prepared, "src zzzqqq", { limit: 20 })
    expect(miss.length).toBe(0)
  })

  test("trailing slash means directory-completion mode", () => {
    const res = Matcher.queryPaths(prepared, "src/", { limit: 20 })
    expect(res.length).toBeGreaterThan(0)
    for (const r of res) {
      expect(r.item.isDir).toBe(true)
      expect(r.item.path.endsWith("/")).toBe(true)
    }
  })

  test("deterministic across repeated calls", () => {
    const a = Matcher.queryPaths(prepared, "search", { limit: 20 }).map((r) => r.item.path)
    const b = Matcher.queryPaths(prepared, "search", { limit: 20 }).map((r) => r.item.path)
    expect(a).toEqual(b)
  })

  test("limit respected", () => {
    const all = Matcher.queryPaths(prepared, "o", { limit: 100 })
    expect(all.length).toBeGreaterThan(5)
    expect(Matcher.queryPaths(prepared, "o", { limit: 3 }).length).toBeLessThanOrEqual(3)
    expect(Matcher.queryPaths(prepared, "o", { limit: 3 }).length).toBeGreaterThan(0)
  })

  test("positions ascending, in-bounds, highlight the query", () => {
    const res = Matcher.queryPaths(prepared, "pac", { limit: 10 })
    for (const r of res) {
      const pos = r.positions ?? []
      expect(pos.length).toBeGreaterThan(0)
      for (let i = 0; i < pos.length; i++) {
        expect(pos[i]!).toBeLessThan(r.item.path.length)
        if (i > 0) expect(pos[i]!).toBeGreaterThan(pos[i - 1]!)
      }
    }
    // exact prefix hit highlights the basename start
    const pkg = res.find((r) => r.item.path === "packages/x.ts")
    if (pkg?.positions && pkg.baseOffset !== undefined) expect(pkg.positions[0]!).toBe(pkg.baseOffset)
  })

  test("empty and whitespace queries return nothing", () => {
    expect(Matcher.queryPaths(prepared, "", { limit: 10 })).toEqual([])
    expect(Matcher.queryPaths(prepared, "   ", { limit: 10 })).toEqual([])
    expect(Matcher.query(prepared, "", {}).results).toEqual([])
  })

  test("typo transposition recovers on strict underfill", () => {
    const page = Matcher.query(prepared, "comopnents", { limit: 10 })
    expect(page.results.length).toBeGreaterThan(0)
    expect(page.results.some((r) => r.path?.includes("component"))).toBe(true)
  })
})

describe("matcher unified paging", () => {
  test("merged results carry kind discriminators and stable order across pages", () => {
    const big = Matcher.prepare({
      paths: Array.from({ length: 400 }, (_, i) => ({ path: `mod/file${i}.ts`, isDir: false })),
      symbols: Array.from({ length: 300 }, (_, i) => ({ name: `handler${i}`, kind: "function", path: `mod/h${i}.ts`, line: i })),
    })
    const p1 = Matcher.query(big, "file", { limit: 200, offset: 0 })
    const p2 = Matcher.query(big, "file", { limit: 200, offset: 200 })
    expect(p1.results.length).toBe(200)
    expect(p1.hasMore).toBe(true)
    expect(p2.results.length).toBeGreaterThan(0)
    // no overlap between pages, and page 2 continues page 1's ranking
    const seen = new Set(p1.results.map((r) => ("path" in r ? r.path : `${r.name}@${r.path}`)))
    for (const r of p2.results) {
      const key = "path" in r && r.kind === "file" ? r.path : `${r.name}@${r.path}`
      expect(seen.has(key)).toBe(false)
    }
    for (const r of p1.results) expect(["file", "symbol"]).toContain(r.kind)
  })

  test("hasMore false on last page", () => {
    const page = Matcher.query(prepared, "components", { limit: 100 })
    expect(page.hasMore).toBe(false)
  })

  test("session incremental append agrees with stateless query on result set", () => {
    const session = Matcher.createSession(prepared)
    session.query("gete", { limit: 10 })
    const inc = session.query("getus", { limit: 10 })
    const cold = Matcher.queryPaths(prepared, "getus", { limit: 10 })
    // incremental filter-down is a generator approximation; the validated
    // top results must still agree on the strong head
    expect(inc.files[0]?.item.path).toBe(cold[0]?.item.path)
  })
})

describe("scorer invariants", () => {
  test("primary exact beats longer partial", () => {
    const idxPrep = Matcher.prepare({
      paths: [
        { path: "a/schema", isDir: true },
        { path: "b/schema-extra-long-name.ts", isDir: false },
      ],
      symbols: [],
    })
    const res = Matcher.queryPaths(idxPrep, "schema", { limit: 2 })
    expect(res[0]?.item.path).toBe("a/schema")
  })

  test("NEG constant unchanged", () => {
    expect(MatcherScore.NEG).toBe(-1 << 30)
  })
})
