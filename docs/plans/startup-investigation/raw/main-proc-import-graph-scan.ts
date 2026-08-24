// STARTUP-AUTOPSY: temporary static import-graph scanner (lane main-proc).
// Walks ESM import edges from packages/desktop/src/main/index.ts within src/,
// records external package imports per module. Read-only; not part of the app.
const root = "C:/Users/slooshied/WebstormProjects/opencode/packages/desktop"
const entry = `${root}/src/main/index.ts`

const seen = new Set()
const externals = new Map()
const queue = [entry]
let edgeCount = 0

function resolve(from, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null
  const base = spec.startsWith("/") ? `${root}${spec}` : new URL(spec, `file://${from}`).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}.json`]
  return candidates.find((c) => {
    try { return Deno ? false : require("node:fs").statSync(c).isFile() } catch { return false }
  })
}

const fs = await import("node:fs")
function resolve2(from, spec) {
  if (!spec.startsWith(".")) return null
  const base = new URL(spec, `file:///${from.replaceAll("\\", "/")}`).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}.json`]) {
    try { if (fs.statSync(c).isFile()) return c } catch {}
  }
  return null
}

while (queue.length) {
  const file = queue.shift()
  if (seen.has(file)) continue
  seen.add(file)
  const src = fs.readFileSync(file, "utf8")
  const re = /(?:^|\n)\s*(?:import|export)[^'"]*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*\(\s*["']([^"']+)["']\s*\)/g
  let m
  while ((m = re.exec(src))) {
    const spec = m[1] ?? m[2]
    if (!spec) continue
    edgeCount++
    if (!spec.startsWith(".")) {
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
      if (!externals.has(pkg)) externals.set(pkg, [])
      externals.get(pkg).push(`${file.replace(root + "/", "")}`)
      continue
    }
    const resolved = resolve2(file, spec)
    if (resolved && !resolved.includes(".test.") && resolved.endsWith(".ts")) queue.push(resolved)
  }
}

console.log(`internal modules reachable from src/main/index.ts: ${seen.size}`)
console.log(`total import edges (incl. type-only): ${edgeCount}`)
console.log(`external packages imported somewhere in graph:`)
for (const [pkg, files] of [...externals].sort()) console.log(`  ${pkg}  (${files.length} importer(s), e.g. ${files[0]})`)
