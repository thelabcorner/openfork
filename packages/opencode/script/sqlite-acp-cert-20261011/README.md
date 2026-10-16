# sqlite-acp-cert-20261011 — packaged ACP certification harness (Lane C)

Self-contained CI/bench harness certifying the **packaged Bun `--compile` OpenFork
executable** as a real ACP host against disposable file-backed SQLite databases.
Owned by lane C; see `docs/research/sqlite-delegations-20261011/C-acp-runtime.md`.

Everything disposable is written under this directory's `.work/` (git-ignored).
No user database, installed JetBrains runtime, or OS temp directory is used.

## Prerequisites

- Bun 1.4.3 (repo toolchain) on Windows x64 for the compiled-binary path.
- A packaged binary. Either provide one (`--binary`) or run the real pipeline
  (`--build`; redirected via `OPENFORK_BUILD_OUTPUT_DIR` into `.work/builds`,
  `--skip-install`, `--skip-embed-web-ui`, cached `MODELS_DEV_API_JSON`).
- No provider network: the config points at a bounded local stall mock
  (`lib/stall-llm.ts`) for the cancellation phase.

## Commands

```powershell
# Single-host lifecycle: initialize -> session/new -> session/close,
# lock release, cancellation, EOF exit, DB integrity.
bun run smoke-cert.ts --binary <path-to-openfork.exe> --driver default --stdout-json --report .work/reports/smoke-default.json

# Compare the documented sync opt-out on the same binary.
bun run smoke-cert.ts --binary <path> --driver optout --report .work/reports/smoke-optout.json

# 1/3/6 concurrent hosts sharing one WAL database, both drivers sequentially.
bun run hosts-cert.ts --binary <path> --matrix 1,3,6 --rounds 6 --drivers-both --report .work/reports/hosts.json

# Hard-kill recovery (mid-life + startup kill) and fresh-host reuse.
bun run crash-cert.ts --binary <path> --report .work/reports/crash.json
```

## What is measured

- Per-method ACP latency p50/p95/p99 (initialize, session/new, session/close,
  session/list probes, forced-busy session/new).
- Throughput (completed rounds/s) per driver/host-count configuration.
- Protocol responsiveness: `session/list` probe RTT while N hosts are live and
  during a forced external writer-lock hold (native-busy event-loop proxy),
  plus the client harness event-loop lag.
- Per-process RSS/CPU via one shared PowerShell sampler (`lib/sampler.ts`).
- Failure counts per method; stdout protocol cleanliness (every line JSON).
- Cross-host DB integrity: `PRAGMA integrity_check`,
  `PRAGMA foreign_key_check`, exact `session` row count vs expected.
- File-handle release: fixture removal after process exit (Windows EBUSY check).

## Driver configurations

- `default`: current source defaults (async primary + async interactive +
  killable scan subprocess).
- `optout`: `OPENFORK_SQLITE_ASYNC_PRIMARY=0` and
  `OPENFORK_SQLITE_ASYNC_READ_WORKER=0`. **Not a complete workaround**: the
  control lane and `PRAGMA optimize` still select the async worker unconditionally.

Runs for different drivers never share a fixture and never run concurrently, so
their metrics are comparable.

## Diagnostic probes (compiled-worker embedding investigation)

`probe/` contains the RED→GREEN bisection used to locate the packaged worker
launch failure and to verify the owner patch proposal
(`proposals/build-ts-embedded-worker-fix.md`):

- `compile-probe.ts` — real client/worker compiled; cause-chain capture.
- `docs-layout-probe.ts`, `cross-probe.ts`, `variable-probe.ts`, `string-naming-probe.ts` —
  Bun standalone worker launch-form/layout matrix.
- `root-gradient-probe.ts`, `build-parity-layout-probe.ts`, `embed-list-probe.ts` —
  embedded-root/path mapping inside compiled binaries.
- `files-fix-probe.ts` — disproves `files:` materialization for workers.
- `naming-fix-probe.ts` — verified fix: `naming: { entry: "[name].[ext]" }`.
- `full-app-fix-probe.ts` — full CLI compiled with the fix simulated in-harness
  (web UI skipped), used for end-to-end ACP certification of the fix.

All probes write only under `.work/`; run with `--keep` to retain artifacts.
