## UPDATE (later session) — root cause found, do not re-chase §4 hypotheses

The §4 hypotheses (periodic timers, sync persistence, GC, IPC blocking) were **not** the
cause. Attached to the already-running `bun run dev` instance via CDP (no restart —
`http://127.0.0.1:9222/json/list`, page titled "OpenCode") and captured a CPU profile
time-correlated with live `[perf-longtask]` spikes (see `packages/app/scripts/cdp-*.mjs`,
kept for reuse). Every real spike (300ms–900ms+) attributed to the same call stack:
`message-timeline.tsx`'s `virtualizer.resizeItem` wrapper + `@tanstack/solid-virtual`'s
`measureElement`/`getMaxScrollOffset` + `scrollTo`.

**Root cause:** the `resizeItem` wrapper (message-timeline.tsx, was ~line 537-559) read
`root.clientHeight` live on **every single row resize call** to decide whether a size
change was big enough to trigger the "pin visible rows" branch. The virtualizer writes
row-position styles for other rows in the same batch, so this interleaved
read-after-write pattern forced a synchronous layout recalc on nearly every row —
classic layout thrashing, O(rows) forced reflows instead of O(1). Gets worse with more
messages/rows in a session, matching "the longer it runs the worse it gets."

**Fix applied:** cache the container height from the existing width `ResizeObserver`
(async, uses `entry.contentRect.height`, no forced read) into a `containerHeight`
variable instead of reading `root.clientHeight` live inside `resizeItem`. Also removed
one redundant synchronous `root.clientWidth` read at effect-setup time (the
`ResizeObserver`'s guaranteed initial callback already supplies it via `contentRect`).
Verified via typecheck + HMR reload with no errors; not yet re-profiled post-fix to
confirm spike elimination live (interaction-dependent, needs a real scroll/stream
session to reproduce and re-measure).

**Aside:** captured one burst of 35 SolidJS "computations created outside a `createRoot`
or `render` will never be disposed" warnings coincident with a Vite HMR reconnect. No
`import.meta.hot` custom handling exists in the app, so this is most likely a dev-only
Vite/Solid HMR artifact, not a production leak — flagged but not chased further.

---

# Performance Investigation Handoff — opencode desktop/app streaming & idle jank

> Handoff for the next agent. Goal: find and fix the real main-thread jank in the
> opencode desktop app. This doc is the record of what was already proven so you
> don't re-derive it. Read it before touching code.

## TL;DR (read this first)

**The SSE / event-streaming / reducer path is NOT the bottleneck.** A dev build profiler
(`[perf]`) measured the consumer during live use: `reducer ms/s` is **0** even during
41–43 events/s bursts. All prior optimization work (keepalive, refcount, SSE coalescing,
health-poll gating, content caching, suspended gates) was applied to a layer that is
essentially free.

**The real problem is sporadic long main-thread tasks (up to ~2.7s) that occur even at
idle (0 events/s).** These are a periodic/triggered task unrelated to streaming. They are
the actual source of perceived jank ("sometimes it randomly hits 500+ ms"). Find that task.

Everything below is established fact or live-measured evidence unless marked "hypothesis".

---

## 1. What is already proven — DO NOT re-investigate

- **SSE coalescing / emit-count reduction does not move the needle.** A microbenchmark
  (`packages/app/bench/sse-consume.bench.mts`) raced client-side SSE consumer strategies.
  Winner was candidate **H** (retained delta accumulator + dirty-set + threshold emit):
  ~89% fewer emits, 13–100× less downstream string-concat, viable throughput. BUT the
  benchmark also proved that **at the real 16ms flush cadence the emit reduction is ~0%**
  (candidate F: 0.2–0.8% compaction) because few delta keys repeat within one 16ms window.
  The 89% only appears with *sparse* (threshold-based) emission, which trades away live
  streaming latency. So even the "best" client optimization is marginal at normal cadence.
- **The v2 session reducer is O(messages) per delta but cheap in absolute terms.**
  Benchmark (`../../packages/app/bench/v2-reducer.bench.mts`): `source.map` over the whole
  session per text/reasoning/tool delta costs ~4–36µs/delta → ~74ms/sec of CPU at 150
  messages. Not dominant.
- **A live `[perf]` run (see §2) confirmed the consumer reducer stack is ~0ms/s** even
  under burst. This supersedes any theoretical concern about reducer cost.
- **Connection-level fixes already shipped and are irrelevant to the remaining jank:**
  keepAliveTimeout/headersTimeout + TCP keepalive on dead SSE sockets
  (`../../packages/opencode/src/server/server.ts`), desktop window-startup ordering
  (`../../packages/desktop/src/main/index.ts`), refcount bug fix
  (`../../packages/app/src/utils/refcount.ts`), content-scope cache
  (`../../packages/app/src/context/file.tsx`), suspended-session gate
  (`../../packages/app/src/context/server-session.ts`), SSE liveness marking
  (`../../packages/app/src/context/server-sdk.tsx`) + health-poll gating
  (`../../packages/app/src/utils/server-health.ts`).

**Conclusion to carry forward:** stop optimizing the event/transport/reducer layer. Aim at
the periodic long task.

---

## 2. Evidence — live profiler output (user's `bun run dev` run)

Profiler (`../../packages/app/src/context/perf.ts`) auto-enables in dev builds. Each second it
prints:

```
[perf] <events/s> events/s · <ev/frame> ev/frame | reducer ms/s: applyV2 0 apply 0 dir 0 home 0 invalid 0 · applyV2 0.00us/ev | frame: max <ms>ms stalls(>50ms) <n>
```

Representative lines from the run:

| time | events/s | reducer ms/s (applyV2/apply/dir/home/invalid) | frame max |
|------|----------|-----------------------------------------------|-----------|
| 20:54:09 | 3 | 0 / 0 / 0 / 0 / 0 | 96ms |
| 20:54:20 | 0 | 0 / 0 / 0 / 0 / 0 | **990ms** |
| 20:54:26 | 41 | 0 / 0 / 0 / 0 / 0 | 29ms |
| 20:54:32 | 0 | 0 / 0 / 0 / 0 / 0 | **319ms** |
| 20:54:33 | 0 | 0 / 0 / 0 / 0 / 0 | **519ms** |
| 20:54:47 | 0 | 0 / 0 / 0 / 0 / 0 | **2732ms** |
| 20:55:09–21 | 6–10 | 0 / 4–8 / 0 / 0 / 0 | 20–28ms |

Observations:
- `reducer ms/s` is **0** across the board, including the 41–43 events/s burst at
  20:54:26–27. The only nonzero entry was `apply` ~4–8ms/s during a tiny idle trickle
  (negligible).
- The **only** large numbers are `frame: max` spikes — 319ms, 519ms, 990ms, **2732ms** —
  and these occur at **0 events/s (idle)**. That is the jank.

> **Profiler bug already fixed (don't be fooled):** an earlier version counted a "stall"
> for every frame `>16ms`, which means it counted normal 60fps frames (16.7ms) — so the
> historical `stalls 48-75/sec` numbers are meaningless. The threshold is now `>50ms`.
> Trust the `frame: max` column, not `stalls`, in any old log.

---

## 3. Architecture map (so you don't re-derive it)

**Data flow (renderer process):**
```
server-sdk.tsx  createServerSdkContextBase
  └─ for await (SSE) → markServerStreamLive → receive({directory, payload})
       └─ retained delta accumulator (v2/v1 nested maps + dirty sets)
  └─ flush() every ~16ms (FLUSH_FRAME_MS) inside batch()
       └─ emitter.emit(directory, payload)   ← one emit per (coalesced) event
server-sync.tsx  createServerSyncContextInner
  └─ serverSDK.event.listen((e) => {            ← runs PER EMITTED EVENT, unbatched
       session.applyV2(event.current)          (v2 reducer: O(messages) source.map/delta)
       session.apply(event)
       homeSessions.apply / refresh
       applyDirectoryEvent(...)                (v1 reducer: produce + Binary.search + deltaBases)
       queryClient.invalidateQueries(...)      (mcp/tool/group changes)
     })
```

**Key files:**
- `../../packages/app/src/context/server-sdk.tsx` — SSE consumer + retained accumulator + flush.
- `../../packages/app/src/context/server-sync.tsx` — **consumer join point (line ~542)**, runs the
  full reducer stack per event. This is where the profiler is wired in.
- `../../packages/app/src/context/server-session.ts` — `applyV2` wrapper + `projectV2`; suspended
  gate at line ~989.
- `../../packages/app/src/context/server-session-v2-reducer.ts` — pure v2 reducer; `update()` does
  `source.map(...)` (O(messages)) per delta (lines 427–433).
- `../../packages/app/src/context/global-sync/event-reducer.ts` — v1 reducer (`message.part.delta`
  append at lines 364–388; `deltaBases` capture at ~1282).
- `../../packages/app/src/context/perf.ts` — **the profiler (NEW, dev-only, zero cost when off).**

**Facts about the consumer:**
- SDK context is deduped per server connection via `ensureServerCtx` (global.tsx) → 1 SSE
  stream per server **per renderer window**; N windows = N streams (inherent, not a bug).
- v2 reducer consumes `event.current` (the raw `OpenCodeEvent`); v1 reducer consumes
  `event.properties.delta`. Both **append** incremental deltas, so an accumulated/coalesced
  delta is correct (verified against `server-session-v2-reducer.ts:198` and
  `event-reducer.ts:375/384`).

---

## 4. The actual problem & leads to chase

**Symptom:** sporadic 300ms–2.7s main-thread blocks at idle. Not correlated with event
rate. This is the thing to fix. Hypotheses, ranked by how well they fit "blocks at idle,
multi-hundred-ms to seconds, periodic-ish":

1. **Periodic store updates triggering full re-renders.** Several `setInterval`s write to
   stores every 1s / 60s; if a large component tree subscribes broadly, each tick re-renders
   everything. Candidate timers (file:line, from a grep — verify before assuming):
   - `pages/session/session-context-tab.tsx:312` — `setNow(Date.now())` every 1000ms
   - `pages/layout/layout.tsx:195` — `setState("sortNow", Date.now())` every 60000ms
   - `context/fork-usage.tsx:62` — heartbeat interval (`heartbeatMs`)
   - `components/prompt-input.tsx:527`, `components/session/live-generation-rate.tsx:65`
   - `utils/server-health.ts:209` — `refresh()` every `pollMs` (NOTE: already gated on SSE
     liveness, but confirm the gate actually suppresses it)
2. **Synchronous persistence of a large store.** `createChildStoreManager` uses `persisted`
   (`../../packages/app/src/context/global-sync/child-store.ts`); if a large per-directory session
   store is serialized synchronously on change/debounce, that can take seconds.
3. **Memory leak → major GC.** A 2.7s pause fits a large/leaky heap. Watch the Memory tab
   during a session; look for unbounded growth in `session`/`part`/`part_text_accum_delta`
   stores or event listeners never torn down.
4. **Desktop main-process IPC blocking the renderer.** The sidecar/CLI
   (`C:/Users/.../AppData/Roaming/ai.opencode.desktop.dev`) or `platform.fetch` doing sync
   work that the renderer awaits. rAF measures the renderer main thread, so a sync IPC wait
   shows up as a long task.

**How to attribute definitively (in priority order):**
1. The new `[perf-longtask]` watcher (PerformanceObserver, threshold 100ms) logs
   `[perf-longtask] <ms> · <container>` — `container` tells you app-bundle vs iframe vs
   extension. Already enabled in dev.
2. **CPU profile.** DevTools is exposed: `DevTools listening on ws://127.0.0.1:9222/devtools/browser/...`
   (from the run log). Connect Chrome DevTools, record Performance for ~20–30s covering a
   spike, read the flamegraph — it names the exact function. This is the fastest path to a
   root cause.
3. Memory tab snapshot/diff for the leak hypothesis.

---

## 5. Reproduce / get data

```bash
# from repo root — opens the desktop dev exe; console shows [perf] lines automatically
bun run dev
```
- Profiler auto-enables in dev (`import.meta.env.DEV`). To force it in a prod/non-dev build:
  `localStorage.setItem("opencode:perf","1")` then reload; disable with
  `localStorage.removeItem("opencode:perf")`.
- Renderer dev server: `http://localhost:5173/` (per run log).
- Watch the console for `[perf]` (per-second summary) and `[perf-longtask]` (block
  attribution). Paste those lines when a spike happens.

---

## 6. Traps — do NOT waste time here

- **Don't re-optimize the SSE coalescing / emit path.** It is proven free (`reducer ms/s=0`).
  The retained accumulator in `server-sdk.tsx` is already implemented; do not "fix" it
  thinking it's the bottleneck.
- **Ignore historical `stalls 48-75/sec` numbers** in old logs — that was the 60fps false
  positive (see §2 note). Use `frame: max`.
- **`../../packages/app/src/context/server-sdk.test.ts` fails to *load*** with
  `SyntaxError: Export named 'use' not found in module 'solid-js/web'`. This is a
  pre-existing import-resolution issue in the test runner (solid-js/web server build),
  **unrelated to performance**. Don't chase it.
- **Pre-existing type errors** in `packages/app/src/pages/session/v2/browser/*`
  (`HostedBrowserWebview.tsx`, `browserHostClient.ts`) — unrelated to this investigation;
  `bun typecheck` will show them. Don't treat them as regressions from the perf work.
- **AGENTS rule:** never restart the app/server process; use the dev exe / dev servers.
- The working tree has **many unrelated changes** from earlier sessions (core/database,
  session/spad, etc. — see §7). Assume NOTHING outside the perf files is part of this
  investigation.

---

## 7. Relevant working-tree changes (this investigation only)

Modified/added by the perf work (verify with `git status`):
- `../../packages/app/src/context/perf.ts` — **NEW** dev-only profiler (`[perf]`, `[perf-longtask]`)
- `../../packages/app/src/context/server-sdk.tsx` — retained accumulator (H) + `perf.frame()`
- `../../packages/app/src/context/server-sync.tsx` — profiler instrumentation in the consumer
- `../../packages/app/src/utils/server-liveness.ts` — **NEW** (SSE liveness tracking)
- `../../packages/app/src/utils/server-health.ts` — health-poll gating on SSE liveness
- `packages/app/bench/sse-consume.bench.mts` — **NEW** consumer strategy benchmark
- `../../packages/app/bench/v2-reducer.bench.mts` — **NEW** v2 reducer cost benchmark
- `../../packages/opencode/src/server/server.ts` — keepAliveTimeout/TCP keepalive (prior round)

Unrelated changes present in the tree (do not assume related): `packages/core/src/database/*`,
`packages/core/src/session/*`, `packages/opencode/src/session/spad/*`, plus various
`docs/chunkdb/*` and backup scripts. These are from earlier unrelated sessions.

---

## 8. Suggested next agent plan

1. Run `bun run dev`, let it idle + stream, collect `[perf]` and `[perf-longtask]` lines.
2. Reproduce a long-task spike; read its `[perf-longtask]` container attribution.
3. If attribution is inconclusive, take a **CPU profile** (DevTools ws://127.0.0.1:9222)
   over a spike → flamegraph names the function.
4. If CPU profile points at GC, take a **Memory** snapshot/diff to find the leak.
5. Fix the root cause (likely one of §4.1–4.4). The fix is almost certainly NOT in the SSE
   consumer — expect it in a periodic timer, a persistence path, or an IPC call.
