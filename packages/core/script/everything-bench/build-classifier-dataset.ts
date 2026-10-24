/**
 * Classifier dataset builder.
 *
 * Aggregates bench-provider.jsen rows across scales into a labeled dataset of
 * wins, proof failures, and native-is-faster cases, so any future eligibility
 * classifier is trained/validated on MEASURED rows instead of intuition.
 *
 * The labels are deliberately conservative and every label is derived from
 * recorded evidence in the row, never asserted:
 *
 *   eligible-candidate  provenTopK && orderedExact && recall===1 && providerFaster
 *   proof-positive-slow provenTopK && orderedExact && !providerFaster
 *   proof-negative      !provenTopK (proof failure / incompleteness / mismatch)
 *   parity-failure      orderedExact === false
 *   incomplete          complete === false
 *   unavailable         provider not measured
 *
 * An `eligible-candidate` label is EVIDENCE, never authorization: Phase 4 stays
 * HOLD until independent proof of parity, completeness, fresh generation
 * ownership, and end-to-end win all exist for the same query class.
 *
 * Usage:
 *   bun packages/core/script/everything-bench/build-classifier-dataset.ts \
 *     --rows=tmp/everything-bench/w-drive-rows.json,tmp/everything-bench/repo-rows.json \
 *     --out=tmp/everything-bench/classifier-dataset.json
 */
import fs from "node:fs"

type Args = Record<string, string>
function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (const item of argv) {
    if (!item.startsWith("--")) continue
    const eq = item.indexOf("=")
    if (eq < 0) args[item.slice(2)] = "true"
    else args[item.slice(2, eq)] = item.slice(eq + 1)
  }
  return args
}

type Row = Record<string, unknown>

function labelsFor(row: Row) {
  const labels: string[] = []
  const measured = row.measured === true
  const proven = row.provenTopK === true
  const exact = row.orderedExact === true
  const recall = row.recall
  const faster = row.providerFaster === true
  const complete = row.complete === true

  if (!measured) labels.push("unavailable")
  if (measured && !complete) labels.push("incomplete")
  if (measured && !exact) labels.push("parity-failure")
  if (measured && !proven) labels.push("proof-negative")
  if (measured && proven && exact && recall === 1 && faster) labels.push("eligible-candidate")
  if (measured && proven && exact && !faster) labels.push("proof-positive-slow")
  if (measured && faster && !proven) labels.push("faster-but-unproven")
  return labels
}

function shapeOf(query: string) {
  if (!/^[a-z0-9]{2,8}$/.test(query)) return { token: query, length: query.length, class: "non-single-token" }
  const length = query.length
  return {
    token: query,
    length,
    class: length <= 3 ? "short-acronymish" : length <= 5 ? "mid" : "long",
  }
}

const args = parseArgs(process.argv.slice(2))
const files = (args.rows ?? "").split(",").map((value) => value.trim()).filter(Boolean)
if (files.length === 0) {
  console.error("usage: build-classifier-dataset.ts --rows=a.json,b.json [--out=dataset.json]")
  process.exit(2)
}

const sources: Array<{ file: string; corpusEntries: number; root: string; generatedAt: string }> = []
const records: Array<Row & { labels: string[]; scale: number }> = []

for (const file of files) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    root: string
    corpusEntries: number
    generatedAt: string
    rows?: Row[]
    keystreamRows?: Row[]
  }
  sources.push({
    file,
    root: parsed.root,
    corpusEntries: parsed.corpusEntries,
    generatedAt: parsed.generatedAt,
  })
  for (const row of [...(parsed.rows ?? []), ...(parsed.keystreamRows ?? [])]) {
    const query = String(row.query ?? "")
    records.push({
      ...row,
      source: file,
      scale: parsed.corpusEntries,
      shape: shapeOf(query),
      labels: labelsFor(row),
    })
  }
}

const byLabel: Record<string, number> = {}
for (const record of records)
  for (const label of record.labels) byLabel[label] = (byLabel[label] ?? 0) + 1

const scales = [...new Set(records.map((record) => record.scale))].sort((a, b) => a - b)
const eligible = records.filter((record) => record.labels.includes("eligible-candidate"))
const proofPositiveSlow = records.filter((record) => record.labels.includes("proof-positive-slow"))
const proofNegative = records.filter((record) => record.labels.includes("proof-negative"))

// Separability: can corpus size alone predict a win? This is the exact claim
// the architecture ledger already rejects, so it is recomputed from data.
const winsByScale = scales.map((scale) => {
  const atScale = records.filter((record) => record.scale === scale)
  return {
    scale,
    rows: atScale.length,
    wins: atScale.filter((record) => record.providerFaster === true).length,
    proven: atScale.filter((record) => record.provenTopK === true).length,
    eligible: atScale.filter((record) => record.labels.includes("eligible-candidate")).length,
  }
})

const out = {
  generatedAt: new Date().toISOString(),
  note: "Measured evidence only. An eligible-candidate label is NOT authorization; Phase 4 remains HOLD.",
  sources,
  scaleBuckets: scales,
  labelCounts: byLabel,
  corpusSizeOnlyPredictsWin: winsByScale.every((bucket) => bucket.wins === bucket.rows || bucket.wins === 0),
  byScale: winsByScale,
  eligibleCandidates: eligible.map((record) => ({
    scale: record.scale,
    query: record.query,
    ratio: record.ratio,
    nativeMsP50: record.nativeMsP50,
    providerMsP50: record.providerMsP50,
    proofFloor: record.proofFloor,
    omittedScoreUpperBound: record.omittedScoreUpperBound,
    candidates: record.candidateCount,
    serverUpperBound: record.serverUpperBound,
  })),
  proofPositiveSlow: proofPositiveSlow.map((record) => ({
    scale: record.scale,
    query: record.query,
    ratio: record.ratio,
    nativeMsP50: record.nativeMsP50,
    providerMsP50: record.providerMsP50,
  })),
  proofNegative: proofNegative.map((record) => ({
    scale: record.scale,
    query: record.query,
    recall: record.recall,
    orderedExact: record.orderedExact,
    complete: record.complete,
    exhaustible: record.exhaustible,
    proofFloor: record.proofFloor,
    omittedScoreUpperBound: record.omittedScoreUpperBound,
    candidates: record.candidateCount,
    serverUpperBound: record.serverUpperBound,
  })),
  records,
}

if (args.out) {
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2))
  console.error(
    JSON.stringify({ wrote: args.out, records: records.length, labelCounts: byLabel, byScale: winsByScale }),
  )
} else {
  console.log(JSON.stringify({ labelCounts: byLabel, byScale: winsByScale }, null, 2))
}