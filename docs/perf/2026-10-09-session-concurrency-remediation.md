# Session concurrency: V1 hot-path remediation and safety gates

Date: 2026-10-09 (ongoing checkout work; no deployment claim)

## Architecture boundary

OpenFork runs **V1 Session execution** in `packages/opencode`, while the V2
presentation remains the product UI direction. This campaign does not turn
logical Session count into one process/port/realm per Session, bypass provider
account quotas, or raise CPU-heavy process limits. The optimization objective
is useful concurrently progressing Sessions with bounded latency and correct
resource ownership, rather than maximizing admitted-but-starved work.

See `AGENTS.md`, `packages/opencode/AGENTS.md`,
`docs/map/{README,architecture,v1-v2}.md`, and
`docs/perf/2026-10-01-performance-regression-investigation.md`.

## Verified source changes

### 1. Context overlay compilation: independent committed-state reader

Source: `packages/opencode/src/session/context/compiler.ts`.

- The V1 compiler reads `session_context_state` through Core Database's
  existing `readDb`, not the primary SQLite writer connection's single
  admission permit. The reader is `query_only` and sees only committed WAL
  history; `:memory:` already aliases the two connections.
- Select only the columns the compiler consumes. Skip decoding the duplicate
  `override_search_text` and unrelated row metadata on the provider loop.
- An empty overlay set returns a shallow-copied unmodified message sequence;
  full policy and authoritative-state checks still run when overlays exist.
- No Session-local cache, invalidation side channel, per-Session timer or new
  workspace Instance. This deliberately trades an indexed, fresh committed
  read for correctness across other writers and all Session generations.

Executable gate:
`bun test test/session/context-compiler-concurrency.test.ts test/session/conversation-control.test.ts`
from `packages/opencode`. The file-backed case holds an IMMEDIATE writer
transaction open while 32 independent Session context reads must complete.
The conversation-control tests prove exclude/edit/restore and signed
reasoning/authoritative-state behavior continue to work.

Synthetic microbenchmark (Windows/Bun, 2,000 messages, 200 compilations per
round, 9 rounds): empty-map full `compile()` traversal median 5.119 ms per
round versus shallow copy 1.073 ms per round (about 4.77x). This measures only
in-memory compilation overhead, **not** provider throughput or end-to-end
Session latency. The 32-session WAL-reader regression took approximately
224 ms including test database setup and cleanup; it is a correctness/isolation
gate, not a standardized throughput result.

### 2. Environment prompt avoids unnecessary location graph

Source: `packages/opencode/src/session/system.ts`.

The System prompt now checks the already cached effective Config references
before starting location-scoped Reference services. Missing/empty reference
config uses the no-reference render path directly, matching the preexisting
`Agent.state` guard. Real configured references retain the existing path.
Test: `bun test test/session/system.test.ts`.

### 3. Trusted interactive delegated turn retains protected route

Source: `packages/opencode/src/session/prompt.ts`.

An interactive user-authored turn with no explicit model selection inherits
the delegated producer's protected route intent at the trusted admission
boundary. An explicit composer selection **never** inherits the producer's
route, preserving turn provenance, human intent and per-account capacity
classification. Durable producer Session metadata remains unchanged.

Focused tests in `test/session/prompt.test.ts`:
`--test-name-pattern "interactive delegated-worker conversation"` and
`--test-name-pattern "a human model selection overrides"`, both passed.

### 4. CPU-heavy process budget cannot fork on live config changes

Source: `packages/opencode/src/tool/heavy-process-concurrency.ts`.

A process-global semaphore/permit count is now selected once while active.
Changing `OPENCODE_MAX_CONCURRENT_HEAVY_TOOLS` cannot replace the semaphore
under existing holders, which would otherwise make new Sessions over-admit CPU
work into a second local budget and desynchronize the global Flock slot count.
The deliberate test reset requires quiescent callers. Existing heavy/I/O/quick
isolation and conservative maximum (4 heavy process trees) remain intact.
Test: `bun test test/tool/shell-concurrency.test.ts` (13/13 passed, including
the dynamic-capacity ownership regression).

## Known non-green gates; do not claim universal concurrency parity

The exhaustive `test/session/prompt.test.ts` run finished **95 pass, 14
skip, 11 fail**. Specific failures included Goal Mode live-tool verification
preemption, orphan-owner takeover, SPAD repetitive output behavior, and
queued shell/prompt interruption assertions. Three cases were reproduced in
isolated runs, so these failures cannot all be attributed to test parallelism.
They require separate root-cause/correctness investigations, especially before
claiming cancellation/fairness dominance. Do not raise limits or weaken
authorization/recovery fencing to make these tests green.

The two previously created handoff workers were **not** successful handoffs:
one OXP atomic-settlement worker failed with an unavailable endpoint; the
other V1-concurrency worker blocked on an external-directory permission.
Neither is evidence of an implemented change.

All four changed V1 paths passed `bun run typecheck` in
`packages/opencode` after the scoped changes. Nothing here was deployed,
committed or hot-reloaded into the running OXP process. Live 10/25/50/100
concurrent provider streams, actual account-local permit lifetime, p50/p95/
p99 TTFT, cancellation-to-reclamation latency, and Electron frame/heap
responsiveness still need instrumented production-like tests.

## Next evidence gates, in order

1. Reconcile isolated Goal and orphan-owner test failures to durable ownership
   fences and real tool-abort propagation; do not resurrect an unknown worker.
2. Measure mixed Session streams by provider/account, with a full-lifetime
   permit fence, per-account capacity, cancellations and starvation probes.
3. Measure writer lock time and queue wait while 10/25/50/100 Sessions
   concurrently compile history and settle tool/turn state.
4. Revisit scheduling fairness and renderer backpressure only after attributing
   p95/p99 tails to queues versus provider/network/tool execution.