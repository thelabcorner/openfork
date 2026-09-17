# Surface and UX

**Read after:** `01-architecture.md`  
**Owns:** HTTP contract, SDK, events, client store, Scheduled inbox

## 1. The route-group split is a correctness question, not a style one

The httpapi `AGENTS.md` is unambiguous: \"Do not put a cheap endpoint behind
heavy group middleware merely because it shares a noun with runtime-heavy
siblings. Split groups/boundaries when their ownership tiers differ.\"

Every scheduled-task endpoint except `runNow` is a Tier 0 read or write
against the global database. If they all live in one group behind
`InstanceContextMiddleware`, then **opening the Scheduled pane bootstraps an
Instance** — config, plugins, tools, LSP, VCS, snapshot — to render a list
of rows that were already sitting in SQLite.

```
Group \"scheduledTask\"           (Tier 0 — NO instance middleware)
  GET    /scheduled-task               list (optional projectID filter)
  POST   /scheduled-task               create
  GET    /scheduled-task/:id           get
  PATCH  /scheduled-task/:id           update (bumps revision)
  DELETE /scheduled-task/:id           remove
  POST   /scheduled-task/:id/enabled    toggle (cheap, separate from update)
  GET    /scheduled-task/:id/run        run history
  GET    /scheduled-task/run            inbox across all tasks
  POST   /scheduled-task/run/:runID/ack acknowledge (clears unread)
  POST   /scheduled-task/preview         dry-run the recurrence engine

Group \"scheduledTaskRuntime\"    (Tier 3 — instance middleware)
  POST   /scheduled-task/:id/run-now    manual fire
```

Two groups, one noun. That is exactly what the contract asks for.

### 1.1 The `preview` endpoint is not optional polish

Cron is a user-hostile notation and DST is worse. `POST /scheduled-task/preview`
takes a schedule   timezone and returns the next N instants as epoch millis,
with a `warnings` array (`\"skips on DST spring-forward 2026-03-08\"`,
`\"fires twice on 2026-11-01\"`). This:

- lets the editor show \"Next: Tue 9:00 AM\" **before** saving;
- puts the **one** recurrence implementation on the server (no client cron
lib
  that can disagree with the server — a classic split-brain bug);
- gives T2 a free end-to-end test surface.

It is Tier 0 and pure: no database write, no instance.

## 2. Events

Register in the schema package alongside the existing domains and add the
definitions to the event manifest — the same way `Goal.Event.Definitions` is
spread into it. **Do not invent a side-channel.**

| Event | Payload | Why it exists |
| --- | --- | --- |
| `scheduledTask.created` | `Info` | List convergence |
| `scheduledTask.updated` | `Info` | Includes `next_run_at` changes |
| `scheduledTask.deleted` | `{ id }` | — |
| `scheduledTask.runStarted` | `Run` | Drives \"running now\" affordance |
| `scheduledTask.runSettled` | `Run` | Drives the unread inbox badge |

**`updated` carrying `next_run_at` is the key design choice.** The client
never computes a next-run time. It receives an integer and formats it. One
shared 1-second ticker re-renders all countdowns; `AGENTS.md` § Concurrency
forbids per-row timers, and this satisfies that without cleverness.

## 3. SDK regeneration is a mandatory step, not a follow-up

`AGENTS.md` is explicit that the generated SDK is not hand-edited and must
be regenerated after API changes. T6 is **not done** until the generated
client types exist and typecheck. A UI task that begins by hand-writing
fetch calls against a not-yet-generated API is the failure mode to avoid —
hence the hard T6 → T8 dependency.

## 4. The Scheduled inbox

Codex's Scheduled view \"acts as your inbox\" and shows an unread indicator
on runs you haven't reviewed. That is the right mental model and it is
worth stating why: **a scheduling feature without a review surface is a
feature that silently burns tokens.** The output of unattended work has
to land somewhere a human actually looks.

Two views, one data source:

```
┌─ Scheduled ─────────────────────────────────────────┐
│  TASKS                                                   │
│  ● Nightly dep audit     daily 02:00    in 7h 12m   │
│  ● PR triage              weekdays 09:00 in 21h      │
│  ○ Weekly refactor        paused         —         │
│                                                    │
│  RUNS  (2 unread)                               │
│  • 02:00  Nightly dep audit    ✓  4m 12s        │
│  • 09:00  PR triage             ⏸ waiting        │
│    21:00  Nightly dep audit    ✗ quota          │
└─────────────────────────────────────────────────────┘
```

The `⏸ waiting` row is why `PermissionMode.pause` exists (03 § 5.1). It is
the single most important state in the inbox: work that stopped because it
needed a decision only a human can make.

### 4.1 Client store rules

- One store subscribing to the five events. No per-component polling.
- One shared ticker for all countdowns. Not one `setInterval` per row.
- The list query is **not** re-fetched on every event; events patch the
store.
- No client-side cron parsing. Ever. The server sends integers.

These four rules are direct consequences of the `AGENTS.md` concurrency
section — \"Prefer one shared owner for expensive observers, timers...\" —
and they are also just good sense.

## 5. The editor

Fields, in the order they matter:

1. **Name** — free text, unique per project.
2. **Target directory** — *required*, no default from ambient state (03 §
2.3).
3. **Isolation** — `directory` | `worktree`. Default `worktree` for git
repos.
4. **Schedule** — presets (hourly / daily / weekdays / weekly / once) plus
an
   \"advanced cron\" escape hatch. Live `preview` call on every change.
5. **Timezone** — defaults to the browser zone, **stored explicitly** (02 §
   timezone). Show it always; a hidden timezone is a future bug report.
6. **Prompt** — the same composer used elsewhere, so slash commands and
   `@`-mentions work. OpenChamber does exactly this (its docs note the
   scheduled prompt can be a slash command).
7. **Agent / model** — optional override.
8. **Run as goal** — optional, expands to objective   criteria   budget.
9. **Permission mode** — default `deny`, visible, with a plain-language
   explanation of each option.
10. **Advanced** — catch-up, overrun, jitter, retry, retention. Collapsed,
    but **present and explicit** (02 § \"no hidden defaults\").

### 5.1 On natural-language schedule entry

ChatGPT's tasks are created conversationally, and its docs show the
assistant inferring schedules from phrases like \"every weekday at 9\". It is
tempting to copy.

**Recommendation: phase 2, and only as a *generator*.** Natural language
produces a concrete `Schedule` struct that the user **sees and confirms**
via `preview` before saving. Never store the phrase as the source of
truth. A schedule you cannot deterministically re-evaluate is not a
schedule.

## 6. Markdown loop files (optional, phase 2)

OpenChamber supports defining schedules as markdown \"loop files\" with YAML
frontmatter, discovered from a conventional directory, which makes them
committable and reviewable. That is genuinely good design — schedules
become code review artifacts rather than hidden local state.

The subtlety is **reconciliation direction**. A file-sourced task and a
UI-sourced task cannot both be authoritative. Rules:

- `source` column is `ui` | `file`; `source_path` is set for `file`.
- **File-sourced tasks are read-only in the UI** except for the enabled
  toggle and manual run. Editing the schedule means editing the file.
- File removed ⇒ task **disabled and tombstoned**, not deleted. Run history
  survives a branch switch. This matters more than it sounds: checking out
  an old branch should not silently destroy your audit trail.
- `revision` is the content hash of the frontmatter, so re-sync is
idempotent
  and a no-op re-read does not perturb `next_run_at`.

**Watcher ownership.** `AGENTS.md` is explicit that filesystem watchers are
expensive observers requiring a single shared owner. Do **not** add a
dedicated watcher for loop files — subscribe to the existing watcher and
filter. If that is not feasible, defer the feature rather than adding a
second watcher. This is why T7 is marked optional and sequenced last.

## 7. Notifications

There is already a push notification subsystem (a `push_notifications`
migration exists). Scheduled runs are the **canonical** consumer — the
whole point is that nobody is watching. Reuse it; do not build a parallel
notifier. Gate per task: notify on `failure` (default), `always`, or
`never`.

## 8. Negative UX requirements

- The Scheduled pane must render **with zero Instance loads**. T9 proves
it
  with a probe — the httpapi `AGENTS.md` asks for exactly this kind of
  regression (\"add a regression that records/probes instance loads and proves
  the count remains zero\").
- No component may own a `setInterval` per task row.
- No endpoint may accept a missing directory and infer one.
- Deleting a task must **not** delete its sessions.

## 9. Cross-surface consistency

Three clients consume this: desktop, web/PWA, and the TUI. The inbox
read state (`acknowledged_at`) is stored **server-side precisely so it
converges** across them. A `localStorage` unread flag would diverge the
moment you open a second client, and the badge would become noise people
learn to ignore.

TUI scope for v1: **read-only list   manual run**. The editor is rich
(cron preview, timezone picker, goal criteria) and reimplementing it
terminal-side is not worth it before the web editor has settled.

## 10. Open UX questions for T0

1. Does the Scheduled pane live globally or per-project? The data model
   supports both (nullable `project_id`); the **navigation** does not
make
   the choice for free.
2. Do scheduled-run sessions appear in the normal session list, or only
in
   the Scheduled inbox? Mixing them in can drown interactive work under
   machine-generated sessions. Recommendation: tag them and filter them
out
   of the default list, with a toggle.
3. Is there a global \"pause all schedules\" kill switch? Strong
   recommendation **yes** — it is the first thing a user wants when
   something goes wrong at 3am, and implementing it later means
   retrofitting a check into every path.
