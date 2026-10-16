# Lane C — packaged ACP runtime certification harness

Owner: DeepSeek V4.1 Flash lane C (explicit user delegation, 2026-10-11).
Exclusive file ownership claimed by this journal:

- `packages/opencode/script/sqlite-acp-cert-20261011/**` (new directory, all files)
- `docs/research/sqlite-delegations-20261011/C-acp-runtime.md` (this file)

Other lanes' journals under `docs/research/sqlite-delegations-20261011/` are READ ONLY.
No other lane may patch the paths above; this lane will not patch any other lane's
claimed paths.

Forbidden/reference-only for this lane (dirty or another owner), never edited:
`packages/core/src/database/**`, `packages/opencode/src/fork/credentials.ts`,
`packages/opencode/script/build.ts`, `packages/opencode/script/install-jetbrains-acp.ts`,
`packages/opencode/src/acp/**`.

## Constraints honored

- Shared dirty worktree (1785 porcelain entries at recon time). No reset/clean/stash/
  restore/checkout; no stage/commit. No edits to generated `migration.gen.ts` /
  `schema.gen.ts`. No live Desktop/sidecar/JetBrains restart or install/uninstall;
  no user DB or account-token inspection.
- Per operator follow-up, **no OXP/external AppData temp paths are used**: every
  disposable build, fixture DB, report, and pid file lives under this lane's
  `.work/` directory (git-ignored via lane `.gitignore`).
- Provider network avoided: lifecycle and cancellation use only a bounded
  localhost stall mock; no real provider/key is contacted. Host env strips
  `OPENCODE_*` overrides and `*_API_KEY/_TOKEN/_SECRET/_PASSWORD` variables.
- Host-free vs live-process evidence is labeled per item.

## Objective

Executable RED→GREEN certification of the packaged Bun `--compile` OpenFork
executable as a real ACP host on disposable file-backed SQLite: NDJSON
`initialize -> session/new -> session/close`, writer/read lock release,
cancellation, crash recovery, 1/3/6 concurrent hosts, default vs sync opt-out,
metrics (p50/p95/p99, throughput, responsiveness, RSS/CPU, failures), DB
integrity, and an owner-ready fix proposal for the packaging defect found.

## Reconnaissance

1. Read root/package/test/core `AGENTS.md`, `docs/map/README.md`,
   `docs/architecture/sqlite-acp-concurrency.md`, and both 2026-10-11 SQLite
   research documents; cross-read E-lane acceptance ledger (read-only).
2. Git precheck: `packages/core/src/database/*` dirty/untracked (other owner);
   `script/build.ts`, `install-jetbrains-acp.ts`, `src/acp/service.ts` dirty
   (other owners); target lane directory did not exist.
3. Packaged build path: `script/build.ts --single --skip-install
   --skip-embed-web-ui`, redirected through `OPENFORK_BUILD_OUTPUT_DIR`;
   `MODELS_DEV_API_JSON` avoids models.dev network/cache writes;
   `OPENCODE_TEST_HOME` keeps the pipeline's own smoke logs inside the lane.
   Pre/post build inventory (git status hash + critical file hashes) proved no
   tracked/generated file changed (`packages/core/src/database/database.ts`
   etc. untouched).
4. ACP entry `src/cli/cmd/acp.ts` starts an internal HTTP server on
   `127.0.0.1:0`; stdout is reserved pre-bootstrap in `src/index.ts`.
5. Driver defaults (current source): file-backed Bun primary writes default to
   the async worker (`database.ts:391`), interactive reads default async
   (`:380`); read-only scan lanes route to the killable subprocess
   (`sqlite.bun-worker.ts:152`); **control (`database.ts:263`) and `PRAGMA
   optimize` (`:493`) hard-select `asyncWorker: true`** regardless of the
   documented opt-out envs.

## RED — packaged executable cannot open its embedded SQLite worker

Committed parent `95543517ae1a92780a68c96da62ca447d010adff` + working tree.

1. The real packaging pipeline's own capability smoke (packaged binary
   `.work/builds/default-1/.../openfork.exe`, 153,221,120 bytes, sha256
   `2e6dac856e973dcec27be545a63ea4ab7a750297ecf43115fb1ee1f8fd13b8eb`) failed:
   `Compiled OpenFork failed to bootstrap the isolated ChunkDB capability
   fixture. exit: 1 — Error: Unexpected error / Failed to open Bun SQLite worker`.
2. Real ACP NDJSON smoke (lane harness) against that binary, default driver:
   the process **exits 1 during startup before answering `initialize`** with the
   same message (`smoke-default.json`: initialize fail, exit.code 1).
3. Documented opt-out (`OPENFORK_SQLITE_ASYNC_PRIMARY=0`,
   `OPENFORK_SQLITE_ASYNC_READ_WORKER=0`) **does not avoid the defect**: control
   lane + `PRAGMA optimize` still select the embedded worker. Real ACP smoke
   with opt-out: same exit-1 crash (`smoke-optout.json`); `session list` with
   the same env also exits 1 with the same message (manual run).
4. Cause chain captured with the real production client compiled standalone
   (`probe/compile-probe.ts`, both `splitting` true/false):
   `Cannot find module 'B:\~BUN\root\sqlite-bun-worker.ts'` →
   `BuildMessage: ModuleNotFound resolving "B:\~BUN\root\sqlite-bun-worker.ts"
   (entry point)` → worker `error` event. Source mode is GREEN
   (same probe, exit 0), so this is a compilation/packaging defect, not native
   SQLite open and not fixture env.

### Root cause (verified, not inferred)

Probe matrix (all lane-local, binaries under `.work/probe/`):

- Bun 1.4.3 embeds **additional `Bun.build` entrypoints at their path relative
  to the effective build root** (default root = common ancestor of entrypoints;
  `packages/` for build.ts's entrypoint set), with `.js` extension.
  App-mode embedded-FS listing (`probe/embed-list*.ts`,
  `probe/build-parity-layout-probe.ts`):
  - default naming, build.ts-parity layout: root listing contains
    `..\core\src\database\sqlite-bun-worker.js` (literal `..` path) and
    `script\...\worker.js`; **no** `sqlite-bun-worker.js` at root.
  - `naming: { entry: "[name].[ext]" }`: root listing =
    `["layout-naming", "worker.js", "sqlite-bun-worker.js"]`; root
    `sqlite-bun-worker.js` exists (4286 bytes).
- The production client resolves `new URL("./sqlite-bun-worker.ts",
  import.meta.url)` at runtime against the embedded root, so it seeks
  `$bunfs/root/sqlite-bun-worker.ts` (+ extension substitution). The nested or
  literal-`..` embedded path is unreachable → module-not-found.
- Not a call-shape issue: inline `new Worker(new URL(...))`, module-const URL,
  `.href`, imported-module vs entry-module, and cross-directory topology were
  all tested (`probe/shape-probe.ts`, `probe/cross-probe.ts`,
  `probe/variable-probe.ts`, `probe/docs-layout-probe.ts`). Same-dir worker
  layouts GREEN; nested/out-of-root layouts RED. `.href` is invalid in 1.4.3.
- `files:` injection does **not** materialize a worker-resolvable file
  (`probe/files-fix-probe.ts`, `probe/embed-list-probe.ts`).
- Function-valued `naming.entry` is rejected by Bun 1.4.3 (targeted rename is
  not available).

## GREEN — verified fix (owner patch simulated in-harness only)

`probe/naming-fix-probe.ts` with the **real production client + worker**:
`naming: { entry: "[name].[ext]" }` produced a working compiled worker in all
build.ts-parity variants (minify, splitting, conditions `["bun","node"]`) —
real SQL round-trip `{"stage":"ready","ok":true}` / `{"stage":"query","ok":true,
"rows":[{"id":7}]}`, exit 0. Binaries (sha256, first 16): `naming-prod`
`5bcab890487965ee`, `naming-prod-split` `3d6ea7a0e0ead535`,
`build-parity-naming` `e60b4bcc85c4fbe9`; control RED variant exit 2.

TUI impact: with entry basenames collapsed, `new Worker("./worker.js")` and
`new Worker("./worker.ts")` both resolve the collapsed `worker.js`
(`probe/string-naming-probe.ts`, exit 0). The owner patch therefore also updates
`OPENCODE_WORKER_PATH` to `./worker.js`. Full proposed diff:
`proposals/build-ts-embedded-worker-fix.md`.

**Full-app fix simulation** (`probe/full-app-fix-probe.ts`): the real CLI was
compiled in-harness with `naming` + collapsed worker define, web UI skipped,
into `.work/builds/fixed-20261011150634707-238452/.../openfork.exe`
(153,228,288 bytes, sha256
`50e9e157404c250334d2a827a319af778f9a4758de42e16308034331c55bb8d3`, `--version`
exit 0, 5.6 s warm compile). **build.ts itself was not edited.**

### Concurrent hosts (1/3/6) — default driver — PASS

`hosts-fixed-default.json` (one shared WAL DB per config, 6 rounds/host plus one
forced-busy session): exact session counts 7/7, 19/19, 37/37; failures 0; walls
13.9 / 16.5 / 21.8 s; throughput 0.50 / 1.15 / 1.70 completed rounds/s
(cold-start dominated).

- `session/new` p50 349/346/440 ms (n=1/3/6) with p95 up to ~3.3 s — first-write
  bootstrap plus 3/6-way concurrent migration on a fresh DB; `session/close` p50
  10.5/12.8/16.3 ms; `session/list` p50 14.2/8.2/12.5 ms.
- Native-busy window (external `BEGIN IMMEDIATE` held 750 ms): `session/new`
  completed at 778/783/794 ms; responsiveness probes during the hold p95
  56.5/45.7/60.3 ms, max ≤ 71 ms, p50 6.9-20.9 ms. Negative invariants: zero
  request timeouts, zero stranded permits, all hosts exit 0, integrity ok.
- RSS/CPU sampled per pid via one shared PowerShell sampler; RSS maxima remain
  unverified upper bounds (PID-reuse caveat above).

### Sync opt-out comparison — same binary, fresh identical fixtures, sequential

`hosts-fixed-optout.json`: PASS at 1/3/6 (7/7, 19/19, 37/37); walls 12.7 / 15.3 /
19.7 s; throughput 0.55 / 1.25 / 1.87 rounds/s. Difference vs default ≤ ~12% in
this cold-start-dominated workload (sync marginally faster). Native-busy
responsiveness tails are worse for opt-out, consistent with synchronous writer
waits occupying the host event loop: hold-window probes p50 77 ms / p95 136 ms
(n=1; default 6.9/56.5) and p95 257 ms at n=6 (default 60.3), yet every request
still completed without deadlock.

**Do not conflate these numbers with the historical 100-session 17.76 → 12.49/s
experimental drop.** That was a different (100 fake-provider session) workload
state; this lane measured a lifecycle-only ACP workload and reports its own
exact figures only. No comparable throughput regression was measured here.

### Crash recovery — PASS

`crash-fixed.json`: mid-life SIGKILL (after initialize + session/new) → kill
observed, writer lock released (independent probe ok), integrity ok, fresh host
recovered on the same DB and completed a full lifecycle (exit 0). Startup
SIGKILL at 750 ms → no DB file had materialized; fresh host cold-booted clean.

Correction recorded: an initial startup-variant FAIL was a **harness artifact** —
the pre-recovery writer probe created `cert_external_probe` in a still-empty
DB, so the fail-closed guard `migration.ts:243` ("Database is not empty and has
no session table") correctly refused it. The harness now probes only after the
schema exists (`probe/startup-kill-inspect.ts` proved the killed host left no DB
file). No product defect is claimed from that artifact.

### Artifact hygiene

The RED pipeline binary (`2e6dac85…`, `.work/builds/default-1`) and all probe
binaries were deleted after hashing to bound disk use (`.work` 3.9 GB → 146 MB);
they are reproducible from the harness commands in `README.md`. The GREEN
fix-simulation binary (`50e9e157…`) and all JSON reports are retained.

## Packaged ACP certification — fixed binary

### Single-host lifecycle (`smoke-cert.ts`, default driver) — PASS 16/16
`smoke-fixed-default.json`:
- `initialize` protocolVersion 1 + agentInfo; `session/new` sessionId +
  configOptions; `session/close`; stdin-EOF exit 0; stdout 100% JSON NDJSON.
- Independent external writer probe `BEGIN IMMEDIATE` succeeded while the host
  was alive (15.7 ms, busy_timeout 3 s) → writer reservation released.
- Protocol cancellation of an idle session survived and stayed responsive.
- **Real in-flight prompt cancellation**: prompt held by the bounded localhost
  stall mock; `session/cancel` produced `{"stopReason":"cancelled"}` (1.05 s);
  `session/update` notifications only.
- Post-exit `PRAGMA integrity_check` = ok, `foreign_key_check` clean,
  `session` table present, fixture directory removed (handle release proof).
- Latencies (n=1): initialize 7590 ms (cold compiled start + first bootstrap),
  session/new 3356 ms (first-write schema bootstrap), session/list 9.4/9.9 ms,
  session/close 1308 ms; client event-loop lag p50 0.84 ms / p95 1.17 ms.
- **RSS caveat:** the PowerShell sampler reported rssMax 2.31 GB for a ~13 s
  lifecycle (first sample 81 MB). PID reuse after process exit can inflate the
  maximum; treat RSS maxima in these reports as unverified upper bounds until
  the sampler drops post-exit samples (tracked in "Outstanding").

Sync opt-out single-host lifecycle also PASS 16/16 including real prompt
cancellation (`smoke-fixed-optout.json`).

Typecheck evidence: scoped `tsgo` over all 53 lane files (harness, libs, probes,
fixtures) = **0 errors**; the lane adds only untracked files (`git diff --name-only`
for lane paths is empty).

### RED control

Same harness against the un-fixed pipeline binary (default driver) fails at
startup exit 1 with `Failed to open Bun SQLite worker`
(`smoke-default.json`), and opt-out crashes identically (`smoke-optout.json`).

## Evidence index

| Artifact | Meaning |
| --- | --- |
| `.work/reports/smoke-default.json` | RED: un-fixed packaged binary, default driver |
| `.work/reports/smoke-optout.json` | RED: un-fixed packaged binary, sync opt-out |
| `.work/reports/smoke-fixed-default.json` | GREEN: fixed simulation binary, 16/16 |
| `.work/reports/smoke-fixed-optout.json` | GREEN: fixed simulation binary, sync opt-out, 16/16 |
| `.work/reports/hosts-fixed-default.json` | 1/3/6 concurrent hosts, default driver, PASS |
| `.work/reports/hosts-fixed-optout.json` | 1/3/6 concurrent hosts, sync opt-out, PASS |
| `.work/reports/crash-fixed.json` | hard-kill recovery (mid-life + startup), PASS |
| `probe/*` | embedding bisection + fix verification (see README) |
| `proposals/build-ts-embedded-worker-fix.md` | owner-ready two-hunk patch proposal |

Build guard evidence: pre/post pipeline inventory hashes recorded under
`.work/proof-*` equivalents noted in session logs; the packaging pipeline in
this lane only ever wrote under `.work/builds/`.

## Outstanding / owner handoff

1. Apply + re-run the real `script/build.ts` `naming`/`OPENCODE_WORKER_PATH`
   patch (owner: build.ts owner) and re-run `smoke-cert --build` against the
   resulting pipeline artifact. This lane certified a **fix simulation**
   (full CLI compiled in-harness, web UI skipped), not a pipeline build.
2. Real TUI worker launch must be confirmed in an interactive terminal after the
   `OPENCODE_WORKER_PATH` collision change (not exercised by this lane).
3. Sampler post-exit PID-reuse filtering for trustworthy RSS maxima.
4. Concurrent-lane note: `packages/opencode/src/fork/credentials.ts` changed
   during this session (13,870 → 23,731 bytes, mtime 14:49 UTC) — that is lane
   A's owned work, not lane C; all other guarded files were hash-verified
   unchanged across this lane's builds and test runs.
5. Installed JetBrains runtime and the user's real DB were never touched.
