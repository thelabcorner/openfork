# T8 — Search expansion, keyboard, accessibility, perf guards

**Goal:** The collapsed picker is at least as fast to drive by keyboard as the flat one, and
nothing is reachable only by mouse or only by color.

## Files to touch

- EDIT `packages/app/src/components/dialog-select-model.tsx` — keyboard routing.
- EDIT `packages/app/src/components/model-account-submenu.tsx` — focus + roles.
- EDIT `packages/app/src/components/dialog-select-model-accounts.ts` — `expandForQuery`
  polish (landed in T5, finished here).
- NEW `packages/app/src/components/dialog-select-model-accounts-keyboard.test.tsx`.

## Steps

1. **Search expansion.** Finish the rule from ARCHITECTURE §7: a query that matches an
   account label expands that group into per-account rows labelled `Model · dana@example.com`.
   Matching uses the same `createModelSearchMatcher` prepared fields — no second matcher.
2. **Keyboard matrix** (UX-SPEC §6). `→` opens and focuses the active policy row; `←`/`Esc`
   closes the submenu only (must not close the popover — mirror the guard the search input
   uses at `:2136`); `↑`/`↓` traverse policy + account rows as one list, skipping section
   labels; `Enter` on the collapsed row selects via the active policy and never opens the
   submenu.
3. **Typeahead** inside the submenu: `startsWith` on the account label, resetting after
   500 ms of no input. Single-digit lists — do not import a fuzzy matcher for this.
4. **Roles/labels.** `aria-haspopup="menu"` and a count-bearing `aria-label` on the trigger;
   `menuitemradio` + `aria-checked` on policy and account rows; `aria-disabled` + the block
   reason inside the accessible name on blocked rows; `role="img"` + `aria-label` on every
   headroom bar (including the existing `ModelStretchBar`, which has none today).
5. **Color independence.** Audit every new state: each must be legible with color vision
   deficiency (the state dot is always accompanied by line-2 text).
6. **Perf guards.**
   - `accounts(modelID)` must be a Map lookup from one memo — add a test that spies on the
     builder and asserts it runs once per data change, not per row.
   - Assert the collapse memo runs once per `unsorted()` change.
   - Confirm the submenu opens with **zero** network calls (spy on the SDK client).

## Acceptance

- [ ] The full UX-SPEC §6 matrix passes as an automated interaction test.
- [ ] Typing an email address and pressing Enter selects that exact account — the pre-collapse
      muscle memory still works.
- [ ] `Esc` inside a submenu returns to the row; a second `Esc` closes the popover.
- [ ] Axe (or the project's a11y lint) reports no new violations on the picker.
- [ ] Opening a submenu issues no HTTP request.

## Risk

- Kobalte owns some arrow-key handling inside `SubContent`; the endpoint list already fights
  this with a manual `focusIndex` + `rangeExtractor` (`:449-479`). The account list is not
  virtualized, so prefer letting Kobalte handle traversal and only add handlers where it
  demonstrably does not.
- Search expansion changes the row count mid-typing, which interacts with the virtualizer's
  scroll restoration. Reset scroll to top on every query change (the rail-change effect at
  `:2050-2062` already does this — reuse it).
