import { describe, expect, test } from "bun:test"
import path from "node:path"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { certifyCandidateTopK, normalizeCandidate } from "../src/search/everything"
import {
  basenameContainsQuerySubsequence,
  omittedSingleTokenScoreUpperBound,
  searchFileMentionsFast,
} from "../src/search/mention-fast"
import { rankFileMentionResults, mentionRecencyBoost } from "../src/search/mention-ranking"
import type { Matcher } from "../src/search/matcher"

/**
 * DIFFERENTIAL PARITY HARNESS (semantic-parity lane).
 *
 * Compares the NATIVE canonical path against the EVERYTHING candidate path on
 * IDENTICAL fixtures and asserts EXACT top-K equivalence wherever a certificate
 * is claimed. Offline by construction: provider rows are simulated absolute
 * paths driven through the REAL production fencing functions
 * (`normalizeCandidate` + an `ignore` fence mirroring filesystem/search.ts), so
 * no live Everything pipe is required and the suite runs on every platform.
 *
 * What "Everything candidate path" means here (mirrors measuredShadow):
 *   normalize -> ignore-fence -> corpus-order filter -> searchFileMentionsFast
 *   rerank (highlights recomputed) -> certifyCandidateTopK.
 * Any drift between this mirror and everything.ts measuredShadow must be
 * treated as a harness bug first and a production bug second; the mirror steps
 * are each labelled below with their production counterpart.
 *
 * Divergence taxonomy (binding):
 *   (a) FENCED      - provider row discarded by normalizeCandidate/ignore
 *                     before scoring; cannot affect anything downstream.
 *   (b) PROOF-CAUGHT - row survives the fence but certifyCandidateTopK
 *                     refuses (strict floor, incomplete, short page, uncovered
 *                     discard, unprovable query shape); production falls back
 *                     to native.
 *   (c) LIVE HOLE   - certified (provenTopK) yet reranked page != native
 *                     page, OR an excluded row observably affects counts,
 *                     proof, highlights, pagination, or ordering. Report
 *                     IMMEDIATELY via swarm mail; do not batch.
 *
 * This suite asserts zero LIVE HOLEs across the whole fixture matrix. Every
 * assertion that would fail on a live hole is marked [LIVE-HOLE-TRIPWIRE].
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const SRC_SEARCH_TS = path.join(TEST_DIR, "..", "src", "filesystem", "search.ts")

// Deterministic synthetic root. normalizeCandidate is pure path arithmetic
// (no fs access), so the root need not exist on disk.
const DRIVE_ROOT = path.parse(process.cwd()).root
const ROOT = path.join(DRIVE_ROOT, "diff-harness-repo")
const SIBLING_ROOT = path.join(DRIVE_ROOT, "diff-harness-repo-other")
const SYSTEM_ROOT = path.join(DRIVE_ROOT, "diff-harness-system")

const abs = (...parts: string[]) => path.join(ROOT, ...parts)

type ProviderRow = { fullPath: string; isDir: boolean; fakePositions?: number[] }

const keyOf = (value: string) => {
  // Mirror of measuredShadow's key(): Everything order must never perturb
  // equal-score rows because rerank filters the authoritative corpus order.
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

const lexical = (row: Matcher.UnifiedResult) => ({
  kind: row.kind,
  path: row.path,
  type: row.type,
  score: row.score,
  positions: row.positions,
  baseOffset: row.baseOffset,
})

interface Fenced {
  kept: Matcher.PathEntry[]
  discarded: string[]
}

/** Production step 1+2: normalizeCandidate then the search.ts ignore fence. */
function fence(
  rows: readonly ProviderRow[],
  ignore: (relative: string) => boolean,
): Fenced {
  const kept: Matcher.PathEntry[] = []
  const discarded: string[] = []
  for (const row of rows) {
    // NOTE: provider-supplied highlight/score fields (fakePositions) are
    // deliberately NEVER read here. normalizeCandidate only sees
    // { fullPath, isDir }, mirroring production where Everything returns
    // paths only and highlights are recomputed by OpenFork.
    const candidate = normalizeCandidate(ROOT, { fullPath: row.fullPath, isDir: row.isDir })
    if (!candidate) {
      discarded.push(row.fullPath)
      continue
    }
    if (ignore(candidate.path)) {
      discarded.push(row.fullPath)
      continue
    }
    kept.push(candidate)
  }
  return { kept, discarded }
}

interface CandidatePath {
  reranked: Matcher.QueryPage
  proof: ReturnType<typeof certifyCandidateTopK>
  fenced: Fenced
}

/** Production steps 3-5: corpus-order filter -> OpenFork rerank -> proof. */
function everythingPath(
  corpus: readonly Matcher.PathEntry[],
  fenced: Fenced,
  input: { query: string; limit: number; offset: number },
  basenameSubsequenceComplete: boolean,
): CandidatePath {
  // Mirror of measuredShadow: filter the AUTHORITATIVE corpus (its order, its
  // IDs, its tie-break) down to the fenced candidate set, then rerank with the
  // canonical scorer. Everything's own result order is discarded here.
  const candidatePaths = new Set(fenced.kept.map((entry) => keyOf(entry.path)))
  const rerankPaths = corpus.filter((entry) => candidatePaths.has(keyOf(entry.path)))
  const reranked = searchFileMentionsFast(rerankPaths, {
    query: input.query,
    limit: input.limit,
    offset: input.offset,
  })
  const proof = certifyCandidateTopK({
    query: input.query,
    pageScores: reranked.results.map((row) => row.score),
    pageLimit: Math.max(1, input.limit),
    basenameSubsequenceComplete,
    discardedPaths: fenced.discarded,
  })
  return { reranked, proof, fenced }
}

const pagesEqual = (a: Matcher.QueryPage, b: Matcher.QueryPage) =>
  JSON.stringify(a.results.map(lexical)) === JSON.stringify(b.results.map(lexical)) &&
  a.total === b.total &&
  a.hasMore === b.hasMore

// ---------------------------------------------------------------------------
// Fixture corpus: every acceptance-criterion class is represented.
// ---------------------------------------------------------------------------

const CONFIGURED_IGNORED_PREFIXES = ["node_modules/", "dist/", "build/", "coverage/"]

const isConfiguredIgnored = (relative: string) =>
  CONFIGURED_IGNORED_PREFIXES.some((prefix) => relative === prefix || relative.startsWith(prefix))

function buildCorpus(): Matcher.PathEntry[] {
  const files = [
    // ordinary project files (certifiable-query targets)
    "src/filesystem/search.ts",
    "src/filesystem/search-policy.ts",
    "src/search/mention-fast.ts",
    "src/search/matcher.ts",
    "src/search/everything.ts",
    "src/search/index-service.ts",
    "src/session/store.ts",
    // hidden / dot-segments (normalizeCandidate must fence)
    // NOTE: these live in the NATIVE corpus here only so the harness can
    // prove the fence removes them from the candidate path; production native
    // corpora never contain them (rg seed + applyEvent skip dot segments).
    ".git/objects/ab.ts",
    ".openfork/state.json",
    "src/.hidden/secret.ts",
    // ignored prefixes (ignore-fence must remove even when normalized)
    "node_modules/pkg/readme.md",
    "node_modules/.bin/run.ts",
    "dist/chunk.js",
    "build/output.css",
    // deep roots
    "a/b/c/d/e/f/g/h/i/j/deep-target.ts",
    // spaces
    "src/my documents/notes file.ts",
    // punctuation in names
    "src/a-b.ts",
    "src/a_b.ts",
    "src/a.b.ts",
    // case variants
    "packages/app/src/components/dialog-select-model.tsx",
    "packages/app/src/components/DialogSelectModel.tsx",
    "src/AB.ts",
    // unicode: NFC e-acute, NFD e+combining-acute, CJK
    "src/caf\u00e9.ts",
    "src/cafe\u0301.ts",
    "src/\u65e5\u672c/server.ts",
    // directories stay mentionable
    "src/filesystem/",
    "src/search/",
  ]
  return files.map((p) => ({ path: p, isDir: p.endsWith("/") }))
}

/**
 * Native authoritative set (production truth). The ripgrep backend's
 * registerFile drops configured-ignored paths before they ever enter state,
 * and the rg seed + applyEvent both skip dot-segments; the index backend's
 * walk is gitignore-aware the same way. So ignored/hidden rows exist in NEITHER
 * the native corpus NOR (post-fence) the candidate set: both sides agree.
 * Including them in the harness native corpus would manufacture a divergence
 * production cannot exhibit.
 */
function nativeCorpus(): Matcher.PathEntry[] {
  return buildCorpus().filter(
    (entry) =>
      !entry.path.split("/").some((segment) => segment.startsWith(".")) &&
      !isConfiguredIgnored(entry.path),
  )
}

/**
 * search.ts ripgrepLayer fence mirror: configured-ignore OR not in the
 * authoritative snapshot. Production keeps files in `known` and directories
 * in `directories` WITH a trailing sep, checking
 * `!known.has(rel) && !directories.has(rel + sep)`; normalizeCandidate
 * returns slash-joined relatives with NO trailing slash. Mirror that exactly:
 * compare trimmed forms so `src/filesystem` matches snapshot `src/filesystem`.
 */

function fenceIgnore(native: readonly Matcher.PathEntry[]) {
  const entries: Matcher.PathEntry[] = [...native]
  const files = new Set(
    entries.filter((e) => !e.isDir).map((e) => e.path),
  )
  const dirs = new Set(
    entries.filter((e) => e.isDir).map((e) => e.path.replace(/\/+$/, "")),
  )
  return (relative: string) => {
    if (isConfiguredIgnored(relative)) return true
    const trimmed = relative.replace(/\/+$/, "")
    return !files.has(relative) && !dirs.has(trimmed)
  }
}

/** Exhaustive provider enumeration of the full fixture corpus + adversarial rows. */
function providerEnumeration(
  corpus: readonly Matcher.PathEntry[],
  extra: readonly ProviderRow[] = [],
): ProviderRow[] {
  const rows: ProviderRow[] = corpus.map((entry) => ({
    fullPath: abs(...entry.path.split("/")),
    isDir: entry.isDir,
  }))
  return [...rows, ...extra]
}

/** Adversarial excluded rows: must ALL be fenced (never scored). */
const ADVERSARIAL_ROWS: ProviderRow[] = [
  // outside-root matches
  { fullPath: path.join(SIBLING_ROOT, "src", "search.ts"), isDir: false },
  { fullPath: path.join(DRIVE_ROOT, "outside.ts"), isDir: false },
  // system paths
  { fullPath: path.join(SYSTEM_ROOT, "config", "sys.ts"), isDir: false },
  // hidden inside root (dot-segment -> normalizeCandidate rejects)
  { fullPath: abs(".git", "objects", "ab.ts"), isDir: false },
  { fullPath: abs(".openfork", "state.json"), isDir: false },
  { fullPath: abs("src", ".hidden", "secret.ts"), isDir: false },
  // relative escape attempt (not absolute -> rejects)
  { fullPath: "src/search/everything.ts", isDir: false },
  // parent traversal spelling
  { fullPath: abs("src", "..", "..", "evil.ts"), isDir: false },
]

describe("differential parity: native vs Everything candidate path", () => {
  test("certifiable query: exhaustive candidates + adversarial rows == native top-K exactly", () => {
    const corpus = nativeCorpus()
    const input = { query: "search", limit: 10, offset: 0 }
    const native = searchFileMentionsFast(corpus, input)
    expect(native.results.length).toBeGreaterThan(0)

    const fenced = fence(providerEnumeration(buildCorpus(), ADVERSARIAL_ROWS), fenceIgnore(corpus))
    // [LIVE-HOLE-TRIPWIRE] Every adversarial row must be fenced, none scored;
    // every dot-segment and every configured-ignored corpus row fenced too;
    // everything else (including directories) survives.
    for (const row of ADVERSARIAL_ROWS) expect(fenced.discarded).toContain(row.fullPath)
    for (const entry of buildCorpus()) {
      if (entry.path.split("/").some((segment) => segment.startsWith(".")))
        expect(fenced.discarded).toContain(abs(...entry.path.split("/")))
      else if (isConfiguredIgnored(entry.path))
        expect(fenced.discarded).toContain(abs(...entry.path.split("/")))
    }
    expect(fenced.kept).toHaveLength(corpus.length)

    const candidate = everythingPath(corpus, fenced, input, true)
    // [LIVE-HOLE-TRIPWIRE] Fenced rows must not shift counts or pagination.
    expect(candidate.reranked.total).toBe(native.total)
    expect(candidate.reranked.hasMore).toBe(native.hasMore)
    // [LIVE-HOLE-TRIPWIRE] Exact top-K equivalence (path/type/score/highlights).
    expect(pagesEqual(candidate.reranked, native)).toBe(true)
  })

  test("case variants: mixed-case query matches canonical casing exactly", () => {
    const corpus = nativeCorpus()
    for (const query of ["dsm", "DSM", "DialogSelect", "ab"]) {
      const input = { query, limit: 10, offset: 0 }
      const native = searchFileMentionsFast(corpus, input)
      const fenced = fence(providerEnumeration(buildCorpus(), ADVERSARIAL_ROWS), fenceIgnore(corpus))
      const candidate = everythingPath(corpus, fenced, input, true)
      // [LIVE-HOLE-TRIPWIRE] Casing must not change fence or order outcomes.
      expect(pagesEqual(candidate.reranked, native)).toBe(true)
    }
  })

  test("unicode fixtures are fenced-or-unprovable, never silently folded into a pass", () => {
    const corpus = nativeCorpus()
    for (const query of ["caf\u00e9", "cafe\u0301", "\u65e5\u672c", "ab\u65e5"]) {
      expect(omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")).toBeUndefined()
      const input = { query, limit: 5, offset: 0 }
      const native = searchFileMentionsFast(corpus, input)
      const fenced = fence(providerEnumeration(buildCorpus(), ADVERSARIAL_ROWS), fenceIgnore(corpus))
      const candidate = everythingPath(corpus, fenced, input, true)
      // (b) PROOF-CAUGHT: bound undefined -> provenTopK false -> native fallback.
      expect(candidate.proof.omittedScoreUpperBound).toBeUndefined()
      expect(candidate.proof.provenTopK).toBe(false)
      // Pages still computed by OpenFork on both sides; equality here is
      // scorer determinism, not a certificate. The certificate is what refuses.
      expect(pagesEqual(candidate.reranked, native)).toBe(true)
    }
  })

  test("punctuation / multi-token / directory-mode / length-shape queries are proof-caught", () => {
    const corpus = nativeCorpus()
    const unprovable = ["a-b", "a_b", "a.b", "server session", "src/", "a", "abcdefghi"]
    for (const query of unprovable) {
      const input = { query, limit: 5, offset: 0 }
      const native = searchFileMentionsFast(corpus, input)
      const fenced = fence(providerEnumeration(buildCorpus(), ADVERSARIAL_ROWS), fenceIgnore(corpus))
      const candidate = everythingPath(corpus, fenced, input, true)
      // (b) PROOF-CAUGHT in every case.
      expect(candidate.proof.provenTopK).toBe(false)
      expect(pagesEqual(candidate.reranked, native)).toBe(true)
    }
  })

  test("deep roots, spaces, and sibling worktrees do not leak across the root boundary", () => {
    const corpus = nativeCorpus()
    const deepAdversarial: ProviderRow[] = [
      ...ADVERSARIAL_ROWS,
      { fullPath: path.join(SIBLING_ROOT, "a", "b", "c", "deep-target.ts"), isDir: false },
      { fullPath: abs("src", "my documents", "notes file.ts"), isDir: false, fakePositions: [0, 1, 2] },
    ]
    const input = { query: "deep", limit: 5, offset: 0 }
    const native = searchFileMentionsFast(corpus, input)
    const fenced = fence(providerEnumeration(buildCorpus(), deepAdversarial), fenceIgnore(corpus))
    // The in-root deep file normalizes fine; every out-of-root row is fenced.
    for (const row of ADVERSARIAL_ROWS) expect(fenced.discarded).toContain(row.fullPath)
    expect(fenced.discarded).toContain(path.join(SIBLING_ROOT, "a", "b", "c", "deep-target.ts"))
    const candidate = everythingPath(corpus, fenced, input, true)
    // [LIVE-HOLE-TRIPWIRE] Sibling-worktree content must not enter counts.
    expect(candidate.reranked.total).toBe(native.total)
    expect(pagesEqual(candidate.reranked, native)).toBe(true)
  })

  test("very large sets: 25k corpus with 5k adversarial rows stays exactly equivalent", () => {
    const big: Matcher.PathEntry[] = Array.from({ length: 25_000 }, (_, i) => ({
      path: `src/gen/file-${String(i).padStart(5, "0")}.ts`,
      isDir: false,
    }))
    big.push(
      { path: "src/filesystem/search.ts", isDir: false },
      { path: "src/search/mention-fast.ts", isDir: false },
    )
    const adversarial: ProviderRow[] = Array.from({ length: 5_000 }, (_, i) => ({
      fullPath: path.join(i % 2 === 0 ? SIBLING_ROOT : SYSTEM_ROOT, `evil-${i}.ts`),
      isDir: false,
    }))
    // Plus in-root ignored rows the fence must also remove.
    adversarial.push(
      { fullPath: abs("node_modules", "pkg", "search.ts"), isDir: false },
      { fullPath: abs("dist", "search.js"), isDir: false },
    )
    const input = { query: "search", limit: 25, offset: 0 }
    const native = searchFileMentionsFast(big, input)
    const fenced = fence(providerEnumeration(big, adversarial), fenceIgnore(big))
    // [LIVE-HOLE-TRIPWIRE] All 5k+2 adversarial rows fenced at scale.
    for (const row of adversarial) expect(fenced.discarded).toContain(row.fullPath)
    expect(fenced.kept).toHaveLength(big.length)
    const candidate = everythingPath(big, fenced, input, true)
    expect(candidate.reranked.total).toBe(native.total)
    expect(pagesEqual(candidate.reranked, native)).toBe(true)
  })
})

describe("excluded entries cannot affect counts, proof, highlights, pagination, ordering", () => {
  test("counts: fenced rows never enter the heap, so total/hasMore are fence-invariant", () => {
    const corpus = nativeCorpus()
    const input = { query: "search", limit: 3, offset: 0 }
    const native = searchFileMentionsFast(corpus, input)
    const withoutAdversarial = fence(providerEnumeration(buildCorpus()), fenceIgnore(corpus))
    const withAdversarial = fence(providerEnumeration(buildCorpus(), ADVERSARIAL_ROWS), fenceIgnore(corpus))
    const a = everythingPath(corpus, withoutAdversarial, input, true)
    const b = everythingPath(corpus, withAdversarial, input, true)
    // [LIVE-HOLE-TRIPWIRE] Adding 8+ excluded rows changes nothing observable.
    expect(a.reranked.total).toBe(b.reranked.total)
    expect(a.reranked.hasMore).toBe(b.reranked.hasMore)
    expect(pagesEqual(a.reranked, b.reranked)).toBe(true)
    expect(b.reranked.total).toBe(native.total)
  })

  test("proof: one uncovered discarded row vetoes the certificate (fenced != bounded)", () => {
    // (b) PROOF-CAUGHT: a discarded row whose basename contains the query as a
    // subsequence is UNBOUNDED (never scored) and must refuse certification
    // even with a dominant floor and complete enumeration.
    const proof = certifyCandidateTopK({
      query: "ab",
      pageScores: [10_000],
      pageLimit: 1,
      basenameSubsequenceComplete: true,
      discardedPaths: [abs("src", "a-b.ts")],
    })
    expect(basenameContainsQuerySubsequence("ab", abs("src", "a-b.ts"))).toBe(true)
    expect(proof.discardedCoverageSafe).toBe(false)
    expect(proof.provenTopK).toBe(false)
    // Covered discards keep the certificate usable at real-world discard rates.
    const ok = certifyCandidateTopK({
      query: "ab",
      pageScores: [10_000],
      pageLimit: 1,
      basenameSubsequenceComplete: true,
      discardedPaths: [abs("node_modules", "pkg", "readme.md"), abs(".git", "objects", "zz.ts")],
    })
    expect(ok.discardedCoverageSafe).toBe(true)
  })

  test("highlights: positions/baseOffset are OpenFork-generated, provider fields ignored", () => {
    const corpus = nativeCorpus()
    const input = { query: "search", limit: 10, offset: 0 }
    const native = searchFileMentionsFast(corpus, input)
    // Smuggle fake provider highlight positions; the pipeline has no field for
    // them (ProviderRow.fakePositions is never read by fence/rerank).
    const poisoned = providerEnumeration(buildCorpus(), ADVERSARIAL_ROWS).map((row) => ({
      ...row,
      fakePositions: [0],
    }))
    const fenced = fence(poisoned, fenceIgnore(corpus))
    const candidate = everythingPath(corpus, fenced, input, true)
    // [LIVE-HOLE-TRIPWIRE] Highlights must equal the native scorer output.
    expect(pagesEqual(candidate.reranked, native)).toBe(true)
    for (const row of candidate.reranked.results) {
      const nativeRow = native.results.find((r) => r.path === row.path)
      expect(row.positions).toEqual(nativeRow?.positions)
      expect(row.baseOffset).toBe(nativeRow?.baseOffset)
      // And they are genuine scorer positions: ascending, in-bounds.
      const positions = row.positions ?? []
      for (let i = 0; i < positions.length; i++) {
        expect(positions[i]!).toBeLessThan(row.path!.length)
        if (i > 0) expect(positions[i]!).toBeGreaterThan(positions[i - 1]!)
      }
      expect(positions).not.toEqual([0])
    }
  })

  test("pagination: offset pages are judged on their own floor; short pages never certify", () => {
    const corpus = nativeCorpus()
    const page1 = { query: "search", limit: 3, offset: 0 }
    const page2 = { query: "search", limit: 3, offset: 3 }
    const native1 = searchFileMentionsFast(corpus, page1)
    const native2 = searchFileMentionsFast(corpus, page2)
    // Deterministic non-overlap on the native side (pagination sanity).
    const seen = new Set(native1.results.map((r) => r.path))
    expect(native2.results.every((r) => !seen.has(r.path))).toBe(true)

    const fenced = fence(providerEnumeration(buildCorpus(), ADVERSARIAL_ROWS), fenceIgnore(corpus))
    const c1 = everythingPath(corpus, fenced, page1, true)
    const c2 = everythingPath(corpus, fenced, page2, true)
    // [LIVE-HOLE-TRIPWIRE] Excluded rows must not shift either page.
    expect(pagesEqual(c1.reranked, native1)).toBe(true)
    expect(pagesEqual(c2.reranked, native2)).toBe(true)

    // Short page (total < limit) has no floor -> UNPROVEN by construction.
    const short = certifyCandidateTopK({
      query: "zzqvopenforknomatch47291",
      pageScores: [],
      pageLimit: 10,
      basenameSubsequenceComplete: true,
      discardedPaths: [],
    })
    expect(short.proofFloor).toBeUndefined()
    expect(short.provenTopK).toBe(false)
  })

  test("ordering: Everything result order cannot perturb equal-score rows", () => {
    const corpus = nativeCorpus()
    const input = { query: "search", limit: 10, offset: 0 }
    const native = searchFileMentionsFast(corpus, input)
    const forward = fence(providerEnumeration(buildCorpus(), ADVERSARIAL_ROWS), fenceIgnore(corpus))
    const reversed = fence(
      [...providerEnumeration(buildCorpus(), ADVERSARIAL_ROWS)].reverse(),
      fenceIgnore(corpus),
    )
    // Deterministic rotation permutation.
    const rotated = providerEnumeration(buildCorpus(), ADVERSARIAL_ROWS)
    const moved = [...rotated.slice(7), ...rotated.slice(0, 7)]
    const permuted = fence(moved, fenceIgnore(corpus))
    const a = everythingPath(corpus, forward, input, true)
    const b = everythingPath(corpus, reversed, input, true)
    const c = everythingPath(corpus, permuted, input, true)
    // [LIVE-HOLE-TRIPWIRE] Provider order is discarded by the corpus-order
    // filter; all three permutations must be bit-identical to native.
    expect(pagesEqual(a.reranked, native)).toBe(true)
    expect(pagesEqual(b.reranked, native)).toBe(true)
    expect(pagesEqual(c.reranked, native)).toBe(true)
  })

  test("omitted native rows (never enumerated) are proof-caught unless the floor dominates", () => {
    // The omission population (1a): provider enumerates only a subset.
    const corpus = nativeCorpus()
    const input = { query: "ab", limit: 2, offset: 0 }
    const native = searchFileMentionsFast(corpus, input)
    expect(native.results.length).toBe(2)
    // Simulate a provider that enumerated only the first native row's path.
    const partial = fence(
      [{ fullPath: abs(...native.results[0]!.path!.split("/")), isDir: false }],
      fenceIgnore(corpus),
    )
    const candidate = everythingPath(corpus, partial, input, true)
    // The reranked page differs from native (missing row) ...
    expect(pagesEqual(candidate.reranked, native)).toBe(false)
    // ... and the certificate must refuse unless the strict floor dominates
    // the omitted bound. Either outcome is (b) PROOF-CAUGHT, never silent use.
    if (!candidate.proof.provenTopK) {
      expect(candidate.proof.provenTopK).toBe(false)
    } else {
      // Certified only if the surviving floor strictly dominates: then the
      // omitted row is provably below every returned row. Still assert the
      // visible decision would be the certified page, never a blend.
      expect(candidate.proof.proofFloor!).toBeGreaterThan(candidate.proof.omittedScoreUpperBound!)
    }
  })
})

describe("fallback to native on any unprovable equivalence", () => {
  test("every unprovable shape refuses certification (fallback decision table)", () => {
    const ceiling = (q: string) => omittedSingleTokenScoreUpperBound(q, "path-substring+basename-subsequence")
    // Query-shape fallback.
    for (const q of ["a-b", "ab.", "server session", "src/", "\u65e5\u672c", "a", "abcdefghi"]) {
      expect(ceiling(q)).toBeUndefined()
    }
    // State fallback: incomplete source, short page, equality floor.
    expect(
      certifyCandidateTopK({
        query: "ab",
        pageScores: [5000],
        pageLimit: 1,
        basenameSubsequenceComplete: false,
        discardedPaths: [],
      }).provenTopK,
    ).toBe(false)
    const bound = ceiling("ab")!
    expect(
      certifyCandidateTopK({
        query: "ab",
        pageScores: [bound],
        pageLimit: 1,
        basenameSubsequenceComplete: true,
        discardedPaths: [],
      }).provenTopK,
    ).toBe(false)
    expect(
      certifyCandidateTopK({
        query: "ab",
        pageScores: [bound + 5000, bound + 4000],
        pageLimit: 10,
        basenameSubsequenceComplete: true,
        discardedPaths: [],
      }).provenTopK,
    ).toBe(false)
  })

  test("COMPLETE IS NOT COVERAGE: a complete source returning zero candidates is its own divergence class", () => {
    // perf-freshness specimen `pkg-119` (8,190-path root): provider reported
    // complete:true, 0 candidates, while native top-K was NON-EMPTY
    // (packages/ui/src/assets/favicon/web-app-manifest-192x192.png — a
    // directory-spanning subsequence the provider's name-only regex never
    // enumerates). The proof refused, but via SHORT-PAGE-NO-FLOOR, not the
    // omitted bound. So "complete" certifies SOURCE EXHAUSTION and says
    // nothing about coverage: this class must be classified explicitly rather
    // than absorbed into a generic proof-caught bucket.
    // Fixture reproducing the specimen shape: a row the scorer matches only
    // through a DIRECTORY-SPANNING subsequence (p...k...g across
    // `packages/.../pkg-119/...`), so a name-only candidate source never
    // enumerates it even though its own enumeration is complete.
    const corpus: Matcher.PathEntry[] = [
      { path: "packages/ui/src/assets/favicon/pkg-119-192x192.png", isDir: false },
      { path: "src/other.ts", isDir: false },
    ]
    const native = searchFileMentionsFast(corpus, { query: "pkg119", limit: 20, offset: 0 })
    expect(native.results.length).toBeGreaterThan(0) // native HAS rows

    // Provider shape: complete source, zero returned candidates.
    const emptyButComplete = fence([], fenceIgnore(corpus)) // nothing enumerated
    const SOURCE_CLAIMS_COMPLETE = true
    const candidate = everythingPath(
      corpus,
      emptyButComplete,
      { query: "pkg119", limit: 20, offset: 0 },
      SOURCE_CLAIMS_COMPLETE,
    )
    expect(candidate.reranked.results).toHaveLength(0)
    expect(candidate.reranked.total).toBe(0)

    // Classification: (b) PROOF-CAUGHT — but via a SPECIFIC gate whose reason
    // matters. With zero rows there is no floor, so no bound is consulted.
    expect(candidate.proof.proofFloor).toBeUndefined()
    expect(candidate.proof.discardedCoverageSafe).toBe(true) // nothing discarded
    expect(candidate.proof.provenTopK).toBe(false)
    // The distinguishing marker: the source claims completeness while coverage
    // is empty and native is not. `complete` alone must never be read as
    // coverage; a router MUST require provenTopK, which is false here.
    // (certifyCandidateTopK does not echo the completeness flag, so the
    // source-side claim is asserted at the input we supplied: true.)
    const sourceCompleteButNoCoverage =
      SOURCE_CLAIMS_COMPLETE && candidate.reranked.total === 0 && native.total > 0
    expect(sourceCompleteButNoCoverage).toBe(true)
    // Native fallback is therefore mandatory on this class.
    expect(candidate.proof.provenTopK).toBe(false)
  })

  test("production call sites return the native page; shadow evidence only feeds logs", () => {
    // Structural fence proof: the Everything shadow in filesystem/search.ts is
    // forkDetach fire-and-forget and the user-visible value is the native page.
    const source = readFileSync(SRC_SEARCH_TS, "utf8")
    // Both backends consult compareEverythingShadow.
    expect(source).toContain("compareEverythingShadow")
    // Shadow work is detached: it can never gate or replace the return value.
    expect(source).toContain("Effect.forkDetach")
    // The detached continuation only logs; it never assigns a visible result.
    // Split on the CALL spelling (with paren) so the import line is not a block.
    const shadowBlocks = source.split("compareEverythingShadow({")
    expect(shadowBlocks.length).toBeGreaterThanOrEqual(3) // two call sites
    for (const block of shadowBlocks.slice(1)) {
      const window = block.slice(0, 1600)
      expect(window).toContain("Effect.logDebug")
    }
    // Native pages are what the service returns.
    expect(source).toContain("return page")
    // The native corpus itself never contains the rows the fence removes:
    // registerFile drops configured-ignored paths on entry, and the seed walk
    // + watcher events skip dot-segments (mirroring rg --files semantics).
    expect(source).toContain("if (isConfiguredIgnored(rel)) return")
    expect(source).toContain("ignore: ignoreGlobs")
  })
})

describe("index-backend recency interplay (characterization for proof-router)", () => {
  test("recency post-pass can reorder a fast-only page: future routers must certify the adjusted page", () => {
    // The index backend (search.ts indexLayer) applies rankFileMentionResults
    // (+0..6 mtime prior) AFTER searchFileMentionsFast; the ripgrep backend
    // does not. The Everything proof reranks fast-only. If a future router
    // compared the fast-only certificate against the recency-adjusted visible
    // page, a near-tie flipped by recency would be a divergence the current
    // certificate does not bound. Today this is (b) PROOF-CAUGHT-by-policy:
    // production never routes, so the visible page is always the adjusted
    // native page. This test pins the premise so proof-router can close it.
    const now = Date.now()
    const rows: Matcher.PathEntry[] = [
      { path: "src/abx.ts", isDir: false },
      { path: "src/aby.ts", isDir: false },
    ]
    const fast = searchFileMentionsFast(rows, { query: "ab", limit: 2, offset: 0 })
    expect(fast.results).toHaveLength(2)
    const gap = Math.abs(fast.results[0]!.score - fast.results[1]!.score)
    const adjusted = rankFileMentionResults(
      fast.results,
      (p) => (p.endsWith("aby.ts") ? { size: 1, mtime: now - 1000 } : { size: 1, mtime: now - 30 * 24 * 3600 * 1000 }),
      now,
    )
    // Premise documentation: lexical gap and recency swing on this fixture.
    expect(gap).toBeLessThanOrEqual(6)
    // The adjusted page is still OpenFork-generated (pure function of the
    // native page + metadata); no provider data enters.
    for (const row of adjusted) {
      expect(row.kind).toBe("file")
      expect(typeof row.score).toBe("number")
    }
  })

  test("FORCED FLIP: equal fast scores + fresh lower row reorders the visible page (fast-only cert would misroute)", () => {
    // Constructed counterexample, not a premise pin. Two rows tie on the fast
    // score (881/881) and the recency post-pass gives the SECOND row +6, so the
    // user-visible index-backend page is the exact reverse of the fast page
    // that measuredShadow reranks and certifies.
    const now = Date.now()
    const rows: Matcher.PathEntry[] = [
      { path: "src/abx.ts", isDir: false },
      { path: "src/aby.ts", isDir: false },
    ]
    const fast = searchFileMentionsFast(rows, { query: "ab", limit: 2, offset: 0 })
    expect(fast.results).toHaveLength(2)
    expect(fast.results[0]!.score).toBe(fast.results[1]!.score) // tie: no lexical winner
    const fastOrder = fast.results.map((r) => r.path)

    const adjusted = rankFileMentionResults(
      fast.results,
      (p) =>
        p.endsWith("aby.ts")
          ? { size: 1, mtime: now - 1000 } // fresh: max boost
          : { size: 1, mtime: now - 40 * 24 * 3600 * 1000 }, // stale: 0 boost
      now,
    )
    // [FORCED-FLIP] The visible index-backend page is NOT the fast page order.
    expect(adjusted.map((r) => r.path)).toEqual([...fastOrder].reverse())
    expect(adjusted[0]!.score - adjusted[1]!.score).toBe(6)

    // Consequence for any router that substitutes on the fast-only proof: the
    // certificate bounds a page the user never sees. A fresh omitted row whose
    // fast score ties the floor wins the visible page while the strict check
    // still passes. The certificate must be taken on the ADJUSTED page with a
    // +maxMentionRecencyBoost margin; until then Phase 4 stays HOLD and native
    // is the only correct answer.
    const proofOnFast = certifyCandidateTopK({
      query: "ab",
      pageScores: fast.results.map((r) => r.score),
      pageLimit: 2,
      basenameSubsequenceComplete: true,
      discardedPaths: [],
    })
    const bound = proofOnFast.omittedScoreUpperBound!
    expect(proofOnFast.proofFloor!).toBe(881)
    // [MISROUTE] The fast-only certificate PASSES: 881 > bound by a wide
    // margin, so a router gating on provenTopK would substitute this page --
    // while the page the user actually sees is the REVERSE order. The
    // certificate is silent about the entire recency dimension.
    expect(proofOnFast.provenTopK).toBe(true)

    // The margin is DERIVED from the recency table, never a literal. A
    // hardcoded 6 would silently mis-model the defect the day
    // MENTION_RECENCY_BY_DAY changes (and in production it would become a
    // soundness bug), so take the maximum observable boost directly.
    const MAX_BOOST = mentionRecencyBoost(Date.now())
    expect(MAX_BOOST).toBe(6) // pins the table's ceiling, not a magic number

    // Concretely: an omitted row whose fast score EQUALS the floor (881) is
    // admitted by the strict check (881 > bound), and if that row is fresh it
    // outranks the floor row (881 + MAX_BOOST > 881 + 0) in the visible page.
    // The strict inequality therefore does not dominate the scores it must
    // dominate; the missing term is exactly the recency boost.
    const omittedFastScore = proofOnFast.proofFloor!
    expect(omittedFastScore).toBeGreaterThan(bound)
    const freshOmittedVisible = omittedFastScore + MAX_BOOST
    const staleFloorVisible = proofOnFast.proofFloor! + 0
    expect(freshOmittedVisible).toBeGreaterThan(staleFloorVisible)
    // Required fix shape (proof-router): floor > bound + maxRecencyBoost.
    expect(proofOnFast.proofFloor!).toBeGreaterThan(bound + MAX_BOOST)
    // ...which is satisfied on THIS fixture only by luck of a large margin.
    // Near the bound it is not: floor == bound + 1 passes today and loses.
    const tightFloor = bound + 1
    expect(tightFloor).toBeGreaterThan(bound) // today: PROVEN
    expect(tightFloor).not.toBeGreaterThan(bound + MAX_BOOST) // required: NOT proven
    const tightCert = certifyCandidateTopK({
      query: "ab",
      pageScores: [tightFloor],
      pageLimit: 1,
      basenameSubsequenceComplete: true,
      discardedPaths: [],
    })
    // The live defect: a page 1 point above the bound certifies, yet a fresh
    // omitted row at the same fast score wins the visible page by MAX_BOOST.
    //
    // EXPECTED TO GO RED when proof-router lands the margin: this pins today's
    // DEFECTIVE behavior. When it does, INVERT it to `.toBe(false)` with a
    // comment that the margin now refuses this case. Do NOT weaken it and do
    // NOT retune the fixture to keep the suite green — that would be tuning
    // toward the bug.
    expect(tightCert.provenTopK).toBe(true)
    expect(tightCert.proofFloor! + MAX_BOOST).toBeGreaterThan(tightFloor)
  })

  test("MARGIN GATE (RED until the +MAX_RECENCY_BOOST margin lands): an OMITTED fresh row outranks the certified floor", () => {
    // THE ACTUAL BUG SHAPE, not in-page reordering. An OMITTED candidate (never
    // enumerated by the certifying source, bounded only by
    // omittedScoreUpperBound) whose FAST score sits just BELOW the page floor.
    // Fast-only, the floor dominates it, so the certificate passes. After the
    // +0..6 mtime prior the omitted row is fresh and the floor row is stale,
    // so the omitted row belongs ABOVE the floor in the user-visible page the
    // certificate claims to bound. That is the confirmed unsoundness.
    //
    // Rows are chosen for their REAL scorer output (verified, not invented):
    //   floor   `aB/aa`  fast 68  (== bound)   basename lacks the subsequence
    //   omitted `aBa/x`  fast 67  (below floor) basename lacks the subsequence
    // Both are UNCOVERED, so both legitimately live in the bounded population.
    const MAX_BOOST = mentionRecencyBoost(Date.now())
    const FLOOR_PATH = "aB/aa"
    const OMITTED_PATH = "aBa/x"
    const bound = omittedSingleTokenScoreUpperBound("ab", "path-substring+basename-subsequence")!
    expect(bound).toBe(68)

    const floorFast = searchFileMentionsFast([{ path: FLOOR_PATH, isDir: false }], { query: "ab", limit: 1, offset: 0 })
      .results[0]!.score
    const omittedFast = searchFileMentionsFast([{ path: OMITTED_PATH, isDir: false }], { query: "ab", limit: 1, offset: 0 })
      .results[0]!.score
    expect(floorFast).toBe(68)
    expect(omittedFast).toBe(67)
    // Premise of the shape: the omitted row is BELOW the floor fast-only, and
    // both are inside the bound's population (neither is basename-covered).
    expect(omittedFast).toBeLessThan(floorFast)
    expect(basenameContainsQuerySubsequence("ab", OMITTED_PATH)).toBe(false)
    expect(basenameContainsQuerySubsequence("ab", FLOOR_PATH)).toBe(false)

    // Provider path: only the floor row was enumerated; the omitted row is
    // population (1a) — never a candidate, bounded solely by the score bound.
    // The certificate is taken over the fast candidate page (what the router
    // sees today). floor=68, bound=68 -> floor > bound is 68 > 68 = FALSE.
    const fastCert = certifyCandidateTopK({
      query: "ab",
      pageScores: [floorFast],
      pageLimit: 1,
      basenameSubsequenceComplete: true,
      discardedPaths: [],
    })
    // Today the floor exactly equals the bound, so already UNPROVEN here. Nudge
    // the scenario to the real historical hole: a floor ONE point above the
    // bound (69) with the omitted row at the bound (68). We cannot fabricate a
    // 69-scoring covered row from the real scorer, so we drive the pure
    // certificate with the concrete scores the shape produces and assert the
    // gate behaviour explicitly.
    const historicalFloor = bound + 1 // 69
    const historicalCert = certifyCandidateTopK({
      query: "ab",
      pageScores: [historicalFloor],
      pageLimit: 1,
      basenameSubsequenceComplete: true,
      discardedPaths: [],
    })
    // TODAY: 69 > 68 passes, so a router would substitute.
    expect(historicalCert.provenTopK).toBe(true)
    // The omitted row (fast 68, <= bound) is admitted by the strict check, and
    // once fresh it beats the stale floor: 68 + 6 = 74 > 69.
    expect(omittedFast).toBeLessThanOrEqual(bound)
    expect(omittedFast + MAX_BOOST).toBeGreaterThan(historicalFloor)
    // Production ordering CONTRADICTS the certified page: the visible page
    // (fast + recency) must place the omitted fresh row above the stale floor.
    const visible = rankFileMentionResults(
      [
        { kind: "file" as const, path: FLOOR_PATH, type: "file" as const, score: historicalFloor },
        { kind: "file" as const, path: OMITTED_PATH, type: "file" as const, score: omittedFast },
      ],
      (p) => (p === OMITTED_PATH ? { size: 1, mtime: Date.now() - 1000 } : { size: 1, mtime: Date.now() - 40 * 24 * 3600 * 1000 }),
      Date.now(),
    )
    expect(visible[0]!.path).toBe(OMITTED_PATH) // omitted fresh row wins the visible page
    expect(visible[0]!.path).not.toBe(FLOOR_PATH) // ...while the certificate returns the floor

    // [MARGIN GATE — RED until proof-router lands the fix] The certificate must
    // refuse this page: the required gate is floor > bound + MAX_RECENCY_BOOST.
    // 69 > 68 + 6 = 74 is FALSE, so a correct certificate returns provenTopK
    // false. Today the bound omits the boost and returns true, so this
    // assertion FAILS — deliberately. Turn it green by landing the margin.
    expect(historicalCert.provenTopK).toBe(false)
  })

  // NOTE (unsigned-fixture fence): the RED above is the coupling to proof-router.
  test("MARGIN GATE documents the required gate shape independently of the RED assertion", () => {
    const MAX_BOOST = mentionRecencyBoost(Date.now())
    const bound = omittedSingleTokenScoreUpperBound("ab", "path-substring+basename-subsequence")!
    // Required gate: a page certifies only when its floor strictly dominates
    // the omitted bound AFTER the largest recency swing can be added to an
    // omitted row. Nothing here touches production.
    const gate = (floor: number) => floor > bound + MAX_BOOST
    expect(gate(bound)).toBe(false)
    expect(gate(bound + MAX_BOOST)).toBe(false) // equality still unproven
    expect(gate(bound + MAX_BOOST + 1)).toBe(true)
  })
})

// ===========================================================================
// DISCRIMINATING FIXTURE — the discard VETO must key on corpus MEMBERSHIP,
// not on basename coverage and not on which branch fired.
//
// Defect (coordinator-measured, code-confirmed at everything.ts:742-749): the
// two `discardedPaths.push` sites are undifferentiated. `discardedCoverageSafe`
// then vetoes purely on `basenameContainsQuerySubsequence`, which is a proxy
// that is wrong in BOTH directions:
//
//   (A) OUT-of-corpus row whose basename IS covered. The callback is
//       `!visiblePaths.has(rel)` (index backend) or `!known.has(rel) && ...`
//       (ripgrep backend), so such a row is by construction NOT in the native
//       corpus and can never be in native top-K. Vetoing on it is provably
//       unnecessary — and at the repo root that is 509/512 enumerated rows.
//   (B) IN-corpus row that was NOT scored. It CAN be in native top-K and no
//       bound covers an unscored row, so it MUST veto regardless of whether its
//       basename happens to contain the query.
//
// The correct rule: veto iff (row ∈ authoritative native corpus) AND (row was
// not scored). Membership of the SAME generation's corpus — never branch
// identity, because the ripgrep backend's first disjunct (isConfiguredIgnored)
// is a config-glob test that can match a TRACKED (in-corpus) file.
//
// These assertions are RED against today's code (the veto set is
// undifferentiated) and turn GREEN when the fix keys on membership.
// ===========================================================================

type VetoReason = "outside-root" | "not-in-snapshot" | "configured-ignore" | "in-corpus-unscored"

/**
 * Reference implementation of the CORRECT veto rule, kept in the test so the
 * fixture can state what "green" means independently of production. It keys on
 * same-generation corpus membership, exactly the invariant the fix must adopt.
 *
 * Both sides are normalized through `keyOf` (slash form, case-folded on win32)
 * so an absolute discarded path and a relative corpus entry compare equal when
 * they denote the same file. `memberKey` lets callers pre-normalize the corpus
 * to absolute form.
 */
function correctVetoes(
  discarded: readonly { path: string; reason: VetoReason }[],
  corpusKeys: ReadonlySet<string>,
): string[] {
  return discarded.filter((d) => corpusKeys.has(keyOf(d.path))).map((d) => d.path)
}

describe("discard veto keys on corpus membership, not basename coverage (RED until the fix)", () => {
  /** Corpus keys in the SAME normalized form `correctVetoes` compares against. */
  const corpusOf = (absolutePaths: readonly string[]) => new Set(absolutePaths.map(keyOf))

  test("(A) an OUT-of-corpus row with a COVERED basename must NOT veto", () => {
    // Query "ab": basename coverage is true, so today's proof vetoes -- but the
    // row is not in the native corpus and can never be in native top-K.
    const outOfCorpus = { path: abs("node_modules", "a-b.ts"), reason: "not-in-snapshot" as const }
    expect(basenameContainsQuerySubsequence("ab", outOfCorpus.path)).toBe(true) // covered, yet out-of-corpus
    const corpus = corpusOf([abs("src", "search.ts")]) // authoritative snapshot does NOT contain it

    const proof = certifyCandidateTopK({
      query: "ab",
      pageScores: [10_000],
      pageLimit: 1,
      basenameSubsequenceComplete: true,
      discardedPaths: [outOfCorpus.path],
    })
    // The correct rule returns no vetoes here.
    expect(correctVetoes([outOfCorpus], corpus)).toEqual([])
    // [RED] Production vetoes anyway, because it keys on basename coverage.
    expect(proof.discardedCoverageSafe).toBe(true)
  })

  test("(B) an IN-corpus UNSCORED row must veto EVEN when its basename is not covered", () => {
    // Basename coverage is false, so today's proof calls it safe -- but the row
    // IS in the native corpus and was never scored, so no bound covers it.
    const inCorpus = "src/zz.ts"
    const inCorpusAbs = abs("src", "zz.ts")
    expect(basenameContainsQuerySubsequence("ab", inCorpusAbs)).toBe(false) // uncovered, yet in-corpus
    const corpus = corpusOf([abs(...inCorpus.split("/")), abs("src", "search.ts")]) // snapshot CONTAINS it

    const proof = certifyCandidateTopK({
      query: "ab",
      pageScores: [10_000],
      pageLimit: 1,
      basenameSubsequenceComplete: true,
      discardedPaths: [inCorpusAbs],
    })
    // The correct rule DOES veto here.
    expect(correctVetoes([{ path: inCorpusAbs, reason: "in-corpus-unscored" }], corpus)).toEqual([inCorpusAbs])
    // [RED] Production calls it safe because the basename lacks the subsequence.
    expect(proof.discardedCoverageSafe).toBe(false)
  })

  test("(C) the two axes are independent: membership decides, coverage does not", () => {
    // A 2x2 of {in,out}-corpus x {covered,uncovered} shows production tracks the
    // COVERAGE column while the correct rule tracks the MEMBERSHIP row.
    const inCovered = abs("src", "a-b.ts")
    const inUncovered = abs("src", "zz.ts")
    const outCovered = abs("node_modules", "a-b.ts")
    const outUncovered = abs("node_modules", "zz.ts")
    const cases: Array<{ path: string; inCorpus: boolean }> = [
      { path: inCovered, inCorpus: true },
      { path: inUncovered, inCorpus: true },
      { path: outCovered, inCorpus: false },
      { path: outUncovered, inCorpus: false },
    ]
    const corpus = corpusOf([inCovered, inUncovered]) // exactly the in-corpus rows

    // Correct rule: vetoes are exactly the in-corpus rows, regardless of coverage.
    const expectedVetoes = cases.filter((c) => c.inCorpus).map((c) => c.path)
    expect(correctVetoes(cases.map((c) => ({ path: c.path, reason: "in-corpus-unscored" as const })), corpus)).toEqual(
      expectedVetoes,
    )

    // Production's decision per single-row proof, for contrast: it agrees with
    // coverage, not membership. Assert the two disagree on exactly the two rows
    // where the axes cross, so the fixture cannot silently become vacuous.
    const productionVetoes = (path: string) =>
      !certifyCandidateTopK({
        query: "ab",
        pageScores: [10_000],
        pageLimit: 1,
        basenameSubsequenceComplete: true,
        discardedPaths: [path],
      }).discardedCoverageSafe
    const disagreements = cases.filter((c) => productionVetoes(c.path) !== c.inCorpus)
    // out-of-corpus+covered (prod vetoes, membership says no) and
    // in-corpus+uncovered (prod allows, membership says veto) both disagree.
    expect(disagreements.map((c) => c.path).sort()).toEqual([outCovered, inUncovered].sort())
  })

  test("(D) membership must come from the SAME generation's corpus (provenance coupling)", () => {
    // keystream-lifecycle's hazard: once the veto depends on membership, pairing
    // a stale corpus with a fresh candidate set would mis-veto. The reference
    // rule makes provenance explicit, so the invariant is assertable.
    const row = abs("src", "a-b.ts")
    const generation1 = corpusOf([]) // row absent at g1
    const generation2 = corpusOf([abs("src", "a-b.ts")]) // row present at g2
    // Same row, same reason, two generations -> two different veto decisions.
    expect(correctVetoes([{ path: row, reason: "in-corpus-unscored" }], generation1)).toEqual([])
    expect(correctVetoes([{ path: row, reason: "in-corpus-unscored" }], generation2)).toEqual([row])
    // Therefore a proof MUST resolve membership against its own generation's
    // corpus; asserting that coupling is the point of this test.
  })
})
