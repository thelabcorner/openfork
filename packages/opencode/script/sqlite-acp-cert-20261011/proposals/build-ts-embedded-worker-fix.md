# Owner-ready patch proposal — packaged Bun worker embedding (build.ts)

Status: **verified RED→GREEN in an isolated harness; NOT applied** (build.ts is
another owner's dirty file and lane C does not edit it).

## Defect

`script/build.ts` compiles the CLI with `Bun.build({ compile })`. Additional
entrypoints are embedded at their path **relative to the effective build root**
(without an explicit `root`, the common ancestor of the entrypoints). For the
current entrypoint set, that root is `packages/`:

```
entrypoints: ["./src/index.ts", "./src/cli/tui/worker.ts", "../core/src/database/sqlite-bun-worker.ts"]
effective root: packages/
embedded:      $bunfs/root/sqlite-bun-worker.js … NO
               $bunfs/root/../core/src/database/sqlite-bun-worker.js … literal ".." path
               $bunfs/root/opencode/src/cli/tui/worker.js … (insufficient for TUI too)
```

Meanwhile `packages/core/src/database/sqlite-bun-worker-client.ts` launches
`new Worker(new URL("./sqlite-bun-worker.ts", import.meta.url))`. In a compiled
binary the resolution base is the embedded root, so the runtime seeks
`$bunfs/root/sqlite-bun-worker.ts` (`.js` via extension substitution). It is not
there → `Cannot find module 'B:\~BUN\root\sqlite-bun-worker.ts'` →
`Failed to open Bun SQLite worker` → the packaged Windows executable exits 1 at
startup for **every** file-backed lane that selects the async worker (primary by
default, control lane and `PRAGMA optimize` unconditionally).

Verified embedded-FS listings (probe: `probe/build-parity-layout-probe.ts`):

- default naming: worker entry embedded at a literal `..\core\src\database\sqlite-bun-worker.js`; no file at `sqlite-bun-worker.js`.
- `naming: { entry: "[name].[ext]" }`: `B:/~BUN/root` = `["layout-naming", "worker.js", "sqlite-bun-worker.js"]`; root `sqlite-bun-worker.js` exists.

## Owner patch (two hunks in `packages/opencode/script/build.ts`)

```diff
       minify: true,
       sourcemap: sourcemapsFlag ? "linked" : "none",
       splitting: true,
+      // Additional entrypoints are embedded at their path relative to the build
+      // root; the compiled worker URL `./sqlite-bun-worker.ts` resolves at the
+      // embedded root, where a nested (or literal `..`) path is unreachable.
+      // Collapse entry names to basenames so the worker lands at the root.
+      naming: { entry: "[name].[ext]" },
       compile: {
```

```diff
-      OPENCODE_WORKER_PATH: workerPath,
+      // Matches the basename-collapsed TUI worker emitted by naming.entry.
+      OPENCODE_WORKER_PATH: "./worker.js",
```

`workerPath` remains the TUI entrypoint specifier; only the runtime define that
the TUI passes to `new Worker(file)` changes. `"./worker.js"` and `"./worker.ts"`
were both verified to resolve the basename-collapsed worker
(`probe/string-naming-probe.ts`, exit 0 both).

### Required owner follow-up

- Re-run the real packaging pipeline and the full ACP lifecycle
  (`bun run script/sqlite-acp-cert-20261011/smoke-cert.ts --build`).
- Launch the real TUI once: `OPENCODE_WORKER_PATH` is collapsed, so a real TUI
  worker launch (`new Worker("./worker.js")` in compiled mode) must be confirmed
  in an interactive terminal.
- Confirm no other additional entrypoint expects its original nested name.

## Evidence

- RED (current settings): `probe/compile-probe.ts`, `probe/root-gradient-probe.ts`,
  `probe/build-parity-layout-probe.ts` — real client + worker, compiled,
  `Cannot find module 'B:\~BUN\root\sqlite-bun-worker.ts'`, exit 2.
- GREEN (naming applied, build.ts-parity options incl. splitting + conditions):
  `probe/naming-fix-probe.ts` variants `naming-prod`, `naming-prod-split`,
  `build-parity-naming` — real SQL round-trip, exit 0. Binary SHA-256 recorded in
  the journal.
- Not a call-shape issue: inline vs variable `new Worker(...)` and entry/main
  directory topology do not change the outcome (`probe/shape-probe.ts`,
  `probe/cross-probe.ts`, `probe/variable-probe.ts`).
- `files:` injection does not materialize a worker-resolvable file
  (`probe/files-fix-probe.ts`, `probe/embed-list-probe.ts`).
- Function-valued `naming.entry` is rejected by Bun 1.4.3 (a targeted
  sqlite-worker-only rename is therefore not available).

## Residual risk

The env opt-outs `OPENFORK_SQLITE_ASYNC_PRIMARY=0` and
`OPENFORK_SQLITE_ASYNC_READ_WORKER=0` do **not** avoid the defect: the control
lane (`packages/core/src/database/database.ts:263`) and the `PRAGMA optimize`
maintenance connection (`:493`) hard-select `asyncWorker: true`. Do not treat
the opt-outs as a shipping workaround for the packaged binary.
