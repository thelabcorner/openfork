# OpenFork Usage + OXP Workload Intelligence — implementation ledger

Date: 2026-10-11. Status: **in progress**. Owner: OpenFork. Keep this document as the source of truth for implementation status; a checked cell requires passing evidence, not just a code edit.

## Product goal

Convert Usage from a cost-only dashboard into a dense, queryable developer workload profiler that answers **what happened, where time and tokens went, which tools failed, which model/provider combinations work best, and how trustworthy each estimate is**. Provide genuine three-level global → provider → model breakdowns, plus the distinct OXP external-agent boundary. Use the visual grammar and interaction patterns of the **OXP Session Tool Timeline**, not generic SaaS charts: compact chronological rows, hairline rules, icon/tool semantics, tight typographic hierarchy, contextual inspector detail, quiet zinc, New York density, no decorative gradients/cards/giant gutters. Keep all data sourced from authoritative services, not transcript UI.

## Inspected authoritative paths

- Repo contract: `AGENTS.md`, `packages/{app,core,opencode}/AGENTS.md`, `docs/map/{README,architecture,surfaces,v1-v2}.md`. V1 mature runtime with V2 presentation. Tier-0 global usage; no implicit Instance/workspace bootstrap.
- OpenFork usage: `packages/opencode/src/usage/usage.ts` (settled `usage_record`, duration, TTFT, generation); `inspection-query.ts`; `packages/app/src/pages/usage-page.tsx` and `usage/*`.
- OXP: `packages/core/src/oxp-activity/{sql,inspection,activity}.ts`, `oxp-attribution/*`; `packages/app/src/pages/oxp/{oxp-timeline,oxp-invocation-row,oxp-attribution-panel,oxp-api-cost-panel}.tsx`.
- Existing pages: `UsagePageOxp` obtains bootstrap-free `global.oxpAttribution` lazily; other tab uses global `usage.summary`. Preserve separation until unified projection is justified.
- Dirty-tree safety: shared checkout contains extensive unrelated in-flight modifications; never reset/stash/reformat them, and check overlapping files before patching.

## Fundamental measurement truth

1. **Observed**: exact duration from clock start/end; request/result text character counts at OXP boundary; actual recorded provider prompt/completion/cache/TTFT/generation when present.
2. **Estimated**: OXP text tokens from calibrated tokenizer/character fallback; surrounding OpenAI tokens from *paired local OpenFork donor request histories* segmented by model/provider, turn lifecycle, cache, context length, and message type. No claim that this is observed ChatGPT billing.
3. **Unavailable**: provider TTFT if provider never exposed it; true ChatGPT server-side cache usage; upstream hidden reasoning and internal tokens; a missing duration cannot equal zero. Never infer these from timing unrelated events.
4. **Tool phases**: wall duration per tool invocation, overlapping/nonexclusive. Do not sum overlapping tools as user-visible blocking time without interval-union logic. Distinguish provider latency / model generating / tool execution / scheduling & idle.
5. **Attribution identity**: one authoritative `providerID + modelID` per settled generation where available; OXP executions have external-agent origin and may **not** have a known upstream model. Never falsely assign OpenFork's provider/model to a ChatGPT OXP call.
6. **Cohort validity**: always expose sample sizes, telemetry coverage, p50/p95 quantiles, and no-sample/unavailable states. Keep retries, cancellations, aborts and authorization denials separate from tool failures.
7. **Historical honesty**: indicate since-available or partial-coverage telemetry instead of showing complete-looking zeroes; avoid double-counting forked sessions or mirrored settlements.

## Architecture / transport

```
V1 and Core producers (settlement, tool start/stop, TTFT, cache counters)
  -> durable owner (Usage for model settlement / OXP Activity for external invocations)
  -> bounded, indexed Tier-0 aggregate projection/query
  -> single browser-safe result with applied scope, telemetry coverage and watermark
  -> lazy Usage / OXP inspector + bounded charts / virtualized long lists
```

### Data model and API checklist

- [x] Inventory `usage_record`, `OxpInvocationTable`, SessionTelemetry and native terminal-tool settlement coverage. Observability gaps are documented in the evidence appendix.
- [x] Implement idempotent scalar-only terminal host-tool settlement with no arguments/outputs; historical unrecorded invocations remain unavailable.
- [x] Preserve distinct native terminal outcome classes and distinct OXP observed outcome classes. Open/running OXP stays non-failure.
- [x] Distinguish host dispatch→token, client creation→token and token→stream-end measurements; provider-internal TTFT is explicitly unavailable, not guessed.
- [x] Build Tier-0 native query with genuine providerID/modelID/projectID/time filters, no transcript hydration; global/provider/model all share one query implementation.
- [x] Add completed-time provider/model composite index, bounded top-N and independent failure ranking, deterministic ranking, and validated EXPLAIN query plan.
- [x] OXP activity-based opt-in indexed profiler: observed statuses, p50/p95 with coverage, volume and failure leaderboards, <=120 buckets and backward-compatible response.
- [ ] OXP estimation **partial**: actual local per-model and cohort ratios, explicit provenance n, independent OXP-vs-surrounding cache assumptions implemented. Shrinkage, cache-write model, per-request long-context distribution and validated intervals outstanding.
- [ ] Invariant tests: Tier-0 no Instances, no provider request or workspace bootstrap, stable pagination, no read-time transcript hydration, no double counting, correct failure denominators, bounded active-request behavior.

### UI information architecture / task ledger

- [ ] **Partial**: main Usage window/project controls retained; Performance now has clickable global → provider → model profiler with keyboard-accessible scope breadcrumbs, independent true cohort tool/project breakdowns, and stale-result protection. Period-over-period comparison outstanding.
- [ ] **Overview / Efficiency**: compact instrument bar — spent, requests, token classes, generated time, tool wall vs union time, TTFT p50/p95, output TPS, cache reuse, error rate, uncertainty/coverage. Trend sparklines when sampled; avoid card nesting.
- [ ] **Partial**: same settled metrics per provider and model, searchable sortable dense provider/model cohort table and a dedicated model detail. Multi-model comparison matrix and normalized rankings outstanding.
- [ ] **Partial**: real global/provider/model native top-used/top-failing/slow, per-tool expandable outcome/P50/P95 inspector; native project failure/time/volume with dominant tools; model/project settled-generation counts/tokens/stream time including tool-less models. Correlation, concurrency interval union, and causal analysis outstanding.
- [ ] **Partial**: three distinct observed host/client/generation percentile distributions, 3-phase comparative bar plot, coverage shown. True provider-internal latency, overlapping union and long-tail outlier navigation outstanding.
- [ ] **Activity**: retain session/project and calendar diagnostics; link to slow/failing tool cohorts.
- [ ] **Partial**: OXP timeline-inspired inspector now includes selectable bucket trends, independently ranked leaderboards and expandable invocation-tool aggregates, local donor cost scenarios integrated. Direct session-timeline navigation and >90-day profiling still outstanding.
- [ ] **Correlations**: contextual comparisons such as tool count vs end-to-end time, failure vs latency, cache vs cost, per-provider normalized request mix; distinguish correlation from causal effect.
- [ ] Long lists: virtualized/recycled rows and tiny deferred detail modules; no expensive per-row effects, charts created only in active tab.
- [x] Focused keyboard navigation on scope breadcrumbs, scope rows, tool and project inspectors; sortable column announcements, hover not sole access, values readable without color. Full accessibility E2E still open.

### Performance acceptance

- [ ] Query cold/warm benchmarks on *actual large local DB* with EXPLAIN QUERY PLAN and bound counts; preserve incrementalized/O(1) settlement hot paths.
- [x] Lazy Perf/OXP tabs; indexed bounded server workload read only when selected; no N+1 polling, per-row effects, or provider fanout.
- [x] OXP server chart <=120 buckets; true counted outcomes; native tool top-N 1–50 with independent failure leaders; stable sorting.
- [ ] Production traces with several active sessions; tab switch, 30d/90d/all, model/provider switch, refresh and no network/provider fanout.
- [ ] Run focused tests, typechecks and benchmark before claiming a checked implementation cell.

## Working order

P0: truth / coverage and data provenance audit → P1: indexed grouped global/provider/model tool + timing projection → P2: premium Tools/Latency inspector UI → P3: OXP tool/time profiling + empirical model/cache split → P4: correlations and uncertainty → P5: production benchmark, migration/backfill, regression gates.

## Evidence ledger

| Milestone | Status | Evidence |
|---|---|---|
| Root/package architecture review | done | Files inspected above |
| Current frontends and server ownership surveyed | done | Usage records, OXP invocation ownership, native tool-part terminal producer, SDK transport, migration and UI inspected |
| Plan and implementation checklist authored | done | This document |
| Authoritative global/provider/model tools | implemented, isolated tests green | /usage/workload; provider/model/project selectors, native settlement producer, top-used/top-failing |
| Native TTFT/tool latency breakdown | implemented, isolated tests green | Host/client/generation clocks, percentiles, outcome taxonomy, scoped UI |
| OXP workload profiler | implemented, isolated tests green | Bounded /global/oxp/attribution opt-in, independent failure leaderboard, trend chart |
| OXP calibrated cache/input-output estimation | partial | Local donor per-model cache/output ratios and independent OXP cache scenario; uncertainty/shrinkage pending |
| Hierarchical global/provider/model profiler | implemented; app focus tests green | `usage-drilldown-model.ts`, `usage-page-performance.tsx`, `usage-workload-panel.tsx`; provider/model-qualified scope, one canceled/replaced Tier-0 request, stale response guard |
| Top projects by native tool usage | implemented; focused backend tests green | Independent project call/error/tool-time boards, per-project dominant tools; see `usage-cohort-backend-evidence.md` |
| Top projects by settled model generations | implemented; focused backend tests green | `generationProjects` projection, provider/model identity, caching/output counts, exact generation clock and measured Ns, tombstones, unattributed cohort, tool-less models; see `usage-generation-project-evidence.md` |
| OXP timeline-inspired inspector | implemented; focused tests green | OXP 95/95 tests reported by DeepSeek worker, 11/11 pure model tests; focusable activity buckets/expandable rows, no asserted upstream model identity |
| UX and performance gate | partial | 19/19 focused app tests, 13/13 integrated query tests, app `tsgo -b` green, 20K-row synthetic scoped query 7.6 ms with composite index. Core typecheck currently has an unrelated `sqlite-scan-ipc-error-recovery-20261011.test.ts` generic mismatch; full opencode typecheck has many unrelated dirty-tree type errors. Live large DB + visual E2E pending; no CDP desktop on :9222. |
