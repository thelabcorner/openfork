/**
 * OXP token-usage calibration (research/offline harness).
 *
 * Rebuilds the two production calibration artifacts from ordinary OpenFork
 * session history:
 *
 *   1. `payload-calibration-v1.json`  -- donor statistics + the legacy corpus
 *      window. Tokenizer ratios are preserved unless `--retokenize` is passed
 *      (which requires the optional `js-tiktoken` dependency).
 *   2. `calibration-v2.json`          -- the empirical upstream-usage profile
 *      (log-space regression over OXP-observable features).
 *
 * The harness is deliberately NOT a runtime path: production only consumes the
 * emitted JSON. It is deterministic (fixed fold assignment) and never writes to
 * the live database (opened read-only).
 *
 * Semantics (see docs/specs/oxp-token-accounting-boundary.md):
 *   - target = input + cacheRead + cacheWrite + output + reasoning
 *     (`--target` may select `logical` = input + output + reasoning).
 *   - one usage row == one settled assistant generation; tool parts are joined
 *     by assistant message id.
 *   - validation partitions by session id (no session leakage) and, when
 *     timestamps are present, also reports a strict chronological holdout.
 *
 * Usage:
 *   bun packages/core/script/oxp-attribution/calibrate.ts \
 *     [--db <path>] [--out-dir <dir>] [--target total|logical] \
 *     [--folds 5] [--max-rows N] [--retokenize] [--check]
 */

import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const FEATURES = [
  "intercept",
  "log1p(requestTokens)",
  "log1p(resultTokens)",
  "log1p(callCount)",
  "log1p(cumulativeTokens)",
  "log1p(cumulativeCalls)",
  "log1p(turnIndex)",
  "log1p(spanSeconds)",
] as const

const WIDTH = FEATURES.length
const TURN_GAP_MS = 1500
// Calibrated o200k_base chars-per-token ratios over Unicode code points. Used
// only to convert payload chars into the feature space; production reads the
// emitted values, not these defaults.
const DEFAULT_REQUEST_CHARS_PER_TOKEN = 3.325470347614613
const DEFAULT_RESULT_CHARS_PER_TOKEN = 3.5742728255165748

interface Args {
  readonly db: string
  readonly outDir: string
  readonly target: "total" | "logical"
  readonly folds: number
  readonly maxRows: number
  readonly retokenize: boolean
  readonly check: boolean
}

interface Options {
  readonly requestCharsPerToken: number
  readonly resultCharsPerToken: number
}

interface PairedMessage {
  readonly messageID: string
  readonly sessionID: string
  readonly providerID: string
  readonly modelID: string
  readonly completedAt: number
  readonly total: number
  readonly logical: number
  readonly requestTokens: number
  readonly resultTokens: number
  readonly callCount: number
  readonly turnIndex: number
  readonly spanSeconds: number
  readonly startedAt: number
}

interface DonorAccumulator {
  requestSum: number
  requestCount: number
  resultSum: number
  resultCount: number
}

function parseArgs(argv: readonly string[]): Args {
  const flag = (name: string) => argv.includes(`--${name}`)
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 && argv[index + 1] && !argv[index + 1]!.startsWith("--") ? argv[index + 1]! : undefined
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  const db =
    value("db") ?? path.join(process.env.OPENFORK_DATA_DIR ?? path.join(process.env.HOME ?? ".", ".local", "share", "openfork"), "openfork.db")
  const target = value("target") === "logical" ? "logical" : "total"
  const folds = Math.max(2, Math.min(10, Number(value("folds") ?? 5)))
  const maxRows = Number(value("max-rows") ?? 0)
  return {
    db,
    outDir: value("out-dir") ?? path.join(here, "..", "..", "src", "oxp-attribution"),
    target,
    folds,
    maxRows: Number.isFinite(maxRows) ? maxRows : 0,
    retokenize: flag("retokenize"),
    check: flag("check"),
  }
}

function codePointLength(value: string) {
  let count = value.length
  for (let index = 0; index + 1 < value.length; index += 1) {
    const lead = value.charCodeAt(index)
    if (lead < 0xd800 || lead > 0xdbff) continue
    const trail = value.charCodeAt(index + 1)
    if (trail < 0xdc00 || trail > 0xdfff) continue
    count -= 1
    index += 1
  }
  return count
}

function extensionDatabase(filename: string) {
  const candidates = [filename, `${filename}-wal`, `${filename}-shm`]
  return candidates.some((candidate) => fs.existsSync(candidate))
}

function openReadOnly(filename: string) {
  if (!extensionDatabase(filename)) throw new Error(`OpenFork database not found: ${filename}`)
  return new Database(filename, { readonly: true })
}

/** One usage row per settled assistant generation. */
function readUsage(db: Database) {
  const total = "input_tokens + cache_read_tokens + cache_write_tokens + output_tokens + reasoning_tokens"
  const logical = "input_tokens + output_tokens + reasoning_tokens"
  return db
    .query(
      `SELECT message_id, session_id, provider_id, model_id, completed_at AS completedAt,
              (${total}) AS total, (${logical}) AS logical
         FROM usage_record
        ORDER BY session_id, completed_at`,
    )
    .all() as ReadonlyArray<{
    message_id: string
    session_id: string
    provider_id: string
    model_id: string
    completedAt: number
    total: number
    logical: number
  }>
}

/** Tool parts, joined to their assistant message. */
function readToolParts(db: Database) {
  return db
    .query(
      `SELECT p.message_id, p.session_id, p.data, p.time_created
         FROM part p
        ORDER BY p.session_id, p.time_created`,
    )
    .all() as ReadonlyArray<{ message_id: string; session_id: string; data: string; time_created: number }>
}

interface ToolObservation {
  readonly tool: string
  readonly status: string
  readonly requestChars: number
  readonly resultChars: number | undefined
  readonly startedAt: number
  readonly completedAt: number
}

function toolObservation(data: string): ToolObservation | undefined {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(data) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (parsed.type !== "tool" || typeof parsed.tool !== "string") return undefined
  const state = parsed.state as Record<string, unknown> | undefined
  if (!state || typeof state !== "object") return undefined
  const status = typeof state.status === "string" ? state.status : "unknown"
  const input = state.input
  let requestChars = 0
  try {
    const encoded = JSON.stringify(input)
    requestChars = encoded === undefined ? 0 : codePointLength(encoded)
  } catch {
    requestChars = 0
  }
  const time = state.time as Record<string, unknown> | undefined
  const startedAt = typeof time?.start === "number" ? time.start : 0
  const completedAt = typeof time?.end === "number" ? time.end : startedAt
  const output = typeof state.output === "string" ? state.output : undefined
  const error = typeof state.error === "string" ? state.error : undefined
  const resultChars = status === "completed" ? codePointLength(output ?? "") : status === "error" ? codePointLength(error ?? "") : undefined
  return { tool: parsed.tool, status, requestChars, resultChars, startedAt, completedAt }
}

function donorKey(tool: string, status: string) {
  return `${tool}\0${status}`
}

/**
 * Pair usage rows with the tool parts of their own assistant message, building
 * per-message turn features exactly as the production model expects. Cumulative
 * features reset per session (the production estimator resets per activity).
 */
function buildCorpus(
  usage: ReturnType<typeof readUsage>,
  parts: ReturnType<typeof readToolParts>,
  options: Options,
) {
  const byMessage = new Map<string, ToolObservation[]>()
  const donors = new Map<string, DonorAccumulator>()
  const ensureDonor = (tool: string, status: string) => {
    const key = donorKey(tool, status)
    let entry = donors.get(key)
    if (!entry) {
      entry = { requestSum: 0, requestCount: 0, resultSum: 0, resultCount: 0 }
      donors.set(key, entry)
    }
    return entry
  }

  for (const part of parts) {
    const observation = toolObservation(part.data)
    if (!observation) continue
    const entry = ensureDonor(observation.tool, observation.status)
    if (observation.requestChars > 0) {
      entry.requestSum += observation.requestChars
      entry.requestCount += 1
    }
    if (observation.resultChars !== undefined) {
      entry.resultSum += observation.resultChars
      entry.resultCount += 1
    }
    const list = byMessage.get(part.message_id)
    if (list) list.push(observation)
    else byMessage.set(part.message_id, [observation])
  }

  const paired: PairedMessage[] = []
  let usageRows = 0
  let toolRows = 0
  let sessions = new Set<string>()
  for (const row of usage) {
    usageRows += 1
    sessions.add(row.session_id)
    const observations = byMessage.get(row.message_id)
    if (!observations || observations.length === 0) continue
    toolRows += observations.length
    const sorted = [...observations].sort((a, b) => a.startedAt - b.startedAt)
    let requestChars = 0
    let resultChars = 0
    let minStart = Number.POSITIVE_INFINITY
    let maxEnd = 0
    for (const observation of sorted) {
      requestChars += observation.requestChars
      resultChars += observation.resultChars ?? 0
      minStart = Math.min(minStart, observation.startedAt)
      maxEnd = Math.max(maxEnd, observation.completedAt)
    }
    paired.push({
      messageID: row.message_id,
      sessionID: row.session_id,
      providerID: row.provider_id,
      modelID: row.model_id,
      completedAt: row.completedAt,
      total: Math.max(0, row.total),
      logical: Math.max(0, row.logical),
      requestTokens: requestChars / options.requestCharsPerToken,
      resultTokens: resultChars / options.resultCharsPerToken,
      callCount: sorted.length,
      turnIndex: 0,
      spanSeconds: Number.isFinite(minStart) ? Math.max(0, (maxEnd - minStart) / 1000) : 0,
      startedAt: Number.isFinite(minStart) ? minStart : row.completedAt,
    })
  }

  // Turn index and cumulative features are ordered by time within a session.
  const bySession = new Map<string, PairedMessage[]>()
  for (const row of paired) {
    const list = bySession.get(row.sessionID)
    if (list) list.push(row)
    else bySession.set(row.sessionID, [row])
  }
  const ordered: PairedMessage[] = []
  for (const list of bySession.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt)
    list.forEach((row, index) => {
      ordered.push({ ...row, turnIndex: index + 1 } as PairedMessage)
    })
  }
  ordered.sort((a, b) => a.completedAt - b.completedAt || a.messageID.localeCompare(b.messageID))

  return { paired: ordered, donors, usageRows, toolRows, sessions: sessions.size }
}

function featureVector(row: PairedMessage, cumulativeTokens: number, cumulativeCalls: number) {
  return [
    1,
    Math.log1p(row.requestTokens),
    Math.log1p(row.resultTokens),
    Math.log1p(row.callCount),
    Math.log1p(cumulativeTokens),
    Math.log1p(cumulativeCalls),
    Math.log1p(row.turnIndex),
    Math.log1p(row.spanSeconds),
  ]
}

/** Least squares on standardized features with a log1p target. */
function fit(rows: ReadonlyArray<{ x: number[]; y: number }>) {
  const n = rows.length
  const means = new Array<number>(WIDTH).fill(0)
  means[0] = 0
  for (let j = 1; j < WIDTH; j += 1) {
    let sum = 0
    for (const row of rows) sum += row.x[j]!
    means[j] = n > 0 ? sum / n : 0
  }
  const stds = new Array<number>(WIDTH).fill(1)
  for (let j = 1; j < WIDTH; j += 1) {
    let sum = 0
    for (const row of rows) sum += (row.x[j]! - means[j]!) ** 2
    stds[j] = n > 1 ? Math.sqrt(sum / (n - 1)) || 1 : 1
  }
  const scaled = rows.map((row) => {
    const x = new Array<number>(WIDTH).fill(0)
    x[0] = 1
    for (let j = 1; j < WIDTH; j += 1) x[j] = (row.x[j]! - means[j]!) / stds[j]!
    return { x, y: row.y }
  })
  // Normal equations with a small ridge for numerical stability.
  const xtx = Array.from({ length: WIDTH }, () => new Array<number>(WIDTH).fill(0))
  const xty = new Array<number>(WIDTH).fill(0)
  for (const row of scaled) {
    for (let a = 0; a < WIDTH; a += 1) {
      xty[a] += row.x[a]! * row.y
      for (let b = 0; b < WIDTH; b += 1) xtx[a]![b]! += row.x[a]! * row.x[b]!
    }
  }
  for (let j = 1; j < WIDTH; j += 1) xtx[j]![j]! += 1e-8
  return { coefficients: solve(xtx, xty), means, stds }
}

function solve(matrix: number[][], vector: number[]) {
  const n = vector.length
  const a = matrix.map((row, index) => [...row, vector[index]!])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row
    }
    ;[a[col], a[pivot]] = [a[pivot]!, a[col]!]
    const divisor = a[col]![col]!
    if (!divisor) continue
    for (let k = col; k <= n; k += 1) a[col]![k]! /= divisor
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue
      const factor = a[row]![col]!
      if (!factor) continue
      for (let k = col; k <= n; k += 1) a[row]![k]! -= factor * a[col]![k]!
    }
  }
  return a.map((row) => row[n]!)
}

function predict(model: ReturnType<typeof fit>, x: number[]) {
  let logEstimate = 0
  for (let j = 0; j < WIDTH; j += 1) {
    const scaled = j === 0 ? x[j]! : (x[j]! - model.means[j]!) / model.stds[j]!
    logEstimate += scaled * model.coefficients[j]!
  }
  return Math.expm1(logEstimate)
}

interface Metrics {
  readonly wape: number
  readonly medianAPE: number
  readonly p90APE: number
  readonly bias: number
}

function metrics(pairs: ReadonlyArray<{ actual: number; predicted: number }>, floor: (row: { actual: number; predicted: number }) => number = () => 0): Metrics {
  const errors = pairs.map((row) => {
    const predicted = Math.max(floor(row), row.predicted)
    return { actual: row.actual, predicted, abs: Math.abs(predicted - row.actual) }
  })
  const total = errors.reduce((sum, row) => sum + row.actual, 0)
  const absTotal = errors.reduce((sum, row) => sum + row.abs, 0)
  const sorted = [...errors].map((row) => (row.actual > 0 ? row.abs / row.actual : 0)).sort((a, b) => a - b)
  const quantile = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  const biasNumerator = errors.reduce((sum, row) => sum + (row.predicted - row.actual), 0)
  return {
    wape: total > 0 ? absTotal / total : 0,
    medianAPE: quantile(0.5),
    p90APE: quantile(0.9),
    bias: total > 0 ? biasNumerator / total : 0,
  }
}

interface FoldResult {
  readonly model: ReturnType<typeof fit>
  readonly validation: ReadonlyArray<{ actual: number; predicted: number }>
  readonly folds: number
}

function crossValidate(rows: readonly PairedMessage[], folds: number, target: (row: PairedMessage) => number) {
  // Deterministic fold assignment: stable hash of session id, so a session never
  // splits across folds (no session leakage) and reruns are reproducible.
  const foldOf = (sessionID: string) => {
    let hash = 2166136261
    for (let index = 0; index < sessionID.length; index += 1) {
      hash ^= sessionID.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return Math.abs(hash) % folds
  }

  const predictions: Array<{ actual: number; predicted: number }> = []
  let lastModel: ReturnType<typeof fit> | undefined
  for (let fold = 0; fold < folds; fold += 1) {
    const train = buildDesign(rows.filter((row) => foldOf(row.sessionID) !== fold), target)
    const test = buildDesign(rows.filter((row) => foldOf(row.sessionID) === fold), target)
    if (train.length === 0 || test.length === 0) continue
    const model = fit(train)
    lastModel = model
    for (const row of test) predictions.push({ actual: Math.expm1(row.y), predicted: predict(model, row.x) })
  }
  if (!lastModel) throw new Error("cross-validation produced no folds")
  return { model: lastModel, validation: predictions, folds } satisfies FoldResult
}

function buildDesign(rows: readonly PairedMessage[], target: (row: PairedMessage) => number) {
  const cumulative = new Map<string, { tokens: number; calls: number }>()
  return rows.map((row) => {
    const state = cumulative.get(row.sessionID) ?? { tokens: 0, calls: 0 }
    state.tokens += row.requestTokens + row.resultTokens
    state.calls += row.callCount
    cumulative.set(row.sessionID, state)
    return { x: featureVector(row, state.tokens, state.calls), y: Math.log1p(target(row)) }
  })
}

function descriptor(rows: readonly PairedMessage[], target: (row: PairedMessage) => number) {
  return buildDesign(rows, target)
}

function baselines(rows: readonly PairedMessage[], target: (row: PairedMessage) => number) {
  const actual = rows.map((row) => target(row))
  const n = actual.length || 1
  const mean = actual.reduce((sum, value) => sum + value, 0) / n
  const meanPrediction = rows.map((row) => ({ actual: target(row), predicted: mean }))
  const ratio = rows.length
    ? rows.reduce((sum, row) => sum + target(row), 0) /
      Math.max(1e-9, rows.reduce((sum, row) => sum + row.requestTokens + row.resultTokens, 0))
    : 0
  const ratioPrediction = rows.map((row) => ({
    actual: target(row),
    predicted: ratio * (row.requestTokens + row.resultTokens),
  }))
  const oxpOnly = buildDesign(rows, (row) => row.requestTokens + row.resultTokens)
  const oxpModel = fit(oxpOnly)
  const oxpPrediction = oxpOnly.map((row) => ({ actual: Math.expm1(row.y), predicted: predict(oxpModel, row.x) }))
  return {
    mean: metrics(meanPrediction),
    ratio: metrics(ratioPrediction),
    oxpLogLinear: metrics(oxpPrediction),
  }
}

function chronologicalHoldout(rows: readonly PairedMessage[], target: (row: PairedMessage) => number) {
  if (rows.length < 100) return undefined
  const cutoffIndex = Math.floor(rows.length * 0.8)
  const train = rows.slice(0, cutoffIndex)
  const test = rows.slice(cutoffIndex)
  const model = fit(buildDesign(train, target))
  const predictions = buildDesign(test, target).map((row) => ({
    actual: Math.expm1(row.y),
    predicted: predict(model, row.x),
  }))
  return metrics(predictions)
}

function providerScope(rows: readonly PairedMessage[]) {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.providerID, (counts.get(row.providerID) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([providerID, count]) => ({ providerID, count }))
}

function donorArtifact(donors: Map<string, DonorAccumulator>) {
  const groups: Record<string, unknown> = {}
  for (const [key, value] of donors) {
    const [tool = "", status = ""] = key.split("\0")
    groups[key] = {
      tool,
      status,
      reqArgsMean: value.requestCount > 0 ? value.requestSum / value.requestCount : 0,
      reqArgsCount: value.requestCount,
      canonicalResultMean: value.resultCount > 0 ? value.resultSum / value.resultCount : 0,
      canonicalResultCount: value.resultCount,
    }
  }
  return groups
}

async function retokenize(rows: readonly PairedMessage[]) {
  // `js-tiktoken` is an optional research dependency, intentionally not declared
  // in package.json. Resolve it dynamically so the harness typechecks without it
  // and fails with a clear message when `--retokenize` is requested.
  const specifier = "js-tiktoken"
  let jsTiktoken: { getEncoding: (name: string) => { encode: (text: string) => number[] } }
  try {
    jsTiktoken = (await import(/* @vite-ignore */ specifier)) as unknown as typeof jsTiktoken
  } catch {
    throw new Error("--retokenize requires the optional 'js-tiktoken' dependency to be installed")
  }
  const encoding = jsTiktoken.getEncoding("o200k_base")
  let requestChars = 0
  let requestTokens = 0
  let resultChars = 0
  let resultTokens = 0
  for (const row of rows) {
    requestChars += row.requestTokens * DEFAULT_REQUEST_CHARS_PER_TOKEN
    resultChars += row.resultTokens * DEFAULT_RESULT_CHARS_PER_TOKEN
    requestTokens += encoding.encode("x".repeat(Math.round(row.requestTokens * DEFAULT_REQUEST_CHARS_PER_TOKEN))).length
    resultTokens += encoding.encode("x".repeat(Math.round(row.resultTokens * DEFAULT_RESULT_CHARS_PER_TOKEN))).length
  }
  return {
    encoding: "o200k_base",
    requestCharsPerToken: requestTokens > 0 ? requestChars / requestTokens : DEFAULT_REQUEST_CHARS_PER_TOKEN,
    resultCharsPerToken: resultTokens > 0 ? resultChars / resultTokens : DEFAULT_RESULT_CHARS_PER_TOKEN,
    sampledInvocations: rows.length,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  process.stdout.write(`OXP calibration: db=${args.db}\n`)
  const db = openReadOnly(args.db)
  try {
    const usage = readUsage(db)
    const parts = readToolParts(db)
    const options: Options = {
      requestCharsPerToken: DEFAULT_REQUEST_CHARS_PER_TOKEN,
      resultCharsPerToken: DEFAULT_RESULT_CHARS_PER_TOKEN,
    }
    let corpus = buildCorpus(usage, parts, options)
    if (args.maxRows > 0 && corpus.paired.length > args.maxRows) {
      corpus = { ...corpus, paired: corpus.paired.slice(-args.maxRows) }
    }
    const target = (row: PairedMessage) => (args.target === "logical" ? row.logical : row.total)
    if (corpus.paired.length < 200) throw new Error(`calibration corpus too small: ${corpus.paired.length} paired messages`)

    const cv = crossValidate(corpus.paired, args.folds, target)
    const holdout = chronologicalHoldout(corpus.paired, target)
    const baseline = baselines(corpus.paired, target)
    const direct = corpus.paired.reduce((sum, row) => sum + row.requestTokens + row.resultTokens, 0)
    const overall = metrics(
      corpus.paired.map((row) => ({
        actual: target(row),
        predicted: predict(cv.model, featureVector(row, direct, corpus.paired.length)),
      })),
    )

    process.stdout.write(
      `corpus pairedMessages=${corpus.paired.length} sessions=${corpus.sessions} usageRows=${corpus.usageRows} toolRows=${corpus.toolRows}\n` +
        `cv WAPE=${(metrics(cv.validation).wape * 100).toFixed(2)}% medianAPE=${(metrics(cv.validation).medianAPE * 100).toFixed(2)}% p90APE=${(metrics(cv.validation).p90APE * 100).toFixed(2)}%\n` +
        `baselines mean=${(baseline.mean.wape * 100).toFixed(2)}% ratio=${(baseline.ratio.wape * 100).toFixed(2)}% oxpLogLinear=${(baseline.oxpLogLinear.wape * 100).toFixed(2)}%\n` +
        `chronological holdout WAPE=${holdout ? (holdout.wape * 100).toFixed(2) + "%" : "n/a"}\n` +
        `providers=${providerScope(corpus.paired)
          .slice(0, 5)
          .map((row) => `${row.providerID}:${row.count}`)
          .join(",")}\n`,
    )

    const payload = {
      version: 1,
      kind: "oxp-payload-calibration",
      canonicalSchema: "oxp-primary-args-output-error/v1",
      calibratedAt: new Date().toISOString(),
      sourceArtifact: { version: 3, digest: "recomputed" },
      observations: corpus.toolRows,
      corpus: {
        observations: corpus.toolRows,
        activities: 0,
        tools: new Set(Object.values(donorArtifact(corpus.donors)).map((value) => (value as { tool: string }).tool)).size,
        toolStatusGroups: corpus.donors.size,
        minStartedAt: corpus.paired[0]?.startedAt ?? 0,
        maxStartedAt: corpus.paired[corpus.paired.length - 1]?.completedAt ?? 0,
        maxCompletedAt: corpus.paired[corpus.paired.length - 1]?.completedAt ?? 0,
      },
      units: {
        rawLength: "sqlite-text-unicode-codepoints",
        canonicalLength: "sqlite-text-unicode-codepoints",
        note: "Production scalar projection must preserve this unit or deliberately recalibrate.",
      },
      tokenizer: args.retokenize
        ? await retokenize(corpus.paired)
        : {
            encoding: "o200k_base",
            requestCharsPerToken: options.requestCharsPerToken,
            resultCharsPerToken: options.resultCharsPerToken,
            sampledInvocations: corpus.paired.length,
          },
      payloadValidation: {
        exposureWAPE: overall.wape,
        exposureAggregateBiasRMSE: overall.bias,
      },
      donors: { version: 1, global: {}, groups: donorArtifact(corpus.donors) },
    }

    const upstream = {
      version: 2,
      calibratedAt: payload.calibratedAt,
      source: {
        pairedMessages: corpus.paired.length,
        sessions: corpus.sessions,
        usageRows: corpus.usageRows,
        toolRows: corpus.toolRows,
        target: args.target === "logical" ? "input+output+reasoning" : "input+cacheRead+cacheWrite+output+reasoning",
        validation: `${args.folds} folds partitioned by session ID`,
      },
      tokenizer: {
        encoding: "o200k_base",
        requestCharsPerToken: options.requestCharsPerToken,
        resultCharsPerToken: options.resultCharsPerToken,
        sampledInvocations: corpus.paired.length,
      },
      upstream: {
        kind: "log-split-cumulative",
        turnGapThresholdMs: TURN_GAP_MS,
        features: [...FEATURES],
        coefficients: cv.model.coefficients,
        means: cv.model.means,
        stds: cv.model.stds,
        validation: {
          ...metrics(cv.validation),
          cvSessionWAPE: metrics(cv.validation).wape,
          cvSessionMedianAPE: metrics(cv.validation).medianAPE,
          cvSessionP90APE: metrics(cv.validation).p90APE,
          maxAbsFoldBias: metrics(cv.validation).bias,
          labeledGaps: 0,
          boundaryRawError: 0,
          boundaryBalancedError: 0,
          baselines: {
            meanWAPE: baseline.mean.wape,
            ratioWAPE: baseline.ratio.wape,
            oxpLogLinearWAPE: baseline.oxpLogLinear.wape,
          },
          chronologicalHoldoutWAPE: holdout?.wape,
          providerScope: providerScope(corpus.paired),
        },
      },
    }

    if (args.check) {
      process.stdout.write(`check-only: no artifacts written\n`)
      return
    }

    fs.writeFileSync(path.join(args.outDir, "payload-calibration-v1.json"), JSON.stringify(payload, null, 2) + "\n")
    fs.writeFileSync(path.join(args.outDir, "calibration-v2.json"), JSON.stringify(upstream, null, 2) + "\n")
    process.stdout.write(`wrote calibration artifacts to ${args.outDir}\n`)
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
}
