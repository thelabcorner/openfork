// STARTUP-AUTOPSY: summarize self-time by top functions from a .cpuprofile
import { readFileSync } from "node:fs"

const file = process.argv[2]
const profile = JSON.parse(readFileSync(file, "utf8"))
const { nodes, samples, timeDeltas } = profile
const byId = new Map(nodes.map((n) => [n.id, n]))
const self = new Map()
let total = 0
for (let i = 0; i < samples.length; i++) {
  const us = timeDeltas[i] ?? 0
  total += us
  self.set(samples[i], (self.get(samples[i]) ?? 0) + us)
}
const rows = [...self.entries()]
  .map(([id, us]) => {
    const n = byId.get(id)
    const f = n.callFrame
    const name = f.functionName || "(anonymous)"
    const url = (f.url || "").replace(/^file:\/\/\/C:\/Users\/slooshied\/WebstormProjects\/opencode\//, "")
    return { name, url: url + (f.lineNumber >= 0 ? ":" + (f.lineNumber + 1) : ""), ms: +(us / 1000).toFixed(1) }
  })
  .sort((a, b) => b.ms - a.ms)
console.log("total_sampled_ms", +(total / 1000).toFixed(0))
console.log("top self-time:")
for (const r of rows.slice(0, 30)) console.log(String(r.ms).padStart(8), r.name.slice(0, 60), "@", r.url.slice(0, 90))

// aggregate by top-level segment of url
const agg = new Map()
for (const r of rows) {
  const seg = r.url.includes("/dist/node/") ? "dist/node bundle" : r.url.includes("node:") ? "node internals" : r.url.includes("effect") ? "effect pkg" : r.url ? r.url.split("/").slice(0, 2).join("/") : "(program/idle)"
  agg.set(seg, (agg.get(seg) ?? 0) + r.ms)
}
console.log("\nby segment:")
for (const [k, v] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(+v.toFixed(0)).padStart(8), k)
