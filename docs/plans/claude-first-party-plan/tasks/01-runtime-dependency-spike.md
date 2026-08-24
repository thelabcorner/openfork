# Task 01 - Runtime and Dependency Spike

Dependencies: `00-decision-gates`

Owner: runtime maintainer

## Work

- Add the Agent SDK only in a spike branch or isolated dependency change.
- Verify lazy import under Bun and Node.
- Verify the SDK's child process, executable resolution, and environment behavior on Windows, macOS, and Linux.
- Build `dist/node/node.js` and prove the dependency is present and loadable in the sidecar.
- Record version pinning, update policy, license files, and failure behavior.

## Acceptance Criteria

- Missing SDK produces a provider-unavailable result, not startup failure.
- Bun and Node smoke tests agree on availability and error categories.
- No prompt, token, or full environment is logged.
- A dependency/terms report is attached to the plan.
