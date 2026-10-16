import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"

/**
 * An *observed OpenFork* donor cohort for counterfactual OXP API valuation.
 *
 * This is deliberately NOT an inference of the hidden ChatGPT prompt cache,
 * model or reasoning split. It answers a narrower question: "If the upstream
 * session behaved like my locally recorded GPT-6 generations, what would the
 * token class split look like?" No extra DB query or transcript hydration is
 * needed — the normal Usage page already owns this aggregate.
 */
export type OxpLocalDonor = {
  cohort: "exact-model" | "gpt-6" | "all-models"
  messages: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  cachedInputPercent: number
  surroundingOutputPercent: number
}

type Row = Pick<UsageSummaryResponse["models"][number], "modelID" | "messages" | "tokens">

function valid(n: number) {
  return Number.isFinite(n) && n > 0 ? n : 0
}

function summarizeDonor(selected: readonly Row[], cohort: OxpLocalDonor["cohort"]): OxpLocalDonor | undefined {
  const combined = selected.reduce(
    (total, row) => {
      total.messages += valid(row.messages)
      total.input += valid(row.tokens.input)
      total.cacheRead += valid(row.tokens.cacheRead)
      total.cacheWrite += valid(row.tokens.cacheWrite)
      total.output += valid(row.tokens.output)
      total.reasoning += valid(row.tokens.reasoning)
      return total
    },
    { messages: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
  )
  const inputMass = combined.input + combined.cacheRead
  const allMass = inputMass + combined.cacheWrite + combined.output + combined.reasoning
  if (!allMass) return
  return {
    ...combined,
    cohort,
    cachedInputPercent: inputMass ? (100 * combined.cacheRead) / inputMass : 0,
    surroundingOutputPercent: (100 * (combined.output + combined.reasoning)) / allMass,
  }
}

export function oxpLocalDonorProfile(rows: readonly Row[], minMatchingMessages = 20): OxpLocalDonor | undefined {
  const eligible = rows.filter((r) => valid(r.messages) > 0)
  if (!eligible.length) return
  const matching = eligible.filter((r) => /^gpt[-_./]?6(?:[.-]|$)/i.test(r.modelID))
  const messages = matching.reduce((sum, row) => sum + valid(row.messages), 0)
  const cohort = messages >= minMatchingMessages ? "gpt-6" : "all-models"
  return summarizeDonor(cohort === "gpt-6" ? matching : eligible, cohort)
}

/** Prefer exact matching provider-settled model generations; fall back to GPT-6 cohort then all models. */
export function oxpLocalDonorForModel(rows: readonly Row[], modelID: string, minMessages = 20): OxpLocalDonor | undefined {
  const exact = rows.filter((r) => r.modelID.toLowerCase() === modelID.toLowerCase() && valid(r.messages) > 0)
  if (exact.reduce((sum, row) => sum + valid(row.messages), 0) >= minMessages) {
    return summarizeDonor(exact, "exact-model")
  }
  return oxpLocalDonorProfile(rows, minMessages)
}
