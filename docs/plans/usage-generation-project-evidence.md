# Usage workload: model-generation top-projects backend evidence

Additive, backend-only extension of the settled `GET /usage/workload` projection.
No frontend, no route change, no migration, and no SDK regeneration is required
for the backend contract; the OpenAPI/SDK surface inherits the enlarged response
schema and may be regenerated separately if a client needs the new field.

## Why

The existing `WorkloadSnapshot.projects` board ranks **native tool invocations**
from `native_tool_settlement`. A model that settles generations without emitting
tool calls therefore never appears in any project ranking. `generationProjects`
ranks **settled model calls** (`usage_record`) so tool-less models still surface,
giving the profiler a true per-model top-projects view.

## What changed

`WorkloadSnapshot` gains one new sibling object `generationProjects` alongside
`tools` and `projects`. `projects` and `tools` are untouched. `generationProjects`
reuses the same cohort filter as the generation metrics
(`generationFilter`: completed-at window, optional `providerID`, `modelID`,
`projectID`, with maintenance/compaction exclusions), so its `totals.settlements`
always equals `generation.settlements` for the same request.

## Exact additive response schema

```ts
WorkloadSnapshot.generationProjects: {
  provenance: "producer-settlement" | "unavailable"
  coverage: "recorded-only; historical calls may be missing" | "unavailable"
  totals: GenerationProjectTotals
  unattributed: GenerationProjectTotals
  rows: Array<{
    project: string
    projectName: string | null
    providerID: string
    modelID: string
  } & GenerationProjectTotals>
  totalProjects: number
  omittedProjects: number
}

GenerationProjectTotals: {
  settlements: number            // settled model calls
  generationMs: number           // sum of observable generation duration
  generationRecords: number      // measured denominator for generationMs
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
  tokenRecords: number           // measured denominator: records with a non-zero token total
}
```

- `rows` is bounded to `limit` (default 20, HTTP cap 50). It is a
  `(project, provider, model)` cohort ranked by `settlements` DESC with a
  deterministic binary-collation tiebreak (`project`, then `provider`, then
  `model`). Original `providerID`/`modelID` identity is preserved per row
  (never coalesced to `base_model_id`; a NULL source column surfaces as the
  `"unknown"` sentinel).
- `totals` is an independent full-sum scalar over the whole filtered cohort. It
  is never derived by summing the truncated `rows`, so top-N truncation cannot
  corrupt the sum coverage.
- `unattributed` is an explicit cohort for settlements whose session/project
  attribution could not be resolved (no live `session` row and no
  `usage_session` tombstone). It is reported separately from `rows` so a
  tool-less but fully attributed model never hides behind orphan rows.
- `totalProjects` is the distinct attributed project cardinality;
  `omittedProjects = max(0, totalProjects - distinctProjectsInRows)`. Because a
  project may span multiple `(provider, model)` rows, the truncation gap is
  measured in distinct projects, not rows.
- `generationMs`/`generationRecords` and `tokens`/`tokenRecords` carry explicit
  measured denominators, so consumers can distinguish "no data" from
  "genuinely zero": `generationRecords` counts records with an observable
  generation duration (`streamed_at - first_token_at`) **only when both timestamps are valid**. Do not
  fall back to `completed_at - created_at`: that is an end-to-end interval, not a generation clock.
  `tokenRecords` counts records with a non-zero token total.

## Attribution semantics (reused from Inspection)

`generationProjects` reuses `packages/opencode/src/usage/inspection-query.ts`
project attribution: `COALESCE(session.project_id, usage_session.project_id)`.
The live Session's project wins over its durable `usage_session` tombstone, and
a record with neither is unattributed. Project display names come from
`COALESCE(project.name, usage_session.project_name)`. Attribution joins are
primary-key lookups only (`session.id`, `usage_session.session_id`,
`project.id`), never a per-project N+1, and never a history or `Instance` load.

## Ownership invariants proven by tests

1. **Tool-less models appear.** A cohort with zero `native_tool_settlement` rows
   reports `projects.totals.calls === 0` while `generationProjects` still ranks
   projects by settled calls (`workload-query.test.ts`).
2. **Settled-call ranking, not tool ranking.** `generationProjects` counts
   `usage_record` settlements; it shares no SQL with the tool-count board.
3. **Tombstone + live reassignment.** A deleted Session keeps its
   `usage_session` tombstone attribution; a live reassigned project wins over an
   older tombstone; an orphan record surfaces in `unattributed`.
4. **Name collisions stay distinct.** Two projects sharing a display name remain
   two rows keyed by `project_id`, never merged.
5. **No history hydration / no Instance bootstrap.** The queries touch only
   `usage_record` scalar columns plus `session`/`usage_session`/`project` primary
   keys. `runWorkload` runs in the existing process-global `readLease` with no
   `Location`, `Instance`, or catalog dependency. The reader fixture exposes only
   `all`/`get`, so a history or instance dependency cannot be expressed.
6. **Independent top-N and sum coverage.** `totals.settlements` equals
   `generation.settlements` regardless of `limit`; `omittedProjects` reports the
   distinct-project truncation gap exactly.
7. **Index-bounded.** `EXPLAIN QUERY PLAN` confirms the aggregation seeks
   `usage_record_model_completed_idx` for the provider/model drilldown path. No
   new index or migration is introduced: attribution is by session primary key,
   and `usage_record` has no project column to index.

## Files touched

- `packages/opencode/src/usage/workload.ts` — additive `generationProjects`
  schema (`GenerationTokens`, `GenerationProjectTotals`).
- `packages/opencode/src/usage/workload-query.ts` — `generationAttributionJoins`,
  `generationProjectTotalsQuery`, `generationProjectUnattributedQuery`,
  `generationProjectRowsQuery`, `generationProjectCountQuery`, and `runWorkload`
  wiring.
- `packages/opencode/src/usage/workload-query.test.ts` — five new regression
  tests plus token columns, `project` table, and `usage_session.project_name`
  added to the shared fixture.

No changes to `packages/core`, routes, migrations, generated clients, or
`packages/app/**`.
