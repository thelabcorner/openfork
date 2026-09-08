/**
 * Reproducible @-mention latency benchmark.
 *
 * Compares the old file-only path (full Matcher.prepare + warm query) with the
 * scan-first file picker used by Prompt Input V2. Run from packages/core:
 *
 *   bun test/bench-mention-fast.ts
 */
import { Matcher } from "../src/search/matcher"
import { searchFileMentionsFast } from "../src/search/mention-fast"

const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]!

function sample(run: () => void, iterations = 20) {
  const values: number[] = []
  for (let i = 0; i < iterations; i++) {
    const started = performance.now()
    run()
    values.push(performance.now() - started)
  }
  return median(values)
}

function benchmark(name: string, paths: string[]) {
  const rows = paths.map((path) => ({ path, isDir: false }))
  const start = performance.now()
  const prepared = Matcher.prepare({ paths: rows, symbols: [] })
  const legacyPrepareMs = performance.now() - start
  const legacy = Matcher.createSession(prepared)
  const queries = ["s", "se", "search", "prompt", "dialog", "model", "index", "mention"]

  const coldStart = performance.now()
  searchFileMentionsFast(rows, { query: "s", limit: 200, offset: 0 })
  const fastColdMs = performance.now() - coldStart

  const legacyHot = queries.map((query) =>
    sample(() => legacy.query(query, { limit: 200, symbols: false })),
  )
  const fastHot = queries.map((query) =>
    sample(() => searchFileMentionsFast(rows, { query, limit: 200, offset: 0 })),
  )

  console.log(
    JSON.stringify({
      name,
      paths: rows.length,
      legacyPrepareMs: Number(legacyPrepareMs.toFixed(2)),
      legacyHotMedianMs: Number(median(legacyHot).toFixed(3)),
      fastColdMs: Number(fastColdMs.toFixed(3)),
      fastHotMedianMs: Number(median(fastHot).toFixed(3)),
      fastWorstQueryMs: Number(Math.max(...fastHot).toFixed(3)),
    }),
  )
}

const rg = Bun.spawn(["rg", "--files"], { cwd: "../..", stdout: "pipe" })
const repoPaths = (await new Response(rg.stdout).text())
  .trim()
  .split(/\r?\n/)
  .map((path) => path.replaceAll("\\", "/"))
  .filter(Boolean)
await rg.exited
benchmark("opencode-real", repoPaths)

for (const count of [100_000, 250_000]) {
  benchmark(
    `synthetic-${count}`,
    Array.from(
      { length: count },
      (_, i) => `packages/pkg${i % 300}/src/components/feature-${i % 1000}/dialog-select-model-${i}.tsx`,
    ),
  )
}
