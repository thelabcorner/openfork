# Regenerate Session Title — Feature Design (retitler / JUNIPER)

Status: DESIGN ONLY — no code changed. Standalone doc for the "Regenerate session title"
feature; independent of `docs/swarm-tab-stop-pause.md` (critic owns that one) except for the
shared tab context-menu surface, where placement is coordinated below with t4 (uxsmith) and
task_35c8ab37 (pathfinder).

Feature scope, two parts:
1. **Tab context menu item** — "Regenerate session title" in the session tab's right-click menu.
2. **Settings picker** — choose the title-generation model from ALL models (composer-selector
   UX), plus an **editable title-generation prompt** (default, user-modifiable) opened from an
   "Edit prompt" button next to the model picker (operator requirement).

All file:line references verified against branch `dev` on 2026-08-13.

---

## 1. Problem + user story

Sessions are created with a mechanical default title (`New session - 2026-08-13T...Z`,
`packages/core/src/session.ts:241`). Today the only title-affecting actions are:
- **Auto-title on first prompt** — V1 only: `SessionPrompt.ensureTitle` fires on the first real
  user message (`packages/opencode/src/session/prompt.ts:193-253`). **The V2 runner does NOT
  auto-title** (TODO unchecked at `packages/core/src/session/runner/llm.ts:83`: "Update title,
  summaries, compaction state, and cleanup in bounded background work").
- **Manual rename** — tab double-click inline rename → `session.rename` → legacy `session.update`
  (`titlebar-tab-strip.tsx:104-111`, `server-compat.ts:183-185`).

There is no way to ask the assistant to re-title a session after the fact, and no way to pick
which model does the titling (V1 falls back through `agent.title.model` → `small_model` config →
session model, `prompt.ts:216-221`).

**User story:**
> "I opened a session, typed a throwaway first message, the auto-title was generic (or the V2
> side never titled it at all). The conversation has now taken a clear direction. I right-click
> the tab → 'Regenerate session title' → the tab shows a sensible title. Later I open Settings →
> General → Title generation, pick a cheaper/faster model from the full model list, and edit the
> prompt the titler uses so titles match my style."

**Acceptance criteria**
- Right-clicking any session tab shows "Regenerate session title" above the Close group.
- The action generates a single-line title from the conversation (first real user message pinned,
  newest-first context) and updates the session row; the tab and sidebar titles update live.
- A manual rename made while generation is in flight always wins; generation never clobbers a
  title the user changed (explicit or via rename).
- Failure never overwrites an existing title and surfaces to the UI (toast), not silent.
- Settings exposes (a) a model list styled like the composer selector (search + provider groups)
  and (b) an editable prompt with a default, opened from an "Edit prompt" button.
- Regeneration does not touch the transcript or the session_input queue (no visible message, no
  drain side effects).

---

## 2. V1/V2 reality that shapes this design (verified)

The repo is on the V2 session core, but the **desktop app's actual surface is V1**:

- `packages/app/src/utils/server-protocol.ts:24-35` — `detectServerProtocol` probes `/global/health`;
  the legacy `{healthy:true}` shape resolves `"v1"`. The desktop sidecar defaults to V1
  (`packages/desktop/src/main/index.ts:67`, `OPENCODE_SIDECAR_V2` opt-in) per
  `docs/desktop-build-and-architecture.md §1.1`.
- `packages/app/src/utils/server-compat.ts:86-92` — `createCompatibleApi` picks the V1 API when
  the server is v1. Rename today: `server-compat.ts:183-185` → legacy `session.update`.
- Both message stores coexist in one SQLite DB (V1 `message`/`part` + V2 `session_message`),
  and the V2 `session` table is shared (title lives there). `docs/desktop-build-and-architecture.md §1.3`.
- V2 protocol (`packages/protocol/src/groups/session.ts`) has NO rename/update endpoint today;
  `Session.Info` has `title` only (`packages/core/src/session/info.ts:14-49`).

Consequence: the **primary implementation surface is the V1 httpapi** (what the desktop talks
to), backed by core code that the V2 server can reuse. Protocol changes (V2 endpoint + event)
require BOTH regen steps (`packages/client` `bun run generate` + `packages/sdk/js`
`bun ./script/build.ts`) per `docs/desktop-build-and-architecture.md §4`.

---

## 3. API / backend design

### 3.1 Integration point: a new `SessionTitle` service, NOT prompt admission

**Decision: implement a new companion service `packages/core/src/session/title.ts`
(`SessionTitle`), Location-scoped, and expose a thin `SessionV2.Interface.regenerateTitle`
method on the existing session service (alongside `revert.*` at `packages/core/src/session.ts:447-467`).**

Justification:
- Title generation is **background maintenance**, not a user-visible transcript event. Admitting
  a `session_input` row (as `SessionV2.prompt` does, `session.ts:374-400`) would pollute the
  durable queue and surface a fake user message in history. The runner's own TODO classifies
  title updates under "Post-run maintenance … bounded background work" (`runner/llm.ts:80-83`).
- It needs context + LLM + model resolution but **no tools, no permissions, no continuation
  loop** — a different execution shape than the drain. This matches the companion pattern
  (`SessionCompaction.make({ events, llm, config })`, `runner/llm.ts:109`).
- Location-scoping: the session's catalog/integrations live at its Location; delegate like
  `revert.stage` does (`session.ts:453`: `Effect.provide(locations.get(session.location))`).
- **Structural condition (coremith, Q6): `SessionTitle` calls the LLM directly and is NEVER
  routed through `SessionRunner.run()`.** The pause gate lives at the top of `run()` (t3 rev 3
  §3); anything routed through the runner would be blocked while paused and a user-initiated
  "Regenerate title" would silently no-op. As a standalone service it runs while paused,
  promotes nothing, and never clears the pause flag.
- The same service is the natural home for **auto-title parity** (slice S6, §8): the V2 runner's
  post-run hook calls it with stricter guards, so one implementation serves both manual
  regeneration and first-prompt auto-titling.

`SessionV2.Interface.regenerateTitle(input: { sessionID, model?, prompt? }): Effect<NoContent, ...>`
— resolves the session, snapshots baseline, forks the generation, applies guarded, returns 204.

### 3.2 Endpoint

V2 protocol (`packages/protocol/src/groups/session.ts`, after `session.interrupt` at :396-409):

```
POST /api/session/:sessionID/title/regenerate
payload: { model?: Model.Ref, prompt?: Schema.String }   // model = explicit picker choice; prompt = custom instruction (omitted = default)
success: HttpApiSchema.NoContent
errors:  [SessionNotFoundError, ConflictError, ServiceUnavailableError]
middleware: sessionLocationMiddleware
```

V1 httpapi (the desktop surface, `packages/opencode/src/server/routes/instance/httpapi/`):
`SessionPaths.regenerateTitle = ${root}/:sessionID/title/regenerate` (groups/session.ts :78-105),
declared like `abort` (:253-264), handler in `handlers/session.ts`.

Semantics: the request is **accepted (204) and runs in the background**; the client shows a
pending state and toasts on failure. It never admits a session_input row and never wakes the
drain — regeneration is independent of execution state (works while idle OR while a drain is
running; does not interrupt the drain; per t2/t5, `session.pause` gates the drain, not this
side-service — interplay flagged in §7 Q6).

### 3.3 Pending state + race guards

Process-local registry inside `SessionTitle` (mirrors "SessionExecution is process-global and
Session-ID based"): `Ref<Map<SessionID, { requestID: ulid, baselineTitle: string }>>`.

- On regenerate: `pending.set(sessionID, { requestID: ulid(), baselineTitle: session.title })`.
  A new request **replaces** the previous pending entry (supersede; the stale completion no-ops
  below). The client disables the menu item while pending, so supersede is the backstop for
  double-fire and multi-client races.
- **Apply guard** (checked atomically at write time):
  1. `pending.get(sessionID)?.requestID === thisRequestID` — stale generations never apply.
  2. `store.get(sessionID).title === baselineTitle` — **manual rename wins**: the inline rename
     (`session.update { title }`) changes the row mid-flight; a baseline mismatch discards the
     generated title (client toasts "title kept").
  3. Write `session.title` = sanitized title; clear pending.
- **Failure guard**: any provider/sanitize error clears pending and writes nothing — the
  existing title is never clobbered. Errors surface to the client via the request's error
  (V1 path) or a durable failure event (V2 path, §3.5).
- **Manual regenerate may overwrite ANY title** (default or custom) — the explicit click is the
  user's authorization. The "only overwrite default titles" rule applies to **auto-title only**
  (§6).

### 3.4 Model resolution cascade

1. `request.model` (the settings picker's explicit choice) — highest priority.
2. `AgentV2.get("title").model` override (user config `agent.title.model`, `packages/core/src/plugin/agent.ts:187-192` + `Agent.Info.model` in `packages/schema/src/agent.ts:22`).
3. Config `small_model` (`"provider/model"`, `packages/core/src/v1/config/config.ts:77-79`):
   parse and resolve via the catalog — **NOTE:** `CatalogV2.model.small`
   (`packages/core/src/catalog.ts:234-284`) does NOT read `small_model` today (the V1 provider
   does, `packages/opencode/src/provider/provider.ts:1895-1905`); the service must check the
   config value itself first.
4. `CatalogV2.model.small(session.model.providerID)` (V2 analog of `provider.getSmallModel`,
   `catalog.ts:234-284`).
5. The session's own model (`session.model`, resolved via `SessionRunnerModel.resolve`,
   `packages/core/src/session/runner/model.ts:172-216`).

If nothing resolves → typed error → handler maps to `ServiceUnavailableError`.

### 3.5 Context assembly + sanitize + events

**Context** (reuse the V1 builder shape, `prompt.ts:222-236`, for both stacks):
- Load history (V2: `SessionStore.context` / `SessionHistory.load`, `store.ts:39-41`; V1:
  `SessionV1.WithParts` from the legacy store — the sidecar's real message store).
- Walk **newest-first**, accumulating text; stop at ~8k chars. If the **first real user message**
  was truncated away, **pin it** (prepend) so the model always sees the opening intent.
- Include `previousTitle` (current title string) in the prompt (regenerate variant), replacing
  the `{previousTitle}` placeholder.

**Prompt** (customizable — §5.2): resolved as `request.prompt` → config `title_prompt` → built-in
default `DEFAULT_TITLE_PROMPT`. The model's system prompt stays the fixed `PROMPT_TITLE`
(`plugin/agent.ts:39-82` — "single line, ≤50 chars, same language as the user message, no tool
names"); only the *task instruction* is user-editable. The conversation block is always attached
as a separate `<conversation>…</conversation>` section even when the user's prompt omits the
placeholder.

**Sanitize** (single implementation in `SessionTitle`, shared by both stacks — stronger than
today's V1 post-processing at `prompt.ts:243-249`):
strip `<think>` blocks → strip markdown/code fences/quotes → take first non-empty line → trim →
cap at **60 chars** (58 + `…`). Empty/whitespace result = failure (no write).

**Events / client propagation**:
- **V1 path (desktop, primary):** the handler writes the title through the legacy
  `Session.setTitle` (`packages/opencode/src/session/session.ts:755-757`), which publishes
  `session.updated` with full info (`session.ts:748`) — the app already renders that live
  (`packages/app/src/context/server-session.ts:1002-1007`, home index
  `global-sync/home-session-index.ts:152`). **Zero app event wiring needed on the V1 path.**
- **V2 path:** `SessionTitle` publishes a durable event `session.next.renamed { sessionID, title }`
  — add to **BOTH `DurableDefinitions` and `Definitions`** in
  `packages/schema/src/session-event.ts:448-512` (same inventory slot as the t3 pause events
  `session.next.paused/resumed`; no conflict, same SSE path; greenfield — the inventory has no
  renamed event today). Replayable via `GET /api/session/:sessionID/event`.
  **Explicit client wiring required in BOTH app consumers** (cartographer precision): neither
  existing consumer matches `session.next.*` — `server-session.ts:946` keys on the literal
  `"session.renamed"` reading `event.data.title` (v2 shape), and `global-sync/event-reducer.ts:193`
  keys on `"session.renamed"` reading `event.properties.title` (v1 shape). Add one case per file
  for `session.next.renamed` matching each file's existing payload field. Do not assume the
  legacy consumers match the new event (critic).
- **Note:** the app already consumes a `session.renamed` event shape in two places
  (`server-session.ts:946`, `global-sync/event-reducer.ts:193`) that nothing emits today; the V2
  event is the first real publisher and reuses those consumers (one mapping-key addition).

---

## 4. Settings UI — model picker + prompt editor

### 4.1 Placement

`packages/app/src/components/settings-v2/dialog-settings-v2.tsx` → **General** tab
(`settings-v2/general.tsx`). New `settings-v2-section` "Title generation" inserted after the
existing `GeneralSection` (:327-387) and before `AppearanceSection` (:122-178). A per-server
behavior preference belongs in General, not the Models tab (which is visibility toggles,
`settings-v2/models.tsx`).

### 4.2 Title model row (composer-selector UX)

`SettingsRowV2` (title/description, `parts/row.tsx`) with a trigger that opens the **existing
composer model selector** `ModelSelectorPopoverV2` (`packages/app/src/components/dialog-select-model.tsx:225-544`):
search input + provider-grouped `MenuV2.RadioGroup` + free/latest tags + Manage/credentials
actions. Reuse it via a custom `model` controller (the component already accepts one:
`dialog-select-model.tsx:226-228, 262-299`) bound to the persisted setting instead of
`useLocal().model`, so the list shows **ALL models** (filtered by `model.visible(...)`, i.e. the
same set the composer shows).

- Trigger label: current selection or `settings.general.row.titleModel.default`
  ("Default (small model)") when unset.
- Row description explains the model is used for generating/regenerating session titles.

### 4.3 "Edit prompt" button + editor modal (operator requirement)

An `IconButtonV2`/"Edit prompt" button sits **in the same section, adjacent to the title model
row** (`data-action="settings-title-prompt-edit"`). It opens a dedicated editor **modal**
(`Dialog` from `@opencode-ai/ui/v2/dialog-v2`, same pattern as `dialog-settings-v2.tsx:45`):
- Multi-line `textarea` (spellcheck off), pre-filled with the current custom prompt, or empty
  (meaning "use the default").
- Placeholder legend row documenting the supported tokens: `{previousTitle}` (replaced with the
  current session title) and `{conversation}` (the assembled conversation is **always** attached,
  whether or not the token is present).
- **"Reset to default"** ghost button (`common.reset`) — clears the custom prompt; the modal
  shows the built-in default text as read-only reference so users know what they're resetting to.
- Save (`common.save`) / Cancel (`common.cancel`), `esc` closes.

### 4.4 Persistence + config schema

- **Client persistence:** `persisted(Persist.serverGlobal(serverSdk().scope,
  "settings.general.titleGeneration"))` → `{ model?: { providerID, modelID }, prompt?: string }`
  (`packages/app/src/utils/persist.ts:501` pattern). Sent with each regenerate request
  (`model` + `prompt`). This is required because there is **no config-write API** in the
  protocol today (no `config` HttpApi group), and the desktop app cannot write `opencode.json`.
- **Server config (headless/parity):** optional new `title_prompt: Schema.String` key beside
  `small_model` (`packages/core/src/v1/config/config.ts:77-79`). Resolution: request `prompt` >
  config `title_prompt` > `DEFAULT_TITLE_PROMPT`. Also honored by auto-title (S6). `small_model`
  remains the config-file mechanism for the model; the picker value is a request-level override.
- `DEFAULT_TITLE_PROMPT` = the task section of `PROMPT_TITLE` (`plugin/agent.ts:41-50`),
  extracted verbatim into `SessionTitle` so settings can display it and both stacks share one
  copy.

### 4.5 i18n keys (all new keys added to `en.ts` + every locale; parity test
`packages/app/src/i18n/parity.test.ts` enforced)

| key | EN copy |
|---|---|
| `settings.general.section.titleGeneration` | Title generation |
| `settings.general.row.titleModel.title` | Title model |
| `settings.general.row.titleModel.description` | Model used to generate and regenerate session titles |
| `settings.general.row.titleModel.default` | Default (small model) |
| `settings.general.row.titlePrompt.edit` | Edit prompt |
| `dialog.titlePrompt.title` | Title generation prompt |
| `dialog.titlePrompt.description` | Instructions for the title model. The conversation is always attached; `{previousTitle}` is replaced with the current title. |
| `dialog.titlePrompt.placeholder` | Custom instructions (empty = default prompt) |
| `dialog.titlePrompt.reset` | Reset to default |
| `command.session.regenerateTitle` | Regenerate session title |
| `command.session.regenerateTitle.description` | Generate a new title from this session's conversation |
| `command.session.regenerateTitle.pending` | Generating title… |
| `toast.title.regenerated` | Session title updated |
| `toast.title.failed` | Failed to generate session title |
| `toast.title.keepExisting` | Title kept — it changed while generating |

Reuse existing: `common.reset` (en.ts:899), `common.save` (:321), `common.cancel` (:314),
`dialog.model.search.placeholder` (:170), `dialog.model.empty` (:171), `model.tag.free`/`latest`.

---

## 5. Tab context menu item

### 5.1 Placement (coordinates with t4 + pathfinder)

`packages/app/src/components/titlebar-tab-context-menu.tsx` (currently close-only, :23-37).
Per pathfinder's layout contract (deliverable/task_35c8ab37 §"Menu layout contract", which names
this lane "t6"): top→bottom

```
[t4 Stop/Pause/Resume]   ← uxsmith (paused/working states)
[t6 Regenerate title]    ← THIS FEATURE
[P1/P2/P3 project actions] ← pathfinder
──────── divider ────────
[existing Close group]   ← unchanged
```

So the item sits **above the Close group** (assignment requirement), below the stop/pause group,
above the project actions. Confirms pathfinder's contract (their open question "retitler: layout
contract §3 — needs confirm once t6 lands" is answered YES here).

### 5.2 Item spec

- `MenuV2.Item` labeled `language.t("command.session.regenerateTitle")`, placed between the
  stop/pause group and the project-actions group.
- **Disabled** while a regeneration is pending for that session (client in-flight map keyed by
  `sessionID`); while pending, label swaps to `command.session.regenerateTitle.pending`
  ("Generating title…"), **label-only — no spinner inside the item** (MenuV2 closes on select,
  so the pending state only shows on re-open; the disabled+label swap is the double-fire guard).
- **Enabled while paused** (stop/pause feature): retitle is a deliberate user action orthogonal
  to execution gating — it never admits session_input, never touches `paused_at` or the runner
  gate. Unlike Stop (disabled when nothing runs), retitle has no pause-disabled state (critic Q6).
- Disabled on draft tabs (no session — DraftTabSlot already has no context menu; only
  SessionTabSlot wraps it, `titlebar-tab-strip.tsx:55-71`).
- No keybind. Command-palette parity: register `command.session.regenerateTitle`
  (+ `.description`) in `use-session-commands.tsx` sessionCmds (targets the active session),
  matching `command.session.compact` etc. (en.ts:95).
- Handler: `ctx.sdk.api.session.regenerateTitle({ sessionID, model?, prompt? })` (new compat +
  V2 client method; §3.2). Optimistic pending → on success toast
  `toast.title.regenerated`; on error toast `toast.title.failed` (title untouched); on
  baseline-mismatch-drop toast `toast.title.keepExisting`.

---

## 6. Auto-title parity + race fixes

- **V1 already auto-titles** the first prompt (`ensureTitle`, `prompt.ts:193-253`) with guards:
  skip forked sessions (`parentID`), skip unless `isDefaultTitle` (:200), and only when exactly
  one real (non-synthetic) user message (:202-206). It then sets the title (:250-252).
- **V2 does NOT** (llm.ts:83 TODO). Parity slice (S6): hook `SessionTitle` into the V2 runner's
  post-run maintenance (`runner/llm.ts:80-83`) with the same guards — default title only, exactly
  one real user message, `parentID` none. Model cascade identical to §3.4 (minus `request.model`,
  which auto-title has no request for). **The hook fires ONLY on non-interrupted run completion**
  (coremith): an interrupt-driven drain exit — which is exactly what pause triggers — must not
  auto-retitle. This is naturally satisfied: the runner gate makes the drain exit BEFORE the
  post-run maintenance hook, so a paused session never auto-titles (critic Q6 — no extra guard
  needed).
- **Shared race guards** (one implementation in `SessionTitle`): requestID freshness + baseline
  compare + default-only-overwrite (auto path) + pending cleared on failure + never clobber.
  Auto-title and manual regenerate serialize through the same per-session pending registry
  (auto-title takes a turn like any generation; a pending manual request supersedes it and vice
  versa).
- **Fix in V1 path:** `ensureTitle` today can race the user's own rename of the very first
  message; moving its write behind the same baseline+requestID guard closes it.

---

## 7. Edge cases

| # | case | behavior |
|---|---|---|
| 1 | Manual rename while generation in flight | Baseline mismatch at apply → generated title discarded; toast `toast.title.keepExisting`. Manual rename always wins. |
| 2 | Double-fire / second client regenerate | New request supersedes pending (requestID replaces); stale completion no-ops. Menu disabled client-side while pending. |
| 3 | Provider failure / model unavailable | No write; pending cleared; `ServiceUnavailableError` → toast `toast.title.failed`. Existing title untouched. |
| 4 | Sanitizer yields empty (model output garbage / think-only) | Treated as failure → no write + toast. |
| 5 | Session with zero real user messages | Server no-ops (204, no generation) — nothing to title; menu stays enabled (harmless). |
| 6 | Conversation > 8k chars | Newest-first fill; first real user message pinned so opening intent survives truncation. |
| 7 | Generated title > 60 chars / multi-line | Sanitize: first non-empty line, cap 60 (58 + `…`), strip fences/quotes. |
| 8 | Current title is custom (user renamed earlier) | Manual regenerate allowed (explicit action = authorization); auto-title never touches it (default-only). |
| 9 | Regenerate while a drain is running | Runs concurrently; no session_input admission, no interrupt, no transcript effect. |
| 10 | Session paused (t2/t3 feature) | **Manual regenerate runs while paused** (semanticist boundary principle, endorsed by critic/coremith/uxsmith): pause gates the drain pipeline (`SessionRunner.run()`), not side-channel maintenance — title gen is auxiliary, invisible, non-execution (same class as project refresh). It never un-pauses, never promotes inputs, never starts a drain, never produces transcript content, never touches `paused_at`. The tab stays visibly paused (no spinner/Stop flash; `data-session-state` unchanged). Caveat (semanticist): fine while title-gen is cheap/invisible/one-shot; a future expensive/visible maintenance task would need its own gate. Menu item stays ENABLED while paused (unlike Stop). |
| 11 | Server restart mid-generation | Pending registry is process-local → lost; no partial write (apply is atomic row update). Title stays as-is; client request errors → toast. |
| 12 | Forked / child session | Treated as a normal session (manual action). Auto-title skips `parentID` sessions (V1 guard kept). |
| 13 | Empty/whitespace custom prompt | Falls back to default prompt (no error). |
| 14 | Custom prompt with no `{conversation}` token | Conversation still attached (always-appended section) so the model has context. |
| 15 | `{previousTitle}` in custom prompt | Replaced with the current title string at request time. |
| 16 | RTL / mixed-direction generated title | Stored as-is, single line; existing tab title rendering handles bidi (rtl-aware skill: no new layout). |
| 17 | Custom title-model choice points at a disabled/invalid model | Cascade falls through to the next step; if nothing resolves → `ServiceUnavailableError` toast. |

---

## 8. Implementation slices (server-first, then UI)

**S1 — Core shared pieces** (`packages/core/src/session/title.ts`, new): `SessionTitle` service —
`DEFAULT_TITLE_PROMPT`, sanitizer, context assembly (newest-first + pinned first message),
pending registry, guarded apply, model cascade (request model → agent.title.model → config
`small_model` → `catalog.model.small` → session model — same order as §3.4; most-explicit user
intent first). Extract/duplicate `isDefaultTitle` (V1 regex at
`packages/opencode/src/session/session.ts:48-55`) into core so both stacks share it. Tests:
`packages/core/test/session-title.test.ts` (sanitize, cascade, guards, supersede).

**S2 — V1 server route (the desktop path; ships first)**:
`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` (path + endpoint decl,
modeled on `abort` :253-264) + `handlers/session.ts` (handler: V1 history context, reuse the
`ensureTitle` generation body via a small refactor of `prompt.ts:193-253`, write via
`Session.setTitle` → `session.updated`). Tests: extend `packages/opencode/test/server/httpapi-session.test.ts`.

**S3 — V2 parity**: `SessionV2.Interface.regenerateTitle` (`packages/core/src/session.ts`),
protocol endpoint (`packages/protocol/src/groups/session.ts`), handler
(`packages/server/src/handlers/session.ts`), durable `session.next.renamed` event
(`packages/schema/src/session-event.ts`). Run **BOTH regens**: `packages/client` `bun run generate`
+ `packages/sdk/js` `bun ./script/build.ts`.

**S4 — App state + compat**: `server-compat.ts` `regenerateTitle` mapping (v1: legacy route; v2:
V2 client), persisted `settings.general.titleGeneration`, in-flight pending map, toast wiring.

**S5 — App UI**: context-menu item (placement per §5.1), command-palette entry, settings section
(model row + Edit-prompt modal), i18n keys + parity test.

**S6 — Auto-title parity**: V2 runner post-run hook (`runner/llm.ts:80-83`) calling `SessionTitle`
with default-only + exactly-one-real-user guards; retire the V1-specific ensureTitle write behind
the shared guards.

---

## 9. Decisions log (open questions → resolved by peer review)

| # | question | decision | rationale |
|---|---|---|---|
| Q1 | Async vs synchronous endpoint | **ASYNC** (204 + background + events) | Title gen is "post-run bounded background work" (llm.ts:80-83); a sync endpoint would block the HTTP request on an LLM call. Client pending map + toast mirrors the tab Stop button pattern. |
| Q2 | Concurrent regenerates: supersede vs 409 | **SUPERSEDE** | Pending registry is per-session process-local; two clients (app + TUI) can fire concurrently and 409 loses a race they can't win. Last-request-wins with requestID + baseline compare is deterministic and mirrors "manual rename wins". |
| Q3 | Prompt editor: modal vs inline | **MODAL** (operator requirement) | Multi-line editor + token legend + reset needs room a settings row doesn't have. Esc-to-close kept. |
| Q4 | `title_prompt` config key | **INCLUDE** (load-bearing) | The S6 auto-title path (V2 runner post-run hook) has no client to send `prompt` — without the key auto-title is forced to the default forever. Precedent: `small_model` (config.ts:77-79). Cascade: request.prompt → config → default. |
| Q5 | Menu placement | **SIGNED OFF** (critic, uxsmith, pathfinder) | [Stop/Pause/Resume] → [Regenerate title] → [project actions] → [Close], separators, icon-free, no keybinds. |
| Q6 | Regenerate while paused | **RUNS** (semanticist boundary principle, endorsed coremith/uxsmith/critic) | Pause gates the drain pipeline, not side-channel maintenance. `SessionTitle` is a separate service calling the LLM directly — never through `SessionRunner.run()` (coremith structural condition), so the pause gate can't block it. Auto-title excluded for free: the runner gate makes the drain exit before the post-run hook. Menu item stays enabled while paused. |
| Q7 | Show resolved default-model label in picker | **DEFER** (keep "Default (small model)") | Resolving needs a location-scoped catalog read in settings context and depends on agent/session config; a concrete label could mislead. YAGNI for v1. |

---

## 10. Files that would change (index)

- `packages/core/src/session/title.ts` — NEW: SessionTitle service (guards, cascade, sanitize,
  `DEFAULT_TITLE_PROMPT`, `isDefaultTitle`).
- `packages/core/src/session.ts` — `regenerateTitle` on `SessionV2.Interface` (near :447-467).
- `packages/core/src/session/runner/llm.ts` — post-run auto-title hook (:80-83, slice S6).
- `packages/core/src/v1/config/config.ts` — optional `title_prompt` (:77-79 area).
- `packages/schema/src/session-event.ts` — durable `session.next.renamed` (:448-477).
- `packages/protocol/src/groups/session.ts` — `session.regenerateTitle` endpoint (after :409).
- `packages/server/src/handlers/session.ts` — handler (pattern :408-414).
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` + `handlers/session.ts`
  — V1 route + handler (abort pattern :253-264).
- `packages/opencode/src/session/prompt.ts` — extract `ensureTitle` generation body (:193-253).
- `packages/app/src/utils/server-compat.ts` — `regenerateTitle` (rename pattern :183-185).
- `packages/app/src/components/titlebar-tab-context-menu.tsx` — menu item (§5).
- `packages/app/src/pages/session/use-session-commands.tsx` — palette command.
- `packages/app/src/components/settings-v2/general.tsx` — Title generation section + modal.
- `packages/app/src/context/settings.tsx` — `titleGeneration` persisted setting.
- `packages/app/src/context/server-session.ts` — V2 event mapping (:946 area).
- `packages/app/src/i18n/en.ts` + all locales — §4.5 keys.
- Regens: `packages/client` `bun run generate` + `packages/sdk/js` `bun ./script/build.ts`.
