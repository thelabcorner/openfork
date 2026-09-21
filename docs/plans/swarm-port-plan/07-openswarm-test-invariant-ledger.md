# OpenSwarm test-file -> first-party invariant ledger

**Status:** COMPLETE FILE-LEVEL INVENTORY — 2026-09-18  
**Authority:** subordinate to `00-first-party-overhaul-2026-09-18.md`  
**Source corpus:** every `/openswarm/test/unit/*.test.ts` file (64/64)

This ledger treats the OpenSwarm test corpus as product/correctness evidence, not
as implementation authority. A row marked **DELETE mechanics** still preserves
any user-visible invariant named in the row.

| OpenSwarm test file | Product/correctness invariant worth preserving | Native destination / disposition |
|---|---|---|
| `autopermissions.test.ts` | Delegation never widens authority; unsafe/path-sensitive permissions are not copied blindly; diagnostics are truthful. | **PRESERVE / REDESIGN** -> generic Session execution-boundary restriction lattice + PermissionV2. Delete permission-copy propagation. |
| `capability-delegation.test.ts` | Capability-aware model selection, explicit model override, deterministic cheapest-capable ordering, bounded listing. | **PRESERVE / REDESIGN** -> Tier-2 `LocationProfileResolver` over canonical host catalog. Delete duplicate pricing/tier catalog. |
| `chunkdb-store.test.ts` | Existing stores can be migrated without identity/state loss; CAS/order/claim semantics survive migration. | **MIGRATION ONLY** -> versioned legacy importer + native DB invariant tests. Delete ChunkDB/SQLite dual runtime backend and its storage-size KPI as a native requirement. |
| `contracts.test.ts` | Optional typed blackboard keys reject invalid values while preserving CAS; contract inspection is readable. | **PRESERVE OPTIONAL / REDESIGN** -> `swarm_blackboard_contract` service if shipped. Delete model-copyable confirmation strings as authority. |
| `core.test.ts` | Swarm/member creation, uniqueness, root Session backing, message fanout, blackboard CAS, task claim and continuation are deterministic. | **PRESERVE / REWRITE** -> Core aggregate + SessionInput. Delete fuzzy/bare-ID self-heal and implicit coordinator seizure/rebind. |
| `corpse-gold.test.ts` | Artifact outcomes can inform later work without becoming hard correctness. | **DEFER** -> evidence-bearing annotations/evaluation. Never foundational scheduler authority. |
| `cross-memory.test.ts` | Cross-collaboration knowledge access is useful; CAS/contracts remain valid across boundaries. | **PRESERVE UX / REDESIGN AUTH** -> explicit external/cross-Swarm grant/policy. Delete silent guest auto-registration. |
| `cross-swarm-status.test.ts` | A member/task from Swarm A can never mutate ownership/state in Swarm B. | **PRESERVE HARD INVARIANT** -> same-Swarm FK/service validation + member/task fencing generations. |
| `cross-swarm.test.ts` | Cross-Swarm direct/reply flows can be symmetric and attributable; self-message guards still hold. | **PRESERVE UX / REDESIGN AUTH** -> explicit bridge/grant. Delete `force:true` bypass and fake destination membership. |
| `dag.test.ts` | Cycle rejection, dependency direction/readiness, deterministic candidate scoring, human-focus suppression. | **PRESERVE CORE** -> pure DAG algorithms + incremental readiness. Text affinity only deterministic tie-break; human focus moves to Session-owned signal. |
| `deliverables.test.ts` | Handoffs have durable author/task refs, filters, and verdicts; cross-team use remains attributable. | **PRESERVE** -> `swarm_deliverable` linked to task run; cross-Swarm access requires grant. |
| `delivery-audit.test.ts` | Coordinator can see delivery/permission-block failures truthfully; notification failure cannot destroy canonical blocked state. | **PRESERVE / REDESIGN** -> native Permission + message receipt/event projection. |
| `digest-exchange.test.ts` | Team-sync summaries should be bounded and avoid redundant churn. | **DEFER mechanism** -> compact first-party summary/notice projection. Delete anti-entropy premise in one canonical DB. |
| `digest.test.ts` | Digest comparison can detect changed knowledge state cheaply. | **DEFER** -> only if knowledge-plane evaluation justifies it. Not scheduler correctness. |
| `edge-cases.test.ts` | Concurrency, rollback, duplicate lifecycle calls, messaging expiry, CAS, recovery, and DAG corner cases remain correct. | **PRESERVE INVARIANTS** -> transactional Core/service tests against native schema. |
| `emergency.test.ts` | Operator can stop unsafe collaboration quickly; fail-safe state is visible and reversible where intended. | **PRESERVE / REDESIGN** -> explicit Swarm stop/pause + typed trip signals. No heuristic global kill switch driven by text/status guesses. |
| `failure-detection.test.ts` | Quota/provider/auth/session failures are distinct and produce actionable diagnostics with deduplication. | **PRESERVE / REDESIGN** -> typed provider/Session run errors + compact failure projection. Delete transcript/error-string reconstruction where typed causes exist. |
| `fencing.test.ts` | Peer/task/blackboard text is untrusted model-facing data and must be delimited consistently. | **PRESERVE** -> one central collaboration renderer/fence used by every model-facing surface. |
| `flood-rate-control.test.ts` | Bursts are bounded; urgent work can bypass soft throttles; sender/mention fanout and notice churn are bounded. | **PRESERVE / REDESIGN** -> bounded dispatcher/coalescer + explicit quotas. No per-member timer farm or correctness-critical process-local cooldown map. |
| `guest-messaging.test.ts` | External participants can communicate when policy permits and remain non-coordinator/non-worker authority. | **PRESERVE FEATURE / REDESIGN** -> explicit guest/join grant. Delete frictionless silent registration. |
| `hive-diagnostics.test.ts` | Advanced shared-knowledge state can be summarized compactly/readably. | **DEFER** with Hive knowledge plane; no core dependency. |
| `humanchat.test.ts` | Direct user chat yields member automation and later releases it deterministically. | **PRESERVE / REDESIGN** -> user-owned Session admission projection + optimistic admission fence + Swarm lull policy. |
| `leases-retries.test.ts` | Lease expiry and semantic retry budget are separate; claims are atomic; rescue churn does not falsely consume failure budget. | **PRESERVE CORE** -> `swarm_task_lease`, `swarm_task_run`, lease generation, typed failure taxonomy. |
| `manual-stop-fallback.test.ts` | Operator abort must not be mistaken for ordinary idle/turn completion. | **PRESERVE invariant / DELETE heuristic** -> native Session pause/interrupt provenance; no fallback text/status inference. |
| `manual-stop.test.ts` | Explicitly paused members receive no scheduler/mail auto-resume until explicit user action. | **PRESERVE** -> Session pause is execution gate; Swarm scheduler consumes it. |
| `match.test.ts` | Name/query matching is deterministic and user-friendly. | **PRESERVE for UX only** -> pure suggestion/search helper; never mutation authority. |
| `memory-share.test.ts` | One action can write shared knowledge and notify selected peers without duplicate manual calls. | **PRESERVE composition** -> blackboard CAS transaction + message service; identities remain separate. |
| `mentions.test.ts` | Structured member/task/file mentions resolve predictably and bounded fanout prevents explosions. | **PRESERVE / REDESIGN** -> structured refs + capped routing; no free-text mention as authority. |
| `messaging-guards.test.ts` | Self-send, invalid target, malformed request/reply, expiry and other message invariants fail closed. | **PRESERVE CORE** -> message-domain validators. |
| `messaging.test.ts` | Direct/broadcast/request/reply ordering, correlation, kickoff/completion mail and safe formatting work end-to-end. | **PRESERVE semantics / REWRITE transport** -> immutable message + per-recipient delivery + typed SessionInput. |
| `model-catalog.test.ts` | Users need meaningful model availability/capability information. | **PRESERVE UX / DELETE duplicate classification authority** -> canonical host Model/Catalog projection. |
| `model-management.test.ts` | Coordinator can inspect/change managed worker model(s); invalid updates are atomic/no-op; batch targeting works. | **PRESERVE / REDESIGN** -> desired managed-member profile + explicit Session model materialization. Delete Session/message auto-sync mirror. |
| `model-selection.test.ts` | Explicit > per-member > batch/default/capability fallback precedence is deterministic and explained. | **PRESERVE** -> Tier-2 profile resolver; persist resolved concrete model for managed worker. |
| `model-variant.test.ts` | Reasoning variants are validated, persisted in desired profile, transported correctly, and failures are explicit. | **PRESERVE** -> canonical Model variant schema/resolver/provider lowering. |
| `models.test.ts` | Model categories can support concise UX. | **REDESIGN/DELETE duplicate provider-tier truth** -> derive UI labels from canonical catalog only. |
| `multi-swarm.test.ts` | One Session, especially a coordinator, may participate in multiple Swarms without identity collision. | **PRESERVE HARD INVARIANT** -> no global unique `session_id`; membership is scoped by `swarm_id`. |
| `need.test.ts` | A member can request targeted expertise rather than broadcast indiscriminately. | **DEFER advanced router / preserve request semantics** -> explicit need/request message + evaluated capability routing later. |
| `noreply.test.ts` | Fire-and-forget notices are structurally marked; action-requiring kinds cannot suppress replies; ack-only churn is damped. | **PRESERVE** -> message schema validator + renderer. |
| `notice-aggregator.test.ts` | Coordinator notices coalesce into bounded digests, never self-notify, and do not create prompt floods. | **PRESERVE mechanism class / REDESIGN owner** -> one process-owned coalescer driven by canonical events. |
| `notices-integration.test.ts` | Advanced Hive transitions notify exactly once / only on meaningful transitions. | **DEFER with Hive**; if shipped, use EventV2 correlation/dedupe. |
| `notices.test.ts` | Notice rendering/dedup rules are pure and deterministic. | **DEFER with Hive**, reuse generic notice renderer where applicable. |
| `permission-lifecycle.test.ts` | Rebinds do not make permission walls invisible; pending/replied state is deduped and exact. | **PRESERVE invariant / DELETE adapter mechanics** -> binding generation + native Permission events. Delete V1/V2 endpoint routing and polling backstop. |
| `permission-wall-delivery.test.ts` | A blocked worker remains visible/actionable even if notification delivery fails or human focus delays notice. | **PRESERVE / REDESIGN** -> Permission authority + compact Swarm blocked projection/notice. Coordinator model cannot mint allow authority. |
| `permissions-escalation.test.ts` | Permission asks are listable/actionable, deduped, and tied to the blocked member; workers cannot escalate peers. | **PRESERVE UX / REDESIGN authority** -> native Permission. Human/operator grants; coordinator may diagnose/attenuate but not widen without delegated grant. |
| `probe-compat.test.ts` | Graceful behavior across missing legacy permission surfaces. | **DELETE native runtime compatibility probe**; current first-party service has one permission engine/contract. |
| `removal-grace.test.ts` | Removal gives truthful final notice, releases owned work, and old Session loses member authority. | **PRESERVE** -> member lifecycle + task release + binding-generation fence; exact orphan error. |
| `reservation.test.ts` | Explicit intended owner survives delayed DAG readiness, has bounded TTL, and falls back truthfully. | **PRESERVE** -> task reservation fields separate from active lease. |
| `revive.test.ts` | Health is inspectable; explicit revive/rebind/retask can recover collaboration while respecting deliberately stopped members. | **PRESERVE / REDESIGN** -> typed health projection + binding generation + desired profile. Delete fuzzy seizure/automatic adoption. |
| `runtime.test.ts` | Runtime facts such as Session existence, selected profile and todos are available to collaboration logic. | **DELETE HTTP adapter; PRESERVE facts** -> in-process Session/Permission/Telemetry services and Tier-2 resolver. |
| `scheduler-bundle.test.ts` | Assignment cannot strand/double-bind work; host kickoff is not human chat; ownership transition is atomic. | **PRESERVE invariants / DELETE mirrors** -> task lease/run + typed Synthetic provenance; no `currentTaskId` status coupling. |
| `scheduler-edgecases-fix.test.ts` | Expired work can become reassignable in the same logical pass; freshly admitted work is not immediately “repaired” as stale. | **PRESERVE** -> event-driven due processing + exact run/admission timestamps/generations. |
| `scheduler-robustness.test.ts` | Runtime/session errors do not burn semantic retry budget or hot-loop bad members; diagnostics stay readable/bounded. | **PRESERVE / REDESIGN** -> typed ExecutionOutcome + eligibility backoff/deadline + notice coalescer. |
| `scheduler-stickiness.test.ts` | Explicit coordinator reassignment is sticky for a bounded time; unavailable intended owner falls back truthfully; stopped members are ineligible. | **PRESERVE** -> reservation TTL/stickiness. Text affinity becomes low-authority tie-break only. |
| `scheduler-watchdog-budget.test.ts` | Watchdog/recovery churn is not semantic failure; absent Sessions are quarantined/rebindable; explicit retry resets allowed terminal states. | **PRESERVE / REDESIGN** -> SessionTelemetry + task run failure taxonomy + explicit retry transition. |
| `schema-drift.test.ts` | Runtime schema and migration truth must not diverge. | **DELETE duplicated-schema test** -> host Drizzle schema snapshot/generator/check already enforces one source. |
| `session-groups.test.ts` | Group navigation is optional/compatible and managed ownership cannot be mistaken for manual grouping. | **PRESERVE UX / REWRITE** -> first-party virtual `kind:"swarm"` SessionGroup projection; no plugin capability negotiation. |
| `stale-crossswarm-binding.test.ts` | Stale/mis-scoped task binding can never corrupt another Swarm; explicit invalid mutation fails. | **PRESERVE HARD INVARIANT** -> remove `currentTaskId` mirror; task lease FK/scope validation + generation fencing. |
| `stalls.test.ts` | Permission wall, usage limit, absent Session, expired lease, user chat, queued mail and healthy execution are distinct diagnoses. | **PRESERVE diagnoses / REDESIGN mechanics** -> typed canonical projections/events; no transcript polling or omnibus escalation scan. |
| `store.test.ts` | Unique names, atomic claims, delivery expiry/retry, CAS, ordering, rollback, TTL and scope invariants are storage-enforced. | **PRESERVE applicable invariants** -> native Host DB tests. Delete bespoke migrations/backend parity; Hive H1/H2 rows remain deferred. |
| `subscriptions.test.ts` | Topic subscription routing is deterministic; runtime failures/abort/retry/deletion do not resurrect or corrupt members. | **MIXED**: recovery invariants **PRESERVE** in native event consumers; topic pub/sub **DEFER** unless product surface ships. |
| `timeline.test.ts` | Collaboration history is queryable in stable order, filterable, bounded, and human-readable. | **PRESERVE** -> EventV2 Swarm aggregate history + renderer. Delete `swarm_event` table. |
| `tools.test.ts` | High-level one-call workflows, truthful errors, exact ownership, CAS, task lifecycle, status/probe, and batch ergonomics remain useful. | **MINE/PRESERVE selectively** -> thin lazy tools over Core services. Delete tool-owned state machines, confirmation-string authority, duplicated permission/runtime/Hive mechanics. |
| `transport-resilience.test.ts` | Transient transport failure differs from permanent/domain failure; notice failure is contained and retryable. | **PRESERVE taxonomy/containment** -> typed provider/Session/DB outcomes; delete HTTP self-transport-specific matching where native errors exist. |
| `wip-aura.test.ts` | Advisory path claims have TTL/heartbeat, overlap warnings, and never hard-block unrelated authority. | **PRESERVE H0** -> canonical `swarm_claim` current-state row + generation/expiry + pure overlap helper. |

## Cross-file conclusions

The corpus repeatedly protects a smaller set of foundational invariants than the
plugin architecture suggests:

1. **identity/scope:** exact Swarm/member/Session/task identities never cross
   authority domains accidentally;
2. **monotonic authority:** permissions and leases never widen or resurrect from
   stale actors;
3. **idempotent admission:** message/task execution can be retried after process
   death without duplicating logical work;
4. **human precedence:** direct user interaction and explicit stop/pause beat
   automation structurally;
5. **semantic retry accounting:** infrastructure recovery does not consume task
   failure budget;
6. **bounded fanout:** messages/notices/mentions cannot create unbounded prompt
   storms;
7. **truthful state names:** queued/claimed/admitted/completed are not conflated;
8. **one authority per fact:** Session owns live execution; Swarm owns
   collaboration; Permission owns asks; EventV2 owns history.

These invariants, not the plugin classes/tables/adapters, are the migration
surface.

## Native Phase-1 realization evidence — 2026-09-19

The first-party Core implementation now has executable evidence for the
foundational rows above rather than merely preserving them as design intent:

- `dag.test.ts`, `edge-cases.test.ts`, and `store.test.ts` invariants are covered
  by generated/deep DAG validation, transactional dependency readiness, schema
  constraints, Blackboard CAS, and indexed current-state reads.
- `leases-retries.test.ts`, `scheduler-bundle.test.ts`, and stale-binding
  invariants are covered by a single authoritative task lease, exact generation
  tokens, 16-way single-winner claim concurrency, retirement-before-supersede,
  binding fences, task-run fences, and operational-vs-semantic failure accounting.
- `messaging.test.ts`, `messaging-guards.test.ts`, and `noreply.test.ts` semantics
  are represented as immutable logical messages plus snapshotted per-recipient
  delivery receipts. Broadcast expansion is normalized once, self-send fails
  closed, request/reply correlation is structural, and delivery reclaim/admission
  is generation-fenced across member rebinds.
- `multi-swarm.test.ts` and `session-groups.test.ts` invariants are realized by
  `SwarmMember` membership plus a virtual read-only SessionGroup projection.
  No Swarm identity/membership is copied into `session_group`,
  `session_group_member`, or `SessionTable.group_id`; one Session can appear in
  multiple virtual Swarm groups.
- `wip-aura.test.ts` H0 advisory semantics are represented by one current-state
  claim row per scoped member claim with generations and expiry. Stale claim
  tokens cannot mutate a reacquired generation.
- `deliverables.test.ts` has a normalized immutable deliverable row with
  one-shot verdict authority and task-run linkage.
- A static Core boundary test prevents Swarm from acquiring Instance, Location
  runtime, plugin, workspace-execution, or Session-history dependencies. Query
  plans are asserted for ready-task, mailbox, summary, and navigation paths.

This evidence closes only the pure Core/domain phase. Human precedence,
Synthetic Session admission, execution ownership/quiescence, kill-boundary
recovery, and permission/runtime integration remain Phase-2+ responsibilities;
the ledger must not treat Phase-1 storage correctness as proof of those runtime
invariants.
