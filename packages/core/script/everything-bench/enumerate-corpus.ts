/**
 * Materialize a real relative-path corpus for the Everything SDK3 provider
 * benchmark.
 *
 * This is a MEASUREMENT HARNESS, not a product path. It walks a root with the
 * same visibility rules native FileSystemSearch applies to provider candidates
 * (no dot-segment directories, no empty segments) so the native corpus and the
 * candidate universe describe the same set of rows. Reparse points are not
 * followed so the walk cannot escape the requested root or loop.
 *
 * Usage:
 *   bun packages/core/script/everything-bench/enumerate-corpus.ts <root> <out.json> [--max=N] [--skip-hidden]
 *
 * Output is a JSON object: { root, generatedAt, truncated, entries: string[] }
 * where every entry is a root-relative forward-slash path.
 */
import fs from "node:fs"
import path from "node:path"

function visible(relative: string) {
  if (!relative) return false
  if (relative.startsWith("../") || path.isAbsolute(relative)) return false
  return !relative.split("/").some((segment) => segment === "" || segment.startsWith("."))
}

export function enumerate(root: string, max: number, skipHidden: boolean) {
  const canonical = path.resolve(root)
  const entries: string[] = []
  const stack: string[] = [""]
  let truncated = false
  while (stack.length > 0) {
    const current = stack.pop()!
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(current ? path.join(canonical, current) : canonical, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      const relative = current ? `${current}/${dirent.name}` : dirent.name
      // Mirrors normalizeCandidate: dot-segments are not provider-visible rows.
      if (!visible(relative)) continue
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        if (skipHidden && dirent.name.startsWith(".")) continue
        stack.push(relative)
        continue
      }
      if (!dirent.isFile()) continue
      entries.push(relative)
      if (entries.length >= max) {
        truncated = true
        stack.length = 0
        break
      }
    }
  }
  entries.sort()
  return { root: canonical, entries, truncated }
}

if (import.meta.main) {
  const [root, out, ...rest] = process.argv.slice(2)
  if (!root || !out) {
    console.error("usage: enumerate-corpus.ts <root> <out.json> [--max=N] [--skip-hidden]")
    process.exit(2)
  }
  const maxArg = rest.find((value) => value.startsWith("--max="))
  const max = maxArg ? Number(maxArg.slice("--max=".length)) : Number.POSITIVE_INFINITY
  const skipHidden = rest.includes("--skip-hidden")
  const started = performance.now()
  const result = enumerate(root, max, skipHidden)
  fs.writeFileSync(
    out,
    JSON.stringify({
      root: result.root,
      generatedAt: new Date().toISOString(),
      truncated: result.truncated,
      entries: result.entries,
    }),
  )
  console.log(
    JSON.stringify({
      root: result.root,
      entries: result.entries.length,
      truncated: result.truncated,
      ms: Math.round(performance.now() - started),
      out,
    }),
  )
}