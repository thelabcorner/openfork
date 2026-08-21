import { readFileSync } from "node:fs"
import { Matcher } from "../src/search/matcher"

const REAL =
  "C:/Users/slooshied/.local/share/opencode/file-index/8477d838d1cb4e5e8a46e82e4b93ce516286fcf81e3a34bdc6a8ed61cad42577.json"
const doc = JSON.parse(readFileSync(REAL, "utf8")) as { subtrees: Record<string, { entries: { path: string }[] }> }
const paths: string[] = []
for (const tree of Object.values(doc.subtrees)) for (const e of tree.entries) paths.push(e.path)

const VOCAB_A = ["get", "find", "search", "build", "parse", "handle"]
const VOCAB_B = ["File", "User", "ById", "Schema", "Node", "Path"]
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
const syms = Array.from({ length: 50_000 }, () => {
  const b1 = pick(VOCAB_B)
  const b2 = pick(VOCAB_B)
  return { name: `${pick(VOCAB_A)}${b1}${b2}`, kind: "function", path: "src/x.ts", line: 1 }
})
const prepared = Matcher.prepare({ paths: paths.map((p) => ({ path: p, isDir: false })), symbols: syms })
const session = Matcher.createSession(prepared)

// find a getUserById-like symbol and query its acronym
const target = syms.find((s) => s.name === "getUserById")
console.log("target present:", target?.name)
if (target) {
  const page = session.query("gubi", { limit: 30 })
  console.log("top-10:")
  for (const r of page.results.slice(0, 10)) {
    console.log(`  ${r.kind} ${r.kind === "symbol" ? r.name : r.path}`)
  }
  const namesInTop10 = page.results.slice(0, 10).map((r) => (r.kind === "symbol" ? r.name : null))
  console.log("contains exact name:", namesInTop10.includes(target.name))
}
