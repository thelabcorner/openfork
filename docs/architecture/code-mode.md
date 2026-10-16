# Code Tool Architecture

> Status: **adopted OpenFork architecture**.
>
> OpenFork uses the confined JavaScript/TypeScript interpreter in
> `@opencode-ai/codemode` as an execution engine, but the product contract,
> capability graph, permissions, persistence, replay, saved tools, and provider
> surface are fork-owned.

## Product contract

Code is **not an agent mode, session mode, REPL, or durable runtime**. It is one
static provider-visible orchestration tool named `code`.

The provider contract is intentionally small and cache-stable:

```text
code.search
code.describe
code.run
code.save
code.call
```

The `code` tool definition does not grow when MCP servers, saved tools, or run
history grow. Dynamic information stays behind discovery.

Ordinary direct OpenFork tools may remain provider-visible when the registry
chooses to expose them. Connected MCP tools and saved tools do not expand the
provider manifest merely because they exist; Code reaches them through the
host-owned capability graph.

The former provider tool named `execute` is retired. OpenFork never exposes
`execute` and `code` together.

## Agent workflow

The preferred workflow is:

```text
unknown operation
  -> code.search(...)
  -> code.describe({ ref })
  -> code.run({ code, input })

successful reusable run
  -> code.save({ runID, save })

known saved tool
  -> code.call({ tool, input })
```

### Search

`code.search` is broad, bounded discovery. Its targets are:

- `callable` — default; current callable capabilities plus saved tools;
- `capabilities` — host capabilities only;
- `saved` — reusable saved tools;
- `runs` — replayable CodeRun history in the current physical scope.

Broad discovery intentionally omits raw source and full signatures. Search
returns stable refs for later exact inspection.

Run-history discovery is source-free. The session search projection indexes only
bounded Code identity/lineage metadata, never generated source or arbitrary run
input.

### Describe

`code.describe({ ref })` is exact inspection, not search.

For callable capabilities it returns the exact host-issued ref, raw schemas, and
a JSDoc-rich TypeScript `call(ref, input)` signature/example. Agents should
search then describe rather than guess arguments.

For `run:...` refs it returns a safe replay descriptor rather than the original
source body.

### Run

`code.run` executes either:

- new inline JavaScript/TypeScript source; or
- a fresh replay of a retained `run:...` handle.

The sandbox receives immutable JSON-safe `input` and, when host capabilities
are available, the global bridge:

```ts
await call(ref, input)
```

Use ordinary language constructs for branching, loops, filtering, aggregation,
and result shaping. Start independent calls together and await them with
`Promise.all` when concurrency is useful.

Keep large intermediate values inside Code when the model only needs a smaller
derived result.

### Save

`code.save` promotes a successful retained run into a versioned reusable tool.
`code.run` can also request post-success promotion with its `save` field.

A saved tool is a **durable artifact revision**, not a durable interpreter or
warm process.

Project saved tools live under:

```text
<physical-project-root>/.openfork/code/<id>/
```

Global saved tools use the canonical OpenFork global config root.

The filesystem is authoritative for source/revision bytes. Core stores a small
separate `SavedCodeAdmission` trust fact; valid-looking files are not callable
merely because they appeared on disk.

Saved revisions pin their execution-relevant dependency contracts. Re-saving is
how a tool deliberately adopts changed dependency semantics.

### Call

`code.call` invokes a saved ID, scoped alias, or immutable saved-revision
handle.

Saved-to-saved composition remains inside the same supervised root execution.
It does not create nested `code.run` roots.

The shared gateway enforces cycle, nesting-depth, total-call, concurrency,
cancellation, trace, permission, plugin-hook, and workspace-mutation policy.

## Runtime boundary

The default runtime is disposable and confined. It has no ambient:

- filesystem;
- process or shell;
- environment variables;
- network or authenticated `fetch`;
- imports, modules, npm, or package installation;
- credentials;
- Python or Jupyter kernel;
- persistent global state;
- warm interpreter state.

External authority flows only through host capabilities.

This is a deliberate security and determinism boundary. Do not add ambient
authority to make one integration convenient; expose the operation through the
existing semantic capability owner instead.

## Capability ownership

Code does not own duplicate implementations of OpenFork tools.

The effective capability inventory normalizes native, lazy, MCP, MCP-resource,
and saved registrations into stable collision-free refs. The
`CapabilityInvocationGateway` owns semantic invocation.

That gateway preserves the existing OpenFork owners for:

- permissions;
- plugin before/after hooks;
- workspace mutation/Snapshot semantics;
- cancellation and interrupts;
- structured results and attachments;
- resource lifetimes;
- nested frame identity and bounded tracing.

Browser, task/subagent, swarm, MCP, and other operations therefore remain owned
by their existing services. Code composes them; it does not replace them.

## Transport projections

Code is a semantic capability across OpenFork transports, but persistence follows
the authority owner of each transport rather than being emulated for parity.

### Native Sessions and ACP

Native Session clients, including ACP, receive the full static five-action
`code` tool from `ToolRegistry`: `search`, `describe`, `run`, `save`, and
`call`. ACP therefore preserves native `ToolPart`/CodeRun ownership, replay,
saved revisions, permission identities, traces, and attachments. It never
falls back to the retired `execute` tool.

### OXP

OXP represents an external principal with no implicit OpenFork Session. Its
permanent `capability` broker therefore exposes first-class Code as capability
`code` with stateless `search`, `describe`, and `run`. Keeping Code brokered
preserves OXP's bounded permanent-tool manifest and progressive disclosure.
Both the permanent broker description and OXP server instructions explicitly
route models through `describe code` -> `call code`, so brokered placement does
not make the capability implicit or undiscoverable.

OXP has a dedicated deny-by-default `code` authority. That authority admits the
confined interpreter only; it never implies read, write, process, Git, browser,
integration, or other leaf authority. Generated `call(ref,input)` operations
reuse the existing OXP capability owners and independently re-authorize their
root and operation at execution time.

When an explicit approved root and the independent integrations authority are
present, OXP Code also projects that root's MCP catalog as stable
`mcp:<canonical-id>` refs. Search remains schema-light; describe resolves the
current MCP schema, and run re-resolves its exact broker contract immediately
before invocation. Revoking integrations authority therefore invalidates even a
previously discovered MCP ref.

An uncertain external mutation is never flattened into an ordinary interpreter
`ToolFailure`: `OXP_AMBIGUOUS_EXTERNAL_RESULT` escapes the Code boundary so the
caller cannot mistake an unknown commit state for a safely failed operation.

OXP intentionally does not fabricate `save`, run replay, or `code.call` for an
external principal. Those operations require a real Session/ToolPart durability
owner.

### OFXP

OFXP exposes executable capability `code`, also with stateless
`search`/`describe`/`run` and a dedicated deny-by-default `code` peer grant.
A `code.run` is conservatively receipt-backed as a non-idempotent parent
invocation. Every generated leaf receives a fresh child InvocationID linked to
the parent and re-enters the ordinary OFXP dispatcher, preserving the leaf's
peer grant, approved-root confinement, broker contract, mutation receipt, and
ambiguous-commit behavior. Retrying a parent that crossed the execution boundary
never blindly replays its mutations.

Likewise, a child `AMBIGUOUS_COMMIT` escapes the interpreter as an outer
`AMBIGUOUS_COMMIT`; the parent receipt remains `started`, so a same-ID retry
continues to fail closed instead of replaying uncertain mutations.

The transport parity ledger must point to these real `code` owners. Generic
`capability` availability is not sufficient evidence that Code itself exists.

## Permissions

Code is not a privilege-escalation path.

Leaf calls still enforce their ordinary permissions. Saved-tool save/call
operations also use revision/scope-aware Code permission identities.

The deprecated provider permission key `execute` is a compatibility input only
and is normalized to `code`. If both deprecated `execute` and explicit
`code` policy are present, the explicit `code` rule always wins regardless
of object order.

`Permission.fromConfig` remains a rule projection; compatibility migration
happens in config normalization.

## Runs and replay

A CodeRun reuses the existing durable V1 `ToolPart`; OpenFork does not maintain
a second execution-history database.

The public run handle is an opaque reversible PartID handle:

```text
run:prt_...
```

Replay is a fresh execution under current root authority, not continuation of a
warm sandbox.

Replay is restricted to the same canonical physical project/workspace scope.
Logical ProjectID alone is insufficient because one project may have multiple
physical worktrees.

Replay lineage stores canonical source/input run handles so replay-of-replay
resolution remains a constant number of indexed lookups instead of walking an
unbounded chain.

Deleting the session naturally invalidates unsaved scratch runs. Committed saved
revisions are independent durable artifacts.

## Prepared programs and budgets

Valid repeated source is prepared once into an authority-free parsed program and
held in a bounded process LRU. Prepared objects contain no credentials,
permissions, capability snapshot, fibers, or session state, so cache reuse
cannot transfer authority between roots.

One root Code execution shares resource budgets across nested saved calls,
including:

- deterministic interpreter operations;
- aggregate intermediate host-result bytes;
- host capability call count;
- capability nesting depth;
- concurrency.

Nested saved programs cannot reset these budgets by opening a second root.

## Trace and UI contract

The authoritative durable trace shape is schema-owned under
`packages/schema/src/v1/session.ts` as `CodeRunTrace`.

It is browser-safe and bounded. It records compact frame identity, parent/depth,
capability kind, status/timing, optional title/attachment count, aggregate
counters, and truncation metadata. It does **not** embed arbitrary leaf
arguments/results or credentials.

The outer Code `ToolPart` persists that final bounded trace in metadata. Live
progress is only a lossy projection and must not be treated as durable truth.

Clients should consume the schema-owned trace contract rather than inventing
client-local parsing of arbitrary metadata.

## Attachments

Nested capability attachments are collected by the root run and projected once
on the outer Code result. Generated code receives only a bounded data value or a
safe attachment summary; binary/credential-bearing host objects do not enter the
sandbox.

## Saved revision identity

Executable revision identity covers execution semantics, including:

- canonical source hash;
- confined runtime/profile;
- normalized input/output schemas;
- sorted static dependency refs;
- dependency execution contracts;
- non-secret authority bindings;
- pinned immutable saved dependencies.

Description/tags are descriptor metadata, not execution trust. Editing help text
must not silently create a new execution identity.

Global saved tools may not depend on project-local saved revisions. Project tools
may depend on global tools.

P0 saved programs require statically knowable capability targets. A computed
runtime target can be used in scratch Code, but promotion is rejected until the
dependency set is explicit.

## MCP and OpenAPI

Exact MCP tools/resources enter the same capability inventory and invocation
gateway as other host capabilities. Direct MCP provider exposure is not restored
by the deprecated Code Mode flag.

The generic CodeMode package retains OpenAPI engine support, but OpenFork does
not grant ambient authenticated network authority to generated code. Product
integrations expose external APIs as host capabilities.

## Compatibility flag

`OPENCODE_EXPERIMENTAL_CODE_MODE` is retained only as a deprecated parsed
compatibility identifier. Its value no longer selects the orchestration surface
and cannot re-expose direct MCP tools.

The provider-visible orchestration tool is always `code`.

## Ownership

Generic confined execution engine:

- `packages/codemode/**`

OpenFork integration and persistence:

- `packages/opencode/src/exchange/code.ts`
- `packages/opencode/src/oxp/code.ts`
- `packages/opencode/src/oxp/capability.ts`
- `packages/opencode/src/ofxp/capability.ts`
- `packages/opencode/src/code/**`
- `packages/opencode/src/tool/code.ts`
- `packages/opencode/src/tool/capability.ts`
- `packages/opencode/src/session/capability-invocation-gateway.ts`
- `packages/opencode/src/session/session.ts`
- `packages/opencode/src/session/tools.ts`
- `packages/core/src/code/**`
- `packages/schema/src/v1/session.ts`

The V1 session/runtime remains the production semantic owner. Current/V2 code
may be an implementation donor, but adopting Code does not require a V1
retirement or a local API compatibility promise.

## Non-goals

Code is not:

- a persistent REPL;
- a second shell;
- a general Node.js runtime;
- a Python/Jupyter environment;
- a credential container;
- a package manager;
- an authority bypass;
- a second session/execution database;
- a generic rollback engine for arbitrary external side effects.

Snapshot/workspace mutation semantics do not imply that arbitrary MCP/API side
effects can be reversed. Any future reversible-capability contract must be
explicit per semantic owner.

## Normative implementation plans

The detailed design and implementation ledger remain:

- `docs/plans/code-tool-architecture.md`
- `docs/plans/code-tool-implementation-ledger.md`

Those documents contain the performance gates, saved-artifact layout, trust
model, dependency contracts, replay invariants, and release checklist behind the
adopted product contract described here.
