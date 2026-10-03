# Task 06 - Provider, Models, and User Surface

Dependencies: `02-auth-and-availability`, `03-agent-runtime`

Owner: provider/app maintainer

## Work

- Register the canonical first-party provider without config-hook mutation.
- Discover the signed-in account's concrete model IDs from the official Agent
  SDK/Claude CLI `supportedModels()` surface; normalize aliases, effort
  variants, attachments, and 200K/1M limits without making models.dev an
  entitlement authority.
- Add provider setup/status UI using existing auth/provider surfaces and localization.
- Make unavailable/approval-required states distinguishable from network errors.
- Add migration handling for `claude-code/<model>` references.

## Acceptance Criteria

- Provider listing never starts the Agent SDK process.
- Model selection is stable across Bun, Node sidecar, and desktop.
- No hardcoded user-facing English strings are added.
- Legacy references do not silently select direct Anthropic API models.

## Implemented Catalog Architecture

- Passive provider/model listing never imports the Agent SDK or starts Claude.
- Explicit sign-in and an already-running Claude turn are the only live catalog
  refresh boundaries. Normal turns piggyback `supportedModels()` on the
  authenticated query OpenFork already owns; refresh attempts are single-flight
  and throttled to the upstream 10-minute cadence.
- Successful discovery is persisted in OpenFork's cache as concrete model IDs.
  A process-local catalog revision causes the Provider owner to rebuild its
  normal per-instance snapshot on the next provider/model read, preserving
  ordinary config/filter semantics rather than mutating provider maps ad hoc.
- models.dev can enrich exact discovered/bootstrap rows with descriptive
  metadata, but cannot add subscription models or rewrite SDK-derived
  plain-vs-`[1m]` context/output semantics.
- Before the first successful account discovery, a small concrete bootstrap
  catalog mirrors the current opencode-claude fallback. Moving aliases such as
  `sonnet`, `opus`, `haiku`, and `fable` remain migration/selection
  inputs only; they are not provider catalog rows.
- 1M models expose a 900K input threshold so compaction begins before the hard
  context edge, matching the upstream provider precedent.
