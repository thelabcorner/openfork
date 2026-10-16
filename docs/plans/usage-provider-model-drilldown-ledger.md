# Usage Intelligence — provider / model / project profiler drilldown ledger

**2026-10-11 · additive to** `usage-oxp-workload-intelligence-ledger.md`. Repository-wide and `packages/app`, `packages/core`, `packages/opencode` AGENTS rules remain normative. Shared uncommitted tree: no reset, reformat, unrelated changes, or commit.

## IA and first-party interaction contract

**Usage › Performance** is the entry point. One content rail, not a second permanent sidebar: `All providers › Provider › Model` is a stable breadcrumb with backtracking. Clicking a provider opens a **provider profiler** with its real settled models. Clicking a model opens a **model profiler**, not another generic chart. Clicking the breadcrumb changes scope without losing the Usage time-window/project context. Global, provider, model always query the *same* authoritative producer with the exact applied scope.

- [x] Global index: provider ranking and global tool rankings (volume, errors, time) + global project profile; metrics and measured coverage.
- [x] Provider inspector: provider identity, locally recorded settlement statistics, child models ranking, matching top tools and project ranking. A one-click model row opens the model profiler.
- [x] Model inspector: provider/model identity and generation metrics; generation phases P50/P95 with measured Ns; **top used tools**, **top failing tools**, **slow tools**, independently ranked **top projects by model generations** and **top projects by native tool activity** in the same scoped range; compact observational diagnostics.
- [x] Universal scope breadcrumb: keyboard accessible, escape-free backtracking via parent crumb, no mistaking global and selected cohorts, no stale model when switching provider; visible project/window constraints.
- [x] Both volume and failure boards have **independent server top-N**, never ranking by errors after truncating to top-volume.
- [x] Project table: producer-linked `projectID` attribution; meaningful name only when available without bootstrap; unattributed observations remain explicit and do not silently assign to a project. Project rows apply the top-level Usage project filter; no project-path guessing.
- [x] Tool profile disclosure: actionable tool rows show outcomes, P50/P95, denominator, coverage, wall time and explicit failure taxonomy; no transcript fetch or per-row fetch.
- [x] Across scopes: optional searchable index, sortable numeric columns, visible denominators, tabular alignment. Global Overview remains independent of profiler loading.

## Visual grammar — borrow from OXP Session Tool Timeline

- Reuse muted timeline bars, hairline separators, quiet tool identity and status, 27–32px dense rows, deterministic duration alignment; collapsed summary → explicit drilldown rather than modal-on-modal.
- One bordered panel per logical section, **no nested bordered cards**; avoid giant KPI blocks, giant blank headers, bright accent colors, decorative charts, duplicate global nav, gradients or sharp corners.
- Context/instrument strip with 10px labels, 11px data; short hierarchy header with clear active scope + parent breadcrumb; responsive overflow for dense tables.
- Show unknown telemetry as `—` with meaning, *not* `0ms` or `0%`. Tool wall is additive and overlapping; provider-internal TTFT not observed.
- Use bounded top-N, capped chart buckets, deferred detail; keep no per-row effects, no implicit instances, no per-row network requests, no provider catalogs on the Usage Performance path.

## Engineering checklist & evidence

- [x] Audit authoritative Usage settlement and NativeToolSettlement schema/indexes; confirm no consumer-side message hydration.
- [x] Extend server Tier-0 aggregate for scoped **native-tool** project ranking with SQL grouping/index plan and bounded payload; test project/provider/model collision and null/unattributed paths.
- [x] Extend the same Tier-0 aggregate for settled **generation/project/model** cross-tab, with token/stream-time coverage, tombstone attribution, explicit unattributed cohort and independent full-sum totals. Project-name collisions do not merge IDs; projects with no native tool calls appear.
- [x] Implement testable pure scope-navigation model and transition invariants, including suppression of stale resource results.
- [x] Build compact provider/model inspectors and integrate project/tool leaders and generation percentiles with no extra lookup.
- [x] OXP external agent inspector built independently; does not assign its activity to an OpenFork provider or model without verified provenance.
- [x] Add focused tests for identity, stale model transitions, provider/model/project filter propagation, independent rankings, telemetry classifications and Tier-0 scalar-only data ownership; note that a complete authenticated middleware no-Instance E2E gate remains outstanding.
- [ ] Typechecks, targeted isolated tests and bounded/EXPLAIN query plans verified; visual E2E awaits real desktop renderer; Core may have unrelated active-checkout typecheck failures.
- [x] Record implemented and outstanding checkpoints in primary ledger with executable evidence; mark unavailable telemetry/truthful limitations.

## Verified 2026-10-11 closeout snapshot

- Main profiler: hierarchical global → provider → model, scoped authorized producer query, stale-snapshot suppression, project and model clickthrough, observed stream/host TTFT and cache samples. Unit navigation regression tests **5/5**.
- OXP: timeline-inspired tool inspector, focusable buckets and expandable tool diagnostics. Dedicated test file **11/11**; worker's OXP suite **95/95**.
- Core Usage query: settled project tool boards (independent volume/failure/time with bounded composition) and generation project/model cohorts including tool-less models. Combined `packages/opencode/src/usage/workload-query.test.ts` **13/13**, including index-plan fixtures; scoped 20K-row tool query **7.6ms** on the test machine. This is **synthetic fixture**, not the user's large live DB.
- Corrected the generation-project time metric: only measured first-token → stream-end intervals count toward generation duration. Missing stream timing remains unmeasured, not substituted with end-to-end duration; 13/13 query tests still pass. Updated HTTP OXP mock to include the new independent `topFailures`/`topTime` fields; the bounded OXP route test passes. The full global HttpApi file has **10 pass, 1 unrelated session-status mock assertion failure** (missing `ses_retry_status`).
- App isolated profiler/OXP tests **19/19**; app `tsgo -b` passed. Server middleware/E2E real DB latency, concurrent overlap-union, calibrated confidence intervals for upstream OXP model estimates, and visual QA remain **open**.
- Whole-package Core tsgo currently fails in the separate `sqlite-scan-ipc-error-recovery-20261011.test.ts` generic-call test; full `packages/opencode` typecheck has multiple existing/in-flight errors across unrelated session, agent, compatibility and HTTP tests. Do **not** conflate this with focused Usage/OXP validation or claim full repository typecheck success.

## Primary negative performance gates

1. Switching global→provider→model triggers **one** bounded authorized workload query per scope change (superseded requests canceled), no request per child provider/model/tool/project row.
2. No implicit `InstanceStore.load`, provider/catalog bootstrap, or transcript hydration on Usage analytics reads.
3. Long ranges avoid exact percentile sorting at unbounded cardinality; suppress with sample-count notice.
4. Project names may only derive from cheap known metadata. Missing project attribution is not an empty project and cannot silently map to current workspace.
5. Date, project and provider/model filters must be reflected in all tool and project totals and rankings; no mixing independently scoped summary values with selected-cohort totals.
