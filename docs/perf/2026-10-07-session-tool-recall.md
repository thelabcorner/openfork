# Exact Session tool recall — ownership and performance audit (2026-10-07)

## Architecture and correctness

Tool identity is produced at V1 `PartUpdated` and V2 `Tool.Called`. It is
materialized into `session_tool_recall` by Core's Session projector; Session
search reads this compact durable projection. No target Session/Instance
bootstrap, message/part JSON hydration, OPCL/CDB dereference, or N-per-session
read is permitted on the normal recall hot path.

The physical sidecar retains a Session FK, with exact-tool identity indexed
separately from bounded input text. SQLite parent-delete triggers from
`20261007192518_session_tool_recall_projection` remove V1 calls on part
deletion and V2 calls on message deletion, including revert and cascading
message removal. Do **not** add parallel projector DELETE statements: that
duplicates database writes and misses non-projector deletion paths. The
sidecar-to-FTS triggers maintain postings on insert, update, and deletion.

Producer V1 updates write the exact-tool sidecar only for actual tool parts
or when the prior bounded search projection indicates a tool-to-non-tool
replacement. Id-preserving republished progress/settlement suppresses
no-op sidecar and FTS writes via the UPSERT `setWhere` predicate.

Historical repair is explicitly bounded and runs on a separate connection
when invoked; search never starts repair and never silently hydrates history.
Incomplete historical coverage remains an explicit result rather than a
claim that a call never happened.

## Search plans

- **Global tool-only:** `(tool,time_created,id)` index, newest first, stop
  after `limit+1` results; no temporary ordering tree expected.
- **Selective directory/workspace/parent tool-only:** drive scoped Session
  rows first, probe `(session_id,tool,time_created,id)` sidecar index.
  The join can sort scoped hits but avoids walking unrelated global calls.
- **Combined tool + text:** drive FTS first using a forced join order and
  verify `tool` with exact relational equality. This avoids probing the
  entire recent call timeline when the searched text is rare.
- **Relevance override:** FTS BM25 (tool field weight zero), not a loose
  textual approximation of tool identity.

Migration `20261007195036_session_tool_recall_scope_indexes` must use
`CREATE INDEX IF NOT EXISTS session_directory_idx`: fresh-schema databases
already have this index. A narrowly enumerated checksum correction supports
the journaled pre-release source without allowing arbitrary source mutation.

## Reproducible synthetic microbenchmark

Run `bun script/bench-session-tool-recall.ts` from `packages/core`.
In-memory SQLite; 50,000 calls, 1,000 sessions, five tool names, 12 warm
timings per query. Figures below are **SQL execution only**, not OXP/tool
round-trip latency, disk I/O, OPCL backfill, or full application time.

| Access path | Mean | Median | p95 |
| --- | ---: | ---: | ---: |
| Global indexed tool-only | 0.0088 ms | 0.0085 ms | 0.0108 ms |
| Narrow directory-scoped tool-only | 0.0749 ms | 0.0744 ms | 0.1065 ms |
| FTS-first tool + common term | 7.7026 ms | 7.5208 ms | 12.1058 ms |
| FTS-first tool + rare term | 0.3978 ms | 0.3908 ms | 0.4445 ms |

The common-term path is the remaining search-cost frontier, not an excuse
to force a global time-index-first FTS probe: that alternative can perform a
large number of negative row probes before finding rare matching text.
Benchmark new access plans under both common and rare terms before adopting.

## Validation / negative invariants

- Core Session recall, projector, sidecar migration and full migration chain:
  55 passed (2026-10-07).
- Exchange, OXP/OFXP supervision, native Session surface: 24 passed.
- `bun script/migration.ts --check`: passed (no schema drift).
- Normal recall returns correct results after wide message payloads are
  overwritten with non-tool JSON (proves the search doesn't re-decode them).
- Deleting the parent V1 part / V2 message removes indexed results without a
  hot-path cleanup scan; V2 revert removes only suffix calls.
- Exact identity prevents marker-like user text from becoming a tool hit.
- Scoped reads apply authorized root filters before results can leave the
  supervision boundary.

Future optimization work should prioritize real database EXPLAIN QUERY PLAN,
total candidate/byte costs, and OPCL cold-history backfill budgets. Do not
optimize by eagerly preloading Session history or expanding the permanent
provider tool schema.