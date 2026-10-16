/**
 * Reproducible, isolated OXP production-host cold-start benchmark.
 *
 * bun packages/opencode/script/bench-oxp-host-lazy.ts
 *
 * Every sample uses a fresh child process, XDG config/cache/data/state roots
 * in its own disposable OS temp directory, and a disposable approved workspace.
 * No live desktop, user OXP config, tunnel, or provider credentials are used.
 * This probes enabled listener readiness, initialize/list, 100 first calls,
 * and revocation. Not a live Cloud tunnel benchmark.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const script = path.resolve(import.meta.dir, "../test/oxp/fixture-host-lazy.ts")
const pkg = path.resolve(import.meta.dir, "..")
const samples = 3
const names = ["OXP_READY", "OXP_LIST", "OXP_EXEC", "OXP_REVOKED"] as const
const results: Record<string, number>[] = []

for (let i = 0; i < samples; i++) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-host-cold-"))
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_DATA_HOME: path.join(dir, "data"),
    XDG_STATE_HOME: path.join(dir, "state"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
    OPENCODE_TEST_HOME: path.join(dir, "home"),
    OXP_LAZY_FIXTURE_ROOT: path.join(dir, "workspace"),
  }
  try {
    const child = Bun.spawn([process.execPath, script], {
      cwd: pkg, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exit !== 0) {
      throw new Error("OXP startup probe failed: " + stderr.slice(-2500) + "\n" + stdout.slice(-1500))
    }
    const row: Record<string, number> = {}
    for (const key of names) {
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith(key + " "))
      if (!line) throw new Error("Missing startup phase " + key)
      const phase = JSON.parse(line.slice(key.length + 1)) as Record<string, unknown>
      if (typeof phase.ms === "number") row[key + ".ms"] = phase.ms
      if (typeof phase.heapMiB === "number") row[key + ".heapMiB"] = phase.heapMiB
      if (typeof phase.count === "number") row[key + ".count"] = phase.count
    }
    results.push(row)
    console.log(JSON.stringify({ sample: i + 1, ...row }))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}
const fields = Object.keys(results[0]!)
console.log(JSON.stringify({
  samples,
  median: Object.fromEntries(fields.map((key) => [key, median(results.map((row) => row[key]!))])),
  caveat: "Enabled host lifecycle under disposable XDG state. Never assume comparability with different-workload historical import-only timings or live tunnel calls.",
}))
