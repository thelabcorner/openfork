# CodeMode Engine Design and Status

`@opencode-ai/codemode` is OpenFork's host-neutral confined JavaScript/TypeScript orchestration engine. It is **not** the provider-visible OpenFork tool contract.

The OpenFork product integration is documented in [`docs/architecture/code-mode.md`](../../docs/architecture/code-mode.md). That host layer owns the static `code` tool with `search | describe | run | save | call`, durable ToolPart-backed runs, saved-tool revisions, permissions, tracing, replay, and capability discovery.

Detailed package API documentation lives in [README.md](./README.md). OpenAPI-specific follow-ups live in [src/openapi/TODO.md](./src/openapi/TODO.md).

## Purpose

CodeMode executes a bounded orchestration program inside an owned tree-walking interpreter. A host may expose either an explicit schema-described tool tree, a host-mediated `call(ref, input)` bridge, or both. Programs can sequence dependent work, fan out independent calls, branch, filter, aggregate, and return only the data the model needs.

The engine is designed to:

- keep large intermediate values out of model context;
- avoid agent round-trips between every dependent call;
- expose only host-supplied authority;
- support deterministic resource budgets and cancellation;
- permit reusable prepared programs without retaining host authority or warm runtime state.

CodeMode is an orchestration language, not a general JavaScript runtime or an authorization system.

## Runtime

1. TypeScript syntax is transpiled away and Acorn parses the resulting JavaScript.
2. An owned interpreter executes the supported subset without `eval` or ambient host globals.
3. Program input, tool arguments, tool results, and final output cross bounded plain-data boundaries.
4. Host calls return supervised sandbox promises; independent calls may run concurrently up to the configured budget.
5. Expected parse/program/tool/limit failures return normalized `CodeMode.Result` diagnostics; host interruption remains Effect interruption.
6. `CodeMode.prepare(source)` produces an authority-free `PreparedProgram`; `executePrepared(...)` reuses parse/transpile work with fresh input, host calls, limits, and runtime state.
7. `PREPARED_PROGRAM_ABI` versions the prepared-program representation so host caches can invalidate safely when parser/runtime semantics change.

## Host call surfaces

### Explicit tool tree

A host may pass `tools` built from `Tool.make(...)`. CodeMode can render a bounded inline catalog and internal search index for that generic engine API. This is useful for embedders that want the engine itself to own progressive disclosure.

### Host-mediated capability bridge

A host may instead provide `call(ref, input)`. The generated program sees only the opaque host-issued ref plus structured input; resolution, authorization, mutation ownership, cancellation, tracing, and persistence remain host responsibilities.

OpenFork's production `code` tool uses this bridge. Provider-level discovery happens through `code.search` and exact inspection through `code.describe`; the runtime surface stays intentionally smaller: `input` plus `call(ref, input)`.

## Execution budgets

Hosts choose limits. The engine supports bounded wall-clock time, tool-call count, model-facing output bytes, per-leaf and aggregate intermediate-data bytes, interpreter operations/fuel, string bytes, collection entries, and concurrent host calls.

A host may pass one shared `ExecutionBudget` to multiple prepared executions. OpenFork uses this for nested saved-code frames so operation and intermediate-data limits remain root-scoped instead of resetting at every nested saved invocation.

## Data, files, and failures

Program-visible values are JSON-like bounded data. Runtime references and promises cannot escape. Unknown host defects are sanitized, while `ToolError` is the explicit safe-message channel.

Files and attachments remain outside sandbox value space. A host can collect them while leaves execute and project them once on the outer result.

## Authority boundary

CodeMode intentionally provides no ambient filesystem, process, environment, network, credential, module, package, or application access. There are no imports, dynamic imports, `eval`, npm packages, or host-process globals inside generated code.

Authorization is host-owned. The engine does not decide whether a capability may run, persist approval state, resolve credentials, or implement exactly-once external effects. OpenFork supplies those semantics through its capability inventory and invocation gateway.

## OpenFork integration

OpenFork's V1 production host owns the provider-visible `code` tool and uses CodeMode only as the confined compute engine. The host integration:

- exposes one static cache-stable provider schema;
- discovers native/lazy/MCP/MCP-resource/saved capabilities outside the sandbox;
- executes every leaf through `CapabilityInvocationGateway`;
- preserves permissions, plugin hooks, Snapshot ordering, cancellation, attachments, and root-scoped trace/budgets;
- stores root state in the existing durable ToolPart;
- supports fresh replay and revisioned filesystem-backed saved tools;
- never treats the generic CodeMode inline catalog as provider authority.

See [`docs/architecture/code-mode.md`](../../docs/architecture/code-mode.md) for the product contract and [`docs/plans/code-tool-architecture.md`](../../docs/plans/code-tool-architecture.md) for detailed design history.

## Intentional boundaries

- no ambient filesystem/process/network/credential access;
- no modules/imports/eval/arbitrary host globals;
- no heuristic parsing of text results as JSON;
- no generic authorization or permission policy inside the engine;
- no claim that arbitrary external side effects are rollbackable;
- no durable runtime/kernel state between executions.

## Decisions and rationale

| Decision | Rationale |
| --- | --- |
| Own the interpreter | The requirement is bounded orchestration, not arbitrary JavaScript. |
| Keep authority host-owned | The engine can only confine execution to host-supplied capabilities; leaf policy belongs to the host. |
| Support explicit tools and `call(ref,input)` | Embedders need both self-contained engine catalogs and host-owned capability resolution. |
| Prepare source separately from execution | Repeated replay/saved calls should avoid redundant transpile/parse without retaining authority or mutable runtime state. |
| Share execution budgets explicitly | Nested programs must not reset root operation/intermediate limits. |
| Keep files outside sandbox values | Binary/file payloads should not flow through generated code or model context. |
| Return expected failures as data | Agents need actionable diagnostics while interruption/defects keep host semantics. |
| Leave limit values to hosts | Appropriate budgets depend on surrounding product policy. |

## Remaining engine work

Keep this section limited to generic engine work; OpenFork host/product work belongs in the architecture and implementation ledger.

- Design multi-stage promise pipelines (`then`, `catch`, `finally`) without weakening cancellation or failure semantics.
- Support async iteration / `for await...of` once a bounded stream boundary exists.
- Expand deterministic callback-bearing standard-library variants where common generated code benefits.
- Close remaining deterministic `Object`, collection, and `Math` parity gaps.
- Continue refining diagnostics so user throws, safe tool failures, host defects, and interpreter defects remain distinguishable without leaking private causes.
- Define tagged bounded representations before adding Blob/File/ArrayBuffer/typed-array/stream values.
- Keep OpenAPI adaptation fail-closed for operations/transports it cannot represent accurately.
