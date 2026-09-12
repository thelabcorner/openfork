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
9. The task's instruction not to implement Tenth Pass roadmap item 3 "as written" is honored: no projection-deferral mechanism was added. The fix corrects the coverage of the existing `suspended` machinery on a background load path that never consulted it.
