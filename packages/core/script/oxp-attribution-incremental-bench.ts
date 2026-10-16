/**
 * Synthetic projector benchmark only: deliberately excludes SQLite latency,
 * network transport, React rendering, and native OXP recording costs.
 * Run: bun script/oxp-attribution-incremental-bench.ts
 */
import { performance } from "node:perf_hooks"
import { OxpAttributionModel as Model, type Row } from "../src/oxp-attribution/model"
import { OxpAttributionCalibration as Calibration } from "../src/oxp-attribution/calibration"
import { Rollup } from "../src/oxp-attribution/rollup"

const options: Model.ProjectOptions = {
  turnGapThresholdMs: Calibration.turnGapThresholdMs,
  requestCharsPerToken: Calibration.requestCharsPerToken,
  resultCharsPerToken: Calibration.resultCharsPerToken,
  upstream: Calibration.upstream,
}

const groups = 600
const perGroup = 120
const rounds = 35
const mass = (chars: number) => ({ chars, source: "observed_boundary" as const })
const histories: Row[][] = Array.from({ length: groups }, (_, activity) =>
  Array.from({ length: perGroup }, (_, index) => ({
    id: `call-${activity}-${index}`,
    activityID: `activity-${String(activity).padStart(5, "0")}`,
    tool: index % 3 ? "read" : "process",
    status: "success",
    startedAt: index * 100,
    completedAt: index * 100 + 40,
    request: mass(100 + (index % 7)),
    result: mass(500 + (index % 31)),
  })),
)

const coverage = (count: number) => ({
  request: { observed_boundary: count, historical_detail: 0, calibrated_surrogate: 0, calibrated_donor: 0, unavailable: 0 },
  result: { observed_boundary: count, historical_detail: 0, calibrated_surrogate: 0, calibrated_donor: 0, unavailable: 0, not_applicable: 0 },
  invalidPersistedMeasurements: 0,
  complete: true,
} as const)

const rollup = new Rollup()
for (const history of histories) rollup.update(history[0]!.activityID, {
  totals: Model.project(history, options), coverage: coverage(history.length),
})

const fullTimes: number[] = []
const deltaTimes: number[] = []
let check = 0
for (let round = 0; round < rounds; round++) {
  const affected = round % groups
  const history = histories[affected]!
  const last = history[history.length - 1]!
  history[history.length - 1] = { ...last, result: mass(500 + round) }

  const beforeFull = performance.now()
  const expected = Model.project(histories.flat(), options)
  fullTimes.push(performance.now() - beforeFull)

  const beforeDelta = performance.now()
  rollup.update(history[0]!.activityID, {
    totals: Model.project(history, options), coverage: coverage(history.length),
  })
  const actual = rollup.snapshot(options).totals
  deltaTimes.push(performance.now() - beforeDelta)
  if (Math.abs(expected.estimatedTotalTokens - actual.estimatedTotalTokens) > 1e-6) {
    throw new Error(`Model divergence at round ${round}`)
  }
  check += actual.calls
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const full = median(fullTimes)
const delta = median(deltaTimes)
console.log(JSON.stringify({
  kind: "synthetic-projector-only", activities: groups, rows: groups * perGroup,
  changedActivityRows: perGroup, rounds, fullMedianMs: full, incrementalMedianMs: delta,
  speedup: full / delta, checksum: check,
}, null, 2))