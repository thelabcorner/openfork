/**
 * Deterministic local prompt correction microbenchmark.
 *
 * Run from the repository root: bun benchmarks/prompt-correction.ts
 * Measurements cover parser + UTF-16 remapping ONLY, not UI, network or LLM.
 * No sampled user content or telemetry is collected.
 */
import { correctPromptParts, type PromptCorrectionOptions } from "../packages/app/src/components/prompt-input/correction"
import type { Prompt } from "../packages/app/src/context/prompt-state"

function measure(label: string, prompt: Prompt, iterations: number, expected: number, options?: PromptCorrectionOptions) {
  const observed: number[] = []
  for (let i = 0; i < 64; i++) correctPromptParts(prompt, true, options)
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    const result = correctPromptParts(prompt, true, options)
    observed.push(performance.now() - start)
    if (result.patches.length !== expected)
      throw new Error(`Benchmark output changed for ${label}: expected ${expected}, saw ${result.patches.length}`)
  }
  observed.sort((a, b) => a - b)
  const quantile = (fraction: number) => Number(observed[Math.floor((iterations - 1) * fraction)]!.toFixed(4))
  return {
    label,
    characters: prompt.reduce((sum, part) => sum + (part.type === "image" ? 0 : part.content.length), 0),
    parts: prompt.length,
    iterations,
    expectedPatches: expected,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    mode: "warm synthetic single-thread",
  }
}

function prose(content: string): Prompt {
  return [{ type: "text", content, start: 0, end: content.length }]
}
const sample = "Please check the renderer state, provider quota, file references, and performance counters carefully. "
const typical = (chars: number) =>
  prose(("Contienu the reasearch. " + sample.repeat(Math.ceil(chars / sample.length))).slice(0, chars))
const dense = prose('"contienu" '.repeat(1_000) + "contienu ".repeat(120))
const structured: Prompt = []
let offset = 0
for (let i = 0; i < 420; i++) {
  const content = i % 7 === 0 ? " contienu " : " stable "
  structured.push({ type: "text", content, start: offset, end: offset + content.length })
  offset += content.length
  const token = "@agent"
  structured.push({ type: "agent", name: "agent", content: token, start: offset, end: offset + token.length })
  offset += token.length
}

console.log(JSON.stringify([
  measure("typical-1k", typical(1_000), 3_000, 2),
  measure("typical-10k", typical(10_000), 1_000, 2),
  measure("typical-10k-reviewed-first-only", typical(10_000), 1_000, 1, { selectedPatchStarts: new Set([0]) }),
  measure("clean-10k", prose(("Inspect all the renderer and session state carefully without deleting any source files. ").repeat(130).slice(0, 10_000)), 1_000, 0),
  measure("dense-quoted-literals-12k", dense, 1_000, 120),
  measure("dense-quoted-literals-reviewed-one", dense, 1_000, 1, { selectedPatchStarts: new Set([11_000]) }),
  measure("structured-references-840-parts", structured, 1_000, 60),
], null, 2))
