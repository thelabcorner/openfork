# OpenFork Swarm — AX / Agent Experience audit and repair

**Date:** 2026-10-09  
**Scope:** Native `swarm_create`, lazy coordinator `swarm`, always-visible `swarm_member`, external OXP `openfork_swarm`, common Swarm/Core execution paths, provider-visible schemas and result/error/continuation contracts.  
**Method:** User's actual **AX — Agent Experience Engineering v1.0** skill: intent → discovery → selection → parameters → authorization → execution → state recognition → verification → recovery/handoff. This is an engineering audit, **not a statistically calibrated measure of task success**. The referenced AX-16 supporting principles file was not independently available; the 16 rows below operationalize the retrieved SKILL.md requirements, not a falsely quoted official 16-axis scale.

## Test goals and authority map

| Agent goal (natural-language intent) | Correct entry | Proof of completion | Failure injection |
| --- | --- | --- | --- |
| "Start a team to work on X" | Native `swarm_create` or OXP `openfork_swarm(delegate)` | Persisted Swarm and roster **then** actual member Session/task runs | Invalid model, bad initial dependency, missing coordinator authorization, interrupted creation |
| "Add the next three independent specialists" | Native/OXP lazy `swarm(member.batch)` | Per-member `created/satisfied/failed` + inspected roster/bindings | One rejected profile, stale name, stopped worker, authority revoked after prior commit |
| "Split project into tasks with dependencies" | `swarm(task.batch)` | Task IDs and blocked/ready status, persisted prerequisite edges | Invalid task, missing prerequisite, cycle, interrupted stage |
| "I'm a worker, what is my assignment?" | `swarm_member(status)` | Session-bound membership and current running task | Not a member, several Swarms, no running lease, stale binding |
| "Send an update to the team" | `swarm_member(send)`, recipient name or `all` | Durable message/delivery receipt; not necessarily delivered/seen | Unknown recipient, blank body, revoked member |
| "Read all shared work / inbox" | `swarm_member(shared.get/inbox)` | Exhaust pages until `complete=true`, independent task verification | >page limit, same-timestamp message ties, cross-member isolation |
| "End a task / resolve unknown effects" | Worker `done/fail`; coordinator `task.review` and explicitly authorized recovery actions | Exact TaskRun settlement / adjudication under current lease generation | Stale lease, interrupted external effect, denied admin grant |

### Observed producer/transport inventory

- **Running connected OXP binary:** `capability.list(query="swarm")` discovers one lazy `openfork_swarm`; its `capability.describe` is **8,878 characters**, inputSchema **7,815 characters**, **33 actions**, **53 top-level fields**, **0 parameter descriptions**. The live binary does **not** expose `member.batch`, `task.batch`, or `focusAction`. This is a *real deployment skew*, not absence of code. Connected host status says `runtime.refreshable=false`; rebuilding source does not refresh this existing connection.
- **Checkout source (Bun source-schema projection):** **35 action enums**, **53 top-level fields**, **53 descriptions**, **13,613-character** full inputSchema. The prior generic `focusAction` did not support flat Swarm enums. AX now adds an explicitly reviewed, schema-derived focused projection for the three commonly used delegation actions; all other actions retain the complete descriptor.
- `swarm_create` accepts flattened worker models (`providerID/modelID/permissionBoundary/workspace`) while coordinator `member.batch` accepts nested `desiredProfile.model.id` and `workspacePolicy.mode`. Both execute the same domain owner but have different input spelling. This **is** a source-backed parameterization burden; indiscriminate schema widening would cause ambiguity, so any unification must preserve the existing callers and explicit grants.
- `swarm_member` is a separate always-visible 8-action *worker* contract with Session-derived membership and no model-authored Swarm/member/task authority IDs. This is a valuable AX safety/ergonomics affordance; preserve it. The 35-action coordinator surface remains lazy by policy.

### AX-16 operational audit

Legend: **GOOD** supported by code/tests; **IMPROVED** defect addressed in this change but not yet independently model-evaluated; **OPEN** unresolved or unproven. Do not add these as an artificial numerical agent success score.

| # | Decision lens | Observed state/evidence | Result | Next experiment/fix |
| --- | --- | --- | --- | --- |
| 1 | Capability propensity / unnamed discovery | OXP search finds `openfork_swarm`; native `swarm_create` eager and `swarm` lazy | GOOD | Test unprompted model routing across families |
| 2 | Tool-selection contraindications | Worker tool distinct from coordinator/admin; OXP metadata generic | GOOD | Test wrong tool selected for task settlement |
| 3 | Discovery/context overhead | Live 8.9k-char descriptor/53 fields with zero explanations; focused contract patch only in checkout | IMPROVED | Verify focused descriptor, contract and field guidance in restarted external OXP; run model A/B |
| 4 | Schema learnability | Flat eager vs nested lazy worker profile; 35 coordinator verbs | OPEN | Compare standardized aliases/normalized wire with existing callers |
| 5 | Argument admission | Worker send/fail/shared.put/publish previously failed only after entering runtime | IMPROVED | Schema-error negative test + no unauthorized side effects |
| 6 | Defaults and constraints | Hard permission boundary, model preflight, typed state and caps | GOOD | Compare model mistake rate against examples |
| 7 | Identity and least privilege | Real caller Session for worker; OXP coordinator tag; force separately granted | GOOD | Repeat revocation tests on every external adapter |
| 8 | Irreversible/conditional effects | Task dependencies transactionally linked, lifecycle fences | GOOD | Race and interrupted-commit fault injection |
| 9 | Outcome truth / state interpretation | Native creation previously returned full aggregate but without clear persisted-vs-running emphasis | IMPROVED | Compare agents' false 'workers running' claims |
| 10 | Response/context economy | Native creation now emits IDs, partial receipts, verification next steps instead of full row dump | IMPROVED | Measure output bytes/tokens across realistic 1–8 member fixtures |
| 11 | Partial item progress | `member.batch` and `task.batch` independent receipts and prerequisite pruning | GOOD | Multi-profile latency/throughput measurement |
| 12 | Retry/idempotency | Member names and deterministic staged task IDs support replay, but **initial swarm_create lacks durable idempotency key** | OPEN | Add Core transaction idempotency key with receipt/state lookup |
| 13 | Unknown outcome/cancellation | Advice to inspect durable list; no general operation ID/status reconciliation route | OPEN | Add persisted invocation receipt for ambiguous crashes |
| 14 | Pagination/completeness | Worker `shared.get` had a dangling nextKey; worker inbox was silent bounded prefix | IMPROVED | Page all shared state and Core inbox tie timestamps |
| 15 | Injection/data trust | Peer content fenced by host renderers; task assignment belongs to trusted Session/runtime | GOOD | Adversarial instruction text fixtures |
| 16 | Verification/evaluation | Native OXP/Core tests available; user skill requires real model-controlled A/B harness to claim AX success | OPEN | Preregister same task corpus and real model trials |

## Repairs landed (source working tree, not deployed to attached OXP)

1. **Worker action schema preflight:** validate missing send-to/body, fail-kind, shared key/value and publish summary at the tool boundary **before** member lookup, permission checks or DB effects. Accept a deliberately supplied JSON `null` as a value. Reject misplaced pagination cursors with corrective guidance. Existing Session-derived authorization remains unchanged.
2. **Shared knowledge pagination:** `swarm_member(shared.get)` now accepts `afterKey=previous.nextKey`; the existing Core `blackboardPage` provides a real continuation. Responses include `hasMore`, `complete`, `nextKey` and the next permitted read, without pretending a truncated page is complete.
3. **Inbox pagination:** Core `memberInboxPage` uses a stable descending `(delivery.time_created, delivery.id)` keyset cursor under the exact Swarm/member/delivery-state predicates and bounded SQL `LIMIT limit+1`. Worker `inboxCursor={createdAt,id}` admits precisely that continuation and returns `hasMore`, `complete`, `next` and action guidance. Legacy `memberInbox` is retained for internal callers.
4. **Native creation outcome clarity:** new `SwarmAX.creation` projection consumed by native `swarm_create` and `swarm(delegate)`. Produces `outcome` (`applied/partial`), exact persisted Swarm and worker/task IDs with task keys, admission failures, truthful caveat that running execution is **unverified**, `swarm.get` verification route, staged-add next actions. Raw durable records are still accessible using existing scoped `get` and `task.runs`.
5. **Adaptive staging guidance:** removed fixed '**at most TWO**' from native create and lazy worker/task batch hints and OXP source errors. AX says use small batches when failure risk is unknown, increase toward the **existing** eight-member/task action ceiling when measured outcomes justify; *do not* optimize for minimum tool calls alone.
6. **Regression/contract coverage:** Core member inbox multi-page test includes equal timestamps/no gaps/no duplicates/no cross-member leaks; worker action/schema and cursor integration tests; coordinator tool creation receipt test; preserved prior actual native/OXP task and member partial-admission tests.
7. **OXP Swarm focused discovery:** `capability.describe({capability:"openfork_swarm",focusAction:"member.batch"|"task.batch"|"delegate"})` now narrows the *actual described contract* to an exact action and explicitly reviewed fields/requirements. Its generated schema retains reachable type definitions; the host's existing focused-contract validation refuses use with any other action. Local source-schema probes: original full **13,613 characters**; `member.batch` **4,451** (67.3% less); `task.batch` **2,026** (85.1% less); `delegate` **6,089** (55.3% less). These are characters in schemas, **not measured provider tokens**. Focus is deliberately unavailable for unreviewed actions.

### Findings not to mask

- **Connected OXP is stale**: unchanged running host advertises 33 actions (missing both batching verbs), no property descriptions, and no `focusAction`. **Neither source code changes nor source tests prove these improvements are live in the attached connector.** Restart/rebuild/re-approve and test actual broker descriptor and calls.
- **Action focus coverage is still partial**: only the three heavily used staged delegation actions are reviewed and supported; the remaining 32 source actions need individual field/authority matrices before they can be safely focused. Broker execution still validates the original full schema, authorization and per-leaf gates; focused descriptors do not grant privilege.
- **Initial creation retry ambiguity**: duplicate identical `swarm_create` can create a second independent Swarm. Avoid blind retry after transport loss until durable Core idempotency is added.
- **No universal dispatcher certification**: native/worker/Core/OXP tests do not by themselves certify Code Mode, OFXP, ACP and MCP transport actions. Track them individually in the parity ledger, not as a broad success claim.
- **No behavioral model benchmark in this patch**: static schema size, execution tests, and Core regressions are evidence of code correctness only. They are not measured propensity, completion-rate, or token-cost wins for actual models.

## Evaluation corpus (pre-registration proposal, NOT executed model trials)

Use consistent model versions, sampling settings, tool scopes, fixture DB state, and clear pass/fail assertions. Compare baseline (old surface) vs candidate in three configurations: unnamed tool discovery, named-tool use, and adversarial ambiguous state. Repeat across at least one high-reasoning and one inexpensive model family; distinguish not-discovered, not-selected, bad schema, authorization refusal, execution failure, state misinterpretation, and unverified success. Measure **fully verified task success**, unauthorized writes, unnecessary retries, total tool calls, context bytes, wall-clock latency, and failure recovery. Seed tasks: (a) create 4-member Swarm with one invalid model; (b) stage DAG with a missing prereq; (c) replay after uncertain commit; (d) continue >50 Blackboard entries; (e) page >20 inbox messages sharing timestamps; (f) try to settle stale held assignment; (g) revoked coordinator; (h) poisoned peer message. Only then claim real AX improvement quantitatively.

### Executed verification — October 9, 2026

- `packages/opencode`: `bun test test/tool/swarm-member.test.ts test/tool/swarm.test.ts test/tool/swarm-schema.test.ts test/swarm/command.test.ts test/oxp/swarm.test.ts` → **65 pass, 0 fail**, 396 assertions.
- `packages/core`: `bun test test/swarm/member-inbox.test.ts test/swarm/read-projections.test.ts` → **7 pass, 0 fail**, 63 assertions. Actual SQLite-backed inbox tie/continuation check passed.
- OXP quick verifier `bun packages/opencode/script/verify-oxp-native-parity.ts --quick` → **Core projection pass, OXP 101 pass/0 fail (1,114 assertions), overall pass**. A first run reported a worker-broker test failure, but that exact test passed isolated, and the full quick verifier subsequently passed; preserve both facts rather than claiming an identified fix for the transient.
- Reviewed focused OXP describe/contract test passes. Source-schema probe: full 13,613 chars, member batch 4,451, task batch 2,026, delegate 6,089.
- Focused `git diff --check` against the changed Swarm/AX/source/adapter/test files is **clean**. Whole-worktree `git diff --check` reports unrelated concurrent whitespace changes; not a claim of a globally clean dirty checkout.
- Latest OpenFork-host `tsgo --noEmit` still exits nonzero with errors outside the touched AX/Swarm source/tests (CLI, HTTP handlers and compat suites). **No diagnostics identified in the touched AX/Swarm files in the final filtered run**, but global release typecheck **is not certified**. Other concurrent changes remain untouched.

## Immediate remaining priorities

1. Rebuild/restart OXP host and remeasure broker schema including source-supported batch actions (deployment, not source).
2. Extend the reviewed per-action Swarm coordinator schema focusing beyond the three delegation actions, with executable action-level parity and permission tests.
3. Add durable Core creation idempotency/reconciliation IDs and immutable receipt lookup.
4. Unify model-selection ergonomics without silently relaxing explicit permission boundaries; quantify parser/selection errors using model harnesses.
5. Preserve/action-certify Code, OFXP, ACP, MCP; audit worker inbox pagination under concurrent delivery-state changes (keyset pages represent a moving view, not a snapshot).

**Version/rollout note:** Files in shared dirty working checkout, uncommitted; unrelated concurrent work must be preserved. Re-run tests and full typecheck before merging/releasing. Changes should not be represented as already deployed to the unrefreshable connected OXP host.

## Continuation: action-focused AX and retry safety (October 9, 2026)

This addendum **supersedes** the three-action schema coverage and initial-creation retry statements in the historical snapshot above. The older measurements/test counts are retained as reproducible earlier observations, not current results.

### Verified additional repairs in the checkout

- **Correctness defect in discovery:** The shared OXP JSON Schema compactor discarded every key called `description`, including real application payload fields of that name. The filter now drops *only string-valued schema annotations*. Native `task.create.description`, nested descriptions and array item descriptions remain present under `compact`, `balanced` and `full`, while optional annotation prose still respects budgets. Source tests cover the collision directly.
- **31/31 connector-supported Swarm actions now have reviewed, focused OXP contracts.** `SWARM_FOCUSED_ACTIONS` enumerates parameter sets and requirements for every non-`admin.*` Swarm action, retaining exact `$defs` references and the original executable decoder. Native force and four operator-only actions are intentionally absent. The broker contract changes with focused action and rejects cross-action reuse. The reviewed `message.send` focused contract represents recipient XOR broadcast; `task.settle` requires `failureKind` on failed settlement; bounded member/task batches expose 1–8 items. Discovery is **not** permission.
- **Safe, actionable validation failures:** `swarmArgumentDiagnostic` replaces the generic OXP Swarm decoder error with bounded missing-argument names, action focus instructions, and known conditional input corrections. Error text never echoes peer message bodies, sensitive provider/profile content, or user-supplied argument values. An executable broker-to-leaf test and pure adversarial-input tests prove the nonreflection behavior.
- **At-most-once initial creation when `requestKey` is supplied:** `swarm_create`, native lazy `swarm(delegate)`, and OXP `openfork_swarm(delegate)` now pass an optional, validated ASCII `requestKey` through the same domain owner. The owner derives a deterministic Swarm ID from project, workspace, directory, caller Session identity or trusted OXP connector identity, and key. Core `Swarm.create` reserves this identity in its existing durable insert transaction. Repeating the key yields a typed conflict with the **original Swarm ID**, even if changed input is submitted, rather than creating a duplicate or reporting false success. The caller must inspect durable `get`/`list` and original task receipts before proceeding.
- **Security invariant:** A creation key is **not** a capability, shared secret, optimistic success receipt or authority bypass. It is scoped to the authenticated coordinator identity, and all existing OXP root-grant revocation/native Session checks still run. A malformed or unscoped key fails before any Swarm write. Without a supplied key, historical random-ID creation behavior remains.

### Reproduced source-schema budget (point-in-time)

The evolving local schema projection currently measures **16,159 characters** for the balanced all-action OXP Swarm input contract, versus **31 focused action contracts** averaging **1,402**, median **793**, minimum **507**, maximum **7,211** characters; `delegate` is **7,211**, `member.batch` **4,650**, and `task.batch` **2,764**. These are `JSON.stringify` character counts after new annotations and projection changes, **not provider tokens, context occupancy, task success or runtime throughput**. A focused *on-demand* descriptor has lower per-invocation schema exposure; advertising all 31 upfront would be a regression.

### Continuation verification

- Seven-suite source regression `bun test test/tool/swarm-schema.test.ts test/swarm/command.test.ts test/tool/swarm.test.ts test/oxp/capability.test.ts test/oxp/swarm.test.ts test/oxp/swarm-focus.test.ts test/oxp/schema-projection-ax.test.ts` completed **108 passed, 0 failed, 1,292 assertions**. A follow-up correction-message fixture adds one additional passing unit test (4/4 in its own file). All three creation adapters have direct persisted-state and duplicate-conflict tests, including a cross-native eager/lazy retry. Newly added creation-key pattern checks reject malformed input at the provider-visible Schema boundary, with the domain validator as a second guard.
- The OXP `--quick` parity release gate passed the Core projection stage and **OXP 101 passed / 0 failed / 1,370 assertions**, exit 0. This is still **not** an independent OFXP/ACP/MCP dispatcher release gate.
- Latest host `tsgo --noEmit` exits nonzero with **21 unrelated TypeScript diagnostics** (CLI/server/compat test owners); no diagnostics identified in the edited AX/Swarm source/tests after narrowing the sole new `command.test.ts` union assertion. This is not a claim of repo-wide typecheck success.
- Scoped `git diff --check` over the modified AX/Swarm paths passed. The shared checkout remains dirty, uncommitted, and separate from the stale connected OXP binary.

### Unresolved and nonclaims

1. **Not full transaction replay:** The new `requestKey` guarantees *at most one initial Swarm row* per trusted caller scope, not that interrupted multi-write creation automatically resumes, nor that duplicate requests with changed intent are silently accepted. An interrupted original `creating` Swarm still requires durable inspection/recovery. A separate immutable creation fingerprint + resumable receipt registry is a larger Core migration and has **not** been done.
2. **Still opt-in:** A caller omitting `requestKey` can still create multiple independent Swarms. User-facing examples, actual default selection rates and retry-error recovery require model evaluation.
3. **Transport parity limited:** The reviewed executable path is the shared Core owner, native V1 lazy tool and OXP. No independent OFXP/ACP/MCP task-level certification, and no live validation of the stale, non-refreshable connected OXP binary.
4. **No model A/B claim:** The AX rubric's end-to-end task-success and context-efficiency outcomes require preregistered live model trials with controlled model/provider/token settings.

## Continuation: recoverable creation and preflight Pareto (October 9, 2026)

This section supersedes the previous statement that caller-key conflicts have **no** dedicated lookup path. The source now implements a read-only lookup, but it still does **not** automatically resume incomplete creation or reproduce the original intent/receipt.

The new `creation.lookup` is the **32nd focused connector action**. Local schema projection measured **16,218** JSON characters for the all-action OXP input, **751** for this focused lookup (**95.4% smaller**), with 32 focused schemas averaging **1,393** characters, median **804**. These measurements concern emitted schema characters only, not model tokens or runtime task performance.

### New `creation.lookup` read action

- Shared owner: `src/swarm/creation-key.ts`, `SwarmCreationKey.lookup`; registered as `swarm(action="creation.lookup", requestKey=...) ` in native V1 and as `openfork_swarm(action="creation.lookup", requestKey=...)` in OXP. No new database, background service, runtime owner, authorization bypass, or cloned scheduler.
- The same trusted project, workspace, normalized directory, and caller Session (or connector principal) derive the exact ID as initial keyed creation. A mismatched or absent key is rejected at the provider schema. Unknown durable ID yields `found=false`; existing ID yields a bounded, *observed* snapshot including `status`, `revision`, coordinator-presence, member counts, and task `ready/blocked` counts. A row still in `creating` explicitly says bootstrap is incomplete and must be reconciled. All responses state that task execution/success is **unverified**. These are read-only snapshots, not immutable operation receipts.
- Native requires `swarm.read` with a project-scoped permission ask and derives its Session principal from the real tool context. OXP uses its own delegated read authority and approved root, with the connector-owned principal from the authoritative admission. Neither adapter accepts a model-supplied principal, precomputed hash, or Swarm ID for this lookup. Separate native/OXP/Core SQLite-backed tests verify missing → found, cross-caller non-disclosure, incomplete bootstrap, no accidental creation, and status/evidence accuracy.
- This closes an important *uncertain-outcome inspection* gap: after lost output, **inspect first** rather than creating a second Swarm with a new request key. It does not settle a task, restart a worker, or implicitly accept differing intent.

### Bounded parallel profile preflight

`SwarmCommand.delegatePartial` now executes independent read-only model/agent/profile preflights with `Effect.forEach(..., {concurrency: 4})`. It preserves input-ordered receipts, duplicate-name handling after profile validation, original coordinator/Session fencing, and sequential durable creation/membership/activation. A strictly **invocation-local** `WeakMap` carries the successful resolution for the exact same directory and profile object into `delegate()`, avoiding a second identical model catalog resolution during the same creation. Later worker materialization still performs its own authoritative preflight; nothing is cached globally.

Furthermore, exact JSON-equivalent profile inputs are grouped **within the same invocation**, so assigning the same model and hard boundary to eight different managed workers performs just **one** model-preflight check (rather than sixteen duplicated preflights), while still creating **eight distinct roster members**. This deduplication does not merge workers, collapse their independent task receipts, share Session authority, or persist catalog results across invocations. Schema-validated profile data is JSON-compatible; different profile keys/permission boundaries remain distinct. A dedicated SQLite-backed regression verifies one resolution, eight member IDs, and full admission.

The same successful-profile reuse is applied to later `member.batch` admission **without speculative parallel catalog reads**: each worker still proceeds serially through the existing per-write coordinator/root revocation fence, but later siblings with an identical already-validated profile reuse that proof within this one call. Eight equal-profile staged workers therefore require **one** preflight rather than eight (**87.5% fewer profile checks**). The per-member creation/receipt transactions remain independent; failures are never cached as successes. A dedicated staged-member test verifies this with all eight durable member IDs.

**Transient-negative preservation:** An initial shared-profile preflight rejection is **not** treated as authoritative for all later independent workers. Later siblings receive their own fresh preflight and can still be admitted if a temporary provider/catalog failure clears. Likewise, staged batches never memoize negative checks. Two SQLite-backed failure-injection tests prove an initial first worker fails but two identical siblings succeed, and a staged first worker fails while the second succeeds. Positive proofs remain reusable only inside the same tool invocation.

### Initial-delegation authorization gap closed

The OXP initial `delegate` previously rechecked the root/connector grant **once before the entire multi-step creation**. A slow model preflight followed by several independent Core inserts could continue writing even if that grant was revoked. `SwarmCommand.delegate` now accepts an adapter-provided, non-agent `beforeWrite` callback and invokes it before **every** durable `create`, coordinator/member insertion, task insertion, dependency mutation, and the final `creating → active` transition. OXP passes its existing `OxpRuntimeV1.commitGuard`. Authority failure stops the entire call rather than being converted into a per-item admission receipt; already-committed creating rows remain durable for `creation.lookup`, while the aggregate stays non-runnable. A fault-injection test revokes authority after the third write, verifies no later managed member or task is inserted, and confirms the Swarm remains `creating`, never active. This retains existing Core transactions and does **not** claim a new cross-write atomic transaction.

For `n` members, `u` distinct profile payloads (`1 ≤ u ≤ n`), and equal check latency `L`, the previous initial path paid approximately `2nL` serial preflight latency (one partial-admission check plus another inside delegate). The new pure-preflight portion's ideal critical path is `ceil(u/4)L`, a ratio `2n/ceil(u/4)` (for `n=u=8`, theoretical **8×** on *that phase alone*; for `n=8,u=1`, **16×**). For heterogeneous times, provider contention, scheduler overhead, serialization, and serial SQLite writes reduce the real end-to-end benefit. A deterministic test uses eight **distinct** 20 ms controlled checks, proves eight calls rather than sixteen, a maximum of four simultaneously outstanding checks, and correct durable admission; a separate test verifies the single-check identical-profile case. These are *not* claimed end-to-end measured speedups.

### Staging economics: when two beats eight, and when it does not

Given independent per-item admission failure probability `p`, the probability that a stage of size `b` has **at least one** failed item is `q(b) = 1-(1-p)^b`. For the illustrative, **not empirically estimated** `p=0.1`, `q(2)=0.19` and `q(8)≈0.570`. If an interface discards every successfully applied sibling whenever any sibling fails, big calls can be costly. But OpenFork now **preserves** individually accepted members/tasks, and uses their durable keys for satisfied retries. This fundamentally changes the cost function: large stages can amortize fixed call overhead without multiplying accepted-work replay, provided dependency coupling is low and acceptance/recovery semantics are stable.

Therefore **no blanket two-worker hard limit** should be imposed. Start conservatively when model/provider authorization risk is unknown, admit unrelated members separately from fragile DAG clusters, inspect receipts, and enlarge future stages only after observed preflight/admission success. The hard eight-item batch cap is an input/schema limit, not an empirically optimal stage size. Latency and cost experiments must measure `total=(model tokens + tool invocations + preflight + database writes + repair)`, not tool-call count alone. Avoid pretending a fixed `p` captures correlated provider outages, revoked permissions or cyclic task dependencies.

### Mechanism prior art

- AWS Lambda's `ReportBatchItemFailures` documents preserving successes rather than retrying all records after one failure: https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html
- Stripe documents durable idempotency keys and parameter-mismatch conflicts: https://docs.stripe.com/api/idempotent_requests
- Temporal distinguishes durable workflow completion from activity attempts, including partially repeated external effects: https://docs.temporal.io/tasks
- Kubernetes Server-Side Apply documents conflict-controlled incremental reconciliation: https://kubernetes.io/docs/reference/using-api/server-side-apply/
- AWS Step Functions Map controls per-stage concurrency rather than assuming unlimited parallelism is always best: https://docs.aws.amazon.com/step-functions/latest/dg/state-map-distributed.html

These are *borrowed, adapted engineering principles*. They are not evidence of novel algorithm invention, model-run productivity gains, or production deployment. The active checkout remains highly concurrent/uncommitted; the live connected OXP host is not hot-refreshable. Independent ACP/OFXP/MCP executable coverage and immutable creation-intent journaling are still open.

### Final verification of this continuation (source checkout)

- Seven focused AX/Swarm suites: **120 passed, 0 failed, 1,361 assertions**; Core-backed creation lookup, native and OXP adapters, focused OXP contract, task/member batching, transient-negative and authority-fence coverage.
- After the last typed authorization-callback correction, native/Core/OXP dispatcher rerun: **57 passed, 0 failed, 306 assertions**.
- `bun packages/opencode/script/verify-oxp-native-parity.ts --quick`: **PASS** Core footprint projection and OXP broker/shared domain, with **102 OXP tests passed, 0 failed, 1,393 assertions**. This is not certification of OFXP, ACP, or MCP independent dispatch.
- Latest `bun run typecheck` (`tsgo --noEmit`) still exits nonzero with **21 diagnostics outside the edited AX/Swarm source and test paths** (existing CLI, HTTP route and compatibility-test owners). The newly introduced unknown/error callback type regression was found and fixed; no remaining errors in changed AX/Swarm files were reported in the final run. Whole-package TypeScript remains a release blocker.
- Scoped `git diff --check` passed; the multi-agent checkout remains dirty/uncommitted. Running OXP connection has `runtime.refreshable=false` and cannot be treated as deployed from source.
