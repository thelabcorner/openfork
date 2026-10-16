# LACE v14.8 — V1 checkpoint-tail search closeout

Date: 2026-10-10. Integration target: existing production V1 compaction path.
Scope: a **bounded, exact-full-suffix-estimate search** for the proven monotone
subclass of settled, plain-text assistant turns. It is **not** a general V2
checkpoint migration, a native-provider compaction implementation, or a
semantic-fidelity certification.

## Why this change

V1 `splitTurn()` historically scanned the oversized turn from oldest suffix
to newest and recomputed `MessageV2.toModelMessagesEffect(...)` plus
`Token.estimate(JSON.stringify(...))` for every candidate. For `n` long
assistant steps with the earliest fitting suffix near the end, serialization
alone processed O(n²) total message mass.

- New helper: `src/session/lace-checkpoint-retention.ts`.
- Production V1 adapter: `src/session/compaction.ts` invokes
  `firstFittingSuffix()` only if `isMonotoneTextSuffix()` holds.
- No changes to Session/Goal ownership, provider route/account selection,
  durable storage, UI, direct provider SDKs, or existing compaction checkpoints.
- Each probed suffix is measured with the **existing V1 model-message
  projection and estimator**. A candidate is returned only after its own
  cost is verified to fit; nonfinite token estimates never qualify.
- The fast path is never attempted on user/host turns, tool-bearing steps,
  signed reasoning, multimedia, synthetic parts, metadata-bearing parts,
  unfinished/error/summary messages, or empty assistant messages. Normal
  `step-start`/`step-finish` markers around nonempty text are permitted.
- All other turns retain the preexisting linear path. Provider-native opaque
  checkpoint semantics remain separate and unmodified.
- The existing unrelated transient route and checkpoint-validity edits in
  `compaction.ts` were preserved. The checkpoint caller now explicitly
  narrows assistant role before accessing `parentID`, resolving a previously
  observed local TypeScript diagnostic.

## Verification recorded

1. `bun test test/session/lace-checkpoint-retention.test.ts`: 7 passed,
   0 failed, 21,007 assertions. Includes 10,000 reproducibly seeded monotone
   cases against a full linear oracle, edge budgets, nonfinite input, 65,536
   candidate stress, negative eligibility fixtures, and 80 randomized
   histories measured with the actual V1 `MessageV2.toModelMessagesEffect`
   projection (including step-start/step-finish).
2. `bun run test test/session/compaction.test.ts`: 64 passed, 1 skipped,
   0 failed, 199 assertions (135.71s), executed after the search was first
   integrated and before refactoring the unchanged guard into a helper.
3. After extracting the identical eligibility predicate into the helper,
   the focused integrated test `retains a split turn suffix when a later
   message fits the preserve token budget` passed (1/1, 9 assertions).
4. `bun script/lace-retention-bench.ts`: isolated Bun benchmark using a
   controlled JSON message serializer rather than actual model/provider
   dispatch. Four timed samples after warmup, median:

| Synthetic assistant messages | Legacy median | LACE median | Legacy estimates | LACE estimates | Ratio |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 128 | 3.32 ms | 0.45 ms | 120 | 9 | 7.43x |
| 512 | 30.59 ms | 0.77 ms | 504 | 11 | 39.48x |
| 1,024 | 97.43 ms | 0.74 ms | 1,016 | 12 | 131.84x |

These are **isolated suffix-search measurements**, not the latency of
compaction inference or end-to-end agent Sessions, and must not be advertised
as commercial-provider performance.

## Formal limits and invariants

- Binary search requires a non-increasing estimated suffix size as the start
  moves forward. The admission predicate conservatively excludes mixed
  provider transformations; the fallback retains original behavior.
- `Token.estimate` is a heuristic of a fully projected model-message JSON
  payload, **not** exact provider-billed token usage or final signed wire bytes.
- Retention is a contiguous suffix. This change does not imply evidence
  preservation or identity-safe summary promotion.
- The complete transcript remains durable. Summary admission, replay,
  provider-native opaque state, and deferred tool execution need their own
  independently verified atomicity barriers.
- Unrelated checkout modifications, existing runtime databases, and running
  processes were not reset, cleaned, rewritten, or restarted.

## Next production gates

1. Preserve provider-native reasoning/tool-call adjacency under an atomic
   group model, then extend faster selection beyond text-only turns only after
   demonstrating monotone full-projection accounting.
2. Build independently checked checkpoints with causal source references,
   source-revision compare-and-swap, crash/restart idempotency, and a
   single-flight compaction owner.
3. Measure closed-loop multi-compaction factual/evidence fidelity with
   5–20 successive rounds and adversarial hidden dependencies.
4. Measure provider-cache and actual billed-token economics per account/route
   before enabling LACE's parent-prefix compaction optimizer.
5. Run 1/3/6/25/50/100 genuinely concurrent V1 Sessions, including SQLite
   contention, tool successes, memory, cancellation and first-token latency.
6. Resolve unrelated whole-package TypeScript diagnostics and run full release
   certification. The existing whole-package check was not green.
