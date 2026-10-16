/**
 * Reproducible read-only OXP module-import phase probe.
 *
 * From monorepo root:
 *   bun packages/opencode/script/bench-oxp-import-phases.ts
 *
 * Each sample uses a fresh child process. This measures module evaluation and
 * its transitive import graph, NOT endpoint ready time, browser/tunnel login,
 * disk cold cache, or session/workspace execution. No endpoint is activated.
 */
const runs = 5
const program = [
  "const start = performance.now();",
  "await import('./packages/opencode/src/oxp/host.ts');",
  "const host = performance.now();",
  "await import('./packages/opencode/src/oxp/active-runtime.ts');",
  "const active = performance.now();",
  "console.log(JSON.stringify({ hostMs: host - start, activeIncrementMs: active - host, totalMs: active - start, heapMiB: process.memoryUsage().heapUsed / 1048576 }))",
].join("\n")

async function probe() {
  // process.execPath prevents Windows .cmd argument escaping from changing
  // embedded JS; child stdout/stderr stay bounded by this one JSON result.
  const child = Bun.spawn([process.execPath, "-e", program], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0) throw new Error(`OXP import probe failed (${exit}): ${stderr.slice(0, 3_000)}`)
  const result = JSON.parse(stdout.trim()) as Record<string, number>
  for (const field of ["hostMs", "activeIncrementMs", "totalMs", "heapMiB"]) {
    if (!Number.isFinite(result[field]) || result[field]! < 0) throw new Error(`Invalid ${field} in OXP import probe`)
  }
  return result
}

function statistics(values: readonly number[]) {
  const ordered = values.toSorted((a, b) => a - b)
  return {
    median: Math.round(ordered[Math.floor(ordered.length / 2)]! * 1_000) / 1_000,
    min: Math.round(ordered[0]! * 1_000) / 1_000,
    max: Math.round(ordered[ordered.length - 1]! * 1_000) / 1_000,
  }
}

const samples: Array<Record<string, number>> = []
for (let i = 0; i < runs; i++) samples.push(await probe())
console.log(JSON.stringify({
  workload: "OXP import phases, child-process fresh per sample",
  samples: runs,
  hostImportMs: statistics(samples.map((row) => row.hostMs)),
  activeImportIncrementMs: statistics(samples.map((row) => row.activeIncrementMs)),
  combinedImportMs: statistics(samples.map((row) => row.totalMs)),
  heapAfterImportMiB: statistics(samples.map((row) => row.heapMiB)),
  caveat: "No endpoint activation; OS file caches may be warm. Does not measure live ChatGPT MCP latency.",
}))
