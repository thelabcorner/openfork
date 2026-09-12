import { DEFAULT_SPAD_CONFIG } from "../src/session/spad/config"
import { BoundedExactPeriodVerifier, proveExactPeriod, verifyExactPeriodCandidate } from "../src/session/spad/exact-proof"
import { createPeriodLaneStats, PeriodLane, type PeriodLaneStats } from "../src/session/spad/period-lane"

const MiB = 1024 * 1024

function xorshift(seed: number) {
  let x = seed >>> 0
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x >>> 0
  }
}

function randomCodes(length: number, seed: number): Uint16Array {
  const rand = xorshift(seed)
  const out = new Uint16Array(length)
  for (let i = 0; i < length; i++) out[i] = 32 + (rand() % 95)
  return out
}

function periodicCodes(length: number, period: number, seed: number): Uint16Array {
  const motif = randomCodes(period, seed)
  const out = new Uint16Array(length)
  for (let i = 0; i < length; i++) out[i] = motif[i % period]!
  return out
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function timeNs(fn: () => void, iterations = 7): number {
  for (let i = 0; i < 2; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint()
    fn()
    samples.push(Number(process.hrtime.bigint() - start))
  }
  return median(samples)
}

function lane(stats?: PeriodLaneStats) {
  return new PeriodLane({
    lane: "raw",
    ringSize: DEFAULT_SPAD_CONFIG.ringSize,
    anchorTableSize: DEFAULT_SPAD_CONFIG.anchorTableSize,
    qgram: DEFAULT_SPAD_CONFIG.qgram,
    maxPeriod: DEFAULT_SPAD_CONFIG.maxPeriod,
    maxCandidates: DEFAULT_SPAD_CONFIG.maxCandidates,
    bands: DEFAULT_SPAD_CONFIG.exactBands,
    coverageMultiplier: 1,
    exponentBonus: 0,
    storeRawPositions: false,
    stats,
  })
}

function runLane(input: Uint16Array): number {
  const detector = lane()
  for (let i = 0; i < input.length; i++) if (detector.push(input[i]!, i, 1)) return i + 1
  return input.length
}

function textCodes(text: string): Uint16Array {
  const out = new Uint16Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

function scanLaneStats(name: string, input: Uint16Array) {
  const stats = createPeriodLaneStats()
  const detector = lane(stats)
  let hitAt: number | undefined
  for (let i = 0; i < input.length; i++) {
    if (detector.push(input[i]!, i, 1)) {
      hitAt = i + 1
      break
    }
  }
  const consumed = hitAt ?? input.length
  return {
    benchmark: `proposal-stats-${name}`,
    consumed,
    hitAt,
    proposalsPerMi: (stats.candidatesAdded / consumed) * MiB,
    candidateComparisonsPerCodeUnit: stats.candidateComparisons / consumed,
    ...stats,
  }
}

function structuredFixtures() {
  let jsonl = ""
  let markdown = ""
  let code = ""
  for (let i = 0; i < 12_000; i++) {
    jsonl += JSON.stringify({ id: i, status: `state-${i % 17}`, value: (i * 7919) % 100003, ok: i % 5 !== 0 }) + "\n"
    markdown += `${i + 1}. **module-${i % 97}** validates item-${i} with status-${i % 13} and offset-${i * 3}.\n`
    code += `const value_${i} = normalize(input_${i % 113}, ${i}); // generated fixture ${i}\n`
  }
  return [
    ["jsonl-changing", textCodes(jsonl)] as const,
    ["markdown-enumeration", textCodes(markdown)] as const,
    ["code-generated", textCodes(code)] as const,
  ]
}

function benchLane(name: string, input: Uint16Array) {
  let consumed = 0
  const ns = timeNs(() => {
    consumed = runLane(input)
  })
  return {
    benchmark: name,
    medianNs: ns,
    consumed,
    nsPerConsumedCodeUnit: ns / consumed,
  }
}

function benchProof(period: number, spanLength: number, falseCandidate = false) {
  const span = periodicCodes(spanLength, period, 0x1000 + period)
  if (falseCandidate) span[Math.floor(span.length * 0.75)]! ^= 1
  let result = proveExactPeriod(span, period)
  const calls = Math.max(250, Math.floor(2_000_000 / spanLength))
  const ns = timeNs(() => {
    for (let i = 0; i < calls; i++) result = proveExactPeriod(span, period)
  })
  const proof = result.ok ? result : undefined
  return {
    benchmark: falseCandidate ? `proof-reject-p${period}-n${spanLength}` : `proof-accept-p${period}-n${spanLength}`,
    calls,
    medianNs: ns,
    nsPerProof: ns / calls,
    nsPerSpanCodeUnit: ns / (calls * spanLength),
    periodComparisons: result.periodComparisons,
    prefixComparisons: result.prefixComparisons,
    minimalPeriod: proof?.minimalPeriod,
  }
}

function benchReusableProof(period: number, spanLength: number) {
  const span = periodicCodes(spanLength, period, 0x3000 + period)
  const verifier = new BoundedExactPeriodVerifier()
  let result = verifier.prove(span, period)
  const calls = Math.max(250, Math.floor(2_000_000 / spanLength))
  const ns = timeNs(() => {
    for (let i = 0; i < calls; i++) result = verifier.prove(span, period)
  })
  if (!result.ok) throw new Error(`unexpected reusable proof failure: ${result.reason}`)
  return {
    benchmark: `proof-reuse-p${period}-n${spanLength}`,
    calls,
    medianNs: ns,
    nsPerProof: ns / calls,
    nsPerSpanCodeUnit: ns / (calls * spanLength),
    periodComparisons: result.periodComparisons,
    prefixComparisons: result.prefixComparisons,
    minimalPeriod: result.minimalPeriod,
  }
}

function benchCandidateProof(period: number, spanLength: number) {
  const span = periodicCodes(spanLength, period, 0x5000 + period)
  let result = verifyExactPeriodCandidate(span, period)
  const calls = Math.max(250, Math.floor(2_000_000 / spanLength))
  const ns = timeNs(() => {
    for (let i = 0; i < calls; i++) result = verifyExactPeriodCandidate(span, period)
  })
  if (!result.ok) throw new Error(`unexpected candidate proof failure: ${result.reason}`)
  return {
    benchmark: `candidate-proof-p${period}-n${spanLength}`,
    calls,
    medianNs: ns,
    nsPerProof: ns / calls,
    nsPerSpanCodeUnit: ns / (calls * spanLength),
    periodComparisons: result.periodComparisons,
  }
}

function benchCheckpointOverhead(period: number, total = MiB) {
  const input = periodicCodes(total, period, 0x9000 + period)
  const checkpoint = 1024
  const spanLength = Math.min(8192, Math.max(2048, period * 4))
  let proofs = 0
  let comparisons = 0
  const ns = timeNs(() => {
    proofs = 0
    comparisons = 0
    for (let end = spanLength; end <= input.length; end += checkpoint) {
      const result = verifyExactPeriodCandidate(input.slice(end - spanLength, end), period)
      if (!result.ok) throw new Error(`unexpected failed proof p=${period} n=${spanLength}: ${result.reason}`)
      proofs++
      comparisons += result.periodComparisons
    }
  })
  return {
    benchmark: `checkpoint-overhead-p${period}`,
    inputCodeUnits: total,
    checkpoint,
    spanLength,
    proofs,
    medianNs: ns,
    addedNsPerInputCodeUnit: ns / total,
    proofComparisonsPerInputCodeUnit: comparisons / total,
  }
}

const healthy = randomCodes(MiB, 0xdecafbad)
const rows = [
  benchLane("period-lane-healthy-1Mi", healthy),
  ...[16, 64, 256, 1024].map((p) => benchLane(`period-lane-loop-p${p}`, periodicCodes(MiB, p, p))),
  ...[16, 64, 256, 1024].flatMap((p) => {
    const span = Math.min(8192, Math.max(2048, p * 4))
    return [benchProof(p, span), benchReusableProof(p, span), benchCandidateProof(p, span), benchProof(p, span, true)]
  }),
  ...[16, 64, 256, 1024].map((p) => benchCheckpointOverhead(p)),
  scanLaneStats("random-ascii", healthy),
  ...structuredFixtures().map(([name, input]) => scanLaneStats(name, input)),
]

console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, rows }, null, 2))
