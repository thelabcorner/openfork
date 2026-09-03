# T5 — Collapse account variants in the selector controller

**Goal:** One row per model, ranked once. The submenu does not exist yet; this task is
purely about the list.

## Context

`createModelSelectorController` (`dialog-select-model.tsx:923-1183`) builds
`unsorted() → allModels()` and derives `groups()`, `favorites()`, `recents()`,
`searchableFields()`, `thresholdMap()`. `ModelSelectorPopoverV2View` then builds
`renderRows()` (`:1882`) and the virtualizer over it.

Every one of those is keyed by `modelKey(item) = "${provider.id}:${item.id}"`, so the
account suffix currently multiplies all of them.

## Files to touch

- NEW `packages/app/src/components/dialog-select-model-accounts.ts` — `collapseAccountVariants`,
  `expandForQuery`, `groupForModelID`, `variantForPolicy` (all pure).
- NEW `packages/app/src/components/dialog-select-model-accounts.test.ts`.
- EDIT `packages/app/src/components/dialog-select-model.tsx` — controller wiring only.
- EDIT `packages/app/src/context/models.tsx` — stale-key pruning extended to orphaned
  account-qualified favorites/recents (`:65-78`).

## Steps

1. Implement `collapseAccountVariants(items, registry)` per ARCHITECTURE §4.2. Keep it
   allocation-lean: single pass, `Map<groupKey, ModelGroup>`, and **return the original
   `ModelItem` objects** — the canonical row must be a real catalog item so `cost`,
   `limit`, `capabilities` and the yield ranker keep working unchanged.
2. Insert between the filters and `sortByCheapness` (`:1001-1012` → `:1085-1118`). Ranking,
   `openOrder` freezing and `thresholdMap` now operate on canonical items only.
3. Expose from the controller:
   - `groupOf(item): ModelGroup | undefined` (Map lookup, one memo),
   - `variants(item): AccountVariant[]`,
   - `selectVariant(item, accountID | policy)` — the single entry point the submenu will use
     in T6, so selection logic lives in the controller, not the view.
4. Rework `favorites()`/`recents()` (`:1146-1163`) to map a favorited/recent *variant* id to
   its group, dedupe, and carry the pinned account id along for the chip.
5. Rework `current()` (`:1120-1123`) to match any variant; expose `currentVariant()` so the
   row can render the chip and the check.
6. Search: add every variant's account label + id to `prepareModelSearchFields`
   (`:1106-1112`), and apply `expandForQuery` after filtering (ARCHITECTURE §7).
7. `model.visible()` filter: group visible if any variant is visible.
8. Interim affordance (before T6 lands): the canonical row's `title` lists the accounts, so
   nothing is unreachable in the intermediate commit.

## Acceptance

- [ ] With 4 accounts × 12 models, the list shows 12 WorkBuddy rows (+ context variants),
      not 60.
- [ ] A favorited `hy4-preview@wb-a` shows **once**, in Favorites, with an account chip.
- [ ] Selecting the model, restarting, and reopening restores the same variant (recents and
      `model.current()` still round-trip the full id).
- [ ] Searching an account label expands that group into per-account rows; clearing the
      search re-collapses.
- [ ] Removing an account prunes its orphaned favorites/recents without leaving ghost rows.
- [ ] Non-multi providers (openrouter, anthropic, …) are untouched — assert with a snapshot
      of `groups()` for a fixture catalog.

## Risk

- **navKey churn.** navKeys drive the active-row effect, the virtualizer scroll-into-view
  and the tooltip. Keep `navKey = modelKey(canonical)` and make sure the canonical choice is
  *stable* across renders (bare id preferred; otherwise the first variant by account
  enrollment order, not by Map iteration order of an object).
- `openOrder` (`:1101-1110`) freezes rank on open to stop rows moving under the pointer.
  Collapsing changes the key set; verify the freeze still works after a live quota update.
- Storybook/tests that assert on duplicate rows will break — that is expected; update them
  in the same commit.
