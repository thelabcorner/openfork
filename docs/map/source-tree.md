# Source-tree lookup

Use this as a “where do I start?” index. It is intentionally oriented around ownership,
not exhaustive file enumeration.

## Top-level

```text
AGENTS.md             repository architecture contract
FORK.md               fork/upstream ownership + merge policy
keep-manifest.json    machine-readable keep/prune policy
package.json          workspace composition

packages/             product/runtime packages
script/               repository automation + fork sync
patches/              dependency patches
extensions/           client extensions
benchmarks/           reusable benchmark harnesses
experiments/          prototypes / experimental evidence
docs/                 documentation
.opencode/            repo-local OpenCode configuration/tools/agents
```

## “I need to change …”

| Concern | Start here |
| --- | --- |
| Main GUI / session page / project explorer / settings | `packages/app/src` |
| Shared session/message rendering | `packages/session-ui/src` |
| Shared visual primitives | `packages/ui/src` |
| Electron windows/native integration/IPC | `packages/desktop/src/main`, `src/preload` |
| Desktop renderer host glue | `packages/desktop/src/renderer` |
| Built-in browser authority | `packages/desktop/src/main/browser` and fork browser surfaces in app |
| Browser visual capture support | `packages/browser-visual/src` |
| Mobile client | `packages/mobile/src` |
| Current durable session/domain behavior | `packages/core/src/session` |
| Current built-in tool contracts | `packages/core/src/tool` |
| Durable DB schema/migrations | `packages/core/src/**/*.sql.ts`, `packages/core/src/database` |
| V1 session/prompt execution | `packages/opencode/src/session` |
| V1/fork-rich tools | `packages/opencode/src/tool` |
| Full local HTTP API composition | `packages/opencode/src/server/routes/instance/httpapi` |
| Shared current API contract | `packages/protocol/src` |
| Shared server middleware/handlers | `packages/server/src` |
| Generated Protocol client | `packages/client` |
| Generated unified OpenCode SDK | `packages/sdk/js` |
| Provider wire protocols | `packages/llm/src` |
| Shared browser-safe schemas/IDs | `packages/schema/src` |
| Plugin contracts | `packages/plugin` |
| TUI compatibility code | `packages/tui/src`, embedded CLI host under `packages/opencode/src/cli` |
| Fork sync/prune behavior | `script/fork-sync.ts`, `script/fork-prune.ts`, `FORK.md`, `keep-manifest.json` |

## Core/current domain tree

`packages/core/src` contains the current domain/runtime substrate. Important areas:

```text
session/            session state, input, runner, execution, history, projectors
tool/               current built-in tools and registry
event/              durable/current event services
database/           database and migrations
goal/               Goal durable/runtime domain
scheduled-task/     scheduled-task domain
search/             fork search/index services
effect/             Effect runtime/service composition
filesystem/         filesystem services
project/            project domain
observability/      logging/metrics/runtime observation
v1/                 centralized V1 compatibility helpers
```

Many top-level Core modules also expose domain services such as Git, shell, PTY,
snapshot, provider, project inventory, process environment, system projection, and
tool-output retention/projection.

## OpenCode local-host tree

`packages/opencode/src` is the local host and major compatibility layer:

```text
server/             full local HTTP server + route composition
session/            legacy/V1 execution + compatibility seams
tool/               V1/fork-rich tool implementations
provider/           provider host/runtime integration
project/            project/instance host integration
config/             host config resolution
plugin/             plugin activation
cli/                embedded legacy CLI/TUI host code
acp/                ACP integration
background/         background execution support
browser/            browser-related runtime support
goal/               Goal host integration
quota/              fork quota behavior
scheduled-task/     scheduler host/execution integration
snapshot/           snapshot integration
worktree/           worktree host behavior
util/               host/runtime utilities
```

When adding new behavior, first decide whether it belongs in durable/shared Core or
only in the OpenCode host adapter. Do not default to `packages/opencode` merely
because that is where an HTTP route lives.

## GUI tree

`packages/app/src` is organized primarily by:

```text
components/         reusable app-level interaction surfaces
context/            server state, projections, settings, files, tabs, runtime state
pages/              route/page composition
hooks/              reusable reactive data hooks
utils/              browser/app utilities and compatibility adapters
i18n/               app strings/localization
wsl/                Windows/WSL client support
```

The app is hybrid. A `v2` component or route directory describes UI generation, not
necessarily API/runtime generation. See [v1-v2.md](./v1-v2.md).

## Tests and evidence

Tests generally live adjacent to their owning package:

- `packages/core/test`
- `packages/opencode/test`
- `packages/app/src/**/*.test.*`
- `packages/app/e2e`
- package-local test directories elsewhere.

Architecture/performance claims should be closed with the real triggering runtime
where practical, not only a unit test or isolated microbenchmark.

## Documentation lookup

- current repository map: `docs/map`;
- durable cross-cutting architecture: `docs/architecture`;
- normative specs: `docs/specs`;
- active work/research: `docs/plans`;
- audits/handoffs/closeouts: `docs/handoff`.
