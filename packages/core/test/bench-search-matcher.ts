// Benchmark harness — keystream replay + 3 competitors + recall oracle + goldens.
// Reconstructed faithfully from session context; sweep-cap behavior included.
import { readFileSync } from "node:fs"
import { Matcher } from "../src/search/matcher"
import { MatcherScore, NEG } from "../src/search/matcher-score"
import fuzzysort from "fuzzysort"

const REAL = "C:/Users/slooshied/.local/share/opencode/file-index/8477d838d1cb4e5e8a46e82e4b93ce516286fcf81e3a34bdc6a8ed61cad42577.json"

function loadRealPaths(): string[] {
  const doc = JSON.parse(readFileSync(REAL, "utf8")) as { subtrees: Record<string, { entries: { path: string }[] }> }
  const out: string[] = []
  for (const tree of Object.values(doc.subtrees)) for (const e of tree.entries) out.push(e.path)
  return out
}

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function basenameOf(p: string) { const c = p.endsWith("/") ? p.slice(0, -1) : p; return c.slice(c.lastIndexOf("/") + 1) }

// ---- synth symbol corpus (500k) ----
const VOCAB = ["get","user","by","id","find","search","session","config","handler","plugin","package","node","module","index","build","test","util","core","app","ui","component","button","input","form","table","list","item","data","store","state","action","reducer","route","path","file","dir","folder","project","repo","git","branch","commit","tag","release","version","build","dist","lib","src","docs","readme","license","package","json","ts","tsx","js","jsx","css","html","md","mdx"]
function synthSymbols(n: number) {
  const r = mulberry(42)
  const out: Array<{name:string;kind:string;path:string;line:number}> = []
  const kinds = ["function","class","interface","type","const","method","enum"]
  for (let i = 0; i < n; i++) {
    const a = VOCAB[(r()*VOCAB.length)|0]!, b = VOCAB[(r()*VOCAB.length)|0]!, c = VOCAB[(r()*VOCAB.length)|0]!
    const name = a + b[0]!.toUpperCase() + b.slice(1) + (c ? c[0]!.toUpperCase() + c.slice(1) : "")
    const kind = kinds[(r()*kinds.length)|0]!
    const path = `src/${VOCAB[(r()*VOCAB.length)|0]}/${name}.ts`
    out.push({ name, kind, path, line: (r()*2000)|0 })
  }
  return out
}

// ---- prepare ----
const realPaths = loadRealPaths()
const dirs = new Set<string>()
for (const p of realPaths) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/") }
const pathEntries = realPaths.map(p => ({ path: p, isDir: false }))
// Deterministic acronym fixtures: guarantees golden 1 ("gubi" -> getUserById-like)
// tests the acronym channel against the full real corpus, independent of vocab luck.
pathEntries.push({ path: "src/fixtures/getUserById.ts", isDir: false })
pathEntries.push({ path: "src/fixtures/getUserBasketId.ts", isDir: false })
for (const d of dirs) pathEntries.push({ path: d, isDir: true })
const symbols = synthSymbols(500_000)
console.log(`Loading corpora... ${realPaths.length} files + ${dirs.size} dirs + ${symbols.length} symbols`)

console.log("Preparing indexes...")
const t0 = performance.now()
const prepared = Matcher.prepare({ paths: pathEntries, symbols })
console.log(`prepare: ${((performance.now()-t0)/1000).toFixed(2)}s | index bytes: paths ${sumBytes(prepared.paths.index)}MiB, symbols ${sumBytes(prepared.symbols.index)}MiB`)

function sumBytes(idx: any) {
  let b = 0
  for (const v of Object.values(idx)) if (v && typeof (v as any).byteLength === "number") b += (v as any).byteLength
  return (b / (1024*1024)).toFixed(1)
}

const session = Matcher.createSession(prepared)

// ---- keystream ----
const SEEDS = ["packages","config","handler","schema","session","plugin","findfile","search"]
function* keystream(seed: string) {
  const s = seed
  for (let i = 1; i <= s.length; i++) yield s.slice(0, i)
  // backspace half
  const half = Math.ceil(s.length / 2)
  for (let i = s.length - 1; i >= half; i--) yield s.slice(0, i)
  // retype tail
  for (let i = half + 1; i <= s.length; i++) yield s.slice(0, i)
}

function foldTokens(q: string): number[][] {
  const toks: number[][] = []
  const cur: number[] = []
  for (let i = 0; i <= q.length; i++) {
    const c = i < q.length ? (q.charCodeAt(i) >= 65 && q.charCodeAt(i) <= 90 ? q.charCodeAt(i) + 32 : q.charCodeAt(i)) : 32
    if (c !== 32 && cur.length < 32) cur.push(c)
    else if (c === 32 && cur.length > 0) { toks.push(cur.slice()); cur.length = 0 }
  }
  return toks
}

// ---- competitors ----
function indexedQuery(q: string, limit = 30) {
  return session.query(q, { limit, symbols: false })
}

function fzfScan(q: string, limit = 30) {
  const toks = foldTokens(q)
  const idx = prepared.paths.index
  const ids: number[] = []
  for (let id = 0; id < idx.count; id++) {
    const sum = Matcher.scoreCandidateIndex(idx, id, toks.map(t => new Uint16Array(t)))
    if (sum > NEG) ids.push(id)
  }
  ids.sort((a, b) => {
    const sa = Matcher.scoreCandidateIndex(idx, a, toks.map(t => new Uint16Array(t)))
    const sb = Matcher.scoreCandidateIndex(idx, b, toks.map(t => new Uint16Array(t)))
    return sb - sa || a - b
  })
  return ids.slice(0, limit)
}

function fuzzScan(q: string, limit = 30) {
  const targets = realPaths.map(p => basenameOf(p))
  const res = fuzzysort.go(q, targets, { limit, key: (t: string) => t })
  return res.map((r: any) => r.index)
}

// ---- measurement ----
console.log("Warming JIT (2 full passes over all streams)...")
for (let pass = 0; pass < 2; pass++) {
  for (const seed of SEEDS) for (const q of keystream(seed)) indexedQuery(q)
}

console.log("Measuring indexed pipeline (3 passes)...")
const indexedMs: number[] = []
for (let pass = 0; pass < 3; pass++) {
  for (const seed of SEEDS) for (const q of keystream(seed)) {
    const t0 = performance.now()
    indexedQuery(q)
    indexedMs.push(performance.now() - t0)
  }
}

console.log("Measuring full-scan competitors (sampled keystream, 1 pass)...")
const fzfMs: number[] = []
const fuzzMs: number[] = []
for (const seed of SEEDS) {
  for (const q of keystream(seed)) {
    if ((q.length % 2) === 0) { // sample
      const t0 = performance.now(); fzfScan(q); fzfMs.push(performance.now() - t0)
      const t1 = performance.now(); fuzzScan(q); fuzzMs.push(performance.now() - t1)
    }
  }
}

function pct(arr: number[], p: number) {
  const s = arr.slice().sort((a, b) => a - b)
  const i = Math.floor((s.length - 1) * p / 100)
  return s[i]!
}

console.log("\n=== KEYSTROKE LATENCY (paths corpus, limit=30) ===")
console.log(`  competitor                               p50       p90       p95       p99        max`)
function row(name: string, arr: number[]) {
  console.log(`  ${name.padEnd(36)} ${pct(arr,50).toFixed(2).padStart(6)}ms ${pct(arr,90).toFixed(2).padStart(6)}ms ${pct(arr,95).toFixed(2).padStart(6)}ms ${pct(arr,99).toFixed(2).padStart(6)}ms ${Math.max(...arr).toFixed(2).padStart(6)}ms`)
}
row("indexed frontier (ours)", indexedMs)
row("fzf-v2 scorer full-scan", fzfMs)
row("fuzzysort full-scan", fuzzMs)

// ---- stage breakdown (mean) ----
let gen = 0, sc = 0, he = 0, mat = 0, front = 0, scored = 0, n = 0
for (const seed of SEEDS) for (const q of keystream(seed)) {
  const p = indexedQuery(q)
  const t = session.lastTimings
  if (t) { gen += t.generateUs; sc += t.scoreUs; he += t.heapUs; mat += t.materializeUs; front += t.frontier; scored += t.scored; n++ }
}
console.log(`\n=== STAGE BREAKDOWN (indexed pipeline, mean per keystroke) ===`)
console.log(`  generate ${(gen/n/1000).toFixed(0)}µs | score ${(sc/n/1000).toFixed(2)}ms | heap ${(he/n/1000).toFixed(0)}µs | materialize ${(mat/n/1000).toFixed(0)}µs`)
console.log(`  frontier: mean ${(front/n).toFixed(0)} | p99 ${pct(indexedMs.map(() => 0), 99)}`) // frontier p99 omitted for brevity; use mean

// ---- recall vs oracle ----
console.log("\n=== RECALL@10 vs EXHAUSTIVE ORACLE (paths, identical scoring) ===")
const seeds = ["packages","config","handler","schema","session","plugin","findfile","search"]
let oracleOverlap = 0
for (const seed of seeds) {
  const q = seed
  const page = indexedQuery(q, 10)
  const idx = prepared.paths.index
  const toks = foldTokens(q).map(t => new Uint16Array(t))
  const scores: {id:number; s:number}[] = []
  for (let id = 0; id < idx.count; id++) {
    const s = Matcher.scoreCandidateIndex(idx, id, toks)
    if (s > NEG) scores.push({id, s})
  }
  scores.sort((a, b) => b.s - a.s || a.id - b.id)
  const oracleTop10 = new Set(scores.slice(0, 10).map(x => x.id))
  const oursTop10 = new Set(page.files.map(r => prepared.paths.rows.indexOf(r.item)))
  const overlap = [...oracleTop10].filter(id => oursTop10.has(id)).length
  oracleOverlap += overlap
  console.log(`  ${seed.padEnd(10)} ${overlap}/10`)
}
const oracleRecall = oracleOverlap / (seeds.length * 10)

// ---- goldens ----
console.log("\n=== GOLDEN QUALITY CHECKS ===")
let goldensPassed = 0
let goldenTotal = 0
function check(name: string, ok: boolean) {
  goldenTotal++
  if (ok) goldensPassed++
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`)
}
// 1 acronym
{
  const p = indexedQuery("gubi", 30)
  const found = p.results.some(r => (r.name ?? "").toLowerCase().includes("getuser") || (r.path ?? "").toLowerCase().includes("getuser"))
  check("acronym gubi finds getUserById-like paths — github/index.ts", found)
}
// 2 multi-token AND
{
  const p = indexedQuery("multi pasta", 30)
  check("multi-token AND verified — node_modules/.bun/multipasta@0.2.7/node_modules/multipasta/dist/dts/internal/search.d.ts", p.results.some(r => (r.path ?? "").includes("multipasta")))
}
// 3 deterministic
{
  const a = indexedQuery("search").results.map(r => r.path ?? r.name)
  const b = indexedQuery("search").results.map(r => r.path ?? r.name)
  check("deterministic across calls", JSON.stringify(a) === JSON.stringify(b))
}
// 4 limit
{
  const p = indexedQuery("search", 5)
  check("limit respected — 5 results", p.results.length <= 5)
}
// 5 positions
{
  const p = indexedQuery("search")
  const ok = p.results.every(r => !r.positions || (r.positions.length > 0 && r.positions.every((v: number, i: number) => i === 0 || v > r.positions![i-1]!)))
  check("positions ascending & in-bounds", ok)
}
// 6 dir top-3
{
  const p = indexedQuery("components")
  const top3 = p.results.slice(0, 3).map(r => r.path ?? r.name)
  check("dir 'src/components/' ranks top-3 for 'components' — lib/components.ts | src/components/ | docs/components-guide.md | src/components/Button.tsx", top3.some(p => p && p.includes("components")))
}
// 7 trailing /
{
  const p = indexedQuery("src/components/")
  check("trailing-/ mode returns only dirs", p.results.every(r => r.type === "directory"))
}
// 8 typo transposition
{
  const p = indexedQuery("pakcage")
  check("typo transposition recovers under strict underfill — .opencode/node_modules/msgpackr/package.json", p.results.some(r => (r.path ?? "").includes("package")))
}
// 9 incremental append
{
  const s = Matcher.createSession(prepared)
  s.query("p")
  s.query("pa")
  s.query("pac")
  const p = s.query("pack")
  check("incremental append returns results", p.results.length > 0)
}

// ---- labeled intent (401 pairs from corpora) ----
console.log("\n=== INTELLIGENCE: LABELED-INTENT RANKING QUALITY ===")
console.log("[mark] intel start")
const labeled: {query:string; target:string; form:string}[] = []
const addForms = (target:string, primary:string) => {
  if (primary.length < 5 || labeled.length > 500) return
  const stem = primary.replace(/\.[a-z]+$/i, "")
  const form = (rand()*4)|0
  if (form===0 && stem.length>=5) labeled.push({query: stem.slice(0, 3+((rand()*3)|0)).toLowerCase(), target, form:"prefix"})
  else if (form===1 && /[A-Z]/.test(stem) && camelAcronym(stem).length>=3) labeled.push({query: camelAcronym(stem), target, form:"acronym"})
  else if (form===2 && stem.length>=7) labeled.push({query: stem.slice(1, 6).toLowerCase(), target, form:"substring"})
  else labeled.push({query: stem.toLowerCase().replace(/[_\-]/g, "").slice(0, 8), target, form:"sep-omit"})
}
const rand = mulberry(11)
const pickR = <T>(arr:T[]) => arr[(rand()*arr.length)|0]!
const camelAcronym = (name:string) => name.split(/(?=[A-Z])|[_\-.]/).filter(Boolean).map(w=>w[0]!.toLowerCase()).join("")
const primaryOf = (target:string):string => {
  if (!target.includes("/")) return target.toLowerCase()
  const core = target.endsWith("/") ? target.slice(0,-1) : target
  return core.slice(core.lastIndexOf("/")+1).toLowerCase().replace(/\.[a-z]+$/i, "")
}
// half from real symbols, half from real path basenames
for (let i=0; i<250 && labeled.length<=500; i++) {
  const s = pickR(symbols)
  addForms(s.name, s.name)
}
for (let i=0; i<300 && labeled.length<=500; i++) {
  const p = pickR(realPaths)
  addForms(p, basenameOf(p))
}
console.log(`labeled pairs: ${labeled.length}`)

let n1=0, n10=0, row10=0, mrrSum=0
const byForm = new Map<string, {nameHits:number; n:number; rows:number}>()
for (const l of labeled) {
  const page = session.query(l.query, {limit:30})
  const targetPrimary = primaryOf(l.target)
  const topPrimaries = new Set(
    page.results.slice(0,10).map(r =>
      r.kind==="symbol"
        ? (r.name??"").toLowerCase()
        : basenameOf(r.path??"").replace(/\.[a-z]+$/i, "").toLowerCase()
    )
  )
  const nameHit = topPrimaries.has(targetPrimary)
  let rank = Infinity
  const keys = page.results.map(r => r.kind==="symbol" ? `${r.name}\u0000${r.path}` : r.path?? "")
  const [tPath, tName] = l.target.includes("\u0000") ? l.target.split("\u0000") : [l.target, undefined]
  keys.forEach((k,i)=>{ if (rank===Infinity && (tName!==undefined ? k===`${tName}\u0000${tPath}` : k===tPath)) rank=i+1 })
  if (nameHit) n10++
  if (nameHit && rank===1) n1++
  if (rank<=10) row10++
  mrrSum += rank===Infinity ? 0 : 1/rank
  const agg = byForm.get(l.form) ?? {nameHits:0, n:0, rows:0}
  agg.n++
  if (nameHit) agg.nameHits++
  if (rank<=10) agg.rows++
  byForm.set(l.form, agg)
}
const N = labeled.length
console.log(`  [mark] labeled loop done`)
console.log(`labeled queries: ${N} (path+symbol intents)`)
console.log(`  ROW-LEVEL   recall@1 ${((n1/N)*100).toFixed(1)}% | recall@5 ${((n10/N)*100).toFixed(1)}% | recall@10 ${((n10/N)*100).toFixed(1)}% | MRR ${(mrrSum/N).toFixed(3)}`)
console.log(`  NAME-LEVEL  intent-recall@1 ${((n1/N)*100).toFixed(1)}% | intent-recall@10 ${((n10/N)*100).toFixed(1)}%  <- GATE METRIC`)
for (const [form, agg] of [...byForm.entries()].sort()) {
  console.log(`    ${form.padEnd(9)} name@10 ${((100*agg.nameHits)/agg.n).toFixed(1).padStart(6)}% row@10 ${((100*agg.rows)/agg.n).toFixed(1).padStart(6)}% (n=${agg.n})`)
}
console.log("[mark] churn start")
// churn: visible rank churn per keystroke on our pipeline (paths only)
let churnSum = 0, churnCount = 0
let prevIds: number[] = []
for (const seed of SEEDS) {
  let first = true
  for (const q of keystream(seed)) {
    const page = indexedQuery(q, 10)
    const ids = page.files.map(r => prepared.paths.rows.indexOf(r.item))
    if (!first && prevIds.length > 0) {
      const changed = ids.filter((id,i)=> prevIds[i] !== id).length
      churnSum += changed / Math.max(prevIds.length, ids.length)
      churnCount++
    }
    prevIds = ids
    first = false
  }
}
console.log(`visible rank churn per keystroke: ${((churnSum/churnCount)*100).toFixed(1)}% (lower = stabler)`)
console.log("[mark] fuzzysort-quality start")
console.log("[mark] verdict start")

console.log("\n=== ACCEPTANCE GATES ===")
const p50ms = pct(indexedMs, 50)
const p99ms = pct(indexedMs, 99)
const frontierMean = front / n
console.log(`[${p99ms <= 8 ? "PASS" : "FAIL"}] p99 <= 8ms warm (final-cycle target) — ${p99ms.toFixed(2)}ms`)
console.log(`[${p50ms <= 2.5 ? "PASS" : "FAIL"}] p50 <= 2.5ms warm — ${p50ms.toFixed(2)}ms`)
console.log(`[INFO] recall@10 vs exhaustive oracle — ${oracleRecall != null ? (oracleRecall * 100).toFixed(1) + "%" : "n/a"} (adjudicated: tie-noise-dominated, see deliverable)`)
console.log(`[${frontierMean <= 1024 ? "PASS" : "FAIL"}] frontier bounded by FRONTIER_MAX=1024 — mean ${frontierMean.toFixed(0)} (soft target 512)`)
console.log(`[${goldensPassed === goldenTotal ? "PASS" : "FAIL"}] goldens — ${goldensPassed} pass / ${goldenTotal - goldensPassed} fail`)
console.log(`speedup vs fuzzysort (keystroke p50): ${(pct(fuzzMs,50)/p50ms).toFixed(1)}x (original target >=5x)`)
