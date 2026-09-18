# Stop / Pause a chat on session tabs — final design

**Status:** IDEATION / DESIGN ONLY — no repo code was modified to produce this document. Backend sections are *design*, explicitly not implementation.
**Author:** critic (NIAMH) — synthesis of t1 map, t2 semantics, t3 backend, t4 UI, stress-tested against source.
**Inputs:** `deliverable/t1` (factual map), `deliverable/t2` (rev 3), `deliverable/t3` (rev 2), `deliverable/t4` (rev 3); source files verified directly (refs below).
**Branches of record:** this fork runs on branch `openfork`; the AGENTS.md default is `dev`. All file:line refs are from the working tree at time of writing.

---

## 0. Stress-test findings (contradictions found and resolved)

The four inputs landed converged after two reconciliation rounds. Remaining issues found by this review, with severity:

| # | Finding | Severity | Resolution |
|---|---|---|---|
| S1 | **t4 rev 3 still references the deleted `session.stop` endpoint, `stopped_at`, and `session.next.stopped`** in its "Contracts LOCKED" block and §3 handler wiring ("working → `session.stop({ sessionID })`"). t3 rev 2 explicitly dropped all three (t2 D2/D4). | High (would ship a handler against a non-existent endpoint) | Stop = existing `session.interrupt` (protocol/src/groups/session.ts:396-409). Tab working-state button calls `sdk().api.session.interrupt({ sessionID })` — the identical call the composer already makes (packages/app/src/pages/session.tsx:1918-1923). Corrected in §4. |
| S2 | **`session_working()` must exclude `paused`, and the fix has TWO sites.** t3 rev 2 §5 and t4 rev 3 both name `server-session.ts:207`; neither names `packages/app/src/context/global-sync/child-store.ts:232-235`, which duplicates the same `type !== "idle"` predicate for sidebar workspace state. | Medium (sidebar would show a paused session as working) | Fix both sites; add `child-store.ts` to the app change list (§5). |
| S3 | **New prompts while paused: forced `delivery=queue` (t2 edge #10, t3 rev 2 §3) vs gate-only.** Forced-queue makes a corrective message typed during pause run *after* older queued follow-ups on resume (queues drain 1-at-a-time after steers). The runner gate already blocks all promotion while paused (llm.ts:383-406), so the override adds no enforcement — only reordering. | Medium (UX ordering, reversible) | **Gate-only, keep client-supplied delivery**; the pause gate is the single enforcement point. A steer typed while paused promotes ahead of queues on resume — newest explicit intent first. One-line deviation from t2/t3, deliberately, marked in §5.1. |
| S4 | **`SessionStatus.Info` union must grow or paused must live in a sidecar.** If the reducer wrote `session_status[id] = {type:"paused"}`, the union at schema/src/session-status-event.ts:9-32 (currently `idle|retry|busy`) would reject it, and `session_working` would flip to true unless redefined. Neither t3 nor t4 lists `session-status-event.ts` as a changed file. | Medium (type/schema gap) | **Sidecar `session_paused(id)`** keyed off durable `session.next.paused/resumed` + `session.active` seeding; `session_status` keeps `idle|retry|busy`. No union change, no `session_working` redefinition load-bearing on the union. §5.3. |
| S5 | **`session.execution.started/succeeded/failed/interrupted` are consumed by the app (server-session.ts:963-969, server-session-v2-reducer.ts:328-334) but emitted nowhere in the repo** (verified: no emitter in core, server, or opencode). The app's busy→idle transition for V2 sessions cannot be assumed to flow from these events. | Medium (the design must not rely on unemitted scaffolding) | Pause/resume state reaches the app via the NEW durable events (`session.next.paused/resumed`) and `session.active` seeding — not via `session.execution.*`. §5.3. |
| S6 | **`session.active` widening is under-specified on the data source.** `SessionV2.active` = `execution.active` = live drains (core/src/session.ts:439, session/execution.ts:11). A paused session has *no* drain, so the handler must union durable-paused IDs with the live-drain set — the current `active: execution.active` passthrough alone cannot report `{type:"paused"}`. | Low (implementation detail, flagged in t3 §6 risk 1) | Handler reads durable paused IDs (same read path as `session.get`) and unions with `execution.active`. §5.2. |
| S7 | **t2's "title suffix `(paused)`" affordance is invisible under truncation** — tabs are w-56 with a container query that hides the title below ~64px (titlebar-tab-nav.css). The pause glyph in the avatar slot (t4) is the visible signal; drop the title suffix. | Low | Adopt t4's avatar-slot glyph as the sole persistent paused marker. §4. |
| S8 | t4's keybind proposal (`esc` / `esc,esc` for stop) conflicts with the composer's context-local Esc (prompt-input.tsx:1268-1293: macOS blur, stop-when-stopping, menu dismiss). | Medium | **No default keybinds** for stop/pause/resume in v1. §4.3. |

Everything else reconciled cleanly: t2 D1–D7 ↔ t3 rev 2 scope ↔ t4 rev 3 contracts (after S1/S4 corrections). t1 (cartographer's factual map, `deliverable/t1`) corroborates every source claim in this review — including the S5 status-event gap, the close-doesn't-stop-tab behavior (tabs.tsx closeTab→removeTab, no interrupt call), and the four sources of `session_working`.

---

## 1. Problem & user story

**Problem.** A session tab is the user's persistent view of a chat. Today a tab shows only avatar + title + close: it gives no control over the session's execution, and its only state signal is a spinner while `session_working()`. The *only* place to stop a running session is inside the session page's composer (prompt-input.tsx:286-303, `stopping = working() && blank()` → `session.interrupt`). To stop a runaway run the user must open the tab and find the composer — and there is no way to *hold* a session's work at all. There is also no notion of "I want this to stop starting new work until I come back", which matters for autonomous multi-step runs and for sessions left running while the user moves to another tab.

**User story.** *"I'm working across four tabs. One session is churning through a long autonomous task I no longer want — I want to stop it without opening the tab. Another session is mid-run and I have to step away: I want to freeze it so nothing else starts (no follow-ups, no queued work burning tokens), and pick it back up later — even after I restart the app."*

**Scope.** One affordance surface: the session tab in the titlebar (titlebar-tab-strip / titlebar-tab-nav), plus the context menu and command palette. Stop is surfaced per-session; Pause is a durable per-session state. No changes to tool side-effect semantics — neither action rolls back applied file changes (t2 D7).

---

## 2. Definitions — Stop vs Pause (recommendation + rejected alternatives)

### 2.1 Recommendation (final)

**STOP = today's `session.interrupt`, surfaced on the tab.**
- Kills the in-flight provider stream and tool fibers; the active assistant message is settled as failed — `Step.Failed` "Provider turn interrupted" (core/src/session/runner/llm.ts:295-310, publish-llm-event.ts:199-211); unsettled tools get `Tool.Failed` "Tool execution interrupted" with a truthful `executed` flag.
- Queued inputs are untouched: rows stay `promoted_seq IS NULL` and drain on the next run activation. (There is no successor drain after interrupt — run-coordinator.ts:94-101 sets `stopping=true` and clears `pendingWake`.)
- Idle interrupt is a no-op (execution.ts:16-17).
- No new endpoint, no durable state, no event. The interrupted markers in the transcript are the durable evidence (t2 D2/D4).
- Tab wiring: `POST /api/session/:sessionID/interrupt` — the exact call the composer already makes.

**PAUSE = a durable server state**, the only new backend feature.
- Server-authoritative: `paused_at` on the session row + two durable events + two endpoints (`session.pause`, `session.resume`).
- Pause = interrupt-if-working **+ durable gate**: while paused, no promotion, no wake — and no **drain** provider turn — may start, from any client (app, TUI, CLI), even after server restart. The gate is scoped to the session's drain pipeline (`SessionRunner.run()`); side-channel maintenance that calls the LLM directly without routing through the runner — e.g. the retitle feature's `SessionTitle` service (docs/swarm-session-retitle.md §3.1, Q6) — is NOT gated. [Cross-doc review amendment R2: "no provider turn" clarified to "no drain provider turn".]
- Resume = clear the gate + wake. It drains held inputs one at a time and **never auto-retries the interrupted turn** (t2 D5).

**Why these two are different (and why the doc treats them as two features, not one):** interrupt answers *"stop what's happening"*; pause additionally answers *"and don't start anything until I say so"* and *"remember this hold across restarts"*. They share the kill mechanism; they differ in durability, queue policy, and reversibility. Modeling pause as "interrupt + durable flag" reuses the tested interrupt path instead of inventing a second execution-control primitive.

**The honest limit (state it plainly to users): pause does NOT freeze-and-resume the current turn.** LLM streaming has no continuation token; the interrupt settlement already finalizes the turn (failed assistant + interrupted tools). Resume un-gates future work; the interrupted turn stays visible and must be retried explicitly. This is the same truth as today's Stop, and it is the correct v1 story.

### 2.2 Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Pause as client-side gate** (app stores a bool; tab just stops issuing wakeups) | `session_input` rows are durable and outlive the app; execution is process-global and server-owned (SessionRunCoordinator, session/execution/local.ts); TUI + app + CLI share sessions. A client gate dies on reconnect/restart and — critically — *does not stop the server's drain*; it only stops the one client from asking. Breaks for a second client. Rejected by t2 D3 and t3 rev 2 §0 alike. |
| **Graceful pause: "finish the current step, then hold"** (flag checked at turn boundaries instead of interrupting) | Requires durable agent-loop continuation (step counter, pending tool results) and an asynchronous "pausing…" wind-down — a new execution primitive. The only payoff vs interrupt is not killing the in-flight tool, and today's interrupt already does that (users live with it). Future work, tied to durable loop continuation. v1 pause = interrupt + gate. |
| **Stop as new endpoint with durable hold** (t3 rev 1: `session.stop` + `stopped_at` + `session.next.stopped`, queue held until next steer) | ~Zero behavioral delta vs today's interrupt: queued rows already sit unpromoted until the next prompt/wake. Adds a second durable column + event + overlapping state machine (`paused_at` vs `stopped_at`) for nothing observable. Dropped by t3 rev 2 and t2 rev 3. |
| **New prompt while paused forced to `delivery=queue`** (t2 edge #10, t3 rev 2) | Reordering-only (the gate already blocks promotion); makes a corrective message typed during pause run *after* older follow-ups on resume. See S3 — gate-only, keep delivery. |

---

## 3. State model

Durable states are exactly **`idle | working | paused`** (t2 D4). `stopped` is a **transient client label** (~2s after a Stop click, then idle) — never durable. `queued` is a **count overlay**, not a state.

| state | meaning | source of truth | tab render |
|---|---|---|---|
| `idle` | no run active, nothing held | `session_status.type === "idle"` (existing) | avatar + title, no action button |
| `working` | a drain is active (streaming / tool / compaction) | `session_working(id)` (existing) | spinner in avatar slot + **Stop** button |
| `paused` | durable hold; no run active; nothing may start | durable `paused_at` / `session.next.paused` events / `session.active` seed | pause glyph in avatar slot + **Resume** button; subtle tint |
| `stopped` (transient) | just interrupted | client-side, ~2s, driven by the existing `session.status` idle round-trip | returns to idle look; NO persistent styling |
| `queued` (overlay) | unpromoted `session_input` rows | `SessionInput.hasPending`-style count (input.ts:170-189) | count badge (v1 optional — see §6 slice 4) |

**Key invariant (S2): `paused` ⇒ `session_working(id) === false`.** A paused session runs nothing; it must not render as working (composer Stop button, sidebar busy dot, project avatar spinner). Enforced by fixing `session_working` at **both** definition sites (`server-session.ts:207-209`, `child-store.ts:232-235`).

**Transitions:**

| from | to | trigger | side effects |
|---|---|---|---|
| idle | working | prompt (steer/queue) / wake | drain starts |
| working | idle | run completes / terminal failure | — |
| working | idle | **STOP** (`session.interrupt`) | assistant + tools settled as interrupted; queue untouched |
| working | paused | **PAUSE** | interrupt (turn settles as interrupted) + `paused_at` set + event |
| idle | paused | PAUSE while idle | flag + event only; held inputs stay held |
| paused | working | **RESUME** | clear flag + event + wake; held inputs drain 1-at-a-time; NO auto-retry of interrupted turn |
| any | (unchanged) | close tab | no session state change — the tab is a view; the session and its run continue (tabs.tsx `removeTab`) |

Pause is per-session. "Pause all" is a batch gesture over per-session endpoints (t2 D6), out of scope.

---

## 4. UI spec (tab affordances)

Adopts t4 rev 3 with corrections S1 (stop → `interrupt`) and S7 (no title suffix; avatar-slot glyph is the paused marker).

### 4.1 Placement

- **Primary: one inline icon button on the tab**, in the existing action group at `inset-inline-end` alongside close (titlebar-tab-nav.tsx:281-293). It is context-dependent — one button, two meanings, like the composer's submit↔stop:
  - `working` → **Stop** (filled square; danger tint on hover/focus).
  - `paused` → **Resume** (play triangle; neutral).
  - `idle` → absent.
  - No two-button inline combo (tab is h-7; a pair would steal title width — t4 §1 rationale).
- **Secondary: tab context menu** (titlebar-tab-context-menu.tsx) — Stop / Pause / Resume items in the session-state group, first in the shared 4-group menu contract (see pathfinder's binding layout in docs/swarm-tab-project-actions.md §3, adopted by docs/swarm-session-retitle.md §5.1: `[Stop/Pause/Resume] → [Regenerate title] → [project actions] → [Close]`, separators between groups). [R4: reference the binding contract.]
  - `disabled={!working}` for Stop; `disabled={paused OR (idle AND no pending inputs)}` for Pause — **not** `!working` (R6, per uxsmith §10.2 flag): pause-while-idle-with-queued-work is a first-class state-model scenario (see §3 transition table + edge cases "Pause while idle (with queued work)"), and the idle-pause is idempotent server-side. Requires the pending-input count in the tab store — promote the queued-badge read (`SessionInput.hasPending`-style) to slice 3; interim fallback: `disabled={!working}` while keeping the palette `pause` command always-available.
  - `disabled={!paused}` for Resume.
- **Command palette:** `command.session.stop` / `command.session.pause` / `command.session.resume` (+ `.description`) targeting the active session, registered like `command.session.compact` (en.ts:95).
- **Reuse existing:** `prompt.action.stop` ("Stop") as the terse verb; do not add bare `common.stop/pause/resume`.

### 4.2 States and visuals

Tab root gains `data-session-state={idle|working|paused}` (transient `stopped` optional polish). Derivation:
- `working` from existing `session_working(id)`.
- `paused` from the NEW `session_paused(id)` sidecar — **never** from `!session_working(id)` (S4; avoids spinner→pause→spinner flicker during the ms-scale interrupt-cleanup window).

| state | avatar slot | inline button | tab root |
|---|---|---|---|
| idle | project avatar (unchanged) | none | unchanged |
| working | `SessionProgressIndicatorV2` spinner (existing, session-tab-avatar.tsx) | Stop, hover-reveal + always visible when active | unchanged; spinner conveys activity |
| paused | pause glyph in the same size-4 slot | Resume, hover-reveal + always visible when active | static neutral tint (`--tab-overlay: var(--v2-overlay-simple-overlay-hover)`) |

- Buttons reuse `IconButtonV2 size="small" variant="ghost-muted"` + the existing `hover-reveal` class; hover/focus-visible reveal for `[data-slot="tab-state"]` must also trigger on keyboard focus (extend the css selector at titlebar-tab-nav.css:18).
- The title fade mask offset (titlebar-tab-nav.css:71-104) must reserve room for the button group via a CSS var.
- **RTL:** logical properties throughout (`inset-inline-end` for the group); icons (stop/pause/play) are non-directional — do not mirror. Container-query centering (css:145-149) switches to `inset-inline-start: 50%` (per .opencode/skills/rtl-aware-development/SKILL.md).

### 4.3 Interaction

- One click = the state-dependent action. No confirm dialogs (stop is interrupt — already unconfirmed in the composer; pause is reversible).
- Handlers: `working` → `session.interrupt({ sessionID })` (S1); `paused` → `session.resume({ sessionID })`; context menu + palette → `session.pause` / `session.interrupt` / `session.resume` as applicable.
- Pointer handling mirrors close exactly: `onPointerDown` preventDefault+stopPropagation, `onClick` stopPropagation; extend `isTabCloseTarget` (titlebar-tab-gesture.ts:3) → `isTabActionTarget` matching `[data-slot="tab-close"]` OR `[data-slot="tab-state"]`. Hide while editing title. Middle-click close unchanged. Touch: apply the same "always visible when active" rule as close.
- **No default keybinds for stop/pause/resume in v1 (S8).** The composer's Esc is context-local (prompt-input.tsx:1268-1293: macOS blur, stop-when-stopping, menu dismiss) and stop is destructive — a global bare Esc would create a dangerous ambiguity (dismissing a dialog could kill a run). Offer keybinds as settings-suggested only. TUI's `esc,esc` remains TUI-shell-specific.
- Optimistic fire + existing `session.status` round-trip drives state; no local timers, no second source of truth (t4 §3 "Stopped transient").
- Tooltip + `KeybindV2` hint pattern (session-sortable-tab-v2.tsx:44-63) when a keybind exists.
- **Composer interplay (companion, not tab):** while paused, `session_working()` is false so the composer's Stop is already suppressed; add a paused-composer status line "Paused — will run on resume" (`prompt.action.paused`) instead of a disabled input (t4 §3; t2 edge #3). Copy nuance (semanticist t2 §4.10): a message typed while paused is a *steer* (it will run on resume, ahead of held queue rows) — say "paused", not "queued".

### 4.4 i18n keys (add to en.ts + every locale; parity test packages/app/src/i18n/parity.test.ts)

| key | EN copy | use |
|---|---|---|
| `command.session.stop` / `.description` | Stop session / Stop the current response and cancel pending work | palette + context menu |
| `command.session.pause` / `.description` | Pause session / Pause this session to continue it later | palette + context menu |
| `command.session.resume` / `.description` | Resume session / Continue the paused session | palette + context menu |
| `common.stopSession` | Stop session | inline button aria-label + tooltip (parallel to `common.closeTab`) |
| `common.pauseSession` | Pause session | aria-label (context menu secondary) |
| `common.resumeSession` | Resume session | inline button aria-label + tooltip when paused |
| `tab.state.working` | Working | aria-label for the spinner slot |
| `tab.state.paused` | Paused | aria-label for the pause glyph slot |
| `prompt.action.paused` | Paused — will run on resume | paused-composer status text |

### 4.5 A11y

- DOM/focus order: tab link → state button → close button (keep markup order).
- Always `aria-label` on the state button — and fix the existing missing aria-label on the close button in `TabNavItem` (DraftTabItem already sets `common.closeTab`).
- No `aria-live` on the tab; the button's aria-label is the announcement. Spinner/pause glyph `aria-hidden` with the slot carrying `aria-label`.
- Reduced motion: spinner must respect `prefers-reduced-motion` (verify `SessionProgressIndicatorV2`; if not, gate with `motion-reduce` → static glyph). Pause glyph is static by design.
- 44px target is impossible in an h-7 tab; keep ≥20px hit area (matches the close-button precedent).

---

## 5. Backend spec — DESIGN, NOT IMPLEMENTATION

Consolidated from t3 rev 2 with S3 (gate-only delivery), S6 (active handler data source), and the schema gap closed.

### 5.1 API surface (protocol)

Two new endpoints, matching the group style in `packages/protocol/src/groups/session.ts` (params + `.middleware(sessionLocationMiddleware)` + OpenApi annotations):

- `POST /api/session/:sessionID/pause` → NoContent, error `[SessionNotFoundError]`
  - If not paused: set `paused_at`, publish durable `session.next.paused`, then `execution.interrupt(sessionID)` (idle interrupt is a no-op — the flag is the real gate).
  - Idempotent: pause-while-paused = no-op, no duplicate event.
- `POST /api/session/:sessionID/resume` → NoContent, error `[SessionNotFoundError]`
  - If paused: clear `paused_at`, publish durable `session.next.resumed`, then `execution.wake(sessionID)` so held inputs drain.
  - **Maps to pause-resume semantics (clear flag + wake), NOT the core `execution.resume` forced-run** — honoring "no auto-retry of the interrupted turn" (t3 rev 2 §3).

Stop requires **no** protocol change: the tab calls the existing `session.interrupt`. `session.interrupt` stays as the raw turn-kill for the composer and TUI/CLI.

Widen `SessionActive` (`{type:"running"}` at protocol/src/groups/session.ts:83-85) → `{type:"running"} | {type:"paused"}`. **Implementation note (S6):** a paused session has no drain, so the `session.active` handler must union the durable-paused IDs with `execution.active` — the current `active: execution.active` passthrough (core/src/session.ts:439) alone cannot report `paused`.

**V1 desktop surface (cross-doc review amendment R1 — closes the V1/V2 split gap).** The desktop app defaults to the V1 httpapi (packages/desktop/src/main/index.ts:67; `detectServerProtocol` → "v1"), so the V2 protocol endpoints alone are unreachable on the primary surface. The V1 server needs its own routes + event path:

- **V1 httpapi routes** `POST /api/session/:sessionID/pause` + `/resume` in `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` (`SessionPaths`, modeled on `abort` :91/:253-264), handlers in `handlers/session.ts` calling the SAME core `SessionV2.pause/resume` the V2 handler calls.
- **V1 event path:** the pause/resume handlers write `paused_at` through the legacy `patch()` (the `setTitle` pattern, packages/opencode/src/session/session.ts:755-757), so the existing `session.updated` event carries `pausedAt` in its full `info` payload. The app's `session.updated` consumer (server-session.ts:1002-1007) already remembers full info — the sidecar derives from `info.pausedAt` on the V1 path and from `session.next.paused/resumed` on the V2 path, plus `session.active`/`session.get` seeding on both. No new V1 event type.
- **Compat routing:** `pause`/`resume` passthroughs (server-compat.ts) dispatch to the legacy routes when protocol === v1, to the V2 client otherwise (the rename pattern, server-compat.ts:183-185).
- **Fallback** if V1 route work is deferred: gate the pause UI on `protocol === "v2"` in slice 1 (Stop needs no gate — `session.interrupt` exists on both surfaces).

### 5.2 Durability / state

- One nullable column `paused_at: integer()` (epoch millis) on `SessionTable` (core/src/session/sql.ts) — non-destructive additive migration, no default; mirror `time_archived` style. No new table.
- `Session.Info` (schema/src/session.ts) gains optional `pausedAt: DateTimeUtcFromMillis`; `fromRow` (core/src/session/info.ts) maps the column.
- **Atomicity:** set the column and publish the durable event via `EventV2.publish`'s existing `commit` hook (`PublishOptions.commit(seq)`, core/src/event.ts:118-124) — the same pattern SessionInput admission uses (session/input.ts:54-80), so a crash between column write and event publish cannot desync the fast-read column from the replayable stream.
- Location-independent: enforcement happens at whatever Location the drain runs; `LocationServiceMap`/placement untouched. Restart: nothing auto-drains on startup (no crash-continuation per AGENTS.md), so a persisted pause is naturally preserved and the gate keeps refusing wakes.

### 5.3 Execution interplay + app wiring

**Enforcement — two gates (t3 rev 2 §3):**
1. **Hard gate** at the top of `SessionRunner.run()` (core/src/session/runner/llm.ts, after `getSession`): if `session.pausedAt` set → return before promotion/provider turn. `SessionStore.get` reads fresh from the DB (store.ts:35-38), so the gate is sound with no cache staleness. Covers every wake path uniformly (prompt wake, coalesced follow-up, queue promotion).
2. **Prompt gate** in `V2Session.prompt` (core/src/session.ts:374-399): if paused, skip `execution.wake` (admit-only) so no drain is even scheduled. **Delivery is NOT overwritten (S3)** — the gate is the single enforcement point; a steer typed while paused promotes ahead of queues on resume (newest intent first).

**Mid-drain pause:** endpoint sets flag + `execution.interrupt`; the in-flight turn settles exactly as today (llm.ts:295-310); the coordinator sets `stopping=true`, clears `pendingWake`, and starts no successor (run-coordinator.ts:94-101). A concurrent in-flight wake produces a successor drain that hits the gate and returns — no new coordinator logic.

**Queued inputs:** rows with `promoted_seq IS NULL` stay durable under pause (gate blocks promotion); the count badge derives from the same query `SessionInput.hasPending` uses. Promoted-but-unfinished rows keep `promoted_seq` (not re-promoted) — resume with no new input finds nothing pending and returns, leaving the interrupted turn visible (t2 D5).

**Events (schema/src/session-event.ts — add to BOTH `DurableDefinitions` and `Definitions`; `durable: {aggregate:"sessionID", version:1}`):**
- `session.next.paused` — `{ timestamp, sessionID }`
- `session.next.resumed` — `{ timestamp, sessionID }`

They flow through `GET /api/session/:sessionID/event` SSE and `session.history`, so every client renders from the same replayable stream. **The app must key off these (S5)**, not off `session.execution.*` (which nothing currently emits):

- `packages/app/src/context/server-session.ts` — in `applyV2`: `session.next.paused` → sidecar `session_paused(sessionID) = true`; `session.next.resumed` → false. Add the `session_paused(id)` accessor to the store (server-session.ts:196-210 area) and **fix `session_working(id)` to exclude paused** — it is today `type !== "idle"` (server-session.ts:207-209).
- `packages/app/src/context/global-sync/child-store.ts:232-235` — same `session_working` fix (S2).
- `packages/app/src/context/global-sync/event-reducer.ts:267-271` — second consumer of the legacy `session.status` event (feeds the child-store/sidebar path). Its `session_status` write is fed by the same never-emitted-for-V2 source as the primary path; when the sidecar lands, BOTH sync paths must agree on `session_paused` (give the global-sync reducer the `session.next.paused/resumed` cases too, or the sidebar workspaces drift from the session page — cartographer's t1 §2/§4 confirmation).
- `packages/app/src/context/server-sync.tsx` `seedActiveSessionStatuses` (server-sync.tsx:168-177) — map active `{type:"paused"}` → sidecar true (and do NOT map it to busy).
- `packages/app/src/utils/server-compat.ts` — `pause`/`resume` passthroughs.
- `SessionStatus.Info` union is **unchanged** (sidecar approach, S4); `session_status` stays `idle|retry|busy`.

**Working-signal caveat (pre-existing, carries into the tab Stop affordance).** t1 confirmed that under the V2 backend nothing publishes a live busy/idle event: the app's `session_working` is optimistic (submit.ts sets busy before the request) + mount-seeded from `session.active` (a query fetched ONCE — `staleTime: Infinity, refetchOnMount: false`, server-sync.tsx:153-166), and `session.execution.*` are consumed but never emitted (llm.ts:52 unchecked TODO). Consequences for this design: (a) the paused/resumed state rides ONLY on the new durable events + active seed — it does not depend on the broken busy/idle channel; (b) the tab's *Stop* button visibility inherits today's working-signal reliability — a stale "working" tab shows Stop over an idle session, which is benign (idle interrupt is a no-op); a *missing* button while working is the same gap the composer already has today, so the tab adds no new failure mode. Fixing the V2 busy/idle lifecycle is a separate prerequisite (recommend a durable execution-lifecycle event; see §8 slice 2 note).

### 5.4 Files that change (implementation checklist)

Schema: `schema/src/session.ts` (Info.pausedAt), `schema/src/session-event.ts` (Paused/Resumed + inventories).
Core: `core/src/session/sql.ts` (column), new `core/src/database/migration/<ts>_session_pause.ts` + register, `core/src/session/info.ts`, `core/src/session.ts` (Interface + `pause`/`resume` + prompt gate), `core/src/session/runner/llm.ts` (runner gate).
Protocol: `protocol/src/groups/session.ts` (2 endpoints, `SessionActive` widening).
Server: `server/src/handlers/session.ts` (2 handlers; NotFoundError mapping; active union per S6). V1: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` + `handlers/session.ts` (2 legacy routes + `patch()`-routed write per R1).
SDK regen (public Protocol surface changed): `packages/client` `bun run generate`; `packages/sdk/js/script/build.ts`.
App: server-session.ts, child-store.ts, server-sync.tsx, server-compat.ts, prompt-input(-v2).tsx (companion), plus the UI files in §6 of t4.
Tests: `core/test/session-pause.test.ts` (pause blocks drain; prompt-while-paused admits without wake; resume drains 1-at-a-time; no auto-retry; restart survival; idempotence; mid-drain race); extend `opencode/test/server/httpapi-session.test.ts` (endpoints + active incl. paused).

---

## 6. Edge cases

| Scenario | Behavior |
|---|---|
| Stop mid-stream | Turn killed; assistant settled "Provider turn interrupted" (partial text preserved); session → idle; queue untouched. |
| Stop while idle | No-op (interrupt semantics); UI disables Stop when not working. |
| Pause mid-stream | Interrupt fires (same settlement as stop) + `paused_at` set + event; tab shows pause glyph + Resume. |
| Pause mid-tool | Tool fiber cancelled; tool marked interrupted with truthful `executed`; applied side effects stand (D7); detached child processes may outlive briefly (interrupt is process-local); the next run's `failInterruptedTools` marks stragglers. |
| Pause while idle (with queued work) | Flag + event only; held inputs stay; nothing drains. |
| Pause while idle (no work) | Flag + event only; idempotent. |
| Resume with held queue | Clears flag + event + wake; queue drains 1-at-a-time via existing `promoteNextQueued`. |
| Resume with no pending input (paused mid-turn) | Un-pauses; drain finds nothing pending and returns; interrupted turn stays visible; user must re-prompt or (future) Retry. No auto-retry (D5). |
| New prompt while paused | Admitted durably (delivery preserved per S3), wake skipped; promotes on resume with steers before queues. |
| Steer arrives during pause | Same as above — the durable gate, not delivery mode, is authoritative over *when* it runs. |
| Server restart while paused | `paused_at` persisted; nothing auto-drains (no crash-continuation); clients reseed paused from `session.active`/`session.get`; Resume works. |
| Server restart while working (no pause) | Run is lost (process-local, no crash-continuation per AGENTS.md); transcript tail shows the incomplete turn; queued inputs persist. |
| Second client (TUI + app) | Both render from the same durable events + `session.active`; pause/resume from either client is authoritative and visible to both. |
| Pause lands while a wake is in flight | Endpoint interrupts (clears pendingWake); a successor drain would hit the runner gate and return. Requires a targeted test. |
| Close a tab while working/paused | No session state change — tab is a view; run continues; paused stays paused. |
| Pause all (batch) | Loop of per-session pause endpoints; no shared state (D6). Out of scope for v1. |

---

## 7. Open questions & risks

### Open questions
1. **Retry-interrupted-turn affordance** (t2 D5 "future explicit user action"): a "Retry" affordance on the interrupted turn would make Pause→Resume feel complete. Requires designing message-level retry semantics (new admitted input mirroring the original vs replay) — deferred, explicitly out of scope.
2. **TUI parity**: TUI calls `session.interrupt`/`session.active` today; it needs the two new verbs + paused rendering to match. Endpoints/events are client-agnostic, so TUI can adopt later — but "paused" in `session.active` will already change TUI behavior (its status renderer must not crash on the widened union).
3. **Pause attribution** (who paused, multi-user) — YAGNI for v1; a timestamp suffices for tab rendering.
4. **Persist the Resume button** on paused tabs beyond hover/active (t4): recommend A/B during implementation; the avatar-slot glyph already makes paused discoverable.

### Risks (top 3 — handoff)
1. **Expectation gap: pause ≠ resume-the-turn (HIGH).** Users will click Pause mid-response expecting the same response to continue on Resume. It cannot: LLM streaming has no continuation token and interrupt finalizes the turn. Mitigation: honest copy ("Pause this session to continue it later"), visible interrupted markers, and the future Retry affordance. This is the #1 product risk.
2. **V2 status-event gap + `session_working` drift (HIGH).** Under the V2 backend no code publishes busy/idle (`session.execution.*` are consumed but never emitted — llm.ts:52 unchecked; `session.active` is fetched once, server-sync.tsx:153-166), so `session_working` is optimistic/mount-seeded and the tab's `working`/Stop rendering can drift from reality. Paused state must therefore be its own source of truth via the durable `session.next.paused/resumed` events + active seed (S5), and `paused ⇒ not working` must be enforced at BOTH `session_working` sites (server-session.ts:207, child-store.ts:232) or a paused tab renders as working with a useless Stop button. A real fix for the busy/idle drift (V2 runner emitting execution-lifecycle events) is a separate prerequisite slice. Stale-working is benign (idle interrupt is a no-op); missing-Stop-while-working is a pre-existing composer gap, not new.
3. **Durability/atomicity + race (MEDIUM).** The column+event pair must commit atomically (`PublishOptions.commit`) or a crash desyncs the fast-read column from the replayable stream; and pause-while-wake-in-flight needs a targeted test (the gate makes it safe, but it is currently untested). Migration must stay additive/non-destructive (repo has destructive V2-reset precedent — keep this one safe).

---

## 8. Suggested implementation slices

Each slice is independently shippable; the design degrades gracefully (older slices = today's behavior, just without pause).

- **Slice 1 — Backend core (pause API, zero UI):** migration + column + `Info.pausedAt` + `SessionV2.pause/resume` + runner gate + prompt gate (skip-wake, keep delivery per S3) + durable events + 2 endpoints + `SessionActive` widening (with the active-union fix, S6) + SDK regeneration + `core/test/session-pause.test.ts` + httpapi tests. Ships `pause`/`resume` usable by CLI/TUI immediately.
- **Slice 2 — App state layer:** `session_paused` sidecar + `session_working` fixes (both sites) + v2 reducer cases for `session.next.paused/resumed` + `seedActiveSessionStatuses` mapping + `server-compat` passthroughs. Pause becomes visible/consistent everywhere (sidebar, composer, page).
- **Slice 3 — Tab UI:** icon glyphs (stop/pause/play in `packages/ui/src/v2/components/icon.tsx`), inline tab button (interrupt / resume), context-menu items, palette commands, `data-session-state`, i18n keys + parity, a11y + RTL per §4, `isTabActionTarget`, title-fade offset. The user-visible feature.
- **Slice 4 — Companion polish (optional):** paused-composer "Paused — will run on resume" text (`prompt.action.paused`), queued count badge on the tab (t2 overlay), TUI parity, settings-suggested keybinds, and — the highest-value follow-up — the Retry-interrupted-turn affordance.
