# Handoff Prompt: Concurrent Session Contention Scout

You are the **audit/scouting agent** for an ongoing OpenCode concurrency and responsiveness investigation in `/webstormprojects/opencode`.

Your job is deliberately narrow: **investigate, locate, prove, and rank candidate causes of concurrent-session clogging. Do not patch the repository. Do not refactor. Do not commit. Do not push.** The primary agent owns all code changes and will use your report as a prioritized queue.

## Mission

Find mechanisms where one busy session, several simultaneously active sessions, or one pathological large session can materially degrade unrelated sessions or the desktop UI.

We care about:

- cross-session head-of-line blocking
- process-global or machine-global locks/semaphores/queues
- single-thread/event-loop monopolization
- synchronous work proportional to whole session/history/message size
- N-active-session fan-out
- durable write amplification
- SQLite writer lock duration and connection-level contention
- renderer reactive invalidation or expensive liveness-driven work
- SSE/replay/backpressure/reconnect amplification
- filesystem/Git work repeated independently by concurrent sessions
- provider/model/auth startup serialization or duplicate work
- tool execution/resource contention
- background maintenance competing with interactive work
- giant event/frame production and repeated serialization/copying
- cache designs that accidentally turn independent sessions into shared bottlenecks
- lifecycle leaks where background/inactive sessions continue expensive work

The symptom to explain is not merely "one request is slow." The important failure mode is: **as more sessions run concurrently, otherwise unrelated sessions and/or the UI progressively feel clogged, delayed, or frozen, and responsiveness often improves again when the concurrent work ends.**

## Hard Rules

1. **READ ONLY. Do not modify source, tests, docs, config, migrations, generated files, or local state.**
2. Do not commit, stage, restore, reset, clean, checkout, stash, rebase, or otherwise mutate Git state.
3. The worktree is heavily dirty with tracked and untracked work from multiple active efforts. Treat all existing changes as user-owned.
4. Do not launch destructive workloads. Read-only profiling/benchmarks are allowed only if they do not mutate persistent user state. Prefer existing tests, traces, and source evidence.
5. Do not spend your time re-proving already-fixed items unless you find a remaining hole or a materially different mechanism.
6. Do not propose broad rewrites based only on aesthetics. A candidate must have a concrete contention mechanism.
7. Distinguish **verified**, **measured**, **strongly inferred**, and **speculative** findings.
8. Search tracked and untracked source because the active fixes are not all committed yet.
9. Do not optimize a local operation if it cannot plausibly affect concurrent sessions. Keep cross-session causality central.
10. Your final deliverable is a ranked audit report only. No patches.

## Important Existing Findings - Do Not Rediscover These as New

The primary agent has already investigated or patched the following. You may inspect them to understand boundaries, but only report them if you find a remaining edge case or a distinct second-order problem.

### Renderer/background projection

- Background session hydration previously activated content projection indefinitely because `server-session.ts sync()` conflated hydration with foreground ownership.
- `sync(..., { activate: false })` and related call-site changes now allow background hydration without activating projection.
- Prefetched/inactive sessions are intentionally suspended and recover on activation.
- Renderer SSE consumption no longer deliberately stops reading the socket when its local queue is full; local overload repairs via a global hydration barrier.
- Local renderer event queue is byte- and count-bounded.

### SSE/replay transport

- Historical replay is delivered as a direct finite prefix and no longer consumes the bounded live subscriber queue.
- Native and legacy instance/global SSE paths were aligned around the replay ring's 8 MiB budget.
- Large replay history no longer steals byte headroom from a near-budget live event.
- Previous traces showed a reconnect storm and subscriber failures; replay/live queue coupling was one real contributor and has been changed.

### Markdown worker

- One Web Worker has serial worker-side queues. Main-side parse concurrency was reduced to one per serial lane so 16 jobs are not needlessly posted into a FIFO that cannot execute in parallel.

### Git/start snapshot

- Concurrent session start snapshots previously convoyed through redundant Git work.
- Snapshot capture was changed so provider generation can overlap start-snapshot work while assistant/tool publication remains behind the snapshot correctness barrier.
- Concurrent snapshot requests are batched/deduplicated rather than independently repeating the expensive Git tree operation.

### SQLite read/write isolation

- The primary DB handle has a single connection permit. Reads previously queued behind an unrelated writer transaction even though the DB is WAL mode.
- File-backed DBs now have a persistent query-only `readDb` connection. `:memory:` intentionally aliases `db` because separate in-memory handles are different databases.
- High-volume committed-state reads have been routed to `readDb`, including major V2 session/history/search/list/replay paths, runner history, pure Goal reads, credential reads, and major V1 session/message reads.
- Mutation precondition reads intentionally remain on the writer.

### Durable write amplification / FTS

- Schema encoding of an immutable durable event payload was moved before the `IMMEDIATE` transaction.
- `session_message` and legacy `part` FTS triggers previously fired on every row update, including metadata-only updates.
- Search text is now recomputed only for events that can change searchable text, and migrations scope FTS triggers to `UPDATE OF search_text`.
- An isolated ~800 KB row / ~460 KB search-text benchmark improved from roughly 629 ms/100 metadata writes to 161 ms/100 when unnecessary FTS work was removed.

### OAuth/model startup

- Credential reads used during model resolution now use `readDb`.
- Near-expiry OAuth refreshes are keyed/singleflight per credential. Concurrent sessions using the same credential should perform one refresh, not a refresh stampede.

### CPU paths already measured and currently lower priority

- Canonical LLM lowering is relatively cheap even on intentionally extreme histories: about 4-5 ms for ~31 MiB text histories and about 15 ms for 1000 completed tool messages in the measured harness.
- Message schema decode was roughly 6.6 ms for 1000/~7.8 MiB and 26 ms for 5000/~39 MiB in the measured microbenchmark.
- Do not rank these highly unless you find a different nonlinear/copying mechanism around them.

### Current known open target

The primary agent is actively investigating large-assistant durable projection. The current projector performs a full assistant row decode -> Immer update -> schema encode -> SQLite rewrite for tiny logical metadata changes.

Measured through the real EventV2/projector stack after the FTS fix:

| Assistant row size | Step.Streamed | Step.Ended |
| --- | ---: | ---: |
| ~1 MiB | ~7-16 ms | ~7-8 ms |
| ~4 MiB | ~18-29 ms | ~16-18 ms |
| ~16 MiB | ~71-89 ms | ~61-74 ms |

Those events run inside the global durable writer transaction, so this is already a confirmed candidate. The primary agent is handling it. **Do not make this your #1 finding unless you identify an additional mechanism or a safer/better architecture the primary agent has missed.** Be especially mindful of OPCL `$cdbRef` projection rows, which cannot be blindly JSON-patched.

## Where to Look Next

This list is intentionally broad. Follow evidence rather than mechanically checking boxes.

### Core/server durable-event path

- Everything that executes while an `IMMEDIATE` transaction owns the primary DB permit.
- Projectors and local commit hooks that perform multiple SQL calls, large object transforms, hashing, compression/decompression, path scanning, or synchronous JS.
- Whether any event class unnecessarily becomes durable or produces an oversized durable envelope.
- Event sequence allocation, semantic indexing, OPCL/ChunkDB hooks, pruning/sealing interactions, and replay validation.
- Post-commit listener fan-out: look for slow listeners that are still effectively serialized or unbounded in aggregate.

### SQLite/database maintenance

- WAL checkpoint behavior, busy timeouts, sealer/compactor/pruner connections, migration/backfill work, and any code that can acquire the single writer slot for long periods.
- Queries missing indexes that become progressively slower as session/event tables grow.
- JSON extraction/index queries over large message bodies.
- Hidden synchronous native SQLite operations that block the Bun/Electron JS thread even when they use a separate connection.
- Places still using `db` for purely committed-state interactive reads that could safely use `readDb`.
- Conversely, flag any newly routed `readDb` use that creates a stale-read mutation race.

### Session execution/provider path

- Per-session coordinator behavior versus process-global shared resources.
- Any global semaphore around provider calls, tool materialization, system context, prompt assembly, authentication, special agents, compaction, or model/catalog refresh.
- Duplicate provider/model/tool registry work repeated by N sessions.
- Prompt/context compaction paths that become synchronous or superlinear on large sessions.
- Retry/backoff logic that can synchronize many sessions into bursts.

### Tool execution

- Machine-wide heavy-process concurrency is intentionally bounded. Check for other tool classes that launch expensive work without equivalent admission control.
- Child-process stdout/stderr collection that can allocate/copy huge buffers or block event dispatch.
- Tools whose result representation contains large inline base64/media and causes repeated full copies through event -> DB -> SSE -> renderer.
- Tool-output persistence and materialization paths that cause repeated serialization of the same payload.

### SSE / bridge / HTTP

- Remaining reconnect triggers after replay/live separation.
- Heartbeat starvation from synchronous server work.
- Per-subscriber serialization and copying of multi-megabyte events.
- Global bridge fan-out to directories/sessions that do not need an event.
- Event coalescer watermark behavior around large events, tool events, and reconnect boundaries.
- Any queue that is technically bounded but fails the whole stream rather than degrading/repairing safely.

### Renderer

- Work that still runs for suspended/background sessions despite content gating.
- Non-content events that fan out through global/home/directory reducers for every active session.
- Timeline projection or row derivation that scans complete histories on every event/frame.
- Solid memos/effects accidentally subscribing to global containers instead of narrow keys.
- Giant event parsing, cloning, `reconcile`, normalization, syntax highlighting, markdown, or tool-output rendering on the renderer main thread.
- Repeated conversion between V1/V2/projected forms.
- Timers or animation loops multiplied by active/background sessions.
- Look for costs that stop when sessions become idle.

### Filesystem / Project Explorer / watchers

- The explorer has already been changed from eager recursive hydration toward bounded lazy directory caches. Look for remaining hidden whole-tree work.
- Watcher event storms, duplicate refreshes, ignored-directory leaks, coarse invalidation, metadata/stat fan-out, or persistence work triggered by unrelated tool writes.
- Any project-wide ripgrep/glob/indexing work started per session rather than shared/deduplicated.

### Process/machine level

- CPU-heavy subprocess fan-out beyond the explicit heavy-process limiter.
- Disk I/O patterns that can saturate the same volume hosting the DB/worktree.
- Worker pools with too much concurrency or expensive structured cloning.
- Logging/tracing that is default-on and writes large volumes synchronously or serially.
- Memory pressure/GC caused by keeping multiple copies of large tool/message payloads alive across event, DB, SSE, and renderer layers.

## Required Investigation Style

For each promising candidate, answer these questions:

1. **Mechanism:** What exact shared resource or O(N) path couples otherwise independent sessions?
2. **Trigger:** What event/workload causes it?
3. **Scaling law:** Does cost scale with active sessions, total history, message size, subscriber count, tool count, or DB size?
4. **Cross-session causal chain:** Why does session A slow session B?
5. **Evidence:** File/symbol/line references, existing traces/tests, and measurements if available.
6. **Confidence:** Verified / measured / strongly inferred / speculative.
7. **Expected severity:** Critical / high / medium / low, with a rough latency or throughput estimate when possible.
8. **Reproduction:** Cheapest decisive experiment the primary agent can run.
9. **Likely remediation shape:** One or two sentences only. Do not implement it.
10. **Regression risk:** What invariant could a future patch accidentally break?

Reject candidates that do not have a plausible cross-session causal chain.

## Ranking Formula

Return **10-20 candidates maximum**, ranked. Prefer fewer strong candidates over filler.

Score each candidate from 0-5 on:

- `impact`: how badly it can stall independent sessions/UI
- `likelihood`: how likely it is active in ordinary concurrent use
- `evidence`: quality of source/trace/measurement support
- `scaling`: how aggressively it worsens with concurrency/size
- `fixability`: likelihood of a contained robust fix

Also score `risk` from 0-5 where 5 means a fix is especially dangerous.

Use this priority heuristic:

`priority = impact*3 + likelihood*3 + evidence*2 + scaling*2 + fixability - risk`

Do not fake numerical precision. The score exists to force explicit tradeoffs.

## Required Final Report

Return the report in this exact high-level structure:

### 1. Executive conclusion

5-10 sentences describing the dominant remaining contention domains and what you believe the primary agent should investigate next.

### 2. Ranked candidate table

Columns:

`rank | candidate | mechanism | evidence state | impact | likelihood | scaling | fixability | risk | priority`

### 3. Candidate dossiers

For every ranked candidate, include the 10 investigation fields listed above. Include exact source paths and symbols. Use line numbers only after reading the current dirty worktree so they are not stale.

### 4. False leads / deprioritized paths

List mechanisms you inspected and rejected, and explain why. This is important so the primary agent does not repeat your search.

### 5. Top 5 decisive experiments

Give the cheapest high-information experiments that distinguish the top candidates. Prefer experiments that can falsify a candidate quickly.

### 6. Audit coverage

List the subsystems/files you actually inspected, plus important areas you did not have time to inspect.

## Final Reminder

You are a scout, not the patch author. **Do not change anything.** Your value is in finding hidden shared bottlenecks, proving or falsifying them, and handing the primary agent a ranked queue with enough evidence to act surgically.
