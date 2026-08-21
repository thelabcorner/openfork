// Per-keystroke timing over ALL stream keys against the FULL prepared index
import { readFileSync } from "node:fs"
import { Matcher } from "../src/search/matcher"

const REAL =
  "C:/Users/slooshied/.local/share/opencode/file-index/8477d838d1cb4e5e8a46e82e4b93ce516286fcf81e3a34bdc6a8ed61cad42577.json"
const doc = JSON.parse(readFileSync(REAL, "utf8")) as { subtrees: Record<string, { entries: { path: string }[] }> }
const paths: string[] = []
for (const tree of Object.values(doc.subtrees)) for (const e of tree.entries) paths.push(e.path)
const pathEntries = paths.map((p) => ({ path: p, isDir: false as const }))
const dirSet = new Set<string>()
for (const p of paths) {
  const parts = p.split("/")
  for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/") + "/")
}
for (const d of dirSet) pathEntries.push({ path: d, isDir: true })

const VOCAB_A = ["get", "set", "find", "search", "index", "build", "parse", "handle", "resolve", "load", "fetch"]
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
const rand = mulberry(42)
const pick = <T>(arr: T[]) => arr[(rand() * arr.length) | 0]!
const syms = Array.from({ length: 500_000 }, () => {
  const nWords = 1 + ((rand() * 3) | 0)
  let name = ""
  for (let w = 0; w < nWords; w++) {
    const b = pick(VOCAB_B)
    name += w === 0 ? pick(VOCAB_A) : rand() < 0.7 ? b : b.toLowerCase()
  }
  return { name, kind: "function", path: "src/x.ts", line: 1 }
})

console.log("preparing...")
const t0 = performance.now()
const prepared = Matcher.prepare({ paths: pathEntries, symbols: syms })
console.log(`prepared in ${((performance.now() - t0) / 1000).toFixed(1)}s`)

const SOURCES = ["packages", "FileSystemSearch", "getUserById", "findfile", "src search", "config", "handler", "schema", "gubi", "chunkstore", "session", "plugin"]
const keys: string[] = []
for (const src of SOURCES) {
  for (let i = 1; i <= src.length; i++) keys.push(src.slice(0, i))
  for (let i = src.length - 1; i >= 1; i--) keys.push(src.slice(0, i))
  if (src.length > 4) keys.push(src.slice(0, 3) + "x" + src.slice(4))
}

const session = Matcher.createSession(prepared)
// warm every key once
for (const k of keys) session.query(k, { limit: 30 })
console.log("warmed. measuring...")
let worst = { key: "", ms: 0 }
const slow: string[] = []
const tAll = performance.now()
for (let pass = 0; pass < 3; pass++) {
  for (const k of keys) {
    const t = performance.now()
    session.query(k, { limit: 30 })
    const ms = performance.now() - t
    if (ms > worst.ms) worst = { key: k, ms }
    if (ms > 100) slow.push(`${k}: ${ms.toFixed(0)}ms`)
  }
}
console.log(`total ${(performance.now() - tAll) / 1000}s over ${keys.length * 3} queries`)
console.log(`worst: "${worst.key}" ${worst.ms.toFixed(1)}ms`)
console.log(`slow (>100ms): ${slow.length}`)
for (const s of slow.slice(0, 20)) console.log(`   ${s}`)
