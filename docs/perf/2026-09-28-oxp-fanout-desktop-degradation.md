# OXP fan-out desktop degradation — live investigation (2026-09-28)

Status: **investigation complete, no code changed.** Findings are measured against
the running `bun run dev` desktop app (Electron 42.3.3, app `1.18.30`, dirty
working tree at `ac08136011`). Line references are to the working tree as of this
date; `chat-sidebar-pane.tsx` had uncommitted changes at the time.

## TL;DR

The user reported ~80+ active sessions, the debug bar's "Long task" readout pinned
near 3000, and a severely laggy app. There were two independent failures,
triggered by the same OXP worker fan-out:

1. **Renderer: compositor saturation from per-rect SVG spinner animations.**
   Every "working" sidebar row renders a `Spinner` with **12 separately animated
   `<rect>` elements**, and each working session is rendered **twice** (Recent
   plus its project group). At 84 working sessions that was **2,016 concurrent
   opacity animations**. Chromium's `Layerize` / `PaintArtifactCompositor::Update`
   step then cost **~200 ms per frame** (66% of the main thread), and the app ran
   at **~4 fps**. A live A/B test that removed only those animations went from
   **4.4 fps → 34.4 fps** and cut long-task time from **93% → 6%**.
2. **Sidecar: the server's main JS thread hung at 01:07:05** in a synchronous CPU
   loop: one core pinned, flat memory, zero I/O. HTTP requests timed out, the
   event stream stopped, and the runtime-owner heartbeat stopped. After the
   dev app was relaunched from WebStorm, the hung sidecar survived as an
   **orphan** and still held execution leases for 88 sessions.

Secondary defects found along the way:

- The context panel's limits cards **fully remount every second** (~390 DOM
  nodes/s), and a hook **scans the synced message history every second**.
- An **unscoped server request materializes a full workspace instance at
  `process.cwd()`**; this was reproduced live.
- **Stale execution leases accumulate** across restarts.
- Several **observability gaps** prevented faster root-causing.

## Contents

- [Scope, method, and side effects](#scope-method-and-side-effects)
- [Timeline](#timeline)
- [F1 — Renderer compositor saturation (primary lag cause)](#f1--renderer-compositor-saturation-primary-lag-cause)
- [F2 — Sidebar per-second writes on off-screen rows](#f2--sidebar-per-second-writes-on-off-screen-rows)
- [F3 — Limits panel remounts every second and scans message history](#f3--limits-panel-remounts-every-second-and-scans-message-history)
- [F4 — Sidecar event-loop hang](#f4--sidecar-event-loop-hang)
- [F5 — Hung sidecar orphaned by relaunch](#f5--hung-sidecar-orphaned-by-relaunch)
- [F6 — Stale execution leases](#f6--stale-execution-leases)
- [F7 — Unscoped request creates a cwd instance; status is per-instance](#f7--unscoped-request-creates-a-cwd-instance-status-is-per-instance)
- [F8 — Fan-out shape amplifies every per-session cost](#f8--fan-out-shape-amplifies-every-per-session-cost)
- [F9 — Observability gaps](#f9--observability-gaps)
- [Other observations](#other-observations)
- [Ruled out](#ruled-out)
- [Recommendations](#recommendations)
- [Open questions](#open-questions)
- [Appendix — measurement toolkit](#appendix--measurement-toolkit)

## Scope, method, and side effects

Constraint: **do not close or restart the app** (active sessions were running;
`packages/app/AGENTS.md` forbids restarting). All live measurement used
non-destructive paths:

| Technique | Purpose |
|---|---|
| `renderer.log` / `server.log` bucketing | Onset detection (`[perf]` and `[perf-longtask]` lines) |
| `process._debugProcess(<electron main pid>)` → Node inspector `127.0.0.1:9229` | Entry point into the Electron main process (`--remote-debugging-port=9222` was configured but **not bound**; `DevToolsActivePort` was stale) |
| main-process `webContents.fromId(1).debugger` (CDP 1.3) | Renderer CPU profile, `Memory.getDOMCounters`, `Performance.getMetrics` |
| main-process `contentTracing` | 5 s Chromium trace of renderer lifecycle phases |
| main-process `webContents.executeJavaScript` | DOM/animation census, MutationObserver churn probes, reversible CSS A/B |
| Authenticated sidecar HTTP (`packages/mobile/.opencode-dev-agent-token.json`) | Session metadata, messages, status |
| Read-only SQLite (`mode=ro`) pragmas and small-table reads | Lease and owner state |
| Win32 process / thread / IO counters | Sidecar hang characterization |

**Side effects the investigation caused.** They are listed here for honesty and
for anyone reading these logs later.

- Four full workspace instances were created on the old sidecar by diagnostic
  probes, including one at `C:\Users\slooshied` through the cwd fallback (see
  [F7](#f7--unscoped-request-creates-a-cwd-instance-status-is-per-instance)).
  They were created at 01:02:33–01:02:55, 4.5 minutes before the hang. See
  [F4](#f4--sidecar-event-loop-hang) for why they are unlikely to be the hang cause.
- Node inspectors were opened on the old main process (died with it) and on the
  **new** main process (PID 87844, `127.0.0.1:9229`). They remain until that
  process exits. Do **not** call `inspector.close()` from an attached session: it
  blocks until connections close.
- A spinner-disabling `<style>` was injected for ~10 s during the A/B test and
  then removed (verified `restored: true`).
- With the user's explicit approval, the orphaned hung sidecar (PID 86204) and
  its 21 descendants were terminated at ~01:21.

Artifacts (profiles, traces, scripts) are in `%TEMP%\openfork-perf\`.

## Timeline

All times are local (UTC−5), night of 2026-09-27 → 2026-09-28.

| Time | Event | Source |
|---|---|---|
| 17:33:30 | Desktop dev app starts (sidecar `:39321`, run `130791a0`) | `main.log` |
| 17:30–00:45 | Long-task time 0–2% per 10-minute bucket | `renderer.log` |
| **00:47:02** | OXP worker delegation starts creating sessions ("ES3 quirk research 01…") | `server.old.log` |
| 00:47–00:54 | **~147 new top-level sessions** (17 / 16 / 34 / 63 / … per minute) | `server.old.log` `created` |
| 00:47:54, 00:48:30 | Bursts of `[session.error] [object Object]` in the renderer | `renderer.log` |
| 00:48:16, 00:48:22 | 2× `SqlError: Failed to execute statement` (cause not logged) | `server.old.log` |
| **00:49** | Renderer long-task time 21% → **89–95%** from 00:50 onward | `renderer.log` |
| 00:53 | 32× `AbortError`: first ES3 wave (`space-bunny-free`) aborted | `server.old.log` |
| 00:53–00:54 | Wave respawned on `openai/gpt-6-luna`, then "replacement" sessions | `server.old.log` |
| 01:01:35 | `server.log` rotates (only one 5 MB `server.old.log` retained) | log dir |
| 01:02:33–55 | Diagnostic probes create 4 instances (see [F7](#f7--unscoped-request-creates-a-cwd-instance-status-is-per-instance)) | `server.log` |
| **01:07:05** | **Last sidecar log line; runtime-owner heartbeat stops; event stream stops** | `server.log`, `runtime_owner` |
| 01:07–01:15 | Sidecar: 1 core pinned, HTTP requests time out, renderer 0 events/s | live probes |
| **01:15:54** | Dev app relaunched from WebStorm; **old sidecar orphaned** | process tree |
| 01:16:05 | New sidecar: `pending Goal continuation recovery failed … SessionBusyError` | new `server.log` |
| ~01:21 | Orphan + 21 descendants terminated (user-approved) | — |
| 01:23 | New renderer already at 37 spinners / 436 animations | live probe |

## F1 — Renderer compositor saturation (primary lag cause)

### Evidence

**Process level.** The renderer (PID 21452) used **176% CPU** (main thread
saturated plus raster). The sidecar used 34% at the time and the GPU process 50%.

**App perf log.** Reducer cost stayed low throughout (`apply` ≈ 8–17 ms/s at
~100 events/s), while back-to-back 200–450 ms long tasks ran continuously. The
app's own sampler already says this split means "rendering, not the SSE/reducer
path" (`packages/app/src/context/perf.ts:9-15`).

**JS CPU profile** (10 s, 500 µs sampling):

| Bucket | Share |
|---|---|
| `(program)`, i.e. native Blink work | **91.6%** |
| All JS (Solid runtime, sidebar, server-sdk flush) | ~8% |
| `(idle)` | 0.2% |

**`Performance.getMetrics` delta over 10 s:** `TaskDuration` 11.8 s,
`ScriptDuration` 0.93 s, `RecalcStyleDuration` 1.27 s, `LayoutDuration` 0.12 s.
Most task time was outside script, style, and layout.

**Chromium trace** (5 s, `CrRendererMain` of PID 21452):

| Phase | Inclusive | Count |
|---|---|---|
| `ProxyMain::BeginMainFrame` | 4,390 ms | **19 frames in 5 s** |
| `Layerize` / `PaintArtifactCompositor::Update` (self) | **3,298 ms** | 19 (≈175–205 ms each) |
| `Document::recalcStyle` | 390 ms | 30 |
| `Paint` | 128 ms | 3,525 |
| `Layout` | 57 ms | 22 |
| `UpdateLayer` | — | **14,207** (~750 per frame) |

**Animation census** (`document.getAnimations()`):

| Animation | Target | Count |
|---|---|---|
| `pulse-opacity-dim` | `<rect>` inside `spinner` | 1,344 |
| `pulse-opacity` | `<rect>` inside `spinner` | 672 |
| `pulse-opacity` | `svg.animate-pulse` (hourglass icons) | 58 |
| `session-progress-indicator-v2-dot-*` | titlebar tabs (2 × 25) | 50 |
| **Total** | | **2,128** (402 in viewport) |

**Host of the spinners.** All spinners sit in
`#chat-sidebar-pane nav#chats-group-*` rows. There were 84 working sessions ×
**2 rows each** (`chats-group-0` = Recent, plus the owning project group) ×
**12 animated rects** = 2,016. The sidebar had 258 mounted rows and no
virtualization; only ~29–31 spinners were on screen.

### Causal proof (live A/B, restored)

| Condition | fps | Worst frame | Long-task % |
|---|---|---|---|
| A. Baseline | 4.4 | 282 ms | 93% |
| B. `[data-component="spinner"] rect { animation-play-state: paused }` | 4.5 | 310 ms | 93% |
| C. `[data-component="spinner"] rect { animation: none }` | **34.4** | 78 ms | **6%** |
| D. Style removed | 3.9 | 827 ms | 85% |

### Mechanism

Condition B vs C matters. Pausing does not help; removing the animations does.
An element with an **active** opacity animation (paused or not) gets its own
effect paint-property node and becomes a compositing candidate. With about 2,000
of them, each `PaintArtifactCompositor::Update` walks thousands of paint chunks
and pending layers. Its overlap and merge decisions scale super-linearly, which
produced ~750 composited layers per frame.

Layerization re-runs on **any** repaint anywhere in the frame: streaming text,
the per-second timers in [F2](#f2--sidebar-per-second-writes-on-off-screen-rows),
[F3](#f3--limits-panel-remounts-every-second-and-scans-message-history)'s
remounts, or hover. That is why the lag was **app-wide** rather than confined to
the sidebar.

SVG child elements cannot run compositor-driven animations, so each of those
rects also needs main-thread style updates every frame.

### Code

- `packages/ui/src/components/spinner.tsx:4-51` has 16 rects, 12 of them with
  their own `animation` (`pulse-opacity` / `pulse-opacity-dim`) and random
  per-rect delay and duration. It is fine for one or two instances. It is
  pathological when repeated per row.
- `packages/app/src/pages/session/v2/chat-sidebar-pane.tsx:2152-2181` renders a
  `Spinner` per working row.
- `chat-sidebar-pane.tsx:434-463` (`baseGroups`) and `:490-523` (`groups`):
  Recent is the union of every project slice (`recentPool`) and is rendered
  **in addition to** each project group. Project groups are not sliced by any
  limit (`sessions: rows`).
- `chat-sidebar-pane.tsx:804-925` shares one row runtime (`leaseRowRuntime`)
  between the Recent and project copies. The duplication therefore costs **DOM
  and animations, not reactive work**, which is exactly the expensive dimension.
- `git log`: `spinner.tsx` last changed in `c3b4b25966` (2026-08-28, "update
  provider icon, spinner, and tooltip styles"). The sidebar pinning, Recent, and
  grouping work landed 2026-08-23 → 2026-09-08. Nothing here is new. It became
  visible when working-session counts crossed ~50.

### Scaling

Cost ≈ f(working sessions × 2 × 12 animated elements), independent of which
rows are visible. At 12 working sessions (288 animations) it is tolerable. At 84
it is not. After the relaunch the new renderer reached 37 spinners and 436
animations within 7 minutes as sessions resumed.

## F2 — Sidebar per-second writes on off-screen rows

A 10 s whole-document `MutationObserver` census, with no user interaction, found:

| Region | Mutation | Count / 10 s |
|---|---|---|
| `#chat-sidebar-pane` | text `"#m #s"` (elapsed timer) | 962 |
| `#chat-sidebar-pane` | attribute `data-chat-tooltip-text` | 1,364 |
| `#chat-sidebar-pane` | text `"# tok/s"` | 8 |
| `<main>` / `#context-panel` | nodes added and removed | 3,900 / 3,900 (see [F3](#f3--limits-panel-remounts-every-second-and-scans-message-history)) |

- `chat-sidebar-pane.tsx:867-870`: `live()` recomputes from the shared `now()`
  clock for every working row.
- `chat-sidebar-pane.tsx:2319-2323`: the elapsed value is also written into a
  `data-chat-tooltip-text` attribute every tick, whether or not a tooltip is
  open. The pane already has a shared tooltip controller with a
  `MutationObserver` for dynamic text (`:980-998`), so the attribute could be
  produced lazily on open.

The shared clock is acceptable under `packages/app/AGENTS.md`, since it is one
timer. But it guarantees at least one repaint, and therefore one ~200 ms
Layerize from F1, **every second**, including for off-screen rows.

Row identity was **not** a problem. A 10 s probe measured **0 row remounts** in
the sidebar. The `withDirectory` WeakMap cache (`:245-253`) and `stableGroups`
reuse (`:533-551`) work as intended.

## F3 — Limits panel remounted every second through clock-coupled provider reconstruction

**Evidence.** `#context-panel` added and removed ~390 nodes per ~936 ms. The
sample was the whole `[data-limits-provider="opencode-zen"]` card.

**Historical chain at incident capture:**

1. `LimitsPanelContent` subscribed to the global 1 Hz display clock.
2. A client-side provider allowance projection also read that clock while scanning
   synced `message` history. So **every second** it rebuilt an allowance report
   from conversation history — exactly the consumer-first reconstruction
   `packages/app/AGENTS.md` prohibits.
3. `entries()` consumed that report and built **fresh `Entry` wrapper objects
   for every provider** on each tick.
4. `<For each={visibleEntries()}>` keyed those wrappers by reference, so provider
   cards were torn down and rebuilt every second.

The offending provider-specific reconstruction has since been removed. The
architectural finding remains: display-clock updates must not trigger history
scans or rebuild provider-entry identity.

**Effects.** A guaranteed full repaint every second (which feeds F1), DOM/GC churn
(`Memory.getDOMCounters` reported +21k nodes per 10 s, while only ~13k elements
were attached), and loss of any transient UI state inside the cards. The code
comments at `:1428-1436` and `:1642-1643` show the team already hit
reference-identity bugs in this list. This is another instance of the same bug.

## F4 — Sidecar event-loop hang

### Evidence

| Signal | Observation |
|---|---|
| HTTP `GET /global/session/:id` | 3/3 timed out at 30 s (01:12), and again at 01:15 |
| Renderer `[perf]` | `0 events/s` from ~01:07 onward |
| `server.log` | Last line at **01:07:05.505** |
| `runtime_owner.heartbeat_at` for PID 86204 | **~01:07:06**, then never again |
| Thread CPU | One thread (TID 95944, the process's original JS thread, started 17:33:30) consumed **7.2 s of CPU per 5 s** |
| Private bytes | **2,203 MB, flat to the MB** over 15 s |
| Handles | Constant (702) |
| File I/O | ~0 (10 read ops in 5 s) |
| Duration | At least 01:07:05 → 01:21 (killed); never recovered |

That signature (a single core, no allocation growth, no I/O, no progress) is a
**synchronous pure-CPU loop on the event loop**: catastrophic regex
backtracking, a non-terminating loop, or an effectively unbounded synchronous
computation.

### What ran last

The final log lines show normal concurrent work across ~30 streaming sessions.
The very last line is a bash-tool permission evaluation:

```
01:07:05.505 evaluated permission=bash pattern="node --test test/demo-server-security.test.mjs test/capability-authority.test.mjs" action=allow
```

No `node --test` child was ever spawned. In
`packages/opencode/src/tool/shell.ts:1088-1113` the steps after `ask()` are
`shellEnv()` (plugin hooks), `Shell.validateInvocationEnvironment()`, then
`run()` → spawn. The hang may therefore be in that path, but with ~30
concurrent fibers the last log line may equally just be the last thing to run
before an unrelated fiber's synchronous loop took over. **The exact frame was
not captured.**

### Why the frame could not be captured

- The sidecar runs as an Electron **utility process**. `process._debugProcess`
  worked for the Electron main process but **does not activate an inspector in
  the utility process**. It was retried after port 9229 was free; nothing
  listened.
- No native debugger (`cdb`, `procdump`, WinDbg) was installed, so a stack could
  not be taken non-invasively.

### Could the diagnostic probes have caused it?

They cannot be fully excluded, but the evidence argues against it:

- The probe-created instances initialized in under 1 s at 01:02:33–55, and the
  server kept logging normally for 4.5 more minutes.
- A home-directory watcher or snapshot walk would be **I/O-heavy**; the hang has
  **zero I/O**.
- The last pre-hang activity is unrelated session execution.

### Related server-side errors during the fan-out

- 2× `SqlError: Failed to execute statement` at 00:48:16 and 00:48:22, during
  `process` of two "Build ES*" sessions. The underlying SQLite error was **not
  logged** ([F9](#f9--observability-gaps)).
- 32× `AbortError` at 00:53. These are consistent with the orchestrator
  cancelling the first ES3 wave before respawning it, not a server fault.

## F5 — Hung sidecar orphaned by relaunch

At 01:15:54 the dev app was relaunched from WebStorm
(`webstorm64 → bun → bun → concurrently → dev-electron.ts → electron-vite →
electron`). The old Electron main process exited, but the **hung sidecar PID
86204 kept running**:

- Parent gone, still at ~111% CPU with 2 GB private memory.
- Still listening on 6 ports (`:39321`, `:29004`, `:19731`, `:7510`, `:7509`,
  `:7493`).
- 21 descendant processes still alive: agent-spawned webseal dev servers and
  witness servers, `npm run dev` / `vite --port 5174`, and PowerShell
  wait-loops, including one polling for a file every 10 s since 22:19.

A healthy utility process normally exits with its parent. A process whose event
loop is blocked cannot observe the parent pipe closing, so nothing reaps it. The
dev runner does not check for a surviving sidecar from the previous run, even
though `packages/mobile/.opencode-dev-handshake.json` records its URL and
instance ID.

## F6 — Stale execution leases

Read-only query of `openfork-main.db` after the relaunch:

| Fact | Value |
|---|---|
| `runtime_owner` rows | **195** from 50 distinct PIDs; only **1** heartbeating within 60 s |
| Orphan (PID 86204) owner `…ee5205835240` | owns **87** sessions; heartbeat ~01:07:06 |
| Orphan owner `…e0e38d6174b3` | owns 1 session, `ses_f1ac4f5f…` |
| Sessions with non-null `owner_id` | 175 |
| …whose owner heartbeat is >5 min stale | **157** (includes owners from earlier runs) |
| `recovery_owner_id` set for orphan-owned sessions | 0 |

At startup, the new sidecar logged
`pending Goal continuation recovery failed … ses_f1ac4f5f… SessionBusyError`.
That session's `session_execution_owner.owner_id` pointed at the (then still
alive, but hung) orphan's runtime owner. Owner rows are never garbage-collected,
and stale leases are not reclaimed at startup.

Not yet verified: whether stale leases are reclaimed lazily when the user next
prompts one of those sessions. See [Open questions](#open-questions).

## F7 — Unscoped request creates a cwd instance; status is per-instance

**Reproduced live.** A diagnostic `GET /session/status` with no `directory` and
no `x-opencode-directory` produced this at 01:02:33:

```
"creating instance" directory="C:\\Users\\slooshied"
bootstrapping … config 335ms, plugin 296ms, toolReload, lsp, shareNext, format, vcs, snapshot, project
```

This is `defaultDirectory()` in
`packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:86-92`,
which returns `process.cwd()` when both are absent. It is a direct violation of
the root `AGENTS.md` Tier-0 and instance-routing invariant ("a server request
with no explicit directory … must **not** silently invent one with
`process.cwd()`"). The sidecar's cwd is the user's home directory, so a full
execution graph was initialized over `~`. Scoped probes for three other
directories created three more instances.

**Status is not authoritative per session.** `SessionStatus` is `InstanceState`
(`packages/opencode/src/session/status.ts:28-52`), and `GET /session/status`
returns only the addressed instance's map (`handlers/session.ts:86-88`).
Probing the **pre-existing** instance for `C:\Users\slooshied\WebstormProjects`
returned 0 busy, and the Adobe instance returned 1, while ~30 sessions in those
directories were demonstrably stepping in the log. Delegated sessions evidently
record status in some instance other than the one keyed by their own
`session.directory`.

Consequence: there is no bootstrap-free, global way to ask "which sessions are
working". Clients depend entirely on the event stream, so a missed idle event
cannot be repaired by a cheap read.

## F8 — Fan-out shape amplifies every per-session cost

- **All delegated sessions are top-level** (`parentID=undefined`,
  `metadata.workerDelegation.producer=oxp`). Each becomes a root sidebar row,
  doubled by Recent, instead of folding under the delegating principal.
  Sidebar rows reached 258.
- **Waves:** 33 on `opencode-go/space-bunny-free`, aborted at 00:53, then 33 on
  `openai/gpt-6-luna`, then ~17 "replacement" sessions, plus ~60 WebSeal auditor
  roles. Each wave adds rows. Aborted and superseded sessions remain.
- **Working without progress.** Of 84 spinning sessions, only 30 ran a loop step
  in a 4-minute window. Examples: `replacement 12` had an assistant message open
  since 00:54:44 with **0 parts** (no first token in 10+ minutes), and
  `ES3 research 01` had an unanswered user message since 00:53:08. They are
  legitimately in flight from the client's view, but show the same full-cost
  spinner as a streaming session. There is no "waiting for provider / queued"
  presentation.
- `concurrent checkpointed turns share one worktree; attribution may be
  imprecise` was logged repeatedly: ~55 sessions shared the Adobe `Scripts`
  worktree.

## F9 — Observability gaps

Each of these slowed this investigation:

1. **`[session.error] [object Object]`** in `renderer.log`: the error object is
   string-concatenated, so the provider and error kind are lost.
2. **`SqlError: Failed to execute statement`** without the SQLite cause
   (`SQLITE_BUSY`? constraint?).
3. **`[perf-longtask] 272ms · `** has empty attribution for every entry
   (`perf.ts:66-69`). The Long Animation Frames API (`long-animation-frame`)
   would have attributed style, layout, and script inside each frame directly.
4. **Server log retention**: one 5 MB `server.old.log`. Under the fan-out that
   was ~80 minutes of history, and the 17:33–23:41 window was already gone.
5. **The utility-process sidecar has no attachable inspector** in dev, and no
   hang watchdog. A blocked event loop is detectable only by external probing.
6. **Instance creation lacks attribution.** The logs cannot say which request or
   route created an instance, or that a cwd fallback was used. The package
   `AGENTS.md` asks for this.
7. `--remote-debugging-port=9222` is configured
   (`packages/desktop/src/main/index.ts:229`) but was not bound in this run.

## Other observations

- `openfork-main.db` is **9.6 GB** (1.17M pages × 8 KiB, freelist 0, WAL,
  `auto_vacuum=2`) for 2,627 sessions / 121k messages / 527k parts.
  `ChunkDB semantic prune` / `sealer` passes run continuously. Not implicated
  here, but worth a separate size and IO audit.
- `failed to add snapshot files … 'esenv/' does not have a commit checked out` is
  logged on nearly every step in the Adobe `Scripts` project. Nested
  `git init`-ed directories break snapshot capture, costing a failed `git add`
  per step per session.
- `Failed to load plugin opencode-lmstudio@latest: Stripping types is currently
  unsupported for files under node_modules` is repeated on every instance
  bootstrap.
- `[command] duplicate command id "settings.open" / "common.goBack" /
  "common.goForward"` and dnd-kit `Cannot remove nonexistent droppable` warnings
  appear on a layout remount (00:57:47), for ~20 project droppables.
- Renderer heap is 454 MB JS + 371 MB Blink (embedder). `jsEventListeners`
  ~21k. After relaunch: 134 MB JS, 2.1k listeners.
- Agent-spawned long-lived helpers accumulate (for example a PowerShell
  `while (-not (Test-Path …)) { Start-Sleep 10 }` alive for 3 hours) and are
  owned by the sidecar process tree.

## Ruled out

| Hypothesis | Evidence against |
|---|---|
| SSE event volume / reducer cost | ~100 events/s; reducer ≤ 17 ms/s; JS ≈ 8% of main thread |
| Sidebar row remount churn | 0 row adds/removes in a 10 s probe; row runtime is shared |
| Layout thrash | Layout 57 ms / 5 s; ~20k layout objects |
| GC pressure as primary | V8 GC ≈ 34 ms / 5 s |
| Stale client "working" state as primary | Server logs show the spinning sessions genuinely in flight (stepping or awaiting the provider) |
| Sidecar hang caused by filesystem walk | Zero I/O and flat memory during the hang |

## Recommendations

Ordered by impact over effort. Each item names the negative invariant that should
guard it, per the root `AGENTS.md` performance closure standard.

### P0 — Renderer

1. **Replace per-rect spinner animation in dense surfaces.** For sidebar and tab
   rows, use a static "working" glyph or **one** animation on a single
   HTML-level element (for example `opacity` or `transform` on the root, which
   the compositor can run). Keep the 16-rect `Spinner` for single-instance
   surfaces. `animation-play-state: paused` is **not** a fix (A/B row B).
   - *Invariant:* `document.getAnimations().length` is bounded by a constant, or
     by the number of on-screen rows, not by working sessions × 24. Assert this
     in an e2e with 100 synthetic working sessions.
2. **Render each working session's animated indicator at most once.** Either
   de-duplicate Recent vs project group (for example, Recent excludes rows
   visible in an expanded project group, or duplicates get a static
   indicator), or bound project groups the way Recent is bounded.
3. **Stop per-second writes for off-screen rows.** Gate `live()`-driven text on
   visibility (one shared IntersectionObserver or `content-visibility`), and
   compute the elapsed tooltip text only while the shared tooltip is open.
   - *Invariant:* sidebar `characterData` + `attributes` mutations per second
     ≤ visible working rows.
4. **Limits panel:** keep `entries()` independent of the display clock (key
   wrappers by `key` and reuse them, or use a keyed map). Any future allowance
   or rollover computation must come from a server/usage projection or a
   cadence-specific signal, never by scanning `message` on each `now()` tick.
   - *Invariant:* zero `childList` mutations under `#context-panel` over 5 s
     idle; zero message-map scans per clock tick.
5. Re-run the benchmark at 1 / 3 / 6 / 50 / 100 working sessions, measuring
   Layerize ms/frame and fps (the trace method in the appendix).

### P0 — Sidecar

6. **Hang detection and capture.** In dev, start the utility-process sidecar
   with an inspector on an ephemeral port (published in the handshake file) so
   a hung loop can be paused and its stack read. Add a main-process watchdog on
   the sidecar heartbeat that, after N seconds, logs "event loop blocked" and
   surfaces it in the UI.
7. **Reap stale sidecars.** `dev-electron.ts` (and production startup) should
   terminate a previous sidecar identified by the handshake or instance ID
   before spawning a new one, and the sidecar tree should be owned by a Windows
   Job Object with kill-on-close.
8. **Lease recovery.** At startup, reclaim `session_execution_owner` leases
   whose `runtime_owner` heartbeat is stale **and** whose PID is not alive.
   Garbage-collect dead `runtime_owner` rows.
   - *Invariant:* after killing a sidecar mid-run, a restarted sidecar can
     resume or recover every orphan-owned session with no `SessionBusyError`.

### P1 — Ownership / architecture

9. **Remove the `process.cwd()` fallback** in `workspace-routing.ts:86-92` for
   Tier 2/3 routes (fail explicitly). Make "which sessions are working" a Tier 0
   global projection (the session-telemetry projection already exists) rather
   than a per-instance map.
   - *Invariant:* unscoped `GET /session/status` creates **zero** instances.
10. **Fan-out presentation.** Delegated OXP workers should be grouped under
    their principal (a parent or session group) instead of each being a root
    row. Distinguish "queued / awaiting provider" from "streaming". Consider
    per-provider admission control for large waves.

### P2 — Observability

11. Log structured `session.error` payloads, including the error name and
    provider, instead of `[object Object]`.
12. Include the SQLite cause and statement class in `SqlError` logs.
13. Switch `perf.ts` from `longtask` to `long-animation-frame`, which includes
    render-phase and script attribution.
14. Keep more than one rotated server log (for example 5 × 5 MB) in dev.
15. Attribute every instance creation (route, caller, explicit vs fallback
    location).

## Open questions

- **What was the sidecar's hung frame?** Next occurrence: attach via recommendation 6,
  or install Sysinternals `procdump` and take `procdump -ma <pid>` before
  killing.
- Are orphan-owned sessions recovered lazily on the next prompt, or do they stay
  `SessionBusyError` until manual intervention?
- In which instance do OXP-delegated sessions record `SessionStatus`, and why
  does it differ from their `session.directory`?
- What caused the two `SqlError`s at 00:48, and could they be `SQLITE_BUSY`
  under ~60 concurrent writers?
- Would `content-visibility: auto` on collapsed or off-screen sidebar sections
  remove their animations from layerization? Measure before relying on it.

## Appendix — measurement toolkit

These were all used live without restarting. Scripts are in
`%TEMP%\openfork-perf\`.

```powershell
# 1. Find the Electron main PID (parent of --type=renderer) and open its Node inspector
node -e "process._debugProcess(<mainPid>)"          # -> 127.0.0.1:9229

# 2. Evaluate in the main process (main-eval.mjs): Runtime.evaluate with
#    includeCommandLineAPI: true exposes require("electron").
#    - webContents.fromId(1).debugger.attach("1.3") -> Profiler.*, Memory.getDOMCounters,
#      Performance.getMetrics, then detach()
#    - contentTracing.startRecording({ included_categories: ["devtools.timeline",
#      "disabled-by-default-devtools.timeline", "blink", "cc", "v8", ...] }) / stopRecording(path)
#    - webContents.fromId(1).executeJavaScript(...) for DOM / animation / MutationObserver probes
node main-eval.mjs profile.js      # 10 s CPU profile  -> analyze.mjs
node main-eval.mjs trace.js        # 5 s trace         -> trace-analyze.mjs <file> <rendererPid>
node main-eval.mjs anims.js        # animation census
node main-eval.mjs ab.js           # reversible spinner A/B (fps + long-task %)
node main-eval.mjs mutations.js    # 10 s whole-document mutation census

# 3. Onset detection from logs: bucket "[perf-longtask] <ms>" per minute in renderer.log
```

Cautions:

- Never call `require("inspector").close()` from the attached session. It blocks
  until connections close and would freeze the main process.
- `process._debugProcess` does **not** work on the utility-process sidecar.
- Unscoped or unknown-directory sidecar HTTP probes **create instances** (F7).
  Use `/global/session/:id` and session-scoped routes for diagnostics.
