/**
 * Cold ChunkDB decompression/parse fairness benchmark.
 *
 * Workers decompress in parallel; completed JSON bodies are parsed on the main
 * thread one per scheduler turn. This benchmark reports the largest observed
 * event-loop gap while four jumbo completions settle.
 *
 * Run: bun run packages/core/test/bench-decompress-fairness.ts
 */
import { compressText } from "../src/database/json-codec"
import { decompressPoolClose, decompressValueAsync } from "../src/database/decompress-pool"

const encoder = new TextEncoder()
const MiB = 1024 * 1024
const payloadMiB = Number(process.env.BENCH_MIB ?? 16)
const count = Number(process.env.BENCH_COUNT ?? 4)

const frame = (index: number, mib: number) => {
  const stored = compressText(JSON.stringify({ index, text: "x".repeat(mib * MiB) }))
  return typeof stored === "string" ? encoder.encode(stored) : stored
}

// Warm worker startup independently from the measured burst.
await decompressValueAsync(frame(-1, 1))

const frames = Array.from({ length: count }, (_, index) => frame(index, payloadMiB))
let lastTick = performance.now()
let maxGap = 0
let ticks = 0
const timer = setInterval(() => {
  const now = performance.now()
  maxGap = Math.max(maxGap, now - lastTick)
  lastTick = now
  ticks += 1
}, 1)

const started = performance.now()
const decoded = await Promise.all(frames.map((value) => decompressValueAsync(value)))
const elapsed = performance.now() - started
await new Promise((resolve) => setTimeout(resolve, 3))
clearInterval(timer)

if (decoded.some((value, index) => (value.value as { index: number }).index !== index)) {
  throw new Error("decompression result mismatch")
}

console.log("\n=== Cold decompression parse fairness ===")
console.log(`${count} x ${payloadMiB} MiB JSON payloads`)
console.log(`total settlement: ${elapsed.toFixed(2)} ms`)
console.log(`max event-loop gap: ${maxGap.toFixed(2)} ms`)
console.log(`timer opportunities during burst: ${ticks}`)

await decompressPoolClose()
