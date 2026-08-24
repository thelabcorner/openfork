# Current-State Research

Date: 2026-08-24

## Repository Facts

- This is OpenFork, a desktop plus sidecar fork. `../../../../FORK.md` marks `../../../../packages/opencode/src/plugin/index.ts` and `../../../../packages/opencode/src/provider/provider.ts` as union/conflict files and marks quota as fork-owned.
- The desktop renderer has no Node access. The packaged Electron sidecar runs the Bun-built `../../../../packages/opencode/dist/node/node.js` under Node. `../../../desktop-build-and-architecture.md` and `../../../../packages/desktop/scripts/prebuild.ts` are authoritative for this boundary.
- `../../../../packages/opencode/package.json` currently depends on `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, and the OpenCode plugin SDK, but not `@anthropic-ai/claude-agent-sdk`.
- `../../../../packages/opencode/script/build-node.ts` bundles `src/node.ts` for Node and treats source mtime as the freshness boundary. A new runtime dependency must be tested in both source/Bun and bundled/Node execution.

## Existing First-Party Plugin Precedents

`../../../../packages/opencode/src/plugin/index.ts` directly imports first-party auth/provider integrations including Codex, Copilot, Azure, xAI, and others. The internal plugin list is sequential and coexists with external plugin loading. `../../../../packages/opencode/src/provider/auth.ts` collects plugin auth hooks and exposes OAuth methods through the provider-auth service.

This precedent is useful for auth and model hooks, but it does not mean Claude should be implemented as a plugin. A Claude runtime has a process bridge, session binding, tool parking, and project-sensitive state that deserve explicit service boundaries.

## Cloned Source Audit

The source repository was cloned from `https://github.com/openchamber/opencode-claude.git` into `C:\Users\SLOOSH~1\AppData\Local\Temp\opencode\opencode-claude` for this planning pass. The README and TypeScript source were reviewed, not only the installed compiled package. The repository contains source modules, smoke tests, a Bun lockfile, a Node-targeted TypeScript build, an MIT license, and a GitHub release workflow.

The README explicitly defines the parity target: official Claude CLI authentication, no credential extraction/copy/refresh/send, Agent SDK query execution, OpenAI-compatible local proxy, effort variants, tools, attachments, auto-compact, sticky sessions, and rate-limit fast-fail.

## Current External Plugin

The cloned source describes `@openchamber/opencode-claude@0.14.0`. Its package metadata declares:

- `@anthropic-ai/claude-agent-sdk` as a runtime dependency;
- `@opencode-ai/plugin` as its host contract;
- a local OpenAI-compatible proxy backed by the Agent SDK;
- CLI-owned authentication;
- effort variants, session resume, tools, skills, MCP, and images.

The plugin declares provider ID `claude-code`, default model `sonnet`, and npm provider `@ai-sdk/openai-compatible`. It starts a loopback proxy on an ephemeral or configured port, then mutates OpenCode config to publish `http://127.0.0.1:<port>/v1`.

Relevant external implementation behaviors:

- `src/index.ts`: config/provider hooks, model metadata, effort variants, request context headers, and CLI auth methods.
- `src/proxy.ts`: chat completions, models, rate-limit endpoint, health, SSE, tool parking/resume, history transfer, compact notes, and rate-limit fast-fail.
- `src/query.ts`: lazy Agent SDK loading, CLI child environment, query options, adaptive thinking, MCP/skills/tools, interruption, and process-tree cleanup.
- `src/prompt.ts`: multimodal image/PDF conversion and bounded conversation-history transfer.
- `src/session-store.ts`: sticky foreign session IDs and Claude transcript existence checks.
- `src/bridge-pool.ts`: one active bridge per conversation, pending tool resolution, supersession, and cleanup.
- `src/auth-env.ts`, `src/detect.ts`, `src/executable-path.ts`, `src/cli-install.ts`, and `src/cli-login.ts`: credential stripping, CLI detection, install, and official CLI login relay. The plugin never performs OAuth itself.
- `src/rate-limit.ts` and `src/usage.ts`: durable reset state, 429 fast-fail/Retry-After, SDK rate-limit events, usage/cost metadata, and compact annotations.
- `test/smoke.ts`: fake CLI login/install, env stripping, detection, model/effort, prompt conversion, proxy, rate-limit, and runtime smoke coverage without a live account.

## Existing OpenFork Claude-Related Code

- `../../../../packages/opencode/src/quota/providers/claude.ts` reads local Claude credentials and calls Anthropic OAuth usage. It is advisory only and now has a five-minute result cache, including cached 429s.
- `../../../../packages/opencode/src/quota/quota.ts` registers the quota adapter independently from provider/model execution.
- `../../../../packages/opencode/src/provider/provider.ts` already has generic model/API normalization, custom provider loading, and fetch wrapping. A recent fallback allows a configured model to inherit `provider.options.baseURL`, but first-party Claude should avoid relying on config mutation for its endpoint.
- `../../../../packages/opencode/src/provider/transform.ts` contains Claude-family message/tool normalization, but this is generic provider transformation and should not become a hidden Agent SDK runtime.
- `../../../../packages/opencode/src/permission/index.ts` owns the OpenCode permission decision path and fires the legacy `permission.ask` plugin hook. A native runtime must use the authoritative permission service rather than copying the plugin's permissive callback behavior.

## Current User Configuration Risk

The observed machine has Claude declarations in both global `opencode.json` and `opencode.jsonc`, including an explicit `claude-code` provider entry. OpenCode does deduplicate plugin origins by load identity in `../../../../packages/opencode/src/config/plugin.ts`, but provider config and plugin model mutation still create ordering/precedence risks. First-party integration must define migration precedence and prevent two Claude runtimes from loading.

## First-Party Port Risks to Preserve or Deliberately Improve

- A plugin-generated model can have no model-level URL while the provider has `options.baseURL`; generic normalization must handle this without producing `Invalid URL`.
- The proxy is intentionally local and ephemeral; preserve behavior for parity, then decide whether an internal secret or same-process transport is needed.
- The global JSON session map and short conversation hash are compatibility behavior; improve them only after parity tests exist so resume is not accidentally broken.
- The plugin uses a bypass-permissions mode while restricting execution to OpenCode MCP tools; preserve and test the exact authority model before changing it.
- The bridge pool and proxy lifecycle are process-global in the plugin; first-party ownership should make disposal and instance scoping explicit.
- Plugin config hooks currently start the proxy and mutate provider config; first-party registration should do the same functional setup through internal services without requiring user config mutation.
