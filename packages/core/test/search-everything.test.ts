import { describe, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import {
  certifyCandidateTopK,
  compareShadow,
  normalizeCandidate,
  searchCandidatePage,
  searchCandidates,
  searchCandidatesExhaustive,
} from "../src/search/everything"
import { basenameContainsQuerySubsequence, omittedSingleTokenScoreUpperBound, searchFileMentionsFast } from "../src/search/mention-fast"
import type { Matcher } from "../src/search/matcher"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

/** Drive the pure certificate directly - no live Everything index required. */
function certify(input: {
  query: string
  pageScores: readonly number[]
  pageLimit: number
  basenameSubsequenceComplete?: boolean
  discardedPaths?: readonly string[]
}) {
  return certifyCandidateTopK({
    query: input.query,
    pageScores: input.pageScores,
    pageLimit: input.pageLimit,
    basenameSubsequenceComplete: input.basenameSubsequenceComplete ?? true,
    discardedPaths: input.discardedPaths ?? [],
  })
}

describe("Everything candidate provider", () => {
  test("never returns absolute or escaped candidates", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
    const rows = await Effect.runPromise(searchCandidates({ root, query: "src", count: 200 }))
    for (const row of rows) {
      expect(path.isAbsolute(row.path)).toBe(false)
      expect(row.path.startsWith("../")).toBe(false)
      expect(row.path.split("/").some((segment) => segment.startsWith("."))).toBe(false)
    }
  })

  test("shadow comparison reports top-k coverage without affecting native ordering", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
    const corpus = [
      { path: "src/filesystem/search.ts", isDir: false },
      { path: "src/search/mention-fast.ts", isDir: false },
    ]
    const input = { query: "search", limit: 2, offset: 0 }
    const native = searchFileMentionsFast(corpus, input)
    const result = await Effect.runPromise(
      compareShadow({
        root,
        query: input.query,
        count: 200,
        native: native.results,
        corpus,
        limit: input.limit,
        offset: input.offset,
      }),
    )
    expect(result.nativeTopK).toBe(2)
    expect(result.coveredTopK).toBeGreaterThanOrEqual(0)
    expect(result.coveredTopK).toBeLessThanOrEqual(2)
    expect(result.recall).toBeGreaterThanOrEqual(0)
    expect(result.recall).toBeLessThanOrEqual(1)
    if (result.provenTopK) expect(result.orderedExact).toBe(true)
  })

  test("concurrent provider calls expose busy/unavailable state instead of cross-wiring", async () => {
    if (process.platform !== "win32") return
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
    const [left, right] = await Promise.all([
      Effect.runPromise(searchCandidatePage({ root, query: "search", count: 50 })),
      Effect.runPromise(searchCandidatePage({ root, query: "session", count: 50 })),
    ])
    expect(["measured", "busy", "unavailable"]).toContain(left.status)
    expect(["measured", "busy", "unavailable"]).toContain(right.status)
    for (const result of [left, right]) {
      for (const entry of result.paths) {
        expect(path.isAbsolute(entry.path)).toBe(false)
        expect(entry.path.startsWith("../")).toBe(false)
      }
    }
  })

  test("detailed and exhaustive APIs distinguish a true empty result from provider failure", async () => {
    if (process.platform !== "win32") return
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
    const query = "zzqvopenforknomatch47291zzqv"
    const page = await Effect.runPromise(searchCandidatePage({ root, query, count: 8 }))
    if (page.status === "measured") {
      expect(page.paths).toEqual([])
      expect(page.complete).toBe(true)
      expect(page.requiredCount).toBe(0)
      expect(page.exhaustible).toBe(true)
    } else if (page.status === "unavailable") {
      expect(["unsupported", "database-loading", "transport", "protocol"]).toContain(page.reason)
    } else {
      expect(page.status).toBe("busy")
    }

    const exhaustive = await Effect.runPromise(searchCandidatesExhaustive({ root, query, initialCount: 1 }))
    if (exhaustive.status === "measured") {
      expect(exhaustive.paths).toEqual([])
      expect(exhaustive.complete).toBe(true)
      expect(exhaustive.requiredCount).toBe(0)
    }
  })

  test("shadow scheduler discards stale generations and preserves the latest request", async () => {
    if (process.platform !== "win32") return
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
    const native = [
      { kind: "file" as const, path: "src/filesystem/search.ts", type: "file" as const, score: 100, positions: [], baseOffset: 15 },
    ]
    const [first, middle, latest] = await Promise.all([
      Effect.runPromise(compareShadow({ root, query: "search", count: 512, native })),
      Effect.runPromise(compareShadow({ root, query: "session", count: 512, native })),
      Effect.runPromise(compareShadow({ root, query: "project explorer", count: 512, native })),
    ])
    expect(first.measured).toBe(false)
    expect(first.skippedReason).toBe("stale")
    expect(middle.measured).toBe(false)
    expect(middle.skippedReason).toBe("stale")
    expect(latest.skippedReason).not.toBe("stale")
  })

  test("normalization rejects relative and out-of-root paths", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
    const inside = normalizeCandidate(root, { fullPath: path.join(root, "src", "search", "everything.ts"), isDir: false })
    const outside = normalizeCandidate(root, { fullPath: path.resolve(root, "..", "outside.ts"), isDir: false })
    const relative = normalizeCandidate(root, { fullPath: "src/search/everything.ts", isDir: false })
    expect(inside?.path).toBe("src/search/everything.ts")
    expect(outside).toBeUndefined()
    expect(relative).toBeUndefined()
  })
})

describe("top-K certificate refuses to certify", () => {
  // 1. FLOOR EQUALITY IS UNPROVEN. This is not theoretical: the equality is
  //    reachable by an ordinary path the scorer ranks above its own bound.
  test("a floor exactly equal to the bound is UNPROVEN, never a pass", () => {
    const query = "ab"
    const ceiling = omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")!
    const adversarial = searchFileMentionsFast([{ path: "aB/x.ts", isDir: false }], { query, limit: 1, offset: 0 })
    const score = adversarial.results[0]!.score
    // Pin the premise: equality is genuinely reachable.
    expect(score).toBe(ceiling)
    const equal = certify({ query, pageScores: [score], pageLimit: 1 })
    expect(equal.omittedScoreUpperBound).toBe(ceiling)
    expect(equal.proofFloor).toBe(ceiling)
    expect(equal.provenTopK).toBe(false)
    // One point of strict margin is what it takes.
    expect(certify({ query, pageScores: [ceiling + 1], pageLimit: 1 }).provenTopK).toBe(true)
    expect(certify({ query, pageScores: [ceiling - 1], pageLimit: 1 }).provenTopK).toBe(false)
  })

  // 2. OMITTED CANDIDATES. The regression this closes: a row the provider
  //    enumerated but candidate filtering discarded is an UNBOUNDED member of
  //    the omitted set. Before the gate it could outrank the floor and the
  //    certificate still passed.
  test("a discarded row whose basename is not covered refuses certification", () => {
    const query = "ab"
    const ceiling = omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")!
    const floor = ceiling + 40
    // This row scored high in the real corpus, yet normalizeCandidate drops it
    // for the dot segment, so it is enumerated-but-discarded and unbounded.
    const highScoring = searchFileMentionsFast([{ path: "x/ab.ts", isDir: false }], { query, limit: 1, offset: 0 })
    expect(highScoring.results[0]!.score).toBeGreaterThan(floor)
    expect(normalizeCandidate(ROOT, { fullPath: path.join(ROOT, ".openfork", "ab.ts"), isDir: false })).toBeUndefined()

    expect(certify({ query, pageScores: [floor], pageLimit: 1 }).provenTopK).toBe(true)
    const blocked = certify({
      query,
      pageScores: [floor],
      pageLimit: 1,
      discardedPaths: [path.join(ROOT, ".openfork", "ab.ts")],
    })
    expect(blocked.discardedCoverageSafe).toBe(false)
    expect(blocked.provenTopK).toBe(false)
  })

  test("discarded rows that satisfy the precondition keep the certificate", () => {
    const query = "ab"
    const ceiling = omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")!
    const floor = ceiling + 40
    // Real corpora discard the large majority of enumerated rows. A discarded
    // row whose basename lacks the query as a subsequence is indistinguishable
    // from a never-enumerated row, so the bound covers it and certification
    // stands. This is what keeps the accelerator usable at the measured
    // 94-98% discard rate instead of being permanently unprovable.
    const result = certify({
      query,
      pageScores: [floor],
      pageLimit: 1,
      discardedPaths: [
        path.join(ROOT, "node_modules", "pkg", "readme.md"),
        path.join(ROOT, ".openfork", "state.json"),
        path.join(ROOT, "dist", "chunk.js"),
        path.join(ROOT, "zz.ts"),
      ],
    })
    expect(result.discardedCoverageSafe).toBe(true)
    expect(result.provenTopK).toBe(true)
  })

  test("one uncovered discarded row among many covered ones still refuses", () => {
    const query = "ab"
    const ceiling = omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")!
    const result = certify({
      query,
      pageScores: [ceiling + 40],
      pageLimit: 1,
      discardedPaths: [path.join(ROOT, "a", "zz.ts"), path.join(ROOT, "src", "a-b.ts")],
    })
    expect(result.discardedCoverageSafe).toBe(false)
    expect(result.provenTopK).toBe(false)
  })

  // 3. PAGE / LIMIT VARIATION.
  test("a short page never certifies because it has no floor", () => {
    const query = "ab"
    const ceiling = omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")!
    const short = certify({ query, pageScores: [ceiling + 500, ceiling + 400], pageLimit: 10 })
    expect(short.proofFloor).toBeUndefined()
    expect(short.provenTopK).toBe(false)
    // The floor is the LAST row of the page, never the first.
    const full = certify({ query, pageScores: [ceiling + 900, ceiling + 40], pageLimit: 2 })
    expect(full.proofFloor).toBe(ceiling + 40)
    expect(full.provenTopK).toBe(true)
    // Deep pages are held to the same strict rule at their own floor.
    expect(certify({ query, pageScores: [ceiling + 900, ceiling - 1], pageLimit: 2 }).provenTopK).toBe(false)
  })

  test("the floor tracks the requested page, so offset paging is judged on its own rows", () => {
    const query = "ab"
    const ceiling = omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")!
    // Simulate page two of three: only the returned page's floor is known.
    const laterPage = certify({ query, pageScores: [ceiling + 30, ceiling + 20], pageLimit: 2 })
    expect(laterPage.proofFloor).toBe(ceiling + 20)
    expect(laterPage.provenTopK).toBe(true)
    expect(certify({ query, pageScores: [ceiling + 30, ceiling], pageLimit: 2 }).provenTopK).toBe(false)
  })

  // 4. INCOMPLETE ENUMERATION.
  test("an incomplete certifying source refuses even with a dominant floor", () => {
    const query = "ab"
    const ceiling = omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")!
    const result = certify({
      query,
      pageScores: [ceiling + 5000],
      pageLimit: 1,
      basenameSubsequenceComplete: false,
    })
    expect(result.proofFloor).toBe(ceiling + 5000)
    expect(result.provenTopK).toBe(false)
  })

  // 5. PUNCTUATION.
  test("punctuation queries are unprovable rather than mis-scored", () => {
    for (const query of ["a-b", "a_b", "a.b", "ab.", ".ab", "a/b", "a\\b", "a+b", "a&b"]) {
      expect(omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")).toBeUndefined()
      const result = certify({ query, pageScores: [100_000], pageLimit: 1 })
      expect(result.omittedScoreUpperBound).toBeUndefined()
      expect(result.provenTopK).toBe(false)
    }
  })

  // 6. UNICODE.
  test("non-ASCII queries are unprovable, never silently folded", () => {
    for (const query of ["éab", "abé", "aéb", "日本", "ab日"]) {
      expect(omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")).toBeUndefined()
      expect(certify({ query, pageScores: [100_000], pageLimit: 1 }).provenTopK).toBe(false)
    }
  })

  // 7. MULTI-TOKEN.
  test("multi-token queries are unprovable, including the historical counterexamples", () => {
    for (const query of ["server session", "proj exp", "filesystem search", "dialog select"]) {
      expect(omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")).toBeUndefined()
      const result = certify({ query, pageScores: [10_000], pageLimit: 1 })
      expect(result.omittedScoreUpperBound).toBeUndefined()
      expect(result.provenTopK).toBe(false)
    }
  })

  // 8. DIRECTORY MODE. Its score space is disjoint from the token bound, and
  //    the bound is undefined for every directory-mode query, so directory
  //    completion can never be certified.
  test("directory mode is unprovable by construction", () => {
    for (const query of ["src/", "src\\", "ab/", "a\\", "ab//"]) {
      expect(omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")).toBeUndefined()
      const result = certify({ query, pageScores: [2_000], pageLimit: 1 })
      expect(result.omittedScoreUpperBound).toBeUndefined()
      expect(result.provenTopK).toBe(false)
    }
  })

  // 9. LENGTH SHAPE.
  test("token length outside the 2-8 shape is unprovable", () => {
    for (const query of ["a", "abcdefghi", "a".repeat(64), "a".repeat(200)]) {
      expect(omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")).toBeUndefined()
      expect(certify({ query, pageScores: [100_000], pageLimit: 1 }).provenTopK).toBe(false)
    }
    expect(omittedSingleTokenScoreUpperBound("abcdefgh", "path-substring+basename-subsequence")).toBe(337)
  })
})

describe("coverage precondition mirrors the scorer", () => {
  test("basename containment is reported for exactly the rows the broad source enumerates", () => {
    // Row the basename-subsequence source enumerates.
    expect(basenameContainsQuerySubsequence("ab", "src/ab.ts")).toBe(true)
    expect(basenameContainsQuerySubsequence("ab", "src/a-b.ts")).toBe(true)
    expect(basenameContainsQuerySubsequence("abc", "x/abc.ts")).toBe(true)
    // Everything's `name:` property is the FILE NAME, not the relative path, so
    // a query satisfied only by directory segments is NOT enumerated even
    // though the scorer matches it. The precondition must agree with the
    // provider's field or the omitted set is miscomputed.
    expect(basenameContainsQuerySubsequence("abc", "x/a/b/c.ts")).toBe(false)
    expect(basenameContainsQuerySubsequence("abc", "a/b/c.ts")).toBe(false)
    // Rows it does not: the basename lacks the subsequence even though the full
    // path matches through the directory portion.
    expect(basenameContainsQuerySubsequence("ab", "ab/x.ts")).toBe(false)
    expect(basenameContainsQuerySubsequence("abc", "aB/c.ts")).toBe(false)
    expect(basenameContainsQuerySubsequence("ab", "src/x.ts")).toBe(false)
  })

  test("the precondition lowercases like the scorer, so casing cannot hide a row", () => {
    // A mixed-case query must be compared against the lowercased path exactly
    // as searchFileMentionsFast does. Comparing raw "aA" against "aa" would
    // wrongly declare a high-scoring basename row uncovered.
    expect(basenameContainsQuerySubsequence("aA", "src/aA.ts")).toBe(true)
    expect(basenameContainsQuerySubsequence("aA", "src/aa.ts")).toBe(true)
    expect(basenameContainsQuerySubsequence("AB", "src/ab.ts")).toBe(true)
    expect(basenameContainsQuerySubsequence("aA", "src/x.ts")).toBe(false)
    // Whitespace-padded input trims exactly like the scorer's raw query.
    expect(basenameContainsQuerySubsequence("  ab  ", "src/ab.ts")).toBe(true)
  })

  test("basename boundaries handle separators, trailing separators and Windows roots", () => {
    expect(basenameContainsQuerySubsequence("ab", "C:\\repo\\src\\ab.ts")).toBe(true)
    expect(basenameContainsQuerySubsequence("ab", "C:\\ab\\x.ts")).toBe(false)
    expect(basenameContainsQuerySubsequence("x", "src/x")).toBe(true)
    expect(basenameContainsQuerySubsequence("x", "src/x/")).toBe(true)
    // No separator at all: the whole relative path is the basename.
    expect(basenameContainsQuerySubsequence("ab", "ab.ts")).toBe(true)
    expect(basenameContainsQuerySubsequence("zz", "ab.ts")).toBe(false)
  })

  test("every precondition-covered row is genuinely enumerated and every covered row is bounded", () => {
    // Cross-check the precondition against brute force over a small corpus so
    // the helper cannot silently drift from the scorer.
    const corpus: Matcher.PathEntry[] = [
      "src/ab.ts", "src/a-b.ts", "ab/x.ts", "aB/c.ts", "a/b/c.ts", "src/x.ts",
      "C:\\repo\\src\\ab.ts", "ab.ts", "src/ab", "x/y/ab/z.ts", "packages/core/src/ab.ts",
    ].map((p) => ({ path: p, isDir: false }))
    // Every token here must be inside the 2-8 shape, otherwise the bound is
    // undefined and there is nothing to partition against.
    for (const token of ["ab", "abc", "abg"]) {
      const ceiling = omittedSingleTokenScoreUpperBound(token, "path-substring+basename-subsequence")!
      for (const row of corpus) {
        const covered = basenameContainsQuerySubsequence(token, row.path)
        const score = searchFileMentionsFast([row], { query: token, limit: 1, offset: 0 }).results[0]?.score
        if (score === undefined) continue
        if (covered) {
          // A covered row is enumerated as a candidate, so it is in the corpus
          // and never needs the bound to cover it.
          expect(score).toBeGreaterThan(ceiling)
        } else {
          // An uncovered row is exactly the population the bound must cover.
          expect(score).toBeLessThanOrEqual(ceiling)
        }
      }
    }
  })

  test("camel-boundary equality case is covered by the precondition, not the bound", () => {
    // aB/x.ts: basename "x.ts" has no "ab" subsequence, so it is an omitted row
    // whose score equals the bound exactly. The strict comparison is what
    // keeps it UNPROVEN.
    expect(basenameContainsQuerySubsequence("ab", "aB/x.ts")).toBe(false)
    const score = searchFileMentionsFast([{ path: "aB/x.ts", isDir: false }], { query: "ab", limit: 1, offset: 0 }).results[0]!.score
    expect(score).toBe(omittedSingleTokenScoreUpperBound("ab", "path-substring+basename-subsequence"))
  })
})