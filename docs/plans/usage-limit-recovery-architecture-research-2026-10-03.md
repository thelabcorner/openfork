# Usage-Limit Recovery: T3 Code Research and OpenFork Implementation Record

> **Research date:** 2026-10-03  
> **Implementation closeout:** 2026-10-04  
> **Status:** Implemented; recovery-scoped closeout verification completed, with unrelated repository-wide gate failures recorded below  
> **Scope:** First-party OpenFork `Resume at reset` + `Snooze until reset` for provider usage/subscription limits  
> **Primary runtime target:** OpenFork V1/fork session runtime  
> **Primary UI target:** OpenFork V2/new-layout GUI  
> **Implementation owner:** Core durable recovery cursor + process-global OpenCode deadline runner

## Executive conclusion

T3 Code supplied the product insight: usage-limit recovery is a **durable recovery opportunity**, not a renderer countdown and not a multi-hour retry sleep. OpenFork now implements that idea natively against its own persistence, admission, execution-ownership, quota, API, and V2 UI architecture rather than copying T3 mechanically.

The shipped OpenFork design is:

1. **Terminal usage-limit stops become durable first-class Session recovery state.** Core stores one operational `session_limit_recovery` cursor per Session.
2. **Recovery identity is causal and generation-fenced.** It records the exact stopped assistant/user turn, provider/account/model route, frozen latest-user sequence, reset evidence, deterministic continuation ID, and claim state.
3. **Reset provenance is execution authority.** Only `retry-after` and genuinely provider-declared `provider` reset deadlines may arm unattended recovery. `observed`, `local`, and `inferred` timestamps remain advisory.
4. **Quota state only enriches an already-confirmed limit stop.** It does not independently pause inference or manufacture autonomous execution authority.
5. **A single process-global `LimitRecoveryRunner` owns deadline wakeups.** It reads indexed durable truth, caps sleeps at 60 seconds, dispatches bounded batches, uses short durable claims, and never creates one timer per Session.
6. **Existing execution owners win.** The runner checks `SessionExecutionOwner` before `InstanceStore.provide()`; a live owner therefore prevents unnecessary workspace bootstrap and competing activation.
7. **Continuation goes through `SessionInput`, not direct transcript writes.** The deterministic recovery input is admitted as `automatic` + `queue` + `userPreemptible`, fenced by the frozen `expectedLatestUserSeq`, then promoted by exact ID so it runs before user work that was already queued when the provider stopped.
8. **A genuinely newer user turn supersedes recovery atomically.** Admission-fence conflict or concurrent revocation clears the stale recovery generation instead of reconstructing the continuation.
9. **Crash/restart is durable.** Claims expire and are reclaimable by a fresh process; deterministic input identity prevents duplicate promotion; a completed continuation is detected and repaired without replay.
10. **Recovery state is additive, not a SessionStatus compatibility mutation.** The existing `idle | busy | retry` family remains unchanged; recovery publishes `session.limit_recovery.updated` / `cleared`.
11. **V2 uses generated `sessionLimitRecovery.*` SDK methods.** Manual resume, auto-resume, snooze, wake, cancel-auto-resume, and cancel-recovery actions are server-owned mutations of the durable cursor.
12. **Goal autonomy remains intrinsic.** Recovery does not introduce a second manual/automatic Goal policy.

`ProviderRouteHealth` remains an adjacent route-health capability, but it is **not** an autonomous recovery execution-authority input in the current implementation. The recovery cursor plus current Session/admission/provider-route fences decide whether this exact turn may continue.

### Closeout verification snapshot

Recovery-scoped verification on 2026-10-04:

- Core recovery cursor/claim tests: **4/4 pass**.
- Core SessionInput lifecycle: **17/17 pass**, including deterministic exact-ID replay and user-preemption CAS.
- OpenCode quota reset projection + recovery selection + runner: **12/12 pass**.
- OpenCode recovery prompt/E2E slice: **5/5 pass**, including pre-existing queue ordering, explicit manual resume from advisory evidence, newer-user supersession, account-route mismatch, and live-owner contention.
- Retry-After focused classification/delay tests: **7/7 pass**.
- Core recovery config focused test: **1/1 pass**.
- Bootstrap-free generation-fenced recovery HttpApi integration test: **1/1 pass**.
- Recovery HttpApi coverage mode: **6/6 pass**.
- Recovery HttpApi effect mode: **6/6 pass**.
- Recovery HttpApi auth mode: **5/6 pass**; the first cold GET probe returns harness status 0 before the graph is warm, while the other five routes return the expected unauthorized response and the whole group is structurally behind the same Authorization middleware.
- Schema, OpenCode, and SDK typechecks: **pass**.
- SDK OpenAPI/codegen build: **pass on clean retry** after one transient Windows file-open failure in Prettier.
- App production build: **pass** (5081 modules transformed).

Repository-wide gates that are not recovery regressions:

- Core package-wide typecheck is blocked by unrelated concurrent Skill work in src/skill.ts and test/tool-skill.test.ts; no recovery file is present in those diagnostics.
- App package-wide typecheck is blocked by unrelated concurrent Code Mode/tool-metadata shape errors in global sync, server session, message/timeline helpers, tool preview, and session-ui; no recovery file is present in those diagnostics.
- The canonical HttpApi exerciser still reports **179 unrelated routes without scenarios**. The six recovery routes now have scenarios. A filtered auth-only invocation can make the first GET probe hit the harness's fixed 1-second cold-start timeout before the HttpApi graph finishes booting; once warm, the other five recovery auth probes pass. This is a harness timing limitation, not a recovery authorization bypass.

### Live reconciliation addendum — 2026-10-04

After an OXP restart, closeout was repeated against the live dirty `main` worktree at `1d96902911` rather than relying on the earlier verification snapshot. The tree contained hundreds of concurrent modifications, so recovery-owned files were diffed in place and no unrelated work was reset, stashed, restored, cleaned, rebased, reformatted, or overwritten.

Fresh current-byte evidence:

- Core `session-limit-recovery` + `session-input-lifecycle`: **21/21 pass**.
- Schema recovery event contract: **1/1 pass**.
- OpenCode recovery quota/runner + retry suites: **84/84 pass**.
- Prompt-level recovery slice: **4/4 pass** for interrupted-turn-before-preexisting-queue ordering, explicit manual resume from advisory evidence, genuine-user supersession, and account-route mismatch retirement.
- Schema, SDK, and App package typechecks: **pass** in this reconciliation.
- Core package typecheck remains blocked by unrelated concurrent Skill API work in `src/skill.ts` / `test/tool-skill.test.ts`.
- OpenCode package typecheck initially exposed one recovery-scoped regression in `session/prompt.ts`: the explicit manual-resume branch reused `session.model.variant` as an unbranded `string` where Synthetic admission requires `ModelV2.VariantID`. The branch now reconstructs provider/model/account identity explicitly and brands the variant through `ModelV2.VariantID.make`. After that repair, the recovery diagnostic is gone; the remaining OpenCode typecheck blocker is an unrelated generated `dist/node/node.js` artifact containing TypeScript-only assertion syntax.
- Independent execution review found a restart/cancellation edge beyond the original closeout list: a RecoveryContinuation that had already been promoted before a crash could remain an active structural user turn if the durable cursor was later cleared by HTTP Cancel recovery, Pause, or runner lifecycle invalidation without a newer genuine user turn. Because `MessageV2.latest()` intentionally treats non-historical recovery continuations as provider-user boundaries, a later loop could select that stale continuation despite cancellation. Recovery retirement is now an explicit `SessionPrompt` operation; prompt cancel/pause, the recovery HTTP cancel route, and paused/archived runner invalidation retire any active recovery continuation to historical provenance before deleting the cursor. The focused prompt recovery slice remains **4/4 pass** and the runner clock suite remains **3/3 pass** after this repair.

This reconciliation also revalidated the shipped invariants in current source: recovery remains additive to `idle | busy | retry`; automatic continuation is admitted only through `SessionInput.admitSynthetic` as `automatic/queue/userPreemptible` with the frozen user-sequence fence; deterministic exact-ID promotion remains the interrupted-turn ordering mechanism; route/account/model changes fence stale automatic recovery; explicit manual Resume remains durable authority without upgrading advisory reset provenance; advisory future resets remain valid snooze/display evidence; and the recovery claim remains wake deduplication while `SessionExecutionOwner` is the cross-runtime execution exclusion fence.

Sections 1-23 preserve the original research reasoning where useful, but statements that were implementation proposals are superseded by the implementation/verification record in Sections 24-31.

### Final current-byte reconciliation — 2026-10-04

A second live OXP reconciliation was performed after the runtime restart, again treating retained memory as advisory and the current `/webstormprojects/opencode` bytes as authoritative. OXP reported stable on runtime `sha256:5327daa6af8741fcf5e77e7b25f6e5c9f482fab43f0fe56388ce885ce701302a`; Git remained on `main@1d96902911`, while the worktree had expanded to 2,043 status entries. Recovery verifier workers were present but none owned execution, and every file edited in this pass was diffed immediately beforehand. No reset, stash, clean, restore, broad checkout, rebase, mass-format, or unrelated-byte rewrite was performed.

Current measured recovery evidence:

- Core `session-limit-recovery` + generalized SessionInput lifecycle: **24/24 pass**. This now directly covers manual authority being non-rearmable as unattended auto-resume, asynchronous enrichment generation fencing, advisory-to-trusted provenance promotion advancing generation, route identity changes advancing generation, and a file-backed SQLite reopen test in which an active lease rejects a competing claimant before expiry and a fresh runtime reclaims the cursor exactly after lease expiry.
- OpenCode quota selection + process-global runner clock + full retry/classification suite: **85/85 pass**. This includes conservative provider/account/model reset scoping, stale-quota downgrade, strict case-insensitive Retry-After parsing, IMF-fixdate plus required obsolete HTTP-date forms, malformed/past/non-integral authority rejection, canonical OpenCode Go reset display parsing, terminal limit settlement, and the no-long-sleep retry policy.
- Prompt-level continuation behavior: interrupted continuation ordering, genuine-user supersession, route/account mismatch retirement, and explicit manual resume all pass on current bytes. Manual resume initially hit the generic 5-second Effect harness deadline without an assertion failure; unlike adjacent recovery integration cases, that one test lacked an explicit test budget. The test alone was given the same `20_000` millisecond budget used by neighboring recovery cases, after which it passed in about 14.9 seconds. This was a verification-harness repair only; production recovery behavior was unchanged.
- Promoted-continuation revocation: **1/1 pass** for cancel and pause retiring active `RecoveryContinuation` turns to historical provenance before recovery authority is cleared.
- Execution-owner contention: **1/1 pass**. A committed Synthetic wake remains pending while another local `SessionExecutionOwner` generation owns the Session; the wake does not promote or revoke the work and does not supersede the owner. This is the direct proof that claim expiry/competing runtimes may cause redundant wake attempts but cannot create duplicate Session execution.
- Bootstrap-free generation-fenced recovery HttpApi integration: **1/1 pass** on an isolated rerun with 13 assertions. A previous concurrent run exceeded its 20-second harness deadline during graph cold start; the isolated run passed in about 15.8 seconds. The test deliberately arms recovery and therefore logs an expected failed cold activation in its temporary workspace, but still proves that the recovery control route itself does not bootstrap the workspace.
- Schema recovery event contract: **1/1 pass**, confirming `session.limit_recovery.updated` and `session.limit_recovery.cleared` remain fork-owned additive events rather than additions to the compatibility-sensitive SessionStatus family.
- Runtime mounting was re-read directly: `LimitRecoveryRunner.node` is registered in both direct `AppRuntime` and the served HTTP graph, while the runner is constructed with `makeGlobalNode`; the two graph registrations therefore resolve to the same process-global deadline owner rather than creating per-graph or per-Session clocks.
- V2 projection was re-read directly. `session.limit_recovery.updated` ignores older generations and `cleared` cannot erase a newer projected generation. UI actions continue to use only the generated SDK surface, and advisory future reset evidence remains presentation/snooze-capable without becoming unattended execution authority.
- Generated SDK parity was re-read without running the destructive codegen build: the generated `SessionLimitRecovery` client contains `get`, `autoResume`, `resume`, `snooze`, `wake`, and `cancel`, and the top-level V2 client exposes `sessionLimitRecovery`. SDK typecheck passes. The normal SDK build intentionally cleans/rewrites generated files, so it was not invoked in this highly concurrent dirty worktree.
- Core, Schema, App, and SDK package typechecks pass on current bytes. OpenCode package typecheck is presently blocked only by unrelated concurrent diagnostics in support-bundle CLI typing, timeline-read readonly query typing, compatibility/account-alias tests, one unrelated branded MessageID test, and session-actions typing. No recovery source or recovery-focused test appears in the OpenCode typecheck diagnostics.

The current live implementation therefore agrees with the intended authority model: durable SQLite recovery state is authoritative; `wake` only unsnoozes; manual Resume is durable explicit user authority and never upgrades advisory reset provenance; only trusted failure-local/provider reset evidence may arm unattended continuation; automatic continuation enters through `SessionInput.admitSynthetic` with `automatic/queue/userPreemptible`, deterministic identity, and the frozen latest-user sequence fence; `SessionExecutionOwner` remains the cross-runtime execution exclusion fence; and stale promoted continuations are retired before cancel/pause/lifecycle invalidation can clear recovery authority.

---



## 1. Research inputs and architectural constraints

The original design was derived from the live OpenFork tree plus current T3 Code source; the closeout sections now record the implementation that resulted from that research.

### OpenFork architecture documents read

- `AGENTS.md`
- `FORK.md`
- `docs/map/README.md`
- `docs/map/architecture.md`
- `docs/map/v1-v2.md`
- `docs/map/surfaces.md`
- `docs/map/packages.md`
- `docs/map/upstream-fork.md`
- `docs/map/source-tree.md`
- `docs/architecture/compatibility-boundary.md`
- `docs/architecture/t3code-compatibility.md`

The constraints relevant to this feature are:

- OpenFork is an independent product, not an OpenCode-compatible distribution.
- V1 is a production architecture in OpenFork. Current/V2 runtime code is often a semantic donor, not a migration mandate.
- The V2/new-layout GUI is the primary product presentation.
- The GUI is not the owner of durable runtime truth.
- Local runtime/API/persistence semantics are fork-owned and can be designed correctly for OpenFork.
- The explicit T3 Code compatibility facade is narrower than OpenFork itself. Do not casually change shared compatibility contracts such as the recognized `idle | busy | retry` session-status family.
- Goal Mode has intrinsic autonomy. Do not reintroduce a manual/automatic continuation policy into Goal Mode.

### T3 Code sources inspected

Repository: <https://github.com/pingdotgg/t3code>

Primary introduction commit:

- `de343914273eceb852a1d1d739cd1d38df7796ee`
- `feat(orchestrator): introduce new orchestrator (#2829)`
- 2026-10-02

Key current files:

- `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts`
- `apps/server/src/orchestration-v2/ProjectionStore.ts`
- `apps/server/src/orchestration-v2/ProviderFailure.ts`
- `apps/server/src/orchestration-v2/Orchestrator.ts`
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`
- `apps/server/src/scheduling/Scheduler.ts`
- `apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx`
- `apps/mobile/src/features/threads/UsageLimitRecoveryCard.tsx`
- `packages/contracts/src/orchestrationV2.ts`
- `packages/contracts/src/settings.ts`
- `packages/shared/src/orchestrationV2ThreadError.ts`
- `docs/user/thread-sidebar.md`

---

## 2. What T3 Code actually implemented

### 2.1 Product behavior

T3 documents the following user-facing behavior:

- A thread becomes **Limited** when a provider stops on a usage/rate limit.
- Manual **Resume** can continue a limited or interrupted turn.
- Queued messages stay saved while the thread is limited and run after the continuation.
- If a reset time is known, the thread offers **Resume at reset**.
- The user can cancel scheduled auto-resume.
- A global **Auto-resume limited threads** setting can arm recovery automatically.
- Overdue recoveries resume after the server restarts.
- Sending a new message, archiving, or settling prevents a stale pending continuation from starting.
- **Snooze until reset** is independent of resume.
- Snooze-only wakes the thread at reset without sending a message.
- Snooze + resume both hides the thread and resumes it at reset.
- Providers without a reset time still support manual retry and ordinary snooze behavior.

Source: `docs/user/thread-sidebar.md`.

### 2.2 T3's recovery identity

T3's core recovery state is:

```ts
{
  requestId?: CommandId
  runId: RunId
  resetAt: IsoDateTime
  autoResume: boolean
  snooze?: boolean
}
```

The important identity is not merely the thread. It is the **specific stopped run + specific reset boundary**, with a request/generation fence layered on top.

This prevents an old timer or old UI command from resuming a newer failure.

### 2.3 T3's terminal failure model

T3 normalizes provider failures into a stable object containing:

- failure class;
- bounded/redacted message;
- code;
- retryability;
- optional `resetAt`.

Only failures classified as `usage_limit` are eligible for limit recovery.

That classification becomes thread-shell state:

- `lastErrorClass`
- `usageLimitResetAt`

The recovery worker therefore does not parse error strings.

### 2.4 T3's worker

`UsageLimitRecoveryWorker.limitRecoveryCommand()` validates:

- thread is failed;
- latest failure is `usage_limit`;
- latest run exists;
- reset time exists and is valid;
- reset is newer than the stopped run;
- thread is not archived;
- thread is not settled;
- no pending runtime interaction blocks the thread.

It then either:

1. persists/arms recovery state for this exact run/reset identity; or
2. when due, emits a continuation command carrying the exact source run and exact recovery request identity.

The continuation text is currently:

> `Continue where you left off.`

This is intentionally a continuation turn, not a replay of the failed HTTP/provider invocation.

### 2.5 T3's stale-delivery fencing

The T3 orchestrator revalidates immediately before continuation:

- source run is still the exact usage-limited run;
- latest thread failure is still usage-limit;
- auto-resume remains enabled for this recovery identity;
- recovery request ID still matches;
- reset timestamp still matches the provider failure;
- reset time has arrived;
- thread is not archived/deleted/settled;
- provider instance is unchanged;
- there is no pending runtime request;
- snooze does not still extend past now.

Invalid deliveries become no-ops rather than retry loops.

This is one of the strongest parts of T3's implementation and should be preserved conceptually.

### 2.6 T3's scheduler

T3's new server has a small generic scheduler:

- one five-second clock;
- registered due-work sources;
- per-source non-overlap semaphore;
- concurrent sources;
- due work is derived from persisted state, so restart requires no timer reconstruction.

This is structurally sound, but OpenFork already has a more mature deadline scheduler pattern and does not need to copy the five-second polling cadence.

### 2.7 T3's provider reset extraction

#### Codex / ChatGPT subscription

T3's Codex adapter listens to `account/rateLimits/updated`, maintains a current rate-limit snapshot, and derives a reset boundary through `codexUsageLimitResetAt()`.

When a terminal Codex failure is `usageLimitExceeded` or `rateLimitExceeded`, the adapter attaches the current reset deadline. If the reset snapshot arrives after the failure, T3 can backfill the stopped turn's failure exactly once.

#### Claude

T3 treats Claude terminal `blocking_limit` and relevant 429 outcomes as `usage_limit`.

It collects Claude rate-limit reset timestamps and, when all relevant windows have known reset timestamps, chooses the **latest** reset. This is conservative: the turn should not be resumed while any blocking window is still exhausted.

---

## 3. OpenFork already has the required building blocks

## 3.1 Session failure classification

File:

- `packages/opencode/src/session/retry.ts`

`ProviderFailureDecision` already contains:

```ts
{
  class: ProviderFailureClass
  retry: "none" | "same-route"
  routeEffect: ProviderFailureRouteEffect
  message: string
  resetAt?: number
  action?: RetryAction
}
```

Existing classes already distinguish:

- `account-quota`
- `account-rate-limit`
- `public-quota`
- transient provider errors
- request admission failures
- auth failures
- invalid requests
- cancellation

This is substantially closer to the required domain model than starting from provider-specific error strings.

### Research-time gaps and their closeout

#### Gap A — terminal quota failure can be invisible — **closed**

In `SessionRetry.policy()`, a `retry: "none"` decision publishes a retry status only when `decision.action` exists.

Several terminal quota/rate-limit branches have no action.

The observable result can therefore be:

```
busy -> idle
```

with no durable first-class fact saying that the session stopped because of a usage limit.

The implementation closes this by observing eligible terminal failures in the Session processor and writing/updating the Core-owned `SessionLimitRecovery` cursor. Recovery visibility no longer depends on adding a new SessionStatus member.

#### Gap B — resetAt is computed, then discarded on several branches — **closed for recovery authority**

`retryResetAt()` computes a trusted absolute reset/retry time from provider headers.

Several classification branches do not forward it.

Recovery capture now preserves strict failure-time retry evidence separately from advisory quota observations. Eligible terminal limit classes can therefore persist a trusted `retry-after` deadline even though the compatibility retry/status path remains independent.

#### Gap C — duplicate Retry-After parsers disagree — **closed for the recovery path**

`delay()` and `retryResetAt()` do not parse headers identically.

Examples identified during research:

- one path performs direct case-sensitive header lookup;
- the durable parser uses case-insensitive lookup;
- one path uses permissive `parseFloat`;
- the durable parser is intentionally stricter.

The recovery path uses the strict normalized failure-time reset evidence exercised by the retry tests. Permissive or provider-observation estimates never silently acquire autonomous recovery authority.

---

## 3.2 ProviderRouteHealth

File:

- `packages/core/src/provider-route-health.ts`

OpenFork already persists route-level availability state including:

- account authentication invalidity;
- account cooldown;
- account quota exhaustion;
- public quota exhaustion;
- optional future reset/expiry times.

This is the correct owner for **route eligibility**.

It is **not** the correct owner for session recovery identity because its key is route/account/model-oriented, not session/turn-oriented.

Keep this separation:

```
ProviderRouteHealth
  = can this route/account/model be selected now?

SessionLimitRecovery
  = may this exact stopped Session turn be continued at this deadline?
```

Do not overload one table/service with the other responsibility.

---

## 3.3 Quota factory

Directory:

- `packages/opencode/src/quota/**`

The quota factory is already a normalized provider-usage layer.

Registered adapters currently include:

- OpenCode Go
- OpenCode Zen
- OpenRouter
- Kimi
- DeepSeek
- Genspark
- Claude
- Codex / ChatGPT
- xAI
- NVIDIA
- WorkBuddy

`UsageWindow` already includes:

- used percent;
- remaining percent;
- window duration;
- `resetAt`;
- `resetAfterSeconds`;
- structured resource data.

`Quota.Service` already exposes:

- `providers()`
- `get({ providerID })`
- `resets({ from, to })`

The comments in this subsystem make an important architectural promise:

> quota is advisory display state and must not gate inference.

That promise should remain true.

### Correct integration rule

**A quota snapshot must never independently decide that a running request is blocked.**

Instead:

1. the session runtime confirms a terminal usage/rate-limit failure;
2. the recovery resolver may query/consult the quota system to enrich that confirmed failure with an account/model reset boundary;
3. provenance and freshness are preserved;
4. the deadline is revalidated before expensive work resumes.

That preserves the quota factory's advisory nature while still reusing it for recovery.

---

## 3.4 Reset agenda

File:

- `packages/opencode/src/quota/resets.ts`

This is especially valuable.

OpenFork already normalizes provider resets into `ResetOccurrence` objects with:

- stable IDs;
- provider;
- account;
- model;
- reset time;
- observation time;
- scope;
- windows;
- source provenance.

Existing reset provenance includes:

- `provider`
- `observed`
- `inferred`
- `local`

This is almost exactly the vocabulary needed by recovery, but it needs one more distinction: a failure-local trusted `Retry-After` should remain distinguishable from a separately fetched provider quota snapshot.

Recommended recovery provenance:

```ts
type LimitResetSource =
  | "retry-after"       // exact failure response
  | "provider"          // provider-owned usage/rate-limit API
  | "observed"          // learned from a concrete provider failure/event
  | "local"             // deterministic local accounting
  | "inferred"          // estimated boundary
```

The source should never be erased after selection.

---

## 3.5 SessionInput and durable admission

Files:

- `packages/core/src/session/input.ts`
- `packages/opencode/src/session/prompt.ts`

OpenFork already has:

- durable input admission;
- deterministic message IDs;
- optimistic human-focus fences via `expectedLatestUserSeq`;
- priority lanes;
- user-preemptible automatic work;
- crash-safe activation after admission.

This is reusable, but there is one subtle ordering requirement described later: an interrupted-turn continuation must run **before user messages that were already queued before the limit stop**, while a genuinely new user message after the stop must supersede recovery.

That requirement means recovery cannot be treated blindly as just another low-priority automatic queue item.

---

## 3.6 Goal continuation recovery

File:

- `packages/opencode/src/session/goal-continuation-recovery.ts`

This is the strongest in-repo implementation pattern for restart recovery.

It already has:

- process-start recovery;
- durable pending reservations;
- Session lookup without transcript scans;
- bounded workspace activation;
- a failed-session negative cache;
- owner-race protection;
- no dependence on a connected GUI.

The recovery runtime should copy these ownership properties.

Goal's `GoalAutomationTable` is also the right persistence precedent: operational continuation state is separate from user-owned Goal specification state.

---

## 3.7 Scheduled-task runtime

Files:

- `packages/opencode/src/scheduled-task/runner.ts`
- `packages/opencode/src/scheduled-task/wake.ts`
- `packages/core/src/scheduled-task/index.ts`
- `packages/core/src/scheduled-task/sql.ts`
- `packages/core/src/scheduled-task/lease.ts`

This system demonstrates several hard-earned invariants that usage recovery should reuse:

- **one owned timer** per runner;
- never trust a multi-hour sleep;
- re-read the clock after wake;
- at most one dispatch batch;
- level-triggered wake coalescing;
- bounded concurrency;
- materialized `next_run_at`;
- indexed due query;
- crash-safe leases;
- process-owner fencing;
- heartbeat/reclaim for work that actually starts;
- restart/catch-up behavior.

The key due index is conceptually:

```
WHERE enabled = 1
  AND next_run_at <= now
ORDER BY next_run_at
```

No recurrence scan is required.

Usage recovery should have the same complexity class.

---

## 4. Implemented OpenFork domain model

## 4.1 First-class durable recovery aggregate

The implementation uses the Core-owned `SessionLimitRecovery` aggregate.

Do **not** store this solely in:

- transient `SessionStatus`;
- GUI state;
- provider route health;
- the scheduled-task table;
- arbitrary Session metadata JSON that must be scanned.

### Durable table

A single active row per Session is sufficient.

```text
session_limit_recovery
----------------------
session_id                  PRIMARY KEY / FK Session
source_assistant_message_id NOT NULL
source_user_message_id      NULL/optional causal root
provider_id                 NOT NULL
account_id                  NULL
model_id                    NOT NULL

failure_class               NOT NULL
failure_code                NULL

reset_at                    NULL
reset_source                NULL
reset_observed_at           NULL

expected_latest_user_seq    NULL
generation                  NOT NULL DEFAULT 1

auto_resume                 NOT NULL DEFAULT 0
manual_resume               NOT NULL DEFAULT 0
snooze_until                NULL
continuation_id             NOT NULL

claim_owner                 NULL
claim_expires_at            NULL

time_created                NOT NULL
time_updated                NOT NULL
```

This is the implemented shape; the live Drizzle definition is `packages/core/src/session/limit-recovery.sql.ts`.

### Implemented indexes

```
PRIMARY KEY(session_id)

INDEX session_limit_recovery_due_idx
  ON session_limit_recovery(auto_resume, reset_at, session_id)

INDEX session_limit_recovery_manual_idx
  ON session_limit_recovery(manual_resume, claim_expires_at, session_id)

INDEX session_limit_recovery_claim_idx
  ON session_limit_recovery(auto_resume, claim_expires_at, session_id)
```

The due query must be a bounded index range scan.

Do not scan Session JSON or message history on scheduler ticks.

### Why one row per Session?

Only the latest valid terminal limit stop should own recovery authority.

A later turn/failure supersedes the old recovery row.

The row is an operational cursor, not a history table. Historical failure evidence remains in messages/events/usage telemetry.

---

## 4.2 Recovery identity

The **database identity should be causal, not timestamp-keyed**.

Durable ownership:

```
PRIMARY KEY(sessionID)

sourceAssistantMessageID
generation
providerID
accountID?
modelID
resetAt?
```

`resetAt` is a **fence/cursor value**, not the primary key. Providers can move a reset boundary after the failure. When a stronger/newer authoritative reset replaces the old one, update the same Session cursor and bump `generation`; do not manufacture a second live recovery row.

The logical identity therefore means:

```
this Session
+ this exact stopped assistant turn
+ this recovery generation
```

Provider/account/model and `resetAt` are stale-delivery fences.

A deterministic continuation/admission ID includes the frozen reset boundary and generation:

```
msg_limit_recovery_ + sha256(sessionID, sourceAssistantMessageID, resetAt, generation)
```

because a moved reset must not allow an old delivery to admit the continuation. The database row, however, remains one-row-per-Session.

This gives idempotency across:

- duplicate timer wakes;
- reset-boundary revisions;
- renderer retries;
- process restarts;
- multi-process races;
- lost acknowledgements.

---

## 4.3 Conceptual state machine

The table does not need a large string enum, but the conceptual lifecycle is:

```text
none
  |
  | terminal confirmed usage limit
  v
limited
  |
  +-- reset unknown --------------------> manual retry only
  |
  +-- reset known
        |
        +--> snoozed
        |
        +--> armed(autoResume)
                |
                | reset <= now
                v
             claimed
                |
                | all fences valid
                v
           continuation admitted
                |
                v
             consumed
```

Stale paths converge to cancellation/supersession rather than repeated errors.

---

## 5. Reset evidence and confidence

This feature needs an explicit **Reset Resolver**. It should not simply take the first timestamp it sees.

## 5.1 Priority order

Recommended priority:

1. **Failure-local Retry-After / native provider terminal reset**
2. **Provider-owned usage/rate-limit endpoint for the exact account/model**
3. **Concrete observed reset event**
4. **Deterministic local accounting**
5. **Inferred reset**

Never overwrite a stronger source with a weaker one just because it arrived later.

## 5.2 Scheduling policy by provenance

| Source | Auto-resume? | Snooze/display? | Required behavior |
|---|---:|---:|---|
| `retry-after` | **Yes** | Yes | Trusted failure-local deadline; normal runtime still revalidates on continuation |
| `provider` | **Yes, when exact/fresh** | Yes | Provider-owned reset for the exact exhausted account/model/window |
| `observed` | **No by default** | Yes | Observation can be conservative or represent a quota-fetch cooldown rather than an allowance reset |
| `local` | **No by default** | Yes | Deterministic local accounting is useful UX evidence, but should not silently gain unattended execution authority |
| `inferred` | **No** | Yes | Best-effort UX only |

This is intentionally conservative. An `observed` or `local` source can become schedulable only if its provider-specific contract is strengthened so the normalized reset agenda can prove that it is the exact blocking allowance boundary.

A user can still manually retry an observed/local/inferred/unknown limit.

## 5.3 Multiple windows

Never use:

```
max(all provider account reset windows)
```

blindly.

Only consider windows that can explain the confirmed exhaustion.

Examples:

- a five-hour window at 100% and weekly window at 40% -> use five-hour reset;
- five-hour and weekly windows both exhausted -> use the later reset;
- monthly account billing reset unrelated to request admission -> do not block on it;
- model-scoped exhausted window -> do not use a different model's reset.

T3's Claude behavior — taking the latest reset among relevant blocking windows — is the correct conservative pattern.

---

## 6. Provider coverage matrix

The matrix below separates two questions that must not be conflated:

1. Can OpenFork **confirm that this turn stopped because of a usage limit**?
2. Can OpenFork **name a trustworthy reset time**?

| Provider | Confirm stop | Reset data already available | Reset source | Recommended recovery |
|---|---|---|---|---|
| Claude subscription / Claude Code | Yes **when the committed route is an account route**: generic account 429 already classifies as `account-rate-limit`; provider-specific terminal limit signals may need further normalization | 5h / weekly / scoped reset windows from Claude usage data; failure headers may also report reset | provider / retry-after | Full Resume at reset only after exact account/window correlation; if several windows are actually blocking, wait for the latest blocking reset |
| Codex / ChatGPT subscription | Yes: committed-account 429 and quota paths | provider usage primary/secondary windows expose reset time/window size | provider / retry-after | Full Resume at reset; exact ChatGPT account ID must match |
| OpenCode Go | Yes: explicit `GoUsageLimitError` -> `account-quota` | Go usage snapshot exposes provider/local/observed reset evidence | provider / observed / local | Auto-resume only for provider-authoritative exact exhausted window or failure-local Retry-After |
| OpenCode Zen | Yes for concrete public/key exhaustion | observed key cooldown/reset or inferred daily/free-tier boundary | observed / inferred | **No unattended auto-resume by default** from current normalized evidence; use for snooze/display unless failure-local Retry-After exists |
| Kimi | A committed-account runtime 429 can confirm the stop | weekly/rate-window reset fields are provider-owned | provider / retry-after | Auto-resume after confirmed runtime exhaustion + exact account/window match |
| xAI / Grok | A committed-account runtime 429 can confirm the stop | provider quota response exposes a billing-cycle reset | provider / retry-after | Do not equate arbitrary request throttling with billing-cycle exhaustion; schedule only when the failed request is correlated to that blocking window |
| NVIDIA | A committed-account runtime 429 can confirm the stop | local fixed-window accounting computes reset | local / retry-after | Local reset is display/snooze evidence only by default; failure-local Retry-After is schedulable |
| WorkBuddy | Runtime failure can confirm the stop | model limits contain server-confirmed, observed, and inferred evidence, but current reset normalization collapses server-6004 into `observed` | observed / inferred | **Do not auto-resume from normalized WorkBuddy reset state until server-confirmed provenance survives normalization**; Retry-After remains schedulable |
| OpenRouter | A committed-account runtime 429 can confirm the stop | quota adapter is prepaid credits only: explicitly **no reset window** | retry-after if present | Resume at reset only from the failed request's trusted deadline |
| DeepSeek | A committed-account runtime 429 can confirm the stop | quota adapter is balance only: explicitly **no reset window** | retry-after if present | Same |
| Genspark | A committed-account runtime 429 can confirm the stop | quota adapter is credit balance only; its own 429 cooldown is merely usage-check throttling | retry-after if present | Same |

### Critical distinction: quota-fetch throttling is not model quota reset

Several adapters can themselves receive a 429 while OpenFork is calling a quota endpoint.

That cooldown protects the **quota fetch**.

It must never be interpreted as:

> the model subscription will reset at this time.

Keep those two rate-limit domains separate.

---

## 7. Failure classification changes required

## 7.1 Add a stable recovery discriminator

OpenFork can either:

A. add `usage-limit` as a normalized recovery class; or  
B. define a predicate over existing classes such as `account-quota`, `public-quota`, and selected `account-rate-limit`.

A dedicated normalized discriminator is easier for downstream persistence/UI and avoids repeating provider-routing logic.

Recommended conceptual API:

```ts
type LimitFailure = {
  kind: "usage-limit"
  scope: "account" | "public" | "unknown"
  providerID: string
  accountID?: string
  modelID: string
  message: string
  code?: string
  reset?: {
    at: number
    source: LimitResetSource
    observedAt: number
  }
}
```

This can be a Core internal contract even if the existing public error union is preserved for compatibility.

## 7.2 Normalize Retry-After once

Make one parser authoritative.

`delay()`, UI retry countdowns, route-health expiry, and limit-recovery reset selection should all consume the same parsed deadline.

If a provider says:

```
Retry-After: 3600
```

there should be exactly one interpretation of that value throughout the process.

---

## 8. Continuation semantics

This is the most important correctness section after reset selection.

## 8.1 Do not replay the failed provider call

A request may have already:

- emitted assistant text;
- executed tools;
- mutated files;
- triggered external side effects;
- partially updated provider-native conversation state.

Reissuing the original provider request is not safe.

The recovery action must be a new **continuation turn** that sees the durable history and completed tool state.

Conceptually:

> Continue where you left off.

This matches T3's implementation and OpenFork's existing host-continuation architecture.

## 8.2 Exact source turn

Recovery must name the exact stopped assistant message/turn.

Do not infer the source by scanning for “latest error” during wake.

The stopped message ID is already in scope when `SessionRetry` terminates in `session/processor.ts`; persist it then.

## 8.3 Causal provenance

The materialized continuation should use OpenFork's existing synthetic/host-derived provenance machinery so it inherits the correct:

- worker causal root;
- capabilities;
- checkpoint lineage;
- provider conversation semantics.

Goal continuation materialization in `SessionPrompt` is the best reference for stable IDs and compaction-safe causal recovery.

## 8.4 Queued messages: a subtle but non-negotiable ordering rule

T3 explicitly guarantees:

> queued messages stay saved while the limit blocks the thread; they run after the continuation finishes.

OpenFork's ordinary `SessionInput` lane order gives genuine user queue entries higher priority than `automatic` queue entries.

Therefore, blindly calling:

```ts
admitSynthetic({
  admissionClass: "automatic",
  delivery: "queue",
  ...
})
```

is **not sufficient** if user messages were already queued before the limit stop.

### Required semantics

At failure time freeze:

```
expectedLatestUserSeq = SessionInput.latestUserSeq(sessionID)
```

This includes user inputs already admitted/queued at the moment of failure.

At recovery time:

- if latest user seq is greater than the frozen seq, a genuinely new user interaction superseded recovery -> cancel/no-op;
- if the seq is unchanged, pre-existing queued messages do **not** supersede the interrupted turn;
- the recovery continuation must complete first;
- then the normal user queue drains.

### Recommended implementation shape

Treat recovery as a **continuation reservation/cursor**, not merely a normal low-priority inbox row.

The prompt loop should claim/materialize an eligible limit-recovery continuation before promoting pre-existing queued rows covered by the frozen frontier.

This can be implemented in the same spirit as Goal continuation reservations:

1. claim durable recovery cursor;
2. verify frozen user frontier;
3. materialize stable synthetic continuation with exact causal source;
4. execute that continuation;
5. settle recovery;
6. return to ordinary SessionInput lane order.

A new user admission after the failure must cancel/revoke that authority.

This preserves T3 semantics without weakening OpenFork's user-priority rules.

## 8.5 New user activity

A new genuine user turn after the limit stop means the user has taken control.

It must:

- supersede pending auto-resume;
- clear/cancel the old recovery cursor;
- un-snooze the session if appropriate.

The frozen user sequence provides the race-proof check even if the explicit cancellation event is lost.

## 8.6 Provider/account/model changes

Automatic recovery should require equality with the failure snapshot:

- provider;
- selected account when known;
- model/routing identity when relevant.

If the user changes provider/model/account, the old automatic recovery becomes stale.

Manual resume can intentionally use the new route, because that is a new user decision.

## 8.7 Permissions and questions

Do not resume provider work while a pending interaction requires the user.

Before dispatch:

- check pending permission state;
- check pending question state;
- check other session interaction fences.

Leave the recovery armed and wake it again when the interaction resolves, or let the user action supersede it.

Never auto-answer or bypass the gate.

## 8.8 Explicit Stop / abort / pause

An explicit user stop is authoritative.

The session-status schema already warns auto-resume consumers to treat operator abort as a stop.

Therefore:

- explicit stop/abort cancels recovery;
- paused session keeps recovery durable but does not run until resumed, unless product semantics explicitly choose cancellation;
- Goal pause/abort remains authoritative too.

## 8.9 Archive / delete

Archived/deleted sessions must not auto-resume.

The persistent recovery row should be removed/cancelled or be filtered by an indexed/session-state fence.

## 8.10 Compaction

Do not special-case by replaying pre-compaction history.

Use stable causal source IDs plus the same “republish after latest compaction boundary” pattern already implemented for Goal continuations.

---

## 9. Goal Mode

This feature must not accidentally reconstruct a Goal “continuation policy”.

Normal sessions may have a global preference:

- auto-resume limited sessions on/off.

Goal Mode is different.

The repository contract says Goal execution is autonomous until independently complete or genuinely blocked.

A provider usage limit with a trusted future reset is a **temporary schedulable blocker**.

Recommended Goal semantics:

- persist the limit recovery cursor;
- automatically arm it for the trusted reset regardless of the ordinary-session auto-resume preference;
- show the blocked/reset state in Goal UI;
- resume after reset;
- explicit user pause/abort still wins;
- if no trustworthy reset exists, Goal is genuinely blocked and waits for a route/user change.

This is not an “automatic Goal mode”. It is continuation of the one intrinsic Goal behavior.

---

## 10. Snooze semantics

Snooze is independent from execution recovery.

Recommended fields:

```
snoozeUntil?: number
autoResume: boolean
```

### Snooze only

- session is hidden/parked until reset;
- no provider work is scheduled;
- at/after reset, the UI naturally treats snooze as expired;
- no scheduler mutation is required merely to make an expired snooze visible after a restart.

This is an opportunity to be more efficient than T3.

### Snooze + auto-resume

- session remains hidden until reset;
- recovery runner continues it at reset;
- continuation activity naturally returns it to the active/working surface.

### Wake now

- clears `snoozeUntil`;
- does not automatically cancel `autoResume` unless the product explicitly labels that action;
- user can separately cancel auto-resume.

---

## 11. Scheduler / deadline architecture

## 11.1 Do not create hidden Scheduled Tasks

`ScheduledTaskTable` is explicitly a **user-owned durable schedule specification**.

A limit recovery is not:

- a user-created schedule;
- a recurring task;
- a task-history object;
- a target-directory policy;
- a notification policy;
- a Goal action.

Encoding recoveries as hidden Scheduled Tasks would contaminate both domains and drag in unnecessary task/session/run/history machinery.

Do not do this.

## 11.2 Reuse the scheduler mechanics, not the ScheduledTask domain

OpenFork's scheduled-task runner has better deadline behavior than T3's five-second source sweep.

For limit recovery, preserve these invariants:

- one process-global recovery timer;
- max sleep <= 60 seconds;
- always re-read wall clock after wake;
- query indexed due rows;
- timer-epoch fencing;
- serialized wake;
- coalesced wake-pending bit;
- bounded execution concurrency;
- restart scan/catch-up;
- no GUI dependency.

### Implemented deadline owner

The implementation is the process-global `LimitRecoveryRunner` in `packages/opencode/src/session/limit-recovery-runner.ts`.

modeled on:

- `ScheduledTaskRunner`
- `GoalContinuationRecovery`

Do **not** refactor the mature ScheduledTask domain just to save one timer.

It owns one clock, re-reads durable truth on every wake, caps any sleep at 60 seconds, batches at most 50 due cursors, and dispatches with concurrency 2. Updated/Cleared recovery events wake the clock early.

If a third/fourth independent deadline domain appears later, extract the timer/wake mechanics into a generic internal `DueWorkClock` without changing domain ownership.

### Why not T3's five-second scan?

At 1,000 or 10,000 persisted sessions, a correctly indexed OpenFork due query remains effectively independent of total transcript size.

There is no reason to wake SQLite every five seconds when the earliest known deadline may be hours away.

Use:

```
nextDueAt()
sleep(min(nextDueAt - now, 60_000))
wake()
```

and always re-query on wake.

---

## 12. Claiming and idempotency

OpenFork can be used in configurations where more than one runtime/process sees the same database.

Recovery uses both a database-adjudicated claim and convergent admission identity.

Implemented defense in depth:

1. recovery row has a generation;
2. runner atomically claims generation/deadline;
3. claim has short expiry;
4. materialized continuation uses a deterministic `SessionInput` ID;
5. Session execution ownership independently prevents simultaneous provider cycles;
6. stale claims are recoverable after process death.

A full scheduled-task-style heartbeat is likely unnecessary for the short “claim -> admit continuation” critical section.

Prefer a short claim TTL plus deterministic admission over a heavy long-running lease.

Once the Session owns execution, normal Session execution ownership becomes authoritative.

---

## 13. Due-time revalidation

The runner performs only bootstrap-free checks until it knows activation is necessary:

- generation/claim eligibility is adjudicated in Core;
- durable Session must still exist;
- paused/archived Sessions clear recovery;
- an existing `SessionExecutionOwner` defers recovery before `InstanceStore.provide()`.

At the Session activation boundary, `SessionPrompt` revalidates:

- completed-continuation crash repair;
- frozen latest-user sequence;
- trusted reset source and due time for autonomous recovery;
- pending permission/question interaction gates;
- source assistant and parent user existence/completion;
- provider/model/account route identity;
- paused/archive state;
- automatic-recovery selected-model drift.

The actual continuation is then admitted through `SessionInput.admitSynthetic` with the frozen user fence. A concurrent/newer User admission therefore wins without a race-prone renderer or transcript check.

The current implementation intentionally does **not** turn `ProviderRouteHealth`, stale quota observations, or an inferred/local deadline into a second autonomous execution-authority gate.

---

## 14. Global settings

Normal-session defaults belong on the **server**, not solely in renderer-local Settings persistence, because recovery must work when clients are closed.

OpenFork already has:

- `Config.getGlobal()`
- `Config.updateGlobal()`
- the global config HTTP surface;
- server-sync handling for `config.updated`.

Recommended global config:

```jsonc
{
  "usage_limit_recovery": {
    "auto_resume": false,
    "snooze_until_reset": false
  }
}
```

Defaults should be false initially, matching T3's opt-in behavior.

The V2 Settings GUI should mutate global server config, not `packages/app/src/context/settings.tsx` local preferences.

A multi-server/all-environments UI can fan this server-owned setting out explicitly, the same way other environment-scoped settings are handled.

---

## 15. V2 GUI integration

## 15.1 Primary session surface

Primary candidate:

- the new/V2 session composer region around `packages/app/src/components/prompt-input-v2.tsx` and session V2 composer/dock components.

Render a dense warning/recovery row immediately above the composer when:

```
recovery.kind === "usage-limit"
```

Presentation:

```text
Usage limit reached
Resets 5:00 PM

[ Resume at reset ] [ Snooze until reset ]
```

Scheduled:

```text
Usage limit reached
Resets 5:00 PM · Auto-resume scheduled

[ Cancel auto-resume ] [ Snooze until reset ]
```

Snoozed:

```text
Usage limit reached
Snoozed until 5:00 PM

[ Resume at reset ] [ Wake now ]
```

Unknown reset:

```text
Usage limit reached
Reset time unavailable

[ Resume ] [ Change model/provider ]
```

The UI should not infer state from error prose.

## 15.2 Limits panel

The Limits panel should remain the detailed provider-account inspection surface.

Useful integration:

- recovery banner can deep-link/focus the relevant provider row;
- relevant account/model window can be highlighted;
- it can show where the selected reset timestamp came from.

But the Limits panel is not the recovery scheduler.

## 15.3 Settings

Primary new-layout file:

- `packages/app/src/components/settings-v2/general.tsx`

Suggested dense section:

### Usage limits

- **Auto-resume at reset**  
  Continue interrupted sessions when the provider reports a trustworthy reset.

- **Snooze until reset**  
  Park limited sessions until their allowance returns.

Use server-global config state.

Legacy settings may mirror the capability only if the retained legacy surface still requires parity; V2 is the product priority.

---

## 16. UI performance rules

Do not introduce one-second timers for every limited sidebar row.

Existing code already demonstrates why: the Limits panel bounds mounted countdown subscribers because hundreds of ticking nodes are wasteful.

Recommended strategy:

- server stores absolute timestamps;
- active session can use one shared display clock if a live relative countdown is desired;
- sidebar uses absolute/reset-at text or a shared app-level clock;
- buttons that become invalid exactly at reset can use a single `setTimeout(resetAt - now)` while mounted;
- execution scheduling is never tied to renderer timers.

The server event updates state; the UI renders state.

---

## 17. Server event/API shape

Do not expand the compatibility-sensitive `SessionStatusEvent.Info` union merely to represent recovery.

Prefer a fork-owned event/projection, for example:

```ts
session.limit_recovery.updated
session.limit_recovery.cleared
```

Example projection:

```ts
type SessionLimitRecoveryView = {
  sessionID: string
  sourceMessageID: string
  providerID: string
  accountID?: string
  modelID: string

  resetAt?: number
  resetSource?: LimitResetSource
  observedAt?: number

  autoResume: boolean
  snoozeUntil?: number
  generation: number

  state:
    | "limited"
    | "scheduled"
    | "due"
    | "blocked"
}
```

Mutation API should be CAS/fenced by generation:

```
set autoResume
set snoozeUntil
wake now
cancel autoResume
manual resume
```

A stale GUI request must not update a newer recovery generation.

---

## 18. Performance targets

These began as engineering targets. The closeout audit confirms the architectural properties below; it did not add a synthetic microbenchmark suite solely for this feature.

### Failure hot path

Creating/updating recovery state:

- O(1) keyed DB write;
- no transcript scan;
- no provider-list scan;
- no extra quota network call unless failure lacks a trusted reset and enrichment is needed.

Target incremental CPU overhead: effectively noise relative to terminal error processing.

### Idle scheduler

When no armed recoveries:

- zero periodic per-session work;
- one process-global clock remains armed with a bounded 60-second durable recheck.

When future recoveries exist:

- one next-due indexed query no more often than once/minute;
- no full table scan;
- no workspace bootstrap.

### Due batch

- bounded rows per batch;
- concurrency 2 is a proven in-repo default for cold activation;
- jitter bursts sharing a provider reset boundary;
- trusted failure-time/provider reset evidence is resolved before autonomous arming; advisory enrichment does not create an additional due-time polling loop.

### GUI

- zero per-row one-second intervals in sidebar;
- no transcript scanning to detect Limited state;
- one compact projection per session;
- reuse shared quota transport rather than duplicate provider HTTP calls.

---

## 19. Thundering-herd protection

A reset boundary can release many sessions simultaneously.

This is especially likely for:

- daily free tiers;
- account-wide five-hour windows;
- weekly subscription windows.

Required protections:

1. batch due rows;
2. bounded Session activation;
3. small deterministic jitter inside a short post-reset window;
4. provider/account grouping where useful;
5. quota refresh single-flight;
6. ProviderRouteHealth revalidation;
7. stop dispatching new recoveries if the first resumed request proves the account is still limited and publishes a newer reset.

A single resumed failure should be able to move the rest of that account's pending recoveries to the newer deadline without making every session hit the provider.

That is a useful improvement over a naive timer-per-thread design.

---

## 20. Clock and restart correctness

### Sleeping laptop

Never trust that a timer fired on time.

On wake:

- read current clock;
- query `reset_at <= now`;
- process overdue work.

### Clock moves backward

Use persisted absolute timestamps and re-query.

Do not extend recovery merely because a scheduled in-memory delay became inconsistent.

### Clock moves forward

Overdue recoveries become due.

### Restart before reset

The database row survives; runner arms from `nextDueAt`.

### Restart after reset

Due query finds overdue row; recovery runs after startup grace/revalidation.

No timer restoration table is needed.

---

## 21. Stale-recovery invalidation matrix

| Change after limit stop | Auto-resume behavior |
|---|---|
| New genuine user message | Cancel/supersede |
| User manually resumes | Consume/cancel old auto recovery |
| Provider switch | Cancel old automatic recovery |
| Account switch | Cancel old automatic recovery |
| Model switch | Cancel unless recovery semantics explicitly say same quota domain and user opted in |
| Session archived/deleted | Cancel |
| Explicit Stop/abort | Cancel |
| Session paused | Keep durable, do not run |
| Pending permission/question | Keep armed, do not run |
| Reset time replaced by newer authoritative reset | Bump generation and reschedule |
| Snooze toggled | Does not inherently cancel auto-resume |
| Auto-resume toggled off | Keep limited state, remove from due scheduler |
| Quota refresh fails | Do not destroy stronger existing failure-local reset; revalidate later |
| Route still blocked at due | Reschedule/back off using newer evidence; do not hammer |

---

## 22. Security and safety

Provider-controlled error text must not become executable control data.

Recovery should consume only bounded, normalized fields:

- failure class;
- provider/account/model IDs;
- reset timestamp;
- provenance;
- stable source message ID.

Do not serialize arbitrary provider response bodies into the recovery table or event.

Use existing credential-safe redaction and quota adapter boundaries.

---

## 23. Observability

Add structured events/metrics for:

- limit stop observed;
- reset source chosen;
- recovery armed;
- snooze applied;
- recovery due;
- recovery claim won/lost;
- stale fence reason;
- continuation admitted;
- recovery consumed;
- due-time provider still limited;
- reset moved;
- recovery cancelled by user activity.

Useful counters:

```
usage_limit_recovery.created
usage_limit_recovery.armed
usage_limit_recovery.resumed
usage_limit_recovery.stale
usage_limit_recovery.superseded_by_user
usage_limit_recovery.rescheduled
usage_limit_recovery.reset_source.<source>
```

Do not log secrets or raw provider headers.

---

## 24. Implementation record by slice

### Slice 0 — behavioral contract — **complete**

The recovery contract is now encoded in Core/OpenCode tests rather than existing only in this document: trusted reset provenance, generation fencing, durable claims, exact Synthetic admission, queue ordering, user supersession, route identity, and single-clock behavior all have focused coverage.

### Slice 1 — failure semantics — **complete**

Primary implementation:

- `packages/opencode/src/session/retry.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/limit-recovery-reset.ts`

Eligible terminal quota/rate-limit failures are observed durably. Strict failure-time retry evidence is preserved separately from asynchronous quota enrichment.

### Slice 2 — Core recovery aggregate — **complete**

Implemented files:

- `packages/core/src/session/limit-recovery.ts`
- `packages/core/src/session/limit-recovery.sql.ts`
- `packages/schema/src/session-limit-recovery.ts`

Implemented behavior includes one-row-per-Session state, generation CAS, direct lookup, due/next-due queries, durable explicit manual-resume authority, trusted automatic arming, advisory/trusted snooze state, claims with expiry, deterministic continuation identity, cancel, and FK cascade. Manual authority is preserved against slower quota enrichment and repeated observations of the same stopped assistant/route.

### Slice 3 — quota/reset bridge — **complete**

Implemented files:

- `packages/opencode/src/session/limit-recovery-quota.ts`
- `packages/opencode/src/session/limit-recovery-reset.ts`
- existing quota reset agenda/adapters.

The selector requires exact route scope where necessary, rejects non-exhausted windows, downgrades percentage-free/stale evidence to `observed`, and only emits trusted `provider` provenance when the provider observation is sufficiently correlated with the confirmed failure. Recovery asks the Quota service for a provider-scoped reset projection; OpenCode Go therefore uses the same canonical shared fork-usage snapshot path as the global reset agenda instead of trying to treat its ordinary provider result as a reset source.

### Slice 4 — continuation materialization — **complete**

Primary files:

- `packages/opencode/src/session/prompt.ts`
- `packages/core/src/session/input.ts`

The final implementation deliberately does **not** write recovery turns directly into V1 transcript storage. It admits one deterministic Synthetic input through `SessionInput.admitSynthetic` as `automatic/queue/userPreemptible`, freezes the expected latest-user sequence, carries explicit recovery provenance/execution identity, and uses exact-ID promotion to preserve the interrupted-turn-before-preexisting-queue ordering rule. After a successful recovery with no genuinely pending admitted work, the provider drain terminates instead of making the retired synthetic/original source turn eligible for an accidental second dispatch.

### Slice 5 — recovery runner — **complete**

`packages/opencode/src/session/limit-recovery-runner.ts` is mounted as a process-global AppRuntime node. It owns one bounded clock, indexed durable due queries, short claims, bounded dispatch, existing-owner deferral, exact Session directory/workspace activation, and durable re-arming.

### Slice 6 — server API/events — **complete**

The Effect HttpApi exposes generated-SDK-backed get/auto-resume/manual-resume/snooze/wake/cancel operations with generation fencing. `resume` persists explicit manual execution authority; `wake` only clears snooze/attention state. Recovery publishes additive Updated/Cleared events and leaves the compatibility-sensitive SessionStatus union unchanged.

### Slice 7 — V2 UI — **complete**

The new-layout composer mounts `LimitRecoveryProvider` and the recovery shelf. The shelf is provider/reset aware and exposes Resume now, Resume at reset, Cancel auto-resume, Snooze until reset, Wake now, and Cancel recovery. Trusted reset evidence is required only for unattended Resume at reset; any known future advisory reset may drive the display and Snooze until reset. Settings seed server-owned defaults. The projection reducer is generation-aware so a delayed clear for N cannot erase N+1.

### Slice 8 — provider hardening — **complete at the normalized recovery boundary**

Provider-specific quota adapters continue to own provider extraction. Recovery consumes the normalized reset agenda conservatively instead of adding provider-specific execution code. The focused selector suite validates account/model correlation, exhaustion evidence, freshness, and advisory downgrade behavior. This closeout did not duplicate every adapter's own provider tests inside the recovery package.

---

## 25. Verification matrix

### 25.1 Classification and reset trust

- **Verified:** numeric and HTTP-date Retry-After focused tests.
- **Verified:** malformed/invalid Retry-After does not become trusted recovery authority.
- **Verified:** eligible account/public quota and rate-limit terminal classes feed the recovery path.
- **Verified:** stale provider observations and percentage-free reset evidence are downgraded to advisory `observed`.
- **Verified:** only `retry-after` / trusted `provider` sources are autonomously armable.
- **Verified:** advisory `observed` / `local` / `inferred` future deadlines may still drive reset display and snooze without becoming unattended execution authority.
- **Verified:** OpenCode Go provider-scoped recovery enrichment uses the canonical shared fork-usage snapshot path before reset selection.

### 25.2 Durable recovery state

- **Verified:** duplicate observation of the same stop is idempotent and preserves the generation/frozen user fence/claim.
- **Verified:** changed route identity advances generation and stale generations cannot mutate/claim.
- **Verified:** once explicit manual Resume is durably requested for the same stopped assistant/route, a slower reset re-observation cannot silently replace that user authority with a new automatic generation.
- **Verified:** disabled auto-resume is excluded from due work.
- **Verified:** durable claim exclusivity before expiry and fresh-process reclaim exactly at expiry.
- **Verified:** manual Resume is immediately due without mutating advisory reset provenance into a trusted source, consumes auto-resume, clears snooze, and uses the same durable claim path as automatic recovery.
- **Verified structurally:** Session deletion cascades the recovery row through the FK.

### 25.3 Continuation and human-focus fencing

- **Verified:** exact stopped turn is continued; the failed provider request is not replayed.
- **Verified:** pre-existing queued User work remains behind the recovery continuation.
- **Verified:** a genuinely newer User turn supersedes/revokes automatic recovery.
- **Verified:** deterministic recovery replay promotes exactly once.
- **Verified:** provider/model/account route mismatch retires automatic recovery before a second provider dispatch.
- **Verified:** explicit manual Resume can continue from advisory reset evidence without granting that evidence automatic authority.
- **Verified:** a settled recovery with no pending admitted work exits the drain instead of replaying the original pre-limit User turn.
- **Verified structurally:** permission/question gates defer continuation; paused/archive state prevents unattended activation.
- **Verified:** completed-continuation crash repair clears the stale cursor rather than replaying the completed turn.

### 25.4 Runner / restart / duplicate dispatch

- **Verified:** one clock owner; wake storms coalesce and batches never overlap.
- **Verified:** stale asynchronous timer-arm completion cannot install a second timer.
- **Verified:** stop invalidates an in-flight arm.
- **Verified:** claim expiry is the crash/restart handoff and allows another runtime to reclaim the same generation.
- **Verified:** a concurrent/live Session execution owner keeps synthetic work durable and prevents competing recovery execution; `SessionExecutionOwner` is the final cross-runtime execution fence while the short recovery claim only deduplicates wake attempts.
- **Verified structurally:** `SessionExecutionOwner.snapshot()` is checked before `InstanceStore.provide()`, so a live owner causes zero recovery cold-workspace bootstraps.
- **Verified structurally:** exact durable `session.directory` plus `WorkspaceRef(session.workspaceID)` are used for cold activation.
- Batch size is 50 and dispatch concurrency is 2; no unbounded all-session sweep exists.

### 25.5 HTTP / SDK / UI

- **Verified:** all six recovery HttpApi routes pass canonical coverage-mode scenarios.
- **Verified:** all six pass effect-mode scenario execution.
- **Verified with harness caveat:** auth mode returns the expected unauthorized result for five routes; the first cold GET probe reports harness status 0 before graph warm-up. All six endpoints are members of the same Authorization-middleware HttpApi group.
- **Verified:** generated `sessionLimitRecovery.*` SDK surface is used by the GUI; the obsolete/fake `limitRecovery.update` path is absent.
- **Verified:** Schema, OpenCode, and SDK typechecks pass.
- **Verified:** SDK OpenAPI generation/build completes on retry after an intermittent Windows Prettier file-open failure.
- **Verified:** App production build passes.
- **Verified:** recovery state is additive; `idle | busy | retry` remains the SessionStatus compatibility family.
- **Verified:** V2 shelf exposes manual resume, auto-resume, snooze/wake, auto-resume cancellation, and recovery cancellation.

### 25.6 Known non-recovery gate state

- Core package-wide typecheck is presently blocked by unrelated concurrent Skill API work in `src/skill.ts` and `test/tool-skill.test.ts`.
- App package-wide typecheck is presently blocked by unrelated concurrent Code Mode/tool-metadata shape work. The recovery context/shelf do not appear in the diagnostics.
- OpenCode, Schema, and SDK package typechecks are green.
- SDK full build is green on retry; the first closeout invocation reproduced the intermittent Windows generated-file open failure during Prettier.
- The full HttpApi `--fail-on-missing` gate remains globally blocked by 179 unrelated missing route scenarios. Recovery contributes zero missing scenarios after this closeout.
- A filtered auth-only run has a known harness cold-start artifact: its fixed one-second first-probe deadline can expire while the HttpApi graph initializes. Five subsequent recovery auth probes pass once warm; the recovery API group remains behind the normal `Authorization` middleware.

---

## 26. Rejected designs

### Rejected: renderer timer calls resume

Fails when:

- desktop/browser is closed;
- app sleeps;
- route changes;
- renderer crashes;
- another device changed state.

Execution scheduling belongs to the server.

### Rejected: long `setTimeout(resetAt - now)`

Fails sleep/wake and clock correctness and complicates restart.

Use absolute deadline + bounded re-read timer.

### Rejected: poll all sessions every five seconds

Unnecessary DB wakeups and does not leverage OpenFork's existing scheduler quality.

### Rejected: hidden Scheduled Tasks

Wrong domain ownership and too much task machinery.

### Rejected: use ProviderRouteHealth as recovery table

Wrong key/domain. It knows route health, not exact stopped Session turn.

### Rejected: quota factory independently pauses inference

Violates the quota factory's advisory contract.

### Rejected: infer Limited by parsing error text in the GUI

Fragile, provider-specific, not durable.

### Rejected: replay failed provider request

Unsafe after partial tool/side-effect execution.

### Rejected: auto-resume an inferred reset with no revalidation

Turns an estimate into execution authority.

---

## 27. Final implemented architecture

The shortest complete description is:

```text
                    provider failure
                          |
                          v
                 SessionRetry.classify
                          |
               confirmed usage-limit
                          |
                          |
                          v
                failure-time reset
           strict Retry-After / quota enrichment
                          |
                          v
                SessionLimitRecovery
                 durable Core cursor
                          |
            +-------------+-------------+
            |                           |
            v                           v
         V2 GUI                 LimitRecoveryRunner
 durable mutations only           one global clock
                                        |
                           durable claim + owner check
                                        |
                           exact Session/workspace activation
                                        |
                                  SessionPrompt
                                        |
                   trusted reset / user / route / interaction fences
                                        |
                            SessionInput.admitSynthetic
                     automatic + queue + userPreemptible
                                        |
                              exact-ID promotion
                                        |
                                  normal V1 runtime
```

The important separation is:

- **classification** proves the stop;
- **failure-time reset evidence / quota enrichment** names the deadline and preserves provenance;
- **recovery cursor** says whether this exact Session turn may continue;
- **runner** wakes and claims it without racing an existing execution owner;
- **SessionPrompt** revalidates the stopped turn and admits a deterministic continuation;
- **SessionInput** owns the atomic human-focus fence and transcript projection;
- **GUI** only controls/displays it.

ProviderRouteHealth remains orthogonal route-health infrastructure; it is not read as an independent recovery execution-authority source.

---

## 28. Closeout findings

The original highest-priority findings are now resolved in the implementation:

1. **Terminal usage limits are durable state** through SessionLimitRecovery.
2. **Recovery reset authority is normalized and provenance-bearing**; strict failure-time/provider evidence is distinguished from advisory observations.
3. **Exact stopped-turn identity is persisted** together with provider/account/model and the frozen latest-user sequence.
4. **Queue ordering is explicit:** recovery runs before user work that was already queued at the stop, while a genuinely newer user turn atomically supersedes it.
5. **Continuation is canonical SessionInput work**, not a direct V1 transcript append.
6. **T3 compatibility status contracts remain unchanged**; recovery uses fork-owned events/projection.
7. **Normal-session defaults are server/config owned** and V2 Settings edits those defaults.
8. **Goal autonomy remains intrinsic** rather than gaining a new policy switch.
9. **Deadline scheduling is indexed and process-global**, with no five-second global Session scan and no per-session timers.
10. **Crash/restart and duplicate-delivery behavior are explicit:** short durable claims are reclaimable after expiry and deterministic Synthetic identity promotes once.
11. **Existing execution ownership is honored before workspace bootstrap**, preventing a recovery runner from racing an already-live Session.
12. **The V2 GUI is on the generated SDK surface** and exposes the full manual/automatic/snooze/wake/cancel lifecycle.
13. **Manual Resume is a distinct durable authority**, not an alias for wake/unsnooze and not a forged trusted reset; it may use the current selected route and survives a process restart until consumed or superseded.
14. **Recovery settlement does not replay the original turn.** When no admitted work remains after the synthetic continuation commits, the drain exits instead of re-selecting historical source input.
15. **Route identity participates in recovery generation identity.** Provider/account/model changes for the same stopped assistant advance the generation rather than overwriting route metadata under an old fence.
16. **Advisory reset evidence remains useful without becoming authority.** Observed/local/inferred future deadlines can drive reset display and snooze, while unattended execution remains restricted to Retry-After/provider-authoritative evidence.
17. **OpenCode Go reset enrichment follows its canonical snapshot path.** Provider-scoped recovery asks Quota for the same shared fork-usage projection used by the reset agenda.

---

## 29. Source index: T3 Code

- <https://github.com/pingdotgg/t3code/commit/de343914273eceb852a1d1d739cd1d38df7796ee>
- <https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts>
- <https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/ProjectionStore.ts>
- <https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/ProviderFailure.ts>
- <https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Orchestrator.ts>
- <https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts>
- <https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts>
- <https://github.com/pingdotgg/t3code/blob/main/apps/server/src/scheduling/Scheduler.ts>
- <https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx>
- <https://github.com/pingdotgg/t3code/blob/main/apps/mobile/src/features/threads/UsageLimitRecoveryCard.tsx>
- <https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestrationV2.ts>
- <https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/settings.ts>
- <https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/orchestrationV2ThreadError.ts>
- <https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md>

---

## 30. Source index: OpenFork live tree

### Architecture

- `AGENTS.md`
- `FORK.md`
- `docs/map/README.md`
- `docs/map/architecture.md`
- `docs/map/v1-v2.md`
- `docs/map/surfaces.md`
- `docs/map/upstream-fork.md`
- `docs/architecture/compatibility-boundary.md`
- `docs/architecture/t3code-compatibility.md`

### Failure / runtime

- `packages/opencode/src/session/retry.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/limit-recovery-runner.ts`
- `packages/opencode/src/session/limit-recovery-reset.ts`
- `packages/opencode/src/session/limit-recovery-quota.ts`
- `packages/opencode/src/session/status.ts`
- `packages/opencode/src/session/run-state.ts`
- `packages/opencode/src/session/goal-continuation-recovery.ts`
- `packages/core/src/provider-route-health.ts`
- `packages/core/src/session/input.ts`
- `packages/core/src/session/limit-recovery.ts`
- `packages/core/src/session/limit-recovery.sql.ts`
- `packages/core/src/session/sql.ts`
- `packages/core/src/goal/sql.ts`
- `packages/schema/src/session-limit-recovery.ts`
- `packages/schema/src/session-status-event.ts`

### Quota / usage

- `packages/opencode/src/quota/quota.ts`
- `packages/opencode/src/quota/schema.ts`
- `packages/opencode/src/quota/registry.ts`
- `packages/opencode/src/quota/resets.ts`
- `packages/opencode/src/quota/providers/claude.ts`
- `packages/opencode/src/quota/providers/codex.ts`
- `packages/opencode/src/quota/providers/opencode-go.ts`
- `packages/opencode/src/quota/providers/opencode-zen.ts`
- `packages/opencode/src/quota/providers/kimi.ts`
- `packages/opencode/src/quota/providers/xai.ts`
- `packages/opencode/src/quota/providers/nvidia.ts`
- `packages/opencode/src/quota/providers/workbuddy.ts`
- `packages/opencode/src/quota/providers/openrouter.ts`
- `packages/opencode/src/quota/providers/deepseek.ts`
- `packages/opencode/src/quota/providers/genspark.ts`

### Scheduling

- `packages/opencode/src/session/limit-recovery-runner.ts`
- `packages/opencode/src/scheduled-task/runner.ts`
- `packages/opencode/src/scheduled-task/wake.ts`
- `packages/opencode/src/scheduled-task/session-admission.ts`
- `packages/core/src/scheduled-task/index.ts`
- `packages/core/src/scheduled-task/sql.ts`
- `packages/core/src/scheduled-task/lease.ts`

### Configuration / UI

- `packages/core/src/v1/config/config.ts`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/session-limit-recovery.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session-limit-recovery.ts`
- `packages/app/src/context/server-sync.tsx`
- `packages/app/src/context/limit-recovery.tsx`
- `packages/app/src/components/limit-recovery-composer-shelf.tsx`
- `packages/app/src/hooks/use-limits/index.ts`
- `packages/app/src/pages/session/limits-panel.tsx`
- `packages/app/src/components/prompt-input-v2.tsx`
- `packages/app/src/components/settings-v2/general.tsx`
- `packages/app/src/i18n/en-core.ts`
- `packages/app/src/i18n/en-settings-general.ts`
- `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- `packages/sdk/js/src/v2/gen/types.gen.ts`

### Focused verification

- `packages/core/test/session-limit-recovery.test.ts`
- `packages/core/test/session-input-lifecycle.test.ts`
- `packages/core/test/config/config.test.ts`
- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/session/retry.test.ts`
- `packages/opencode/test/session/limit-recovery-runner.test.ts`
- `packages/opencode/test/session/limit-recovery-quota.test.ts`
- `packages/opencode/test/server/httpapi-exercise/index.ts`

---

## 31. Final implementation state

OpenFork's first-party usage-limit recovery is implemented as a **Core-owned durable Session recovery capability** backed by OpenFork's own provider-failure semantics, reset normalization, SessionInput admission, execution ownership, deadline scheduling, generated HttpApi/SDK surface, and V2 presentation.

The shipped architecture preserves the useful T3 product invariants without inheriting T3's orchestration shape:

- exact stopped-turn/reset identity;
- server-owned recovery and restart survival;
- durable explicit manual-resume authority;
- independent snooze and auto-resume;
- explicit reset provenance;
- generation-fenced mutations;
- deterministic, user-preemptible continuation;
- indexed bounded scheduling;
- existing-owner deferral before workspace activation;
- zero client execution authority;
- unchanged SessionStatus compatibility family.

The live tree had already moved the recovery continuation onto SessionInput admission before the final reconciliation. This closeout then found and fixed the remaining product/correctness gaps: the missing distinct manual Resume path, duplicate source-turn replay after an otherwise successful recovery, OpenCode Go's missing canonical snapshot enrichment, route-identity generation ambiguity, manual-authority overwrite by later observations, and the accidental coupling of advisory snooze eligibility to autonomous reset trust.

The feature-specific tests, App production build, SDK build, and Schema/OpenCode/SDK type gates are green. Core and App package-wide typechecks remain red only on unrelated concurrent Skill and Code Mode/tool-metadata work, and the auth exerciser retains the documented first-probe cold-start artifact. Those limitations are recorded explicitly in Section 25.6 rather than being hidden by recovery-scoped edits.

This document is therefore the implementation-and-verification record for the first-party feature, not a pending architecture proposal.


---

## 32. Post-interruption reconciliation — 2026-10-05

The earlier closeout in Sections 25–31 was re-opened after a fresh OXP/runtime/tree reconciliation. The live repository remained on `main@1d96902911`, but the shared worktree continued to change underneath verification. The recovery-specific source files remained an untracked implementation lane while generated database registries were tracked and dirty alongside unrelated pending migrations. No reset, stash, clean, broad restore/checkout, rebase, mass-format, or unrelated repair was used.

### 32.1 Newly discovered generation-reuse defect

Independent review found a release-significant hole in the original generation CAS design. The operational `session_limit_recovery` cursor is intentionally deleted when recovery settles or is cancelled. Generation had previously been derived only from the currently present cursor:

```ts
const generation = unchanged ? current.generation : (current?.generation ?? 0) + 1
```

After deletion, a later unrelated recovery for the same Session could therefore reuse generation `1`. A stale client that had retained the old generation could then satisfy the generation predicate against the new cursor and issue a mutation such as manual Resume or cancel against the wrong recovery generation.

The repaired design separates cursor lifecycle from the monotonic fence. Core now owns a durable `session_limit_recovery_epoch` row keyed by Session. Fresh recovery generations transactionally insert generation `1` or increment that persistent high-watermark; duplicate observations of the current exact stop continue to reuse the current cursor generation. Deleting the operational cursor no longer resets the generation namespace. The epoch row cascades only when the Session itself is deleted.

The canonical migration generator created:

- `packages/core/src/database/migration/20261005054655_careful_tarot.ts`

which creates `session_limit_recovery_epoch`. The repository had pre-existing migration-registry lag from several unrelated migrations; running the canonical generator consequently refreshed those ambient registry/schema entries as well. Those unrelated entries were not manually edited or normalized as part of recovery work. A subsequent `bun run migration --check` reported no pending schema changes.

A new file-backed Core regression proves the repaired semantics end-to-end:

1. create recovery generation 1;
2. cancel/delete its operational cursor;
3. reopen through the durable database and observe a different recovery;
4. receive generation 2 rather than reusing 1;
5. attempt manual Resume with stale generation 1;
6. verify the mutation is rejected and generation 2 remains unchanged.

Current focused Core recovery result: **8/8 passed, 70 assertions**.

### 32.2 Client projection ordering defect and tombstone repair

The previous V2 projection guarded `Updated(N)` against overwriting a locally newer generation and guarded delayed `Cleared(N)` against deleting `N+1`. Fresh review exposed the reverse ordering problem: after `Cleared(N)` sets the projection to `null`, a delayed `Updated(N)` has no remaining local generation to compare against and could resurrect a cursor that is already gone.

A second race existed on the control plane: the shelf's `refresh()` is not bootstrap-only; it is also the mutation-error reconciliation path. An in-flight GET can therefore race SSE or a mutation response in either direction.

The V2 recovery context now retains a per-Session `clearedGeneration` watermark. Projection admission rejects any `Updated` whose generation is less than or equal to that tombstone, while a genuinely newer generation remains admissible. GET reconciliation records the generation/tombstone visible when the request began and refuses stale in-flight results to regress newer projection activity. Clear events advance the tombstone and only clear a current generation that is not newer than the clear. Local cancel advances the same tombstone. Mutation responses are also merged through the same monotonic rule rather than written unconditionally.

A new pure App regression verifies:

- older generations cannot regress a newer projection;
- `Cleared(2)` prevents delayed `Updated(2)` and `Updated(1)` from resurrecting state;
- generation 3 is accepted after the generation-2 tombstone.

Current focused App projection result: **1/1 passed, 7 assertions**.

### 32.3 Fresh current-byte verification after the repairs

Measured on the reconciled post-fix bytes:

- Core `session-limit-recovery.test.ts`: **8/8 passed**, including file-backed restart/claim reclaim and post-delete monotonic generation fencing.
- OpenCode quota/runner/retry focused suite: **85/85 passed**, **132 assertions**.
- Schema recovery event contract: **1/1 passed**, **7 assertions**.
- App recovery projection regression: **1/1 passed**, **7 assertions**.
- Prompt automatic continuation cases: **3/3 passed** for interrupted-turn ordering, genuine-user supersession, and durable route mismatch retirement.
- Prompt explicit manual Resume case: **1/1 passed**, proving advisory `observed` reset evidence remains non-authoritative while explicit durable user authority continues the turn.
- Recovery HttpApi integration: **1/1 passed**, **13 assertions**, including bootstrap-free generation-fenced control and fork event publication.
- Core typecheck: **passed**.
- Schema typecheck: **passed**.
- SDK typecheck: **passed**.
- Database migration consistency check: **passed** with no pending schema migration.
- App typecheck passed once during this reconciliation, then a later rerun failed only because concurrent `packages/session-ui/src/components/markdown.tsx` introduced an unrelated undefined `updateLiteralParagraphBlock` reference. No recovery file appears in that diagnostic.
- Broad OpenCode typecheck remains red only on concurrent non-recovery work including support-bundle CLI typing, timeline-read readonly query typing, compatibility tests, and unrelated test typing. Recovery-specific focused tests remain green.

The generated V2 SDK still exposes the canonical `SessionLimitRecovery` surface, and the real runtime still mounts `LimitRecoveryRunner.node` in both the direct AppRuntime graph and the served HttpApi graph. No fake recovery client or compatibility-sensitive SessionStatus extension was introduced.

### 32.4 Closeout correction

The earlier blanket statement that generation-fenced mutations were complete was too strong because it considered only mutations while an operational cursor row existed. The durable epoch repair closes the delete/recreate namespace hole. Likewise, the earlier client ordering proof covered delayed clear versus newer update but not delayed update versus a completed clear; the cleared-generation watermark closes that reverse ordering.

Accordingly, the implementation closeout should be evaluated from this Section 32 evidence rather than the earlier pre-reconciliation counts. The architecture remains unchanged at the control-plane level: durable SQLite authority, one bounded process-global recovery deadline owner, trusted-only unattended reset authority, explicit durable manual authority, Synthetic queue admission with a frozen user-focus fence, and SessionExecutionOwner as the final cross-runtime execution exclusion boundary.
