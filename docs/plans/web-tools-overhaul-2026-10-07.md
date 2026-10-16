# OpenFork Web Tools Overhaul — Research, Diagnosis, and Implementation Plan

**Date:** 2026-10-07  
**Scope:** `packages/opencode` production web surface plus native/OpenFork, OXP, OFXP, ACP presentation, and newer `packages/core` as a source donor.  
**Status:** Research pass complete; first reliability/hardening tranche implemented in the shared dirty worktree. This document deliberately separates what is already implemented from follow-on work.

## Executive conclusion

OpenFork does **not** primarily have a "missing providers" problem. It has a search abstraction problem.

The existing product direction — one compact model-visible `web` tool delegating internally to fetch/search — is the right direction for OpenFork's low-hydration architecture. The main reason search is unattractive to agents is that the implementation previously exposed backend infrastructure while providing weak reliability semantics:

- provider selection used deterministic session sharding rather than quality/health-aware routing;
- an automatically selected provider could fail or return nothing without runtime fallback;
- native, OXP, and OFXP each performed their own one-provider dispatch;
- keyed-provider feature flags could be confused with provider availability;
- provider outputs were plain provider-specific strings instead of a normalized result contract;
- response-body bounds and timeout semantics were incomplete;
- tool prose overstated capabilities and pushed provider recovery work onto the model.

The correct target is therefore:

> **One small semantic `web` tool, backed by one shared Web runtime, with lazy provider modules, ordered availability/fallback, normalized structured results, real cancellation/deadlines, and empirical routing telemetry.**

Provider choice should almost never be a model concern. A provider pin is an advanced operational/debug override.

## Current OpenFork architecture

### Model-visible surface

`packages/opencode/src/tool/registry.ts` exposes the unified `web` tool. `webfetch` and `websearch` remain internal delegates. This already follows the desired compact surface and should be preserved.

The old `webSearchEnabled()` model/provider gate is currently runtime-dead: it remains referenced by tests but not by tool selection. Search underuse is therefore not explained by OpenAI/third-party models being blocked from seeing the unified tool.

### Production search providers

The active V1/fork path currently contains adapters for:

- Parallel MCP
- Exa MCP
- Firecrawl
- DuckDuckGo HTML
- Brave Search API
- Tavily Search API
- SearXNG
- Ollama Web Search

Before this pass, automatic selection was effectively:

`explicit pin > OPENCODE_WEBSEARCH_PROVIDER > feature flags > deterministic session hash over available providers`

There was no automatic fallback after the chosen provider failed or returned no usable results.

### Surface duplication

Native, OXP, and OFXP all depended on the same provider adapters but had separate dispatch decisions. That meant routing semantics could drift even when the provider clients were shared.

ACP maps the unified `web` tool as a fetch-like tool regardless of search/fetch action. That is presentation metadata debt, not the core search failure, but it should be corrected.

## External implementation research

### OpenCode upstream

Current upstream OpenCode remains a useful **source donor**, not a compatibility target.

Its current `packages/opencode/src/tool/websearch.ts` still exposes only Exa and Parallel and still uses an env/flag/session-selection policy rather than a mature provider chain. It is therefore not a strong donor for routing policy.

The newer `packages/core/src/tool/webfetch.ts`, however, is a good hardening donor: it uses `collectBoundedResponseBody` so a chunked or lying response cannot force an unbounded allocation before the configured size limit is enforced. That mechanism has now been backported into the active OpenFork V1 path.

Source:
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/websearch.ts
- https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/webfetch.ts

### oh-my-pi / OMP

OMP is currently the strongest architecture donor.

Its web stack has several properties that OpenFork should emulate selectively:

1. **Lazy provider registry.** Provider modules are dynamic imports loaded on first selection and memoized, keeping dozens of provider transports out of interactive startup.
2. **Normalized response contract.** Every adapter returns a structured `SearchResponse` containing provider, sources, optional answer/citations, dates/snippets, usage, request ID, auth mode, etc.
3. **Fallback is runtime policy.** A role/provider chain is walked until usable results are returned.
4. **Explicit provider/model selection is exceptional.** Automatic routing is the normal path.
5. **Hard provider deadlines + cancellation propagation.** Caller abort is not misclassified as provider failure and therefore never causes additional fallback requests after cancellation.
6. **Semantic query parsing.** Search directives and recency/domain constraints are parsed once, mapped to provider-native controls when possible, and leniently post-filtered when not.
7. **Grounded model search is first-class.** Existing model credentials/grounding for Gemini, Anthropic, Codex/OpenAI, xAI, OpenRouter, etc. can act as search providers alongside dedicated APIs.
8. **Public/search-engine fallbacks are explicitly lower-confidence transports**, not confused with agent-grade search APIs.

Particularly useful source files:
- https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/web/search/provider.ts
- https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/web/search/index.ts
- https://github.com/can1357/oh-my-pi/blob/main/packages/tui/src/tools/web-search-types.ts
- https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/test/web/search/abort-and-timeout.test.ts

The OMP model-facing schema is also notably small: query, optional recency, optional limit, and a few advanced generation/search-count controls. Providers remain an internal routing concern.

### OpenChamber

OpenChamber is not a strong donor for backend search orchestration. Its main web-search responsibility is configuration UX around OpenCode.

What is worth borrowing is **configuration provenance**:

- settings distinguish automatic/random/explicit/disabled selection;
- writes go to the highest-owned effective config layer;
- project config overrides are detected and surfaced rather than silently overwritten;
- config changes are idempotent and live.

Source:
- https://github.com/openchamber/openchamber/blob/main/packages/web/server/lib/opencode/websearch-config.js

For OpenFork, this argues for an "Automatic" default in settings with advanced provider priority/pinning configured outside the model schema.

### Gemini CLI

Gemini CLI provides two useful design patterns:

- model-facing search can be tiny — essentially the query — while the underlying provider synthesizes grounded output with citations;
- fetch security belongs in a shared network boundary: URL/IP validation, private/reserved-network handling, redirect handling, and connection behavior should not be reimplemented independently by every web tool.

OpenFork should borrow the security ownership principle, not necessarily Gemini's exact transport.

### Cline

Cline's Exa integration is a useful semantic-schema donor: query plus limit/domain/recency/country controls and structured results. It is less useful for routing because it is essentially a single-provider integration.

## Search provider landscape — October 2026

The word "free" must be split into three categories: keyless zero-config, free-tier authenticated, and self-hosted/public scraping.

| Provider | Zero-config? | Free allowance / model | Recommended OpenFork role |
|---|---:|---|---|
| Parallel Search MCP | Yes | Free by default; no account/API key required for public MCP; auth optional for higher limits/analytics | Primary zero-config search candidate |
| Exa hosted MCP | Yes | No API key required; advertised free to use | Primary zero-config semantic search candidate |
| Firecrawl Keyless | Yes | 1,000 free credits/month; REST/MCP/CLI; no Authorization header required | Primary zero-config search/fetch candidate |
| SearXNG | Self-hosted | Open source; JSON API depends on instance config | Excellent user/self-hosted provider |
| Tavily | No | 1,000 API credits/month; no credit card | Good configured free-tier provider |
| Brave Search API | No | $5 free credits/month; Search currently $5/1,000 requests | Good configured provider; not zero-config |
| Serper | No | 2,500 free Google-search queries advertised; no credit card | Candidate configured SERP provider |
| SerpApi | No | 250 searches/month free plan | Candidate configured SERP provider |
| Ollama Web Search | No | Free Ollama account includes a web-search free tier; API key required | Good configured free-tier provider, particularly for Ollama users |
| DuckDuckGo HTML | No key, but not API | Best-effort HTML scraping | Last-resort fallback only |
| Startpage/Google/Ecosia/Mojeek HTML | No key, but not API | Best-effort scraping; anti-bot/ToS/reliability constraints | Optional fallback tier, never primary |
| Jina | No | Current API docs require key; large signup token allowance | Evaluate endpoint/product terms before defaulting |

Primary official references:
- Parallel free MCP: https://parallel.ai/blog/free-web-search-mcp
- Exa MCP: https://exa.ai/mcp
- Firecrawl Keyless: https://www.firecrawl.dev/blog/firecrawl-keyless-launch
- Tavily pricing: https://www.tavily.com/pricing
- Brave Search API: https://brave.com/search/api/
- Serper: https://serper.dev/
- SerpApi: https://serpapi.com/pricing
- Ollama Web Search: https://ollama.com/blog/web-search
- SearXNG Search API: https://docs.searxng.org/dev/search_api.html

### Firecrawl-specific opportunity

Firecrawl Keyless is especially relevant because it now provides a legitimate zero-config REST surface, not merely an unauthenticated accident. Firecrawl also exposes developer-oriented search/index capabilities that are worth evaluating as a specialized coding/docs route rather than forcing every technical query through generic search.

## Implemented in this pass

The following changes are already present in the live shared worktree.

### 1. Removed session-hash roulette from automatic search

Automatic search is now deterministic and free-first rather than randomly stable per session.

Current automatic candidate order:

`Parallel -> Exa -> Firecrawl -> configured SearXNG -> configured Brave -> configured Tavily -> configured Ollama -> DuckDuckGo`

This ordering is an initial operational default, **not a claim that it is globally optimal**. The end state should be driven by OpenFork's own replay benchmark/telemetry.

### 2. Added runtime provider fallback

A new shared `searchWithFallback()` walks eligible providers, falling through when a provider errors or returns empty/non-result content.

Explicit call-site provider pins and `OPENCODE_WEBSEARCH_PROVIDER` remain strict one-provider overrides for debugging/operations.

Feature flags are preferences, not fake credentials.

### 3. Shared whole-search deadline

A shared `executeWebSearch()` wraps the fallback chain with a 45-second total deadline.

Each automatic provider attempt has a shorter bounded response deadline; an explicit single-provider request retains a longer single-provider allowance.

Native, OXP, and OFXP now all call the same execution path.

### 4. Cancellation semantics

The fallback loop detects Effect interruption and rethrows it instead of treating it as an ordinary provider failure. This prevents an interrupted native search from continuing to issue fallback searches.

Follow-up work is still needed to compose the OXP/OFXP caller `AbortSignal` directly into outbound HTTP transport rather than only checking the signal around execution.

### 5. Stronger MCP response parsing

The Exa/Parallel MCP parser now rejects JSON-RPC and MCP tool errors rather than returning error payloads as "search results", and it can aggregate multiple text content blocks.

### 6. Correct Firecrawl Keyless availability

Firecrawl is treated as genuinely keyless. A `FIRECRAWL_API_KEY` remains optional for authenticated usage, but a feature flag or automatic routing does not require one.

This matches Firecrawl's June 16, 2026 Keyless launch: REST calls may be made without an Authorization header and receive 1,000 free credits/month.

### 7. Bounded fetch response bodies

Active V1 `webfetch` now uses the newer shared `collectBoundedResponseBody` implementation.

The 5 MiB limit is enforced while streaming, including chunked/misreported responses, instead of after `arrayBuffer()` has already buffered the entire body.

The fetch timeout now encloses body collection rather than only response-header receipt.

### 8. Bounded search-provider response bodies

All current search transports now use a shared bounded response-text collector:

- MCP (Parallel/Exa)
- Firecrawl
- Brave
- Tavily
- SearXNG
- DuckDuckGo

This prevents malformed or adversarial search endpoints from turning `response.text()` into an unbounded allocation.

### 9. Tool prose corrected

The search/fetch descriptions no longer claim unsupported HTTPS auto-upgrading, generic domain-filter support, or guaranteed full-page search content.

Search documentation now teaches the intended policy: automatic provider selection/fallback by default; explicit provider selection only as an advanced override.

## Validation state

Focused package-local tests after the implementation pass:

- `test/tool/webfetch.test.ts`
- `test/tool/websearch.test.ts`

Current result: **41 pass, 0 fail**.

Coverage includes:

- deterministic free-first selection;
- provider availability vs credentials;
- Firecrawl Keyless behavior;
- automatic fallback through failed/non-result providers;
- empty-result prose rejection;
- MCP JSON-RPC/MCP-error parsing;
- multiple MCP text blocks;
- provider response parsers;
- permission/dispatch behavior;
- chunked fetch response rejection over the 5 MiB limit.

A package-wide typecheck was also attempted. It remains red because of unrelated pre-existing/shared-tree errors in session recall metadata, ACP nullability, support-bundle argument typing, HTTP API brands, swarm typing, and compatibility/server tests. None of the reported diagnostics were in the web files changed by this tranche.

The giant parameter snapshot is already heavily modified by unrelated concurrent tool-schema work; it was intentionally not regenerated/overwritten as part of this focused change.

## Target architecture

### A. Keep exactly one ordinary model-visible web surface

Do not add `parallel_search`, `exa_search`, `firecrawl_search`, etc. as separate ordinary tools.

The unified `web` surface should remain small and semantic:

```text
action: search | fetch | providers/debug
query/url
limit?
recency?
includeDomains?
excludeDomains?
mode?: fast | balanced | deep
```

Provider is an advanced/debug option, ideally not present in the normal schema hydration path.

### B. Create one shared WebSearch service as the lowest correct owner

The next structural refactor should move provider registry, availability, fallback, normalized response types, failure classification, deadlines, and telemetry under one shared service/module.

Native Tool, OXP, OFXP, and future ACP/external surfaces should be thin adapters over that service.

### C. Lazy provider registry

Replace eager static imports with dynamic provider loaders memoized by provider ID, similar to OMP.

Benefits:

- provider count can grow without interactive startup/import cost;
- optional SDKs/transports remain cold until selected;
- provider addition does not inflate the ordinary model tool schema;
- provider implementation becomes independently testable.

### D. Normalize provider output before rendering

Provider adapters should return data, not model-facing prose.

Suggested minimum contract:

```ts
type SearchSource = {
  url: string
  title: string
  snippet?: string
  publishedAt?: string
  score?: number
  author?: string
}

type SearchResponse = {
  provider: WebSearchProvider
  query: string
  answer?: string
  sources: SearchSource[]
  citations?: Array<{ url: string; title?: string; citedText?: string }>
  relatedQueries?: string[]
  requestId?: string
  usage?: unknown
  authMode?: "keyless" | "api-key" | "oauth" | "self-hosted" | "public-html"
}
```

Only the boundary renderer should turn this into compact text for the model.

This unlocks dedupe, source-quality measurement, freshness handling, citation preservation, provider benchmarking, and UI metadata without reparsing markdown.

### E. Semantic query controls

Borrow the OMP/Cline approach:

- `recency`
- include/exclude domains
- query directives such as `site:`, `-site:`, `after:`, `before:`, `filetype:`, `intitle:`, `inurl:`
- provider-native mapping when supported
- local lenient post-filtering when a provider cannot enforce the constraint

Do not expose seven different provider-specific schemas to the model.

### F. Route on intent, health, and evidence — not static folklore

The initial free-first order is a bootstrap. Build OpenFork's own routing data.

Record per attempt:

- provider
- latency
- success/error/empty
- HTTP/error class
- result count
- source/domain diversity
- publication-date coverage
- fallback position
- bytes/tokens returned
- whether fetch follow-up was needed
- query intent class (coding/docs/current-news/research/navigation)

Then use a replay corpus of real OpenFork searches to choose defaults.

A lightweight circuit breaker should temporarily cool down providers producing repeated timeouts/429/5xx so every search does not pay the same known-bad latency.

### G. Add explicit search modes

Suggested semantics:

- **fast**: one best available provider; one fallback only if failure.
- **balanced**: normal ordered fallback until first usable result.
- **deep**: optionally query two complementary providers, canonicalize/dedupe URLs, merge/rerank, and return consensus/source diversity.

Do not fan out by default: parallel provider search spends quota, increases latency, and can flood context.

### H. Reuse already-owned model grounding

OMP demonstrates a high-value route OpenFork does not yet fully exploit: if the current account/model connection already provides grounded web search, it can be an internal provider without requiring another user's search API account.

Evaluate grounded adapters for the provider surfaces OpenFork already authenticates, especially OpenAI/Codex, Gemini, Anthropic, and others with native grounded search.

This should remain behind the same normalized `SearchResponse`.

### I. Coding-specialized routing

For OpenFork's main use case, generic web quality is not the only metric.

Investigate specialized routes for:

- Firecrawl Developer Index;
- GitHub/code-host tools when the query targets repositories/code;
- official documentation domain boosts;
- package registry/docs sources.

The unified tool can infer/receive intent internally without exposing more tools.

### J. Fetch security and extraction

The response-size bug is fixed, but fetch still needs a deliberate shared egress policy.

At the shared HTTP/network owner, add:

- redirect-hop validation;
- DNS resolution and private/reserved IP checks;
- rebinding-safe connection behavior where practical;
- protocol allowlist;
- consistent maximum redirects;
- cancellation wired into transport;
- adaptive/user-agent policy.

Do not implement SSRF policy separately in `webfetch.ts`, OXP, and OFXP.

Site-aware extraction can remain an optimization layer after the generic secure fetch path. Dedicated authenticated tools (for example GitHub) should be preferred where OpenFork already has them.

## Prioritized next implementation sequence

1. **Normalize SearchResponse + provider error types.** This is the key enabling refactor.
2. **Move adapters behind a lazy provider registry.**
3. **Add semantic `recency/includeDomains/excludeDomains` input and query-directive parsing.**
4. **Add telemetry + provider health/circuit breaker and build a replay benchmark from real OpenFork search queries.**
5. **Wire OXP/OFXP caller AbortSignal into the actual outbound HTTP effect.**
6. **Add grounded-model providers using already-owned authentication where technically/contractually appropriate.**
7. **Add Firecrawl Developer Index / coding-intent route.**
8. **Implement shared fetch egress/SSRF/redirect policy.**
9. **Fix ACP/UI semantic presentation so search renders as search rather than fetch.**
10. **Use OpenChamber-style provenance-aware settings for Automatic / Disabled / advanced provider preferences.**

## Required test matrix for the next tranche

Provider orchestration:

- primary success stops fallback;
- empty result falls through;
- malformed body falls through;
- 401/403 classified as auth/config problem;
- 429 classified as transient/rate limit and circuit-breaker eligible;
- 5xx and network errors classified transient;
- provider deadline falls through;
- whole-chain deadline terminates;
- caller cancellation terminates immediately and never starts another provider;
- explicit pin does not silently route elsewhere;
- unavailable keyed provider is skipped without network I/O.

Response semantics:

- canonical URL dedupe;
- duplicate source merge;
- dates preserved;
- citations preserved;
- source cap/truncation is deterministic;
- recency/domain filters map correctly to each capable provider;
- local post-filter relaxes constraints rather than returning a false empty when appropriate.

Transport/fetch:

- chunked oversized search/fetch bodies;
- lying Content-Length;
- redirect to private/reserved target;
- DNS rebinding scenario where testable;
- redirect loops;
- slow body after fast headers;
- compressed response expansion limits;
- image/text/PDF content-type behavior;
- caller cancellation during body stream.

Cross-surface parity:

- native/OXP/OFXP same candidate order;
- same total/provider deadlines;
- same result provider/attempt metadata;
- same explicit-pin semantics;
- same error classification;
- attachment behavior explicitly specified rather than accidentally lost.

## Decision

The current changes should be treated as **Phase 0/1 reliability hardening**, not the finished search architecture.

They remove the most damaging behavior immediately — random backend quality and no fallback — while preserving OpenFork's compact single-tool philosophy.

The next highest-leverage work is **not adding another provider**. It is introducing the normalized structured result/service boundary so every future provider, router, benchmark, citation renderer, filter, and UI can build on one stable contract.
