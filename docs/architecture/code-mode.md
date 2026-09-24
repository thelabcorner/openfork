# Code Mode

> Status: **adopted OpenFork architecture**.
>
> OpenFork uses the upstream `@opencode-ai/codemode` implementation as its
> default MCP orchestration path. This document defines the fork-owned product
> contract around that donor implementation.

## Product contract

Code Mode is **not an agent mode and not a session state**. Agents do not enter
or leave it. It is a provider-tool exposure strategy:

- ordinary OpenFork native tools remain direct provider-visible tools;
- connected MCP tools are removed from the ordinary provider manifest;
- one provider-visible `execute` tool exposes those MCP capabilities through a
  confined JavaScript orchestration runtime;
- the model may freely alternate between direct native tools and `execute`
  across turns;
- permissions, plugin hooks, cancellation, external authority, and side-effect
  policy remain owned by OpenFork and the underlying leaf tools.

Conceptually:

```text
agent
  |- read / find / shell / edit / write / git / task / ...   (direct)
  `- execute                                                 (Code Mode)
       `- confined program
            |- tools.<mcp-server>.<tool>(...)
            `- $codemode.search(...)
```

There is no transition ceremony. A model can call `read`, then `execute`,
then `edit`, then `execute` again as ordinary tool selection.

## Default and opt-out

OpenFork enables Code Mode by default.

The retained upstream compatibility flag is an explicit opt-out:

```text
OPENCODE_EXPERIMENTAL_CODE_MODE=false
```

Setting it to `false` restores direct MCP tool exposure. Explicit `true`
continues to work. The historical `EXPERIMENTAL` spelling is retained to
minimize upstream divergence; it does not describe OpenFork product status.

## Why this is the default

The architecture follows the Cloudflare-style code-as-orchestration model and
the current upstream OpenCode implementation:

1. keep the provider-visible tool surface small;
2. use a confined program to sequence, branch, filter, aggregate, and run
   independent tool calls concurrently;
3. keep large intermediate results inside the program;
4. return only the result the agent needs;
5. progressively disclose large catalogs through a budgeted inline catalog plus
   `$codemode.search`.

This reduces provider context consumed by large MCP catalogs and removes model
round-trips between every dependent MCP call.

## Boundaries

Code Mode is an orchestration language, **not** a general JavaScript runtime.

It does not provide ambient filesystem, process, environment, network,
credential, module/import, npm, or application authority. External work must
flow through supplied tools.

Direct OpenFork native tools are intentionally **not** ambient globals inside
Code Mode. The fork follows upstream's separation:

```text
native OpenFork capabilities -> direct tools
MCP/deferred capabilities    -> execute / Code Mode
```

Do not expand Code Mode into a second shell, persistent REPL, Python kernel, or
agent-authored package system without a new architecture decision.

## Discovery and execution

The model receives a token-budgeted catalog. When the complete MCP catalog does
not fit, Code Mode keeps namespaces discoverable and exposes
`$codemode.search` for exact paths and signatures.

Independent calls should be started together and awaited with `Promise.all`
where appropriate. The runtime currently bounds nested call concurrency and
supervises unfinished calls before successful completion.

Nested leaf calls continue to use OpenFork permission checks and plugin
lifecycle hooks. Code Mode must never become a privilege escalation path.

## OpenFork integration ownership

The generic confined interpreter is owned by:

- `packages/codemode/**`

The V1/OpenFork adapter is owned by:

- `packages/opencode/src/tool/code-mode.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/session/tools.ts`
- `packages/opencode/src/effect/runtime-flags.ts`

OpenFork's V1 runtime remains the production integration target. Upstream
current/V2 is a semantic and implementation donor; future upstream Code Mode
improvements should be selectively backported without forcing a V1 retirement
or local API migration.

## Superseded Custom Runtime proposal

The former `docs/architecture/custom-runtime.md` and
`docs/architecture/custom-runtime-review.md` proposals explored persistent
agent-authored functions, warm JS/Python kernels, and a `custom` meta-tool.
That direction is **superseded**.

The adopted architecture intentionally stops at upstream/Cloudflare-style Code
Mode. Persistent agent-created runtime libraries are not part of the product
plan.
