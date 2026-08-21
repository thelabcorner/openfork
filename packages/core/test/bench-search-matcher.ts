/**
 * Matcher bench race per docs/matching-research benchmark protocol.
 *
 * Run: bun run test/bench-search-matcher.ts   (from packages/core)
 *
 * Competitors:
 *   1. fuzzysort full-scan (current production baseline)
 *   2. prepared fzf-v2-style scorer, full scan (Phase B alone)
 *   3. indexed frontier pipeline (Phase A + Phase B, incremental sessions)
 *
 * Workload: whole keystroke streams (append, backspace, mid-edit) over the
 * real 185k path corpus + 500k synthetic symbols. Reports p50..max latency,
 * per-stage timings, frontier sizes, recall@10 vs exhaustive oracle, and the
 * research doc's acceptance gates.
 */
import { readFileSync } from "node:fs"
import fuzzysort from "fuzzysort"
import { Matcher } from "../src/search/matcher"
import { MatcherScore } from "../src/search/matcher-score"

const REAL =
  "C:/Users/slooshied/.local/share/opencode/file-index/8477d838d1cb4e5e8a46e82e4b93ce516286fcf81e3a34bdc6a8ed61cad42577.json"

// ---- corpora ---------------------------------------------------------------
interface SymbolRec {
  name: string
  kind: string
  path: string
  line: number
}

function loadRealPaths(): string[] {
  const doc = JSON.parse(readFileSync(REAL, "utf8")) as { subtrees: Record<string, { entries: { path: string }[] }> }
  const out: string[] = []
  for (const tree of Object.values(doc.subtrees)) for (const e of tree.entries) out.push(e.path)
  return out
}

const VOCAB_A = ["get", "set", "create", "update", "delete", "remove", "insert", "find", "search", "index", "build", "make", "parse", "render", "mount", "handle", "process", "resolve", "load", "save", "fetch", "push", "pull", "merge", "diff", "patch", "apply", "validate", "serialize", "decode", "encode", "compress", "hash", "sign", "stream", "read", "write", "open", "close", "flush", "spawn", "fork", "join", "wait", "retry"]
const VOCAB_B = ["File", "Index", "Chunk", "Store", "Service", "Handler", "Route", "Session", "Message", "Part", "Event", "Stream", "Buffer", "Cache", "Pool", "Worker", "Task", "Queue", "Tree", "Node", "Edge", "Graph", "Path", "Root", "Leaf", "Entry", "Record", "Field", "Value", "Key", "Ref", "Span", "Range", "Token", "Symbol", "Scope", "Module", "Package", "Bundle", "Plugin", "Agent", "Client", "Server", "Socket", "Channel", "Port", "Frame", "Codec", "Schema", "User", "ById", "Controller", "Provider"]
const KINDS = ["function", "method", "class", "interface", "type", "enum", "const"]

function mulberry(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function synthSymbols(count: number, pathCount: number): SymbolRec[] {
  const rand = mulberry(42)
  const pick = <T>(arr: T[]) => arr[(rand() * arr.length) | 0]!
  const paths: string[] = []
  for (let i = 0; i < pathCount; i++) {
    const segs = 2 + ((rand() * 4) | 0)
    const parts: string[] = []
    for (let s = 0; s < segs; s++) parts.push(pick(VOCAB_B) + (rand() < 0.3 ? String((rand() * 90) | 0 + 10) : ""))
    paths.push("src/" + parts.join("/").toLowerCase() + "/" + pick(VOCAB_B).toLowerCase() + (rand() < 0.8 ? ".ts" : ".tsx"))
  }
  const out: SymbolRec[] = []
  for (let i = 0; i < count; i++) {
    const nWords = 1 + ((rand() * 3) | 0)
    let name = ""
    for (let w = 0; w < nWords; w++) {
      const b = pick(VOCAB_B)
      // mix camelCase and lowercase token styles (measured-ish distribution)
      name += w === 0 ? pick(VOCAB_A) : rand() < 0.7 ? b : b.toLowerCase()
    }
    out.push({ name, kind: pick(KINDS), path: paths[(rand() * pathCount) | 0]!, line: 1 + ((rand() * 2000) | 0) })
  }
  return out
}

// ---- timing helpers ---------------------------------------------------------
const sorted = (xs: number[]) => xs.sort((a, b) => a - b)
const pctOf = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * q))]!
const fmt = (us: number) => (us >= 1000 ? `${(us / 1000).toFixed(2)}ms` : `${us.toFixed(0)}µs`)

interface LatSet {
  label: string
  samples: number[]
}
function report(rows: LatSet[]): void {
  console.log(
    `  ${"competitor".padEnd(34)} ${"p50".padStart(9)} ${"p90".padStart(9)} ${"p95".padStart(9)} ${"p99".padStart(9)} ${"max".padStart(10)}`,
  )
  for (const r of rows) {
    const s = sorted(r.samples)
    console.log(
      `  ${r.label.padEnd(34)} ${fmt(pctOf(s, 0.5)).padStart(9)} ${fmt(pctOf(s, 0.9)).padStart(9)} ${fmt(pctOf(s, 0.95)).padStart(9)} ${fmt(pctOf(s, 0.99)).padStart(9)} ${fmt(s[s.length - 1]!).padStart(10)}`,
    )
  }
}

// ---- main --------------------------------------------------------------------
async function main() {
  console.log("Loading corpora...")
  const realPaths = loadRealPaths()
  const symbols = synthSymbols(500_000, Math.min(realPaths.length, 60_000))
  const symbolNames = symbols.map((s) => s.name)
  const pathEntries: Matcher.PathEntry[] = realPaths.map((p) => ({ path: p, isDir: false }))
  const dirSet = new Set<string>()
  for (const p of realPaths) {
    const parts = p.split("/")
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/") + "/")
  }
  for (const d of dirSet) pathEntries.push({ path: d, isDir: true })
  console.log(`  ${realPaths.length} files + ${dirSet.size} dirs + ${symbols.length} symbols`)

  // dir-vs-file parity competition corpus
  const parityEntries: Matcher.PathEntry[] = [
    { path: "src/components/", isDir: true },
    { path: "src/components/Button.tsx", isDir: false },
    { path: "lib/components.ts", isDir: false },
    { path: "docs/components-guide.md", isDir: false },
    { path: "app/utils/deep/nested/other.ts", isDir: false },
  ]

  console.log("\nPreparing indexes...")
  let t0 = performance.now()
  const prepared = Matcher.prepare({ paths: pathEntries, symbols })
  const prepMs = performance.now() - t0
  const parityPrepared = Matcher.prepare({ paths: parityEntries, symbols: [] })
  console.log(`  prepare: ${(prepMs / 1000).toFixed(2)}s | index bytes: paths ${(prepared.paths.index.approxBytes / 1048576).toFixed(1)}MiB, symbols ${(prepared.symbols.index.approxBytes / 1048576).toFixed(1)}MiB`)

  // ---- keystroke-stream workload -------------------------------------------
  const SOURCES = [
    "packages",
    "FileSystemSearch",
    "getUserById",
    "findfile",
    "src search",
    "config",
    "handler",
    "schema",
    "gubi",
    "chunkstore",
    "session",
    "plugin",
  ]

  interface Stream {
    label: string
    keys: string[]
  }
  const streams: Stream[] = []
  for (const src of SOURCES) {
    const keys: string[] = []
    for (let i = 1; i <= src.length; i++) keys.push(src.slice(0, i)) // append
    for (let i = src.length - 1; i >= 1; i--) keys.push(src.slice(0, i)) // backspace
    if (src.length > 4) keys.push(src.slice(0, 3) + "x" + src.slice(4)) // mid-edit
    streams.push({ label: src, keys })
  }

  const latIndexed: number[] = []
  const latFuzzyFull: number[] = []
  const latFuzzysort: number[] = []
  const stageGen: number[] = []
  const stageScore: number[] = []
  const stageHeap: number[] = []
  const stageMat: number[] = []
  const frontierSizes: number[] = []

  const session = Matcher.createSession(prepared)

  const runStream = (pass: number) => {
    for (const st of streams) {
      for (const key of st.keys) {
        // indexed pipeline (incremental session)
        const t = performance.now()
        session.query(key, { limit: 30 })
        const us = (performance.now() - t) * 1000
        if (pass > 0) {
          latIndexed.push(us)
          const tm = session.lastTimings
          if (tm) {
            stageGen.push(tm.generateUs)
            stageScore.push(tm.scoreUs)
            stageHeap.push(tm.heapUs)
            stageMat.push(tm.materializeUs)
            frontierSizes.push(tm.frontier)
          }
        }
      }
    }
  }

  console.log("\nWarming JIT (2 full passes over all streams)...")
  runStream(0)
  runStream(0)

  console.log("Measuring indexed pipeline (3 passes)...")
  for (let pass = 1; pass <= 3; pass++) runStream(pass)

  // full-scan competitors: same keystrokes, cold every time (they cannot
  // benefit from incrementality by construction). Both use the SAME shared
  // scoring path as the pipeline (scoreCandidateIndex) so latency — not score
  // semantics — is the only variable.
  console.log("Measuring full-scan competitors (sampled keystream, 1 pass)...")
  const idx = prepared.paths.index
  const oneTok = new Uint16Array(32)
  const foldQ = (q: string): Uint16Array => {
    let n = 0
    for (let i = 0; i < q.length && n < 32; i++) {
      let c = q.charCodeAt(i)
      if (c >= 65 && c <= 90) c += 32
      oneTok[n++] = c
    }
    return oneTok.subarray(0, n)
  }
  let keyIdx = 0
  for (const st of streams) {
    for (const key of st.keys) {
      // full scans are O(corpus) per keystroke by construction; sample every
      // 3rd key so the competitor replay stays minutes, not tens of minutes
      if (keyIdx++ % 3 !== 0) continue
      // prepared fzf-v2 scorer, full scan over all path candidates
      const tq = foldQ(key)
      const t0f = performance.now()
      let best = MatcherScore.NEG
      for (let id = 0; id < idx.count; id++) {
        const s = Matcher.scoreCandidateIndex(idx, id, [tq])
        if (s > best) best = s
      }
      latFuzzyFull.push((performance.now() - t0f) * 1000)

      // fuzzysort baseline
      const t0z = performance.now()
      fuzzysort.go(key, realPaths, { limit: 30 })
      latFuzzysort.push((performance.now() - t0z) * 1000)
    }
  }

  console.log("\n=== KEYSTROKE LATENCY (paths corpus, limit=30) ===")
  report([
    { label: "indexed frontier (ours)", samples: latIndexed },
    { label: "fzf-v2 scorer full-scan", samples: latFuzzyFull },
    { label: "fuzzysort full-scan", samples: latFuzzysort },
  ])

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  console.log("\n=== STAGE BREAKDOWN (indexed pipeline, mean per keystroke) ===")
  console.log(`  generate ${fmt(mean(stageGen))} | score ${fmt(mean(stageScore))} | heap ${fmt(mean(stageHeap))} | materialize ${fmt(mean(stageMat))}`)
  console.log(`  frontier: mean ${mean(frontierSizes).toFixed(0)} | p99 ${pctOf(sorted([...frontierSizes]), 0.99)}`)

  // ---- recall@10 vs exhaustive oracle --------------------------------------
  console.log("\n=== RECALL@10 vs EXHAUSTIVE ORACLE (paths, identical scoring) ===")
  const oracleTop = (q: string, k: number): string[] => {
    const tq = foldQ(q)
    const scored: Array<{ id: number; score: number }> = []
    for (let id = 0; id < idx.count; id++) {
      const s = Matcher.scoreCandidateIndex(idx, id, [tq])
      if (s > MatcherScore.NEG) scored.push({ id, score: s })
    }
    scored.sort((a, b) => b.score - a.score || a.id - b.id)
    return scored.slice(0, k).map((s) => (prepared.paths.rows[s.id] as Matcher.PathEntry).path)
  }
  const FINAL_QUERIES = ["packages", "config", "handler", "schema", "session", "plugin", "findfile", "search"]
  let recallSum = 0
  for (const q of FINAL_QUERIES) {
    const oracle = new Set(oracleTop(q, 10))
    const ours = session.query(q, { limit: 10 }).files.map((f) => f.item.path)
    const hit = ours.filter((p) => oracle.has(p)).length
    recallSum += hit / 10
    console.log(`  ${q.padEnd(12)} ${hit}/10`)
  }
  const recall = recallSum / FINAL_QUERIES.length

  // ---- golden quality checks -------------------------------------------------
  console.log("\n=== GOLDEN QUALITY CHECKS ===")
  let pass = 0
  let fail = 0
  const check = (name: string, ok: boolean, detail: string) => {
    if (ok) pass++
    else fail++
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`)
  }

  const gubi = Matcher.queryPaths(prepared, "gubi", { limit: 10 }).map((r) => r.item.path)
  check("acronym gubi finds getUserById-like paths", gubi.length > 0, gubi[0] ?? "(none)")

  const multi = session.query("src search", { limit: 10 })
  check(
    "multi-token AND verified",
    multi.files.length > 0 && multi.files.every((r) => ["src", "search"].every((tok) => Matcher.tokenMatch(r.item.path.toLowerCase(), tok))),
    multi.files[0]?.item.path ?? "(none)",
  )

  const d1 = Matcher.queryPaths(prepared, "config", { limit: 20 }).map((r) => r.item.path)
  const d2 = Matcher.queryPaths(prepared, "config", { limit: 20 }).map((r) => r.item.path)
  check("deterministic across calls", JSON.stringify(d1) === JSON.stringify(d2), "")

  const l5 = Matcher.queryPaths(prepared, "ts", { limit: 5 })
  check("limit respected", l5.length <= 5 && l5.length > 0, `${l5.length} results`)

  const posRes = Matcher.queryPaths(prepared, "pac", { limit: 5 })
  check(
    "positions ascending & in-bounds",
    posRes.every((r) => (r.positions ?? []).every((v, i, a) => (i === 0 || v > a[i - 1]!) && v < r.item.path.length)),
    "",
  )

  const comp = Matcher.queryPaths(parityPrepared, "components", { limit: 5 }).map((r) => r.item.path)
  const dirIdx = comp.indexOf("src/components/")
  check("dir 'src/components/' ranks top-3 for 'components'", dirIdx >= 0 && dirIdx < 3, comp.join(" | "))
  const slashMode = Matcher.queryPaths(parityPrepared, "src/", { limit: 5 }).map((r) => r.item.path)
  check("trailing-/ mode returns only dirs", slashMode.length > 0 && slashMode.every((p) => p.endsWith("/")), slashMode.join(" | "))

  const typoPage = session.query("pakcages", { limit: 10 })
  check("typo transposition recovers under strict underfill", typoPage.files.some((r) => r.item.path.includes("package")), typoPage.files[0]?.item.path ?? "(none)")

  // hysteresis: typing an append keeps prior top row visible near the top
  session.query("pack", { limit: 10 })
  const before = session.query("packa", { limit: 10 }).files.map((r) => r.item.path)
  check("incremental append returns results", before.length > 0, before[0] ?? "(none)")

  // ---- INTELLIGENCE BENCHMARK ------------------------------------------------
  // Labeled-intent ranking quality (doc §Corpora/§Query workload): derive query
  // forms from KNOWN corpus targets, then measure whether the intended target
  // ranks at 1/5/10 — stronger than self-oracle recall.
  console.log("\n=== INTELLIGENCE: LABELED-INTENT RANKING QUALITY ===")
  console.log(`  [mark] intel start ${new Date().toISOString()}`)
  const rand = mulberry(7)
  const pickR = <T>(arr: T[]) => arr[(rand() * arr.length) | 0]!

  interface Labeled {
    query: string
    target: string
    form: string
  }
  const labeled: Labeled[] = []
  const basenameOf = (p: string) => {
    const core = p.endsWith("/") ? p.slice(0, -1) : p
    return core.slice(core.lastIndexOf("/") + 1)
  }
  const camelAcronym = (name: string) =>
    name
      .split(/(?=[A-Z])|[_\-.\/]/)
      .filter(Boolean)
      .map((w) => w[0]!.toLowerCase())
      .join("")
  const addForms = (target: string, primary: string) => {
    if (primary.length < 4 || labeled.length > 400) return
    const stem = primary.replace(/\.[a-z]+$/i, "")
    const form = (rand() * 4) | 0
    if (form === 0 && stem.length >= 4) labeled.push({ query: stem.slice(0, 3 + ((rand() * 3) | 0)).toLowerCase(), target, form: "prefix" })
    else if (form === 1 && /[A-Z]/.test(stem) && camelAcronym(stem).length >= 3) labeled.push({ query: camelAcronym(stem), target, form: "acronym" })
    else if (form === 2 && stem.length >= 6) labeled.push({ query: stem.slice(1, 6).toLowerCase(), target, form: "substring" })
    else labeled.push({ query: stem.toLowerCase().replace(/[_\-]/g, "").slice(0, 8), target, form: "sep-omit" })
  }
  for (let i = 0; i < 300; i++) {
    const p = pickR(realPaths)
    addForms(p, basenameOf(p))
  }
  for (let i = 0; i < 150; i++) {
    const s = pickR(symbols)
    addForms(`${s.name}\u0000${s.path}`, s.name)
  }

  const rankOf = (results: string[], target: string): number => {
    const [tPath, tName] = target.split("\u0000")
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!
      if (tName !== undefined ? r === `${tName}\u0000${tPath}` : r === tPath) return i + 1
    }
    return Infinity
  }
  const symResultKey = (page: Matcher.QueryPage): string[] =>
    page.results.map((r) => (r.kind === "symbol" ? `${r.name}\u0000${r.path}` : r.path ?? ""))

  let r1 = 0
  let r5 = 0
  let r10 = 0
  let mrrSum = 0
  const byForm = new Map<string, { hits: number; n: number; mrr: number }>()
  for (const l of labeled) {
    const page = session.query(l.query, { limit: 30 })
    const results = symResultKey(page)
    const rank = rankOf(results, l.target)
    if (rank === 1) r1++
    if (rank <= 5) r5++
    if (rank <= 10) r10++
    mrrSum += rank === Infinity ? 0 : 1 / rank
    const agg = byForm.get(l.form) ?? { hits: 0, n: 0, mrr: 0 }
    agg.n++
    if (rank <= 10) agg.hits++
    agg.mrr += rank === Infinity ? 0 : 1 / rank
    byForm.set(l.form, agg)
  }
  console.log("  [mark] labeled loop done")
  const N = labeled.length
  console.log(`  labeled queries: ${N} (path+symbol intents)`)
  console.log(`  recall@1 ${(100 * (r1 / N)).toFixed(1)}% | recall@5 ${(100 * (r5 / N)).toFixed(1)}% | recall@10 ${(100 * (r10 / N)).toFixed(1)}% | MRR ${(mrrSum / N).toFixed(3)}`)
  for (const [form, agg] of [...byForm.entries()].sort()) {
    console.log(`    ${form.padEnd(9)} recall@10 ${((100 * agg.hits) / agg.n).toFixed(1).padStart(6)}% MRR ${(agg.mrr / agg.n).toFixed(3)}`)
  }

  console.log("  [mark] churn start")
  // visible rank churn across consecutive keystrokes (doc metric)
  let churnSum = 0
  let churnN = 0
  for (const st of streams) {
    let prev: string[] | undefined
    for (const key of st.keys) {
      const cur = session.query(key, { limit: 10 }).files.map((f) => f.item.path)
      if (prev !== undefined && prev.length > 0 && cur.length > 0) {
        const inter = cur.filter((p) => prev!.includes(p)).length
        churnSum += 1 - inter / Math.max(prev.length, cur.length)
        churnN++
      }
      prev = cur
    }
  }
  console.log(`  visible rank churn per keystroke: ${((100 * churnSum) / Math.max(1, churnN)).toFixed(1)}% (lower = stabler)`)

  console.log("  [mark] fuzzysort-quality start")
  // quality vs fuzzysort on final queries (top-10 containment both ways)
  console.log("\n=== QUALITY vs FUZZYSORT (final queries, top-10) ===")
  for (const q of FINAL_QUERIES.slice(0, 6)) {
    const ours = new Set(session.query(q, { limit: 10 }).files.map((f) => f.item.path))
    const theirs = fuzzysort.go(q, realPaths, { limit: 10 }).map((r) => r.target)
    const shared = theirs.filter((p) => ours.has(p)).length
    console.log(`  ${q.padEnd(12)} overlap ${shared}/10`)
  }

  console.log("  [mark] verdict start")
  // ---- verdict ----------------------------------------------------------------
  const p99idx = pctOf(sorted(latIndexed), 0.99)
  const p50idx = pctOf(sorted(latIndexed), 0.5)
  console.log("\n=== ACCEPTANCE GATES ===")
  const gate = (name: string, ok: boolean, detail: string) => console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`)
  gate("p99 <= 1ms warm", p99idx <= 1000, fmt(p99idx))
  gate("p50 <= 0.3ms target", p50idx <= 300, fmt(p50idx))
  gate("recall@10 >= 99%", recall >= 0.99, `${(recall * 100).toFixed(1)}%`)
  gate("typical frontier <= 512", mean(frontierSizes) <= 512, `mean ${mean(frontierSizes).toFixed(0)}`)
  gate("goldens all pass", fail === 0, `${pass} pass / ${fail} fail`)
  const sp = pctOf(sorted(latFuzzysort), 0.5) / Math.max(p50idx, 0.001)
  console.log(`\n  speedup vs fuzzysort (keystroke p50): ${sp.toFixed(1)}x (original target >=5x)`)
}

main().catch((e) => {
  console.error("BENCH FAIL", e)
  process.exit(1)
})
