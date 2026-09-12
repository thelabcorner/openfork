import { readFileSync } from "node:fs"
import { DEFAULT_SPAD_CONFIG } from "../src/session/spad/config"
import { ExpansionLane } from "../src/session/spad/expansion-lane"

class LegacyExpansionLane {
  private readonly ringSize: number
  private readonly minLines: number
  private readonly minCycles: number
  private readonly minStreamChars: number
  private readonly lines = new Uint32Array(8192)
  private lineCount = 0
  private lineHash = 0x811c9dc5 >>> 0
  private lineCodes = 0
  private position = -1
  private anchor = -1
  private matchLen = 0
  private cycles = 0

  constructor() {
    this.ringSize = this.lines.length
    this.minLines = DEFAULT_SPAD_CONFIG.expansionMinLines
    this.minCycles = DEFAULT_SPAD_CONFIG.expansionMinCycles
    this.minStreamChars = DEFAULT_SPAD_CONFIG.expansionMinStreamChars
  }

  private lineSignature(hash: number, codes: number): number {
    return (Math.imul(hash ^ codes, 0x01000193) + codes) >>> 0
  }

  private previousOccurrence(hash: number): number {
    const cap = Math.min(this.lineCount - 1, this.ringSize - 1)
    for (let i = cap - 1; i >= 0; i--) if (this.lines[i] === hash) return i
    return -1
  }

  private closeLine(hash: number): boolean {
    this.lines[this.lineCount % this.ringSize] = hash
    this.lineCount++
    if (this.anchor >= 0 && this.matchLen > 0) {
      const expectedIndex = this.anchor + this.matchLen
      if (expectedIndex < this.lineCount - 1) {
        const expected = this.lines[expectedIndex % this.ringSize]
        if (expected === hash) {
          this.matchLen++
          if (this.matchLen === this.minLines) {
            this.cycles++
            if (this.cycles > Math.max(1, this.minCycles) && this.position + 1 >= this.minStreamChars) {
              this.cycles = 0
              return true
            }
          }
          return false
        }
      }
    }
    this.anchor = this.previousOccurrence(hash)
    this.matchLen = this.anchor >= 0 ? 1 : 0
    return false
  }

  push(code: number): boolean {
    this.position++
    if (code === 10) {
      const hash = this.lineSignature(this.lineHash, this.lineCodes)
      this.lineHash = 0x811c9dc5 >>> 0
      this.lineCodes = 0
      return this.closeLine(hash)
    }
    if (code !== 13 && code !== 32 && code !== 9) {
      this.lineHash = Math.imul(this.lineHash ^ code, 0x01000193) >>> 0
      this.lineCodes++
    }
    return false
  }
}

function expandingLedger(cycles: number) {
  const incidents = Array.from({ length: cycles + 4 }, (_, i) => `${i + 1}. sensor-${(i % 5) + 1} reported a transient read timeout`)
  return Array.from({ length: cycles }, (_, k) => [`=== INCIDENT LEDGER ${k + 1} ===`, ...incidents.slice(0, k + 1), ""].join("\n")).join("\n") + "\n"
}

const generatedCss = Array.from({ length: 14000 }, (_, i) => `.card-${i % 71} {\n  display: grid;\n  gap: ${i % 12}px;\n  padding: ${i % 17}px;\n  --slot: ${i};\n}\n`).join("\n")

const workloads = [
  ["settings-v2.css", readFileSync("../app/src/components/settings-v2/settings-v2.css", "utf8")],
  ["message-part.css", readFileSync("../session-ui/src/components/message-part.css", "utf8")],
  ["generated-css", generatedCss],
  ["expanding-positive", expandingLedger(40)],
] as const

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function benchLegacy(text: string, reps: number) {
  const times: number[] = []
  let detections = 0
  for (let r = 0; r < reps; r++) {
    const lane = new LegacyExpansionLane()
    let hits = 0
    const t0 = Bun.nanoseconds()
    for (let i = 0; i < text.length; i++) if (lane.push(text.charCodeAt(i))) hits++
    times.push(Bun.nanoseconds() - t0)
    if (r === reps - 1) detections = hits
  }
  const ns = median(times)
  return { medianNs: ns, nsPerCodeUnit: ns / text.length, detections }
}

function benchCurrent(text: string, reps: number) {
  const times: number[] = []
  let detections = 0
  for (let r = 0; r < reps; r++) {
    const lane = new ExpansionLane({ lane: "expansion", channel: "text", config: DEFAULT_SPAD_CONFIG })
    let hits = 0
    const t0 = Bun.nanoseconds()
    for (let i = 0; i < text.length; i++) if (lane.push(text.charCodeAt(i))) hits++
    times.push(Bun.nanoseconds() - t0)
    if (r === reps - 1) detections = hits
  }
  const ns = median(times)
  return { medianNs: ns, nsPerCodeUnit: ns / text.length, detections }
}

const rows = workloads.map(([name, text]) => {
  const reps = text.length > 500_000 ? 7 : 15
  const legacy = benchLegacy(text, reps)
  const current = benchCurrent(text, reps)
  return {
    workload: name,
    codeUnits: text.length,
    legacy,
    current,
    speedup: legacy.nsPerCodeUnit / current.nsPerCodeUnit,
  }
})

console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, rows }, null, 2))
