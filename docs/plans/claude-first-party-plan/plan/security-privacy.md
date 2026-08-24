# Security and Privacy Plan

## Threat Model

Assets:

- API keys and any approved Claude credentials;
- project paths, prompts, files, tool arguments, and transcripts;
- OpenCode tool authority and permission decisions;
- foreign Claude session IDs and settings;
- local process handles and runtime state.

Threats:

- another local process calling an exposed loopback proxy;
- cross-project session or cwd leakage;
- prompt/path/token leakage through logs or error messages;
- Agent SDK tools bypassing OpenCode permission checks;
- stale session IDs resuming the wrong transcript;
- child processes surviving cancellation or instance disposal;
- hostile MCP/tool output being treated as trusted instructions;
- package supply-chain or SDK update behavior changing runtime semantics;
- Anthropic data collection or commercial terms conflicting with distribution promises.

## Required Controls

- Prefer in-process typed calls over TCP. If a private HTTP boundary is temporarily required, bind to loopback, require a high-entropy bearer secret, validate origin/request shape, and never publish the port as a general API.
- Scope every runtime, bridge, and binding by instance/project/session. Include cwd and configuration digest in resume validation.
- Use OpenCode's permission service for every OpenCode tool. No blanket `allow` callback in production.
- Disable Agent SDK built-in filesystem/shell tools when OpenCode is the authority, unless a reviewed policy explicitly allows them and transcript/permission semantics are defined.
- Redact tokens, Authorization headers, prompt bodies, tool arguments, and full paths from logs. Use stable hashes only where correlation is needed.
- Kill process trees on cancel, timeout, instance disposal, and fatal stream errors on Windows, macOS, and Linux.
- Use bounded sizes and timeouts for prompts, tool results, MCP messages, session identifiers, and stored metadata.
- Treat all external transcript data, MCP output, and tool output as untrusted input. Preserve content fencing in the model/runtime boundary.
- Make credential readers read-only by default. Never refresh or write CLI credentials without an approved contract.
- Add dependency/license/SBOM review for the Agent SDK and any transitive runtime package.

## Privacy Decisions Required

- Whether Agent SDK feedback/usage collection is acceptable for OpenFork users.
- What user-facing notice and opt-out, if any, is required.
- Whether OpenCode telemetry may record provider availability, latency, errors, or usage counts. It must not record prompt/tool content.
- Where external Claude transcripts live and whether OpenCode can reference them.
- How uninstall and account disconnect behave without deleting user-owned Claude state.

## Security Acceptance Tests

- A second local process without the runtime secret cannot invoke a turn.
- A binding from project A cannot resume in project B, even when the short conversation seed matches.
- Denied OpenCode tools never execute through the Agent SDK bridge.
- Cancellation leaves no active child process or pending bridge.
- Logs and diagnostics contain no token, prompt, tool argument, or raw Authorization header.
