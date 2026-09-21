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

## Product-surface boundaries

- Desktop and web share the same V2/new-layout store and components while
  consuming the fork-owned V1/unified SDK contract.
- Mobile may consume the same Tier-0 contract as a separate presentation.
- `packages/tui` is retained coupling rather than an OpenFork product surface;
  no scheduled-task TUI parity work is required.
- Inbox read state comes from the server (`acknowledged_at`), never
from
  `localStorage` — otherwise it diverges across clients and the badge
  becomes noise.
- Conversational creation is a separate provider-visible product entry point,
  but **not** a separate scheduler: `scheduled_task` delegates to
  `ScheduledTaskAgent` and then the same Core writer. The editor/API remain the
  lifecycle-management surfaces for update/delete/enable/run-now.
- Run inspection is a normal Session concern. A run row exposes its durable Session as soon as `scheduledTask.runUpdated` binds `sessionID`; the global pane uses the App's canonical directory+Session route helper and the shared `session-ui` Session-navigation behavior. Do not build a Scheduled-specific transcript viewer or duplicate Task/Goal click semantics.
- The V2 Chats sidebar likewise consumes only canonical Session roots. Its
  worktree store is a project-wide root index when project identity is known;
  foreign-directory Scheduled roots enter through ordinary Session events.
  Scheduled list/inbox state must never be merged into the chat list.
- A Scheduled run root is user-drivable. Opening it exposes the normal composer
  and normal Session prompt path; no `/scheduled-task/.../prompt` transport is
  permitted. Normal composer submission uses the ordinary V1 Session
  `prompt_async` transport. This conversational exception does not make the
  producer-owned aggregate publicly mutable.
- A human follow-up submitted while the Scheduled worker is active takes focus
  at the next safe provider-cycle boundary through the shared `SessionInput`
  User frontier; do not add a Scheduled-specific interrupt or follow-up queue.

## Conversational creation

`scheduled_task` is a direct provider-visible creation capability, not a
parallel scheduler. The OpenCode adapter resolves only the active
provenance-qualified human worker root; Core then applies the
domain-specific scheduling-intent policy and writes through the canonical
`ScheduledTask.Service`.

- old human turns cannot lend stale consent to a newer host/scheduled worker;
- child Sessions cannot create durable future automation;
- daily/weekly/cron wall-clock schedules require an explicit IANA timezone;
  ambiguous user intent is clarified rather than guessed from the server host;
- exact tool-call replay is idempotent by source turn + exact specification;
- creation provenance (`agent` + source message) is distinct from later run
  provenance (`scheduled-task.run` + run ID).

## Verification

- Opening the pane causes **zero** instance loads (D1).
- 200 task rows produce **one** ticker, not 200 timers (D4).
- Acknowledging a run on one client clears the badge on another.
- A running run becomes enterable immediately after its live `runUpdated` Session binding and remains enterable after terminal settlement/reload.
- A foreign-directory Scheduled root appears in Chats after project-catalog
  scope upgrade, updates/deletes through ordinary Session events, and causes no
  Scheduled catalog/inbox read merely by opening Chats.
- Direct human prompting of a Scheduled root succeeds while an unregistered
  generic host admission remains rejected.
- Actual browser Send emits the ordinary Session `prompt_async` request; a
  malformed Scheduled origin is synchronously rejected before 204, while
  producer-owned update/delete/fork/control surfaces remain fenced.
- Active-run steering proves the newly admitted human input is the shared User
  frontier and the next provider cycle is parented to that human turn.
