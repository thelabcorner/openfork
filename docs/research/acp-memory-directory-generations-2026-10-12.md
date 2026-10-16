# OpenFork ACP memory and directory-generation hardening — 2026-10-12 UTC

## Product authority

Read repository `AGENTS.md`, `packages/opencode/AGENTS.md`,
`packages/opencode/src/acp/AGENTS.md`, and
`docs/map/v1-v2.md`. V1 remains the supported production session runtime.
ACP is a transport adapter; provider/agent resolution is owned by the
location-bound instance loader and its canonical snapshots. Nothing in this
campaign changes V1 tool authority, authorization or the model catalog's
source of truth.

## Failure discovered: stale directory generation

The ACP directory service caches lazy Effect computations per directory
using a synchronized map. An old in-flight `get(directory)` may overlap
`refresh(directory)`. Previously:

- If the older loader **failed** after the refresh succeeded, its
  `tapError` callback unconditionally deleted `directory` from the map,
  deleting a newer, valid generation. Subsequent ACP sessions then
  redundantly bootstrap expensive provider/agent catalogs.
- If the older loader **succeeded** after the refresh, an in-flight getter
  returned stale provider/mode/command configuration after the new
  generation had become authoritative.

**Correction in `packages/opencode/src/acp/directory.ts`:** failed loaders
remove only their *own* cached Effect object when its identity still
matches the map entry. `get` checks the current generation after the
computation settles, following an intervening refresh. At most three
generations are observed; repeated refresh churn fails closed with an
ACP service failure instead of looping indefinitely. Different directory
keys remain independently cached. The new logic does not repeat an
arbitrary SDK write, impersonate a Session identity, or bypass the
canonical instance loader.

New adversarial tests in `test/acp/directory.test.ts` prove both
old-failure-after-refresh and old-success-after-refresh, with cache
identity preserved and exactly two loader invocations. A third negative
test checks that failure of the *currently authoritative* load still
evicts that specific generation, allowing a later get to retry.
Selected ACP directory, session service, event and tool tests:
**83 passing, 0 failures across four files**, 231 assertions.
The wider OpenCode typecheck still reports 32 errors outside changed paths.

## Real compiled Windows ACP memory attribution

Earlier Windows process sampling showed ~2.15–2.32 GiB of working set for
a **single compiled ACP host**. Causality was not established.
This campaign added an opt-in diagnostic at
`packages/opencode/src/acp/profile.ts`:
`OPENFORK_ACP_MEMORY_PROFILE=1` activates
`rssMiB`, `heapMiB`, `heapTotalMiB`, `externalMiB`,
and `arrayBuffersMiB` on ACP markers, plus one unreferenced timer
sample per second. None of these allocations/timers runs without
the opt-in flag. `packages/opencode/src/cli/cmd/acp.ts` emits EOF and
HTTP-server stop markers, while `packages/opencode/src/server/server.ts`
adds scoped, opt-in transport/Scope.close phase markers. All output is
on stderr; ACP stdout remains protocol-only.

Reproducible disposable-fixture profiler:
`bun run script/sqlite-acp-cert-20261011/memory-cert.ts --binary <path>`.
It uses the actual compiled executable, independent OS process memory
sampling, real ACP initialize/new/close/EOF, and a disposable local-only
SQLite fixture. It reports phase timing and sampler series. No production
database is read or touched.

### Measured observations (Windows x64, Bun 1.4.3)

Representative compiled-host measurements, not a statistical
distribution:

| Phase | RSS MiB | Live JS heap MiB | Heap capacity MiB |
| --- | ---: | ---: | ---: |
| ACP command handler started | ~628–958 | ~367–374 | ~437–641 |
| Listener created / ACP initialized | ~1014–1153 | ~648–651 | ~752–893 |
| Provider-directory load settled | ~1030–1162 | ~723–726 | ~759–888 |
| Session closed; **before** HTTP stop | ~985–1124 | ~727–728 | ~756–880 |
| **After** `Scope.close` during shutdown | ~2281–2305 | ~727–728 | ~2027–2036 |

A repeat build/run without invasive finalizer wrappers recorded 7.23 s
to ACP initialize, another 3.09 s to create the first Session, and
2.84 s between ACP stdin EOF and process exit. The independent OS
sampler measured **2204 MiB** peak; direct JavaScriptCore readings
reached ~2291 MiB during scope close. Sampled working sets and
in-process readings are different observations at different instants,
not interchangeable numbers.

The RSS expansion occurs **after stdin EOF** inside
`Server.listen(...).stop(true)`, and specifically after force-closing
sockets has already succeeded but during
`Scope.close(state.scope, Exit.void)`.
The root scope had **two** finalizers. Instrumenting the two
finalizer boundaries on a disposable build attributed most of the
expansion to the earlier-registered layer finalizer: finalizer 1
completed with no significant RSS change; finalizer 0 spanned an
increase from roughly 1003 to 1709 MiB RSS. However this
instrumentation itself perturbed memory timing and peak, so its peak
numbers are not a valid baseline comparison. The finalizer wrappers
were **removed** after the diagnostic run; finalizer semantics remain
untouched. The existing Effect runtime is
`effect@4.0.0-beta.83` and any runtime upgrade needs independent
compatibility gates; this experiment does not establish an upstream
bug as its cause.

The live JavaScript heap stayed almost constant (~727 MiB) while the
capacity increased by ~1.2 GiB. This is evidence of substantial
allocator activity during Effect-layer teardown, **not proof that
1.2 GiB of session objects leak or remain live**. Closing a short-lived
process frees its OS working set anyway. Do not attempt an unsafe
fix by dropping `Scope.close` or forcibly skipping finalizers:
correct resource cleanup and file-handle release have greater
priority than cosmetically lowering an exit-time memory sample.

### Remaining frontier

1. Attribute the earlier **~650 MiB** listener-initialization live
   heap to specific package/module graphs (before `session/new`).
   The model catalog JSON on disk is only ~5.4 MB, so claiming the
   entire 650 MiB is the catalog would be unjustified.
2. Measure the root layer's nested finalizer group without modifying
   finalizer order, using CPU profiling or Effect tracing. Determine
   whether upgrading the currently pinned Effect v4 beta runtime to
   stable changes the behavior; do not make a monorepo-wide version
   change without isolated differential correctness tests.
3. Benchmark **warm** ACP sessions and the actual JetBrains/Electron
   subprocess path; startup-dominated one-host tests do not prove
   1/3/6 concurrent agent execution or sustained-memory growth.
4. Keep default diagnostics off and compare heap used versus heap
   capacity versus OS working set separately.

## Validation/status caveats

- 83/83 ACP focused tests passed after the generation-race correction.
- The compiled ACP memory harness used only isolated disposable
  databases. ACP stdout violations were zero; exit code was zero.
- OpenCode's full typecheck retained 32 errors in unrelated paths,
  none identified in these modified ACP source files.
- Active OXP host was not refreshed or redeployed. No production
  database, stored Session or consumer plugin was changed.
- The instrumented disposable Windows executable (~146 MiB) was
  removed after the profiling campaign. The canonical repository
  checkout and live running binaries were not replaced.
- Bun documents `--smol` as a memory-vs-GC-throughput trade-off and
  permits it on compiled binaries, but it was **not validated** in
  this campaign. Do not enable it by default without paired
  correctness/performance experiments:
  https://bun.com/docs/runtime and
  https://bun.sh/docs/bundler/executables
