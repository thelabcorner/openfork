import { LLMResponse, Usage as LLMUsage } from "@opencode-ai/llm"
import { Token } from "@opencode-ai/core/util/token"
import { Effect } from "effect"
import type { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import type { Interface as UsageInterface, TokenTotals } from "./usage"

const encode = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

const tokenTotal = (tokens: TokenTotals) =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning

/**
 * Convert one physical special-agent provider response into the same normalized
 * token/cost vocabulary used by persisted assistant messages, then append it to
 * the maintenance ledger.
 *
 * Terminal completion intentionally stops some provider streams as soon as the
 * host-owned tool call is complete. If that suppresses the provider's trailing
 * usage packet, estimate input/output from the exact request/response payload
 * and mark the cost as estimated instead of silently losing the invocation.
 */
export const recordResponse = (input: {
  usage: UsageInterface
  agent: string
  model: Provider.Model
  response: LLMResponse
  request: unknown
  sessionID?: string | null
  projectID?: string | null
  variant?: string | null
  startedAt: number
}) =>
  Effect.gen(function* () {
    const reported = LLMResponse.usage(input.response)
    const estimated = reported === undefined
    const raw =
      reported ??
      new LLMUsage({
        inputTokens: Token.estimate(encode(input.request)),
        outputTokens: Token.estimate(
          encode({
            message: input.response.message,
            finishReason: input.response.finishReason,
          }),
        ),
      })
    const normalized = Session.getUsage({ model: input.model, usage: raw, metadata: raw.providerMetadata })
    const tokens: TokenTotals = {
      input: normalized.tokens.input,
      cacheRead: normalized.tokens.cache.read,
      cacheWrite: normalized.tokens.cache.write,
      output: normalized.tokens.output,
      reasoning: normalized.tokens.reasoning,
    }
    const rawTotal = raw.totalTokens
    yield* input.usage.recordMaintenance({
      agent: input.agent,
      providerID: input.model.providerID,
      modelID: input.model.id,
      variant: input.variant ?? null,
      sessionID: input.sessionID ?? null,
      projectID: input.projectID ?? null,
      cost: normalized.cost,
      costEstimated: estimated,
      tokens,
      totalTokens: typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : tokenTotal(tokens),
      startedAt: input.startedAt,
      completedAt: Date.now(),
    })
  }).pipe(Effect.catch(() => Effect.void))
