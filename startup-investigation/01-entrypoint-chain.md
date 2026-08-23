# 01 · Entry-point chain: `bun run dev` → window visible (packages/desktop)

Lane owner: **entry-chain** · Swarm `startup-autopsy` · 2026-08-21
Status: **COMPLETE.** 7 trials total (4 mine: `ec-cold`, `ec-warm1`, `ec-warm2`, `ec-iso-fresh`; 3 harness-canonical: `w1`, `w2`/`w3`, `c1`). All numbers below are from stamped logs in `raw/harness/logs/` + `raw/trials.jsonl`.

## TL;DR — ranked verdict

1. **`bun run dev` costs ~59–72 s to a visible window, and 85–90% of that is ONE phase: electron-vite's main-process Rollup build re-bundling the already-built opencode backend.** `electron.vite.config.ts:64-70` resolves `virtual:opencode-server` to `../opencode/dist/node/node.js` (32.7 MB, produced by predev seconds earlier); Rollup parses/transforms/re-renders it into a 34 MB chunk (`out/main/chunks/node-*.js`). Measured: transform 53.8 s + render 5.5 s = **59.25 s** (ec-warm1), 62 s (ec-cold), 67.1 s (w1). Three-lane convergence: entry-chain (file:line + timeline), main-proc (33 MB chunk artifact), metrics-harness (67.1 s/88% in w1). Fix: externalize + copy the server bundle as an asset. Impact: **−55…−60 s every launch, COLD and WARM alike.**
2. **COLD vs WARM barely matters (Δ ≈ +2…+4 s):** clearing `.vite` + `out/` + `dist/node` moved window-visible 67.4→71.5 s (ec-warm1 vs ec-cold); clearing `.vite` alone moved nothing (c1 68.7 s ≈ w3 68.8 s). None of the expensive phases read a cache — they rebuild unconditionally.
3. **predev re-does cacheable work every launch: 3.8–4.9 s WARM** (backend `Bun.build` ~2.0-2.2 s incl. blocking models.dev fetch ~0.8-1.6 s; CLI `bun add` 0.4-0.5 s warm / unbounded cold; icons+electron-check ~0.3-0.5 s). `predev.ts:4-9`, `generate.ts:13`, `utils.ts:72-96`. Fix: freshness checks + TTL cache + version-check skip.
4. **Everything else is small and healthy:** electron-vite config boot 1.38-1.48 s; preload build 0.08-0.12 s; renderer dev server ~0.1-0.2 s; electron binary boot + main-bundle eval ~1.4 s; whenReady→windows-created ~0.2 s; first-paint→show ~0.36-0.42 s. The in-app segment (spawn→visible) is a steady **2.2-2.5 s** across all trials.
5. **Brand-new-user first launch is the FASTEST observed warm variant (61.2 s)** — fresh profile skips migrate/store scans; the dominant cost is unchanged (main build 52.9 s).

## Method

- Canonical clock: lane-5 harness `startup-investigation/raw/harness/run-trial.ps1` (monotonic `Stopwatch` line stamps, `ELECTRON_ENABLE_LOGGING=1`, `NO_COLOR=1`, OS-level window detection via `MainWindowTitle` on new electron PIDs, tree-kill teardown, JSONL per trial). Reused verbatim per ground rule #2.
- In-app marks: `[STARTUP-AUTOPSY]` JSON probes, env-gated `STARTUP_AUTOPSY_TIMING=1` (lane-2's `autopsy-timing.ts`; my marks at `windows.ts:267,269` — see Anomalies for why they did not emit).
- Trials (all `INSTRUMENTED` notes in trials.jsonl):
  - `ec-cold` — `-Mode cold -ClearPaths 'packages/desktop/out','packages/opencode/dist/node'` (also clears `.vite` per cold mode).
  - `ec-warm1`, `ec-warm2` — `-Mode warm`, back-to-back after cold (cache re-established by the cold run itself).
  - `ec-iso-fresh` — `-Mode warm` + `TEST_ONBOARDING=1` (fresh per-run tmpdir profile; lock-isolated; migrate skipped per `index.ts:262`).
  - Harness-canonical context: `w1` (WARM, pre-unblock, window-blocked at 76.3 s — still fully valid for build-phase attribution), `w2`/`w3` (WARM), `c1` (COLD, `.vite` only).
- Host: AMD Ryzen 9 5900X (12c/24t), Ultimate Performance plan. Trial CPU: avg 40-60%, max 69-90% — the Rollup pass alone saturates the machine.
- COLD definition: `.vite` dep-cache + `out/` + `../opencode/dist/node` deleted. Caveats: bun's global npm cache and the downloaded Electron binary stay warm; OS file cache uncontrollable.

## Evidence

### A. Keystroke → window-visible totals (all trials)

| Trial | Mode | window_shown (ms) | Notes |
|---|---|---:|---|
| ec-cold | COLD (.vite+out/+dist/node) | **71,545** | |
| ec-warm1 | WARM | **67,437** | |
| ec-warm2 | WARM | **69,629** | |
| ec-iso-fresh | WARM + fresh profile | **61,226** | TEST_ONBOARDING=1, migrate skipped |
| w2 (harness) | WARM | 59,331 | canonical, uninstrumented |
| w3 (harness) | WARM | 68,836 | canonical |
| c1 (harness) | COLD (.vite only) | 68,706 | ≈ w3 → dep-cache is NOT a factor |
| w1 (harness) | WARM | n/a (76.3 s to kill) | window-blocked by user instance; build attribution valid |

**WARM ≈ 59-70 s (median ≈ 68 s) · COLD ≈ 69-72 s · Δ(COLD−WARM) ≈ +2…+4 s.**

### B. Phase table — WARM (ec-warm1, representative; ec-cold/warm2/iso variants in logs)

| # | Phase | t_start | Duration | % of 67.4 s | Boundary source |
|---|-------|--------:|---------:|------------:|-----------------|
| 0 | bun boot → predev starts | 0 | 85 | 0.1% | `$ bun ./scripts/predev.ts` |
| 1 | predev: install-electron (cached skip) + copy-icons | 85 | 306 | 0.5% | `Copied dev icons` @391 |
| 2 | predev: build-node init + models.dev fetch | 391 | 1,044 | 1.5% | `Loaded models.dev snapshot` @1435 |
| 3 | predev: `Bun.build` backend → dist/node (32.7 MB) | 1435 | 1,996 | 3.0% | `Build complete` @3431 |
| 4 | predev: CLI `bun add` + copy (175.6 MB pkg, warm cache) | 3431 | 426 | 0.6% | `Copied @opencode-ai/cli-…` @3857 |
| 5 | electron-vite boot: config esbuild-bundle + load + plugins | 3874 | 1,377 | 2.0% | `building SSR bundle…` @5251 |
| 6 | **MAIN build: Rollup transform (59 modules incl. 32 MB backend)** | 5387 | **53,765** | **79.8%** | `rendering chunks...` @59152 |
| 7 | MAIN build: chunk render + write (34 MB chunk) | 59152 | 5,470 | 8.1% | `✓ built in 59.25s` @64622 |
| 8 | preload build (index+preview) | 64622 | 447 (pure 117 ms) | 0.7% | `✓ built in 117ms` @65020 |
| 9 | renderer dev server create+listen | 65069 | 147 | 0.2% | `dev server running` @65144 |
| 10 | electron spawn → binary boot + main-bundle eval | 65226 | 1,272 | 1.9% | `main-body-start` probe @66498 |
| 11 | main init: whenReady, migrate, stores, ipc, updater | 66498 | ~410 | 0.6% | probes: whenReady-done 66659 → windows-created 67078 |
| 12 | window create → first paint → `show()` | 67078 | 359 | 0.5% | `# WINDOW-SHOWN` @67437 |
| | **TOTAL** | | **67,437** | 100% | |

Phase 6+7 = **59.2 s = 88%** of the run. Identical structure in every trial; COLD adds ~2-4 s spread across phases 3/6/9 (colder IO + dep-optimize), nothing structural.

### C. In-app segment detail (electron spawn → visible), probe marks, all 4 ec-trials

| Mark (probe-ms since main-module eval) | ec-cold | ec-warm1 | ec-warm2 | ec-iso-fresh |
|---|---:|---:|---:|---:|
| main-body-start (module eval done) | 333 | 283 | 298 | 317 |
| whenReady-done | 510 | 419 | 420 | 468 |
| migrate-done | 511 | 420 | 421 | 469 |
| store-cleanup-done | 520 | 430 | 433 | 481 |
| ipc-registered | 540 | 450 | 449 | 503 |
| windows-created | 727 | 603 | 621 | 690 |
| WINDOW-SHOWN (OS, wall-clock) | 71,545 | 67,437 | 69,629 | 61,226 |

Electron binary boot (process start → module eval) ≈ 1.05-1.25 s in all trials (`uptimeMs` at main-body-start 1376-1581 minus probe-ms). whenReady→windows-created ≈ 0.18-0.22 s; migrate+store-cleanup ≈ 1-13 ms (WARM profile) — **the in-app segment is NOT a cost driver; the build phase is.**

### D. Post-window context (handoff to lanes 2/3/4, not in scope above)

- Sidecar (v1 utilityProcess): spawn-start at probe 635-754 ms; utility process imports the 34 MB chunk (`sidecar-server-imported` +1.33-1.57 s sidecar-uptime); listening ≈ +1.8-2.0 s; `loading-task-done` ≈ +3.0 s after window creation. Backend readiness is NOT the dev-start bottleneck.
- backend-link mined 117 real user runs: renderer's first `awaiting server ready` IPC lands p50 **17.6 s** after `app starting` — post-window splash wait is renderer/dev-server-transform-bound in steady state (vite-lane's lane).
- Raw captures: `raw/harness/logs/ec-*.log`, `raw/harness/logs/w1.log`, `raw/trials.jsonl`.

## Code-path analysis (keystroke → window, file:line)

1. `bun run dev` → auto-`predev` (`packages/desktop/package.json:14-15`).
2. `scripts/predev.ts` — `:4` `install-electron` (electron/install.js `isInstalled()` silent skip when cached); `:6` copy-icons; `:8` `bun script/build-node.ts` → `generate.ts:13` blocking `fetch("https://models.dev/api.json")` + `build-node.ts:15-30` unconditional `Bun.build` of `src/node.ts` → 32.7 MB `dist/node/node.js`; `:9` `downloadCliToResources()` (`utils.ts:72-96`) = real `bun install --no-save` of the 175.6 MB CLI pkg into a tmpdir + copy (warm only via bun's global cache). Cosmetic: `packages/script/src/index.ts:77` banner.
3. `electron-vite dev` (`node_modules/electron-vite/dist/chunks/lib-7y7CgM8M.js`): `:17` resolveConfig esbuild-bundles `electron.vite.config.ts` (leftover `electron.vite.config.1787197266363.mjs` = debris from a killed run); `:36` main build (watch) with entries `src/main/index.ts`+`src/main/sidecar.ts` (`electron.vite.config.ts:41`) — plugin `opencode:virtual-server-module` (`electron.vite.config.ts:64-70`) pulls `../opencode/dist/node/node.js` into the Rollup graph → `out/main/chunks/node-*.js` 34 MB; `:71-79` wasm copy; `:49` preload; `:58-72` renderer server; `:74` `startElectron` (`lib-q6ns0vZr.js:220-241`, `stdio:'inherit'`).
4. Electron main (`out/main/index.js` 309 kB ← `src/main/index.ts`): module eval (probe `main-body-start`, `index.ts:122`) → `app.whenReady()` (`:260`) → migrate/stores/ipc/updater (probes `:262-351`) → `restoreMainWindows()` (`:371`) → `createMainWindow` (`windows.ts:200-270`) → `loadWindow` against `ELECTRON_RENDERER_URL` (`windows.ts:277-286`) → `ready-to-show` → `win.show()` (`windows.ts:267-271`). Backend wait is forked off-path (`index.ts:374-448`); renderer splash awaits it via IPC (`:292-300`).

## Root causes (cause → evidence → impact → fix + effort)

### RC1 — Backend re-bundled into the main dev build (dominant; 85-90% of wall-clock)
- **Cause:** `virtual:opencode-server` feeds the freshly-built 32.7 MB `dist/node/node.js` through Rollup instead of treating it as an external artifact.
- **Evidence:** phase table B rows 6-7 (59.2 s of 67.4 s); consistent across all 7 trials (52.9-67.1 s); output chunk 34,064 kB; rollup warnings cite `../opencode/dist/node/node.js` (w1.log:50-53); three-lane convergence.
- **Impact:** ~55-60 s on EVERY launch, COLD and WARM.
- **Fix:** mark the virtual module external; copy `dist/node/*` next to `out/main` (the wasm-copy plugin `electron.vite.config.ts:71-79` is half the pattern already); import at runtime via `pathToFileURL`. Effort S-M. Expected result: `bun run dev` → visible window in **~8-12 s** WARM (predev 3.8 + boot 1.4 + main ~1-2 + preload 0.1 + renderer 0.2 + electron 2.3).
- **Workaround today:** `bunx electron-vite dev --rendererOnly` (skips main/preload builds; `lib-7y7CgM8M.js:26,52`) while iterating on renderer only.

### RC2 — predev redoes cacheable global work every launch
- **Cause:** no freshness checks: `Bun.build` unconditional (`build-node.ts:15`), models.dev fetched unconditionally (`generate.ts:13`), CLI reinstalled unconditionally (`utils.ts:81`).
- **Evidence:** table B rows 1-4 = 3.77 s WARM (up to 4.9 s in ec-cold); cold/offline multiplies (175 MB CLI download; slow models.dev; hard failure offline).
- **Impact:** ~3-5 s WARM; tens of seconds true-cold/offline.
- **Fix:** skip `build-node` when `dist/node` newer than `src/**`; TTL-cache the models.dev JSON; skip CLI step when `resources/opencode-cli.exe` exists and matches `CLI_VERSION` (`utils.ts:6`). Effort S.

### RC3 — (minor) electron-vite config boot
- 1.38-1.48 s every run (table B row 5). Not worth isolated treatment; shrinks if RC1 lands. No action.

### Non-causes (measured, ruled out)
- Vite dep-optimize cache: c1 (cleared) ≈ w3 (kept) → no effect on window-visible.
- In-app main-process work (migrate/stores/ipc/updater): ≤0.22 s combined (table C).
- Renderer dev-server listen: 0.1-0.2 s. Electron binary boot: ~1.1 s (fixed cost).

## Anomalies & data-integrity notes

1. **My `window-ready-to-show`/`window-shown` probe marks (windows.ts:267,269) did not emit in any trial** despite: source present at build time; the handler demonstrably executing (`win.show()` is its only call site and the OS observed the window); the shared `autopsy-timing` module working in the same process (all index.ts marks printed, incl. the code-split `autopsy-timing-*.js` chunk). Endpoint timing is unaffected — harness OS-level `WINDOW-SHOWN` detection is authoritative and present in all trials + JSONL. Flagged to main-proc: their `mp1` run (next slot) re-tests with fresh bundles.
2. **`out/main` found empty after the trials** (build logs prove writes at ec-iso-fresh 58058-58147 ms; the app executed the bundle; `out/preload` files from the same build remain, 19:47:01). Emptied post-trial by an unknown actor (peer or user activity in the gap). Benign for timing — every dev run rebuilds `out/` — but peers should not trust `out/` state between trials.
3. First `ec-iso-fresh` attempt was interrupted at ~6 s (tool timeout on my side); no JSONL record, no strays; clean re-run produced the recorded trial.

## Instrumentation edits made

All temporary, env-gated `STARTUP_AUTOPSY_TIMING=1`, tagged `// STARTUP-AUTOPSY:`, removed after the investigation:

1. `packages/desktop/src/main/windows.ts` — `:267` `autopsyMark("window-ready-to-show")`, `:269` `autopsyMark("window-shown")` in the existing `ready-to-show` handler (entry-chain's endpoint; shares lane-2's helper; single import at `:1` after collision resolution with main-proc). See Anomalies #1 for the non-emission issue.
2. No harness code changes by me; harness is lane-5's (`raw/harness/run-trial.ps1`, incl. their `-ClearPaths` addition and teardown fix). An initial private stamper was deleted unused.

## Handoff notes

- **To coordinator:** lane complete. Headline: ~68 s WARM / ~72 s COLD to visible window; 88% is RC1 (`electron.vite.config.ts:64-70`); fix estimate ~8-12 s WARM after RC1(+RC2). Trials ec-* are INSTRUMENTED-labeled in trials.jsonl; w2/w3/c1 are canonical.
- **To main-proc:** your `mp1` slot opens after my `ec-done` ping. Please re-check Anomaly #1 (my windows.ts marks silent in all 4 ec-trials) — your index.ts marks printed fine from the same module. In-app segment numbers for your doc: table C; binary boot ~1.1 s; whenReady→windows-created ~0.2 s; paint→show ~0.36-0.42 s.
- **To vite-lane:** renderer server listen 0.1-0.2 s; dep-cache ruled out for window-visible (c1≈w3). Your territory starts post-window: backend-link's user-log mining shows first server-ready IPC at p50 17.6 s after app start — that splash wait is yours to attribute.
- **To backend-link:** predev fully attributed (table B rows 1-4; models.dev fetch 0.8-1.6 s; CLI step 0.4-0.5 s warm). Sidecar ready ≈ 3.0 s after window creation (probe `loading-task-done`) — your engine-wait path is off the window-visible critical path, as designed at `index.ts:354-371`.
- **To metrics-harness:** 4 JSONL records appended (ec-cold/ec-warm1/ec-warm2/ec-iso-fresh), all INSTRUMENTED-labeled, no leftovers, no timeouts. Cross-check request: my ec-warm median 68.5 s vs your w2=59.3 s outlier — worth a look if you need a tighter canonical WARM number.
