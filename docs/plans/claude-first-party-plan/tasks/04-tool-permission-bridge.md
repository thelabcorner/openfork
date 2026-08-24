# Task 04 - Tool and Permission Bridge

Dependencies: `03-agent-runtime`

Owner: tools/security maintainer

## Work

- Define the typed bridge for OpenCode tools exposed to the Agent SDK.
- Route every tool through OpenCode permission policy and project context.
- Implement pending tool parking, continuation, partial results, timeout, supersession, and cleanup.
- Decide which Agent SDK built-in tools are disabled, delegated, or explicitly allowed.
- Preserve untrusted-content fencing and avoid executing tools from model text.

## Acceptance Criteria

- Denied tools do not execute.
- Multiple pending tools resume correctly and exactly once.
- A cancelled/disposed session rejects all pending bridges.
- Cross-project tool invocation is impossible in tests.
- No blanket auto-allow callback exists in production.
