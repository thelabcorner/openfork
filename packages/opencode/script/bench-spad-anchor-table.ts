import { DEFAULT_SPAD_CONFIG } from "../src/session/spad/config"
import { SpadDetector } from "../src/session/spad/detector"
import { makeTurnPolicy } from "../src/session/spad/intent"
import { SpadSupervisor } from "../src/session/spad/supervisor"
import type { SpadConfig } from "../src/session/spad/types"

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function fixture(size = 1 << 20) {
  let x = 0x51adbeef >>> 0
  const chars = new Array<string>(size)
  for (let i = 0; i < size; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    const r = x >>> 0
    // Healthy-ish printable ASCII with realistic whitespace frequency.
    chars[i] = r % 17 === 0 ? " " : r % 113 === 0 ? "\n" : String.fromCharCode(33 + (r % 94))
  }
  return chars.join("")
}

const input = fixture()

function detectorThroughput(config: SpadConfig, channel: "text" | "reasoning") {
  const samples: number[] = []
  for (let sample = 0; sample < 11; sample++) {
    const detector = new SpadDetector({ channel, config })
    const start = Bun.nanoseconds()
    for (let i = 0; i < input.length; i += 256) detector.push(input.slice(i, i + 256))
    const elapsed = Bun.nanoseconds() - start
    if (sample >= 2) samples.push(elapsed / input.length)
  }
  return median(samples)
}

function detectorConstruction(config: SpadConfig, channel: "text" | "reasoning") {
  const samples: number[] = []
  for (let sample = 0; sample < 9; sample++) {
    const start = Bun.nanoseconds()
    for (let i = 0; i < 500; i++) new SpadDetector({ channel, config })
    const elapsed = Bun.nanoseconds() - start
    if (sample >= 2) samples.push(elapsed / 500)
  }
  return median(samples)
}

function detectorReset(config: SpadConfig, channel: "text" | "reasoning") {
  const detector = new SpadDetector({ channel, config })
  detector.push(input.slice(0, 8192))
  const samples: number[] = []
  for (let sample = 0; sample < 11; sample++) {
    const start = Bun.nanoseconds()
    for (let i = 0; i < 5000; i++) detector.reset()
    const elapsed = Bun.nanoseconds() - start
    if (sample >= 2) samples.push(elapsed / 5000)
  }
  return median(samples)
}

function supervisorPartLifecycle(config: SpadConfig) {
  const sup = new SpadSupervisor(config)
  sup.beginTurn(makeTurnPolicy("Continue the task."))
  const text = "Healthy progress update with changing details and no repeated exact attractor. ".repeat(9)
  const reasoning = "Inspecting the next distinct state and checking current evidence before proceeding. ".repeat(9)
  // Warm both cached detectors.
  sup.startPart("text")
  sup.push(text)
  sup.startPart("reasoning")
  sup.push(reasoning)
  const samples: number[] = []
  for (let sample = 0; sample < 9; sample++) {
    const start = Bun.nanoseconds()
    for (let i = 0; i < 1000; i++) {
      sup.startPart("text")
      sup.push(text)
      sup.startPart("reasoning")
      sup.push(reasoning)
    }
    const elapsed = Bun.nanoseconds() - start
    if (sample >= 2) samples.push(elapsed / 2000)
  }
  return median(samples)
}

for (const anchorTableSize of [4096, 8192]) {
  const config: SpadConfig = { ...DEFAULT_SPAD_CONFIG, anchorTableSize }
  const textNs = detectorThroughput(config, "text")
  const reasoningNs = detectorThroughput(config, "reasoning")
  const row = {
    anchorTableSize,
    textNsPerChar: textNs,
    textMiBps: 1e9 / textNs / (1024 * 1024),
    reasoningNsPerChar: reasoningNs,
    reasoningMiBps: 1e9 / reasoningNs / (1024 * 1024),
    textConstructUs: detectorConstruction(config, "text") / 1000,
    reasoningConstructUs: detectorConstruction(config, "reasoning") / 1000,
    textResetUs: detectorReset(config, "text") / 1000,
    reasoningResetUs: detectorReset(config, "reasoning") / 1000,
    supervisorPartUs: supervisorPartLifecycle(config) / 1000,
    estimatedCachedSupervisorAnchorBytes:
      // text detector: raw + canonical, reasoning detector: raw
      3 * anchorTableSize * (Uint32Array.BYTES_PER_ELEMENT + Int32Array.BYTES_PER_ELEMENT),
  }
  console.log(JSON.stringify(row))
}
