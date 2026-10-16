# Usage cohort backend evidence — project drilldown on `/usage/workload`

Date: 2026-10-11. Status: backend implemented, isolated tests and lint green; package
typecheck clean for the touched files (repo-wide run still carries unrelated in-flight
failures). Scope: Tier-0 settled analytics for global/provider/model drilldown, with the
project boards as the primary deliverable.

This document is evidence for the backend slice only. UI work is owned by a separate
change; `docs/plans/usage-oxp-workload-intelligence-ledger.md` and the provider/model
drilldown ledger remain the frontend-owned ledgers.

## Files touched

- `packages/opencode/src/usage/workload.ts` — `projects` tool row extended
  (`projectName`, `topTools`) and `projects.quantiles` / `topFailingRows` /
  `topSlowRows` added. `generationProjects` (parallel generation-project slice) already
  present in this file and left semantically unchanged.
- `packages/opencode/src/usage/workload-query.ts` — new persisted-table aggregates
  (`projectFailingRowsQuery`, `projectSlowRowsQuery`, `projectToolRowsQuery`,
  `projectDurationQuery`, `projectNamesQuery`) plus assembly in `runWorkload`.
- `packages/opencode/src/usage/workload-query.test.ts` — focused tests for the new
  boards, names, composition, coverage and query plans; existing contract tests updated
  for the additive row shape.
- Usage-service test stubs repaired for the enlarged contract:
  `test/server/httpapi-tier0-ownership.test.ts` (full Tier-0 workload mock + response
  cast), `test/server/project-copy-route.test.ts`, `test/tool/quota-usage.test.ts`.

## Response contract — `projects`

All new fields are additive; every pre-existing field and the request shape are
unchanged, so older clients that ignore unknown keys keep working.

| Field | Meaning |
| --- | --- |
| `provenance` | `"producer-settlement"` when `native_tool_settlement` exists; `"unavailable"` on databases that predate it. |
| `coverage` | Explicit `recorded-only; historical calls may be missing` limitation. |
| `quantiles` | `exact` / `suppressed-large-cohort` / `unavailable`; gates every per-project and per-tool percentile in this section. |
| `totals` | Independent full-cohort tool totals (same vocabulary as `tools.totals`), never derived from the top-N rows. |
| `rows` | Top projects by tool call volume (`calls DESC`, binary `project` tiebreak), sliced to the request `limit`. |
| `topFailingRows` | Independent leaderboard: projects with `error > 0` ranked by `error DESC`, `calls DESC`, `sum_ms DESC`. A low-volume failing project stays visible even when it is absent from `rows`. |
| `topSlowRows` | Independent leaderboard ranked by measured tool wall time (`sum_ms DESC`). |
| `totalProjects` | Distinct project cardinality over the whole filtered cohort, independent of truncation. |
| `omittedProjects` | `totalProjects - rows.length`. |

Each row (`ProjectToolRow`, shared by all three boards):

- `project` — the settlement row's own producer-stamped `project_id`. A NULL recorded
  project surfaces as the honest sentinel `"unknown"`; it is never replaced by a
  session/project join.
- `projectName` — display name from cheap durable metadata only: the live `project`
  row name wins, otherwise the deterministic maximum of retained `usage_session`
  tombstone names. `null` when no name is known; no path resolution and no workspace
  state is loaded.
- Tool outcome counters — `calls`, `success`, `error`, `abort`, `denied`, `timeout`,
  `unknown`. Failure denominators treat only `error` as a failure; abort/denial/timeout
  stay separate classes.
- `duration` — `samples` is the measured timing coverage (`started_at` present and
  `completed_at >= started_at`); `calls - samples` counts invocations whose clock was
  missing or invalid. `sumMs` is exact; `p50Ms`/`p95Ms` are exact nearest-rank when the
  whole tool cohort is at most 10,000 measured rows, otherwise `null` under
  `quantiles: "suppressed-large-cohort"`.
- `topTools` — bounded tool composition inside the project (at most 5), ranked by
  calls with `sum_ms`/tool tiebreaks, each carrying the same outcome counters and
  per-(project, tool) percentiles. This is the substantive tool/project relationship
  the drilldown consumes without per-row fetches.

Bounds: every board is sliced in SQL to the validated request `limit` (1–50, default
20); `topTools` is fixed at 5 per project. Worst case is 3 boards × `limit` project rows
plus `limit` project rows × 5 tools, so the payload is bounded independently of project
width and tool cardinality.

## `generationProjects` (parallel slice, same response)

The same response also carries `generationProjects` (settled model calls per
project/provider/model, ranked by settlements, with `generationMs`/token totals,
`generationRecords`/`tokenRecords` measured denominators, and an explicit
`unattributed` cohort). It was implemented by the concurrent generation-projects slice
and is not modified here; its semantics and tests live in the same files
(`workload.ts`, `workload-query.ts`, `workload-query.test.ts`).

## Attribution observations (verified by tests)

- **Tool rows are settlement-attributed.** A project later reassigned or deleted keeps
  its settlement-time project (`native_tool_settlement.project_id`), so history is not
  rewritten by later metadata. Test: “top projects rank by call volume using
  producer-attributed project_id…” including a `bySessionProject` case proving a
  session-scoped project with no matching settlements is an empty cohort, not a
  fallback to session joins.
- **Generation rows are session-attributed.** `generationProjects` resolves the live
  Session project first, then the `usage_session` tombstone, and counts records with
  neither as `unattributed`. The two rules are intentionally different because
  `usage_record` has no producer-stamped project column; the divergence is explicit in
  the response, not hidden.
- Missing tool attribution is explicit (`"unknown"` sentinel row) and still carries
  names (null) and composition.

## Efficiency / query-plan evidence

- The new project aggregates are scalar `GROUP BY` queries over
  `native_tool_settlement`, scoped by the same `since/until`, `provider_id`,
  `model_id`, `project_id` predicates as the rest of the endpoint.
- Tests assert `EXPLAIN QUERY PLAN` uses
  `native_tool_settlement_provider_model_completed_idx` for the scoped project boards
  and composition query, and that none of the new SQL contains `message`, `part`, or
  `json_extract` (no transcript hydration).
- Percentile queries run only when the cohort is within the existing exact-quantile
  cap (10,000 measured rows); large cohorts keep exact counts/sums and suppress
  sorting.
- Observed synthetic benchmark (20,000 tool settlements, in-memory fixture):
  `workload 20k rows: 6.0ms; plan: SEARCH t USING INDEX
  native_tool_settlement_provider_model_completed_idx (provider_id=? AND model_id=?
  AND completed_at>? AND completed_at<?)`. This is a fixture benchmark, not a live
  large-database measurement.
- No new database index was added. The project-scoped tool filter still rides the
  completed-time range index and filters `project_id` per row; adding a
  `(project_id, completed_at)` index is a possible follow-up if real project-scoped
  latency degrades. Raw project attribution uses per-row primary-key lookups only over
  the already range-bounded cohort.

## Checks run

- `bun test src/usage/workload-query.test.ts` (packages/opencode): **13 pass, 0 fail,
  102 expect() calls**.
- `bunx oxlint` on the three workload files: **0 errors** (warnings only, pre-existing
  fixture assertion patterns).
- `bun run typecheck` (packages/opencode, tsgo): the touched workload files are clean.
  The repo-wide run still reports unrelated in-flight failures in other files
  (`test/compat/*`, `test/server/httpapi-session.test.ts`, `test/session/*`,
  `test/swarm/runtime-graph.test.ts`, etc.); the workload-specific Usage stubs were
  repaired here.
- A schema round-trip (`Schema.decodeUnknownSync(WorkloadSnapshot)`) is asserted in
  tests so the HTTP encoder contract cannot drift from the produced object.

## Findings / notes for the frontend change

- Response additions are additive; old fields are byte-compatible in shape.
- `projects.rows`, `projects.topFailingRows`, `projects.topSlowRows` share one row
  type; only the ranking differs.
- Percentile nullability must be read together with `projects.quantiles`; `null` never
  means `0ms`.
- The OpenAPI/SDK generated client was **not** regenerated in this slice; regenerate
  `packages/sdk/js` when wiring UI types so `projects`/`generationProjects` appear in
  the unified client.
- A percentile-merge defect was caught by the new tests (a project percentile was
  taken from a single pair row and could be nulled by an unrelated tool); fixed by
  merging the per-project p50/p95 carried by whichever `(project, tool)` row owns the
  ranked sample.
