# OpenFork `code` Tool Architecture Plan

> Status: **proposed architecture; not yet implemented**.
>
> This plan replaces the provider-visible `execute` Code Mode tool with a richer,
> stable `code` tool while preserving the current confined JavaScript execution
> engine as the zero-startup hot path. It deliberately does **not** revive the
> superseded Python/Jupyter Custom Runtime design.
>
> The target is OpenFork's mature V1 production execution path. Current/V2 remains
> a semantic/reference donor, consistent with the repository lifecycle policy.

## 1. Decision

OpenFork should replace the current MCP-only provider tool:

```text
execute({ code })
```

with one stable programmable capability surface:

```text
code
  search   discover exact capability paths, saved code tools, and prior runs
  run      execute new JS/TS or replay a prior run
  save     promote a successful run into a revisioned reusable code tool
  call     invoke a saved code tool
```

`code` is not an agent mode, session state, shell, or notebook. It is a stable
provider-visible tool and a programmable broker over the capabilities the current
agent/session can already use.

The key product abstraction is:

> **Every successful code execution is a replayable artifact, and a replayable
> artifact can be promoted into a durable, revisioned tool without expanding the
> provider tool manifest.**

This gives OpenFork three execution levels without adding provider schema churn:

```text
direct tool call
  -> best for one simple known operation

code.run
  -> best for orchestration, branching, filtering, fan-out, aggregation, and
     keeping intermediate results out of model context

code.call(saved)
  -> best for a proven orchestration that should be reused
```

## 2. Why this is the right next architecture

Cloudflare's Code Mode work validates the central shape: present capabilities as a
typed JavaScript API, let generated code compose them, keep credentials outside the
generated program, and keep the model-facing surface small. Their server-side Code
Mode exposes an entire large API behind search + execute while keeping the provider
footprint roughly constant.

OpenFork already has most of the difficult primitives:

- `packages/codemode/**`: confined Effect-native JS/TS execution without `eval`;
- `packages/opencode/src/tool/code-mode.ts`: current MCP Code Mode adapter;
- `packages/opencode/src/tool/access.ts`: stable lazy `tool` broker and descriptor
  contract pattern;
- `packages/opencode/src/tool/registry.ts`: authoritative V1 tool registry,
  lazy exposure, snapshot guards, custom-tool refresh;
- `packages/opencode/src/session/tools.ts`: the mature provider/tool execution seam
  containing permission, plugin hook, cancellation, attachment, and progress
  semantics;
- filesystem-backed custom tool loading and hot-reload infrastructure;
- durable Core persistence and local SQLite for run metadata/indexes;
- existing output truncation, background supervision, tracing, and cancellation
  primitives.

The work should therefore be a **convergence/refactor around existing owners**, not
a second parallel tool runtime.

### 2.1 External evidence and what OpenFork is actually borrowing

The external evidence should be kept precise rather than turning "Cloudflare Code
Mode" into a vague design slogan.

- Cloudflare's September 2025 Code Mode write-up demonstrated the core model:
  represent MCP tools as a TypeScript API, let the model compose calls in code, and
  execute that code in an isolated environment whose external authority is supplied
  through RPC-backed tool bindings.
- Cloudflare's February 2026 server-side Code Mode work collapsed the Cloudflare API
  into two provider-visible operations, `search` and `execute`, reporting roughly
  1,000 tokens of tool surface and a 99.9% input-token reduction versus exposing the
  full API operation inventory directly.
- Cloudflare's enterprise MCP portal follow-up reported a smaller real catalog
  example where 52 directly exposed tools cost about 9,400 tokens while the
  Code-Mode portal surface cost roughly 600 tokens.
- Cloudflare's current durable Code Mode runtime stores execution history, pending
  approvals, and reusable snippets. Approval resumes through replay: already-applied
  calls return recorded results while the newly approved action executes and the
  same source continues.
- Dynamic Workers are Cloudflare's sandbox implementation. Their startup/isolation
  benchmarks are evidence for the value of cheap disposable sandboxes, **not**
  performance claims OpenFork may reuse for `@opencode-ai/codemode`.
- OpenAI's current Programmatic Tool Calling independently converges on the same
  boundary: fresh isolated JavaScript/V8 execution, no ambient Node/packages/filesystem/
  subprocess/network authority, and external effects only through explicitly eligible
  tools. Its guidance also distinguishes deterministic/data-shaped orchestration from
  workflows where every intermediate result needs fresh model judgment.

Sources:

- https://blog.cloudflare.com/code-mode/
- https://blog.cloudflare.com/code-mode-mcp/
- https://blog.cloudflare.com/enterprise-mcp/
- https://blog.cloudflare.com/dynamic-workers/
- https://developers.cloudflare.com/agents/tools/codemode/
- https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/
- https://developers.cloudflare.com/agents/tools/codemode/api-reference/
- https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling

OpenFork borrows the **typed programmable capability surface, progressive discovery,
small provider manifest, durable execution/reuse concepts, and host-owned authority
boundary**. OpenFork-specific ideas in this plan — durable `CodeRun` artifacts tied
to OpenFork sessions, revisioned filesystem-backed saved tools, native OpenFork
capability access, dependency execution contracts, and revision-bound saved-tool
trust — are local product architecture, not claims about Cloudflare's implementation.

## 3. Non-negotiable invariants

### INV-1: provider definition is byte-stable

The provider-visible `code` description and JSON schema MUST be byte-identical
regardless of:

- connected MCP servers;
- native tool inventory;
- lazy tools;
- project/global saved code tools;
- saved tool revisions;
- run history;
- permission changes that do not remove `code` itself.

No generated catalog may be appended to the tool description. This fixes the current
`execute` dynamic-description cache bug instead of carrying it forward.

### INV-2: nested execution never bypasses host authority

Every nested capability invocation must preserve the same relevant semantics as a
normal OpenFork tool call:

- session + agent permissions;
- leaf `ctx.ask(...)` checks;
- plugin `tool.execute.before` / `tool.execute.after`;
- cancellation and per-call interruption;
- worktree mutation / Snapshot ordering;
- tracing and child-call identity;
- attachment projection;
- output safety boundaries;
- session metadata/progress behavior where appropriate.

Code execution is orchestration, not privilege elevation.

Snapshot mutation ordering is **leaf-scoped**. No delegator (`code`, saved frame,
`tool`, task/session wrapper, etc.) may hold the Snapshot mutation/read lock across a
nested capability subtree. The gateway applies ordering at the actual leaf and reports
mutating descendants separately to the root processor's mutation-observation sink so
post-step diff/snapshot/SPAD behavior is preserved.

### INV-3: credentials never enter generated code

Generated source receives only the host-mediated `call(ref, input)` bridge and
JSON-safe bindings, never bearer tokens, cookies, API keys, MCP credentials, or raw
OpenFork service objects.

### INV-4: confinement and program authority are distinct

The default confined **executor** has no ambient:

- filesystem;
- process;
- environment;
- generic network;
- credentials;
- module loader;
- npm/package installation.

All external effects flow through the host-mediated `call(ref, input)` capability
bridge.

That does **not** mean a code program is powerless. The root capability snapshot is
the program's authority surface: if refs for shell, write, or a durable delegator are
present, the program can request exactly the same leaf authority that capability has
when called directly. The security boundary is:

```text
no ambient host authority
        +
explicit capability graph
        +
leaf authorization on every effect
```

Confinement must never be used as a reason to skip capability review or permission
checks.

### INV-5: saved tool trust is revision-bound

A saved tool's executable identity is its content-addressed revision, not merely its
human name. Editing source mints a new revision and cannot silently inherit approval
for old code.

### INV-6: saved library does not become provider tools

Saving 0, 10, or 10,000 tools must not change provider-visible tool definitions.
Saved tools are discovered/called through `code`.

### INV-7: filesystem is authoritative for saved source

Project/global saved tool source and manifests are reviewable files. SQLite may hold
rebuild-derived catalog/search projections, but deleting those projections must not
delete or redefine the library. P0 does not invent a separate authoritative saved-tool
usage store.

### INV-8: runs are durable facts, not warm-runtime state

A replayable run is defined by durable source + input + execution metadata. No
successful replay may depend on an old in-memory lexical environment.

### INV-9: JavaScript/TypeScript only

There is no Python evaluator/kernel/runtime profile in Code Mode. This does **not**
forbid a normal host capability from internally using Python, a subprocess, a browser,
or a remote service: if that capability is explicitly programmatic-call eligible, the
sandbox may request it through `call(...)` and the host executes it under the same
gateway/permission/resource policy as a direct call.

### INV-10: one outer model-output boundary

Nested results should stay inside the code execution whenever possible. Only the
outer `code` result is projected into model context. Leaf safety/size limits still
apply, but the architecture should avoid needlessly truncating structured
intermediate data before the program can filter it.

### INV-11: recursion is capability composition, not evaluator recursion

Code may recursively compose **capabilities** through the host gateway, and a saved
Code tool is itself a capability. Saved tools may therefore call native/MCP
capabilities and other saved tools, including fairly deep graphs.

The confined runtime does **not** expose provider actions as recursive meta-tools:

- no nested `code.run` / arbitrary-source evaluator spawning;
- no runtime `code.save` durable mutation by default;
- no runtime discovery/search in P0;
- no direct self-call or indirect saved-tool cycle;
- ordinary JavaScript function recursion remains normal language behavior.

The P0 runtime composition primitive is only host-mediated `call(...)`; do not ship a
second `tools.*` invocation facade in P0. Every descendant inherits the root deadline,
cancellation signal, permission context, capability snapshot, concurrency pool, and
shared resource budget; child calls can consume remaining authority/budget but can
never reset or widen it.

## 4. Provider-facing `code` contract

The action surface should remain intentionally small:

```ts
type CodeInput =
  | {
      action: "search"
      query?: string
      ref?: string
      target?: "callable" | "capabilities" | "saved" | "runs"
      limit?: number
      cursor?: string
    }
  | {
      action: "run"
      code?: string
      runID?: string
      input?: unknown
      // zero-ceremony promotion when the agent already knows this deserves reuse
      save?: SaveSpec
    }
  | {
      action: "save"
      runID: string
      save: SaveSpec
    }
  | {
      action: "call"
      tool: string
      input?: unknown
    }

type SaveSpec = {
  name: string
  description?: string
  scope?: "project" | "global"
  inputSchema?: JsonSchema
  outputSchema?: JsonSchema
  tags?: string[]
}
```

Rules:

- `run` accepts exactly one source selector: inline `code` or prior `runID`;
- for `action:"run"`, `runID` means fresh replay of that prior CodeRun's source;
- dirty saved working copies are ordinary files, not a third provider source selector:
  inspect them through normal `read` authority and pass the returned source as `code`;
- `save` only accepts a successful run;
- `run.save` is a convenience path, not a second persistence mechanism;
- `scope` defaults to project;
- global save is always explicit;
- `call.tool` accepts a canonical saved ID (`find_todos`), an explicitly scoped
  alias (`project/find_todos` / `global/find_todos`), or an immutable saved-revision
  handle. Alias calls resolve atomically to one revision at call admission and pin
  that revision for the whole run; the result echoes the resolved immutable handle;
- `search` is the single discovery primitive for capabilities, saved tools, and
  run history;
- `search.target` defaults to `callable` (native/lazy/MCP + saved tools) so old run
  history never pollutes ordinary capability discovery; run lookup is explicit.
- `search.ref` is exact inspection: it accepts the host-issued ref returned by search
  (including `native:*`, `mcp:*`, `saved:*`, and `run:*`) and returns the complete
  descriptor/signature/metadata for that one object. It replaces a separate
  provider-facing `describe` action.
- broad `search.query` returns compact ranked candidates; an exact canonical ref hit
  deterministically returns the same full descriptor as `search.ref`.

`input` defaulting is action/source-specific and deterministic:

- inline `run` with omitted `input` receives `{}`;
- `call` with omitted `input` receives `{}` and therefore still fails a required
  saved-tool input schema normally;
- replay `run` (`runID`) with omitted `input` reuses the original run's JSON-safe
  invocation input. Pass `{}` explicitly to replay with an empty object.

The top-level schema is static. Dynamic names never appear as schema enums.

The actual provider JSON Schema should be a flat object with an `action` enum and
optional action-specific fields rather than a deeply nested `oneOf` tree. Several
providers transform function schemas differently; OpenFork already has compatibility
normalization at this boundary. Runtime decoding should enforce the action-specific
XOR/required-field rules and return precise repair instructions.

Flat does not mean undocumented. Every static field must carry a concise provider
description that says which action uses it and whether it is required there. Reject
unknown fields and contradictory action fields with an error that names the accepted
shape. This preserves provider compatibility without forcing agents to discover the
schema through validation failures.

For `save`, only the canonical saved-tool `name` is required on the happy path.
Here `name` is deliberately the executable/library ID, e.g. `find_todos`, and must
already satisfy the saved-ID grammar. Do not silently slug arbitrary prose because
normalization creates collision/identity ambiguity. Description/schemas/tags are
optional overrides. The host should reuse a declared input/output schema from the run
when present; otherwise omit the schema rather than inventing a false one. A missing
description gets a stable neutral fallback rather than forcing another agent-authored
field solely for ceremony. Human-friendly title casing is presentation derived from
the ID in P0, not a second durable identity field.

### Static provider description

The description itself should be short, operational, and stable. A good target:

```text
Write and run JavaScript/TypeScript that composes OpenFork capabilities through a
host-controlled `call(ref, input)` bridge, search capability/saved-tool/run history,
replay prior source, and save successful programs as reusable versioned tools. Use
direct tools for simple one-step work; use code for predictable composition,
branching, loops, filtering, fan-out, or reusable logic. Discover capability refs with
provider-level `code.search` before authoring when needed. The default runtime is
confined: filesystem/process/network/import authority is available only through
`call(...)`. Capability calls still enforce their normal permissions.
```

Do **not** append:

- current MCP names;
- saved-tool names;
- dynamic TypeScript signatures;
- permission summaries;
- recent run names;
- examples containing real current capabilities.

All dynamic catalog information belongs behind provider-level `code.search`. P0 does
not expose catalog search/describe from inside an executing program.

### Agent decision heuristic

The model-facing instructions should make the selection rule extremely obvious:

```text
1 operation you already know -> call the direct tool
multiple predictable dependent operations / filtering / loops / fan-out -> code.run
intermediate result needs fresh semantic/model judgment -> stay in the direct agent loop
unknown capability -> code.search, then code.run with returned refs
known saved abstraction -> code.call
successful orchestration worth reusing -> code.save
```

This avoids the failure mode where the model reaches for `code` merely because it
exists, or conversely keeps burning model round-trips on a workflow better expressed
as a program.

### Why replay is part of `run`, not another action

Replay is execution of an existing source artifact with a new or reused input, not a
separate lifecycle. Keeping it under `run` reduces action count and makes this
natural:

```js
code({
  action: "run",
  runID: "run:prt_...",
  input: { path: "packages/core" }
})
```

Replay means "execute the same recorded source/revision again." It does **not**
promise identical external results, because filesystem/database/network/tool state
may have changed.

Call this **fresh replay** in implementation/docs. It is intentionally distinct from
**resume replay**, where an interrupted/approval-paused execution replays already
completed steps from a durable call log in order to continue the same logical run.
Cloudflare's durable runtime uses the latter for approvals. OpenFork P0 does not need
it because the mature V1 `ctx.ask()` path can suspend the actual leaf call and resume
it in-process. If OpenFork later needs process-crash-safe or transport-epoch-safe
continuation, add resume replay as an explicit execution-state feature; never silently
change `runID` fresh replay to mean "resume prior side effects."

## 5. Program environment

The default program should feel like ordinary JS/TS:

```ts
const matches = await call("native:find", {
  grep: "ToolInvocationGateway",
  path: "packages/opencode/src",
})

const source = await call("native:read", {
  filePath: "packages/opencode/src/session/tools.ts",
  offset: 1,
  limit: 120,
})

return { matches, source }
```

Trusted globals:

```text
call        host-controlled capability invocation bridge
input       JSON-safe invocation input
console     bounded captured logging
JSON
Promise
standard safe JS builtins supported by @opencode-ai/codemode
```

No secrets or raw host handles are injected.

### Host-supplied data bindings

The current generic `@opencode-ai/codemode` runtime seeds `tools` and safe builtins,
but it does not currently seed an `input` value. Add a **host-neutral immutable data
binding** mechanism rather than teaching the generic package about OpenFork runs or
sessions.

Conceptual additive API:

```ts
CodeMode.execute({
  code,
  tools,
  bindings: { input },
})

const runtime = CodeMode.make({ tools })
runtime.execute(code, {
  bindings: { input },
})
```

Rules:

- bindings cross the existing JSON/plain-data copy boundary;
- bindings are immutable from the program's perspective;
- reserved runtime names such as `tools`, `Promise`, `console`, and builtins cannot
  be shadow-injected by the host;
- the generic package remains unaware of session IDs, permissions, filesystems, and
  persistence;
- run-specific input is supplied per execution so a cached runtime/compiled program
  can be reused with different inputs.

This is preferable to synthesizing `const input = ...` into generated source because
it preserves source identity, avoids serialization/injection edge cases, and lets
replay keep the exact original source hash.

### Runtime composition boundary

The confined runtime exposes **one** host-effect primitive:

```ts
const value = await call(capabilityRef, input)
```

The provider-facing four-operation API and the runtime API are intentionally
asymmetric:

```text
provider surface                 runtime surface

code.search(...)                 call(ref, input)
code.run(...)
code.save(...)
code.call(...)
```

Inside a running program there is no recursive `code.run`, no `code.save`, and no
P0 catalog `search` / `describe`. Ordinary JavaScript functions provide local
abstraction; reusable OpenFork behavior is composed through `call(...)`.

Capability refs are collision-free host-issued identities returned by `code.search`.
Examples of presentation forms:

```text
native:read
native:find
mcp:<server>/<tool>
saved:project/<id>@sha256:<revision>
saved:global/<id>@sha256:<revision>
```

The internal canonical identity is structured segments, not a lossy dot-joined string;
the rendered ref is a serialization of that identity. Models should use refs returned
by search rather than inventing escaping/sanitization rules.

`call(...)` always crosses back into `CapabilityInvocationGateway`, which owns
authorization, hooks, cancellation, Snapshot mutation ordering, accounting, tracing,
attachments, and dispatch. The sandbox never executes host capabilities directly and
never receives their credentials.

Provider meta-tools `code`, `tool`, and `invalid` are not callable capability
refs. This makes recursive evaluator spawning structurally unavailable:

```text
code.run -> call("code", ...)
           ^ rejected / absent from capability snapshot
```

Saved code **is** a capability. Therefore the useful recursion is capability
composition:

```text
root code.run
  -> call(saved A)
      -> call(saved B)
          -> call(native/MCP)
```

P0 deliberately omits in-runtime discovery. Scratch programs may call any explicit
ref present in their captured root capability snapshot. A program promoted to a saved
tool must have statically resolvable literal `call("ref", ...)` targets; save rejects
computed/dynamic capability refs in P0. This makes dependency preflight, revision
pinning, and drift diagnostics complete instead of pretending dynamic discovery is
deterministic.

A future runtime-discovery feature can be added explicitly if real workflows require
it. If added, it must mark the saved artifact dynamic, weaken preflight guarantees,
and remain separate from `run` / `save` so it does not reintroduce recursive
evaluator lifecycle semantics.

## 6. The central refactor: CapabilityInvocationGateway

The current execution semantics are split across:

- `SessionTools.resolve` for native tools;
- `tool/access.ts` for lazy broker delegation;
- `tool/code-mode.ts` for nested MCP;
- the direct-MCP fallback in `session/tools.ts`.

That split becomes increasingly dangerous once `code` can call native + lazy + MCP
+ saved capabilities.

Introduce one host-owned gateway beneath all programmable invocation:

```ts
interface CapabilityInvocationGateway {
  snapshot(ctx: InvocationContext): Effect<CapabilitySnapshot>

  search(input: {
    snapshot: CapabilitySnapshot
    query?: string
    target?: CapabilityKind
    limit?: number
    cursor?: string
  }): Effect<CapabilitySearchResult>

  describe(input: {
    snapshot: CapabilitySnapshot
    ref: string
  }): Effect<CapabilityDescriptor>

  invoke(input: {
    snapshot: CapabilitySnapshot
    ref: string
    args: unknown
    parentFrameID?: string
    depth: number
    stack: readonly RevisionID[]
  }, ctx: InvocationContext): Effect<CapabilityResult>
}
```

A snapshot freezes the effective callable graph for the outer run so an in-flight
program cannot observe half of a tool hot reload.

### CapabilityDescriptor

```ts
type CapabilityDescriptor = {
  identity: CapabilityIdentity
  kind: "native" | "lazy" | "mcp" | "mcp-resource" | "saved"
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  revision?: string
  permissionKey?: string
  descriptorFingerprint: string
  executionContract: string
  authorityBinding: string
  codeCallable: boolean
  lifetime: "inline" | "durable"
  classifyWorkspaceMutation(args: unknown): boolean
}
```

`descriptorFingerprint` fingerprints the complete model-facing descriptor and is
useful for discovery/cache invalidation. It is internal metadata; the agent does not
echo it on calls. `executionContract` fingerprints callable semantics: canonical
structured identity/kind, input/output schemas, semantic contract version, saved revision when
applicable, and the current non-secret `authorityBinding`. Prose/help-text edits may
change the descriptor fingerprint without changing the executable semantics.

`authorityBinding` prevents a schema-identical capability from silently changing what
authority it points at. For MCP, derive it from non-secret server/transport/endpoint
identity plus credential-scope/account identity (never credential material). For saved
tools it includes the immutable saved handle. Native capabilities use a stable
implementation/host authority identity appropriate to that tool. A changed authority
binding is a hard dependency-preflight failure, distinct from cosmetic descriptor drift.

Catalog visibility is discovery policy, not authorization. The catalog snapshot is
frozen for one root run, but authorization is **not** frozen: `invoke` first runs the
registration's live `authorize(...)` admission behavior against the current
session/agent policy, then executes the semantic leaf and its ordinary `ctx.ask(...)`
checks.

### Internal result projection vs model delivery

The current V1 tool abstraction mixes semantic execution with model delivery in a few
places. In particular, `Tool.define(...)` applies final `Truncate.output(...)` inside
the registered execute wrapper, and plugin/custom-tool adapters may also project text
before returning. Calling those wrappers unchanged from `code` can therefore truncate
an intermediate result **before** the program has a chance to filter or aggregate it.
That would violate the intent of INV-10.

Do not solve this by removing bounds. Split the concerns:

```text
leaf producer/domain limits
  -> semantic CapabilityResult
       value/data
       text fallback
       attachments
       metadata
  -> delivery projection
       internal code boundary: bounded but not model-truncated
       provider boundary: normal model-facing truncation/projection
```

Recommended migration:

1. Make the **semantic executor** the primary V1 contract, following the canonical Core
   tool shape already present in `packages/core/src/tool/tool.ts`: decode input once,
   execute with a typed expected-failure channel, keep structured data separate from
   model projection, and derive provider delivery from that executor.
2. Remove leaf-local `Effect.orDie` from built-ins that currently collapse expected
   failures before the shared wrapper can observe them (for example `read`, `grep`,
   `access`, and other matching leaves). A semantic executor that still receives an
   already-died leaf is not a semantic boundary.
3. Provider delivery may preserve existing user-visible behavior by mapping typed
   expected failures at the provider boundary. Internal `call(...)` invocation maps
   expected failures to CodeMode `ToolError` / `CapabilityFailed` so program
   `try/catch` works. Genuine defects remain defects; cancellation remains
   interruption.
4. Replace generic `Cause.squash` behavior at the CodeMode host boundary with cause
   partitioning:
   - any interrupt -> propagate interruption;
   - typed expected ToolError/ToolFailure -> catchable program failure;
   - defect with no typed expected failure -> re-die, never convert to a catchable
     sandbox Error.
5. Change host abort racing to interrupt/cancel semantics rather than
   `Effect.die(new AbortError(...))`, so abort is distinguishable from a host defect.
6. Add optional structured `data` to V1 `Tool.ExecuteResult`; the code gateway
   prefers `data` and falls back to `output`. Convert the first high-value
   composition tools (find/grep/glob/read/project/symbols) early enough that the
   provider-facing examples are executable rather than aspirational.
7. Introduce an explicit internal/provider delivery intent at the shared invocation
   seam instead of inferring it from the caller. Delegators such as `find`, `web`,
   `browser`, and the lazy `tool` broker must invoke the target semantic executor,
   not its provider-delivery wrapper.
8. Keep producer-specific bounds (grep hit caps, SQLite paging, archive limits, MCP
   transport limits, etc.) in force for both modes.
9. Give internal code results their own per-call and per-root byte budgets so a huge
   child result cannot exhaust memory merely because model truncation is deferred.
10. Apply the ordinary model-facing `Truncate.output(...)` exactly once to the outer
    `code` result. Internal bounded projection must not create one truncation
    retention artifact per nested call.

MCP already has a better structured boundary through `structuredContent`; preserve it
through the gateway rather than stringifying and reparsing it. Attachments remain
host-side and are collected onto the outer result.

### Gateway implementation strategy

Phase the extraction to avoid a flag day:

1. extract shared invocation helpers from `session/tools.ts`;
2. move current nested MCP Code Mode invocation to the gateway with behavior parity;
3. route `tool` lazy calls through the same gateway;
4. expose native registry tools to `code`;
5. keep direct provider invocation on the mature V1 delivery path in P0/P1 while it
   consumes the same registration/authorization owner. Do **not** force direct calls
   through the Code gateway merely for architectural symmetry: direct-provider denial
   and provider-delivery failure semantics intentionally differ from catchable
   in-program capability failures.

The goal is one semantic registration/authority owner, not one universal outer
transport. The migration must not destabilize the mature V1 provider loop.

There is already concrete semantic drift proving this extraction is needed:
`session/tools.ts` wraps direct MCP execution in `snapshot.withMutation(...)`,
while the current nested MCP path in `tool/code-mode.ts` invokes the MCP client
directly and does not apply that same Snapshot mutation ordering. The gateway should
make this class of divergence structurally difficult: one capability descriptor owns
its mutation classification and one invocation path applies it.

### Registry ownership: do not rebuild the graph ad hoc in `code`

The gateway should consume an authoritative model/session-effective capability
projection from the registry layer rather than independently stitching together
`registry.tools()`, `registry.all()`, MCP state, and saved-tool state on every
execution. Neither existing registry method is sufficient by itself:

- `registry.tools()` applies model/provider selection and provider-definition
  shaping but intentionally hides lazy tools and returns provider-delivery wrappers;
- `registry.all()` includes lazy registrations but skips the model/provider
  projection and provider-definition plugin shaping.

Add one shared projection, conceptually `registry.capabilities(...)`, and derive
both provider-visible tools and Code capabilities from that common source.

Conceptually extend the registry/capability owner with:

```ts
interface CapabilityInventory {
  generation: string
  entries: readonly CapabilityRegistration[]
}

interface CapabilityIdentity {
  // authoritative identity: never reconstruct from a sanitized/dot-joined string
  segments: readonly string[]
  key: string               // internal collision-free map key
  ref: string               // reversible host-issued selector returned by search
  renderedPath?: string     // optional human/JS presentation only
}

interface CapabilityRegistration {
  identity: CapabilityIdentity
  kind: CapabilityKind
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  permissionKey?: string
  delegatesTo?: readonly string[]
  invokeSemantic: CapabilityExecutor
  authorize(input: { authority: InvocationAuthority; args: unknown }): Effect.Effect<void>
  authorityBinding: string
  classifyWorkspaceMutation(args: unknown): boolean
  codeCallable: boolean     // required; omission is not an implicit allow
  lifetime: "inline" | "durable"
  revision?: string
}
```

`CapabilityInvocationGateway.snapshot()` captures this immutable **catalog**
inventory plus the model/provider/client/flag selectors used to construct it.
Search, signature rendering, and execution all consume that same registration
snapshot. This prevents "search found one version, invoke ran another version" races
and avoids repeated schema conversion.

The full original `Tool.Context` remains the execution context: messages,
`extra.model`, `promptOps`, `authorizedAgentNames`, `workerRootMessageID`,
abort signal, session/message IDs, and permission plumbing are preserved. Leaf
authorization is re-evaluated at invocation time instead of being treated as part of
the frozen catalog snapshot.

`authorize(...)` is live behavior, not frozen permission state. `InvocationAuthority`
is the single owner of the current session+agent ruleset and root-run approval scope;
registration code does not re-merge permissions independently. For native/lazy
registrations it preserves the same explicit-deny semantics currently split across
`providerPolicy(...)` and `Permission.disabled(...)`. Composite/delegating capabilities
encode their delegated leaf identities in registration metadata rather than in separate
hard-coded tables. For MCP it owns the MCP capability permission check. For saved tools
it first requires a matching `SavedCodeAdmission`, then owns the revision-bound
`permission="code", pattern="call:<scope>:<id>@<revision>"` gate. Descriptor
fingerprints remain catalog/cache identity only and never grant or revoke execution
authority. The semantic executor may still perform finer-grained `ctx.ask(...)` checks;
admission and leaf authority are deliberately additive.

Do not copy the current lazy-broker hole where a target can be reached after only the
`tool` broker itself passed admission. Once the gateway exists, direct provider,
lazy-broker, and `code` invocation of the same target must share this authorization
owner.

The existing provider-facing `registry.tools()` remains a projection of the same
authoritative registrations during migration. Do not make `code` the new registry.

## 7. Capability graph construction

For a given outer `code` call, build an effective snapshot from:

### Native/default tools

Use the same model-aware V1 registry selection used for provider tools. Preserve
existing patch-vs-edit/model-specific decisions.

### Lazy tools

Include their underlying registered `Tool.Def` directly in the code capability
graph. Code should not call the `tool` broker to reach them.

### MCP tools

Preserve the original MCP server/tool identity. Do **not** make
`McpCatalog.sanitize(...)` the canonical key: sanitization can collapse distinct
names onto the same JavaScript identifier.

The canonical identity is stored as original segments rather than a lossy joined
string. `code.search` renders a collision-free capability ref from those segments:

```text
mcp:github/search_issues
mcp:corp.github/search_issues
mcp:a-b/issue.search
```

Search/descriptors return that exact paste-ready ref plus the canonical structured
identity. Models never guess, normalize, or sanitize MCP path segments.

The ref encoding itself is canonical and reversible. For externally named segments
(MCP server/tool/resource identifiers), UTF-8 percent-encode every byte outside the
RFC 3986 unreserved set (`A-Z a-z 0-9 - . _ ~`) and use uppercase hex escapes. `/`,
`:`, `%`, `?`, `#`, and non-ASCII bytes are therefore data, never separators. Decode
exactly once back into the authoritative segment array; never derive identity by
splitting a display path or re-running `McpCatalog.sanitize(...)`.

Keep the existing flattened/sanitized MCP registry key separately as `permissionKey`;
that remains the V1 permission identity used by current rules, `Permission.disabled`,
and MCP `ctx.ask`. The Code SDK path is discovery/call identity, not a silent
permission-key migration.

Because the legacy sanitized permission key is lossy, inventory build must detect
collisions. If two distinct original MCP identities map to the same legacy
`permissionKey`, P0 fails those entries closed for Code invocation and surfaces an
`AmbiguousPermissionIdentity` diagnostic; it must never let one colliding tool inherit
the other tool's permission decision. A future permission-key migration can remove
that limitation explicitly.

### MCP resource helpers

Extract the existing list/read/template resource helpers from their inline
`SessionTools` fallback into ordinary capability registrations owned by the same
inventory/gateway. They retain explicit server/resource-scoped permission identity via
`permissionKey`; do not overload their Code SDK path with the generic native `read`
identity. Any permission-name migration from today's legacy helper behavior is covered
by compatibility tests rather than occurring implicitly during extraction.

### Saved tools

Unqualified saved IDs resolve only when they are unambiguous across the effective
project/global catalogs. Never silently let a repository-defined saved tool replace a
global tool with the same ID.

```text
saved:project/find_todos@sha256:...
saved:global/find_todos@sha256:...
```

Provider-level `code.call` may accept a canonical ID when unambiguous, but runtime
composition uses the resolved capability ref returned by `code.search` or pinned by a
saved revision:

```ts
await call("saved:project/find_todos@sha256:...", input)
await call("saved:global/find_todos@sha256:...", input)
```

If both scopes define the same canonical ID, unqualified provider lookup fails with
`SavedToolAmbiguous` and returns the two exact immutable handles. Runtime `call(...)`
does not silently resolve an ambiguous saved alias.

### Exclusions

Exclude:

- `code` itself;
- `tool` broker;
- `invalid`;
- any internal-only capability that is not valid for the active session/client;
- capabilities disabled by the effective discovery ruleset.

### Programmability is explicit metadata

Direct provider exposure and programmatic-call eligibility are separate axes.
`Tool.Def` / capability registration should be able to state whether a capability is
safe/meaningful for programmatic nesting without changing whether it is direct or lazy:

```ts
exposure?: "default" | "lazy"   // existing provider-manifest policy
codeCallable?: boolean          // new programmatic-caller policy
```

The raw tool definition may omit `codeCallable`, but the authoritative inventory
normalizer must produce an explicit `codeCallable: boolean` for every registration;
there is no `undefined` at the gateway boundary. Ordinary chat capabilities normalize
to `true` unless a central exclusion/reentrancy rule says otherwise. `false` is for
meta-recursive or structurally invalid entries, not a blanket escape hatch. This is
conceptually the same separation as an `allowed_callers` policy: how a capability is
discovered is not the same question as who may invoke it.

Initial hard exclusions:

- `code` (would recursively create another code root);
- `tool` (code sees its lazy leaves directly);
- `invalid`;
- any internal sentinel/debug capability not intended for agent use.

Interactive/long-lived capabilities such as `question`, `task`, `goal`,
`background`, or swarm tools should not be excluded merely because they can wait or
run for a long time. If the agent can legitimately call them directly, the gateway
should preserve that behavior inside code unless a concrete reentrancy bug is proven.

Their registration must declare `lifetime: "durable"` when work may outlive the
root run. A root CodeRun settling does not imply cancellation or rollback of a
durable session, background job, Goal, scheduled task, or peer action that a leaf
successfully created. `lifetime` is consumed by the gateway/trace layer: once such a
leaf successfully returns a durable handle, root cancellation no longer pretends to
own the spawned work. The delegated session/job starts with its ordinary independent
permission/concurrency policy; Code-run approvals are not inherited as standing grants.

Durable capabilities remain code-callable when they are directly callable by the same
agent. Do not create a second, stricter hidden capability universe merely because Code
is the caller.

## 8. Runtime architecture

Do not make every run pay process startup.

### Profile A: `confined` — default and hot path

Use the existing `@opencode-ai/codemode` interpreter:

- JS/TS syntax;
- no `eval`;
- no generic network/process/filesystem;
- supervised tool fibers;
- bounded concurrency;
- deterministic parser/interpreter behavior;
- cheap one-shot startup;
- ideal for orchestration and most reusable agent-authored tools.

This should remain the default for `code.run` and saved tools created from those
runs.

### Profile B: `module` — future richer JS/TS tools

Only add when real saved-tool use proves a need for multi-file modules or third-party
libraries.

Contract:

```text
language: JavaScript/TypeScript
preferred engine: Bun when the deployed OpenFork runtime supports it
fallback engine: Node when required by distribution/runtime constraints
transport: framed JSON-RPC over stdio
host authority: reverse capability RPC only
credentials: never sent to child
```

The product contract is JS/TS, not "Bun semantics" or "Node semantics". Engine
selection is an implementation detail.

A native module runtime must not automatically inherit the user's full environment,
network, cwd authority, or secrets. If it cannot be confined to the intended
capability boundary on a supported platform, fail closed or require a stronger
explicit permission profile rather than pretending the process is sandboxed.

### No warm REPL requirement

Persistent lexical state is not required. Reuse comes from durable saved tools and
replayable runs, not a Jupyter-like warm namespace.

This removes the hardest/least deterministic part of the superseded Custom Runtime.

### Executor / capability / durable-state separation

Adopt the useful separation now present in Cloudflare's durable Code Mode:

```text
executor
  runs JavaScript; owns no durable product state

capability gateway
  exposes/invokes authorized host operations; owns no code history

Code Service
  owns runs, replay lineage, saved tools, revision identity, and policy
```

The confined interpreter should remain reusable and host-neutral. It must not learn
about sessions, SQLite, saved-tool directories, permissions, or provenance. The
gateway must not become a persistence service. The Code Service composes both.

This separation also keeps a future Bun/Node executor replaceable without rewriting
saved-tool/run semantics.

### Host execution budgets

`@opencode-ai/codemode` intentionally leaves limits to the host. The new `code`
surface must therefore own explicit production defaults rather than inheriting
"unlimited" accidentally.

Start with conservative host policy and benchmark/tune it:

```text
source bytes             bounded (target order: 64-128 KiB)
input JSON bytes         bounded
captured log bytes       bounded
per-leaf data bytes      bounded before interpreter copy
aggregate data bytes     bounded per root
attachment count/bytes   bounded per root
returned JSON bytes      outer tool truncation + code-specific bound
leaf call count          bounded
saved-call depth         bounded
execution operations     bounded by interpreter fuel
string value bytes       bounded inside interpreter
collection entries       bounded for Array/Object/Map/Set growth
concurrency              current CodeMode cap (8) initially
permission prompts       bounded/deduplicated per root
wall-clock               bounded, but high enough for legitimate long host tools
```

Do not encode arbitrary **default values** in the generic `packages/codemode`
package. Keep defaults in OpenFork's Code Service so tests/telemetry can tune them
without changing the reusable interpreter contract.

The generic package still needs host-supplied intermediate-copy budgets at the actual
sandbox copy boundary. Per-leaf limits alone do **not** bound a run: 100 individually
valid results can still retain 100× the per-leaf bytes.

Create one root-scoped `CodeExecutionBudget` for external data admitted into the
interpreter:

```ts
type CodeExecutionBudget = {
  maxLeafBytes: number
  remainingAggregateBytes: number
}
```

`copyIn(...)` (or its successor) receives that budget, counts bytes incrementally while
crossing the host→sandbox plain-data boundary, aborts before fully cloning a result that
would exceed either limit, and monotonically decrements the aggregate budget for every
admitted leaf result. Exhaustion is `LimitExceeded`. The monotonic accounting is
intentionally conservative; it bounds total external data admitted even if the program
later drops references.

The generic package defines the mechanism; OpenFork owns numeric policy/defaults. This
is separate from `maxOutputBytes`, which bounds the final model-facing result, and from
attachment/log budgets. It is an **external-data admission** bound, not a claim that it
fully meters arbitrary JS heap amplification inside the interpreter.

Because the confined interpreter runs **in-process**, it also needs host-supplied
same-process safety limits rather than treating wall-clock/output caps as a memory
sandbox. Extend generic execution limits with mechanisms equivalent to:

```ts
maxOperations?: number
maxStringBytes?: number
maxCollectionEntries?: number
maxConcurrency?: number
```

- operation fuel is consumed at deterministic interpreter evaluation points (including
  loop iterations and user callback/function execution), so tight synchronous loops do
  not rely only on wall-clock interruption;
- string-expanding intrinsics such as `repeat` / padding / concatenation are checked
  against the string budget before materializing obviously oversized results where the
  output size is predictable;
- Array/Object/Map/Set creation and mutation cannot grow beyond the collection-entry
  budget, including direct large array-index assignment;
- violations normalize to `LimitExceeded` at the OpenFork Code boundary.

The generic package still owns **mechanism only**; OpenFork supplies/tunes the numeric
limits. These guards target catastrophic same-process amplification, not precise heap
accounting.

For long-lived leaf tools, wall-clock policy should measure the root execution and
remain cancellation-aware. If a background/task tool intentionally returns a durable
job/session handle, the code run can finish normally; it should not keep the executor
alive just because the delegated work continues elsewhere.

## 9. Evolve `@opencode-ai/codemode` toward resolver-backed capabilities

The current package accepts a materialized nested `tools` tree. That is fine for
dozens of MCP tools but becomes wasteful when `code` spans the complete OpenFork
capability graph.

Add a resolver-backed path conceptually equivalent to:

```ts
CodeMode.make({
  catalog,
  invoke: ({ path, input }) => gateway.invoke(...),
  inlineCatalog: false,
})
```

Benefits:

- no rebuilding thousands of `Tool.make` wrappers per run;
- capability search and invocation share one structured canonical identity/ref model;
- exact descriptors can be cached by catalog fingerprint;
- dynamic libraries do not alter provider instructions;
- unknown paths can return targeted suggestions;
- the interpreter remains host-neutral.

The existing `tools` object API can remain for package consumers. The resolver path
is an additive optimization/generalization, not a breaking rewrite.

### Prepared-program seam

The current interpreter unconditionally runs TypeScript `transpileModule(...)` and
then Acorn parsing for every execution. Add a host-neutral opaque preparation API so
parsing/transpilation is a pure source-stage separate from invocation state:

```ts
const prepared = CodeMode.prepare(source)
const result = runtime.executePrepared(prepared)
```

Conceptually, `PreparedProgram` owns:

- parsed/normalized program representation;
- source/runtime format version;
- source hash or host-supplied cache key;
- statically extractable literal `call("ref", ...)` capability references;
- whether any host-effect call target is computed/dynamic (non-promotable in P0).

It owns **no** session, permission, capability snapshot, call counters, logs, fibers,
or mutable execution state. That makes it safe to cache and reuse across replay and
saved-tool calls.

Keep `runtime.execute(source)` as the ergonomic API; internally it can prepare then
execute. OpenFork's Code Service may maintain the bounded LRU keyed by runtime version
+ source hash.

## 10. CodeRun: every execution is an artifact

The authoritative root run is the existing durable V1 `ToolPart` for the outer
`code` invocation. Do not create a parallel execution record containing the same
input/output/timing data.

Expose an opaque replay handle derived reversibly from the ToolPart primary key, for
example:

```text
run:prt_...
```

The exact prefix is product syntax; the invariant is that `runID -> PartID` is a
pure reversible mapping, so replay lookup is a primary-key read rather than a scan or
second mapping table.

### ToolPart identity enters `Tool.Context` once

The V1 processor already creates the durable ToolPart before host execution and keeps
`toolCallID -> partID` in its in-memory call map. Reuse that authoritative mapping:

1. add a read-only `toolPartID(toolCallID): PartID | undefined` projection to
   `SessionProcessor.Handle`;
2. add `partID?: PartID` to `Tool.Context`;
3. `SessionTools.resolve` populates `partID` from the processor when constructing the
   root context;
4. the capability gateway inherits that root `partID` for nested calls. `Tool.Context.callID`
   remains the **real root provider ToolPart call ID** so permission/question UI always
   anchors to an existing ToolPart. Nested identity is a separate monotonic `frameID`,
   never a synthetic replacement for `Tool.Context.callID`.

No database read or second ToolPart ID allocator is required on the execution hot path.
The provider-visible `code` tool requires a root `partID`; contexts created outside the
normal provider loop may leave it undefined for other tools.

Nested leaves cannot call `processor.updateToolCall` / `completeToolCall`; progress is
aggregated into bounded root-Code metadata. The gateway derives a **leaf execution
context** from the root context rather than pretending a synthetic ToolPart exists:

- `callID` and `partID` stay the real root identities used by permission/question UI;
- `frameID` is the unique child trace/accounting identity;
- `abort` is a child signal linked to root abort but independently cancellable;
- `metadata(...)` writes only to the in-memory Code trace/coalescer, never directly to
  `SessionProcessor.updateToolCall`;
- no child context exposes root ToolPart completion/settlement.

Each cancellable leaf owns exactly one gateway interrupt entry keyed by its `frameID`,
linked to root abort and released in finalization. Permission/question requests keep
the root `callID`, while trace, accounting, cancellation, and parent/child
relationships use `frameID`. Killing one leaf cannot cancel a sibling or prematurely
complete the root ToolPart.

For historical replay resolution, add a narrow owner-level read such as
`Session.getCodeToolPart(partID, physicalScope)`. Implement it as one parameterized
`part -> message -> session` join so the owner establishes the session's project,
workspace, and directory **before exposing part content**, then hydrates any
projection/chunk reference through the existing session/Core projection owner. The Code
Service must never read raw `PartTable.data` or a `$cdbRef` directly.

P0 replay is restricted to the same physical worktree scope (project + workspace +
directory identity), not merely the same project ID. A dangling/pruned projection maps
to `RunNotReplayable`; foreign-scope and missing handles both map to `RunNotFound`
without exposing whether the foreign part exists.

Code-specific state lives in the ToolPart's existing fields:

```text
state.input
  inline code | replay runID | saved alias/handle + invocation input

state.output / state.error
  outer CodeResult / failure

state.time / attachments
  existing V1 tool lifecycle data

state.metadata.code
  runtime profile/version
  sourceHash
  sourceRunID
  replayOf
  capabilityFingerprint
  bounded frame/leaf-call summary
  saved revision/handle when applicable
```

The original `code({ action:"run", code })` ToolPart already stores source in
`state.input`. In the current V1 lifecycle the provider input is persisted before the
tool executor runs, so do **not** claim the Code Service can reject it before ToolPart
admission. Enforce source/input byte limits at the first Code execution step; an
oversized call settles as `InvalidInput`, is explicitly non-replayable/non-savable, and
is never reinterpreted from truncated bytes. A future generic pre-admission limit may
move this earlier, but it is not required for P0 correctness.
Fresh replays store only `runID` plus their new/reused input and carry
`sourceRunID` in metadata, so identical source is not copied into every replay record.

`sourceRunID` is always canonicalized to the original source-bearing ToolPart, while
`replayOf` names the immediate parent. Replay-of-replay therefore preserves full
lineage without creating an O(depth) source-resolution chain.
Saved tools materialize source to the filesystem and therefore do not depend on the
origin ToolPart remaining forever.

### Canonical run-source resolver

`code.save(runID)` does not assume every successful root embeds source bytes. The Code
Service owns one source resolver:

```text
inline source-bearing run
  -> hydrated ToolPart state.input.code

fresh replay root
  -> canonical sourceRunID -> hydrated source-bearing ToolPart

saved-tool call root
  -> resolved immutable saved handle -> verified admitted staged revision bytes
```

The resolver returns canonical source bytes + sourceHash only if they still exactly
match the run metadata. If the source-bearing session was deleted, a projection is no
longer hydratable, a saved revision lost admission, or bytes/hash disagree, save fails
with `RunSourceUnavailable` and performs no filesystem/admission mutation.

This is intentionally different from replayability. A replay root remains a valid
historical successful ToolPart even if its original source is later deleted, but it can
no longer be replayed or promoted once the canonical source is unavailable.

`run.save` immediately after a successful execution naturally has a resolvable source.
A later standalone `save` must re-resolve it at admission time rather than trusting a
stored sourceHash alone.

### Replay semantics

`code({ action: "run", runID, input })`:

1. decodes `runID` to the authoritative ToolPart primary key;
2. resolves it through the project-scoped, projection-hydrating Session owner;
3. verifies the part is a replayable `code` run and resolves its canonical
   `sourceRunID` directly to the original source-bearing run;
4. loads the exact source from that hydrated ToolPart input;
5. creates a fresh capability snapshot;
6. executes against current external state;
7. settles a new ToolPart with `replayOf` + the same `sourceRunID`;
8. never mutates the historical ToolPart.

A replay that omits `input` reuses the original JSON-safe invocation input. This is
not the same default as an inline-source run; passing `input:{}` explicitly overrides
replay reuse with an empty object.

Replay/run-history access is **same physical project-scope rooted** in P0:

- resolve the origin ToolPart and owning session;
- derive the canonical physical project-scope key from each session/workspace location
  using the same scope resolver as project saved tools;
- require `originScopeKey === currentScopeKey`; never use logical `ProjectID` as a
  filesystem/trust boundary because it may identify multiple clones/worktrees;
- `code({ action:"search", target:"runs" })` searches the same physical scope only;
- an inaccessible foreign-scope run handle is surfaced as `RunNotFound`, avoiding an
  existence oracle and accidental cross-workspace input reuse;
- intentional cross-scope reuse is expressed by a saved global tool, whose source and
  permission lifecycle are explicit.

If the owning session/run has been deleted, likewise return `RunNotFound`; replay does
not create a hidden retention obligation.

### Retention follows session ownership

Scratch run retention is the existing ToolPart/session lifecycle. Do not invent a
second run-retention policy merely because Cloudflare's standalone runtime needs one.

- deleting a session removes its scratch runs through the existing session/message/part
  lifecycle; `part.session_id` is denormalized and must not become a new deletion owner;
- a deleted scratch run is no longer replayable;
- saving a successful run copies the executable source/manifest into the saved-tool
  filesystem, so the saved revision survives deletion of its origin session;
- immutable saved revisions are retained by saved aliases, nested saved-dependency
  references, and in-flight calls, not by origin-run retention.

This keeps conversation history and reusable program artifacts as separate lifetimes.

### Root run vs nested frames

The outer durable ToolPart is the root `CodeRun` projection for each provider-level
`code.run` or `code.call`. Nested saved-tool invocations are trace frames inside that
root by default:

```ts
type CodeFrame = {
  frameID: string
  parentFrameID?: string
  kind: "root" | "saved"
  revision?: string
  depth: number
  startedAt: number
  durationMs?: number
  status: "running" | "succeeded" | "failed" | "cancelled"
}
```

This keeps provenance/audit detail without writing any additional root or helper run
rows. The bounded frame tree is stored in outer ToolPart metadata at settlement; a
future UI can expand it.

A saved-tool frame is **not** a recursive provider-level `code.run` and does not create
a new root runtime/sandbox. The Code Service executes the saved `PreparedProgram` as a
child frame under the same root execution supervisor. It receives a fresh lexical
`input` binding but inherits the root capability snapshot, deadline, abort tree,
permission context, accounting counters, and resource budgets.

### Leaf call log

Maintain a bounded per-root call log:

```ts
type CodeLeafCall = {
  seq: number // monotonic dispatch ordinal, never settle order
  frameID: string
  ref: string
  startedAt: number
  durationMs?: number
  outcome: "success" | "failure" | "cancelled"
  permission?: "none" | "allowed" | "prompted" | "denied"
  inputDigest?: string
  resultDigest?: string
}
```

Do not persist full arbitrary arguments/results by default. Inputs may contain
secrets or large data. The durable audit record should store bounded/redacted
summaries and hashes unless a specific capability/result policy says the full value
is safe and needed.

This call log is also the natural foundation for a future resume-replay engine if
OpenFork ever needs process-surviving approvals.

### Typed CodeRunTrace wire contract

The call graph is a product/wire contract, not arbitrary UI metadata. Define one
bounded schema-owned structure (for example under `packages/schema/src/v1/session.ts`
or the nearest existing V1 session-schema owner) and place it under the outer ToolPart
metadata:

```ts
type CodeRunTrace = {
  version: 1
  rootFrameID: string
  frames: CodeFrame[]
  leaves: CodeLeafCall[]
  counters: {
    calls: number
    failed: number
    active: number
  }
  truncated?: {
    frames?: number
    leaves?: number
    logs?: number
  }
}
```

The exact persisted shape must stay bounded and browser-safe. Clients do not parse
`metadata: any` ad hoc, and nested arbitrary tool inputs/results are not embedded.

Live progress is a lossy **projection** of the authoritative in-memory trace: compact
counters + a bounded active/top-N summary. It must not clone/publish the full root
source on every leaf start/end. Final settlement writes the complete bounded
`CodeRunTrace` once; UI must not treat dropped throttle updates as durable truth.

## 11. Saved code tools

Saved IDs are intentionally strict. `SaveSpec.name` maps directly to manifest `id`;
there is no hidden slugging/alias layer in P0. Use one portable, JavaScript-addressable
canonical identifier:

```text
^[a-z][a-z0-9_]{0,63}$
```

Reject Windows reserved device names, the reserved scope words `project` / `global`,
and case-fold collisions. This keeps identity stable across Windows/macOS/Linux and
makes the saved ID safe to embed in host-issued refs such as
`saved:project/find_todos@sha256:...`. UI may derive a title-cased label from the ID;
a separate durable display name is unnecessary in P0.

Canonical project location:

```text
<physical-project-scope-root>/.openfork/code/<id>/
  tool.json                    mutable alias/current descriptor
  code.ts                      mutable reviewable working copy
  revisions/
    <revisionHex>.json         immutable executable-revision envelope
    source/
      <sourceHashHex>.ts       immutable canonical source bytes, deduplicated
  README.md                    optional
  test.ts                      optional/future
```

The **revision envelope**, not the source hash alone, is the executable object. It
contains the source hash, runtime/profile version, semantic schemas/options, static
dependency execution identities, and pinned saved handles. Two executable revisions
may therefore reuse identical source bytes while differing in schema/dependency/runtime
identity.

Canonical global location is the authoritative OpenFork global config root:

```text
~/.config/openfork/code/<id>/
```

Implementation should obtain the global root from the existing Global/config-path owner
so configured OpenFork root overrides continue to work. Do not choose an arbitrary
member of the multi-directory config search path.

The saved catalog has two ownership tiers:

```text
process-global GlobalSavedCodeCatalog
  -> global config/code root + generation/cache/watch

location/worktree ProjectSavedCodeOverlay
  -> physical-project .openfork/code root + generation/cache/watch

root EffectiveSavedCatalog
  -> immutable composition of both for one Code execution
```

Global saved discovery/call resolution must not require creating a Location or using a
project-scoped `InstanceStore` as bootstrap. Project overlay uses the ordinary physical
workspace owner. The Code Service composes both and performs same-ID ambiguity checks.

Project scope is keyed by the canonical **physical workspace/session root** returned by
the saved-code scope resolver (using the repository's existing realpath/directory-key
primitive), not by logical `ProjectID`. Two clones of one remote repository therefore
do not share admission authority accidentally. All saved paths are containment-checked
in physical/realpath space; unprovable identity fails closed.

### Manifest

```json
{
  "format": 1,
  "id": "find_todos",
  "description": "Find and summarize TODOs under a source tree.",
  "runtime": "confined",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string" }
    },
    "required": ["path"]
  },
  "tags": ["source", "todo"],
  "revision": "sha256:...",
  "sourceHash": "sha256:...",
  "dependencies": [
    {
      "ref": "native:find",
      "executionContract": "cap_..."
    }
  ],
  "origin": {
    "run": "run:prt_...",
    "session": "...",
    "message": "..."
  }
}
```

Volatile timestamps/provenance fields must not participate in executable revision
identity unless they change semantics.

### Executable revision vs descriptor fingerprint

Keep these identities separate:

```text
ExecutableRevision
  source + runtime + semantic schemas/options
  -> permission/trust identity

DescriptorFingerprint
  executable revision + model-facing description/schema metadata
  -> catalog/search cache invalidation
```

Changing a tag or description should not invalidate execution trust or duplicate
staged code, but should mint a new descriptor fingerprint if the model-facing descriptor
changed.

Changing source/runtime/input schema/output schema creates a new executable revision.

### Capability dependency manifest

A confined saved tool should carry the capability dependencies that are knowable at
save time.

For literal runtime calls such as:

```ts
await call("native:find", {...})
await call("mcp:github/list_issues", {...})
await call("saved:project/analyze_symbols@sha256:...", {...})
```

1. statically extract the literal capability ref from the prepared AST;
2. resolve it against the successful run's capability snapshot;
3. store an execution-contract fingerprint with the saved revision;
4. when the dependency is another saved tool, store/pin its immutable saved handle;
5. verify those dependencies before a later `code.call` begins.

P0 save rejects computed call targets such as `call(input.tool, ...)`, concatenated refs,
or runtime catalog lookup. Scratch runs may use a ref supplied in `input` if needed,
but such a run cannot be promoted unchanged to a saved tool until its dependencies are
made explicit.

The dependency fingerprint should cover execution-relevant identity — canonical
path, input/output schemas, saved dependency revision, any explicit semantic contract
version, and the non-secret `authorityBinding` — **not prose-only description
changes**.

This is distinct from a model-facing descriptor fingerprint. A help-text edit should
not break a saved tool; an input-schema or native/MCP semantic contract change should.

For saved-to-saved dependencies, pin the exact dependency handle into the caller
revision. If `A@rev1` was validated against `B@rev7`, executing `A@rev1` continues to
bind its saved-B call to `B@rev7` even after the human-facing `b` alias moves to
`B@rev8`. P0 retains committed immutable revisions, so the pinned `B@rev7` handle
remains valid without a reachability race. Re-saving `A` is how it deliberately adopts
the newer `B`.
This provides reproducibility without rewriting the original source.

The pinned saved dependency handles participate in `A`'s executable revision
payload. A saved dependency change therefore cannot alter `A@rev1` behind its back;
adopting the newer dependency means saving a new `A` revision.

Scope portability is checked at save time. A **global** saved revision may depend on
other global saved revisions and ordinary host capabilities, but it may not pin a
project-scoped saved handle: that physical dependency cannot be reproduced safely in
another project. Reject such promotion as `SaveRejected` and name the offending
project dependency. Project revisions may depend on global revisions normally.

The sorted static dependency execution identities also participate in the executable
revision payload:

```text
canonical dependency ref / structured identity
executionContract
authorityBinding
pinned saved handle when applicable
```

This matters even when source bytes did not change. Re-validating identical source
against a changed native/MCP semantic contract must mint a new executable revision
rather than accidentally inheriting trust from the old environment.

P0 saved tools do not perform runtime discovery. A saved artifact with a computed or
runtime-discovered capability target is rejected at save time rather than being
misrepresented as statically reproducible. If dynamic discovery is added later, it
must be an explicit runtime feature with an explicit manifest mode and weaker preflight
semantics.

### Revision identity

Canonicalization must be specified once and reused by run storage, replay, save, and
staging. For confined source:

- decode as UTF-8;
- strip a UTF-8 BOM if present;
- normalize CRLF/CR line endings to LF;
- do **not** Unicode-normalize identifiers/strings or trim whitespace;
- execute the exact canonical source whose bytes are hashed.

Canonical JSON used in input/schema/revision envelopes is key-sorted and
whitespace-free.

Hash a canonical execution payload:

```text
format version
runtime profile + CodeMode semantic/runtime API version
normalized source bytes
input schema
output schema if present
semantic runtime options
sorted static dependency execution identities
```

Do not hash:

- creation timestamp;
- usage counters;
- description/help-text formatting or tags that do not affect execution.

### Immutable staging

A callable saved revision should resolve to immutable staged content keyed by hash.
Mutable working source may continue to be edited without affecting an in-flight
call.

For confined tools, canonical source bytes are written once to
`revisions/source/<sourceHashHex>.ts`, while each executable revision gets its own
immutable `revisions/<revisionHex>.json` envelope pointing at that source hash. `code.ts`
is only the reviewable mutable working copy; it is never the authority for an immutable
handle. Exact handle resolution is therefore
`handle -> revision envelope -> sourceHash -> immutable source bytes`.

The saved directory has one alias visibility commit point. Do not claim multiple files
are atomically replaced together:

1. acquire the existing Core cross-process `Flock` primitive for a canonical lock key
   derived from physical scope + saved ID (a cheap in-process keyed mutex may sit in
   front only as an optimization). Use a bounded acquisition timeout and the ordinary
   Flock stale-owner/heartbeat behavior; do not invent a saved-code-specific lock file;
2. canonicalize/hash source and derive the complete executable revision envelope;
3. write/reuse `revisions/source/<sourceHashHex>.ts` using create-if-absent semantics;
4. write/reuse immutable `revisions/<revisionHex>.json` only after its referenced source
   exists; never rewrite an existing revision object;
5. write/update the reviewable working `code.ts`;
6. atomically replace `tool.json` last using a same-directory temp file, file sync, and
   bounded Windows-safe rename retry; this is the filesystem alias visibility commit;
7. persist the exact SavedCodeAdmission record; this is the **callability** commit
   point;
8. invalidate/refresh the saved catalog.

Concurrent saves are serialized. Both immutable revisions survive; if two distinct
saves target the same human alias, the alias pointer follows lock/commit order. P0 does
not expose a fake compare-and-swap conflict without an `expectedRevision` in the
provider contract.

A crash before step 6 leaves the prior alias callable. A crash after the manifest
commit but before SavedCodeAdmission leaves the new filesystem revision visible but
**unadmitted/non-callable**; retrying the same save safely completes admission. Process
crash safety is required on all supported platforms; power-loss durability follows the
platform/filesystem guarantees and must not be overstated.

P0 does **not** automatically GC any committed/admitted immutable revision. Automatic
cleanup is restricted to abandoned temporary staging artifacts that never became a
revision object/admission, is age-gated, and runs under the same saved-tool lock. Exact
handles and pinned saved dependencies therefore cannot be invalidated by background GC.

Integrity verification is **once per immutable handle per root run**, at saved-frame
admission, not on every repeated invocation. The first use of a handle in a root:

1. reads the staged bytes;
2. recomputes `sourceHash`;
3. recomputes the executable revision from the canonical envelope using the manifest's
   **recorded** static dependency identities (not newly sampled live identities);
4. checks `SavedCodeAdmission`;
5. compares those recorded dependency identities against the root run's already-captured
   capability snapshot;
6. prepares the program and caches a `VerifiedSavedProgram` by immutable handle for the
   remainder of that root.

Stored hash strings are hints, not authority. Any mismatch before admission makes the
handle non-callable. Once admitted, repeated/nested calls in the same root execute the
cached prepared source and pinned dependency snapshot without re-reading/re-hashing the
filesystem. A later root revalidates from disk and sees any edit/authority drift.

Saved-tool resolution must not traverse symlinks, junctions, or other reparse points.
`tool.json`, `code.ts`, and staged revision files must resolve to regular files inside
their owning saved-tool directory.

### Source persistence vs callable admission

Filesystem content is authoritative for the saved library's source/revision bytes, but
mere filesystem presence is **not** authority to execute as a saved tool. In particular,
project `.openfork/code/**` content may arrive through version control, archive restore,
or other repository-content paths that are not equivalent to a local `code.save`
decision. Durable host trust therefore lives separately from reviewable filesystem
content.

Persist a small host-owned `SavedCodeAdmission` fact for the exact tuple:

```text
scope kind + physical scope key
saved id
executable revision
source hash
origin run/provenance reference
optional descriptor fingerprint for audit/cache diagnostics only
```

`SavedCodeAdmission.Service` is the only writer. It has exactly two P0 authorities:

1. `code.save`, after a successful run and `permission="code", pattern="save:<scope>:<id>"` authorization;
2. an explicit **human operator admission** flow (UI/CLI) for an on-disk revision,
   useful for human-authored tools and trust-store recovery. The operator flow
   recomputes canonical source/revision/dependency identity, runs parse/static preflight,
   shows the exact scope/id/revision/source hash/dependencies to the human, and records
   `origin = operator`; it does not fabricate a successful agent run.

`code.call` itself never auto-admits. It requires both a valid on-disk immutable
revision and a matching admission before applying its saved-call permission gate.
Manual/external edits stay visible as dirty/unadmitted state until promoted through
`code.save` or explicitly admitted by the human operator flow.

The admission store contains no source bytes and does not replace filesystem source of
truth. Losing it does not delete the library; revisions simply require re-admission
before becoming callable again.

### Dependency summary

Because OpenFork owns the parser/AST for confined code, a saved revision can record
the exact capability paths statically referenced by source plus the paths actually
observed in its successful origin run:

```ts
type SavedDependencySummary = {
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

produce exact static dependencies. P0 promotion requires every host-effect call target
to be statically resolvable.

This metadata supports:

- preflight missing-capability diagnostics;
- saved-tool portability checks;
- UI dependency views;
- search ranking;
- more precise provenance.

It is **not** authorization. Every invocation still traverses the gateway.

### Dirty edits

If a human or agent edits `code.ts` directly:

- the filesystem working copy becomes dirty;
- the previously validated/staged revision remains callable;
- the new source is not silently trusted as the old revision;
- agents may inspect it through ordinary `read` authority, pass that exact source to
  `code({ action:"run", code, ... })`, and promote a successful run with
  `code({ action:"save", ... })` or the atomic `run.save` convenience;
- no extra `workingCopy` provider field is introduced;
- UI/search descriptors expose `workingCopy: { dirty, sourceHash }` so agents and
  humans can tell that ordinary `code.call` is still using the last admitted committed
  revision.

## 12. Save admission flow

The best happy path is deliberately short.

### Save an existing run

```text
run succeeds
  -> code({ action:"save", runID, save:{...} })
  -> validate manifest/schema
  -> ensure source hash exactly matches successful run
  -> materialize project/global files atomically
  -> stage immutable revision
  -> update derived catalog index
  -> return full descriptor + immutable revision handle
```

No second execution is required for a confined run whose exact source just succeeded,
unless runtime policy changed between run and save.

### Run and save in one call

```js
code({
  action: "run",
  code: "...",
  input: { path: "packages/opencode" },
  save: {
    name: "scan_tool_seams"
  }
})
```

Persistence occurs only after successful completion.

### Native/module profile

When a future native module tool is saved, a cold-start validation is still required
because module resolution/dependencies are part of correctness.

## 13. Saved tool invocation

Provider path:

```js
code({
  action: "call",
  tool: "find_todos",
  input: { path: "packages/core" }
})
```

The normal happy path uses the canonical saved ID. Explicit forms are available when
needed:

```text
find_todos
project/find_todos
global/find_todos
saved:project/find_todos@sha256:...   # exact reproducible revision
```

At call admission, aliases resolve against the captured saved catalog to one
executable revision. That immutable handle is pinned for the full run and returned in
the result. A project/global collision never guesses: it returns
`SavedToolAmbiguous` with the exact qualified alternatives.

Programmatic path inside a running program:

```ts
await call("saved:project/find_todos@sha256:...", { path: "packages/core" })
```

A direct provider-level `code.call` creates a root CodeRun.

A runtime `call(savedHandle, ...)` creates a nested saved CodeFrame inside the same
root supervisor. It does not invoke provider-level `code.call`, does not create another
ToolPart, and does not create another root runtime/sandbox.

### Saved-tool preflight

Before the **first** execution of a saved revision in a root (subsequent uses reuse
its cached `VerifiedSavedProgram`):

1. atomically resolve alias/handle to one immutable revision and pin it for the root run;
2. recompute/verify staged source hash + executable revision from filesystem bytes;
3. require an exact matching `SavedCodeAdmission`;
4. apply the executable-revision-bound saved-call permission gate;
5. validate input schema;
6. bind pinned saved dependencies to their recorded immutable handles;
7. resolve native/MCP/static capability paths against the captured snapshot;
8. fail before side effects if a dependency is missing, its execution contract drifted,
   or its `authorityBinding` changed;
9. execute as a child saved frame under the existing root supervisor.

P0 saved revisions have no dynamic capability refs: any computed runtime target makes
promotion fail before admission. Scratch runs may still compute a ref from ordinary
input, but such a run must be rewritten with explicit refs before it becomes a saved
artifact.

## 14. Immutable handles and stale-tool safety

The lazy `tool` broker needs a separate descriptor contract because its mutable tool
name is the invocation identity. Saved code tools already have a stronger primitive:
their **immutable executable revision**.

An exact saved-tool search returns:

```json
{
  "kind": "saved",
  "ref": "saved:project/find_todos@sha256:...",
  "id": "find_todos",
  "qualified": "project/find_todos",
  "revision": "sha256:...",
  "handle": "saved:project/find_todos@sha256:...",
  "description": "...",
  "inputSchema": { "...": "..." },
  "workingCopy": {
    "dirty": false,
    "sourceHash": "sha256:..."
  }
}
```

`code.call` accepts the canonical ID/qualified alias for low-ceremony use or the
immutable `handle` for exact reproducibility. Aliases are convenience selectors, not
execution identity: the host resolves once, performs revision-bound authorization,
records/returns the concrete handle, then executes only that revision. Calling an
exact handle can never silently move to newly edited code.

Inside a `code.run`, the entire capability snapshot is already pinned, so each
runtime `call(ref, input)` does not need to echo a secondary descriptor contract. A
runtime saved ref resolves to one saved revision when the outer snapshot is created
and remains on that revision for the entire root run.

Keep `BrokerContract` for the existing provider-visible lazy `tool` broker. Do not
cargo-cult its two-phase contract field into `code.call` where atomic alias resolution
plus an immutable saved handle already solves stale execution identity with less agent
ceremony.

`BrokerContract` and `executionContract` are deliberately different identities:
`broker-v1` fingerprints the lazy broker's model-facing descriptor (including prose),
while `executionContract` excludes cosmetic prose and fingerprints callable semantics
+ authority binding for saved dependency preflight. Reuse common canonical JSON/hash
primitives where practical, but do not make description-only edits break executable
dependency contracts.

## 15. Permissions and persistence security

Use `code` as the permission namespace with precise patterns.

Conceptually:

```text
permission="code", pattern="save:project:<name>"
permission="code", pattern="save:global:<name>"
permission="code", pattern="call:project:<name>@sha256:..."
permission="code", pattern="call:global:<name>@sha256:..."
```

The exact pattern syntax should match existing Permission conventions.

Permission ownership is deliberately non-duplicative:

| operation | outer Code permission | leaf permission |
|---|---|---|
| `search` | no prompt; explicit `code = deny` still disables the surface | none |
| `run` | no generic prompt; explicit `code = deny` still blocks it | every called leaf evaluates normally |
| `save` / `run.save` | `permission="code", pattern="save:<scope>:<id>"` | origin run already evaluated its leaves |
| `call` | revision-bound `permission="code", pattern="call:<scope>:<id>@<revision>"` | every called leaf evaluates normally |

This avoids a useless "allow code, then allow read" double prompt for ordinary
orchestration while giving durable persistence and reusable execution their own
explicit authority.

The current permission implementation has a pre-existing hazard that must be fixed
before revision-bound trust is claimed: standing approved rules are appended after
configured rules and can therefore out-rank a later explicit deny. Explicit deny
must remain revocable/authoritative.

Nested Code execution also must not mint a project-wide wildcard grant merely because
a leaf offered `always: ["*"]`. This requires a real **run-scoped permission primitive**,
not prose: Code-originated asks carry the root `executionID`; the permission owner can
record an allow for `once` or `this run`, and the gateway consults that run-local map
before prompting again. Durable `always` remains a separate explicit UI choice and is
never inferred from successful execution. A live configured deny still wins over both
run-local and standing approvals. Consequently descendant authority is always a subset
of the root/session authority and can never escalate by entering another saved frame.

### One-shot confined runs

Running pure confined source does not itself grant external authority. Every leaf
capability invocation still asks/evaluates its normal permission.

The catalog snapshot may be frozen for determinism; authorization is live. A policy
change while a long CodeRun is active applies to subsequent leaf invocations.

### Save is a distinct authority

Saving persistent executable source is security-sensitive even if the originating
run was safe. It requires an explicit save permission path.

Only the **agent/provider-level** `code.save` / `run.save` surface can persist a tool in
P0. Executing scratch or saved code has no runtime `save(...)` primitive and cannot
reach provider-level `code` through `call(...)`. A program may return a proposed tool
spec/source as ordinary data, after which the agent can explicitly choose to run and
save it. Composition and self-modification are intentionally separate authorities.

### Saved-call revision gate

Calling a saved revision requires a decision bound to the **executable revision**.
Source/runtime/schema/dependency/authority-semantic changes already mint a new revision
and therefore a new call authority identity. Description/tag/help-text edits change the
descriptor fingerprint used by catalog/search caches, but do not silently revoke or
expand executable authority.

This saved-call gate is **in addition to**, never instead of, the underlying leaf tool
permissions.

### Global tools

Global save is explicit. First execution of a global saved tool in a project that has
not seen that revision should require a project-context decision even if the same
revision ran elsewhere.

Project and global tools with the same canonical ID are never silently shadowed.
Unqualified lookup becomes ambiguous and requires an explicit scope/handle.

### Provenance

Record at save time:

- originating run/session/message;
- model/provider identity if available;
- source hash;
- capability snapshot fingerprint;
- whether the authoring turn consumed externally sourced/untrusted content when
  OpenFork has a reliable provenance signal;
- scope and revision lineage.

Do not invent an unreliable "trusted/untrusted" heuristic merely to fill the field.
Provenance should be recorded only from authoritative signals.

## 16. Recursive composition without recursive evaluators

The architecture deliberately permits **capability recursion** and forbids recursive
Code Mode lifecycle spawning.

Allowed:

```text
scratch code -> native/MCP capability
scratch code -> saved tool
saved A -> native/MCP capability
saved A -> saved B -> saved C
saved A -> native capability -> saved B
ordinary JavaScript function recursion inside one prepared program
```

Not exposed in P0:

```text
running program -> code.run(...)
running program -> code.save(...)
running program -> code.search(...)
running program -> recursively instantiate another root Code runtime
```

The stronger invariant is:

> Code can call capabilities, and saved code is itself a capability.

### Root execution context

Every provider-level `code.run` / `code.call` creates one root execution supervisor:

```ts
type RootCodeExecution = {
  executionID: RunID
  capabilitySnapshot: CapabilitySnapshot
  deadlineAt: number
  abort: AbortSignal
  permissionContext: PermissionContext
  budget: SharedCodeBudget
  activeSavedStack: RevisionID[]
}
```

A nested saved-tool call creates only a child `CodeFrame` with a fresh lexical
`input`. It does **not** receive a new deadline, fresh call budget, fresh permission
universe, or new capability snapshot.

Resource/authority inheritance is monotonic:

```text
child capabilities  ⊆ root captured capabilities
child authority     ⊆ root/session authority
child deadline      = root deadline
child remaining CPU/time/call/data budget <= root remaining budget
child abort signal  descends from root abort
```

No nested saved frame can reset a counter by calling another saved tool.

### Cycle and depth rules

Maintain the active saved-revision path:

```text
A@rev1 -> B@rev4 -> C@rev2
```

If C attempts A again, reject immediately:

```text
SavedToolCycle:
A@rev1 -> B@rev4 -> C@rev2 -> A@rev1
```

Direct self-call `A -> A` is rejected for the same reason; local recursion belongs in
ordinary JavaScript instead.

Use an initial host-owned maximum saved-frame depth of **16**. This is a final safety
valve, not a substitute for cycle detection. Also enforce:

- maximum leaf capability calls per root;
- maximum simultaneous leaf calls;
- maximum distinct permission prompts/decisions per root;
- bounded log bytes;
- bounded per-leaf and aggregate intermediate data bytes;
- bounded attachment count and bytes;
- bounded returned JSON depth/size;
- cancellation propagation through every nested fiber/RPC;
- hard child-process kill after a grace interval for the future module runtime.

Keep the current CodeMode concurrency behavior as the initial baseline (currently a
small bounded number of concurrent calls) and tune from telemetry rather than making
fan-out unbounded. The concurrency cap is shared by the whole root call graph; a saved
child does not receive another pool of eight slots.

If a durable delegator creates another OpenFork session and that separate session later
invokes its own provider-level `code` tool, that is a genuinely new root execution
with its own ToolPart and budget. Do not model cross-session delegation as interpreter
recursion.

A root `code` cancellation cancels:

1. interpreter execution;
2. pending permission waits;
3. active native/MCP leaf calls;
4. every descendant saved-tool frame;
5. future native module child execution if present.

The trace therefore forms one first-class call graph rooted at the outer ToolPart,
not a forest of nested `code.run` executions.

## 17. Output, data, and attachments

### Structured result

The model-facing result should be compact and machine-legible:

```json
{
  "run": "run:prt_...",
  "source": "sha256:...",
  "value": { "...": "..." },
  "logs": [],
  "calls": {
    "total": 7,
    "failed": 0
  }
}
```

Detailed child traces belong in metadata/UI, not repeated into model context unless
needed for failure recovery.

### Success/failure envelope

Keep the outer model-facing shape predictable:

```ts
type CodeResult =
  | {
      ok: true
      runID: string
      sourceHash: string
      inputHash?: string
      replayOf?: string
      replayable: boolean
      value: unknown
      calls: { total: number; failed: number }
      warnings?: Array<{ kind: string; message: string }>
      saved?: { id: string; revision: string; handle: string; path: string }
    }
  | {
      ok: false
      runID: string
      sourceHash?: string
      replayOf?: string
      error: {
        kind: CodeErrorKind
        message: string
        recovery: string
      }
      calls?: { total: number; failed: number }
    }
```

Program/tool failures should ordinarily return as structured `ok:false` data rather
than bubbling as opaque host exceptions. Host defects remain private diagnostics.

This mirrors the useful property of the current confined engine: expected failures are
data the agent can reason about.

The split inside a program is equally explicit:

- expected leaf refusal/schema/tool failures are catchable by program `try/catch`;
- root execution budgets, cancellation, interpreter defects, and host-invariant
  failures terminate the root run;
- every user-correctable outer failure supplies a concrete `recovery` instruction;
- `UnknownCapability` includes ranked near-misses when available;
- schema failures identify the failing property/path and expected shape.

A dirty working copy is not itself an execution failure when a validated staged
revision remains available. Report `SavedToolDirty` as a warning alongside the
revision actually executed unless the caller explicitly requested the dirty source.

### Attachments

Keep binary/media outside the interpreter as the current CodeMode adapter does:

- child tool produces attachment;
- host collects it;
- program receives a compact structured placeholder/metadata;
- outer `code` result attaches the actual file once.

Do not base64-inject large binary data into generated JS.

### Internal structured data

WP0.5 introduces an optional internal structured payload as part of the semantic
executor split:

```ts
type ExecuteResult = {
  output: string
  data?: unknown
  ...
}
```

The provider-facing path continues to use `output`; the code gateway prefers bounded
`data ?? output`.

Convert the composition-critical baseline early enough that the documented `call(...)`
examples are real, not prose fantasies. Additional tools such as JSON/SQLite/project/
symbols can migrate incrementally afterward without changing the contract again.
Large structured producers must paginate/spill/reference rather than treating `data`
as an unbounded heap escape hatch.

## 18. Search and discovery

One search engine should index:

- native capability path/id;
- MCP server + tool path;
- descriptions;
- input property names;
- enum literals where useful;
- saved tool name/description/tags/input properties;
- recent CodeRun bounded summary/title/capability references; never raw source.

Build the search structure once per catalog generation rather than linearly
re-rendering every schema/signature on every query. Minimum useful structure:

- O(1) exact maps for canonical IDs and directly usable JavaScript paths;
- bounded pre-tokenized lexical documents plus exact/namespace maps; use token postings
  where measurement justifies them rather than rebuilding one lowercase mega-string;
- lazy/cached full TypeScript signatures only for exact inspection (or an explicit
  signature-detail request), never for ordinary broad-search hits;
- deterministic keyset cursors based on ranking tuple + canonical ref, not mutable
  numeric offsets.

Do not concatenate enormous enum lists into one generic search blob. Index bounded
enum tokens separately only when they materially improve discovery.

Ranking should strongly prefer:

1. exact canonical native/capability path/name;
2. exact saved path/name;
3. exact token/prefix;
4. identifier decomposition (camelCase/snake/kebab);
5. property-name matches;
6. description lexical relevance;
7. recency only as a weak run-history tiebreaker.

No embedding model is required for P0.

Saved descriptions/tags/run summaries are untrusted data. Search renders them in
structurally delimited fields, never concatenates them into instruction prose, and
counts their bytes against the response budget. An exact native/canonical ref match
cannot be outranked by saved metadata.

Reuse the repository's existing code-aware lexical normalization where it is the
correct owner rather than creating another incompatible tokenizer.

### Progressive disclosure

`code.search` exact hit returns a full descriptor/signature.

Broad search returns compact candidates first. The response should not dump hundreds
of schemas.

Suggested bounds:

- default 8 results;
- maximum 25;
- deterministic cursor pagination;
- exact hit may include one usage example.

### Search result shape

Broad capability result:

```json
{
  "kind": "capability",
  "ref": "native:symbols",
  "summary": "Search and inspect source symbols."
}
```

Exact inspection:

```json
{
  "kind": "capability",
  "ref": "native:symbols",
  "description": "...",
  "signature": "call(\"native:symbols\", input): Promise<...>",
  "source": "native"
}
```

Saved result additionally returns scope, revision, immutable handle, source path, and
its compact dependency summary. `code.search` does **not** return saved source bodies,
even for exact inspection. Source inspection goes through the ordinary `read`/
filesystem authority path: project-scope source is read like any other project file;
global-scope source therefore receives the existing outside-project / external-directory
permission behavior instead of turning `code.search` into a hidden global-filesystem
read capability.

Run-history results should be intentionally compact:

```json
{
  "kind": "run",
  "runID": "run:prt_...",
  "status": "succeeded",
  "sourceHash": "sha256:...",
  "summary": "Queried symbols and grouped call sites",
  "startedAt": 0
}
```

Run search is summary/title/capability-reference discovery, not full-source search.
Do not index or dump raw CodeRun source into broad run search in P0. Exact
`path/runID` inspection returns metadata plus a source hash/reference; replay/source
retrieval still goes through the run-resolution owner and its same-physical-scope
policy.

## 19. Performance architecture

This feature should improve total agent latency/context cost, not merely add power.

### P-1: no dynamic provider prefix

This is the highest-priority regression test.

### P-2: catalog snapshots are cached

Build normalized descriptors/search documents when the authoritative inventory
changes, not for every `code.run`.

Fingerprint inputs:

- registry generation;
- MCP catalog generation;
- saved catalog generation;
- effective permission visibility projection.

Use structural sharing so one saved-tool edit does not rebuild unrelated MCP schema
documents.

The current `@opencode-ai/codemode` path eagerly constructs a complete search index
and renders schemas/signatures around execution. The resolver architecture is not
complete until ordinary `code.run` avoids O(catalog-size) preparation work on the
hot path.

### P-3: compile/parse cache

Cache confined-code prepared programs by:

```text
(runtimeVersion, sourceHash)
```

Replay of identical code should normally skip TS transpile + Acorn parse.

Do not cache execution state.

Benchmark an additional JS-first preparation path: attempt Acorn directly on the
original source (the runtime already permits top-level return/await), and fall back to
TypeScript transpilation only when JS parsing fails in a way compatible with TS syntax.
The TypeScript compiler import itself must be lazy behind that fallback; otherwise
JS-only runs still pay the compiler module-graph startup cost. Do not ship this
optimization until parity tests prove diagnostics/source locations and supported
syntax remain correct.

To make this clean, evolve `packages/codemode` toward a split similar to:

```ts
const program = CodeMode.compile(source)
yield* CodeMode.executeCompiled(program, {
  resolver,
  bindings: { input },
  limits,
})
```

The exact public API may differ, but compilation must be separable from run-specific
capability bindings/input. The host owns the bounded LRU keyed by
`(codemodeSemanticVersion, transpiler/parserVersion, sourceHash)`; the generic package owns the compiled
artifact format and invalidates it when interpreter semantics change.

The cache is bytes-weighted, not merely entry-count bounded, because retained AST
size tracks source complexity. It stores no execution state, Tool.Context,
capability snapshot, promises, or fibers.

### P-4: do not duplicate durable source

The source-bearing root ToolPart already persists `code` in `state.input`. Fresh
replays reference `sourceRunID` instead of copying that source again. Saved revisions
materialize source to the filesystem. Do not add a second `CodeSource` table unless a
measured future workload proves the existing ownership is insufficient.

### P-5: one existing ToolPart settlement per root run

Do not add a second run row/event for every execution, progress chunk, or nested leaf
call. Maintain an in-memory bounded trace while running, coalesce UI progress, and
settle the existing outer ToolPart once with a bounded code metadata summary.

Current `SessionTools.resolve` already documents why unthrottled progress publishes
are harmful; `code` should not reintroduce that failure mode at a larger fan-out.

### P-6: no child process for ordinary runs

The confined interpreter is the default precisely because process startup, stdio
framing, environment construction, and teardown are unnecessary overhead for normal
orchestration.

### P-7: search index is incremental

A saved-tool edit updates one search document. MCP reconnect updates the affected
server namespace. Registry refresh updates changed native descriptors.

### P-8: benchmark gates

Track at minimum:

- cold `code.run` overhead with zero leaf calls;
- warm/replay overhead;
- parser/compile cache hit rate;
- search p50/p95 over 100 / 1k / 10k capabilities;
- nested gateway overhead per leaf call;
- provider-prefix bytes before vs after `execute -> code`;
- DB writes/events per run;
- memory retained per capability snapshot;
- save-to-call latency;
- cancellation latency;
- fan-out throughput at 1/4/8 concurrent calls.

## 20. Durable ownership

Follow the repository's bottom-up ownership rules.

### Filesystem authoritative

Saved source/manifests:

```text
.openfork/code/**
global OpenFork code directory
```

Project `.openfork/code/**` is an OpenFork metadata/artifact subtree, not ordinary
application source. Exclude it from generic ProjectInventory/broad source search by
default so saved tools do not recursively pollute project analysis. Explicit path reads
remain allowed under normal filesystem authority, and `code.search(target:"saved")` is
the canonical discovery path.

Do **not** automatically add `.openfork/code/**` to the user's `.gitignore`: project
saved tools may intentionally be version-controlled/shared. Files arriving from Git are
still non-callable until their exact revision is admitted, so versionability does not
become execution authority.

### Existing Core ToolPart is authoritative

The V1 `ToolPart` is already projected into Core's `part` table as durable JSON. It
stores the outer code call's input, output/error, metadata, timing, and attachments.
That is the authoritative root-run record.

`runID` is a reversible handle over the durable `ToolPart.id` / `PartTable.id`, so
exact replay lookup uses the existing primary key. It is **not** the provider
`toolCallId`: V1 creates these as separate identities.

`SessionProcessor.ensureToolCall()` already allocates the durable PartID before a host
Tool.Def executes and keeps an in-memory `toolCallID -> partID` map. Expose that map
through a narrow read-only processor seam and add `Tool.Context.partID?: PartID`.
`SessionTools.resolve` resolves the already-admitted PartID per invocation and places
it in the context; nested gateway frames inherit the root PartID and real root provider callID while
retaining their own child frame/trace/interrupt IDs. Do not issue a no-op `updateToolCall` merely to discover the
PartID, because that would turn identity lookup into a durable write.

The handle is a locator, **not a bearer capability**. The Code Service validates that
the decoded part is actually a `code` ToolPart and that its owning session matches the
current physical worktree scope (project/workspace/directory identity) before exposing
source, metadata, or existence. Foreign-scope and missing handles collapse to the same
`RunNotFound` result.

No `code_source` or duplicate `code_run` table is required for P0.

If broad cross-session run browsing later proves expensive, add only a rebuild-derived
projection/index such as:

```text
code_run_index
  run_id      PK / reversible PartID handle
  part_id     UNIQUE
  session_id
  source_hash
  source_run_id
  status
  time_created
  summary     optional bounded text
```

It must contain no authoritative source/input/output copies and must be rebuildable
from `PartTable`.

Do **not** blindly reuse the existing session FTS for CodeRun search: its generic input
projection may include a prefix of `state.input.code`, which is precisely the source P0
forbids broad search from indexing. Reuse FTS only after giving Code ToolParts a bounded
source-excluding search projection and physical-scope filter; otherwise use the small
rebuild-derived `code_run_index` above.

Do not make SQLite the source of truth for saved library files. A saved-tool
search/usage table is likewise allowed only as rebuild-derived state.

### SavedCodeAdmission is durable trust state, not library storage

The one intentional saved-code durable table is a minimal Core-owned admission fact,
for example:

```text
saved_code_admission
  scope_kind              # project | global
  scope_key               # canonical physical project-root or global saved-code-root identity
  saved_id
  executable_revision
  source_hash
  descriptor_fingerprint? # optional audit/cache diagnostic; not trust identity
  origin_session_id? / origin_message_id? / origin_part_id?
  admitted_at
  PRIMARY KEY(scope_kind, scope_key, saved_id, executable_revision)
```

It contains **no source, manifest, dependency graph, output, or arbitrary tool input**.
P0 has exactly two writers: successful permission-gated `code.save`, and the explicit
human operator admission/import/recovery flow that recomputes and displays the same
revision identity before confirmation. `code.call` never auto-admits. It requires both
verified filesystem bytes and a matching admission row before applying the revision-
bound call permission. Deleting/corrupting this table cannot delete saved source; it
only makes affected revisions fail closed until re-admitted.

This table belongs in Core because it is persistent host authority, unlike the
rebuild-derived catalog/search indexes owned by the Code Service.

## 21. Error taxonomy

Upgrade the current generic CodeMode failure path so agents can recover correctly.

At minimum:

```text
ParseError
UnsupportedSyntax
UnknownCapability
AmbiguousPermissionIdentity
CapabilitySchemaError
CapabilityDenied
CapabilityFailed
DependencyContractChanged
InvalidInput
InvalidOutput
LimitExceeded
Timeout
Cancelled
RunNotFound
RunNotReplayable
RunSourceUnavailable
SaveRejected
SavedToolNotFound
SavedToolAmbiguous
SavedToolDirty
SavedToolCycle
SavedToolDepthExceeded
RuntimeUnavailable
InternalRuntimeError
```

Model-facing errors must contain actionable recovery instructions where possible
without leaking private host causes.

## 22. Agent-developer UX

The tool should reward the shortest correct path.

### Unknown operation

```text
code({ action: "search", query: "sqlite inspect schema" })
  -> compact ranked refs
code({ action: "search", ref: "native:sqlite" })
  -> exact descriptor + signature when needed
code({ action: "run", code: "...", input: { ... } })
```

### Known capability

For one simple known operation, prefer the ordinary direct tool call. For predictable
multi-step orchestration whose refs are already known, skip search and use `code.run`
directly.

### Successful scratch orchestration

```text
code({ action: "run", code: "...", input: { ... } })
  -> run:prt_x, source hash, value
```

### Replay with different input

```text
code({ action: "run", runID: "run:prt_x", input: { ... } })
```

### Promote after proving usefulness

```text
code({ action: "save", runID: "run:prt_x", save: { name: "find_todos" } })
  -> saved descriptor + revision + immutable handle
```

### Invoke later

```text
code({ action: "search", target: "saved", query: "todo" })
code({ action: "call", tool: "find_todos", input: { ... } })
  -> result echoes resolved saved:project/find_todos@sha256:... handle
```

### Save immediately on a known-good pattern

```text
code({ action: "run", code, input, save })
```

### Evolve an existing saved tool

```text
code({ action: "search", ref: "saved:project/find_todos" })
  -> current revision/handle + sourcePath + dependency summary

read sourcePath through ordinary filesystem authority
modify source in-model

code({ action: "run", code: modifiedSource, input: representativeInput })
  -> successful run:prt_...

code({
  action: "save",
  runID: "run:prt_...",
  save: { name: "find_todos", scope: "project" }
})
  -> new immutable revision; alias advances atomically
```

There is no special `edit`, `draft`, `validate`, or `publish` action. `run` is the
validation step and saving the same canonical ID is an atomic version update. The
previous staged revision remains callable by its immutable handle and remains pinned
while referenced by another saved revision or in-flight call.

Manual filesystem edits to `code.ts` remain useful for human development, but they
only create a dirty working copy. `code.call` continues using the last committed
staged revision until a successful run/save advances the manifest.

The model never drives a draft/validate/publish state machine on the happy path.

## 23. User-visible developer UX

Saved tools should be pleasant for humans too.

Future UI should show:

- saved tool name/scope;
- current callable revision;
- dirty working-copy indicator;
- source location;
- origin run/session;
- optional last-used/use-count/recent-outcome projections **only when** they can be
  derived from retained ToolParts or a rebuild-derived index; no UI-only authority store;
- capability dependencies observed in successful runs;
- revision diff;
- project/global badge;
- disable/delete/promote controls;
- "replay origin run" and "open source" actions.

The UI is a projection. It must not become the owner of revision calculation,
execution, or search.

## 24. Relationship to the existing `tool` lazy broker

Keep both provider tools initially:

```text
tool
  -> low-frequency direct capability access without expanding provider manifest

code
  -> programmable orchestration + run artifacts + saved executable abstractions
```

Internally, both should converge on `CapabilityInvocationGateway`.

Do **not** auto-promote saved code tools into the lazy `tool` broker in P0. That
would create two discovery/call identities for the same saved abstraction and
complicate trust semantics.

If later telemetry shows strong value in direct lazy-tool promotion, it can be added
as an explicit projection of the same saved revision.

## 25. Migration from `execute`

### Step M0: tests before rename

Add regression tests proving:

- current MCP Code Mode execution behavior;
- attachment behavior;
- permission denial;
- plugin hooks;
- cancellation;
- concurrent nested calls;
- dynamic description currently changes (document the bug) and the new `code`
  replacement does not.

### Step M1: gateway extraction

Introduce `CapabilityInvocationGateway` and move current MCP child execution onto
it without changing `execute` externally.

### Step M2: static `code` alternate implementation

Register `code` behind one **temporary development selector**, e.g.
`OPENCODE_EXPERIMENTAL_CODE_TOOL`, but never expose `code` and `execute`
simultaneously to the same provider turn. The selector owns both orchestration-tool
choice and direct-MCP hiding:

```text
legacy branch -> execute visible, MCP direct tools hidden by legacy Code Mode policy
new branch    -> code visible, execute absent, MCP direct tools hidden by Code policy
```

Internal tests may instantiate both implementations; the model should not have two
overlapping orchestration tools competing for calls.

Initially:

- `search` over MCP + native capabilities;
- `run` through confined runtime;
- native + lazy + MCP invocation through gateway;
- no persistence yet.

### Step M3: CodeRun + replay

Use the existing durable root ToolPart as the authoritative CodeRun record. For
`action:"run"`, inline `code` creates a new source-bearing run and `runID` selects
fresh replay over an existing source-bearing identity. Dirty saved working source is
read through ordinary filesystem authority and supplied as inline `code`; there is no
third run-source selector. Do not add duplicate run/source tables merely for Code Mode.

### Step M4: saved tools

Add filesystem catalog, save/call, immutable revision handles, dependency contracts,
provenance, project/global scope, cycle/depth protection.

### Step M5: replace `execute`

Make `code` the default and remove provider-visible `execute`.

At final cutover, remove the temporary selector and make `code` the sole orchestration
surface. Retire/deprecate legacy `OPENCODE_EXPERIMENTAL_CODE_MODE` semantics rather
than preserving a misleading permanent dual mode merely because the flag came from
upstream.

While the temporary selector chooses `code`, legacy
`OPENCODE_EXPERIMENTAL_CODE_MODE=false` must not re-expose direct MCP tools. The new
selector is the single authority for both provider tool selection and MCP-manifest
hiding.

The provider-tool rename is also permission-sensitive. Existing explicit
`execute = deny` configuration must not silently become permission to use `code`.
Own this exactly once in the `ConfigPermissionV1` decode/config-normalization owner,
**before** `Permission.fromConfig` projects runtime rules. When a config contains legacy
`execute` rules and **no explicit `code` rules**, synthesize equivalent `code` rules. If any explicit `code` rule exists,
do not synthesize the legacy alias; the user's new configuration wins without relying
on object insertion order / `findLast` accidents. Tests must prove `execute=deny`
alone denies `code`, while `execute=deny` plus explicit `code=allow` allows it. Remove
this compatibility normalization through the normal config-migration policy.

### Step M6: delete obsolete adapter/catalog generation

Once parity is proven:

- delete the dynamic `describeCodeMode` provider-description path;
- remove `CODE_MODE_TOOL = "execute"`;
- keep generic `packages/codemode` as the confined engine;
- update `docs/architecture/code-mode.md` from current adopted `execute` semantics
  to the new adopted `code` architecture.

## 26. Proposed source layout

Host-owned architecture:

```text
packages/opencode/src/code/
  service.ts
  schema.ts
  run.ts
  catalog.ts
  search.ts
  saved.ts
  revision.ts
  storage.ts
  provenance.ts
  limits.ts
  error.ts

packages/opencode/src/session/
  capability-invocation-gateway.ts

packages/opencode/src/tool/
  code.ts

packages/core/src/code/
  admission.sql.ts
  admission.ts
```

The Core admission owner stores only durable saved-code trust facts; it is not a
CodeRun/source store and does not change ToolPart ownership.

Generic confined engine remains:

```text
packages/codemode/**
```

P0 adds no dedicated Core CodeRun tables. The existing durable ToolPart/PartTable
remains authoritative. A later rebuild-derived run-search projection belongs in Core
only if measured cross-session query cost proves it necessary.

## 27. Testing gates

### Provider cache invariance

Snapshot the **fully resolved provider manifest** after provider schema transforms and
`tool.definition` plugin shaping, for at least two materially different model
families. Then:

- connect/disconnect MCP;
- save 100 tools;
- edit 100 tools;
- delete them;
- change run history;
- refresh custom registry.

Assert byte-equal serialized `code` description + JSON schema every time. Also
assert no capability catalog is injected into system/tail context as a hidden
replacement for the old dynamic description.

### Authority parity

For every capability kind, prove nested code invocation has the same allow/ask/deny
result as direct invocation for equivalent session/agent rules.

The gate includes the exact permission identity/pattern, not merely final outcome:

- ordinary native/lazy target deny applies identically through provider, `tool`, and
  `code`;
- delegated `find` / `web` / `browser` keep their action-specific leaf authority
  rather than being blocked by an incorrect wrapper-level wildcard check;
- MCP Code SDK paths may preserve original names, but authorization still uses the
  existing flattened `permissionKey` until an explicit permission migration occurs;
- MCP resource helpers exercise their documented server/resource-scoped permission
  identity;
- explicit `code = deny` blocks search/run/save/call as specified;
- saved-call authorization binds the atomically resolved executable revision before
  the saved program executes; descriptor fingerprints affect search/cache presentation only,
  not execution authority.

### Hook parity

Exactly one before + one after hook per leaf call. No double-hooking through lazy or
saved delegation. Test both `tool -> call(x)` and `code -> call(ref, input)` after the
lazy broker migrates onto the gateway.

### Snapshot parity

Read-only nested capabilities do not invalidate workspace Snapshot reuse. Mutating
native/MCP calls do.

Snapshot has two distinct channels and both must be preserved:

- **mutation ordering** — `code` is a delegator/read-only wrapper; each mutating leaf
  enters the shared Snapshot mutation section using its real arguments;
- **mutation observation** — the root processor must still know that at least one leaf
  mutated so post-step `snapshot.track()`, patch projection, and SPAD progress/thrash
  recovery run normally.

P0 may conservatively mark root `code` mutation-observed when any mutating leaf is
dispatched. Do not make `code` read-only in the processor observation channel merely
because it is read-only in the registry ordering channel.

### Root identity and attachment projection

A provider-level `code` execution without an already-admitted root `Tool.Context.partID`
fails closed rather than minting a second identity. Each nested leaf has its own child
trace/interrupt ID but creates no nested ToolPart.

Every attachment produced by nested leaves is projected exactly once onto the outer
Code ToolPart with exactly one valid PartID; nested calls do not create duplicate
attachment rows or complete the root early.

### Revision safety

Edit saved source while a call is running; in-flight call stays on captured revision.
Next call does not silently execute dirty source.

A verified staged revision with no matching `SavedCodeAdmission` is inspectable but
cannot execute. Corrupting staged bytes, stored hashes, or manifest revision strings
cannot preserve callability under an old handle.

### Persistence safety

A failed run cannot be saved. A successful run's saved source hash must exactly match
the run source hash.

A source-bearing inline run durably owns the exact bounded canonical source bytes it
executed. If those bytes came from a saved tool's dirty `code.ts`, later filesystem
edits cannot change the source promoted from that successful run. A denied save leaves
no new staged revision, manifest pointer, or admission record.

Two concurrent saves of the same ID are serialized by the saved-code lock. Immutable
revision/source objects are content-addressed and never overwritten; both distinct
revisions survive. The mutable human alias (`tool.json`) advances in lock/commit order,
with atomic replacement so there is no torn or partially published pointer.

### Replay safety

Historical runs are immutable. Replay creates a new ToolPart with lineage. A run from
another project is not replayable/searchable by handle in P0; inaccessible and deleted
handles both resolve as `RunNotFound`. Exact run handles round-trip to the underlying
ToolPart primary key without a second identity table.

Projection-backed/ChunkDB V1 part data is hydrated through the session/Core owner; a
dangling/pruned projection becomes `RunNotReplayable` rather than exposing `$cdbRef`
or raw storage internals. Replay-of-replay resolves the canonical `sourceRunID` in
O(1) rather than walking lineage.

### Cancellation

Abort while:

- interpreting;
- waiting on permission;
- one leaf call is active;
- eight leaf calls are active;
- nested saved tool is active;
- a nested human question is pending;
- a per-leaf MCP/native interrupt is active.

No leaked pending permission/question or execution remains. Cancellation settles the
outer Code result as `ok:false, error.kind="Cancelled"`; it is never reported as a
successful `"Execution cancelled"` payload.

The assertion includes underlying transports/processes, not only settled Effect
fibers: per-leaf abort must reach MCP transport/native execution where that leaf
supports cancellation.

### Failure catchability

Expected native/lazy/MCP leaf failures are catchable by program `try/catch` and do
not become host defects merely because the direct provider wrapper normally uses
`Effect.orDie`.

Expected outer program/tool failures return the stable `CodeResult { ok:false,
error:{kind,message,recovery} }` envelope; only genuine host defects escape as tool
execution defects.

### Saved catalog freshness

`code.save` invalidates its process-local catalog synchronously. External/manual
filesystem edits are detected by the dedicated saved-code catalog owner on both Bun
and Node. Correctness does not depend on a watcher: the **first use of each immutable
saved handle per root run** revalidates manifest/staged bytes + `SavedCodeAdmission`
and caches the resulting `VerifiedSavedProgram`. Repeated same-handle calls within the
root use that pinned verified program; the next root revalidates from disk.

### Search determinism

Same catalog/query yields stable ordering. Exact canonical ref always wins.

### Cycle/depth

Self-call and A->B->A fail with explicit paths.

## 28. Initial performance targets

These are engineering budgets to benchmark, not claims about current performance:

- the serialized provider-visible `code` description + schema remain **byte-identical**
  regardless of catalog size;
- no-code/zero-leaf confined startup should remain single-digit-millisecond class on
  a normal desktop after warm module load;
- cached replay should avoid transpile/parse work;
- capability search over 10k descriptors should target <10 ms p95 locally;
- gateway overhead should be small relative to leaf tool execution and measured
  independently;
- one root run should create O(1) durable run writes, not O(number of progress
  chunks);
- idle saved catalogs must not retain executable runtimes/processes;
- no native child process for ordinary confined runs.

Do not optimize against invented numbers. Add benchmarks first and adjust targets from
measured distributions.

## 29. Decisions intentionally deferred

The following should not block P0/P1:

- native Bun vs Node module profile implementation;
- third-party npm dependency installation;
- global saved-tool package sharing/export;
- autonomous retrieval/tail injection of saved tools;
- automatic lazy-`tool` promotion;
- embeddings;
- warm JS REPL;
- additional languages;
- remote execution;
- binary data inside the interpreter.

The architecture leaves room for them without requiring them.

## 30. Recommended implementation order

The highest-leverage sequence is:

```text
1. resolved-provider-manifest + capability harness tests
2. repair standing-approval precedence / permission revocation semantics
3. raw semantic executor / internal-vs-provider delivery seam
4. authoritative CapabilityInventory projection
5. CapabilityInvocationGateway + current MCP execute/lazy-broker parity
6. finite host limits + Snapshot/cancellation/permission parity hardening
7. same-process interpreter fuel/string/collection safety budgets
8. code.search + code.run as an alternate (never co-exposed) provider surface
9. host-neutral CodeMode resolver + lazy signatures/search index
10. prepared-program / compile cache
11. ToolPart-backed CodeRun fresh replay
12. Core SavedCodeAdmission table/service/migration + operator admission owner
13. saved filesystem catalog + canonical revision/dependency hashing + immutable staging
14. permission-gated code.save + alias/handle code.call + nested saved tools
15. provenance/trust audit + saved-catalog invalidation hardening
16. atomically replace provider-visible execute, coverage tables, TUI dispatch, flags, docs
17. UI/telemetry/performance closeout
18. evaluate native Bun/Node module profile from real usage
```

This order makes the **core capability architecture** useful after steps 4–5 and the
new provider surface usable after step 8. Each stage remains testable, and persistence
or native-runtime complexity does not precede a proven shared gateway.

## 31. Final architecture

```text
                                  MODEL
                                    |
                   provider-visible, cache-stable
                                    v
                         +--------------------+
                         |        code        |
                         |--------------------|
                         | search             |
                         | run / replay       |
                         | save               |
                         | call               |
                         +---------+----------+
                                   |
                             Code Service
              +--------------------+--------------------+
              |                    |                    |
              v                    v                    v
          Run Store           Saved Catalog       Search/Catalog
       existing ToolPart      filesystem truth      cached index
              |                    |                    |
              +--------------------+--------------------+
                                   |
                         Code Execution Engine
                     +-------------+-------------+
                     |                           |
                confined JS/TS             module JS/TS
                existing hot path          future Bun/Node
                     |                           |
                     +-------------+-------------+
                                   |
                         capability bindings
                                   |
                                   v
                    CapabilityInvocationGateway
          +------------+------------+------------+------------+
          |            |            |            |            |
        native        lazy          MCP      MCP resources    saved
        tools         tools         tools                     tools
          |            |            |            |            |
          +------------+------------+------------+------------+
                                   |
                     permission / hooks / abort /
                    snapshot / trace / attachments
```

The defining property is not that OpenFork can "run JavaScript." It is that OpenFork
has one small, stable programmable surface over its complete capability graph, with
replayable execution provenance and the ability to crystallize successful
orchestrations into durable tools without increasing provider context cost.
