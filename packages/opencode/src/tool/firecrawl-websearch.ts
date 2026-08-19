import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export const FIRECRAWL_URL = "https://api.firecrawl.dev/v2/search"

const FirecrawlSearchArgs = Schema.Struct({
  query: Schema.String,
  limit: Schema.Number,
})

// Defensive parse of the Firecrawl v2 `/search` response. The documented shape is
// `{ success, data: { web: [{ url, title, description, ... }] } }` — every field
// except the per-item `url` is optional so a quota/error response degrades to
// "no results" instead of a hard parse failure.
const FirecrawlSearchResult = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
})
const FirecrawlSearchResponse = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  data: Schema.optional(
    Schema.Struct({
      web: Schema.optional(Schema.Array(FirecrawlSearchResult)),
    }),
  ),
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(FirecrawlSearchResponse))

export function firecrawlAuthHeaders(): Record<string, string> {
  const headers = { "User-Agent": `opencode/${InstallationVersion}`, "Content-Type": "application/json" }
  if (!process.env.FIRECRAWL_API_KEY) return headers
  return { ...headers, Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` }
}

export type FirecrawlResult = {
  url?: string
  title?: string
  description?: string
  date?: string
}

/** Render Firecrawl results in a markdown-ish shape consistent with the other providers. */
export function renderFirecrawlResults(results: readonly FirecrawlResult[]): string | undefined {
  const clean = results.filter((r): r is FirecrawlResult & { url: string } => Boolean(r && r.url))
  if (clean.length === 0) return undefined
  return clean
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title || r.url}`]
      if (r.description) lines.push(`   ${r.description}`)
      lines.push(`   ${r.url}`)
      if (r.date) lines.push(`   ${r.date}`)
      return lines.join("\n")
    })
    .join("\n\n")
}

export const parseFirecrawlResponse = Effect.fn("FirecrawlWebSearch.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  if (!trimmed) return undefined
  // decodeUnknownOption is synchronous — it returns an Option, not an Effect.
  const parsed = decode(trimmed)
  if (Option.isNone(parsed)) return undefined
  return renderFirecrawlResults(parsed.value.data?.web ?? [])
})

export const call = (
  http: HttpClient.HttpClient,
  query: string,
  limit: number,
  timeout: Duration.Input = "25 seconds",
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(FIRECRAWL_URL).pipe(
      HttpClientRequest.accept("application/json"),
      HttpClientRequest.setHeaders(firecrawlAuthHeaders()),
      HttpClientRequest.schemaBodyJson(FirecrawlSearchArgs)({ query, limit }),
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.die(new Error("Firecrawl request timed out")),
        }),
      )
    const body = yield* response.text
    return yield* parseFirecrawlResponse(body)
  })
