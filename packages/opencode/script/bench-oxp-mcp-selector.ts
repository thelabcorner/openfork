/**
 * Read-only OXP MCP selector microbenchmark and reference-equivalence check.
 *
 * Run from the monorepo root:
 *   bun packages/opencode/script/bench-oxp-mcp-selector.ts
 *
 * Pure in-process CPU cost only. Excludes MCP enumeration, transport, root
 * verification, provider latency, permission checks and model inference.
 */
import { canonicalToolID, selectMcpTool } from "../src/oxp/mcp-selector"

type Tool = { readonly server: string; readonly name: string }

function reference(tools: readonly Tool[], selector: string) {
  const canonical = tools.filter((tool) => canonicalToolID(tool) === selector)
  if (canonical.length === 1) return { kind: "found", tool: canonical[0] }
  const bare = tools.filter((tool) => tool.name === selector)
  if (bare.length === 1) return { kind: "found", tool: bare[0] }
  if (bare.length > 1) return { kind: "ambiguous", candidates: bare.slice(0, 8).map(canonicalToolID) }
  return { kind: "missing" }
}

let seed = 0x02ac13
function random() {
  seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
  return seed / 0x1_0000_0000
}
const words = ["short", "lookup/item", "publish", "server", "fancy name", "x%20y", "percent%ZZ", "é", "工具"]
function sample() {
  return words[Math.floor(random() * words.length)]!
}
for (let i = 0; i < 2_000; i++) {
  const tools = Array.from({ length: Math.floor(random() * 18) }, () => ({
    server: sample(),
    name: sample(),
  }))
  const picked = tools[Math.floor(random() * tools.length)]
  const selector = picked
    ? random() < 0.5 ? picked.name : canonicalToolID(picked)
    : sample()
  const expected = reference(tools, selector)
  const actual = selectMcpTool(tools, selector)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Selector reference mismatch, case ${i}: ${JSON.stringify({ expected, actual, selector })}`)
  }
}

function median(values: number[]) {
  const ordered = values.toSorted((a, b) => a - b)
  return ordered[Math.floor(ordered.length / 2)]!
}

function measure(fn: () => unknown, iterations: number) {
  // Keep a real result consumer to prevent dead-code elimination.
  let found = 0
  for (let i = 0; i < 500; i++) {
    const result = fn() as { kind?: string }
    if (result?.kind === "found") found++
  }
  const samples: number[] = []
  for (let repeat = 0; repeat < 7; repeat++) {
    const t = performance.now()
    for (let i = 0; i < iterations; i++) {
      const result = fn() as { kind?: string }
      if (result?.kind === "found") found++
    }
    samples.push((performance.now() - t) * 1_000 / iterations)
  }
  if (found < 0) throw new Error("Impossible selector result")
  return median(samples)
}

for (const count of [32, 500, 3_000]) {
  const tools = Array.from({ length: count }, (_, i) => ({ server: `server-${i}`, name: `tool-${i}` }))
  const scenarios = [
    ["bare", tools[count - 1]!.name],
    ["canonical", canonicalToolID(tools[count - 1]!)],
    ["missing", "missing-tool"],
  ] as const
  for (const [scenario, selector] of scenarios) {
    const iterations = count > 500 ? 500 : 1_000
    const oldUs = measure(() => reference(tools, selector), iterations)
    const newUs = measure(() => selectMcpTool(tools, selector), iterations)
    console.log(JSON.stringify({
      count, scenario, referenceCases: 2_000,
      oldMedianUs: Number(oldUs.toFixed(3)),
      newMedianUs: Number(newUs.toFixed(3)),
      speedup: Number((oldUs / newUs).toFixed(2)),
      scope: "selector-only",
    }))
  }
}
