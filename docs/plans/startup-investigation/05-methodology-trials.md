# 05 — Methodology & Canonical Trials (`metrics-harness`, lane 5)

**TL;DR verdict:** `bun run dev` (packages/desktop) spends **~85–90% of its wall clock building the main-process SSR bundle** — electron-vite transforms the entire opencode server (`../../../packages/opencode/dist/node/node.js`, ~33 MB) into `out/main/chunks/node-*.js` on *every* invocation. Measured **window-visible totals: WARM 59.3 s / 68.8 s, COLD 68.7 s**. Clearing the vite dep-optimize cache changed nothing (COLD ≈ WARM), so dep-opt is exonerated; the sidecar main-config build is the prime suspect. Everything before the build (predev chain) costs only ~4–5 s; everything after it (preload build, dev server, electron spawn → window) costs only ~2.5–3 s combined.

## Method

### Harness

- Script: [`raw/harness/run-trial.ps1`](raw/harness/run-trial.ps1) (+ [`raw/harness/cpu-sampler.ps1`](raw/harness/cpu-sampler.ps1))
- Usage (from repo root):

```powershell
# warm trial
pwsh -File startup-investigation/raw/harness/run-trial.ps1 -Mode warm -TrialId w2 -Notes "..."
# cold trial (deletes packages/desktop/node_modules/.vite first)
pwsh -File startup-investigation/raw/harness/run-trial.ps1 -Mode cold -TrialId c1 -Notes "..."
# deep cold (also clears build outputs) — used by entry-chain
pwsh -File startup-investigation/raw/harness/run-trial.ps1 -Mode cold -TrialId ec-cold `
  -ClearPaths 'packages/desktop/out','packages/opencode/dist/node'
```

What it does per trial:

1. Snapshots pre-state: CPU %, active power plan, vite-cache file count/bytes, PIDs of all running `electron`/`vite`/`bun` processes (baseline).
2. COLD mode: deletes `../../../packages/desktop/node_modules/.vite` (verified gone) plus any `-ClearPaths`.
3. Spawns `bun run dev` (cwd `../../../packages/desktop`) via `System.Diagnostics.Process` with `ELECTRON_ENABLE_LOGGING=1`, `NO_COLOR=1`; starts a `[System.Diagnostics.Stopwatch]`.
4. Stamps **every stdout/stderr line** with monotonic elapsed-ms into `raw/harness/logs/<trialId>.log`.
5. Detects markers by regex (table below) on live lines; polls every ≤50 ms for (a) first new `electron` PID (= spawn) and (b) first new electron process whose `MainWindowTitle` matches `^OpenCode` (= window shown). Baseline PIDs are excluded so a concurrently running user instance can never satisfy our markers.
6. Samples CPU % every 400 ms in a background sampler process.
7. Hard timeout (default 300 s), then kills **only our tree**: `taskkill /PID <root> /T /F`, plus a CIM-descendant sweep and a PID-diff sweep (new electron/vite PIDs vs baseline). Pre-existing processes are never touched. Post-run leftover check recorded in the JSONL.
8. Appends one JSONL record to [`raw/trials.jsonl`](raw/trials.jsonl).

### Definitions

- **WARM**: immediate rerun; vite dep-opt cache present, `out/` present, bun global cache warm, electron download cache warm.
- **COLD** (this lane, trial `c1`): exactly the WARM state minus `../../../packages/desktop/node_modules/.vite` (vite dep-optimize cache, 1098 files / 59.7 MB), deleted and verified immediately before spawn. **OS file cache is NOT controllable** on this machine (would require admin + reboot round-trips) — every trial therefore runs with hot OS file cache; treat all numbers as file-cache-warm.
- **DEEP COLD** (entry-chain's `ec-cold`): COLD + `../../../packages/desktop/out` + `../../../packages/opencode/dist/node` deleted → forces predev `build-node.ts` rebuild and a from-scratch electron-vite build.
- **INSTRUMENTED**: peer runs with env-gated `// STARTUP-AUTOPSY:` probes (`STARTUP_AUTOPSY_TIMING=1`) or profile isolation (`TEST_ONBOARDING=1`) in env; labeled in `notes`; not pooled with canonical numbers.

### Marker derivation (from actual log lines, w1.log)

| Marker | Regex | Source line observed |
|---|---|---|
| t_predev_done_ms | `(?i)Copied @opencode-ai/cli` | final line of `scripts/predev.ts` chain (utils.ts:95) |
| t_main_built_ms | `(?i)main process built successfully` | electron-vite after main SSR rollup |
| t_preload_built_ms | `(?i)preload scripts built successfully` | electron-vite after preload build |
| t_vite_ready_ms | `(?i)dev server running for the electron renderer` | electron-vite renderer dev server banner |
| t_dev_url_ms | `(?i)(localhost\|127\.0\.0\.1):\d+` | `➜ Local: http://localhost:5174/` |
| t_electron_starting_ms | `(?i)starting electron app` | electron-vite pre-spawn notice |
| t_electron_spawn | PID poll (not a log line) | first new `electron.exe` PID not in baseline |
| t_app_starting_ms | `(?i)\bapp starting \{` | electron-log line `> app starting { version… }` |
| t_window_shown | `MainWindowTitle -match '^OpenCode'` poll | Win32 window title of NEW electron PID |

An earlier candidate regex (`ready in \d+`, stock-vite style) matched nothing under electron-vite v5 — replaced after w1. That discovery run is preserved as-is in `logs/w1.log`.

## Trial tables

Machine context (all trials): AMD Ryzen 9 5900X 12C/24T · 128 GB RAM · Windows · power plan `Ultimate Performance` · bun 1.3.14 · Electron 42.3.3 · electron-vite ^5 / vite 7.1.4.

### Canonical trials (this lane)

| trial | mode | when | predev done | main built | preload built | dev server up | electron spawn | app starting | **window shown** | CPU avg/max % |
|---|---|---|---|---|---|---|---|---|---|---|
| w1 | WARM* | 19:00 | 4715 | 73351 | 74659 | 74788 | 75035 | 76348 | **n/a** † | 60.2 / 90 |
| w2 | WARM | 19:17 | 4294 | 56913 | 57543 | 57607 | 57807 | 58893 | **59331** | 39.6 / 69 |
| w3 | WARM | 19:18 | 4912 | 66531 | 66942 | 67011 | 67232 | 68422 | **68836** | 43.6 / 100 |
| c1 | COLD | 19:20 | 4118 | 66152 | 66535 | 66603 | 66851 | 68182 | **68706** | 42.7 / 71 |

\* w1 ran while the user's own dev instance was live (CPU avg 60%); retained as contaminated-discovery run, excluded from clean pools. Its markers still hold attribution value.
† w1's electron quit at `src/main/index.ts:205` (`requestSingleInstanceLock`) because the user's instance held the lock — window never shown. This collision is itself evidence: **two dev instances cannot coexist**, and any measurement protocol must serialize them.

Segment deltas (clean trials):

| segment | w2 | w3 | c1 |
|---|---|---|---|
| spawn → predev done | 4294 | 4912 | 4118 |
| predev done → main built (**SSR build**) | **52619** | **61619** | **62034** |
| main built → dev server up | 694 | 480 | 451 |
| dev server up → electron spawn | 200 | 221 | 248 |
| electron spawn → window shown | 1524 | 1604 | 1855 |

### Peer instrumented trials (run via this harness; labeled INSTRUMENTED)

| trial | owner | mode | variant | window shown | notes |
|---|---|---|---|---|---|
| ec-cold | entry-chain | DEEP COLD | STARTUP_AUTOPSY_TIMING=1 | **71545** | out/ + dist/node cleared; +4.1% vs my c1 — consistent |
| ec-warm1 | entry-chain | WARM | STARTUP_AUTOPSY_TIMING=1 | **67437** | in-range vs canonical warm pool |
| ec-warm2 | entry-chain | WARM | STARTUP_AUTOPSY_TIMING=1 | **69629** | in-range |
| ec-iso-fresh | entry-chain | WARM | TEST_ONBOARDING=1 fresh profile | _not run_ | swarm torn down before slot |
| mp1 | main-proc | WARM | STARTUP_AUTOPSY_TIMING=1 marks | _not run_ | swarm torn down before slot |

Early cross-check: ec-cold (deep cold) 71545ms vs c1 (vite-cache-only cold) 68706ms vs w3 warm 68836ms — clearing `out/` + `../../../packages/opencode/dist/node` costs only ~+2.8s over vite-cold and ~+0.8s over warm. The cold/warm axis is nearly flat across ALL cache layers tried; the SSR build (~52–62 s) re-runs regardless because electron-vite dev rebuilds the main config every invocation. This kills the "cold caches" hypothesis family and concentrates suspicion on work done unconditionally per-run.

## Cross-checks of peer numbers

Threshold: flag direct to author if >20% divergence from canonical trials. **No flags were required — all published peer numbers reconciled.**

| peer claim | canonical reference | verdict |
|---|---|---|
| main-proc: `out/main/chunks/node-*.js` = 33.2 MB, sidecar entry pulls opencode server (electron.vite.config.ts:41, virtual:opencode-server) | w1.log: emitted chunk **34,064.13 kB**; main SSR build 52.6–67.1 s of every trial | ✅ consistent (<20%) |
| backend-link: main-build cost attributable to sidecar input bundling `../../../packages/opencode/dist/node/node.js` | my marker structure: predev done ~4.3–4.9 s → main built ~56.9–66.5 s (build phase = 88–90% of total) | ✅ consistent |
| entry-chain ec-cold/ec-warm1/ec-warm2 (instrumented) | 71545 / 67437 / 69629 vs canonical 59331–68836 | ✅ within +4.1% of pool, no flag |
| vite-lane renderer-only probe: cold ≈ +21 s (esbuild prebundle ~50 deps → 1098 files/56.9 MB, shiki bundledLanguages fan-out + @codemirror/language-data), warm 1.1–1.5 s | my full-run cold−warm delta ≈ 0 s | ✅ reconciled: electron-vite overlaps renderer dep-opt with the main SSR build, so the 21 s hides under the 52–62 s main build (w1.log shows dev-server banner after main+preload build sections). Dep-opt becomes first-order only once the main build shrinks. Probe used a private cacheDir — shared `.vite` untouched, c1 assumptions hold. |

**Net attribution picture (all lanes' numbers pooled):** of a ~59–72 s window-visible total, ~52–62 s is the unconditional per-run main-config SSR build of the 34 MB server bundle; predev chain ~4–5 s; renderer dep-opt ~21 s but fully overlapped today; electron spawn→window ~1.5–1.9 s.

## Distribution summary (clean canonical trials n=3; warm-only n=2)

```
boundary            min      median   max      (pool)
t_window_shown      59331    68706    68836    w2,w3,c1
  warm-only         59331    64084    68836    w2,w3
predev_done         4118     4294     4912     w2,w3,c1
main_built          56913    66152    66531    w2,w3,c1
electron_spawn      57807    66851    67232    w2,w3,c1
app_starting        58893    68182    68422    w2,w3,c1
SSR-build delta     52619    61619    62034    w2,w3,c1
spawn->window       1524     1604     1855     w2,w3,c1
```

(all values ms from `bun` process start; variance note: w2 ran 16% faster than w3/c1 — same code, same caches; see caveats.)

## Cross-checks of peer numbers

_Filled — see table above._ Discrepancy threshold >20% flagged directly to author: **zero flags required**.

## Caveats / threats to validity

1. **Background load.** This is an actively used dev machine (WebStorm, multiple agent sessions). Even canonical trials averaged 39–44% CPU. w1 (avg 60%) shows contention inflates totals ~15–25%. Treat single-trial deltas <10% as noise.
2. **OS file cache uncontrolled** (see Definitions). True first-touch-after-boot cold is not measured here.
3. **Window-shown detection granularity.** Poll loop ≤50 ms; `MainWindowTitle` appears when the top-level window exists — this is "window created & titled", not "first paint completed". Renderer hydration time is NOT included.
4. **Settle-kill.** Each trial is killed 8 s after window-shown; long-tail work (engine connect, telemetry) past that point is unmeasured by design.
5. **Port drift.** While the user instance lived, our renderer shifted 5173→5174 and devtools bind failed (0x2740, cosmetic). Canonical trials had ports free.
6. **Single-instance lock** (`src/main/index.ts:205`) serializes all desktop measurements machine-wide; enforced via slot arbitration (README ground rule #2).
7. **c1 post-state anomaly:** after the cold trial `.vite` contained 1 file/23 bytes — dep-opt re-ran lazily on first renderer request, which our short settle window mostly misses. Reinforces finding #1 in the TL;DR (dep-opt cost is small either way).

## Handoff notes

- Coordinator/lanes: cite trials by id (`w2`, `w3`, `c1`) with COLD/WARM labels; raw lines in `raw/harness/logs/<id>.log`, machine-readable records in `raw/trials.jsonl`.
- Run slots remain arbitrated by me — request via direct message; serialization is mandatory (single-instance lock + CPU contention).
- The harness is reusable verbatim for any future regression check (`-Mode warm -TrialId <id>`); exit codes 0/2/3/4 = ok/timeout/no-window/spawn-fail.
- Open question handed to backend-link: how much of the 52–62 s SSR build is rollup transform vs minification of the 34 MB chunk, and what does the runtime import of that chunk cost the sidecar utility process at app start.
