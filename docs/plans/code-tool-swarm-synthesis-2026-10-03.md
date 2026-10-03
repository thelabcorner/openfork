# OpenFork `code` Tool — 16-Agent Swarm Synthesis

> Date: 2026-10-03
>
> Batch: `grp_efff47f5cffePbmhFHim4mLFu7`
>
> Model: `opencode-go/space-bunny-free`
>
> Scope: read-only red-team of the proposed replacement of provider-visible `execute`
> with the richer `code` surface. The swarm did not implement code. This document
> records reconciled decisions; individual worker reports are advisory evidence, not
> architecture authority.

## 1. Product invariant after synthesis

Provider surface:

```text
code.search
code.run
code.save
code.call
```

Runtime surface:

```ts
call(capabilityRef, input)
```

The provider and runtime surfaces are intentionally asymmetric.

The defining invariant is:

> **Code can call capabilities, and saved code is itself a capability.**

Therefore:

```text
root code.run
  -> call(native/MCP)
  -> call(saved A)
      -> call(saved B)
          -> call(native/MCP)
```

is first-class.

But executing code cannot recursively invoke provider-level `code.run`, `code.save`,
or P0 `code.search`. Saved calls execute as child prepared-program frames under the
same root supervisor; they do not create nested root sandboxes/ToolParts/budgets.

## 2. Accepted high-confidence findings

### A. Semantic execution must be fixed before native `call(...)`

Live V1 tools currently collapse expected failures too early:

- `Tool.Def.execute` has no typed expected-error channel;
- several leaves use leaf-local `Effect.orDie`;
- the shared wrapper adds another `Effect.orDie`;
- CodeMode `runHost` currently uses `Cause.squash`, which can turn host defects into
  catchable program errors and mishandle mixed interruption causes;
- host abort racing currently dies with `AbortError` instead of propagating
  cancellation/interruption.

Decision:

- adopt Core's canonical semantic shape as the V1 reference;
- expected ToolFailure remains typed;
- provider delivery projects expected failures at the outer boundary;
- program `call(...)` maps expected failures to catchable CodeMode errors;
- host defects stay defects;
- interruption/cancellation stays interruption;
- structured `data` is added at this seam rather than deferred to a late cleanup WP.

This is a hard prerequisite for native/lazy capability access through Code.

### B. One capability inventory + one invocation gateway

Do not maintain separate graphs for provider tools, lazy tools, MCP, Code Mode, and
saved tools.

Normalized registrations own:

- structured collision-free identity;
- rendered `ref`;
- schema/descriptor data;
- semantic executor;
- live authorization/admission behavior;
- permission key where legacy V1 identity differs;
- non-secret authority binding;
- workspace mutation classification;
- programmatic eligibility;
- lifetime metadata.

Provider projection, lazy broker, `code.search`, and Code runtime are projections of
that owner.

### C. Root ToolPart identity is stable; child identity is separate

`Tool.Context.callID` must remain the real provider/root ToolPart call ID because
permissions/questions/UI already use it as such.

Nested leaves/frames receive separate monotonic:

```text
frameID
trace/interrupt ID
dispatch sequence
```

They never create synthetic ToolPart call IDs and never settle/update child ToolParts.

### D. `code` is a Snapshot delegator

The outer Code call is not itself a workspace mutation.

Each called capability owns the same argument-dependent mutation classification used
for direct invocation, and the gateway applies `snapshot.withMutation` at the leaf.

Pure read orchestration must preserve Snapshot reuse.

### E. ToolPart is the authoritative CodeRun

Do not create duplicate CodeRun/CodeSource execution tables.

- root run identity is a reversible handle over existing PartID;
- source/input/output/error/timing/attachments already live in ToolPart;
- replay exact-reads through the session/Core projection owner and hydrates projection
  references there;
- replay is restricted to the same physical worktree scope, not merely ProjectID;
- deletion of the owning session naturally removes unsaved scratch replay history.

Saved artifacts survive independently because `code.save` materializes them to the
saved filesystem.

### F. Saved storage needs source blobs + revision envelopes

Source hash alone is not executable revision identity.

Canonical shape:

```text
.openfork/code/<id>/
  tool.json
  code.ts
  revisions/
    <executableRevisionHex>.json
    source/
      <sourceHashHex>.ts
```

The revision envelope includes execution-relevant runtime/schema/dependency identity
and points to canonical source bytes.

Two revisions may share source bytes.

### G. Trust identities are deliberately separated

- **Executable revision**: admission + saved-call permission/trust identity.
- **Descriptor fingerprint**: search/catalog/cache presentation identity only.
- **Execution contract**: dependency compatibility metadata.

Cosmetic description/tag changes do not revoke or expand executable authority.

### H. Saved-to-saved composition pins exact revisions

When A is saved while calling B, A records the exact immutable B handle.

Later movement of B's human alias does not mutate A.

Re-saving A is the deliberate adoption path.

Committed immutable revisions are retained in P0; no automatic committed-revision GC.

### I. No runtime dynamic discovery in P0

Provider `code.search` discovers capability refs before authoring.

Scratch programs may compute a ref if necessary, but promotion to saved code requires
statically resolvable literal `call("ref", ...)` targets.

This makes complete dependency preflight and saved-revision reproducibility possible.

### J. Capability composition is allowed; evaluator recursion is not

Allowed:

- native -> saved through host orchestration;
- saved -> native;
- saved -> saved;
- deep saved dependency graphs;
- ordinary JavaScript function recursion.

Not exposed inside running code:

- recursive provider `code.run`;
- runtime persistence/`code.save`;
- P0 runtime catalog search;
- direct or indirect saved-tool cycles.

Initial saved-frame depth limit: **16**.

The whole root graph shares one deadline, abort tree, call/data/log/attachment budgets,
permission context, and concurrency pool.

### K. Same-process interpreter safety is a release gate

Because `@opencode-ai/codemode` executes in-process, finite root timeout and tool-call
limits are not enough.

Before `code` ships, host-supplied mechanisms must include:

- deterministic operation fuel;
- string-expansion bounds;
- collection-growth bounds;
- host->sandbox per-leaf and aggregate data budgets;
- bounded logs/output/attachments;
- finite concurrency.

Numeric policy belongs to OpenFork; mechanism remains generic in `packages/codemode`.

### L. Search should be scalable without premature overengineering

Accepted shape:

- O(1) exact-ref lookup;
- structured segment identity, never lossy dot-joined identity;
- namespace maps;
- generation-cached compact lexical documents;
- lazy full signature rendering;
- bounded broad-search responses.

P0 can reuse existing deterministic lexical tokenizer/ranking semantics over compact
cached docs. Synthetic 1k/10k/50k benchmarks determine whether an inverted-postings
accelerator is warranted.

Do not require a second search engine solely because 50k synthetic entries exist.

### M. Runtime references are collision-free host-issued identities

MCP sanitizer output is not canonical identity.

The inventory stores original identity segments and derives a reversible `ref`.
Legacy flattened/sanitized MCP keys remain permission compatibility identity until a
separate permission migration.

### N. Project/global saved scope remains a product requirement

One simplification lane proposed project-only P0.

Rejected.

The product goal explicitly includes reusable project and global tools. Ambiguous
unqualified aliases fail; runtime saved composition prefers explicit immutable refs.

Global state must have a bootstrap-safe process/global owner; project scope overlays
the physical workspace.

### O. `.openfork/code/**` is project metadata, but may be versioned

Do not auto-edit `.gitignore`.

Project saved tools may intentionally be committed/shared.

However generic source/project inventory should skip the subtree unless explicitly
targeted, so saved tools do not recursively pollute ordinary project analysis.

Git-arrived saved source is not execution authority: exact revisions remain
unadmitted until `code.save` or explicit operator admission.

### P. Permission syntax uses the existing V1 two-axis matcher

Correct form:

```text
permission="code"
pattern="save:project:<id>"

permission="code"
pattern="call:project:<id>@<revision>"
```

Do not create compound permission names such as `code/save:...`; that would break
`code = deny` matching.

Saved-call permission is executable-revision-bound.

Leaf permissions remain additive.

### Q. Code-originated permission decisions require a root-run scope

Nested asks should not silently turn leaf `always:["*"]` suggestions into permanent
project-wide grants.

The root execution needs a run-local decision/dedup scope. Current configured deny must
still override stale standing approval.

### R. Search/runtime output should not flood model context

- broad search omits full signatures;
- exact inspection supplies signature/details;
- child trace lives in bounded ToolPart metadata/UI;
- only outer Code result enters model context;
- nested attachments remain host-side;
- full arbitrary child inputs/results are not persisted by default.

### S. UI/trace contract should become typed

The first-class root call graph should expose a bounded schema-owned CodeRunTrace for
TUI/desktop/app consumers instead of each client parsing `metadata: any`.

Trace records root/frame lineage and leaf dispatch order, timings, outcomes, and
permission state without copying arbitrary child payloads.

## 3. Deliberately rejected swarm suggestions

### Project-only saved tools

Rejected: conflicts with product goal. Keep both project and global scope.

### Blanket exclusion of durable/interactive tools

Rejected: Code should expose the real eligible capability graph.

Durable capabilities need explicit lifecycle/cancellation semantics, not automatic
removal merely because they can create sessions/jobs.

### Excluding a capability because its implementation internally uses Python

Rejected as a category rule.

"No Python" means no Python Code evaluator/kernel/runtime profile. A normal host
capability may internally use any implementation technology if it is explicitly
programmatic-call eligible and runs through the host gateway.

### Recursive runtime `run` / `save`

Rejected.

They add lifecycle recursion/self-modification without meaningful expressive power.
Use ordinary JS functions + `call(...)` + explicit agent-level save.

### Mandatory postings index before measurement

Rejected.

Keep the search contract compatible with an accelerator, but benchmark the compact
generation-cached lexical implementation first.

### Descriptor fingerprint in executable permission identity

Rejected.

Execution trust binds executable revision. Descriptor fingerprint is cache/presentation
identity.

## 4. Remaining implementation-critical gates

Before the first production `code` cutover:

1. permission standing-approval precedence repair;
2. semantic executor/provider-delivery split;
3. CodeMode cause partition + abort-as-interruption;
4. authoritative capability inventory;
5. invocation gateway + lazy/MCP/resource convergence;
6. root callID vs child frame/interrupt identity split;
7. Snapshot leaf-mutation parity;
8. same-process interpreter fuel/growth limits;
9. static byte-stable provider `code` schema;
10. resolver-backed `call(ref,input)`;
11. ToolPart-backed replay with projection hydration + physical-scope check;
12. saved source/revision-envelope storage;
13. durable SavedCodeAdmission;
14. permission-gated save/call + pinned saved composition;
15. atomic `execute -> code` cutover across registry, coverage, flags, TUI/UI, docs,
    and literal tool-ID consumers;
16. deterministic benchmark/structural closeout.

## 5. Structural performance gates preferred over flaky wall-clock assertions

Always-safe CI assertions:

- provider `code` definition is byte-identical across catalog changes;
- zero provider schema growth as saved/MCP catalog grows;
- no signature rendering on ordinary broad search;
- prepared-program cache hit performs no TypeScript transpile/Acorn parse;
- ordinary confined run spawns no child Node/Bun process;
- one root ToolPart execution record, zero child ToolParts;
- nested progress never re-clones/publishes the full source per leaf event;
- saved child frames share root counters/deadline/concurrency pool;
- no nested provider-level Code root can be created from runtime `call(...)`.

Wall-clock p50/p95 benchmarks remain valuable diagnostics, but should become blocking
only after noise distributions are understood.

## 6. Historical lineage

The September Cloudflare-style Code Mode decision remains valid:

- disposable confined JS/TS execution;
- capability-bound external effects;
- no Python/Jupyter warm kernel;
- small provider-visible surface.

The October architecture intentionally supersedes only the old "no persistent
agent-authored packages" conclusion:

- runtime state is still disposable;
- **successful source may crystallize into a durable saved capability artifact**;
- persistence exists at the artifact/revision layer, not at the interpreter-state
  layer.

That distinction is the key continuity rule.
