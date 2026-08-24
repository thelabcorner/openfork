# opencode Mobile PWA — Ideation Set (entry point)

Premium iOS-PWA client for opencode agent sessions: all projects/sessions, @mention spotlight search, context breakdown, full agent chat with desktop-parity tool UX. No file explorer, no browser pane. One source of truth with the desktop app.

**Status:** ideation complete (6 design docs, 1 synthesis). No production code changed.

## Reading order

| File | What it is |
|---|---|
| `07-synthesis.md` | **Start here** — decision register, consistency check, roadmap, consolidated open questions |
| `00-handoff.md` | Verified repo recon ledger — every cited fact the docs build on (anti-re-exploration instrument) |
| `03-source-of-truth.md` | THE architecture decision: third shell inside `../../../packages/app` (Option A′) |
| `01-ux-architecture.md` | IA, navigation model, screen inventory, scope matrix, gestures, state matrix |
| `02-design-system.md` | zinc theme over existing tokens, New York density, touch tiers, motion, component dispositions |
| `04-api-and-data.md` | V1 endpoint inventory, same-origin serving, SSE-only realtime, auth/pairing, offline boundary |
| `05-chat-and-tools.md` | Flagship chat/tool/diff/composer/@mention/context-sheet UX spec |
| `06-pwa-platform.md` | Manifest/SW/safe-areas/keyboard/push/perf budgets/dev workflow/risk register |

## The five decisions that define it

1. **Third shell in `../../../packages/app`** (`PlatformName: "pwa"`) mounting the same `AppInterface` as desktop — sharing, not porting.
2. **Same-origin serving by `opencode serve`** — the PWA is the embedded bundle; no CORS story at all.
3. **Zero new routes** — mobile chrome is a third layout variant; tab bar + stack + detent sheets.
4. **SSE-only realtime**, refetch-on-reconnect; permissions live-only; offline submit via outbox + `prompt_async`.
5. **zinc.json auto-discovered theme** + six-rule touch-density system over the existing New-York-dense tokens.

## Immediate next step if building

Phase 0 of `07-synthesis.md` §4: pwa entry + Platform impl, zinc.json, `ProjectExplorerPanel` lazy-boundary, mkcert dev HTTPS, client regen for `/find/search`.
