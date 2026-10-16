/**
 * Freshness probe: how long after create / rename / delete does an indexed path
 * become visible / invisible to the Everything SDK3 candidate provider?
 *
 * This is a MEASUREMENT HARNESS, not a product path. It writes throwaway files
 * under a scratch directory ON AN INDEXED VOLUME and polls the provider exactly
 * as production polls it (searchCandidatePage), so the measured latency is
 * "keystroke-visible freshness", not raw NTFS/ReFS cache behavior.
 *
 * It fails closed in the reporting sense: a run that never observes the
 * transition is recorded as `observed:false`, never as a fast transition.
 *
 * Usage:
 *   bun packages/core/script/everything-bench/freshness-probe.ts \
 *     --root=W:\ --scratch=.openfork-freshness-probe --rounds=9 --out=fresh.json
 */
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { searchCandidatePage } from "../../src/search/everything"

type Args = Record<string, string>
function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (const item of argv) {
    if (!item.startsWith("--")) continue
    const eq = item.indexOf("=")
    if (eq < 0) args[item.slice(2)] = "true"
    else args[item.slice(2, eq)] = item.slice(eq + 1)
  }
  return args
}

const POLL_MS = 2

async function visible(root: string, relative: string) {
  const page = await Effect.runPromise(
    searchCandidatePage({ root, query: path.basename(relative), count: 10_000 }),
  )
  if (page.status !== "measured") return undefined
  const key = relative.replaceAll("\\", "/").toLowerCase()
  return page.paths.some((entry) => entry.path.replaceAll("\\", "/").toLowerCase() === key)
}

/** Poll until `predicate` holds, or the deadline passes. */
async function until(predicate: () => Promise<boolean | undefined>, budgetMs: number) {
  const started = performance.now()
  for (;;) {
    const value = await predicate()
    if (value !== undefined) return { observed: true as const, ms: performance.now() - started }
    if (performance.now() - started > budgetMs) return { observed: false as const, ms: performance.now() - started }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(args.root ?? ".")
  const scratchName = args.scratch ?? ".openfork-freshness-probe"
  const rounds = Number(args.rounds ?? 9)
  const budgetMs = Number(args.budget ?? 10_000)
  const scratch = path.join(root, scratchName)

  const rows: Record<string, unknown>[] = []
  fs.mkdirSync(scratch, { recursive: true })
  try {
    for (let round = 0; round < rounds; round++) {
      const created = `${scratchName}/fresh-${round}-${process.pid}-${Date.now()}/target-token-${round}.ts`
      const renamed = `${scratchName}/fresh-${round}-${process.pid}-${Date.now()}/renamed-token-${round}.ts`
      const dir = path.dirname(path.join(root, created))

      // CREATE: write the file, then wait for the provider to return it.
      fs.mkdirSync(dir, { recursive: true })
      const createStart = performance.now()
      fs.writeFileSync(path.join(root, created), "// freshness probe\n")
      const create = await until(async () => {
        const seen = await visible(root, created)
        return seen === undefined ? undefined : seen
      }, budgetMs)
      const createTotalMs = performance.now() - createStart

      // RENAME: the old relative path must disappear and the new one appear.
      const renameStart = performance.now()
      fs.renameSync(path.join(root, created), path.join(root, renamed))
      const rename = await until(async () => {
        const gone = await visible(root, created)
        const appeared = await visible(root, renamed)
        if (gone === undefined || appeared === undefined) return undefined
        return !gone && appeared
      }, budgetMs)
      const renameTotalMs = performance.now() - renameStart

      // DELETE: the new relative path must disappear.
      const deleteStart = performance.now()
      fs.rmSync(path.join(root, renamed), { force: true })
      const remove = await until(async () => {
        const seen = await visible(root, renamed)
        return seen === undefined ? undefined : !seen
      }, budgetMs)
      const deleteTotalMs = performance.now() - deleteStart

      fs.rmSync(dir, { recursive: true, force: true })

      const row = {
        round,
        createMs: Math.round(create.ms * 100) / 100,
        createTotalMs: Math.round(createTotalMs * 100) / 100,
        renameMs: Math.round(rename.ms * 100) / 100,
        renameTotalMs: Math.round(renameTotalMs * 100) / 100,
        deleteMs: Math.round(remove.ms * 100) / 100,
        deleteTotalMs: Math.round(deleteTotalMs * 100) / 100,
        // A miss is a fail-closed observation, not a fast transition.
        allObserved: create.observed && rename.observed && remove.observed,
      }
      rows.push(row)
      console.error(JSON.stringify(row))
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }

  function summary(key: string) {
    const values = rows.map((row) => row[key] as number).sort((a, b) => a - b)
    if (values.length === 0) return undefined
    const at = (q: number) => Math.round(values[Math.min(values.length - 1, Math.ceil(q * values.length) - 1)]! * 100) / 100
    return { n: values.length, p50: at(0.5), p95: at(0.95), max: values.at(-1) }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    root,
    scratch,
    rounds,
    pollMs: POLL_MS,
    budgetMs,
    platform: process.platform,
    rows,
    summary: {
      create: summary("createMs"),
      rename: summary("renameMs"),
      delete: summary("deleteMs"),
      allObserved: rows.every((row) => row.allObserved === true),
    },
  }
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(out, null, 2))
    console.error(JSON.stringify({ wrote: args.out, summary: out.summary }))
  } else {
    console.log(JSON.stringify(out, null, 2))
  }
}

await main()