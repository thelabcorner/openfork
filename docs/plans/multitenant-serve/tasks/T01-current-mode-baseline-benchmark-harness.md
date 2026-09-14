# T01 - Current per-session baseline benchmark harness

**Lane:** benchmark / evidence  
**After:** nothing  
**Unlocks:** T12, T14, T18 performance comparison  
**Primary repos:** PresGen, with OpenFork instrumentation only if necessary  
**Architecture refs:** sections 17, 29, 30.0, production performance gates

## Objective

Build a repeatable benchmark harness for PresGen's current per-session runtime
before shared mode changes the topology.

The result is the control group for every later density/performance claim.

## Required workloads

Measure at least:

```text
1, 5, 10, 25, 50, 100 live sessions
```

If the existing 100-port allocator prevents a 100-session run, that ceiling is
itself baseline evidence. Record it rather than changing the allocator here.

Run four workload families:

1. **Idle residency**: sessions started and healthy, no active turns.
2. **Interactive light**: short fake/mock provider turn with event streaming.
3. **Concurrent burst**: many sessions start a turn at nearly the same time.
4. **Churn**: repeatedly start/use/stop sessions to expose process, socket,
   dentry, WAL, and cleanup behavior.

Use a deterministic local/mock provider path where possible so network/provider
variance does not dominate the server-runtime measurement.

## Owned surfaces

Prefer new benchmark-only paths, for example:

- `backend/tests/performance/opencode/`
- `backend/scripts/bench_openfork_sessions.py`
- `docs/plans/multitenant-serve/benchmarks/`

If OpenFork needs lightweight metrics/probes, keep them read-only and
production-safe. Do not optimize runtime behavior in this task.

## Metrics

Mandatory per sample:

### Process/container

- sandbox total RSS
- OpenFork/OpenCode process RSS distribution
- process count
- thread count if available
- open FD count
- TCP connection/socket count
- CPU idle and active utilization
- event-loop delay if available without invasive patching

### Session lifecycle

- supervisor `/start` latency
- server-ready latency
- PresGen session create latency
- first message enqueue latency
- first event latency
- time-to-first-token/event for mock provider
- stop/cleanup latency

### Storage/runtime

- DB handles/files
- WAL size
- workspace/storage growth
- dentry/inode slab proxy if measurable from container/host
- per-session listening ports

### Streaming

- upstream OpenCode SSE connections
- downstream browser/PresGen SSE connections in harness
- events/sec and bytes/sec for a controlled token stream
- reconnect count

## Harness requirements

- deterministic configuration file/CLI arguments;
- machine-readable output (JSONL or JSON) plus a human summary;
- warmup phase separated from measured phase;
- at least 3 measured repetitions for small/medium cases;
- explicit failure representation, never silently dropping failed sessions;
- timestamped environment metadata: commit, runtime versions, host/container
  limits, binary identity;
- cleanup verification after each trial.

## Implementation steps

1. Define benchmark schema and metadata.
2. Implement single-session smoke with exact lifecycle timings.
3. Add N-session orchestrator.
4. Add resource sampler with monotonic timestamps.
5. Add idle/light/burst/churn workload modes.
6. Add graceful cleanup and leak check.
7. Produce baseline runs on the current topology.
8. Check in summarized baseline results; large raw traces may stay ignored or in
   a documented external artifact location if repository policy requires.
9. Document exact reproduction command.

## Correctness guard

A benchmark sample is invalid if:

- a session failed to become healthy;
- a mock turn did not reach terminal idle;
- cleanup left managed child processes alive;
- resource sampling failed for a meaningful portion of the run;
- the harness accidentally reused one server where the baseline expects one
  server per session.

## Analysis outputs

Compute at least:

- incremental idle RSS/session;
- incremental FDs/session;
- incremental sockets/session;
- p50/p95 startup latency by concurrency;
- p50/p95 first-event latency;
- process-count slope;
- maximum successfully admitted live sessions;
- cleanup residual after churn.

Do not fit an elaborate model unless the data justifies it. Raw percentile and
slope evidence is more valuable than a pretty chart with weak assumptions.

## Exit criteria

PASS only when:

- the harness is repeatable from a documented command;
- machine-readable baseline exists;
- 1/5/10/25 session runs complete or fail with a proven platform limit;
- 50/100 are attempted where feasible and limitations are recorded;
- resource cleanup is measured;
- T14 can later run the same workload shape against shared mode.

## Handoff

`../results/T01.md` must record:

- reproduction commands;
- baseline summary table;
- raw artifact locations;
- known measurement caveats;
- benchmark schema version;
- exact metrics T12/T14 must preserve for apples-to-apples comparison.

