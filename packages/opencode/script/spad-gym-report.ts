import { createHash } from "node:crypto"
import { DEFAULT_SPAD_CONFIG } from "../src/session/spad/config"
import { makeTurnPolicy } from "../src/session/spad/intent"
import { SpadSupervisor } from "../src/session/spad/supervisor"
import type { SpadAction } from "../src/session/spad/types"
import {
  counterfactualPairs,
  negativeCases,
  type ProtectedNegativeClass,
  type TextCase,
} from "../test/session/spad-gym-fixtures"

function runText(input: TextCase, chunks: readonly number[] = [97, 31, 7]): SpadAction | undefined {
  const sup = new SpadSupervisor(DEFAULT_SPAD_CONFIG)
  sup.beginTurn(makeTurnPolicy(input.user ?? "Continue the task.", input.structured ?? false))
  sup.startPart("text")
  let at = 0
  let i = 0
  while (at < input.text.length) {
    const size = chunks[i++ % chunks.length]!
    const action = sup.push(input.text.slice(at, at + size))
    if (action) return action
    at += size
  }
  return undefined
}

function isDestructive(action: SpadAction | undefined): boolean {
  return action?.type === "recover" || action?.type === "abort"
}

function zeroEventUpper95(n: number): number | null {
  if (n <= 0) return null
  return 1 - Math.pow(0.05, 1 / n)
}

type ClassRow = {
  class: ProtectedNegativeClass
  cases: number
  codeUnits: number
  destructiveInterventions: number
  zeroEventCaseUpper95: number | null
}

const byClass = new Map<ProtectedNegativeClass, ClassRow>()
let totalCodeUnits = 0
let totalDestructive = 0
for (const item of negativeCases) {
  const action = runText(item)
  const destructive = isDestructive(action) ? 1 : 0
  const row = byClass.get(item.class) ?? {
    class: item.class,
    cases: 0,
    codeUnits: 0,
    destructiveInterventions: 0,
    zeroEventCaseUpper95: null,
  }
  row.cases++
  row.codeUnits += item.text.length
  row.destructiveInterventions += destructive
  byClass.set(item.class, row)
  totalCodeUnits += item.text.length
  totalDestructive += destructive
}
for (const row of byClass.values()) {
  row.zeroEventCaseUpper95 = row.destructiveInterventions === 0 ? zeroEventUpper95(row.cases) : null
}

const counterfactual = counterfactualPairs.map((pair) => {
  const healthy = runText(pair.healthy)
  const degenerate = runText(pair.degenerate)
  return {
    name: pair.name,
    healthyDestructive: isDestructive(healthy),
    degenerateAction: degenerate?.type ?? null,
    degenerateLane: degenerate?.detection.lane ?? null,
    exactVerifiedSpan: degenerate?.detection.exactVerifiedSpan ?? null,
  }
})

const registryHash = createHash("sha256")
  .update(JSON.stringify({ negativeCases, counterfactualPairs }))
  .digest("hex")

const rows = [...byClass.values()].sort((a, b) => a.class.localeCompare(b.class))
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  registrySha256: registryHash,
  note: "Synthetic regression exposure only. Case-level zero-event bounds are not production FP-rate estimates and code units are not independent Bernoulli trials.",
  productionProfile: {
    autoRecoverRaw: DEFAULT_SPAD_CONFIG.autoRecoverRaw,
    autoRecoverCanonical: DEFAULT_SPAD_CONFIG.autoRecoverCanonical,
    autoRecoverExpansion: DEFAULT_SPAD_CONFIG.autoRecoverExpansion,
    autoRecoverPersistedMotifs: DEFAULT_SPAD_CONFIG.autoRecoverPersistedMotifs,
    autoRecoverToolLoop: DEFAULT_SPAD_CONFIG.autoRecoverToolLoop,
    autoRecoverThrash: DEFAULT_SPAD_CONFIG.autoRecoverThrash,
  },
  totals: {
    protectedClasses: rows.length,
    cases: negativeCases.length,
    codeUnits: totalCodeUnits,
    destructiveInterventions: totalDestructive,
    zeroEventCaseUpper95: totalDestructive === 0 ? zeroEventUpper95(negativeCases.length) : null,
  },
  classes: rows,
  counterfactual,
}

console.log(JSON.stringify(report, null, 2))

if (totalDestructive > 0 || counterfactual.some((row) => row.healthyDestructive || row.degenerateAction !== "recover")) {
  process.exitCode = 1
}
