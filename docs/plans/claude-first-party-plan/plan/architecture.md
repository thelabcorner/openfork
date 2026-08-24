# Architecture Plan

## Decision Summary

Build a first-party `ClaudeAgentRuntime` behind the existing provider path, preserving the external plugin's behavior first. The parity port keeps provider ID `claude-code`, official CLI login relay, lazy Agent SDK query, ephemeral OpenAI-compatible proxy, MCP tool parking/resume, multimodal conversion, compact/history fallback, sticky sessions, and rate-limit gate. Users no longer install or configure an npm plugin.

After parity is proven, the loopback proxy may be refactored into a same-process transport. That is a later hardening phase, not a prerequisite for first-party parity.

## Alternatives Considered

| Option | Benefit | Critical problem | Decision |
|---|---|---|---|
| Keep npm plugin | Lowest code change | Third-party lifecycle, config races, legal ambiguity, insecure proxy, opaque state | No |
| Copy plugin into `src/plugin` | Fast parity | Treats a stateful runtime as a hook; preserves proxy/session/security defects | No |
| Direct Anthropic Client SDK | Simple request ownership | Reimplements Claude Code agent loop, tools, permissions, sessions, and compaction | Not parity |
| First-party port of current proxy/runtime | Preserves proven behavior and minimizes user-visible change | Retains a proxy boundary until later hardening | Recommended |
| Direct Agent SDK runtime adapter | Removes the HTTP hop | High event/tool/session integration cost and behavior drift | Later optimization |
| Run Claude CLI as a subprocess only | Stable CLI surface | Harder streaming/tool/permission integration and weaker observability | Fallback for SDK incompatibility |

## Proposed Module Boundaries

Create a bounded area under `../../../../packages/opencode/src/claude`:

- `availability.ts`: executable, SDK, and CLI-auth detection; no network side effects.
- `auth.ts`: official CLI status/login/install relay; never read, copy, refresh, or store subscription tokens.
- `models.ts`: canonical model IDs, aliases, capability metadata, and effort variants.
- `runtime.ts`: lifecycle-owned Agent SDK query execution, cancellation, process cleanup, and diagnostic events.
- `transport.ts`: typed turn/continuation events; maps text, reasoning, tool calls, tool results, usage, and failures.
- `tools.ts`: OpenCode tool bridge with explicit permission checks and project context.
- `sessions.ts`: project-scoped binding between OpenCode session ID and external Claude session ID, with config/cwd validation.
- `errors.ts`: stable user-safe error categories and redacted diagnostics.
- `provider.ts`: first-party `claude-code` provider registration/model loader, separate from generic plugin loading.

The exact names may change during the spike, but the ownership boundaries must remain.

## Runtime and Provider Contract

The provider adapter must:

- expose the existing canonical provider ID `claude-code`;
- preserve legacy `claude-code/<model>` references without an alias hop;
- own the live proxy URL internally instead of requiring a user-authored `baseURL`;
- return unavailable/configuration errors without crashing provider discovery;
- load the Agent SDK dynamically so users without Claude support do not pay startup cost or fail startup;
- produce stable model metadata and variant names;
- route cancellation to the runtime and then to the child process tree;
- preserve OpenCode's durable message/tool semantics.

Keep quota source ID `claude` separate from provider ID `claude-code`; this matches current fork and plugin behavior.

## Authoritative Loop

The recommended boundary is:

1. OpenCode owns the durable session, provider turn admission, permissions, and transcript projection.
2. Claude Agent Runtime owns one Agent SDK turn and its foreign process/session handle.
3. OpenCode tools are exposed to the Agent SDK through an in-process MCP/tool bridge.
4. If the Agent SDK requests an OpenCode tool, the runtime parks the foreign turn and emits a typed OpenCode tool call.
5. OpenCode executes the tool through its permission and tool services.
6. The continuation sends tool results back to the same runtime binding; the runtime resumes the foreign turn.
7. Every parked turn has an owner, project/session key, timeout, cancellation path, and disposal cleanup.

This is intentionally a state machine, not a loose collection of promises. The external plugin's bridge-pool behavior is research input, not a contract.

## Authentication Modes

### Official CLI-authenticated mode

Use the plugin's existing flow: detect the official `claude` executable and Agent SDK, invoke `claude auth status --json` for status, run `claude auth login --claudeai` for sign-in, relay only the authorize URL and user-entered code, and let the CLI perform/store/refresh its own credentials. Strip credential environment variables from the Agent SDK child environment as the plugin does.

### No-auth mode

The provider remains undiscoverable or reports a clear setup state. Discovery must not spawn a CLI, start a proxy, or make an external request.

## Persistence

For the parity milestone, preserve the plugin's `~/.local/share/opencode-claude/sessions.json` binding format and Claude transcript lookup so existing sessions continue to resume. After parity, migrate to OpenCode-owned project/instance persistence with:

- OpenCode session ID;
- external Claude session ID;
- project/worktree identity;
- canonical cwd and a configuration/settings digest;
- model family and runtime mode;
- created/updated timestamps;
- invalidation reason and last error category.

The binding is not transcript authority. If the external transcript is absent or mismatched, invalidate it and use an explicit history-transfer path or start a fresh external session with an honest notice.

## Lifecycle

- The proxy starts at the same first-party lifecycle point as the plugin's config/provider setup, but provider listing must not spawn a Claude query or CLI process.
- One runtime owner exists per OpenCode instance/location, not per model request.
- Disposal interrupts active queries, rejects pending tools, closes MCP resources, removes temporary secrets, and kills child process trees.
- Runtime health is observable without exposing prompts, tokens, or raw child-process arguments.
