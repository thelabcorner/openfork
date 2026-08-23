// STARTUP-AUTOPSY: vite-lane renderer dev-server probe.
// Env-gated by design: only does anything when invoked directly
// (`bun startup-investigation/raw/vite-lane-renderer-probe.ts --label <name>`).
// Measures electron-vite renderer dev-server phases via vite JS API:
//   config-resolve -> createServer -> listen -> warmupRequest("/") graph crawl.
// Uses a PRIVATE cacheDir (raw/vite-lane-probe-cache) so the shared
// packages/desktop/node_modules/.vite cache is never touched (user's live
// dev instance may hold it open; peers' trials depend on its state).
// COLD = first run into empty private dir; WARM = any subsequent run.
// DEBUG=vite:deps,vite:transform output is timestamped to raw/vite-lane-<label>.log.
import { performance } from "node:perf_hooks"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const label = process.argv[process.argv.indexOf("--label") + 1] ?? "run"
const rawDir = path.resolve(import.meta.dir)
const desktopDir = path.resolve(rawDir, "../../packages/desktop")
process.chdir(desktopDir)

process.env.DEBUG = "vite:deps,vite:transform"

// Resolve through packages/desktop's graph so we get the SAME vite instance
// electron-vite uses (single module identity for plugin compatibility).
const desktopRequire = createRequire(path.join(desktopDir, "package.json"))

const logPath = path.join(rawDir, `vite-lane-${label}.log`)
const t0 = performance.now()
const stamp = (msg: string) => {
  const line = `[${(performance.now() - t0).toFixed(0)}ms] ${msg}`
  appendFileSync(logPath, line + "\n")
}
appendFileSync(logPath, `=== probe ${label} start ${new Date().toISOString()} ===\n`)

// Wrap console AND process.stderr.write so vite's `debug` output
// (vite:deps, vite:transform — written to stderr) gets timestamps too.
const origLog = console.log
console.log = (...args: unknown[]) => {
  stamp(args.map(String).join(" "))
}
const origErrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  const text = typeof chunk === "string" ? chunk : String(chunk)
  for (const line of text.split("\n")) {
    if (line.trim()) stamp(line.replace(/\x1b\[[0-9;]*m/g, ""))
  }
  return origErrWrite(chunk, ...rest)
}) as typeof process.stderr.write

const { resolveConfig } = await import(pathToFileURL(desktopRequire.resolve("electron-vite")).href)
const resolved = await resolveConfig({}, "serve")
const tConfig = performance.now() - t0

const rendererConfig = resolved.config.renderer
rendererConfig.cacheDir = path.join(rawDir, "vite-lane-probe-cache") // STARTUP-AUTOPSY: private cache
rendererConfig.server = { ...rendererConfig.server, port: 5179, strictPort: false }
rendererConfig.customLogger = {
  info: (m: string) => stamp(m.replace(/\n/g, " | ")),
  warn: (m: string) => stamp("WARN " + m.replace(/\n/g, " | ")),
  error: (m: string) => stamp("ERR " + m.replace(/\n/g, " | ")),
  warnOnce: (m: string) => stamp("WARN_ONCE " + m.replace(/\n/g, " | ")),
  hasWarned: false,
  clearScreen: () => {},
}

const t1 = performance.now()
const { createServer } = await import(pathToFileURL(desktopRequire.resolve("vite")).href)
const server = await createServer(rendererConfig)
const tCreate = performance.now() - t1

const t2 = performance.now()
await server.listen()
const tListen = performance.now() - t2
stamp(`LISTEN ${server.resolvedUrls?.local?.[0]}`)

// warmupRequest("/") does not recurse into the entry script in vite 7.1,
// so crawl the static import graph ourselves: transform each module and
// follow the import specifiers vite rewrote into the code (browser-faithful).
// Skips pre-bundled dep chunks (cache dir), vite client internals, and
// dynamic imports (lazy routes are not startup work).
const SKIP = [/vite-lane-probe-cache/, /node_modules\/\.vite\//, /^\/@vite\//, /^\/@solid-refresh/, /\0/]
const crawl = async (entryUrl: string) => {
  const seen = new Set<string>()
  const queue = [entryUrl]
  let count = 0
  while (queue.length > 0 && seen.size < 5000) {
    const url = queue.shift()!
    if (seen.has(url)) continue
    seen.add(url)
    if (SKIP.some((re) => re.test(url))) continue
    try {
      const result = await server.transformRequest(url)
      count++
      if (!result?.code) continue
      const re = /\bimport\s*(?:[\s\S]*?from\s*)?["']([^"']+)["']/g
      let m: RegExpExecArray | null
      while ((m = re.exec(result.code))) {
        const spec = m[1]
        if (spec.startsWith("/") || spec.startsWith(".")) queue.push(spec)
      }
    } catch {
      // unresolvable entries are fine to skip
    }
  }
  return count
}

const t3 = performance.now()
// Wrap transformRequest to attribute queue-wait vs service time.
const origTransform = server.transformRequest.bind(server)
let inflight = 0
let maxInflight = 0
server.transformRequest = async (url: string, opts?: unknown) => {
  const start = performance.now()
  inflight++
  maxInflight = Math.max(maxInflight, inflight)
  stamp(`T_START depth=${inflight} ${url}`)
  try {
    return await origTransform(url, opts as never)
  } finally {
    inflight--
    stamp(`T_END waited=${(performance.now() - start).toFixed(0)}ms ${url}`)
  }
}
const crawled = await crawl("/index.tsx")
stamp(`CRAWL_DONE modules=${crawled} maxInflight=${maxInflight}`)
const tWarmup = performance.now() - t3

// Wait for the dep optimizer to finish writing its cache (cold runs bundle
// ~50 deps incl. shiki's ~1000 grammar chunks; can take tens of seconds).
const depsDir = path.join(rendererConfig.cacheDir, "deps")
const metaPath = path.join(depsDir, "_metadata.json")
let optimizerDone = false
const t4 = performance.now()
while (performance.now() - t4 < 180_000) {
  if (appendFileSync && (await Bun.file(metaPath).exists())) {
    optimizerDone = true
    break
  }
  await new Promise((r) => setTimeout(r, 250))
}
const tOptimizer = performance.now() - t4
stamp(`OPTIMIZER_DONE ${optimizerDone} after ${tOptimizer.toFixed(0)}ms`)

// Second crawl now that optimized deps exist: measures warm transform wave.
const t5 = performance.now()
const crawled2 = await crawl("/index.tsx")
stamp(`CRAWL2_DONE modules=${crawled2}`)
const tWarmup2 = performance.now() - t5

const total = performance.now() - t0

stamp(
  `RESULT {"label":"${label}","t_config_ms":${tConfig.toFixed(0)},"t_create_ms":${tCreate.toFixed(0)},"t_listen_ms":${tListen.toFixed(0)},"t_warmup_ms":${tWarmup.toFixed(0)},"t_optimizer_ms":${tOptimizer.toFixed(0)},"optimizer_done":${optimizerDone},"t_warmup2_ms":${tWarmup2.toFixed(0)},"total_ms":${total.toFixed(0)},"cacheDir":"${rendererConfig.cacheDir}"}`,
)
console.log = origLog
console.log(
  JSON.stringify({
    label,
    t_config_ms: Math.round(tConfig),
    t_create_ms: Math.round(tCreate),
    t_listen_ms: Math.round(tListen),
    t_warmup_ms: Math.round(tWarmup),
    t_optimizer_ms: Math.round(tOptimizer),
    optimizer_done: optimizerDone,
    t_warmup2_ms: Math.round(tWarmup2),
    total_ms: Math.round(total),
  }),
)

// Hard exit: server.close() can hang while HMR watchers/optimizer workers
// are still winding down; we only need the numbers.
process.exit(0)
