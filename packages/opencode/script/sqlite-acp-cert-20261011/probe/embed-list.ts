// App-mode embedded-FS diagnostic. Lists the compiled binary's virtual root and
// probes specific paths, so we can see where a nested worker entrypoint is
// actually embedded (vs where the worker URL expects it).

import { existsSync, readdirSync, statSync } from "node:fs"

const roots = ["B:/~BUN/root", "/$bunfs/root"]
const report: Record<string, unknown> = { importMetaUrl: import.meta.url, execPath: process.execPath }
for (const root of roots) {
  try {
    const entries = readdirSync(root, { recursive: true }) as string[]
    report[root] = entries.slice(0, 200)
  } catch (error) {
    report[root] = `ERR ${(error as Error).message}`
  }
}
for (const candidate of [
  "B:/~BUN/root/sqlite-bun-worker.ts",
  "B:/~BUN/root/sqlite-bun-worker.js",
  "/$bunfs/root/sqlite-bun-worker.ts",
]) {
  try {
    report[candidate] = { exists: existsSync(candidate), bytes: existsSync(candidate) ? statSync(candidate).size : 0 }
  } catch (error) {
    report[candidate] = `ERR ${(error as Error).message}`
  }
}
console.log(JSON.stringify(report))
