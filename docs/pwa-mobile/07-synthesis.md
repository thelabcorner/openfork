# PWA Mobile UI — Synthesis (07)

Coordinator capstone over docs 01–06. Every decision below is owned by its source doc; this file only registers, cross-checks, and sequences them. Read `00-overview.md` first for the index.

---

## 1. The product in one paragraph

A **third shell inside `packages/app`** (`PlatformName: "pwa"`, new `entry-pwa.tsx` + `pwa.html`) mounting the **same `AppInterface`** the Electron desktop uses, styled by a new auto-discovered `themes/zinc.json`, served **same-origin by `opencode serve` itself**, installable as an iOS PWA. Navigation: persistent 3-tab bar (Sessions / Search / Settings) + push stack + corvu detent sheets; **zero new routes**. Chat reuses the session-ui kit unchanged with turn-level virtualization; tools expand inline exactly like desktop plus a Maximize→full-sheet affordance; diffs are unified <640px with `SessionReview` as the only file surface. Realtime is SSE-only with refetch-on-reconnect; permissions are live-only; offline submit is a client outbox flushing `prompt_async`. Excluded by contract: file explorer, browser pane.

## 2. Decision register (canonical chain, in dependency order)

| # | Decision | Owner | Gates |
|---|---|---|---|
| D1 | Architecture = **Option A′**: third shell in `packages/app`; rejected separate package & shared-module extraction | 03 §1 | everything |
| D2 | Mobile chrome = third layout variant (`pages/layout-mobile.tsx`), following legacy/new dual-layout precedent | 03 §1, 01 §2 | nav build |
| D3 | Router: browser history (not MemoryRouter), zero new routes, settings-as-sheet | 03 §4, 01 §2 | phase 1–2 |
| D4 | Theme: add `themes/zinc.json` (auto-discovery needs no registration); PWA boots `defaultTheme="zinc"`; monochrome primary w/ desaturated-blue `interactive` *(sub-decision pending sign-off)* | 02 §2 | all visuals |
| D5 | Density: repo already New-York dense; six-rule touch system (visual density sacred + hit slop; chrome/rows pay full 44px) | 02 §3 | all visuals |
| D6 | Bottom sheet/action sheet promoted to `ui/v2`; tab bar/large-title PWA-local; FAB rejected | 02 §4 | phase 2 |
| D7 | Serving: **same-origin**, hosted by `opencode serve` embedded bundle; separate origin rejected (CORS) | 04 §3 | phase 0 |
| D8 | Realtime: SSE-only via `/event`; reconnect = refetch on `server.connected` + keyset cursor; suspend on background | 04 §2 | phase 1 |
| D9 | Auth/pairing: existing Basic + `?auth_token=` (URL-stripped by entry.tsx); QR pairing is presentation-layer; security flags recorded | 04 §4 | phase 0 |
| D10 | Context breakdown = client-computed metrics in a detent sheet (no endpoint) | 04, 05, 01 | phase 3 |
| D11 | @mention: regenerate vendored client (`bun run generate` in packages/client) to unlock `GET /find/search`; picker-sheet UX inherits at-mention-search debounce/pagination | 04 §1, 05 | phase 3 |
| D12 | Keyboard: single `KeyboardInset` store from visualViewport; composer/sheets consume it; NO other reader | 06 §2.4 | composer build |
| D13 | SW boundary: precache hashed shell only; API+SSE network-only ("SW owns bytes, Query/ServerSync own truth"); update → SKIP_WAITING → `Platform.refresh()` | 06 §3 | phase 4 |
| D14 | Mobile updater OMITTED (D13 replaces it); Platform delta = optional share/installPrompt/haptics sketches, no-op-safe | 03 §3, 06 | phase 0–2 |
| D15 | Chat: turn-level virtualization; tool rows expand inline as desktop + Maximize chevron → full-height sheet; unified diffs <640px; SessionReview-only file inspection; permission approval sheet w/ hold-to-confirm | 05 §§1–4 | phase 3 |

## 3. Cross-doc consistency check

Verified aligned (members wired each other explicitly, spot-checked against doc structure): context-as-sheet (01↔05), zinc keys/touch tiers (02↔05), same-origin + SSE-only + outbox (04↔03↔06), KeyboardInset single-reader (06↔05), updater omission (03↔06), i18n plans deduped (05↔06). No contradictions found.

Two axiom clarifications to carry into implementation:
1. **Q1 (05):** `sdk/v2` *type imports* in app code are not a license to design against V2 endpoints — all data-flow specs here remain V1-only.
2. **R4 (05):** the explorer lazy-boundary (03's phase-0 fix for the static `ProjectExplorerPanel` import at `pages/session.tsx:31`) is what makes the "no file explorer" exclusion real on mobile — it must land before or with the mobile shell.

## 4. Consolidated roadmap (from 03 §8, annotated with gates)

- **Phase 0 — foundations:** pwa entry + Platform impl (D14); zinc.json (D4); lazy-boundary ProjectExplorerPanel (R4); mkcert HTTPS dev (SW + Basic-creds prerequisite, 06 §7); client regen for `/find/search` (D11).
- **Phase 1 — walking skeleton:** connect (D9) → sessions list → open session → stream (D8) → prompt (`prompt_async` only).
- **Phase 2 — nav chrome:** layout-mobile variant (D2/D3), tab bar/large-title (D6), sheets promotion to ui/v2 — gated on desktop e2e staying green.
- **Phase 3 — features:** chat/tool/diff spec build-out (D15), @mention picker-sheet (D11), context detent sheet (D10), permission approval sheet.
- **Phase 4 — hardening:** SW + update flow (D13), push matrix, perf budgets (TTI <3s cold / INP <200ms p75 / initial JS ≤300KB gzip), device validation pass.

## 5. Consolidated open questions (all remaining unknowns)

| Question | Source | Gate |
|---|---|---|
| Locate pending-question ask-surface component (timeline hides them, `message-part.tsx:801`) before mobile ask-sheet | 05 Q5 | phase 3 |
| Prompt-while-running semantics untraced in V1 handlers | 04 §7 | phase 1 |
| Virtualizer × iOS rubber-band behavior — device validation | 05 Q2 | phase 4 |
| Edge-swipe vs sheet conflicts on device; `navigator.vibrate` absence confirm | 01→06 | phase 4 |
| Maskable-icon asset audit; `setAppBadge` support recheck on current iOS minors | 06 §10 | phase 2/4 |
| Zinc accent sub-decision sign-off (monochrome primary + blue `interactive`) | 02 §2.3 | phase 0 |
| Upstream fixes to schedule: define `--surface-disabled`; Inter TTF→woff2 | 02, 06 | phase 0 |
| Redirect replace-semantics audit (browser-history switch risk R2) | 03 R2 | phase 1 |

## 6. If the operator says "build"

Start Phase 0 exactly as §4 lists it — every item is small, independently verifiable, and de-risks everything after. The single highest-leverage pre-move is the `ProjectExplorerPanel` lazy-boundary: it shrinks the session chunk on desktop today and makes the mobile exclusion structural rather than cosmetic.

— end of synthesis —
