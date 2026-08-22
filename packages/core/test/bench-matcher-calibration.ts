/**
 * CALIBRATION RUN (coordinator amendment): labeled-intent metrics against a
 * REPO-REAL corpus — real paths + symbols extracted from this repo via
 * indexer's symbols.ts extractor. No synthetic duplicates, no hash-chunk
 * acronyms. Not a gate — the defensible floor for the blackboard.
 *
 * Run: bun run test/bench-matcher-calibration.ts   (from packages/core)
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { Matcher } from "../src/search/matcher"
import { Symbols } from "../src/search/symbols"

const REAL =
  "C:/Users/slooshied/.local/share/opencode/file-index/8477d838d1cb4e5e8a46e82e4b93ce516286fcf81e3a34bdc6a8ed61cad42577.json"

function loadRealPaths(): string[] {
  const doc = JSON.parse(readFileSync(REAL, "utf8")) as { subtrees: Record<string, { entries: { path: string }[] }> }
  const out: string[] = []
  for (const tree of Object.values(doc.subtrees)) for (const e of tree.entries) out.push(e.path)
  return out
}

// walk repo source dirs for .ts/.tsx (skip node_modules/dist/out/.git)
const ROOTS = ["packages/core/src", "packages/opencode/src", "packages/app/src", "packages/tui/src", "packages/schema/src"]
function walk(dir: string, out: string[], depth: number) {
  if (depth > 12 || out.length > 4000) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (e.startsWith(".") || e === "node_modules" || e === "dist" || e === "out") continue
    const full = join(dir, e)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out, depth + 1)
    else if (/\.(ts|tsx)$/.test(e)) out.push(full)
  }
}

console.log("extracting repo symbols...")
const files: string[] = []
for (const r of ROOTS) walk(join("C:/Users/slooshied/WebstormProjects/opencode", r), files, 0)
const symbols: Array<{ name: string; kind: string; path: string; line: number }> = []
for (const f of files) {
  let src: string
  try {
    src = readFileSync(f, "utf8")
  } catch {
    continue
  }
  const rel = f.replaceAll("\\", "/").replace("C:/Users/slooshied/WebstormProjects/opencode/", "")
  symbols.push(...Symbols.extractTypeScriptSymbols(src, rel))
}
console.log(`  ${files.length} files scanned -> ${symbols.length} real symbols`)

const realPaths = loadRealPaths()
const pathEntries = realPaths.map((p) => ({ path: p, isDir: false }))
const dirSet = new Set<string>()
for (const p of realPaths) {
  const parts = p.split("/")
  for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/") + "/")
}
for (const d of dirSet) pathEntries.push({ path: d, isDir: true })

console.log("preparing...")
const t0 = performance.now()
const prepared = Matcher.prepare({ paths: pathEntries, symbols })
console.log(`prepared in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
const session = Matcher.createSession(prepared)

// ---- labeled intents from REAL identifiers ----
function mulberry(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry(11)
const pickR = <T>(arr: T[]) => arr[(rand() * arr.length) | 0]!
const basenameOf = (p: string) => {
  const core = p.endsWith("/") ? p.slice(0, -1) : p
  return core.slice(core.lastIndexOf("/") + 1)
}
const camelAcronym = (name: string) =>
  name
    .split(/(?=[A-Z])|[_\-.]/)
    .filter(Boolean)
    .map((w) => w[0]!.toLowerCase())
    .join("")

interface Labeled {
  query: string
  target: string // symbol name or file path
  form: string
}
const labeled: Labeled[] = []
const addForms = (target: string, primary: string) => {
  if (primary.length < 5 || labeled.length > 500) return
  const stem = primary.replace(/\.[a-z]+$/i, "")
  const form = (rand() * 4) | 0
  if (form === 0 && stem.length >= 5) labeled.push({ query: stem.slice(0, 3 + ((rand() * 3) | 0)).toLowerCase(), target, form: "prefix" })
  else if (form === 1 && /[A-Z]/.test(stem) && camelAcronym(stem).length >= 3) labeled.push({ query: camelAcronym(stem), target, form: "acronym" })
  else if (form === 2 && stem.length >= 7) labeled.push({ query: stem.slice(1, 6).toLowerCase(), target, form: "substring" })
  else labeled.push({ query: stem.toLowerCase().replace(/[_\-]/g, "").slice(0, 8), target, form: "sep-omit" })
}
// half from real symbols, half from real path basenames
for (let i = 0; i < 250 && labeled.length <= 500; i++) {
  const s = pickR(symbols)
  addForms(s.name, s.name)
}
for (let i = 0; i < 300 && labeled.length <= 500; i++) {
  const p = pickR(realPaths)
  addForms(p, basenameOf(p))
}
console.log(`labeled pairs: ${labeled.length}`)

const primaryOf = (target: string): string => {
  if (!target.includes("/")) return target.toLowerCase()
  const core = target.endsWith("/") ? target.slice(0, -1) : target
  return core.slice(core.lastIndexOf("/") + 1).toLowerCase().replace(/\.[a-z]+$/i, "")
}

let n1 = 0
let n10 = 0
let row10 = 0
let mrrSum = 0
const byForm = new Map<string, { nameHits: number; n: number; rows: number }>()
for (const l of labeled) {
  const page = session.query(l.query, { limit: 30 })
  const targetPrimary = primaryOf(l.target)
  const topPrimaries = new Set(
    page.results.slice(0, 10).map((r) =>
      r.kind === "symbol"
        ? (r.name ?? "").toLowerCase()
        : basenameOf(r.path ?? "").replace(/\.[a-z]+$/i, "").toLowerCase(),
    ),
  )
  const nameHit = topPrimaries.has(targetPrimary)
  // row-level rank among results
  let rank = Infinity
  const keys = page.results.map((r) => (r.kind === "symbol" ? `${r.name}\u0000${r.path}` : r.path ?? ""))
  const [tPath, tName] = l.target.includes("\u0000") ? l.target.split("\u0000") : [l.target, undefined]
  keys.forEach((k, i) => {
    if (rank === Infinity && (tName !== undefined ? k === `${tName}\u0000${tPath}` : k === tPath)) rank = i + 1
  })
  if (nameHit) n10++
  if (nameHit && rank === 1) n1++
  if (rank <= 10) row10++
  mrrSum += rank === Infinity ? 0 : 1 / rank
  const agg = byForm.get(l.form) ?? { nameHits: 0, n: 0, rows: 0 }
  agg.n++
  if (nameHit) agg.nameHits++
  if (rank <= 10) agg.rows++
  byForm.set(l.form, agg)
}
const N = labeled.length
console.log(`\n=== CALIBRATION (repo-real corpus, ${N} labeled intents) ===`)
console.log(`  NAME-LEVEL intent-recall@1 ${(100 * (n1 / N)).toFixed(1)}% | intent-recall@10 ${(100 * (n10 / N)).toFixed(1)}%`)
console.log(`  ROW-LEVEL recall@10 ${(100 * (row10 / N)).toFixed(1)}% | MRR ${(mrrSum / N).toFixed(3)}`)
for (const [form, agg] of [...byForm.entries()].sort()) {
  console.log(`    ${form.padEnd(9)} name@10 ${((100 * agg.nameHits) / agg.n).toFixed(1).padStart(6)}% row@10 ${((100 * agg.rows) / agg.n).toFixed(1).padStart(6)}% (n=${agg.n})`)
}
