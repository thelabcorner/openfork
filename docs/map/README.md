# OpenFork codebase map

This is the canonical orientation layer for the OpenFork repository. It answers:

- what runs where;
- what “V1” and “V2” mean in different parts of the tree;
- how GUI, TUI, desktop, mobile, and the local server relate;
- which package owns which responsibility;
- which upstream OpenCode infrastructure is deliberately absent;
- where OpenFork intentionally diverges from upstream;
- which remote upstream contracts OpenFork must still obey.

## Product boundary in one sentence

**OpenFork is an independent local product/runtime descended from OpenCode. It is
not an OpenCode-compatible distribution and it does not contain OpenCode's hosted
backend.**

That wording is intentional. The desktop/web/mobile clients use an **OpenFork-owned
local sidecar** for sessions, providers, tools, persistence, and workspace execution.
It was forked from OpenCode, but its local API and behavior are not an OpenCode
compatibility promise. Upstream's hosted backend implementation is deliberately
pruned from this repository.

The strict compatibility boundary is instead the **upstream-operated remote OpenCode
services that OpenFork consumes**. Those deployed services cannot be changed by this
fork, so their wire and behavioral contracts must remain compatible. See
[the compatibility boundary](../architecture/compatibility-boundary.md).

One lifecycle policy intentionally differs from upstream: **OpenFork is not trying
to migrate off V1 merely because upstream is moving toward current/V2.** V1 is an
active production architecture in this fork. OpenFork repairs and extends it, and
current/V2 is frequently a semantic/reference implementation from which behavior
and features should be selectively backported into V1. Local parity with upstream
is not the objective.

That applies to the execution runtime **and the local client API strategy**, **not
to UI generation**.
OpenFork does not have a product goal to finish upstream's migration onto the
current Protocol/`/api/*` client APIs. V1 is the target; current/V2 client
surfaces are donor/reference or transitional seams. This is separate from the
OpenCode-hosted Zen/Go model-provider API and any other upstream-operated remote
services OpenFork actually consumes. Those are the compatibility-critical boundary.

The presentation direction is intentionally different: **the V2/new-layout UI is
the primary OpenFork product UI and should continue evolving**. A V2 UI surface can
sit on top of V1/fork runtime and local API contracts when those are the correct
backend contracts.

## Atlas

- [Hosted provider route ownership for all OpenFork special agents](../architecture/hosted-special-agent-routing.md)
- [Model-picker account routing: hosted session strategies vs model-only configuration and catalog defaults](../architecture/model-picker-account-routing.md)

- [SQLite historical contention, safe recovery, and maintenance ownership (October 7–15)](../research/sqlite-historical-reconciliation-2026-10-11.md)
- [SQLite writer-admission tracing, large-DB forensics, OXP duplicate index, Scheduled Task recovery](../research/sqlite-20261015-admission-storage-oxp-index.md)
- [V1 provider stream stalls, phase-aware deadlines, transport-first cancellation and regression receipts (October 15)](../perf/provider-stall-phase-verification-2026-10-15.md)
- [Session crash recovery: generation-fenced ownership, burden-of-proof activity, and shared Stop controls (October 15)](../architecture/session-crash-stop-proof-2026-10-15.md)
- [SQLite worker BEGIN retry and packaged Windows ACP certification](../research/sqlite-bun-worker-begin-retry-2026-10-11.md)
- [OXP tunnel health and remote retry ownership](../architecture/oxp-tunnel-health.md)
- [OXP independent Cloudflare backup transport](../architecture/oxp-cloudflare-backup.md)
- [Settings sidebar and nested subtab navigation](../architecture/settings-subtab-navigation.md)
- [Generalized Telegram notification platform and quota-reset source](../architecture/telegram-notifications.md)
- [OpenFork compatibility boundary](../architecture/compatibility-boundary.md)
- [Telegram notification platform: generic channel and services](../architecture/telegram-notification-platform.md)
- [Native Swarm forced operations](../architecture/swarm-forced-operations.md)
- [Swarm execution ownership across HTTP and direct runtimes](../architecture/swarm-runtime-ownership.md)
- [Goal Mode intrinsic autonomy](../architecture/goal-mode.md)
- [OXP parent-tool epoch and durable continuation](../architecture/oxp-parent-tool-epoch.md)
- [OXP internal error diagnostics](../architecture/oxp-internal-diagnostics.md)
- [OXP upstream authentication boundary](../specs/oxp-upstream-auth-boundary.md)
- [Universal executable tool parity: native sessions, Code, OXP, OFXP, ACP, MCP and future entry points](../architecture/tool-surface-parity.md)
- [Dreamer: read-only background historical investigation](../architecture/dreamer-background-agent.md)
- [OXP native tool exposure parity](../architecture/oxp-native-tool-parity.md)
- [Agent Experience: progressive tool descriptions](../architecture/ax-tool-descriptions.md)
- [Agent Experience: ranked capability discovery and Code Mode parity](../architecture/ax-capability-discovery.md)
- [Agent Experience: explicit native @tool mention context and routing](../architecture/ax-tool-mentions.md)
- [Chat image/SVG zoom: source fidelity and shared inertial interaction](../architecture/chat-image-zoom.md)
- [Multimodal Read and video/audio transport parity](../architecture/media-capability-parity.md)
- [Architecture and control/data flow](./architecture.md)
- [V1 vs V2/current](./v1-v2.md)
- [Runtime and product surfaces](./surfaces.md)
- [Workspace packages and dependency roles](./packages.md)
- [Upstream vs OpenFork](./upstream-fork.md)
- [Source-tree lookup](./source-tree.md)

## High-level runtime

```mermaid
flowchart LR
  Human --> GUI["GUI<br/>packages/app"]
  Human --> Mobile["Mobile PWA<br/>packages/mobile"]
  Human --> TUI["Retained TUI dependency<br/>packages/tui"]

  Desktop["Electron host<br/>packages/desktop"] --> GUI
  Desktop --> Sidecar["OpenFork local sidecar<br/>packages/opencode"]
  ChatGPT["ChatGPT parent<br/>finite OXP tool epoch"] -->|Secure MCP Tunnel / OXP| Sidecar
  GUI <-->|HTTP / SSE| Sidecar
  Mobile <-->|HTTP / SSE| Sidecar
  TUI <-->|generated SDK| Sidecar

  Sidecar --> Protocol["Protocol + server adapters<br/>packages/protocol · packages/server"]
  Sidecar --> V1["OpenFork V1 production runtime<br/>packages/opencode/src/session + tool"]
  Sidecar --> Core["Current/V2 domain runtime<br/>packages/core"]
  V1 --> LLM["LLM/provider protocols<br/>packages/llm"]
  Core --> LLM
  V1 --> Host["workspace / shell / git / tools"]
  Core --> Host
  Core --> DB[("local SQLite")]
```

The TUI box above is a retained runtime/coupling dependency, **not an OpenFork
product surface or OpenCode compatibility promise**. See [surfaces.md](./surfaces.md).

## Authority hierarchy

The map is descriptive. When documents disagree, use this order:

1. executable source and tests;
2. repository/package `AGENTS.md` architecture contracts;
3. [`FORK.md`](../../FORK.md) and `keep-manifest.json` for sync/prune ownership;
4. durable docs in `docs/architecture` and `docs/specs`;
5. this map;
6. plans, research ledgers, audits, and handoffs.

If source has intentionally moved ahead of a durable document, update the durable
document rather than preserving the discrepancy.
