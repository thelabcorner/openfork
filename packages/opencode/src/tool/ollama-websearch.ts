import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { readSearchResponseText, renderSearchResults, websearchHeaders } from "./websearch-shared"

// Official Ollama Search API: free account quota, not an anonymous endpoint.
export const OLLAMA_WEBSEARCH_URL = "https://ollama.com/api/web_search"

const Response = Schema.Struct({
  results: Schema.optional(
    Schema.Array(Schema.Struct({
      title: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
      content: Schema.optional(Schema.String),
    })),
  ),
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Response))
const Args = Schema.Struct({ query: Schema.String, max_results: Schema.Number })

export const parseOllamaSearchResponse = Effect.fn("OllamaWebSearch.parseResponse")(function* (body: string) {
  const parsed = decode(body)
  if (Option.isNone(parsed)) return undefined
  return renderSearchResults(
    (parsed.value.results ?? []).map((result) => ({
      url: result.url,
      title: result.title,
      description: result.content,
    })),
  )
})

export const call = (http: HttpClient.HttpClient, query: string, count: number, timeout: Duration.Input = "25 seconds") =>
  Effect.gen(function* () {
    const key = process.env.OLLAMA_API_KEY
    if (!key) return yield* Effect.fail(new Error("OLLAMA_API_KEY is required for Ollama Web Search"))
    const request = yield* HttpClientRequest.post(OLLAMA_WEBSEARCH_URL).pipe(
      HttpClientRequest.accept("application/json"),
      HttpClientRequest.setHeaders({ ...websearchHeaders(), Authorization: `Bearer ${key}` }),
      HttpClientRequest.schemaBodyJson(Args)({ query, max_results: count }),
    )
    const response = yield* HttpClient.filterStatusOk(http).execute(request).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new Error("Ollama web search request timed out")),
      }),
    )
    return yield* parseOllamaSearchResponse(yield* readSearchResponseText(response))
  })