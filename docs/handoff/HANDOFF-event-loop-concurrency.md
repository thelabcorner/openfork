# Handoff: OpenFork event-loop saturation and concurrent-session audit

## 0. Handoff metadata

- Date/time (UTC): 2026-09-06 00:06 UTC.
- Sending agent: primary repository agent (Codex); exact model identity is not
  load-bearing.
- Receiving agent: unknown; assume the same workspace and tool access.
- Reason for handoff [USER]: the user explicitly said, “Write a COMPREHENSIVE
  HANDOFF DOCUMENT following this spec,” after a long continuation audit. The
  work has crossed many packages and contains both verified fixes and unresolved
  architectural work.
- Trust guidance [INFERENCE] **mixed**. Focused tests and package typechecks provide good
  evidence for the items marked verified. Earlier write-ups overstated several
  mechanisms, and the user repeatedly corrected those claims against the actual
  `main` tree. Treat architectural conclusions outside the listed tests as
  hypotheses until rechecked.
- Source tags used below:
  - **[USER]** direct user request or correction.
  - **[OBSERVED]** read from the worktree or returned by a command.
  - **[ATTEMPTED]** an action taken by the sending agent.
- **[INFERENCE]** a reasoned interpretation that still needs confirmation.
- **[UNKNOWN]** not established in this environment.
- **[CONSTRAINT]** a repository instruction or explicit operating boundary;
    this is a source/status marker used for guardrails, not evidence that a
    behavior was implemented.
- Status modifiers such as **[VERIFIED]**, **[PARTIAL]**, **[IN PROGRESS]**, and
    **[NOT STARTED]** describe validation state; they do not replace a source
    tag.

## 1. The user's actual goal

- **[USER]** The user asked for an exhaustive concurrency and event-loop saturation audit
  spanning the local OpenCode sidecar/server, Electron renderer, SSE transport,
  session rendering, worker queues, file watcher, and project explorer. Their
  words included:

  > “Look for absolutely everything and anything that could yield event-loop
  > saturation and patch it robustly, optimize the FUCK out of it.”

  > “keep devoting a comprehensive amount of time to looking into the ability to
  > run concurrent sessions in my openfork codebase.”

  > “make sure the project-explorer-panel.tsx is also optimized in this same
  > context; I believe it also unfortunately holds the potential to yield event
  > stream cloggage.”

- **[USER]** The user then supplied multiple independent audits of the real `main` tree,
  emphasizing that prior write-ups sometimes described changes that were not in
  the checked-out code. Their latest correction included:

  > “The cursor needs an epoch, and this is the most serious remaining gap.”

  > “Watcher: concurrency 8 is an ordering regression.”

  > “Ranked for the next pass: stream epoch in the cursor, ring compaction plus
  > time-based sizing … serialize-at-capture … watcher publish ordering, and
  > re-running the four omitted suites.”

- **[INFERENCE]** The current interpretation is: make concurrency safe under sustained load,
  preserve ordering and recoverability, bound every retained structure in bytes
  where practical, reduce renderer work, and leave an evidence-aware record so a
  future agent can continue without assuming an unverified optimization worked.

- **[UNKNOWN]** “Maximum performance” does not specify an acceptable memory,
  battery, or correctness tradeoff. The current work favors bounded memory,
  ordered delivery, and explicit repair over adding more SSE sockets. This is an
  agent decision, not a separately approved product requirement.

## 2. Current state of the task

### Done and verified

- **[OBSERVED] [VERIFIED] Replay cursor identity and handoff ordering.** The replay buffer exposes a
  per-ring epoch and routes validate `epoch:sequence` cursors. Foreign,
  malformed, numeric-only, and out-of-window cursors become gap repairs. The
  handlers subscribe before replay and avoid advertising the latest cursor in a
  readiness frame before a valid replay is delivered. Verified by focused core
  replay tests, package typechecks, and the instance HTTP replay/foreign-epoch
  test.
- **[OBSERVED] [VERIFIED] Cursor-safe coalescing.** Manifest metadata opts event types into
  coalescing; unknown types remain barriers. Cursor-bearing streams merge only
  adjacent runs of one key, so an interleaving such as A1/B1/A2 cannot
  acknowledge A1 merely because A2 was merged. Verified by the event-coalescer
  test that asserts output sequence `[1, 2, 3]` and preserves each fragment.
- **[OBSERVED] [VERIFIED] Watcher ordering and Git filtering.** Publication is sequential to preserve
  same-path create/unlink order. The callback applies ignore rules again at the
  publication boundary. Git control events are allowlisted per event for
  `HEAD`, `refs/**`, and `packed-refs`; transient files such as `index.lock`
  and `MERGE_HEAD` are excluded. Verified by watcher unit/live tests and the
  create-delete-create regression test.
- **[OBSERVED] [VERIFIED] Explorer cancellation correctness.** Scheduler cancellation resolves with a
  private sentinel instead of an empty list; queue pressure cannot erase a
  directory as if the server authoritatively returned no children. Stale list
  results do not mark a newer stale epoch fresh. Search supersession requeues
  ancestors that are still expanded, and nested tree components do not advance
  the root search generation merely by mounting. Verified by focused tree,
  search, and file-tree tests.
- **[OBSERVED] [VERIFIED] Decompression pool bounds and settlement.** The worker pool now admits at
  most 64 MiB of queued/in-flight input bytes. Worker ID mismatches, malformed
  JSON, synchronous `postMessage` failures, and shutdown reject callers and
  release retained-byte accounting. Verified by five fake-worker tests.
- **[OBSERVED] [VERIFIED] SSE parser and generated transport hardening.** The parser handles split
  CRLF, multiline data, comments, retry/ID validation, split UTF-8, and an 8 MiB
  UTF-8 byte limit. Generated V1 and V2 clients cancel readers on return/abort,
  preserve cursors across reconnects, use full-jitter retry, and use heartbeat
  frames as socket-liveness evidence. Verified by 15 parser/transport tests and
  the SDK typecheck/build.
- **[OBSERVED] [UNKNOWN] Net logging remains opt-in.** `OPENCODE_NETLOG=1` or `--net-log` is needed;
  normal desktop operation does not capture every SSE chunk. This was observed
  in `packages/desktop/src/main/logging.ts`; no new test was added in this pass.
- **[ATTEMPTED] [OBSERVED] The audit document was corrected.** The sixth/seventh-pass section no longer
  claims full-jitter/domain-reset semantics or eight-way watcher publication
  that the code does not implement. An eighth-pass correction section records
  the epoch, decompression, parser, explorer, and remaining-work state.

### Done but not fully verified

- **[OBSERVED] [PARTIAL]** The native `/api/event`, legacy `/event`, and `/global/event` paths contain
  epoch-aware replay/gap behavior, but the end-to-end cursor test directly
  exercises the instance legacy route. Native and global route behavior has
  package typecheck coverage and shared buffer tests; separate end-to-end tests
  for every route and every filtered-directory cursor case remain desirable.
- **[OBSERVED] [PARTIAL]** The renderer/server sync path is described as applying native V2 events once
  and keeping legacy `session.next.*` dispatch ordered. The focused reducer and
  server-session tests pass, but no production renderer trace was captured after
  the latest code was present.
- **[ATTEMPTED] [OBSERVED] [PARTIAL]** The SDK generator was run successfully, then the pre-existing generated V2
  worktree state was restored to avoid unrelated formatter churn. The generated
  SSE file and generator source contain the intended transport changes and the
  SDK typecheck passes. A clean regenerated diff should be reviewed before any
  commit because the code generator rewrites many files and line endings.
- **[OBSERVED] [UNKNOWN]** `server.stream.gap` repair behavior is emitted by the server handlers. The
  receiver should verify that every renderer consumer hydrates only the affected
  state and does not silently ignore the control event.

### In progress / partially done

- **[OBSERVED] [IN PROGRESS]** The replay rings still use an estimated object size and retain event objects.
  Exact serialize-at-capture storage was identified but not implemented across
  all three surfaces.
- **[OBSERVED] [IN PROGRESS]** Replay capacity is bounded by frames/bytes, not by a time window with log
  compaction. A hidden renderer can still fall outside the ring and require a
  snapshot repair.
- **[OBSERVED] [IN PROGRESS]** Hidden/occluded Electron behavior is only partially handled. DOM visibility
  is not sufficient for an occluded window, and the stream is not yet closed on
  hide with cursor-based reconnection.
- **[OBSERVED] [IN PROGRESS]** The live tree has a node ceiling, but expand-all has no user-visible depth or
  node budget for a single expanded root larger than the ceiling.
- **[UNKNOWN] [NOT STARTED]** Socket `writableLength` monitoring, server subscription filtering, recursive
  server-side tree listing, rope-based session text accumulation, full code-line
  virtualization, and renderer-to-server adaptive coarsening remain design
  work.

### Not started

- **[UNKNOWN] [NOT STARTED]** A measured persistent 30x throttled scenario combining 32 active sessions,
  expand-all, a background `bun install`, hidden/occluded Electron state, and
  long markdown/code output after the latest changes.
- **[UNKNOWN] [NOT STARTED]** Exact serialized frame retention and time-compacted replay.
- **[UNKNOWN] [NOT STARTED]** A server control channel for per-session cold/snapshot-only modes.
- **[UNKNOWN] [NOT STARTED]** A cross-route subscription filter for event types and filesystem path
  prefixes.

### Blocked or constrained

- **[OBSERVED]** The default app server-sync test invocation can fail before the
  test body because the installed Solid server runtime lacks the `solid-js/web`
  `use` export. Running the affected suite with Bun's `--conditions=browser`
  condition passes. This is an environment/dependency-resolution mismatch, not
  evidence that the session logic is correct in a real Electron renderer.
- **[OBSERVED]** Full core typecheck reports existing test/type-shape failures;
  the changed production files did not appear in the filtered diagnostics.
- **[CONSTRAINT]** The app `AGENTS.md` says never restart the app or server.
  No restart was performed, so runtime behavior in the user's already-running
  desktop process is not verified.

## 3. Concrete artifacts, paths, and identifiers

### Files modified or materially involved

- `packages/core/src/event-replay.ts` — epoch-aware replay cursor parsing and
  ring behavior. Current line anchors: `parseEventSequence` around line 35,
  `epoch` around line 48, oversized-frame reference clearing around line 76.
  Status: focused tests passed; exact serialized retention remains unimplemented.
- `packages/core/src/event-coalescer.ts` — manifest opt-in/barrier behavior and
  adjacent-key restriction for cursor-bearing streams. Status: tests passed.
- `packages/core/src/filesystem/watcher.ts` — publisher filtering, Git control
  allowlist, bounded pending updates, and sequential publication. Relevant
  exports: `dedupeUpdates` around line 61 and `isGitControlPath` around line 70.
- `packages/core/src/database/decompress-pool.ts` — retained-byte admission and
  settlement. `DEFAULT_MAX_RETAINED_BYTES` is around line 39; admission is
  around line 145; shutdown is around line 157. Status: typecheck and five tests
  passed.
- `packages/core/test/database/decompress-pool.test.ts` — fake-worker tests for
  mismatch, malformed JSON, close, postMessage failure, and byte admission.
- `packages/server/src/handlers/event.ts` — native SSE replay ring, epoch
  cursor parsing, gap frame, and replay/readiness handoff. Status: typecheck
  passed; route-specific end-to-end coverage is incomplete.
- `packages/opencode/src/event-v2-bridge.ts` — bridge-level replay epoch and
  sequence mapping; private `GlobalBus` replay capture is retained.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts` —
  legacy instance SSE replay/gap/readiness path. Cursor parsing is around line
  75; readiness and output mapping around lines 131–134.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` —
  legacy global SSE replay/gap/readiness path.
- `packages/app/src/context/file/tree-store.ts` — shared listing scheduler,
  generation cancellation, `CANCELLED_LIST` around line 51, stale result guard
  around line 499, and loading finalizer around line 617.
- `packages/app/src/components/file-tree.tsx` — root-only search-generation
  effect around lines 273–274.
- `packages/app/src/components/project-explorer-search.ts` — query-generation
  ownership and ancestor requeue behavior.
- `packages/sdk/js/src/sse-parser.ts` — incremental UTF-8-aware SSE parser.
- `packages/sdk/js/script/build.ts` — generator patch that handles both
  one-line and prettier-wrapped generated reader shapes around lines 115–220.
- `packages/sdk/js/src/gen/core/serverSentEvents.gen.ts` and
  `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts` — generated V1/V2
  transport output. Do not hand-edit these as a lasting workflow; update the
  generator and regenerate.
- `packages/sdk/js/test/sse-parser.test.ts` and
  `packages/sdk/js/test/sse-transport.test.ts` — parser and generated-client
  adversarial coverage.
- `docs/handoff/AUDIT-event-loop-concurrency.md` — cumulative audit and corrected
  sixth/seventh/eighth-pass findings.
- `docs/handoff/HANDOFF-event-loop-concurrency.md` — this handoff artifact.

### Files read for context but not necessarily changed in this handoff

- `packages/app/src/pages/session/v2/project-explorer-panel.tsx`.
- `packages/app/src/context/file/watcher.ts`.
- `packages/session-ui/src/components/session-turn.tsx`.
- `packages/session-ui/src/components/markdown-stream.tsx` and worker files.
- `packages/desktop/src/main/logging.ts`.
- `packages/core/src/event.ts`.
- `packages/schema/src/event-manifest.ts` and event definitions.
- `docs/handoff/AGENTS.md` — handoff-specific repository instructions.
- `packages/app/src/pages/session/v2/project-explorer-panel.tsx` — inspected as
  a potential renderer/event-stream pressure surface; no direct file diff was
  made in this continuation, so panel-level runtime improvement is unverified.
- `packages/app/AGENTS.md` and `packages/opencode/AGENTS.md`.

### Commands run and observed status

- `bun test test/event-byte-queue.test.ts test/event-coalescer.test.ts
  test/event-replay.test.ts test/event.test.ts test/filesystem/watcher.test.ts`
  from `packages/core`: focused event/watcher run passed; the latest narrower
  rerun was 30 passed, 1 skipped.
- `bun test test/database/decompress-pool.test.ts` from `packages/core`: **5
  passed, 0 failed**.
- `bun test src/context/file/tree-store.test.ts
  src/components/project-explorer-search.test.ts src/components/file-tree.test.ts
  src/context/file/watcher.test.ts` from `packages/app`: **29 passed, 0 failed**
  in the broader run; a later focused run was **24 passed, 0 failed**.
- `bun test src/context/server-session.test.ts
  src/context/server-session-v2-reducer.test.ts src/utils/session-message.test.ts`
  from `packages/app`: **81 passed, 0 failed**.
- `bun test --conditions=browser src/context/server-sdk.test.ts
  src/context/server-sync.test.ts` from `packages/app`: **31 passed, 0 failed**.
- `bun test test/server/httpapi-event.test.ts` from `packages/opencode`: **5
  passed, 0 failed**.
- The focused epoch/replay HTTP test added to that suite: **4 passed, 0 failed**.
- `bun test test/sse-parser.test.ts test/sse-transport.test.ts` from
  `packages/sdk/js`: **15 passed, 0 failed**.
- `bun run build` from `packages/sdk/js`: completed successfully after the
  generator patch was made robust to the wrapped-reader output shape. The build
  temporarily deleted/generated `openapi.json`; it was regenerated and compacted
  back to the tracked state afterward. The generated V2 worktree was restored
  from the pre-build working copy to avoid unrelated formatter churn.
- `bun run typecheck` from `packages/opencode`: exit 0.
- `bun run typecheck` from `packages/server`: exit 0.
- `bun run typecheck` from `packages/sdk/js`: exit 0.
- `bun run typecheck` from `packages/core`: nonzero because of existing test and
  fixture type diagnostics; no changed production file appeared in the filtered
  output. Do not describe this as a clean core typecheck.
- `git diff --check` on the touched package/doc paths: no whitespace errors;
  Git printed normal LF→CRLF conversion warnings for generated/edited files.
- **[OBSERVED] Relevant worktree status at handoff:**
  `packages/core/src/database/decompress-pool.ts` (modified),
  `packages/core/test/database/decompress-pool.test.ts` (modified),
  `packages/sdk/js/script/build.ts` (modified),
  `packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts` (modified),
  `docs/handoff/AUDIT-event-loop-concurrency.md` (untracked), and this handoff file
  (untracked). The repository also has unrelated pre-existing dirty files;
  the receiver must inspect the full status before staging anything.

### External sources, credentials, and saved outputs

- No web sources, external APIs, credentials, or paid tools were used.
- The user-provided specification was read from
  `C:\Users\slooshied\.t3\userdata\attachments\c28431c7-91ef-406e-a0a6-d87bdfd112d2-5c9e536d-6065-4791-b484-c30ad9ec9efd-md.md`.
- Existing diagnostic artifacts are under `.opencode/cache/`; do not assume
  that an old benchmark file is a post-change measurement.

## 4. What I actually attempted (chronological, recency-weighted)

### Attempt 1 — latest: write the evidence-aware audit continuation

- Tried: reconciled the user’s sixth/seventh-pass critique with actual source,
  tests, typechecks, and the existing audit document.
- Why: the existing document claimed some behaviors that were not true in the
  checked-out code, especially cursor continuity, jitter, watcher concurrency,
  and heartbeat semantics.
- Observed: the code contains epoch-aware cursor changes, adjacent-only cursor
  coalescing, sequential watcher publication, and the decompression pool fixes;
  exact serialized capture and time-compacted replay are absent.
- Outcome: the audit was updated; content is written but has not been reviewed
  by the user. Status: **written, user acceptance unverified**.
- Confidence: high for the source/test observations, mixed for architectural
  prioritization.

### Attempt 2 — bound the decompression read path

- Tried: add retained-byte accounting, a 64 MiB admission ceiling, idempotent
  settlement, and shutdown rejection to `DecompressPool`.
- Why: the reviewer identified an unbounded queue retaining input bytes plus
  worker clones beneath the event-stream budgets.
- Observed: fake-worker tests cover every intended settlement path and pass.
- Outcome: **worked for the tested unit behavior**. Real worker throughput and
  clone-memory behavior remain unmeasured.

### Attempt 3 — harden generated SSE transport regeneration

- Tried: make `packages/sdk/js/script/build.ts` patch both one-line and
  prettier-wrapped `response.body` reader shapes, use a byte `TextDecoder`,
  cancel readers, and preserve jitter/liveness behavior after regeneration.
- Why: the first build attempt left V2 on the old `TextDecoderStream` shape and
  exposed a duplicate decoder in V1; those failures were observed rather than
  silently ignored.
- Observed: the first build failed with `Cannot find name 'decoder'`, then with
  `"decoder" has already been declared`. The generator patch was corrected; a
  later build exited 0 and SDK transport tests passed.
- Outcome: **worked**, with the caveat that codegen rewrites unrelated generated
  files and must be reviewed before committing.

### Attempt 4 — verify cursor epoch and replay order

- Tried: add/execute an HTTP test that opens a stream, captures a cursor,
  publishes an event, reconnects with the cursor, and reconnects with a foreign
  epoch.
- Why: the user identified a restart cursor collision as the most serious gap.
- Observed: valid replay arrives before a readiness cursor; foreign epoch emits
  a gap. The suite passed.
- Outcome: **verified for the instance HTTP route**; native/global route e2e
  behavior remains only partially verified.

### Attempt 5 — explorer cancellation and watcher ordering

- Tried: exercise queue overflow, stale invalidation during a listing, shared
  search ancestor supersession, create-delete-create watcher order, and Git
  transient filtering.
- Why: the reviewer found empty-list cancellation corruption and eight-way
  watcher publication ordering risk.
- Observed: all focused explorer and watcher tests passed.
- Outcome: **verified for the covered unit/live scenarios**; a 10,000-event
  production-like watcher flood was not run.

### Attempt 6 — investigate but do not overclaim exact serialization/compaction

- Tried: reason about moving serialization to capture and compacting the replay
  log. Did not complete a safe cross-route implementation because append-only
  text cannot be compacted by keeping only the newest delta, and route-specific
  legacy adaptation changes the wire shape.
- Why: the user’s review proposed this as the next architectural priority.
- Outcome: **not implemented**. The audit records it as remaining work rather
  than laundering the design into a completed fix.

## 5. User feedback on prior attempts

### Approved or implicitly accepted

- **[USER]** The user continued asking for deeper passes and explicitly expanded
  scope to the project explorer, concurrent sessions, and the audit document.
  This authorizes continued in-scope investigation and patching, but is not an
  explicit acceptance of every individual code change.
- **[USER]** The user asked that `docs/handoff/AUDIT-event-loop-concurrency.md` include
  “ALL of your comprehensive 6th/7th pass continuation findings, changes, etc.”

### Rejected or corrected

- **[USER]** “I pulled the actual main tree rather than taking the write-up at
  face value.” This is a standing warning: do not trust a prior summary without
  checking the current files.
- **[USER]** The user called out that the stream had no resume semantics and
  that `id: undefined` made overflow recovery rehydrate too much.
- **[USER]** The user corrected the static ring design: a 4,096-frame/8 MiB
  ring is too short for hidden-window gaps and needs time sizing plus safe
  compaction.
- **[USER]** “Watcher: concurrency 8 is an ordering regression.” Do not restore
  unordered concurrent publication for same-path events without path sharding
  or an equivalent ordering proof.
- **[USER]** The user said publisher filtering must happen before the shared
  session stream is flooded and identified `node_modules`, `dist`, `target`,
  `.venv`, and build outputs as relevant noise sources.
- **[USER]** The user repeatedly asked to “continue”; no user-approved stop,
  rollback, or clean-worktree request was given.

### Open questions the user has not answered

- Is the desired hidden-window behavior to close SSE immediately, or is a
  background low-rate control stream required for liveness/UI notifications?
- What memory/battery tradeoff is acceptable for `backgroundThrottling: false`?
- Should exact replay retention prioritize minutes of hidden-session repair or
  smaller steady-state memory?
- Is a visible “expand-all truncated at N” affordance acceptable, and what N is
  appropriate for the product?
- What production trace or user-visible latency threshold defines success?

## 6. Decisions made and rationale

- **[INFERENCE] Decision:** Do not add multiple SSE streams as a saturation strategy.
  - Alternatives: one stream per session, a stream pool, or load balancing
    across renderer sockets.
  - Rationale: parsing, adaptation, reducers, Solid writes, and ordering still
    serialize on the renderer’s JavaScript event loop; extra streams add socket
    buffers and cross-stream ordering hazards. This is an agent inference from
    the architecture, not a benchmark-proven universal rule.
  - Reversibility: easy; a future protocol can add filtered lanes if measured.
  - Approval: agent decision consistent with the user’s audits; not separately
    approved.
- **[USER] [INFERENCE] Decision:** Use an epoch plus sequence rather than sequence alone.
  - Alternatives: reset sequence to zero and treat a future cursor as current,
    or force every reconnect to hydrate.
  - Rationale: a fresh ring can otherwise mistake an old process cursor for a
    valid current position; future cursors must be gaps, never no-ops.
  - Reversibility: protocol-visible and therefore moderately hard.
  - Approval: user explicitly ranked the epoch as the next priority.
- **[INFERENCE] Decision:** Keep cursor-bearing coalescing adjacent-only.
  - Alternatives: merge all same-key fragments within a timer window and attach
    the newest sequence.
  - Rationale: newest-sequence attachment can acknowledge an earlier fragment
    that was never delivered.
  - Reversibility: local implementation change; wire ordering semantics matter.
  - Approval: agent decision backed by a regression test.
- **[USER] [INFERENCE] Decision:** Publish watcher events sequentially.
  - Alternatives: eight concurrent effects, path-hash sharding, or per-path
    counters.
  - Rationale: native publication was already non-blocking; concurrency eight
    introduced same-path ordering risk without removing the real publisher
    bottleneck.
  - Reversibility: easy, but any future concurrency must preserve per-path order.
  - Approval: user explicitly identified the ordering regression.
- **[INFERENCE] Decision:** Reject decompression submissions above the retained-byte budget.
  - Alternatives: an unbounded waiter list, silently dropping reads, or
    transferring caller-owned buffers.
  - Rationale: a waiter list still retains the bytes and defeats the bound;
    rejecting lets the read path surface backpressure/error rather than OOM.
  - Reversibility: easy; a real upstream bounded reader can replace rejection.
  - Approval: agent decision based on the user’s unbounded-queue finding.
- **[INFERENCE] Decision:** Keep exact serialize-at-capture and time-compacted replay open.
  - Alternatives: implement a lossy newest-delta compactor immediately.
  - Rationale: append-only text deltas cannot be discarded without an accumulated
    snapshot or equivalent state boundary. A fast but lossy implementation would
    turn repair into silent text corruption.
  - Reversibility: intentionally deferred, not rejected.
  - Approval: agent safety decision; user has not approved the eventual protocol.

## 7. Known constraints and invariants

- **[CONSTRAINT]** Do not restart the desktop app or server. `packages/app/AGENTS.md` explicitly
  forbids it. Runtime claims must be labeled unverified unless a sanctioned
  running process is already available.
- **[CONSTRAINT]** Run tests from package directories, never repo root. Use `bun run typecheck`,
  not direct `tsc`.
- **[CONSTRAINT]** After changing `packages/opencode/src/server/routes/**`, regenerate the
  unified SDK with `bun run build` from `packages/sdk/js`; do not hand-edit
  generated SDK files as the lasting workflow.
- **[CONSTRAINT]** Preserve the dirty worktree. Do not use `git reset --hard`, broad checkout,
  or destructive cleanup. Existing untracked artifacts and unrelated user work
  belong to the user unless proven otherwise.
- **[CONSTRAINT]** Keep native V2 and legacy event application in one ordered pipeline; do not
  introduce a second queue that can invert cross-family events.
- **[CONSTRAINT]** Do not drop append-only session events merely to reduce pressure unless a
  snapshot/gap repair contract proves correctness.
- **[INFERENCE]** Event queues need both item and byte bounds where retained payload size can be
  large. Event-count limits alone are not a memory proof.
- **[INFERENCE]** Hidden/occluded Electron behavior must be treated separately from ordinary
  `document.visibilityState`; Chromium may throttle an occluded renderer.
- **[CONSTRAINT]** Avoid hardcoded user-visible English in production UI; use existing i18n.
- **[CONSTRAINT]** Keep the fork’s release-tag synchronization model. Do not merge upstream dev
  or change fork ownership rules while working on this task.

## 8. Dead ends and things already ruled out

- **[INFERENCE] More SSE sockets as load balancing:** ruled out as an unproven fix because
  the renderer’s apply/parse/reducer/DOM work remains one event loop and streams
  introduce ordering and buffer duplication.
- **[OBSERVED] Sequence-only replay cursors:** ruled out by the restart collision. A cursor
  above the current ring must be a gap, not an empty successful replay.
- **[INFERENCE] Newest-delta-only replay compaction:** not safe for append-only text. Do not
  implement without a snapshot or accumulated-content boundary.
- **[USER] [OBSERVED] Eight-way watcher publication:** identified as an ordering regression for
  create/unlink sequences. Do not retry without path-order proof.
- **[OBSERVED] Resolving cancelled explorer jobs as `[]`:** reproduced as a correctness
  hazard because the list completion path treats the result as authoritative
  emptiness. The sentinel approach is now tested.
- **[INFERENCE] Unbounded decompression waiters:** ruled out because queued promises still
  retain input bytes. Admission rejection is currently the bounded behavior.
- **[INFERENCE] Switching Electron file logging to an async unbounded transport:** ruled out
  as a standalone fix; it trades synchronous blocking for an unbounded write
  queue.
- **[OBSERVED] Default browser runtime for app server-SDK tests:** failed because the
  installed Solid server export lacks `solid-js/web` `use`. The browser
  condition is the working test environment; do not interpret the default
  runtime failure as a session reducer failure.
- **[CONSTRAINT] Running a production benchmark by restarting the app/server:** not done due
  to explicit repository constraints. Do not claim before/after latency.

## 9. Risks, suspicions, and unknowns

- **[OBSERVED] Known risk:** replay rings can still fall out during a long hidden period;
  the result is a gap/full hydration rather than a compact replay. This is
  correct but may remain expensive.
- **[OBSERVED] Known risk:** `estimateEventBytes` is not exact serialized UTF-8 retention.
  It bounds conservatively in current tests but does not prove wire-memory size.
- **[OBSERVED] Known risk:** a single expanded directory larger than the live node ceiling
  has no safe eviction victim. Current behavior must not silently evict visible
  expanded content.
- **[OBSERVED] Known risk:** filesystem publisher filtering for the project-root watcher
  is gated by the experimental flag; confirm the user’s default flag state
  before prioritizing that flood path.
- **[INFERENCE] Suspected, unverified:** markdown full-text lexing, DOM sanitization, Solid
  turn derivation, growing string accumulation, and worker state retention can
  still produce superlinear renderer cost under long concurrent sessions.
- **[INFERENCE] Suspected, unverified:** socket `writableLength` may grow after accepted
  queue frames when a renderer stops reading; no adapter-level threshold test
  exists yet.
- **[UNKNOWN]** whether the user’s worst lag is server CPU, loopback socket
  buffering, Chromium background throttling, renderer reducer/DOM work, or a
  combination. No new production trace was collected.
- **[UNKNOWN]** whether all renderer consumers handle `server.stream.gap` with
  targeted repair rather than full navigation/hydration.
- **[UNKNOWN]** whether all existing generated SDK changes are intended to remain
  after the next clean codegen run; generator formatting creates broad diffs.
- **[INFERENCE] Assumption that may be wrong:** the shared listing scheduler key accurately
  identifies a sidecar/server connection. Verify URL normalization and lifecycle
  ownership before relying on it for global fairness.

## 10. Validation status summary

| Item | Status | How verified or why not |
|---|---|---|
| Replay epoch parsing and future/foreign cursor gaps | Verified | Core replay tests, including prior-epoch case |
| Instance HTTP replay-before-readiness and foreign epoch | Verified for instance route | Four focused HTTP tests passed |
| Native/global SSE epoch behavior | Partially verified | Package typechecks/shared code; separate route e2e coverage remains |
| Adjacent-only cursor coalescing | Verified | Event-coalescer sequence regression passed |
| Sequential watcher publication and Git allowlist | Verified for covered paths | Watcher unit/live suite and ordering tests passed |
| Explorer cancellation sentinel/stale epoch/search requeue | Verified for focused scenarios | 24 focused app tests passed; no 10k flood trace |
| Decompression retained-byte budget and shutdown settlement | Verified | Five fake-worker tests passed; core source typechecks within changed paths |
| SSE parser UTF-8/CRLF/metadata/limit handling | Verified | Nine parser tests passed |
| V1/V2 SSE cancellation/jitter/heartbeat tests | Verified | Six transport tests passed |
| SDK regeneration path | Verified for one build | `bun run build` exited 0; clean generated diff still needs review |
| App session/reducer/sync omitted suites | Verified in split runtimes | 81 default-runtime and 31 browser-condition tests passed |
| Core full typecheck | Failed baseline | Existing fixture/test diagnostics; changed production paths not listed |
| Production event-loop throughput improvement | Unverified | No post-change 30x trace and no app/server restart |
| Exact serialize-at-capture replay | Not implemented | Estimator/object retention remains |
| Time-compacted ring/disconnect-on-hide | Not implemented | Explicit next architectural step |
| Socket backpressure enforcement | Not implemented | `writableLength` threshold not added |
| Bounded expand-all UX | Not implemented | Node/depth budget and truncation affordance absent |

## 11. Recommended next actions

1. Read this handoff and inspect the current `git status`/diff before changing
   anything. Expected signal: the receiver can identify which changes are
   pre-existing user work and which are this continuation’s edits.
2. Re-run the exact focused suites from section 3 after any local edits, then
   run the native `/api/event` and global `/global/event` cursor paths with
   filtered multi-directory events. Expected signal: valid cursors replay a
   filtered suffix; foreign epochs always produce a gap; readiness never jumps
   the cursor ahead of replay.
3. Design exact serialize-at-capture storage before changing compaction. Define
   the wire frame type, UTF-8 byte accounting, legacy adaptation boundary, and
   how coalesced append-only text gets a snapshot boundary. Expected signal: a
   proof that replay bytes equal retained bytes and that text cannot be lost.
4. Implement a time-sized, compacted replay log only after step 3. Preserve all
   barriers and either accumulated text or a repair snapshot. Expected signal:
   hidden-window reconnects within the target interval replay without full-world
   hydration; older cursors produce explicit targeted gaps.
5. Add socket `writableLength`/write-failure thresholds and test deliberate
   close/reconnect repair. Expected signal: a stalled consumer cannot grow a
   socket indefinitely after the subscriber queue accepts a frame.
6. Add server-side event/path subscription filtering. Measure event count and
   bytes before and after filtering during a dependency-install and branch-switch
   burst. Expected signal: ignored watcher events never enter the session stream.
7. Define an expand-all node/depth budget and localized truncation affordance.
   Test a synthetic root larger than the live node ceiling. Expected signal:
   visible content is never silently evicted and the operation terminates.
8. Run a persistent Electron scenario with concurrent sessions, hidden/occluded
   renderer, long markdown/code output, expand-all, and watcher flood. Record
   server CPU, event-loop delay, queue bytes, socket writable bytes, renderer
   apply/render duration, reconnect/gap rate, and hydration duration. Expected
   signal: a before/after measurement tied to the actual user-visible lag.
9. Only after measurements, decide whether rope accumulation, incremental
   markdown lexing, worker sharding/style IDs, or renderer adaptive coarsening
   provides the largest remaining gain.

## 12. Do-not-touch / do-not-repeat list

- Do not reset or clean the dirty worktree broadly. Existing untracked benchmark,
  audit, and handoff files may belong to the user.
- Do not restart the desktop app or sidecar/server during this task.
- Do not add more SSE sockets simply because concurrency is high.
- Do not restore unordered watcher concurrency eight without a same-path ordering
  guarantee.
- Do not resolve cancelled tree listings to an empty array.
- Do not compact append-only text by retaining only the newest delta.
- Do not treat a numeric `Last-Event-ID` as valid on an epoch-aware route.
- Do not make a cursor above the current ring a no-op.
- Do not hand-edit generated SDK files as the source of truth. Patch
  `packages/sdk/js/script/build.ts`, regenerate, then review the diff.
- Do not claim a production latency improvement from unit tests or old benchmark
  artifacts.
- Do not call the full core typecheck clean; it currently has baseline fixture
  failures even though changed production paths were not implicated.
- Do not silently convert the user’s remaining architectural questions into
  implementation decisions without recording the tradeoff.

## 13. Synthesis instruction to the receiving agent

Before changing files or running a state-changing command, the receiving agent
must read this document and then state:

1. The user’s goal in its own words: reduce event-loop saturation and make
   concurrent sessions responsive while preserving ordering and recoverability,
   including the project explorer.
2. The current state: epoch-aware replay, ordered/coalesced transport, bounded
   watcher/explorer/decompression work, and hardened SSE parsing are tested in
   focused scopes; exact capture, time compaction, socket backpressure,
   subscription filtering, bounded expand-all, and production measurement remain
   open.
3. Which parts of this handoff it trusts and which it will re-verify, especially
   native/global route e2e behavior, generated SDK diffs, and any claim about
   renderer performance.
4. Whether the next action is verification, implementation, or measurement. If
   a proposed action could discard user work, alter the wire protocol, restart a
   process, or change a product tradeoff, it must be surfaced before execution.

The receiver should not treat this document as proof that the overall lag is
solved. It is an execution-state transfer: verified fixes, failed attempts,
known constraints, and unresolved hypotheses are deliberately kept separate.
