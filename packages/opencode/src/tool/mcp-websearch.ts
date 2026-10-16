import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { readSearchResponseText } from "./websearch-shared"

export const EXA_URL = process.env.EXA_API_KEY
  ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : "https://mcp.exa.ai/mcp"
export const PARALLEL_URL = "https://search.parallel.ai/mcp"

const McpResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
    isError: Schema.optional(Schema.Boolean),
  }),
})

const decode = Schema.decodeUnknownOption(McpResult)

const parsePayload = (payload: string) =>
  Effect.gen(function* () {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    const json = yield* Effect.try({
      try: () => JSON.parse(trimmed) as unknown,
      catch: () => new Error("Malformed JSON-RPC search response"),
    })
    if (json && typeof json === "object" && "error" in json) {
      const error = json.error
      const message =
        error && typeof error === "object" && "message" in error && typeof error.message === "string"
          ? error.message.slice(0, 240)
          : "Remote search provider returned an RPC error"
      return yield* Effect.fail(new Error(message))
    }
    const decoded = decode(json)
    if (Option.isNone(decoded)) return undefined
    const data = decoded.value.result
    const content = data.content
      .filter((item) => item.type === "text" && item.text)
      .map((item) => item.text!.trim())
      .filter(Boolean)
      .join("\n\n")
    if (data.isError) return yield* Effect.fail(new Error(content.slice(0, 240) || "Remote search tool failed"))
    return content || undefined
  })

export const parseResponse = Effect.fn("McpWebSearch.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  const direct = trimmed ? yield* parsePayload(trimmed) : undefined
  if (direct) return direct

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = yield* parsePayload(line.substring(6))
    if (data) return data
  }
  return undefined
})

export const SearchArgs = Schema.Struct({
  query: Schema.String,
  type: Schema.String,
  numResults: Schema.Number,
  livecrawl: Schema.String,
  contextMaxCharacters: Schema.optional(Schema.Number),
})

export const ParallelSearchArgs = Schema.Struct({
  objective: Schema.String,
  search_queries: Schema.Array(Schema.String),
  session_id: Schema.optional(Schema.String),
  model_name: Schema.optional(Schema.String),
})

const McpRequest = <F extends Schema.Struct.Fields>(args: Schema.Struct<F>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({
      name: Schema.String,
      arguments: args,
    }),
  })

export const call = <F extends Schema.Struct.Fields>(
  http: HttpClient.HttpClient,
  url: string,
  tool: string,
  args: Schema.Struct<F>,
  value: Schema.Struct.Type<F>,
  timeout: Duration.Input,
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(headers ?? {}),
      HttpClientRequest.schemaBodyJson(McpRequest(args))({
        jsonrpc: "2.0" as const,
        id: 1 as const,
        method: "tools/call" as const,
        params: { name: tool, arguments: value },
      }),
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error(`${tool} request timed out`)) }),
      )
    const body = yield* readSearchResponseText(response)
    return yield* parseResponse(body)
  })
