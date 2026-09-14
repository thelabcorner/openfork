# Concurrent Session Contention Scout Audit

Date: 2026-09-13

Scope: `/webstormprojects/opencode`

Mode: **historical scout baseline + successor implementation closeout**. The scout-only constraints recorded later in this document describe the original evidence-gathering phase. They no longer describe the current tree. The successor pass was explicitly authorized to patch production source/tests/migrations while preserving unrelated dirty worktree state.

## Closeout: authoritative post-remediation state

The original ranked findings were real, but the current dirty worktree no longer has the architecture described by the historical candidate table below. The successor pass re-simulated each causal chain, patched the shared coupling rather than merely shaving local CPU, and then re-ran adversarial benchmarks/tests.

The central result is that **session-local pathological work can still be expensive, but it no longer owns the scarce shared resource for the full duration**. Large history is paid once per active runner projection rather than every turn. Large durable payloads are cooperatively staged before a tiny semantic transaction. High-rate scoped events are routed before foreign callbacks. Renderer control events do not rebuild history. Waiting shell commands no longer consume compiler/test permits. Background session cache retention is bounded by approximate bytes as well as count. The final closing pass extended that proof through the real Chromium renderer, Project Explorer, Context, tab previews, reconnect/hidden behavior, and Changes/VCS.

| original rank | finding | post-remediation architecture | measured / verified result | residual risk |
| ---: | --- | --- | --- | --- |
| 1 | Runner history rebuilt before every provider dispatch | Active runner owns an incremental, sequence-aware history projection. It snapshots once, buffers commits across the snapshot frontier, then updates from aggregate-local durable events. | Latest 5k rerun: **142.79 ms cold**, **136.54 ms reload-class work**, **7.72 us warm**, max event-loop lag **15.59 ms**. | First activation after a cold cache still has O(history) work; it is no longer paid on every turn. |
| 2 | Watcher burst × process-global EventV2 listener fan-out | EventV2 has type+location and aggregate-scoped registries, so foreign-location callbacks are not invoked. Watcher drains in bounded chunks and yields between chunks. | Scoped-routing, defective-listener, durable handoff, saturation, and watcher/index regression suites pass. | A single location can still legitimately generate substantial local watcher work. |
| 3 | Control/no-op V2 events cloned/reconciled full renderer history | Reducer has explicit unchanged/incremental/structural semantics; `projectV2()` returns immediately for unchanged message projection and uses one-slot incremental updates where possible. | Control-event + delta benchmark is approximately **1.18 / 1.00 / 0.91 / 0.80 us per pair** at 100 / 1k / 5k / 10k messages, versus the scout baseline ~25.8 us / 126.7 us / 1.23 ms / 2.47 ms. | True structural replacements still reconcile by design. |
| 4 | Jumbo Tool.Success rewrote accumulated assistant + jumbo event under global writer | Mutable assistant keeps only small tool overlay pointers. Durable jumbo event JSON is content-addressed and staged in <=256 Ki-character independently committed chunks with scheduler yields; final semantic event stores a tiny reference. A tiny metadata row refcounts committed payloads; old zero-ref crash residue is startup-reclaimed after a grace period. | Latest adversarial probe: Session A 8 MiB total **60.08 ms**, Session B tiny durable event **1.63 ms**, A final semantic writer **1.63 ms**. Four 6 MiB settlements leave mutable assistant 299 -> 902 B rather than accumulating 24 MiB. | Session A still performs O(payload) staging/JSON work; fairness is achieved by bounded ownership and cooperative slices, not by making bytes free. |
| 5 | Lifecycle events invalidated stream index, forcing next delta rebuild | Stream index survives control/no-op events and is invalidated only by structural changes; hot deltas use indexed one-slot updates. | Same interleaved benchmark above is flat with history size; dedicated reducer tests verify control events preserve the hot index. | Structural/hydration replacement must still rebuild indexes. |
| 6 | Worker decompression completions burst JSON.parse on main thread | Worker raw completions enter a byte-accounted parse queue. At most one completed jumbo JSON body is parsed per Bun timer turn; completed raw bytes remain charged to admission until settlement. | Latest 4 x 16 MiB cold completion benchmark: **101.40 ms total**, worst event-loop gap **22.73 ms**, 8 timer opportunities. Historical pre-fix was ~36.6 ms and an earlier post-fix run was ~20.6 ms. | One individual JSON.parse remains synchronous and indivisible; very large single objects can still consume a ~10-20+ ms turn. |
| 7 | Every foreground shell shared the 2-slot heavy-process budget | Shell admission is resource-classed. Simple known network/wait/log commands use a separate bounded I/O pool; builds/tests/typechecks/unknown/compound commands fail conservative into the heavy pool. | Shell concurrency suite **11/11**. A waiting I/O command starts while a one-permit heavy pool is occupied. Default I/O pool on 24 logical CPUs is 6, hard-capped at 12. | Classification intentionally prefers false-heavy over false-light; unknown I/O commands can still queue behind heavy work. |
| 8 | Renderer cache count-bounded but not byte-bounded | Background cache LRU is now bounded by both 40 sessions and an approximate **128 MiB retained-byte budget**. Inline strings are charged as UTF-16, so base64 media is intentionally expensive. Active/pinned/inflight sessions remain protected. | Cache tests **5/5**; a synthetic 6 MiB data URI is charged >12 MiB. Full server-session/reducer target suite **95/95**. | Protected active sessions may exceed the byte target by design; byte estimation occurs at background/cache lifecycle boundaries, not token rate. |
| 9 | Session-context live path wrote state, then durable projector wrote it again | `applyOps()` / fork-origin APIs now publish once; the durable projector is the single authoritative operational writer for live and replay. Missing tool collapse/restore projector cases were added, and the projector is a Session service dependency. | Conversation-control tests **4/4**. Duplicate ops/state writes on the global writer are removed. | No known contention residual in this path. |

Additional validation at closeout:

- Core contention suite: **85/85 passing** across EventV2, decompression pool, SessionProjector, active runner history, tool-event publication, and durable tool progress.
- Additional contention-boundary sweep: **22/22 passing** across event coalescing, saturation, byte-bounded subscriber queues, independent read-DB isolation, and runner snapshot overlap. The saturation probe reported publish p50 2 ms / p99 6 ms and a 6x2 MiB durable-boundary loop max gap of 17.5 ms.
- Core migration generator consistency: `bun run migration --check` passes after the tool-overlay, staged-payload, and payload-metadata migrations.
- App session/cache/reducer targets: **100/100 passing** total across the 5 cache tests plus 95 server-session/reducer tests.
- OpenCode targets: shell concurrency **11/11**, conversation-control **4/4**.
- Filesystem index/watcher-consumer regression suite: **11/11 passing**. The in-memory fixture still logs an existing ChunkDB semantic-prune warning because that fixture lacks `ocdb_meta`; it backs off and does not fail the index tests.
- Server replay/backlog capacity tests: **6/6 passing**, including byte-budget separation between replay history and live frames.
- Full package typechecks remain nonzero because this heavily dirty worktree already contains unrelated test/build diagnostics. Full-program filtered output is clean for the contention source files after fixing the one new `event.ts` narrowing diagnostic and branded-ID test assertions.
- The worktree was deliberately not reset, cleaned, stashed, committed, or pushed by this successor pass.

### Final renderer/UI/browser closing pass

The later renderer work materially widened the original server-focused audit. The following results supersede any earlier implication that the campaign ended at the core/server layer:

- **Real Chromium benchmark is now valid only after four harness defects were removed.** (1) `PLAYWRIGHT_SERVER_PORT` accidentally aliased the Vite frontend port. (2) Ambient `NODE_ENV=development` compiled development-only observers into a nominal production build. (3) With production semantics restored, the web entry correctly selected `location.origin`, so the fixture had to persist/register the explicit `127.0.0.1:4096` backend and assert the encoded server route. (4) The mock still answered backend API/SSE traffic on both ports, creating two server contexts/subscribers that destructively shared the fixture's `events.splice(...)` queue. A diagnostic run dequeued all 160 events but visibly stopped at **143/160** for 420 s while rAF stayed frame-clean; this contradiction exposed the duplicate subscriber. The final fixture uses strict backend-port interception, and environment/port guards are **6/6** with a clean E2E TS project.
- **320-turn / 160-delta strict-backend production browser run (1x):** 160/160 delivered, 0 pending, **3.2517 s**, **49.21 deltas/s**, rAF P95 **16.7 ms** / max **16.8 ms**, 0 long tasks, 0 >33 ms frame gaps, 0 blank frames, exact bottom anchor, no timeline/Markdown remount, only 2 global topology projection runs.
- **Strict-backend 4x CPU run:** 160/160, **3.4024 s**, **47.03 deltas/s**, rAF P95 **33.4 ms** / max **66.7 ms**, 14 gaps >33 ms, 2 gaps >50 ms, no Long Task API entries. Direct Markdown work remained bounded (~177 ms effects, ~153 ms block updates, ~75 ms sanitize); direct worker compute ~287 ms.
- **Strict-backend 30x CPU pathological run:** still delivered 160/160 with zero pending and preserved row/Markdown identity, zero blank samples and exact bottom anchoring, but locally saturated the renderer (**283.90 s**; P95 rAF **3.1165 s**, max **7.083 s**, 1068 long tasks totaling ~239.1 s). Direct worker request round-trip accumulated ~**476.3 s** while worker compute was only ~**317.6 ms**, proving the limiting resource was the deliberately starved renderer/main-thread service path rather than worker compute.
- **Timeline topology isolation:** content-only streaming keeps structural row/index projection asleep. The browser run observed only 2 topology projections across the entire 320-turn stream; focused timeline/Find tests remain green.
- **Session Find:** an explicit browser-condition reactive test proves opening Find with no query performs no corpus work and changing one streaming turn reevaluates that turn rather than every historical turn.
- **Project Explorer:** the exact cooperative search loop was extracted into a testable runner and wired back into the component. The latest 50,000-node all-match rerun completed in **17 slices / 281.03 ms total / 13.37 ms worst synchronous slice**; superseding search generations cannot publish stale output. Total wall time varies with host scheduling, while the bounded synchronous slice is the fairness invariant. A 50,000-selection drag case builds the bounded transfer in ~0.95 ms without traversing the full selection.
- **Changes/VCS:** the final audit found a real residual defect. Persistent Git failure could re-arm the reactive dirty effect and automatically retry, and a static placeholder query could not observe cache data populated by on-demand refresh. The final architecture uses a disabled reactive query plus a tested refresh controller: hidden invalidations issue zero Git requests, opening Changes consumes the dirty latch once, an invalidation racing a successful request produces at most one follow-up, and persistent failure is retry-blocked until a new invalidation/visibility transition.
- **Context pane:** closed panes stop at the `active()` gate before reading session message/part stores. Historical analytics snapshot part-array references only on message-metadata boundaries; live token progress subscribes to the active assistant only. Raw history defaults to the newest 200 messages. The latest 5,000-message window operation measured ~0.040 ms; an 8 MiB text body becomes a 24,579-character preview in ~0.174 ms rather than feeding megabytes into Markdown.
- **Tab previews:** the metadata hydration lane is one process/module-global 4-request gate, not four per tab. A 100-request adversarial test observed max concurrency exactly 4. Large groups remain paged at 80 rows.
- **Reconnect/hidden renderer:** replayable reconnect tests remain incremental while explicit repair refetches; hidden/uninterested reconstructible content is discarded before renderer queue work, and byte-pressure repair invalidates only the owning session.
- **Hot-pattern audit:** no desktop/session-ui production path reintroduced growing `startsWith(previousFullText)` checks. Two such checks remain in the separate mobile Markdown implementation and are recorded as outside this desktop concurrent-session campaign. Remaining `getBoundingClientRect()` calls in the desktop session path are attached to explicit Find/hash-scroll/editor/scrollbar interactions rather than a global token-rate timeline scan.

Final focused validation from the closing pass: core contention subset **53/53 / 450 assertions**, EventV2 **55/55**, database migration suite **19/19** plus clean migration-generation check, session-ui components/Markdown **205/205 / 1628 expectations** plus clean typecheck, OpenCode queue/filesystem/shell **24/24**, server replay **6/6** plus clean typecheck, app closeout **31/31 + 30/30** under the appropriate Solid/browser conditions, Context metrics/raw-history **72/72**, performance environment/port/mock guards **8/8** plus clean E2E TS typecheck, and the final strict-backend Chromium benchmark passes at 1x/4x/30x CPU throttle. Full app typecheck remains red with 47 diagnostics confined to unrelated dirty-tree React context-history/context-ledger, oversized SDK inference, old `server-session.test.ts` typing, and chat-sidebar files; the two campaign-attributable `server-sdk.test.ts` narrowing diagnostics were fixed. The complete evidence table and scenario matrix is in `docs/handoff/CLOSEOUT-concurrent-session-contention-2026-09-13.md`.

One noisy but non-failing test-harness issue remains: several in-memory ChunkDB fixtures start semantic pruning without an `ocdb_meta` table, log that error, then back off. Targeted tests still pass. This warning should be cleaned up separately; it does not invalidate the measured concurrency paths above.

Everything below this closeout is retained as the **historical pre-remediation evidence trail**. It explains why the patches were made; it should not be read as a description of current production behavior.

## 0. Historical scout working method and evidence standard

The symptom under investigation is cross-session degradation: one busy or pathological session, or several simultaneously active sessions, cause unrelated sessions and/or the desktop UI to become delayed, clogged, or frozen until the concurrent work subsides.

Candidates are retained only when there is a plausible coupling mechanism such as a process-global lock, shared SQLite writer, event-loop monopolization, machine-wide resource, N-session fan-out, coarse reactive invalidation, shared worker queue, or memory/GC pressure. Findings are labeled **verified**, **measured**, **strongly inferred**, or **speculative**.

Priority scoring follows the existing handoff formula:

`priority = impact*3 + likelihood*3 + evidence*2 + scaling*2 + fixability - risk`

Scores are 0-5 except `risk`, where 5 means a remediation is especially dangerous.

## 1. Historical scout executive conclusion (pre-remediation)

This section is intentionally revised as the scout progresses.

Four measured remaining mechanisms now stand out. The newest **highest-priority server candidate is synchronous runner-history materialization before every provider dispatch**: `SessionHistory.entriesForRunner()` performs an unbounded post-compaction SQLite `.all()` and decodes every projected message on the shared server JS thread. Warm median measurements were ~11.6 ms for 100 messages, ~41.2 ms for 1,000, and ~163.2 ms for 5,000; one 6 MiB assistant row took ~9.35 ms. Every concurrent session turn runs this path before its LLM stream starts, so session A's long history can directly delay session B's provider dispatch and all other server JS work. A second top-tier server candidate is **filesystem-watcher EventV2 fan-out across cached locations**: one native watcher burst can retain up to 4,096 paths, then publishes them one-by-one and yields only after the entire batch. EventV2 live publication walks the process-wide listener array sequentially, while each cached location contributes multiple listeners that filter by location only after invocation. A 4,096-event benchmark with no-op listeners took 55.7 ms at 0 listeners, 78.4 ms at 10, 111.4 ms at 30, and 258.2 ms at 100, before any real listener work. The renderer also contains an **O(history) no-op projection path for lifecycle/control events**: a reducer-only stress benchmark, excluding Solid reconcile itself, rose to ~1.23 ms per rename+delta pair at 5,000 messages and ~2.47 ms at 10,000. Finally, **jumbo Tool.Success content still creates a server-side global SQLite writer convoy** even after the Step-lifecycle sidecar fix: the actual EventV2+SessionProjector path measured 24.62 ms for a supported 6 MiB media result in an in-memory DB. Several attractive global-fanout theories are weaker than they first appear and are recorded below as rejected/deprioritized so they are not rediscovered.

## 2. Historical ranked candidate table (pre-remediation)

| rank | candidate | mechanism | evidence state | impact | likelihood | scaling | fixability | risk | priority |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Every runner turn synchronously materializes and decodes unbounded post-compaction history before provider dispatch | `SessionHistory.entriesForRunner()` uses `.all()` + full row decoding on the shared server JS thread; all sessions do this before LLM streaming | measured | 5 | 4 | 5 | 4 | 3 | 48 |
| 2 | Watcher bursts multiply through the process-wide EventV2 listener array and yield only after the full batch | Up to 4,096 path events are published sequentially; every cached-location listener is invoked before filtering by location | measured | 4 | 4 | 5 | 4 | 2 | 46 |
| 3 | V2 no-op lifecycle events reconcile entire session history | Control/lifecycle events return a cloned unchanged message array; `projectV2` reconciles it before observing `touched=[]` | measured | 5 | 4 | 5 | 5 | 2 | 45 |
| 4 | Jumbo Tool.Success rewrites the whole assistant inside the global durable writer transaction | Native media is intentionally unbounded; success mutates assistant content and rewrites multi-MiB `session_message.data` plus durable event | measured end-to-end | 5 | 3 | 5 | 3 | 4 | 43 |
| 5 | V2 stream-index invalidation under lifecycle interleaving | The same non-whitelisted events delete the positional stream index; the following delta rebuilds message/content maps | measured as part of C1 pair cost | 4 | 4 | 4 | 4 | 2 | 38 |
| 6 | Cold ChunkDB rehydration parses jumbo payloads on the server main thread | Decompression is worker-pooled, but worker completion performs `TextDecoder + JSON.parse` on the event loop; up to four jumbo completions can serialize | measured | 4 | 3 | 4 | 3 | 3 | 37 |
| 7 | All foreground shell commands consume the same 2-slot machine-wide heavy-process budget regardless of actual CPU weight | Two long low-CPU/waiting shell calls can queue shell/test/typecheck/sqlite/SymPy/archive work in every session | verified, active config | 3 | 3 | 4 | 4 | 2 | 36 |
| 8 | Renderer session history cache is count-bounded but not byte-bounded, and active/protected sessions bypass the nominal cap | Up to 40 ordinary caches plus all protected sessions can retain inline multi-MiB tool/media histories and create GC pressure | source-verified, magnitude inferred | 3 | 2 | 4 | 3 | 2 | 30 |
| 9 | Session-context live writes are duplicated by the durable projector | `applyOps` writes ops/state directly, then durable publish replays the same writes inside the global `IMMEDIATE` transaction | verified in source | 4 | 2 | 4 | 4 | 3 | 29 |

The ranking will be re-sorted as evidence accumulates.

## 3. Candidate dossiers - live

### C1. V2 no-op lifecycle events reconcile entire session history

**Mechanism.** Several native V2 events that do not change projected session messages still return `result([...source])` from the reducer. Examples in `packages/app/src/context/server-session-v2-reducer.ts` include `session.next.prompt.admitted` / `session.next.moved` at lines 292-294 and `session.next.retried`, revert lifecycle, paused/resumed/renamed at lines 1056-1063. The reduction therefore owns a newly cloned full history with `touched: []`. `projectV2()` in `packages/app/src/context/server-session.ts:1101-1107` then reads `reduction.messages` and executes `setData("session_message", sessionID, reconcile(messages))` **before** checking `reduction.touched.length === 0`. A metadata-only or state-only event can therefore perform a full Solid history reconcile even though no message changed.

**Trigger.** Rename/move/pause/resume/revert/control traffic, admitted input bookkeeping, certain execution terminal events with no retry state, and any other reducer branch that produces an unchanged full message array with an empty touched set. These events naturally interleave with active streams.

**Scaling law.** At least O(session history) for the reducer clone and index rebuild, plus O(history/reactive graph) for Solid reconcile. Measured reducer-only rename+delta pair cost scales sharply with history size: ~25.8 microseconds at 100 messages, ~126.7 microseconds at 1,000, ~1.23 ms at 5,000, and ~2.47 ms at 10,000. Steady-state deltas stayed ~0.26-1.02 microseconds each. The production cost is higher because the microbenchmark intentionally excludes Solid `reconcile()`.

**Cross-session causal chain.** `packages/app/src/context/server-sync.tsx:672-692` feeds all native events for the server context through the shared renderer's `session.applyV2()`. One long session receiving a lifecycle/control event can monopolize the renderer main thread while reconciling thousands of unrelated historical entries, delaying session B's event reduction and UI paint.

**Evidence.** Verified source mechanism plus measured reducer-only scaling. Benchmark command was a read-only `bun -e` harness against the current dirty worktree. Results: 100 messages = 25.83 us/pair; 1,000 = 126.66 us; 5,000 = 1,231.80 us; 10,000 = 2,465.33 us. Existing steady-state benchmark `packages/app/bench/v2-reducer.bench.mts` measured ~0.54-0.65 us/delta around 150 messages and showed no meaningful history slope in the indexed case.

**Confidence.** Measured.

**Expected severity.** High. The raw reducer cost reaches multi-millisecond territory before Solid reconciliation is counted. A burst across several long active sessions can consume a substantial fraction of a 16 ms frame budget.

**Cheapest reproduction.** Instrument `projectV2()` around the no-touch reduction branch and send repeated `session.next.renamed`/paused/resumed events into 100, 1k, 5k, and 10k message stores. Compare with an early no-touch return before reconcile.

**Likely remediation shape.** Treat `touched.length === 0` reductions as message-projection no-ops unless the reduction explicitly carries a structural replacement. Better still, represent control-only reductions without materializing/cloning `messages` at all. Keep message-structure events explicit.

**Regression risk.** Some apparently metadata-like events may intentionally repair message state or carry structural semantics in future schemas. The fix needs an explicit reduction kind/invariant rather than a broad event-name skip list.

### C2. V2 reducer stream-index invalidation under lifecycle interleaving

**Mechanism.** `createV2SessionReducer()` maintains `indexes: Map<string, StreamIndex>` for token-rate content/tool/compaction updates. At `packages/app/src/context/server-session-v2-reducer.ts:151-183`, every event outside an explicit whitelist executes `indexes.delete(sessionID)`. The hot-path update helpers then have to reconstruct positional information when no index is available. The suspected failure mode is not steady-state token streaming, but real agent traffic where `*.started`, step lifecycle, retries, shell, synthetic/context, or other structural events interleave with deltas and repeatedly destroy the cache.

**Trigger.** Multiple actively streaming sessions with ordinary step/tool/text/reasoning lifecycle events interspersed with deltas, especially sessions with long message histories or assistants containing many content/tool entries.

**Scaling law.** Potentially `O(active sessions * invalidation frequency * history/content size)` on the renderer main thread. Exact rebuild complexity and frequency are still being measured.

**Cross-session causal chain.** All server events for one server context are reduced on the same renderer main thread. Session A forcing repeated full index rebuilds consumes the same frame/task budget needed to process session B and paint the UI.

**Evidence.** Current dirty-worktree source: `packages/app/src/context/server-session-v2-reducer.ts:53-61` owns the index maps; `:151-183` eagerly invalidates on every non-whitelisted event; `packages/app/src/context/server-sync.tsx:672-692` funnels current native events through `session.applyV2()` on the shared renderer listener before returning early for stream deltas.

**Confidence.** Measured as one component of the C1 interleaving benchmark. The benchmark combines full-array cloning, index deletion, and next-delta rebuild; a follow-up can isolate rebuild-only cost, but the scaling law is already confirmed.

**Expected severity.** Provisionally high if index rebuilds are frequent and histories/content are large; otherwise medium.

**Cheapest reproduction.** Drive the reducer with a large synthetic session, then compare pure delta throughput against a sequence that inserts one invalidating lifecycle event every N deltas. Measure both reducer wall time and index rebuild count across history/content sizes.

**Likely remediation shape.** Replace blanket invalidation with event-specific index maintenance or distinguish metadata-only events that cannot change positional structure. Preserve a conservative fallback for true structural changes.

**Regression risk.** A stale positional index can apply deltas to the wrong assistant/content/tool entry, which is worse than a performance regression. Any optimization must prove equivalence across insert/remove/reorder/hydration cases.

### C5. Jumbo Tool.Success rewrites the whole assistant inside the global durable writer transaction

**Mechanism.** Native tool media is intentionally preserved without the 50 KiB textual settlement cap. `ToolOutputStore.bound()` keeps `file` entries verbatim (`packages/core/src/tool-output-store.ts:219-251`), and its regression suite explicitly preserves a 6 MiB base64 data URI (`packages/core/test/tool-output-store.test.ts:95-118`). For local tools, `createLLMEventPublisher()` correctly avoids duplicating the media in a compatibility `result`; `packages/core/test/session-runner-tool-events.test.ts:89-106` asserts the base64 appears exactly once in the durable Tool.Success event. That optimization is real, but one copy is still multi-megabyte. `SessionMessageUpdater` turns the running tool into a completed tool with `structured` and `content` embedded in the assistant (`packages/core/src/session/message-updater.ts:306-328`). The SessionProjector adapter first reads/decodes the existing assistant, Immer produces the changed assistant, `encodeMessage()` schema-encodes the **entire assistant**, and `updateMessage()` rewrites `session_message.data` (`packages/core/src/session/projector.ts:145-186`). All of this projector work executes inside `EventV2.commitDurableEvent()`'s shared `IMMEDIATE` transaction before the durable event row is inserted (`packages/core/src/event.ts:895-1041`). The lifecycle sidecar only fast-paths Step.Streamed/Ended/Failed and therefore does not apply to Tool.Success.

**Trigger.** Any tool completion containing a large native media file, large structured output, or another supported ToolContent payload. The repository explicitly tests/preserves a 6 MiB image data URI. Provider-executed tools can be worse because the compatibility `result` is retained as well (`publish-llm-event.ts:401-410`).

**Scaling law.** O(current assistant serialized size + Tool.Success event payload size), with the large row rewrite and durable event insert performed while SQLite's shared writer slot is held. Assistants with several earlier large tool results compound the cost because every later content mutation re-encodes/replaces the accumulated assistant.

**Cross-session causal chain.** Session A publishes one large tool completion. The durable transaction owns the single SQLite writer while it reads/projects and rewrites the multi-MiB assistant plus event row. Durable publication from session B waits behind that transaction. CPU spent decoding/Immer/schema encoding also runs on the shared server JS thread. After commit, the same jumbo event still has transport/renderer costs.

**Evidence.** Source mechanism is verified, and an end-to-end `EventV2 + SessionProjector` benchmark was run against an isolated `OPENCODE_DB=:memory:` database with sealing disabled so no production DB was touched. Tool.Success publication measured: **1 MiB 7.88 ms; 4 MiB 17.29 ms; 6 MiB 24.62 ms; 8 MiB 27.54 ms**. Projected assistant JSON lengths were ~1.05, 4.19, 6.29, and 8.39 million characters respectively. In-memory SQLite removes much of real storage latency, so these numbers are a conservative CPU/row-work floor rather than a worst case.

**Confidence.** Measured end-to-end in the actual durable/projector path.

**Expected severity.** High when media/large structured outputs occur. A single supported 6 MiB result consumed ~25 ms before real-disk cost, enough to block unrelated durable sessions for longer than a renderer frame. Repeated large tools in one assistant can increase future mutation cost even if the next event itself is small.

**Cheapest reproduction.** Two concurrent sessions against a real temporary WAL DB: session A publishes 1/4/6/8 MiB Tool.Success events while session B loops tiny durable events. Record B's commit p50/p95/p99 and the writer-hold duration for A. Repeat after accumulating two or four large tool results in A's same assistant to expose historical-amplification slope.

**Likely remediation shape.** Do not store multi-megabyte tool bodies inline in the mutable assistant aggregate. Externalize large ToolContent/structured payloads into a content-addressed/blob/value store and keep a bounded typed reference in both the durable Tool.Success event and assistant projection, with lazy materialization only at consumers that need bytes. A narrower content-part projection table could also prevent unrelated assistant content from being rewritten on each tool state transition. Any solution should avoid creating a second independent copy between event storage and assistant projection.

**Regression risk.** High. Tool media must remain available to provider continuation, replay/export, UI rendering, forks, and offline/session-history reads. Externalization must preserve reference lifetime, integrity, and model-context behavior, and provider-executed compatibility results complicate deduplication.

### C6. Watcher bursts multiply through the process-wide EventV2 listener array and yield only after the full batch

**Mechanism.** `packages/core/src/filesystem/watcher.ts` retains up to `MAX_PENDING_UPDATES = 4096` unique path notifications. Its drain copies the current pending set, clears it, then `Effect.forEach`s the whole batch into one `events.publish(file.watcher.updated, ...)` per path and only calls `Effect.yieldNow` after the entire batch (`watcher.ts:113-143`). EventV2 live notifications use one process-wide `listeners` array and, when there are multiple listeners, invoke the snapshot **sequentially** for live events (`packages/core/src/event.ts:1106-1137`). Location-scoped consumers such as `FileIndexWatcher`, `FileSystemSearch`, and `SearchIndexService` each install an EventV2 listener and reject foreign locations only inside that listener. `buildLocationServiceMap()` retains location layers for an idle TTL of 60 minutes (`packages/core/src/location-services.ts:105-150`), so recently-used projects continue contributing listener callbacks even when another project emits the watcher burst.

**Trigger.** Branch switches, package installs, generated output, build steps, refactors, or agents touching hundreds/thousands of files. The watcher source itself explicitly calls out branch switches and package-manager churn as expected burst sources. The effect grows as more location layers have been used and remain cached.

**Scaling law.** Approximately O(watcher paths × process EventV2 listeners) synchronous Effect dispatch, before per-listener real work. Maximum retained watcher batch is 4,096 paths; location consumers are additive. Real listeners also normalize paths, manipulate maps/queues, stat files later, and feed SSE.

**Cross-session causal chain.** Session/project A causes filesystem churn. Its watcher fiber publishes thousands of live events without yielding. Every publish walks callbacks belonging to other cached locations/sessions on the same server runtime. During that long JS task/fiber run, unrelated session event publication, HTTP work, provider stream handling, and heartbeats are delayed. The events then also enter the shared desktop SSE/render path.

**Evidence.** Source mechanism is verified. A read-only isolated EventV2 benchmark published exactly 4,096 `file.watcher.updated` live events against the real current event service with synchronous no-op listeners: **0 listeners 55.73 ms (13.61 us/event); 10 listeners 78.43 ms (19.15 us/event); 30 listeners 111.36 ms (27.19 us/event); 100 listeners 258.20 ms (63.04 us/event)**. These are lower bounds because listener bodies did no filtering or work. The service itself emitted warnings at listener counts 50 and 100, confirming high listener count is already treated as anomalous diagnostically.

**Confidence.** Measured.

**Expected severity.** High during filesystem storms; negligible when the repository is quiet. A 30-listener maximum burst already exceeds 100 ms before actual index/search/SSE work, which is sufficient to make every concurrent session appear stalled.

**Cheapest reproduction.** Keep 5-10 location layers warm, generate a 4,096-file create/change burst in one project, and simultaneously measure another session's tiny live-event publish latency/provider-stream inter-arrival delay. Record EventV2 listener count and watcher batch sizes.

**Likely remediation shape.** Do not represent a native watcher batch as thousands of process-wide generic events. Publish a bounded **batched watcher event** or route watcher updates through a location-keyed subscriber registry so foreign-location callbacks are never invoked. Independently add cooperative yield/chunking inside a large watcher drain, e.g. every 32-128 paths or a small wall-clock budget. Preserve downstream per-path semantics by expanding only inside the matching location consumer where necessary.

**Regression risk.** Medium. Ordering matters for create/change/unlink transitions, and consumers currently assume one path per event. Batch/coalescing must preserve terminal state and git-control handling. Aggressive dropping can make file indexes stale, so the existing stale/re-list repair semantics should remain the correctness fallback.

### C7. All foreground shell commands consume the same 2-slot machine-wide heavy-process budget regardless of actual CPU weight

**Mechanism.** `packages/opencode/src/tool/heavy-process-concurrency.ts` defines one process- and machine-wide admission budget shared by foreground shell, test, typecheck, sqlite subprocess, SymPy, and archive work. The default is 1 permit at <=8 logical CPUs and **2 permits above 8**, capped at 4. `shell-concurrency.ts` deliberately routes every foreground shell execution through this heavy budget, and `shell.ts:692-779` acquires the permit around the entire spawned command lifetime, from spawn until exit/abort/timeout. There is no command classification: a CPU-saturating build and a mostly idle `curl`, `sleep`, `docker logs`, network wait, or long file transfer each occupy one identical heavy permit.

**Trigger.** Two long foreground shell calls are enough under the current default. Once both permits are occupied, every additional foreground shell as well as test/typecheck/sqlite/SymPy/archive work waits for machine-slot admission even if the machine has abundant idle CPU.

**Scaling law.** Hard queue at `permits`, not gradual degradation. With P=2, the third and later heavy-classified operation waits for one of two existing operations to finish. The machine-wide Flock layer extends this across multiple OpenCode processes/hosts, so another host can consume the same slots too.

**Cross-session causal chain.** Session A and B each launch a long low-CPU foreground shell command. Session C invokes a short shell/test/typecheck action and blocks before its child process starts. The tool has already entered its execution lifecycle, so to the agent/user it can look like the session or tool is stuck even though the server/renderer remain healthy. This is a **tool-level concurrency clog**, distinct from the UI/event-loop stalls above.

**Evidence.** Verified source plus active configuration measurement. Current process reports `availableParallelism() = 24`, no override environment variable, and `configuredHeavyProcessPermits() = 2`. `withShellSlot` is applied around the entire foreground shell process lifetime. The shared budget is also used by TestTool (`test.ts:263+`), typecheck (`typecheck-scope.ts:274+,344+`), sqlite subprocess, SymPy and archive operations. Background long-lived processes use a separate three-slot budget, which is good and prevents them from permanently occupying foreground slots.

**Confidence.** Verified.

**Expected severity.** Medium overall, high for agents that use long foreground shell calls. It does not freeze the renderer or provider streams by itself, but it can make multiple concurrent coding sessions appear to stop progressing at tools.

**Cheapest reproduction.** Start two foreground `shell` calls that wait for 30 seconds with negligible CPU, then issue a trivial third shell or scoped typecheck from another session. Measure admission delay versus CPU utilization. Repeat with one/two actual CPU-heavy builds to validate that the limiter remains useful for its intended class.

**Likely remediation shape.** Split shell admission by resource class. Preserve the conservative heavy-process budget for compilers/tests/builds, but classify known waiting/I/O commands into a larger bounded I/O-process pool, with an explicit opt-in/override for ambiguous commands. At minimum, expose `queued for machine heavy slot` as tool progress/metadata so intentional admission control is not indistinguishable from a dead tool.

**Regression risk.** Medium. Misclassifying a build/test command as light can recreate the original CPU-starvation failure this guard was designed to prevent. Classification must fail conservative and maintain a global ceiling.

### C8. Renderer session history cache is count-bounded but not byte-bounded, and active/protected sessions bypass the nominal cap

**Mechanism.** `packages/app/src/context/global-sync/session-cache.ts` limits visited session caches to `SESSION_CACHE_LIMIT = 40`, but eviction is based only on session identity, not retained bytes. `createServerSession()` also protects pinned sessions, requests/inflight loads, optimistic state, sessions with pending permission/questions, and **every non-idle session** from eviction (`packages/app/src/context/server-session.ts:565-587`). Therefore 40 is not a hard upper bound when many agents are simultaneously active. ToolOutputStore and session projection explicitly support inline 6+ MiB media, so one cached session can outweigh many normal sessions while costing the same one cache slot.

**Trigger.** Visiting/activating many sessions with large histories, especially sessions containing image/media tool output, while several remain running/busy and thus protected. Repeated switching can also retain up to 40 ordinary histories even after they become inactive.

**Scaling law.** O(sum of cached history bytes), not O(session count). Nominal retention can reach hundreds of MiB with only a few dozen 6-8 MiB tool outputs, before Solid proxy/object overhead and duplicate normalized views. Protected active sessions can push beyond the 40-session count.

**Cross-session causal chain.** Large histories remain strongly reachable in the renderer store. Increasing heap size raises GC frequency/pause duration and can make unrelated session rendering/event reduction hitch even though those sessions are not touching the large objects. This mechanism compounds C5: the same inline media that makes server projection expensive also raises renderer-retention cost once that session is hydrated.

**Evidence.** Source-verified retention policy plus verified support for 6 MiB native media. `dropSessionCaches()` is otherwise well-optimized and targeted; the concern is specifically absence of a byte budget and the protected-session bypass. No heap-profile measurement has yet confirmed that this is a dominant current stall source.

**Confidence.** Strongly inferred, not yet measured end-to-end.

**Expected severity.** Medium when users keep many media-heavy sessions warm; low for text-only histories. More likely to explain progressive degradation over time than an immediate two-session stall.

**Cheapest reproduction.** Hydrate 10/20/40 sessions each containing a distinct 6 MiB media result, force several to busy/protected status, and record renderer heap, GC long tasks, and event-reducer p99 while switching an unrelated small session.

**Likely remediation shape.** Add approximate retained-byte accounting alongside session-count LRU, with much smaller budgets for background/inactive histories and explicit protection policy for only the minimal state required by active background sessions. Inline media externalization from C5 would also reduce this substantially.

**Regression risk.** Low-to-medium if eviction continues to use authoritative hydration repair. Do not evict permissions/questions/optimistic state needed for interaction, and avoid byte estimation that recursively scans jumbo payloads on every token.

### C9. Every runner turn synchronously materializes and decodes unbounded post-compaction history before provider dispatch

**Mechanism.** `packages/core/src/session/runner/llm.ts:195-254` calls `SessionHistory.entriesForRunner(readDb, session.id, baselineSeq)` on every turn attempt before building the LLM request and before `llm.stream(request)`. `packages/core/src/session/history.ts:22-50,80-87` queries every matching post-compaction `session_message` row with an unbounded `.all()`, then `SessionMessageProjection.decodeRows()` decodes the full result. The dedicated `readDb` is an important prior fix because it prevents a writer transaction from owning the same connection permit, but the Bun SQLite driver is synchronous and every native SQL client itself has a one-permit semaphore (`packages/core/src/database/sqlite.bun.ts:98-159`). More importantly, SQLite row materialization and Effect/Schema decode execute on the single server JS thread, so a second connection would not by itself eliminate CPU/event-loop stalls.

**Trigger.** Every V2 runner turn attempt. Cost grows with all messages after the current context baseline/compaction and with their serialized byte size. Long sessions, many tool turns, and media-heavy assistants are the worst shapes. Several sessions starting or continuing turns concurrently naturally align these costs.

**Scaling law.** O(number of post-compaction rows + total serialized/decompressed message bytes). The query is not paginated or time-sliced. Even if SQLite returns quickly, `decodeRows()` performs schema/object construction for every row and can rehydrate externalized values.

**Cross-session causal chain.** Session A begins a turn and synchronously loads/decodes a large history before provider dispatch. During that 10-160+ ms event-loop window, session B cannot process provider events, publish SSE heartbeats/events, complete other synchronous DB calls, or begin its own LLM dispatch. If B also starts a turn, its history work follows, producing a startup convoy. This matches the symptom class particularly well because several concurrent sessions can appear to start slowly or stall together before tokens arrive.

**Evidence.** Source path is verified and actual `SessionHistory.entriesForRunner()` was benchmarked against the current schema/projector decoder in an isolated in-memory DB. First-run measurements: 100 rows 19.71 ms, 1,000 rows 51.13 ms, 5,000 rows 193.02 ms, one 6 MiB assistant row 9.35 ms. Repeating six loads of the same history in one process to remove cold schema/JIT effects yielded **warm medians of 11.57 ms at 100 rows, 41.23 ms at 1,000, and 163.19 ms at 5,000**. These are in-memory timings, so disk/page-cache misses and OPCL rehydration can only add cost. The runner source itself already comments at `llm.ts:285-289` that synchronous node/sqlite durable commits can monopolize the single event loop; the same runtime property applies to large synchronous reads/decodes.

**Confidence.** Measured in the exact runner-history helper used by production.

**Expected severity.** Very high for long histories and meaningful even around 100 projected messages. Unlike watcher storms or jumbo media, this path occurs on **every turn**, so its likelihood is high under normal multi-session use.

**Cheapest reproduction.** Populate two sessions with controlled post-compaction histories of 100/1k/5k messages. Start both runners simultaneously while recording provider-dispatch timestamp, server event-loop delay, and a third session's heartbeat/tiny-event latency. Repeat with compaction immediately before the turn to prove the expected drop in cost.

**Likely remediation shape.** Avoid reconstructing the entire canonical history synchronously on every step. Maintain or cache a runner-ready immutable context projection keyed by durable sequence/context epoch, incrementally append/decode new rows, and invalidate only across compaction/context-boundary changes. If a full rebuild is unavoidable, introduce byte/row chunking with cooperative yields and consider worker-side schema/materialization only if transfer costs benchmark well. A pool of SQLite reader handles alone will not fix main-thread decode/row construction.

**Regression risk.** Medium-high. Runner context must remain exactly ordered, replay-correct, compaction-aware, and consistent with provider/tool continuation semantics. Caching stale history would be a correctness failure, so the cache key must include the authoritative context baseline and latest durable sequence/message projection revisions.

### C3. Session-context live writes are duplicated by the durable projector

**Mechanism.** `SessionContextState.applyOps()` in `packages/opencode/src/session/context/state.ts:86-295` first inserts the ops-log row and then loops over every operation, issuing state-table writes directly. It then publishes `SessionContext.ContextOpsApplied`. The registered projector in `packages/opencode/src/session/context/projector.ts:20-123` inserts the same ops-log row again and loops over the same operations, applying the same state-table mutations idempotently. `EventV2.commitDurableEvent()` runs all projectors inside the shared `IMMEDIATE` transaction at `packages/core/src/event.ts:895-1041`, so the second copy owns SQLite's single writer slot for the whole O(N) projector loop.

**Trigger.** Any context operation request. The current UI call sites generally submit one operation, but the HTTP API explicitly accepts a batch and the schema at `packages/opencode/src/server/routes/instance/httpapi/groups/session-context.ts:12-14` uses an unbounded `Schema.Array(...)` with no maximum length.

**Scaling law.** Roughly 2× the intended state-write count on the live path, with the second O(N) half serialized inside the global durable writer transaction. `text.restore` / `tool.restore` can add reads before writes, further increasing statements per operation.

**Cross-session causal chain.** A context batch from session A holds the single SQLite writer while the durable projector performs one SQL operation per context mutation. Durable events from sessions B/C cannot commit until that transaction exits. The first direct-write pass also competes for the same writer before the durable publish begins.

**Evidence.** Verified in current source. Direct writes: `state.ts:95-285`; durable publish: `:287-293`; duplicate replay projector: `projector.ts:20-123`; projector transaction boundary: `core/src/event.ts:991-1041`. UI call sites found in `packages/app/src/pages/session.tsx` and `packages/app/src/components/session/session-context-tab.tsx` currently construct one-op arrays, lowering ordinary likelihood but not eliminating API/agent bulk batches.

**Confidence.** Verified mechanism; severity under ordinary workloads is strongly inferred rather than measured.

**Expected severity.** Medium normally, high for large programmatic/bulk context edits. The batch is unbounded at the API schema.

**Cheapest reproduction.** Apply batches of 1/10/100/1000 idempotent context operations while a second session publishes small durable events; measure second-session commit p50/p99 and count SQL statements/transaction duration.

**Likely remediation shape.** Make the live state mutation the durable event's atomic local commit/projector responsibility instead of pre-writing and replay-writing the same state twice, or distinguish live-vs-replay projector execution while preserving rebuild correctness. Add a defensible batch cap/chunking policy.

**Regression risk.** Context state and the durable audit log must remain crash-consistent and replayable. Removing either write path without preserving atomic publication/replay semantics can create state/event divergence.

### C4. Cold ChunkDB rehydration parses jumbo payloads on the server main thread

**Mechanism.** `packages/core/src/database/decompress-pool.ts:93-110` deliberately has workers return raw decompressed bytes, then performs `JSON.parse(decoder.decode(res.raw))` in the worker `message` callback on the main server thread. `rehydrateEvents()` in `packages/core/src/event.ts:474-536` dispatches cold misses concurrently (`concurrency: 16`) when workers are enabled; the physical `DecompressPool` is up to four workers (`decompress-pool.ts:59-66`). Codec work is parallelized, but parsed-object construction remains a synchronous main-thread phase for each completion. V5 delta-ref rehydration is even more direct: base decode/correction and `JSON.parse` occur inline in `event.ts:490-518`.

**Trigger.** Cold replay/history reads containing externalized `$cdbRef` values, especially large tool/media/message payloads that miss the per-DB rehydrate cache. This deployment has `OPENCODE_SEAL_ENABLED=1`, `OPENCODE_SEAL_DEDUP=1`, and `OPENCODE_SEAL_WORKERS=1`, so the worker-completion parse path is active.

**Scaling law.** Approximately O(total decompressed JSON bytes completing in one event-loop window). Up to four workers can finish near-simultaneously, and `rehydrateEvents` can queue more. The rehydrate cache suppresses repeat cost, so the worst case is cold navigation/replay or cache churn across many large values.

**Cross-session causal chain.** The parse callback executes on the single server JS event loop. While session A constructs a 16-32 MiB parsed object, session B's event publication, HTTP work, heartbeat scheduling, queue offers, and other JS tasks cannot execute. Several worker completions can produce a contiguous long task.

**Evidence.** Source-verified active path plus local microbenchmark of exactly `TextDecoder.decode(bytes) + JSON.parse(...)`: median ~0.73 ms at 1 MiB, ~2.43 ms at 4 MiB, ~5.45 ms at 16 MiB, and ~10.51 ms at 32 MiB. Four back-to-back parses measured ~2.97, 8.35, 17.15, and **34.69 ms** respectively. These numbers exclude schema decode, SHA verification, cache insertion, row mapping, and GC.

**Confidence.** Measured for parse cost; strongly inferred for real cold-replay burst timing.

**Expected severity.** High for cold jumbo histories; low for cache-hot ordinary token streaming. A 35 ms server-thread burst is enough to produce visible scheduling jitter across unrelated sessions even before downstream renderer work.

**Cheapest reproduction.** Create four distinct 16-32 MiB cold `$cdbRef` values, clear the rehydrate cache, request a page containing all four while another session emits a heartbeat-sized event stream, and record server event-loop delay plus publish latency.

**Likely remediation shape.** Parse JSON in workers too, but avoid simply structured-cloning a giant parsed object back to the main thread; benchmark transferable/streamed representations or reduce cold page concurrency for jumbo raw sizes. A byte-aware completion scheduler can prevent four large parse phases from landing in one event-loop slice.

**Regression risk.** Moving parsing across worker boundaries can replace parse cost with structured-clone cost and double memory. Integrity validation must remain byte-exact and cache semantics must remain safe.

## 4. False leads / deprioritized paths - live

### F1. Per-subscriber jumbo-event JSON serialization as the main V2 multi-session scaler

**Status: deprioritized.** `packages/server/src/event-serializer.ts` weak-caches both `wireEvent(event)` by published payload identity and the serialized frame by wire-object identity. The legacy server has the equivalent `adaptLegacyEvent`/`serializeLegacyEvent` identity caches. More importantly, `packages/app/src/context/server-sdk.tsx:650-749` opens one selected event stream per server context after protocol detection, not one SSE connection per active session. Therefore ordinary session concurrency does not multiply JSON serialization by session count in the current V2 desktop. Large first-serialization cost can still monopolize one JS task, but subscriber-count amplification is not the dominant cross-session mechanism.

### F2. Default-on EventTrace / renderer phase tracing

**Status: rejected for normal production.** `packages/core/src/event-trace.ts:32-38` requires explicit `OPENCODE_EVENT_TRACE`; `packages/app/src/context/phase-trace.ts:136-150` requires localStorage/query opt-in. These were previously plausible observer-induced bottlenecks but are no longer active by default.

### F3. `BackgroundJob` global registry lock serializes unrelated subagents

**Status: deprioritized.** `packages/core/src/background-job.ts:126-186` uses one `SynchronizedRef<Map<...>>`, but terminal scope close happens after the atomic state modification. `wait()` reads the job then awaits its `Deferred` outside the registry lock (`:313-321`). `extend()` sequences work using per-job tails after the map mutation (`:277-309`). `modifyEffect` is used for small scope/deferred allocation in start/promote/foreground, not for waiting on the actual background work. There is a shared registry, but no source evidence yet that a stuck job holds it across long I/O.

### F4. Checkpoint finalization directly blocks the next model turn across sessions

**Status: lower priority, not fully rejected as machine-I/O pressure.** `packages/opencode/src/session/checkpoint.ts:450-485` forks heavy finalize work in the service scope after turn finish/abort rather than awaiting it on the response path. Snapshot Git operations are serialized by shadow-repo gitdir in `packages/opencode/src/snapshot/index.ts:55-65,165`. This can still consume CPU/disk and serialize worktree snapshots, but the source does not show a direct foreground wait that explains unrelated-session UI freezes by itself.

### F5. Active ChunkDB sealer monopolizes the main event loop with synchronous compression

**Status: rejected for this deployment.** The non-worker sealer path can synchronously call `compressText()` over a full candidate batch before yielding, and `OPENCODE_SEAL_WORKERS` is default-off in generic configuration. However, the current execution environment reports `OPENCODE_SEAL_ENABLED=1`, `OPENCODE_SEAL_DEDUP=1`, and `OPENCODE_SEAL_WORKERS=1`. Active compression therefore uses `CompressPool`, which is capped at two workers (`packages/core/src/database/compress-pool.ts:60-66`). This theoretical stall is not the current configuration.

### F6. ChunkDB background SQLite writer monopolizes the durable writer slot

**Status: currently lower priority.** The active sealer uses a dedicated connection with `busy_timeout=100ms`, foreground-priority busy retry, write slices capped at 8 rows / 512 KiB with 15 ms pauses, and one cross-process elected owner. Semantic prune uses 256-row slices; the source records a measured separate-process foreground-writer p99 of ~2.3 ms at that slice size (`packages/core/src/database/chunk-prune.ts:56-65`). Maintenance can still add disk/CPU load, but the current implementation specifically avoids long writer ownership and has existing contention measurements.

### F7. Value-identical Location refs create duplicate location service/watcher stacks

**Status: rejected.** `buildLocationServiceMap()` keys the 60-minute `LayerMap` by `Location.Ref`, and many call sites construct a fresh `Location.Ref.make(...)`, which initially made object-identity cache misses a serious concern. Direct measurement against the current Effect/schema runtime shows two separately-created refs with the same directory are `a === b: false` but `Equal.equals(a,b): true` and have the same `Hash.hash(...)`. The LayerMap therefore has value/hash semantics for these schema values rather than raw JS identity semantics. Distinct workspace IDs intentionally remain distinct locations, but repeated construction of the same ref does not multiply watchers/index services.

### F8. Shell stdout publishes one durable Tool.Progress event per output chunk

**Status: rejected for the current tool bridge.** `packages/opencode/src/tool/shell.ts` does call `ctx.metadata(...)` for every decoded output chunk, which initially looked like a direct durable-event storm. However, `packages/opencode/src/session/tools.ts:257-304` explicitly throttles metadata per `toolCallId` to at most once every **500 ms** and documents the exact reason: unthrottled shell/build output would cost DB reads/writes, event publication and SSE fan-out thousands of times per second across concurrent sessions. Completion still carries the final state. The V2 `createLLMEventPublisher` also does not convert every local stdout chunk into Tool.Progress. This mitigation should remain covered because removing/bypassing it would immediately resurrect a severe convoy.

### F9. Hidden/background sessions continue reducing heavy Tool/Text/Reasoning content in the renderer

**Status: rejected.** `packages/app/src/utils/session-stream-content.ts` classifies both legacy and native `session.*` / `session.next.*` text, reasoning, tool, shell, step and compaction families as reconstructible session content, in addition to full message/part events. `server-sdk.tsx` checks foreground interest before adaptation, byte accounting, queue insertion and emitter fan-out. Therefore a hidden session's 6 MiB Tool.Success can still hurt the **server** through C5, but it is intentionally skipped by the renderer until authoritative hydration on foreground resume.

### F10. One cold location boots two independent full-repository search seeds

**Status: rejected.** `FileSystemSearch` contains both an older ripgrep/FFF layer and the persisted `SearchIndex` composite, but `packages/core/src/filesystem/search.ts:499-500` selects exactly one backend. `Flag.OPENCODE_SEARCH_INDEX` defaults to true, so the current path uses only `indexComposite`. `SearchIndex` also protects an empty physical index with a machine-wide crash-recovering cold-seed lease before running the full `rg` walk (`packages/core/src/search/index-service.ts:250-295`). There is no same-location double full-repository seed in the default configuration.

## 5. Top decisive experiments - live

1. **Concurrent runner-history convoy:** start two controlled 100/1k/5k-message sessions simultaneously and record provider-dispatch delay, event-loop delay, and a third session's tiny-event/heartbeat latency. Repeat immediately after compaction.
2. **Watcher cross-location burst:** keep 5-10 location layers warm, generate 4,096 path updates in one repo, and measure another session's event/provider-stream latency plus actual listener count.
3. **Production no-touch projection timing:** instrument `projectV2` around full `reconcile(messages)` and compare current behavior to a synthetic early-return experiment for `touched=[]` control events at 100/1k/5k/10k messages.
4. **Jumbo Tool.Success writer convoy:** run two sessions against a real temporary WAL DB; vary Tool.Success payload 1/4/6/8 MiB and accumulated prior assistant media, measuring the unrelated session's durable commit p99.
5. **Cold jumbo rehydrate / context-writer split:** clear the rehydrate cache and decode four distinct 16/32 MiB refs while measuring unrelated publish latency; separately run 1/10/100/1000-op context batches against a tiny competing durable writer.

## 6. Audit coverage - live

Inspected so far:

- `docs/handoff/HANDOFF-concurrent-session-audit-scout.md`
- `packages/app/src/context/server-session-v2-reducer.ts`
- `packages/app/src/context/server-session.ts`
- `packages/app/src/context/server-sync.tsx`
- `packages/app/src/context/server-sdk.tsx`
- `packages/server/src/handlers/event.ts`
- `packages/server/src/event-serializer.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`
- `packages/opencode/src/server/event-serialization.ts`
- `packages/opencode/src/event-v2-bridge.ts`
- `packages/core/src/event-trace.ts`
- `packages/app/src/context/phase-trace.ts`
- `packages/core/src/background-job.ts`
- `packages/opencode/src/session/checkpoint.ts`
- `packages/opencode/src/snapshot/index.ts`
- `packages/opencode/src/session/context/state.ts`
- `packages/opencode/src/session/context/projector.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/session-context.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session-context.ts`
- `packages/core/src/event.ts` durable transaction/projector boundary
- `packages/core/src/database/database.ts`
- `packages/core/src/database/chunk-sealer.ts`
- `packages/core/src/database/chunk-prune.ts`
- `packages/core/src/database/chunk-compaction.ts`
- `packages/core/src/database/compress-pool.ts`
- `packages/core/src/database/decompress-pool.ts`
- `packages/core/src/flag/flag.ts`
- `packages/core/src/tool-output-store.ts`
- `packages/core/test/tool-output-store.test.ts`
- `packages/core/src/session/runner/publish-llm-event.ts`
- `packages/core/test/session-runner-tool-events.test.ts`
- `packages/core/src/session/message-updater.ts`
- `packages/schema/src/session-event.ts`
- `packages/schema/src/session-message.ts`
- `packages/core/test/session-tool-progress.test.ts`
- `packages/core/src/location-services.ts`
- `packages/core/src/location-service-map.ts`
- `packages/core/src/location.ts`
- `packages/schema/src/location.ts`
- `packages/core/src/filesystem/watcher.ts`
- `packages/core/src/filesystem/index-watcher.ts`
- `packages/core/src/filesystem/search.ts`
- `packages/core/src/search/index-service.ts`
- `packages/opencode/src/tool/heavy-process-concurrency.ts`
- `packages/opencode/src/util/machine-slot-budget.ts`
- `packages/opencode/src/tool/shell-concurrency.ts`
- `packages/opencode/src/tool/shell.ts`
- `packages/opencode/src/tool/test.ts`
- `packages/opencode/src/tool/typecheck.ts`
- `packages/opencode/src/tool/typecheck-scope.ts`
- `packages/opencode/src/background/process-concurrency.ts`
- `packages/opencode/src/session/tools.ts`
- `packages/app/src/utils/session-stream-content.ts`
- `packages/app/src/context/global-sync/session-cache.ts`
- `packages/core/src/session/history.ts`
- `packages/core/src/session/runner/llm.ts`
- `packages/core/src/session/store.ts`
- `packages/core/src/session/context-epoch.ts`
- `packages/core/src/database/sqlite.bun.ts`

Major areas still to inspect include reducer helper rebuild cost, database maintenance/sealing/pruning, remaining writer critical sections, worker/compression pools, giant tool/media payload copy chains, filesystem watcher amplification, tool subprocess admission outside the heavy-process limiter, logging, memory retention/GC, query/index growth, and provider/catalog/session startup duplication.
