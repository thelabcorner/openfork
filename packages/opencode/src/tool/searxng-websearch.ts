// src/tool/searxng-websearch.ts
//
// SearXNG — self-hosted metasearch, keyless. Base URL from SEARXNG_URL (or the
// enableSearxng flag). REST JSON GET endpoint; response parsed defensively.

import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { renderSearchResults, websearchHeaders } from "./websearch-shared"

export function searxngBaseUrl(): string | undefined {
  return process.env.SEARXNG_URL?.trim() || undefined
}

const SearxngResult = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
})
const SearxngResponse = Schema.Struct({
  results: Schema.optional(Schema.Array(SearxngResult)),
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(SearxngResponse))

export const parseSearxngResponse = Effect.fn("SearxngWebSearch.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  if (!trimmed) return undefined
  const parsed = decode(trimmed)
  if (Option.isNone(parsed)) return undefined
  return renderSearchResults(
    (parsed.value.results ?? []).map((r) => ({ url: r.url, title: r.title, description: r.content })),
  )
})

export const call = (http: HttpClient.HttpClient, query: string, timeout: Duration.Input = "25 seconds") =>
  Effect.gen(function* () {
    const base = searxngBaseUrl()
    if (!base) return yield* Effect.die(new Error("SEARXNG_URL is not set — SearXNG is unavailable"))
    const request = HttpClientRequest.get(`${base.replace(/\/+$/, "")}/search`).pipe(
      HttpClientRequest.accept("application/json"),
      HttpClientRequest.setHeaders(websearchHeaders()),
      HttpClientRequest.setUrlParams({ q: query, format: "json" }),
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.die(new Error("SearXNG request timed out")),
        }),
      )
    const body = yield* response.text
    return yield* parseSearxngResponse(body)
  })
