# LACE v14.9 — V1 checkpoint admission and durable promotion audit

Date: 2026-10-10. Integration target: OpenFork's production V1 session execution path (not an upstream V2 runtime replacement). Status: **integrated in shared dirty checkout, uncommitted; focused gates passed, release certification pending**.

## Structural findings

1. A summary assistant with any truthy `finish` used to be treated as a completed checkpoint, even for length/tool-call/error finishes; nonblank text alone was insufficient to establish a faithful continuation.
2. A summary message could be durably written before the retained-tail boundary was determined, leaving a crash window in which historical context was hidden without a finalized checkpoint.
3. Summary chaining (`completedCompactions`), the canonical effective-history collector, and Goal STATE projection each had different definitions of checkpoint completion.
4. Retried compaction attempts with the same marker could create multiple candidate summary assistants, with no durable link selecting which was promoted.
5. Session forking remapped `tail_start_id` but not a summary ID, requiring up-front ID allocation for forward references.
6. A real V1 provider stream uses finish `stop`; historical host/test records also use `end_turn`. Both represent terminal success here; `length`, tool-calls and error do not.

## Implemented

- `packages/opencode/src/session/compaction-checkpoint.ts`: one shared conservative checkpoint admission predicate requires summary assistant, successful terminal stop/end_turn, no error, no tools/files, at least one nonignored nonempty text part. It does **not** claim semantic completeness or mandate a custom Markdown template.
- `packages/schema/src/v1/session.ts`: optional `CompactionPart.pending` and `checkpoint_message_id` as backward-compatible durable fields. Absent fields preserve legacy import semantics.
- `packages/opencode/src/session/compaction.ts`: new markers start pending. After inference, reread the durable summary and live marker, reject unready or already-superseded results before continuing, and promote the marker once with `pending: false`, exact `checkpoint_message_id` and optional `tail_start_id`. Matching previous summary for recursive compaction now honors marker promotion and committed candidate identity. The supersession read is explicitly not a DB CAS.
- `packages/opencode/src/session/message-v2.ts`: both effective-history filtering and Goal STATE-reset discovery require a usable summary, promoted marker, and exact checkpoint match where the pointer is present. Discard abandoned assistant checkpoint candidates from the promoted effective window. If promotion never occurs, preserve previous history.
- `packages/opencode/src/session/session.ts`: preallocate child message IDs so forward/backward compaction references can be remapped during fork. If a referenced ID is excluded/unmapped, forked marker fails closed as pending rather than pretending the source ID is valid.
- V1 reversible tool-output pruning now uses the same admitted-and-promoted checkpoint boundary as summary chaining. A partial/pending summary no longer prematurely stops pruning.
- V1 compaction mocked processor now persists a synthetic successful summary (matching the real processor contract), rather than returning success without writing anything.
- New checkpoint-admission, repeated-boundary, provider-inference, fork, and STATE-projection regressions.

## Measured verification

- `bun test test/session/compaction-checkpoint.test.ts`: **10 passed**, 77 assertions; including 20 consecutive structural checkpoints, incomplete outputs, bad parts, a pending marker with an old tail pointer, stale candidates, and legacy compatibility.
- `bun test test/session/lace-checkpoint-retention.test.ts`: **7 passed**, 21,007 assertions; preserving the v14.8 logarithmic suffix-selection invariants.
- Real V1 provider-stream integration: **positive marker promotion** passed (5 assertions); **empty checkpoint rejection** passed (7 assertions).
- `bun test test/session/messages-pagination.test.ts -t 'fork remaps compaction tail_start_id'`: **1 passed**, 11 assertions; now verifies explicit checkpoint pointer remapping and fail-closed fork truncation before summary.
- `bun test test/session/messages-pagination.test.ts -t compaction`: **8 passed** before the fork extension, 14 assertions.
- `bun test test/session/message-v2.test.ts -t compaction`: **5 passed** before the STATE reset extension; extended focused valid/pending STATE tests also pass.
- Focused auto-continuation and compacted-event tests passed.
- Reversible old-tool-output pruning passed after injecting an interrupted, unpromoted summary candidate between the old tool output and recent turns.
- `bun script/lace-retention-bench.ts`: isolated median selector speedups of **6.82x** (128 messages), **42.23x** (512), **155.53x** (1,024), relative to a linear suffix-search control. These are synthetic serialization/search timings, not provider inference speedups.
- `git diff --check` scoped to LACE files: clean. Unrelated repository-wide whitespace diagnostics remain in another agent's modifications.
- Full compaction suite encountered fixture timeouts during shared concurrent checkout activity, including a prior split-tail test that was green in v14.8. Timeout is an **unresolved gate**, neither passing evidence nor proof of regression.
- Whole-package TypeScript still fails with unrelated errors (server handler, compatibility tests and other concurrent areas). After corrections, the latest compiler output shows no diagnostics in the modified LACE/session files. This is not a clean package-wide typecheck or production build certification.

## Crash/compatibility invariants

- Provider summary parts cannot become a history-reset boundary until the marker is committed.
- One durable marker update contains checkpoint ID + tail boundary + promoted status; no partial state may be read from a newly pending marker as a complete checkpoint.
- Legacy markers with fields absent remain readable.
- A retry's abandoned summary must not supersede the exact promoted checkpoint.
- Forked sessions must not carry parent-session checkpoint references.
- Historic transcript remains durable; compaction changes model-visible context.
- Goal STATE remains authoritative and is not cleared by partial, blank, interrupted, or wrong-ID compaction.

## Uncompleted certification

1. Add an actual compare-and-swap marker promotion against source history revision and a session-wide single-flight owner. Current marker update is durable but **not** a complete revision-fenced transaction across readers, Session additions, and retries.
2. Add restart/crash-injection tests with paused provider streams, failed event publication, fork during generation, and WAL contention.
3. Measure semantic fidelity under 5–20 real inference compactions using sourced golden instruction/evidence probes, hidden dependencies, exact paths/IDs, hallucination checks and repeated-summary drift. Present round-trip recall and false-positive/negative rates, never infer fidelity from structural boundary tests.
4. Test provider-native opaque compaction only on proven supported provider/API routes; ensure cache-prefix and reasoning invariants.
5. Compare real token/billing/cache economics, multiple providers/account routes, and 1/3/6/25/50/100 sessions end to end before claiming Pareto dominance.
6. Reconcile existing unrelated TypeScript failures, complete full V1 compaction regression suite, build and production rollout gating.

Production posture: treat this as tested structural hardening in shared checkout, not complete LACE v15 semantic or release certification. Preserve all concurrent dirty modifications and do not restart the live runtime.
