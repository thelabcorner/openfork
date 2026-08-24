# Execution Roadmap

This roadmap is parity-first. Distribution and terms review runs alongside implementation; it does not substitute an API-key-only redesign for the requested CLI-backed behavior.

## Phase 0 - Product and Distribution Verification

Tasks: `00-decision-gates`

Output:

- approved auth modes;
- approved product name and branding;
- SDK terms/data-use decision;
- owner for dependency and distribution review.

Verification conditions:

- CLI-owned credential boundaries are documented and tested;
- SDK distribution terms, data use, and branding are assigned for release review;
- the implementation never copies CLI credentials into OpenCode storage.

## Phase 1 - Runtime Feasibility

Tasks: `01-runtime-dependency-spike`, `02-auth-and-availability`

Output:

- Bun/Node dependency proof;
- availability state machine;
- official CLI status/login relay path;
- documented OS/CLI/SDK support floor.

No-go conditions:

- the sidecar cannot load or cleanly dispose the SDK;
- the SDK requires unsupported native/runtime behavior;
- missing SDK/CLI breaks unrelated OpenCode startup.

## Phase 2 - CLI-Backed Parity Thin Slice

Tasks: `03-agent-runtime`, `06-provider-models-and-ui`

Output:

- one model and one text turn through the same local proxy/Agent SDK path;
- streaming and cancellation;
- first-party provider listing;
- no external plugin installation or user config mutation;
- fake-runtime integration tests.

No-go conditions:

- the implementation changes the CLI-owned auth boundary;
- model listing starts a child process;
- the provider cannot distinguish unavailable, unauthorized, and upstream failure.

## Phase 3 - Tool and Session Parity

Tasks: `04-tool-permission-bridge`, `05-session-binding`

Output:

- OpenCode tool calls through authoritative permissions;
- continuation after tool results;
- safe project-scoped resume;
- interruption and cleanup under all terminal states.

No-go conditions:

- tool execution bypasses OpenCode policy;
- external sessions cannot be scoped to a project/cwd;
- pending bridges survive cancellation or disposal.

## Phase 4 - Observability and Migration

Tasks: `07-quota-and-observability`, `08-migration-and-deprecation`

Output:

- accurate CLI status, rate-limit, usage, and quota behavior;
- legacy aliases and duplicate-load prevention;
- rollback flag and migration diagnostics;
- support report with redaction proof.

No-go conditions:

- old and new runtimes can be active for one session;
- legacy config silently changes billing/auth semantics;
- telemetry contains prompt, tool, path, or credential material.

## Phase 5 - Packaging and Release

Tasks: `09-packaging-and-release`

Output:

- desktop sidecar and CLI artifacts;
- Windows/macOS/Linux smoke evidence;
- release notes, privacy copy, migration guide, and rollback procedure.

No-go conditions:

- packaged sidecar differs from tested source behavior;
- the build omits the runtime dependency;
- release verification is absent while the feature is distributed.

## Parallel Work Rules

- Product/legal work may proceed in parallel with the runtime spike; implementation must preserve the documented CLI-backed behavior.
- Model metadata/UI work may proceed after availability contracts exist.
- Quota work must not define auth policy; it consumes the approved auth mode.
- Migration work must not delete user config or external transcript files.
- Packaging work begins only after a fake-runtime thin slice exists; otherwise packaging hides architectural defects.
