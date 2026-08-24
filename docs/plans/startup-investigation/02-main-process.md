# 02 — Electron main-process boot cost (`../../../packages/desktop/src/main`)

Lane owner: `main-proc` · Swarm `startup-autopsy` · 2026-08-21
Status: COMPLETE — static audit + standalone benchmarks + instrumented in-app trial `mp1b` (clean; `mp1` discarded, see Method).

## TL;DR — ranked verdict

1. **`bun run dev` is a BUILD-PIPELINE problem, not an Electron-runtime problem.** In the clean instrumented trial mp1b (WARM, total 59.6 s to window-title): predev 4.2 s + **main-config SSR build 51.0 s** (Rollup transforming the 33–34 MB opencode server bundle fed in by `electron.vite.config.ts:41`) + preload 0.11 s = **57.3 s (96%) elapsed before Electron even spawned**. Harness w1 measured the same phase at 67.1 s of 76.3 s (88%) under heavier background load.
2. **Electron main-process runtime to window-created is only ~0.4 s** (module-eval start → `windows-created` = 323→727 ms, mp1b). The 308 KB main bundle (48 modules / 240 edges) is NOT the bottleneck. All pre-window sync work combined (migrate 1.7 ms, store-cleanup 11.5 ms, updater config 8.9 ms, IPC+drafts-sqlite 11.1 ms) ≈ 33 ms.
3. **The sidecar utility process needs ~2.0 s from fork to server-ready** (mp1b: spawn 751 ms → ready-msg 2675 ms), of which **1.33 s is parsing+evaluating the 34 MB server chunk** (`sidecar.ts:58`, measured 1328 ms in-process; standalone Node approx 1.8–2.1 s) and ~0.40 s is `Server.listen` init. This gates `serverReady` → the renderer's LoadingSplash — the user-visible "slow after window appears" component.
4. **Window-visible is NOT blocked by the backend** — `restoreMainWindows()` (`index.ts:380`) precedes the loading-task fork (`:384`); documented deliberately at `index.ts:355-362`. Caveat: in mp1b the harness's title-based `window_shown` marker fired at 59.6 s but the `ready-to-show` handler's marks never printed — see Evidence caveat; entry-chain owns that endpoint.
5. **Module-scope dead weight (real but second-order):** `electron-updater` (99 files / 552 KB) parsed every boot though dev-disabled (`constants.ts:6`); native `@lydell/node-pty-win32-x64` DLLs (305+132 KB) load via `index.ts:47 → wsl/sidecar.ts:6 → wsl/runtime.ts:4` though WSL sidecars spawn only post-server-ready.

## Method

- Static: read of all 43 entries under `src/main`, built artifacts under `out/`, `electron.vite.config.ts`, `scripts/predev.ts`; transitive-graph scanner `raw/main-proc-import-graph-scan.ts` (bun, read-only).
- Benchmarks: standalone `node -e "import('file:///…node-BsjhI-JA.js')"` ×4 (Node v22.23.2, warm FS cache) — approximates the utility process's dynamic import; labeled WARM-approx.
- In-app: env-gated marks (`STARTUP_AUTOPSY_TIMING=1`) emitting `[STARTUP-AUTOPSY]` JSON lines to stdout, captured by harness `run-trial.ps1`.
  - Trial **mp1** (WARM) — DISCARDED/contaminated: an external OpenCode instance appeared mid-run; its window triggered the harness marker at 46.4 s while my main build was still transforming (finished 52.5 s). Only its build-phase lines are usable. Log kept: `raw/harness/logs/mp1.log`.
  - Trial **mp1b** (WARM, clean, INSTRUMENTED): pre-checked zero electron PIDs immediately before launch; consistent internal ordering (electron_spawn 57.3 s < app-starting 58.6 s < marks); exit 0, tree killed by harness (`leftovers=[]`). Log: `raw/harness/logs/mp1b.log`. Marks parsed with `raw/main-proc-parse-marks.ts`.
- Cross-lane numbers cited from metrics-harness trial w1 (canonical, clean).
- Note: the swarm's coordination store vanished mid-lane; mp1b was executed solo after verifying no other electron/bun dev processes were live (slot-arbitration was impossible at that point).

## Evidence

### Built-artifact sizes (WARM, out/ @ 7:01 PM build)

| Artifact | Bytes | Loaded by |
|---|---|---|
| `out/main/chunks/node-BsjhI-JA.js` | 34,064,133 | sidecar utility process only (dynamic import) |
| `out/main/index.js` | 308,486 | Electron main |
| `out/main/sidecar.js` | 3,381 | utilityProcess.fork entry |
| `out/preload/index.js` | ~11 KB | renderer preload |
| wasm assets copied from server dist | 1.88 MB + 2.57 MB | sidecar |

### Import graph (from `src/main/index.ts`)

48 internal modules · 240 edges (incl. type-only). Heavy externals at module scope:

| Package | Edge | Weight | Dev-relevant? |
|---|---|---|---|
| electron-updater | `updater.ts:2` | 99 files / 552 KB | NO — `UPDATER_ENABLED=false` in dev (`constants.ts:6`), yet parsed at boot |
| @lydell/node-pty-win32-x64 | `wsl/runtime.ts:4` | native DLLs 305+132 KB | only for WSL servers, post-ready |
| drizzle-orm + node:sqlite | `draft-store.ts:2-5` | used synchronously pre-window | YES |
| electron-store | `store.ts:1` | deferred instantiation (comment `store.ts:11-14`) | YES |
| @zip.js/zip.js | `logging.ts:5` | exportDebugLogs only | rarely |
| @opencode-ai/ui (+ oc-2.json from UI *source*) | `windows.ts:2-4` | theme resolve at module scope | YES |

### Pre-window-show critical path (execution order, `index.ts` main())

| # | Step | Site | Sync IO? |
|---|---|---|---|
| 1 | contextMenu init | `index.ts:121` | no |
| 2 | initializeOldLayoutEligibility | `onboarding.ts:12-21` via `index.ts:153` | readdirSync + store rw |
| 3 | initLogging + log cleanup | `logging.ts:22-34,118-131` via `index.ts:154` | mkdir/readdir/statSync |
| 4 | crashReporter.start | `logging.ts:36-42` | mkdir |
| 5 | CA certs merge | `index.ts:185` | tls system read |
| 6 | single-instance lock | `index.ts:203` | OS mutex (blocks 2nd instance) |
| 7 | app.whenReady | `index.ts:260` | async |
| 8 | migrate() | `migrate.ts:69-91` via `index.ts:262` | sync store read; first-run file migration |
| 9 | cleanupStoreFiles (awaited) | `store-cleanup.ts:17-62` via `index.ts:263` | async but sequence-blocking scan |
| 10 | setupAutoUpdater | `updater.ts:13-61` via `index.ts:280` | sync store("opencode.updater") open |
| 11 | registerIpcHandlers → drafts DB | `ipc.ts:60` → `draft-store.ts:16-36` via `index.ts:289` | **sync sqlite open + full-table scan + orphan deletes** |
| 12 | updater.start() fired (void) | `index.ts:351` | network, dev-disabled no-op |
| 13 | startNetLog | `index.ts:346` | async |
| 14 | restoreMainWindows | `windows.ts:189-192` via `index.ts:380` | window-state file reads |
| 15 | ready-to-show → win.show() | `windows.ts:267-271` | needs renderer from ELECTRON_RENDERER_URL (vite) |
| 16 | sidecar fork → dynamic import → Server.listen → health OK | `index.ts:433-459`, `sidecar.ts:51-66`, `server.ts:145-164` | post-window; gates serverReady/splash |

### Standalone import benchmark of the 34 MB chunk (WARM-approx)

| Sample | ms |
|---|---|
| 1 | 1841 |
| 2 | 2083 |
| 3 | 1924 |
| 4 | 2036 |

Mean ≈ 1971 ms — parse+eval floor before `Server.listen` even begins (DB open, routers, config come after).

### In-app runtime marks — trial mp1b (CLEAN, WARM, INSTRUMENTED)

t0 = main-bundle module-eval start (autopsy-timing.ts imported first in index.ts). Electron spawned at wall 57.27 s; t0 ≈ wall 58.12 s. Source: `raw/harness/logs/mp1b.log`, pid 82540 (main) / 72168 (sidecar utility).

Main process (pid 82540):

| Mark | ms (t0-rel) | Δ phase | Wall |
|---|---|---|---|
| main-body-start | 323.2 | — module graph eval ≈ 323 ms | 58.44 s |
| whenReady-wait-start | 408.3 | +85.1 (contextMenu, paths, logging, crashReporter, CA certs, lock, env) | 58.57 s |
| whenReady-done | 481.7 | +73.4 (whenReady wait) | 58.60 s |
| migrate-done | 483.4 | +1.7 (store hit, "already done") | 58.68 s |
| store-cleanup-done | 494.9 | +11.5 (userData scan) | 58.70 s |
| updater-configured | 503.8 | +8.9 (electron-updater config + store open) | 58.89 s |
| ipc-registered | 514.9 | +11.1 (incl. drafts.sqlite open + orphan scan) | 58.91 s |
| updater-start-fired | 516.2 | +1.3 (dev-disabled no-op) | 58.92 s |
| windows-restore-start | 589.3 | +73.1 (netLog start + BrowserEngine construction) | 59.00 s |
| windows-created | 727.3 | +138.0 (1 BrowserWindow + window-state read) | 59.02 s |
| sidecar-spawn-start | 751.1 | +23.9 | 59.08 s |
| sidecar-ready-msg | 2675.0 | **+1923.9 (fork + 34 MB import + Server.listen)** | 60.80 s |
| sidecar-health-done | 2795.4 | +120.5 (health poll, 100 ms interval) | 60.92 s |
| loading-task-done | 2796.7 | +1.3 | 60.95 s |

Sidecar utility process (pid 72168, via stdout relay):

| Mark | ms (its own t0 = utility module eval) | Meaning |
|---|---|---|
| sidecar-module-eval | 0.2 | 3.6 KB sidecar.js loads instantly |
| sidecar-start-cmd | 3.3 | start command received |
| sidecar-server-imported | 1328.1 | **34 MB chunk parsed+evaluated** |
| sidecar-listening | 1726.7 | Server.listen done (+399 ms DB/routers) |

**Wall-clock budget of mp1b (59.6 s total):** predev 4.2 s → main SSR build **51.0 s** (`✓ built in 51.02s`, incl. 42.9 s transform + 4.8 s render of the 34 MB chunk) → preload 0.11 s → dev server 0.1 s → electron spawn +1.4 s → main runtime to windows-created **0.73 s** → sidecar to server-ready **+2.05 s**. Build pipeline = 57.3 s = **96%**; Electron main-process runtime work ≈ 0.7 s; sidecar (parallel, gates splash) 2.0 s.

**Caveat (window-visible endpoint):** harness `window_shown=59572ms` fired right after renderer `[vite] connected` (59.36 s), but the `ready-to-show` handler's marks (`window-ready-to-show`/`window-shown`, windows.ts:266-270, present in the built bundle) never printed before tree-kill at ~67.5 s. Two hypotheses: (a) PowerShell `MainWindowTitle` can report a title for a still-hidden `show:false` window, i.e. the marker fired before first paint; (b) `ready-to-show` was delayed >8 s by renderer work. Entry-chain owns this endpoint; its marks remain in the tree for their trials.

## Code-path analysis (key edges, file:line)

- **Server-in-main-config:** `electron.vite.config.ts:41` lists `sidecar: "src/main/sidecar.ts"` as a main rollup input; `:65-70` resolves `virtual:opencode-server` to `../opencode/dist/node/node.js`; `:71-79` copies wasm assets into `out/main/chunks`. Consequence: the 33 MB server is Rollup-processed as part of EVERY main build (dev or prod), and re-emitted whenever `predev` rebuilds the dist (`scripts/predev.ts:8` runs `bun script/build-node.ts` unconditionally).
- **Sidecar import:** `sidecar.ts:57-58` `const { Server } = await import("virtual:opencode-server")` — executed inside the utility process after `start` message; nothing else can use that chunk earlier.
- **Decoupled window:** `index.ts:354-371` — comment documents the earlier bug (window waited on `Fiber.await(loadingTask)`); today `restoreMainWindows()` precedes the loading-task fork, and `ready-to-show` fires off the vite URL (`windows.ts:373-381`).
- **Draft store on critical path:** `registerIpcHandlers` (`index.ts:289`) constructs `createDesktopDraftStore(join(userData,"drafts.sqlite"))` (`ipc.ts:60`): `new DatabaseSync` + WAL pragma + CREATE TABLEs + SELECT-all of `document` and `blob` + JSON.parse of every document value + DELETE of orphans (`draft-store.ts:16-36`). All synchronous, before window creation.
- **Updater dead weight in dev:** `updater.ts:2` imports electron-updater at module scope; `setupAutoUpdater` opens the `opencode.updater` store (`updater.ts:28`); `void updater.start()` (`index.ts:351`) would hit the network but `check()` short-circuits while disabled (`updater-controller.ts:39`).
- **Native pty at module scope:** `index.ts:47` imports `./wsl/sidecar` → `wsl/sidecar.ts:6` imports `./runtime` → `wsl/runtime.ts:4` imports `@lydell/node-pty` (vite plugin resolves to `-win32-x64`, config `:54-63`); the `.node` binaries load during main-bundle evaluation regardless of WSL usage.
- **Shell-env probe risk (non-Windows only):** `server.ts:44-46` → `shell-env.ts:37` `spawnSync(shell, ["-il","-c","env -0"])` with 5 s timeout runs BEFORE `whenReady` (via `preferAppEnv`, `index.ts:208`). On Windows this is skipped (`server.ts:45`), but on macOS/Linux a slow login shell adds up to 5 s pre-whenReady.

## Root causes (cause → evidence → impact → fix + effort)

1. **Server bundle rides the main vite build every run** — evidence: config `:41/:65-70`, predev `:8`, mp1b `✓ built in 51.02s` (of 59.6 s total = 86% alone; 96% including all pre-electron phases), w1 = 67.1 s/76.3 s (88%). Impact: dominates wall clock of every `bun run dev`, COLD and WARM identically (no cache involved). Fix: in dev, don't bundle — emit a stub sidecar that computes the dist path and `await import(pathToFileURL(...))` at runtime (Rollup then never walks the 33 MB graph), or add an up-to-date check that skips `build-node.ts` + chunk emit when `../../../packages/opencode/dist` hash is unchanged. Effort: M. Expected saving: ~50-67 s/run.
2. **Sidecar parse floor ≈ 1.3-2.0 s before listen** — evidence: in-process mark `sidecar-server-imported` = 1328 ms (mp1b); standalone Node bench 1841-2083 ms; `sidecar.ts:57-58`. Impact: delays `serverReady` → LoadingSplash duration (renderer-perceived slowness after window appears). Fix: same stub/externalization shrinks the parse to the real entry; additionally consider V8 code cache/snapshot for the server bundle. Effort: M (with 1). Expected saving: ~1.3 s off splash time.
3. **electron-updater parsed at boot though dev-disabled** — evidence: `updater.ts:2`, `constants.ts:6`, 552 KB tree. Impact: tens of ms parse + memory in dev; none functional. Fix: `await import("electron-updater")` inside `setupAutoUpdater` (or gate on `UPDATER_ENABLED`). Effort: S.
4. **Native node-pty loads at module scope** — evidence: edge chain above; DLL sizes. Impact: native DLL load + 12 MB package residency for a niche feature. Fix: dynamic-import pty inside `spawnWslSidecar`/runtime fns. Effort: S.
5. **Draft-store sqlite open + orphan GC pre-window** — evidence: `ipc.ts:60`, `draft-store.ts:16-36`; measured within `ipc-registered` = 11.1 ms total (mp1b, small draft DB). Impact: sync IO proportional to draft count on every launch, ahead of window creation; today cheap, unbounded growth risk. Fix: lazy-init on first `draft-*` IPC call. Effort: S.
6. **Store-cleanup scan awaited pre-window** — evidence: `index.ts:263-275`. Impact: one userData dir scan before window; small but free to move. Fix: run after `restoreMainWindows()` (it's already async). Effort: S.
7. **(Non-Windows only) shell-env spawnSync pre-whenReady** — evidence: `server.ts:44-46`, `shell-env.ts:36-62`. Impact: up to 5 s on macOS/Linux with slow shells. Fix: make `preferAppEnv` lazy/async. Effort: S.

## Instrumentation edits made (all tagged `// STARTUP-AUTOPSY:`, all gated on `STARTUP_AUTOPSY_TIMING=1`)

- NEW `src/main/autopsy-timing.ts` — helper; captures t0 at main-bundle eval start (imported first in index.ts), emits `[STARTUP-AUTOPSY] {mark, ms, pid, uptimeMs}` JSON lines.
- `src/main/index.ts` — 15 marks: main-body-start, whenReady-wait-start/done, migrate-done, store-cleanup-done, updater-configured, ipc-registered, updater-start-fired, windows-restore-start, windows-created, sidecar-spawn-start, sidecar-ready-msg, sidecar-health-done, loading-task-done.
- `src/main/windows.ts` — import + `window-ready-to-show` / `window-shown` marks in the existing `ready-to-show` handler (co-located with entry-chain's endpoint mark; duplicate import resolved).
- `src/main/sidecar.ts` — import + sidecar-module-eval, sidecar-start-cmd, sidecar-server-imported, sidecar-listening.
- Raw scanner/benchmarks/parsers: `raw/main-proc-import-graph-scan.ts`, `raw/main-proc-static-audit.md`, `raw/main-proc-parse-marks.ts`.
- Trial logs: `raw/harness/logs/mp1.log` (contaminated, build-phase only) and `raw/harness/logs/mp1b.log` (clean, authoritative for this lane).
- All probes are removal candidates once the autopsy lands; none affect behavior when the env var is unset.

## Handoff notes

- → **coordinator / executive summary**: headline — `bun run dev` slowness is 96% build pipeline (51 s main-config build of the 33 MB server bundle in mp1b; 67.1 s in w1), ~0.7 s Electron main runtime, ~2.0 s sidecar-to-server-ready (1.33 s of it parsing the same 34 MB chunk). Fix the bundling, not the app.
- → **entry-chain**: mp1b gives you exact phase boundaries (`raw/harness/logs/mp1b.log`). Caveat for your endpoint: harness `window_shown` (title-based) fired at 59.6 s but our `ready-to-show` marks never printed before kill — verify your window-visible definition against a visible-window signal, not MainWindowTitle (hypothesis in Evidence caveat).
- → **backend-link**: the 33 MB dist is YOUR artifact (`../../../packages/opencode/dist/node/node.js`, rebuilt every predev); root cause #1's fix likely lands in `script/build-node.ts` caching + desktop config stub. Inside the utility process: import = 1328 ms, `Server.listen` = +399 ms (DB/routers) — yours to break down further.
- → **vite-lane**: main-config (not renderer) carries the 34 MB chunk emit; renderer dev server was up in ~0.1 s and `[vite] connected` at 59.36 s (≈2.3 s after electron spawn) in mp1b.
- → **metrics-harness**: apologies for executing mp1/mp1b without a granted slot — the swarm coordination store vanished mid-lane, making arbitration impossible; I pre-checked zero live electron PIDs before each run and the harness killed its own trees cleanly (`leftovers=[]`). mp1's contamination (external OpenCode window at 46.4 s) is documented; treat mp1b as INSTRUMENTED-WARM canonical for lane 2.
