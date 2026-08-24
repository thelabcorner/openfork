# Task 03 - First-Party Agent Runtime

Dependencies: `01-runtime-dependency-spike`, `02-auth-and-availability`

Owner: provider/runtime maintainer

## Work

- Create the lifecycle-owned `ClaudeAgentRuntime` boundary.
- Add lazy SDK loading, query creation, stream adaptation, timeout, stall detection, interruption, and process-tree cleanup.
- Define typed runtime events and stable error categories.
- Keep the runtime instance/location scoped and dispose it with the OpenCode instance.
- Preserve the plugin's ephemeral loopback OpenAI-compatible proxy and SSE boundary for parity; bind narrowly and make lifecycle/disposal explicit.

## Acceptance Criteria

- A fake CLI/SDK can drive the complete proxy-backed turn state machine.
- Normal completion, failure, cancellation, timeout, and disposal are deterministic.
- No duplicate runtime owner exists for one OpenCode instance.
- Runtime diagnostics are redacted and bounded.
