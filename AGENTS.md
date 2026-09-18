# OpenFork Repository Agent Guide

This file is the repository-wide architecture contract. Nested `AGENTS.md` files
add package-specific rules; they do not make the rules below optional unless
they explicitly document a narrower exception.

## Repository map

Before substantial cross-package or cross-runtime work, read
`docs/map/README.md`. Its companion maps cover architecture/data flow,
V1-vs-current/V2 semantics, runtime/product surfaces, package ownership,
upstream-vs-fork boundaries, and source-tree lookup. The map is an orientation
layer; this file and `FORK.md` remain authoritative when a rule or ownership
decision is normative.

### V1/current lifecycle policy

Current/V2 is a semantic/reference architecture for OpenFork, **not an automatic
migration destination**. Upstream may retire V1 in favor of current/V2; OpenFork
intentionally repairs and extends its mature V1 production path and selectively
backports current/V2 capabilities into it.

- Prefer a shared authoritative owner plus a narrow V1 adapter over duplicated
  semantics.
- Do not delete or bypass V1 merely to match upstream's lifecycle.
- V1 removal requires an explicit OpenFork architecture decision with proven
  parity and a product reason; it is never implied by an upstream migration,
  rename, or current/V2 implementation existing.
- This applies to the **local client API** too. Do not migrate V1 callers onto
  current Protocol/`/api/*` surfaces merely to match upstream. Existing current
  calls are transitional/implementation facts, not a compatibility target.
- The OpenCode-hosted Zen/Go model-provider API is a separate external-provider
  concern. Its versioning must not be conflated with local V1/current client API
  generation.

## Architecture Before Call Sites

For any change that crosses storage/runtime/server/client/UI boundaries, design
**from the authoritative source of truth outward**, not from the easiest UI
call site inward.

The required investigation order is:

1. identify where the fact or state is authoritatively produced or stored;
2. identify the service that should own it and its lifetime;
3. classify the operation by the ownership tiers below;
4. determine whether an existing materialized row, event, projection, or cache
   already contains the answer;
5. design the narrowest correct server/service projection and transport;
6. only then wire client state and presentation.

The UI may define *what the user needs to see*. It does not thereby become the
owner of the computation. Existing frontend helpers, stores, and endpoints are
implementation evidence, not proof of correct ownership.

Pure presentation-only changes are exempt from inventing backend work. The rule
applies whenever a feature needs domain state, durable state, live execution
state, cross-session/global state, or performance-sensitive derived data.

### Current incident postmortem: bottom-up or stop

The instance-bootstrap/concurrent-session incident happened because multiple
passes accepted a consumer-first data path and then optimized around it. Future
agents must treat that as the failure pattern to detect, not as a solved one-off
bug.

- Starting with a component, finding an existing SDK method, and making that
  method cheaper is not architecture. It is only valid after the owner/source of
  truth and middleware/service cost have been proven correct.
- A small response body is not evidence of a cheap path. In this repo, tiny reads
  such as provider/config/path/session metadata can cross
  `WorkspaceRoutingMiddleware -> InstanceContextMiddleware -> InstanceStore.load`
  and thereby initialize config, plugins, tool reload, and warmup services.
- Missing directory/workspace input must be considered toxic until proven
  harmless. If the path can fall back to `process.cwd()`, the implementation has
  not established ownership.
- Do not let a scheduler, queue, debounce, viewport gate, hover delay, lazy
  import, or cache make a wrong producer look acceptable. First ask whether the
  work should exist at that layer at all.
- If the first concrete implementation step is a frontend fetch, message-history
  hydration, per-row timer, or provider catalog query, stop and write the
  bottom-up path before coding.
- Every cross-layer performance closeout must include at least one negative
  invariant that would have caught the original bug, such as zero implicit
  instances, zero metric-only history hydration, or no N-per-row request/stream
  multiplication under the actual trigger state.

### Reject consumer-first reconstruction

- Do not fetch or hydrate a large object merely because a component can derive
  one small scalar from it.
- Do not reconstruct semantic runtime state from historical UI artifacts when
  the producer already knows the state at the moment it changes.
- Do not scan messages/parts/history per row, per timer tick, or per render for
  values that can be incrementally projected once at the owning boundary.
- Do not create a second raw-content stream to support a summary projection.
  Project counters/phases at the producer and coalesce transport updates.
- Dense navigation surfaces (sidebars, lists, badges, tab strips) should consume
  O(1) materialized metadata or compact projections. Rich history hydration is
  for an explicitly opened detail surface, not for background row decoration.

For deeper examples and review heuristics, read
`docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md` before starting a substantial
cross-layer performance or data-ownership change.

## Server Ownership Tiers

Classify server work before choosing middleware or an endpoint.

### Tier 0 — process/global

Examples: health/identity/capabilities, authentication validation, global
preferences/config, durable project catalog, global session indexes/status,
usage/quota/account metadata, global event transport.

**Tier 0 must never materialize a workspace `Instance`.**

### Tier 1 — durable location metadata

Examples: project/workspace identity for an explicit directory, durable session
root/index reads, cheap path normalization, persisted metadata.

Tier 1 may require an explicit location, but must not initialize plugins, tools,
LSP, formatters, VCS, snapshots, watchers, or execution runtime merely because
a directory exists.

### Tier 2 — workspace configuration/catalog

Examples: resolved provider/model catalog, agents/commands from workspace config,
MCP/config metadata. Require explicit workspace/location ownership and pay only
for the configuration services the answer genuinely needs.

### Tier 3 — execution/runtime

Examples: prompts, tools, plugin runtime, shell/PTY, requested LSP/format work,
VCS/snapshot mutations. This is the tier that may justify the full execution
graph, and expensive services should still be lazy when possible.

### Instance-routing invariants

- A server request with no explicit directory/workspace/session-derived location
  must **not** silently invent one with `process.cwd()`.
- `process.cwd()` is acceptable as an outer CLI convenience. It is not a server
  routing policy.
- A small response body does not imply a cheap request. Trace middleware and
  service construction all the way through `InstanceStore`/bootstrap before
  calling an endpoint cheap.
- If one resource-named API group mixes cheap/global reads with runtime actions,
  split the ownership boundary rather than forcing every endpoint through the
  heaviest middleware used by any sibling.
- Missing location on a Tier 2/3 operation should fail explicitly or route to a
  deliberately global Tier 0/1 surface. It must not fall through to cwd.
- Every full instance creation should be attributable to an explicit caller,
  location, and runtime reason. If it cannot be explained, observability and/or
  ownership are incomplete.

## Concurrency And Shared Ownership

First remove unnecessary work; only then bound necessary work.

- A scheduler, semaphore, debounce, lazy import, hover delay, viewport gate, or
  one-at-a-time queue can protect the system, but it does **not** make an
  unnecessary operation architecturally correct.
- Prefer one shared owner for expensive observers, timers, portals, caches,
  subscriptions, and transport streams in dense UI. Per-item consumers should
  contribute lightweight identity/intent.
- A single shared timer that wakes N expensive per-row computations is still N
  work. Share the computation or move it to an incremental projection.
- Prefer one batched snapshot plus one shared update channel over N row requests
  or N session subscriptions.
- Background work must be bounded in count **and** in the dimension that really
  costs (bytes, history length, listener fanout, CPU time, etc.).
- Keep session-local and location-local work local. Unavoidable global work must
  be bounded, cooperative, observable, and cheap.

## Required Reasoning For Cross-Layer / Performance Work

Before patching, narrate the real path end to end:

> producer/storage -> domain service -> route + middleware -> transport -> client
> cache/store -> component -> displayed value

Then narrate the reverse demand path from the UI back to the source of truth.
For each step ask:

- Why does this layer own this work?
- What scales with active sessions, history, parts, projects, listeners, bytes,
  or rows?
- Which scarce shared resource is held while it runs?
- Is the same fact already materialized upstream?
- Can an event update a compact projection once instead of every consumer
  reconstructing it?
- If another session starts simultaneously, where does it wait or duplicate
  work?

If the verbal story contains something like "load 200 messages to draw one
badge" or "create a workspace instance to validate a token," treat that as an
architecture defect, not a micro-optimization opportunity.

## Performance Closure Standard

Measure before and after, but do not confuse a narrow green benchmark with an
architecture proof.

- Exercise the **actual trigger state**. Idle startup cannot prove behavior for
  selected/working sessions; one visible timeline cannot prove a desktop sidebar
  under six concurrent streams.
- For desktop-wide failures, include the real Electron renderer + sidecar +
  server path when practical. Isolated unit/microbenchmarks prove mechanisms,
  not the absence of cross-layer coupling.
- Closure needs negative invariants in addition to latency numbers: no implicit
  instance creation, no metric-only history hydration, no unbounded listener
  growth, no N-per-row transport, bounded event rate, and convergent teardown.
- Re-run representative 1 / 3 / 6+ concurrent-session scenarios for work whose
  cost can scale with active sessions.
- Scope conclusions to what was actually measured. New contradictory runtime
  evidence automatically reopens a prior closeout; do not defend an old verdict
  against a better trace.
- Tests should make ownership mistakes fail, not merely verify the optimized
  implementation of the current ownership mistake.

## Workspace

Runtime dependencies stay directed from Schema to Core and Protocol, then from
Core and Protocol to Server/OpenCode. Client runtime code may depend on Schema
and Protocol but never on Core or Server. Keep browser-safe contracts free of
host/runtime implementation details.

## API Surfaces

This repository is hybrid. Choose a client from the endpoint's actual owning API,
not from a UI component name.

This section describes how to work safely with the **current hybrid tree**; it does
not make both client families OpenFork product targets. OpenFork is V1-first. Do
not migrate a V1 call onto Protocol/current `/api/*` merely because the generated
client exists.

- **Protocol client**: `packages/client` / `@opencode-ai/client`, generated from
  `packages/protocol` `ServerApi`. After changing Protocol, run `bun run generate`
  from `packages/client`.
- **Unified SDK**: `packages/sdk/js` / `@opencode-ai/sdk/v2/client`, generated
  from the full `packages/opencode` `OpenCodeHttpApi`. This is the only generated
  client for `experimental/*`, `instance/*`, `control/*`, `workspace/*`,
  `quota/*`, `sync/*`, `tool/*`, and other OpenCode-owned route groups. After
  changing `packages/opencode/src/server/routes/**`, run `bun run build` from
  `packages/sdk/js`.
- If both API layers changed, regenerate both. Never edit generated client files
  by hand.
- A "V2" suffix in a UI component is not an API-version decision.
- Protocol/current-client parity is not an OpenFork release requirement. Maintain
  it only where retained code actually depends on it.

API availability is separate from architecture correctness. Finding an existing
SDK method does not establish that the route has the right ownership tier.

## Dirty Worktree Safety

This repository is frequently shared by concurrent campaigns and agents.

- Read current source and relevant diffs before editing.
- Preserve unrelated tracked and untracked work.
- Do not reset, restore, stash, clean, or broadly rewrite the worktree to make a
  task easier.
- Batch related edits narrowly and keep architectural documentation synchronized
  when a finding changes the intended ownership model.
