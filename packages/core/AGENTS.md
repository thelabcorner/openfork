# Core Package Guide

Repository orientation: read `../../docs/map/architecture.md`,
`../../docs/map/packages.md`, and `../../docs/map/v1-v2.md` before changing
cross-generation ownership or package boundaries.

Current/Core is a semantic reference and shared implementation source for
OpenFork, not a mandate to retire V1. When a current capability should also exist
in the mature V1 runtime, put semantics at the lowest correct shared owner and
expose a narrow V1 adapter/backport. Keep Core independent of V1 implementation
details; sharing must not invert the dependency direction.

Core owns durable domain state, event projectors, process/global projections, and
location-scoped runtime services. UI demand may reveal that Core needs a new
projection, but UI code must not define the computation by reconstructing Core
state from rendered artifacts.

## Bottom-up ownership

- Start from the domain producer or durable table, then expose the smallest
  browser-safe contract needed by Protocol/App. Do not add app-side scans because
  a value can be derived from messages, parts, or raw events after the fact.
- Prefer materialized rows and incremental projectors for dense UI facts such as
  session phase, model identity, context pressure, token counters, cache ratios,
  cost, generated/tool time, and recent activity.
- Emit semantic lifecycle state at the moment Core already knows it. Consumers
  should not infer thinking/generating/tool state by exclusion from message shape.
- Keep detail-surface history explicit. A session page may request history; a
  sidebar/list/tab badge should consume O(1) projection data.

## Process-global versus Location-scoped services

- Process/global services for telemetry, indexes, usage summaries, project
  catalogs, device/auth state, and event transport must not depend on
  `Location.Service`, `LocationServiceMap`, `InstanceState`, workspace tools,
  plugins, VCS, snapshots, LSP, or formatters.
- Location-scoped runtime services are correct for prompts, tools, filesystem
  mutation, permissions, snapshots, VCS, LSP, and workspace config. Do not pull
  those services into global reads merely because a caller supplied a directory.
- If a service can be queried without executing workspace runtime behavior, keep
  that query on a narrower process/global or durable-storage boundary.

## Session telemetry/projection rules

- `SessionTelemetry`-style projections are compact live overlays plus bounded
  settled snapshots, not second history databases.
- Update projections from existing `SessionEvent.Step`, `Text`, `Reasoning`,
  `Tool`, retry, pause, and settlement events. Do not create another raw-content
  stream for sidebar metrics.
- Coalesce live updates and bound retained idle state by TTL/LRU. More concurrent
  sessions must not imply one timer, one event stream, or one history scan per
  row.
- Snapshot reads for dense UI must be batched by session ID and must remain
  bootstrap-free: SQLite/global memory only, no Location or Instance materialize.

## Regression expectations

- Tests for global/session projections should assert both the returned data and
  the ownership invariant: no workspace instance, no location service, no
  history hydration unless the API is explicitly a detail/history API.
- When a bug was caused by frontend reconstruction, add at least one Core-level
  test proving the semantic producer emits the compact state directly.

## Project filesystem inventory rules

- `ProjectInventory` is the canonical location-owned producer of the project
  file set (tracked ∪ untracked-non-ignored). Sessions and tools consume it;
  they must not run their own root-wide `rg --files` / `git ls-files` walk.
- The authoritative seed is Git (`Git.index.list`: `ls-files --cached` +
  `ls-files --others --exclude-standard`). Do not replace it with a
  watcher-inferred or search-shaped list: dotfiles, tracked files under
  generated folders, and Git-ignore semantics are part of the domain.
- Watcher deltas are an optimization, not a correctness model. `revision`
  changes only when the observed set changes; explicit `invalidate()` is for
  mutation brokers; `.git`-control events force an authoritative rebuild.
- `complete` is the coverage proof. It is false when the native watcher does
  not own the root, or when an inventory file would be hidden by the watcher's
  ignore rules. Coverage is tracked-aware: `Ignore.coverage` drops any pattern
  that would hide a tracked file from the native subscription and emits the
  exact path globs the callback guard must not drop (`.opencode/`, a package's
  `desktop`/`bin`, a tracked `*.log`, ...). Never reintroduce a segment-based
  ignore check that hides tracked files; a watcher that hides tracked files is
  a freshness bug, not an optimization. Consumers that need exact freshness
  must check `complete` and otherwise re-read Git directly. Do not serve a
  retained tree from watcher ownership alone.
- Adding a new location service to `locationServices` requires adding its exact
  node name to `locationServiceNodeNames` at the same index.
- Acquire a location service from opencode lazily and only when its proof can
  hold. Building the location graph merely to read a value you would then ignore
  is a bootstrap regression (e.g. gate inventory acquisition on
  `Watcher.hasActiveRoot`).
