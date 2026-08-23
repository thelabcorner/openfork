# 03 — Vite dev pipeline + renderer transform costs (lane: vite-lane)

**Date:** 2026-08-21 · **Scope:** electron-vite config inventory, dep-optimize cache forensics (cold vs warm), renderer transform cost attribution.

## TL;DR — ranked verdict

1. **The dep-optimize cache is NOT cold because of hash churn — it is cold because dev processes get killed during a ~20s prebundle window.** Vite's deps hash is stable ("Hash is consistent. Skipping." on every warm run). But `packages/desktop/node_modules/.vite/` contained **5 orphaned `deps_temp_*` dirs and no completed `deps/`** (abandoned 19:25–19:50 today) — each an interrupted prebundle. Every kill re-colds the next launch.
2. **Cold prebundle costs ~20s** (measured 19.4s / 21.8s, two trials) because the esbuild scan discovers **~50 deps that fan out into 1098 files / 56.9MB**, dominated by the full `shiki` bundle (`bundledLanguages` ≈ 200 grammars + themes) imported at `packages/app/src/pages/session/v2/project-explorer-markdown-viewer.tsx:6`, plus `@codemirror/language-data`. In full runs this cost currently hides under the main-process SSR build (metrics-harness: cold≈warm wall-clock), but it becomes user-visible whenever the main build gets faster or the process is killed mid-prebundle.
3. **Even WARM, the renderer's eager entry graph costs ~10.5–12.6s of server-side transform** per fresh page load. Largest structural cause: `packages/desktop/src/renderer/i18n/index.ts:8-70` statically imports **all 67 locale dictionaries (~6.0MB TS)** into the startup graph; only one is ever used at runtime. The app package already has the correct lazy pattern (`packages/app/src/context/language.tsx:59-68`); the desktop barrel defeats it.
4. SolidJS babel transforms of large app modules are the remaining warm cost (app.tsx 835ms, ui/theme/context.tsx 880ms, layout.tsx 729ms … pipelined wall times). No cheap fix; reduce eager graph instead.
5. Hygiene: a leftover electron-vite temp config `electron.vite.config.1787197266363.mjs` is **committed to git**; electron-vite writes these into the project dir on every run and deletes them on success (`electron-vite/dist/chunks/lib-q6ns0vZr.js:1766-1777`) — killed runs leave them behind.

## Method

- Config/cache forensics: direct reads + `rg` over `packages/desktop/electron.vite.config.ts`, `packages/app/vite.js`, electron-vite/vite dist (versions: electron-vite per `packages/desktop/node_modules/electron-vite`, vite 7.1.4).
- Renderer measurements: JS-API harness `startup-investigation/raw/vite-lane-renderer-probe.ts` — loads the REAL merged renderer config via electron-vite's own `resolveConfig({}, "serve")`, starts a vite dev server with vite's `createServer`, then BFS-crawls the static import graph from `/index.tsx` via `transformRequest` (browser-faithful: follows exactly the specifiers vite rewrites into code). DEBUG=`vite:deps,vite:transform` captured with timestamps.
- **COLD vs WARM**: private `cacheDir` (`raw/vite-lane-probe-cache`), deleted before cold trials. This measures identical prebundle work without touching the shared cache (the user's live dev instance held the real one; peers' trials depended on its state). Shared cache was never modified by this lane.
- Machine state during trials: user's dev instance running throughout (~20% total CPU, no peer trials concurrent — verified before each run).

## Evidence

### Dep-optimize prebundle (isolated renderer server)

| trial | dep-cache | config-resolve | createServer | listen | optimizer (esbuild prebundle) | total |
|---|---|---|---|---|---|---|
| cold2 | empty | 820ms | 80ms | 106ms | **19410ms** | 22200ms |
| cold3 | empty | 658ms | 67ms | 69ms | **21816ms** | 24400ms |
| warm1 | hot | 779ms | 133ms | 77ms | skipped — `Hash is consistent. Skipping.` | 1510ms |
| warm2 | hot | 750ms | 76ms | 52ms | skipped | 1210ms |
| warm3 | hot | 717ms | 71ms | 54ms | skipped | 1120ms |

Scan phase (cold2/cold3): `Scan completed in ~2177ms`, 50 deps discovered → prebundle writes 1098 files / 56.9MB when warm (measured on the earlier populated cache: 54 optimized entries in `_metadata.json`, hash `5e5a234f`). Top chunks: `effect.js` 1672KB, `ghostty-web.js` 1401KB, `@sentry_solid.js` 945KB, `emacs-lisp-*.js` 762KB, `wasm-*.js` 608KB (shiki grammar), plus ~200 language/theme chunks.

### Warm eager-graph transform crawl (what the browser first-load requests)

| trial | modules crawled | pipelined wall time |
|---|---|---|
| warm8 | 85 source (+132 dep-chunk serves) | 12094ms |
| warm9 | 85 | 12595ms |
| warm10 | 85 | 10460ms |

Top single-module transforms (warm9, `vite:transform` wall times under pipelining):

| module | ms |
|---|---|
| `ui/src/theme/context.tsx` | 880 |
| `app/src/app.tsx` | 835 |
| `app/src/context/layout.tsx` | 729 |
| 67 × `/i18n/*.ts` desktop locale dicts | ~740 each (one concurrent wave) |
| `app/src/context/server.tsx` | 569 |
| `app/src/context/server-sdk.tsx` | 567 |
| `app/src/context/server-sync.tsx` | 535 |
| `app/src/context/language.tsx` | 417 |
| `app/src/context/command.tsx` | 381 |
| `/styles.css` (tailwind v4) | 357 |

Shared-cache state at time of writing: `.vite/deps_temp_{10b0a9f8,2096a261,431b0275,537c12f8,7aa9f469}` orphaned (19:25–19:50), no `deps/` → next launch pays the full cold prebundle again.

## Code-path analysis

- **Config plumbing** — `packages/desktop/electron.vite.config.ts`: main inputs `index`+`sidecar` (:41) with CJS-shim banner (:45-51) and `externalizeDeps` node-pty (:54); custom plugins `opencode:node-pty-narrower` (:57-63), `opencode:virtual-server-module` (:65-70), `opencode:copy-server-assets` (:72-79). Preload inputs `index`+`preview` (:85-91). Renderer (:99-111): plugins `[appPlugin, sentry]`, `publicDir ../../../app/public`, `root src/renderer`, `build.sourcemap true` (**build-only**; does not affect dev transform cost). Sentry plugin active only when `SENTRY_*` env set (:17-32) — off in normal dev.
- **appPlugin** — `packages/app/vite.js:18-48`: alias `@`→app/src (:25), `define VITE_OPENCODE_CHANNEL` (:29), worker es format (:31-33), theme-preload inline script injection (:39-44), `tailwindcss()` (:46), `solidPlugin()` (:47). **No i18n plugin, no optimizeDeps.include/exclude anywhere, no custom cacheDir.**
- **cacheDir location** — vite 7.1.4 default resolves to nearest `package.json` dir above root: `.../node_modules/.vite` (`vite/dist/node/chunks/dep-C6pp_iVS.js:36247`). Stable across runs; not a churn source.
- **Why shiki explodes the cache** — `project-explorer-markdown-viewer.tsx:6` imports `bundledLanguages` (full bundle) statically; statically imported by `project-explorer-editor-pane.tsx:54`. The esbuild scanner discovers it regardless of route laziness → all grammars/themes prebundled on cold start.
- **Locale barrel** — `packages/desktop/src/renderer/i18n/index.ts:8-70` static-imports 67 dicts (6.0MB total measured across `app/src/i18n/*.ts`); `build()` (:116-179) selects exactly one at runtime. Contrast the lazy pattern one level up: `packages/app/src/context/language.tsx:59-68` uses per-locale dynamic `import()`.
- **Temp config litter** — electron-vite bundles TS config to `electron.vite.config.<Date.now()>.mjs` **inside the project dir** and unlinks it after import (`lib-q6ns0vZr.js:1766-1777`); kills during config load leave it behind. One such file is tracked in git.

## Root causes (cause → evidence → impact → fix + effort)

1. **Interrupted prebundles keep the dep cache cold** → 5 orphaned `deps_temp_*`, no `deps/`; warm runs skip instantly → every killed session adds ~20s to the next launch → Fix: none needed in vite; reduce what gets prebundled (#2) so the cold window shrinks below kill-frequency, and prefer graceful shutdown. Effort: n/a (behavioral).
2. **Full shiki bundle in the dep graph** → markdown-viewer import chain (above); 1098-file/56.9MB prebundle, 19.4–21.8s cold → dominant renderer-side cold cost; delays first paint whenever not overlapped → Fix: import fine-grained (`shiki` core + only needed grammars) or lazy `import("shiki")` inside the viewer + move to a web worker; alternatively `optimizeDeps.exclude: ["shiki"]` trades prebundle for on-demand serving. Effort: low-medium.
3. **Desktop locale barrel loads 67 dicts eagerly** → i18n/index.ts:8-70; several seconds of the warm 10.5–12.6s crawl + 6MB module graph every startup → Fix: dynamic-import only the resolved locale (mirror language.tsx:59-68). Effort: low.
4. **Solid babel transform aggregate** → table above; ~10s warm floor for the current eager graph → Fix: route-level lazy loading to shrink the startup graph; no plugin swap recommended. Effort: medium (app architecture).
5. **Committed temp config** → `electron.vite.config.1787197266363.mjs` tracked in git → repo noise, confuses config discovery → delete + gitignore `electron.vite.config.*.mjs`. Effort: trivial.

## Instrumentation edits made

- **No product files modified.** All instrumentation lives in `startup-investigation/raw/`: `vite-lane-renderer-probe.ts` (tagged `// STARTUP-AUTOPSY:`; env-gated by direct invocation; sets `DEBUG=vite:deps,vite:transform`; overrides `cacheDir`+`port` on its private server only) and `vite-lane-introspect.ts` (one-off DevServer shape probe). Logs: `vite-lane-{cold1..3,warm1..10}.log`.
- Shared `packages/desktop/node_modules/.vite` was never touched by this lane (private cacheDir). Private probe cache deleted after trials.

## Handoff notes

- **entry-chain**: renderer dev-server readiness does NOT gate electron spawn; the browser's first load waits on optimized deps, so a cold prebundle delays first paint by up to ~20s unless overlapped with your main-process build (your w1 shows it currently IS overlapped — metrics-harness measured cold≈warm full-run). If the main build shrinks, revisit.
- **metrics-harness**: your c1 cleared the shared cache; as of now it is still cold (only orphaned temp dirs remain) — factor into any further trials. My numbers cross-check yours: isolated cold delta ≈ +21s vs your cold≈warm wall-clock ⇒ overlap conclusion holds.
- **main-proc**: nothing in renderer config blocks main-process boot; `opencode:copy-server-assets` copies `.wasm`s synchronously in `writeBundle` (build phase, not dev-server path).
- Coordinator: items 2/3/5 are cheap, high-confidence fixes; item 2 needs an app-owner decision on shiki usage.
