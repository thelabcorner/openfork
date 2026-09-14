# Final Closeout — Concurrent Session / Transport / Renderer Contention Campaign

Date: 2026-09-13 (final validation continued into 2026-09-14 UTC)

Scope: `/webstormprojects/opencode`

This document is the final evidence-oriented closeout for the concurrency campaign. It does **not** replace the historical scout trail in `AUDIT-concurrent-session-contention-scout-2026-09-13.md`; it records the current dirty-tree architecture and the final validation sweep.

## Executive conclusion

The original goal is now defensible for the desktop/main app architecture:

> Concurrent OpenCode sessions are substantially isolated. Ordinary session-local streaming, history, Markdown rendering, filesystem activity, project search, Context analytics, tab-preview work, and tool output no longer impose work proportional to unrelated sessions/history/projects. Shared resources that cannot be fully isolated are bounded and cooperative. Pathological workloads can still slow themselves, but they no longer reasonably monopolize the global SQLite writer, EventV2 fanout, worker pipeline, filesystem/indexing path, or normal renderer workload. The corrected real Chromium timeline benchmark reaches the intended workload and corroborates the unit/microbenchmark architecture.

The qualification is important: a deliberately absurd **30x CPU throttle** can still starve a single Chromium renderer main thread for seconds at a time. That is local CPU starvation, not a return of the original cross-session/global-resource architecture. At 1x the same 320-turn/160-delta workload is frame-clean; at 4x it remains usable and completes with bounded jank. All browser figures below come from the same final production-build harness contract: distinct frontend/backend ports, explicit persisted `127.0.0.1:4096` backend selection, backend-only mock interception, and an assertion that the session route resolves through that backend.

## Final architecture by coupling surface

### Server / SQLite / runner

- Active runners hold a sequence-aware incremental history projection. Cold history is decoded cooperatively once; continuations read a microsecond-class hot view.
- Jumbo tool lifecycle/results live in a small mutable overlay rather than repeatedly rematerializing historical multi-MiB results into the assistant row.
- Jumbo durable event payloads are content-addressed and staged in bounded chunks outside the semantic writer transaction. The final semantic event transaction writes a small reference.
- Payload metadata/refcounts protect committed content; old zero-ref crash residue is reclaimed after a grace period.
- Cold decompression worker completions remain byte-accounted until settlement and jumbo JSON parsing is serialized/cooperatively scheduled.
- Shell admission separates known simple wait/network/log commands from conservative heavy builds/tests/typechecks/unknown compound shell.

### Event / transport / reconnect

- EventV2 routes high-rate listeners by type + exact location and by aggregate before callback invocation. Foreign projects do not pay callback/filter cost.
- Watcher publication is cooperatively chunked.
- Live/replay subscriber queues are bounded by count and bytes and fail explicitly instead of silently dropping semantic events.
- Recoverable reconstructible-content pressure repairs the owning session instead of turning a local backlog into global hydration.
- Ordinary successful reconnect is liveness only; actual replay gaps/explicit repair trigger repair behavior.
- Hidden/uninterested reconstructible content can be rejected before renderer adaptation/queueing.
- Renderer ingress coalesces growing deltas as fragments and materializes once rather than repeatedly concatenating the accumulated string.

### Timeline / Find / Markdown

- Renderer V2 reductions explicitly represent unchanged vs incremental vs structural projection. Control traffic no longer clones/reconciles the full session or destroys the stream index.
- Timeline structural identity is indexed (`messageByID`, turn indexes, stable per-turn row arrays). Normal token growth is consumed in mounted rows without waking global flatten/index topology.
- Prepend anchoring uses virtualizer coordinates with bounded stabilization instead of broad repeated DOM geometry scans.
- Session Find does zero corpus work for an empty query, does not hydrate older history merely because the UI opened, and isolates streaming corpus recomputation to the changed turn.
- Markdown worker projection and code highlighting are append-oriented with retained per-key worker state and explicit miss/reset recovery.
- The desktop renderer no longer proves append-only continuity by walking the entire previous growing string every token.
- Markdown reparses the mutable tail where semantics allow it; reference definitions and other retroactive constructs retain a full-message escape hatch.
- The Marked token fast path mutates only grammar-safe terminal token shapes and falls back exactly on structural/ambiguous input. Differential fuzzing is part of the session-ui suite.

### Explorer / editor / VCS / Context / tabs

- Explorer search stays cold while empty. Active search is generation-cancelled and cooperatively slices matching, ancestor construction, and filtered DFS.
- Native drag payload construction is bounded and does not traverse huge selections after reaching its item/byte limits.
- Dirty editor buffers are never evicted; inactive clean buffers are bounded; external watcher changes mark inactive clean buffers stale rather than eagerly reading them.
- Changes/VCS is a visible-consumer concern. Hidden watcher/idle invalidations set one dirty bit and perform zero Git diff work. A tested controller bounds races and failures. A disabled reactive query observes the same cache key populated by explicit refresh.
- Context historical analytics snapshot only at metadata boundaries; live token progress subscribes only to the active assistant. Closed Context panes stop before reading message/part stores.
- Context raw history progressively mounts the newest 200 rows and bounds human-readable body/reasoning previews to ~24 KiB; authoritative Raw JSON remains available on demand.
- Tab previews use one global four-request metadata hydration lane and progressive 80-row group pages. Membership/project/open-tab lookups are indexed.

## Final measurements

| Surface | Final evidence | Interpretation |
| --- | --- | --- |
| Jumbo writer fairness | A 8 MiB publish 60.08 ms total; **B tiny durable commit 1.63 ms**; A final semantic writer **1.63 ms** | A can do O(payload) work without holding SQLite's scarce writer for the whole operation. |
| Repeated jumbo tool results | Four 6 MiB settlements leave mutable assistant **299 -> 902 B** | Historical result bytes do not accumulate in the mutable assistant row. |
| Runner 5k history | **142.79 ms cold**, **7.72 us warm**, max event-loop lag **15.59 ms** | O(history) decode is activation work, not per-provider-continuation work. |
| Decompression fairness | 4 x 16 MiB: **101.40 ms total**, max event-loop gap **22.73 ms**, 8 timer opportunities | Main-thread parse bursts are cooperatively separated; one individual JSON.parse remains indivisible. |
| Event saturation | Latest rerun: multi-session delta publish p50 **2 ms**, p99 **8 ms**, max **22 ms**; loop max gap **25 ms** | High-rate event pressure remains bounded/cooperative; scheduler noise changes wall-time tails without changing the mechanism. |
| 6 x 2 MiB durable boundaries | Latest rerun: p50 **84.2 ms**, p99/max **100.6 ms**, loop max gap **15.5 ms** | Large local commits do not monopolize the JS loop for the full wall time. |
| Browser 320 turns / 160 deltas, 1x | **3.2517 s**, **49.21 delta/s**, rAF P95 **16.7 ms**, max **16.8 ms**, 0 long tasks, 0 >33 ms gaps | Normal production workload is frame-clean. |
| Browser same workload, 4x CPU | **3.4024 s**, **47.03 delta/s**, rAF P95 **33.4 ms**, max **66.7 ms**, 14 gaps >33 ms, 2 >50 ms, 0 long tasks | Low-end-device stress remains bounded and completes promptly. |
| Browser same workload, 30x CPU | **283.90 s**, **160/160 delivered**, 0 pending, rAF P95 **3.1165 s**, max **7.083 s**, 1068 long tasks / 239.1 s Long Task time, exact bottom anchor, no remount/blanking | Deliberately starved renderer becomes locally CPU-bound; transport/state correctness remains intact. |
| 30x worker timing | ~**476.3 s** aggregate request round-trip vs only **~317.6 ms** worker compute | The starved main thread cannot service worker replies promptly; worker compute itself is not the bottleneck. |
| Timeline topology in browser run | only **2** topology projection runs over ~321 turns | Token updates do not make all historical turns rebuild topology. |
| Explorer 50k all-match | Latest rerun: **17 slices**, **281.03 ms total**, **13.37 ms max slice** | Broad search yields within a frame-scale budget instead of one monolithic ~20+ ms task. Total wall time varies with host scheduling; the synchronous slice bound is the fairness invariant. |
| Explorer 50k drag selection | **~0.95 ms** bounded payload construction | Drag transfer cost is independent of the full selected-set size after limits are hit. |
| Context 5k raw history | newest **200 rows**, latest selection operation **~0.040 ms** | Raw ledger mount cost is bounded by view policy, not history length. |
| Context 8 MiB text preview | **24,579 chars**, latest preview operation **~0.174 ms** | Expand-all summaries cannot accidentally Markdown-render multi-MiB historical bodies. |
| Tab preview stress | 100 queued hydrations, observed **max concurrency 4** | One hover storm cannot multiply request lanes per tab/popover. |

## Required adversarial scenario matrix

### A — Two active streaming sessions

Transport/coalescer validation drives **32 concurrent streaming sessions** through bounded batches while preserving reducer state. Event saturation probes multi-session bursts and the renderer ingress suite preserves independent stream identities. The real Chromium benchmark validates the active visible timeline. A separate two-window/two-visible-Chromium frame-cadence benchmark was not built; OpenCode renders one active timeline per window, so the shared transport/server isolation is proven more directly by the 32-session tests while visible-frame behavior is proven by the real timeline run.

### B — Jumbo tool output

Passed. During Session A's 8 MiB durable publish, Session B's tiny durable event completed in **1.63 ms**; A's final semantic writer hold was **1.63 ms**. Four 6 MiB settlements keep the mutable assistant under 1 KiB.

### C — Filesystem storm

EventV2 exact-location routing tests prove foreign-project callbacks are not invoked. Filesystem index tests verify lazy subtree work and touched-only refresh behavior. Saturation tests prove bounded event-loop gaps. Watcher publication is chunked/yielding in production source. No evidence of global callback fanout remains.

### D — 5k-turn/history pressure

Runner 5k warm history reads are **7.72 us** after one cooperative cold materialization. Timeline structure tests prove content-only growth does not rebuild topology; the real 320-turn browser workload performs only two topology projections. Structural append remains O(N) index construction rather than per-turn O(N) searches.

### E — 50k Explorer

Passed directly. Latest all-match 50k search: 17 cooperative slices, 281.03 ms total, 13.37 ms max measured slice. Superseded generation publishes no stale result. 50k selection drag transfer is ~0.95 ms and bounded.

### F — 100 tabs / many groups

The tab preview hydration stress queues 100 tasks and observes max concurrency exactly 4 through the single global lane. Large group preview pages are capped at 80 rows at a time; membership/project/open-tab lookup paths are indexed.

### G — Context pane

Closed pane architecture stops before message/part-store reads. Open pane historical analytics are snapshot-driven and live progress follows only the active assistant. Raw history is 200-row bounded; latest 5k windowing is ~0.040 ms. An 8 MiB body creates a ~24 KiB preview in ~0.174 ms. Authoritative Raw JSON remains opt-in.

### H — Reconnect

Home/session-index tests prove replayable reconnect stays incremental while explicit repair/disposal/move refetches. Queue pressure tests distinguish session-local reconstructible repair from truly global/unrecoverable conditions.

### I — Hidden renderer/window

Browser-condition server SDK tests prove hidden/uninterested reconstructible content is dropped before renderer queue work and queued streaming work is discarded when the renderer becomes hidden. Reveal/repair remains scoped to affected sessions.

### J — Browser-level timeline benchmark

Passed after fixing **four** benchmark-harness defects rather than accepting superficially plausible green numbers:

1. the frontend and mocked backend ports were accidentally aliased;
2. ambient `NODE_ENV=development` could compile development-only instrumentation into the nominal production benchmark;
3. once production semantics were restored, the web entry correctly defaulted to `location.origin`, so the fixture had to persist both the explicit `127.0.0.1:4096` default server and a matching server connection;
4. after that fix, the mock still answered backend APIs/SSE on both the frontend and backend ports. Production therefore created two server contexts/subscribers while the fixture exposed one destructive `events.splice(...)` queue. The inactive frontend-origin subscriber could steal frames from the active backend subscriber.

The fourth defect was caught by a deliberately fail-closed rerun: all 160 fixture deltas had been dequeued with zero pending and the renderer remained frame-clean, yet the visible stream stopped at marker **143/160** for the entire 420 s timeout. That combination is incompatible with renderer CPU starvation and led directly to the duplicate-subscriber diagnosis. The performance fixture now enables strict backend-port interception, so the frontend Vite origin cannot impersonate a second OpenCode backend. A 1-turn/160-delta proof then reached 160/160, followed by final 320-turn/160-delta passes at 1x, 4x, and 30x CPU. The final session URL is also asserted to encode `127.0.0.1:4096` before measurement begins.

## Validation ledger

- Core focused contention subset: **53/53**, 450 assertions.
- EventV2 full focused file: **55/55**, 103 assertions.
- Core migration suite: **19/19**, including current migration ordering. Generated registry ends with `20260913213000_scope_session_search_fts_updates`, `20260913221334_session_message_lifecycle_overlay`, `20260913232150_session_message_tool_overlay`, `20260913233022_event_payload_chunks`, `20260913235645_event_payload_meta`.
- Session UI component/Markdown suite: **205/205**, 1628 expectations; `packages/session-ui` typecheck clean.
- OpenCode HTTP-event/filesystem/shell subset: **24/24**. Shell suite verifies simple waiting I/O commands do not consume heavy permits.
- Server replay/backlog: **6/6**; `packages/server` typecheck clean.
- App final closeout subset: **31/31** (Explorer, Context raw bounds, VCS controller, Home/reconnect, cache/phase-trace, tab preview gate/indexing).
- App browser-condition closeout subset: **30/30** (Session Find streaming isolation and server transport/hidden behavior).
- Context metrics/raw-history group: **72/72**.
- Performance harness environment/port/mock regression tests: **8/8**; E2E TS project clean. This includes a direct unit proof that strict-backend mode falls through on the Vite origin and fulfills the mocked backend origin, in addition to distinct-port/production-environment guards. The timeline fixture also asserts the encoded backend route before streaming.
- Real Chromium timeline workload: passed at 1x, 4x, and 30x CPU throttle after harness correction.

## Typecheck / dirty-tree reality

`packages/session-ui` and `packages/server` are type-clean. The performance E2E TypeScript project is clean. Full `packages/app` typecheck is still red with **47 diagnostic lines**, all confined to unrelated dirty-tree groups: experimental React `context-history`/`context-ledger`, the known oversized inferred `context/sdk.tsx` type, older `server-session.test.ts` typing, and concurrently edited `chat-sidebar-pane.tsx`. Two `server-sdk.test.ts` narrowing diagnostics introduced by this campaign were fixed during final attribution, reducing the package-wide count from 49 to 47; no closeout-touched file remains in the diagnostic set.

No reset, restore, stash, clean, commit, or push was performed. Existing tracked/untracked changes remain user/other-agent owned.

## Residual limitations / risks

1. **Extreme local CPU starvation still exists by definition.** In the final strict-backend run a 30x throttled Chromium renderer took 283.90 s, with rAF P95 3.1165 s and max 7.083 s, even though all 160 deltas arrived and state/identity/anchoring stayed correct. Optimizing specifically for that artificial regime would likely add complexity for little normal-world value; 1x is frame-clean and 4x remains bounded.
2. **One jumbo `JSON.parse` is indivisible.** Cooperative settlement separates completions but cannot preempt the native parse of one very large object.
3. **In-memory ChunkDB fixture warning.** Some tests/benchmarks start semantic pruning without an `ocdb_meta` table, log the missing-table error, then back off. This is a test-harness cleanup item, not a failed contention assertion.
4. **Separate mobile Markdown renderer.** `packages/mobile/src/markdown/stream.ts` still uses growing-prefix `startsWith(previous.text)` checks. The desktop/app/session-ui concurrent-session campaign did not migrate the mobile renderer.
5. **No dedicated two-window visual Chromium benchmark.** Shared transport/server concurrency is stress-tested with 32 simultaneous session streams, while active visible-frame behavior is validated with the real timeline benchmark. A future multi-window benchmark could combine both in one browser-level artifact if desired, but no current architectural defect depends on it.

## Final judgment

The original cross-session clogging failure mode has been attacked at the coupling mechanisms rather than hidden behind delays: full-history repeated work, global event fanout, giant writer ownership, replay/global-repair coupling, renderer-wide structural invalidation, growing-string work, eager hidden UI, unbounded search/drag/history surfaces, per-tab request multiplication, and hidden Git refreshes are all removed or bounded. The remaining expensive cases are local, explicitly bounded/cooperative where technically possible, and do not justify reopening the architecture campaign without new evidence.
