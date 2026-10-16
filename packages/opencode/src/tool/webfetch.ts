import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"
import { collectBoundedResponseBody } from "@opencode-ai/core/tool/http-body"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

const GITHUB_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "patch-diff.githubusercontent.com",
  "codeload.github.com",
])

export function isGitHubUrl(url: string): boolean {
  try {
    return GITHUB_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

export const GITHUB_TOOL_NUDGE =
  'Prefer the github tool for GitHub content (authenticated, structured, paginated): e.g. github({action:"command", argv:["pr","diff","123"]}) or github({action:"catalog", q:"..."}). This webfetch fallback is unauthenticated and unstructured.'

export function applyGitHubNudge(output: string, url: string): string {
  return isGitHubUrl(url) ? `${output}\n\n${GITHUB_TOOL_NUDGE}` : output
}

export const executeFetch = Effect.fn("WebFetch.execute")(
  function* (
    http: HttpClient.HttpClient,
    params: Schema.Schema.Type<typeof Parameters>,
  ) {
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      return yield* Effect.fail(new Error("URL must start with http:// or https://"))
    }

    const httpOk = HttpClient.filterStatusOk(http)
    const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

    let acceptHeader = "*/*"
    switch (params.format) {
      case "markdown":
        acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
        break
      case "text":
        acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        break
      case "html":
        acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
        break
    }
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept: acceptHeader,
      "Accept-Language": "en-US,en;q=0.9",
    }
    const request = HttpClientRequest.get(params.url).pipe(HttpClientRequest.setHeaders(headers))
    const { response, body } = yield* Effect.gen(function* () {
      const response = yield* httpOk.execute(request).pipe(
        Effect.catchIf(
          (err) =>
            err.reason._tag === "StatusCodeError" &&
            err.reason.response.status === 403 &&
            err.reason.response.headers["cf-mitigated"] === "challenge",
          () =>
            httpOk.execute(
              HttpClientRequest.get(params.url).pipe(
                HttpClientRequest.setHeaders({ ...headers, "User-Agent": "opencode" }),
              ),
            ),
        ),
      )
      const body = yield* collectBoundedResponseBody(
        response,
        MAX_RESPONSE_SIZE,
        () => new Error("Response too large (exceeds 5MB limit)"),
      )
      return { response, body }
    }).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(new Error("Request timed out")) }))

    const contentType = response.headers["content-type"] || ""
    const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
    const title = `${params.url} (${contentType})`
    if (isImageAttachment(mime)) {
      const base64Content = body.toString("base64")
      return {
        title,
        output: "Image fetched successfully",
        metadata: {},
        attachments: [{ type: "file" as const, mime, url: `data:${mime};base64,${base64Content}` }],
      }
    }
    const content = new TextDecoder().decode(body)
    if (params.format === "markdown" && contentType.includes("text/html")) {
      return { output: applyGitHubNudge(convertHTMLToMarkdown(content), params.url), title, metadata: {} }
    }
    if (params.format === "text" && contentType.includes("text/html")) {
      return { output: applyGitHubNudge(extractTextFromHTML(content), params.url), title, metadata: {} }
    }
    return { output: applyGitHubNudge(content, params.url), title, metadata: {} }
  },
)

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          return yield* executeFetch(http, params)
        }).pipe(Effect.orDie),
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
