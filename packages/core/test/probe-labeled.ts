import { readFileSync } from "node:fs"
import { Matcher } from "../src/search/matcher"

const REAL =
  "C:/Users/slooshied/.local/share/opencode/file-index/8477d838d1cb4e5e8a46e82e4b93ce516286fcf81e3a34bdc6a8ed61cad42577.json"
const doc = JSON.parse(readFileSync(REAL, "utf8")) as { subtrees: Record<string, { entries: { path: string }[] }> }
const paths: string[] = []
for (const tree of Object.values(doc.subtrees)) for (const e of tree.entries) paths.push(e.path)
const realPaths = paths
const pathEntries = paths.map((p) => ({ path: p, isDir: false as const }))
const dirSet = new Set<string>()
for (const p of paths) {
  const parts = p.split("/")
  for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/") + "/")
}
for (const d of dirSet) pathEntries.push({ path: d, isDir: true })

const VOCAB_A = ["get", "set", "create", "find", "search", "index", "build", "parse", "handle", "resolve", "load", "fetch"]
const VOCAB_B = ["File", "Index", "Chunk", "Store", "Service", "Session", "Event", "Cache", "Pool", "Worker", "Task", "Queue", "Node", "Path", "Entry", "Token", "Symbol", "Module", "Package", "Agent", "Client", "Server", "Schema", "User", "ById", "Controller", "Provider"]
function mulberry(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand0 = mulberry(42)
const pick0 = <T>(arr: T[]) => arr[(rand0() * arr.length) | 0]!
const symbols = Array.from({ length: 500_000 }, () => {
  const nWords = 1 + ((rand0() * 3) | 0)
  let name = ""
  for (let w = 0; w < nWords; w++) {
    const b = pick0(VOCAB_B)
    name += w === 0 ? pick0(VOCAB_A) : rand0() < 0.7 ? b : b.toLowerCase()
  }
  return { name, kind: "function", path: "src/x.ts", line: 1 }
})

console.log("preparing...")
const prepared = Matcher.prepare({ paths: pathEntries, symbols })
const session = Matcher.createSession(prepared)

// EXACT replica of bench labeled construction
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
for (let i = 0; i < 300; i++) addForms(pickR(realPaths), basenameOf(pickR(realPaths)))
for (let i = 0; i < 150; i++) {
  const s = pickR(symbols)
  addForms(`${s.name}\u0000${s.path}`, s.name)
}

const acro = labeled.filter((l) => l.form === "acronym")
console.log(`acronym pairs: ${acro.length}`)
let shown = 0
for (const l of acro) {
  if (shown >= 6) break
  const page = session.query(l.query, { limit: 30 })
  const [tPath, tName] = l.target.split("\u0000")
  const results = page.results.map((r) => (r.kind === "symbol" ? `${r.name}\u0000${r.path}` : r.path ?? ""))
  let rank = Infinity
  results.forEach((r, i) => {
    if (rank === Infinity && (tName !== undefined ? r === `${tName}\u0000${tPath}` : r === tPath)) rank = i + 1
  })
  shown++
  console.log(`\nquery="${l.query}" target=${tName ?? tPath} rank=${rank}`)
  for (const r of page.results.slice(0, 10)) {
    console.log(`   ${r.kind} ${r.kind === "symbol" ? r.name : r.path}`)
  }
}
