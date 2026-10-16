import { describe, expect, test } from "bun:test"
import { Cause, Clock, Effect, Exit, Layer, Option } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { parseResponse } from "../../src/tool/mcp-websearch"
import {
  call as callFirecrawlWebSearch,
  isFirecrawlHttpStatusError,
  parseFirecrawlResponse,
  renderFirecrawlResults,
  sanitizeStatusDetail,
} from "../../src/tool/firecrawl-websearch"
import { parseBraveResponse } from "../../src/tool/brave-websearch"
import { parseTavilyResponse } from "../../src/tool/tavily-websearch"
import { parseSearxngResponse } from "../../src/tool/searxng-websearch"
import { parseDuckDuckGoHtml } from "../../src/tool/duckduckgo-websearch"
import { renderSearchResults } from "../../src/tool/websearch-shared"
import { parseOllamaSearchResponse } from "../../src/tool/ollama-websearch"
import { call as callOllamaWebSearch, OLLAMA_WEBSEARCH_URL } from "../../src/tool/ollama-websearch"
import {
  WebSearchTool,
  hasSearchResults,
  isProviderAvailable,
  noteProviderCooldown,
  providerCooldownInfo,
  providerStatus,
  providersOutput,
  resetWebSearchCooldowns,
  searchWithFallback,
  selectWebSearchProvider,
  webSearchProviderCandidates,
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
  test("rejects empty-result prose but preserves genuine search content", () => {
    expect(hasSearchResults(undefined)).toBe(false)
    expect(hasSearchResults("   ")).toBe(false)
    expect(hasSearchResults("No search results found. Please try a different query.")).toBe(false)
    expect(hasSearchResults("No relevant results found.")).toBe(false)
    expect(hasSearchResults("1. A sourced result\n   https://example.org/")).toBe(true)
  })

  test("uses a deterministic free-first default instead of session sharding", () => {
    expect(selectWebSearchProvider(SESSION_ID)).toBe("parallel")
    expect(selectWebSearchProvider("ses_completely_different")).toBe("parallel")
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

  test("Firecrawl remains keyless and an API key is optional", () => {
    const prior = process.env.FIRECRAWL_API_KEY
    try {
      delete process.env.FIRECRAWL_API_KEY
      expect(isProviderAvailable("firecrawl", { firecrawl: true })).toBe(true)
      expect(providerStatus("firecrawl")).toContain("keyless-conditional")
      expect(selectWebSearchProvider(SESSION_ID, { firecrawl: true })).toBe("firecrawl")
      process.env.FIRECRAWL_API_KEY = "fixture-key"
      expect(isProviderAvailable("firecrawl", { firecrawl: true })).toBe(true)
      expect(providerStatus("firecrawl")).toContain("ready (authenticated)")
      expect(selectWebSearchProvider(SESSION_ID, { firecrawl: true })).toBe("firecrawl")
    } finally {
      if (prior === undefined) delete process.env.FIRECRAWL_API_KEY
      else process.env.FIRECRAWL_API_KEY = prior
    }
  })

  test("an explicit provider pin overrides env, flags, and automatic routing", () => {
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

  test("automatic candidates are ordered free-first with HTML scraping last", () => {
    expect(webSearchProviderCandidates().filter((p) => ["parallel", "exa", "firecrawl", "duckduckgo"].includes(p)))
      .toEqual(["parallel", "exa", "firecrawl", "duckduckgo"])
  })

  test("key-based providers become eligible only when their credentials exist", () => {
    const original = process.env.BRAVE_API_KEY
    try {
      delete process.env.BRAVE_API_KEY
      expect(isProviderAvailable("brave", { brave: true })).toBe(false)
      expect(webSearchProviderCandidates({ brave: true })).not.toContain("brave")

      process.env.BRAVE_API_KEY = "test-key"
      expect(isProviderAvailable("brave", { brave: true })).toBe(true)
      expect(webSearchProviderCandidates({ brave: true })[0]).toBe("brave")
    } finally {
      if (original === undefined) delete process.env.BRAVE_API_KEY
      else process.env.BRAVE_API_KEY = original
    }
  })

  test("Ollama free-tier provider is available only with an API key", () => {
    const prior = process.env.OLLAMA_API_KEY
    try {
      delete process.env.OLLAMA_API_KEY
      expect(isProviderAvailable("ollama", { ollama: true })).toBe(false)
      expect(webSearchProviderCandidates({ ollama: true })).not.toContain("ollama")
      process.env.OLLAMA_API_KEY = "fixture-key"
      expect(isProviderAvailable("ollama", { ollama: true })).toBe(true)
      expect(webSearchProviderCandidates({ ollama: true })[0]).toBe("ollama")
    } finally {
      if (prior === undefined) delete process.env.OLLAMA_API_KEY
      else process.env.OLLAMA_API_KEY = prior
    }
  })

  test("pins the new free providers explicitly", () => {
    expect(selectWebSearchProvider(SESSION_ID, {}, "duckduckgo")).toBe("duckduckgo")
    expect(selectWebSearchProvider(SESSION_ID, {}, "brave")).toBe("brave")
    expect(selectWebSearchProvider(SESSION_ID, {}, "tavily")).toBe("tavily")
    expect(selectWebSearchProvider(SESSION_ID, {}, "searxng")).toBe("searxng")
  })

  test("routes to the new providers via env override", () => {
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

  test("flag precedence covers available providers without treating a flag as credentials", () => {
    expect(
      selectWebSearchProvider(SESSION_ID, { exa: true, parallel: true, firecrawl: true, duckduckgo: true, brave: true, tavily: true, searxng: true }),
    ).toBe("parallel")
    expect(selectWebSearchProvider(SESSION_ID, { firecrawl: true, duckduckgo: true })).toBe(
      "firecrawl",
    )
    expect(selectWebSearchProvider(SESSION_ID, { duckduckgo: true })).toBe("duckduckgo")
    expect(selectWebSearchProvider(SESSION_ID, { brave: true })).toBe("parallel")
    expect(selectWebSearchProvider(SESSION_ID, { tavily: true })).toBe("parallel")
    expect(selectWebSearchProvider(SESSION_ID, { searxng: true })).toBe("parallel")
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

  it.effect("falls through providers returning non-result payloads until one returns usable results", () =>
    Effect.gen(function* () {
      const firecrawlFixture = JSON.stringify({
        success: true,
        data: { web: [{ url: "https://fallback.dev", title: "Fallback Result", description: "usable" }] },
      })
      const fakeHttp = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(firecrawlFixture, { status: 200 }))),
      )
      const original = process.env.OPENCODE_WEBSEARCH_PROVIDER
      const originalKey = process.env.FIRECRAWL_API_KEY
      try {
        delete process.env.OPENCODE_WEBSEARCH_PROVIDER
        process.env.FIRECRAWL_API_KEY = "fixture-key"
        const result = yield* searchWithFallback(
          fakeHttp,
          { query: "fallback query" },
          { sessionID: SESSION_ID },
          {},
        )
        expect(result.provider).toBe("firecrawl")
        expect(result.output).toContain("Fallback Result")
        expect(result.attempts.map((attempt) => [attempt.provider, attempt.status])).toEqual([
          ["parallel", "empty"],
          ["exa", "empty"],
          ["firecrawl", "success"],
        ])
      } finally {
        if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
        else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
        if (originalKey === undefined) delete process.env.FIRECRAWL_API_KEY
        else process.env.FIRECRAWL_API_KEY = originalKey
      }
    }),
  )

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

  it.effect("rejects JSON-RPC errors and MCP tool errors rather than returning them as search hits", () =>
    Effect.gen(function* () {
      const rpc = yield* Effect.exit(parseResponse(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "quota exhausted" },
      })))
      expect(Exit.isFailure(rpc)).toBe(true)
      if (Exit.isFailure(rpc)) expect(Cause.pretty(rpc.cause)).toContain("quota exhausted")

      const tool = yield* Effect.exit(parseResponse(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { isError: true, content: [{ type: "text", text: "provider unavailable" }] },
      })))
      expect(Exit.isFailure(tool)).toBe(true)
      if (Exit.isFailure(tool)) expect(Cause.pretty(tool.cause)).toContain("provider unavailable")
    }),
  )

  it.effect("collects multiple MCP text blocks and ignores non-text content", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({
        result: { content: [
          { type: "text", text: "First result" },
          { type: "image", data: "unused" },
          { type: "text", text: "Second result" },
        ] },
      })
      expect(yield* parseResponse(body)).toBe("First result\n\nSecond result")
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

  it.effect("wraps a non-2xx rejection in a typed status error without leaking credentials", () =>
    Effect.gen(function* () {
      const priorKey = process.env.FIRECRAWL_API_KEY
      try {
        process.env.FIRECRAWL_API_KEY = "fc-test-secret"
        const denied = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("denied", { status: 403 }))),
        )
        const exit = yield* Effect.exit(callFirecrawlWebSearch(denied, "query", 5))
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const found = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(found)).toBe(true)
        if (!Option.isSome(found)) return
        expect(isFirecrawlHttpStatusError(found.value)).toBe(true)
        if (!isFirecrawlHttpStatusError(found.value)) return
        expect(found.value.status).toBe(403)
        expect(found.value.message).toContain("403")
        expect(found.value.message).not.toContain("fc-test-secret")
        expect(found.value.message).not.toContain("Authorization")
      } finally {
        if (priorKey === undefined) delete process.env.FIRECRAWL_API_KEY
        else process.env.FIRECRAWL_API_KEY = priorKey
      }
    }),
  )

  test("status detail sanitization redacts keys and bounds length", () => {
    const priorKey = process.env.FIRECRAWL_API_KEY
    try {
      process.env.FIRECRAWL_API_KEY = "fc-test-secret"
      const detail = sanitizeStatusDetail(
        "StatusCode error: non 2xx (403 POST https://api.firecrawl.dev/v2/search) Bearer fc-test-secret api_key=fc-test-secret",
      )
      expect(detail).not.toContain("fc-test-secret")
      expect(detail).toContain("[redacted]")
      expect(sanitizeStatusDetail("x".repeat(400))).toHaveLength(240)
    } finally {
      if (priorKey === undefined) delete process.env.FIRECRAWL_API_KEY
      else process.env.FIRECRAWL_API_KEY = priorKey
    }
  })

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
  it.effect("Ollama REST adapter posts a bounded query using the configured bearer key", () =>
    Effect.gen(function* () {
      const original = process.env.OLLAMA_API_KEY
      try {
        process.env.OLLAMA_API_KEY = "test-ollama-key"
        const fakeHttp = HttpClient.make((request) => {
          expect(request.url).toBe(OLLAMA_WEBSEARCH_URL)
          expect(request.method).toBe("POST")
          expect(request.headers.authorization).toBe("Bearer test-ollama-key")
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({
            results: [{ title: "Ollama test", url: "https://example.org/ollama", content: "Official result" }],
          }), { status: 200 })))
        })
        const output = yield* callOllamaWebSearch(fakeHttp, "test query", 2)
        expect(output).toContain("Official result")
      } finally {
        if (original === undefined) delete process.env.OLLAMA_API_KEY
        else process.env.OLLAMA_API_KEY = original
      }
    }),
  )
  it.effect("parses Ollama official Search API and rejects missing results", () =>
    Effect.gen(function* () {
      const output = yield* parseOllamaSearchResponse(JSON.stringify({
        results: [
          { title: "Ollama docs", url: "https://ollama.com/blog/web-search", content: "Official API details" },
          { title: "Broken", url: "javascript:evil()", content: "unsafe" },
        ],
      }))
      expect(output).toContain("1. Ollama docs")
      expect(output).toContain("Official API details")
      expect(output).not.toContain("javascript:")
      expect(yield* parseOllamaSearchResponse("{}")).toBeUndefined()
      expect(yield* parseOllamaSearchResponse("not json")).toBeUndefined()
    }),
  )
  test("normalizes and bounds REST search citations", () => {
    const output = renderSearchResults([
      { url: "javascript:alert(1)", title: "not a citation" },
      { url: "https://user:pass@example.com/hidden", title: "credential leak" },
      { url: "https://example.org/\nINJECT", title: "URL injection" },
      { url: "https://example.org/a", title: "Header\nOverride", description: "one\ntwo" },
      { url: "https://example.org/a", title: "duplicate" },
      { url: "invalid result URL", title: "invalid" },
      ...Array.from({ length: 30 }, (_, i) => ({
        url: `https://example.org/${i}`,
        title: "x".repeat(500),
        description: "d".repeat(3000),
      })),
    ])!
    expect(output).toContain("1. Header Override")
    expect(output).toContain("one two")
    expect(output).not.toContain("duplicate")
    expect(output).not.toContain("credential leak")
    expect(output).not.toContain("URL injection")
    expect(output).not.toContain("javascript:")
    expect(output).not.toContain("21. ")
    expect(output.length).toBeLessThan(20 * (240 + 480 + 2048 + 60))
    expect(renderSearchResults([{ url: "javascript:bad()" }])).toBeUndefined()
  })

  test("stays bounded when a provider floods the boundary with 1000+ candidates", () => {
    const candidates = Array.from({ length: 1200 }, (_, i) => ({
      url: i % 3 === 0 ? "https://user:pass@example.com/leak" : `https://example.org/p/${i}`,
      title: `Result ${i} `.repeat(40),
      description: "d".repeat(5000),
    }))
    const output = renderSearchResults(candidates)!
    expect(output.split("\n\n")).toHaveLength(20)
    expect(output).not.toContain("user:pass@")
    expect(output).not.toContain("Result 1199")
    expect(output.length).toBeLessThan(20 * (240 + 480 + 2048 + 60))
  })

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
      const originalKey = process.env.FIRECRAWL_API_KEY
      process.env.FIRECRAWL_API_KEY = "fixture-key"
      try {
      const { ctx, calls } = makeCtx()
      const result = yield* execute({ query: "fixture query", provider: "firecrawl" }, ctx)

      expect(calls.length).toBe(1)
      expect(calls[0].permission).toBe("websearch")
      expect(calls[0].metadata.provider).toBe("firecrawl")
      expect(result.output).toContain("Fixture Result")
      expect(result.output).toContain("https://fixture.dev")
      expect(result.title).toContain("Firecrawl Web Search")
      } finally {
        if (originalKey === undefined) delete process.env.FIRECRAWL_API_KEY
        else process.env.FIRECRAWL_API_KEY = originalKey
      }
    }),
  )

  itTool.instance("env override firecrawl: same dispatch without an explicit pin", () =>
    Effect.gen(function* () {
      const original = process.env.OPENCODE_WEBSEARCH_PROVIDER
      const originalKey = process.env.FIRECRAWL_API_KEY
      try {
        process.env.OPENCODE_WEBSEARCH_PROVIDER = "firecrawl"
        process.env.FIRECRAWL_API_KEY = "fixture-key"
        const { ctx, calls } = makeCtx()
        const result = yield* execute({ query: "env query" }, ctx)
        expect(calls[0].metadata.provider).toBe("firecrawl")
        expect(result.output).toContain("Fixture Result")
      } finally {
        if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
        else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
        if (originalKey === undefined) delete process.env.FIRECRAWL_API_KEY
        else process.env.FIRECRAWL_API_KEY = originalKey
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
        expect(result.output).toContain("websearch providers (8")
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

describe("websearch anonymous provider cooldown", () => {
  const MCP_EMPTY = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "No results found." }] },
  })
  const FIRECRAWL_RESULTS = JSON.stringify({
    success: true,
    data: { web: [{ url: "https://cooldown.dev/hit", title: "Cooldown Hit", description: "usable" }] },
  })
  const EMPTY_HTML = "<html><body>no results</body></html>"

  type FirecrawlBehavior = "forbidden" | "rate-limited" | "results" | "interrupt"

  // Fake transport: Parallel/Exa always report an empty result set so the
  // automatic chain reaches Firecrawl; every other URL (DuckDuckGo) is empty.
  const makeHttp = (behavior: { firecrawl: FirecrawlBehavior }) => {
    const counts = { parallel: 0, exa: 0, firecrawl: 0, other: 0 }
    const http = HttpClient.make((request) => {
      const reply = (body: string, status = 200) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })))
      const url = request.url
      if (url.includes("search.parallel.ai")) {
        counts.parallel++
        return reply(MCP_EMPTY)
      }
      if (url.includes("mcp.exa.ai")) {
        counts.exa++
        return reply(MCP_EMPTY)
      }
      if (url.includes("api.firecrawl.dev")) {
        counts.firecrawl++
        if (behavior.firecrawl === "interrupt") return Effect.interrupt
        if (behavior.firecrawl === "forbidden") return reply("IP address looks suspicious", 403)
        if (behavior.firecrawl === "rate-limited") return reply("slow down", 429)
        return reply(FIRECRAWL_RESULTS)
      }
      counts.other++
      return reply(EMPTY_HTML)
    })
    return { http, counts }
  }

  // Process-local cooldown state and these env vars must not leak between
  // tests (or into unrelated tests sharing this module instance).
  const COOLDOWN_ENV = [
    "OPENCODE_WEBSEARCH_PROVIDER",
    "FIRECRAWL_API_KEY",
    "BRAVE_API_KEY",
    "TAVILY_API_KEY",
    "SEARXNG_URL",
    "OLLAMA_API_KEY",
  ] as const

  const isolated = <A, E>(body: () => Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const saved = COOLDOWN_ENV.map((key) => [key, process.env[key]] as const)
      resetWebSearchCooldowns()
      for (const key of COOLDOWN_ENV) delete process.env[key]
      try {
        return yield* body()
      } finally {
        resetWebSearchCooldowns()
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    })

  const runSearch = (http: HttpClient.HttpClient, params: { query: string; provider?: "firecrawl" }) =>
    Effect.exit(searchWithFallback(http, params, { sessionID: SESSION_ID }, {}))

  const failureText = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")

  it.effect("cooldown helpers bound TTLs, honor auth mode, and never shorten a longer window", () =>
    isolated(() =>
      Effect.gen(function* () {
        const t0 = yield* Clock.currentTimeMillis

        // Only 401/403/429 denial statuses cool a provider down.
        noteProviderCooldown("firecrawl", 500, t0)
        expect(providerCooldownInfo("firecrawl", t0)).toBeUndefined()

        noteProviderCooldown("firecrawl", 403, t0)
        expect(providerCooldownInfo("firecrawl", t0)?.status).toBe(403)
        expect(providerCooldownInfo("firecrawl", t0 + 5 * 60_000 - 1)?.remainingMs).toBe(1)
        // A later, shorter 429 must not truncate the active 403 window.
        noteProviderCooldown("firecrawl", 429, t0 + 1_000)
        expect(providerCooldownInfo("firecrawl", t0 + 1_000)?.status).toBe(403)
        // Expiry drops the entry; an earlier timestamp does not resurrect it.
        expect(providerCooldownInfo("firecrawl", t0 + 5 * 60_000)).toBeUndefined()
        expect(providerCooldownInfo("firecrawl", t0)).toBeUndefined()

        // A bare 429 cools down for exactly one minute.
        noteProviderCooldown("firecrawl", 429, t0)
        expect(providerCooldownInfo("firecrawl", t0 + 59_999)?.remainingMs).toBe(1)
        expect(providerCooldownInfo("firecrawl", t0 + 60_000)).toBeUndefined()

        // Auth mode scopes the state: a configured key reads its own bucket,
        // and an authenticated denial never writes into the anonymous bucket.
        noteProviderCooldown("firecrawl", 403, t0)
        process.env.FIRECRAWL_API_KEY = "fixture-key"
        expect(providerCooldownInfo("firecrawl", t0)).toBeUndefined()
        noteProviderCooldown("firecrawl", 403, t0 + 10)
        delete process.env.FIRECRAWL_API_KEY
        expect(providerCooldownInfo("firecrawl", t0)?.status).toBe(403)
      }),
    ),
  )

  it.effect("first anonymous 403 skips Firecrawl until the 5-minute cooldown expires", () =>
    isolated(() =>
      Effect.gen(function* () {
        const { http, counts } = makeHttp({ firecrawl: "forbidden" })

        const first = yield* runSearch(http, { query: "q1" })
        expect(Exit.isFailure(first)).toBe(true)
        expect(failureText(first)).toContain("firecrawl:error")
        expect(counts.firecrawl).toBe(1)

        const now = yield* Clock.currentTimeMillis
        expect(providerCooldownInfo("firecrawl", now)?.status).toBe(403)
        expect(providerStatus("firecrawl", {}, now)).toContain("cooldown 300s after HTTP 403")

        const second = yield* runSearch(http, { query: "q2" })
        expect(failureText(second)).toContain("firecrawl:unavailable")
        expect(counts.firecrawl).toBe(1)

        yield* TestClock.adjust("5 minutes")
        expect(providerCooldownInfo("firecrawl", yield* Clock.currentTimeMillis)).toBeUndefined()

        const third = yield* runSearch(http, { query: "q3" })
        expect(failureText(third)).toContain("firecrawl:error")
        expect(counts.firecrawl).toBe(2)
      }),
    ),
  )

  it.effect("first anonymous 429 cools down for one minute, then the backend is retried", () =>
    isolated(() =>
      Effect.gen(function* () {
        const { http, counts } = makeHttp({ firecrawl: "rate-limited" })

        const first = yield* runSearch(http, { query: "q1" })
        expect(failureText(first)).toContain("firecrawl:error")
        expect(providerCooldownInfo("firecrawl", yield* Clock.currentTimeMillis)?.status).toBe(429)
        expect(counts.firecrawl).toBe(1)

        const second = yield* runSearch(http, { query: "q2" })
        expect(failureText(second)).toContain("firecrawl:unavailable")
        expect(counts.firecrawl).toBe(1)

        yield* TestClock.adjust("30 seconds")
        const third = yield* runSearch(http, { query: "q3" })
        expect(failureText(third)).toContain("firecrawl:unavailable")
        expect(counts.firecrawl).toBe(1)

        yield* TestClock.adjust("31 seconds")
        const fourth = yield* runSearch(http, { query: "q4" })
        expect(failureText(fourth)).toContain("firecrawl:error")
        expect(counts.firecrawl).toBe(2)
      }),
    ),
  )

  it.effect("a configured FIRECRAWL_API_KEY bypasses the anonymous cooldown without clearing it", () =>
    isolated(() =>
      Effect.gen(function* () {
        const { http, counts } = makeHttp({ firecrawl: "forbidden" })

        const first = yield* runSearch(http, { query: "q1" })
        expect(failureText(first)).toContain("firecrawl:error")
        expect(counts.firecrawl).toBe(1)
        const second = yield* runSearch(http, { query: "q2" })
        expect(failureText(second)).toContain("firecrawl:unavailable")
        expect(counts.firecrawl).toBe(1)

        // Authenticated mode ignores the anonymous bucket and never records
        // its own cooldown, so every authenticated attempt goes out.
        process.env.FIRECRAWL_API_KEY = "fixture-key"
        expect(providerCooldownInfo("firecrawl", yield* Clock.currentTimeMillis)).toBeUndefined()
        yield* runSearch(http, { query: "q3" })
        yield* runSearch(http, { query: "q4" })
        expect(counts.firecrawl).toBe(3)

        // Removing the key restores the untouched anonymous cooldown.
        delete process.env.FIRECRAWL_API_KEY
        const fifth = yield* runSearch(http, { query: "q5" })
        expect(failureText(fifth)).toContain("firecrawl:unavailable")
        expect(counts.firecrawl).toBe(3)
      }),
    ),
  )

  it.effect("strict pins (provider param and env override) bypass the cooldown", () =>
    isolated(() =>
      Effect.gen(function* () {
        const { http, counts } = makeHttp({ firecrawl: "forbidden" })

        const automatic = yield* runSearch(http, { query: "q1" })
        expect(failureText(automatic)).toContain("firecrawl:error")
        expect(counts.firecrawl).toBe(1)

        const skipped = yield* runSearch(http, { query: "q2" })
        expect(failureText(skipped)).toContain("firecrawl:unavailable")
        expect(counts.firecrawl).toBe(1)

        const explicitPin = yield* runSearch(http, { query: "q3", provider: "firecrawl" })
        expect(failureText(explicitPin)).toContain("firecrawl:error")
        expect(counts.firecrawl).toBe(2)

        process.env.OPENCODE_WEBSEARCH_PROVIDER = "firecrawl"
        const envPin = yield* runSearch(http, { query: "q4" })
        expect(failureText(envPin)).toContain("firecrawl:error")
        expect(counts.firecrawl).toBe(3)

        delete process.env.OPENCODE_WEBSEARCH_PROVIDER
        const backToAutomatic = yield* runSearch(http, { query: "q5" })
        expect(failureText(backToAutomatic)).toContain("firecrawl:unavailable")
        expect(counts.firecrawl).toBe(3)
      }),
    ),
  )

  it.effect("cancellation is terminal, records no cooldown, and later searches still run", () =>
    isolated(() =>
      Effect.gen(function* () {
        const behavior = { firecrawl: "interrupt" as FirecrawlBehavior }
        const { http, counts } = makeHttp(behavior)

        const cancelled = yield* runSearch(http, { query: "q1" })
        expect(Exit.isFailure(cancelled)).toBe(true)
        if (Exit.isFailure(cancelled)) expect(Cause.hasInterrupts(cancelled.cause)).toBe(true)
        expect(counts.firecrawl).toBe(1)
        // Terminal: no DuckDuckGo probe after the interrupted attempt.
        expect(counts.other).toBe(0)

        // The interrupted attempt must not have cooled anything down.
        behavior.firecrawl = "forbidden"
        const second = yield* runSearch(http, { query: "q2" })
        expect(failureText(second)).toContain("firecrawl:error")
        expect(counts.firecrawl).toBe(2)

        // ...while a completed 403 from the second attempt does.
        const third = yield* runSearch(http, { query: "q3" })
        expect(failureText(third)).toContain("firecrawl:unavailable")
        expect(counts.firecrawl).toBe(2)
      }),
    ),
  )

  it.effect("providers introspection reports conditional cooldown without any network probe", () =>
    isolated(() =>
      Effect.gen(function* () {
        const { http, counts } = makeHttp({ firecrawl: "forbidden" })
        yield* runSearch(http, { query: "warmup" })
        const probes = counts.firecrawl
        expect(probes).toBe(1)

        const now = yield* Clock.currentTimeMillis
        const cooled = providersOutput({}, now)
        expect(cooled).toContain("firecrawl")
        expect(cooled).toContain("cooldown 300s after HTTP 403")
        expect(cooled).toContain("keyless-conditional")
        expect(counts.firecrawl).toBe(probes)

        // Authenticated view hides the anonymous cooldown.
        process.env.FIRECRAWL_API_KEY = "fixture-key"
        const authenticated = providersOutput({}, now)
        expect(authenticated).not.toContain("cooldown")
        expect(authenticated).toContain("ready (authenticated)")
        delete process.env.FIRECRAWL_API_KEY

        // Expired cooldown disappears from the listing.
        expect(providersOutput({}, now + 5 * 60_000 + 1)).not.toContain("cooldown")
        expect(counts.firecrawl).toBe(probes)
      }),
    ),
  )
})
