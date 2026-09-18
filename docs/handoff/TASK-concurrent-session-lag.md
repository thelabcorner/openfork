# TASK: Concurrent-Session Renderer Lag - Root Cause Confirmation & Fix

## 0. Metadata

- **Created**: 2026-09-12 UTC
- **Author**: Claude (Opus 4.6) via GetMCP
- **Assignee**: DeepSeek V4.1 Flash (key3), reasoning variant `max`
- **Scope root**: `/project/opencode`
- **Predecessors**: `docs/handoff/AUDIT-event-loop-concurrency.md` (Tenth Pass), `docs/handoff/HANDOFF-concurrent-sessions.md` (incl. Eleventh Pass addendum)

## 1. Mission

Confirm or refute the Eleventh Pass hypothesis for renderer lag during concurrent sessions, **by measurement**, then fix the confirmed cause. Do not begin with a refactor.

## 2. How to read this document (epistemic discipline)

Every claim below is tagged. **Respect the tags.**

- `[VERIFIED]` - read directly from source at the cited file:line. Trustworthy, but re-read before editing (line numbers drift).
- `[UNVERIFIED]` - plausible inference **not** confirmed. Must be tested before being relied on.
- `[FALSIFIED]` - previously asserted and checked against source; **it is wrong**. Do not resurrect without new evidence.

The cautionary tale: the Tenth Pass produced four confident findings and a three-item roadmap. Three findings did not survive line-by-line verification, and one roadmap item proposed rebuilding machinery that already exists. It read plausibly because it reasoned from **type signatures** (`Record<string, Part[]>`) rather than from **write paths**. Do not repeat that error. Read the handler bodies.

## 3. The observed symptoms (ground truth from the reporter)

1. Renderer lag / event-loop stalls when multiple sessions run concurrently.
2. **Severity scales with the number of simultaneously active sessions.**
3. **It resolves on its own once all sessions complete** - no reload, no navigation.

Symptoms 2 and 3 are the entire diagnostic lever. Reason about them explicitly:

- A cost driven by store **shape** (one big store, array-vs-map part keying) is **time-invariant**. The store holds the same keys and the same array layout after streaming stops, so shape-driven lag would **persist**. It does not persist. Therefore shape is not the driver.
- A cost that **vanishes at completion** must be gated on a **liveness predicate** - something true only while `session_working` is `true`.

That single inference moves the investigation out of `server-session.ts` and into the **timer-driven consumers** of the store.

## 4. PRIMARY HYPOTHESIS (H1): ticker x liveness x part-array walks

**File**: `packages/app/src/pages/session/v2/chat-sidebar-pane.tsx`

`[VERIFIED]` Line ~174: the pane owns one shared 1s ticker, `const tick = setInterval(() => setNow(Date.now()), 1000)`, with `onCleanup(() => clearInterval(tick))`. Its comment notes per-row intervals "would multiply timers by the number of visible sessions" - so timer *count* was already considered. Sharing the timer does **not** share the work it triggers.

`[VERIFIED]` Line ~x7E1088: `now` is passed into each row as a prop.

`[VERIFIED]` Per-row `live` memo (row component starts ~1540):

```ts
const live = createMemo(() => {
  if (!isWorking()) return undefined                // ~1607 - LIVENESS GATE
  // ...walk messages backward to find active assistant msg...
  const progress = liveGenerationProgress(active, activeParts, props.now()) // ~1628
  rate: computeMeasuredRate(activeParts, props.now())?.rate ?? null   // ~1633
})
```

`[VERIFIED]` `isWorking` = `createMemo(() => sessionData().session_working(props.session.id))` (~1548), and `sessionData` = `() => serverSync().session.data` (~1547) - i.e. rows read the **shared session store directly**.

### 4.1 Why H1 fits both symptoms

**Scaling with N.** With N sessions working, N row `live` memos depend on `now()`. Each tick invalidates all N, and each re-runs two functions that **walk the active message's entire part array**:

- `[VERIFIED]` `streamedChars(parts)` (`components/prompt-input/live-generation-rate-math.ts`) loops all parts, summing `part.text.length` for text/reasoning.
- `[VERIFIED]` `computeMeasuredRate(parts, now)` (same file) loops all parts for min `time.start` / max `time.end`, **then calls `streamedChars`** - a second full pass.
- `[VERIFIED]` `liveGenerationProgress(msg, parts, now)` (`components/session/session-context-model-metrics.ts` ~268) calls `toolExecutionSeconds(parts, now)` - another pass.

So per tick: **O(N_active x parts_per_turn)**, with ~x7E3-4 passes per row.

**Getting progressively worse.** `parts_per_turn` grows monotonically while a turn streams (each new tool call / text block appends a part). So the per-tick cost rises over the life of each turn - the lag compounds **within** a turn, not just across N. This matches "progressively gets worse the more sessions are active" better than a flat multiplier would.

**Self-resolution.** `[VERIFIED]` On completion `session_status` goes `idle` (`server-session.ts`: `session.execution.succeeded/failed/interrupted` -> `setData("session_status", id, {type:"idle"})`), `session_working()` returns false, `isWorking()` flips, **every row memo short-circuits at ~1607**, and per-tick cost drops to near zero. No reload required. This is the strongest single piece of evidence for H1.

### 4.2 The gap this exposes (most important insight)

The existing background-session gate **does not cover this path**.

`[VERIFIED]` `server-session.ts` has `suspended` (~253), `release()`/`resume()` (~904-913), and pre-reduce bails: V2 at ~1046-1049 (`if (suspended.has(sessionID) && contentEvent) { stale.add(sessionID); return }`) and V1 at ~1109. Wired to routing in `pages/session/timeline/model.ts` (`release(previous)` on change and in `onCleanup`; `resume(id)` on activation).

That gate suppresses **event-driven** work for background sessions and works correctly. But sidebar rows are driven by a **wall-clock timer**, not by events, and read the store directly. So a background session whose deltas are being correctly dropped **still pays the full per-second cost**. The gate is orthogonal to the hot path.

## 5. SECONDARY HYPOTHESIS (H2): `totals()` tracks the global part record

`[VERIFIED]` `chat-sidebar-pane.tsx` ~1582:

```ts
const session = aggregateSessionContextByModel(messages(), sessionData().part, []).session
```

`sessionData().part` is the **global `Record<messageID, Part[]>` for every message of every session**, not this row's slice. The doc comment above `totals` correctly avoids reading `now()`, so the **ticker** does not wake it.

`[UNVERIFIED - MUST TEST]` But the memo still **tracks `data.part`**, which streaming deltas mutate continuously. Open question: does Solid's fine-grained proxy narrow the dependency to the touched `messageID` key, or does handing the whole container to a **plain non-reactive function** coarsen it to the entire record?

If coarsened, every token in **any** session wakes `totals()` in **every** visible row, and `aggregateSessionContextByModel` (`session-context-model-metrics.ts` ~432) loops every assistant message calling `countToolCalls(parts[msg.id])` and `measuredGenerationSeconds` per message - **O(rows x messages x parts) per token**. That would be far worse than H1 and would also scale with N and clear on completion (deltas stop). **H1 and H2 are not mutually exclusive and have overlapping signatures.** Distinguish them by: H1 fires at exactly 1 Hz per row; H2 fires at token rate. A profile flame chart separates them trivially.

## 6. FALSIFIED claims - do NOT act on these

`[FALSIFIED]` **"Coarse part array granularity: any delta replaces/mutates the entire array, causing an O(N_sessions x N_messages) cascade."** The `message.part.delta` handler (`server-session.ts` ~1356-1365) mutates **one indexed leaf's one field** inside `produce`: `draft[result.index][field]  = props.delta`. `message.part.updated` writes `setData("part", messageID, result.index, reconcile(part))` (~1274). Array-identity replacement occurs **only on part insertion** (~1276-1281) - once per new part, not per token. **Do not re-key `Record<string, Part[]>` to `Record<string, Part>` plus an ID index on this basis.** It is a large invasive refactor across a 1,561-line file whose justification does not reproduce, and it cannot explain self-resolution on completion.

`[FALSIFIED]` **"Lack of viewport/active-session gating; background sessions keep running applyV2/projectV2/normalizeSessionMessages per token."** The gate exists (see 4.2) and bails **before** `v2.reduce`/`projectV2`. A second gate exists in `global-sync` (`sessionContent: false` at both production call sites), locked by `context/global-sync/session-content-gate.test.ts` whose comment states the child store must NOT accumulate streaming text or "every token would pay for a second reactive projection that nothing renders." **Implementing "background session projection gating" would duplicate existing machinery.**

`[PARTLY FALSIFIED]` **"Monolithic reactive store causes store-wide reactivity checks across renderer components."** A single `createStore` does exist (`server-session.ts` ~216-237) and all sessions share it. But hot writes are **key-path targeted**, so a delta in session A does not sweep components bound to session B's keys. Shared *container*, not shared *invalidation*. Do not split the store as a first move.

## 7. CONSTRAINT: `part_text_accum_delta` is renderer-visible

`[VERIFIED]` The Tenth Pass proposed moving `part_text_accum_delta` out of the reactive store into a plain `Map<string,string>`. **This would break streaming text rendering.** It is read by the renderer: `packages/session-ui/src/components/message-part.tsx` ~2116 and ~2174 both call `readPartText(data.store.part_text_accum_delta, part())`, and `message-part-text.ts` is:

```ts
export function readPartText(accum, part) {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}
```

It **prefers the accumulator over `part.text`**. A non-reactive `Map` removes the reactive source the streaming text renders from, so text would stop updating mid-stream.

`[VERIFIED]` It is also load-bearing elsewhere: `context/directory-sync.ts` routes it through the `sessionFields` proxy (~21); `global-sync/session-cache.ts` and `global-sync/event-reducer.ts` maintain it; `global-sync/types.ts` declares it; `session-ui/src/context/data.tsx` (~40) types it as optional. Roughly 12 assertions read `store.data.part_text_accum_delta` across `server-session.test.ts`, `session-cache.test.ts`, `event-reducer.test.ts`, `bootstrap.test.ts`, and `session-content-gate.test.ts`.

**If you ever extract it**, preserve a reactive read path (e.g. a per-part signal that `readPartText` consumes, or a `createStore` keyed per part) - **never a plain `Map`**. But note: **this is not the reported bug.** Accumulator churn scales with token rate, not `N_active`.

## 8. Genuine (but minor) finding: double write per token

`[VERIFIED]` `server-session.ts` `message.part.delta` writes the same text **twice per token**: to `part_text_accum_delta[partID]` (~1348) and to `part[messageID][index][field]` (~1356). Since `readPartText` prefers the accumulator and falls back to `part.text`, that is two reactive writes yielding one rendered string.

**Do not treat this as the lag cause.** It is paid only for non-suspended sessions and scales with token rate, not `N_active`, and would not clear on completion differently from any other delta work. Deduplicating it is worthwhile hygiene - **but only after H1/H2 are settled**, and only with the ~12 test assertions updated deliberately. Beware: `deltaBases` and the `preserveDelta` logic in `replaceParts` (~679-690) depend on the accumulator and `part.text` diverging - read that block before changing either write.

## 9. YOUR PLAN - execute in this order

**Phase 0: re-verify.** Line numbers may have drifted. Re-read each cited site before trusting it. If any `[VERIFIED]` claim does not match what you find, **say so explicitly and stop** - do not quietly work around it.

**Phase 1: measure (do this before any fix).**

1. **Ticker bisect.** Change `chat-sidebar-pane.tsx` ~174 from `1000` to `5000`. Reproduce with several concurrent sessions. If lag drops roughly proportionally, **H1 confirmed**. If unchanged, H1 is wrong - pivot to H2. This is a one-token edit and the single highest-information experiment available. **Revert it afterwards.**
2. **Profile.** Capture a performance profile while N sessions stream. Look for per-second stacks under `computeMeasuredRate`, `streamedChars`, `toolExecutionSeconds`, `liveGenerationProgress`, `aggregateSessionContextByModel`. Frequency discriminates H1 (1 Hz x rows) from H2 (token rate x rows).
3. **Count rows.** Determine whether the sidebar virtualizes. If all sessions render rows regardless of visibility, N is total sessions, not visible ones - which would amplify everything above. I did not verify this.

**Phase 2: fix only what Phase 1 confirmed.** Candidate remedies, cheapest first:

1. **Single-pass metrics.** `liveGenerationProgress` and `computeMeasuredRate` traverse the same `activeParts` on the same tick, and `computeMeasuredRate` internally calls `streamedChars` for yet another pass. Fold into one traversal returning all needed scalars. Pure-function change, well covered by `session-context-model-metrics.test.ts` and `live-generation-rate.test.ts`.
2. **Incremental `streamedChars`.** Cache per `(messageID, partCount, lastPartLength)` instead of recomputing over a monotonically growing array each tick.
3. **Scope `totals()`.** Pass only this session's part slice rather than the global `part` record (addresses H2 directly).
4. **Decouple tick from metrics.** The 1s tick exists for **duration display**. Rates need not recompute at the same cadence - consider a slower cadence for rate, or recompute rate on part-change rather than on clock tick.
5. **Extend liveness gating to timer-driven consumers** - the structural fix for 4.2. Rows for sessions that are working but **not visible/expanded** need not compute live rates at all.

## 10. Other timer-driven suspects (not yet investigated)

- `[VERIFIED exists, UNVERIFIED impact]` `components/prompt-input/live-generation-rate.ts`: a **200ms** `setInterval` sampler gated on `args.working()` - same liveness signature at 5x the frequency. It *appears* scoped to the active composer rather than per-session, so it likely does not scale with N - **confirm this** rather than assuming. Note `setSamples((prev) => [...prev, ...])` allocates a new array every 200ms.
- `[UNVERIFIED]` `pages/session/timeline` row projection. `timeline/THROUGHPUT.md` claims the footer chip recomputes on message-list identity "never per token delta" - verify that claim holds under concurrency rather than trusting the doc.
- `[UNVERIFIED]` `components/session/session-context-tab.tsx` has its own `now()`-driven `liveDelta` memo (~391). Only costly if the tab is open.

## 11. Deliverables

1. A verdict on H1 and H2 **with measurements**, not reasoning alone.
2. The minimal fix for whatever was confirmed, with `bun test` passing in affected packages.
3. An appended **Twelfth Pass** section in `docs/handoff/HANDOFF-concurrent-sessions.md` using the same `[VERIFIED]`/`[UNVERIFIED]`/`[FALSIFIED]` tagging.
4. **Explicit list of anything in THIS document you found to be wrong.** I verified what I cite, but I did not run the app and I did not profile. H1 is a hypothesis with a good mechanism and a matching signature - it is **not a confirmed diagnosis**. Treat it as the most probable lead, not as truth. Overturning it with evidence is a success, not a failure.

## 12. Rules

- Scope: `/project/opencode` only.
- **Measure before refactoring.** No large refactor on an unconfirmed hypothesis.
- Prefer the smallest change that removes the confirmed cost.
- Revert instrumentation (e.g. the ticker bisect) before finishing.
- Cite `file:line` for every claim you add. If you did not verify it, tag it `[UNVERIFIED]`.
- Do not implement Tenth Pass roadmap items 1-3 as written (see sections 6-7).
