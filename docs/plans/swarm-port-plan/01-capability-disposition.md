# OpenSwarm capability disposition

**Status:** DECISION-MATRIX COMPANION — subordinate to
`00-first-party-overhaul-2026-09-18.md`  
**Purpose:** prevent “feature parity” from turning into accidental implementation parity

The migration unit is a **behavioral contract**, not a source file.

Every OpenSwarm capability is classified into one of four dispositions:

- **PRESERVE** — product semantics are first-party requirements.
- **REDESIGN** — keep the user value, replace the mechanics.
- **DELETE** — plugin-era mechanism has no native reason to exist.
- **DEFER** — potentially useful, but must not block the first-party core.

---

## 1. Core interaction

| Capability | Disposition | First-party interpretation |
|---|---|---|
| Real member chats | **PRESERVE** | Members remain independently openable root Sessions. |
| Coordinator + workers | **PRESERVE** | Roles are Swarm-domain identities, not Session parentage. |
| Peer-to-peer communication | **PRESERVE** | Durable logical peer envelope + per-recipient delivery. |
| User can chat with a worker | **PRESERVE** | User-owned Session turn structurally preempts/suppresses automation. |
| 5-minute human-chat lull | **REDESIGN** | Optional product grace deadline; provenance defines identity, not text/timer heuristic. |
| Emoji/title membership | **DELETE** | SessionGroup + Swarm membership are authoritative. |
| External guest auto-registration | **REDESIGN** | Explicit external participant/message authority policy; never silent privilege escalation. |

---

## 2. Task orchestration

| Capability | Disposition | First-party interpretation |
|---|---|---|
| DAG dependencies | **PRESERVE** | Native graph tables + cycle check + incremental readiness. |
| Atomic task claim | **PRESERVE** | DB CAS lease is authoritative. |
| Lease expiry | **PRESERVE** | Durable lease deadline; shared deadline owner. |
| Retry budget | **PRESERVE** | Typed failure taxonomy decides whether semantic retry budget is consumed. |
| Explicit reservation/reassign | **PRESERVE** | Durable preference + fencing generation; stale owner loses authority immediately. |
| Full DAG recompute every scheduler pass | **DELETE** | Incremental unmet-dependency counters/outgoing-edge propagation. |
| Prose-token affinity as primary matcher | **REDESIGN** | Capabilities/scopes first; textual score only a deterministic tie-break. |
| “failed/cancelled dependency counts as complete” | **DELETE** | Explicit edge success/failure policy. |
| `member.currentTaskId` as parallel ownership fact | **DELETE** | Active lease is ownership; roster projects it. |

---

## 3. Messaging

| Capability | Disposition | First-party interpretation |
|---|---|---|
| Durable mail | **PRESERVE** | Message + recipient-delivery rows. |
| Direct request/response | **PRESERVE** | Correlation/reply-to with direct recipient semantics. |
| Broadcast | **PRESERVE** | One-way topic/fanout semantics by default; one logical message. |
| Delivery retry/expiry | **PRESERVE** | Delivery-level attempts/deadline separate from task retry. |
| Sender-visible truthful verdict | **PRESERVE** | Report queued/claimed/admitted/failed/expired accurately. |
| “delivered = model understood it” | **DELETE** | Admission is the strongest transport truth; reply/settlement are separate. |
| Prompt-prefix inbox protocol | **REDESIGN** | Central bounded renderer + host-turn provenance; peer data remains fenced. |
| Busy-session ad-hoc prompt injection | **REDESIGN** | Native Session admission/ingress boundary owns ordering. |
| In-memory delivery cooldown maps | **REDESIGN** | Durable deadline/index where semantics require cooldown; otherwise coalesce before admission. |

---

## 4. Shared coordination / Hive

| Capability | Disposition | First-party interpretation |
|---|---|---|
| Versioned blackboard | **PRESERVE** | CAS shared coordination state. |
| Typed blackboard contracts | **PRESERVE/REDESIGN** | Useful optional schema validation; service-level, not tool-owned. |
| Path/lane claims | **PRESERVE** | Explicit advisory scopes with TTL. |
| Deliverable/handoff ledger | **PRESERVE** | Artifact/reference + verdict, linked to task run. |
| Artifact gold/corpse/struggle signals | **DEFER** | Keep as evidence-bearing annotations after core; no fuzzy scheduler authority. |
| Belief store | **DEFER** | Recast as evidence-bearing scoped knowledge; evaluate against first-party Memory concepts. |
| Whisper/shout reinforcement | **DEFER** | Visibility/evidence policy only if independent evidence semantics are proven. |
| Resonance/consolidation | **DEFER** | Requires evaluations and explicit evidence graph. |
| Local anti-entropy digest | **DELETE** | One canonical host DB has no peer-replica entropy to reconcile. |
| Token-substring relevance | **DELETE/REDESIGN** | Indexed scoped search/evidence ranking if knowledge plane ships. |

---

## 5. Runtime/recovery

| Capability | Disposition | First-party interpretation |
|---|---|---|
| Stable member identity across Session loss | **PRESERVE** | Logical member row can bind a replacement Session. |
| Crash recovery | **PRESERVE** | Reconcile durable leases/deliveries/runs against native Session existence. |
| Explicit revive/rebind | **PRESERVE/REDESIGN** | Typed operation with authority; no fuzzy seizure. |
| Watchdog | **REDESIGN** | SessionTelemetry/Status + run deadlines + typed provider failures; no history scan. |
| Provider-limit diagnosis | **PRESERVE/REDESIGN** | Typed native provider/run error classification and UI projection. |
| Startup “fix everything” broad scan | **REDESIGN** | Indexed bounded recovery of unresolved leases/deliveries only. |
| fuzzy self-heal names/ids | **DELETE as authority** | Suggestions may be UX-only; mutation always requires exact stable ID/authorization. |
| coordinator auto-adoption/rebinding | **DELETE** | Explicit ownership transition only. |
| plugin runtime adapter | **DELETE** | In-process first-party services. |
| plugin self-SSE subscription | **DELETE** | Typed EventV2 subscription. |
| permission polling backstop | **DELETE** | Native permission state/events. |

---

## 6. Persistence

| Capability | Disposition | First-party interpretation |
|---|---|---|
| Durable Swarm state | **PRESERVE** | Host Database/Drizzle only. |
| Atomic task/message transitions | **PRESERVE** | Native transactions/CAS/unique constraints. |
| Separate `.opencode/swarms/swarms.db` | **DELETE** | Legacy import source only. |
| Native SQLite + ChunkDB pluggable stores | **DELETE** | Host DB is the runtime store. |
| ChunkDB legacy reader | **PRESERVE only for migration** | Read-only importer path if existing users need it. |
| bespoke `user_version` migration chain | **DELETE** | Host migration system owns native schema. |
| `swarm_event` timeline table | **DELETE** | EventV2 durable history. |
| pending permission table | **DELETE** | Permission service is authoritative. |

---

## 7. Session grouping and UI

| Capability | Disposition | First-party interpretation |
|---|---|---|
| Group members under coordinator/Swarm | **PRESERVE** | First-party SessionGroup `kind:"swarm"` (exact contract TBD). |
| Stable grouping across coordinator re-root | **PRESERVE** | Group identity keyed by Swarm ID, anchor is mutable presentation metadata. |
| Live member status | **PRESERVE/REDESIGN** | Batch SessionTelemetry/Status projection, not Swarm status shadow. |
| Task/status dashboard | **PRESERVE** | Compact SwarmSummary/Detail endpoint/events. |
| per-row Session fetches | **DELETE** | Batched projection or existing SessionGroup lightweight Session projection. |

---

## 8. Permissions and models

| Capability | Disposition | First-party interpretation |
|---|---|---|
| Never widen coordinator authority | **PRESERVE** | Generic delegated-session permission invariant. |
| Permission escalation UX | **PRESERVE** | Native permission request + Swarm correlation. |
| V1/V2 dual event interception | **DELETE** | Internal native service knows its own permission engine. |
| worktree string-normalization permission shim | **DELETE/REDESIGN** | Existing native path/permission abstractions own scope. |
| per-member model choice | **PRESERVE** | Store selection policy; Session owns current actual model. |
| capability-aware model choice | **PRESERVE** | Query live first-party model catalog. |
| duplicate OpenSwarm pricing/catalog | **DELETE** | Provider/catalog source of truth only. |
| last-used model in blackboard | **DELETE** | Session/runtime or explicit member policy provides first-party source. |

---

## 9. Tools

| Capability | Disposition | First-party interpretation |
|---|---|---|
| `swarm_delegate` UX | **PRESERVE** | High-level command over native service transaction/workflow. |
| `swarm_task` / task actions | **PRESERVE** | Thin adapter; completion authority resolved from active lease/session. |
| `swarm_message` / reply | **PRESERVE** | Thin adapter over message service. |
| status/roster/probe | **PRESERVE** | Queries over compact projections/indexes. |
| model/admin/revive/contracts tools | **PRESERVE selectively** | Lazy capabilities / UI where appropriate. |
| every tool permanently in provider manifest | **DELETE** | Use OpenFork lazy-tool broker. |
| tool-layer domain store/state machine | **DELETE** | Core service owns semantics. |
| current `packages/opencode/src/tool/swarm/` implementation | **REPLACE** | Harvest useful UX/tests; rebuild tools after service exists. |

---

## 10. Test disposition rule

OpenSwarm tests are evidence, not automatically portable truth.

For each test:

1. identify the user/correctness invariant it protects;
2. keep the invariant if valid;
3. rewrite the test against the first-party producer/store boundary;
4. delete tests that only protect plugin shims;
5. add negative-invariant tests for bugs the plugin structure made possible.

The goal is to preserve hard-won behavioral knowledge without enshrining the implementation that
created the need for the workaround.

