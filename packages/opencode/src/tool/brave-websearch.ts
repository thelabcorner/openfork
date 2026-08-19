// src/tool/brave-websearch.ts
//
// Brave Web Search API — free tier with an API key (BRAVE_API_KEY). REST JSON
// GET endpoint; response parsed defensively (degrade to "no results").

import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { renderSearchResults, websearchHeaders } from "./websearch-shared"

export const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"

const BraveResult = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
})
const BraveResponse = Schema.Struct({
  web: Schema.optional(
    Schema.Struct({
      results: Schema.optional(Schema.Array(BraveResult)),
    }),
  ),
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(BraveResponse))

export function braveAuthHeaders(): Record<string, string> {
  const headers = websearchHeaders()
  if (!process.env.BRAVE_API_KEY) return headers
  return { ...headers, "X-Subscription-Token": process.env.BRAVE_API_KEY }
}

export const parseBraveResponse = Effect.fn("BraveWebSearch.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  if (!trimmed) return undefined
  const parsed = decode(trimmed)
  if (Option.isNone(parsed)) return undefined
  return renderSearchResults(parsed.value.web?.results ?? [])
})

export const call = (http: HttpClient.HttpClient, query: string, count: number, timeout: Duration.Input = "25 seconds") =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(BRAVE_URL).pipe(
      HttpClientRequest.accept("application/json"),
      HttpClientRequest.setHeaders(braveAuthHeaders()),
      HttpClientRequest.setUrlParams({ q: query, count: String(count) }),
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.die(new Error("Brave request timed out")),
        }),
      )
    const body = yield* response.text
    return yield* parseBraveResponse(body)
  })
