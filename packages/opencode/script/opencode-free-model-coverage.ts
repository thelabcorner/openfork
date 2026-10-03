import path from "node:path"
import { fileURLToPath } from "node:url"

export type FreeModelCoverageFixture = {
  version: number
  providerID: string
  capturedAt: string
  sources: readonly string[]
  models: readonly string[]
}

export type FreeModelCoverageIssue = {
  modelID?: string
  code:
    | "invalid-payload"
    | "missing-provider"
    | "missing-model"
    | "missing-cost"
    | "nonzero-cost"
  message: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const FREE_MODEL_COVERAGE_FIXTURE_PATH = path.join(
  __dirname,
  "fixtures",
  "opencode-free-language-models.json",
)

export async function loadFreeModelCoverageFixture(): Promise<FreeModelCoverageFixture> {
  return (await Bun.file(FREE_MODEL_COVERAGE_FIXTURE_PATH).json()) as FreeModelCoverageFixture
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function explicitCostEntryIsZero(value: unknown) {
  if (!isRecord(value)) return false
  const input = numberOrUndefined(value.input)
  const output = numberOrUndefined(value.output)
  if (input === undefined || output === undefined) return false
  if (input !== 0 || output !== 0) return false
  for (const key of ["cache_read", "cache_write"] as const) {
    const amount = numberOrUndefined(value[key])
    if (amount !== undefined && amount !== 0) return false
  }
  return true
}

function rawCostIsZero(value: unknown) {
  if (!explicitCostEntryIsZero(value) || !isRecord(value)) return false

  const tiers = value.tiers
  if (tiers !== undefined) {
    if (!Array.isArray(tiers)) return false
    if (tiers.some((tier) => !explicitCostEntryIsZero(tier))) return false
  }

  const over200k = value.context_over_200k
  if (over200k !== undefined && !explicitCostEntryIsZero(over200k)) return false
  return true
}

/**
 * Release/build-time evidence gate only.
 *
 * Hosted availability remains a runtime concern. This validator proves that the
 * generated Models.dev payload can safely construct every route in the committed
 * source-backed free-language coverage fixture without guessing pricing metadata.
 */
export function validateFreeModelCoverage(
  payload: string | unknown,
  fixture: FreeModelCoverageFixture,
): FreeModelCoverageIssue[] {
  let parsed: unknown
  try {
    parsed = typeof payload === "string" ? JSON.parse(payload) : payload
  } catch {
    return [{ code: "invalid-payload", message: "Models.dev payload is not valid JSON" }]
  }
  if (!isRecord(parsed)) return [{ code: "invalid-payload", message: "Models.dev payload is not an object" }]

  const provider = parsed[fixture.providerID]
  if (!isRecord(provider) || !isRecord(provider.models)) {
    return [
      {
        code: "missing-provider",
        message: `Models.dev payload is missing provider ${fixture.providerID}`,
      },
    ]
  }

  const issues: FreeModelCoverageIssue[] = []
  for (const modelID of fixture.models) {
    const model = provider.models[modelID]
    if (!isRecord(model)) {
      issues.push({ modelID, code: "missing-model", message: `Missing model ${modelID}` })
      continue
    }
    if (!isRecord(model.cost)) {
      issues.push({ modelID, code: "missing-cost", message: `Missing pricing metadata for ${modelID}` })
      continue
    }
    if (!rawCostIsZero(model.cost)) {
      issues.push({
        modelID,
        code: "nonzero-cost",
        message: `Free coverage model ${modelID} has non-zero or ambiguous pricing metadata`,
      })
    }
  }
  return issues
}

export function formatFreeModelCoverageIssues(
  fixture: FreeModelCoverageFixture,
  issues: readonly FreeModelCoverageIssue[],
) {
  const header =
    `OpenCode free-model coverage drift (${fixture.capturedAt}; ${issues.length} issue${issues.length === 1 ? "" : "s"})`
  return [header, ...issues.map((issue) => `- ${issue.message}`)].join("\n")
}

export function strictFreeModelCoverageBuild() {
  return (
    process.env.OPENCODE_FREE_MODEL_COVERAGE_STRICT === "1" ||
    process.env.CI === "true" ||
    process.env.GITHUB_ACTIONS === "true"
  )
}