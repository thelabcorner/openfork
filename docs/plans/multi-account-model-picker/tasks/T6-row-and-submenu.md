# T6 — `ModelRowBody` extraction, `MultiAccountRow`, submenu shell

**Goal:** The collapsed row becomes a `MenuV2.Sub` trigger whose submenu lists the accounts.
Policy section and rich account rows land in T7; this task builds the shell and proves the
plumbing.

## Context

`OpenRouterRow` (`dialog-select-model.tsx:550-687`) is the reference implementation:
`MenuV2.Sub` with controlled `open`, a `SubTrigger` carrying the row chrome, and a
`SubContent` that starts with `ModelTooltip` (so the floating tooltip does not compete with
the submenu's hover-open) followed by an Auto row and the list.

The plain row branch (`:2288-2325`) duplicates ~50 lines of that chrome: provider icon,
name, `DeepSeekRateBadge`, `WorkBuddyFreeBadge`, unlimited/free/latest tags, `ModelRowMeta`,
check, `ModelFavoriteToggle`.

## Files to touch

- EDIT `packages/app/src/components/dialog-select-model.tsx` — extract `ModelRowBody`,
  add `MultiAccountRow`, route rows through the descriptor.
- NEW `packages/app/src/components/model-account-submenu.tsx` — `AccountOptionList` shell
  (+ `AutoPolicySection` / `AccountSubmenuFooter` stubs for T7).
- EDIT `packages/app/src/i18n/en.ts` — the keys this task actually renders.

## Steps

1. **Extract `ModelRowBody(props)`** containing everything between the provider icon and the
   favorite toggle. Use it in all three branches (plain, OpenRouter, multi-account). Verify
   OpenRouter rows are unchanged pixel-for-pixel; this is a pure refactor and should be its
   own commit.
2. Add the **account chip** and **chevron** to `ModelRowBody` behind optional props
   (UX-SPEC §2), so only multi-account rows render them.
3. Add `MultiAccountRow`, structurally mirroring `OpenRouterRow`:
   - controlled `open` from `store.submenu`, `onOpenChange` → `setSubmenu(navKey, open)`;
   - `SubContent` carries `data-model-selector-submenu` (the outside-dismiss guard at
     `:2209-2211` depends on it);
   - header = `ModelTooltip` with the same border/typography treatment as `:625-641`.
4. Generalise `setSubmenu` (`:1557-1564`): the OpenRouter prefetch (`ensureOpenRouter`) moves
   behind a descriptor check; multi-account opens do zero work.
5. Exclude collapsed multi-account rows from the floating tooltip (`tooltipModel()`, `:1776`)
   exactly as OpenRouter rows are excluded — the tooltip now lives in the submenu.
6. `AccountOptionList` shell: label, check on the selected variant, `onSelect` →
   `controller.selectVariant(item, accountID)`. Scroll container `max-h-[280px]`, **no**
   virtualizer (ARCHITECTURE §8.3).
7. Single-account groups keep rendering the plain `MenuV2.Item` branch (D6) — assert this in
   a story, not just in code.

## Acceptance

- [ ] Hovering a multi-account row opens a submenu listing every account; clicking one pins
      the model to it and closes the popover.
- [ ] The OpenRouter submenu is unchanged (same DOM structure, same fetch behaviour).
- [ ] Hovering another row closes the previous submenu (existing `activate()` behaviour).
- [ ] Clicking inside the submenu does not dismiss the popover (the `data-` guard works).
- [ ] A single-account provider shows no chevron and no submenu.
- [ ] `dialog-select-model.tsx` line count is **lower** than before this task.

## Risk

- **Hover-intent interaction.** `TOOLTIP_INTENT_DELAY` (`:1533`) plus Kobalte's own submenu
  safe-triangle can make the submenu feel sticky or jumpy. Tune only via the existing
  constants; do not add a second timer.
- Kobalte `Sub` inside a virtualized list: the trigger unmounts when scrolled out of range.
  `OpenRouterRow` already lives with this (the `Show when={props.submenuOpen}` around the
  Portal at `:624`). Copy that pattern exactly rather than inventing a keep-alive.
