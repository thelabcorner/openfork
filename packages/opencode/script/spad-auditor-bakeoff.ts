import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { SpadAuditor } from "@opencode-ai/core/spad-auditor"
import { auditorCorpus, type AuditorSplit } from "../test/session/spad-auditor-corpus"

type VerdictRow = {
  id: string
  decision: SpadAuditor.Decision
  confidence: number
  reason: SpadAuditor.Reason
  model?: string
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  cost?: number
}

const mode = process.argv[2] ?? "emit"
const corpusHash = createHash("sha256").update(JSON.stringify(auditorCorpus)).digest("hex")

type Framing = "neutral" | "biased"
const splits = new Set<AuditorSplit>(["dev", "calibration", "holdout"])

function renderPrompt(framing: Framing) {
  if (framing === "neutral") return `${SpadAuditor.DEFAULT_PROMPT}\n\n${SpadAuditor.PROTOCOL_PROMPT}`
  return `${SpadAuditor.DEFAULT_PROMPT}\n\nA separate automatic detector flagged this candidate as likely degenerate repetition. Independently confirm or reject that suspicion from the supplied evidence.\n\n${SpadAuditor.PROTOCOL_PROMPT}`
}

function selectSplit(name: string | undefined) {
  if (!name || name === "all") return auditorCorpus
  if (!splits.has(name as AuditorSplit)) throw new Error(`Unknown split: ${name}`)
  return auditorCorpus.filter((item) => item.split === name)
}

if (mode === "emit") {
  const framing = (process.argv[3] ?? "neutral") as Framing
  if (framing !== "neutral" && framing !== "biased") throw new Error("emit framing must be neutral or biased")
  const selected = selectSplit(process.argv[4] ?? "all")
  const splitHash = createHash("sha256").update(JSON.stringify(selected)).digest("hex")
  for (const item of selected) {
    console.log(
      JSON.stringify({
        id: item.id,
        split: item.split,
        framing,
        corpusSha256: corpusHash,
        splitSha256: splitHash,
        prompt: renderPrompt(framing),
        input: SpadAuditor.renderCase(item.audit),
      }),
    )
  }
  process.exit(0)
}

if (mode === "compare") {
  const neutralFile = process.argv[3]
  const biasedFile = process.argv[4]
  if (!neutralFile || !biasedFile) throw new Error("compare mode requires neutral and biased verdict JSONL files")
  const load = async (file: string) =>
    new Map(
      (await readFile(file, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as VerdictRow)
        .map((row) => [row.id, row] as const),
    )
  const neutral = await load(neutralFile)
  const biased = await load(biasedFile)
  let paired = 0
  let decisionFlips = 0
  let towardDegenerate = 0
  let towardLegitimate = 0
  let neutralFalseVetoes = 0
  let biasedFalseVetoes = 0
  let confidenceDelta = 0
  const flips: Array<{ id: string; gold: string; neutral: string; biased: string }> = []
  for (const item of auditorCorpus) {
    const a = neutral.get(item.id)
    const b = biased.get(item.id)
    if (!a || !b) continue
    paired++
    confidenceDelta += b.confidence - a.confidence
    if (SpadAuditor.disposition(a) === "veto" && item.gold === "degenerate") neutralFalseVetoes++
    if (SpadAuditor.disposition(b) === "veto" && item.gold === "degenerate") biasedFalseVetoes++
    if (a.decision !== b.decision) {
      decisionFlips++
      if (b.decision === "degenerate") towardDegenerate++
      if (b.decision === "legitimate") towardLegitimate++
      flips.push({ id: item.id, gold: item.gold, neutral: a.decision, biased: b.decision })
    }
  }
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        corpusSha256: corpusHash,
        paired,
        decisionFlips,
        flipRate: paired ? decisionFlips / paired : null,
        towardDegenerate,
        towardLegitimate,
        meanConfidenceDelta: paired ? confidenceDelta / paired : null,
        neutralFalseVetoes,
        biasedFalseVetoes,
        falseVetoDelta: biasedFalseVetoes - neutralFalseVetoes,
        flips,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

if (mode !== "score") throw new Error("Usage: bun run script/spad-auditor-bakeoff.ts [emit [neutral|biased] [all|dev|calibration|holdout] | score <verdicts.jsonl> [split] | compare <neutral.jsonl> <biased.jsonl>]")
const file = process.argv[3]
if (!file) throw new Error("score mode requires a verdict JSONL file")
const selectedCorpus = selectSplit(process.argv[4] ?? "all")
const rows = (await readFile(file, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line) as VerdictRow
    } catch (error) {
      throw new Error(`Invalid verdict JSONL at line ${index + 1}: ${String(error)}`)
    }
  })
const byID = new Map(rows.map((row) => [row.id, row]))
const selectedIDs = new Set(selectedCorpus.map((item) => item.id))
const submittedForSplit = rows.filter((row) => selectedIDs.has(row.id)).length

let covered = 0
let correctCovered = 0
let vetoes = 0
let correctVetoes = 0
let falseVetoes = 0
let degeneratePredictions = 0
let correctDegeneratePredictions = 0
let missing = 0
const confusion = {
  legitimate: { legitimate: 0, degenerate: 0, uncertain: 0, missing: 0 },
  degenerate: { legitimate: 0, degenerate: 0, uncertain: 0, missing: 0 },
}
const failures: Array<{ id: string; gold: string; decision: string; confidence: number | null; reason: string | null }> = []

for (const item of selectedCorpus) {
  const row = byID.get(item.id)
  if (!row) {
    missing++
    confusion[item.gold].missing++
    failures.push({ id: item.id, gold: item.gold, decision: "missing", confidence: null, reason: null })
    continue
  }
  if (!SpadAuditor.DECISIONS.includes(row.decision) || !SpadAuditor.REASONS.includes(row.reason))
    throw new Error(`Invalid enum value in verdict row ${row.id}`)
  if (!Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1)
    throw new Error(`Invalid confidence in verdict row ${row.id}`)
  confusion[item.gold][row.decision]++
  if (row.decision !== "uncertain") {
    covered++
    if (row.decision === item.gold) correctCovered++
  }
  if (row.decision === "degenerate") {
    degeneratePredictions++
    if (item.gold === "degenerate") correctDegeneratePredictions++
  }
  const disposition = SpadAuditor.disposition(row)
  if (disposition === "veto") {
    vetoes++
    if (item.gold === "legitimate") correctVetoes++
    else falseVetoes++
  }
  if (row.decision !== item.gold && row.decision !== "uncertain")
    failures.push({ id: item.id, gold: item.gold, decision: row.decision, confidence: row.confidence, reason: row.reason })
}

const finite = (values: Array<number | undefined>) => values.filter((value): value is number => value !== undefined && Number.isFinite(value))
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const latency = finite(rows.map((row) => row.latencyMs)).sort((a, b) => a - b)
const quantile = (values: number[], q: number) => (values.length ? values[Math.min(values.length - 1, Math.floor(values.length * q))]! : null)

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      corpusSha256: corpusHash,
      split: process.argv[4] ?? "all",
      splitSha256: createHash("sha256").update(JSON.stringify(selectedCorpus)).digest("hex"),
      cases: selectedCorpus.length,
      submitted: submittedForSplit,
      missing,
      coverage: covered / selectedCorpus.length,
      coveredAccuracy: covered ? correctCovered / covered : null,
      veto: {
        threshold: SpadAuditor.VETO_CONFIDENCE,
        count: vetoes,
        coverage: vetoes / selectedCorpus.length,
        precision: vetoes ? correctVetoes / vetoes : null,
        falseVetoes,
      },
      degeneratePredictionPrecision: degeneratePredictions ? correctDegeneratePredictions / degeneratePredictions : null,
      confusion,
      usage: {
        inputTokens: sum(finite(rows.map((row) => row.inputTokens))),
        outputTokens: sum(finite(rows.map((row) => row.outputTokens))),
        cost: sum(finite(rows.map((row) => row.cost))),
        latencyP50Ms: quantile(latency, 0.5),
        latencyP95Ms: quantile(latency, 0.95),
      },
      failures,
    },
    null,
    2,
  ),
)
