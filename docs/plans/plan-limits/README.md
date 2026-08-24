# Limits / Quota System — Plan Index

> **Goal:** Dynamic, premium provider-limits pane that shows *every connected* provider’s quota with depletion-anxiety clarity, per-credential Go coverage, and faithful ports of OpenChamber + UsageTray patterns.

```
plan-limits/
├── README.md               ← this file (executive summary)
├── ARCHITECTURE.md         ← full architecture (two planes, registry, credential ownership, normalization)
├── PROVIDER-MATRIX.md      ← per-provider credentials, endpoints, windows, brittleness
├── TASKS.md                ← task dependency graph + sequencing
└── tasks/
    ├── T1-core-foundation.md
    ├── T2-claude-provider.md
    ├── T3-codex-provider.md
    ├── T4-xai-provider.md
    ├── T5-openrouter-both.md
    ├── T6-opencode-go-multikey.md
    ├── T7-frontend-system-hook.md
    ├── T8-limits-panel-premium-ux.md
    └── T9-testing-hardening.md
```

## Non-negotiables

1. **OpenCode Go source = `https://opencode.ai/zen/go/v1/usage` + local aggregation (`fork/usage-cache.ts`).** Official snapshot is first-class; local math (`buildLocalWindows`/`buildAggregateWindows`) is fallback, exactly as key-switcher does.
2. **Hide not-connected.** `configured===false` providers are filtered client-side, not rendered.
3. **OpenRouter shows both:** `credits: $X left · $Y spent` *and* free-usage `remaining/limit/percent + model breakdown` (from `OpenRouterFreeUsageTracker`).
4. **As many providers as possible, dynamically.** Registry stays declarative; adding a provider = 1 adapter + 1 alias + 1 fetch/normalize. No UI changes.
5. **DRY with key-switcher.** `toneForRemaining`/`colorFor`/`formatCountdown`/`displayWindowLabel`, `useForkUsage` heartbeat+SSE+cooldown, and `usage-cache` math are reused, not duplicated.
6. **Faithful port, not invent.** Claude/Codex/xAI shapes come from `openchamber/openchamber@main:packages/web/server/lib/quota/providers/*` (MIT). URLs, headers, cooldowns, transforms are 1:1.

## Two Systems — Do Not Conflate

| Plane | Question | Source |
|-------|----------|--------|
| **Account Quota** | “How much of my plan is left?” | Provider billing/quota APIs via OpenCode `auth.json` |
| **Session Telemetry** | “How much context/cost did this conversation use?” | `message.info.tokens/cost` from OpenCode messages |

`plan-limits` touches only the Account Quota plane. Session telemetry (`context-panel`, `session-context-*`) stays untouched.

## Quick Start (execution order)

```
T1 core-foundation
   ├─ T2 claude
   ├─ T3 codex
   ├─ T4 xai
   ├─ T5 openrouter-both (can run parallel with T2-T4)
   └─ T6 opencode-go-multikey (needs T1)
        └─ T7 frontend-system-hook (needs T1+T6+T5)
             └─ T8 limits-panel-premium-ux (needs T7)
                  └─ T9 testing-hardening
```

Each task is independently revertible; T2/T3/T4 can land in any order.

## Upstream References

- OpenChamber quota core: `openchamber/openchamber:packages/web/server/lib/quota/**`
- UsageTray host/plugin model: `Rana-Faraz/usage-tray-windows` (isolated QuickJS + `ctx.host.*` capabilities; credential discovery via CLI auth/json/keychain/sqlite)
- Our existing Go cache: `../../../packages/opencode/src/fork/usage-cache.ts` + `../../../packages/app/src/context/fork-usage.tsx`
- Current quota: `packages/opencode/src/quota/**` (4 adapters) + `../../../packages/app/src/pages/session/limits-panel.tsx` (mono-file)

## Empty-State Contract

- No configured providers → `"No quota providers configured"` (prompt to connect).
- Connected but fetch error → `ok:false` card with message, not hidden.
- `configured:false` → filtered out entirely.
