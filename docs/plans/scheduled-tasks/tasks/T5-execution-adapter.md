# T5 — Execution adapter (the only Tier 3 component)

**Depends on:** T4  
**Blocks:** T9  
**Read first:** `03-execution-and-safety.md` in full

## Scope

`executor.ts` in the server package. This is the **only** file in the
feature allowed to import `InstanceStore`. Implement the 11-step firing
sequence from 03 § 3 exactly, including the step ordering.

## Hard rules

- Signature returns `Effect<ExecutionOutcome>` **with no error channel**.
  Every failure is encoded in the outcome (03 § 1).
- **Never read `process.cwd()`.** Stat the target first; missing directory
  ends the run as `skipped / target_missing` **before** any instance load.
- Instance handles acquired with `Effect.acquireRelease` so they release
on
  interruption.
- Worktree creation failure is a **failure**, never a silent demotion to
  directory mode.
- If `action.goal` is present, delegate to the existing goal preparation
  entry point. Do not reimplement continuation, auditing, or termination.
- Apply the per-task permission mode and the wall-clock ceiling from 03 §
  5.

## Verify the risky assumption first

06 marks \"the executor can originate a session headlessly\" as **Medium
confidence**. Before building the full adapter, spike the minimum: create
a session and send one prompt with no interactive client attached. If
that does not work cleanly, **stop and report** — it invalidates part of
03 and needs a design amendment, not a workaround.

## Verification

- D5 (no `process.cwd()`) and the other half of D7.
- Target-missing path causes **zero** instance loads.
- Timeout path aborts the session and settles as `failed / timeout`.
- Worktree reuse leaves exactly one worktree after 10 runs.
