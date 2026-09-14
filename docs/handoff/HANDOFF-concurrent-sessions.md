# Handoff: Concurrent Session Renderer Flooding Audit

## 0. Handoff Metadata

- **Date/Time (UTC)**: 2026-09-12 17:47 UTC
- **Sending Agent**: Gemini 3.8 Flash
- **GetMCP Endpoint URL**: https://cheese-teachers-earning-scuba.trycloudflare.com/v0/init/tuo6SXnL
- **Scope Root**: `/project/opencode`
- **Revision**: See the ADDENDUM (Eleventh Pass) below + sections 1-2 contain findings that did not survive verification against the source. Read the addendum before acting on the remediation roadmap.

## 1. Executive Summary & Bottleneck Identification

Investigation into concurrent sessions (e.g., 8 running sessions) flooding the renderer
revealed that the choke point is not network/SSE pipe saturation or transport packet
delivery delays. Transport batches and event-ring buffers deliver events cooperatively.

Rather, the bottleneck stems from the **monolithic reactive state model and fine-grained
invalidation leaks in `packages/app/src/context/server-session.ts`**:

1. **Monolithic Store Reactivity**:
   All sessions share a single `createStore` state instance. Streaming token deltas from any
   of the 8 concurrent sessions trigger Solid store graph dependency sweeps and computations
   across all components attached to the session context.

2. **Reactive Delta Accumulator Churn**:
   `part_text_accum_delta` resides inside the reactive store. Every incoming text or reasoning
   delta mutates the reactive store directly via `setData("part_text_accum_delta", ...)`,
   generating hundreds of reactive notifications per second.

3. **Coarse Part Array Granularity (`Record<string, Part[]>`)**:
   Parts are stored as arrays keyed by parent message ID. Updating a single streaming part
   replaces or mutates the entire message part array, invalidating every sibling part and
   rendered turn row in that message. Across 8 active streams, this results in an
   $O(N_{\text{sessions}} \times N_{\text{messages}})$ re-render load.

4. **Lack of Viewport Gating for Background Sessions**:
   Sessions that have been loaded or visited continue to execute `applyV2`, `projectV2`, and
   `normalizeSessionMessages` for every token chunk even while rendered in the background.

## 2. Remediation Roadmap

1. **Extract the Streaming Accumulator**:
   Move `part_text_accum_delta` out of Solid's reactive store into a plain JavaScript `Map<string, string>`
   with frame-throttled (rAF / 16ms) signal notifications.

2. **Re-Key Parts by Part ID**:
   Transition from `Record<string, Part[]>` to a flat part map `Record<string, Part>` plus an
   ordered ID list `Record<string, string[]>`. Deltas will only invalidate the targeted part leaf.

3. **Background Session Projection Gating**:
   Defer full V2 message normalization and projection for background sessions until they are
   switched into view or reach turn/step completion.

---

## ADDENDUM (Eleventh Pass) - Corrections and Revised Hypothesis

**Status**: The Tenth Pass diagnosis above is partly unsupported by the source. Verified line-by-line against `packages/app/src/context/server-session.ts` (1,561 lines) before any code change. **No remediation from section 2 was applied.**

### A. New evidence from the reporter

1. Lag **scales with the number of concurrently active sessions**.
2. Lag **resolves when the sessions complete**, with no reload and no navigation.

This pattern is the key discriminator. Cost tied to store *shape* (monolithic store, `Part[]` array granularity) would **persist** after completion, because the store still holds the same keys and the same array layout when streaming stops. Cost that **disappears** on completion must be gated on a **liveness predicate** - something only true while `session_working` is `true`. That redirects the investigation away from `server-session.ts` entirely.

### B. Primary suspect: per-row 1s ticker x full-session re-aggregation in the chat sidebar

`packages/app/src/pages/session/v2/chat-sidebar-pane.tsx`

The pane owns one shared 1-second ticker (line 174, `setInterval(() => setNow(Date.now()), 1000)`) - correctly shared rather than per-row, and its comment says so: "per-row intervals would multiply timers by the number of visible sessions." It is passed into rows as `now` (line 1088). But sharing the *timer* does not share the *work it triggers*.

Each session row (`ChatSidebarSessionRow`, from line ~1540) has:

```ts
const live = createMemo(() => {
  if (!isWorking()) return undefined                  // 1607 - liveness gate
  // ...find active assistant message...
  const progress = liveGenerationProgress(active, activeParts, props.now())  // 1628
  rate: computeMeasuredRate(activeParts, props.now())?.rate ?? null      // 1633
})
```

The `isWorking()` early return at line 1607 is precisely the liveness predicate the symptoms imply:

- **While N sessions stream**: N row memos depend on `now()`. Every tick invalidates all N, and each re-runs `liveGenerationProgress`   `computeMeasuredRate` - both of which walk the active message's **entire part array**. `streamedChars` sums `part.text.length` over every text/reasoning part; `computeMeasuredRate` scans all parts for min `time.start` / max `time.end`; `toolExecutionSeconds` walks them again. Per-tick work is **O(N_active x parts_per_turn)**.

- **`parts_per_turn` grows monotonically as a turn streams**, so the per-tick cost degrades over the life of each turn, not just with N. This explains "progressively gets worse" as a compounding effect rather than a flat multiplier.
- **On completion**: `session_working` flips to `idle` (via `session.status` / `session.execution.*`), `isWorking()` returns `false`, every row memo short-circuits at line 1607, and the per-tick cost vanishes - no reload needed. **This matches "resolves itself when all sessions complete" exactly.**

Critically, this cost is **not suppressed by the `suspended`/`release()` gate**. That gate only blocks `v2.reduce`/`projectV2` inside `server-session.ts` (lines 1046-1049 and 1109). Sidebar rows read `serverSync().session.data` directly (line 1547) and are driven by a **wall-clock timer**, not by events - so background sessions keep paying every second even though their deltas are correctly being dropped. The Tenth Pass assumed gating was missing; it exists, but **it does not cover timer-driven consumers**. That is the actual gap.

### C. Secondary suspect: `totals()` passes the whole part map, per row

Line 1582:

```ts
const session = aggregateSessionContextByModel(messages(), sessionData().part, []).session
```

`sessionData().part` is the **global part record for every message of every session**, not this row's slice. The doc comment above `totals` states it "deliberately does NOT read `now()`" so the tick runs a cheap memo instead of re-aggregating once a second. That intent is sound and holds for the **timer**.

But the memo still **tracks `data.part`**, and streaming deltas mutate `data.part` continuously. `aggregateSessionContextByModel` (line 432) loops every assistant message and calls `countToolCalls(parts[msg.id])` plus `measuredGenerationSeconds` per message, so a spurious wake-up here costs **O(messages x parts)** per row. **[UNVERIFIED]** Whether Solid's fine-grained tracking narrows this to the touched message or coarsens to the whole record (because the container is handed to a plain non-reactive function) was **not determined by reading** - it needs the profile in section F.

### D. Corrections to the Tenth Pass

**Finding 1 (monolithic store) - partly right, wrong consequence.** A single `createStore` does exist (lines 216-237), but all hot writes are **key-path targeted**, so a delta in session A does not sweep components bound to session B's keys. Shared container, not shared invalidation.

**Finding 3 (coarse `Part[]` granularity) - not supported by the code.** The claim that any delta "replaces or mutates the entire array" is contradicted by the delta handler at lines 1356-1365, which mutates **one indexed leaf's one field** via `produce`.

`message.part.updated` likewise writes `setData("part", messageID, result.index, reconcile(part))` (1274). Array-identity replacement happens only on **part insertion** (1276-1281) - once per new part, not per token. The `O(N_sessions x N_messages)` per-token cascade is asserted, not demonstrated. **Do not re-key to `Record<string, Part>` on this basis**; it is a large invasive refactor whose justification does not reproduce, and it would not explain recovery-on-completion either.

**Finding 4 (no viewport gating) - already implemented.** `suspended` (253) + `release()`/`resume()` (904-913) + the pre-reduce bail at 1046-1049 (V2) and 1109 (V1), wired to the route in `pages/session/timeline/model.ts` (release on session change and in `onCleanup`, resume on activation). The inline comment above 1032 already states the rationale in nearly the handoff's words. A second gate exists in `global-sync` (`sessionContent: false`), locked by `session-content-gate.test.ts`. **Remediation #3 would rebuild existing machinery.**

**Finding 2 (accumulator churn) - real, but the proposed fix breaks rendering.** `part_text_accum_delta` is reactive and written per delta (1348), so churn is real. But it is **read by the renderer**: `session-ui/src/components/message-part.tsx` lines 2116 and 2174 call `readPartText(data.store.part_text_accum_delta, part())`, and `readPartText` **prefers the accumulator over `part.text`**. Moving it to a plain non-reactive `Map` removes the reactive source streaming text renders from - text would stop updating mid-stream.

It is also load-bearing in `directory-sync.ts` (`sessionFields`, line 21), `global-sync/session-cache.ts`, `global-sync/event-reducer.ts`, and ~12 assertions across three test files. Any extraction must preserve a reactive read path (e.g. a per-part signal `readPartText` consumes) - not a plain `Map`.

### E. One real per-token finding in `server-session.ts`

The `message.part.delta` handler writes the same text **twice per token**: once to `part_text_accum_delta[partID]` (1348) and once to `part[messageID][index][field]` (1356). Since `readPartText` prefers the accumulator and falls back to `part.text`, that is two reactive writes producing one rendered string. Note this is **not** a fit for the reported symptoms: it is paid only for non-suspended sessions and scales with token rate, not with `N_active`, and it would not clear on completion any differently. Worth fixing as hygiene; not the lag cause.

### F. Recommended next step: measure before refactoring

`N_active` scaling plus clean recovery on completion is a **timer-x-liveness** signature, not a store-shape signature. Confirm cheaply before touching `server-session.ts`:

1. **Raise the sidebar ticker** (line 174) from `1000`ms to `5000`ms with N sessions streaming. If lag drops roughly proportionally, section B is confirmed and the Tenth Pass roadmap is aimed at the wrong file. Cheapest decisive test; revert after.
2. **Profile a tick** while N sessions stream; look for N stacks per second under `computeMeasuredRate` / `streamedChars` / `toolExecutionSeconds` / `aggregateSessionContextByModel`. This also settles the section C question.
3. **Collapse the duplicate part-walks** - `liveGenerationProgress` and `computeMeasuredRate` traverse the same `activeParts` on the same tick; one pass can serve both.
4. **Cache `streamedChars` incrementally** - recomputed from scratch each tick over a monotonically growing array.
5. **Scope `totals()` to one session's parts** instead of handing it the global `part` record.
6. **Also audit** `pages/session/timeline` row projection and `prompt-input` `createLiveGenerationRate` (a `200`ms sampler gated on `args.working()` - same liveness signature at 5x frequency, though it appears scoped to the active composer rather than per-session).

**Do not implement Tenth Pass items 1-3 as written.** Item 1 would break streaming text render, item 2 is unjustified by the code, item 3 is redundant. None of the three explains either reported symptom.


---

## ADDENDUM (Twelfth Pass) - H1 quantified, H2 falsified, the real driver found and fixed

**Date**: 2026-09-12 UTC. **Status**: fix applied to `packages/app/src/context/server-session.ts` (+ regression test). Packages/app AGENTS.md forbids restarting the app and no dev instance was running, so **no in-app CPU profile was obtained**. Measurements below come from a temporary Bun harness that drove the real `createServerSession` store with real `applyV2` V2 stream events and the exact ChatRow memo graph; the harness was removed per TASK section 12 and its raw output is preserved at `.opencode/cache/twelfth-pass-concurrent-session-lag.txt`. Tag `[MEASURED-HARNESS]` means measured in that harness, not in the running app.

### A. Method and its limits

- Harness: real `createServerSession({} as OpencodeClient)`, history seeded through the real `normalizeSessionMessages`, deltas delivered as real `session.text.delta` events via `store.applyV2`. The memo graph mirrors `chat-sidebar-pane.tsx:1607-1638` (`isWorking`/`messages`/`totals`/`live`) and is observed with `createComputed`.
- `[VERIFIED]` A first run under `--conditions=solid` was invalid: that condition loads Solid's server build (`solid-js/dist/server.js`), where computed values never react. All numbers below use `--conditions=browser`. A second harness bug (an unmemoized `totals`) was fixed before the retained run; discarded numbers are called out in the cache file.
- Limits: no Electron renderer, no SSE parse/coalescing, no markdown. Per-delta figures are reducer+projection CPU only; absolute values will differ in the app, the ratio between gated and ungated sessions is the load-bearing result.

### B. H1: mechanism `[VERIFIED]`, causation `[FALSIFIED]`

- `[MEASURED-HARNESS]` 16 working rows, 200 parts on each active message, 82-message histories, 20 ticks: the `live` memo ran **exactly once per working row per tick** (`liveEvals` 336 = 16 mount + 20 x 16) and `totals` did not re-run at all after mount (16 total). A whole 16-row tick cost **2.8ms**, i.e. ~0.3% of one core at 1Hz.
- `[MEASURED-HARNESS]` Ticker bisect equivalent: identical 10s workload (8 sessions, 4000 deltas) with a 1000ms vs 5000ms ticker changed `live` evaluations 104 -> 40 and changed wall time from 1599ms to 1295ms - within run noise. The task's one-token experiment would therefore show no meaningful improvement.
- `[VERIFIED]` H1 is not delta-coupled on the native V2 path either. V2-projected text parts carry no `time` (`utils/session-message.ts:305-314`), so `computeMeasuredRate` returns before `streamedChars` (`live-generation-rate-math.ts:80`) and `live` never subscribes to `part.text` for those parts. The task's premise that H1 fires at 1Hz is right; it just does not fire at token rate, and at 1Hz it is three orders of magnitude too small to stall the loop.

### C. H2: `[FALSIFIED]`

- `[MEASURED-HARNESS]` 16 rows x 3200 real V2 deltas with no ticks: `totals` evaluated 16 times total (mount only) and `live` 32 (mount plus the one-off part insertion on each session's first delta). **Zero per-token wakeups.**
- `[VERIFIED]` The store semantics rule this out structurally. Solid 1.9.10 `setProperty` notifies only the written key plus `$SELF`/`$HAS` (`packages/app/node_modules/solid-js/store/dist/store.js:119-138`); `reconcile`/`applyState` recurse and notify changed leaves only (314-395); `produce` returns the same state so `setData("part", messageID, produce(...))` does not replace the array (`store.js:414-425`, handler at `server-session.ts:1362-1371`). A per-token write changes one `text`/`input` leaf; `totals` reads `type`/`time`/`state` and `countToolCalls` iterates parts, none of which are notified. Handing the whole `data.part` record to a plain function does not coarsen tracking.

### D. The confirmed driver: per-token reduce+project for prefetched background sessions `[VERIFIED]` `[MEASURED-HARNESS]`

- `[VERIFIED]` The content gate exists but is **opt-out**: `suspended` starts empty (`server-session.ts:253`) and is only populated by timeline `release` (`pages/session/timeline/model.ts:22,32`); content gating is at `server-session.ts:1056` and `:1119`.
- `[VERIFIED]` `prefetch` (`server-session.ts:922-934`) loads messages into `data.message` but never suspends. Its background callers are the chats-pane row hydration and hover warm (`chat-sidebar-pane.tsx:603-613`, `:619-630`, invoked from `:1095`), layout neighbor/tab warming (`layout.tsx:713-715`), and inactive tab-strip hover (`titlebar-tab-strip.tsx:110-117`). A loaded, never-activated session passes `loaded` (`server-session.ts:1042,1060`) and runs the full `v2.reduce` + `projectV2` path for every token while the user is looking somewhere else.
- `[MEASURED-HARNESS]` `applyV2` per delta for one loaded session, 12 parts/message:

  | history messages | unsuspended (loaded) | suspended |
  |---|---|---|
  | 10 | 161us | 1.2us |
  | 40 | 202us | 1.0us |
  | 160 | 533us | 0.94us |
  | 320 | 1108us | 0.88us |

- `[VERIFIED]` Production coalesces stream deltas to at most one reduced delta per 16ms per key (`server-sdk.tsx` `FLUSH_FRAME_MS`, `currentDeltaKey`), i.e. ~62/s/session. Eight prefetched background sessions each streaming then cost **~264ms/s** of renderer main-thread time at 160 messages, >500ms/s at 320 - and it stops when the sessions complete. That matches both reporter facts; the 1Hz sidebar work cannot.
- `[VERIFIED, NEW EVIDENCE]` This overturns the task's section 6 falsification ("lack of viewport gating... bails before `v2.reduce`/`projectV2`") and the Eleventh Pass section D.4. Both verified the gate's existence, not its coverage. The gate covers timeline-released sessions; prefetch-loaded sessions were never covered. This is not a resurrection on old grounds - it is a measured, distinct write path (prefetch -> loaded -> ungated).

### E. Fix (minimal)

- `prefetch` now marks the session suspended after warming the cache unless the timeline has activated it. New `activated` set: `resume` adds, `release` removes, `evict` clears (`server-session.ts:253-258`, `:543`, `:909-920`, `:922-934`). Active-session behavior, `sync` activation, and timeline release semantics are unchanged; the existing `stale`/`fresh` path (`:1461-1463`) recovers dropped content when the session is activated.
- `[MEASURED-HARNESS]` Real `prefetch` A/B at 160 messages: background **1.96us/delta** vs activated **408us/delta** (208x reduction).
- Regression test `server-session.test.ts:267-312`; verified fail-before (a prefetched session projected a background delta into `session_message`) and pass-after by stashing only the source file.
- Tests: `server-session.test.ts` + `server-session-v2-reducer.test.ts` 79 pass / 0 fail; all of `./src/context` 389 pass / 3 fail (a `tabs` preview test and the two `home-session-index` tests), identical with the fix stashed except the new regression test failing, so pre-existing and unrelated. Scoped typecheck shows no diagnostic on changed lines (remaining diagnostics are the documented app baseline at untouched lines 1072-1075).
- Known trade-off `[UNVERIFIED]`: a prefetched background row's live timer now reads the prefetch snapshot instead of per-token updates. This is the same trade-off the existing `release` gate already makes for timeline-inactive sessions.

### F. Corrections to `TASK-concurrent-session-lag.md` (deliverable 4)

1. **Section 3 is a non sequitur.** "A cost that vanishes at completion must be gated on a liveness predicate" is false: per-token event-driven work also vanishes at completion and scales with `N_active` (measured: ~533us/delta for a loaded session vs ~1us suspended). This inference, not evidence, is what kept the investigation inside timer-driven UI code.
2. **Section 4.1's severity estimate is not supported.** H1's mechanism reproduces (1 evaluation/row/tick) but measured cost is ~2.8ms per 16-row tick at 1Hz; the 1000->5000 bisect in section 9.1 would have shown ~nothing. `[FALSIFIED as cause]`.
3. **Section 4.2 / section 6's "the gate works correctly" is wrong for prefetch-loaded sessions.** `suspended` is only populated by timeline release (`model.ts:22,32`); `prefetch` leaves sessions ungated. Measured 533us/delta at 160 messages for exactly that state.
4. **Section 5's H2 coarsening question resolves negative.** 0 `totals` evaluations over 3200 real V2 deltas. `[FALSIFIED]`.
5. **Section 4's "~x7E3-4 passes per row" overstates the walks.** `streamedChars` is only reached when a text/reasoning part has `time.start`; V2-projected text parts have no `time` at all (`utils/session-message.ts:305-314`). Per tick the practical work is `toolExecutionSeconds` plus `computeMeasuredRate`'s scan.
6. **Section 8's "double write per token" is not on the native path.** Native stream deltas (`session.text.delta`, ...) are routed to `applyV2` only and return before the legacy reducer (`server-sync.tsx:670-682`, `isNativeStreamDelta` 120-124); the `message.part.delta` handler (`server-session.ts:1331`) is the legacy/V1 path. Hygiene note only.
7. Minor line drift: `ChatRow` starts at 1511, not ~1540; the part-array insertion branch is `server-session.ts:1285-1290` (was 1276-1281); the V2 delta `produce` write is `:1362-1371` (was 1356-1365). The cited memo lines (1547/1548/1578/1582/1607/1628/1633) all matched exactly.
8. `prompt-input/live-generation-rate.ts` is single-instance per composer (`prompt-input-v2.tsx:1359`), so its 200ms sampler does not scale with session count. The task asked for this confirmation in section 10; it holds.
9. The task's instruction not to implement Tenth Pass roadmap item 3 "as written" is honored: no projection-deferral mechanism was added. The fix corrects the coverage of the existing `suspended`
---

## ADDENDUM (Thirteenth Pass) - the gate still leaks: `sync()` activates every background tab

**Date**: 2026-09-13 UTC. **Reporter**: lag persists after the Twelfth Pass fix (commit `00c9e4ce71`). **Status**: root cause located and reproduced by a failing test; no fix applied yet.

### A. Why the Twelfth Pass fix was necessary but not sufficient

`[VERIFIED]` The Twelfth Pass closed the `prefetch()` hole only. There is a second, larger hole: `sync()` calls `resume(sessionID)` **unconditionally** (`server-session.ts:891-893`). `resume` does `activated.add` + `suspended.delete` (`:917-920`). So any caller of `sync()` permanently marks that session as an activated foreground timeline - and because `activated` now also suppresses the self-suspend guards added at `:929` and `:933`, a later `prefetch()` can no longer re-gate it. The Twelfth Pass fix is defeated by any earlier `sync()`.

### B. Who calls `sync()` on a session that is NOT the foreground timeline

`[VERIFIED]` All call sites of `session.sync(` (`packages/app/src`):

1. `components/titlebar-tab-strip.tsx:151` - **the main leak.** Inside `createEffect`, guarded only by `if (!props.active()) return` plus a **one-shot `prefetched` boolean** (`:140-152`). Every tab you have ever visited runs `sync()` once while it is active, setting `activated`. Nothing ever clears it when the tab goes background: the effect cannot re-run (`prefetched` latches) and the component is **not disposed** - the tab strip keeps every tab mounted. So `activated` grows monotonically with the number of tabs visited this app run.
2. `pages/session/timeline/model.ts:62,81` - legitimate (foreground timeline; paired with `release()` on change/cleanup at `:22,32`).
3. `pages/session/timeline/message-timeline.tsx:937` - syncs the **parent** session of a subagent timeline. Never released, never the foreground timeline. Directly relevant to concurrent subagent fan-out.
4. `pages/layout.tsx:1229` - session resolution during project open.

### C. Reproduction (failing test, run and then reverted)

`[MEASURED]` Added a test to `server-session.test.ts` mirroring the existing "prefetched background sessions drop stream deltas" test, but calling `await ctx.store.sync("child")` instead of `prefetch`, then applying one `session.text.delta`. Result under `bun test --conditions=solid`: **1 fail, 76 pass** - the delta was projected into `session_message` (text became `"leaked"`) instead of being dropped. This is the exact state every background tab is in. The probe was reverted (`git checkout`); the committed fix `00c9e4ce71` was verified intact afterwards.

### D. Why this matches both reported symptoms

- **Scales with active sessions**: each ungated session pays full `applyV2` + `projectV2` per delta. Twelfth Pass numbers for this exact state: **161us/delta at 10 history messages, 533us at 160, 1108us at 320** vs ~1us suspended.
- **Resolves on completion**: deltas stop, so the cost disappears with no reload - while `activated` stays dirty, which is why it recurs on the next run.

### E. Recommended fix (not yet applied - needs a decision)

`sync()` conflates two things: "fetch this session's messages" and "this session is the foreground timeline". Split them. Preferred shape: give `sync` an option (e.g. `sync(id, { activate: false })`) that skips `resume()` and applies the same `if (!activated.has(id)) suspended.add(id)` self-gate `prefetch` now uses, then pass `activate: false` at `titlebar-tab-strip.tsx:151`, `message-timeline.tsx:937` and `layout.tsx:1229`. Leave `model.ts` (the real foreground timeline) activating.

**Do NOT** simply delete `resume()` from `sync()`: `model.ts:81` relies on `sync()` for the non-cached path, and `:22-27` documents that cache-first navigation deliberately calls `resume()` separately. Removing it outright risks a foreground timeline that never consumes its stream - the bug `8188132ff5` fixed.

Also worth fixing independently: `titlebar-tab-strip.tsx` should `release()` when a tab stops being active, so `activated` tracks reality instead of growing monotonically.

### F. Second independent cost: the gate only covers content, not the per-event fan-out

`[VERIFIED]` `applyV2`'s bail (`:1056-1059`) only fires for `contentEvent`. In `server-sync.tsx:662-682`, **every** SSE event from **every** directory runs `session.applyV2` first, and only the four `isNativeStreamDelta` types (`:120-124`) return early. Everything else - notably `session.tool.*` (non-delta), `session.step.started/ended`, `session.status` - continues into `homeSessions.refresh`, group invalidation and `applyDirectoryEvent` (`time("dir", ...)`) for the matching directory store. With N concurrent sessions doing tool work, that non-delta traffic scales with N too and is **not** covered by `suspended`.

`[UNVERIFIED]` Magnitude unknown - no profile. `perf` reports `dir`/`home`/`invalid` spans separately, so this is directly measurable (see G).

### G. STOP BUILDING HARNESSES - the app already has the instrument

`[VERIFIED]` `packages/app/src/context/perf.ts` is a purpose-built sampler for exactly this bug, **auto-enabled in dev builds**, or `localStorage.setItem("opencode:perf", "1")` + reload in any build. It logs once per second: events/s, `reducer ms/s` broken out per span (`applyV2` / `apply` / `dir` / `home` / `invalid`), `applyV2 us/ev`, and `frame: max <N>ms stalls(>50ms) <N>`. It also warns on any >100ms long task (`[perf-longtask]`).

Its own header comment states the discriminator this investigation has been guessing at for three passes: high `reducer ms/s` means the cost is in the per-event reducer path; low reducer but high `frame:` stalls means it is **rendering**, which no SSE/reducer change will fix.

**Next agent: run the app with several concurrent sessions, read one line of `[perf]` output, and paste it into this document before changing any code.** Every pass since the Tenth has reasoned from source and synthetic harnesses; two of three diagnoses were wrong. This one line settles reducer-vs-render and tells you whether section E or section F dominates.

**UPDATE (Fourteenth Pass): superseded - the server-side tracer below had already recorded the answer on disk; no repro was needed.**

---

## ADDENDUM (Fourteenth Pass) - MEASURED: server drops 90% of events, client reconnect-storms

**Date**: 2026-09-13 UTC. **Status**: first pass using real telemetry from actual runs instead of synthetic harnesses.

### A. Thirteenth Pass section G pointed at the weaker instrument

`[VERIFIED]` There are two default-ON tracers:
- `app/src/context/phase-trace.ts` (renderer, 413 lines): breaks out dispatchMs, applyV2Ms, applyMs, projectionMs, rowsMs, slowRows, frameMaxMs, frameStalls plus a 27-field markdown summary (paced/effect/block/sanitize/worker, incl workerQueueMs, workerSuperseded). `[phase-trace]` JSON every 5s; live `window.__opencodePhaseTrace()`.
- `core/src/event-trace.ts` (server, 251 lines): **writes JSONL to disk by default** at `<xdg-data>/opencode/log/event-trace/trace-<pid>-<ts>.jsonl`, rotated at 25 MiB.

`[MEASURED]` 60 server trace files already exist on this machine (2026-09-06..09-13) at `%USERPROFILE%\.local\share\opencode\log\event-trace`. No repro was needed. **Correction**: renderer `[phase-trace]` lines are NOT persisted - `desktop/src/main/windows.ts:462-471` only forwards console messages containing "terminal".

### B. MEASURED: busiest window drops 90.8% of events

`trace-39276-2026-09-11T21-53-55-582Z.jsonl`, windowSec=15.005:

global.coalescerIn 47230 / queue.offered 4359 / queue.offeredBytes 75387739 (5 MB/s) / global.subscriberOffered 4358 / **global.subscriberFailed 42872** / global.serializeBytes 11829304 / global.serializeMs count=606 avg=0.030ms max=6.79ms / bridge.published 127.

Interpretation: the coalescer merged 47230 inputs into ~4359 delivered frames (10.8:1 - it works), but **42872 offers were refused**. Refusal is not a drop: `makeByteBoundedSubscriberQueue.offer` (`core/src/event.ts:696-719`) sets `failed=true` and calls `Queue.failCauseUnsafe(...SubscriberOverflowError)`, which **fails the whole SSE stream**. Every subsequent offer short-circuits on `if (failed) return false`, so the 42872 are one dead stream being written to, not 42872 independent failures.

### C. MEASURED: the trigger is a single 1 MB frame, and it repeats 256 times

> **[SUPERSEDED by Fifteenth Pass A]** - the sizes are NOT identical; there are 78 distinct sizes up to 7.79 MB. The "same event retried" inference below is withdrawn.

`[MEASURED]` Every `queue.overflow` record in that file is identical:

`{"phase":"queue.overflow","capacity":4352,"size":1031813}` x256, ~14-30ms apart.

`size=1031813` is a **single event ~> 1 MB**. It trips the first branch of `offer` (`size > maxBytes` is false at 8 MiB, but `pendingBytes > maxBytes - size` is true once the queue holds ~7 MB), so one oversized frame arriving while the queue is backed up kills the stream. The identical `size` on all 256 records means the **same event is retried after every reconnect** and kills the stream again.

### D. MEASURED: the self-reinforcing loop (this is the mechanism)

`[MEASURED]` Same file, `sse.reconnect` records: two in the first 4 hours (t=1789163635, 1789163888), then from t=1789177947 onward a continuous **~1.0-1.4s cadence** on `route:"native"` - 1176 reconnects in one process. **Every one has `"fresh":true`** for the storm window.

`[VERIFIED]` `fresh:true` means `parseEventSequence(request.headers["last-event-id"])` returned undefined - **the client sent no resume cursor**. Confirmed from the client side: `Last-Event-ID`/`last-event-id` appears **nowhere in `packages/app/src`**. The server maintains a 4096-frame/8-MiB replay ring and stamps SSE `id:` on every domain frame, but the app never sends it back. Ratio over the whole file: **924 fresh vs 252 resumed**.

The loop:
1. Concurrent sessions saturate the queue (5 MB/s measured).
2. A ~1 MB frame arrives -> `SubscriberOverflowError` -> stream fails.
3. Client reconnects **with no cursor** -> full re-subscribe, zero replay.
4. Stores re-hydrate from snapshots (`server.stream.gap` path -> `server.connected` -> refetch), so the renderer eats N-session rehydration ~1x/second.
5. The oversized event is still pending -> back to 2.

### E. Why this explains the symptoms the store-gating fixes did not

- **Scales with concurrent sessions**: overflow needs ~7 MB of queue backlog; one session rarely gets there, N do (measured 5 MB/s).
- **Resolves on completion without reload**: deltas stop, backlog drains, the next reconnect succeeds. No state needs clearing - which is why it recurs every run and why `activated`-set hygiene did not change it.
- **Immune to every fix so far**: passes 10-13 all edited renderer store projection. None touch the queue, the byte ceiling, or the missing resume cursor.
- **Correlation across 60 files**: overflow > 0 occurs in exactly 4 files (256/59/20/3), and all four are high-reconnect (1176/70/21/140). Every zero-overflow file has a low count. No counter-example.

### F. Secondary findings (verified, unmeasured)

1. `[VERIFIED]` **The markdown worker is a module-level singleton with one thread.** `session-ui/src/components/markdown-worker.ts:224` - one `new Worker`, shared across every session and tab. `markdown-worker-transport.ts` coalesces **per-key only** (`maxActive` default 4, `MARKDOWN_PARSE_MAX_ACTIVE=16`), so N streaming sessions contend rather than coalesce. Compare `pierre/worker.ts:22` which deliberately uses `poolSize: 2`. `phase-trace` already reports `workerQueueMs`/`workerDispatchWaitMs`/`workerSuperseded` - measurable without new code.
2. `[VERIFIED]` **`MAX_DELTA_CHARS = 64 * 1024` is a merge ceiling, not a frame ceiling** (`core/src/event-coalescer.ts:14`). It caps *merged* fragments; a single non-delta event (the measured 1031813-byte one) is never bounded or split. Note `message.part.updated` carries full part state and was 58/127 of published types in the busiest window.

3. `[VERIFIED]` **Correction to the Thirteenth Pass per-directory fan-out theory**: `message-timeline.tsx:651-656` documents that the timeline component is **shared across session tabs** and only remounts on server/directory change. So background tabs do NOT each mount a timeline; N-mounted-timelines is `[FALSIFIED]`. The `sync()`/`activated` leak (Thirteenth E) remains real - it is store-level, not component-level - but its ceiling is lower than assumed.
4. `[VERIFIED]` `server-sdk.tsx:572` client backpressure (`while (queue.size >= 1024) await wait(16)`) stops draining the socket under load, which is what lets the **server** queue reach 7 MB. Client and server backpressure are coupled; the client stall is the proximate cause of the server overflow.

### G. Recommended order of work

1. **[WITHDRAWN - see Fifteenth Pass C & G4] Send the resume cursor.** The v2 stream is volatile by contract and an e2e test asserts the cursor is absent; do not do this as a perf fix. Original text: Highest value, smallest change: the replay ring already exists and is unused (924 fresh / 252 resumed). This converts every overflow from a full rehydration into a bounded replay and breaks step 3 of the loop.
2. **Bound or split oversized frames** server-side before `offer`, or make overflow drop-and-gap instead of fail-stream. Breaks step 2.
3. Then re-measure before touching renderer projection again. **Do not apply Thirteenth E first** - it is real but it is not this.
4. Only then investigate F1 (worker pool) using `window.__opencodePhaseTrace()`.

**Artifacts**: `.opencode/cache/p14-busiest.txt`, `p14-overflow.txt`, `p14-scan.txt` (all 60 files), `p14-loop.txt`, `p14-types.txt`, `p14-fresh.txt`.
---

## ADDENDUM (Fifteenth Pass) - CORRECTS Pass 14: oversized single events, not replay amplification

**Date**: 2026-09-13 UTC. **Status**: same measured telemetry, read more carefully. Two Pass 14 claims were wrong and its top recommendation contradicted an explicit design contract. The core finding (the subscriber queue fails the stream) survives and is strengthened.

### A. `[CORRECTED]` The overflow frames are NOT one repeated event

`[MEASURED]` Pass 14 section C claimed all 256 overflow records were identical at `size=1031813`, and inferred "the same event is retried after every reconnect". Grouping instead of sampling the first three shows **78 distinct sizes** in `trace-39276`:

`size=1031813 x6, 1043303 x6, 1204827 x11, 1278981 x14, 1627165 x18, ... 2599125 x3` plus small outliers (`size=1139 x3`, `size=3889 x1`, `size=8576 x7`).

And in `trace-109076` (2026-09-13, the most recent run) the sizes are far larger - 37 distinct values from **3.97 MB to 7.79 MB**: `size=7787075, 7765958, 7732110, 7649157 x4, 7443743, ... 4524041 x2, 3974734`.

So the trigger is a **population of genuinely enormous single events**, not one poison frame. The repeated counts (`x4`, `x6`, `x11`) are real repeats of equally-sized payloads, which is what you get when the same growing part is republished.

### B. `[FALSIFIED]` Replay does not refill the queue on reconnect

`[VERIFIED]` Pass 14 section D step 3->2 claimed the cursor-less reconnect re-enqueues work that re-triggers overflow. `EventReplayBuffer.since` (`core/src/event-replay.ts:137-142`) begins:

`if (after === undefined) return { kind: "ok", frames: [], latest, bytes: 0, ... }`

A fresh connection enqueues **zero replay frames**. Replay amplification is `[FALSIFIED]`. The `SUBSCRIBER_HEADROOM` comment (`handlers/event.ts:35-41`) confirms capacity is coupled to replay only for *resumed* connections.

### C. `[CORRECTED]` The cursor is missing BY DESIGN on the native route

`[VERIFIED]` Pass 14 recommendation #1 ("send the resume cursor") was stated without checking intent. Three independent sources say this is deliberate:
- An e2e test **asserts the absence**: `app/e2e/regression/session-timeline-transport.spec.ts:100-111`, "does not request replay when reconnecting the volatile V2 event stream" -> `expect(connection.headers["last-event-id"]).toBeUndefined()`.
- The published API description: "**Volatile by contract**: a slow consumer overflows and fails the stream, and events during disconnection are missed. Consumers that need reliability should combine the changes feed with durable session log reads."
- `app/src/context/server-sdk.tsx:515` calls `eventApi.event.subscribe({ signal })` and never reads `frame.id`, while the SDK's own SSE helper (`serverSentEvents.gen.ts:112-114, 179`) **does** track `lastEventId` and would send it automatically - the app bypasses that retry loop entirely and runs its own (`server-sdk.tsx:500-600`).

`[MEASURED]` The two routes behave exactly as that split predicts, in `trace-39276`:

`reconnect:global:fresh=False:kind=ok x251` / `reconnect:global:fresh=True:kind=ok x29` / `reconnect:global:fresh=False:kind=gap x1` / **`reconnect:native:fresh=True:kind=ok x895`** (zero resumed).

So Pass 14's "924 fresh vs 252 resumed" was arithmetically right but misattributed: the `global` (v1) route **does** resume (251/281 = 89%), and the `native` (v2) route never does because it is contractually volatile. "The client never sends the cursor" is true only of v2.

### D. What actually survives, and is now better supported

`[VERIFIED]` The real defect is in `makeByteBoundedSubscriberQueue.offer` (`core/src/event.ts:696-719`). Both overflow branches are terminal:

`if (size > options.maxBytes || pendingBytes > options.maxBytes - size) { failed = true; ... Queue.failCauseUnsafe(...) }`

The trace cannot distinguish the two branches (both emit the same record), but the `trace-109076` sizes settle it: **`size` values of 7.79 MB against a `maxBytes` of 8 MiB (8.389 MB)** mean a *single event* is within 7% of the entire per-connection byte budget. At that size the second branch fires with almost no backlog - `pendingBytes` only needs to exceed ~600 KB. **A single oversized event is sufficient to kill the stream; concurrency is not even required, it just makes it certain.**

`[MEASURED]` The alternation is exact and visible in `.opencode/cache/p15-seq.txt`:

`overflow size=7649157` -> `sse.reconnect global fresh=True` -> `overflow size=7649157` -> `reconnect` -> ... four times at the identical size, ~1-20s apart, then the size shifts (`4538313` x4, then `4537288`, then `5062328`).

That is **republish of a growing payload**, not replay of a retained one: each plateau is one part being re-emitted at a stable size, and the steps between plateaus are it growing.

### E. `[VERIFIED]` The ring already solves this problem; the subscriber queue does not

The same codebase handles the identical hazard correctly one layer up. `EventReplayBuffer.append` (`core/src/event-replay.ts:80-95`):

`if (size > maxBytes) { ... this.holes.push(frame.sequence); return frame.sequence }`

with the comment "it must not strand every other client: the oversized frame is dropped while previously retained frames keep their cursors". The ring **drops one frame and records a hole**. The subscriber queue, given the same input, **fails the entire connection**. That asymmetry is the bug, and the fix is already written eleven lines away in a sibling module.

`[VERIFIED]` The `server.stream.gap` control frame exists precisely to express "you missed something, hydrate" (`handlers/event.ts:133-150`) and is already wired into the client. An oversized event should emit that, not `SubscriberOverflowError`.

### F. `[UNVERIFIED]` Where a multi-megabyte single event comes from

The busiest window's type histogram (Pass 14) was `message.part.updated 58, message.updated 42, session.status 12, session.updated 6, session.diff 6, message.part.delta 3`. `message.part.updated` carries **full part state**, so a part whose accumulated text or tool output reaches several MB is republished at full size on every update - matching the measured plateaus-then-steps pattern. `session.diff` is a second candidate (whole-diff payloads). **Not yet confirmed**: the trace deliberately records no payload content, and `queue.overflow` does not record the event type.

`[ACTIONABLE]` One field added to the existing `EventTrace.event({ phase: "queue.overflow" ... })` call (`core/src/event.ts:702, 714`) - the event `type` plus which branch fired - would identify the culprit on the next run with no new harness. That is the single highest-value next step.

### G. Revised recommendations (supersedes Pass 14 section G)

1. **Instrument the overflow first** (F above). Add event `type` + branch + `pendingBytes` to the `queue.overflow` record. Cheap, no behavior change, and it names the oversized producer.
2. **Make oversized-single-event non-fatal.** Mirror `EventReplayBuffer.append`: drop the one frame, emit `server.stream.gap`, keep the stream alive. Only genuine sustained backpressure (branch 2 with a normal-sized frame) should consider failing.
3. **Bound the producer.** A 7.79 MB single event is a defect regardless of transport policy; `MAX_DELTA_CHARS` (64 KB) bounds only *merged deltas*, never a single non-delta payload.
4. **Do NOT add a v2 resume cursor** (Pass 14 #1 - withdrawn). It contradicts the documented volatile contract and an explicit passing e2e assertion. If reliability is wanted there, it is an API-contract decision, not a perf fix.
5. Thirteenth Pass E (`sync()`/`activated` leak) stays deferred but **is still real and still unfixed**.

`[STILL UNKNOWN]` Whether the renderer stall the user perceives is this loop or an independent render cost. `window.__opencodePhaseTrace()` remains the one unexecuted measurement; `frameStalls` vs `applyV2Ms` settles it and needs a live app.

**New artifacts (Fifteenth Pass)**: `.opencode/cache/p15-routes.txt` (per-route reconnect + grouped overflow sizes, 3 files), `p15-seq.txt` (interleaved overflow/reconnect timeline).

## ADDENDUM (Seventeenth Pass - coordinator) - CORRECTS Pass 15: the oversize branch never fired; it is backpressure+one real config bug

Method: coordinator verification while two genspark/gpt-5.6-luna (variant max) workers audited in parallel (swarm `p16-concurrent-session-audit`). Every claim below was checked by me directly against source, not delegated.

### A. `[FALSIFIED]` "Oversized single event" is the wrong diagnosis (my own Pass 15 heading)

The overflow test (`core/src/event.ts:700`) is a disjunction:

```ts
if (size > options.maxBytes || pendingBytes > options.maxBytes - size)
```

`[VERIFIED]` Every byte budget in the tree is 8 MiB = **8388608**: `core/src/event.ts:733` (`allBounded` default), `opencode/.../handlers/event.ts:78`, `handlers/global.ts:56` and `:173`, `server/src/handlers/event.ts:22,85`.

`[MEASURED]` The largest `size` ever recorded across all 60 traces is **7787075** (`trace-109076`); `p15-seq.txt` tops out at 7649157. Both are BELOW 8388608.

**Therefore the first disjunct - the true "oversize" branch - has provably never fired in any captured run.** Every observed `queue.overflow` came from the second disjunct, `pendingBytes > maxBytes - size`. For a 7787075-byte frame that requires only `pendingBytes > 601533` - about **600 KB of already-queued backlog**. The fatal condition is a large-but-LEGAL frame colliding with a modest backlog: a **backpressure** failure, not a poison-payload failure. Pass 15's section heading and its ">600 KB triggers stream death" phrasing were directionally right but mislabelled the cause.

### B. `[FALSIFIED]` The `pendingBytes` counter does NOT leak

I hypothesised a leaked retained-byte counter - it would have been a far simpler root cause than anything in Pass 14/15. It is wrong. `core/src/event.ts:727-730` deliberately does NOT expose the raw queue stream:

```ts
const stream = Stream.fromQueue(queue).pipe(Stream.tap(release))
```

`[VERIFIED]` Both SSE consumers use that wrapped getter - `handlers/global.ts:258` (`subscriber.stream.pipe(...)`) and `server/src/handlers/event.ts:158` (`const live = subscriber.stream.pipe(`). No caller bypasses `release`, so retained bytes are freed as each frame is handed to the writer. `[FALSIFIED]`.

### C. `[VERIFIED]` Why `pendingBytes` reaches 600 KB: the replay is enqueued SYNCHRONOUSLY

This is the mechanism Pass 14 and 15 both missed. `handlers/global.ts:163-172` states it outright:

> The subscriber queue must be able to hold a FULL replay window: the entire replay is enqueued synchronously here, before the body stream is ever pulled, and `offer` FAILS the stream on overflow rather than dropping.

`server/src/handlers/event.ts:13-20` repeats it and calls the coupling "load-bearing". So on every reconnect the handler pushes up to a whole replay window into the queue **before anything drains it** - `pendingBytes` is at its maximum precisely when the first live frames arrive (`global.ts:249-256` flushes replay, then `pendingLive`, then flushes again, all before `:258` builds the stream). A multi-MB live frame landing in that window fails the stream - which triggers a reconnect, which re-enqueues a replay window. That is the self-sustaining loop `p15-seq.txt` shows as alternating overflow→reconnect at identical sizes.

Note this is consistent with Pass 15 section B: a *cursor-less* reconnect replays nothing (`since(undefined)` returns no frames), so the loop needs the `global` v1 route where cursors ARE sent (`[MEASURED]` 89% resumed). `p15-seq.txt` confirms every reconnect in the loop is `route=global`.

### D. `[VERIFIED]` **A real, shippable bug**: the v1 routes' replay byte ceiling is half their ring budget

The native route fixed this and left a comment explaining why (`server/src/handlers/event.ts:29-34`):

> The byte guard must not sit below the ring's own retention budget. The ring can never produce more than it retains, so a guard under `ringMaxBytes` means holding bytes we refuse to send and forcing a full snapshot hydration for a window the server is already retaining -- the same defect as a frame ceiling below the ring capacity. Match the ring so the two budgets agree.

`[VERIFIED]` It did: `export const MAX_REPLAY_BYTES = ringMaxBytes` (8 MiB), `server/src/handlers/event.ts:34`. And `server/src/event-replay-bytes.test.ts:16` pins it: `expect(MAX_REPLAY_BYTES).toBe(RING_MAX_BYTES)`.

`[VERIFIED]` **The other two routes did not get the fix**:
- `opencode/.../handlers/global.ts:39` - `const MAX_REPLAY_BYTES = 4 * 1024 * 1024` while its ring is 8 MiB (`:57`).
- `opencode/.../handlers/event.ts:34` - `export const MAX_REPLAY_BYTES = 4 * 1024 * 1024` while its queue is 8 MiB (`:78`).

Worse, `global.ts:31-37` carries a comment claiming it *does* agree with the ring and "matches the native route" - the frame ceiling was raised to `RING_CAPACITY` two lines above, but the **byte** ceiling directly below was left at 4 MiB. The comment documents an invariant the code on the next line violates.

`[ACTIONABLE]` Consequence by the native route's own reasoning: any resumable window between 4 and 8 MiB is **retained but refused**, so `global.ts:229` takes the `gap` path and forces a full hydration instead of replaying data the server still holds. Under concurrent sessions the ring fills fast, so this fires often - and forced hydration is exactly the expensive client path. Fix is one line per route plus an equivalent of the existing test extended to all three. This is the cheapest high-value change found in passes 14-17.

### E. `[VERIFIED]` Why "drop-and-gap" (Pass 15 recommendation #2) needs rethinking

Pass 15 recommended mirroring the ring's drop-one-frame-and-record-a-hole behaviour in the subscriber queue. Given section A - the failing frame is LEGAL and the queue is merely full - that remedy now looks wrong on its own terms: it would discard real data every time the consumer is briefly slow, not just when a payload is pathological.

The design intent is explicit at `core/src/event.ts:655-656`:

> For synchronous event emitters: never suspend a producer behind a slow subscriber, and never silently discard an append-only event on overflow.

Those two constraints cannot both hold when the queue is full, and fail-fast is the deliberate tie-break. So any fix here is a **policy change against a stated invariant**, not a bug fix, and must be argued as such. Ranked by cost/risk:

1. `[ACTIONABLE]` **Fix section D first.** It is a genuine inconsistency with a documented invariant and an existing test to copy, and it removes forced hydrations that feed the loop. No policy question at all.
2. `[ACTIONABLE]` **Drain before enqueueing the rest of the replay**, or enqueue the replay lazily as the body stream is pulled. This attacks section C - the synchronous pre-load is what puts `pendingBytes` near its ceiling at the worst moment - and it honours BOTH stated constraints (no producer suspension, no discard). Larger change; the "capacity is load-bearing" comments exist precisely because the current shape is synchronous.
3. Bound the producer so no single event is multi-MB (unchanged from Pass 15 #3; still the right long-term fix and independent of transport policy).
4. Drop-and-gap - **demoted**. Only defensible for a frame that genuinely exceeds `maxBytes` alone, i.e. the branch that has never fired.

### F. Instrumentation note (supersedes Pass 15 section F's priority)

Pass 15 made "log the event type on `queue.overflow`" the single highest-value next step. Demoted but still worth doing: section A already establishes analytically which branch fires, so the field that buys genuinely new information is **`pendingBytes` at failure time** - it shows how the backlog accumulated and would confirm or refute section C on the next run. Keep the branch discriminator too, so section A's analytic claim stays falsifiable rather than assumed. Both overflow records are at `core/src/event.ts:702` and `:714` and are currently byte-identical, which is why `p14-overflow.txt` could not distinguish them.

### G. Coordination record (process, for the next agent)

Two workers ran on `genspark/gpt-5.6-luna` variant `max` (swarm `swarm_getmcp_mu01xk8l_1eedfdfae2adb344`): Worker A on server transport, Worker B on renderer/markdown-worker/store. Their sections append separately as `ADDENDUM (Sixteenth Pass - Worker A/B)`.

Two process observations worth carrying forward. First, **the coordinator should verify arithmetic before delegating**: section A invalidated the premise of a task I had already dispatched, and I had to send a mid-flight correction. Three consecutive passes (13, 14, 15) each overturned part of the one before, and in every case the error was an unchecked inference from a partial sample - Pass 14 read three overflow records and called them one repeated frame; Pass 15 read the size distribution but never compared it to the budget. Second, `swarm_wait` on this plugin returns a stale member snapshot while the underlying sessions are still working; `opencode_session messages` on the member `sessionId` is the reliable progress check.

### H. Status of every live claim after this pass

| Claim | Status |
| --- | --- |
| Server refuses ~90% of offered events in the busiest window | `[MEASURED]` holds (Pass 14) |
| Coalescer works (10.8:1 merge) | `[MEASURED]` holds (Pass 14) |
| Overflow fails the whole SSE stream, not one frame | `[VERIFIED]` holds |
| Trigger is one repeated poison frame | `[FALSIFIED]` (Pass 15 A) |
| Trigger is an oversized single event | `[FALSIFIED]` (this pass, A) |
| Trigger is a legal large frame + ~600 KB backlog | `[VERIFIED]` (this pass, A) |
| Backlog comes from the synchronous replay pre-load | `[VERIFIED]` from source/comments (C); `[UNVERIFIED]` at runtime - needs `pendingBytes` logged |
| `pendingBytes` leaks | `[FALSIFIED]` (this pass, B) |
| Replay refills the queue on a FRESH reconnect | `[FALSIFIED]` (Pass 15 B) |
| Replay refills the queue on a RESUMED `global` reconnect | `[VERIFIED]` by design comment (C) |
| v1 byte ceiling (4 MiB) < its ring budget (8 MiB) | `[VERIFIED]` (this pass, D) - **new, actionable** |
| Add a v2 resume cursor | `[WITHDRAWN]` (Pass 15 C) |
| `message.part.updated` is the multi-MB producer | `[UNVERIFIED]` - Worker A task 2 |
| Markdown worker singleton head-of-line blocks | `[UNVERIFIED]` - Worker B task 2 |
| Renderer stall is this loop vs independent render cost | `[STILL UNKNOWN]` - needs a live `window.__opencodePhaseTrace()` |

**The one unexecuted measurement remains a live app run.** Nothing in passes 14-17 could settle whether the user-visible stall is this transport loop or an independent renderer cost, because every server-side artifact on disk is consistent with both.



## ADDENDUM (Sixteenth Pass - Worker A)

**Date**: 2026-09-13 UTC. **Scope**: queue overflow instrumentation, producer-path audit, and non-fatal oversized-event design. No renderer-owned files were changed.

### A. `[VERIFIED]` Queue overflow traces now identify the event and branch

`packages/core/src/event.ts:680-748` adds an optional `typeOf(value)` callback to `makeByteBoundedSubscriberQueue`. Both terminal overflow records now include `type`, `branch`, and `pendingBytes`, in addition to the existing `capacity` and `size` (`:713-722`, `:731-740`). The first conditional branch labels `branch: "oversize"` when `size > maxBytes`, otherwise `"backpressure"`; the `Queue.offerUnsafe` refusal branch labels `"backpressure"` (`:700-740`). No payload content is passed to `EventTrace`; the tracer contract remains metadata-only (`packages/core/src/event-trace.ts:8-20`).

`typeOf` is optional so the generic queue contract remains compatible with arbitrary `A`. Domain event queues provide `item.event.type` or `event.type` (`packages/server/src/handlers/event.ts:83-88`, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:76-81`, `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:163-176`, `packages/core/src/event.ts:759-764`). PTY queues provide only `"pty.data"` or `"socket.close"` (`packages/server/src/handlers/pty.ts:193-198`, `packages/opencode/src/server/routes/instance/httpapi/handlers/pty.ts:239-244`), because those values are not domain event envelopes. A required callback or a queue-level cast to `Payload` would break those generic callers; deriving `event.type` inside the generic queue would violate its type boundary.

`[VERIFIED]` The added regression test exercises both terminal branches and checks `type`, `branch`, `size`, and `pendingBytes` without checking or logging content (`packages/core/test/event-byte-queue.test.ts:47-101`). `bun test test/event-byte-queue.test.ts` passed 3/3; `bun test test/event-trace.test.ts` passed 4/4; `bun test test/event-replay-budget.test.ts` passed 12/12; `bun test test/server/httpapi-event-queue-capacity.test.ts` passed 2/2. The root-scoped test command was not used because the repository test wrapper resolves a nonexistent `do-not-run-tests-from-root` path when invoked from the monorepo root.

### B. `[FALSIFIED]` / `[VERIFIED]` Producer hypothesis results

`[VERIFIED]` `message.part.updated` is constructed at `packages/opencode/src/session/session.ts:824-831`: `updatePart` publishes `SessionV1.Event.PartUpdated` with `part: structuredClone(part)`. The schema carries the full union `Part` (`packages/schema/src/v1/session.ts:359-385`) and the event schema carries that full part under `part` (`:634-642`). Streaming code repeatedly calls `session.updatePart` with the current full text/reasoning/tool state (`packages/opencode/src/session/processor.ts:758-805`, `:824-873`; `packages/opencode/src/session/prompt.ts:859-915`), while `updatePartDelta` is a distinct `message.part.delta` event (`packages/opencode/src/session/session.ts:1255-1263`). There is no producer-side size cap on `Part` or on `updatePart` before publication. Therefore this candidate is confirmed as capable of producing large full-state frames, but the existing trace data alone did not identify it as the measured culprit.

`[VERIFIED]` `session.diff` is constructed at `packages/opencode/src/session/revert.ts:73-79` from `summary.computeDiff`, and also emitted as an empty event by `packages/opencode/src/session/summary.ts:102-115`. `computeDiff` returns the complete `snapshot.diffFull` result (`packages/opencode/src/session/summary.ts:82-100`); `snapshot.diffFull` generates one `FileDiff` per changed file and uses `formatPatch(structuredPatch(..., { context: Number.MAX_SAFE_INTEGER }))` without a patch-size cap (`packages/opencode/src/snapshot/index.ts:546-756`, especially `:735-752`). The event schema is an unbounded array of `FileDiff.Info` (`packages/schema/src/v1/session.ts:666-672`), and `FileDiff.Info.patch` is an unconstrained string (`packages/schema/src/file-diff.ts:6-12`). Thus `session.diff` is also capable of multi-megabyte payloads, but is not proven to be the measured producer.

`[VERIFIED]` `MAX_DELTA_CHARS` is only a merge ceiling: `packages/core/src/event-coalescer.ts:14` and `:92-106` reject a merge above 64 KiB, but only for explicitly registered/coalescible delta events. `message.part.updated` and `session.diff` are not coalesced definitions (`packages/schema/src/v1/session.ts:634-672`), so the cap does not bound either full-state frame. The existing histogram measured `message.part.updated:58` and `session.diff:6` of 127 bridge publications (`.opencode/cache/p14-types.txt:1`), but no pre-instrumentation record carried type metadata. The new trace field is required for a future run to distinguish them.

### C. `[VERIFIED]` Existing fail-stream assertions and conscious impact of Task 3

Current tests that explicitly encode `SubscriberOverflowError` or refusal-as-stream-failure are:

- `packages/core/test/event.test.ts:371-387` asserts a bounded synchronous subscriber stream ends with `SubscriberOverflowError`.
- `packages/core/test/event.test.ts:417-445` asserts only the slow `allBounded` subscriber ends with `SubscriberOverflowError`, while the fast subscriber continues.
- `packages/core/test/event-replay-budget.test.ts:170-226` documents and asserts `makeByteBoundedSubscriberQueue` refuses a replay beyond item capacity; `firstRefusal === 256` is the deliberate regression guard.
- `packages/server/src/event-replay-capacity.test.ts:7-71` documents and asserts the same capacity refusal for the native route helper.
- `packages/opencode/test/server/httpapi-event-queue-capacity.test.ts:11-71` documents and asserts the same capacity refusal, including `offered < wanted` for a queue below the replay ceiling.

The focused tests above passed before any behavior change because this pass did not change `Queue.failCauseUnsafe` behavior. The three capacity tests and the two core stream-failure assertions must be revisited deliberately if Task 3 is implemented; they should not be silently rewritten. In particular, Task 3 targets only a single event whose `size > maxBytes`, not ordinary item-count refusal or sustained backpressure. The existing `SubscriberOverflowError` assertions primarily exercise item-capacity/backpressure semantics and therefore should remain unless the chosen implementation broadens the behavior.

### D. `[UNVERIFIED]` Minimal Task 3 design, intentionally not applied

The minimal design is a transport-aware oversized-event policy rather than a generic queue silently manufacturing a `server.stream.gap` object. Add an optional `onOversize` callback to `makeByteBoundedSubscriberQueue` that receives metadata (`size`, `maxBytes`, `pendingBytes`, and the event type via the same metadata callback) and returns whether the event was handled. On `size > maxBytes`, callers for the SSE domain queues would enqueue one existing `server.stream.gap` control frame with no replay cursor, using the route’s existing gap shape, and then continue the queue without setting `failed`. The generic queue remains unaware of protocol payloads. PTY and generic callers omit the callback and retain terminal failure. This design preserves the existing generic contract and keeps control-frame construction in `packages/server/src/handlers/event.ts:135-150` / `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:134-150` and `global.ts:228-247`.

The callback must not recursively call `offer` with an oversized original event. It should enqueue a bounded control frame through a separate callback or a caller-supplied `gap` value, then return `true`; otherwise the queue needs an explicit `onOversize` result carrying a replacement event. A practical alternative is to add `onOversize?: (event, metadata) => A | undefined`, where the callback returns a bounded replacement frame. The queue would attempt the replacement only after confirming its size fits, and would fail if the replacement itself cannot fit. That is a design sketch only; no behavior change was applied in this pass.

`[VERIFIED]` The existing replay ring already drops an oversized frame and records its sequence as a hole (`packages/core/src/event-replay.ts:80-118`), and the SSE handlers already emit `server.stream.gap` for replay gaps (`packages/server/src/handlers/event.ts:135-150`, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:134-150`, `global.ts:228-247`). The app already treats that control frame as a hydration signal (`packages/app/src/context/server-sdk.tsx:559-570`; renderer file read only, no edit). However, `[UNVERIFIED]` exact live-overflow gap sequencing, coalescer state handling, and whether one gap per oversized frame is sufficient still require a focused design/test before implementation.

### E. `[MEASURED]` Telemetry context retained

`trace-39276` recorded 256 overflow events and 1,176 reconnects (`.opencode/cache/p14-scan.txt:28`), with 47,230 coalescer inputs, 4,359 offered frames, 75,387,739 offered bytes, and 42,872 failed offers in a 15.005-second window (`.opencode/cache/p14-busiest.txt:1-3`). `trace-109076` grouped overflow sizes from 3,974,734 to 7,787,075 bytes (`.opencode/cache/p15-routes.txt:83-122`). Pass 15 correctly established that fresh native reconnects enqueue zero replay frames (`packages/core/src/event-replay.ts:136-143`, as recorded in the preceding addendum); this pass does not revive the withdrawn cursor recommendation.

### F. `[MEASURED]` Captured traces do not prove the oversize branch

The newly added `branch` field is not present in historical files. Independently, the recorded maximum `size` is 7,787,075 bytes (`.opencode/cache/p15-routes.txt:120`), below the 8 MiB queue budget used by the SSE handlers (`packages/server/src/handlers/event.ts:83-87`, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:76-80`, `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:163-175`). Therefore the historical artifacts establish large legal frames plus backlog, not a frame that exceeded `maxBytes` by itself. `[UNVERIFIED]` The new per-event `type` and `branch` fields require a later real run to identify which legal large event type is colliding with the backlog; this pass does not claim `message.part.updated` or `session.diff` as the measured culprit.

## ADDENDUM (Sixteenth Pass - Worker B)

**Date**: 2026-09-13 UTC. **Scope**: `packages/app/src` and `packages/session-ui/src`. No Core or server files were changed.

### A. Reconnect behavior and the actual refetch fan-out

`[VERIFIED]` An ordinary native SSE EOF or non-abort stream error does **not** itself refetch session messages. The reconnect loop creates a fresh `eventApi.event.subscribe({ signal })` at `packages/app/src/context/server-sdk.tsx:503-515`; after stream termination it only marks liveness, records `phaseTrace.reconnect`, waits with backoff, and loops at `:577-605`. The native subscribe call does not read or send an event cursor (`:511-515`), consistent with Pass 15's withdrawn cursor recommendation and the volatile-v2 contract.

`[VERIFIED]` The client-side event queue does synthesize a refresh barrier when it receives `server.stream.gap`: `server-sdk.tsx:559-570` records `phaseTrace.gap`, enqueues the original gap, then enqueues one `server.connected` event for the same event directory. Queue byte overflow in the renderer's own bounded queue also calls `repair(event)` and replaces the queued work with one `server.connected` barrier (`server-sdk.tsx:114-123`, `:150-164`). Therefore the exact answer is conditional: a bare stream death causes no state refetch; a delivered gap or client queue repair causes one barrier-driven refresh path.

`[VERIFIED]` On the global barrier, `server-sync.tsx:710-718` may refetch the active-session query once if it has not loaded, and `applyGlobalEvent` calls `bootstrap.refetch()` for the global bootstrap (`global-sync/event-reducer.ts:37-46`; `server-sync.tsx:712-718`). The global handler then queues only child directories for which `children.active(directory)` is true (`server-sync.tsx:728-734`). The refresh queue de-duplicates by directory and drains at most two directory bootstraps concurrently (`global-sync/queue.ts:8-10`, `:19-25`, `:52-80`). Thus this is at most one global bootstrap plus one directory bootstrap per active directory, not one message-store rebuild per session.

`[VERIFIED]` A directory bootstrap's critical path loads the session list for that directory (`global-sync/bootstrap.ts:453-457`, `:614-617`), and `loadSessions` performs a session-list query only when the retained limit grew; otherwise it trims/no-ops (`server-sync.tsx:501-541`, `:544-579`). The deferred bootstrap work refreshes directory metadata and auxiliary queries, not every session's messages (`bootstrap.ts:457-612`). The shared `ServerSession` message cache is not invalidated or rebuilt by the barrier: `server-sync.tsx:670-682` applies the event once to the shared session reducer, while `applyDirectoryEvent(..., sessionContent: false)` explicitly skips content events (`global-sync/event-reducer.ts:109-125`).

`[VERIFIED]` Background sessions are therefore **not** individually hydrated by a reconnect barrier and their message stores are not rebuilt. Native content reduction itself is gated per session: a suspended session records stale and returns before reduction (`server-session.ts:1035-1067`). The remaining renderer cost of a barrier is global/bootstrap work plus active-directory list work, not N-session message refetch. `[UNVERIFIED]` The wall-clock contribution of that bootstrap/list work versus independent rendering still requires a live app measurement.

`[UNVERIFIED]` This worker could not perform the requested live measurement because no Desktop browser host is registered in this session. Exact human console call: `window.__opencodePhaseTrace()`; compare `current.reconnects`, `current.gaps`, `current.applyV2Ms`, `current.projectionMs`, `current.rowsMs`, `current.frameStalls`, and `current.markdown` during a reproduced stall. A high `frameStalls`/`projectionMs` or `rowsMs` with low reducer totals would identify an independent renderer cost; high `applyV2Ms`/`dispatchMs` concurrent with reconnects would implicate the barrier/reducer path.

### B. Markdown worker head-of-line behavior

`[VERIFIED]` `packages/session-ui/src/components/markdown-worker.ts:32-45` has one module-level `Worker`, one set of pending maps, and one `new Worker(...)` at `:220-228`; all `Markdown` instances, sessions, and tabs in that renderer module share it. No design comment in `markdown-worker.ts`, `markdown-worker-transport.ts`, `markdown.worker.ts`, or the local docs explicitly declares the singleton intentional. `[VERIFIED]` The separate Pierre/Shiki integration does explicitly document its pool choice: `pierre/worker.ts:14-23` says the default is 8 and chooses `poolSize: 2` for OpenCode. That is evidence for a deliberate pool in that subsystem, not proof that the Markdown parser singleton was deliberate.

`[VERIFIED]` Requests from different sessions do queue behind one another within each transport. `createWorkerTransport` tracks active requests globally for that transport and dispatches while `active.size < maxActive` (`markdown-worker-transport.ts:7-20`). The highlight and project transports use the default `maxActive: 4` (`markdown-worker.ts:97-122`), while parse uses `MARKDOWN_PARSE_MAX_ACTIVE = 16` (`markdown-worker.ts:123-137`). These are request slots in one physical Worker, not four/16 threads: the worker receives messages through one `self.onmessage` and its queue runs one `running` promise at a time (`markdown.worker.ts:90-110`; `markdown-worker-queue.ts:39-63`). Parse/project/highlight have separate host-side transport slots but still contend for the same worker event loop.

`[VERIFIED]` Coalescing is per key only. A newer request replaces a queued predecessor with the same key (`markdown-worker-transport.ts:34-43`), and requests for different keys remain FIFO queued until an active slot completes (`:12-20`, `:52-62`). The worker-side latest queue repeats that per-key policy (`markdown-worker-queue.ts:73-89`) and is single-running (`:39-63`). Since `Markdown` creates a unique owner (`markdown.tsx:385-398`) and includes it in projection/code keys (`markdown.tsx:428-447`, `:657-684`), different rendered blocks/sessions do not coalesce with one another. `[VERIFIED]` N concurrent streams can therefore produce cross-session head-of-line delay even though repeated updates for one key supersede.

`[VERIFIED]` `workerSuperseded` does **not** cancel computation already posted to the Worker. The transport's `supersede` callback rejects and removes the main-thread promise (`markdown-worker.ts:102-108`, `:115-121`, `:129-136`), but an active request remains in `active` until `complete` (`markdown-worker-transport.ts:41-55`). The worker-side queue comment says a running job is never touched and its result is still needed to release the active slot (`markdown-worker-queue.ts:17-32`); when the response arrives with no pending consumer, the main thread only calls `transport.complete(...)` (`markdown-worker.ts:236-264`, `:303-308`). Supersession cancels delivery/retains no result, not in-flight Worker CPU.

`[VERIFIED]` `workerQueueMs` measures time from the Worker receiving a request until its job starts (`markdown.worker.ts:112-125`, `:138-171`, `:184-212`), while the phase trace's `workerQueueMs` is the worker-internal value and its `workerDispatchWaitMs` is main-thread time before posting (`markdown-worker.ts:61-83`; `phase-trace.ts:365-375`). Under N concurrent streaming sessions, the expected signature is: one physical worker, a growing FIFO of distinct keys, rising `workerQueueMs` for requests waiting behind active work, and rising `workerDispatchWaitMs` when the host transport's four highlight/project slots (or 16 parse slots) are saturated. `workerSuperseded` rises when newer same-key updates replace queued requests, but it does not count or stop active CPU. This is a code-derived prediction, not a live measurement: `[UNVERIFIED]` exact values and whether user-visible frame stalls are dominated by it require `window.__opencodePhaseTrace()` during N-session streaming.

`[UNVERIFIED]` A pool is warranted if the live trace shows worker queue/dispatch wait and superseded counts materially coincident with frame stalls; a pool is not justified from source alone because the worker has independent per-key coalescing and bounded caches, and the Pierre pool's explicit `poolSize: 2` rationale applies to Shiki rather than Markdown parsing. The current singleton is a verified architectural fact, not yet a verified bug.

### C. Remaining store-level background-session leak

`[FALSIFIED]` The Pass 13 theory that each background tab mounts its own timeline and creates per-tab component fan-out is false. `message-timeline.tsx:652-663` explicitly says the component instance is shared across session tabs and only remounts on server/directory change; the effect runs on tab switches but does not measure all timelines.

`[VERIFIED]` A narrower store-level leak remains. `titlebar-tab-strip.tsx:140-152` calls `session.sync(value.id)` once when each visited tab becomes active. `server-session.ts:891-905` unconditionally calls `resume(sessionID)` before loading, adding that session to `activated` and removing it from `suspended`; there is no matching release in the tab-strip effect. `release` only adds the session back to `suspended` (`server-session.ts:909-912`), and the actual timeline model does release on session change/cleanup (`pages/session/timeline/model.ts:20-33`). Because the tab strip remains mounted while tabs go into the background, sessions visited through it can remain activated after navigation.

`[VERIFIED]` For those activated sessions, `server-session.ts:1056-1067` does not take the suspended early return, so content events are reduced/projected for each activated background session. For sessions that remain suspended, the content-event path returns at `:1056-1059`; the shared reducer is one instance (`server-sync.tsx:293-295`) and the native event is applied once at `:670-682`, not once per mounted timeline. Verdict: `[VERIFIED]` there is still a store-level CPU leak proportional to the number of sessions incorrectly left in `activated`, but `[FALSIFIED]` there is no remaining per-tab timeline fan-out proportional to all mounted background tabs. The exact per-session microsecond cost is already instrumented by `phaseTrace.reducer(..., sessionID)` at `server-sync.tsx:398-410`, but `[UNVERIFIED]` no live sample was available here.
