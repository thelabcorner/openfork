import { describe, expect, test } from "bun:test"
import { LLMError, QuotaExceededReason, RateLimitReason } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { mapSystemOneError } from "../../src/server/routes/instance/httpapi/handlers/system-one"

describe("System One HttpApi provider failures", () => {
  test("maps invalid or ambiguous provider-account selectors to accountID request errors", () => {
    const mapped = mapSystemOneError(
      new Provider.AccountResolutionError({
        providerID: ProviderV2.ID.make("workbuddy"),
        selector: "team",
        reason: "ambiguous",
        matches: ["wb-a", "wb-b"],
      }),
    )

    expect(mapped).toMatchObject({
      _tag: "InvalidRequestError",
      kind: "provider-account",
      field: "accountID",
    })
  })

  test("maps unavailable live provider-account rosters to service unavailable", () => {
    const mapped = mapSystemOneError(
      new Provider.AccountResolutionError({
        providerID: ProviderV2.ID.make("workbuddy"),
        selector: "team",
        reason: "unavailable",
      }),
    )

    expect(mapped).toMatchObject({
      _tag: "ServiceUnavailableError",
      service: "workbuddy",
    })
  })

  test("preserves rate limits as an explicit 429 contract error", () => {
    const mapped = mapSystemOneError(
      new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: new RateLimitReason({
          message: "Rate limit exceeded",
          retryAfterMs: 30_000,
        }),
      }),
    )

    expect(mapped).toMatchObject({
      _tag: "RateLimitError",
      service: "system-one",
      message: "Rate limit exceeded",
      retryAfterMs: 30_000,
    })
  })

  test("keeps quota exhaustion distinct from transient rate limiting", () => {
    const mapped = mapSystemOneError(
      new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: new QuotaExceededReason({
          message: "Quota exceeded",
        }),
      }),
    )

    expect(mapped).toMatchObject({
      _tag: "QuotaExceededError",
      service: "system-one",
      message: "Quota exceeded",
    })
  })
})
