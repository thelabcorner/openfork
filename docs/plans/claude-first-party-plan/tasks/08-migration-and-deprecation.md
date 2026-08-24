# Task 08 - External Plugin Migration

Dependencies: `05-session-binding`, `06-provider-models-and-ui`, `07-quota-and-observability`

Owner: migration maintainer

## Work

- Detect the external plugin and legacy provider/config declarations.
- Define first-party versus external precedence during the compatibility window.
- Prevent duplicate runtime/provider registration.
- Add legacy model/provider aliases and safe binding migration.
- Add warnings, docs, feature flag rollback, and eventual deprecation behavior.

## Acceptance Criteria

- Both global config files cannot create two active Claude runtimes.
- Existing sessions have a deterministic migration outcome.
- Removing the plugin does not remove credentials or transcripts.
- Rollback is tested and does not silently switch a user to a different billing/auth mode.
