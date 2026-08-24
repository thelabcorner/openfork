# 04 — Backend link: engine spawn/wait path + predev work

**Lane owner:** backend-link · **Status:** COMPLETE (all windows measured)
**All numbers WARM unless labeled otherwise.** "Backend ready" = desktop log line `loading task finished` (index.ts:447), i.e. after first successful health poll.

## TL;DR — ranked verdict

1. **The runtime backend link is NOT the bottleneck.** Across 117 real user runs (Aug 14–21, `%APPDATA%\ai.opencode.desktop.dev\logs`): sidecar spawn → server listening + first health 200 = **p50 1.61s / p90 2.38s / max 3.30s**. The renderer doesn't even *call* `awaitInitialization` until **p50 17.6s** after `app starting` — the backend sits ready ~10× longer than it takes to boot. Splash time is renderer/vite-bound, not backend-bound.
2. **The 32 MB server bundle is bundled TWICE and parsed once per launch.** predev's `build-node.ts` produces `dist/node/node.js` (32.68 MB) on every dev start (**3.07–3.35 s warm**, Bun.build is fast); electron-vite's main build then re-bundles it via the `virtual:opencode-server` module into `out/main/chunks/node-*.js` (32.49 MB) — metrics-harness w1 attributes **67.1 s of 76.3 s total dev startup (88%)** to that main build. This packaging choice is the single largest measured cost in the pipeline.
3. **At runtime the utility process pays a ~2.3 s serial boot**: V8 parse/link/eval of the 32.5 MB chunk ≈ **1.70–1.81 s (≈75%)**, `Server.listen()` layer-graph build incl. DB open ≈ **0.50–0.56 s (≈20%)**, first health 200 ≈ **56–72 ms** (bare-node harness, 3 runs + profile run).
4. **predev adds a fixed ~4.2–4.5 s warm tax per launch** (install-electron 219–285 ms, copy-icons ~105 ms, models.dev fetch 703–738 ms, build-node 3.07–3.35 s incl. its own fetch, CLI download 207–262 ms) — all unconditional, two network calls, no staleness checks. Meaningful, but an order of magnitude below cause 2.
5. **DB/config boot cost is real but bounded:** dev channel DB on this machine is `~/.local/share/opencode/opencode-openfork.db` = **7.77 GB**; opening it + PRAGMAs + migration-journal check is absorbed inside the 0.5 s listen phase. Zero health-check failures or retry storms in 117 logged runs.

**Fix with best leverage:** make `virtual:opencode-server` resolve external in dev (sidecar.js imports `../opencode/dist/node/node.js` at runtime instead of Rollup re-bundling it) — removes the ~67 s main-build cost. Second: hash-gate predev's rebuild + cache the models.dev fetch + skip CLI download when up-to-date — removes ~4.5 s.

## Method

- Static trace: `../../../packages/desktop/scripts/predev.ts` → `scripts/utils.ts`; `src/main/index.ts` → `server.ts` → `sidecar.ts` → `../../../packages/opencode/src/server/server.ts` → layer graph.
- Log mining: parsed `app starting` / `spawning sidecar` / `loading task finished` / `awaiting server ready` timestamps from 117 run dirs under `%APPDATA%\ai.opencode.desktop.dev\logs\` (script inline in session; output saved to `raw/backend-link-desktop-logs-mined.txt`). These are the user's own launches — zero interference with harness trials.
- Timed trials (executed 2026-08-21 ~19:35–19:50, machine quiet of peer trials; ambient load = user's usual desktop apps):
  - **W1** per-step predev timing: `bun startup-investigation/raw/backend-link-predev-steps.ts` ×2 runs → `raw/backend-link-w1-predev.log`, `raw/backend-link-w1-predev-run2.log`.
  - **W2** bare-node boot split ×3 + 1 `--cpu-prof` run: `node --experimental-loader ./startup-investigation/raw/backend-link-pty-hook.mjs ./startup-investigation/raw/backend-link-server-boot.mjs` → `raw/backend-link-w2-boot.log`, `raw/backend-link-w2-cpuprofile.log`, profile `raw/backend-link-boot.cpuprofile` (+ summarizer `backend-link-cpuprofile-summarize.mjs`).
  - **W3** (folded into W1): `build-node-cached-models` step with `MODELS_DEV_API_JSON` pointing at a saved snapshot (`raw/models-dev-api.json`, 4.26 MB) vs live fetch.
  - Fidelity notes: harness runs system **node v22.23.2** while the real sidecar runs Electron 42's Node 24 — parse speeds are comparable but not identical; a `--experimental-loader` shim resolves `@lydell/node-pty` from `../../../packages/desktop/node_modules` exactly as electron-vite's externalizeDeps does (the bundle externalizes it, `build-node.ts:21`); harness sets `OPENCODE_SERVER_USERNAME/PASSWORD` before import, mirroring `sidecar.ts:83-89` `prepareSidecarEnv` (without this, an ambient `OPENCODE_SERVER_PASSWORD` from the host session wins and health 401s — found the hard way, see `raw/backend-link-health-debug.mjs`).

## Evidence

### E1. Real-run backend readiness (117 runs, WARM, mined from desktop logs)

| Metric | min | p50 | p90 | max | mean |
|---|---|---|---|---|---|
| `spawning sidecar` → `loading task finished` (ms) | 1295 | 1607 | 2378 | 3303 | 1746 |
| `app starting` → renderer first `awaiting server ready` (ms) | 1774 | 17638 | 21708 | 137170 | — |

Interpretation: the backend link contributes ~1.3–3.3 s per launch; the renderer reaches its own init-await ~17–22 s later even though the answer is already waiting. Raw: `raw/backend-link-desktop-logs-mined.txt`.

Live-run example (2026-08-21 18:42, the instance running during this investigation):

```
18:42:28.965 app starting
18:42:29.098 sidecar connection started { version: 'v1' }
18:42:29.110 spawning sidecar { url: 'http://127.0.0.1:37585' }
18:42:30.876 loading task finished            <- backend ready: 1766 ms after spawn
18:42:47.334 awaiting server ready            <- renderer only asks here (+18.4 s)
18:42:47.335 server ready                     <- resolved instantly (deferred already set)
```

### E2. The bundle that everything pays for

| Artifact | Size |
|---|---|
| `../../../packages/opencode/dist/node/node.js` (predev Bun.build output) | 32.68 MB (+58.5 MB map, 4 wasm assets) |
| `packages/desktop/out/main/chunks/node-BsjhI-JA.js` (electron-vite main build re-bundle) | 32.49 MB |

### E3. Dev-channel DB size on this machine

| File | Size |
|---|---|
| `~/.local/share/opencode/opencode-openfork.db` (branch-named channel DB, used by dev desktop) | 7.77 GB |
| `~/.local/share/opencode/opencode.db` (default-channel DB, written by another process) | 4.52 GB (+125 MB WAL) |

### E4. Timed windows (measured 2026-08-21, WARM)

**W1 — predev steps** (two runs; `raw/backend-link-w1-predev*.log`):

| Step | Run 1 | Run 2 |
|---|---|---|
| `bun run install-electron` | 285 ms | 219 ms |
| `copy-icons.ts dev` | 102 ms | 107 ms |
| `generate.ts` models.dev fetch alone | 738 ms | 703 ms |
| `build-node.ts` total (fetch + Bun.build) | 3066 ms | 3348 ms |
| `build-node.ts` with cached models snapshot | (failed: snapshot missing) | 2944 ms |
| `downloadCliToResources` (network bun install + copy) | 247 ms | 207 ms |
| **Total predev-equivalent** | **~4.44 s** | **~4.28 s** |

Network-fetch contribution inside build-node ≈ 3348 − 2944 = **~400 ms** warm. True COLD predev (empty electron cache / cold npm+network) not measured — would require flushing machine-global caches; flagged as unmeasured.

**W2 — bare-node boot split** (`raw/backend-link-w2-boot.log`; node v22.23.2; port 4096; DB = 7.77 GB channel db, one unrelated WAL reader present):

| Phase | Run 1 | Run 2 | Run 3 | Profile run |
|---|---|---|---|---|
| import dist/node bundle (parse/link/eval) | 1805 ms | 1699 ms | 1745 ms | 1943 ms |
| `Server.listen` (layer graph + DB open) | 504 ms | 555 ms | 506 ms | 556 ms |
| first health 200 (25 ms poll) | 63 ms | 72 ms | 56 ms | 55 ms |
| **spawn→first-API-response total** | **2373 ms** | **2326 ms** | **2308 ms** | **2555 ms** |
| subsequent health request | 3.6 ms | 6.4 ms | 4.1 ms | 6.4 ms |

Attribution: **import ≈ 75%, listen ≈ 20–22%, health ≈ 2%**. The `--cpu-prof` profile shows the main thread ~96% idle during import — V8 streams the 32 MB parse on background threads, so main-thread profiling cannot split it further; wall-clock phase splits are the honest attribution (`raw/backend-link-w2-cpuprofile-summary.txt`).

Cross-check vs desktop logs: in-Electron spawn→health p50 1607 ms (117 runs) vs bare-node 2308–2555 ms here — consistent order of magnitude; the harness adds node22-vs-electron-node24 and loader-shim overhead, and desktop's poll is 100 ms-grained.

## Code-path analysis

### Predev (every `bun run dev`)

`packages/desktop/scripts/predev.ts:4-9` runs four steps unconditionally:

1. `bun run install-electron` — electron pkg install script (bin `install-electron` in `../../../packages/desktop/node_modules/.bin`); verifies/downloads Electron zip (OS-cache warm ⇒ cheap).
2. `bun ./scripts/copy-icons.ts dev` — `rm -rf resources/icons && cp -R icons/dev` (trivial).
3. `cd ../opencode && bun script/build-node.ts` — **full rebuild every time**: `script/generate.ts:11-13` fetches `https://models.dev/api.json` (or `$MODELS_DEV_API_JSON`) with **no cache**, then `Bun.build` bundles `src/node.ts` → `dist/node/node.js` (32.68 MB, sourcemap linked). No input-hash/staleness check.
4. `downloadCliToResources()` (`scripts/utils.ts:72-96`) — creates temp dir, `bun install --no-save @opencode-ai/cli-windows-x64-baseline@0.0.0-next-16350` (**network**) and copies `opencode2.exe` → `resources/opencode-cli.exe`. No cache check against the already-present file.

Note: `Script.channel` (`packages/script/src/index.ts:26-31`) defaults to the current git branch name → the built-in `OPENCODE_CHANNEL` define is e.g. `'openfork'`, which also selects the branch-named SQLite DB (see below).

### Desktop → engine connection

- Desktop does NOT spawn an external `opencode serve`. It forks an Electron **utility process** running the bundled sidecar: `spawnLocalServer` (`src/main/server.ts:57-69`) → `utilityProcess.fork("sidecar.js", { serviceName: "opencode server" })`.
- Port: ephemeral via `createServer().listen(0)` (`src/main/index.ts:401-416`), or `$OPENCODE_PORT`. Password: `randomUUID()` (`index.ts:419`). Basic-auth `opencode:<password>`.
- Sidecar `start()` (`src/main/sidecar.ts:51-71`): sets env, forces loopback into NO_PROXY, merges system CA certs, then `await import("virtual:opencode-server")` → resolved by electron-vite plugin to `../opencode/dist/node/node.js` (`electron.vite.config.ts:64-70`) → emitted as `out/main/chunks/node-*.js` (32.49 MB) → `Server.listen({port, hostname, username, password, cors})` → posts `{type:"ready"}`.
- Main waits for the `ready` message with a **60 s stall timeout** (`SIDECAR_START_STALL_TIMEOUT`, server.ts:20, timeout armed at :101-106). No retry/backoff — single shot; failure rejects through `forwardInitializationFailure` into the `serverReady` deferred.
- After `ready`, main starts a health poll: every **100 ms**, GET `/api/health` then `/global/health`, each with **3 s abort timeout** (`checkHealth`, server.ts:145-164,187-212). Worst case one cycle ≈ 6 s if TCP accepts but requests hang. This poll result gates nothing user-visible: `health.wait` is awaited under `Effect.timeout("30 seconds")` and failure is only logged (`index.ts:438-445`).
- **Renderer gating:** `serverReady` deferred is succeeded immediately after `spawnLocalServer` returns (i.e. once `Server.listen` resolved), BEFORE health confirmation (`index.ts:431-432`). Renderer `LoadingSplash` shows until `awaitInitialization` IPC resolves (`src/renderer/index.tsx:338,368-370,393`) plus defaultServer/locale/wsl resources. So the app UI unblocks on "socket listening", not on "health verified". Robustness note: if the sidecar fails to start, `serverReady` rejects, `awaitInitialization` rejects, the `sidecar` resource errors — `ready` still flips true (it only checks `.loading`) and the UI renders with no sidecar connection in the servers list (blank main view); there is no retry and no user-visible error surface for this path.
- **Window does not block on the backend:** `restoreMainWindows()` runs before the loading task is forked (`index.ts:371` vs `:374-448`; comment at :354-361 documents this was moved earlier deliberately). Window becomes visible on `ready-to-show` (`windows.ts:266-270`).

### Server boot inside the sidecar (what listen() blocks on)

`Server.listen` (`packages/opencode/src/server/server.ts:73-98`) → `Layer.buildWithMemoMap(listenerLayer(...))` (:124-138) **eagerly builds** the route layer tree provided in `HttpApiApp.createRoutes` (`routes/instance/httpapi/server.ts:290-332`), which includes `AppNodeBuilderV1.build(app)` — a ~60-service graph (server.ts:225-288). Eager-cost contributors:

- **Database** (`packages/core/src/database/database.ts:28-78`): open `node:sqlite` `DatabaseSync`, 7 PRAGMAs incl. `wal_checkpoint(PASSIVE)` and 64 MB page cache, `DatabaseMigration.apply` (journal check — cheap: `sqlite_master` + `migration` table reads, `migration.ts:18-41`), `ensureChunkDB` (no-op unless `OPENCODE_SEAL_ENABLED`). On this machine that means opening the **7.77 GB** branch DB; empirically absorbed within the 1.3–3.3 s total.
- **ModelsDev** (`packages/core/src/models-dev.ts:255-258`): at layer build it *forks* a background `refresh()` (fetches models.opencode.ai/api.json if cache >5 min TTL, Flock-locked, 10 s timeout, 2 transient retries) — background, does not block listen. The full catalog is also baked into the bundle as `OPENCODE_MODELS_DEV` define (build-node.ts:23), which is part of why the bundle is 32 MB.
- Config/Plugin/agents etc. are `InstanceState`-scoped (e.g. `config/config.ts:600`, `plugin/index.ts:167`) — lazy per-project, not paid at listen.
- `global.ts:35-43` top-level `await` mkdirs 7 dirs at module import (part of import_ms, tiny).

### Retry/backoff inventory (silent multipliers)

| Loop | Where | Behavior |
|---|---|---|
| Health poll | server.ts:153-161 | fixed 100 ms, no backoff, unbounded until 30 s Effect.timeout; failure non-fatal (logged) |
| Ready-message wait | server.ts:101-106 | 60 s stall timeout, no retry |
| ModelsDev refresh | models-dev.ts:152-157,255-258 | exponential 200 ms jittered ×2, background fork every 60 min |
| Remote config fetch | config/config.ts:193 | `withTransientReadRetry` |
| CLI download (predev) | utils.ts:81 | none — network failure fails predev outright |

No pathological multipliers observed in the 117-run corpus (zero `health check failed` / `did not become ready` lines).

## Ranked root causes (backend-link scope)

| # | Cause | Evidence | Impact/launch | Fix | Effort |
|---|---|---|---|---|---|
| 1 | electron-vite main build re-bundles the 32.7 MB server bundle on every dev start (virtual module resolves to real file → Rollup ingests it) | electron.vite.config.ts:64-70; out/main/chunks 32.49 MB; metrics-harness w1: 67.1 s of 76.3 s | ~67 s | In dev, emit sidecar.js with a plain relative import of `../opencode/dist/node/node.js` (mark external / resolveId returns `{external:true}` + copy wasm), skip Rollup ingestion | S–M |
| 2 | Runtime parse/link/eval of the 32.5 MB chunk in the utility process dominates engine boot | W2: import 1.70–1.94 s of 2.31–2.55 s total (≈75%) | ~1.7 s serial before the server socket exists | Bundle-size diet (externalize heavy unused deps from the node build), V8 compile cache (`module.enableCompileCache()` for the sidecar), or ship a prebuilt snapshot | M–L |
| 3 | predev re-runs everything unconditionally: full Bun.build + models.dev fetch + CLI pkg download, no staleness checks | predev.ts:4-9; generate.ts:11-13; utils.ts:72-96; W1: ~4.3–4.4 s warm total | ~4.3 s fixed tax (more when network slow/offline — two hard network deps) | Hash-check inputs, reuse dist/node when `src/`+lockfile unchanged; cache models.dev json (`MODELS_DEV_API_JSON` already supported); skip download if `resources/opencode-cli.exe` version matches | M |
| 4 | `Server.listen` eagerly builds the ~60-service layer graph incl. DB open on a multi-GB SQLite file | server.ts:124-138; httpapi/server.ts:225-288,290-332; database.ts:28-78; E3 (7.77 GB db); W2 listen = 0.50–0.56 s | ~0.5 s | Lazy-build services not needed for first paint; defer non-critical PRAGMAs (e.g. boot-time `wal_checkpoint(PASSIVE)`) | M |
| 5 | Branch-named channel DB grows unbounded (7.77 GB on this machine) and is opened at every boot | database.ts:111-123 (channel from git branch via Script.channel); E3 | small today (inside the 0.5 s listen phase) but scales with DB size | Retention/pruning for per-channel DBs | S |

Non-causes checked: `/api/health` vs `/global/health` — BOTH are declared endpoints (`/api/health` = protocol HealthGroup `../../../packages/protocol/src/groups/health.ts`, mounted via serverRoutes; `/global/health` = groups/global.ts:66); desktop's poll order is correct and first poll succeeds (W2 health_path=/api/health). Health-poll failure path is non-fatal by design (index.ts:438-445).

## Instrumentation edits made

- **No edits to repo source** by this lane. Everything lives under `raw`:
  - `backend-link-predev-steps.ts` — W1 per-step predev timer (executed ×2)
  - `backend-link-server-boot.mjs` — W2 import→listen→health splitter (executed ×4)
  - `backend-link-pty-hook.mjs` — resolve shim mapping the bundle's `@lydell/node-pty` external to `../../../packages/desktop/node_modules` (measurement-only; mirrors electron-vite's externalizeDeps)
  - `backend-link-health-debug.mjs` — one-shot 401 diagnostic (kept as evidence for the ambient-env gotcha)
  - `backend-link-cpuprofile-summarize.mjs` + `backend-link-w2-cpuprofile-summary.txt`
  - `models-dev-api.json` — saved models.dev snapshot used by the cached-build step
  - `backend-link-w1-predev.log`, `backend-link-w1-predev-run2.log`, `backend-link-w2-boot.log`, `backend-link-w2-cpuprofile.log`
  - `backend-link-desktop-logs-mined.txt` — mined timestamps, 117 real runs
- Side effects on machine state (same as a normal dev launch produces): rebuilt `packages/opencode/dist/node/*`, refreshed `../../../packages/desktop/resources/icons` and `resources/opencode-cli.exe`. No commits.
- Observed peer instrumentation (not mine): `autopsyMark(...)` // STARTUP-AUTOPSY at `windows.ts:267,269`.

## Handoff notes

- **entry-chain / vite-lane:** your renderer numbers explain the 17.6 s p50 "renderer first await" gap I mined — the backend is idle-ready by then; cite E1/E2 freely. The ~67 s main-build cost (your w1 cross-check) is causally cause #1: the sidecar entry pulls `dist/node` through the virtual module.
- **metrics-harness:** W1–W3 executed after your trials and entry-chain's runs finished; numbers in E4 for cross-check. Note my harness total (~2.3 s) vs your in-electron p50 (1.6 s) — different runtime + loader shim; treat as attribution evidence, not canonical totals.
- **main-proc:** the 32.49 MB chunk lives in your process's build output but executes in the utility process; import cost is off the main-process event loop. The utility process boot is ~2.3 s serial (W2).
- **coordinator:** biggest wins are packaging-level (#1 externalize virtual module in dev ≈ −67 s, #3 predev gating ≈ −4.3 s); runtime work (#2 bundle diet / compile cache ≈ −1.5 s potential) is second-order at current sizes.
- Swarm infrastructure note: `startup-autopsy` was deleted from the store before final handoff; deliverable persisted here in the repo tree instead of the blackboard.
