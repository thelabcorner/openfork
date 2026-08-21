# Handoff — startup error sounds / black screen + session summary

Written in a hurry, token budget about to run out. Read this before continuing.

## Immediate context: what the user just asked

"during startup, it makes a bunch of error sounds but it never shows errors. furthermore,
during startup it will just show a black screen with tabs and its confusing. think
critically and analyze the startup flow."

## What's been established about the sound/black-screen issue (NOT yet confirmed root cause)

- Sound effects live in `packages/app/src/utils/sound.ts` (`playSound`/`playSoundById`).
  There's a dedicated `settings.sounds.errors()` sound + `settings.sounds.errorsEnabled()`
  toggle, played from `packages/app/src/context/notification.tsx:377` inside
  `handleSessionError`, which fires on every `session.error` SSE event.
- `handleSessionError` (notification.tsx:366-397) plays the sound **unconditionally** (if
  the setting is on) but only shows a native OS notification via `platform.notify()` if
  `settings.notifications.errors()` is on AND (critically) `platform.notify` itself
  (packages/desktop/src/renderer/index.tsx `notify:`) **skips showing anything if the
  window currently has focus** (`if (focused) return`). On startup the window is almost
  always focused → sound plays, native toast never shows. This is a real, confirmed gap
  in the code, but does NOT explain where the underlying `session.error` events are
  coming from at startup with nothing visibly wrong.
- **Checked and RULED OUT:** the backend SSE endpoint
  (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`) does NOT
  replay history to new subscribers — it's a pure live `Queue.unbounded` subscription
  starting from `server.connected`. So the error sounds are not from historical event
  replay over SSE.
- **Leading hypothesis (NOT YET CONFIRMED):** earlier in this same session I had to
  recover from SQLite corruption (see below) by pointing `OPENCODE_DB` at a **brand new,
  empty database file** (`opencode-openfork-recovered.db`). The app's window-restore
  state (`opencode.workspace.*.dat` / `opencode.window.*.dat` under
  `%APPDATA%/ai.opencode.desktop.dev/`) still remembers session IDs from the OLD
  (corrupted, now-abandoned) database. Every restored tab trying to resolve its
  remembered session ID against the fresh empty DB would legitimately fail →
  genuinely-new `session.error` events fire once per stale tab at startup → "a bunch of
  error sounds", one per tab. This would be a **one-time, expected side effect of the DB
  recovery**, not a persistent bug — but it needs to actually be confirmed, not assumed.
- **Black screen with tabs:** hypothesis is that this is `SessionErrorFallback` /
  `isCurrentSessionNotFoundError` in `packages/app/src/pages/session.tsx` rendering for
  each stale tab, and that fallback UI may look like a mostly-blank dark panel (poor
  visual contrast/messaging) rather than a clear "session not found" message — making it
  read as "black screen" even though it's technically the intended error state. This is
  UNCONFIRMED — have not yet actually visually inspected a tab in the error state.

## Where I was when interrupted

I attached to the **currently-running** dev app via CDP (`http://127.0.0.1:9222`, page
titled "OpenCode") to check its console log replay buffer for startup-time errors. The
app had already settled into a working state by the time I looked (screenshot showed a
fully populated, healthy session — NOT black, no visible errors) — so whatever happened
during boot was transient and I could not catch it retroactively from the current
instance. I was mid-way through filtering ~234 buffered console lines for
error/fail/exception patterns when interrupted; **that grep is what needs to be looked at
first** (rerun a similar CDP console-tail, but ideally attach *before* or immediately
*during* a fresh app launch, not after it's already settled).

## Recommended next steps (in order)

1. **Reproduce and observe live.** Ask the user to restart the app while you have a CDP
   console/network watcher already attached and running (see script patterns below —
   several small reusable CDP scripts were written this session in
   `packages/app/scripts/`: `cdp-console.mjs`, `cdp-watch-health.mjs`,
   `cdp-profile.mjs`, `cdp-combined.mjs`, `cdp-nav-profile.mjs`, `cdp-backend-watch.mjs`).
   Since the app takes a moment to spawn its DevTools port, you may need to poll
   `http://127.0.0.1:9222/json/list` in a loop right after telling the user to restart,
   then immediately start tailing console + Network domains to catch the actual
   `session.error` events and the exact sequence of what renders black.
2. **Confirm or refute the stale-tab-after-DB-reset hypothesis directly**: check how many
   `session.error` events fire in the first few seconds of startup, and whether their
   count/timing matches the number of restored tabs. Check `isCurrentSessionNotFoundError`
   and `SessionErrorFallback` in `packages/app/src/pages/session.tsx` to see exactly what
   renders for a not-found session, and screenshot it directly to see if it really is
   near-black.
3. **If confirmed**, the real fix has two independent parts:
   - a. **Notification/sound gap (real bug, worth fixing regardless):** `notify()` in
     `packages/desktop/src/renderer/index.tsx` silently no-ops when the window is
     focused, but the sound in `notification.tsx` plays unconditionally — these two
     should be consistent, or at minimum the in-app notification list (`append(...)`,
     which does always run) should be made obviously visible/discoverable so a burst of
     startup errors isn't purely audio with no visible trace. Consider suppressing the
     sound too when it's clear these are startup-time bootstrap failures rather than a
     surprising live event, or debounce/coalesce multiple errors in the same burst into
     one sound instead of N.
   - b. **Stale tab restoration:** if a session genuinely doesn't exist anymore (fresh
     DB), the UI should make that obvious and pleasant (clear empty/not-found state,
     maybe auto-prompt to close all stale tabs at once) rather than silently erroring
     per tab with a sound and a confusing near-black panel.
4. If the hypothesis is wrong, go back to first principles: use the same CDP
   console/network tailing approach live during an actual restart to see exactly what
   errors are firing and where they originate (grep the text for stack traces / event
   payloads — `session.error` events carry an `error` field that should name the actual
   failure).

## Everything else from this session (context, already done, do not redo)

This was a very long session. Summary of concrete, shipped work, most recent first:

### Database corruption (resolved, but caused the above side-effect)
- Found `opencode-openfork.db` (7.7GB) and `opencode.db` (2.3GB) both corrupted
  (`database disk image is malformed`), likely from a hard-kill mid-write during earlier
  restart cycles in this session. Files still exist on disk at
  `C:\Users\slooshied\.local\share\opencode\` — attempts to rename them aside failed with
  "Device or resource busy" (a lock from an unidentified process; not currently urgent
  since the app now uses a different file, but the ~10GB of corrupted+locked data is
  still sitting there unresolved and worth cleaning up eventually).
- Fix applied: `.run/desktop dev.run.xml` now sets `OPENCODE_DB` to
  `C:\Users\slooshied\.local\share\opencode\opencode-openfork-recovered.db` (a fresh
  file). This is a durable env-var change in the run config, not temporary.

### ChunkDB background sealer — enabled (real fix for the giant-DB-size root cause)
- Discovered the DB likely grew unbounded because the entire "chunkdb" background
  compaction system already existed in code
  (`packages/core/src/database/chunk-sealer.ts`, `chunkdb.ts`,
  `packages/core/src/database/json-codec.ts`) but was **never turned on**
  (`Flag.OPENCODE_SEAL_ENABLED` defaults off).
- Verified epoch-1 (compression-only, brotli-frames cold rows ≥4KB after 48h idle) is
  safe: read path (`json-codec.ts` `parseDriverValue`/`fromDriver`) correctly detects and
  decompresses frames transparently; existing test suite
  `packages/core/test/database/chunkdb.test.ts` (3 tests) passes.
- **Did NOT enable epoch-2 dedup** (`OPENCODE_SEAL_DEDUP`) — confirmed via code reading
  that the read path has **no implemented rehydration** for its `{"$cdbRef": "..."}`
  reference markers (the comment in `chunkdb.ts` explicitly says this is the job of a
  "readpath-v2" module that does not exist anywhere in the repo). Turning it on would
  make deduplicated rows permanently unreadable. There IS a `PRAGMA user_version` epoch
  gate that fails closed if this is ever touched, so it's safe as long as the flag stays
  off — just never set `OPENCODE_SEAL_DEDUP`.
- Change applied: `.run/desktop dev.run.xml` now also sets `OPENCODE_SEAL_ENABLED=true`.
- The elaborate design docs under `docs/chunkdb/architecture/*.md`
  (compact-pipeline.md, sealing.md, readpath-v2-*.md) describe a MUCH more ambitious
  multi-epoch system (worker-thread pools, segment-based storage, value-dedup tables,
  4-layer backpressure, etc.) that is explicitly "DESIGN PROPOSAL — no implementation
  code" and references several other docs (storage.md, readpath.md, migration.md,
  PLAN.md, contract.md, schema-v2/ops-v2 handoffs) that **do not exist in this repo** —
  treat those docs as aspirational/exploratory, not a spec to implement wholesale. What
  actually exists and is now enabled (epoch-1 only) is a much simpler, tested subset.

### Backend sidecar crash (caused by me, reverted)
- While diagnosing the DB, I temporarily added `execArgv: ["--inspect=127.0.0.1:9229"]`
  to the sidecar spawn in `packages/desktop/src/main/server.ts`, and a monkeypatch of
  `fs.watch` in `packages/desktop/src/main/sidecar.ts` (via `import * as fs from
  "node:fs"` then reassigning `fs.watch` — this throws in Node's ESM namespace-object
  semantics and crashed the sidecar before it could even signal ready). **Both fully
  reverted** — confirmed via typecheck clean. Do not reintroduce that monkeypatch pattern;
  if you need to intercept `fs.watch` again, patch it differently (e.g. wrap at a specific
  call site, not the shared ESM namespace object) or use `--require`/loader-based
  instrumentation instead.

### Backend request-latency degradation (root cause still NOT fully found)
- Live-observed (via CDP attached to the backend's Node inspector on a since-reverted
  `--inspect` port) a real, severe, progressive slowdown of the whole backend process:
  health-check latency went 34ms → 11s → 23s → full 30s timeouts over about 4 minutes of
  an otherwise-idle session. This is the real mechanism behind the "red status dot"
  complaint from earlier in the session — proven NOT to be caused by connection/listener
  count (only 7 sockets open at the time) or by `server.requestTimeout` (a fix I applied
  earlier — see below — but the smooth ramp pattern doesn't match a sudden 5-minute kill,
  so that fix, while still valid/harmless, is probably not the (only) explanation).
- Found the backend process holding **37,729 live `fs.FSWatcher` handles** (via
  `process._getActiveHandles()`), matching `_ignoreMatcher` (an Electron-patched
  `fs.watch` feature). Confirmed this count is **flat over time** (not growing across a
  40+ minute session), so it's not itself a leak, but it's an enormous, suspicious
  standing count that was never fully traced to its source before I had to revert the
  diagnostic instrumentation due to the sidecar crash it caused. **This is unresolved —
  worth another pass with a safer diagnostic method** (e.g. patch at the specific
  `@parcel/watcher` or chokidar call site instead of the shared `fs` module namespace, or
  use `--require` a CJS preload script instead of ESM reassignment).
- The connection between "37k FSWatcher handles" and "progressive request-latency
  degradation" was never proven — they're two suspicious findings from the same
  investigation, not yet shown to be causally linked. Do not assume they're the same bug.

### Confirmed, shipped performance fixes (all verified via typecheck + tests, all still in place)
- `packages/opencode/src/server/server.ts`: Node `http.Server` `keepAliveTimeout` raised
  from the 5s default to 60s (+ matching `headersTimeout`), and OS-level TCP keepalive
  enabled per-socket (15s delay) — reduces connection churn and helps the server detect
  genuinely-dead SSE sockets. Also sets `server.requestTimeout = 0` (this server is
  loopback-only/trusted-client, so the slow-loris protection this exists for doesn't
  apply, and Node's requestTimeout is a known footgun for long-lived SSE responses).
- `packages/app/src/pages/session/timeline/message-timeline.tsx`: fixed a real,
  CPU-profiler-confirmed layout-thrashing bug — `virtualizer.resizeItem`'s wrapper was
  reading `root.clientHeight` **live, synchronously, on every single row resize call**,
  forcing a synchronous layout recalc on nearly every row while the virtualizer was
  simultaneously writing row-position styles for other rows. Fixed by caching container
  height from the existing `ResizeObserver` instead. This was found via a live CPU
  profile captured through CDP on the running dev renderer, and was the dominant named
  hotspot in every real >100ms `[perf-longtask]` spike observed. High confidence this is
  a real, meaningful fix for "switching tabs is laggy" / general rendering jank,
  especially on large sessions.
- `packages/app/src/utils/server-health.ts`: the health-poll loop that drives the
  status-dot could get stuck showing a stale (possibly red) status for a long time
  because a single slow `checkServerHealth` attempt could take up to ~30s+retries before
  the loop tried again, and there was no bound on how long a "trust the SSE stream is
  alive, skip the real check" state could persist without ever re-verifying. Fixed:
  added a poll-path-specific fast-fail timeout (`POLL_CHECK_OPTS`: 8s timeout, 1 retry),
  shortened `VERSION_REFRESH_MS` (the max time the poll will trust stream-liveness
  without a real check) from 60s to 20s, and added a `REFRESH_WATCHDOG_MS` constant as a
  documented safety margin. Empirically demonstrated live: the dot was stuck red while
  the backend was actually responding in 3-5ms the whole time; forcing a fresh check via
  HMR-reloading `server-liveness.ts` immediately turned it green. This is a UI robustness
  fix — it reduces how long a stuck/desynced state can persist, but does not itself
  explain WHY the desync happens in the first place (still somewhat open, see backend
  degradation section above — they may be related).
- Earlier in the session (still in place, from before this summary's detail level):
  `packages/app/src/utils/refcount.ts` (cross-tab event-delivery bug fix, with a
  regression test), `packages/app/src/context/file.tsx` (per-project file-content cache
  eviction fix), `packages/app/src/context/server-session.ts` (V1/V2 suspended-tab event
  gating parity fix), `packages/desktop/src/main/index.ts` (window now shows immediately
  instead of blocking on full backend health during startup — this was the FIRST startup
  latency fix of the session, unrelated to today's black-screen complaint, which is a
  DIFFERENT, newer issue).

### Diagnostic tooling added (kept, reusable, not temporary)
- `packages/app/scripts/cdp-console.mjs` — tail all renderer console output live via CDP
  without restarting the app.
- `packages/app/scripts/cdp-profile.mjs`, `cdp-combined.mjs`, `cdp-nav-profile.mjs` —
  record/correlate CPU profiles with console/longtask events or with a scripted UI
  interaction (finds real tab elements via DOM query + `Input.dispatchMouseEvent`).
- `packages/app/scripts/cdp-watch-health.mjs` — watch health-check network requests +
  console for a given duration.
- `packages/app/scripts/cdp-backend-watch.mjs` — attach to the **backend** (not
  renderer) Node inspector for CPU profiling + memory/handle-count polling (requires
  `--inspect` to be temporarily re-added to `packages/desktop/src/main/server.ts` if you
  need this again — it's currently reverted/removed for safety).
All of these connect to `http://127.0.0.1:9222/json/list` (renderer) or `:9229` (backend,
if `--inspect` is re-added) — the app must already be running; these attach live, no
restart needed, per the standing "never restart the app/server process" rule.

## Standing rules from this session, still in effect
- Never restart the app/server process yourself — ask the user, they restart it.
- Prefer attaching live via CDP over restarting to diagnose things.
- Don't touch `OPENCODE_SEAL_DEDUP` — unsafe, unimplemented read path.
- Any change to `packages/desktop/src/main/sidecar.ts` involving monkeypatching Node
  builtins needs care around ESM namespace-object mutability (see crash above).
