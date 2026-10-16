# Lane B — OXP activity link / SQLite recovery journal (2026-10-11)

Owner: delegated DeepSeek V4.1 Flash worker, Lane B (activity recorder / links).
Reviewer gate: `E-e2e-acceptance.md` §B. Status: **COMPLETE (host-free evidence; live-cause certification remains open)**.
Disposition: **reproducible diagnostic baseline + owner-ready patch proposal**. No production data-correctness defect was demonstrated; no other contributor's file was edited.

## Exclusive ownership claim (this lane)

- `docs/research/sqlite-delegations-20261011/B-activity-link.md` (this file)
- `packages/core/test/oxp-activity-sqlite-link-recovery-20261011.test.ts` (new, committed-lane regression)
- `packages/core/test/oxp-activity-sqlite-link-recovery-20261011.investigation.ts` (new, explicit-path RED probe; not auto-discovered)
- `packages/opencode/test/oxp/activity-link-sqlite-recovery-20261011.test.ts` (new, committed-lane regression)

Not edited (read-only other-owner work): `packages/core/src/oxp-activity/{activity,sql}.ts`, `packages/opencode/src/oxp/activity-recorder.ts`, `packages/opencode/src/oxp/diagnostics.ts` (untracked), existing tests, sibling journals C/D/E.

## Commands, exit codes, exact results

| Artifact | Command (workdir) | Result |
| --- | --- | --- |
| Core RED probe | `bun test ./test/oxp-activity-sqlite-link-recovery-20261011.investigation.ts` (packages/core) | exit 0; 1 pass; prints genuine codes below |
| Core regression | `bun test ./test/oxp-activity-sqlite-link-recovery-20261011.test.ts` (packages/core) | exit 0; **6 pass / 0 fail / 39 assertions**, 3.21s; independently replayed by supervisor: exit 0, 6 pass, 39 assertions, 4.29s |
| Recorder regression | `bun test ./test/oxp/activity-link-sqlite-recovery-20261011.test.ts` (packages/opencode) | exit 0; **6 pass / 1 todo / 0 fail / 37 assertions**, 9.16s |
| Typecheck (core lane) | scoped tsgo via temp tsconfig `packages/core/tsconfig.json` | **0 errors** for both core files |
| Typecheck (opencode lane file) | scoped tsgo via temp tsconfig `packages/opencode/tsconfig.json` | **0 errors attributable to this file**; 8 pre-existing errors in other owners' dirty `src/` files (image wasm import, global.ts/session-read.ts handler types, seek-bzip, shell tree-sitter wasm) — untouched |

Every fixture logged `disposable database removed in 1–2ms` **after** scoped SQL service close; removal executes before the assertion result can be masked, and a removal failure is reported as its own labeled error.

## RED evidence — genuine native codes through the real production chain

Core probe (`…investigation.ts`, run 2026-10-11 14:49:12):

- Held writer (`BEGIN IMMEDIATE`), `activity.linkMany` failed after ~140ms:
  `EffectDrizzleQueryError > CauseImpl.reasons[0](Fail) > SqlError > LockTimeoutError > SQLiteError{code:"SQLITE_BUSY", errno:5, message:"database is locked", operation:"execute", isRetryable:true}`; `sqliteBusyCode === "SQLITE_BUSY"`. After release the same link succeeded and a repeat batch stayed idempotent (1 row).
- Stale invocation (activity deleted → cascade), `linkMany` failed:
  `EffectDrizzleQueryError > … > SqlError > ConstraintError > SQLiteError{code:"SQLITE_CONSTRAINT_FOREIGNKEY", errno:787, message:"FOREIGN KEY constraint failed", operation:"execute", isRetryable:false}`; `sqliteBusyCode === undefined` (correctly non-busy, non-retryable). No orphan link rows, `PRAGMA foreign_key_check` empty.
- Cancellation while writer held: interrupt completed; the single-statement write remained exactly-once (durable row count 1 after a subsequent idempotent write); no partial/orphan rows.
- Integrity after all: `{staleInvocationLinks:0, orphanLinks:0, fkViolations:0, busyRootLinks:1, cancelLinks:1}`.

Recorder probe (`packages/opencode ...investigation.ts`, run 14:30:46):

- Sustained contention beyond the 450ms recorder budget reproduced the **exact live retained signature**:
  `{phase:"activity_recording", activityOperation:"link", errorName:"EffectDrizzleQueryError", errorCode: <absent>}`.
  The paired settle incident retained its code: `{activityOperation:"settle", errorName:"SqlError", errorCode:"SQLITE_BUSY"}` — proving the code loss is specific to the Drizzle-wrapped link path, not to SQLite.
- Stale FK at recorder level also yields `errorName:"EffectDrizzleQueryError"` with no code and completes immediately (2ms in probe; no retry replay).
- Direct capture through the **production** classifier: a genuine busy defect (`_tag:"EffectDrizzleQueryError"`, `sqliteBusyCode:"SQLITE_BUSY"`) produced `OxpDiagnostics.sqliteIncidentCode(defect) === undefined` (JSON field omitted); the same for genuine FK. This is the reconciliation gap: the live diagnostic could not carry a trusted native code.
- A genuine `SQLITE_CONSTRAINT_NOTNULL` (1299) was also observed wrapped identically during an intermediate test bug, confirming the wrapper is generic across constraint families.

## GREEN evidence — committed regressions

Core (`oxp-activity-sqlite-link-recovery-20261011.test.ts`):

1. Held-writer busy → exact `SQLITE_BUSY`/errno 5/`LockTimeoutError`/`execute`/retryable chain; release → success; repeat idempotent; 1 row.
2. Stale FK → exact `SQLITE_CONSTRAINT_FOREIGNKEY`/787/`ConstraintError`/non-retryable; `sqliteBusyCode` undefined; zero orphans; FK check empty.
3. 44 concurrent begin/linkMany/settle across 11 activities; duplicate batches idempotent → exactly 88 links, 44 settled, 44 parent calls, FK check empty.
4. Cancellation during contended linkMany → no duplication/orphan; later write succeeds; exactly 1 row.
5. Scoped close → reopen same file → links and settlement survive; fixture removed 1ms after close.
6. Full 64-link batch in one writer acquisition; repeat idempotent; 65-link batch rejected.

Recorder (`activity-link-sqlite-recovery-20261011.test.ts`), all on real file-backed WAL + real `OxpActivityRecorder` + real Core `OxpActivity`:

1. Release at 280ms (inside 450ms budget) → recovers silently, **zero diagnostics**, status success, exactly 2 links (atomic initial + observed result).
2. Sustained hold → ≥1 `activityOperation:"link"` incident, `phase:"activity_recording"`, `errorName:"EffectDrizzleQueryError"`; tool flow unaffected; settle incident carries `SQLITE_BUSY`; incident JSON contains no SQL/schema/params.
3. Stale FK → link incident present, errorName `EffectDrizzleQueryError`, no replay, FK check empty.
4. Classifier shim of the proposed patch over **genuine** production defects → `SQLITE_BUSY` and `SQLITE_CONSTRAINT_FOREIGNKEY`; `test.todo` marks the production expectation.
5. 44 concurrent recorder invocations under a competing writer → 44 invocations, 44 settled, 88 links, zero orphans, FK check empty.
6. Interrupted completion + repeated completion → idempotent, exactly 2 links and one settle.

## Expected vs actual ledger

| Scenario | Expected (contract) | Actual (measured) | Verdict |
| --- | --- | --- | --- |
| link INSERT vs held writer | bounded busy classification, retryable | `SQLITE_BUSY`(5), `LockTimeoutError`, `execute`, retryable, ~140–151ms/attempt | matches |
| link to deleted invocation | loud constraint, never retried | `SQLITE_CONSTRAINT_FOREIGNKEY`(787), `ConstraintError`, non-retryable, no orphan | matches |
| release inside 450ms budget | silent recovery, durable link | success, no diagnostic, 2 links | matches |
| hold beyond budget | fail closed, fixed-op diagnostic, tool unaffected | link incident (no native code), tool flow continues | diagnostic code gap (B-3) |
| 40+/many sessions | exactly-once links + settlement | 44/44, 88/88, FK clean | matches |
| cancellation | no partial/duplicate/orphan state | exactly-once after recovery | matches |
| close/reopen | durable links/settlement | verified on second scoped graph | matches |
| Windows teardown | scope close, then removable fixture | removal 1–2ms; uncleaned failure never masks scenario | matches |

## Native-code preservation review (source level, read-only)

1. Native `SQLiteError{code, errno}` → `effect/unstable/sql` `classifySqliteError` → `LockTimeoutError`/`ConstraintError{ cause: native, operation, message }`: **preserved** in `reason.cause`.
2. Vendored Drizzle `queryWithCache` (`packages/effect-drizzle-sqlite/src/sqlite-core/effect/session.ts:301`) wraps typed failures as `EffectDrizzleQueryError{ query, params, cause: Cause.fail(SqlError) }`: preserved transitively; note the wrapper's `message` getter embeds SQL text and params, so diagnostics must never stringify its message/`Cause.prettyErrors` output (the current recorder/diagnostics do not; my tests assert persisted incident JSON contains no SQL).
3. `sqlite-busy.ts` traversal follows `cause/reason/reasons/error/...` plus arrays: **preserved** (busy classification verified through the real chain; `isRetryable` remains the authoritative gate).
4. `packages/opencode/src/oxp/diagnostics.ts:71` name gate (`SqlError`/`SQLITE_ERROR` only) rejects the Drizzle wrapper and does not iterate `Cause.reasons`: **native code lost at the diagnostic boundary** — the sole reconciled defect (observability, not data correctness).

## Owner-ready patch proposal (diagnostics.ts — not applied; untracked/concurrently owned file)

```diff
@@ export function sqliteIncidentCode
   const name = top._tag ?? top.constructor?.name ?? top.name
-  if (name !== "SqlError" && name !== "SQLITE_ERROR") return undefined
+  if (name !== "SqlError" && name !== "SQLITE_ERROR" && name !== "EffectDrizzleQueryError") return undefined
@@ traversal loop
     for (const field of ["reason", "cause", "error", "defect", "failure"] as const) {
       try { if (node[field] && typeof node[field] === "object") stack.push(node[field]) } catch {}
     }
+    try {
+      if (Array.isArray(node.reasons)) {
+        for (let index = 0; index < Math.min(node.reasons.length, 8); index++) {
+          const reason = node.reasons[index]
+          if (reason && typeof reason === "object") stack.push(reason)
+        }
+      }
+    } catch {}
```

Semantics validated by the shim test on genuine defects. Existing `diagnostics-ax` expectations stay valid (SqlError path unchanged; user-exception rejection unchanged because the gate still rejects arbitrary `Error` names and message matching remains whole-string anchored). No SQL/params are added to incidents.

## Safe diagnostic / transaction contract attached to the patch

- Diagnostics may persist only: fixed enums (`phase`, `activityOperation`), sanitized tool/action labels, `errorName`, allowlisted `SQLITE_*` code, fixed generic message, file-only stack frames. Never SQL text, params, refs, paths, or user metadata.
- Retry only when `isSqliteBusy`/`isRetryable` is true, only over the complete atomic unit. `linkMany` is a single `INSERT … ON CONFLICT DO NOTHING` (idempotent, no external effects); settlement's conditional `UPDATE … WHERE status='running' RETURNING` is exactly-once by predicate. Never replay an uncertain COMMIT or a partially acknowledged transaction; busy aborts the transaction and the whole unit is re-attempted only while the 450ms budget holds.
- Cancellation is not rolled back into a false state: a writing statement may already be durably acknowledged; tests assert exactly-once, never duplication.

## Live vs host-free separation

All evidence above is **host-free**: disposable file-backed WAL fixtures with the real production services, never the user's database or a live sidecar. The retained live `activity_recording/link` `EffectDrizzleQueryError` remains **unauthenticated**: with no SQL/codes retained it cannot be retro-attributed; it is signature-compatible with both sustained `SQLITE_BUSY` and constraint failures (FK/NOTNULL), and the missing code is explained by the diagnostics gap, not by absence of a genuine SQLite cause. No claim is made that the live incident is resolved.

## E-gate mapping (§B)

1. Distinct contention vs stale FK with native extended codes + sanitized operation class → core tests 1–2 (`errno 5`/`787`, `operation:"execute"`, adapter `statementClass:"INSERT"`; no SQL payloads persisted).
2. begin→linkMany→settle→close/reopen exactly-once under 40+ concurrent + competing writer + cancellation → core 3–5, recorder 5–6.
3. No false success / no blind COMMIT replay / bounded retry only → recorder 1–3, classification `isRetryable` checks, whole-unit single-statement design.
4. Windows teardown before fixture removal → every fixture logged 1–2ms removal after scope close; cleanup failure is separately labeled.

**Blockers/limits:** live sidecar certification is outside this lane; `runtime.refreshable=false`; the diagnostics patch awaits its owning lane or an uncontested window; OFXP/supervision link paths were not exercised.
