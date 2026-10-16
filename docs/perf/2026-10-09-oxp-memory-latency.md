# OXP memory recall latency — 2026-10-09

Retrieval relevance, historical inclusion, source diversity and later test
evidence are tracked in
`docs/perf/2026-10-09-oxp-memory-recall-fidelity.md`.

## Incident and measured evidence

Users observed OpenFork `remember` lookups appearing stuck for almost a minute and eventually succeeding. Replication across the authorized OXP tool and the local execution graph produced:

| Surface | Operation | Duration | Interpretation |
| --- | --- | ---: | --- |
| OXP live connector, first run | memory search / history | 79.99 s | End-to-end; precise internal stage not then instrumented |
| OXP live connector, second concurrent batch | memory map | 58.83 s | No historical search needed; broad-search fan-out cannot be the only cause |
| OXP live connector, warmed | memory map | 1.55 s | Intermittent, strongly startup/contention-sensitive |
| OXP live connector, warmed | memory search | 2.12 s | Same |
| direct ExchangeMemory.executeRuntime, cold | map | 5,552 ms | AppRuntime + InstanceStore bootstrap + memory |
| direct ExchangeMemory.executeRuntime, warm | memory-only search | 75 ms | Core lookup is not intrinsically slow |
| direct ExchangeMemory.executeRuntime, warm | combined search | 354 ms | Includes bounded indexed historical lookup |
| minimal independent graph, cold | map | 97 ms | DB + ProjectV2 + Memory only, without shared runtime graph |
| minimal independent graph, warm | memory-only search | 7 ms | Same graph |
| minimal independent graph, warm | combined search | 94 ms | Same graph |
| patched ExchangeMemory.executeRuntime, cold | map | 436 ms | Lightweight graph + imports on test process |
| patched ExchangeMemory.executeRuntime, warm | memory-only search | 6 ms | Same |
| patched ExchangeMemory.executeRuntime, warm | combined search | 296 ms | Same |

The **local cold-map reduction is ~92%** (5552 to 436 ms). Figures are observations from individual runs, not controlled p50/p95 latency distributions, and the 59–80 s external outliers are **not fully attributed** without server/transport timing for those requests.

## Root architectural defect

`packages/opencode/src/exchange/memory.ts` routed all memory operations, including cheap durable reads, through `ExchangeRuntimeV1.enter` and `AppRuntime`'s `InstanceStore.provide`. This invokes project instance loading and the config/plugin/tool-reload bootstrap gate, which is explicitly forbidden for Tier-1 durable reads by `packages/opencode/AGENTS.md`.

A memory read only needs an independently authorized canonical root, read-only project identity resolution, `Memory`, and `Database`. Session-history search, when independently authorized, is a bounded, directory-prefixed indexed DB lookup. `ExchangeMemory.execute` remains the single domain owner.

## Fix in source

- `packages/opencode/src/exchange/memory-read-runtime.ts`: narrowly compiled, shared-memoMap `Memory + ProjectV2 + Database` runtime; no InstanceStore/config/plugins. Canonical project scope retained. Read access accounting disabled to prevent background write amplification. Session history remains explicitly independently gated; directory-prefix scope retained.
- `packages/opencode/src/exchange/memory.ts`: dispatches read actions (map, search, open, get, timeline) to lightweight runtime, keeps write actions on canonical V1 executor. Legacy project-ID drift falls back to V1 migration, rather than silently missing memories.
- `packages/opencode/src/oxp/memory.ts`: reports authorization, runtime execution, egress, and total server-side `timingMs`. External end-to-end time minus server total now identifies transport/queue overhead on a slow incident.
- `packages/opencode/test/exchange/memory-runtime.test.ts`: proves reads survive malformed workspace config without bootstrapping that config, preserve session-supervision denial, and reject cancellation. Existing memory security/retrieval tests remain valid.

## Validation

- Real database cold/warm benchmark: patched map 436 ms / saved-only 6 ms / combined 296 ms.
- Existing and new Exchange memory tests: 15 passed, 0 failed.
- Core memory tests, including new security, project-migration and read-purity gates: 25 passed, 0 failed.
- Package-wide TypeScript check reports unrelated preexisting errors outside changed files, so the package is **not typecheck-green**. No memory-path diagnostics surfaced in its output.
- No production server was restarted. The live OXP host can continue running its old bundle until the application's controlled rollout/restart. Do not conflate source correctness with deployment.

## Remaining investigation / acceptance criteria

1. On a host rebuilt from these sources, read `metadata.timingMs` and measure caller-observed latency for at least 50 cold and 100 warm calls, across map/saved-only/both and concurrent load.
2. Compare `total` vs caller wall time: if backend remains under 1 s while caller sees 60 s, investigate broker/proxy/scheduler/connection contention instead of changing SQLite retrieval.
3. Preserve and explicitly report `sessionCoverageComplete=false` until the background session-index backfill finishes. This is result completeness, not the identified cold-bootstrap latency bug.
4. Never bootstrap plugin or session execution state for memory reads, never bypass memory/project authorization, and never automatically broaden permissions to Session supervision. Do not silently treat unavailable/incomplete session evidence as absence.
5. Target warm search p95 under 500 ms and cold read p95 under 1.5 s **inside the host**, with connector latency monitored separately. These are acceptance targets, not measured guarantees.

## Continuation: correctness and tail-latency hardening

### New defects found and corrected

- Timeline retrieval accepted \`projectID\`/\`workspaceID\` but did not filter its seed, stable-key lookup, supersession hop, or final result by those IDs. Unauthorized cross-project history retrieval was possible when an ID/key was known. Every phase now enforces \`global OR same-project OR same-project-and-workspace\` visibility. Stable-key seed selection prefers workspace > project > global.
- Workspace scope filtering previously matched a workspace ID without also verifying its project ID. Search, get, topic lookup, topic listing and timeline now use a consistent project-bound workspace identity.
- Topic-key selection contained an unparenthesized SQL \`OR\` expression: the requested key predicate could apply only to the global branch. The full disjunction is now parenthesized, and the most-specific topic wins deterministically.
- Map/topic calls implicitly inserted default topics on every read; opening a topic persisted a derived projection although it was regenerated every time. Both write paths were removed, and a \`Memory.mapDetails\` projection gets map and topic count from one read. \`total_changes()\` assertions prove repeated map/open requests have no database writes.
- Canonical V1 project-ID migration previously moved Sessions/Workspaces but not Memory. The new transactional Core migration transfers memory entries, topics, and suppression tombstones; colliding topic keys are merged without deleting memory entries or evidence, and repeat migration is idempotent.
- The shared-memoMap Tier-1 reader is now disposed before AppRuntime shutdown to release its SQLite-layer lease. OXP memory responses expose both authorization/runtime/egress timings and lightweight-runtime identity-versus-execution timing.

### Reproducible warm-path benchmark (100 iterations each, same developer database)

Run \`bun run script/bench-memory-runtime.ts <absolute-approved-root> 100\`.

| Operation | p50 | p95 | p99 | Max |
| --- | ---: | ---: | ---: | ---: |
| Memory map | 2.78 ms | 5.89 ms | 300.66 ms | 1309.87 ms |
| Saved-memory only | 2.26 ms | 4.24 ms | 6.55 ms | 7.30 ms |
| Memory + Session evidence | 24.02 ms | 162.36 ms | 1385.79 ms | 1473.66 ms |
| Combined, batches of 10 (batch wall time) | 315.25 ms | 1660.01 ms | 1660.01 ms | 1660.01 ms |

Cold map on that run: 425.26 ms. ChunkDB semantic-prune activity appeared during large outliers, but overlap is not sufficient to prove causality. The historical Session index still reported incomplete coverage: truthful missing-data warnings remain mandatory. These figures are internal execution durations only, not OXP/ChatGPT end-to-end timings or a production SLO certification. The live OXP host has not been reloaded with the changes.

### Validation limitations

- Core: 25/25 tests passed. Exchange: 15/15 passed.
- Core and opencode package-wide \`tsgo --noEmit\` have existing errors outside the changed Memory/runtime/migration paths; checks are not green and must not be reported as such.
- No source-level hot path should enter \`InstanceStore\`, write seed topics, update projections, weaken scope, or silently migrate historical data on a pure read. The rare preexisting V1 project-ID drift fallback still executes canonical migration; it is not an ordinary read path and should be measured separately.
