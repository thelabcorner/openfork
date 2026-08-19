// src/tool/tavily-websearch.ts
//
// Tavily Search API — free tier with an API key (TAVILY_API_KEY). REST JSON
// POST endpoint; response parsed defensively (degrade to "no results").

import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { renderSearchResults, websearchHeaders } from "./websearch-shared"

export const TAVILY_URL = "https://api.tavily.com/search"

const TavilySearchArgs = Schema.Struct({
  query: Schema.String,
  max_results: Schema.Number,
  search_depth: Schema.String,
})

const TavilyResult = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
})
const TavilyResponse = Schema.Struct({
  results: Schema.optional(Schema.Array(TavilyResult)),
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(TavilyResponse))

export function tavilyAuthHeaders(): Record<string, string> {
  const headers = { ...websearchHeaders(), "Content-Type": "application/json" }
  if (!process.env.TAVILY_API_KEY) return headers
  return { ...headers, Authorization: `Bearer ${process.env.TAVILY_API_KEY}` }
}

export const parseTavilyResponse = Effect.fn("TavilyWebSearch.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  if (!trimmed) return undefined
  const parsed = decode(trimmed)
  if (Option.isNone(parsed)) return undefined
  return renderSearchResults(
    (parsed.value.results ?? []).map((r) => ({ url: r.url, title: r.title, description: r.content })),
  )
})

export const call = (
  http: HttpClient.HttpClient,
  query: string,
  maxResults: number,
  timeout: Duration.Input = "25 seconds",
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(TAVILY_URL).pipe(
      HttpClientRequest.accept("application/json"),
      HttpClientRequest.setHeaders(tavilyAuthHeaders()),
      HttpClientRequest.schemaBodyJson(TavilySearchArgs)({
        query,
        max_results: maxResults,
        search_depth: "basic",
      }),
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.die(new Error("Tavily request timed out")),
        }),
      )
    const body = yield* response.text
    return yield* parseTavilyResponse(body)
  })
