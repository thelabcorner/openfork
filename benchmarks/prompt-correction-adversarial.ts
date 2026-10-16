/**
 * Deterministic adversarial grammar and complexity microbenchmark.
 * Run at repository root: bun benchmarks/prompt-correction-adversarial.ts
 *
 * Synthetic strings only. No model calls, data uploads, or user prompt capture.
 * Validates correctness with known patch counts on every iteration.
 */
import { correctPromptParts } from "../packages/app/src/components/prompt-input/correction"

const cases = [
  { label: "unmatched-open-brackets", value: "[".repeat(12_000) + " contienu", patches: 0 },
  { label: "unmatched-label-fragments", value: "[abc".repeat(3_000) + " contienu", patches: 0 },
  { label: "unclosed-destination", value: "Please contienu. [literal](contienu " + "x".repeat(10_000), patches: 1 },
  { label: "paired-quotes", value: '"'.repeat(12_000) + " contienu", patches: 1 },
  { label: "backticks", value: "`".repeat(12_000) + " contienu", patches: 0 },
  { label: "inline-links", value: "[aaa](foo) ".repeat(1_200) + "contienu", patches: 0 },
  { label: "ordinary-prose", value: "check the source carefully. ".repeat(440) + "contienu", patches: 1 },
] as const

const iterations = 121
for (const entry of cases) {
  const prompt = [{ type: "text" as const, content: entry.value, start: 0, end: entry.value.length }]
  for (let i = 0; i < 16; i++) correctPromptParts(prompt)
  const elapsed: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    const result = correctPromptParts(prompt)
    elapsed.push(performance.now() - start)
    if (result.patches.length !== entry.patches) {
      throw new Error(`Unexpected ${entry.label} patch count: ${result.patches.length} != ${entry.patches}`)
    }
  }
  elapsed.sort((a, b) => a - b)
  const ms = (fraction: number) => Number(elapsed[Math.floor((iterations - 1) * fraction)]!.toFixed(4))
  console.log(JSON.stringify({
    workload: entry.label,
    characters: entry.value.length,
    iterations,
    expectedPatches: entry.patches,
    p50Ms: ms(0.5),
    p95Ms: ms(0.95),
    p99Ms: ms(0.99),
  }))
}
