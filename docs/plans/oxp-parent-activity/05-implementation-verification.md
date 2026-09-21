# Gate P implementation and verification plan

## Local implementation closeout — 2026-09-19

Phases P0–P6 are implemented. Focused local verification is green with **42
passing tests / 0 focused failures** across the Core activity domain,
high-cardinality soak, correlation identity/privacy, recorder semantics, real
OXP HTTP/MCP server, and Tier-0 ownership suites.

Verified properties include:

- compact post-commit EventV2 invalidations whose publication failure cannot
  redefine durable operation truth;
- exact timestamp-tie cursor pagination and exact 96-call concurrent
  cardinality/counters;
- 8 KiB safe-summary enforcement and direct database inspection proving raw
  upstream correlation, prompts, arbitrary results, private structured fields,
  native file paths, and other generic payload material are absent;
- typed causal links for Sessions/workers/groups, Scheduled Tasks, process
  handles, roots, external MCP, and file transfer, plus reverse resource lookup;
- storage-level proof that causal links foreign-key only to OXP invocation
  history, never to native resources, so deleting activity history cannot
  cascade outward;
- restart recovery that interrupts only still-running spans owned by a host
  generation for which `RuntimeOwner.proveLocalDeath()` returns an explicit
  local death proof; interruption never claims rollback;
- observed epoch-segment accounting by `(activityID, hostRunID, observedEpoch)`,
  including host restart boundaries, plus durable 20-minute handoff markers;
- one global shared event path, summary-only sidebar state, independently
  paginated invocation history, bounded renderer detail cache, overlap lanes,
  native-resource navigation, reverse Session provenance, and no composer.

Performance acceptance is green on the focused warm runs:

| Surface | Measured | Provisional target |
| --- | ---: | ---: |
| recorder begin, real observed-epoch path | 0.752 ms median | < 1 ms |
| recorder settle | 0.672 ms median | < 1 ms |
| parent list, 10k activities | 0.75 ms | < 20 ms |
| invocation first page, 100k spans | 2.82 ms | < 25 ms |

`EXPLAIN QUERY PLAN` verifies the parent-list, invocation-history, and
host/epoch-segment indexes are used. The recorder existing-parent hot path uses
one indexed `UPDATE ... RETURNING` to refresh correlation observation metadata
and resolve `activity_id`, avoiding the prior SELECT+UPDATE pair while retaining
SQLite as the cross-process authority.

Schema and generated SDK scoped typechecks are clean. Core scoped typechecking
is blocked only by the existing `bun:sqlite` / unrelated `TextDecoder`
environment diagnostics. The broader OpenCode/App programs remain polluted by
unrelated concurrent handler/session/theme/asset diagnostics; focused Gate P
files introduced no local diagnostics.

The correlation/continuity realignment additionally passes the complete OXP
regression: **210/210** tests. The canonical `openai/session` epoch tracker
measured **~0.0021 ms median / ~0.0051 ms p95** across 10,000 warm observations.
The local TypeScript checker still reports repository/environment ambient-type
and unrelated program diagnostics (Node/Bun types, control-plane/session/SPAD,
WASM declarations); the modified correlation tests compile and execute under
Bun and the full OXP runtime regression is green.

**Remaining closure dependency:** correlation *semantics* are now grounded in
OpenAI's documented `_meta["openai/session"]` conversation identifier rather
than inferred from transport behavior. The installed acceptance section remains
gated on Gate N only as a runtime-conformance proof: verify the packaged
ChatGPT/Secure MCP Tunnel forwards the documented metadata on relevant calls and
that the observed 20/25-minute host window still behaves as measured. The
installed soak can use the process metrics `conversationCorrelatedCalls` /
`unattributedParentCalls` to prove whether the documented correlation metadata
is arriving without exposing a raw or pseudonymous identifier.

## Phase P0 — durable contract

Create:

- Core OXP activity schemas/IDs;
- typed SQLite tables;
- migration;
- process-global durable service;
- bootstrap-free inspection service.

Tests:

- concurrent first observation for one correlation creates one activity;
- different correlation digests never merge;
- no raw correlation input is persisted;
- summary counters update atomically;
- list/get/history read from SQLite only;
- missing activity returns typed absence/error without workspace bootstrap.

## Phase P1 — invocation spans

Instrument the common OXP `tools/call` boundary.

At admission:

- pseudonymize parent correlation;
- get/create parent activity;
- start durable invocation span.

At settlement:

- project safe operation summary;
- persist truthful outcome;
- update parent summary counters;
- persist causal links.

Tests:

- success;
- denial;
- cancellation before commit;
- cancellation after commit;
- ambiguous external result;
- overlapping calls;
- bounded summary serialization;
- recorder failure cannot fabricate operation failure/rollback.

## Phase P2 — epoch and restart history

Persist:

- observed epoch number;
- continuity marker;
- host run ID.

Recovery:

- settle orphaned spans from dead host runs as `interrupted` or an explicitly
  stronger known status;
- never infer rollback.

## Phase P3 — resource lineage

Add links for:

- native Session supervision;
- delegated workers/groups;
- Scheduled Tasks;
- process handles;
- external MCP;
- file transfer;
- approved roots.

Where native resource metadata supports provenance, add a reverse local link back
to `activityID/invocationID`.

## Phase P4 — global inspection API

Add Tier-0/1 endpoints/contracts for:

- list activity summaries;
- get one summary;
- paginated invocation history;
- rename/archive/delete history.

Negative tests:

- zero `InstanceStore.load`;
- zero workspace/provider/plugin initialization;
- zero message/session-history hydration for activity list.

## Phase P5 — App navigation/UI

Add:

- OXP activity section in chat/sidebar navigation;
- global activity route;
- header summary;
- virtualized/paginated invocation timeline;
- status/outcome presentation;
- filters;
- native Session/worker links;
- no composer.

The sidebar consumes summary rows only.

## Phase P6 — live event projection

One shared global event path updates:

- newly created/updated activity summaries;
- opened invocation timeline.

No per-row timers or per-activity event streams.

## Performance acceptance

Provisional targets:

- recorder begin/settle median < 1 ms each excluding SQLite contention. The
  microbenchmark preserves the real sequential call shape, records independent
  warm rounds, logs every round median, and gates on the best warm round so
  transient OS/SQLite contention is visible without redefining the uncontended
  target;
- parent list first page < 20 ms warm on 10k activities;
- invocation first page < 25 ms warm on 100k invocations for one activity;
- no workspace instance creation for list/detail history;
- 1/3/6 concurrent OXP calls preserve invocation cardinality exactly;
- 96 simultaneous calls do not produce duplicate activity rows for one correlation;
- summary counter updates remain exact under concurrent settlement.

## Privacy/security acceptance

- grep/database inspection proves raw upstream correlation absent;
- raw args/results absent from activity tables;
- renderer contracts contain aliases/relative paths, never native absolute paths;
- signed URLs/credentials absent;
- archive/delete cannot cascade into native resources;
- activity history cannot authorize a later OXP call.

## Installed acceptance

Gate N no longer needs to discover correlation semantics. It must prove installed
runtime conformance with the documented contract:

- repeated calls from one ChatGPT conversation carry the same
  `_meta["openai/session"]` and appear as one expected local activity;
- separate ChatGPT parents remain distinct;
- MCP 2025-era traffic is rejected rather than reintroducing transport-session
  correlation;
- `openai/subject` never merges separate conversations;
- observed epoch boundaries appear truthfully;
- 20-minute advisory marker appears;
- durable worker survives parent OXP loss and remains linked in activity history;
- reopened OXP can continue writing to the same activity when the upstream
  correlation semantics prove that is correct.
