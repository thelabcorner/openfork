# Task 09 - Packaging and Release Gate

Dependencies: `01-runtime-dependency-spike`, `03-agent-runtime`, `04-tool-permission-bridge`, `05-session-binding`, `06-provider-models-and-ui`, `07-quota-and-observability`, `08-migration-and-deprecation`

Owner: release/desktop maintainer

## Work

- Run package typechecks and focused/full tests from package directories.
- Build the Node sidecar and verify the Agent SDK dependency is bundled or intentionally externalized.
- Smoke test desktop with `bun run dev` from `../../../../packages/desktop` and the standalone CLI path.
- Verify Windows process cleanup and all supported OS availability states.
- Publish setup, privacy, migration, support, and rollback documentation.

## Acceptance Criteria

- Release checklist in `plan/testing-release.md` is complete.
- No stale sidecar bundle hides or resurrects the old plugin behavior.
- Subscription mode is disabled unless Task 00 has an approval artifact.
- A rollback build/path is available and exercised.
