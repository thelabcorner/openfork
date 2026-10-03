# OpenFork `code` Tool Implementation Ledger

> Status: planning ledger for `docs/plans/code-tool-architecture.md`.
>
> No implementation is implied by this file. Each work package has an explicit
> architectural objective, likely files, dependencies, tests, and exit gates.
>
> Product decision: the provider-visible `execute` tool is replaced by `code`.
> `@opencode-ai/codemode` remains the default confined JS/TS execution engine.

## 0. Program-level success criteria

The project is complete only when all of the following are true:

1. provider-visible `execute` no longer exists in the normal OpenFork tool manifest;
2. one byte-stable provider tool named `code` provides `search | run | save | call`;
3. `code.run` can programmatically invoke every eligible capability the same agent
   could invoke through the normal V1 tool system, excluding only meta-recursive
   surfaces such as `code`, `tool`, and `invalid`;
4. native, lazy, MCP, MCP-resource, and saved-code calls share one authoritative
   host invocation gateway;
5. nested calls preserve permissions, plugin hooks, Snapshot mutation ordering,
   cancellation, tracing, attachments, and model/session identity;
6. every root code execution receives a durable run ID and replayable source identity;
7. a successful run can become a project/global saved code tool without creating a
   new provider-visible tool;
8. saved tools are revision-addressed, immutable-handle pinned, reviewable on disk, and
   callable from both provider-level `code.call` and runtime `call(saved-ref, input)`;
9. provider-prefix bytes do not scale with MCP/saved-tool catalog size;
10. no Python runtime or Jupyter-style kernel is introduced;
11. ordinary `code.run` does not spawn Bun/Node;
12. benchmarks demonstrate that the new orchestration path does not create
    pathological DB/event/schema-conversion overhead.

## 1. Architectural decisions frozen before implementation

### D1 — four provider actions

```text
search
run
save
call
```

There is no provider-facing `describe` action. Exact inspection is
`search({ ref })`.

The runtime surface is intentionally smaller than the provider surface:

```text
provider: search | run | save | call
runtime:  call(ref, input)
```

P0 executing programs cannot recursively invoke provider-level `run`, `save`, or
`search`. Saved code is itself a capability and is composed through `call(...)`.

### D2 — flat provider schema

Use one stable object schema with `action` plus optional fields. Do not depend on a
deep discriminated-union/`oneOf` schema surviving every provider transform.

Decode and validate action-specific rules in the tool implementation.

Every static field still carries a concise provider-facing description stating which
action uses it and whether it is required there. Reject unknown/contradictory fields
with a precise action-specific repair shape. Flat schema is a provider-compatibility
choice, not permission to make the interface self-undocumented.

### D3 — default runtime is confined

`@opencode-ai/codemode` is the P0/P1 executor. Bun/Node module execution is a later
profile and must not delay replacement of `execute`.

### D4 — fresh replay only in initial product

```ts
code({ action: "run", runID: "run:prt_...", input })
```

creates a fresh run of the same source.

It does not reuse earlier tool results and does not imply idempotence.

Cloudflare-style durable resume replay is a separate future feature.

### D5 — filesystem owns saved source

Canonical project location:

```text
<physical-project-scope-root>/.openfork/code/<id>/
  tool.json
  code.ts
  revisions/
    <revisionHex>.json
    source/
      <sourceHashHex>.ts
```

`code.ts` is the mutable reviewable working copy. `revisions/<revisionHex>.json` is
the immutable executable-revision envelope and points to immutable canonical source
under `revisions/source/<sourceHashHex>.ts`. Exact handles resolve through the revision
envelope and never execute the mutable working copy. Project scope identity is the
canonical physical workspace/session root, not logical `ProjectID`.

The global root is the authoritative OpenFork global config root
(`<global-config>/code/<id>/`), resolved through the existing Global/config-path
owner rather than by picking an arbitrary member of `Config.directories()`.

Search/usage indexes are rebuild-derived. Filesystem source remains authoritative for
library content. A small durable `SavedCodeAdmission` record is **not** an index: it is
host trust state for `(scope-kind, physical-scope-key, id, executable-revision)` and
records the source hash/provenance but no source bytes. Descriptor fingerprints are
presentation/cache diagnostics only, not trust identity. If admission state is lost,
the filesystem library remains intact but must be re-admitted before execution through
either a successful `code.save` or an explicit human operator admission flow.

### D6 — executable revision, descriptor fingerprint, and execution contract are distinct

This distinction is important.

**Executable revision** changes when execution semantics change:

- canonical source bytes;
- runtime/profile + CodeMode semantic/runtime API version;
- input schema;
- output schema;
- semantic runtime flags;
- sorted static dependency execution identities: canonical structured identity/ref + executionContract +
  authorityBinding + pinned saved handle when applicable.

It does not change for a display-description or tag edit.

**Descriptor fingerprint** changes when model-facing invocation metadata changes:

- executable revision;
- description;
- input/output schema presentation;
- canonical call identity.

It is internal catalog/cache identity. The agent does not echo it on `code.call`.

**Execution contract** changes only when the callable semantics expected by a caller
change: canonical structured identity/kind, input/output schemas, semantic contract version, saved
dependency revision where applicable, and a non-secret `authorityBinding` that
identifies what authority/backend the capability is actually bound to.

Executable source trust and saved-call approval both bind to the **executable revision**.
Descriptor fingerprint is catalog/search cache identity only. Description/tag/help-text
changes therefore cannot revoke or silently expand executable authority; semantic schema,
runtime, dependency, or authority-binding changes already mint a new executable revision.

`code.call` staleness is solved by requiring an immutable saved-revision handle,
not by requiring a descriptor contract round-trip.

### D7 — same-name save creates a new revision, not destructive overwrite

The human name points to the current callable revision.

Old immutable staged revisions remain available while referenced by:

- in-flight calls;
- retained run history;
- explicit revision-qualified call;
- revision history policy.

### D8 — all external effects still flow through host tools

No ambient `fetch`, raw filesystem, env, process, or credentials in the confined
profile.

### D9 — direct exposure and code-call eligibility are orthogonal

Keep existing `exposure: "default" | "lazy"` for provider-manifest policy and add a
separate **required** programmatic eligibility bit `codeCallable: boolean` on normalized
registrations. It has no implicit-true default at the authorization boundary.

Meta-recursive wrappers (`code`, `tool`, `invalid`) are false. Other capabilities are
classified explicitly during inventory construction; long-lived/interactive/process-
backed tools are not rejected merely by category, but they must pass the same explicit
reentrancy/cancellation/resource audit before being marked callable.

### D10 — the catalog is frozen; authorization is live

One CodeRun captures an immutable capability registration snapshot so search and
execution agree on exact implementations/schemas. It does **not** freeze permission
authority. Every leaf invocation re-evaluates current session/agent policy and then
runs the leaf's ordinary `ctx.ask(...)`.

The complete original `Tool.Context` is propagated to leaves, including messages,
model/promptOps/authorized-agent context, worker-root metadata, and cancellation.

### D11 — `code` is a Snapshot delegator, but descendant mutation is still observed

Do not wrap the whole root `code` call in `snapshot.withMutation`. The outer tool is a
delegator. The Snapshot mutation/read lock is **leaf-scoped**: no delegator may hold it
across a nested capability subtree.

Each leaf classifies mutation from its real arguments using the same policy as direct
invocation; unknowns default to mutating. MCP registrations remain conservatively
mutating unless they gain an explicit stronger contract.

Ordering and observation are separate:

- gateway mutating leaf -> enter leaf `snapshot.withMutation(...)` for ordering;
- before dispatching a mutating leaf, gateway calls a root-scoped
  `markWorkspaceMutation()` sink owned by SessionProcessor;
- processor `step-finish` therefore still performs post-step `snapshot.track()`, patch
  projection, and SPAD progress/thrash signaling when Code descendants mutated.

A pure-read Code graph does not invalidate Snapshot reuse. A Code graph that writes a
file must still emit the ordinary post-step patch/snapshot evidence.

### D12 — nested Code permission decisions do not become wildcard standing grants

`search` and `run` add no generic prompt beyond an explicit `code = deny` gate;
their leaves authorize normally. `save` and `call` have dedicated Code permission
patterns, with `call` revision-bound.

Permission prompts originating inside one root run are deduplicated and scoped to
that run/revision by default. Do not automatically turn a leaf's
`always: ["*"]` suggestion into a project-wide standing grant.

The pre-existing permission precedence issue must be corrected before claiming
revision trust: a configured explicit deny must be able to revoke/override a prior
standing approval.

### D13 — saved scope aliases never silently shadow

Provider-level `code.call` may use an unqualified saved ID only when it is unique
across effective project/global scopes. Collision returns `SavedToolAmbiguous`.
Runtime composition uses explicit host-issued saved refs/immutable handles and never
silently shadows one scope with another.

## 2. Exact initial provider schema

Likely Effect schema shape:

```ts
const Parameters = Schema.Struct({
  action: Schema.Literals(["search", "run", "save", "call"]),

  // search
  query: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  target: Schema.optional(
    Schema.Literals(["callable", "capabilities", "saved", "runs"]),
  ),
  limit: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.String),

  // run / replay
  code: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  runID: Schema.optional(Schema.String),

  // save
  // reuses top-level runID above

  save: Schema.optional(SaveSpec),

  // call
  tool: Schema.optional(Schema.String),
})
```

Every field lowers with a static JSON-Schema `description`; the flat shape is not an
excuse to make the provider guess action semantics:

| field | provider description requirement |
|---|---|
| `action` | Required. One of `search`, `run`, `save`, `call`; determines which remaining fields are valid. |
| `query` | `search` only. Broad lexical query. Omit with `ref` for exact inspection. |
| `ref` | `search` only. Exact host-issued capability/saved/run ref returned by prior discovery. |
| `target` | `search` only. Defaults to `callable`; `runs` is explicit so history does not pollute capability discovery. |
| `limit` / `cursor` | `search` only. Bounded deterministic pagination. |
| `code` | `run` only. Inline JavaScript/TypeScript source. Mutually exclusive with `runID`. Dirty saved working copies are read through ordinary filesystem authority and passed here; there is no separate working-copy execution field. |
| `input` | `run`/`call`. JSON-safe program/tool input. Omitted inline-run/call input defaults to `{}`; omitted replay-run input reuses the original run input. For object-shaped saved schemas, the decoder may accept a JSON-object string via the existing broker-argument normalizer; genuine string schemas remain strings. |
| `runID` | Action-dependent. On `run`, **freshly re-executes** the recorded source against current state; not resume/continuation and no prior leaf results are reused. On `save`, identifies the successful run to promote. Same physical worktree scope and retained ToolPart only. |
| `save` | `save`, or optional post-success promotion on `run`. Only `save.name` is required; other manifest metadata is optional. |
| `tool` | `call` only. Canonical saved ID, explicit scoped alias, or immutable handle. Aliases resolve atomically to one admitted revision before permission/execution; the resolved immutable handle is pinned and echoed. |

The implementation may use Effect annotations or an equivalent static JSON-schema
projection, but these descriptions are part of the provider contract and therefore
must stay catalog-independent.

Validation table:

| action | required | forbidden / XOR |
|---|---|---|
| search | one of `query/ref` optional for browse | run/save/call fields ignored only if absent; reject contradictory fields |
| run | exactly one of `code/runID` | the other source selector is invalid |
| save | `runID`, `save` | no `code` |
| call | saved canonical ID, explicit scoped alias, or immutable revision handle in `tool` | no run source fields |

For `run`, `save` is allowed as an atomic post-success promotion request.

Search with neither `query` nor `ref` is a bounded browse operation. `target`
defaults to `callable`, which includes current native/lazy/MCP capabilities plus
saved tools but excludes historical runs.

## 3. Capability identity model

Every callable entry needs stable internal identity:

```ts
type CapabilityIdentity = {
  // collision-free structured identity; never reconstructed from a lossy joined string
  segments: readonly string[]

  // paste-ready runtime serialization returned by code.search
  ref: string

  // stable source family
  kind: "native" | "lazy" | "mcp" | "mcp-resource" | "saved"

  // revision/generation of callable implementation where meaningful
  revision?: string

  // existing V1 permission identity when it differs from the Code SDK path
  permissionKey?: string

  // secret-free identity of the external/host authority this capability points at
  authorityBinding?: string

  // complete model-facing descriptor cache identity
  descriptorFingerprint: string

  // execution-relevant semantic identity
  executionContract: string

  // saved capabilities expose this immutable identity to code.call
  savedHandle?: string
}
```

Examples:

```text
native:read
native:sqlite
mcp:github/list_issues
saved:project/find_todos@sha256:abc...
```

The search result returns a canonical structured identity plus a collision-free,
paste-ready runtime `ref` for `call(ref, input)`. Never ask the model to invent path
sanitization or escaping.

For MCP specifically, canonical identity preserves the original server/tool segments.
Do not reuse lossy sanitized names as identity. Render refs with canonical UTF-8
percent-encoding per segment: only RFC 3986 unreserved bytes remain literal; separators,
`%`, and non-ASCII bytes are encoded with uppercase hex. Exact lookup decodes back to
the segment array, never a dot/sanitize-derived path.

The legacy flattened MCP key remains only `permissionKey`. Inventory build groups by
that key and fails distinct colliding MCP identities closed for Code invocation with
`AmbiguousPermissionIdentity`; collision tests cover both same-server sanitize
collisions and cross-server flattened-key collisions.

## 4. Saved-name rules

`SaveSpec.name` is the canonical saved-tool ID and filesystem component. It is not
free-form display prose. Validate before touching disk and do not silently slug it.

Recommended canonical rule:

```text
^[a-z][a-z0-9_]{0,63}$
```

Saved IDs are portable JavaScript identifiers. Lowercase ASCII avoids Windows
case-fold/path collisions, shell/filesystem surprises, and cross-platform ambiguity.
Reject Windows reserved device names plus the reserved scope IDs `project` and `global`.
P0 derives any friendly UI label from the ID;
there is no second durable name/alias identity.

Search returns a directly usable capability ref, for example:

```text
saved:project/find_todos@sha256:...
```

The strict ID grammar deliberately removes the need for a second reversible
filesystem/runtime-ref name-encoding scheme.

## 5. Saved-tool source contract

P0 confined saved tool:

```text
tool.json
code.ts
```

`code.ts` is the same script-body format accepted by `code.run`.

Input arrives through the immutable global `input`.

Example:

```ts
```ts
const matches = await call("native:find", {
  grep: input.query,
  path: input.path,
})

return {
  matches,
  query: input.query,
}
```

The example intentionally uses a literal capability ref so the saved dependency is
fully statically resolvable in P0.
```

This guarantees:

```text
successful scratch source
    ==
saved source
    ==
replayed source
```

No code-generation rewrite is needed to promote a run.

## 6. Static dependency analysis for saved tools

OpenFork can improve on a simple "connector list" by deriving the capability
dependencies actually present in source.

At save time, inspect the already prepared AST and record:

```ts
type DependencySummary = {
  staticRefs: string[]
  observedRefs: string[]
  pinnedSavedHandles: Record<string, string>
}
```

Examples:

```ts
await call("native:read", {...})
await call("mcp:github/list_issues", {...})
```

yield exact static dependencies.

P0 save requires literal/statistically resolvable call targets. Computed refs and
runtime discovery are valid scratch-run techniques but make the run non-promotable
until the dependencies are made explicit.

The successful origin run supplies `observedRefs`.

Benefits:

- preflight missing capabilities before side effects;
- pin saved-to-saved dependencies to exact immutable revisions;
- better saved-tool UI;
- better search ranking;
- better portability diagnostics;
- more useful provenance than recording every connector that happened to be
  configured.

Dependency metadata is preflight/reproducibility information, not authorization. P0 saved
artifacts are static-ref only; every runtime invocation still traverses the gateway.

## 7. Preflight behavior

Before invoking a saved revision:

1. load immutable revision;
2. validate input schema;
3. verify revision trust/permission policy;
4. bind saved dependencies to the immutable handles recorded in this revision;
5. resolve required native/MCP static capability refs against the captured snapshot;
6. verify execution contracts;
7. start execution.

If a required static path is missing or an execution contract drifted, fail before
executing anything:

```text
Saved tool find_todos@abc123 requires native:symbols, which is not available
in this root capability snapshot. Search capabilities or enable the missing tool.
```

P0 saved tools have no dynamic capability dependencies. If runtime discovery is added
later, it gets an explicit manifest mode and weaker preflight guarantees rather than
silently changing this contract.

## 8. Runtime Code SDK model

The P0 Code SDK is intentionally tiny:

```ts
const result = await call(capabilityRef, input)
```

The provider API and runtime API are intentionally **not** mirrors of each other:

```text
provider surface                  runtime surface

code.search                       call(ref, input)
code.run
code.save
code.call
```

`call` is the universal composition boundary for native, MCP/resource, and saved
capabilities. Saved code is itself a capability, so saved A may call saved B without
recursively invoking provider-level Code Mode.

The runtime does **not** expose `run`, `save`, or catalog discovery in P0. Local
abstraction uses ordinary JavaScript functions; durable abstraction uses an explicit
agent-level `code.save`.

Capability refs are host-issued/collision-free and returned by provider-level
`code.search`; agents do not invent sanitizer rules. The internal identity is
segment-based even if the rendered ref is a string.

Do not require an npm package for the confined profile.

A future Bun/Node module profile can expose the same conceptual bridge through a
virtual host-supplied module, e.g.:

```ts
import { call } from "openfork:code"
```

That virtual module is RPC-backed and carries no credentials.

### Static model-facing instructions

The provider description/instructions should teach only this stable heuristic:

```text
direct tool -> one known operation or when each result needs fresh model judgment
code.search -> discover stable capability refs before authoring
code.run -> predictable composition/control flow/filtering/parallelism
code.call -> invoke a known saved abstraction from the agent loop
code.save -> persist a successful orchestration intentionally
inside code -> use call(ref, input); no nested run/save/search
```

Never enumerate current capabilities in the provider prefix.

## 9. WP0 — baseline and guardrails

### Objective

Capture current `execute` behavior before refactoring, while explicitly separating
**semantics to preserve** from **known defects the new architecture must correct**.

### Likely files

```text
packages/opencode/test/tool/code-mode.test.ts
packages/opencode/test/tool/registry.test.ts
packages/opencode/test/session/tools*.test.ts
NEW packages/opencode/test/fixture/capability-harness.ts
packages/codemode/test/**
```

### Add tests for

- MCP nested success;
- MCP nested structured content;
- attachment collection;
- MCP permission allow/ask/deny;
- plugin before/after count;
- cancellation while permission is pending;
- cancellation during child call;
- parallel child calls;
- current catalog/search exact-identity/ref behavior;
- current provider description mutation;
- direct MCP Snapshot mutation guard vs nested Code Mode behavior.

### Existing baseline coverage audit

Do not duplicate coverage already present in `test/tool/code-mode.test.ts`. The live
suite already exercises structured MCP content, media attachment stripping/collection,
parallel `Promise.all`, per-child permission checks, before/after plugin hooks,
catchable child/hook failures, active/pre-aborted cancellation, catalog rendering and
runtime search, and permission visibility.

`test/tool/registry.test.ts` also captures the current provider-visible `execute`
registration and dynamic MCP-catalog description behavior. Those assertions are
baseline evidence; later commits deliberately flip the provider-description invariant
rather than deleting the evidence without replacement.

The remaining WP0 gaps are cross-layer rather than interpreter-unit gaps:

- fully resolved provider-manifest byte snapshot after provider/plugin transforms;
- real `SessionTools` + ToolRegistry projection rather than CodeModeTool-only mocks;
- direct-vs-nested Snapshot mutation ordering/count;
- cancellation while a real permission request is pending;
- cancellation propagation into a child transport/executor;
- provider-delivery truncation count vs raw semantic internal result;
- root ToolPart lifecycle/PartID availability at invocation time.

### Shared fixture deliverables

The capability harness must be able to exercise:

- a real resolved `SessionTools` map + real ToolRegistry projection;
- executable fake MCP;
- counting plugin before/after hooks;
- counting Snapshot mutation reasons;
- counting Truncate/model-delivery calls;
- allow/ask/deny permission cases;
- cancellable 1/4/8-way fan-out;
- a native expected-failure tool;
- a structured `data` result tool.

Add a fully-resolved provider-manifest snapshot helper for at least two model families;
snapshotting the raw Tool.Def is insufficient because provider schema transforms and
`tool.definition` shaping happen later.

### Known defects to assert, then fix

| defect asserted in WP0 | cleared by |
|---|---|
| provider-visible `execute` description changes with MCP catalog | WP15 static `code` replacement |
| nested MCP lacks direct MCP's Snapshot mutation ordering | WP2/WP3 gateway migration |
| outer `execute` is treated as mutating instead of as a delegator | WP2/WP3 leaf-owned mutation |
| nested progress publishes are uncoalesced | WP2 root trace/progress aggregation |
| host CodeMode limits are effectively unset | WP3 finite limits |
| native provider wrappers turn expected failures into defects / provider-truncate intermediate output | WP0.5 semantic executor split |
| lazy `tool` broker applies admission to the broker but not the delegated target | WP2 common authorization owner |
| standing `always` approval can outrank a later explicit configured deny | WP0.25 permission precedence fix |

The clearing WP **replaces** the old-behavior assertion with the inverse regression;
do not leave permanent xfails or delete evidence without a replacement assertion.

### Exit gate

The suite captures enough current semantics that gateway extraction cannot silently
change preserved behavior, and names the defects whose expected results deliberately
change.

## 9.25. WP0.25 — permission precedence + run-scoped approval primitive

### Objective

Make explicit configured deny revocable/authoritative before Code introduces
revision-bound saved-tool trust.

### Likely files

```text
EDIT packages/opencode/src/permission/index.ts
EDIT packages/schema/src/v1/permission.ts
EDIT packages/opencode/src/session/tools.ts
EDIT permission UI/reply projection as required
```

### Work

The current standing `approved` list must not outrank a later configured deny merely
because it is appended after the configured rules. Preserve normal explicit allow/ask
semantics while making a current explicit deny authoritative over stale standing
approval.

Also add the mechanism required by Code composition: permission asks may carry a root
`executionID`, and the reply/permission owner can record `once`, `this run`, or explicit
`always` scope. Code-originated leaf approvals default to `this run`; repeated matching
asks in that root reuse only the run-local decision. Entering another saved frame never
creates a wider approval scope. Durable `always` remains an explicit separate human
choice and a live configured deny always wins.

### Exit gate

- create an `always` approval, then add an explicit configured deny: the deny wins;
- a later explicit configured allow can still intentionally re-authorize;
- one Code leaf approved for `this run` is reused only inside that root execution;
- a sibling/nested saved frame cannot turn that run approval into project/global standing authority;
- ending/cancelling the root drops its run-local approval map;
- existing non-Code permission behavior stays covered by the permission suite.

## 9.5. WP0.5 — semantic executor / delivery split

### Objective

Create the raw internal invocation seam that `code` requires **before** native tools
are placed behind CodeMode.

### Work

- adopt the semantic shape already used by Core rather than creating a third V1-only
  error/projection model: decoded input -> typed expected ToolFailure -> structured
  result -> provider projection;
- widen V1 `Tool.Def.execute` so expected failures are not erased at the type level;
- remove leaf-local `Effect.orDie` sites that currently collapse expected failures
  before the shared wrapper (`read`, `grep`, `access`, and every matching built-in);
- make provider delivery derive from the same semantic executor and preserve existing
  user-facing provider behavior at the outer boundary;
- gateway/internal delivery receives bounded semantic `data ?? output` without
  provider truncation;
- add `data?: unknown` now, not in a late WP, and convert the first composition-critical
  tools (`find`/`grep`/`glob`/`read` plus other obvious structured owners);
- route delegators to target semantic executors so nested orchestration does not
  provider-truncate twice;
- audit plugin/custom-tool adapters at the same seam. When an adapter cannot expose a
  richer raw semantic value, register its returned bounded text as the semantic fallback
  rather than attempting to reverse a provider projection; expected adapter failures
  still map to sanitized catchable `CapabilityFailed` and defects remain private;
- fix `packages/codemode/src/tool-runtime.ts::runHost`: interruption wins, typed
  expected failure is catchable, genuine defect re-dies; do not use `Cause.squash`
  to turn defects into sandbox errors;
- replace abort-as-`Effect.die(AbortError)` with proper interruption/cancellation
  semantics.

### Exit gates

- an expected denied/failed native leaf is catchable by CodeMode `try/catch`;
- a genuine host defect is **not** catchable by program code;
- pure and mixed interruption cannot be swallowed into a catchable failure;
- root abort is classified as cancellation/interruption, not `InternalRuntimeError`;
- provider invocation still exposes the same user-facing expected-error semantics;
- counting Truncate proves provider delivery truncates once and internal code
  invocation does not use the provider truncation path;
- nested delegators consume structured/internal target results rather than provider
  projections;
- plugin/custom adapters have an explicit tested internal-result behavior and cannot
  accidentally double-truncate through both adapter and provider wrappers;
- a real composition example using the first converted structured tools executes
  end-to-end in a test.

## 10. WP1 — CapabilityInventory

### Objective

Create one authoritative callable inventory shape without changing provider behavior.

### Likely files

```text
NEW packages/opencode/src/tool/capability.ts
EDIT packages/opencode/src/tool/registry.ts
EDIT packages/opencode/src/session/tools.ts
EDIT packages/opencode/src/mcp/**
EDIT packages/opencode/src/session/tools.ts   # extract inline MCP resource helpers
```

### Responsibilities

- authoritative structured capability identity segments plus a collision-free internal
  key, host-issued canonical ref, and optional rendered path;
- bounded descriptions/search documents;
- kind + input/output schemas;
- raw semantic execution closure;
- one live authorization/admission owner using current session+agent rules plus the
  root run-scoped approval map;
- delegated-leaf metadata (`delegatesTo`) instead of separate composite hard-code tables;
- non-secret `authorityBinding` used by execution-contract drift checks;
- argument-dependent workspace mutation classifier;
- required `codeCallable` and `lifetime: inline | durable`;
- monotonic inventory generation/fingerprint.

### Important constraint

Do not eagerly stringify TypeScript signatures during every registry build.

Capability registrations carry required `codeCallable`. Provider direct/lazy exposure
and programmatic eligibility must be tested independently so changing one does not
accidentally mutate the other. Missing eligibility is a construction error, not an
implicit allow.

Store normalized schema descriptors and derive rendered signatures lazily/cached.

Do not build inventory from `registry.tools()` or `registry.all()` independently.
Introduce one common model/session-effective registration projection that applies
model-specific patch/edit selection and definition shaping while retaining lazy
registrations and semantic executors. Provider tools and Code inventory are two
projections of that same owner.

Consolidate all current permission-resolution owners (`Permission.evaluate`, provider
projection policy, and `Permission.disabled`/composite visibility) behind one common
authorization projection. Encode composite/delegated behavior for `find`, `web`, and
`browser` in registration metadata; delete duplicated hard-coded composite tables once
parity is proven. Ordinary native/lazy target denies must still win.

MCP registrations keep original server/tool identity for Code paths while retaining the
existing flattened permission identity separately. Lossy legacy permission-key
collisions are detected at inventory build and are non-callable through Code until
explicitly migrated. `authorityBinding` fingerprints
non-secret connection authority (server/transport/endpoint + credential-scope/account
identity, never credential bytes) so schema-identical reconnects cannot silently change
a saved tool's authority target.

Extract the currently inline MCP resource list/read/template helpers into ordinary
registrations owned by this projection instead of leaving a second execution path in
`SessionTools`. Their permission identity must be explicit/server-scoped; add migration
coverage for the current generic-`read` behavior before changing it.

### Exit gate

Provider-facing direct tool inventory remains behaviorally unchanged.

## 11. WP2 — CapabilityInvocationGateway

### Objective

Move nested invocation semantics into one host service.

### Likely file

```text
NEW  packages/opencode/src/session/capability-invocation-gateway.ts
EDIT packages/opencode/src/tool/access.ts
EDIT packages/opencode/src/session/tools.ts
```

### Dependencies

WP1.

### Required behavior

- captures immutable inventory snapshot;
- invokes native/lazy/MCP/resource capability;
- preserves the real root `Tool.Context.callID`/`partID` for permission and question UI;
- derives separate monotonic `frameID` identities for nested trace/accounting/interrupts;
- derives a leaf context whose abort signal is independently cancellable but linked to
  root abort, and whose `metadata(...)` targets only the bounded in-memory Code trace;
- nested leaves never settle/update their own ToolParts and never call
  `SessionProcessor.updateToolCall` directly; progress is bounded/coalesced to the root;
- plugin hooks exactly once **per semantic frame**; delegators may have their own outer
  frame but never manually double-fire a child frame already owned by the gateway;
- runs the registration's live authorization/admission closure, then preserves leaf `ctx.ask`;
- Snapshot mutation serialization;
- one ToolInterrupt entry per cancellable leaf, linked to root abort and released in finalization;
- cancellation/interrupt tracking down to leaf transport/process where supported;
- trace metadata;
- attachment collection;
- internal data projection;
- nested-depth accounting.

### Mutation rule

Mutation classification lives in the shared registration policy as a function of
actual leaf arguments, not a static read/write bit and not in each caller. Reuse the
semantics already encoded by `toolMayMutateWorkspace(toolID, args)` while moving
ownership to the common registration seam. Unknown capabilities default to
mutation-capable.

Split Snapshot responsibilities explicitly. For **ordering**, `code` is a delegator/read-
only registry wrapper and only mutating leaves enter Snapshot mutation sections. For
**observation**, the root processor must still learn that at least one nested leaf
mutated so post-step tracking, patch projection, and SPAD progress/thrash recovery run.
P0 marks the root mutation-observed when any mutating leaf dispatches, through a
processor-owned `markWorkspaceMutation()` callback carried in the invocation context.
This is conservative on failed mutating attempts but preserves the existing post-step
snapshot/diff/SPAD safety contract without falsely marking pure-read Code runs.

### Exit gate

Current direct MCP and current `execute` MCP can both be expressed through the
gateway with equivalent or stricter correctness.

Authorization parity is explicit: direct provider invocation, lazy `tool` broker
invocation, and `code` invocation of the same target produce the same explicit-deny
result. Add a regression for the current lazy-broker target-deny hole before fixing it.

Also explicitly prove the pre-existing semantic drift is removed:

```text
direct MCP mutation ordering
==
code-nested MCP mutation ordering
```

Both must use the same Snapshot mutation owner.

Also prove nested identity separation: N concurrent leaves share the real root
permission/ToolPart `callID`, have N distinct `frameID`/interrupt identities, cancelling
one leaf does not cancel a sibling, and leaf progress produces no direct child ToolPart
update/complete writes.

Additional gates:

- a `code.run` whose descendant writes a file produces the ordinary post-step snapshot
  and patch part;
- a pure-read Code graph leaves the root mutation-observed flag false and preserves
  Snapshot reuse;
- no delegator holds the Snapshot mutation/read lock across a descendant subtree;
- nested checkpoint/task/session-style capabilities settle without lock-upgrade deadlock;
  add a bounded diagnostic/timeout around Snapshot write-lock acquisition if the
  Snapshot owner cannot otherwise make a violated lock-scope invariant observable.

The lazy broker is migrated onto the gateway in this WP. Hook ownership moves rather
than nesting duplicate child hooks. Audit the existing `tool`, `find`, and `web`
delegators: each semantic frame gets exactly one before/after pair, and CodingActivity
must still project once for each mutating leaf.

Add a mixed 8-way read/write fan-out test and measure invalidation count. Start with
correct per-leaf mutation sections; only introduce a root mutation lease/hoist if the
measurement shows repeated invalidation is material and the Snapshot owner can preserve
correct ordering.

## 12. WP3 — migrate existing `execute` to the gateway

### Objective

Prove the gateway before introducing `code`.

### Likely files

```text
EDIT packages/opencode/src/tool/code-mode.ts
EDIT packages/opencode/src/session/tools.ts
EDIT packages/codemode/src/tool-runtime.ts
```

### Work

- remove MCP-client-direct child invocation from `code-mode.ts`;
- construct CodeMode tools from captured capability descriptors;
- route all child calls through gateway;
- preserve outer result shape for now;
- fix Snapshot mutation-order drift;
- pass finite host-owned `timeoutMs`, `maxToolCalls`, `maxConcurrency`, and
  model-facing `maxOutputBytes` rather than inheriting unlimited/fixed package policy;
  keep the current concurrency value (8) as OpenFork's initial policy, not an
  unchangeable interpreter constant;
- keep the new internal intermediate-data budget separate from `maxOutputBytes`;
- thread one root-scoped `CodeExecutionBudget` into the generic CodeMode `copyIn`
  boundary with both `maxLeafBytes` and monotonic `remainingAggregateBytes`; count
  incrementally and reject before a full oversized clone; the package supplies
  mechanism only and OpenFork Code Service owns numeric defaults;
- preserve `McpCatalog.invokeTool` semantics, including the structuredContent-only
  fallback, as the canonical MCP result behavior.

### Exit gate

Existing Code Mode tests pass and new parity tests show nested MCP now observes the
same mutation/cancellation semantics as direct MCP. A structuredContent-only MCP
response also produces the same program-visible value on direct and code-nested paths.
A run whose N leaf results are each below the per-leaf cap but cumulatively exceed the
root aggregate budget fails deterministically with `LimitExceeded`.

## 12.5. WP3.5 — same-process interpreter resource safety

### Objective

Harden the confined in-process interpreter so timeout/tool-call/output limits are not
mistaken for a memory/CPU sandbox.

### Likely files

```text
EDIT packages/codemode/src/codemode.ts
EDIT packages/codemode/src/interpreter/runtime.ts
EDIT packages/codemode/src/stdlib/** where expansive intrinsics are implemented
EDIT packages/codemode/test/**
```

### Generic mechanisms

Add host-supplied limits equivalent to:

```ts
maxOperations?: number
maxStringBytes?: number
maxCollectionEntries?: number
maxConcurrency?: number
```

- deterministic interpreter fuel consumed by AST evaluation / loop iteration /
  user callback/function execution;
- pre-allocation guards for predictable string expansion (`repeat`, padding, concat,
  etc.);
- Array/Object/Map/Set growth guards, including direct large array-index writes;
- stable CodeMode diagnostics that OpenFork maps to `LimitExceeded`.

Do not bake OpenFork numeric defaults into the generic package.

### Exit gate

- tight synchronous loops stop on operation fuel even without a tool call;
- pathological string expansion fails before materializing an over-budget value;
- Array/Object/Map/Set growth beyond the configured entry limit fails deterministically;
- ordinary existing CodeMode programs retain parity when limits are not supplied;
- OpenFork always supplies finite production values before `code` is exposed.

## 13. WP4 — static provider-visible `code` tool

### Objective

Introduce the new surface without persistence.

### Likely files

```text
NEW  packages/opencode/src/tool/code.ts
NEW  packages/opencode/src/code/service.ts
NEW  packages/opencode/src/code/schema.ts
NEW  packages/opencode/src/code/error.ts
EDIT packages/opencode/src/tool/registry.ts
```

### Initial actions

```text
search
run
```

`save/call` fields exist in the stable schema but return an explicit
`NotAvailableYet` only during branch development; do not ship that partial state as
final product.

### Decoder ergonomics

Reuse the existing broker JSON-object normalizer for `code.call` when the resolved
saved-tool input schema is object-shaped and the provider supplied a JSON object as a
string. Do **not** blindly JSON-parse `code.run.input`: a program may legitimately
expect a string/number/array. Validation/coercion is target-schema-aware.

### Runtime

Existing `@opencode-ai/codemode`.

### Rollout

Do not co-expose `code` and `execute` to the provider. During branch development,
add one temporary fork-owned selector in `RuntimeFlags`, e.g.
`OPENCODE_EXPERIMENTAL_CODE_TOOL` (default false):

```text
false -> legacy `execute` selection + legacy MCP exposure policy
true  -> `code` selected, `execute` absent, direct MCP tools hidden by the Code surface
```

When this selector is true, legacy `OPENCODE_EXPERIMENTAL_CODE_MODE=false` must **not**
re-expose direct MCP tools. The new selector owns both responsibilities. Internal tests
may instantiate both implementations, but a provider turn sees exactly one.

At WP15 final cutover, delete the temporary selector and make `code` the sole surface;
retire/deprecate the legacy Code Mode flag rather than carrying a permanent dual-mode
architecture.

`code` is provider-visible on the new branch even when no MCP servers are connected
because it can orchestrate native/lazy capabilities.

### Exit gate

- `code.run` can call native + lazy + MCP capabilities through one gateway;
- every expected program/tool failure returns the structured outer `CodeResult`
  (`ok:false`, `error.kind`, actionable `error.recovery`) rather than an opaque thrown
  provider-tool error; genuine host defects remain defects;
- selector=false never exposes `code`; selector=true never exposes `execute` or direct MCP;
- toggling legacy `OPENCODE_EXPERIMENTAL_CODE_MODE` cannot create a mixed surface when
  the new selector chooses `code`.

## 14. WP5 — catalog/search service

### Objective

Make progressive discovery cheap and exact.

### Likely files

```text
NEW packages/opencode/src/code/catalog.ts
NEW packages/opencode/src/code/search.ts
EDIT packages/codemode/src/tool-runtime.ts
```

### Search structure

Build once per catalog generation; never re-render schemas/signatures per query:

```text
exactByRef: Map<ref, descriptorRef>
exactByCanonicalID: Map<structured-id-key, descriptorRef[]>
docsByNamespace: Map<namespace, compact descriptorRef[]>
documents: bounded compact token fields + signatureCacheKey
optionalPostings?: Map<normalizedToken, compact descriptorRef postings>
```

P0 may score the compact generation-cached documents linearly using the existing
CodeMode tokenizer/ranking semantics. Add postings only when measured catalog size/p95
justifies them; do not build a second search engine merely to satisfy a synthetic size.

Each compact document keeps bounded normalized name/identifier/property/description
tokens and selected enum tokens. Full TypeScript signatures remain lazy and cached;
broad search never renders every signature.

### Ranking

Preserve the useful existing CodeMode deterministic weighting as the baseline.
Measure before inventing semantic search.

### Exact inspection

```ts
code({ action: "search", ref: "native:sqlite" })
```

returns complete descriptor + signature. Saved exact inspection returns metadata,
immutable handle, dependency summary, and source **path/reference**, not source bytes.
Reading saved source uses the ordinary filesystem/read authority; global saved source
therefore retains existing outside-project / external-directory permission behavior.

### Runtime call bridge

Provider-level `code.search` owns discovery. The P0 resolver exposes one host-effect
primitive to prepared programs:

```ts
call(ref, input)
```

No in-program catalog search/describe is exposed in P0.

### Exit gate

- exact `ref` lookup is O(1) map access;
- namespace browse does not scan the entire catalog;
- broad search is benchmarked at 1k/10k/50k synthetic descriptors; if compact linear
  scoring misses the chosen p95 budget, enable the optional postings accelerator behind
  the same search contract;
- ordinary broad queries render **no full signatures**; full signatures are exact-ref
  detail (or an explicit detail request), and the serialized search response has a byte budget;
- profile deeply nested signature rendering separately; if schema rendering is material,
  eliminate per-node visited/context cloning rather than hiding quadratic work behind cache;
- saved-origin text is treated as bounded/untrusted structured data and cannot alter tool instructions;
- exact native/canonical ref matches cannot be outranked by saved metadata;
- `target:"runs"` searches bounded summary/title/capability references only, not raw source.

## 15. WP6 — resolver-backed CodeMode

### Objective

Avoid constructing a huge nested `Tool.make` object for every run.

### Generic package requirement

Keep `packages/codemode` host-neutral.

Possible additive API:

```ts
type CapabilityResolver = {
  resolve(ref: string): ToolReference | undefined
  invoke(ref: string, input: unknown): Effect.Effect<unknown, ToolError, R>
}

// Provider `code.search` uses the host catalog/search service. P0 does not expose
// resolver search/describe as runtime intrinsics.
```

Runtime can then resolve a `ToolReference` path directly.

### Compatibility

Keep existing `CodeMode.make({ tools })` API.

### Exit gate

Both materialized-tree compatibility tests and resolver-backed tests pass, **and** one
prepared resolver/catalog plan is reused across N ordinary `code.run` executions
without O(catalog-size) preparation on each run. The materialized-tree constructor is
compatibility surface, not the production hot path.

Add AST dependency extraction while the interpreter already has the parsed tree:

```text
literal `call("host-issued-ref", ...)` references
computed/dynamic call-target marker (P0 saved promotion rejects these)
```

Expose it as host metadata, not model-visible execution output.

## 16. WP7 — prepared program + compile/parse cache

### Objective

Make replay and repeated saved calls extremely cheap while keeping `packages/codemode`
host-neutral.

Current pipeline unconditionally performs TypeScript `transpileModule(...)` followed
by Acorn parse for every execution.

Add an opaque generic seam:

```ts
const prepared = CodeMode.prepare(source)
const result = runtime.executePrepared(prepared)
```

`PreparedProgram` may contain the parsed representation, format/runtime version, and
pure static tool-reference metadata. It must contain no execution state or capability
snapshot.

Cache immutable prepared programs by:

```text
(codemodeSemanticVersion, transpiler/parserVersion, sourceHash)
```

Use a bytes-weighted bounded LRU. Cached entries contain no Tool.Context, capability
snapshot, execution state, promises, or fibers.

### Experiments

Benchmark a JS-first fast path: Acorn parses valid model-authored JavaScript directly;
fall back to TypeScript transpilation only when needed. Make the TypeScript compiler
import lazy behind that fallback so ordinary JS-only CodeMode use does not pay the
compiler module-graph cost at startup. Do not ship unless parity tests prove supported
syntax, diagnostics, and source locations remain correct.

### Exit gate

Benchmark proves repeat execution avoids parser/transpile cost and cache eviction is
bounded.

Prepared-program cache entries may include the static dependency summary because both
are pure functions of source/runtime version.

## 17. WP8 — ToolPart-backed CodeRun + fresh replay

### Objective

Every root `code.run` becomes a replayable artifact without duplicating the
repository's existing durable tool-call state.

### Authoritative owner

The existing root V1 ToolPart, already persisted into Core's PartTable, is the
authoritative CodeRun. Its tool input already owns source/input; its state owns
output/error, metadata, timing, and attachments.

### Likely files

```text
NEW  packages/opencode/src/code/run.ts
EDIT packages/opencode/src/session/processor.ts
EDIT packages/opencode/src/session/tools.ts
EDIT packages/opencode/src/tool/tool.ts
EDIT packages/opencode/src/session/session.ts
```

No Core database migration is required.

### Root PartID propagation

The processor already owns `toolCallID -> partID` in its live call map. Expose only a
read-only projection:

```ts
SessionProcessor.Handle.toolPartID(toolCallID): PartID | undefined
Tool.Context.partID?: PartID
```

`SessionTools.resolve` itself runs before provider tool calls exist, so it must not
capture a PartID during registry construction. Instead, when the AI SDK invokes an
individual tool, the processor has already handled `tool-input-*` / `tool-call` via
`ensureToolCall()` and registered `toolCallID -> partID`. The per-invocation context
builder resolves that mapping in memory and sets `Tool.Context.partID`.

Nested gateway calls inherit both the root `partID` and the **real root provider
`Tool.Context.callID`**. They do not mint fake ToolPart call IDs. Each nested frame/leaf
gets a separate monotonic `frameID`/trace-interrupt identity for accounting,
cancellation, and parent/child relationships; permission/question UI stays anchored
to the real root ToolPart. No DB read or ID allocation is added to the execution hot
path.

### Write policy

Use a reversible `runID` handle over the authoritative root PartID. Validate that a
decoded replay source is actually a `code` ToolPart.

For historical resolution, add an owner-level
`Session.getCodeToolPart(partID, physicalScope)` rather than importing PartTable into
the Code Service. Use one parameterized `part -> message -> session` join, establish
the owning `(projectID, workspaceID, directory)` before exposing bytes, then hydrate
the projected part through the same Core/session owner that resolves chunk/projection
references. Never interpret raw `PartTable.data` / `$cdbRef` in Code Service. A
dangling/pruned projection becomes `RunNotReplayable`; foreign-scope/missing parts both
become `RunNotFound`.

Current V1 persists tool input before executor entry, so an executor-local size check is
too late for replay/source-storage safety. WP8 must add a **pre-admission Code input
bound** at the SessionProcessor/AI-SDK tool-call insertion seam before full `state.input`
is durably written. Oversized source/input settles as `InvalidInput` without persisting
the rejected full source payload. Keep the mechanism narrow to `code` unless measurement
or another caller justifies a generic per-tool durable-input budget.

Fresh replay creates a new ToolPart whose metadata records `replayOf` as the
immediate parent and `sourceRunID` as the canonical original source-bearing ToolPart.
Replay-of-replay copies the canonical `sourceRunID`; it never forms an execution-time
linked list. It does not duplicate the old source into a second Code-specific database
table.

Do not persist each nested frame/log/progress event as its own durable row.

Persist a bounded final child-call trace summary in outer Code metadata. Do not store
full arbitrary leaf arguments/results by default; retain hashes/redacted summaries
unless explicitly safe.

### Replay authorization

Replay/run-history access is same **physical project scope** in P0. Resolve the origin
session, derive its canonical physical scope key from the owning workspace/session
location through the same resolver used by saved tools, and require
`originScopeKey === currentScopeKey`. Do not use logical `ProjectID` as the trust
boundary. Deleted and inaccessible foreign-scope handles both produce `RunNotFound`.
Cross-scope reuse is an explicit saved global tool, not ambient run access.

### Exit gate

- `code({ action:"run", runID })` works after a process/session boundary wherever
  the retained same-physical-scope run is valid;
- no second run/source table exists;
- replay ToolParts do not duplicate source and replay-of-replay resolves source in O(1);
- foreign-scope/deleted handles both return `RunNotFound`;
- a pruned/dangling projected part fails `RunNotReplayable`, never leaks raw projection refs;
- oversized root source/input is rejected at the pre-admission processor seam before the
  full rejected source can become durable ToolPart input.

## 18. WP9 — run discovery + ordinary lifecycle + saved-revision reachability

### Objective

Use ordinary session/ToolPart retention for scratch runs, expose efficient same-physical-
scope run discovery, and guarantee that saved tools do not depend on retained history
rows for executable source.

### Policy model

```text
session/ToolPart retention -> run/replay availability
filesystem saved revision -> independent executable authority
saved-to-saved handles     -> staged revision reachability
```

If a source run is pruned, its already-saved filesystem revision remains valid.

P0 does **not** automatically GC committed immutable saved revisions. Source artifacts
are small, revision history is valuable, and an automatic cross-process reachability
sweep is unnecessary risk. Current aliases, old explicit handles, and saved-to-saved
pins therefore remain valid without a GC race.

Only abandoned **temporary staging artifacts that never became committed immutable
revision/source objects** may be cleaned automatically. Cleanup is age-gated and
serialized by the same saved-tool filesystem lock. P0 never automatically removes an
admitted/committed revision object or its referenced source bytes, even when no current
alias points at it; exact handles and pinned saved dependencies remain valid. A future
explicit revision-prune feature may add reachability GC with a separately reviewed
protocol.

For `code({ action:"search", target:"runs" })`, exact `run:prt_...` lookup uses the
PartTable primary key through the projection-hydrating session owner. Broad search must
use a **Code-specific bounded projection that excludes raw `state.input.code`** and is
filtered by physical scope. Reuse existing FTS only if its projection can enforce both
properties; otherwise use a rebuild-derived `code_run_index` containing bounded summary,
lineage, title, capability refs, timestamps, and run ID—never authoritative source,
raw arbitrary input/output, or duplicated CodeRun state.

### Exit gate

- deleting/pruning scratch history cannot break a saved tool;
- deleted runs naturally disappear from search;
- run search cannot surface foreign-physical-scope ToolParts;
- broad run search never indexes/returns raw Code source;
- no separate scratch-run retention/GC subsystem exists;
- no committed/admitted saved revision is automatically swept in P0;
- temp cleanup cannot delete committed revision/source objects or break exact/pinned handles.

## 18.5. WP9.5 — SavedCodeAdmission durable trust owner

### Objective

Create the minimal process-global durable trust fact that distinguishes "valid source
exists on disk" from "OpenFork has explicitly admitted this exact revision for saved
execution."

This is a trust/authority table, **not** a CodeRun/source store and not a rebuild-derived
search index.

### Likely files

```text
NEW packages/core/src/code/admission.sql.ts
NEW packages/core/src/code/admission.ts
NEW packages/core/src/database/migration/<generated>_saved_code_admission.ts
EDIT generated Core schema/migration registration as required by the existing migration owner
NEW packages/core/test/code/admission.test.ts
```

### Scope identity

```text
project scope -> scope_kind="project", scope_key=<canonical physical workspace-root identity>
global scope  -> scope_kind="global",  scope_key=<canonical global saved-code-root identity>
```

The Core DB is process/global, so a global admission is visible across project locations.
The separate first-project execution permission gate still applies when a global saved
tool is used in a project for the first time.

### Service

Conceptually:

```ts
SavedCodeAdmission.Service {
  get(...)
  admit(...)   // idempotent exact tuple
  revoke(...)
}
```

The admitted tuple is:

```text
scope kind/key
saved ID
executable revision
source hash
origin: code-save(run provenance) | operator
admitted time
```

It stores no source, manifest, arbitrary input/output, credentials, or dependency body.

### Writers

Only:

1. `code.save` after successful source resolution/validation and save authorization;
2. explicit human operator UI/CLI admission after recomputing the same canonical
   revision/dependency identity and showing it for confirmation.

`code.call` never auto-admits.

### SQLite ownership

Use the normal Core migration path. An idempotent insert that does not read first does
not need a read-before-write transaction. Any future admit/revoke transaction that
reads before its first mutation must use `{ behavior: "immediate" }` per Core WAL
writer rules.

### Exit gate

- schema migration applies on a fresh and existing database;
- admission is globally queryable without Location/Tool bootstrap;
- exact duplicate admit is idempotent;
- revoke makes the revision non-callable without deleting filesystem source;
- DB reset/source-preserving recovery can re-admit through the explicit operator path;
- no source bytes appear in the admission table.

## 19. WP10 — saved filesystem catalog

### Objective

Build durable reusable tools without provider schema growth.

### Likely files

```text
NEW packages/opencode/src/code/saved.ts
NEW packages/opencode/src/code/revision.ts
NEW packages/opencode/src/code/storage.ts
NEW packages/opencode/src/code/provenance.ts
```

### Ownership: process-global base + project overlay

Do not make one Location-scoped `saved.ts` own both scopes.

Conceptually split:

```text
GlobalSavedCodeCatalog.Service   process-global
  -> canonical global config/code root
  -> global manifests/revisions/catalog generation

ProjectSavedCodeOverlay          Location/worktree scoped
  -> <physical-project-root>/.openfork/code
  -> project manifests/revisions/catalog generation

EffectiveSavedCatalog
  -> immutable composition of global base + current project overlay
```

The global catalog must be queryable without `Location`, `InstanceStore`, or Tool
bootstrap. Project scope may depend on the physical workspace/location owner. The Code
Service composes the two for one root execution and applies ambiguity rules there.

This split mirrors the admission store's process-global ownership and prevents a first
project from becoming the accidental bootstrap owner of global saved tools.

### Watch/refresh

Maintain independent global/project catalog generations and a derived effective
generation. A change in either invalidates only saved discovery/preflight state, never
the provider-visible `code` definition. Do **not** depend on the existing
ToolReload watcher: `.openfork` is ignored by generic project inventory/watch paths,
global config is not covered by the same watcher, and Node/Bun behavior differs.

Saved catalog changes MUST NOT invoke provider tool-registry hot reload merely to add
one saved member.

Treat project `.openfork/code/**` as an OpenFork artifact subtree for generic
ProjectInventory/source-search purposes: broad project analysis skips it unless the
caller explicitly targets that path. Do not auto-edit `.gitignore`; project saved tools
may intentionally be version-controlled. Git-arrived revisions remain unadmitted until
`code.save` or the explicit operator admission flow establishes host trust.

`code.save` synchronously invalidates the local saved catalog. Manual/external edits
use a Node+Bun-compatible poll/watch strategy. Correctness still does not depend on
notification timing: exact `code.call` revalidates the selected manifest/revision
from disk before execution.

First use of an immutable handle in a root loads staged bytes, recomputes `sourceHash`
and the executable revision from the manifest's recorded canonical dependency envelope,
verifies `SavedCodeAdmission`, preflights recorded dependencies against the captured
root capability snapshot, and caches a `VerifiedSavedProgram` by handle. Stored hash
strings are never trusted blindly. Repeated calls to that handle in the same root do
not re-read/re-hash/re-derive dependency identity; the next root revalidates from disk.

Saved-tool resolution must not traverse symlinks, junctions, or reparse points.
`tool.json`, `code.ts`, immutable revision envelopes, and immutable source objects must
resolve to regular files within the owning saved-tool directory in canonical physical
realpath space; an unprovable containment/identity check fails closed.

The filesystem is authoritative for source/revision bytes, while Core owns a small
durable `SavedCodeAdmission` trust fact keyed by scope-kind + physical-scope-key +
saved ID + executable revision, with source hash/provenance as verified attributes. It
contains no source. Descriptor fingerprint is presentation/cache metadata, not a trust
key. Catalog entries without a matching admission are visible as dirty/unadmitted but
cannot execute.

The admission service has two authorized writers in P0: `code.save`, and an explicit
human operator UI/CLI recovery/import path. Operator admission recomputes/validates the
same canonical revision/dependencies, records `origin=operator`, and requires direct
human confirmation; `code.call` never auto-admits an arbitrary filesystem revision.

### Exit gate

Manual filesystem edits are detected and reflected as dirty/unvalidated working state
without changing the provider-visible `code` tool definition. They do not silently
mint a callable immutable revision; promotion back to callable state goes through the
save/validation path.

A verified filesystem revision without a matching `SavedCodeAdmission` remains
inspectable but fails closed for `code.call`. Removing/corrupting admission state never
deletes or rewrites filesystem source.

## 20. WP11 — `code.save`

### Objective

Promote a successful run with almost zero ceremony.

### Atomic operation

The dedicated `permission="code", pattern="save:<scope>:<id>"` decision is part of WP11. It is evaluated
before any staged source or manifest pointer is written.

```text
successful CodeRun
  -> resolve exact canonical source bytes through CodeRunSource
  -> require resolved sourceHash == run metadata sourceHash
  -> authorize permission="code", pattern="save:<scope>:<id>"
  -> validate SaveSpec
  -> derive dependency summary
  -> derive executable revision
  -> acquire existing Core cross-process Flock on canonical physical-scope + saved-ID key
  -> canonicalize/hash source
  -> write/reuse immutable revisions/source/<sourceHashHex>.ts
  -> write immutable revisions/<executableRevisionHex>.json envelope
  -> write/update mutable reviewable code.ts
  -> atomic-rename tool.json as filesystem visibility commit point
  -> persist exact SavedCodeAdmission as callability commit point
  -> refresh saved catalog index
  -> return descriptor + immutable handle
```

### Idempotence

Saving the same source/schema/runtime **and the same sorted static dependency execution
identities** under the same name repeatedly returns the existing executable revision.
If a native/MCP dependency executionContract or authorityBinding changed, re-validating
the same source intentionally mints a new executable revision so the tool can adopt the
new environment without inheriting old trust.

Changing only description/tags may update descriptor metadata/fingerprint without
creating a new executable revision or invalidating executable admission/approval.

Changing source/input/output/runtime creates a new revision.

P0 also enforces scope portability at save time: a **global** saved tool may not pin a
project-scope saved dependency, because that physical dependency cannot be reproduced
safely in another project. Reject this as `SaveRejected` with the named dependency.
Project tools may depend on global tools normally; global->global and project->project
pins retain their exact immutable handles.

Only `save.name` is required on the happy path. Description/schema/tags are optional
overrides. Canonical source is UTF-8, BOM-stripped, CRLF/CR->LF with no Unicode
normalization or whitespace trimming, and that exact canonical source is what runs.
Canonical JSON envelopes are key-sorted/whitespace-free.

### Exit gate

Failed or cancelled run cannot be promoted. A successful replay/call run is promotable
only while `CodeRunSource` can still resolve the exact verified bytes that produced it;
otherwise return `RunSourceUnavailable`. A denied `permission="code", pattern="save:<scope>:<id>"` leaves no
staged/manifest/admission mutation behind.

Serialize same-scope/same-ID saves with the saved-code storage lock. Immutable source
and revision-envelope writes are content-addressed/idempotent; the mutable alias manifest
is committed by atomic rename. If the process dies after manifest commit but before
admission, the revision is visible but non-callable and an idempotent retry can complete
admission safely. Do not add agent-facing CAS ceremony unless a real multi-writer use
case later requires optimistic conflict detection.

## 21. WP12 — `code.call` and runtime saved-capability composition

### Objective

Invoke reusable code through both model-facing and programmatic paths.

### Direct

```ts
code({
  action: "call",
  tool: "find_todos", // or project/find_todos, global/find_todos, exact saved:...@sha256 handle
  input,
})
```

### Nested runtime composition

```ts
return await call("saved:project/find_todos@sha256:...", input)
```

### Requirements

- `tool` accepts canonical ID, explicit scoped alias, or immutable handle;
- canonical/scoped aliases resolve atomically at admission to one immutable revision;
  ambiguous unqualified project/global IDs fail before permission or execution;
- the resolved on-disk revision must have a matching `SavedCodeAdmission` for its
  physical-scope/id/executableRevision/sourceHash before any permission prompt or execution;
- revision-bound `permission="code", pattern="call:<scope>:<id>@<revision>"` authorization runs against that
  admitted executable revision before saved execution is enabled;
- exact immutable handles bypass alias lookup but still receive the same call gate;
- the CodeResult/trace echoes the resolved immutable handle;
- revision pinning for the whole root run;
- project/global scope resolution;
- ambiguous unqualified project/global IDs fail with `SavedToolAmbiguous`;
- input validation before execution;
- static dependency preflight before first side effect;
- saved-to-saved dependency handle pinning;
- save-time scope portability: global revisions may pin global saved revisions but
  reject project-scoped saved handles as `SaveRejected`; project revisions may pin
  global revisions normally;
- nested saved-revision call stack;
- immediate cycle detection with the complete revision path;
- host-owned maximum saved-frame depth of 16;
- child saved frames reuse the root capability snapshot, deadline, abort tree,
  permission context, concurrency pool, and remaining budgets rather than resetting them;
- runtime `call(...)` cannot target provider meta-tools `code`, `tool`, or `invalid`;
- executing code has no runtime `run`, `save`, or `search` primitive in P0;
- underlying capability permissions still execute normally;
- one nested CodeFrame rather than a second provider/session ToolPart or root runtime.

### Exit gate

A->B->A fails immediately with the explicit revision path; A->A is rejected as a
self-cycle rather than spawning another evaluator. A saved revision referenced by
another saved revision remains callable even after its human-facing alias advances.
Nested composition never receives a fresh root deadline/call budget.

No commit/release state exists where `code.call` executes a saved revision before both
its SavedCodeAdmission and executable-revision-bound call approval gate are active.

## 22. WP13 — provenance and trust

### Objective

Persistence cannot convert one transient prompt injection into silent permanent
authority.

### Permission hardening/provenance

WP12 already installs the saved-call executable-revision approval gate before saved
execution ships. This WP hardens the surrounding trust/provenance model rather than
introducing that gate late.

`search` and ordinary scratch `run` add no redundant outer prompt; explicit
`code = deny` still blocks the surface. `save` asks
`permission="code", pattern="save:<scope>:<id>"`. `call` uses the WP12 executable-
revision-bound identity, then leaves authorize normally.

WP0.25 already owns the actual run-scoped approval mechanism and precedence repair.
WP13 verifies that provenance and persistent saved execution do not bypass it; it must
not introduce a second Code-only approval store.

### Record authoritative provenance only

- origin run;
- session/message;
- source hash;
- provider/model where available;
- revision lineage;
- reliable external-content provenance if OpenFork has it.

Do not infer "unsafe" from arbitrary text.

### Global first-project gate

A global revision first used inside an unrelated project gets a project-context
decision.

### Exit gate

Changing saved source cannot inherit an old revision approval.

Project/global same-ID collision cannot redirect an unqualified call. Global
first-project execution remains gated.

## 23. WP14 — structured intermediate data rollout

### Objective

WP0.5 already creates the common `ExecuteResult.data?: unknown` seam and converts the
composition-critical baseline. WP14 expands adoption to additional high-value native
tools without changing the execution contract again.

Direct model projection continues to use `output`; gateway/internal Code consumption
continues to prefer bounded `data ?? output`.

### Additional high-value candidates

- project;
- symbols;
- json;
- sqlite;
- git status/diff metadata where sensible;
- search/find;
- test/typecheck result summaries.

Do not rewrite every tool before shipping `code`.

### Intermediate-size boundary

`data` must still be bounded. Large producer results should paginate or spill to an
artifact/reference instead of allocating unlimited in-memory JSON.

## 24. WP15 — replace `execute`

### Preconditions

- `code.run` parity proven;
- native + lazy + MCP path proven;
- provider static-schema invariant proven;
- CodeRun/replay proven;
- save/call proven;
 - cancellation/permission tests green;
 - `ExternalToolCoverage` / OFXP/OXP semantic coverage retargeted from `execute` to
   `code`;
 - TUI/tool-row dispatch understands `code`;
 - one semantic runtime flag owns both orchestration-tool choice and MCP manifest
   hiding;
 - legacy `execute = deny` config migration/alias behavior is tested so rename cannot
   silently widen authority.

### Work

```text
registry:
  remove execute registration
  register code

tool/code-mode.ts:
  either delete adapter or reduce to reusable host adapter helpers

registry describeCodeMode:
  delete dynamic description generation

runtime flags:
  remove the temporary OPENCODE_EXPERIMENTAL_CODE_TOOL selector
  make code the sole orchestration surface + sole owner of MCP direct-tool hiding
  retire/deprecate misleading OPENCODE_EXPERIMENTAL_CODE_MODE semantics

docs:
  make code-tool architecture adopted
  rewrite docs/architecture/code-mode.md

permission migration:
  normalize legacy `execute` -> `code` once in the ConfigPermissionV1 decode/config-normalization owner
  only when no explicit `code` rule exists; keep Permission.fromConfig a pure rule projection
  prove execute=deny -> code=deny and execute=deny + code=allow -> explicit code allow

coverage/UI:
  retarget ExternalToolCoverage execute -> code
  update registry coverage assertions
  update TUI Execute row dispatch/metadata projection atomically
```

### Exit gate

Normal provider tool catalog contains `code`, not `execute`.

No release/turn ever exposes both at once. Direct MCP tools remain hidden whenever
`code` is the selected orchestration surface. Final main has no temporary branch
selector and no ambiguous legacy flag capable of re-exposing MCP tools.

## 25. WP16 — UI / trace projection

### Objective

Make programmatic tool execution understandable without flooding the timeline.

### Schema owner first

Before building renderers, define one bounded browser-safe `CodeRunTrace` contract in
the existing V1 session/schema owner and have the outer Code ToolPart metadata project
that exact shape. TUI/desktop/session-ui consume the schema-owned trace; they do not
invent client-local parsing of `metadata: any`.

Likely owners:

```text
EDIT packages/schema/src/v1/session.ts        # CodeRunTrace / RunID codecs
EDIT packages/opencode/src/code/**            # authoritative in-memory trace + projection
EDIT packages/opencode/src/session/tools.ts   # compact live metadata projection only
EDIT packages/tui/src/routes/session/**       # code row / expandable call graph
EDIT packages/session-ui/src/components/**    # registered code renderer
```

Live progress is deliberately lossy and compact: counters plus bounded active/top-N
frames. It must not republish/structuredClone the full source-bearing ToolPart for
every nested start/end. Final settlement writes the full bounded `CodeRunTrace`
once, so dropped 500 ms throttle updates never become the durable record.

Nested permission prompts keep the real root ToolPart callID/partID for UI anchoring
and carry capability/frame identity in host-owned request metadata; clients do not
look for nonexistent child ToolParts.

Outer timeline row:

```text
Code
  9 calls · 182 ms
  read ×3
  symbols ×2
  sqlite ×1
  saved/find_todos ×1
  ...
```

Expandable detail:

- source;
- run ID;
- replay lineage;
- child trace;
- duration;
- permission pauses;
- saved revision;
- logs;
- attachments.

Nested calls should not each become top-level conversation rows.

Use throttled/coalesced progress, borrowing the existing V1 metadata-throttle lesson.

## 26. WP17 — performance benchmark suite

### Benchmarks

#### B1 provider footprint

Measure serialized provider tool manifest:

- no MCP/no saved tools;
- 100 MCP;
- 1k MCP;
- 10k synthetic;
- +1k saved tools.

`code` definition must remain byte-identical.

Also record the serialized `code` description/schema byte counts explicitly so a
small accidental catalog append cannot hide inside an otherwise large manifest.

#### B2 inventory build

Measure full build and incremental update.

#### B3 search

100 / 1k / 10k / 50k descriptors, p50/p95.

Measure exact lookup separately from broad ranked search and assert broad search does
not render all signatures.

#### B4 run startup

- cold module load with JS-only path;
- cold module load forcing TypeScript fallback;
- source hash;
- compile miss;
- compile hit;
- zero leaf calls.

#### B5 gateway

No-op test capability to isolate gateway overhead.

#### B6 leaf-call execution

- sequential 1 / 10 / 100 awaited leaf calls to expose per-call fiber/promise overhead;
- 1 / 4 / 8 concurrent leaf calls to measure fan-out throughput.

#### B7 saved call

- cold catalog;
- warm catalog;
- first-use immutable-handle admission: staged-byte hash + revision-envelope verify +
  dependency preflight + SavedCodeAdmission lookup;
- repeated same-handle call in one root using cached `VerifiedSavedProgram` (no filesystem
  re-read/re-hash/re-derive);
- compile hit;
- nested saved call depth 2 with dependency preflight;
- negative gate: a P0 run with computed/dynamic capability targets cannot be promoted
  as a saved tool until dependencies are made literal/static.

#### B8 persistence

DB writes/events per root run.

Count progress metadata/event publishes as well; fan-out must remain coalesced rather
than O(leaf-event count) durable/SSE traffic.

#### B9 memory / serialization

- catalog/index/compile-cache retained bytes;
- peak RSS/heap during one run with a near-limit structured leaf result;
- peak additional copy bytes across host result -> sandbox data boundary;
- outer `CodeResult` serialization passes/bytes: model delivery uses compact JSON and
  should avoid repeated pretty-stringify/encode/decode work when one bounded encoding
  can be reused. UI pretty rendering is presentation only.

#### B10 cancellation

time from abort to all nested work settled.

### CI

Prefer **structural/deterministic gates** over noisy absolute timings. Initial blocking
checks should include:

- provider-visible `code` description + JSON schema are byte-identical at 0/100/1k/10k
  capability inventories and after saved-tool churn;
- exact ref lookup performs no full-catalog scan;
- broad search renders zero full TypeScript signatures;
- a prepared-program cache hit performs zero TypeScript transpile/Acorn parse work;
- a confined run spawns zero child processes;
- 1-leaf and 100-leaf roots produce the same O(1) durable ToolPart settlement count and
  nested leaves produce zero child ToolPart settlements;
- repeated calls to one verified saved handle in a root perform zero additional
  filesystem reads/re-hashes/revision derivations;
- abort settles all child frames and produces zero post-settlement leaf progress writes;
- fan-out actually overlaps up to the configured shared-root concurrency cap rather
  than silently serializing.

Collect p50/p95 wall-clock distributions for search, startup, gateway overhead, saved
calls, and cancellation, but keep absolute timing thresholds report-only until stable
baselines exist. Ratio/scaling regressions may become blocking earlier when they are
low-noise.

## 27. WP18 — optional Bun/Node module profile

This is deliberately after `execute` replacement.

### Trigger for implementation

Real saved tools repeatedly require one or more of:

- multi-file modules;
- third-party pure JS libraries;
- algorithms unsupported by the confined JS subset;
- heavy computation substantially faster in native JS.

### Runtime contract

```text
JS/TS only
Bun preferred where bundled/available
Node fallback where distribution requires
framed reverse RPC to CapabilityInvocationGateway
no credentials
sanitized environment
explicit cwd
no implicit network
killable child process
content-addressed module revision
dependency/lock graph fingerprinted into revision
```

### Do not

- auto-install dependencies;
- inherit all environment variables;
- expose arbitrary network solely because Bun/Node supports it;
- silently fall back from confined to native execution.

Runtime profile is part of executable revision identity.

Environment construction is allowlist-based: credentials/tokens and unrelated
`OPEN*`/provider secret variables never reach the child. Process-tree cancellation
must be proven on Windows as well as POSIX before this profile is enabled there.

## 28. Future WP — durable resume replay

Do not implement during the initial `execute -> code` replacement.

Trigger only when OpenFork needs approval/process interruption to survive a host
restart or transport epoch.

Required semantics, informed by Cloudflare's durable runtime:

- stable execution ID;
- sequenced leaf-call log;
- replay divergence detection;
- previously applied non-idempotent calls return recorded results rather than
  executing twice;
- explicit policy for re-executable large/idempotent reads;
- deterministic capture primitive for nondeterministic values used in control flow;
- paused vs running vs stale execution states;
- rollback/compensation is separate from rejection;
- concurrent calls during resumable segments need deterministic ordering or must be
  disallowed.

This is **resume replay**, not `action:"run"` + `runID` fresh replay.

## 29. Cloudflare ideas adopted deliberately

Current Cloudflare Code Mode provides useful evidence for:

- one outer code tool over many operations;
- typed JavaScript capability methods;
- search + focused description;
- credentials remaining in host callbacks/connectors;
- executor separated from durable runtime;
- execution history;
- reusable saved snippets;
- bounded durable history;
- replay logs for durable continuation;
- result shaping before model context.

OpenFork adopts the principles that match its architecture.

## 30. Cloudflare ideas not copied literally

### Not their connector-only universe

OpenFork must include first-party native V1 capabilities, lazy tools, MCP, resources,
and saved code behind one gateway.

### Not automatic durable replay for every permission in P0

OpenFork already has `ctx.ask()` and cancellation semantics. Add resume replay only
when a concrete durability problem demands it.

### Not snippet source as the whole trust model

OpenFork saved tools are content-addressed revisions with project/global scope,
filesystem reviewability, provenance, semantic execution contracts, immutable
handles, and revision-bound authority.

### Not their complete type catalog in provider description

The existing OpenFork dynamic `execute` description is precisely what should be
removed.

## 31. High-risk failure modes

| Risk | Architectural countermeasure |
|---|---|
| code bypasses normal permission checks | gateway owns invocation; leaf policy still runs |
| saved executable semantics change after approval | call authority binds executable revision; descriptor fingerprint is cache/presentation only |
| provider cache busts after save/MCP reconnect | byte-stable `code` definition |
| thousands of wrappers rebuilt per run | resolver-backed CodeMode + cached inventory |
| nested MCP races Snapshot reuse | gateway mutation classification |
| cancellation leaks pending permission | gateway races/propagates abort, tests required |
| nested calls flood DB/SSE | one root durable settlement + coalesced progress |
| source history bloats SQLite | reuse existing ToolPart as CodeRun; no duplicate source/run tables |
| saved tool partially edited during call | immutable staged revision |
| same saved name changes schema silently | immutable revision handle + snapshot pinning |
| project saved tool shadows a global tool | unqualified alias fails on ambiguity; explicit scope/handle required |
| native expected failure becomes defect / host defect becomes catchable | remove leaf-local `orDie`, preserve typed ToolFailure, partition CodeMode Cause, abort as interruption |
| outer code invalidates Snapshot for read-only runs / loses patch observation for mutating runs | leaf-owned ordering + root mutation-observed projection |
| saved manifest tears during concurrent save | existing Core cross-process `Flock` + immutable source/revision objects + manifest-last atomic alias replacement |
| arbitrary Bun/Node becomes host RCE | confined default; native profile explicit and isolated |
| dynamic/computed saved dependency hides reproducibility | P0 saved promotion rejects computed call targets; future dynamic mode must be explicit |
| provider schema transformations break unions | flat provider schema + runtime action decoder |
| distinct MCP identities collapse to one legacy permission key | structured refs + inventory collision detection + fail-closed `AmbiguousPermissionIdentity` |
| nested leaf invents a child ToolPart/callID | real root callID/partID stay fixed; separate frameID/abort/trace identity; no child settlement |
| tight synchronous JS ignores timeout/abort | deterministic operation fuel + growth guards are release gates before `code` exposure |
| global saved revision pins project-only saved dependency | reject save as non-portable; project -> global remains valid |

## 32. Suggested branch/commit sequencing

Keep commits reviewable and bisectable:

```text
1. test(code): add resolved-manifest/capability harness and defect ledger
2. fix(permission): deny precedence + root-run scoped approval primitive
3. refactor(tool): split semantic invocation from provider delivery
4. refactor(tool): add authoritative capability inventory projection
5. refactor(session/code-mode): add gateway; converge execute + lazy broker through it
6. harden(code-mode): finite host limits, snapshot/cancellation/permission parity
7. harden(codemode): add operation fuel + string/collection growth budgets
8. feat(code): add alternate static code search/run surface (never co-exposed)
9. perf(codemode): resolver-backed capability access + lazy search/signatures
10. perf(codemode): bounded prepared-program cache
11. feat(code): ToolPart-backed fresh replay
12. feat(core/code): add SavedCodeAdmission table/service/migration + operator admission owner
13. feat(code): saved filesystem/revision/dependency catalog + immutable staging
14. feat(code): permission-gated save/call + alias/handle resolution + nested saved tools
15. harden(code): provenance, catalog invalidation, trust audit, cycle/depth
16. refactor(tool): atomically replace execute in registry/coverage/TUI/flags/docs
17. feat(app): code-run/saved-tool developer UX
18. perf(code): benchmark closeout
```

Each commit should leave the repository runnable.

## 32.5. 16-agent architecture review closeout

A 16-lane Space Bunny Free review completed on 2026-10-03 across gateway authority,
semantic execution, Snapshot/cancellation, runtime safety/performance, search/identity,
ToolPart replay, saved filesystem/revisions, saved dependency graphs, security,
agent UX, migration, UI/observability, testing, benchmarks, external prior art, and
architecture simplification.

Findings accepted into the live plan include:

- structured capability identity segments and reversible host-issued refs;
- fail-closed handling for lossy legacy MCP permission-key collisions;
- semantic-executor/provider-delivery separation with typed expected failures;
- root ToolPart callID/partID separated from nested frameID/interrupt identity;
- leaf-scoped Snapshot ordering plus root-scoped mutation observation;
- operation fuel and string/collection growth guards as release blockers;
- physical-scope ToolPart replay with owner-mediated projection/chunk hydration;
- immutable revision envelopes distinct from deduplicated source hashes;
- cross-process saved-code locking, manifest-last visibility, then admission commit;
- no automatic committed-revision GC in P0;
- static saved dependency pinning and global-to-project portability rejection;
- generation-cached progressive discovery with no broad-search full signatures;
- deterministic structural performance gates before noisy wall-clock CI thresholds;
- atomic execute-to-code migration across registry, MCP hiding, flags, permissions,
  coverage, TUI/session UI, and docs.

Deliberate product decisions retained despite reviewer simplification proposals:

- global saved tools remain in scope alongside project-local tools;
- P0 runtime exposes only call(ref, input), not recursive run/save/search lifecycle APIs;
- no Python Code runtime exists, but ordinary host capabilities are not forbidden from
  using their normal internal subprocess/Python/browser implementations;
- direct provider delivery is not forced through the Code gateway in P0/P1; it shares
  the same registration/authorization truth while preserving provider-specific failure
  projection;
- committed immutable saved revisions are retained in P0 rather than introducing
  reachability GC races for negligible storage savings.

Any future critique should re-read the current architecture/ledger before reopening
these points; several early review findings were fixed while the swarm was still
running and are stale when read in isolation.

## 33. Definition of implementation-ready

Planning is complete enough to start WP0/WP1 when:

- architecture plan and this ledger agree;
- there are no unresolved questions about provider action surface;
- source-of-truth ownership is explicit;
- runtime scope is explicit;
- saved revision/descriptor identities are explicit;
- migration path does not require a flag-day V1 rewrite;
- performance measurements are specified before optimization work;
- persistence does not depend on future UI;
- no Python evaluator/kernel/runtime profile exists in Code Mode; host capabilities may
  still use their ordinary internal implementations behind the gateway.

At that point, the first coding sequence is WP0 baseline tests -> WP0.25 permission
precedence repair -> WP0.5 semantic-executor split, then CapabilityInventory/Gateway.
Do not start with `code.ts` UI/schema work.
