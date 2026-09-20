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

### Product and compatibility boundary

OpenFork is an **independent product surface**, not an OpenCode-compatible
distribution. Shared source ancestry and `@opencode-ai/*` names do not imply local
API, plugin, extension, CLI, config, or behavioral compatibility.

- Local client/server APIs, runtime behavior, plugin contracts, UI, tools,
  persistence, and configuration are fork-owned and may diverge.
- OpenCode plugins/clients/extensions must be assumed **unsupported** unless the
  exact integration is explicitly named, tested, and documented.
- The strict upstream compatibility boundary is any **upstream-operated remote
  OpenCode service that OpenFork actually consumes**. Preserve its required
  request/auth/header/streaming/response/error/model/quota semantics.
- Upstream release tags are source donors. Tag syncing does not create a local
  compatibility obligation.
- Read `docs/architecture/compatibility-boundary.md` before changing upstream
  service adapters or making any compatibility claim.

#### Brand and compatibility identifiers

- **Product identity is OpenFork.** User-visible UI, CLI/TUI copy, local API/OpenAPI
  descriptions, OAuth pages, crash/help/support surfaces, package metadata, and
  third-party app-attribution headers owned by this fork must identify OpenFork.
- Support, documentation, bug reports, and product metadata must point at
  `https://github.com/thelabcorner/openfork` (or a path beneath it), not upstream
  OpenCode support channels.
- Preserve **OpenCode Zen**, **OpenCode Go**, and **OpenCode Console** when those
  names identify upstream-operated services that OpenFork consumes.
- Preserve compatibility identifiers such as the `opencode` executable,
  `opencode.json`, `.opencode/`, `OPENCODE_*`, `@opencode-ai/*`, provider
  IDs, database/protocol keys, and `opencode://` unless an explicit migration
  changes that contract. A compatibility identifier is not product branding.
- Upstream-sync work must not reintroduce generic OpenCode product branding onto
  OpenFork-owned surfaces.
- **Distribution is fork-owned.** OpenFork update/install/release code must never
  route through upstream OpenCode npm, Homebrew, Scoop, Chocolatey, GitHub release,
  container, or install-script channels merely because compatibility identifiers are
  retained. Fork-owned binaries come from `thelabcorner/openfork` releases.
- Treat package-manager installs that OpenFork does not publish/manage as
  **externally managed**: they may receive update-available notifications, but
  OpenFork must not invoke an upstream package manager to replace itself.
- The CLI may self-replace only when ownership and replacement semantics are
  explicit. Today that is the POSIX `~/.opencode/bin/opencode` direct-install
  path; Windows and other installations fail closed to the OpenFork releases page.
- Retaining `@opencode-ai/*`, `opencode-ai`, or `opencode` as compatibility
  names does **not** grant OpenFork ownership of the corresponding public package
  namespace or distribution feed. Publishing there requires a separate explicit
  architecture/product decision.

### V1/current lifecycle policy

Do not collapse runtime/API/UI generation into one "V1 vs V2" choice.

- **Execution/runtime:** current/V2 is a semantic/reference architecture for
  OpenFork, **not an automatic migration destination**. OpenFork repairs and
  extends its mature V1 production execution path and selectively backports
  current/V2 capabilities into it.
- **Local client/server API:** V1/fork contracts remain the target. Do not migrate
  callers onto current Protocol/`/api/*` merely to match upstream.
- **Presentation/UI:** the new/V2 UI is the primary OpenFork product direction.
  Continue developing V2/new-layout presentation components; do not backport the UI
  to legacy presentation merely because execution remains V1.

- Prefer a shared authoritative owner plus a narrow V1 adapter over duplicated
  semantics.
- Do not delete or bypass V1 merely to match upstream's lifecycle.
- V1 removal requires an explicit OpenFork architecture decision with proven
  parity and a product reason; it is never implied by an upstream migration,
  rename, or current/V2 implementation existing.
- The execution policy applies to the **local client API** too. Do not migrate V1 callers onto
  current Protocol/`/api/*` surfaces merely to match upstream. Existing current
  calls are transitional/implementation facts, not a compatibility target.
- It explicitly does **not** mean "V1 UI." A V2-named component or V2 presentation
  system may be the canonical OpenFork UI while consuming V1/fork runtime contracts.
- The OpenCode-hosted Zen/Go model-provider API and any other consumed
  upstream-operated services are the compatibility-critical external boundary.
  Their versioning must not be conflated with local V1/current client API
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

### Turn provenance is not provider role

Conversation semantics and LLM protocol roles are separate facts. In particular,
V1 stores several host/runtime turns with `role: "user"` because they must lower
to a provider user message; that does **not** make them human/user-owned turns.

- Persist turn ownership/provenance at the durable message producer. Do not infer
  human/user ownership from `role === "user"`, text shape, or `part.synthetic` in
  downstream consumers when explicit provenance is available.
- `part.synthetic` describes an individual content fragment, not ownership of the
  whole conversational turn. A user-owned prompt may contain synthetic MCP/file
  expansion, and a host-owned continuation may consist entirely of synthetic text.
- Keep semantic message kind/ownership separate from provider lowering. Host
  continuations, shell followups, compaction, and other synthetic turns may
  legitimately lower to provider role `user` while remaining semantically
  non-user turns.
- Keep **authority** separate from both ownership and semantic origin.
  `owner=host` does not mean privileged/System authority. Goal continuations,
  scheduled input, peer/swarm messages, recovery turns, monitor observations,
  and other host-authored conversational state should normally remain
  Synthetic/conversational and may lower to provider `user`.
- Conversely, genuinely privileged host policy must not be demoted to provider
  `user` merely because a selected SDK/route has weaker System-message support.
  Resolve exact provider/model semantics and concrete runtime encoder
  capability, then choose an authority-preserving projection (for example a
  privileged head/top-level System representation) or fail closed.
- Provider wire role is therefore a **derived projection**, never the canonical
  source of ownership, provenance, trust, or authority. The durable/runtime
  model must remain truthful even when several semantic kinds lower to the same
  provider role.
- Keep **domain ownership** and **authorization/origin lineage** separate from
  turn ownership and instruction authority. Example: a Goal specification
  projection is a host-owned Synthetic turn whose current truth is owned by the
  Goal domain (`goalID` + revision). The human turn that authorized Goal creation
  is durable audit lineage, not a permanent privileged/instruction-authority
  token. Consumers must read current Goal state from the Goal owner rather than
  re-deriving it from the original prompt.
- Prefer the term **instruction authority** for model-priority semantics:
  conversational/user-lane versus privileged/operator-lane. Do not call causal
  provenance "authority"; use lineage/origin/authorization so it cannot be
  mistaken for provider instruction priority.
- The canonical lowering law is:
  `User/Synthetic/Shell/Compaction -> conversational provider lane`, normally
  provider `user`; `System -> authority-preserving privileged representation`
  chosen by the exact provider/API-route/model/runtime compiler. A provider
  `user` role does not assert that a human typed the bytes.
- Current/V2 `SessionMessage.User` / `Synthetic` / `Shell` / `Compaction` behavior
  is the architectural oracle. V1 compatibility code should converge toward that
  taxonomy rather than creating feature-specific ownership heuristics.
- Legacy V1 ownership inference belongs in one compatibility boundary. Do not
  duplicate part-scanning heuristics across Goal, compaction, title, fork/revert,
  timeline, or authorization code.
- When reviewing `role === "user"`, classify the use: provider/structural turn
  mechanics may remain role-based; user-intent, authorization, causality,
  checkpoint, title, model-source, replay, and UI attribution must use semantic
  provenance/kind.

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

### Text and Git line-ending ownership

Line endings are repository/runtime state, not an ambient Windows preference.

- `.gitattributes` is authoritative for tracked-file checkout policy: text is canonical LF, with narrow explicit exceptions such as Windows batch entrypoints.
- `.editorconfig` is the editor-facing default, not a substitute for Git attributes.
- `packages/core/src/git-runtime.ts` owns OpenCode's Git EOL process policy. App-owned Git argv and the shared child-process boundary must derive from it rather than spelling `core.autocrlf`/`core.eol` independently.
- OpenCode-owned child processes pin Git command-scope config so nested/raw Git invoked through tools cannot inherit Git-for-Windows `core.autocrlf=true`. An explicit later `git -c ...` is the intentional escape hatch.
- Git worktree/reset/checkout code must go through the shared Git service/process policy. Do not add private raw-Git materialization paths.
- Edit/write/patch own mutation-byte preservation: editing an existing CRLF or mixed-EOL file must not cause whole-file churn merely because canonical repository policy is LF.
- Global/user Git config is convenience only. Tests must prove behavior under a hostile inherited `core.autocrlf=true` setting.

Runtime dependencies stay directed from Schema to Core and Protocol, then from
Core and Protocol to Server/OpenCode. Client runtime code may depend on Schema
and Protocol but never on Core or Server. Keep browser-safe contracts free of
host/runtime implementation details.

## API Surfaces

This repository is hybrid. Choose a client from the endpoint's actual owning API,
not from a UI component name.

This section describes how to work safely with the **current hybrid tree**; it does
not make both client families OpenFork product targets. OpenFork is V1-first on the
**execution/local-API axis**, while V2/new-layout remains the preferred UI
generation. Do not migrate a V1 call onto Protocol/current `/api/*` merely because
the generated client exists.

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
