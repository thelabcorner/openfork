# External Constraints and Research

Date: 2026-08-24

Sources:

- Anthropic Agent SDK overview: `https://docs.anthropic.com/en/docs/claude-code/sdk`
- Claude overview: `https://docs.anthropic.com/en/docs/claude-code/overview`
- TypeScript SDK repository: `https://github.com/anthropics/claude-agent-sdk-typescript`
- Installed package inspected locally: `@openchamber/opencode-claude@0.14.0`

## Product/Legal Verification

Anthropic's Agent SDK overview contains guidance about third-party `claude.ai` login, rate limits, branding, commercial terms, and SDK data collection. The cloned plugin README explicitly documents a different boundary: the official Claude CLI owns authentication and the plugin never reads, copies, refreshes, stores, injects, or sends credentials; inference is performed through the official Agent SDK/CLI runtime.

The same documentation says the SDK is governed by Anthropic Commercial Terms, that Anthropic collects some feedback/usage data associated with conversation data, and that partner integrations should consider branding restrictions. These require verification for a first-party OpenCode distribution, but they are not evidence that the requested port is inherently improper.

Implications:

- "First-party in OpenCode" does not automatically make OpenCode an Anthropic-approved first party.
- The first-party feature must retain the CLI-owned authentication flow instead of implementing OAuth or reading credential files.
- Product/legal review must confirm that shipping this local CLI/Agent SDK harness under OpenCode's branding and distribution channel is acceptable.
- Do not change the plugin's provider identity or feature behavior during the parity port solely because of an unverified assumption.
- Privacy documentation must explain SDK data behavior and distinguish OpenCode telemetry from Anthropic SDK data collection.
- A legal review must inspect the SDK package license, Commercial Terms, current Claude Code terms, trademark guidance, and distribution obligations before adding the dependency to installers.

## Technical Findings

The SDK is TypeScript/Node-oriented and exposes the Agent SDK loop, built-in tools, permissions, MCP, sessions, skills, and hooks. The docs recommend the SDK when the host wants the agent loop and tool orchestration, and the Client SDK when the host wants to implement the loop itself.

OpenCode already has its own session, tool, permission, and provider loops. Therefore the integration must explicitly choose which loop is authoritative. Running both loops without a boundary risks duplicate tool execution, non-durable transcript state, inconsistent permission decisions, and cancellation bugs.

## Required Verification Before Release

1. Whether the documented CLI-owned authentication boundary is accepted for OpenFork distribution.
2. Whether the SDK's data collection is acceptable for OpenFork's distribution model.
3. Supported OS/architectures and whether Claude CLI installation is part of OpenCode or a user prerequisite.
4. Whether model IDs and effort levels remain static, SDK-discovered, or CLI-discovered.
5. Whether Claude's own session transcript is a supported source of truth or only a resumable implementation detail.

## Explicit Non-Assumptions

- The port must preserve the plugin's rule that local Claude CLI credentials remain owned by the official CLI.
- A working plugin is not, by itself, a distribution approval artifact; verify the same documented boundary for the first-party build.
- The Agent SDK's built-in tool loop is not interchangeable with OpenCode's tool loop.
- A loopback HTTP URL is not a secure internal API merely because it binds to `127.0.0.1`.
