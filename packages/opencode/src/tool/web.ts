import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "./tool"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "@/agent/agent"
import * as Truncate from "./truncate"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool, WEBSEARCH_PROVIDERS } from "./websearch"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(["fetch", "search", "providers"])).annotate({
    description:
      "Web operation. Fetch is the primary/default path: omit action when url is provided. Use search only when you need discovery rather than retrieving a known URL; providers lists search backends.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description: "URL to fetch. Providing url with no action defaults to fetch.",
  }),
  format: Schema.optional(Schema.Literals(["text", "markdown", "html"])).annotate({
    description: "Fetch output format (default markdown).",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Fetch timeout in seconds (max 120).",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query for action=search.",
  }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Search result count (default 8).",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description: "Search live-crawl preference when supported.",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search depth when supported.",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Search context character cap.",
  }),
  provider: Schema.optional(Schema.Literals(WEBSEARCH_PROVIDERS)).annotate({
    description: "Optional search provider pin.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = "fetch" | "search" | "providers"

type Metadata = {
  action: Action
  delegatedTool: "webfetch" | "websearch"
  provider?: unknown
  [key: string]: unknown
}

function resolveAction(params: Params): Action {
  if (params.action) return params.action
  if (params.url) return "fetch"
  if (params.query) return "search"
  return "fetch"
}

export const WebTool = Tool.define<
  typeof Parameters,
  Metadata,
  HttpClient.HttpClient | RuntimeFlags.Service | Plugin.Service | Agent.Service | Truncate.Service
>(
  "web",
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const fetchInfo = yield* WebFetchTool
    const searchInfo = yield* WebSearchTool
    const fetch = yield* Tool.init(fetchInfo)
    const search = yield* Tool.init(searchInfo)

    return {
      get description() {
        const year = new Date().getFullYear()
        return [
          "Fetch known URLs or search the web through one compact tool.",
          "FETCH FIRST: when you already have a URL, pass url and omit action; fetching is the default and preferred path.",
          "Use action=search with query only for discovery/current information, and action=providers to inspect search backends.",
          `For current-event searches, include the current year (${year}) when it materially improves freshness.`,
        ].join(" ")
      },
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const action = resolveAction(params)
          const target = (action === "fetch" ? fetch : search) as Tool.Def
          let args: Record<string, unknown>

          if (action === "fetch") {
            if (!params.url) throw new Error("url is required for web fetch")
            args = {
              url: params.url,
              format: params.format ?? "markdown",
              ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
            }
          } else if (action === "providers") {
            args = { action: "providers" }
          } else {
            if (!params.query) throw new Error("query is required for web search")
            args = {
              action: "search",
              query: params.query,
              ...(params.numResults !== undefined ? { numResults: params.numResults } : {}),
              ...(params.livecrawl !== undefined ? { livecrawl: params.livecrawl } : {}),
              ...(params.type !== undefined ? { type: params.type } : {}),
              ...(params.contextMaxCharacters !== undefined
                ? { contextMaxCharacters: params.contextMaxCharacters }
                : {}),
              ...(params.provider !== undefined ? { provider: params.provider } : {}),
            }
          }

          yield* plugin.trigger(
            "tool.execute.before",
            { tool: target.id, sessionID: ctx.sessionID, callID: ctx.callID },
            { args },
          )
          const result = yield* target.execute(args, ctx)
          const output = {
            ...result,
            metadata: {
              ...result.metadata,
              action,
              delegatedTool: target.id as "webfetch" | "websearch",
            },
          }
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: target.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
            output,
          )
          return output
        }).pipe(Effect.orDie),
    }
  }),
)
