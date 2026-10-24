# T4 — Adaptive and Round Robin

**Status:** Former three-policy proposal replaced by precisely two modes. [Canonical architecture](../../../architecture/model-picker-account-routing.md).

Adaptive ranks eligible accounts by provider-reported quota-expiry urgency, usage, reset timing and health, with deterministic tie-breaking. Round Robin advances the transactional durable ring cursor. A manual account pin is independent of these strategies and is never silently replaced.

Regression owners: `packages/core/src/provider-account-policy.ts`, `packages/core/src/plugin/provider/opencode-provider-route.ts`, and related Core tests.
