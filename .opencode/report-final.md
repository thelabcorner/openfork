# opencode 100-Session Scaling Report — FINAL SYNTHESIS

Author: report-writer | swarm: opencode-scale-analysis
Date: 2026-08-17 | Read-only analysis. All file:line refs verified against working tree.
Sources: t1-bottlenecks, t2-session-model, t3-concurrency, t4-algorithm, t5-renderer, t6-storage, t2-regression (v7, complete).

---

## 1. EXECUTIVE SUMMARY

opencode can reach 100+ active sessions with minimal lag, but NOT by adding hardware or threads. The ceiling is a **single shared resource** — one SQLite connection gated by `Semaphore.make(1)` (`packages/core/src/database/sqlite.node.ts:115`) — that every read AND write across all sessions serializes on. This is the **scalar-collapse point**: throughput is empirically CONSTANT (~65 units/sec) at 1 session and at 10 sessions (session-model prototype `contention.ts`); adding sessions only adds queueing latency, never throughput. Four independent lanes (storage, session-model, concurrency, algorithm) converge on this as the #1 lever.

The second wall is the **event pipeline**: every session's events are published to a synchronous global bus, fanned out to every SSE subscriber with a **per-subscriber `JSON.stringify`** (`handlers/event.ts:17`), and funneled through a single SSE stream into the renderer. Measured: at 100 sessions × 200 events/sec, per-subscriber stringify alone burns **~574ms CPU/sec (57% of the event loop)** + 636MB/s serialized (bottleneck-mapper `sse-scale.ts`).

The renderer is NOT a primary bottleneck — it is SolidJS (fine-grained reactivity, not React), already frame-coalesced, virtualized, and worker-offloaded. Its one scaling cliff is the active-session timeline projection rebuilding the whole row model O(M+P) per streamed part change (~5-10ms/frame at M=10k messages).

**The path to 100 sessions is a sequence of low-risk wins first (stringify-once, renderer memoization, per-session coalescing, page-size, yieldNow), then three flag-gated structural changes (incremental transcript reload → DB write batching → read/write semaphore split), and LAST the protocol-layer event/SSE batching.** Every structural change is gated by a feature flag, a rollback, and a specific new test. The single non-negotiable invariant across all of them: **durable prompt admission (`SessionInput.admit`) must stay individually durable and promptly delivered — never batch a user prompt.**

---

## 2. AGGREGATE SCALE MODEL @ N=100

### Per-session vs shared costs

| Cost | Type | Per-session @100 | Shared resource | Dominant? |
|---|---|---|---|---|
| Session coordinator map | per-session | O(1)/session (run-coordinator.ts:24-104) | — | no |
| Per-session pub semaphore | per-session | O(1)/session (llm.ts:228) | — | no |
| History load per turn | per-session | O(history)/session/turn (history.ts:66-80) | **single SQLite permit** | yes (queues) |
| Promote / hasPending | per-session | O(pending)/session (input.ts:170-288) | single SQLite permit | minor |
| **Durable event txns** | per-session | ~30-40 txns/turn → **~50-70 txns/sec @100** (t6) | **single SQLite permit** | **FIRST WALL** |
| **Projectors in txn** | per-session | O(events × write-cost), full-row UPDATE + FTS (event.ts:320-322, projector.ts:123-133) | single SQLite permit + write lock | yes |
| **SSE fan-out + stringify** | shared | O(sessions × events) = 2M offers @100×200; **574ms CPU/s (57% loop)** (t1) | single event loop | **SECOND WALL** |
| Durable re-read per wake | per-session | O(history)/wake (event.ts:585-604) | single SQLite permit | yes |
| Render — active session | per-session | O(M+P)/tick projection; **5-10ms/frame @M=10k** (t5) | main thread | cliff @ huge |
| Render — background | per-session | ~2-5μs/event × 2000 ev/s ≈ **~10ms/sec** (t5) | main thread | minor |

### Dominant term / the single "first wall"

**The single-permit SQLite semaphore (`sqlite.node.ts:115`) is the first wall.** It is the scalar-collapse point: every durable event commit, every history load, every projector write, every `hasPending` serializes on one permit. Because `node:sqlite DatabaseSync` is SYNCHRONOUS on the single Bun/Node event loop (desktop sidecar = `utilityProcess.fork` of `sidecar.js`, `server.ts:64`), each txn also **blocks the loop** for its duration — measured 2.7ms@1KB / 6.9ms@16KB / 18.7ms@64KB per 50-txn batch (concurrency-coordinator `measure.ts`). Reads queue behind writes; writes queue behind reads. This is the throughput ceiling regardless of session count.

**Co-dominant event-loop term:** the SSE per-subscriber `JSON.stringify` fan-out (57% of the loop at 100 sessions) — the second wall that saturates the loop before the DB convoy becomes the only problem.

---

## 3. RANKED OPTIMIZATION ROADMAP

Ordered by **win/regression-adjusted ratio** (win at 100 sessions ÷ regression risk), using regression-risk-engineer's matrix (t2-regression v7) as the risk authority. Tier 0 = low-risk wins (land anytime, independently); Tier 1 = structural, flag-gated, strictly sequential; Tier 2 = protocol-layer, flag-gated, LAST.

### TIER 0 — QUICK WINS (low risk, land immediately, independently)

| # | Problem | file:line | Current O()/cost | Proposed O()/cost | Win @100 | Risk | Gating/Rollback |
|---|---|---|---|---|---|---|---|
| Q1 | SSE per-subscriber JSON.stringify | handlers/event.ts:17 | O(subs × events) stringify; 574ms CPU/s (57% loop) | stringify ONCE, broadcast the string | **~50-100×** fan-out CPU (574→~6ms) | LOW | wire-invariant; httpapi-event.test.ts pins framing |
| Q2 | Active-session timeline projection rebuild | projection.ts:34-44 → rows.ts:38-101 | O(M+P)/tick; 5-10ms/frame @M=10k | memoize per-turn; only active turn recomputes | **~50-100×** on huge sessions | LOW | renderer-only; add projection-equivalence test |
| Q3 | Adjacent-only delta coalescing | server-sdk.tsx:79-139 | store write per event under interleaving | per-session coalescing across frame (flush()) | **~10×** fewer store updates | LOW | preserve per-session delta order |
| Q4 | Client part.delta string accumulation | app/event-reducer.ts:364-388 | O(L²) | buffer chunks, join at render | O(L) on long streams | LOW | add delta-ordering test |
| Q5 | MessageV2.stream page size | message-v2.ts:469-490 | O(M/50) round-trips | larger page (500) or single JOIN | **~10×** fewer round-trips | LOW | messages-pagination.test.ts pins order |
| Q6 | No yield in LLM stream publisher | llm.ts:232-275 | burst starves timers/IO | `Effect.yieldNow` between events | loop yields under burst | LOW | test/session/llm.test.ts |
| Q7 | trimSessions / cleanupDroppedSessionCaches | app/session-trim.ts:33-57, event-reducer.ts:80-107 | O(N log N + R²) / O(total parts) per event | incremental insert + Set dedupe | ~10× on session events | LOW | client cache eviction |
| Q8 | filterCompacted constant-factor | message-v2.ts:521-572 | multiple O(M) passes + spreads | single forward pass | ~3-4× fewer allocs | LOW | filterCompacted suite pins output |
| Q9 | Map-vs-array swaps (wire-invariant) | SDK types / hot paths | array iteration | internal Map/Set | constant-factor | MED | wire shape MUST stay; add order-preserved test |
| Q10 | fs watcher dedupe | watcher.ts:94-127, reload.ts:310-338 | 200+ native subs + 100×2s poll loops | share 1 watcher/dir; dedupe ToolReload | 2× handles, 100× poll CPU | MED | native lifecycle; add no-missed-change test |
| Q11 | Periodic WAL checkpoint | database.ts:35 | only `wal_checkpoint(PASSIVE)` at startup; WAL grows unbounded | scheduled `wal_checkpoint(TRUNCATE)` on threshold/idle timer | bounds WAL growth + startup replay cost | LOW | no API/DB-schema change; pairs with S2 (batching reduces WAL write frequency) |

### TIER 1 — STRUCTURAL (flag-gated, strictly sequential — do NOT stack unproven)

| # | Problem | file:line | Current O()/cost | Proposed O()/cost | Win @100 | Risk | Gating/Rollback |
|---|---|---|---|---|---|---|---|
| S1 | Per-step full transcript reload + reconvert | prompt.ts:1282,1464 | O(S·M/50) round-trips + O(S·(M+P)) CPU; ~10k round-trips/prompt | incremental: load tail since last step, cache converted msgs | **removes ~10k round-trips + O(S·P) reconvert/prompt** | MED-HIGH | **flag default-OFF**; equivalence test (incremental==full) is ACCEPTANCE CRITERION; invalidate on compaction/revert/removal |
| S2 | DB write batching (chunk-sealer pattern) | event.ts:239,320-322 | 1 durable event = 1 txn; ~50-70 txns/sec | 1-2 txns/turn; keep short-tx + yield-between invariant | **~10-20× fewer txns** | HIGH | **flag `DB_WRITE_BATCH` default-OFF**; admission stays individually durable; add read-after-write test |
| S3 | Read/write semaphore split | sqlite.node.ts:115 | reads+writes share 1 permit | separate read path / 2nd read connection (same PRAGMAs) | **#1 latency lever** — removes history-load + re-read from write convoy | HIGH | **own flag default-OFF**; split at client boundary; read-after-write test; land AFTER S2 proven |

### TIER 2 — PROTOCOL-LAYER (flag-gated, LAST)

| # | Problem | file:line | Current O()/cost | Proposed O()/cost | Win @100 | Risk | Gating/Rollback |
|---|---|---|---|---|---|---|---|
| P1 | Server-side per-session 16ms frame batching + bounded queue | handlers/event.ts:31, event.ts:406-417 | per-event frames; 130.5ms/55,638KB wire @20k | 1 frame/session/tick; bounded dropping queue | **~1300× fewer frames, ~1350× less wire** | HIGH | **flag default-OFF**; NEVER-DROP list; admission promptly delivered |
| P2 | Event-bus notify() fan-out routing | event.ts:406-417 | O(listeners) per event | route by directory/session at subscribe | O(sessions×events)→O(events) | MODERATE | advisory-only; tie to P1 |
| P3 | IPC coalescing (desktop main↔renderer) | packages/desktop | per-event IPC | batch/debounce advisory frames | ~10× | MED-HIGH | **flag default-OFF + NEW e2e**; NEVER coalesce user-visible content |
| P4 | Skip non-durable deltas for unmounted sessions | server-sync.tsx:542-652 | process every event for every session | skip part.delta/part.updated for no-subscriber sessions | ~10ms/sec main-thread | MED | **flag default-OFF + e2e**; keep durable message.updated path |

### NEVER-DROP EVENT LIST (any batching/coalescing/filtering)
`message.updated`, `part.updated`, `session.created`, `permission.asked`, `question.asked` — dropping any is a silent regression. Only **intermediate deltas** may be dropped (re-derivable from the durable log).

---

## 4. QUICK WINS vs STRUCTURAL

**Quick wins (Tier 0, ~1-2 days each, no flag, low risk):** Q1 stringify-once (57% loop → ~6ms), Q2 renderer projection memoization (50-100× on huge sessions), Q3 per-session coalescing (10×), Q4 delta buffering, Q5 page size, Q6 yieldNow, Q7 client recompute, Q8 filterCompacted, Q10 watcher dedupe. These alone remove most of the event-loop saturation and the render cliff with near-zero regression risk.

**Structural (Tier 1, flag-gated, sequential, the real 100-session unlock):** S1 incremental transcript (removes ~10k round-trips/prompt), S2 DB write batching (10-20× fewer txns), S3 read/write split (#1 latency lever). These attack the scalar-collapse point itself. They must land in order S1→S2→S3 and never be stacked unproven.

**Protocol-layer (Tier 2, LAST):** P1-P4 event/SSE batching + fan-out + IPC coalescing. Widest blast radius (SSE framing, event manifest, SDK surface); only worth it after the DB convoy is relieved, else the batched events just queue on the same permit.

---

## 5. MICROPROTOTYPE EVIDENCE

| Prototype | Lane | Result |
|---|---|---|
| `scale-proto-session/contention.ts` | session-model | Throughput CONSTANT ~65 units/sec at 1 AND 10 sessions — convoy proven; adding sessions adds only latency |
| `scale-proto-bottleneck/sse-fanout.ts` | bottleneck-mapper | 200 events × {1,10,50,100} subs → {0.3,1.2,3.3,5.5}ms stringify+offer — linear in subs |
| `scale-proto-bottleneck/sse-scale.ts` | bottleneck-mapper | 20k evt/s × 100 subs = 574ms CPU/s (57% loop) + 636MB/s — THE T1.1 datapoint |
| `scale-proto-bottleneck/home-index.ts` | bottleneck-mapper | 100 evt/flush × 60 = 0.07ms/flush — home-session-index VALIDATED non-issue |
| `scale-proto-concurrency/measure.ts` | concurrency-coordinator | 50 durable-event txns = 2.7ms@1KB / 6.9ms@16KB / 18.7ms@64KB — synchronous SQLite blocks loop |
| `scale-proto-concurrency/coalesce.ts` | concurrency-coordinator | 20k evt/s: per-event frames 130.5ms/55,638KB vs batched 0.1ms/41KB — ~1300× fewer frames, ~1350× less wire |

---

## 6. OPEN QUESTIONS / NEEDS A REAL BENCHMARK

1. **Real-DB benchmark before S2/S3 default-on.** All convoy numbers are from in-memory prototypes. Need a real `opencode.db` (WAL + FTS trigger + real contention) at 100 sessions to confirm the ~65 units/sec ceiling and the write-amplification cost before flipping `DB_WRITE_BATCH` / read-write-split flags.
2. **Desktop e2e suite does not exist** (`packages/desktop/test` absent). P3 (IPC coalescing) and P4 (unmounted-session filtering) cannot be regression-tested without building it. This is the highest-uncertainty surface.
3. **First-token latency budget.** Server-side 16ms frame batching adds up to 16ms to first-token visibility. Is that acceptable for the product? (Acceptable for text; NOT for durable prompt admission.)
4. **SSE client count.** The O(sessions × events) fan-out and stringify cost scale with the NUMBER OF SSE SUBSCRIBERS, not sessions. Is the target 1 renderer (current) or many (multiple windows/tabs/TUI+desktop+web)? If many, Q1/P2 become the top priority.
5. **`structuredClone` per part update** (`session.ts:645`) — flagged by concurrency-coordinator but not quantified. Needs a benchmark to confirm it's a real cost at 100 sessions.
6. **WAL growth / checkpoint.** No periodic checkpoint (only PASSIVE at startup) → unbounded WAL growth on long runs. Needs a real-run measurement of startup replay cost.
7. **Incremental-transcript equivalence gate.** S1's acceptance criterion (incremental view == full-reload view across compaction/revert/removal/fork-remap) must be written and green BEFORE S1 ships. This is the gate, not a nice-to-have.

---

## APPENDIX — Cross-cutting safety (from regression-risk-engineer v7)
- Test guard: `bun test` in packages/opencode + packages/core + `bun typecheck` in packages/opencode (never from repo root).
- Feature-flag pattern: `Flag.*` (core/flag/flag.ts) with original-restore in afterEach.
- SDK/Protocol discipline: ANY Protocol/HttpApi change → `bun run generate` in packages/client; v1 gen frozen since #5216.
- Migrations: additive DDL + transactional apply; never mutate applied 2026* migrations.
- Rollback boundary: never commit a scaling change that mutates durable-event seq semantics (event.ts / chunk-sealer.ts) without a flag + seq-ordering tests green.
- 9 test gaps to close before landing (read-after-write, IPC e2e, order-preserved swap, delta-ordering, incremental==full equivalence, projection-equivalence, mounted-session durable e2e, NEVER-DROP survives batching, watcher-dedupe no-missed-change).
