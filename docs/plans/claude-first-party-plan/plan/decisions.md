# Decision Log

This file records decisions that must be made before implementation can be considered complete.

## D1 - Faithful CLI Runtime

Status: release verification.

Question: Can OpenFork/OpenCode ship the same documented official CLI-authenticated Agent SDK harness as a built-in provider without changing its auth boundary?

Default: preserve the plugin's CLI-owned authentication and rate-limit behavior while distribution/terms review is completed. Do not implement an OpenCode-owned OAuth flow.

## D2 - Product/Branding Review

Status: release verification.

The built-in subscription transport is presented as **Claude Subscription**
under provider ID `claude`. Direct Anthropic API-key access remains a
separate `claude-api` provider, while `claude-code` stays reserved for the
external plugin compatibility surface. Verify release copy and branding before
distribution without collapsing those identities.

## D3 - Canonical Provider ID

Status: resolved.

Decision: `claude` is the canonical built-in Claude Subscription provider.
`claude-api` is the direct Anthropic API-key provider. `claude-code` remains
reserved for the external plugin so first-party and plugin transports cannot
collide.

## D4 - Agent Loop Authority

Status: recommendation.

OpenCode owns durable sessions, permissions, and tool authority. The Agent SDK owns the Claude model turn. A typed continuation protocol joins them.

## D5 - Persistence Authority

Status: recommendation.

OpenCode owns the binding metadata. Claude owns its own transcript files. A binding is resumable metadata, not a second transcript store.

## D6 - Subscription Credential Writes

Status: recommendation.

Default: read-only detection and delegation to the Claude CLI; no token refresh/write in OpenCode.

## D7 - Subscription Model Catalog Authority

Status: resolved.

The signed-in Claude Agent SDK/CLI `supportedModels()` response is the
availability/entitlement authority for `claude`. OpenFork persists the
normalized concrete catalog and refreshes it only at explicit/live Claude
runtime boundaries; passive provider listing never starts Claude. models.dev is
metadata enrichment only and may neither add subscription entitlements nor
rewrite SDK-derived 200K/1M runtime semantics. A small concrete bootstrap
catalog is allowed before the first successful account discovery.
