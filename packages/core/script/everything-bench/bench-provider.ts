/**
 * Native vs Everything-SDK3 provider benchmark + classifier evidence collector.
 *
 * This is a MEASUREMENT HARNESS, not a product path. It reproduces the
 * production shadow comparison (packages/core/src/filesystem/search.ts calls
 * compareShadow) against a REAL enumerated corpus and records, per query:
 *
 *   - native p50/p95/p99 over searchFileMentionsFast on that corpus
 *   - provider wall time for the same request (compareShadow.providerMs)
 *   - stage split measured externally: candidate fetch (exhaustive provider
 *     search), rerank (searchFileMentionsFast over the candidate set),
 *     proof bound (omittedSingleTokenScoreUpperBound)
 *   - candidates returned by the provider, the server-side upper bound
 *     (requiredCount), completeness/exhaustibility
 *   - proofFloor / omittedScoreUpperBound / provenTopK / orderedExact / recall
 *   - process CPU and heap deltas per sample
 *
 * It NEVER asserts a win. It emits rows so the classifier dataset is built from
 * measured data, and it keeps native semantics canonical: a row is only a
 * candidate, never an authority.
 *
 * Usage:
 *   bun packages/core/script/everything-bench/bench-provider.ts \
 *     --root=W:\ --corpus=<corpus.json> --queries=vlccsc,vlccs,json --samples=9 \
 *     [--limit=20] [--offset=0] [--keystream=vlccsc] [--out=rows.json] [--repeat-native=N]
 */
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { compareShadow, searchCandidatesExhaustive } from "../../src/search/everything"
import {
  omittedSingleTokenScoreUpperBound,
  searchFileMentionsFast,
} from "../../src/search/mention-fast"
import type { PathEntry } from "../../src/search/matcher"

type Args = Record<string, string>
function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (const item of argv) {
    if (!item.startsWith("--")) continue
    const eq = item.indexOf("=")
    if (eq < 0) args[item.slice(2)] = "true"
    else args[item.slice(2, eq)] = item.slice(eq + 1)
  }
  return args
}

function percentile(sorted: number[], q: number) {
  if (sorted.length === 0) return undefined
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return Math.round(sorted[rank] * 1000) / 1000
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    min: percentile(sorted, 0),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: Math.round(Math.max(0, ...sorted) * 1000) / 1000,
  }
}

type Corpus = { root: string; entries: string[] }

function loadCorpus(file: string): Corpus {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Corpus
  const entries = parsed.entries.filter((entry) => typeof entry === "string" && entry.length > 0)
  return { root: parsed.root, entries }
}

/** Native FileSystemSearch equivalent for the mention path. */
function nativeSearch(corpus: PathEntry[], query: string, limit: number, offset: number) {
  return searchFileMentionsFast(corpus, { query, limit, offset })
}

/**
 * Production-shaped shadow count. Kept byte-identical in spirit to
 * filesystem/search.ts so the measured corpus matches the shipped request.
 */
function productionCount(limit: number, offset: number) {
  return Math.min(10_000, Math.max(512, limit + offset, (limit + offset) * 8))
}

type Row = Record<string, unknown>

async function measureQuery(
  corpus: PathEntry[],
  root: string,
  query: string,
  limit: number,
  offset: number,
  samples: number,
  nativeRepeats: number,
): Promise<Row> {
  const count = productionCount(limit, offset)

  // Warm the native prepared-corpus cache exactly like production does
  // (revision-stable candidate array reused across keystrokes).
  for (let i = 0; i < Math.max(1, nativeRepeats); i++) nativeSearch(corpus, query, limit, offset)
  const nativeMs: number[] = []
  let nativeHeap = 0
  let nativeCpu = 0
  let nativeResults = 0
  {
    const cpu0 = process.cpuUsage()
    for (let i = 0; i < samples; i++) {
      const before = process.memoryUsage().heapUsed
      const t0 = performance.now()
      const page = nativeSearch(corpus, query, limit, offset)
      nativeMs.push(performance.now() - t0)
      nativeHeap += process.memoryUsage().heapUsed - before
      if (i === 0) nativeResults = page.results.length
    }
    const cpu1 = process.cpuUsage(cpu0)
    nativeCpu = (cpu1.user + cpu1.system) / 1000
  }

  const providerMs: number[] = []
  const fetchMs: number[] = []
  const rerankMs: number[] = []
  const heapDelta: number[] = []
  let cpuTotal = 0
  let last: Awaited<ReturnType<typeof runProvider>> | undefined

  for (let i = 0; i < samples; i++) {
    const cpu0 = process.cpuUsage()
    const before = process.memoryUsage().heapUsed
    const result = await runProvider(corpus, root, query, limit, offset, count)
    heapDelta.push(process.memoryUsage().heapUsed - before)
    const cpu1 = process.cpuUsage(cpu0)
    cpuTotal += (cpu1.user + cpu1.system) / 1000
    providerMs.push(result.providerMs)
    fetchMs.push(result.fetchMs)
    rerankMs.push(result.rerankMs)
    last = result
  }

  const bound = omittedSingleTokenScoreUpperBound(query, "path-substring+basename-subsequence")
  const p50Native = stats(nativeMs).p50 ?? 0
  const p50Provider = stats(providerMs).p50 ?? 0

  return {
    query,
    corpusSize: corpus.length,
    limit,
    offset,
    candidateCount: last?.candidates ?? 0,
    // Server-side upper bound of compiled sources. When this exceeds the
    // returned candidate count, the difference includes rows the provider
    // normalized away, so win/loss cannot be read without both numbers.
    serverUpperBound: last?.requiredCount ?? 0,
    exhaustible: last?.exhaustible ?? false,
    complete: last?.complete ?? false,
    fetchStats: stats(fetchMs),
    rerankStats: stats(rerankMs),
    providerStats: stats(providerMs),
    nativeStats: stats(nativeMs),
    nativeResults,
    providerMsP50: p50Provider,
    nativeMsP50: p50Native,
    // Positive = provider faster. Native stays authoritative unless this is
    // positive AND the row is proven and ordered-exact.
    deltaMs: Math.round((p50Provider - p50Native) * 1000) / 1000,
    ratio: p50Native > 0 ? Math.round((p50Provider / p50Native) * 1000) / 1000 : undefined,
    providerFaster: p50Provider < p50Native,
    proofFloor: last?.proofFloor,
    omittedScoreUpperBound: last?.omittedScoreUpperBound,
    // Strict comparison: equality is UNPROVEN. Recorded, never widened.
    provenTopK: last?.provenTopK ?? false,
    orderedExact: last?.orderedExact ?? false,
    recall: last?.recall,
    nativeTopK: last?.nativeTopK ?? 0,
    coveredTopK: last?.coveredTopK ?? 0,
    missingCount: last?.missing.length ?? 0,
    missingSample: last?.missing.slice(0, 5) ?? [],
    measured: last?.measured ?? false,
    skippedReason: last?.skippedReason,
    unavailableReason: last?.unavailableReason,
    detail: last?.detail,
    boundMatchesProviderBound:
      bound === undefined || last?.omittedScoreUpperBound === undefined
        ? undefined
        : bound === last.omittedScoreUpperBound,
    cpuMsTotal: Math.round(cpuTotal * 1000) / 1000,
    nativeCpuMsTotal: Math.round(nativeCpu * 1000) / 1000,
    heapDeltaBytesP50: stats(heapDelta).p50,
    nativeHeapDeltaBytesTotal: nativeHeap,
  }
}

async function runProvider(
  corpus: PathEntry[],
  root: string,
  query: string,
  limit: number,
  offset: number,
  count: number,
) {
  // Stage 1: candidate fetch (+ SDK3 decode inside the provider).
  const fetchStart = performance.now()
  const candidates = await Effect.runPromise(
    searchCandidatesExhaustive({ root, query, initialCount: count }),
  )
  const fetchMs = performance.now() - fetchStart

  // Stage 2: rerank through the canonical OpenFork ranker.
  const rerankStart = performance.now()
  const paths = candidates.status === "measured" ? (candidates.paths as PathEntry[]) : []
  const native = nativeSearch(corpus, query, limit, offset)
  const reranked = paths.length > 0 ? searchFileMentionsFast(paths, { query, limit, offset }) : native
  const rerankMs = performance.now() - rerankStart

  // Stage 3: full production shadow comparison (provider + proof fields).
  const shadow = await Effect.runPromise(
    compareShadow({ root, query, count, native: native.results, corpus, limit, offset }),
  )

  return {
    candidates: paths.length,
    requiredCount: candidates.status === "measured" ? candidates.requiredCount : 0,
    exhaustible: candidates.status === "measured" ? candidates.exhaustible : false,
    complete: candidates.status === "measured" ? candidates.complete : false,
    fetchMs,
    rerankMs,
    // compareShadow.providerMs is the provider-side wall time for the same
    // exhaustive request; endToEndMs adds the OpenFork rerank on top.
    providerMs: shadow.measured ? shadow.providerMs : fetchMs,
    endToEndMs: shadow.measured ? shadow.providerMs + rerankMs : fetchMs + rerankMs,
    proofFloor: shadow.proofFloor,
    omittedScoreUpperBound: shadow.omittedScoreUpperBound,
    provenTopK: shadow.provenTopK,
    orderedExact: shadow.orderedExact,
    recall: shadow.recall,
    nativeTopK: shadow.nativeTopK,
    coveredTopK: shadow.coveredTopK,
    missing: shadow.missing,
    measured: shadow.measured,
    skippedReason: shadow.skippedReason,
    unavailableReason: shadow.unavailableReason,
    detail: shadow.detail,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const corpusFile = args.corpus
  if (!corpusFile) {
    console.error("usage: bench-provider.ts --root=<root> --corpus=<corpus.json> --queries=a,b,c")
    process.exit(2)
  }
  const root = path.resolve(args.root ?? ".")
  const limit = Number(args.limit ?? 20)
  const offset = Number(args.offset ?? 0)
  const samples = Number(args.samples ?? 9)
  const nativeRepeats = Number(args["repeat-native"] ?? 3)
  const queries = (args.queries ?? "vlccsc").split(",").map((value) => value.trim()).filter(Boolean)

  const loaded = loadCorpus(corpusFile)
  const corpus: PathEntry[] = loaded.entries.map((entry) => ({ path: entry, isDir: false }))
  console.error(
    JSON.stringify({
      root,
      corpusFile,
      corpusEntries: corpus.length,
      limit,
      offset,
      samples,
      queries,
    }),
  )

  const rows: Row[] = []
  for (const query of queries) {
    const row = await measureQuery(corpus, root, query, limit, offset, samples, nativeRepeats)
    rows.push(row)
    console.error(
      JSON.stringify({
        query,
        corpus: row.corpusSize,
        candidates: row.candidateCount,
        serverUpperBound: row.serverUpperBound,
        nativeP50: row.nativeMsP50,
        providerP50: row.providerMsP50,
        ratio: row.ratio,
        provenTopK: row.provenTopK,
        orderedExact: row.orderedExact,
        recall: row.recall,
      }),
    )
  }

  const keystream = args.keystream
  const keystreamRows: Row[] = []
  if (keystream) {
    // Real keystream: prefixes of one query, newest supersedes the previous
    // generation. The provider's single-slot scheduler is exercised as shipped.
    for (let i = 1; i <= keystream.length; i++) {
      const query = keystream.slice(0, i)
      const row = await measureQuery(corpus, root, query, limit, offset, Math.max(3, samples - 4), nativeRepeats)
      row.keystrokeIndex = i
      keystreamRows.push(row)
      console.error(
        JSON.stringify({
          keystroke: query,
          nativeP50: row.nativeMsP50,
          providerP50: row.providerMsP50,
          provenTopK: row.provenTopK,
          orderedExact: row.orderedExact,
        }),
      )
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    root,
    corpusFile,
    corpusEntries: corpus.length,
    limit,
    offset,
    samples,
    queries,
    rows,
    keystreamRows,
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: (await import("node:os")).cpus().length,
      totalMemMB: Math.round(((await import("node:os")).totalmem() / 1024 / 1024) as number),
    },
  }
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(out, null, 2))
    console.error(JSON.stringify({ wrote: args.out }))
  } else {
    console.log(JSON.stringify(out, null, 2))
  }
}

await main()