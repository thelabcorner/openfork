# Task 02 - Auth and Availability Service

Dependencies: `00-decision-gates`, `01-runtime-dependency-spike`

Owner: auth maintainer

## Work

- Implement official CLI detection and the plugin-compatible status/login/install relay with explicit precedence.
- Keep OpenCode auth storage out of the CLI credential path; do not add an API-key-only replacement for the parity milestone.
- Keep `CLAUDE_CONFIG_DIR`, Windows home, XDG, and environment handling testable.
- Separate "CLI installed," "SDK available," "CLI logged in," "subscription status," and "ready."
- Integrate provider auth/setup status without mutating config files.

## Acceptance Criteria

- Discovery has no network/process side effects beyond an explicitly invoked status operation.
- No subscription token is copied into `auth.json` by default.
- Missing CLI, unavailable SDK, logged-out CLI, malformed status, and conflicting configuration have stable user-safe errors.
- Auth tests cover every supported OS path and precedence rule.
