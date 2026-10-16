/**
 * SDK3 wire audit — STAGE 2: drive the REAL production provider against the
 * live isolated instance and report what the shipped decoder actually does.
 *
 * Diagnostic only. This is an oracle/observation script, not a product path.
 * Run: bun packages/core/script/everything-bench/sdk3-provider-probe.ts [root]
 */
import { Effect } from "effect"
import {
  searchCandidatePage,
  searchCandidatesExhaustive,
  searchCandidates,
} from "../../src/search/everything"

const root = process.argv[2] ?? "C:\\Users\\slooshied\\WebstormProjects\\opencode"
const query = process.argv[3] ?? "search"

const summarize = (label: string, value: unknown) => {
  const r = value as Record<string, unknown>
  console.log(
    `[${label}] status=${r.status} reason=${r.reason ?? "-"} detail=${r.detail ?? "-"} ` +
      `paths=${Array.isArray(r.paths) ? r.paths.length : "-"} complete=${r.complete} ` +
      `requiredCount=${r.requiredCount} exhaustible=${r.exhaustible} ` +
      `basenameSubsequenceComplete=${r.basenameSubsequenceComplete ?? "-"} ` +
      `discarded=${Array.isArray(r.discardedPaths) ? r.discardedPaths.length : "-"}`,
  )
}

async function timed(label: string, run: () => Promise<unknown>) {
  const t0 = performance.now()
  try {
    const value = await run()
    const ms = performance.now() - t0
    summarize(label, value)
    console.log(`  elapsed=${ms.toFixed(1)}ms`)
    return value
  } catch (error) {
    const ms = performance.now() - t0
    console.log(`[${label}] THREW after ${ms.toFixed(1)}ms: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

console.log(`root=${root}`)
console.log(`query=${query}`)
console.log(`runtime bun=${(process as { isBun?: boolean }).isBun ? "yes" : "no"} node=${process.version}`)

for (const count of [10, 50, 200, 512, 1000, 3053, 10000]) {
  await timed(`page count=${count}`, () =>
    Effect.runPromise(searchCandidatePage({ root, query, count })),
  )
}

await timed("exhaustive initial=1", () =>
  Effect.runPromise(searchCandidatesExhaustive({ root, query, initialCount: 1 })),
)

await timed("exhaustive initial=512", () =>
  Effect.runPromise(searchCandidatesExhaustive({ root, query, initialCount: 512 })),
)

await timed("exhaustive initial=10000", () =>
  Effect.runPromise(searchCandidatesExhaustive({ root, query, initialCount: 10_000 })),
)

await timed("plain searchCandidates count=3053", () =>
  Effect.runPromise(searchCandidates({ root, query, count: 3053 })),
)

console.log("\nAUDIT-STAGE-2-COMPLETE")
process.exit(0)