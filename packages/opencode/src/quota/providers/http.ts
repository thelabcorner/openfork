import { Effect, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

/**
 * Bounded GET-JSON seam for provider account endpoints. Adapters receive a
 * discriminated outcome instead of exceptions so each can fold failures into
 * its result envelope the way OpenChamber's per-provider try/catch did.
 */

const REQUEST_TIMEOUT = "10 seconds"

export type FetchOutcome =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly error: "status"; readonly status: number }
  | { readonly ok: false; readonly error: "network"; readonly message: string }
  | { readonly ok: false; readonly error: "parse"; readonly message: string }
  | { readonly ok: false; readonly error: "timeout" }

export function outcomeError(outcome: Extract<FetchOutcome, { ok: false }>): string {
  if (outcome.error === "status") return `API error: ${outcome.status}`
  if (outcome.error === "timeout") return "Request timed out"
  if (outcome.error === "parse") return `Invalid response: ${outcome.message}`
  return outcome.message
}

export const fetchJson = (
  http: HttpClient.HttpClient,
  url: string,
  key: string,
  headers?: Record<string, string>,
): Effect.Effect<FetchOutcome> =>
  Effect.catch(
    Effect.gen(function* () {
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({ authorization: `Bearer ${key}`, ...headers }),
      )
      const raced = yield* Effect.timeoutOption(http.execute(request), REQUEST_TIMEOUT)
      if (Option.isNone(raced)) return { ok: false, error: "timeout" } satisfies FetchOutcome
      const response = raced.value
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: "status", status: response.status } satisfies FetchOutcome
      }
      return yield* Effect.map(response.json, (body): FetchOutcome => ({ ok: true, body }))
    }),
    (error) => Effect.succeed({ ok: false, error: "network", message: error.message }),
  )
