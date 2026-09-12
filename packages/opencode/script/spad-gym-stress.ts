import { writeFileSync } from "node:fs"
import { DEFAULT_EXACT_BANDS, DEFAULT_SPAD_CONFIG } from "../src/session/spad/config"
import { makeTurnPolicy } from "../src/session/spad/intent"
import { SpadSupervisor } from "../src/session/spad/supervisor"
import type { SpadAction, SpadChannel, SpadConfig } from "../src/session/spad/types"
import { negativeCases } from "../test/session/spad-gym-fixtures"

type StreamRun = {
  actions: SpadAction[]
  destructive?: SpadAction
}

type PositiveFailure = {
  id: string
  period: number
  expectedFloor: number
  reason: string
  action?: string
  lane?: string
  proposedPeriod?: number
  exactMinimalPeriod?: number
  runLength?: number
}

type TimingRow = {
  id: string
  period: number
  expectedFloor: number
  runLength: number
  delay: number
  proposedPeriod: number
  exactMinimalPeriod: number
}

const outputPath = process.argv[2] ?? ".tmp-spad-gym-stress.json"
const scale = Math.max(1, Math.min(20, Number.parseInt(process.env.SPAD_STRESS_SCALE ?? "1", 10) || 1))
const seedSalt = Number(process.env.SPAD_STRESS_SEED_SALT ?? 0) >>> 0
const requestedAnchorTableSize = Number.parseInt(
  process.env.SPAD_STRESS_ANCHOR_TABLE_SIZE ?? String(DEFAULT_SPAD_CONFIG.anchorTableSize),
  10,
)
const anchorTableSize = Number.isInteger(requestedAnchorTableSize) && requestedAnchorTableSize > 0
  ? requestedAnchorTableSize
  : DEFAULT_SPAD_CONFIG.anchorTableSize
const stressConfig: SpadConfig = { ...DEFAULT_SPAD_CONFIG, anchorTableSize }

function seeded(seed: number) {
  let x = seed >>> 0
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x >>> 0
  }
}

function percentile(values: readonly number[], p: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!
}

function isDestructive(action: SpadAction | undefined): action is SpadAction {
  return action?.type === "recover" || action?.type === "abort"
}

function runStream(options: {
  text: string
  chunks: readonly number[]
  user?: string
  structured?: boolean
  channel?: SpadChannel
  config?: SpadConfig
}): StreamRun {
  const sup = new SpadSupervisor(options.config ?? stressConfig)
  sup.beginTurn(makeTurnPolicy(options.user ?? "Continue the task.", options.structured ?? false))
  const channel = options.channel ?? "text"
  sup.startPart(channel, false, false)
  const actions: SpadAction[] = []
  let at = 0
  let chunkIndex = 0
  while (at < options.text.length) {
    const size = options.chunks[chunkIndex++ % options.chunks.length]!
    const action = sup.push(options.text.slice(at, at + size))
    at += size
    if (!action) continue
    actions.push(action)
    if (isDestructive(action)) return { actions, destructive: action }
  }
  return { actions }
}

function minimalPeriod(text: string): number {
  if (text.length <= 1) return text.length
  const pi = new Int32Array(text.length)
  for (let i = 1; i < text.length; i++) {
    let j = pi[i - 1]!
    while (j > 0 && text.charCodeAt(i) !== text.charCodeAt(j)) j = pi[j - 1]!
    if (text.charCodeAt(i) === text.charCodeAt(j)) j++
    pi[i] = j
  }
  return text.length - pi[text.length - 1]!
}

const MOTIF_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789,.;:!?_+-=/|~"

function primitiveMotif(period: number, seed: number): string {
  if (period === 1) return "a"
  if (period === 2) return "ab"
  if (period === 3) return "abc"
  if (period === 4) return "abcd"
  for (let attempt = 0; attempt < 64; attempt++) {
    const rand = seeded(seed ^ Math.imul(period + attempt * 131, 0x9e3779b1))
    const chars = new Array<string>(period)
    // Guarantee the lexical gate is not what controls periods >= 5.
    chars[0] = "a"
    chars[1] = "b"
    chars[2] = "c"
    chars[3] = "d"
    chars[4] = "e"
    for (let i = 5; i < period; i++) chars[i] = MOTIF_ALPHABET[rand() % MOTIF_ALPHABET.length]!
    const motif = chars.join("")
    if (minimalPeriod(motif) === period) return motif
  }
  throw new Error(`could not generate primitive motif period=${period}`)
}

function lowEntropyPrimitiveMotif(period: number, seed: number): string {
  if (period < 5) return primitiveMotif(period, seed)
  const alphabet = "abcde"
  for (let attempt = 0; attempt < 128; attempt++) {
    const rand = seeded(seedSalt ^ seed ^ Math.imul(period + attempt * 193, 0x85ebca6b))
    const chars = new Array<string>(period)
    for (let i = 0; i < period; i++) chars[i] = alphabet[rand() % alphabet.length]!
    // Guarantee all five lexical symbols occur without introducing a long run.
    chars[0] = "a"
    chars[1] = "b"
    chars[2] = "c"
    chars[3] = "d"
    chars[4] = "e"
    const motif = chars.join("")
    if (minimalPeriod(motif) === period) return motif
  }
  throw new Error(`could not generate low-entropy primitive motif period=${period}`)
}

function rawFloor(period: number) {
  const band = DEFAULT_EXACT_BANDS.find((row) => period <= row.maxPeriod) ?? DEFAULT_EXACT_BANDS.at(-1)!
  const threshold = Math.max(band.minCoverage, Math.ceil(period * band.minExponent))
  // Periods 1..3 necessarily have fewer than four distinct ASCII letters.
  return period <= 3 ? Math.max(threshold, DEFAULT_SPAD_CONFIG.lowLexicalMinCoverage) : threshold
}

function prefixFor(id: number) {
  return `Healthy-prefix-${id}-${"x".repeat(id % 113)}-§`
}

function repeatedPrefix(motif: string, chars: number) {
  return motif.repeat(Math.ceil(chars / motif.length)).slice(0, chars)
}

function positiveCase(period: number, seed: number, chunks: readonly number[]): { failure?: PositiveFailure; timing?: TimingRow; text: string } {
  const motif = primitiveMotif(period, seed)
  const floor = rawFloor(period)
  const prefix = prefixFor(seed & 0xffff)
  const target = floor + Math.max(128, period * 2)
  const text = prefix + repeatedPrefix(motif, target)
  const run = runStream({ text, chunks })
  const action = run.destructive
  if (!action) return { failure: { id: `p${period}-s${seed}`, period, expectedFloor: floor, reason: "miss" }, text }
  const d = action.detection
  if (action.type !== "recover" || d.lane !== "raw") {
    return {
      failure: {
        id: `p${period}-s${seed}`,
        period,
        expectedFloor: floor,
        reason: "wrong-destructive-action",
        action: action.type,
        lane: d.lane,
        proposedPeriod: d.period,
        exactMinimalPeriod: d.exactMinimalPeriod,
        runLength: d.runLength,
      },
      text,
    }
  }
  if (d.runLength < floor) {
    return {
      failure: {
        id: `p${period}-s${seed}`,
        period,
        expectedFloor: floor,
        reason: "early-detection",
        action: action.type,
        lane: d.lane,
        proposedPeriod: d.period,
        exactMinimalPeriod: d.exactMinimalPeriod,
        runLength: d.runLength,
      },
      text,
    }
  }
  if (d.exactMinimalPeriod !== period) {
    return {
      failure: {
        id: `p${period}-s${seed}`,
        period,
        expectedFloor: floor,
        reason: "minimal-period-mismatch",
        action: action.type,
        lane: d.lane,
        proposedPeriod: d.period,
        exactMinimalPeriod: d.exactMinimalPeriod,
        runLength: d.runLength,
      },
      text,
    }
  }
  return {
    text,
    timing: {
      id: `p${period}-s${seed}`,
      period,
      expectedFloor: floor,
      runLength: d.runLength,
      delay: d.runLength - floor,
      proposedPeriod: d.period,
      exactMinimalPeriod: d.exactMinimalPeriod,
    },
  }
}

function fuzzText(rand: () => number) {
  const nouns = ["session", "processor", "router", "worker", "buffer", "cache", "message", "tool", "result", "module", "stream"]
  const verbs = ["reads", "updates", "checks", "compares", "records", "validates", "loads", "writes"]
  let text = ""
  const rows = 80 + (rand() % 220)
  for (let i = 0; i < rows; i++) {
    const noun = nouns[rand() % nouns.length]!
    const verb = verbs[rand() % verbs.length]!
    text += `${i + 1}. The ${noun} ${verb} item-${(rand() % 197) + 1} with status-${rand() % 19}, attempt-${rand() % 7}, revision-${rand() % 100003}.\n`
    if (rand() % 7 === 0) text += `   - evidence: ${noun} retained schema-${rand() % 13} while value ${rand() % 1000003} changed.\n`
  }
  return text
}

function expandingLedger(cycles: number) {
  const incidents = Array.from({ length: cycles + 4 }, (_, i) => `${i + 1}. sensor-${(i % 5) + 1} reported a transient read timeout`)
  const lines: string[] = []
  for (let k = 0; k < cycles; k++) {
    lines.push(`=== INCIDENT LEDGER (after cycle ${k + 1}) ===`)
    lines.push(...incidents.slice(0, k + 1))
    lines.push("")
  }
  return lines.join("\n") + "\n"
}

function canonicalDrift(lines = 40) {
  const rand = seeded(0x41c4110a)
  const base = "The controller should re anchor to the user request and continue differently."
  return Array.from({ length: lines }, () => {
    let out = ""
    for (const ch of base) {
      if (ch === " ") {
        const whitespace = [" ", "  ", "\t", "\n", " \t "]
        out += whitespace[rand() % whitespace.length]!
      } else if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) {
        out += (rand() & 1) === 0 ? ch.toLowerCase() : ch.toUpperCase()
      } else out += ch
    }
    return out
  }).join("\n")
}

const started = performance.now()
const failures: Array<Record<string, unknown>> = []
const timings: TimingRow[] = []

// 1) Positive exact-period recall across every threshold edge and randomized periods.
const edgePeriods = [1, 2, 3, 4, 5, 8, 15, 16, 17, 31, 32, 63, 64, 65, 127, 255, 256, 257, 511, 767, 768, 769, 1023, 2047, 4095, 4096]
const positivePeriods = [...edgePeriods]
const positiveRand = seeded(0x5ad600d ^ seedSalt)
for (let i = 0; i < 1000 * scale; i++) positivePeriods.push(1 + (positiveRand() % DEFAULT_SPAD_CONFIG.maxPeriod))
for (let i = 0; i < positivePeriods.length; i++) {
  const period = positivePeriods[i]!
  const chunks = [1 + (positiveRand() % 257), 1 + (positiveRand() % 67), 1 + (positiveRand() % 19)]
  const result = positiveCase(period, (0x10000 + i) ^ seedSalt, chunks)
  if (result.failure) failures.push({ suite: "positive-raw", ...result.failure })
  if (result.timing) timings.push(result.timing)
}

// 2) Exact threshold-minus-one negatives prove the raw lane never fires early.
let boundaryNegativeCases = 0
let boundaryNegativeChars = 0
const boundaryRand = seeded(0xb0ad4e ^ seedSalt)
for (let i = 0; i < 1000 * scale; i++) {
  const period = i < edgePeriods.length ? edgePeriods[i]! : 1 + (boundaryRand() % DEFAULT_SPAD_CONFIG.maxPeriod)
  const motif = primitiveMotif(period, (0x20000 + i) ^ seedSalt)
  const floor = rawFloor(period)
  const text = prefixFor(i) + repeatedPrefix(motif, floor - 1)
  const run = runStream({ text, chunks: [1 + (boundaryRand() % 199)] })
  boundaryNegativeCases++
  boundaryNegativeChars += text.length
  if (run.destructive) failures.push({ suite: "threshold-minus-one", case: i, period, floor, action: run.destructive.type, lane: run.destructive.detection.lane, runLength: run.destructive.detection.runLength })
}

// 3) Chunk-boundary invariance on exact positives.
let chunkCases = 0
for (let i = 0; i < 120 * Math.min(scale, 4); i++) {
  const period = 1 + (positiveRand() % DEFAULT_SPAD_CONFIG.maxPeriod)
  const seed = 0x30000 + i
  const motif = primitiveMotif(period, seed)
  const floor = rawFloor(period)
  const text = prefixFor(i) + repeatedPrefix(motif, floor + Math.max(128, period * 2))
  const patterns: readonly number[][] = [[1], [3, 11, 47], [32], [97, 7], [256], [1024, 17]]
  let reference: string | undefined
  for (const chunks of patterns) {
    const run = runStream({ text, chunks })
    const d = run.destructive?.detection
    const signature = run.destructive ? `${run.destructive.type}:${d?.lane}:${d?.runStart}:${d?.runEnd}:${d?.period}:${d?.exactMinimalPeriod}` : "none"
    reference ??= signature
    if (signature !== reference) failures.push({ suite: "chunk-invariance", case: i, period, reference, actual: signature, chunks })
  }
  chunkCases++
}

// 4) Protected hand-authored negative corpus, full-stream semantics and multiple chunkings.
let protectedNegativeRuns = 0
let protectedNegativeChars = 0
for (const item of negativeCases) {
  for (const chunks of [[1], [3, 11, 47], [97, 31, 7], [256], [1024, 17]] as readonly number[][]) {
    const run = runStream({ text: item.text, chunks, user: item.user, structured: item.structured })
    protectedNegativeRuns++
    protectedNegativeChars += item.text.length
    if (run.destructive) failures.push({ suite: "protected-negative", name: item.name, class: item.class, chunks, action: run.destructive.type, lane: run.destructive.detection.lane, reason: run.destructive.policyReason })
  }
}

// 5) Large templated healthy-output fuzz corpus.
let fuzzCases = 0
let fuzzChars = 0
const fuzzRand = seeded(0xf00d51ad ^ seedSalt)
for (let i = 0; i < 2000 * scale; i++) {
  const text = fuzzText(fuzzRand)
  const run = runStream({ text, chunks: [1 + (fuzzRand() % 211), 1 + (fuzzRand() % 37)] })
  fuzzCases++
  fuzzChars += text.length
  if (run.destructive) failures.push({ suite: "templated-fuzz", case: i, action: run.destructive.type, lane: run.destructive.detection.lane, period: run.destructive.detection.period, runLength: run.destructive.detection.runLength })
}

// 6) Repeated near-threshold bouts separated by non-motif sentinels.
let quasiCases = 0
let quasiChars = 0
const quasiRand = seeded(0x0badcafe ^ seedSalt)
for (let i = 0; i < 1000 * scale; i++) {
  const period = 1 + (quasiRand() % DEFAULT_SPAD_CONFIG.maxPeriod)
  const motif = primitiveMotif(period, (0x40000 + i) ^ seedSalt)
  const floor = rawFloor(period)
  let text = prefixFor(i)
  for (let bout = 0; bout < 4; bout++) {
    const length = Math.max(period + DEFAULT_SPAD_CONFIG.qgram, floor - 1 - (quasiRand() % Math.max(1, Math.min(97, floor - 1))))
    text += repeatedPrefix(motif, Math.min(length, floor - 1))
    text += `§${String.fromCharCode(0x100 + ((i + bout) % 500))}§`
  }
  const run = runStream({ text, chunks: [1 + (quasiRand() % 149)] })
  quasiCases++
  quasiChars += text.length
  if (run.destructive) failures.push({ suite: "quasi-periodic-negative", case: i, period, floor, action: run.destructive.type, lane: run.destructive.detection.lane, runLength: run.destructive.detection.runLength })
}

// 7) Policy/gating adversaries: exact repetition is detected but must not mutate.
const gateMotif = "Intentional repeated payload with enough lexical diversity to form exact raw evidence. "
const gateText = gateMotif.repeat(80)
const gateCases = [
  { name: "explicit-repeat", run: runStream({ text: gateText, chunks: [17], user: "Repeat this exact sentence 80 times verbatim." }), expected: "repetition-expected" },
  { name: "structured-output", run: runStream({ text: gateText, chunks: [19], structured: true }), expected: "turn-observe-only" },
  { name: "reasoning", run: runStream({ text: gateText, chunks: [23], channel: "reasoning" }), expected: "reasoning-observe-only" },
  { name: "code-fence", run: runStream({ text: `\`\`\`txt\n${gateText}\n\`\`\``, chunks: [29] }), expected: "code-fence-recovery-disabled" },
]
for (const gate of gateCases) {
  if (gate.run.destructive) failures.push({ suite: "policy-gate", name: gate.name, reason: "destructive", action: gate.run.destructive.type, lane: gate.run.destructive.detection.lane })
  const raw = gate.run.actions.find((a) => a.detection.lane === "raw")
  if (!raw) failures.push({ suite: "policy-gate", name: gate.name, reason: "raw-evidence-missing" })
  else if (raw.policyReason !== gate.expected) failures.push({ suite: "policy-gate", name: gate.name, reason: "wrong-policy", expected: gate.expected, actual: raw.policyReason })
}

// 8) Heuristic positive capability checks remain evidence-producing.
const canonical = runStream({ text: canonicalDrift(), chunks: [13] })
if (!canonical.actions.some((a) => a.detection.lane === "canonical" && a.type === "observe")) failures.push({ suite: "heuristic-positive", lane: "canonical", reason: "miss" })

const expansion = runStream({ text: expandingLedger(16), chunks: [31, 7], config: { ...stressConfig, autoRecoverExpansion: true } })
if (!expansion.destructive || expansion.destructive.detection.lane !== "expansion") failures.push({ suite: "heuristic-positive", lane: "expansion", reason: "miss", actual: expansion.destructive?.detection.lane })

const toolSup = new SpadSupervisor({ ...stressConfig, autoRecoverToolLoop: true })
toolSup.beginTurn(makeTurnPolicy("Investigate the issue."))
toolSup.startPart("text")
let toolAction: SpadAction | undefined
for (let i = 0; i < 40 && !isDestructive(toolAction); i++) toolAction = toolSup.pushTool("read", false, "src/same.ts:o1")
if (!isDestructive(toolAction) || toolAction.detection.lane !== "tool") failures.push({ suite: "heuristic-positive", lane: "tool", reason: "miss" })

const infoSup = new SpadSupervisor()
infoSup.beginTurn(makeTurnPolicy("Inspect the same external state until it changes."))
let informationAction: SpadAction | undefined
for (let g = 0; g < 4; g++) {
  infoSup.markGeneration()
  infoSup.startPart("text")
  // One unique word gives the state-cycle narration lane no recurring trigram
  // while the unchanged-result detector receives its intended exact evidence.
  infoSup.push(`uniqueword${g}`)
  infoSup.pushTool("read", false, "status:stable")
  const action = infoSup.pushToolResult("status:stable", "identical-result")
  if (action?.detection.lane === "information") informationAction = action
}
if (informationAction?.type !== "observe") failures.push({ suite: "heuristic-positive", lane: "information", reason: "miss", actual: informationAction?.type })

const stateSup = new SpadSupervisor()
stateSup.beginTurn(makeTurnPolicy("Investigate the alternating state."))
let stateAction: SpadAction | undefined
const stateCases = [
  {
    resources: ["sqlite.bun.ts:o120:l80"],
    narration: "The native layer closes in a finalizer, so I am rechecking the same lifetime question.",
  },
  {
    resources: ["migration.ts:o90:l60", "database.ts:o1:l50"],
    narration: "Neither helper opens a connection, so I am rechecking the same two call sites.",
  },
]
for (let g = 0; g < 4; g++) {
  stateSup.markGeneration()
  stateSup.startPart("text")
  const state = stateCases[g % 2]!
  for (const resource of state.resources) {
    const tool = stateSup.pushTool("read", false, resource)
    if (tool?.detection.lane === "state") stateAction = tool
    const result = stateSup.pushToolResult(resource, `stable:${resource}`)
    if (result?.detection.lane === "state") stateAction = result
  }
  for (let i = 0; i < state.narration.length; i += 17) {
    const action = stateSup.push(state.narration.slice(i, i + 17))
    if (action?.detection.lane === "state") stateAction = action
  }
}
if (stateAction?.type !== "observe") failures.push({ suite: "heuristic-positive", lane: "state", reason: "miss", actual: stateAction?.type })

// Unicode / UTF-16 exact loops, including surrogate pairs and combining marks.
const unicodeMotifs = [
  "Δβ漢字éΩ",
  "🙂🚀漢字Δβé",
  "e\u0301-café-λ-漢-🙂",
  "Прогресс-検証-🙂-Δ",
]
let unicodePositiveCases = 0
for (let i = 0; i < unicodeMotifs.length; i++) {
  const motif = unicodeMotifs[i]!
  const period = motif.length
  if (minimalPeriod(motif) !== period) throw new Error(`unicode fixture not primitive: ${i}`)
  const floor = rawFloor(period)
  const text = prefixFor(0x50000 + i) + repeatedPrefix(motif, floor + period * 3 + 64)
  for (const chunks of [[1], [2], [3, 7, 19], [128]] as readonly number[][]) {
    const run = runStream({ text, chunks })
    unicodePositiveCases++
    const d = run.destructive?.detection
    if (!run.destructive || run.destructive.type !== "recover" || d?.lane !== "raw" || d.exactMinimalPeriod !== period)
      failures.push({ suite: "unicode-positive", fixture: i, chunks, period, actualLane: d?.lane, actualMinimal: d?.exactMinimalPeriod })
  }
  const near = prefixFor(0x51000 + i) + repeatedPrefix(motif, floor - 1)
  const negative = runStream({ text: near, chunks: [1] })
  if (negative.destructive) failures.push({ suite: "unicode-threshold-minus-one", fixture: i, period, floor, lane: negative.destructive.detection.lane })
}

// Long, low-entropy primitive motifs create heavy internal q-gram recurrence
// and candidate pressure. They are adversarial positives for the bounded
// candidate set and direct-mapped anchor table, while still having one exact
// independently verified minimal period.
let lowEntropyCases = 0
let lowEntropyPassed = 0
let lowEntropyMaxDelay = 0
const lowEntropyRand = seeded(0x10e17e70 ^ seedSalt)
for (let i = 0; i < 500 * scale; i++) {
  const period = 17 + (lowEntropyRand() % (DEFAULT_SPAD_CONFIG.maxPeriod - 16))
  const motif = lowEntropyPrimitiveMotif(period, 0x60000 + i)
  const floor = rawFloor(period)
  const text = prefixFor(0x60000 + i) + repeatedPrefix(motif, floor + Math.max(256, period * 2))
  const run = runStream({ text, chunks: [1 + (lowEntropyRand() % 173), 1 + (lowEntropyRand() % 31)] })
  lowEntropyCases++
  const action = run.destructive
  const d = action?.detection
  if (!action || action.type !== "recover" || d?.lane !== "raw" || d.exactMinimalPeriod !== period || d.runLength < floor) {
    failures.push({
      suite: "low-entropy-positive",
      case: i,
      period,
      floor,
      action: action?.type,
      lane: d?.lane,
      proposedPeriod: d?.period,
      exactMinimalPeriod: d?.exactMinimalPeriod,
      runLength: d?.runLength,
    })
    continue
  }
  lowEntropyPassed++
  lowEntropyMaxDelay = Math.max(lowEntropyMaxDelay, d.runLength - floor)
}

// 9) Healthy tool/workflow stress under the aggressive legacy-thrash opt-in.
let workflowCases = 0
const aggressive: SpadConfig = { ...stressConfig, autoRecoverThrash: true }
for (let c = 0; c < 250 * scale; c++) {
  const sup = new SpadSupervisor(aggressive)
  sup.beginTurn(makeTurnPolicy("Fix the implementation and validate progress."))
  let destructive: SpadAction | undefined
  for (let g = 0; g < 10 && !destructive; g++) {
    sup.markGeneration()
    sup.startPart("text")
    const narration = `Generation ${g}: inspect revision ${c}-${g}, change module-${(c + g) % 11}, and verify benchmark-${g}.`
    for (let i = 0; i < narration.length && !destructive; i += 17) {
      const action = sup.push(narration.slice(i, i + 17))
      if (isDestructive(action)) destructive = action
    }
    const resource = `src/module-${(c + g) % 11}.ts:o${g * 20}`
    const read = sup.pushTool("read", false, resource)
    if (isDestructive(read)) destructive = read
    const readResult = sup.pushToolResult(resource, `revision=${c}-${g};hash=${Math.imul(c + 1, g + 17)}`)
    if (isDestructive(readResult)) destructive = readResult
    const edit = sup.pushTool("edit", true, `src/module-${(c + g) % 11}.ts:edit-${g}`)
    if (isDestructive(edit)) destructive = edit
    sup.markProgress()
    const testResource = `bun-test:case-${c}-${g}`
    const testCall = sup.pushTool("bash", false, testResource)
    if (isDestructive(testCall)) destructive = testCall
    const testResult = sup.pushToolResult(testResource, `pass:${g}:${c}`)
    if (isDestructive(testResult)) destructive = testResult
  }
  workflowCases++
  if (destructive) failures.push({ suite: "healthy-workflow", case: c, action: destructive.type, lane: destructive.detection.lane, reason: destructive.policyReason })
}

// 10) Read-only repeated inspection may produce information evidence, never destructive thrash.
let readOnlyCases = 0
for (let c = 0; c < 120 * scale; c++) {
  const sup = new SpadSupervisor(aggressive)
  sup.beginTurn(makeTurnPolicy("Review this implementation only. Do not edit files."))
  let destructive: SpadAction | undefined
  for (let g = 0; g < 7 && !destructive; g++) {
    sup.markGeneration()
    sup.startPart("text")
    sup.push(`Review pass ${g}: compare the same invariant carefully before writing the report.`)
    const resource = "src/review-target.ts:o1"
    const read = sup.pushTool("read", false, resource)
    if (isDestructive(read)) destructive = read
    const result = sup.pushToolResult(resource, "stable-reviewed-content")
    if (isDestructive(result)) destructive = result
  }
  readOnlyCases++
  if (destructive) failures.push({ suite: "read-only-workflow", case: c, action: destructive.type, lane: destructive.detection.lane, reason: destructive.policyReason })
}

const delays = timings.map((row) => row.delay)
const harmonicProposals = timings.filter((row) => row.proposedPeriod !== row.exactMinimalPeriod)
const lateBeyondOnePeriod = timings.filter((row) => row.delay > row.period)
const report = {
  generatedAt: new Date().toISOString(),
  durationMs: performance.now() - started,
  config: {
    scale,
    seedSalt,
    ringSize: DEFAULT_SPAD_CONFIG.ringSize,
    anchorTableSize,
    maxPeriod: DEFAULT_SPAD_CONFIG.maxPeriod,
    qgram: DEFAULT_SPAD_CONFIG.qgram,
    bands: DEFAULT_EXACT_BANDS,
  },
  positiveRaw: {
    cases: positivePeriods.length,
    passed: timings.length,
    failures: failures.filter((x) => x.suite === "positive-raw").length,
    recall: positivePeriods.length ? timings.length / positivePeriods.length : 0,
    timingDelayChars: {
      min: delays.length ? Math.min(...delays) : 0,
      median: percentile(delays, 0.5),
      p95: percentile(delays, 0.95),
      p99: percentile(delays, 0.99),
      max: delays.length ? Math.max(...delays) : 0,
    },
    harmonicProposalCases: harmonicProposals.length,
    lateBeyondOnePeriodCases: lateBeyondOnePeriod.length,
    worstTiming: [...timings].sort((a, b) => b.delay - a.delay).slice(0, 20),
  },
  lowEntropyPositive: {
    cases: lowEntropyCases,
    passed: lowEntropyPassed,
    recall: lowEntropyCases ? lowEntropyPassed / lowEntropyCases : 0,
    maxDelay: lowEntropyMaxDelay,
  },
  falsePositiveGym: {
    thresholdMinusOne: { cases: boundaryNegativeCases, chars: boundaryNegativeChars },
    protectedCorpus: { sourceCases: negativeCases.length, runs: protectedNegativeRuns, chars: protectedNegativeChars },
    templatedFuzz: { cases: fuzzCases, chars: fuzzChars },
    quasiPeriodic: { cases: quasiCases, chars: quasiChars },
    healthyWorkflows: workflowCases,
    readOnlyWorkflows: readOnlyCases,
    destructiveFailures: failures.filter((x) => ["threshold-minus-one", "protected-negative", "templated-fuzz", "quasi-periodic-negative", "policy-gate", "healthy-workflow", "read-only-workflow"].includes(String(x.suite))).length,
  },
  chunkInvariance: { cases: chunkCases, failures: failures.filter((x) => x.suite === "chunk-invariance").length },
  unicode: { positiveRuns: unicodePositiveCases, fixtures: unicodeMotifs.length },
  heuristicCapability: {
    canonicalObserved: canonical.actions.some((a) => a.detection.lane === "canonical"),
    expansionRecoveredWhenOptedIn: expansion.destructive?.detection.lane === "expansion",
    toolLoopRecoveredWhenOptedIn: toolAction?.detection.lane === "tool" && isDestructive(toolAction),
    informationObserved: informationAction?.detection.lane === "information" && informationAction.type === "observe",
    stateCycleObserved: stateAction?.detection.lane === "state" && stateAction.type === "observe",
  },
  totalFailures: failures.length,
  failures: failures.slice(0, 100),
}

writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
if (failures.length) process.exitCode = 1
