# Custom Runtime - persistent agent-authored functions and interactive kernels

> Status: architecture proposal for OpenFork. No implementation is implied by this document.
> The design is grounded in the current OpenFork tool stack, especially
> `packages/opencode/src/tool/registry.ts`, `tool/custom.ts`, `tool/reload.ts`,
> `tool/code-mode.ts`, `session/tools.ts`, and `packages/codemode`.
>
> Working product name: **Custom Runtime**. Model-facing tool ID: **`custom`**.

## 1. Executive summary

OpenFork should give the agent a persistent programmable environment in which it can create,
develop, test, retain, discover, and invoke reusable functions without turning every function
into another top-level LLM tool.

The core idea is a synthesis of three useful patterns:

1. **Cloudflare Code Mode:** expose a large capability surface as code-callable functions rather
   than injecting every operation as an independent model tool.
2. **Jupyter kernels:** keep a language runtime warm for interactive, stateful exploration while
   separating the runtime process from its frontend/control plane.
3. **OpenFork's existing custom-tool infrastructure:** persist source on disk, support normal
   imports/dependencies, hot-reload safely, and keep execution integrated with OpenCode's
   permissions, cancellation, metadata, and tool lifecycle.

The resulting model-visible surface stays stable:

```text
read
write
shell
grep
...
custom
```

Creating 5, 50, or 500 reusable custom functions must **not** add 5, 50, or 500 provider-visible
tool definitions. The provider sees one stable `custom` definition. The dynamic library is
discovered and invoked through that tool.

JavaScript/TypeScript and Python are first-class runtimes. A custom function has one logical
entrypoint, but its implementation may contain any number of local modules and may use ordinary
language imports. Single-file functions are the frictionless default, not an architectural
constraint.

The interactive runtime is intentionally Jupyter-like, but **kernel memory is a cache, not the
source of truth**. Persistent capabilities live as normal files. Anything published as a custom
function must survive a cold kernel restart.

## 2. Product thesis

The feature should not be thought of as "Code Mode with persistence" or "a script runner."

The stronger abstraction is:

> **OpenFork gives the agent its own programmable runtime and lets the agent manufacture reusable
> abstractions over its existing capabilities.**

That creates three layers of execution with distinct UX semantics:

```text
Shell
  Disposable machine execution.
  Best for OS commands, builds, CLIs, quick filesystem work, and one-off scripts.

Code Mode
  Disposable confined orchestration.
  Best for one bounded code program over a known capability surface.

Custom Runtime
  Persistent programmable agent environment.
  Best for interactive exploration, reusable logic, imports, package structure,
  repeated transformations, and agent-authored durable capabilities.
```

The goal is not to eliminate `shell`. A healthy implementation should make it obvious to the
model when shell is the cheaper primitive and when logic deserves promotion into the custom
library.

## 3. Goals

### 3.1 Primary goals

- Expose exactly one stable top-level `custom` tool to the model.
- Let the agent execute JavaScript/TypeScript and Python interactively.
- Let interactive kernels remain warm during a session.
- Let the agent create durable callable functions that persist across sessions.
- Let durable functions use local imports and multi-file module/package layouts.
- Support normal JS/TS and Python dependencies without inventing a new package ecosystem.
- Let custom code call approved OpenCode/MCP/custom capabilities through a typed capability
  gateway.
- Keep dynamic custom-function catalogs out of the provider-visible tool schema and system-prompt
  prefix.
- Preserve normal OpenCode permission checks, cancellation, tracing, plugin lifecycle hooks,
  truncation, attachments, and nested tool-call visibility where calls pass through the gateway.
- Make project-scoped functions easy and global reusable functions possible.
- Keep the filesystem as the authoritative source for function code.
- Make published functions deterministic enough to cold-start and run without hidden REPL state.
- Allow OpenFork to add more runtimes later without redesigning the catalog or model-facing tool.

### 3.2 UX goals

- No explicit mode switching.
- No "enter Code Mode / exit Code Mode" ceremony.
- No MCP-server boilerplate for a helper that only this agent needs.
- No littering the repository root with disposable `tmp.mjs`, `scratch.py`, etc.
- No need to restart OpenCode after creating a function.
- Repeated use should become cheaper than repeatedly reconstructing equivalent shell scripts.
- Development should feel like the agent has a lightweight private IDE + Jupyter kernel, not a
  form-driven "tool builder" wizard.

## 4. Non-goals

- Do not expose every custom function as a first-class `ToolRegistry` entry.
- Do not replace shell for one-off command execution.
- Do not require every custom function to be single-file.
- Do not invent a replacement for npm/package.json, Python imports, or pyproject.toml.
- Do not make warm kernel globals part of a published function's correctness contract.
- Do not silently grant native JS/Python processes a stronger security guarantee than OpenFork can
  actually enforce.
- Do not implement the full Jupyter wire protocol simply because the UX resembles Jupyter.
- Do not put function source blobs in SQLite as the canonical representation.
- Do not couple the initial implementation to a notebook document format or `.ipynb` files.
- Do not make global cross-project publication automatic.

## 5. Frontier patterns worth preserving

### 5.1 Cloudflare Code Mode

Cloudflare's Code Mode work demonstrates the central context-efficiency argument: instead of
describing every operation to the model as an independent tool, give the model a typed programming
surface and let generated code compose calls, branch, loop, filter intermediate values, and return
only the useful result.

References:

- <https://blog.cloudflare.com/code-mode/>
- <https://blog.cloudflare.com/code-mode-mcp/>

The part OpenFork should copy is **code as an orchestration layer over capabilities**.

The part OpenFork should extend is persistence: the agent should be able to turn useful orchestration
or transformations into named reusable functions that become part of its private library without
inflating the provider-visible tool catalog.

### 5.2 Anthropic programmatic tool calling and discovery

Anthropic's advanced tool-use work independently reinforces two relevant ideas:

- programmatic tool calls are useful when a model must compose many calls or process large
  intermediate results;
- progressive tool discovery is preferable to permanently loading a giant catalog.

Reference:

- <https://www.anthropic.com/engineering/advanced-tool-use>

OpenFork's `packages/codemode` already contains progressive catalog/search machinery. The Custom
Runtime should reuse or generalize that machinery instead of creating a second unrelated search
system.

### 5.3 Jupyter's kernel separation

Jupyter's important lesson for this feature is architectural rather than UI-specific: a frontend
communicates with a separate language-specific process that retains interactive state. A kernel can
be restarted independently, and different languages can implement the same broad execution
contract.

References:

- <https://docs.jupyter.org/en/stable/projects/kernels.html>
- <https://docs.jupyter.org/en/latest/projects/architecture/content-architecture.html>
- <https://jupyter-client.readthedocs.io/en/latest/messaging.html>

OpenFork does **not** need ZeroMQ, notebook documents, or full Jupyter compatibility for P0. A small
versioned local RPC protocol is enough. The useful idea is the process boundary plus persistent
language state.

## 6. Current OpenFork ground truth

The repository is already close to supporting this design.

### 6.1 `ToolRegistry` is dynamic enough

`packages/opencode/src/tool/registry.ts` currently:

- owns built-in and file/plugin custom `Tool.Def` instances;
- stores state through an instance-local `Ref`;
- exposes `refreshCustom()` with atomic swap semantics;
- recomputes the model-visible registry for subsequent prompt steps.

This is useful infrastructure, but **Custom Runtime functions should not be inserted into this
registry**. Doing so would make every persistent function another provider-visible schema and would
reintroduce exactly the context/cache churn the feature is meant to avoid.

### 6.2 `.opencode/tool(s)` is the wrong persistence location

`packages/opencode/src/tool/custom.ts` scans:

```text
{tool,tools}/*.{js,ts}
```

and converts matching exports into top-level `Tool.Def`s.

Therefore agent-authored Custom Runtime functions should live in a separate namespace such as:

```text
.opencode/custom/
```

They must be invisible to `buildCustomTools()` and `ToolRegistry.all()`.

### 6.3 OpenFork already solved much of hot reload

`packages/opencode/src/tool/reload.ts` and `tool/import.ts` already provide useful machinery for:

- file watching and poll fallback;
- content change detection;
- build-before-swap validation;
- fresh JS/TS module loading despite Bun pathname caching;
- atomic registry replacement;
- event publication.

The Custom Runtime should reuse the *patterns and low-level helpers* where appropriate, while
maintaining a separate private catalog.

### 6.4 `packages/codemode` already provides capability-surface machinery

`packages/codemode/src/tool-runtime.ts` already contains:

- schema-described functions;
- a nested `tools.*` shape;
- TypeScript signature rendering;
- bounded plain-data crossings;
- progressive discovery/search;
- tool call hooks and diagnostics.

This should be treated as reusable architecture. The Custom Runtime should avoid creating a second
incompatible concept of a typed capability tree.

### 6.5 `SessionTools.resolve` owns important execution semantics

`packages/opencode/src/session/tools.ts` currently performs important host-tool work around execution:

- model/provider schema transformation;
- construction of `Tool.Context`;
- permission resolution;
- cancellation tracking;
- plugin `tool.execute.before` / `tool.execute.after` hooks;
- attachments;
- metadata and completion updates;
- MCP tool adaptation.

Custom code that programmatically calls OpenCode tools must not bypass these semantics by invoking
arbitrary `Tool.Def.execute` closures ad hoc. A reusable internal invocation gateway should be
extracted.

## 7. Core architecture

```text
                              Model
                                |
                                | one stable tool schema
                                v
                         +--------------+
                         |    custom    |
                         +------+-------+
                                |
                         +------v-------+
                         | CustomRuntime |
                         | Control Plane |
                         +---+-------+---+
                             |       |
                     catalog |       | execution
                             |       |
                  +----------v-+   +-v-------------------+
                  | Custom     |   | Kernel Supervisor    |
                  | Catalog    |   +----+------------+----+
                  +-----+------+        |            |
                        |             JS/TS        Python
                 source/index           |            |
                        |                +------+-----+
                        |                       |
                        +-----------------------+
                                                |
                                      +---------v----------+
                                      | Capability Gateway |
                                      +----+----------+-----+
                                           |          |
                                      OpenCode/MCP   custom
                                      capabilities   functions
```

The architecture has six major subsystems:

1. `CustomTool` - one stable model-facing host tool.
2. `CustomCatalog` - discovery, metadata, indexing, scope resolution, and revision selection.
3. `CustomKernelManager` - lifecycle for session-local JS/TS and Python kernels.
4. `CustomRunner` - cold deterministic invocation of published functions.
5. `ToolInvocationGateway` - safe programmatic invocation of host capabilities.
6. `CustomStorage` - filesystem layout plus optional derived metadata/telemetry index.

## 8. One stable model-facing `custom` tool

### 8.1 Cache invariant

The `custom` tool definition must be stable across function creation, deletion, modification, and
discovery.

Do **not** put custom function names into:

- a JSON-Schema enum;
- the tool description;
- a generated system prompt catalog;
- a dynamic `ToolRegistry` list.

Otherwise each library mutation changes the provider prefix and partially defeats the feature.

The tool description should contain only stable instructions such as:

> Search, inspect, run, create, validate, and manage reusable custom functions. Use `search` before
> guessing a function name. Use shell for disposable OS/CLI work; use custom when code benefits from
> a persistent kernel or reusable implementation.

### 8.2 Proposed action surface

P0 model-facing actions:

```text
search       discover persistent functions
inspect      inspect one function's metadata/schema/files/status
call         invoke a published function
eval         execute an interactive JS/TS/Python cell in this session's kernel
kernel       inspect/reset/restart a kernel
create       scaffold a persistent function package
validate     validate/cold-start test a draft
publish      make a validated draft callable through `call`
disable      keep source but remove it from normal discovery/call
remove       delete/archive a custom function, permission-gated
```

`create` should scaffold. It should **not** accept a giant source-code blob as the normal editing
workflow. Once scaffolded, the agent should use OpenCode's ordinary `read`, `write`, `edit`, patch,
typecheck, symbols, and test machinery on the source files.

This keeps source editing in the infrastructure already optimized for source editing.

### 8.3 Example calls

```ts
custom({ action: "search", query: "sqlite schema foreign keys" })
```

```ts
custom({
  action: "call",
  name: "sqlite-symbol-correlator",
  input: { database: "./opencode.db", sourceRoot: "./packages" },
})
```

```ts
custom({
  action: "eval",
  runtime: "python",
  code: "rows = [x * x for x in range(20)]\nrows[-5:]",
})
```

```ts
custom({
  action: "create",
  name: "sqlite-symbol-correlator",
  runtime: "typescript",
  scope: "project",
})
```

The action schema itself stays constant even when the custom library changes.

## 9. Workbench vs Library

The Custom Runtime should have two conceptual personalities without creating two model tools.

### 9.1 Workbench

The Workbench is the Jupyter-like side:

- execute a cell;
- keep variables/imports/caches alive during the current session;
- inspect kernel state;
- reset/restart the kernel;
- experiment before deciding something deserves persistence.

Typical workflow:

```text
eval Python cell
  -> inspect result
  -> eval another cell using previous variables
  -> decide logic is reusable
  -> create package
  -> write implementation
  -> validate cold
  -> publish
```

### 9.2 Library

The Library is durable:

- filesystem-backed source;
- typed input/output contract;
- description/tags;
- revision identity;
- cold-start execution;
- cross-session discovery;
- usage/failure metadata.

The critical rule is:

> **Workbench state may disappear. Library functions must not depend on it.**

## 10. Kernel lifecycle and state model

### 10.1 Session-local warm kernels by default

Persistent *functions* should work across sessions. Persistent *REPL globals* should not be shared
across unrelated sessions by default.

Sharing one project-wide warm kernel among several concurrent sessions would create subtle races:

- one agent mutates a global used by another;
- imports or monkey patches leak across sessions;
- variable names collide;
- a kernel reset by one session destroys another session's work;
- reproducibility becomes impossible to reason about.

Recommended default:

```text
(sessionID, runtime, project/worktree) -> warm kernel
```

A session may have at most one JS/TS kernel and one Python kernel initially.

Published functions are project/global filesystem artifacts and are therefore discoverable from
other sessions, but their invocation does not depend on the creator's warm kernel.

### 10.2 Kernel states

```text
stopped
starting
ready
busy
interrupting
crashed
restarting
disposed
```

The control plane should expose state and last failure without leaking verbose process internals
into normal model context.

### 10.3 Kernel memory policy

Warm state may include:

- variables;
- imported modules;
- parsed data;
- DB handles;
- compiled regexes;
- helper functions;
- language runtime caches.

It must be understood as disposable. Kernel restart is always legal.

## 11. JavaScript/TypeScript runtime

JS and TS should be one runtime family with a language selector rather than completely separate
architectures.

### 11.1 Persistent package execution

Published TypeScript/JavaScript functions should execute in a dedicated child process, not by
`import()` directly into the OpenCode server process.

Reasons:

- agent-authored code can crash or mutate the host process;
- module globals and monkey patches would leak into OpenCode;
- `process.exit()` must not terminate OpenCode;
- memory and handle leaks need a process boundary;
- cancellation should be able to kill an execution process if graceful interruption fails.

### 11.2 Imports

Support normal module structure:

```text
.opencode/custom/ast-analyzer/
  custom.json
  package.json
  src/
    index.ts
    parser.ts
    schema.ts
    output.ts
```

Then ordinary imports work:

```ts
import { parse } from "./parser"
import ts from "typescript"
```

Single-file remains valid:

```text
.opencode/custom/slugs/
  custom.json
  index.ts
```

### 11.3 Interactive JS/TS kernel

The JS/TS Workbench needs an implementation spike because "real REPL semantics + TypeScript +
top-level await + persistent lexical state + ESM imports" is materially harder than invoking a
normal module.

Candidate implementation directions, in preferred evaluation order:

1. a dedicated Bun/Node kernel process with an explicit persistent context and transpilation layer;
2. Node REPL primitives plus a TypeScript transform;
3. a small cell compiler that rewrites top-level declarations into an explicit persistent scope;
4. reuse `@opencode-ai/codemode` for a confined non-importing scratch profile while native package
   execution handles durable imported code.

This must be spiked before locking P0 JS Workbench semantics. Durable package invocation is much
simpler and should not be blocked on perfect notebook-cell semantics.

## 12. Python runtime

### 12.1 Persistent interactive kernel

Python maps naturally onto the Jupyter-like model. A dedicated Python child process can maintain a
`globals` namespace and execute cells repeatedly.

The OpenFork host communicates with it over a small local RPC protocol. The Python process should
not require `ipykernel` for P0.

### 12.2 Persistent function packages

Example:

```text
.opencode/custom/data-profile/
  custom.json
  pyproject.toml
  src/
    data_profile/
      __init__.py
      main.py
      stats.py
      normalize.py
  tests/
    test_profile.py
```

Normal imports are allowed:

```py
from data_profile.stats import summarize
import sqlite3
```

and declared third-party imports may be installed through a permission-gated dependency workflow.

### 12.3 Interpreter resolution

Python availability is not guaranteed on every OpenCode host. The runtime should resolve in a
predictable order and report diagnostics rather than silently guessing forever.

Potential policy:

1. explicit Custom Runtime Python path in configuration;
2. active project virtual environment if explicitly opted into/discovered;
3. `python3`;
4. `python`;
5. Windows `py` launcher as platform fallback.

The exact resolver should be shared with any existing/future Python tooling rather than duplicated.

## 13. Dependencies and environments

### 13.1 Principle

Use language-native dependency manifests. Do not invent `custom.dependencies` as an alternate
package manager.

JS/TS:

```text
package.json
lockfile when present
node_modules/package-manager resolution
```

Python:

```text
pyproject.toml / requirements files as appropriate
virtual environment
```

### 13.2 External dependency installation is an effectful operation

Installing dependencies can:

- execute package install scripts;
- access the network;
- mutate the filesystem;
- change large dependency trees.

Therefore automatic installation should require a dedicated permission decision or flow, not occur
silently when `import foo` fails.

Suggested permission category:

```text
custom_dependency
```

Patterns can identify package/runtime/scope, for example:

```text
project:typescript:npm:@babel/parser
project:python:pypi:pandas
```

### 13.3 Environment granularity

Do not begin with one virtual environment per function unless measurements justify it. That would
create excessive disk and startup overhead.

Recommended first architecture:

- project-scoped JS dependency root;
- project-scoped Python environment;
- global functions may have a separate global environment;
- function manifests record dependency expectations;
- validation checks for dependency conflicts before publication.

If real conflicts become common, introduce content-addressed environments later without changing the
function or kernel interface.

## 14. Filesystem persistence model

### 14.1 Project scope

Default location:

```text
<worktree>/.opencode/custom/<function-name>/
```

Project scope is the default because:

- code can depend on the current repository;
- source can be reviewed and version-controlled;
- permissions naturally align with the project;
- there is less risk of accidentally leaking project-specific assumptions globally.

### 14.2 Global scope

Suggested location:

```text
~/.config/opencode/custom/<function-name>/
```

Global publication should be explicit because a global capability is available in unrelated future
projects.

### 14.3 Source of truth

The filesystem is authoritative for:

- manifest;
- source files;
- tests;
- package metadata;
- optional readme/reference files.

SQLite may cache/index:

- normalized catalog entries;
- usage count;
- last-used time;
- recent failure stats;
- content hashes;
- search index/FTS data.

If the index is deleted, it must be reconstructable from disk.

## 15. Function package and manifest

### 15.1 Example TypeScript manifest

```json
{
  "version": 1,
  "name": "sqlite-symbol-correlator",
  "description": "Correlate SQLite schema objects with symbols in a TypeScript source tree.",
  "runtime": "typescript",
  "entry": "src/index.ts",
  "export": "run",
  "status": "ready",
  "tags": ["sqlite", "typescript", "analysis"],
  "inputSchema": {
    "type": "object",
    "properties": {
      "database": { "type": "string" },
      "sourceRoot": { "type": "string" }
    },
    "required": ["database", "sourceRoot"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object"
  }
}
```

### 15.2 Example Python manifest

```json
{
  "version": 1,
  "name": "data-profile",
  "description": "Profile a tabular dataset and return compact anomaly statistics.",
  "runtime": "python",
  "entry": "src/data_profile/main.py",
  "export": "run",
  "status": "ready",
  "tags": ["data", "statistics"]
}
```

### 15.3 Manifest should describe the callable contract, not implementation trivia

Do not duplicate package manager details into the manifest. Keep dependency details in native
language files.

Fields likely worth standardizing:

```text
version
name
description
runtime
entry
export
status
tags
inputSchema
outputSchema
executionProfile (future)
```

## 16. Catalog and progressive discovery

### 16.1 Catalog entry

Normalized in-memory representation:

```ts
type CustomFunctionInfo = {
  name: string
  scope: "project" | "global"
  runtime: "javascript" | "typescript" | "python"
  description: string
  tags: string[]
  inputSchema?: JsonSchema
  outputSchema?: JsonSchema
  status: "draft" | "ready" | "disabled" | "broken"
  root: string
  entry: string
  revision: string
}
```

### 16.2 Discovery

`custom.search` should search at least:

- name;
- description;
- tags;
- input property names/descriptions;
- output description when useful;
- runtime;
- usage recency as a weak ranking signal.

Search should return compact entries first. `inspect` provides complete schemas and file details only
for candidates the model actually cares about.

This is the same progressive-disclosure principle already present in `packages/codemode`.

### 16.3 Scope precedence

If project and global scopes contain the same name, project should win by default. Search/inspect
must expose the scope explicitly, and callers should be able to qualify a function when needed.

Potential qualified form:

```text
project:sqlite-analyzer
global:sqlite-analyzer
```

## 17. Revision and publication semantics

### 17.1 Revisions

Compute a content-derived revision from the manifest plus relevant source/dependency metadata.

Example logical identity:

```text
sqlite-analyzer@sha256:abc123...
```

Normal model calls use the current ready revision by name.

An in-flight call pins the resolved revision at invocation start. Editing files while a call is
running must not silently replace code underneath that invocation.

This mirrors the useful invariant OpenFork already has for registry hot reload: in-flight execution
uses the definition it captured; subsequent resolution sees the new definition.

### 17.2 Draft -> validate -> ready

Recommended lifecycle:

```text
create
  -> draft
edit source
  -> draft
validate
  -> validated draft
publish
  -> ready
```

For low ceremony, `validate` may support `publish: true`, but validation itself must remain a real
cold-start check rather than merely trusting the warm Workbench.

### 17.3 Validation gates

At minimum:

- manifest parses;
- runtime/entry/export resolve;
- input/output schemas are valid enough for the supported contract;
- dependencies resolve;
- entrypoint loads in a fresh process/environment;
- exported function is callable;
- a no-op/smoke invocation can be run when the schema permits or when an explicit test fixture is
  provided;
- process exits/cleans up correctly after cold test.

## 18. Capability gateway - the key integration primitive

The Custom Runtime becomes much more powerful if JS/TS/Python code can call existing OpenFork tools
as ordinary functions.

Example TypeScript:

```ts
const schema = await tools.sqlite({
  action: "schema",
  path: input.database,
})

const symbols = await tools.symbols({
  action: "search",
  query: input.name,
})

return correlate(schema, symbols)
```

Example Python:

```py
schema = await tools.sqlite({
    "action": "schema",
    "path": input["database"],
})

symbols = await tools.symbols({
    "action": "search",
    "query": input["name"],
})

return correlate(schema, symbols)
```

### 18.1 Extract `ToolInvocationGateway`

Do not implement this by directly calling random `Tool.Def.execute` functions from each runtime.

Extract a reusable host service from the semantics currently concentrated in `SessionTools.resolve`
and `tool/code-mode.ts`.

Conceptual API:

```ts
interface ToolInvocationGateway {
  catalog(ctx: InvocationContext): Effect<CapabilityCatalog>

  invoke(input: {
    kind: "builtin" | "mcp" | "custom"
    name: string
    args: unknown
    parentCallID?: string
    depth: number
  }, ctx: InvocationContext): Effect<InvocationResult>
}
```

It must preserve:

- permission checks;
- plugin before/after hooks;
- cancellation;
- child call IDs;
- tracing;
- tool result conversion;
- attachments;
- truncation policy;
- metadata/progress where appropriate.

Then both Code Mode and Custom Runtime can consume the same gateway.

### 18.2 Capability bindings

Kernels should not receive raw credentials or host service objects. They receive RPC-backed
bindings/proxies.

JS/TS conceptual shape:

```ts
tools.read(...)
tools.sqlite(...)
tools.mcp.weather.current(...)
custom.call("other-function", ...)
```

Python can expose an analogous async proxy object.

## 19. Kernel RPC protocol

Do not adopt the full Jupyter wire protocol in P0. OpenFork needs a much smaller local protocol.

Recommended transport:

- dedicated child process;
- stdio pipes;
- framed JSON or JSON Lines with request IDs;
- explicit protocol version;
- host -> kernel calls and kernel -> host reverse calls.

### 19.1 Host -> kernel example

```json
{
  "v": 1,
  "id": "req_42",
  "method": "function.invoke",
  "params": {
    "root": "C:/repo/.opencode/custom/sqlite-analyzer",
    "entry": "src/index.ts",
    "export": "run",
    "input": { "path": "opencode.db" },
    "revision": "abc123"
  }
}
```

### 19.2 Reverse capability call

```json
{
  "v": 1,
  "id": "kernel_7",
  "method": "capability.invoke",
  "params": {
    "name": "sqlite",
    "input": { "action": "schema", "path": "opencode.db" }
  }
}
```

The host resolves permission and lifecycle semantics, returns a data-safe result, and keeps the
kernel away from internal Effect service objects.

### 19.3 Required protocol features

- request IDs;
- protocol version;
- structured errors;
- stdout/stderr/log events separate from final value;
- cancellation/interrupt;
- process health/heartbeat or equivalent liveness detection;
- reverse RPC for capability calls;
- attachment references rather than huge inline blobs where possible;
- bounded message size;
- explicit shutdown.

## 20. Recursion, cycles, and nested custom calls

Custom functions should be able to call other custom functions, but recursion needs explicit
protection.

Track an invocation stack:

```text
A -> B -> C      allowed
A -> B -> A      cycle diagnostic
```

Recommended initial limits:

- maximum nested custom depth: 8;
- maximum total gateway calls per top-level invocation: configurable/bounded;
- propagate the same abort signal through the entire tree.

The exact numeric defaults should be benchmarked, but the architecture must include these limits
from the beginning.

## 21. Security and permission model

### 21.1 Native runtime is not a magic sandbox

This distinction must be explicit in code and UX.

A real Node/Bun/Python process with ordinary imports can generally access filesystem/network/process
APIs unless the operating system sandbox prevents it. Process isolation protects the OpenCode host
from many crashes and global mutations, but **does not by itself enforce OpenCode's fine-grained
tool permissions**.

Do not market or label native custom execution as "confined" unless an actual cross-platform
sandbox exists.

### 21.2 Execution permission

Treat native custom code as at least shell-equivalent in trust.

Suggested dedicated permission:

```text
custom_execute
```

Patterns can be precise:

```text
project:typescript:sqlite-analyzer
project:python:data-profile
global:python:csv-normalizer
```

A user may allow a known persistent function without globally allowing arbitrary shell commands.

### 21.3 Capability calls still enforce their own permissions

When custom code uses the capability gateway, the called capability's permission must still be
evaluated. `custom_execute` must not become an implicit permission bypass for `git`, external
directories, MCP writes, etc.

### 21.4 Future execution profiles

The manifest may eventually support:

```text
executionProfile: native | confined
```

But do not block P0 on solving a perfect Windows/macOS/Linux sandbox. Start with honest native-code
permissions and a process boundary.

## 22. Shell vs Custom policy

The model needs a crisp behavioral boundary to prevent overuse.

Recommended stable tool-description guidance:

### Use shell when

- running a build/test/lint command;
- invoking an existing CLI once;
- checking a process/environment value;
- performing disposable filesystem automation;
- a tiny script will be used once and discarded;
- there is no value in retaining state or implementation.

### Use custom Workbench when

- interactive Python/JS exploration is faster than repeated shell calls;
- intermediate data should remain in a warm runtime;
- programmatic composition of several OpenCode capabilities is useful;
- parsing/filtering should happen outside model context.

### Create/publish a custom function when

- the logic has already been repeated or is clearly likely to repeat;
- implementation is nontrivial enough that regenerating it wastes tokens/time;
- imports or helper modules improve correctness;
- it provides a stable abstraction over several lower-level tools;
- it is useful across turns/sessions.

### Anti-pattern

Do not create a persistent custom function merely to run:

```text
2 + 2
git status
ls
npm test
```

## 23. Output and context discipline

One of the most important benefits of programmatic execution is keeping intermediate data out of
the LLM context.

Therefore:

- intermediate gateway results should stay inside the kernel unless code chooses to return them;
- stdout/stderr should be bounded;
- returned values should cross a JSON/data-safe boundary;
- large outputs should use OpenFork's existing truncation/output-file machinery;
- attachments should use the existing attachment channel;
- nested capability call metadata may be shown in UI without dumping every result into the model's
  textual context.

The Custom Runtime should be measured partly by **context bytes avoided**, not merely execution
speed.

## 24. Observability and auditability

Every invocation should record enough information to debug agent-authored tooling:

- function name/scope/runtime/revision;
- session/message/call ID;
- cold vs warm execution;
- start/end/duration;
- outcome;
- child capability names and durations;
- exit/crash/timeout reason;
- truncation/output path;
- kernel restart count;
- optionally peak RSS when cheaply measurable.

Do not store all source or full inputs in telemetry by default. Source already exists on disk and
inputs may be sensitive.

## 25. Usage intelligence without prompt bloat

The system may maintain derived statistics such as:

- call count;
- last used;
- success/failure rate;
- average runtime;
- whether a function was created but never reused.

These are valuable for ranking search results and identifying misuse.

Example diagnostic metric:

```text
functions created: 40
functions called more than once: 7
```

If reuse is low, the model guidance is too eager to publish scratch work.

This should influence search/ranking and later evaluation, not be injected wholesale into the
system prompt.

## 26. UI/UX direction

The initial feature can be model-first, but the tool-call UI should preserve nested execution
clarity.

Suggested `custom` call presentation:

```text
Custom · sqlite-symbol-correlator
TypeScript · project · abc123

  sqlite        completed  42 ms
  symbols       completed  18 ms

Completed in 91 ms
```

Workbench calls:

```text
Custom · Python kernel
Session kernel · warm

>>> rows[-5:]
[225, 256, 289, 324, 361]
```

Avoid dumping internal RPC chatter into the chat transcript. Existing Code Mode child-call metadata
is a useful precedent.

## 27. Proposed module layout

There is already a `packages/opencode/src/tool/custom.ts`, so the model-facing `custom` tool should
**not** be implemented by replacing or overloading that file. Preserve the existing custom-tool
conversion helper and create a distinct runtime namespace.

Suggested code shape:

```text
packages/opencode/src/
  custom-runtime/
    index.ts
    service.ts                 # CustomRuntime control-plane service
    catalog.ts                 # scan/index/search/resolve/scope precedence
    manifest.ts                # schema + parsing
    storage.ts                 # project/global roots
    revision.ts                # content identity
    validation.ts              # cold validation/publish gate
    kernel-manager.ts          # session-local kernel lifecycle
    protocol.ts                # versioned host/kernel RPC messages
    invocation.ts              # published function invocation orchestration
    runtime/
      js.ts                    # JS/TS runner/kernel adapter
      python.ts                # Python runner/kernel adapter
    gateway/
      bindings.ts              # kernel-facing capability proxies
      recursion.ts             # stack/depth/cycle controls

  tool/
    custom-runtime-tool.ts     # Tool.define("custom", ...)
    custom.ts                  # EXISTING file-backed top-level tool conversion

  session/
    tool-invocation-gateway.ts # extracted common invocation semantics
```

Potential package split later:

```text
packages/custom-runtime/
```

only if the runtime becomes useful independently of `packages/opencode`. Do not prematurely create
another package before service boundaries are proven.

## 28. Service interfaces

### 28.1 `CustomCatalog`

```ts
interface CustomCatalog {
  list(input?: CatalogFilter): Effect<readonly CustomFunctionInfo[]>
  search(query: SearchInput): Effect<SearchResult>
  get(ref: CustomFunctionRef): Effect<CustomFunctionInfo | undefined>
  refresh(): Effect<CatalogDiff>
}
```

### 28.2 `CustomKernelManager`

```ts
interface CustomKernelManager {
  executeCell(input: {
    sessionID: SessionID
    runtime: "javascript" | "typescript" | "python"
    code: string
  }): Effect<CellResult>

  status(input: KernelRef): Effect<KernelStatus>
  interrupt(input: KernelRef): Effect<void>
  restart(input: KernelRef): Effect<void>
  disposeSession(sessionID: SessionID): Effect<void>
}
```

### 28.3 `CustomRuntime`

```ts
interface CustomRuntime {
  create(input: CreateInput): Effect<CustomFunctionInfo>
  validate(input: ValidateInput): Effect<ValidationResult>
  publish(input: PublishInput): Effect<CustomFunctionInfo>
  invoke(input: InvokeInput, ctx: Tool.Context): Effect<Tool.ExecuteResult>
}
```

### 28.4 Kernel adapter

```ts
interface CustomKernelAdapter {
  readonly runtime: "javascript" | "typescript" | "python"
  start(input: KernelStart): Effect<KernelHandle>
  executeCell(handle: KernelHandle, input: CellInput): Effect<CellResult>
  invoke(handle: KernelHandle, input: FunctionInvocation): Effect<FunctionResult>
  interrupt(handle: KernelHandle): Effect<void>
  dispose(handle: KernelHandle): Effect<void>
}
```

## 29. Events

Candidate events:

```text
custom.catalog.changed
custom.function.published
custom.function.disabled
custom.kernel.started
custom.kernel.restarted
custom.kernel.crashed
```

Do not add event types merely for completeness. P0 needs only events consumed by a real UI/client or
required for lifecycle observability.

The existing `ToolEvent.Reloaded` should remain about provider-visible tool registry reloads. Custom
library changes are deliberately a different concept because they do not change the top-level tool
catalog.

## 30. Interaction with current tool hot reload

The current hot-reload system remains correct for `.opencode/tool(s)` and plugins.

Custom Runtime adds a separate watcher/index path for `.opencode/custom`.

Important distinction:

```text
.opencode/tools/foo.ts changes
  -> ToolRegistry refresh
  -> provider-visible tool set may change
  -> tool.reloaded event

.opencode/custom/foo/** changes
  -> CustomCatalog refresh
  -> provider-visible tool set DOES NOT change
  -> custom catalog/revision changes only
```

This separation is a fundamental cache invariant and should be covered by regression tests.

## 31. Interaction with Code Mode

Do not delete Code Mode as part of P0.

Instead, extract common primitives so the two systems converge architecturally:

```text
                     ToolInvocationGateway
                      /                 \
              Code Mode              Custom Runtime
                 |                       |
       confined one-shot JS       JS/TS + Python kernels
                                  persistent function library
```

Potential later outcomes:

- Code Mode remains the safest cheap one-shot orchestration runtime.
- Custom Runtime uses Code Mode as a `confined` execution profile for functions that do not need
  native imports.
- Both share capability catalog/search/signature rendering.

Do not prematurely force one to replace the other before real usage data exists.

## 32. Failure modes and required behavior

| Failure | Required behavior |
|---|---|
| Python is unavailable | `custom` returns a precise interpreter diagnostic; JS/TS remains usable |
| JS/TS kernel crashes | mark kernel crashed, preserve OpenCode host, allow restart, fail current cell only |
| Python kernel crashes | same; no host-process failure |
| function syntax/import error | function remains draft/broken; last ready revision remains callable if one exists |
| edit occurs during invocation | running call stays pinned to captured revision; next call resolves new ready revision only after validation/publication |
| dependency missing | validation fails with actionable dependency diagnostic; never silently install |
| dependency install denied | leave source unchanged and function draft/broken; report denied operation |
| invalid manifest | exclude from ready catalog; surface in inspect/diagnostics rather than crashing catalog scan |
| duplicate project/global name | project wins; scope exposed; qualified lookup resolves either |
| recursive custom cycle | fail with explicit invocation path, e.g. `A -> B -> A` |
| nested call depth exceeded | fail child invocation, unwind normally |
| huge stdout/result | truncate/spill through existing output store |
| abort | propagate to child capability calls, then interrupt/kill kernel execution if needed |
| kernel ignores interrupt | hard-kill after grace period and restart lazily |
| custom source deleted | remove from catalog; in-flight captured revision behavior must be defined by staging strategy |
| global function assumes wrong project | normal execution/permission failure; project-specific functions should not be auto-promoted globally |
| model creates many never-reused functions | telemetry exposes low reuse; guidance/search policy can be tuned |

## 33. Staging and in-flight revision safety

To truly guarantee that a running invocation cannot observe partially edited source, a function call
should not execute directly against mutable source paths after revision resolution.

Two viable strategies:

### Option A - content-addressed staging (recommended)

On publish/first invocation of a revision:

```text
source package
  -> validate
  -> stage immutable revision under cache/data directory
  -> invoke staged root
```

Pros:

- strong in-flight immutability;
- source can continue being edited immediately;
- revision hash has concrete meaning;
- same staged revision can be reused.

Cons:

- cache cleanup needed;
- dependency handling must avoid enormous copies.

### Option B - build/package artifact

For TS/JS, a content-addressed bundle can naturally be immutable. Python is less naturally bundled,
so staging still tends to be simpler across both runtime families.

P0 spike should compare startup and disk costs before settling the exact mechanism.

## 34. Testing strategy

### 34.1 Catalog/cache tests

- creating a custom function does not change `ToolRegistry.ids()`;
- creating 100 custom functions still exposes exactly one `custom` host tool;
- search sees newly created functions without provider-tool refresh;
- project scope shadows global scope deterministically;
- invalid manifests do not poison the catalog;
- disabled functions are excluded from normal search/call but remain inspectable.

### 34.2 Runtime tests

- JS single-file call;
- TS single-file call;
- JS/TS multi-file relative import;
- JS/TS external dependency import;
- Python single-file call;
- Python package relative/absolute local import;
- Python third-party dependency import;
- warm cell state survives multiple cells in one session;
- warm state does not leak into another session;
- kernel restart clears Workbench state;
- published function works after a cold restart;
- timeout/abort kills or interrupts correctly;
- runtime crash never crashes OpenCode.

### 34.3 Capability gateway tests

- JS custom code calls a builtin tool;
- Python custom code calls a builtin tool;
- custom code calls MCP through gateway;
- nested child call preserves permission checks;
- plugin before/after hooks fire once;
- child attachments propagate correctly;
- abort propagates through nested calls;
- recursive custom cycle rejected;
- max-depth rejected;
- large intermediate results remain out of model-facing output unless returned.

### 34.4 Permission tests

- native custom execution asks/denies correctly;
- project/global patterns differ;
- calling a permitted custom function does not imply permission for every gateway child capability;
- dependency installation has independent permission;
- global function requires appropriate execution approval in a new project.

### 34.5 Context/cache tests

This deserves explicit automated coverage.

Snapshot the provider-facing tool definitions before and after:

- create;
- edit;
- publish;
- disable;
- delete;
- create 100 additional functions.

The `custom` host-tool schema/description must remain byte-for-byte stable.

## 35. Performance targets

Benchmarks should measure at least:

- cold JS/TS kernel startup;
- warm JS/TS cell latency;
- cold Python kernel startup;
- warm Python cell latency;
- cold published function invocation;
- warm published function invocation;
- catalog scan for 10 / 100 / 1,000 functions;
- search latency for 1,000 functions;
- reverse-RPC overhead per capability call;
- memory per warm kernel;
- process cleanup after session disposal;
- provider tool-definition bytes with 0 vs 1,000 custom functions;
- context bytes avoided in representative programmatic pipelines.

Initial qualitative targets:

- catalog search should feel effectively instant;
- a warm kernel call should add little enough overhead that the model will prefer it for genuinely
  programmatic tasks;
- adding functions should have approximately zero provider tool-schema growth;
- idle kernels must not accumulate without lifecycle cleanup.

## 36. Phased implementation plan

### P0A - architecture spikes

Before broad implementation, resolve the genuinely uncertain mechanisms with small spikes.

1. **JS/TS Workbench spike**
   - persistent cells;
   - top-level await;
   - imports;
   - TypeScript transpilation;
   - state retention;
   - cancellation.
2. **Python kernel spike**
   - persistent `globals`;
   - async host reverse calls;
   - interrupt/kill semantics on Windows/Linux/macOS where available.
3. **RPC spike**
   - bidirectional framed JSON over stdio;
   - nested reverse calls;
   - cancellation;
   - bounded logs/results.
4. **Immutable revision spike**
   - compare staged source trees vs build artifacts;
   - measure cold/warm cost.

Exit criterion: the runtime contract is proven for both languages before production service wiring.

### P0B - stable `custom` catalog + filesystem library

Implement without host-tool bindings first.

1. Add manifest schema and project/global storage roots.
2. Add `CustomCatalog` scan/search/inspect and scope precedence.
3. Add stable `Tool.define("custom", ...)` with `search`, `inspect`, `create`, `validate`,
   `publish`, `call` actions.
4. Ensure `.opencode/custom` never enters `ToolRegistry`.
5. Add watcher/poll refresh using proven `ToolReload` patterns.
6. Add content revision identity.
7. Add JS/TS and Python cold invocation adapters.
8. Add permission-gated native execution.
9. Add context/cache invariance tests.

At the end of P0B, persistent multi-file JS/TS and Python functions exist and survive sessions even
if interactive Workbench semantics are still limited.

### P0C - Jupyter-like Workbench

1. Add session-local JS/TS kernel manager.
2. Add session-local Python kernel manager.
3. Add `custom action:"eval"`.
4. Add kernel status/reset/restart/interrupt.
5. Dispose kernels with session/instance lifecycle.
6. Add warm-state isolation tests across sessions.

### P1 - capability gateway

This is the major power multiplier.

1. Extract `ToolInvocationGateway` from `SessionTools.resolve` / Code Mode child invocation logic.
2. Move Code Mode to the shared gateway without changing behavior.
3. Add reverse RPC from JS/TS kernel to gateway.
4. Add reverse RPC from Python kernel to gateway.
5. Add nested custom -> custom calls with cycle/depth controls.
6. Preserve child call metadata/attachments/plugin hooks/permissions.
7. Generalize progressive capability catalog/signature rendering from `packages/codemode`.

### P2 - dependencies and environment management

1. Implement explicit dependency diagnostics.
2. Add permission-gated install/update actions.
3. Add project JS dependency environment.
4. Add project Python environment.
5. Add global environments.
6. Add conflict diagnostics and environment fingerprints.
7. Decide whether content-addressed environments are justified by real conflicts/performance.

### P3 - premium management UX

1. Custom Runtime/library panel in app/TUI as justified.
2. Search/browse functions and scopes.
3. Runtime/status/revision badges.
4. Open source location.
5. Disable/delete/promote-to-global controls.
6. Kernel status/restart controls.
7. Usage/failure statistics.
8. Nested capability-call visualization.

### P4 - optional confinement and additional runtimes

Only after JS/TS + Python usage validates the architecture:

- confined execution profile;
- OS-specific sandboxing research;
- additional runtimes if there is real demand;
- remote/isolated kernels if useful;
- potential Jupyter-protocol interoperability, but only if a concrete feature needs it.

## 37. Concrete first implementation files

Likely first production changes after spikes:

```text
NEW  packages/opencode/src/custom-runtime/manifest.ts
NEW  packages/opencode/src/custom-runtime/storage.ts
NEW  packages/opencode/src/custom-runtime/catalog.ts
NEW  packages/opencode/src/custom-runtime/revision.ts
NEW  packages/opencode/src/custom-runtime/service.ts
NEW  packages/opencode/src/custom-runtime/protocol.ts
NEW  packages/opencode/src/custom-runtime/kernel-manager.ts
NEW  packages/opencode/src/custom-runtime/runtime/js.ts
NEW  packages/opencode/src/custom-runtime/runtime/python.ts
NEW  packages/opencode/src/tool/custom-runtime-tool.ts

EDIT packages/opencode/src/tool/registry.ts
     - register exactly one `custom` builtin host tool
     - do NOT register library members

EDIT packages/opencode/src/effect/runtime-flags.ts
     - initial experimental feature flag

EDIT packages/opencode/src/effect/app-runtime.ts / relevant layer root
     - wire CustomRuntime services

TEST packages/opencode/test/custom-runtime/*
TEST packages/opencode/test/tool/registry.test.ts
     - cache/catalog invariance
```

P1 then introduces:

```text
NEW  packages/opencode/src/session/tool-invocation-gateway.ts
EDIT packages/opencode/src/session/tools.ts
EDIT packages/opencode/src/tool/code-mode.ts
EDIT packages/opencode/src/custom-runtime/*
```

## 38. Feature flag and rollout

Initial flag:

```text
OPENCODE_EXPERIMENTAL_CUSTOM_RUNTIME
```

Do not piggyback this on `OPENCODE_EXPERIMENTAL_CODE_MODE`. The features have different lifecycle,
security, persistence, and runtime implications.

Recommended rollout:

1. dev-only flag;
2. dogfood JS/TS + Python package invocation;
3. add Workbench;
4. measure tool creation/reuse/context impact;
5. add gateway;
6. only then consider default-on or non-experimental status.

## 39. Evaluation scenarios

The feature should be evaluated on real workflows, not toy `add(a,b)` tools.

### Scenario A - SQLite structural analysis

Agent repeatedly needs to inspect OpenCode's SQLite DB, join several tables, and summarize only
anomalies.

Expected progression:

```text
Python Workbench exploration
  -> useful query/normalization logic emerges
  -> publish sqlite-session-audit
  -> later sessions discover/call it
```

Measure context bytes vs repeated `sqlite` tool calls and model-side aggregation.

### Scenario B - TypeScript AST analysis

Agent needs a custom project-specific structural query not handled by `symbols`.

Expected solution:

- multi-file TypeScript custom function;
- imports TypeScript/tree-sitter package as appropriate;
- returns compact findings;
- persists for later refactors.

### Scenario C - custom composition over host tools

Agent needs to correlate Git history, symbols, and SQLite metadata.

Expected solution:

- custom function calls gateway-backed `git`, `symbols`, and `sqlite` functions;
- filters/intersects data inside kernel;
- only final correlation enters model context.

### Scenario D - one-off command

User asks to run `git status`.

Expected behavior: agent uses `shell` or `git`, **not** Custom Runtime.

This scenario is as important as the success scenarios because it tests overuse prevention.

## 40. Architectural decisions to lock now

These are strong enough to decide before implementation:

1. **One provider-visible `custom` tool.**
2. **Custom library members never join `ToolRegistry`.**
3. **JS/TS and Python are the first-class runtime families.**
4. **One logical function has one entrypoint, not one file. Multi-file imports are supported.**
5. **Filesystem source is authoritative.**
6. **Warm Workbench state is session-local by default.**
7. **Published functions must cold-start independently of Workbench globals.**
8. **Native runtime processes are isolated from the OpenCode host process.**
9. **Native process isolation is not misrepresented as a security sandbox.**
10. **Language-native package/dependency manifests remain authoritative.**
11. **Capability calls go through one shared host invocation gateway.**
12. **Provider tool schema remains byte-stable as the custom library changes.**
13. **Project scope is the default; global promotion is explicit.**
14. **Shell remains the preferred disposable execution primitive.**

## 41. Open questions requiring spikes or product evidence

### Q1 - JS/TS Workbench semantics

Which implementation gives the best combination of:

- top-level await;
- TypeScript;
- persistent variables;
- normal imports;
- interruption;
- predictable lexical semantics?

Do not settle this by intuition. Spike it.

### Q2 - immutable revision staging

Should ready revisions be:

- copied/staged source trees;
- bundled artifacts where possible;
- another content-addressed representation?

Need measurements across JS/TS and Python.

### Q3 - dependency environment scope

Is one project environment sufficient in practice, or do conflicting tools require isolated
content-addressed environments?

Start shared; measure conflicts.

### Q4 - Workbench persistence beyond session

Should a user optionally pin a kernel across sessions? Default answer is **no** because hidden shared
state and concurrency risks are substantial. Revisit only with a concrete UX requirement.

### Q5 - publication ceremony

Should `validate` automatically publish on success, or should ready-state promotion remain explicit?

The model UX should be low ceremony, but accidental publication of scratch code is also a real
failure mode. Dogfood both flows.

### Q6 - custom code direct OS access

P0 native execution is shell-equivalent in trust. Later research can evaluate meaningful OS
confinement profiles. Do not delay the core feature while pretending a weak pseudo-sandbox is safe.

## 42. Success criteria

The architecture is successful when all of the following are true:

- an agent can create a real multi-file TypeScript custom function with imports;
- an agent can create a real multi-file Python custom function with imports;
- both functions survive OpenCode restart and are callable in later sessions;
- creating them does not alter the provider-visible tool catalog beyond the already-present stable
  `custom` tool;
- the agent can discover a relevant function without having the entire library in context;
- a published function works from a cold process and does not depend on hidden REPL state;
- JS/TS/Python crashes do not crash OpenCode;
- nested host capability calls preserve OpenCode permissions and lifecycle hooks;
- intermediate programmatic results can remain outside the LLM context;
- shell remains the chosen primitive for disposable commands;
- real repeated workflows become cheaper in tokens and/or tool round trips after promotion to a
  custom function.

## 43. Final product principle

The feature should not make the agent's prompt carry an ever-growing belt of tools.

It should give the agent a **persistent programmable environment** in which it can build its own
abstractions, retain the abstractions that prove useful, search them on demand, and execute them in
the language best suited to the task.

The shortest expression of the design is:

> **Do not keep giving the agent more tools. Give it a runtime in which it can build and retain the
> tools it actually needs.**
