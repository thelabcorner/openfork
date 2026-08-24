# Decision Log

This file records decisions that must be made before implementation can be considered complete.

## D1 - Faithful CLI Runtime

Status: release verification.

Question: Can OpenFork/OpenCode ship the same documented official CLI-authenticated Agent SDK harness as a built-in provider without changing its auth boundary?

Default: preserve the plugin's CLI-owned authentication and rate-limit behavior while distribution/terms review is completed. Do not implement an OpenCode-owned OAuth flow.

## D2 - Product/Branding Review

Status: release verification.

The parity port keeps provider ID `claude-code` and existing model references. Verify release copy and branding before distribution rather than changing behavior speculatively.

## D3 - Canonical Provider ID

Status: pending implementation spike.

Proposed: keep `claude-code` as the canonical built-in provider ID. Keep quota source ID `claude` separate.

## D4 - Agent Loop Authority

Status: recommendation.

OpenCode owns durable sessions, permissions, and tool authority. The Agent SDK owns the Claude model turn. A typed continuation protocol joins them.

## D5 - Persistence Authority

Status: recommendation.

OpenCode owns the binding metadata. Claude owns its own transcript files. A binding is resumable metadata, not a second transcript store.

## D6 - Subscription Credential Writes

Status: recommendation.

Default: read-only detection and delegation to the Claude CLI; no token refresh/write in OpenCode.
