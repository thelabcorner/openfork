# Multi-Account Model Picker — Account Submenu + OpenFork Auto Router

> Status: **design / not implemented**
> Owner: model-selector surface (`packages/app/src/components/dialog-select-model.tsx`)
> Sibling precedent: the OpenRouter sub-provider submenu (same file, `OpenRouterRow` / `OpenRouterEndpointList`)

## 1. The problem

`workbuddy` and `verdent` are *genuinely multi-account* providers: the user enrolls N
credentials, and each credential owns an independent entitlement (credits, per-model 24h
frequency windows, cooldowns, catalog membership). Both plugins expose that to the model
catalog by **emitting one `Model` per (model × account)**:

- `packages/opencode/src/plugin/workbuddy.ts:1234-1262` — for every account, for every
  catalog entry, `exposedModels(...)` emits `` `${entry.id}@${account.id}` `` plus the
  bare `entry.id` (automatic routing).
- `packages/opencode/src/plugin/verdent.ts:2358-2394` — identical shape with `@vd-…`.
- Display names get disambiguated by suffix: `` `${entry.name} (${accountLabel})` ``
  (`workbuddy.ts:1160`, `verdent.ts:2328`).

So a user with 4 WorkBuddy accounts and a 12-model catalog sees **60 rows** where there
are 12 models — and because WorkBuddy also emits context-window aliases
(`hy4-preview#ctx-262144`), the multiplication is worse. The rows are ranked
independently by the Usage-Yield comparator (`sortByCheapness`), so identical models
scatter across the list instead of sitting together. The picker is unreadable, the yield
ranking is diluted, and the *interesting* difference between the rows (which account has
headroom right now) is buried in a parenthesised email address.

Meanwhile the good pattern already exists in the same file: an OpenRouter row is a
`MenuV2.Sub` whose submenu shows the model tooltip, an **`Auto (OpenRouter routing)`**
entry, and the ranked upstream-provider list. That is exactly the shape multi-account
providers want.

## 2. What we are building

1. **Collapse** every account-qualified variant of a model into **one canonical row**,
   for any provider declared multi-account — driven by a registry, not by hardcoded
   `if (provider.id === "workbuddy")` branches (the file already has too many of those).
2. A **multi-account submenu** on hover/ArrowRight, modelled on the OpenRouter submenu:
   model tooltip header → routing-policy section → per-account list with live headroom,
   reset countdowns and eligibility → footer actions.
3. **OpenFork Auto Router** — our answer to `Auto (OpenRouter routing)`. Three named
   policies that ride the *provider's own* server-side account router rather than
   replacing it, encoded in the model id so no new transport is needed:
   - **Auto · Sticky** (default, = today's bare id): session-affine, rotates only when
     the bound account is blocked. This is the provider's native behaviour.
   - **Auto · Headroom**: per request, pick the eligible account with the most remaining
     entitlement for *this* model.
   - **Auto · Spread**: round-robin across eligible accounts to equalise burn and delay
     the first hard limit.
   Each policy row previews **which account it would pick right now**, so "Auto" stops
   being a black box.
4. **Session-binding transparency**: show which account this session is currently bound
   to, and let the user unbind it.

## 3. Non-goals

- Replacing the server-side `AccountRouter`. The UI never picks the account for a
  request; it picks a *policy* and the router honours it. One ranking function, two
  consumers (§5 of ARCHITECTURE).
- Touching OpenRouter's sub-provider flow. It stays as-is; we borrow its shape.
- Account enrollment/OAuth UX. The submenu links out to existing auth flows.
- Cross-provider routing ("pick the cheapest account across WorkBuddy *and* Verdent").

## 4. Documents

| Doc | What it covers |
|-----|----------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, data flow, identity model, routing policies, degradation ladder, ADRs |
| [UX-SPEC.md](./UX-SPEC.md) | Interaction + visual spec: row anatomy, submenu anatomy, keyboard, states, motion, copy |
| [PROVIDER-MATRIX.md](./PROVIDER-MATRIX.md) | Per-provider capability matrix + what a new multi-account provider must implement |
| [TASKS.md](./TASKS.md) | Task index, dependency graph, sequencing, done-definition |
| [tasks/](./tasks/) | T1–T10, one file each: goal, files, steps, acceptance, risk |

## 5. Decision summary (details in ARCHITECTURE §11)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Collapsing is **pure and provider-declared**, in `utils/multi-account-providers.ts` + `dialog-select-model-accounts.ts` | Keeps the 2.7k-line selector free of another provider special-case; new providers are one descriptor |
| D2 | The **account is the model id**, not a side-channel pin | `@wb-…` / `@vd-…` already round-trips through recents, favorites, drafts, session persistence and `chat.headers`. A parallel pin store (like `subProvider`) would fight it |
| D3 | Routing policy encoded as a **reserved account suffix** `@<prefix>auto:<mode>` | Backwards compatible: an old server decodes an unknown account id and falls back to automatic selection. No schema/transport change needed for the happy path |
| D4 | Account eligibility ranking extracted to a **shared pure module** used by both `AccountRouter.select()` and the UI preview | Otherwise the "Auto would pick X" preview drifts from what the router actually does — the single worst failure mode of this feature |
| D5 | Data comes from `useLimits()` first, routing endpoint second | Quota is already polled and cached; the new endpoint is an enrichment, and the UI degrades to quota-only, then to label-only |
| D6 | Single account ⇒ **no submenu** | Never add a hover-gate to a list with one option. The row stays a plain `MenuV2.Item` |
| D7 | Favorites/recents collapse too, but keep the **exact variant identity** | A favorited `hy4-preview@wb-a` is a deliberate choice; it renders as the canonical row with an account chip, not as a duplicate |
