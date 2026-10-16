/** Characterize the small-group crossover for sparse vs member-scoped
 * summary computation. Synthetic pure JS only; no Solid tracking/rendering.
 * From packages/app: bun run benchmarks/session-preview-summary-scaling.bench.ts
 */
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { previewSparseSummary } from "../src/components/session-preview/session-preview-summary"

const status = { type: "busy" } as SessionStatus
const sparseEntries = [8, 32, 128, 512]
const sizes = [8, 32, 64, 128, 256, 512, 2_048, 8_192, 16_384]
const iterations = 150
const trials = 5
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!

for (const states of sparseEntries) {
  const statuses = Object.fromEntries(Array.from({ length: states }, (_, i) => [`ses_${i * 5}`, status]))
  const permissions = { ses_5: [{}] }
  const questions = { ses_10: [{}] }
  const paused = { ses_0: true }
  for (const size of sizes) {
    const weights = new Map(Array.from({ length: size }, (_, i) => [`ses_${i}`, 1] as const))
    const before = () => {
      let running = 0
      let waiting = 0
      for (const [id, weight] of weights) {
        if (permissions[id as keyof typeof permissions]?.length || questions[id as keyof typeof questions]?.length)
          waiting += weight
        else if (statuses[id]?.type === "busy" && !paused[id as keyof typeof paused]) running += weight
      }
      return { running, waiting }
    }
    const after = () => previewSparseSummary({ weights, statuses, paused, permissions, questions })
    if (JSON.stringify(before()) !== JSON.stringify(after())) throw Error(`parity mismatch ${size}/${states}`)
    const legacy: number[] = []
    const sparse: number[] = []
    for (let trial = -1; trial < trials; trial++) {
      for (const optimize of trial % 2 ? [true, false] : [false, true]) {
        const start = performance.now()
        for (let iteration = 0; iteration < iterations; iteration++) optimize ? after() : before()
        const elapsed = performance.now() - start
        if (trial >= 0) (optimize ? sparse : legacy).push(elapsed)
      }
    }
    const ms = median(legacy)
    const sparseMs = median(sparse)
    console.log(JSON.stringify({
      members: size, statusEntries: states, baselineMs: +ms.toFixed(4),
      sparseMs: +sparseMs.toFixed(4), ratio: +(ms / sparseMs).toFixed(2),
    }))
  }
}