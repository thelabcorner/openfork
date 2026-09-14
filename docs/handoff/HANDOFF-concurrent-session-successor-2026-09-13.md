# Handoff Prompt: Own the Concurrent-Session Architecture Fix

You are taking over an active, heavily instrumented concurrency/responsiveness effort in:

`/webstormprojects/opencode`

Your predecessor has finished the scout phase. **You are not a scout. You are now the primary implementation agent.**

Your mission is to review the evidence, challenge it, re-rank it, and then **patch the remaining architecture and concurrency defects comprehensively** until concurrent OpenCode sessions no longer clog one another through shared event-loop work, shared SQLite paths, process-global fan-out, coarse renderer projection, oversized mutable aggregates, machine-wide admission mistakes, or background resource amplification.

Do not merely apply the numbered findings mechanically. The goal is a robust architecture, not a checklist.

---

## Current status: final closing implementation/audit pass completed

The implementation wave described by this handoff has now been executed **and a second closing pass has re-audited the server, transport, renderer, Markdown, Explorer, Context, tab-preview, Changes/VCS, reconnect, hidden-renderer, and browser-benchmark surfaces** in the dirty worktree. The original scout findings below are retained as design history. The concise final evidence matrix is now in:

`docs/handoff/CLOSEOUT-concurrent-session-contention-2026-09-13.md`

The historical-to-current architecture mapping remains at the top of:

`docs/handoff/AUDIT-concurrent-session-contention-scout-2026-09-13.md`

The major architectural changes are:

1. Active runners keep an incremental sequence-aware history projection instead of reloading/decoding full post-compaction history on every provider turn.
2. EventV2 supports location- and aggregate-scoped listener routing, and filesystem watcher drains are cooperatively chunked.
3. Renderer V2 reductions explicitly distinguish unchanged, incremental, and structural message projection so control traffic no longer clones/reconciles full histories or destroys the hot stream index.
4. Tool progress/settlement is projected through a small sidecar overlay. Jumbo durable event bodies are content-addressed and cooperatively staged outside the semantic writer transaction; the final event commits a tiny reference. Payload metadata refcounts committed users and startup cleanup reclaims old zero-ref crash residue.
5. Cold ChunkDB worker completions are parsed through a byte-accounted, one-jumbo-per-timer-turn completion queue rather than several `JSON.parse` calls landing back-to-back.
6. Foreground shell admission is resource-classed: known simple wait/network/log commands use a bounded I/O pool while builds/tests/typechecks/unknown/compound commands stay in the conservative heavy pool.
7. Background renderer session caches are bounded by approximate retained bytes as well as count, without adding token-rate accounting.
8. Session-context state is written once through the durable projector rather than once directly and again during event projection.
9. The browser transport distinguishes liveness reconnects from actual replay gaps, reconstructible pressure repairs only the owning session, and hidden/uninterested sessions discard reconstructible content before renderer adaptation/queueing.
10. Timeline topology is structurally indexed and referentially stable: content-only streaming does not wake global turn grouping/row flattening, while mounted rows consume live text directly.
11. Markdown projection/highlighting transport is append-oriented; growing-prefix proofs were removed from the desktop renderer, structural reparsing is tail-local where grammar permits it, and the Marked lexer has a conservative exact-fallback incremental path.
12. Project Explorer search is generation-cancelled and cooperatively sliced; huge drag payloads are bounded; inactive clean editor buffers are byte-bounded and watcher-staled rather than eagerly reread.
13. Context analytics keep historical snapshots separate from live-assistant progress; raw history is progressively mounted and large previews are bounded.
14. Tab previews share one global four-request metadata lane and progressively mount large groups instead of multiplying concurrency per tab.
15. Changes/VCS refresh is visibility-gated. The final closing pass found and fixed two remaining defects: persistent Git failure could auto-retry through the dirty reactive latch, and on-demand `fetchQuery()` results were being written to a cache that a static placeholder could not observe. A disabled reactive query plus explicit refresh controller now owns the lifecycle.
16. The real Playwright timeline benchmark is now trustworthy after four separate harness failures were eliminated: frontend/backend port aliasing; ambient `NODE_ENV=development` contaminating production builds; production `location.origin` selection bypassing the intended explicit backend; and dual mock subscribers on frontend+backend ports destructively sharing one stateful fixture event queue. The final fixture persists/registers `127.0.0.1:4096`, asserts that encoded server route, and intercepts backend APIs/SSE on the backend port only.

Key final closeout measurements:

- warm runner history view at 5,000 rows: **7.72 us** versus **142.79 ms** cold materialization on the latest rerun;
- renderer control+delta pair at 10,000 messages: **~0.8 us** versus ~2.47 ms scout baseline;
- 8 MiB jumbo final semantic writer hold: **1.63 ms** on the latest adversarial run; Session B tiny durable commit was also **1.63 ms** while Session A published the 8 MiB payload;
- 4 x 16 MiB decompression completion burst: latest worst observed event-loop gap **22.73 ms** (historical pre-fix ~36.6 ms; prior post-fix run ~20.6 ms);
- mutable assistant stays below ~1 KiB after four separate 6 MiB tool settlements because historical tool bodies are not rematerialized into the base row.
- real Chromium 320-turn / 160-delta strict-backend production benchmark: **3.2517 s**, **49.21 deltas/s**, P95 rAF **16.7 ms**, max **16.8 ms**, **0 long tasks**, **0 >33 ms gaps**, **0 blank frames**, exact bottom anchor, no timeline/Markdown remount, and only **2** global topology projection runs;
- strict-backend 4x CPU Chromium run: **3.4024 s**, **47.03 deltas/s**, P95 rAF **33.4 ms**, max **66.7 ms**, with 14 gaps over 33 ms, 2 over 50 ms, and 0 long tasks;
- deliberately pathological strict-backend 30x CPU run still delivered **160/160** with 0 pending and exact anchor/identity preservation, but locally saturated the renderer (**283.90 s** total, P95 rAF **3.1165 s**, max **7.083 s**, 1068 long tasks / 239.1 s Long Task time). Worker request round-trip accumulated ~**476.3 s** while worker compute was only ~**317.6 ms**, showing renderer/main-thread service starvation rather than worker compute as the limiting resource;
- latest Project Explorer 50k all-match search: **17 cooperative slices**, **281.03 ms total**, **13.37 ms worst slice**; superseded generations publish no stale result;
- 50k selected-file drag transfer builds its bounded payload in **~0.95 ms** without traversing/serializing the whole selection;
- latest Context 5k-message raw history window selects **200 rows in ~0.040 ms**; an 8 MiB body is reduced to a **24,579-char** preview in **~0.174 ms**;
- 100 rapid tab-preview hydration tasks never exceeded the single global **4-request** lane; grouped previews page at **80 rows**.

Final focused validation is green across the current tree: core contention subset **53/53 / 450 assertions**, EventV2 **55/55**, core migrations **19/19** plus clean migration-generation check, session-ui Markdown/components **205/205 / 1628 expectations** with a clean session-ui typecheck, OpenCode queue/filesystem/shell subset **24/24**, server replay **6/6** with a clean server typecheck, final app closeout subsets **31/31 + 30/30** under the appropriate Solid/browser conditions, Context metrics/raw-history **72/72**, performance environment/port/mock guards **8/8** with a clean E2E TS project, and the final strict-backend production browser benchmark passes at 1x, 4x, and 30x CPU throttle. Full `packages/app` typecheck remains nonzero with **47 diagnostic lines** confined to unrelated dirty-tree React context-history/context-ledger, oversized SDK inference, old `server-session.test.ts` typing, and chat-sidebar diagnostics. The two `server-sdk.test.ts` diagnostics attributable to this campaign were fixed during final attribution; no closeout-touched file remains in the diagnostic set.

Two caveats are intentionally preserved. In-memory ChunkDB tests/benchmarks log `ocdb_meta` missing when semantic pruning starts against fixtures that do not initialize that metadata table; the sealer backs off and the targeted tests pass, so this is recorded as a harness warning rather than hidden. Also, `packages/mobile/src/markdown/stream.ts` still has growing-prefix `startsWith(previous.text)` logic; the concurrent-session campaign validated and optimized the desktop/app/session-ui renderer, not the separate mobile Markdown implementation.

No unrelated dirty state was reset, restored, cleaned, stashed, committed, or pushed.

---

## 0. Authority transition: this handoff supersedes the scout-only rules

Start by reading:

1. `docs/handoff/AUDIT-concurrent-session-contention-scout-2026-09-13.md`
2. `docs/handoff/HANDOFF-concurrent-session-audit-scout.md`
3. `docs/handoff/HANDOFF-concurrent-sessions.md`

The first two documents were written under a **read-only scout mandate**. That mandate is historical now.

For this successor task:

- You **may and should patch production code and tests**.
- You should run focused benchmarks and regression tests.
- You should update the audit/handoff documentation when conclusions materially change.
- Do **not** commit, push, restore, reset, clean, stash, or rewrite unrelated Git state unless the user explicitly asks later.
- The worktree is extremely dirty and contains unrelated user work. Preserve it.

At handoff time `git status` reports roughly **123 tracked/untracked entries**. Treat every pre-existing modification as user-owned unless you can prove it belongs to this concurrency effort.

Before editing a file, inspect its current dirty diff or at minimum read the exact current source. Never overwrite an unrelated hunk because you remember an older version.

---

## 1. The actual goal

The failure mode is broader than “one request is slow.”

We are trying to eliminate this class of behavior once and for all:

> One active/pathological session, or several sessions doing ordinary coding work at once, make unrelated sessions and/or the desktop UI progressively feel clogged, delayed, frozen, red/disconnected, or tool-stalled. Responsiveness improves again when concurrent work subsides.

You should think in terms of **coupling mechanisms**. Independent sessions become non-independent when they collide on one of these:

- the single server JS event loop
- a synchronous Bun/SQLite native call
- SQLite's one-writer rule
- a process-global listener array
- a machine-global semaphore/slot pool
- an O(history) or O(message size) transform on every event/turn
- a renderer-wide Solid reactive invalidation
- shared worker completion bursts
- large inline payload copies
- a cache that is bounded by count but not bytes
- filesystem/Git activity that fans out to every cached project
- background work whose cost is paid by foreground sessions

The final architecture should make session-local work stay session-local whenever possible and make unavoidable global work bounded, byte-aware, cooperative, observable, and cheap.

---

## 2. Core reasoning method: verbally simulate the request through the code

Use this deliberately throughout the task.

Do not only stare at abstractions or grep for locks. **Narrate the request as if you are the runtime.** This is the closest thing to rubber-duck execution and it exposes architectural nonsense quickly.

For every suspect path, say something like:

> “Session A receives a tool result. The provider callback enters X. X publishes event Y. Before commit, Y schema-encodes Z. Then the global `IMMEDIATE` writer is acquired. The projector reads the entire assistant, decodes it, clones/produces it, schema-encodes the entire aggregate, rewrites the row, inserts the event, releases the writer, then every EventV2 listener is invoked. The desktop SSE serializer frames the payload, the renderer queue accepts it, background gating does/does not discard it, then `projectV2()` mutates/reconciles the Solid store.”

Then ask:

1. **Does that verbal story sound architecturally sane?**
2. Which steps are proportional to session history, assistant size, project count, listener count, payload bytes, or number of active sessions?
3. Which step is holding a scarce shared resource while doing work unrelated to that resource?
4. Which work is repeated even though the logical state change is tiny?
5. Which work could be represented by an immutable reference instead of copying bytes?
6. Which step could be session-keyed/location-keyed instead of process-global?
7. Which “background” step still runs on the foreground event loop?
8. If Session B starts at the same instant, where exactly does B have to wait?
9. If you say the path out loud and a sentence sounds absurd, stop and investigate that sentence.

Do this before designing each patch and again after the patch. The second narration should be obviously simpler.

Example after a good patch:

> “Session A emits a control-only rename. The reducer updates session metadata, returns no message projection delta, and the timeline store does nothing. No history clone, no full reconcile, no stream-index invalidation.”

That kind of verbal simplification is a strong architectural signal.

---

## 3. First action: review and re-rank the scout audit before touching architecture

Read the full living audit:

`docs/handoff/AUDIT-concurrent-session-contention-scout-2026-09-13.md`

Do **not** assume the predecessor's ranking is correct merely because it is measured.

For each candidate:

- reproduce the causal chain verbally from current source
- verify line/symbol references against the dirty worktree
- inspect whether a newer dirty patch already changes the mechanism
- distinguish “blocks all server JS” from “blocks only durable writes” from “queues only tools” from “hurts only the foreground renderer”
- prefer a fix that removes the shared coupling over a local micro-optimization
- merge candidates when one architectural fix solves several
- demote anything whose ordinary trigger frequency is too low

Then rewrite/re-sort the ranked table before the main implementation wave. The audit is a living decision document, not sacred history.

---

## 4. Current ranked findings from the completed scout pass

These are the predecessor's final live rankings. Re-rank them yourself before implementation.

### Rank 1: synchronous runner-history materialization before every provider dispatch

Files:

- `packages/core/src/session/runner/llm.ts`
- `packages/core/src/session/history.ts`
- `packages/core/src/session/message-projection.ts`
- `packages/core/src/database/sqlite.bun.ts`

Current production story:

1. Every V2 turn attempt enters `runTurnAttempt()`.
2. Before `llm.stream(request)`, it calls `SessionHistory.entriesForRunner(readDb, session.id, baselineSeq)`.
3. History executes an unbounded SQLite `.all()` over post-compaction projected messages.
4. Every row is materialized and decoded into canonical `SessionMessage` objects.
5. This is synchronous Bun/SQLite plus synchronous JS/schema/object construction on the one server event loop.
6. A dedicated `readDb` avoids writer-connection head-of-line blocking, but **does not make SQLite or decoding asynchronous** and does not stop reader-reader/event-loop contention.

Measured with the exact production helper against an isolated in-memory DB:

- 100 rows, warm median: **11.57 ms**
- 1,000 rows, warm median: **41.23 ms**
- 5,000 rows, warm median: **163.19 ms**
- one 6 MiB assistant row: **~9.35 ms**

First-run measurements were ~19.7 / 51.1 / 193 ms respectively.

This is especially important because it occurs **on every turn**, not only pathological media cases.

Likely architectural direction:

- Maintain/cache a **runner-ready immutable history/context projection** keyed by authoritative sequence/context epoch/compaction boundary.
- Incrementally append/decode only new projected rows rather than rebuilding the whole post-compaction context every turn.
- Invalidate/rebuild only across compaction/context replacement or an authoritative structural change.
- If a full rebuild is unavoidable, chunk it cooperatively by row/byte budget so one session cannot own the event loop for 160+ ms.
- Do not assume “add more SQLite read connections” fixes this. The dominant decode/materialization work is still on the same JS thread.

Critical invariant:

Provider context must be **exactly ordered, replay-correct, compaction-aware, and sequence-consistent**. A stale runner cache is worse than a slow runner.

### Rank 2: watcher bursts multiply through the process-global EventV2 listener array

Files:

- `packages/core/src/filesystem/watcher.ts`
- `packages/core/src/event.ts`
- `packages/core/src/filesystem/index-watcher.ts`
- `packages/core/src/filesystem/search.ts`
- `packages/core/src/search/index-service.ts`
- `packages/core/src/location-services.ts`

Current story:

1. Parcel watcher can leave up to **4,096 unique pending paths**.
2. `Watcher.drain()` publishes one generic `file.watcher.updated` EventV2 event per path.
3. It does not `yieldNow` until the whole current batch is published.
4. EventV2 owns one process-wide `listeners[]` array.
5. Live events invoke multiple listeners sequentially.
6. Every cached Location layer contributes several listeners.
7. Most location consumers filter `event.location` **inside** the callback, so foreign-location callbacks are still invoked.
8. Location layers have a 60-minute idle TTL.

Measured 4,096-event live bursts with real EventV2 and no-op listeners:

- 0 listeners: **55.73 ms**
- 10 listeners: **78.43 ms**
- 30 listeners: **111.36 ms**
- 100 listeners: **258.20 ms**

Those are lower bounds. Real callbacks normalize paths, touch maps/queues, update indexes, and feed SSE.

Likely architectural direction:

- Route events by location/type before invoking irrelevant subscribers, not after.
- Prefer a location-keyed or typed+location subscriber registry over one global fan-out array for high-rate scoped events.
- Consider a **batched watcher event** rather than thousands of generic events.
- Add cooperative yield/wall-clock chunking inside watcher drain even if batching is retained.
- Preserve terminal create/change/unlink semantics and stale/re-list repair behavior.

### Rank 3: control/no-op V2 events reconcile the entire renderer session history

Files:

- `packages/app/src/context/server-session-v2-reducer.ts`
- `packages/app/src/context/server-session.ts`
- `packages/app/src/context/server-sync.tsx`

Current story:

1. Some events such as renamed/paused/resumed/moved/retried/etc. do not alter projected messages.
2. Reducer branches still return `messages: [...source]` with `touched: []`.
3. `projectV2()` reads that full messages array and executes Solid `reconcile(messages)`.
4. **Only afterward** does it notice `touched.length === 0`.
5. The same non-whitelisted event also invalidates the reducer stream index, so the following delta may rebuild positional indexes.

Measured reducer-only rename+delta pair, excluding Solid reconcile:

- 100 messages: **25.83 us**
- 1,000: **126.66 us**
- 5,000: **1.2318 ms**
- 10,000: **2.4653 ms**

Steady indexed deltas were approximately **0.5-1 us**.

Likely architectural direction:

- Give reductions an explicit semantic kind, e.g. “message projection unchanged”, “single message replacement”, “single assistant content replacement”, “structural full replacement”.
- A control-only reduction should not materialize `messages`, call Solid reconcile, or invalidate positional indexes unless it truly changes message structure.
- Prefer maintaining stream indexes through metadata-only events instead of blanket invalidation.

Do not implement this with a fragile event-name skip list if a stronger reduction invariant is possible.

### Rank 4: jumbo Tool.Success rewrites the whole assistant while holding the global durable writer

Files:

- `packages/core/src/tool-output-store.ts`
- `packages/core/src/session/runner/publish-llm-event.ts`
- `packages/core/src/session/message-updater.ts`
- `packages/core/src/session/projector.ts`
- `packages/core/src/event.ts`
- `packages/schema/src/session-event.ts`
- `packages/schema/src/session-message.ts`

Important nuance:

- Local tool media is **not duplicated** in the durable success event anymore; there is a regression test asserting one base64 copy.
- Nevertheless, one copy is intentionally unbounded for native media. A 6 MiB base64 image is explicitly supported/tested.

Current story:

1. Tool.Success contains the large ToolContent.
2. Session projector loads/decodes the existing assistant aggregate.
3. Immer updates one tool state.
4. The **entire assistant aggregate** is schema-encoded again.
5. The entire `session_message.data` row is rewritten.
6. The durable event is inserted.
7. All of that projector work occurs inside the global `IMMEDIATE` transaction / single SQLite writer slot.

Measured through the actual EventV2 + SessionProjector stack with isolated in-memory SQLite:

- 1 MiB: **7.88 ms**
- 4 MiB: **17.29 ms**
- 6 MiB: **24.62 ms**
- 8 MiB: **27.54 ms**

Real disk can only be worse.

Likely architectural direction:

- Stop embedding multi-megabyte immutable tool bodies inside a frequently-mutated assistant aggregate.
- Externalize large tool media/structured bodies into an immutable content-addressed/value store and keep a typed bounded reference in projection/event representations.
- Consider narrower per-content/per-tool projection rows so one tool transition does not rewrite all prior assistant content.
- Do not create two independent large copies between event storage and projection.

This is high-risk because provider continuation, replay, export, forks, offline history, UI rendering, and managed URI/materialization semantics must keep working.

### Rank 5: stream-index invalidation on ordinary lifecycle interleaving

This is closely related to Rank 3 and may be best fixed together.

`createV2SessionReducer()` deletes a per-session positional stream index for every event outside an explicit whitelist. Ordinary tool/step/control interleaving can therefore make the next token delta rebuild message/content positional maps.

Prefer event semantics / structural revision tracking over a growing whitelist.

### Rank 6: cold ChunkDB rehydration still JSON-parses jumbo values on the main server thread

Files:

- `packages/core/src/database/decompress-pool.ts`
- `packages/core/src/event.ts`

Workers decompress bytes, but their completion callback runs:

`TextDecoder.decode(raw) + JSON.parse(...)`

on the main server thread.

Measured representative payload cost:

- 1 MiB: ~0.73 ms
- 4 MiB: ~2.43 ms
- 16 MiB: ~5.45 ms
- 32 MiB: ~10.51 ms

Four back-to-back 32 MiB parses: **~34.69 ms**.

Do not blindly “parse in the worker” without measuring structured-clone/transfer cost. A byte-aware completion scheduler, lower jumbo concurrency, or a representation that does not require giant JSON object reconstruction may be safer.

### Rank 7: every foreground shell command occupies the same 2-slot heavy-process budget

Files:

- `packages/opencode/src/tool/heavy-process-concurrency.ts`
- `packages/opencode/src/tool/shell-concurrency.ts`
- `packages/opencode/src/tool/shell.ts`
- `packages/opencode/src/tool/test.ts`
- `packages/opencode/src/tool/typecheck-scope.ts`
- `packages/opencode/src/util/machine-slot-budget.ts`

Current measured config:

- `availableParallelism() = 24`
- no override set
- `configuredHeavyProcessPermits() = 2`

Every foreground shell holds one permit for its entire lifetime regardless of whether it is a compiler/build or a mostly-idle `curl`, `sleep`, logs/tail, network wait, etc.

Two low-CPU foreground shell calls can therefore queue every unrelated shell, test, typecheck, sqlite-subprocess, SymPy, or archive-heavy operation across sessions.

This is a **tool-level clog**, not necessarily a UI/server freeze.

Likely direction:

- Preserve conservative heavy admission for builds/tests/compilers.
- Distinguish known low-CPU/waiting/I/O shell commands into another bounded pool, failing conservative for ambiguity.
- At minimum surface explicit “queued for machine heavy slot” progress so intentional admission is not indistinguishable from a dead tool.

### Rank 8: renderer history cache is count-bounded, not byte-bounded

Files:

- `packages/app/src/context/global-sync/session-cache.ts`
- `packages/app/src/context/server-session.ts`

Nominal cache limit is 40 sessions, but:

- cache slots do not account for bytes
- a 6-8 MiB media-heavy session costs the same slot as a small text session
- non-idle sessions and several interaction/inflight classes are protected from eviction
- therefore 40 is not a hard cap during concurrency

This may explain progressive GC degradation over time. Measure before making it a major rewrite.

Likely direction: lightweight approximate retained-byte accounting plus lower background budgets and authoritative rehydrate-on-foreground.

### Rank 9: SessionContext applyOps performs duplicate live + projector writes

Files:

- `packages/opencode/src/session/context/state.ts`
- `packages/opencode/src/session/context/projector.ts`
- `packages/core/src/event.ts`

`applyOps()` mutates ops/state directly, then publishes a durable event whose projector performs the same idempotent ops/state mutations again inside the shared `IMMEDIATE` transaction.

The API accepts an unbounded operation array. UI normally sends one op, so ordinary likelihood is lower, but bulk callers can create O(N) writer convoys.

Fix only after preserving crash consistency and replay semantics.

---

## 5. Important false leads already eliminated

Do not burn time rediscovering these unless current source has materially changed:

### SSE connection count / per-session frame serialization

- Normal desktop uses one selected SSE stream per server context, not one per active session.
- Native and legacy serializers weak-cache wire/frame serialization by event identity.
- First serialization of a jumbo event can still be a long JS task, but ordinary session count does not multiply it one-for-one.

### Default-on tracing

- Server EventTrace and renderer phase tracing are explicit opt-in now.

### BackgroundJob global registry lock

- Registry mutation is shared, but long waits/job execution are not performed while holding the registry synchronized reference.

### Checkpoint finalize directly blocks next turn

- Finalization is forked after turn completion. It can still consume machine I/O/CPU but is not an obvious foreground wait.

### ChunkDB sealer synchronous compression

Current environment had:

- `OPENCODE_SEAL_ENABLED=1`
- `OPENCODE_SEAL_DEDUP=1`
- `OPENCODE_SEAL_WORKERS=1`

So active compression uses a two-worker pool instead of synchronous main-thread compression.

### ChunkDB maintenance writer monopolization

Current code already uses:

- dedicated maintenance connection
- 100 ms busy timeout
- small sealer write slices (<=8 rows / <=512 KiB)
- pauses between slices
- semantic-prune slices with existing p99 foreground contention measurement around ~2.3 ms

Keep it monitored, but it is not the strongest current target.

### Duplicate location layers caused by fresh `Location.Ref` object identity

Measured:

- separate JS objects: `a === b` false
- `Equal.equals(a,b)` true
- identical Effect hash

LayerMap reuse is value/hash based, so fresh equivalent refs do not inherently multiply location services.

### One durable Tool.Progress per shell stdout chunk

The V1/compat tool bridge intentionally throttles `ctx.metadata()` to at most once per tool call every **500 ms**. Keep this protection.

### Hidden sessions still reduce giant content in the renderer

`packages/app/src/utils/session-stream-content.ts` classifies legacy/native text, reasoning, tool, shell, step, compaction, message and part content. Hidden-session heavy content is discarded before adaptation/byte accounting/renderer queue projection and repaired by authoritative hydration when foregrounded.

It can still hurt the **server** before it reaches the renderer.

### Duplicate full-repo search seed per location

`FileSystemSearch` chooses one backend. SearchIndex defaults on and owns the cold seed with machine-wide election. It does not simultaneously boot the old ripgrep seed.

---

## 6. Critical pre-scout production work already in the dirty tree

Do not accidentally regress these while fixing the next layer.

### Background projection ownership

- `server-session.ts sync()` accepts activation semantics so background hydration does not implicitly make a session foreground-active forever.
- Prefetch/background sync uses `activate:false`.
- Foreground repair has stale/gap handling and joins in-flight prefetch before authoritative refresh.

### SSE replay/live separation

- Replay is a direct finite prefix, not enqueued into the bounded live subscriber queue.
- Native and legacy instance/global replay paths use aligned byte budgets.
- Renderer socket reading is no longer paused by local reducer backlog.

### Renderer queue

- dual bounded by count + retained bytes
- overflow uses authoritative global hydration repair
- flush is wall-clock + count budgeted
- cleanup clears queued work instead of synchronously draining everything
- retained-memory byte accounting avoids double-charging shared `properties/current.data`

### Markdown worker

- single worker lane is treated as serial rather than posting many concurrent jobs into a FIFO worker.

### Durable SQLite transaction

- immutable event schema encoding and sparse checkpoint prep moved before `IMMEDIATE`.
- FTS update amplification was reduced/scoped in later work.

### Large-assistant lifecycle sidecar

- Step lifecycle metadata was separated from the giant assistant row so tiny step metadata transitions no longer rewrite a 1/4/16 MiB assistant aggregate.
- This does **not** solve Tool.Success, which genuinely changes assistant content.

### Project Explorer

- no eager recursive full-project hydration on initial root listing
- bounded lazy metadata caches
- targeted watcher refresh
- bounded pending paths/dirs
- tree identity preserved where possible

### Diagnostics

- expensive traces default off.

### Heavy-process admission

- CPU-heavy tool classes share one process/machine guard specifically to prevent many sessions from launching dozens of internally-parallel build/test trees.
- Do not “fix concurrency” by simply deleting this guard. Refine classification instead.

### Search / credentials / committed-state reads

- a persistent query-only `readDb` exists for file-backed DBs
- major committed-state session/history/search/credential reads were moved off the writer connection
- mutation precondition reads intentionally remain on writer where stale read would break correctness

---

## 7. Very important unfinished production patch: verify this before building on it

Immediately before the scout phase, the predecessor applied a final **lazy zero-copy V2 reducer/projector patch** and did not get a full verification pass before switching to read-only scouting.

The patch changed the reducer/projector boundary so high-frequency indexed changes can avoid:

- copying the full `session_message` array
- slicing the full assistant content array
- materializing a fallback full reduction unless a caller actually requests `reduction.messages`

The intended incremental union is conceptually:

```ts
type Incremental =
  | {
      kind: "assistant-content"
      index: number
      messageID: string
      partID: string
      partIndex: number
      content: Assistant["content"][number]
    }
  | {
      kind: "message"
      index: number
      message: SessionMessageInfo
    }
```

`projectV2()` is supposed to use Solid `produce()` to replace only the targeted content slot/message, and only materialize/reconcile the full messages array on a mismatch/fallback.

**Do not assume this final patch is green. Verify it first.**

Suggested focused suite:

```bash
cd /webstormprojects/opencode/packages/app
bun test --conditions=solid --preload ./happydom.ts \
  src/context/server-session-v2-reducer.test.ts \
  src/context/server-session.test.ts \
  src/utils/session-message.test.ts
```

Then search current source for stale names/accesses such as:

- old `normalizeSessionAssistantPart`
- removed `index.source`
- unguarded `incremental.message`
- unguarded `incremental.partID/partIndex/content`

Potential TypeScript concern from the predecessor: union narrowing around `existing`/`incremental.content` in `server-session.ts` may need explicit branch structure.

Potential semantic concern: nested Solid `produce` assignment must actually trigger the right reactive consumers without broad invalidation.

### Prior green test state before that final lazy patch

These were green at various points immediately before the last zero-copy refinement:

- server-session + reducer: ~84/84
- reducer/session/normalizer combined: ~88/88
- server-sdk: 24/24
- timeline: 21/21
- phase trace: 5/5
- core event trace/byte queue: 7/7
- native server replay: 5/5
- opencode replay/global: 5/5
- markdown worker: 7/7

Use the Solid browser condition for app tests where required:

```bash
bun test --conditions=solid --preload ./happydom.ts ...
```

Whole-package typecheck may contain unrelated pre-existing errors. Distinguish your regressions from baseline noise.

---

## 8. Where the predecessor literally stopped

The final active scout thought was checking whether **canonical provider-message lowering adds another major O(history/bytes) pass immediately after runner-history decode**.

Relevant file:

`packages/core/src/session/runner/to-llm-message.ts`

Source observations:

- `toLLMMessages(messages, model)` is a full `messages.flatMap(...)` traversal.
- Assistant lowering walks `message.content` and then separately filters/maps tool results.
- `ToolOutput.toResultValue()` generally returns references to existing structured/content values rather than JSON-stringifying/copying giant content.
- Previous pre-scout measurements in `HANDOFF-concurrent-session-audit-scout.md` already found canonical LLM lowering relatively cheap even on extreme synthetic shapes: roughly **4-5 ms for ~31 MiB text histories** and **~15 ms for 1000 completed tool messages**.

Therefore this was probably going to be folded into C9's end-to-end pre-dispatch cost rather than promoted as a separate dominant bottleneck, unless a new nonlinear/copying behavior is discovered.

What I wish I had measured before handing off:

1. Decompose C9 into:
   - SQLite `.all()` row materialization
   - projection-ref/OPCL rehydration
   - schema decode
   - `toLLMMessages`
   - compaction token/size analysis
2. Then benchmark **two concurrent runner starts plus one heartbeat/tiny live event** to prove actual cross-session scheduling delay, not merely isolated latency.

That decomposition will tell you whether the best patch is a runner-context cache, SQLite representation change, decode cache, cooperative chunking, or some combination.

---

## 9. Suggested implementation order

Do not follow this blindly. Re-rank first. But this ordering minimizes risk and tends to attack the broadest coupling first.

### Phase A: verify current dirty production patch and establish baselines

1. Run focused reducer/session tests for the unverified lazy patch.
2. Run existing concurrency/transport/markdown tests around previously-fixed invariants.
3. Capture small benchmarks so you can detect regressions after each architectural patch.
4. Read `git diff` for every target file before editing.

### Phase B: eliminate renderer no-op O(history) work

This is likely the easiest high-confidence fix with low architectural blast radius.

Target end-state verbal simulation:

> “Rename/pause/resume/move updates metadata/state. The reducer reports no message projection mutation. `projectV2` does not materialize messages, does not reconcile history, and does not invalidate the content stream index.”

Add adversarial equivalence tests covering:

- control event between text deltas
- control event between tool input/progress/success
- hydration mismatch fallback
- message insert/remove/reorder structural cases
- compaction replacement
- stale index cannot write the wrong part

Benchmark pure delta vs interleaved lifecycle at 100/1k/5k/10k history after the patch. It should be essentially flat for metadata-only interleaving.

### Phase C: runner-history architecture

This may be the largest ordinary-use win.

Do not start by adding random `yieldNow`s around the existing full rebuild. First decide what the authoritative cache/revision model should be.

Questions to answer explicitly:

- What exact durable sequence/revision proves the cached runner context is current?
- Can `SessionMessageProjector` expose append/update deltas suitable for a runner cache?
- Does every new event imply the provider context changes? Many lifecycle events do not.
- How does compaction atomically replace the active context prefix?
- How do context epochs/baselines affect the cache key?
- Can large immutable ToolContent references stay shared rather than decoded/recreated?
- Can runner cache memory be bounded by bytes and tied to active sessions?
- What is the repair path after process restart or cache miss?

Prefer an immutable or revisioned cache over mutating a giant shared array in-place without a correctness key.

Then build a two-session contention test, not just a single-session microbench.

### Phase D: EventV2 scoped fan-out / watcher batching

Do not special-case only the watcher if EventV2 can cheaply expose a generic scoped subscription API.

Potential architecture:

- subscribers register type and optional location/session scope
- high-rate scoped events resolve only matching subscribers
- general listeners remain available for true global observers
- watcher callback emits terminal per-path state in bounded batches
- matching location consumers expand/process locally
- SSE sees one bounded batched event or efficiently expands only once
- drain yields by count/time budget

But do not accidentally break consumers that depend on create+change ordering or git control paths.

Build a benchmark with 5-10 warm locations and prove foreign-location callback count drops toward zero.

### Phase E: large mutable assistant / Tool.Success representation

This is probably the deepest architectural fix.

The smell is straightforward when spoken aloud:

> “To mark one tool completed, we rewrite every previous tool result and media blob in the assistant.”

That should not be the long-term representation.

Possible directions:

- immutable blob/value store referenced from ToolContent
- separate `session_message_content` / assistant-part projection rows
- event payload stores content references above a byte threshold
- canonical message composition lazily joins metadata + part refs
- provider lowering materializes only the values actually needed

Be careful about `$cdbRef` / OPCL representation. Prior work explicitly warned that projection rows cannot be blindly JSON-patched because stored values may be reference envelopes rather than inline canonical JSON.

Add tests around:

- local media tool success
- provider-executed tool result
- replay/rebuild from durable events
- export/fork
- history API
- UI rendering
- provider continuation after restart
- missing/corrupt referenced blob

### Phase F: machine/process policy and memory refinements

After the dominant shared event-loop/write paths are fixed:

- classify foreground shell resource usage more accurately
- expose slot-wait progress
- add byte-aware renderer history retention
- remove duplicate SessionContext writes while preserving replay atomicity
- smooth cold ChunkDB parse completions by byte budget

---

## 10. Testing philosophy for this task

Do not settle for “unit tests pass.” This is a concurrency architecture effort.

For each important patch, require at least three layers:

### 1. Correctness/equivalence tests

Prove the optimized path yields the same authoritative state as the fallback/rebuild path.

Examples:

- optimized V2 part update == full normalization output
- cached runner context == fresh full history reconstruction
- batched watcher terminal state == sequential watcher event terminal state
- externalized ToolContent == inline ToolContent after replay/materialization

### 2. Adversarial concurrency tests

Run two or more unrelated sessions and assert one pathological workload does not explode latency in the other.

Prefer measuring p50/p95/p99 rather than one elapsed time.

### 3. Scaling benchmarks

Vary the dimension the architecture claims to remove:

- history rows 100 / 1k / 5k / 10k
- assistant content entries 10 / 100 / 1k
- payload bytes 1 / 4 / 8 / 16 / 32 MiB
- EventV2 listeners 0 / 10 / 30 / 100
- watcher paths 32 / 128 / 1k / 4k
- warm locations 1 / 5 / 10
- active sessions 1 / 2 / 4 / 8

The desired result is not merely “faster.” The slope should change.

If the old path is O(N) and the new hot path is supposed to be O(1), prove near-constant scaling.

---

## 11. Performance mindset: remove work before parallelizing it

Avoid a common failure mode in concurrency work: adding more parallelism around wasteful work.

Order of preference:

1. **Do not do the work.**
2. Make it session/location keyed rather than global.
3. Make it incremental rather than full-state.
4. Share immutable data/reference it rather than copying.
5. Bound it by bytes and wall time.
6. Yield cooperatively if it must remain on the main thread.
7. Move it to a worker only if transfer/clone costs are measured and favorable.
8. Increase concurrency only when the underlying resource genuinely benefits.

Examples:

- Better than parsing four 32 MiB values in four workers and cloning objects back: avoid needing four giant objects at once.
- Better than four SQLite readers all decoding 5k messages on one JS thread: stop reconstructing 5k messages every turn.
- Better than invoking 100 listeners faster: do not invoke 97 irrelevant listeners.

---

## 12. Correctness invariants you must protect

### Event ordering

- Per-session streamed content order must remain deterministic.
- Replay/live collision must not duplicate or lose state.
- Watcher create/change/unlink terminal semantics must remain correct.

### Session history

- Provider context must contain exactly the correct post-baseline/compaction ordered messages.
- No stale runner cache after compaction, revert, context replacement, tool completion, or process restart.

### Background/foreground ownership

- Hidden sessions may discard reconstructible content only because authoritative hydration repairs it.
- Foreground activation must repair a known content gap before accepting deltas onto an incomplete base.

### Durable event/projector atomicity

- Projection and durable event sequence must not diverge on crash.
- Replay must rebuild the same projection.

### Tool output

- Media/structured output must survive replay, fork, export, provider continuation, and UI hydration.
- Do not silently truncate media for model context just to make storage faster.

### SQLite

- Mutation decisions must not be based on stale `readDb` snapshots where write-side atomicity is required.
- Maintenance should remain lower priority than foreground writes.

---

## 13. Dirty-worktree discipline

This repository currently contains many simultaneous efforts, including unrelated markdown-path UI work, factory-reset storage work, and other changes.

Examples of unrelated or potentially unrelated dirty files at handoff include:

- `packages/app/src/components/markdown-path-resolve*`
- `packages/app/src/components/markdown-target*`
- `packages/opencode/src/storage/reset-local-data.ts`
- associated tests/e2e files

There are also many concurrency-related dirty files, migrations, generated schema/sdk files, etc.

Rules:

- Never restore a whole file to HEAD just to simplify a patch.
- Never use broad formatting over the repo.
- Never `git add -A`, commit, push, reset, clean, or stash unless the user asks.
- Before changing generated artifacts, understand whether the source generator must be updated instead.
- Watch line-ending churn. Earlier diffs showed CRLF/LF whole-file noise in some core files.
- Keep changes surgical but architecturally coherent.

---

## 14. Documentation debt / stale comments to clean only when touching those areas

Known stale commentary from earlier passes:

- `packages/opencode/test/server/httpapi-event-replay.test.ts` may still describe replay being enqueued into the subscriber queue.
- explorer `tree-store.ts` has an old “starts fresh + prewarms” style comment.
- `packages/opencode/script/bench-project-switch.ts` may describe a BEFORE baseline inaccurately.
- `packages/core/src/filesystem/index.ts` header wording may no longer match lazy index architecture.
- watcher tests may still say “invalidates parent” where implementation now refreshes incrementally.

Do not prioritize comment cleanup over concurrency fixes, but do not leave newly-wrong architectural comments behind.

---

## 15. What I wish I knew at the beginning

This is the context that would have saved the predecessor the most time:

1. **The dominant enemy is synchronous work on the one server JS thread, not merely SQLite locks.** A second DB connection solves connection-level head-of-line blocking but not 160 ms of row materialization/schema decode.
2. **Count-bounded is not byte-bounded.** A single 8 MiB event/history can invalidate assumptions built around “only 40 sessions” or “only 4096 queue entries.”
3. **A tiny logical state transition can still rewrite a huge physical aggregate.** Always compare logical mutation size to physical bytes touched.
4. **Process-global listeners create invisible N-location multipliers.** Filtering inside callbacks is too late for high-rate streams.
5. **The server and renderer have different concurrency failure modes.** A hidden session may be correctly gated in the renderer and still monopolize server SQLite/event-loop work.
6. **Admission control can look like deadlock to the user.** If a queue is intentional, surface the wait state.
7. **Do not trust “background” as a performance guarantee.** A background Effect can still perform synchronous native/JS work on the same event loop.
8. **Do not trust “workerized” as complete offloading.** In ChunkDB, decompression is off-thread but JSON parse/object creation is still on-thread.
9. **Do not blindly optimize serialization fan-out.** Current SSE has identity caching and one stream per context, so that attractive theory was weaker than it looked.
10. **The best patches made the verbal runtime story shorter.** When a fix requires explaining more exceptions than the bug, the architecture is probably getting worse.

---

## 16. Success criteria

Do not declare victory because individual microbenchmarks are green.

The end state should satisfy all of these:

### Ordinary multi-session behavior

- Starting/continuing a long-history session does not visibly delay another session's provider dispatch or SSE heartbeat.
- Two to four active coding agents can stream/tools concurrently without progressive UI clogging.

### Filesystem storms

- A 4k-path branch/install/build watcher burst in Project A does not create a 100-250 ms process-global listener fan-out stall for Project B.
- Foreign-location listeners should not run per path.

### Renderer

- Metadata/control events remain near O(1) with respect to session history.
- Token/tool-content updates touch only the necessary reactive slot.
- Background content remains gated and repairable.

### Durable storage

- Small durable events do not wait tens of milliseconds behind an unrelated session's giant mutable aggregate rewrite.
- Large tool/media content no longer causes repeated rewriting/copying of all prior assistant content.

### Memory

- Retention is byte-aware enough that media-heavy histories cannot silently grow renderer heap without bound just because session count is modest.

### Tools

- Intentional machine admission remains safe under CPU-heavy builds/tests.
- Long low-CPU shell waits do not unnecessarily starve every unrelated tool class.
- Users/agents can tell when a tool is queued rather than hung.

### Regression safety

- Replay/rebuild equivalence remains intact.
- Provider context remains exact.
- Tool media survives restart/fork/export/history.
- Existing focused concurrency suites remain green.

---

## 17. Reporting style during your successor run

Work continuously; do not wait until the end to reason.

As you go:

1. Re-rank the living audit when evidence changes.
2. For each patch, record the old verbal execution story and the new one.
3. State what shared resource was removed or bounded.
4. Record the benchmark slope before/after.
5. Note rejected alternatives and why.
6. Keep tests beside the architecture they protect.

The user wants a **comprehensive investigate -> conclude -> patch loop**, not a one-shot code dump.

When you think you are done, perform a fresh adversarial sweep from scratch. Ask:

> “If I wanted one session to make every other session miserable, what remaining shared path would I abuse?”

Then try to prove yourself wrong.

---

## 18. Final message from your predecessor

The repo has improved substantially already. Several earlier catastrophic multipliers are gone: replay/live queue coupling, background activation leaks, broad FTS rewrites, redundant Git start-snapshot convoys, socket-reader backpressure, default tracing overhead, and multiple O(history) token-path operations.

But the remaining findings show the same deeper pattern in different forms:

**session-local logical work is still too often represented as process-global synchronous work or as mutation of large shared aggregates.**

That is the architecture to keep attacking.

Do not be afraid to redesign a seam when the current representation forces absurd work, but make every redesign prove its correctness and scaling law.

Use the verbal simulation method relentlessly. If you can describe exactly why Session A must wait for Session B and the sentence sounds unnecessary, that sentence is your next patch target.

Start by reviewing and re-ranking the audit. Then verify the unverified lazy reducer patch. Then proceed comprehensively until the major shared coupling mechanisms are removed, not merely hidden.
