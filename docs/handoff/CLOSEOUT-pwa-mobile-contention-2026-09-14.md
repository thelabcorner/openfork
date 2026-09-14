# PWA / Mobile Contention Campaign — Final Closeout

Date: 2026-09-14

Scope: `/webstormprojects/opencode`, primarily `packages/mobile`, plus the native EventV2 SSE protocol/serializer/test surface required to make mobile replay semantics correct and shared-server-safe.

## Status

The campaign is closed against the original definition of done.

The final architecture has the properties the campaign was trying to establish:

- one capability-selected event feed per visible mobile client;
- replay-first reconnect with Last-Event-ID rather than reconnect hydration;
- `server.connected` is liveness only;
- an explicit `server.stream.gap` is the broad authoritative-repair boundary;
- hidden/slow renderer work is bounded and locally droppable rather than allowed to become SSE/TCP pressure;
- token-rate projection is session-local and history-size-independent in the actual renderer path;
- deep chat/session lists are virtualized only above measured thresholds;
- jumbo tool output is preview-bounded before expensive parsing;
- Markdown streaming no longer repeatedly re-lexes/proves the accumulated prefix on ordinary token updates;
- Shiki grammar/theme admission is lazy and the production asset graph is constrained to supported languages;
- active-session reconciliation is one global request on V2 servers, with bounded legacy-directory fanout only on compatibility servers;
- permission/question REST repair is single-flight per session;
- native control frames are schema-valid for generated clients;
- warm/cold push navigation resolves the requested session through the real session-selection path.

No reset, restore, stash, clean, commit, or push was performed. The monorepo remained heavily dirty from concurrent agents/user work throughout; this campaign stayed scoped and re-read files before mutation when concurrent evolution was observed.

---

## 1. Starting baseline

Initial mobile validation before this campaign:

- `packages/mobile bun test --only-failures`: **141 pass**, **288 assertions**.
- `packages/mobile bun run typecheck`: clean.
- `packages/mobile bun run build`: clean.
- Main production app chunk: approximately **795.76 kB minified / 230.28 kB gzip**.

Important baseline architecture:

- mobile opened both native `/api/event` and compatibility `/global/event`;
- generated SDK retry was disabled;
- a fresh stream instance discarded the previous replay cursor;
- `server.connected` triggered broad hydration;
- the app also performed broad snapshot repair after its own reconnect loop;
- foreground lifecycle restarted feeds and rehydrated;
- active state was polled every 15 seconds;
- active reconciliation could issue one status request per directory;
- renderer message ingress was an unbounded rAF array;
- token deltas could mutate cross-session runtime state;
- message/part lookup repeatedly scanned arrays;
- ordinary live Markdown could repeatedly lex/inspect the growing accumulated string;
- all loaded chat messages were mounted;
- giant tool output could be ANSI/structure parsed eagerly;
- first Shiki admission exposed the whole bundled language/theme registries to the build graph.

---

## 2. Transport and reconnect architecture

### 2.1 One capability-selected feed

`fetchAllSessions()` now uses successful V2 session-list access as the protocol capability proof:

- V2-capable server -> native `/api/event`;
- old compatibility server -> `/global/event`.

Exactly one stream is opened.

This is safe for legacy-origin sessions on a V2-capable server. The legacy and V2 Session implementations project into the same `SessionTable`, and a real HTTP regression proves a session created through legacy `POST /session` is delivered through native `/api/event`.

That removes the duplicate mobile socket/parser and avoids needlessly keeping the legacy server bridge/capture path active beside native EventV2.

### 2.2 Replay-first reconnect

`openEvents()` leaves ordinary retry to the generated SDK transport:

- default retry delay: 500 ms;
- capped retry delay: 10 s;
- jittered exponential backoff;
- the same stream instance retains Last-Event-ID;
- the app also carries the last cursor across the rare outer stream-generation restart.

The resulting normal reconnect is:

`disconnect -> SDK reconnects with Last-Event-ID -> server.connected -> replay suffix -> live`

`server.connected` performs **zero hydration**.

If the server cannot reconstruct the suffix from its bounded replay ring, it emits `server.stream.gap`. Only that explicit condition performs coordinated authoritative repair:

- session metadata;
- active-runtime snapshot;
- currently open message history.

### 2.3 Generated transport regression coverage

Both V1 and V2 generated SSE transports now have focused tests for:

- consumer cancellation cancelling the underlying response;
- validator-rejected frames not advancing Last-Event-ID;
- heartbeat liveness restoring a healthy retry delay;
- reconnect storms remaining serial rather than creating parallel fetch chains;
- last successfully validated cursor surviving repeated reconnect failures;
- capped jittered exponential backoff.

Final SDK result:

- **8 pass / 0 fail / 20 assertions**;
- SDK `tsgo --noEmit`: clean.

---

## 3. Native SSE protocol correctness

The campaign found a real protocol bug while exercising reconnect/fairness: the native handler intentionally emitted `server.heartbeat` and `server.stream.gap` data frames, but the native protocol success schema only described ordinary EventV2 events plus `server.connected`. A generated/validated client could therefore reject a healthy stream on its first heartbeat or on the exact repair signal it needed.

The protocol now explicitly includes:

- `server.connected` with optional replay `epoch`;
- `server.heartbeat`;
- `server.stream.gap { requested, oldest?, latest }`.

The server serializer now sends domain and transport-control frames through the same schema validation path.

The generated JS SDK `V2Event` union was updated narrowly, without regenerating over unrelated concurrent SDK codegen changes, so its public types expose the same three control-frame shapes.

Server serializer validation:

- **4 pass / 0 fail / 41 assertions**;
- `packages/server tsgo --noEmit`: clean.

Protocol typecheck:

- `packages/protocol tsgo --noEmit`: clean.

---

## 4. Real replay, gap, queue, and multi-client fairness proof

The final isolated HTTP/SSE matrix uses the real in-process server stack and temporary DB fixtures rather than the user's live desktop server.

Canonical command uses the package's required 30 s test timeout because instance/DB cleanup can legitimately exceed Bun's default 5 s hook timeout under a heavy multi-file SSE run.

Final matrix:

- native four-subscriber fairness;
- stream lifetime;
- two concurrent subscriptions;
- explicit gap control frame;
- instance-disposal stream termination;
- live subscriber queue capacity/failure behavior;
- replay more than 256 frames behind;
- foreign epoch rejection;
- reconnect replay ordering;
- basic live delivery;
- cross-location native delivery, including legacy-created sessions.

Result:

- **15 pass / 0 fail / 454 assertions**.

Latest four-subscriber fairness sample (3 PWA-style + 1 desktop-style subscriber):

| metric | value |
| --- | ---: |
| subscribers | 4 |
| baseline request median | 18.27 ms |
| baseline request p95 | 69.34 ms |
| four-subscriber request median | 18.78 ms |
| four-subscriber request p95 | 89.94 ms |
| native offers | 216 |
| subscriber offer failures | 0 |
| legacy envelopes generated | 0 |
| native serialization avg | 0.087 ms |
| native serialization max | 3.123 ms |

The test intentionally uses a generous CI ceiling rather than pretending workstation microbenchmarks are deterministic. The important invariant held: adding three mobile subscribers did not turn native publication into a blocking or failure-prone path, and the legacy bridge stayed skipped.

---

## 5. Background lifecycle and bounded renderer ingress

Mobile now treats a suspended renderer as a local concern.

When the document becomes hidden:

1. admitted renderer work is flushed;
2. the SSE socket is closed;
3. reconstructible deltas are not retained while rAF/painting is suspended.

Foreground starts a stream with the saved cursor and receives the replay suffix. If mobile intentionally skipped renderer-local content that still needs repair, only the active session history is fetched.

`MessageEventQueue` bounds admitted renderer work by both count and retained bytes:

- 256 events default;
- 512 KiB retained-byte budget;
- 64 KiB maximum adjacent coalesced delta chunk.

Adjacent deltas for one exact stream key are kept as fragment ropes in a `WeakMap` and joined once at drain. This avoids rebuilding an ever-growing coalesced string on every wire token.

On local overflow the queue is dropped and exact affected session IDs are marked stale. The server socket is not backpressured to preserve work the phone cannot paint.

Queue tests include:

- adjacent delta coalescing;
- long adjacent stream materialized once at drain;
- interleaved stream ordering;
- count overflow with exact stale-session reporting;
- independent retained-byte overflow.

---

## 6. Active-session and request amplification

V2 active state is server-global. Mobile now performs one `v2.session.active()` request rather than one legacy `session.status()` request per session directory.

The compatibility planner only creates per-directory status work when the server is actually in old-server compatibility mode, deduplicates those directories, and runs them with concurrency **4**.

Focused contract proof:

- **2,000 V2 sessions -> exactly one active-state request and zero directory status calls**.

The 60 s active poll remains as a low-frequency safety net, not reconnect repair.

Permission and question refreshes are also single-flight per session with one dirty rerun, preventing bursts of related events from creating overlapping REST storms.

---

## 7. Token-rate message projection

`messageStream.ts` now keeps hot positional indices for messages and parts and the renderer owns a mutable outer projection for token-rate updates.

The important distinction is:

- low-frequency topology mutations may rebuild/index/copy;
- token-rate updates mutate the detached projection and publish only the exact changed Solid store slot.

History-wide analytics in `ChatView` depend on an explicit structural revision and inspect history untracked, so a growing text token no longer wakes tool-count/subtask scans.

Latest synthetic results, 500 admitted deltas per sample:

| history | immutable reducer 1-char | immutable reducer 64-char | renderer projection 1-char |
| ---: | ---: | ---: | ---: |
| 100 | 5.62 us | 1.80 us | 1.27 us |
| 1,000 | 4.42 us | 3.61 us | 0.62 us |
| 5,000 | 18.99 us | 16.68 us | **0.33 us** |

The public immutable helper still scales somewhat with history because it preserves immutable-array semantics for callers/tests. The actual mobile renderer hot path is the mutable projection column, which is effectively independent of history size in this benchmark.

---

## 8. Markdown streaming

Ordinary live Markdown no longer re-proves append continuity by comparing the accumulated prefix on every token. The reducer supplies an O(1) append contract:

- previous length;
- exact append delta.

The projector keeps the mutable tail incremental and falls back to exact reprojection on structural/correctness-sensitive transitions.

A second quadratic was removed from blank-line detection: ordinary no-newline suffixes no longer call a full-prefix `lastIndexOf("\n")` each token.

The projector also distinguishes harmless trailing-whitespace normalization from true synthetic Markdown healing, preventing ordinary prose from accidentally falling back to full lexing after `remend` normalization.

Final 100 KiB synthetic measurements:

| case | median total projection time |
| --- | ---: |
| append-only ordinary prose | **0.486 ms** |
| one open TypeScript fence | **9.418 ms** |

Rendered HTML cache remains bounded by both:

- 400 entries;
- approximately 8 MiB retained UTF-16 bytes.

---

## 9. Jumbo tool output

Collapsed/generic tool output no longer eagerly pays full ANSI + structural parsing cost for an arbitrarily large body.

`boundedToolPreview()` keeps at most **128 Ki characters** of eager parse input (head + tail with omission marker). Full content remains available when the UX actually requires it.

The common one-text-item tool result also returns the original string directly rather than `filter().map().join()`-copying a multi-megabyte payload.

8 MiB synthetic generic output:

| path | median |
| --- | ---: |
| full ANSI + structure parse | 90.348 ms |
| bounded preview parse | **1.608 ms** |

That is roughly a **56x** reduction in this benchmark and, more importantly, makes eager parser input bounded.

---

## 10. Long-chat virtualization

Current production message hydration is capped at 100, so the normal mobile path intentionally remains non-virtualized.

Virtualization activates only above **160 messages**.

The virtual path is structural-revision-gated so token deltas do not rebuild thousands of row descriptors or invalidate historic row measurements.

Headless-Chromium synthetic measurements:

| messages | mounted message blocks | total DOM nodes | JS heap | ready time |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 100 (plain path) | 1,218 | ~18.5 MB | ~544 ms |
| 500 | 12 | 269 | ~20.9 MB | ~420 ms |
| 1,000 | 12 | 269 | ~17.9 MB | ~543 ms |
| 5,000 | 12 | **269** | ~24.9 MB | ~540 ms |

At 500/1k/5k the final mounted row is the real tail, bottom distance is zero, and resize-induced row-height churn remains anchored. Latest 5k run had no long tasks; frame p95 was ~16.8 ms, with one resize sample max around 22.5 ms.

For comparison, the pre-virtualization 5k probe reached approximately **47,768 DOM nodes / ~191 MB heap / ~33.4 ms max frame**.

---

## 11. Large session lists

SessionsView already had a fixed-height virtual list. This campaign closed both DOM and request-amplification acceptance criteria.

Latest Chromium samples:

| sessions | mounted rows | DOM nodes | heap | ready |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 15 | 418 | ~37.3 MB | ~368 ms |
| 1,000 | 15 | 421 | ~22.4 MB | ~400 ms |
| 2,000 | **15** | **418** | ~28.5 MB | ~396 ms |
| 5,000 | 15 | 421 | ~47.4 MB | ~537 ms |

Frame p95/max stayed around one 60 Hz frame in the latest synthetic samples.

Combined with the active-reconciliation contract, the 2,000-session case is bounded in both renderer work and server request count.

---

## 12. Shiki / syntax-highlighting admission

Mobile uses:

- `shiki/core`;
- the JavaScript regex engine instead of Oniguruma/WASM;
- zero initially loaded grammars;
- per-language single-flight loading;
- direct `github-dark` theme import;
- direct statically enumerable imports for only mobile-supported grammars.

The first implementation still imported `shiki/langs` and `shiki/themes` registries. Runtime loading was lazy, but Vite had to consider the entire language/theme catalogs reachable and emitted hundreds of otherwise unused chunks.

Constraining the imports reduced the production transform graph:

- before direct language/theme imports: **581 transformed modules**;
- after: **323 transformed modules**;
- reduction: approximately **44%**.

Isolated headless-Chromium probe after the final import change:

| metric | result |
| --- | ---: |
| page ready before highlight probe | ~510 ms |
| highlighter module import | ~2.3 ms |
| first TypeScript highlight | **120.5 ms** |
| warm TypeScript median | **0.3 ms** |
| warm TypeScript p95/max | ~0.4 ms |
| cold TS heap increase | ~6.69 MB |
| measured Shiki/theme/TS/Python transfer | **351,573 bytes** |

The earlier registry-based isolated run transferred ~409,130 bytes for the same measured resource set, so the direct-import version reduced that probe by roughly **14%** while also eliminating the huge unreachable build graph.

First-load timing of an additional grammar is network/dev-server dependent (Python was 118 ms in the final cold probe, dominated by its module fetch); subsequent highlighting remains cheap. There is no app-start prewarm: a phone pays this only when a code fence actually needs the grammar.

---

## 13. Push cold/warm navigation

The push audit found two correctness bugs:

1. warm `PUSH_NAVIGATE` changed `activeSessionID` without running the real session selection/hydration path, so it could show the target title over the previous session's messages;
2. cold notifications used `/session/:id` as a document URL, which collides with the same-origin session API route and can return API JSON instead of the PWA shell.

The canonical notification URL is now:

`/?session=<id>`

The app accepts that query form plus the legacy `/session/:id` shape for compatibility. Both warm and cold paths converge on the same parser and real `selectSession()` behavior.

Deep targets outside the current 2,000-row list window are resolved on demand by exact session ID before hydration.

Chromium proof:

| path | time to requested session |
| --- | ---: |
| cold root-document launch | **~748 ms** |
| warm PUSH_NAVIGATE | **~35.7 ms** |

Both landed on the expected target session.

---

## 14. Final validation

### Mobile

- **163 pass / 0 fail / 342 assertions** across 19 files.
- `tsc --noEmit`: clean.
- production Vite build: clean.
- final main app chunk in latest build: approximately **801.49 kB minified / 232.44 kB gzip**.
- production build still emits Vite's >500 kB chunk warning; that is a general bundle-splitting concern, not a regression in the bounded runtime paths audited here.

### Protocol

- `tsgo --noEmit`: clean.

### Server

- serializer: **4 pass / 0 fail / 41 assertions**.
- `tsgo --noEmit`: clean.

### SDK

- SSE transport: **8 pass / 0 fail / 20 assertions**.
- `tsgo --noEmit`: clean.

### Real instance HTTP/SSE matrix

- **15 pass / 0 fail / 454 assertions** across six focused event/location files with the package's canonical 30 s timeout.

The earlier single unnamed `afterEach` red was reproduced as a test-runner timeout configuration issue: the location suite passes standalone, but its real instance/DB fixture cleanup can exceed Bun's default 5 s hook timeout. The package's canonical test command already uses `--timeout 30000`; rerunning the combined matrix with that timeout is fully green.

---

## 15. Remaining non-blocking observations

These are not failures of the campaign's contention/replay definition of done:

- The main mobile app chunk remains >500 kB minified and Vite warns about it. A future bundle/startup campaign can attack that independently without reopening the transport/rendering architecture.
- Shiki's C++ grammar is intrinsically large (~638 kB minified chunk in the latest production output), but it is an isolated lazy grammar and therefore does not tax users who never open a C++ fence.
- Current production chat history is capped at 100. The >160 virtual path was intentionally retained as a future/pathological safety boundary rather than used unconditionally.
- Compatibility servers necessarily have weaker APIs and can still require per-directory status requests; those calls are deduplicated and concurrency-bounded instead of removed by pretending old servers support the V2 global snapshot.

---

## 16. Final architectural conclusion

The mobile path now obeys the same contention principles established by the desktop/server campaign:

1. **Session-local work stays local.** A background token does not wake whole-session runtime/list analytics.
2. **Queues are bounded by count and bytes.** Slow painting cannot create unbounded renderer or shared-server pressure.
3. **Adjacent deltas are ropes/fragments, not repeated growing-string concatenation.**
4. **Reconnect is replayable.** Last-Event-ID is preserved across ordinary network churn and outer stream restarts.
5. **Liveness is not hydration.** `server.connected` does not trigger snapshots.
6. **Repair is explicit and scoped.** A transport gap repairs authoritative global/active/current-session state; local renderer loss repairs only the affected active session.
7. **Fanout is bounded and shared serialization is reused.** Multiple mobile subscribers do not multiply schema encoding or legacy bridge work.
8. **High-frequency updates have narrow Solid invalidation.** Token-rate message writes target one store slot; structural analytics use explicit structural revisions.
9. **Expensive parsing/rendering is admitted lazily.** Deep history, jumbo tool bodies, and syntax grammars only pay their cost when actually needed.
10. **The phone is allowed to slow itself, but not the desktop server.** Hidden mobile sockets close, renderer overflow is local, and request fanout is globally or concurrency bounded.

Against the measured adversarial matrix—flaky reconnect, replay gaps, four concurrent subscribers, 8 MiB tool output, 100 KiB Markdown/code, 2,000/5,000 session lists, 5,000-message chat history, push cold/warm navigation, and first-fence Shiki admission—the design is now defensible.
