# T8 — Client store   Scheduled inbox UI

**Depends on:** T6 (generated SDK must already exist)  
**Blocks:** T9  
**Read first:** `04-surface-and-ux.md` §§ 4–5, 8

## Scope

One store, one pane with two sections (Tasks, Runs), one editor
dialog.

## The four store rules (from 04 § 4.1)

1. One store subscribes to the five events. No per-component polling.
2. One shared 1-second ticker drives **all** countdowns. Never one
   `setInterval` per row.
3. Events **patch** the store; the list is not re-fetched on every
event.
4. No client-side cron parsing, ever. The server sends epoch
integers
   and the `preview` endpoint answers \"when next\".

## Editor

Fields in the order given in 04 § 5. Two things that are easy to
get wrong:

- **Target directory has no ambient default.** The user picks it
  explicitly. Inheriting \"whatever project is open\" is how you end up
  with a 3am agent in the wrong repository.
- **Timezone is always visible**, defaulting to the browser zone but
  stored explicitly. A hidden timezone is a future bug report.

Call `preview` live as the schedule changes and render its `warnings`
array verbatim — DST surprises should be visible *before* saving, not
discovered in March.

## Scope boundaries for v1

- TUI: read-only list   manual run only.
- Desktop and web share the same store and components.
- Inbox read state comes from the server (`acknowledged_at`), never
from
  `localStorage` — otherwise it diverges across clients and the badge
  becomes noise.

## Verification

- Opening the pane causes **zero** instance loads (D1).
- 200 task rows produce **one** ticker, not 200 timers (D4).
- Acknowledging a run on one client clears the badge on another.
