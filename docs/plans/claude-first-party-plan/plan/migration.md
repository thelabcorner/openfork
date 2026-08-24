# Migration and Rollout Plan

## Compatibility Goals

- Existing Claude sessions should remain selectable.
- Existing `claude-code/<model>` references should continue to resolve directly to the built-in provider.
- Existing external plugin users should not run two Claude runtimes.
- Existing `claude-code` provider config should not override the first-party runtime's private transport.
- Removing the plugin should not delete Claude CLI credentials, Claude transcripts, or OpenCode sessions.

## Migration Stages

### Stage 0: Discover and verify

Detect the external plugin package and legacy `claude-code` config. Verify that the built-in provider can take ownership of the same CLI/runtime path. Show a localized migration diagnostic only for duplicate plugin registration or unsupported configuration. Do not alter files automatically.

### Stage 1: First-party parity opt-in

Ship the built-in provider behind a feature flag or channel gate. It must pass parity tests against the plugin's fake CLI/SDK fixtures before becoming the default. If the external package is configured during the compatibility window, prevent both runtimes from owning `claude-code` simultaneously and provide an explicit rollback switch.

### Stage 2: Prevent duplicate registration

Once parity and distribution verification are satisfied, mark `@openchamber/opencode-claude` as deprecated/ignored for the built-in provider path. Preserve a clear warning and an escape hatch for rollback. Do not rely only on substring matching; resolve package identity and avoid suppressing unrelated packages.

### Stage 3: Alias and state migration

- Resolve legacy provider ID/model references through a compatibility alias.
- Import only safe session binding metadata if the format is verified; never blindly trust the plugin's global JSON map.
- Validate cwd, project, model family, and transcript existence before resuming.
- On mismatch, start fresh or inject a bounded history summary and label the transition.

### Stage 4: Remove external dependency path

After one release cycle with telemetry and support evidence, remove the automatic compatibility path. Keep a documented rollback release and migration notes. Do not delete user files.

## Precedence Rules

1. Explicit feature flag or supported mode.
2. First-party availability of CLI, SDK, and login state.
3. Built-in provider/runtime ownership.
4. Legacy config compatibility.
5. External plugin fallback only during the migration window.

User-authored provider options may configure safe model behavior, but may not replace the live runtime endpoint, disable project isolation, or change the official CLI auth source.

## Rollback

Rollback must be possible by disabling the first-party feature flag or reverting the release. It must not require restoring deleted config or credentials. A rollback must:

- stop the first-party runtime;
- release pending tool bridges;
- restore external plugin loading only if the compatibility window remains open;
- preserve session bindings as inert records;
- leave an actionable diagnostic rather than silently switching providers.
