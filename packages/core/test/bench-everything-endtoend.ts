/**
 * Everything end-to-end evidence harness (perf-freshness lane).
 *
 * Measures native `searchFileMentionsFast` baselines AND Everything
 * end-to-end (provider IPC + OpenFork rerank + proof) on identical corpora,
 * with per-stage breakdown, p50/p95, CPU, memory, and classifier rows that
 * contain BOTH wins AND native-is-faster failures.
 *
 * Run from packages/core (never from the repo root):
 *
 *   bun test/bench-everything-endtoend.ts synthetic   # native-only, deterministic synthetic corpora
 *   bun test/bench-everything-endtoend.ts live        # live repo root (NTFS ~8k), native vs provider
 *   bun test/bench-everything-endtoend.ts live-medium # live corpus-120k fixture (~120k), native vs provider
 *   bun test/bench-everything-endtoend.ts live-big    # live full W: root (~1.3M, ReFS), slower
 *
 * Stage model (harness-visible, public APIs only — no production changes):
 *   fetch+decode  combined; inseparable without ipc-runtime hooks. The TS
 *                 client parse() runs inside searchCandidatesExhaustive.
 *   fence+filter  combined; normalizeCandidate + ignore run inside the
 *                 provider call. A separate normalizeCandidate unit microbench
 *                 is reported so the fence unit cost is still quantified.
 *   rerank+hl     combined; searchFileMentionsFast recomputes scores AND
 *                 positions/baseOffset for surviving top-K in one pass.
 *   proof         separate; certifyCandidateTopK pure call.
 * IPC bytes/pages are NOT exposed by the current API (needs ipc-runtime
 * hooks); candidateCount/requiredCount/exhaustible are reported instead.
 *
 * Everything here is diagnostic. No es.exe, no production routing.
 */

import { Effect } from "effect"
import { searchFileMentionsFast } from "../src/search/mention-fast"
import { rankFileMentionResults } from "../src/search/mention-ranking"
import type { Matcher } from "../src/search/matcher"

// NOTE: the Everything provider module is imported LAZILY inside live-only
// functions. everything.ts is contested by three peers and may be mid-edit;
// synthetic native baselines must run regardless of its parse state.

const MAX_VIEWPORT = 10_000
const TIMEOUT_MS = 1500 // mirrors everything.ts TIMEOUT_MS: numbers near this are timeout-censored
const INITIAL_COUNT = 512
const TOP_K = 20

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo)
}

function stats(samples: number[]) {
  const sorted = samples.slice().sort((a, b) => a - b)
  return {
    n: samples.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  }
}

function mem() {
  const m = process.memoryUsage()
  return { rssMB: m.rss / 1048576, heapMB: m.heapUsed / 1048576 }
}

function syntheticCorpus(count: number): Matcher.PathEntry[] {
  const rows: Matcher.PathEntry[] = new Array(count)
  for (let i = 0; i < count; i++) {
    rows[i] = {
      path: `packages/pkg${i % 300}/src/components/feature-${i % 1000}/dialog-select-model-${i}.tsx`,
      isDir: false,
    }
  }
  return rows
}

const NATIVE_QUERIES = ["s", "se", "search", "sis", "abg", "vlccsc", "server session", "proj exp", "json", "file-0999"]
// Live provider queries: realistic keystreams incl. shapes historically fast AND slow.
const LIVE_QUERIES = ["search", "sis", "abg", "vlccsc", "server session", "proj exp", "json", "readme", "src", "file-0999", "pkg-119", "f"]

async function rgFiles(root: string): Promise<string[]> {
  const proc = Bun.spawn(["rg", "--files"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text
    .trim()
    .split(/\r?\n/)
    .map((p) => p.replaceAll("\\", "/"))
    .filter(Boolean)
}

function dropDotSegments(paths: string[]): string[] {
  // Mirrors normalizeCandidate's dot-segment rejection so the native corpus
  // matches what the provider can return.
  return paths.filter((p) => !p.split("/").some((seg) => seg === "" || seg.startsWith(".")))
}

async function nativeSweep(name: string, corpus: Matcher.PathEntry[], queries: string[], samples: number) {
  console.log(JSON.stringify({ part: "native-sweep", corpus: name, paths: corpus.length, queries, samples }))
  const before = mem()
  const cpu0 = process.cpuUsage()
  for (const query of queries) {
    for (let w = 0; w < 3; w++) searchFileMentionsFast(corpus, { query, limit: TOP_K, offset: 0 })
    const lat: number[] = []
    const cpuStart = process.cpuUsage()
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now()
      searchFileMentionsFast(corpus, { query, limit: TOP_K, offset: 0 })
      lat.push(performance.now() - t0)
    }
    const cpu = process.cpuUsage(cpuStart)
    const s = stats(lat)
    console.log(
      JSON.stringify({
        part: "native-row",
        corpus: name,
        query,
        n: s.n,
        p50ms: Number(s.p50.toFixed(3)),
        p95ms: Number(s.p95.toFixed(3)),
        minMs: Number(s.min.toFixed(3)),
        maxMs: Number(s.max.toFixed(3)),
        cpuUserMsPerQuery: Number((((cpu.user / 1000) / samples).toFixed(3))),
        cpuSysMsPerQuery: Number(((cpu.system / 1000 / samples).toFixed(3))),
        heapMB: Number(mem().heapMB.toFixed(1)),
      }),
    )
  }
  const cpuTotal = process.cpuUsage(cpu0)
  console.log(
    JSON.stringify({
      part: "native-sweep-done",
      corpus: name,
      rssMB: Number(mem().rssMB.toFixed(1)),
      heapDeltaMB: Number((mem().heapMB - before.heapMB).toFixed(1)),
      cpuUserSec: Number((cpuTotal.user / 1e6).toFixed(2)),
      cpuSysSec: Number((cpuTotal.system / 1e6).toFixed(2)),
    }),
  )
}

async function recencyReorderProbe(name: string, root: string, relPaths: string[], queries: string[]) {
  // Adversarial counterevidence for proof-router: the production index layer
  // applies rankFileMentionResults (+0..6 recency) AFTER the fast scorer, but
  // the proof reranks fast-only. Measure how often recency reorders the
  // user-visible top-K and whether the proof verdict would flip.
  const { statSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { certifyCandidateTopK } = await import("../src/search/everything")
  const mtimes = new Map<string, number>()
  for (const rel of relPaths) {
    try {
      mtimes.set(rel, statSync(join(root, rel)).mtimeMs)
    } catch {
      mtimes.set(rel, 0)
    }
  }
  const now = Date.now()
  const meta = (path: string) => {
    const mtime = mtimes.get(path) ?? 0
    return mtime > 0 ? { size: 0, mtime } : undefined
  }
  let reorders = 0
  for (const query of queries) {
    const corpus: Matcher.PathEntry[] = relPaths.map((p) => ({ path: p, isDir: false }))
    const fast = searchFileMentionsFast(corpus, { query, limit: TOP_K, offset: 0 })
    const reranked = rankFileMentionResults(fast.results, meta, now)
    const fastOrder = JSON.stringify(fast.results.map((r) => r.path))
    const recOrder = JSON.stringify(reranked.map((r) => r.path))
    const reordered = fastOrder !== recOrder
    if (reordered) reorders++
    const fastProof = certifyCandidateTopK({
      query,
      pageScores: fast.results.map((r) => r.score),
      pageLimit: TOP_K,
      basenameSubsequenceComplete: true,
      discardedPaths: [],
    })
    const recProof = certifyCandidateTopK({
      query,
      pageScores: reranked.map((r) => r.score),
      pageLimit: TOP_K,
      basenameSubsequenceComplete: true,
      discardedPaths: [],
    })
    console.log(
      JSON.stringify({
        part: "recency-row",
        root: name,
        query,
        reordered,
        fastFloor: fastProof.proofFloor ?? null,
        recencyFloor: recProof.proofFloor ?? null,
        bound: fastProof.omittedScoreUpperBound ?? null,
        fastProven: fastProof.provenTopK,
        recencyProven: recProof.provenTopK,
        verdictFlip: fastProof.provenTopK !== recProof.provenTopK,
      }),
    )
  }
  console.log(JSON.stringify({ part: "recency-done", root: name, queries: queries.length, reorderedQueries: reorders }))
}

async function fenceUnitMicrobench(root: string, items: Array<{ fullPath: string; isDir: boolean }>) {
  const { normalizeCandidate } = await import("../src/search/everything")
  const lat: number[] = []
  for (let i = 0; i < 2000; i++) {
    const item = items[i % items.length]!
    const t0 = performance.now()
    normalizeCandidate(root, item)
    lat.push(performance.now() - t0)
  }
  const s = stats(lat)
  console.log(
    JSON.stringify({
      part: "fence-unit",
      rows: items.length,
      iterations: lat.length,
      p50nsPerRow: Math.round(s.p50 * 1e6),
      p95nsPerRow: Math.round(s.p95 * 1e6),
    }),
  )
}

interface ClassifierRow {
  query: string
  nativeP50ms: number
  providerFetchDecodeFenceMs: number
  rerankHlMs: number
  proofMs: number
  e2eP50ms: number
  candidateCount: number
  nativeTopK: number
  coveredTopK: number
  recallTopK: number
  missingSample: string | null
  discardedCount: number
  discardedCoverageSafe: boolean
  basenameSubsequenceComplete: boolean
  requiredCount: number
  exhaustible: boolean
  complete: boolean
  orderedExact: boolean
  proofFloor?: number
  omittedBound?: number
  proofMargin?: number
  provenTopK: boolean
  timeoutCensored: boolean
  faultReason: string | null
  faultDetail: string | null
  decision: "WIN" | "NATIVE_FASTER_PROVEN" | "UNPROVEN_KEEP_NATIVE" | "INCOMPLETE_KEEP_NATIVE" | "TIMEOUT_CENSORED" | "PROVIDER_FAULT_KEEP_NATIVE"
}

async function liveRoot(name: string, root: string, relPaths: string[], queries: string[], samples: number) {
  const { searchCandidatesExhaustive, certifyCandidateTopK } = await import("../src/search/everything")
  const corpus: Matcher.PathEntry[] = relPaths.map((p) => ({ path: p, isDir: false }))
  console.log(JSON.stringify({ part: "live-root", name, root, paths: corpus.length, samples }))
  fenceUnitMicrobench(
    root,
    relPaths.slice(0, 5000).map((p) => ({ fullPath: `${root}\\${p.replaceAll("/", "\\")}`, isDir: false })),
  )
  const classifier: ClassifierRow[] = []
  for (const query of queries) {
    // Native p50 on the exact same corpus.
    for (let w = 0; w < 2; w++) searchFileMentionsFast(corpus, { query, limit: TOP_K, offset: 0 })
    const nativeLat: number[] = []
    let nativeFirst: Matcher.QueryPage | undefined
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now()
      const page = searchFileMentionsFast(corpus, { query, limit: TOP_K, offset: 0 })
      nativeLat.push(performance.now() - t0)
      if (i === 0) nativeFirst = page
    }
    const nativeP50 = stats(nativeLat).p50

    // Provider E2E with per-stage split.
    const fetchLat: number[] = []
    const rerankLat: number[] = []
    const proofLat: number[] = []
    let last: {
      status: string
      complete?: boolean
      exhaustible?: boolean
      requiredCount?: number
      candidateCount?: number
      nativeTopK?: number
      coveredTopK?: number
      recallTopK?: number
      missingSample?: string | null
      discardedCount?: number
      discardedCoverageSafe?: boolean
      basenameSubsequenceComplete?: boolean
      orderedExact?: boolean
      proofFloor?: number
      omittedBound?: number
      provenTopK?: boolean
      reason?: string
      detail?: string
    } = { status: "none" }
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now()
      const res = await Effect.runPromise(
        searchCandidatesExhaustive({ root, query, initialCount: INITIAL_COUNT }),
      )
      const t1 = performance.now()
      fetchLat.push(t1 - t0)
      if (res.status !== "measured") {
        last = { status: res.status, reason: (res as { reason?: string }).reason, detail: (res as { detail?: string }).detail }
        continue
      }
      const t2 = performance.now()
      const reranked = searchFileMentionsFast(res.paths, { query, limit: TOP_K, offset: 0 })
      const t3 = performance.now()
      rerankLat.push(t3 - t2)
      const t4 = performance.now()
      const proof = certifyCandidateTopK({
        query,
        pageScores: reranked.results.map((r) => r.score),
        pageLimit: TOP_K,
        basenameSubsequenceComplete: res.basenameSubsequenceComplete,
        discardedPaths: res.discardedPaths,
      })
      proofLat.push(performance.now() - t4)
      const lexical = (r: Matcher.UnifiedResult) => ({ kind: r.kind, path: r.path, type: r.type, score: r.score, positions: r.positions, baseOffset: r.baseOffset })
      const orderedExact =
        JSON.stringify((nativeFirst?.results ?? []).map(lexical)) === JSON.stringify(reranked.results.map(lexical))
      const foldKey = (v: string) => (process.platform === "win32" ? v.toLowerCase() : v)
      const candKeys = new Set(res.paths.map((e) => foldKey(e.path)))
      const nativeTop = (nativeFirst?.results ?? []).map((r) => r.path).filter((p): p is string => p !== undefined)
      const missingTop = nativeTop.filter((p) => !candKeys.has(foldKey(p)))
      const cov = {
        nativeTopK: nativeTop.length,
        coveredTopK: nativeTop.length - missingTop.length,
        recallTopK: nativeTop.length === 0 ? 1 : (nativeTop.length - missingTop.length) / nativeTop.length,
        missingSample: (missingTop[0] ?? null) as string | null,
      }
      last = {
        status: "measured",
        complete: res.complete,
        exhaustible: res.exhaustible,
        requiredCount: res.requiredCount,
        candidateCount: res.paths.length,
        nativeTopK: cov.nativeTopK,
        coveredTopK: cov.coveredTopK,
        recallTopK: cov.recallTopK,
        missingSample: cov.missingSample,
        discardedCount: res.discardedPaths.length,
        discardedCoverageSafe: proof.discardedCoverageSafe,
        basenameSubsequenceComplete: res.basenameSubsequenceComplete,
        orderedExact,
        proofFloor: proof.proofFloor,
        omittedBound: proof.omittedScoreUpperBound,
        provenTopK: proof.provenTopK,
      }
    }
    const f = stats(fetchLat)
    const r = stats(rerankLat)
    const p = stats(proofLat)
    const fetchP50 = fetchLat.length > 0 ? f.p50 : Number.NaN
    const rerankP50 = rerankLat.length > 0 ? r.p50 : 0
    const proofP50 = proofLat.length > 0 ? p.p50 : 0
    const e2e = fetchLat.length > 0 ? fetchP50 + rerankP50 + proofP50 : Number.NaN
    const timeoutCensored = fetchLat.length > 0 && f.max > TIMEOUT_MS * 0.9
    let decision: ClassifierRow["decision"]
    if (last.status !== "measured") decision = "PROVIDER_FAULT_KEEP_NATIVE"
    else if (timeoutCensored) decision = "TIMEOUT_CENSORED"
    else if (!last.complete || !last.exhaustible) decision = "INCOMPLETE_KEEP_NATIVE"
    else if (!last.provenTopK) decision = "UNPROVEN_KEEP_NATIVE"
    else if (e2e < nativeP50) decision = "WIN"
    else decision = "NATIVE_FASTER_PROVEN"
    const row: ClassifierRow = {
      query,
      nativeP50ms: Number(nativeP50.toFixed(2)),
      providerFetchDecodeFenceMs: fetchLat.length > 0 ? Number(fetchP50.toFixed(2)) : Number.NaN,
      rerankHlMs: Number(rerankP50.toFixed(3)),
      proofMs: Number(proofP50.toFixed(3)),
      e2eP50ms: fetchLat.length > 0 ? Number(e2e.toFixed(2)) : Number.NaN,
      candidateCount: last.candidateCount ?? 0,
      nativeTopK: last.nativeTopK ?? 0,
      coveredTopK: last.coveredTopK ?? 0,
      recallTopK: last.recallTopK ?? 1,
      missingSample: last.missingSample ?? null,
      discardedCount: last.discardedCount ?? 0,
      discardedCoverageSafe: last.discardedCoverageSafe ?? false,
      basenameSubsequenceComplete: last.basenameSubsequenceComplete ?? false,
      requiredCount: last.requiredCount ?? 0,
      exhaustible: last.exhaustible ?? false,
      complete: last.complete ?? false,
      orderedExact: last.orderedExact ?? false,
      proofFloor: last.proofFloor,
      omittedBound: last.omittedBound,
      proofMargin:
        last.proofFloor !== undefined && last.omittedBound !== undefined
          ? last.proofFloor - last.omittedBound
          : undefined,
      provenTopK: last.provenTopK ?? false,
      timeoutCensored,
      faultReason: last.reason ?? null,
      faultDetail: last.detail ?? null,
      decision,
    }
    classifier.push(row)
    console.log(JSON.stringify({ part: "live-row", root: name, ...row }))
  }
  const wins = classifier.filter((c) => c.decision === "WIN").length
  const nativeFaster = classifier.filter((c) => c.decision === "NATIVE_FASTER_PROVEN").length
  const unproven = classifier.filter((c) => c.decision === "UNPROVEN_KEEP_NATIVE" || c.decision === "INCOMPLETE_KEEP_NATIVE").length
  const faults = classifier.filter((c) => c.decision === "PROVIDER_FAULT_KEEP_NATIVE")
  const faultKinds: Record<string, number> = {}
  for (const f of faults) faultKinds[`${f.faultReason ?? "none"}:${(f.faultDetail ?? "").slice(0, 80)}`] = (faultKinds[`${f.faultReason ?? "none"}:${(f.faultDetail ?? "").slice(0, 80)}`] ?? 0) + 1
  console.log(JSON.stringify({ part: "live-done", root: name, wins, nativeFasterProven: nativeFaster, unprovenOrIncomplete: unproven, providerFaults: faults.length, faultKinds, rows: classifier.length }))
}

const mode = process.argv[2] ?? "synthetic"
if (mode === "synthetic") {
  const repo = await rgFiles("../..")
  await nativeSweep("opencode-real", repo.map((p) => ({ path: p, isDir: false })), NATIVE_QUERIES, 15)
  await nativeSweep("synthetic-100k", syntheticCorpus(100_000), NATIVE_QUERIES, 15)
  await nativeSweep("synthetic-250k", syntheticCorpus(250_000), NATIVE_QUERIES, 10)
  await nativeSweep("synthetic-1M", syntheticCorpus(1_000_000), NATIVE_QUERIES, 10)
} else if (mode === "live" || mode === "live-medium" || mode === "live-big") {
  const repoRoot = "C:\\Users\\slooshied\\WebstormProjects\\opencode"
  const repo = dropDotSegments(await rgFiles(repoRoot))
  await nativeSweep("opencode-real-ntfs", repo.map((p) => ({ path: p, isDir: false })), LIVE_QUERIES, 5)
  await liveRoot("repo-ntfs", repoRoot, repo, LIVE_QUERIES, 5)
  await recencyReorderProbe("repo-ntfs", repoRoot, repo, LIVE_QUERIES)
  if (mode === "live-medium") {
    // 120,120-entry materialized fixture (medium corpus for E2E).
    const mRoot = "C:\\Users\\slooshied\\AppData\\Local\\OpenFork\\everything-sdk3-dev\\corpus-120k"
    const m = dropDotSegments(await rgFiles(mRoot))
    await nativeSweep("corpus-120k", m.map((p) => ({ path: p, isDir: false })), LIVE_QUERIES, 5)
    await liveRoot("corpus-120k", mRoot, m, LIVE_QUERIES, 5)
    await recencyReorderProbe("corpus-120k", mRoot, m, LIVE_QUERIES)
  }
  if (mode === "live-big") {
    // Whole-volume ReFS root (~1.3M files by rg --files; W:\Dev alone is only ~43k).
    const wRoot = "W:\\"
    const w = dropDotSegments(await rgFiles(wRoot))
    await nativeSweep("wvol-refs", w.map((p) => ({ path: p, isDir: false })), LIVE_QUERIES, 5)
    await liveRoot("wvol-refs", wRoot, w, LIVE_QUERIES, 5)
  }
} else {
  console.error(`unknown mode ${mode}; want synthetic|live|live-medium|live-big`)
  process.exit(2)
}
process.exit(0)
