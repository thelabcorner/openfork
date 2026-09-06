# Event delivery and concurrent-session audit

## Changes

- Replaced the renderer's nested delta accumulator with an ordered queue. The old accumulator omitted event type from V2 coordinates, emitted dirty deltas before queued lifecycle events, and had inconsistent snapshot/deletion barriers. It could also retain empty directory/message maps. The replacement coalesces independent delta fields only between lifecycle/snapshot barriers, without mutating incoming payloads.
- Drain at most 128 input events per renderer task; pause event iteration at 1,024 pending events. This bounds application-level read-ahead and permits input/render tasks between drains. These are event-count limits, not byte limits or a guarantee that an individual reducer is fast. Browser/network buffers remain separate.
- Coalesce interleaved V2 sessions as well as V1 parts; include event type and unambiguous tuple keys so text, reasoning, tool input, directories, and sessions remain distinct.
- Yield during discarded legacy sync traffic too. Previously that early continue bypassed the stream's cooperative yield.
- Reset reconnect backoff only after sustained delivery over 30 seconds. A readiness event followed by immediate disconnection no longer resets it. Unexpected clean EOF now marks liveness dead and increases backoff.
- Refresh batches wait for both requests to settle, even if one rejects or throws synchronously. Failures previously allowed subsequent batches to overlap surviving requests. Disposal clears pending work and prevents future scheduling, including after an in-flight request completes.
- The active `/api/event` endpoint now schema-encodes and serializes a published object once across subscribers. Weak object keys avoid retaining a fixed history of large serialized payloads and avoid ID collisions between distinct representations. Encoding still happens downstream of publication and still validates the schema.

## Verified

- 35 renderer tests across server SDK, refresh queue, V2 reducer, and server sync.
- Includes 32 concurrent sessions / 6,400 interleaved text and reasoning deltas compared against direct reducer execution, lifecycle ordering, nonmutation, 4,096 ordered events across queue compaction/refill, refresh failures, and disposal during active work.
- 3 server serialization tests, including proof that 32 additional subscribers do not re-read/re-encode the payload.
- 60 existing core event and run-coordinator tests. They cover independent session-key concurrency, same-key joining, self-wake trampolining, and isolation of overflowing subscribers.
- Server typecheck passes. App typecheck reports errors outside changed files, including React-style context components, prompt types, browser appearance imports, and a session-ui model field. Raw output: `.opencode/cache/event-loop-app-typecheck.txt`.
- Production builds completed before and after the event-queue change. Initial broad Playwright discovery picked up Bun-only tests; restricting to `timeline/session-timeline-benchmark.spec.ts` starts the scenario, but setup fails waiting for the session heading. No before/after latency metrics were obtained. Raw final output: `.opencode/cache/event-loop-benchmark.txt`.

## Remaining investigation

The desktop uses direct loopback HTTP/SSE for this stream, not per-token Electron IPC. The active native event endpoint already has a 256-event subscriber queue that fails an overflowing subscriber without blocking publishers; its existing isolation test passes. This protects publication but sustained overload still requires reconnect and state hydration.

Legacy `/event` and `/global/event` now use the same bounded subscriber primitive as the native endpoint. Overflow fails the stream after its accepted prefix; it does not block publication or silently continue after losing deltas. Listeners register before readiness and queues are released on scope cleanup. Instance disposal shares the ordered event queue. Core typed/wildcard PubSubs remain unbounded and require consumer-specific analysis; silently dropping append-only events would corrupt consumers.

Electron's installed file logger defaults to synchronous writes, and sidecar stdout/stderr feed logging. This remains a plausible separate main-process bottleneck under high log volume. Simply enabling its asynchronous option creates an unbounded write queue, so that switch alone is not a robust fix.

The sampled `concurrency: "unbounded"` calls in history/context loading often operate on fixed arrays of two or three jobs; those are not evidence of runaway session concurrency. Publication's semaphore is created inside a turn attempt, rather than imposing one global session lock. SQLite work, filesystem fan-out, individual expensive reducer/render tasks, and logging still need live profiling during an actual stall.

No running app/server was restarted. Server-source changes need the desktop sidecar rebuild and a later user-controlled launch before they affect that running process. There is no measured claim that all live stalls are eliminated.

## Follow-up verification and findings

- Durable replay now reads/rehydrates/decodes pages of 256 events, rather than the entire remaining history. Each historical or live wake drains all available pages before waiting again. A 520-event regression verifies cursor handling and delivery across page boundaries without a subsequent publish. All 48 core event tests pass, including replay/live handoff races and slow-subscriber isolation.
- The native and legacy subscriber helpers now use synchronous offer/failure inside one Effect callback, avoiding extra Effect continuations per delivered event.
- Legacy serializers share adapted payloads and serialized frames by weak object identity. This replaces the strong 1,024-ID cache that could retain large old payloads or reuse a frame for another representation. Both serialization tests and all three legacy event HTTP tests pass.
- Electron sidecar initialization cancels its polling timer and active request when the process exits. Previously the losing Promise.race branch could poll indefinitely. All three cancellation/success lifecycle tests pass.
- Unified SDK generation completed. The opencode package typecheck passes after the source changes. Core typechecking reports 87 errors in other test files, with none in `src/event.ts` or `test/event.test.ts`. Desktop typechecking remains blocked by app/dependency errors outside the changed desktop files.
- Benchmark discovery now excludes Bun-only test files. The mock supplies current skill/preferences/file responses rather than falling through to the SPA's HTML. The streaming benchmark now uses a real persistent in-test SSE response; previously each fulfilled request delivered a finite batch and closed, unintentionally measuring reconnect backoff. Two fixture tests pass.
- The production streaming benchmark passes with 320 history turns, 160 deltas, and deliberately severe 30x CPU throttling: all 160 deltas delivered, none pending, no row/markdown replacement, and no blank geometry samples. Completion was 177,786 ms; 578 long tasks occupied 159,774 ms. These are a working post-fix stress baseline, not a before/after speedup or normal-machine latency. Raw results: `.opencode/cache/event-loop-benchmark-persistent.txt`.
- Full CPU profile attachment support was added so subsequent opt-in profiles retain their raw samples instead of only the top 40 functions. The next profiling run could not start because C: reached zero free bytes. Space later fluctuated to approximately 14 MB, still insufficient for another production build/profile. Automatic approval review rejected removal of the generated app build with `blocked by policy`; no cleanup bypass was attempted.

Next measurement: run the persistent scenario at a documented lower throttle with CPU profiling enabled, resolve hot frames through production source maps, then compare the same scenario after a targeted renderer fix. Synchronous Electron logging and the remaining internal PubSub consumers still need live evidence before changing their loss/backpressure contracts.

## Continuation (second pass)

- Verified the overflow-close/reconnect/backoff loop end to end: overflow fails
  the bounded queue, the stream errors, backoff (250ms→15s, reset only after
  30s sustained delivery) reconnects, `server.connected` refetches the session
  list (bounded limit) plus a single home-index refetch on true reconnects,
  and mid-gap text self-heals at the next full-part barrier (`text-end`
  publishes full part state, which flushes pending deltas first). No
  per-reconnect messages refetch exists, so no refetch storm; no permanent
  staleness class except rare non-superseded events (e.g. a dropped
  `message.removed` lingers until navigation). Overflow finalizers
  (listener unsubscribe, GlobalBus off) run on request-scope close.
- Electron main-process file logger: confirmed electron-log v5 appends with
  `fs.writeFileSync` per line. Sidecar stdout/stderr lines plus spied renderer
  console all land there — hundreds of sync appends/sec under concurrent
  sessions. Fixed with a transport-level token bucket
  (`packages/desktop/src/main/log-throttle.ts`, pure + unit-tested):
  burst 200, 50/sec sustained, error/warn always pass, drops counted with an
  exact summary line. The transport async option was deliberately not used
  (unbounded queue). 6/6 helper tests pass; desktop typecheck shows no new
  errors.
- Core typed/wildcard PubSub analysis: the wildcard `all` stream has zero
  production subscribers (tests only); typed subscriptions are low-frequency
  user-interaction types (permission/question/session-status) with per-type
  hubs. No change needed; per-publish wakeup cost is O(1)-ish.
- New saturation harness `packages/core/test/event-saturation.test.ts`:
  6,000 realistic ~2KB publishes + 4 durable-write contenders + 12 listeners
  (incl. a per-event JSON.stringify and a scheduler-yield listener), asserting
  completeness, in-order delivery, p99 publish < 250ms, loop drift < 1s.
  Measured: p50=2ms p99=6ms max=28ms, max 10ms-tick gap 29ms. Notably, the
  same harness against pre-patch `notify` shows no latency delta at this
  scale — the historical win was volume (10x via coalescing) and removing
  stringify from the publish path, not fiber churn per se.
- Mock server: added `/quota/:providerID` "not configured" responses so usage
  hooks degrade instead of falling through to HTML (the remaining unhandled
  requests in the benchmark log).
- Fixed the persistent-SSE unit harness teardown race: `reader.cancel()`
  followed by socket destroy made Bun's body bridge close an already-closed
  controller (ERR_INVALID_STATE). Teardown is now abort-only with a stopped
  write cadence; helper also guards response 'error' and tracks timers.
  Stable across repeated runs.
- Ruled out as saturators (no change): per-event logging (only lifecycle/
  error logs on hot paths), Token.estimate (O(1) length/4), renderer delta
  apply (binary search + fine-grained store writes), snapshot track/patch
  (async git children), shell `preview()` (bounded rope ops), unbounded
  `Effect.forEach` sites (startup/CLI/shutdown/small-N only).

## Continuation (third pass)

- PTY delivery now has bounded socket-local outboxes in both HTTP surfaces
  (128 frames), with one ordered writer per socket. Native PTY attachments also
  cap the replay-to-live activation handoff at 2 MiB/256 chunks. A stalled
  terminal therefore closes and reconnects from its cursor instead of retaining
  output or blocking the PTY producer.
- The file watcher now deduplicates path/type notifications, keeps a bounded
  latest-update window (4,096 entries), publishes at concurrency 8, and yields
  between batches. The watcher finalizer stops the drain and clears pending
  work before native subscriptions are released.
- Startup and dynamic fan-out was audited across the app, core, server, LSP,
  MCP, plugins, formatting, quota, worktree, prompt, and session paths. The
  remaining high-cardinality reads use small worker pools; fixed-size joins
  remain parallel. Session-parent hydration is capped at 8 and preserves input
  order. This avoids request/fiber bursts when many sessions activate together.
- Native `session.*` events handled by the V2 reducer no longer pass through
  the legacy session reducer. Text, reasoning, tool-input, and compaction
  deltas return immediately after that reduction, avoiding directory/home/query
  fan-out for events that cannot affect those stores. The separate durable
  `session.next.*` family keeps its legacy path until it has a complete app
  reducer. A complete legacy `message.updated` can seed an unloaded session so
  a message arriving during the first history request is merged instead of
  lost.
- Session message normalization now indexes normalized message identities, so
  assistant-parent enrichment is linear in history length rather than repeatedly
  scanning prior messages. This is especially relevant when several long
  sessions stream concurrently.
- Multiple SSE streams were deliberately not added. The current bottleneck is
  the Electron renderer's single JavaScript event loop: splitting the same
  ordered event set across sockets would still serialize parsing, adaptation,
  store writes, and rendering on that loop while adding listeners, buffers, and
  cross-stream ordering/replay failure modes. A future multi-lane protocol
  would need explicit sequence numbers, a control-lane guarantee, and a worker
  or separate renderer for the high-volume lane; adding sockets alone would not
  provide CPU parallelism.

Validation for this pass: 57 core tests (7 platform skips), 10 server HTTP
tests (8 platform skips), 20 session/tool tests, 86 app session/sync tests,
78 app session-message/session tests, and 17 server-SDK tests pass. The
existing full typecheck still contains unrelated baseline errors; changed
source filters remain clean. No running app or server was restarted.

## Continuation (fourth pass)

- Live delta coalescing now happens at the SSE producer boundary as well as in
  the renderer. Native and legacy event routes hold per-key fragments for one
  frame, flush them before lifecycle barriers, and reconnect on bounded queue
  overflow. This reduces serialized frames and queue pressure before bytes
  reach the loopback pipe, while retaining exact event order and text.
- Coalesced fragments are capped at 64 KiB and pending keys at 256. A stalled
  renderer or socket therefore cannot turn token merging into an unbounded
  string or map; capped chunks preserve the complete stream in order.
- Instance disposal now has a dedicated GlobalBus lifecycle channel. V2 event
  streams no longer install a disposal filter on the generic per-event bus,
  and the native bridge skips generic legacy broadcasting when that channel has
  no consumers. Legacy subscribers still receive the original event payload.
- The renderer bypass is restricted to the `session.*` event family that the
  V2 reducer actually handles. `session.next.*` is a separate durable schema
  and remains on the legacy path until its reducer is implemented, avoiding a
  correctness regression while still removing duplicate V2 work.
- The V2 reducer now keeps a bounded per-session message/content index for
  streaming deltas, and the projection path updates one indexed message and
  normalized part instead of re-normalizing the complete history for every
  token. Layout mismatches fall back to the full hydration path, so refreshes,
  removals, and reordered history remain authoritative.

Fourth-pass validation: 51 core event/coalescer tests, 5 server event/PTY
tests (4 platform skips), 18 app SDK tests, and the opencode typecheck pass.

## Continuation (fifth pass)

- The project explorer's directory listing is now semaphore-limited to four
  requests per tree store. Manual expansion, search expansion, prewarm, and
  watcher refreshes share the same scheduler, so a large search or expand-all
  cannot turn into one HTTP request per directory at once. Scope switches skip
  stale queued work, and provider cleanup cancels queued jobs and prewarm
  timers.
- File-tree refreshes are batched into one Solid update. If a watcher returns
  freshly allocated objects with unchanged metadata, the existing node and
  child-array identities are retained. The live row projection is WeakMap
  cached, and selection pruning memoizes the loaded-path set instead of
  rebuilding it for every selection change.
- File watcher invalidations now have bounded queues: directory refreshes are
  capped at 512 paths with a root-refresh fallback, file reads at 256 paths,
  and file reads run in two-worker batches after an 80ms coalescing window.
  Hidden-pane directory work remains stale until the tree is visible; cleanup
  clears all timers and pending sets.
- Explorer mutations keep two requests in flight, and editor `file.edited`
  notifications coalesce by path before reloading clean buffers with the same
  two-worker limit. Bulk rename/delete/mention/open and “add to chat” dispatch
  yield every 32 paths so a large selection does not monopolize the renderer
  task.

Fifth-pass validation: 33 focused explorer/file tests pass, including a
concurrency-cap, unchanged-node identity, and disposal regression. The full
  app typecheck still reports the repository's pre-existing React-style
  context, prompt, browser-appearance, and session-ui model errors; it reports
  no new diagnostics in the changed explorer files. No running app or server
  was restarted.

## Continuation (sixth and seventh passes)

The fifth-pass explorer description above is now superseded in two places:
search and expand-all work is generation-cancelled rather than merely bounded,
and watcher overflow marks loaded subtrees stale instead of refreshing only the
root. The latter behavior matters for expand-all: a root refresh cannot prove
that a deep directory is current.

### Transport, replay, and publication pressure

- Native `/api/event`, legacy `/event`, and `/global/event` now assign a
  monotonic SSE cursor to domain frames. The wire cursor is `epoch:sequence`:
  each route validates the epoch before consulting its 4,096-frame/8 MiB ring,
  so a cursor from a previous sidecar process can never look current in a new
  ring. Subscribers register before replay, and a reconnect with a valid cursor
  receives replay before a readiness frame can advertise a newer cursor. A
  filtered stream may observe a non-contiguous subsequence; the server, not the
  client, decides whether the requested cursor is outside the retained window.
  Cursor-bearing coalescers no longer merge non-adjacent keys and then advance
  past an undelivered fragment. Heartbeats carry no cursor; they prove socket
  liveness for reconnect-backoff reset, while domain delivery remains a separate
  signal for adaptive coarsening.
- A cursor outside the ring produces `server.stream.gap` with the requested,
  oldest, latest, and directory metadata. The renderer treats that control
  frame as a repair barrier and hydrates through the existing snapshot paths;
  it no longer has to guess which non-superseded event was lost. Oversized
  frames also advance the cursor and force a gap rather than pretending an
  empty replay is complete. The legacy serializer has an explicit control-frame
  path because the gap type is transport metadata, not a manifest domain event.
- Subscriber queues now have both item and byte ceilings. The default event
  subscriber and all three HTTP SSE surfaces use an 8 MiB byte budget; queue
  reads release the exact retained-byte estimate. `estimateEventBytes` is an
  iterative, cycle-safe traversal with a node/size saturation limit and a weak
  identity cache for immutable event objects. This closes the old gap where a
  small item count could retain a very large payload.
- `GlobalBus` has a private `event.replay` channel. Replay capture therefore
  remains complete without making the legacy bridge construct and broadcast a
  second envelope when no legacy listener exists. Missing legacy payload IDs are
  copied into a new envelope rather than mutating the producer object, which
  keeps identity-based serialization caches valid. Defective listeners are
  isolated and detached after their first failure; a bad subscriber cannot fail
  publication or run once per subsequent token. Zero/one-listener publication
  avoids the common snapshot and fiber allocations.
- Coalescing is barrier-first. Event definitions opt in with manifest metadata;
  unknown future event types are barriers by default. For ordinary streams the
  coalescer can merge fragments by key; for cursor-bearing SSE streams it only
  merges adjacent runs of one key, because merging A1/B1/A2 into B1/A1+A2
  would advance a replay cursor past an undelivered A1. This removes both the
  old allowlist failure mode and the newer acknowledgement-ordering failure.
- PTY HTTP outboxes are bounded to 128 frames and 1 MiB in bytes, while the
  native PTY replay-to-live handoff remains bounded to 256 chunks and 2 MiB.
  A stalled terminal closes and reconnects rather than retaining arbitrarily
  large reads. Direct socket `writableLength` thresholds and adjacent PTY write
  coalescing are still open follow-ups.
- SSE parsing now assembles fragmented lines and data fields from arrays rather
  than repeated string concatenation, and counts UTF-8 bytes against an 8 MiB
  frame limit. Generated V1 and V2 clients send `Last-Event-ID`, use full-jitter
  exponential retry, cancel the reader on abort/consumer return, and recognize
  fragmented UTF-8 and CRLF correctly. A healthy socket receiving heartbeats can
  reset reconnect attempts; domain-frame delivery is tracked separately and is
  the signal for adaptive coarsening.
- The publisher-side file watcher filters built-in ignores, configured ignores,
  protected paths, and build/dependency directories before publishing; it
  preserves `.git/HEAD`, `.git/refs/**`, and `.git/packed-refs` control changes
  while excluding transient `.git` files such as `index.lock` and
  `MERGE_HEAD`. Exact consecutive path/type duplicates are removed, pending
  updates are bounded to 4,096, publication stays sequential to preserve
  same-path order, and each native batch yields. This
  prevents a dependency install from consuming the session stream's queue with
  events the explorer could never use.
- Desktop net logging is opt-in (`OPENCODE_NETLOG=1` or `--net-log`) so the
  normal Electron process does not capture every loopback SSE chunk into a
  20 MiB network log.

### Explorer and file-tree concurrency

- Directory listing now uses a shared scheduler keyed by server URL: four
  requests may run globally per sidecar, with one reserved slot for interactive
  work and bounded background/local/shared queues. Prewarm, watcher refresh,
  search expansion, manual expansion, and expand-all use the same budget, so
  several project tabs cannot multiply the sidecar fan-out by four each.
- A monotonic generation is attached to filter identity, scope, expand-all,
  collapse-all, prewarm, and provider disposal. Queued jobs from an old search
  or operation are removed before they consume a permit; in-flight work is
  allowed to settle but its result is ignored. `expandAll` checks the generation
  between levels and can be interrupted by collapse, navigation, or a new
  filter. In-flight directory finalizers delete only their own promise, so an
  old scope cannot erase a newer dedup entry. A cancelled listing resolves with
  a private cancellation sentinel, never an empty directory response, so queue
  pressure cannot erase valid cached children. A query that supersedes another
  query re-enqueues shared ancestors that remain expanded.
- Watcher refresh queues are bounded to 512 directories and 256 file reads.
  Overflow increments a stale epoch and re-lists loaded directories lazily when
  the tree is visible. Hidden panes retain only a stale marker. Scope changes
  clear not-yet-started watcher work and timers before restoring the next
  project, while provider disposal prevents late file reads, store writes, and
  toasts.
- The live tree has an independent 50,000-node ceiling. Least-recently-used
  collapsed subtrees are dropped first; the directory shell remains and is
  re-listed when expanded. Snapshot eviction uses a cached node count, child
  arrays use an 8,192-entry MRU cache, and search/selection use an incrementally
  maintained node index plus O(selected-path) `hasNode` checks instead of
  rebuilding a 50,000-entry set for every selection change. Retained nodes keep
  object identity across unchanged watcher refreshes. Expand-all still needs a
  user-visible subtree/depth budget for a single directory containing more than
  the ceiling; evicting expanded content would be a correctness regression.
- The legacy recursive `FileTree` keeps its cosmetic depth guide cheap and uses
  a propagated `Set` for ancestor-cycle protection, replacing the old full
  depth-array scan for every rendered node. Search expansion still uses the
  shared generation token, and `shouldListExpanded` remains covered by the
  fetch-discipline tests.
- `createPathHelpers` memoizes the canonical workspace root and now has a
  bounded 4,096-entry per-scope LRU for repeated normalization. This is useful
  for watcher bursts and repeated row lookups without turning arbitrary path
  input into an unbounded cache.
- Git status now retains one dirty bit rather than every changed path because
  the current endpoint is a full-status query. Fetches are scope-tagged and
  finalizers are identity-checked. Hidden watcher invalidations mark the cache
  dirty without scheduling a scan; the combined scope/visibility effect starts
  one debounced refresh when the explorer becomes visible.
- `ProjectExplorerPanel` searches are debounced by 120 ms, mutation work is
  capped at 512 queued operations with two active requests, and bulk add-to-chat
  yields every 32 paths. Late mutation failures and editor reloads are ignored
  after unmount. The editor keeps only open-buffer reload keys (capped at 256)
  and rechecks ownership after every asynchronous read.

### Renderer, markdown, and worker pressure

- The renderer event queue is bounded by 1,024 pending events and 8 MiB. V2
  stream deltas are merged by session/message/part/field, capped at 64 KiB per
  merged fragment, and flushed at barriers. The stream loop yields while reading
  legacy sync traffic and while the queue is full. When the document is hidden,
  streaming deltas are dropped into a dirty flag and the visible transition
  emits a connected repair barrier; this avoids a Chromium-backgrounded rAF
  backlog while preserving hydration correctness.
- Server sync applies native V2 events once and bypasses the legacy reducer for
  the native session family; `session.next.*` remains on the legacy path until
  it has a complete reducer. Session and message-part summaries now use
  per-message Solid memos with cleanup/pruning, and reasoning headings are
  cached by text identity until the text changes. Performance spans cover
  `list`, `watcher`, and `prune` in addition to the existing session/home
  spans. The frame/long-task monitor is reference-counted so multiple providers
  cannot install duplicate rAF loops or observers.
- Parse, project, and highlight worker requests use keyed latest-wins
  transports with bounded active/queued work. Worker state is capped at 32 MiB;
  the worker caps stream state at 16 MiB/200 keys and projections at
  16 MiB/512 keys. The worker queue time-slices long drains. A late response for
  an active parse that was superseded or disposed now completes its transport
  slot; without that release, later parses for the key could remain queued
  forever.
- Completed-code HTML is capped at 200 entries and 8 MiB, the markdown block
  cache has the same entry count plus an 8 MiB byte ceiling, and Shiki token
  styles are interned into a bounded renderer stylesheet with inline fallback.
  Markdown projection keeps stable prefixes and reparses only the live suffix
  where possible; live hashing uses length/generation instead of a full checksum
  on every token.

### Correction and eighth-pass continuation

The sixth/seventh-pass notes above described some mechanisms more strongly than
the code supported. This section records the verified behavior after auditing
the actual tree again, so the audit remains useful as an engineering record.

The replay cursor is now process-identity-aware. `EventReplayBuffer` mints an
epoch for each ring, `parseEventSequence` requires `epoch:sequence` on routes
that expose an epoch, and malformed, numeric-only, foreign, or future cursors
become gaps. The three SSE handlers do not send a readiness frame carrying the
ring's latest sequence before replaying a valid cursor. The native handler and
both legacy handlers emit `server.stream.gap` when the cursor is foreign,
outside the ring, or the bounded replay handoff would exceed its frame/byte
budget. The end-to-end HTTP test covers a valid replay, a foreign epoch, and the
ordering of readiness versus replay.

This is still a frame-count/byte ring, not the time-sized compacted log proposed
in the review. It cannot safely retain only the newest append-only text delta:
doing that loses text. The next protocol-level improvement is a compacted log
that preserves accumulated text or a snapshot boundary plus barriers. Until
that exists, the hidden-window repair path must treat an old cursor as a gap;
disconnect-on-hide and Electron occlusion signals remain follow-up work.

The current ring still retains event objects and uses the bounded, cycle-safe
`estimateEventBytes` traversal. That estimate is conservative but is not the
exact UTF-8 size of the serialized frame. Serialization-at-capture, storing
the encoded frame once, and making queue/ring budgets use exact retained bytes
remain an explicit optimization target. The current implementation does avoid
an estimator stampede for repeated object identities, but it does not claim to
have deleted the estimator or made every route single-encode at capture.

The coalescer change is intentionally narrower than “sort by newest sequence.”
Manifest metadata opts event types in; unknown types are barriers. Cursor-bearing
streams merge only adjacent runs for one key. This preserves the replay
acknowledgement prefix when unrelated keys interleave. The renderer's legacy and
native dispatch table remains one ordered application pipeline, so a V2 event
cannot overtake a `session.next.*` event through a second queue.

Watcher publication is sequential again. The previous eight-way `Effect.forEach`
could publish create/unlink transitions for one path out of order even though
publication itself was non-blocking. Exact consecutive duplicates are removed,
but create/delete/create remains three terminal hints. The callback applies
`Ignore.match` at the publisher boundary and uses a per-event Git allowlist for
`HEAD`, `refs/**`, and `packed-refs`; it does not rely on a startup directory
listing, so later `index.lock`, `MERGE_HEAD`, and similar files do not leak.
Publisher filtering still depends on the experimental project-watcher flag for
the project-root subscription; the Git control subscription is separate.

The decompression read path now has a 64 MiB retained-input budget covering both
queued and in-flight jobs. Admission rejects a request that would exceed it,
worker ID mismatches reject the affected promise, malformed JSON rejects rather
than stranding the worker, synchronous `postMessage` failures settle normally,
and close rejects active and queued callers without respawning workers. This
bounds a lower-level queue that the SSE ceilings could not protect. JSON.parse
and checksum validation remain on the main thread by design; moving those
costs requires a measured structured-clone alternative.

Explorer cancellation has two correctness guards. Scheduler drops resolve with
a private cancellation sentinel rather than `[]`, so queue overflow cannot
erase a valid directory as an authoritative empty response. A stale listing
cannot mark the current stale epoch fresh, and query supersession requeues
ancestors that remain expanded. Nested `FileTree` instances no longer advance
the shared search generation merely because they mount. The live node ceiling
still has no safe victim when a single expanded root exceeds it; expand-all needs
a visible node/depth budget and truncation state before it can be called hard
bounded.

The SDK parser and generated clients now have adversarial coverage for CRLF
split across chunks, multiline data, comments and heartbeats, retry and ID
validation, every UTF-8 byte split, exact/over-limit UTF-8 byte counts, reader
cancellation, rejected-frame cursor handling, and both V1/V2 generated
transports. The generator patch is deliberately in `packages/sdk/js/script/build.ts`
so regeneration preserves the parser, reader cancellation, heartbeat-aware
liveness reset, and full-jitter retry. The generated output was rebuilt
successfully after fixing the wrapped-reader shape emitted by the generator.

### Validation and limits of the evidence

Latest focused validation after the sixth/seventh-pass changes:

- App file/path/tree/explorer tests: **24 pass, 0 fail, 64 expects** in the
  focused rerun, plus **81 pass, 0 fail, 155 expects** for the default-runtime
  session/reducer/message suites and **31 pass, 0 fail, 70 expects** for the
  browser-condition SDK/sync suites.
- Core event/replay/coalescer/filesystem tests: **75 pass, 1 skip, 0 fail,
  149 expects** in the focused rerun. Decompression-pool settlement tests add
  **5 pass, 0 fail, 16 expects**.
- Opencode HTTP event/serialization tests: **4 pass, 0 fail** for the cursor
  replay/epoch scenario and **5 pass, 0 fail, 80 expects** for the HTTP event
  suite.
- SDK parser and transport tests: **15 pass, 0 fail, 116 expects**. The SDK
  generator/build completed successfully.
- Session-ui worker/queue/message-part tests: **12 pass, 0 fail, 21 expects**.

The full app typecheck still reports the same repository baseline fingerprints
(43 diagnostics in the captured app baseline and 43 in the current run); no new
changed-file diagnostic was added. The default server-sync test invocation still
hits the installed Solid runtime's missing `solid-js/web` `use` export, while
the sanctioned `--conditions=browser` run passes the affected suite. No desktop
sidecar or opencode server was restarted, and no new 30x-throttled production
trace was obtained; earlier stress numbers remain a baseline rather than a
claimed before/after improvement.

The remaining architectural work is intentionally called out rather than hidden
behind static caps: exact serialized capture and time/compaction-based replay,
disconnect-on-hide plus Electron occlusion signals, server-side subscription
filtering by event type/path prefix, a recursive/bounded server tree-list
endpoint, socket `writableLength` monitoring, rope/chunk accumulation for
session text, full line virtualization for very large code blocks, worker-side
Shiki style IDs, and a renderer-to-server control channel for adaptive
coarsening or snapshot-only mode. These require protocol or rendering changes
and should be measured with the persistent SSE scenario before being enabled
broadly. More SSE sockets remain a poor saturation strategy: parsing,
adaptation, reducers, and Solid writes still serialize on the renderer's one
JavaScript event loop, while extra streams add buffers and cross-stream ordering
failure modes.

## Ninth pass: premise corrections and tool-output server stall

Two audit premises were tested against the tree and found false. Both are
recorded here so they are not re-raised.

### The session turn list is already virtualized

Prior passes recorded that 320 history turns render with no virtualization and
that this explains sustained long tasks independent of streaming. That is not
true of the desktop path:

- `packages/app/src/pages/session/timeline/message-timeline.tsx` already builds
  a `createVirtualizer` (line 484) from `@tanstack/solid-virtual` with
  `overscan: 50` and `paddingEnd: 64`, and row emission is
  `<For each={virtualRowKeys()}>` (line 2070), fed by
  `collectVirtualItems(virtualizer.getVirtualItems(), ...)` (line 600).
- `packages/session-ui/src/components/session-turn.tsx` renders ONE turn. Its
  props take a single `messageID` and it resolves that turn with
  `Binary.search` (lines 155-190). It is not a turn list and has no
  `<Index each={grouped()}>`.
- That component has no production importers. Only a doc, a DOM attribute query
  in `session-text-highlighter.ts` (which matches an attribute emitted by
  `message-timeline.tsx`, not by this component), a bench, and an e2e spec.

The remaining genuinely unwindowed turn list is
`packages/mobile/src/views/ChatView.tsx`, which is the PWA rather than the
Electron renderer.

### The 90% rendering attribution is not measured

`perf.ts` writes the reducer-versus-frame diagnostic split to the console, but
`e2e/performance/timeline/session-timeline-benchmark.spec.ts` never captures
page console output. The recorded stress run
(`.opencode/cache/event-loop-benchmark-persistent.txt`) therefore contains
`longTaskTimeMs: 159774` and `longTaskCount: 578` from the harness observer
only, with none of the `applyV2`/`frame:` spans that would attribute them.
Attributing roughly 90% of the stall to rendering is an inference from the
harness numbers, not a measurement. A fresh run with console capture, or a CPU
profile, is required before that split can rank work.

### Tool output writes stalled the whole server

`packages/core/src/tool-output-store.ts` compressed oversized tool output with
`brotliCompressSync` at quality 4. A synchronous brotli pass over a
multi-megabyte payload blocks the server event loop, stalling every SSE
subscriber and HTTP route for its duration. The desktop main process already
documents and avoids this exact mistake in `packages/desktop/src/main/ipc.ts`
("a sync q2 pass on a ~55MB transcript costs ~300ms"); the server had not
inherited the fix. Changed to the callback form via `promisify(brotliCompress)`
inside the existing `Effect` generator, so zlib runs on the libuv threadpool.

Consequence for prior measurements: any SSE timing collected while tool outputs
were being written carries an unattributed multi-hundred-millisecond confound.
Transport numbers should be re-baselined after this change.

### Retention cleanup deleted files with unavailable mtime

In the same file, `cleanup()` mapped the stat mtime through
`Option.getOrElse(() => 0)` and then guarded with `modified !== undefined`.
The fallback always produces a number, so that guard was dead code, and
`0 < cutoff` is unconditionally true. Every managed file whose mtime could not
be read was deleted regardless of age, and the removal is unrecoverable. Changed
to `Option.getOrUndefined` with an explicit skip, since an unavailable mtime is
not evidence that a file is old.

Validation: `bun test test/tool-output-store.test.ts` from `packages/core`
passes 10/10 including the retention test. `bun run typecheck` reports 87
errors, all in `test/` files and none in `src/`, matching the documented
pre-existing baseline.

### What the stall evidence actually supports

Re-reading `.opencode/cache/event-loop-benchmark-persistent.txt` against the
finding that the desktop timeline is already virtualized:

- `longTaskCount` 578 and `longTaskTimeMs` 159774 inside a ~178 s completion.
- `deliveredDeltas` 160, `pendingDeltas` 0, so ~0.90 deltas/s.
- `domTextCharacters` 3515 — very little content actually on screen.
- `rafGapP95Ms` 1849.9, `maxRafGapMs` 2399.9, and
  `longestRafGapOver33MsStreak` 172 of 172 sampled gaps: every gap blew the
  frame budget and there was no recovery frame at any point.

160 deltas and ~3.5 k characters is not enough content to account for 178
seconds, and `pendingDeltas` 0 means the inbound queue was drained. A 2.4 s
rAF gap with an empty queue points at per-update cost or synchronous work
between frames, not at row count or inbound throughput. That is consistent with
each delta triggering a full invalidation pass over the message/part array
structure, which is O(messages) per update rather than O(rows).

This remains a hypothesis, not a measurement: see the note above that `perf.ts`
spans were never captured by the benchmark. Confirming it requires a run with
console capture or a CPU profile.

### PWA is out of scope for the reported lag

The benchmark run builds and serves `packages/app`; the file contains no
reference to `packages/mobile` or port 3301. The one remaining unwindowed turn
list, `packages/mobile/src/views/ChatView.tsx:323` (`<Index
each={props.messages}>`), is real but belongs to the PWA and is unrelated to
this trace. Not pursued as a fix for the reported lag.

### Correction: the replay byte-check cost was overstated

A prior pass recorded that the replay path runs a full O(ring) traversal with
`estimateEventBytes` before deciding to gap, so that even the reject path pays
the cost in full. That is wrong. All three handlers use one `||` chain, for
example at `packages/server/src/handlers/event.ts` lines 81-83:

    replayResult.kind === "gap" || replayResult.frames.length > MAX_REPLAY_FRAMES
      || replayResult.frames.reduce(... estimateEventBytes ...) > 4 * 1024 * 1024

JavaScript `||` short-circuits left to right, so when the frame count exceeds
128 the reduce is never evaluated, and when it is evaluated it runs over at most
128 frames rather than the 4,096-frame ring. The real worst case is 128 estimator
calls per reconnect (plus 128 `adaptLegacyEvent` calls in the legacy handler),
not 4,096. The legacy and global handlers have the identical structure.

Summing the stored `frame.size` is still the correct and cheaper approach, but
it is a secondary optimization. The load-bearing defects in that area are
unaffected by this correction:

- `MAX_REPLAY_FRAMES` is 128 against a 4,096-frame ring, so the usable resume
  window is under a second of streaming. This check fires first and is what
  forces full hydration on any nontrivial reconnect.
- An oversized frame clears the entire window rather than evicting enough to fit,
  and `estimateEventBytes` charges `input.length * 4` for strings where
  `length` is UTF-16 code units. For ASCII that is a 4x overcount, so a ~2 MiB
  tool result trips the 8 MiB budget and strands every connected client's cursor
  at once.

### Coalescing and the sync envelope

A probe of `EventManifest.Latest` reports 98 definitions, of which 5 carry a
`coalesce` descriptor, and all 5 have `durable` unset:
`session.next.text.delta`, `session.next.reasoning.delta`,
`session.next.tool.input.delta`, `session.next.compaction.delta` and
`message.part.delta`. Since the second sync envelope is gated on
`event.durable === undefined` in `event-v2-bridge.ts`, none of these ever
produce one. The claim that the sync envelope acts as a barrier flushing every
delta at a 1:1 ratio therefore does not hold for manifest deltas.

Unverified: `event-coalescer.ts` also registers legacy transport aliases
(`session.text.delta` and siblings) which are not manifest definitions, so this
probe says nothing about whether those are durable. The barrier theory remains
open for that surface only.

### Correction: the per-token reactive store is server-session, not global-sync

Prior passes targeted `packages/app/src/context/global-sync/` as the site of
per-delta reactive invalidation. That is wrong, and it matters because the
streaming accumulator and the part arrays do not live there.

Verified against source:

1. `global-sync/event-reducer.ts:124` early-returns for every
   `SESSION_CONTENT_EVENTS` type when `sessionContent === false`. That set
   includes `message.part.delta`, `message.part.updated`, `todo.updated`,
   `session.status` and `session.diff`.
2. Both production call sites pass `sessionContent: false`
   (`server-sync.tsx:637` and `server-sync.tsx:758`). No other production
   caller exists.
3. Consequently `store.part` and `store.part_text_accum_delta` in
   global-sync receive no per-token writes in production.
4. The accumulator actually lives in `packages/app/src/context/server-session.ts`
   (store shape at line 226, delta writes at roughly lines 1339 and 1468).
   `directory-sync.ts:11-22` proxies `part` and `part_text_accum_delta`
   through to `serverSync.session.data`, so the UI reads the server-session
   store.
5. `server-session.ts:225` declares `part` as `Record<string, Part[]>`,
   i.e. arrays keyed by message. That is the per-message-array invalidation
   granularity that makes one part update invalidate every sibling row.

Implication: re-keying parts by ID, moving the text accumulator out of the
reactive store, per-session stores, and deferring non-visible projection are all
server-session changes. Work done in global-sync moves no per-delta cost.

### Orphan part leak fixed

`dropSessionCaches` walked `store.message[sessionID]` to find parts, so a
session whose message list had already been evicted left its parts and
`part_text_accum_delta` entries in the store for the process lifetime. Fixed in
`global-sync/session-cache.ts` with an orphan path that resolves sessions with
no message list by one pass over `store.part` keyed off each part's own
`sessionID`. The sweep runs only when an orphan exists, so the common trim keeps
its cheap message-walk. Two regression tests added; package tests went from
5 fail / 359 pass to 3 fail / 361 pass, with the 3 remaining failures
pre-existing and confirmed unrelated by stash isolation.

Residual risk: the orphan sweep is O(cached messages) but fires only on the
orphan path, bounded by `SESSION_CACHE_LIMIT` of 40 sessions.

### Benchmark flake note

`test/server/httpapi-event-lifetime.test.ts` and `httpapi-event.test.ts`
showed one `timed out waiting for event` failure on a first run and then
passed 8/8 with 43 expects on a subsequent run. Treat that suite as flaky under
load rather than as a regression, but re-run before trusting a single result.

### Ninth-pass synthesis: where the concurrent-session cost actually lives

The user's reported symptom is the authoritative input: with 8 concurrent
sessions running, long tasks spike exponentially, frames drop, and jank
increases.

"Exponentially" is diagnostically specific. It is the signature of a cost that
scales with the product of two growing quantities rather than either alone: N
sessions emitting deltas against a store whose per-delta update cost is
O(messages) or O(cached sessions) yields O(N x M), which reads as superlinear as
both grow.

That structural prediction points at `packages/app/src/context/server-session.ts`:

- Its store declares `part` as `Record<string, Part[]>` (line 225) — arrays
  keyed by message. One part update replaces an array that every sibling row
  reads, so invalidation granularity is per-message-array rather than per-part.
- The streaming accumulator `part_text_accum_delta` lives here (store shape at
  line 226, writes at roughly 701, 1256, 1339, 1468).
- All sessions share one store and one reactive graph, so a background session's
  traffic can invalidate what the visible session renders.

This is consistent with the independently verified finding that global-sync is
off the streaming hot path (see the section above). The two facts together
identify a single location.

Recommended work, in order, all against `server-session.ts`:
1. Re-key parts by `partID` (a `Record<string, Part>` map plus a per-message
   order array) so a delta touches exactly one leaf.
2. Move `part_text_accum_delta` out of the reactive store into a plain Map with
   a per-part signal bumped at flush, read untracked.
3. Per-session stores, then defer reactive projection for non-visible sessions.

These are deliberately NOT done in this pass. They are structural changes to a
live store with real migration risk, and the benchmark that would prove them has
a known flake. The next pass should begin by measuring, not restructuring.

### Verification status at end of ninth pass

| Surface | Result |
|---|---|
| core: event-replay + event-coalescer + tool-output | 25 pass, 0 fail |
| opencode: bridge-gate + event lifetime + httpapi-event | 14 pass, 0 fail |
| app: global-sync | 48 pass, 3 fail (pre-existing, stash-isolated) |
| app: file context + global-sync | 117 pass, 3 fail (same 3, refresh-queue scenarios) |
| core typecheck | 0 errors in `src/`; 87 in `test/`, matching baseline |

Known flake: `httpapi-event-lifetime.test.ts` failed once with "timed out
waiting for event" and then passed on two subsequent runs. Re-run before
trusting a single result from that suite.

### t6-tree closed: snapshot epoch, expand-all signal, cancellation chokepoint, trim victims, gate bound

`tree-store-correctness` completed all five tree-store items in
`packages/app/src/context/file/tree-store.ts`:

- Snapshot/restore now persists and resumes `loadedEpoch`, so a scope
  switch-back no longer re-lists a warm tree. Covered by a fail-then-pass test.
- `expandAll` returns `{ truncated, droppedDirectories, expanded, reached }`;
  overflowed requests are named instead of silently truncating the frontier.
- The scope guard resolves `CANCELLED_LIST` rather than a fresh `[]`.
- Subtree sizes are tracked incrementally and trim victims are biggest-first;
  measured parity (not a speedup) at tested scales, asymptotic win only.
- `sharedListGates` is hard-bounded at 32 with idle-first LRU eviction.

Verification: `bun test src/context/file/tree-store.test.ts` 23/23 pass;
`bun test src/context/file` 91 pass / 0 fail across 6 files. The earlier
tree-store suite stall was the member's own sentinel-test deadlock, fixed with a
hold flag — not a source defect. The remaining app failures elsewhere are the
previously documented pre-existing ones.

### External research reconciliation: accepted with local scope corrections

A remote-main research pass (no access to the dirty pass-9 worktree) produced
useful structure, but its line numbers and some conclusions must be checked
against this tree before use. Verified locally:

- F1 ACCEPTED. The timeline benchmark is single-session: it streams into one
  `textPartID` with `TIMELINE_DELTA_COUNT`/`TIMELINE_HISTORY_TURNS` knobs
  and no session-count parameter. The 578/159,774ms artifact cannot support a
  per-session scaling law.
- F2 STRUCTURE CONFIRMED, COST UNMEASURED. `projection.ts` builds one
  `grouped()` memo over the message list and then gives each turn a memo that
  calls `grouped().turns.find(...)`; the shallow-equality guard runs after the
  find. That shape can be O(turns^2) per invalidation, but whether the incremental
  index write invalidates `grouped()` every token is not yet proven here.
- F3 ACCEPTED. `protectedSessions()` is called from `touch()`/eviction paths,
  not from `applyV2`; it is ruled out as a per-token cost.
- F4 ACCEPTED FOR global-sync, UNVERIFIED FOR server-session. The readable
  accumulator write is a single keyed concat; the live server-session write sites
  still need direct verification.
- F5 ACCEPTED. `server-session-v2-reducer.ts` copies the session message array
  per indexed content/tool update; the index avoids rescans but not the copy.
- F6 ACCEPTED WITH SCOPE CORRECTION. `applyV2` reduces only when loaded or
  message-loading, suspends only sessions in `suspended`, and `release()`
  only adds to `suspended`. `release()` IS wired to timeline-model session
  change/unmount, so previously visited sessions can still be suspended on
  navigation; whether it fires in the user's 8-session layout remains open.
- F8 STRUCTURE CONFIRMED, INVALIDATION UNKNOWN. The `estimateInputCache`
  reset effect exists, but whether `message.updated` invalidates it per token
  was not settled from source alone.
- Priority-lane workstream REJECTED for this symptom. Transport delivered the
  queued payload; the stall evidence points at main-thread service time, and a
  new lane would add sockets, ordering domains, replay cursors, and queue-capacity
  couplings without reducing per-delta reduce/project work.

Next experiment, before touching `server-session.ts`: vary only
`TIMELINE_HISTORY_TURNS` (for example 40/160/320) at fixed delta count and
throttle. Quadratic scaling supports F2; linear points at F5/F8; flat refutes
both and implicates row construction/measurement.

### Phase-by-phase trace instrumentation (default-on, file-logged)

Added to support an 8+ session measurement run, since every prior attribution
was inferred from a single-session trace without reducer/frame spans.

Server: `packages/core/src/event-trace.ts`. Default ON; `OPENCODE_EVENT_TRACE=0`
disables, `OPENCODE_EVENT_TRACE_DIR` overrides the output directory (default
`<xdg-data>/opencode/log/event-trace`). One `trace-<pid>-<timestamp>.jsonl`
per process, rolled at 25 MiB keeping two rotated files. Hot path records
integer counters only; file writes are buffered with a drop-rather-than-block
policy, so tracing cannot stall the loop it observes. No payload content is
logged — ids, types, counts, sizes, durations. Hook points: the shared bounded-
queue `offer()` (accepted bytes, overflow), bridge publish by type plus the
legacy gate decision (emitted vs skipped envelopes), and per-route coalescer
inputs vs subscriber outputs (merge ratio), serialize ms/bytes, reconnect
cursor/kind/frames/bytes, and gap emission on native, legacy and global routes.
Summary line every 15s.

Renderer: `packages/app/src/context/phase-trace.ts`. Default ON;
`localStorage opencode:phase-trace=0` or `?phase-trace=0` disables.
Summaries go to the console as `[phase-trace]` JSON every 5s (captured by the
desktop file logger) and the live snapshot is at
`window.__opencodePhaseTrace()`. Hook points: SSE receive loop (frame kind,
session, dispatch ms, reconnects, gaps), reducer wrapper (applyV2/apply ms per
session), timeline projection (grouped ms + turn count, per-row ms with slow-row
ring above 25ms), estimate-cache resets, and an independent rAF gap sampler
that skips hidden-tab gaps. Ring capped at 512, histograms at 64 keys + other,
120 five-second windows retained.

Verification: `core/test/event-trace.test.ts` and
`app/src/context/phase-trace.test.ts` cover caps, toggles and summary shape.
After instrumentation: core event suites 93/93, opencode event suites 25/25,
server typecheck clean, opencode typecheck clean, app typecheck 43 diagnostics
matching baseline with none in the touched files.

To analyze a run: server file above plus the desktop log's `[phase-trace]`
lines, or `__opencodePhaseTrace()` live in devtools. Join on 5s/15s windows
by timestamp; per-session histograms identify which session's traffic precedes
each stall cluster.
