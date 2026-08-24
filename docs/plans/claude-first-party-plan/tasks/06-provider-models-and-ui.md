# Task 06 - Provider, Models, and User Surface

Dependencies: `02-auth-and-availability`, `03-agent-runtime`

Owner: provider/app maintainer

## Work

- Register the canonical first-party provider without config-hook mutation.
- Define model IDs, aliases, capabilities, effort variants, attachments, and limits.
- Add provider setup/status UI using existing auth/provider surfaces and localization.
- Make unavailable/approval-required states distinguishable from network errors.
- Add migration handling for `claude-code/<model>` references.

## Acceptance Criteria

- Provider listing never starts the Agent SDK process.
- Model selection is stable across Bun, Node sidecar, and desktop.
- No hardcoded user-facing English strings are added.
- Legacy references do not silently select direct Anthropic API models.
