import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { parseResponse } from "../../src/tool/mcp-websearch"
import {
  parseFirecrawlResponse,
  renderFirecrawlResults,
} from "../../src/tool/firecrawl-websearch"
import { parseBraveResponse } from "../../src/tool/brave-websearch"
import { parseTavilyResponse } from "../../src/tool/tavily-websearch"
import { parseSearxngResponse } from "../../src/tool/searxng-websearch"
import { parseDuckDuckGoHtml } from "../../src/tool/duckduckgo-websearch"
import {
  WebSearchTool,
  selectWebSearchProvider,
  webSearchModelName,
  webSearchProviderLabel,
} from "../../src/tool/websearch"
import { webSearchEnabled } from "../../src/tool/registry"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { testEffect, it } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionID, MessageID } from "../../src/session/schema"

const SESSION_ID = "ses_0196aabbccddeeff001122334455"

describe("websearch provider", () => {
  test("selects a stable provider per session", () => {
    expect(selectWebSearchProvider(SESSION_ID)).toBe(selectWebSearchProvider(SESSION_ID))
  })

  test("supports an operational override", () => {
    const original = process.env.OPENCODE_WEBSEARCH_PROVIDER

    try {
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "parallel"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("parallel")

      process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("exa")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
      else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
    }
  })

  test("routes to Exa when the Exa flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: true, parallel: false })).toBe("exa")
  })

  test("routes to Parallel when the Parallel flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: true })).toBe("parallel")
  })

  test("routes to Firecrawl when the Firecrawl flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: false, firecrawl: true })).toBe("firecrawl")
  })

  test("an explicit provider pin overrides env, flags, and checksum", () => {
    const original = process.env.OPENCODE_WEBSEARCH_PROVIDER
    try {
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa"
      expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: false, firecrawl: false }, "firecrawl")).toBe(
        "firecrawl",
      )
      expect(selectWebSearchProvider(SESSION_ID, { exa: true, parallel: true, firecrawl: true }, "parallel")).toBe(
        "parallel",
      )
      expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: false, firecrawl: false }, "exa")).toBe("exa")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
      else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
    }
  })

  test("supports a firecrawl operational override", () => {
    const original = process.env.OPENCODE_WEBSEARCH_PROVIDER
    try {
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "firecrawl"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("firecrawl")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
      else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
    }
  })

  test("the checksum fallback spreads across all keyless providers", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 80; i++) {
      seen.add(selectWebSearchProvider(`ses_${i}`))
    }
    // No keys/flags configured: only the four keyless providers participate.
    expect(seen).toEqual(new Set(["exa", "parallel", "firecrawl", "duckduckgo"]))
  })

  test("key-based providers are only picked by the checksum when configured", () => {
    const original = process.env.BRAVE_API_KEY
    try {
      delete process.env.BRAVE_API_KEY
      const seenNoKey = new Set<string>()
      for (let i = 0; i < 60; i++) seenNoKey.add(selectWebSearchProvider(`ses_${i}`))
      expect(seenNoKey.has("brave")).toBe(false)

      process.env.BRAVE_API_KEY = "test-key"
      const seenKey = new Set<string>()
      for (let i = 0; i < 80; i++) seenKey.add(selectWebSearchProvider(`ses_${i}`))
      expect(seenKey.has("brave")).toBe(true)
    } finally {
      if (original === undefined) delete process.env.BRAVE_API_KEY
      else process.env.BRAVE_API_KEY = original
    }
  })

  test("pins the new free providers explicitly", () => {
    expect(selectWebSearchProvider(SESSION_ID, {}, "duckduckgo")).toBe("duckduckgo")
    expect(selectWebSearchProvider(SESSION_ID, {}, "brave")).toBe("brave")
    expect(selectWebSearchProvider(SESSION_ID, {}, "tavily")).toBe("tavily")
    expect(selectWebSearchProvider(SESSION_ID, {}, "searxng")).toBe("searxng")
  })

  test("routes to the new providers via env override and flags", () => {
    const original = process.env.OPENCODE_WEBSEARCH_PROVIDER
    try {
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "duckduckgo"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("duckduckgo")
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "brave"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("brave")
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "tavily"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("tavily")
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "searxng"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("searxng")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
      else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
    }
  })

  test("flag precedence covers the new providers (parallel > exa > firecrawl > duckduckgo > brave > tavily > searxng)", () => {
    expect(
      selectWebSearchProvider(SESSION_ID, { exa: true, parallel: true, firecrawl: true, duckduckgo: true, brave: true, tavily: true, searxng: true }),
    ).toBe("parallel")
    expect(selectWebSearchProvider(SESSION_ID, { firecrawl: true, duckduckgo: true })).toBe("firecrawl")
    expect(selectWebSearchProvider(SESSION_ID, { duckduckgo: true })).toBe("duckduckgo")
    expect(selectWebSearchProvider(SESSION_ID, { brave: true })).toBe("brave")
    expect(selectWebSearchProvider(SESSION_ID, { tavily: true })).toBe("tavily")
    expect(selectWebSearchProvider(SESSION_ID, { searxng: true })).toBe("searxng")
  })

  test("is enabled for OpenCode providers or explicit websearch provider flags", () => {
    const none = { exa: false, parallel: false, firecrawl: false, duckduckgo: false, brave: false, tavily: false, searxng: false }
    expect(webSearchEnabled(ProviderV2.ID.opencode, none)).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.make("opencode-go"), none)).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, none)).toBe(false)
    expect(webSearchEnabled(ProviderV2.ID.openai, { ...none, exa: true })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { ...none, parallel: true })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { ...none, firecrawl: true })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { ...none, duckduckgo: true })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { ...none, brave: true })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { ...none, tavily: true })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { ...none, searxng: true })).toBe(true)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel("firecrawl")).toBe("Firecrawl Web Search")
    expect(webSearchProviderLabel("duckduckgo")).toBe("DuckDuckGo")
    expect(webSearchProviderLabel("brave")).toBe("Brave Search")
    expect(webSearchProviderLabel("tavily")).toBe("Tavily Search")
    expect(webSearchProviderLabel("searxng")).toBe("SearXNG")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })

  test("uses the provider API model id for Parallel analytics", () => {
    expect(
      webSearchModelName({
        model: {
          id: "claude-opus-4-7",
          api: { id: "claude-opus-4.7" },
        },
      }),
    ).toBe("claude-opus-4.7")
  })
})

describe("websearch MCP response parser", () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )
})

describe("websearch Firecrawl client", () => {
  const fixture = JSON.stringify({
    success: true,
    data: {
      web: [
        { url: "https://example.com/one", title: "Example One", description: "First result" },
        { url: "https://example.com/two", title: "Example Two" },
      ],
    },
  })

  it.effect("parses a v2 search response", () =>
    Effect.gen(function* () {
      const result = yield* parseFirecrawlResponse(fixture)
      expect(result).toContain("1. Example One")
      expect(result).toContain("https://example.com/one")
      expect(result).toContain("First result")
      expect(result).toContain("2. Example Two")
    }),
  )

  it.effect("degrades defensively on error/empty shapes", () =>
    Effect.gen(function* () {
      expect(yield* parseFirecrawlResponse('{"success":false,"error":"quota exceeded"}')).toBeUndefined()
      expect(yield* parseFirecrawlResponse('{"success":true,"data":{}}')).toBeUndefined()
      expect(yield* parseFirecrawlResponse("not json at all")).toBeUndefined()
    }),
  )

  test("renders results in markdown-ish shape", () => {
    expect(
      renderFirecrawlResults([
        { url: "https://a.dev", title: "A", description: "desc", date: "2026-01-01" },
        { url: "https://b.dev", title: "B" },
      ]),
    ).toBe("1. A\n   desc\n   https://a.dev\n   2026-01-01\n\n2. B\n   https://b.dev")
    expect(renderFirecrawlResults([])).toBeUndefined()
    expect(renderFirecrawlResults([{ title: "no url" }])).toBeUndefined()
  })
})

describe("websearch free-provider clients", () => {
  it.effect("parses a Brave response", () =>
    Effect.gen(function* () {
      const fixture = JSON.stringify({
        web: {
          results: [
            { title: "Brave Result", url: "https://brave.dev", description: "brave desc" },
            { title: "No description", url: "https://brave2.dev" },
          ],
        },
      })
      const result = yield* parseBraveResponse(fixture)
      expect(result).toContain("1. Brave Result")
      expect(result).toContain("https://brave.dev")
      expect(result).toContain("brave desc")
      expect(yield* parseBraveResponse("not json")).toBeUndefined()
      expect(yield* parseBraveResponse('{"web":{}}')).toBeUndefined()
    }),
  )

  it.effect("parses a Tavily response", () =>
    Effect.gen(function* () {
      const fixture = JSON.stringify({
        query: "q",
        results: [
          { title: "Tavily Result", url: "https://tavily.dev", content: "tavily content" },
          { title: "second", url: "https://tavily2.dev" },
        ],
      })
      const result = yield* parseTavilyResponse(fixture)
      expect(result).toContain("1. Tavily Result")
      expect(result).toContain("https://tavily.dev")
      expect(result).toContain("tavily content")
      expect(yield* parseTavilyResponse('{"detail":{"error":"Unauthorized"}}')).toBeUndefined()
    }),
  )

  it.effect("parses a SearXNG response", () =>
    Effect.gen(function* () {
      const fixture = JSON.stringify({
        results: [
          { title: "SearXNG Result", url: "https://searxng.dev", content: "searxng content" },
          { title: "second", url: "https://searxng2.dev" },
        ],
      })
      const result = yield* parseSearxngResponse(fixture)
      expect(result).toContain("1. SearXNG Result")
      expect(result).toContain("https://searxng.dev")
      expect(yield* parseSearxngResponse("{}")).toBeUndefined()
    }),
  )

  it.effect("parses a DuckDuckGo HTML page", () =>
    Effect.gen(function* () {
      const html = [
        '<div class="result results_links">',
        '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=abc">Example <b>One</b></a>',
        '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">First &amp; best result</a>',
        "</div>",
        '<div class="result results_links">',
        '<a rel="nofollow" class="result__a" href="https://example.com/two">Example Two</a>',
        '<a class="result__snippet" href="https://example.com/two">Second</a>',
        "</div>",
      ].join("\n")
      const results = parseDuckDuckGoHtml(html)
      expect(results).toHaveLength(2)
      expect(results?.[0]?.title).toBe("Example One")
      expect(results?.[0]?.url).toBe("https://example.com/one")
      expect(results?.[0]?.description).toBe("First & best result")
      expect(results?.[1]?.title).toBe("Example Two")
      expect(parseDuckDuckGoHtml("<html><body>no results</body></html>")).toBeUndefined()
    }),
  )
})

describe("websearch tool dispatch + permission metadata", () => {
  const firecrawlFixture = JSON.stringify({
    success: true,
    data: { web: [{ url: "https://fixture.dev", title: "Fixture Result", description: "from canned response" }] },
  })
  const fakeHttp = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(firecrawlFixture, { status: 200 })),
    ),
  )
  const itTool = testEffect(
    LayerNode.compile(
      LayerNode.group([
        Truncate.node,
        Agent.node,
        RuntimeFlags.node,
        LayerNode.make({
          service: HttpClient.HttpClient,
          layer: Layer.succeed(HttpClient.HttpClient, fakeHttp),
          deps: [],
        }),
      ]),
    ),
  )

  const baseCtx = {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
  }
  type AskInput = {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, unknown>
  }
  const makeCtx = () => {
    const calls: AskInput[] = []
    const ctx = {
      ...baseCtx,
      ask: (input: AskInput) =>
        Effect.sync(() => {
          calls.push(input)
        }),
    }
    return { ctx, calls }
  }

  const execute = Effect.fn("WebSearchToolTest.execute")(function* (
    params: {
      query?: string
      action?: "search" | "providers"
      provider?:
        | "exa"
        | "parallel"
        | "firecrawl"
        | "duckduckgo"
        | "brave"
        | "tavily"
        | "searxng"
    },
    ctx: typeof baseCtx & { ask: (i: AskInput) => Effect.Effect<void> },
  ) {
    const info = yield* WebSearchTool
    const tool = yield* info.init()
    return yield* tool.execute(params, ctx)
  })

  itTool.instance("pin firecrawl: dispatch uses Firecrawl and the ask names the provider", () =>
    Effect.gen(function* () {
      const { ctx, calls } = makeCtx()
      const result = yield* execute({ query: "fixture query", provider: "firecrawl" }, ctx)

      expect(calls.length).toBe(1)
      expect(calls[0].permission).toBe("websearch")
      expect(calls[0].metadata.provider).toBe("firecrawl")
      expect(result.output).toContain("Fixture Result")
      expect(result.output).toContain("https://fixture.dev")
      expect(result.title).toContain("Firecrawl Web Search")
    }),
  )

  itTool.instance("env override firecrawl: same dispatch without an explicit pin", () =>
    Effect.gen(function* () {
      const original = process.env.OPENCODE_WEBSEARCH_PROVIDER
      try {
        process.env.OPENCODE_WEBSEARCH_PROVIDER = "firecrawl"
        const { ctx, calls } = makeCtx()
        const result = yield* execute({ query: "env query" }, ctx)
        expect(calls[0].metadata.provider).toBe("firecrawl")
        expect(result.output).toContain("Fixture Result")
      } finally {
        if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
        else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
      }
    }),
  )

  itTool.instance("providers action lists providers with config status and needs no ask", () =>
    Effect.gen(function* () {
      const original = process.env.BRAVE_API_KEY
      try {
        delete process.env.BRAVE_API_KEY
        const { ctx, calls } = makeCtx()
        const result = yield* execute({ action: "providers" }, ctx)

        expect(calls.length).toBe(0) // introspection: no permission ask
        expect(result.output).toContain("websearch providers (7")
        expect(result.output).toContain("duckduckgo")
        expect(result.output).toContain("keyless-ready")
        expect(result.output).toContain("needs BRAVE_API_KEY")
        expect(result.output).toContain("needs TAVILY_API_KEY")
        expect(result.output).toContain("needs SEARXNG_URL")

        process.env.BRAVE_API_KEY = "test-key"
        const ready = yield* execute({ action: "providers" }, ctx)
        expect(ready.output).toContain("brave")
        expect(ready.output).not.toContain("brave      needs BRAVE_API_KEY")
      } finally {
        if (original === undefined) delete process.env.BRAVE_API_KEY
        else process.env.BRAVE_API_KEY = original
      }
    }),
  )

  itTool.instance("search without a query is rejected with a clear error", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const exit = yield* Effect.exit(execute({}, ctx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("query is required")
      }
    }),
  )
})
