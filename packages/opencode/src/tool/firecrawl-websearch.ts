import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { renderSearchResults } from "./websearch-shared"
import { readSearchResponseText } from "./websearch-shared"

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
  return renderSearchResults(results)
}

export const parseFirecrawlResponse = Effect.fn("FirecrawlWebSearch.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  if (!trimmed) return undefined
  // decodeUnknownOption is synchronous — it returns an Option, not an Effect.
  const parsed = decode(trimmed)
  if (Option.isNone(parsed)) return undefined
  return renderFirecrawlResults(parsed.value.data?.web ?? [])
})

/**
 * Typed non-2xx Firecrawl status failure. The search coordinator keys its
 * process-local anonymous cooldown off the numeric `status` field, so cooldown
 * decisions never depend on regex-matching provider error strings.
 */
export class FirecrawlHttpStatusError extends Schema.TaggedErrorClass<FirecrawlHttpStatusError>()(
  "FirecrawlHttpStatusError",
  {
    status: Schema.Number,
    detail: Schema.String,
  },
) {
  override get message() {
    return `Firecrawl search request rejected with HTTP ${this.status}${this.detail ? `: ${this.detail}` : ""}`
  }
}

export function isFirecrawlHttpStatusError(value: unknown): value is FirecrawlHttpStatusError {
  if (value instanceof FirecrawlHttpStatusError) return true
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly _tag?: unknown })._tag === "FirecrawlHttpStatusError"
  )
}

const MAX_STATUS_DETAIL_CHARS = 240
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]+", "g")

/**
 * Single-line, credential-safe detail text for a status failure: control
 * characters collapse to spaces, the configured key (if any) and any bearer
 * token or key-shaped query parameter are redacted, and the result is bounded.
 */
export function sanitizeStatusDetail(raw: string): string {
  let detail = raw.replace(CONTROL_CHARS, " ").trim()
  const key = process.env.FIRECRAWL_API_KEY
  if (key) detail = detail.split(key).join("[redacted]")
  detail = detail
    .replace(/(bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|apikey)[=:]\s*)[^\s&]+/gi, "$1[redacted]")
  return detail.slice(0, MAX_STATUS_DETAIL_CHARS)
}

/** Numeric status of a typed `filterStatusOk` rejection, else undefined. */
function statusOfHttpClientError(error: unknown): number | undefined {
  if (!HttpClientError.isHttpClientError(error)) return undefined
  if (error.reason._tag !== "StatusCodeError") return undefined
  const status = error.reason.response.status
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

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
        // Non-2xx becomes a typed status error so the coordinator can apply an
        // auth-mode-scoped cooldown. Transport/decoding failures stay as-is.
        Effect.mapError((error): HttpClientError.HttpClientError | FirecrawlHttpStatusError => {
          const status = statusOfHttpClientError(error)
          if (status === undefined) return error
          return new FirecrawlHttpStatusError({
            status,
            detail: sanitizeStatusDetail(error instanceof Error ? error.message : `HTTP ${status}`),
          })
        }),
      )
    const body = yield* readSearchResponseText(response)
    return yield* parseFirecrawlResponse(body)
  })
