# 04 — Native UX/UI Experience Plan (Desktop · Web App · TUI)

Owner: ux-designer · Status: complete for planning round · Date: 2026-08-21

**Scope.** The complete native experience for swarms in OpenCode: where swarms live in the app, every screen, the state machines behind them, command-palette/keyboard surface, polish standards, TUI parity, and the realtime data contract the UI needs from the backend (§8 → api-designer).

**Ground truth baseline (today, plugin-only).** Members are real root sessions titled `🐝 <swarm> / <member>`; a human can open any member and chat while the swarm yields for that member (mail deferred, task continuation suppressed, scheduler skips; auto-resume after a 5-min lull; `swarm_release` force-resume). Permission asks are answered headlessly — invisible walls. Everything else (roster, DAG, mailbox, hive memory) exists only as tool-output text. Source: `openswarm/docs/DESKTOP.md`, README §Human-in-the-loop.

**Design thesis in one line:** swarm members are *already* first-class chats — the native port's job is not to add a bolted-on "swarm admin console" but to (a) make the invisible visible (yield state, permissions, DAG, memory) at exactly the moment it matters, and (b) give humans one calm place to supervise many agents without leaving the chat-first model.

---

## 1. Experience principles

These govern every decision below. Each is stated with its falsifiable test.

### P1 — Native, not bolted-on
Swarm UI is built from the same primitives as everything else: `../../../packages/ui` components (`Card`, `List`, `Avatar`, `MenuV2`, `Popover`, `Keybind`, `motion-spring`), the existing provider pattern (`createSimpleContext`), the existing router/tabs model, the i18n pipeline (`language.t()`, never hardcoded strings — `../../../packages/app/AGENTS.md` mandates this), and the existing SSE sync (`server-sdk.tsx` event stream).
*Test:* no screen in this plan introduces a new design language, a second dialog system, or raw English strings.

### P2 — Progressive disclosure: chat first, cockpit on demand
The default surface is still a chat. Swarm awareness appears as **status affordances** (dots, chips, banners) that escalate into **full views** (dashboard, DAG, memory browser) only when clicked. Nothing swarm-related may push a transcript below the fold by default.
*Test:* a user who never opens the dashboard has the same chat experience as today, plus better signals.

### P3 — Calm by default, deep observability on demand
Badges exist only for states that need a human decision (permission pending, blocked task, dead member). Everything else (progress, mail traffic, belief churn) is quiet until a surface is opened. Live-updating numbers never animate unattended.
*Test:* with the app unfocused, only permission asks and failures can produce OS notifications (§4.3).

### P4 — Honesty about machine states
Member lifecycle is rendered from real backend state, never inferred optimism. A member that is stopped says *stopped*, not "away". The yield countdown shows the actual `lullDeadlineMs`. Destructive controls mirror the tool contract exactly (`swarm_stop` requires an explicit member; `swarm_delete` requires typing the swarm name).
*Test:* every rendered state maps 1:1 to a backend state in §8's event list; no invented intermediate states.

### P5 — Trust through reversibility gradients
Controls are ordered by blast radius: chat (always safe) → release/wake (cheap) → stop (reversible, releases task) → remove (frees slot) → delete (irreversible, typed confirm). Irreversible actions are visually quarantined in a Danger Zone and require friction proportional to scope.
*Test:* the most destructive action available at any surface is never adjacent to a frequent action.

### P6 — One permission mental model (V1 + V2 unified)
Users must never learn two permission systems. Both engines collapse into one normalized pending-ask shape (§3.5); the reply path is chosen by the backend, not the user. Autopilot (today's headless answering) becomes an explicit, visible, auditable mode — not the silent default.
*Test:* a pending ask looks and answers identically whether it originated from V1 or V2.

### P7 — RTL-awareness is a requirement, not a phase
Per `../../../.opencode/skills/rtl-aware-development/SKILL.md`: logical CSS properties everywhere, `dir="auto"`/`<bdi>` for member names and message text, LTR isolation for paths/IDs/code, mirrored directional meaning (DAG flow, back/forward, indentation) but never mirrored avatars/charts/media. Every swarm screen ships in the same test matrix (EN+LTR, EN+forced-RTL, real RTL locale, mixed content).
*Test:* DAG layout, sidebar nesting, and progress direction all flip under `dir=rtl` without `row-reverse` hacks.

---

## 2. Information architecture — where swarms live

### 2.1 Model: swarms are session groups with superpowers

The app already has server-side session grouping (`context/session-groups.ts`, `SessionGroupEntry {id, name, sessionIds, position}`) and Home-side grouping (`pages/home/home-sessions-controller.tsx`, `HomeSessionGroup`). Swarms reuse this shape rather than inventing a parallel container:

- A **swarm** = a named group whose members are root sessions (exactly today's model), plus swarm metadata (mission, coordinator session id, policy flags) carried natively instead of in title strings.
- The `🐝 <swarm> / <member>` title convention dies; titles become plain member names, and swarm identity comes from group membership. (Migration note for migration-chief: keep a read-only title parser so pre-port swarms render correctly.)

### 2.2 Entry points (all existing surfaces, extended)

| Surface | Extension |
|---|---|
| **Home** (`pages/home/home-sessions-view.tsx`) | Swarms render as a distinct group section: header row `🐝 <name> · N members · M working` with a chevron into the dashboard; member rows reuse `SessionItem` status-dot language (spinner = working, warning dot = permission pending, red dot = error/dead, blue dot = unseen). |
| **Sidebar** (`pages/layout/sidebar-items.tsx`) | Under each project, a collapsible "Swarms" section listing swarm names; expanding lists member rows (same `SessionRow` component, plus pause/dead glyphs). Project rail icon (`ProjectIcon`) gains a swarm-count micro-badge reusing the existing `badge-mask` pattern. |
| **Command palette** (`components/dialog-command-palette-v2.tsx`) | Dynamic per-swarm entries + global swarm commands (§5). |
| **New-session / composer** | `@swarm` at-mention style entry or slash action "Delegate to swarm…" opening the one-shot delegate dialog (§3.8). |
| **Status popover** (`components/status-popover.tsx`) | One-line swarm health summary when any swarm is active (e.g., `🐝 docs-team 3/4 working · 1 blocked`). |

### 2.3 View hierarchy

```
Home ──────────────► Swarm Dashboard (tab or route)
                        ├─ Roster panel ──► member chat tab (existing)
                        ├─ Task DAG panel (expandable full view)
                        ├─ Activity feed panel ──► Mailbox inspector (per member)
                        ├─ Hive memory panel
                        ├─ Permission center (global, reachable from anywhere)
                        └─ Settings/Danger zone
```

Dashboard opens **in a tab** using the existing tab system (`context/tabs.tsx`, `titlebar-tab-strip.tsx`) — one dashboard tab per swarm, like a session tab, so users can keep transcripts open side-by-side. This is the single most important IA decision: the dashboard is a peer of chats, not a modal over them.

Route shape follows the existing pattern (`/:serverKey/session/:id`): propose `/:serverKey/swarm/:swarmId` with panels addressable via search params (`?panel=dag&task=<id>`) so deep links from notifications land precisely.

---

## 3. Screen-by-screen spec

Each spec names the existing components it composes. All copy via i18n keys under a `swarm.*` namespace.

### 3.0 Shared visual grammar

- **State dots** — identical semantics to `sidebar-items.tsx`: pulsing spinner (working), amber dot (permission pending), red dot (dead/error), blue dot (unseen), grey dot (stopped/idle). One grammar everywhere: sidebar, tabs, roster, palette.
- **Chips** — small pill labels for model (`deepseek-v4-flash`), capability (image/pdf), mode source (`modelSource: fallback` renders as "default" chip with tooltip explaining why — honesty principle P4).
- **Countdown ring** — `ProgressCircle` reused for the human-chat lull countdown and lease-expiry warnings.
- **Motion** — `motion-spring.tsx` for enter/exit; `animated-number.tsx` for counters that change while the panel is focused only (P3).

### 3.1 Swarm Dashboard

Purpose: answer "is my swarm healthy and moving?" in five seconds.

Layout (wireframe, LTR; mirrors under RTL):

```
┌──────────────────────────────────────────────────────────────────┐
│ 🐝 docs-team            [Freeze] [⋯ menu]        mission snippet  │
│ 4 members · 2 working · 1 blocked · 1 chatting                    │
├───────────────┬──────────────────────────────────────────────────┤
│ ROSTER        │  ACTIVITY (live, virtualized)                    │
│ ▸ writer   ⠋  │  12:04:11 writer claimed draft                   │
│ ▸ reviewer ⠋  │  12:04:30 writer → reviewer: draft ready         │
│ ⏸ scout    ⏛ │  12:05:02 reviewer started review                │
│ ● architect ⚠│  12:05:40 ⚠ architect needs permission (bash)     │
│               │  …                                               │
├───────────────┴──────────────────────────────────────────────────┤
│ [Tasks 6] [Memory 41 beliefs] [Mail 3 queued] [Permissions 1]    │
└──────────────────────────────────────────────────────────────────┘
```

- **Roster panel** — `List` rows: avatar (`Avatar`, tinted via existing `messageAgentColor`), name, state glyph, current task chip, model chip. Row hover reveals quick actions (`MenuV2`): Open chat, Release now, Wake mailbox, Stop…, Remove…, Respawn. Click = open member chat tab.
- **Health strip** — counts by state + cache-efficiency indicator. The openswarm README documents cache-hit ratio as *the* cost health metric (~98% median in swarm sessions); render a compact gauge (`ProgressCircle`) per member with tooltip ("cache-hit 97% — healthy"; <95% turns amber with guidance "expect higher cost; consider fewer, longer-lived members"). This turns a measured operational insight into UI.
- **Activity feed** — append-only timeline from `swarm.activity` events (§8), virtualized (pattern: `solid-virtual` usage in home lists), filterable by member/type/severity. Errors and permission asks render inline with their action buttons (jump to Permission Center).
- **Bottom tabs** — Tasks / Memory / Mail / Permissions counters; clicking switches the lower pane or navigates to the full view. Counters use `animated-number` only while the tab is focused.
- **Header menu (`⋯`)** — Rename, Edit mission, Model defaults, Autopilot toggle (with explicit "answers permission asks automatically within clamped limits" description), Freeze, Stop all members…, Delete swarm… (Danger Zone styling, §3.9).
- Empty state (no swarms): illustration-free, one sentence + primary button "Create a swarm" + secondary "Read the guide". Loading: skeleton rows matching final layout (no spinners-in-void). Error: inline retry card reusing `tool-error-card` patterns from `session-ui`.

### 3.2 Task DAG visualizer

Purpose: see dependencies, claims, leases, retries, and blockage at a glance.

- **Rendering** — layered DAG (topological levels left→right in LTR; right→left under RTL — direction meaning is mirrored per P7/SKILL doctrine, arrows always flow start→end logically). Nodes are `Card`s: task title, assignee avatar, state color edge, badges for `priority`, retry count (`↻2/3`), lease timer ring when claimed.
- **States** (from §4.2): ready (outline), claimed/working (spinner overlay), complete (filled check), failed (red edge + reason tooltip), blocked (dashed edge from unmet dependency, muted node), cancelled (strikethrough), lease-expiring (amber pulse ring).
- **Interactions** — click node → detail drawer (`Drawer`/`Popover`): description, acceptance criteria, dependsOn list (clickable), claim history, output refs, actions: Reassign…, Release claim, Retry (coordinator-gated per tool contract), Cancel. Drag-to-reparent dependencies is explicitly **out of scope v1** (risk: silent DAG corruption); editing happens via forms only.
- **Scale behavior** — >25 tasks: auto-collapse completed runs into a "✓ 12 completed" collapsed lane; pan/zoom via wheel + pinch; minimap deferred to backlog.
- **Data** — initial snapshot + `swarm.task.events` deltas (§8). Optimistic rendering only for user-initiated claims/releases, reconciled by event.

### 3.3 Live activity feed + mailbox inspector

Covered as dashboard pane (3.1) for glance value; the inspector adds depth:

- **Mailbox inspector** (per member, from roster row "Mail"): queued/delivered/expired/failed messages with delivery verdicts (the plugin already computes these), sender, correlation thread grouping (`swarm_reply` preserves threads — render as threaded list), expiry countdowns, retry-budget meters. Actions: deliver now (= `swarm_wake`), requeue expired (if API allows), copy payload.
- **Injected-content fencing** — peer-authored bodies render inside a visibly fenced container labeled "Untrusted data" (the plugin marks these; the UI must preserve the fence visually — subtle border + label, not scary red).
- **Mixed-direction safety** — message bodies get `dir="auto"`; IDs, paths, code snippets get `<bdi dir="ltr">`.

### 3.4 Hive memory browser

Purpose: make the swarm's shared mind legible without reading tool output.

Three sub-tabs:

1. **Beliefs** — ranked list (reuse `hive_relevant` ranking server-side): fact text (fenced if peer-authored), confidence bar (whisper <0.6 muted / shout ≥0.8 emphasized — match the plugin's tier thresholds), reinforce count, author, evidence refs, resonant badge when independent convergence was detected. Filters: tier, tag, author. Actions: view evidence (links to activity events), consolidate now (= `hive_consolidate`, coordinator-gated, shows retained/pruned/upgraded result summary honestly).
2. **Path annotations** — workspace scent map: grouped by path, type-coded icons (gold ✦ verified solution, corpse ☠ dead end, struggle ⚠ stuck, affordance ◦ promising, note •), weight bars (0–10), TTL/expiry shown. Click path → open in editor (existing file-open flow). This is stigmergy made visible: the scheduler reads these to steer, so humans should see what the swarm "smells".
3. **Spotlights & needs** — active spotlights with remaining TTL (`hive_spotlight` auto-expires), recent routed needs and which members matched.

Design stance: read-mostly. Humans observe and prune; they don't author beliefs (that's the swarm's epistemology — injecting human "beliefs" would corrupt lateral inhibition). Exception: allow deleting/dismissing a wrong belief, surfaced as a first-class moderation action.

### 3.5 Permission center — replacing invisible walls

Today: `permission.ask` hooks answer headlessly (coordinator inheritance or worktree-scoped fallback); V1 and V2 asks are both intercepted invisibly (README §Security). Native target: **asks become visible, unified, and decidable by the human**, with autopilot as an explicit opt-in.

**A. Inline (focused member chat)** — already 90% built: `session-permission-dock.tsx` renders `DockPrompt` with Deny / Allow always / Allow once and pattern display. Extensions:
- Show *who is asking on whose behalf*: "architect (worker, docs-team)" + engine badge (V1/V2 hidden by default, visible in details — P6 says users shouldn't need it, P4 says we don't hide it either).
- Show the clamped scope: "Allow always will be scoped to this swarm's worktree" — because native propagation must stay monotone (never wider than coordinator; DESKTOP.md §4 clamp rules preserved in UI copy).
- Queue indicator when multiple asks stack ("2 more pending").

**B. Aggregated Permission Center** — global surface (route + palette entry + badge):
```
Pending asks (3)                     [Autopilot: OFF ▸]
┌──────────────────────────────────────────────────────┐
│ ⚠ architect · docs-team            2m ago    [V2]    │
│ bash · rm -rf .opencode/cache/tmp-build              │
│ scope: worktree ✓ temp ✓   [Deny] [Allow once] [Always▾]
│──────────────────────────────────────────────────────│
│ ⚠ writer · docs-team               5m ago    [V1]    │
│ webfetch · https://example.com/api                   │
│ default is Ask (webfetch never blanket-allowed)      │
│                          [Deny] [Allow once] [Always▾]
└──────────────────────────────────────────────────────┘
Recent decisions (audit log, filterable)
```
- Rows show tool, patterns (code-styled, `<bdi dir="ltr">`), diff preview for edits (reuse TUI-grade diff rendering concept; in-app use `diff-changes`/review components from `session-ui`), boundary verdict chips (worktree ✓ / outside ✗ / traversal blocked ✗) computed from the same strict rules documented in DESKTOP.md §3 — the UI displays the backend's verdict, never re-implements it (P4).
- **Always-menu** exposes scope choice where the backend supports it: this session / this swarm (clamped) / global — mapping onto the existing `respond("once"|"always"|"reject")` plus a scoped variant (needs §8 item 6 support).
- **Autopilot mode** — per-swarm toggle replicating today's headless behavior, with three honest labels: OFF ("every ask waits for you"), SCOPED ("auto-allow inside worktree/temp only; bash and webfetch still ask" — mirrors the clamp), FULL ("answer everything — unattended mode"). Default OFF for interactive use; the create-swarm flow asks once (§3.8). When ON, the center becomes an audit log with a persistent amber header strip "Autopilot is answering asks for this swarm".
- Badge routing: pending-ask count surfaces on the project rail icon (existing warning-dot pattern), the swarm group header, and optionally the OS (§4.3).

### 3.6 Member lifecycle, rendered honestly

Rendered states (mapping in §4.1): **Spawning** (spinner, cancellable), **Working** (spinner + task chip), **Idle** (grey dot, "waiting for work"), **Chatting — paused** (pause glyph + countdown ring "resumes in 4:32", with **Release now** inline — this is `swarm_release` promoted from an obscure tool to a first-class button), **Stopped** (grey, "stopped by you/coordinator — Resume"), **Dead** (red dot, "crashed — respawning…" or "Respawn" CTA), **Removed** (only in history). Transient **re-rooted** flash ("session re-created, identity preserved") so the reroot-healing behavior (DESKTOP.md/README) isn't mysterious.

Every non-obvious state gets a one-line *why* on hover/tooltip (P4): e.g. Chatting — paused → "You messaged this member directly; swarm machinery yields for them."

### 3.7 Human takeover UX

The killer feature deserves first-class treatment:

- **Yield banner** (in member chat, above composer, replaces nothing): `You're in control — swarm paused for scout · resumes in 4:32 [Release now] [Keep chatting]`. Countdown ring drains; any human message silently extends the lull (existing tracker behavior). "Keep chatting" adds 5 minutes without sending a message.
- **Mid-turn absorption indication**: when the member is mid-turn and the human sends a message, show a transient composer hint "Scout will pick this up between tool calls" (backend: busy flag, §8 item 2). When idle: normal send semantics. This makes the native absorption behavior (DESKTOP.md §1) *feelable* instead of magical.
- **Takeover from dashboard**: roster row context menu "Take over" = opens chat tab + shows banner; if member mid-task, banner adds "currently running: <task title>".
- **Return control**: explicit "Hand back to swarm" affordance at lull expiry moment (toast: "scout resumed swarm work — reopen chat anytime").
- Coordinator chat exemption (plugin exempts the coordinator's own session from chat detection) is preserved; the coordinator's yield banner reads "Coordinator chat — swarm machinery stays live".

### 3.8 Create-swarm guided flow + one-shot delegate

**Guided flow** (dialog-based, reusing settings-v2 dialog patterns; 4 steps + review):

1. **Identity** — name (validated live against dry-run endpoint, §8 item 10), mission textarea, worktree/workspace picker (existing directory-picker components).
2. **Members** — repeatable row editor: name, role, prompt, model picker (reuse `dialog-select-model` patterns; show availability + price tiers via `swarm_models` data), optional capability delegation chip (image/pdf/audio/video → cheapest-capable explanation), advanced: explicit model override vs chain (explicit → last-used → coordinator → config default → fallback; render the resolved `modelSource` preview live — premium honesty).
3. **Tasks** — lightweight DAG builder: add tasks (title, priority, deps multi-select of earlier tasks). Dependency cycles rejected inline. Optional here; tasks can be seeded later.
4. **Guardrails** — Autopilot choice (OFF/SCOPED/FULL with the §3.5 descriptions), guest access toggle (`allowExternalGuests`), lull duration slider (default 5 min).
5. **Review & launch** — summary cards; Launch spawns members and lands on the dashboard with a spawn-progress roster (spinners resolving one by one — satisfying, honest).

**One-shot delegate dialog** (from composer/palette): minimal — pick swarm (or "new swarm…"), task title, optional member hint, priority. For the 80% case: "delegate this to someone." Pre-fills from current context (current file/selection as task description attachment).

### 3.9 Emergency controls

Ordered by blast radius, each with proportionate friction (P5):

| Control | Friction | Semantics (mirror tool contract exactly) |
|---|---|---|
| **Freeze** (pause all machinery) | One click + undo toast (10 s) | Scheduler no-op, mail queues, spawns refuse. Fully reversible. Header strip turns amber fleet-wide. |
| **Stop member** | Confirm popover naming the member | Requires explicit member (never bulk-silent); releases owned task first so the DAG advances (DESKTOP.md §6). |
| **Stop all members** | Typed confirm: number of members | Sequential stops, progress shown, tasks released. |
| **Remove member** | Confirm popover + consequence line ("frees roster slot; tasks released") | Permanent membership removal. |
| **Delete swarm** | Type-the-name confirm (exact swarm name — matches `swarm_delete` contract), red Danger Zone card, lists what vanishes (members, tasks, messages, blackboard) | Irreversible; coordinator-only. |

Emergency surfaces: dashboard header menu, palette commands, and a global keyboard panic combo (§5) that freezes *everything* with one chord — the kill switch must never require navigation.

---

## 4. Interaction state machines

### 4.1 Member lifecycle (rendered)

```
            spawn requested
                  │
              [Spawning] ──cancel──► (removed)
                  │ ready
                  ▼
   ┌─────────[Working]◄────wake/claim────[Idle]◄────────┐
   │            │  human msg       │ human msg          │
   │            ▼                  ▼                    │
   │      (absorb mid-turn)   [Chatting—paused]─────────┤
   │            │                │ lull expires OR      │
   │            └────continue───┘ [Release now]         │
   ▼ any state                                          │
[Stopped] ──resume──► [Idle]                            │
   │ stop w/o crash                                     │
[Dead/crashed] ──auto-respawn──► [Spawning]             │
(any) ──remove──► [Removed] (history only)
transient: [Re-rooted] flash on session.next.moved
```

Rendering rules: exactly one glyph per member at a time; precedence Working > Chatting-paused > Dead > Stopped > Idle > Spawning for badge collisions; transitions animate via `motion-spring` (150–200 ms, no bounce on state glyphs — calm).

### 4.2 Task lifecycle (rendered)

```
[Blocked] ──deps met──► [Ready] ──claim──► [Claimed/Working]
     ▲                                            │
     │            ┌────lease expires──────────────┤
     │            ▼                               ├──complete──►[Complete]
  [Ready] ◄──release──┘                          ├──fail──────►[Failed]──retry(budget)──►[Ready]
                                                 └──cancel───►[Cancelled]
special: [Lease-expiring] amber pulse (T-60s), [Retrying] shows attempt n/budget
```

Rendering: node edge color + fill intensity encode state; retry budget renders as `↻ n/N`; blocked nodes show their missing dep names on hover. Failed-with-exhausted-budget escalates visually (red + "needs human" chip) and can ping OS notification per §4.3.

### 4.3 Notification model (OS vs in-app)

Reuse `context/notification.tsx` index (session/project unseen counts) extended with a swarm scope; reuse `playSoundById` assets (`yup` = turn/task complete, `nope` = failure, `alert` = permission pending) respecting existing sound settings.

| Event | In-app badge | OS notification | Sound |
|---|---|---|---|
| Permission ask pending, window focused | dock + center badge | no | alert (once) |
| Permission ask pending >30 s AND window unfocused | badge | yes (click → Permission Center) | alert |
| Member dead / respawn failed | red dot | yes (batched per swarm, ≥60 s debounce) | nope |
| Task failed, retries exhausted | chip | yes (batched) | nope |
| Task/turn complete (member you've chatted with) | blue dot | only if unfocused & setting enabled | yup |
| Mail delivered to member | counter only | never | none |
| Belief shout upgrade / spotlight / consolidation results | Memory tab counter | never | none |
| Swarm frozen (by anyone) | amber strip | yes | none |
| Human-chat lull expiring (<60 s) while you're still in the member chat | banner text swap | never | none |

Rules: max one OS notification per swarm per minute per category (debounce), all OS notifications deep-link (`?panel=` routes), quiet hours respect existing settings, and nothing OS-level fires for pure progress (P3).

---

## 5. Command palette entries + keyboard shortcuts

Palette integration via existing `command.tsx` registry + `createCommandPaletteModel`; dynamic entries per open swarm follow the `createServerSessionEntries` precedent.

**Global commands**
- `Swarm: Create swarm…` (guided flow)
- `Swarm: Delegate task…` (one-shot dialog)
- `Swarm: Open dashboard…` → fuzzy list of swarms
- `Swarm: Permission center`
- `Swarm: Freeze all` (panic; confirm toast w/ undo)
- `Swarm: Release member…` → member picker (only chatting-paused members listed)

**Per-swarm dynamic entries** (category "Swarm · <name>")
- Open dashboard / DAG / Memory / Mail / Permissions (deep links)
- `Release <member>`, `Wake <member>'s mailbox`, `Stop <member>…`, `Respawn <member>`
- `Reassign task…` → task picker → member picker
- `Run consolidation` (hive)

**Proposed keybind inventory** (subject to collision audit against `config/keybind.ts` (TUI) and `settings-keybinds.tsx` (app) before implementation; all user-rebindable):

| Action | Proposal |
|---|---|
| Command palette | existing (unchanged) |
| Create swarm | `mod+alt+N` |
| Delegate task | `mod+alt+T` |
| Open swarm dashboard | `mod+alt+D` |
| Permission center | `mod+alt+P` |
| Panic freeze | `mod+shift+esc` (double-press confirm toast) |
| Next pending permission | `mod+alt+arrowdown` / prev `arrowup` |
| Release current member (inside chatting chat) | `mod+alt+R` |

TUI equivalents in §7. Every palette entry declares its keybind via the existing `KeybindV2` display so discovery is self-documenting.

---

## 6. Premium polish checklist

**Motion & transitions**
- Spring-based enter/exit (`motion-spring.tsx`); durations 150–250 ms; no motion for state dots (they pulse via CSS only when actionable).
- DAG node add/remove animates position (FLIP-style); activity feed new items slide in 120 ms; counters animate only when panel focused.
- `prefers-reduced-motion`: disable pulses/slides, keep opacity fades ≤100 ms.

**Empty / loading / error states** (every panel, no exceptions)
- Empty: one sentence + the single most likely next action as a button. Never blank grids.
- Loading: skeletons shaped like final content (roster rows, DAG lanes); initial snapshot should make these brief (<300 ms target, §8 item 8).
- Error: inline card with retry + "copy diagnostics"; connection loss shows a persistent slim top strip "Reconnecting to swarm events…" with last-known-good timestamps on stale data (honesty: stale data is labeled stale).

**Density modes** — Comfortable (default) / Compact toggle in dashboard header; Compact reduces row height ~28% and hides secondary chips; persists per user like other settings. Text sizes come from existing tokens only.

**Accessibility**
- Full keyboard operability: roster, DAG (arrow-key graph navigation with visible focus), permission queue (§5 shortcuts); focus order semantic (RTL skill doctrine).
- ARIA: DAG as `role="tree"`-like structured nav with textual fallback list ("writer → review, blocked by draft"); state conveyed by text+icon, never color alone (state glyphs double as shapes).
- Live regions: polite announcements for permission asks and failures; assertive reserved for panic freeze confirmation.
- Contrast: all state colors meet AA against both themes; confidence bars have numeric labels (not just fill).

**RTL mirroring** (per skill test matrix)
- Logical properties throughout; sidebar nesting, breadcrumbs, DAG flow direction, progress/countdown rings' sweep direction, and back/forward affordances mirror; avatars, charts, media, brand marks do not.
- Member names/message text `dir="auto"`; paths/IDs/model ids `<bdi dir="ltr">`.
- Verify scroll endpoints, resize handles, and popover placements in forced-RTL before ship.

**Dark/light** — token-driven only (`--surface-*`, `--text-*`, `--icon-*` families already exist); no hardcoded hex in any new component; both themes verified in storybook stories for every new component.

**Micro-copy tone** — honest, specific, short. "3 queued messages will deliver when scout is released" not "Messages pending". Numbers over adjectives. No emoji in chrome except the established 🐝 swarm mark.

---

## 7. TUI parity plan

Principle: the TUI is a **supervision console**, not a second dashboard. It excels at text, keyboards, and SSH-able sessions; heavy visualization stays app-only.

**In TUI (v1 parity set)**
- `routes/session/permission.tsx` already renders rich permission prompts with diffs — extend to show member identity + swarm scope line; both engines normalized (same §8 event).
- New `feature-plugins/system/swarm-console` slot page: roster table (name/state/task/model), task list (id/state/owner/retries), pending-permission count, mailbox counts — plain tables, zero graphics.
- Keybind-driven actions mirroring tools: release, wake, stop (confirm dialog via `ui/dialog-confirm.tsx`), freeze; palette entries via `component/command-palette.tsx`.
- Yield banner equivalent: one-line footer status in member session ("⏸ swarm paused for you · resumes 4:32 · mod+r release") reusing footer slots (`routes/session/footer.tsx`).
- Which-key hints (`system/which-key.tsx`) gain a `swarm` branch so discoverability survives without a mouse.
- Themes: state colors map onto all 33 theme JSONs via existing theme tokens (no per-theme special-casing).

**App-only (explicitly not in TUI v1)**
- DAG graph canvas (TUI gets the flat task table instead), hive memory browser visuals (TUI gets `hive_relevant`-ranked text list via a read-only dialog if cheap), dashboard gauges/charts, drag interactions, guided create-swarm wizard (TUI keeps tool-driven creation — the tools are already excellent there).

**Minimal viable TUI surface (acceptance)** — a user on SSH can: see roster+states, see tasks+blockers, answer any pending permission with full diff context, release/yield a member, freeze the swarm, and never need the GUI for safety operations. Everything else is convenience.

---

## 8. Telemetry/observability hooks — UX's wish list to api-designer

Sent early via direct message; summarized here for the record. The UI's realism budget is exactly this list — anything absent degrades gracefully but visibly.

**Events (single SSE stream, existing `server-sdk.tsx` pattern):**
1. `swarm.lifecycle` / `swarm.member.lifecycle` (spawned/stopped/removed/respawned/rerooted + reason)
2. `swarm.member.state` — incl. `lullDeadlineMs` (countdown), `busy` (mid-turn absorption hint), current task ref
3. `swarm.task.event` — created/claimed/released/completed/failed/cancelled/retried/blocked/unblocked + `leaseExpiresAt` + `retryBudgetRemaining`
4. `swarm.mail.event` — queued/delivered/expired/failed + per-member unread counts
5. `hive.event` — published/reinforced/upgraded/pruned/resonance; annotation added; spotlight set/expired
6. **Unified permission event** — normalized `{sessionID, requestID, engine: v1|v2, tool, patterns[], metadata(diff?)}` covering both engines + reply endpoint accepting either id (this is the keystone for §3.5)
7. `swarm.activity` — append-only, cursor-paginated timeline for the feed

**Queries:** one-shot swarm snapshot (roster+states+counts+health) for fast first paint; per-member usage aggregates (tokens, cache-hit ratio, est. cost) powering the health gauge; watchdog/stall signals; `swarm_models` availability incl. capability filter (exists) exposed over HTTP for the member editor.

**Mutations with UI-grade semantics:** dry-run validation for create-swarm; scoped "always allow" (session/swarm/global) on permission replies; HTTP-exposed emergency ops honoring the exact confirm contracts (typed swarm name for delete); config read/write for `humanChatLullMs` + autopilot level.

**Stability IDs:** member identity stable across re-roots (identity ≠ sessionId) so UI state survives `session.next.moved`.

Graceful degradation agreed: if aggregates lag v1, health gauge hides (never guesses); if scoped-always is unavailable, the Always menu offers global with a scope warning line.

---

## 9. Open questions

1. **Where does the dashboard live in the *new* layout?** There are parallel layouts (`layout.tsx` vs `layout-new.tsx`, legacy vs v2 home). Need architect's call on which shell is the port target so panels/hooks attach once.
2. **Scoped "always allow"** — does the V1 engine support swarm-scoped grants, or only global/session? Determines whether the Always menu degrades (§8).
3. **Cross-server swarms** — swarms span projects/servers? If yes, Permission Center and dashboards need a cross-server aggregation story beyond the current per-server provider pattern.
4. **Notification ownership during takeover** — when a human is actively chatting with a member, do that member's task completions still notify? Proposed: no (you're already there) — needs a quiet-hours-style rule ratified with api-designer.
5. **Hive write access for humans** — currently read/moderate only in this plan (§3.4). Should operators ever author beliefs directly (e.g., seeding "gold" paths)? Leaning no for v1; wants scout's take on whether tooling assumes human-authored pheromones anywhere.
6. **Title migration cliff** — old `🐝 swarm / member` titles: rename live sessions on first native launch (visible churn) or alias quietly? Migration-chief input needed.
7. **Mobile/narrow viewport** — dashboard panels stack, but does DAG get a list-form fallback below 720 px? Proposed yes (same textual fallback as a11y tree).
8. **Sound identity for swarm events** — reuse existing alert family vs a distinct "swarm" cue pack (`bip-bop` set is unused-looking)? Small delight, low cost, needs a design opinion.
9. **Palette flooding** — with several swarms × members, dynamic entries could drown files/sessions. Proposed cap + "Swarm:" prefix grouping; verify against real usage in rollout phase.
10. **Windows titlebar interplay** — dashboard tabs live in-app, but Electron titlebar overlays (`env(titlebar-area-*)` doctrine) constrain top-strip space for the reconnect/frozen strips; needs desktop-package sizing check.

---

## Appendix A — Component reuse ledger (existing → swarm use)

| Existing | Path | Reused for |
|---|---|---|
| `DockPrompt` | `packages/session-ui/src/dock-prompt.tsx` | permission dock, yield banner container |
| `SessionPermissionDock` | `../../../packages/app/src/pages/session/composer/session-permission-dock.tsx` | base of §3.5A |
| `SessionRow`/`ProjectIcon` status dots | `../../../packages/app/src/pages/layout/sidebar-items.tsx` | member state grammar |
| `notification.tsx` index + sounds | `../../../packages/app/src/context/notification.tsx`, `utils/sound` | §4.3 model |
| Command palette model | `../../../packages/app/src/components/command-palette.ts`, `dialog-command-palette-v2.tsx` | §5 entries |
| Session groups | `../../../packages/app/src/context/session-groups.ts`, `home-sessions-controller.tsx` | swarm-as-group IA (§2.1) |
| Tabs/titlebar | `../../../packages/app/src/context/tabs.tsx`, `titlebar-tab-strip.tsx` | dashboard-as-tab |
| UI kit | `packages/ui/src/components/*` (Card, List, Avatar, MenuV2, Popover, ProgressCircle, Keybind, motion-spring, animated-number, diff-changes, Toast…) | everything |
| Usage charts | `packages/app/src/components/usage/*` | health/cost gauge patterns |
| Settings controllers | `../../../packages/app/src/components/settings-v2/general-controllers.ts` | autopilot/lull settings |
| TUI permission route | `../../../packages/tui/src/routes/session/permission.tsx` | §7 permission parity |
| TUI dialogs/which-key/footer | `../../../packages/tui/src/ui/dialog-confirm.tsx`, `feature-plugins/system/which-key.tsx`, `routes/session/footer.tsx` | §7 console actions |
| Audio assets | `packages/ui/src/assets/audio/*` | §4.3 cues |

## Appendix C — Phase 3 UX acceptance criteria (for migration-chief's synthesis)

Complements 05-roadmap §"Phase 3 — UX surfaces". Each criterion is verifiable by demo or test.

**BR-2 yield/lull parity (UX side)**
- A1 — `chatting-paused` renders only from backend state (`swarm.member.state` event incl. `lullDeadlineMs`); the countdown derives from the server timestamp, never a client-side timer started at send-time. Rationale: restart-lapse reconciliation bugs (E-matrix) must be *visible* as a corrected countdown, not masked by optimistic client inference.
- A2 — `Release now` calls the native equivalent of `swarm_release` and surfaces the tool's factual resume report ("what actually resumed") as a toast; it never claims success beyond the backend's response.
- A3 — Mid-turn absorption hint renders only when the backend reports `busy:true`; if the flag is absent the hint is absent (never a guessed hint). Degradation is silent-by-absence, not wrong.
- A4 — Human-chat doctrine parity (E1–E14) is observable in UI terms: while chatting, roster shows paused glyph + frozen task chip; mail counter shows queued-not-delivered; scheduler skips are visible as "idle · waiting (yielded)" rather than plain idle.
- A5 — Lull expiry transitions render within one event round-trip of the backend transition (no client-side pre-emptive un-yield).

**Permission center (BR-1 companion)**
- A6 — With autopilot OFF, zero permission asks are answered headlessly; every ask appears inline (focused session) AND in the center (global) with identical Deny/Once/Always affordances regardless of engine (V1/V2 indistinguishable in interaction).
- A7 — Boundary verdicts shown in UI (worktree ✓ / outside ✗ / traversal blocked ✗) come from backend computation; UI displays, never re-implements, the clamp/boundary rules.
- A8 — Autopilot ON shows a persistent visible strip + writes to the audit log viewable in the center.

**General Phase 3 UX bar**
- A9 — Every rendered member/task state maps 1:1 to a backend state in §4.1/§4.2; no invented intermediates.
- A10 — OS notifications fire only per the §4.3 table (permission-pending-unfocused, failures, freeze); nothing else leaves the app unfocused-attention budget.
- A11 — All new surfaces pass the RTL skill test matrix (EN+LTR, EN+forced-RTL, real RTL locale, mixed content) and contain zero hardcoded user-visible strings (i18n keys only).
- A12 — Desktop verification against `bun run dev` from `../../../packages/desktop` (per host AGENTS.md); renderer-only changes hot-reload-verified, main-process changes relaunch-verified.
- A13 — Empty/loading/error states exist for every panel (§6 checklist); stale data during reconnect is labeled stale with last-known-good timestamps.

**Q5 answer (TUI scope)** — Minimal supervision console, not dashboards: roster table w/ states, flat task table w/ blockers/retries, permission answering with full diff context (extends existing `routes/session/permission.tsx`), release/wake/stop/freeze actions via existing dialog-confirm + which-key branch, yield footer line in member sessions. Explicitly out of TUI v1: DAG canvas, hive visual browser, gauges/charts, create-swarm wizard (tools remain the TUI creation path). Acceptance: an SSH user can supervise + answer + release + freeze without the GUI.

## Appendix B — Copy deck seeds (i18n keys, English source)

- `swarm.yield.banner.title` "You're in control — swarm paused for {member}"
- `swarm.yield.release` "Release now"
- `swarm.absorb.hint` "{member} will pick this up between tool calls"
- `swarm.permission.center.title` "Permission center"
- `swarm.autopilot.off.description` "Every permission ask waits for you."
- `swarm.autopilot.scoped.description` "Auto-allows file operations inside this swarm's worktree and temp folders. Bash and web fetches still ask."
- `swarm.delete.confirm` "Type {name} to delete this swarm permanently."
- `swarm.state.chatting.tooltip` "You messaged this member directly; swarm machinery yields for them."
