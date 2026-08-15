# Cross-doc consistency review — Stop/Pause · Retitle · Tab Project Actions

**Status:** DESIGN REVIEW — no code changed except a flagged amendment to `docs/swarm-tab-stop-pause.md`
(critic's own doc; recorded in §R of this file).
**Author:** critic (NIAMH), returning after the store reset — all source claims re-verified on disk 2026-08-13.
**Reviewed docs:**
- `docs/swarm-tab-stop-pause.md` (critic's t5 synthesis) — Stop/Pause chat
- `docs/swarm-session-retitle.md` (retitler) — Regenerate session title (§9 rulings routed to critic)
- `docs/swarm-tab-project-actions.md` (pathfinder) — tab context-menu project actions

**Why this review exists:** the three features share ONE surface
(`packages/app/src/components/titlebar-tab-context-menu.tsx`) and overlapping infra
(durable V2 events in `schema/src/session-event.ts`, `Session.Info` fields, i18n keys,
`SessionActive`, the V1 httpapi vs V2 protocol split). This doc rules each seam
consistent / conflict (severity), appends a reconciliation appendix (§R), and answers
retitle §9 Q1–Q7 (§9).

---

## 0. Verification basis (re-verified after store reset)

| Claim (any doc) | Source check | Result |
|---|---|---|
| `session.renamed` consumed, never emitted | server-session.ts:946 (`event.data.title`, v2 shape); event-reducer.ts:193 (`event.properties.title`, v1 shape); repo-wide emitter grep | **Confirmed** — exactly two consumers, zero emitters |
| `session_working` = `type !== "idle"`, two sites | server-session.ts:207-209; child-store.ts:232-235 | **Confirmed** — identical predicate, both sites |
| `SessionStatus.Info` union = idle\|retry\|busy | schema/src/session-status-event.ts:9-32 | **Confirmed** — no `paused` member |
| `SessionActive` = `{type:"running"}` literal only | protocol/src/groups/session.ts:83-85 | **Confirmed** |
| `session.next.*` namespace exists; no paused/resumed/renamed | schema/src/session-event.ts (inventory :448-479) | **Confirmed** — ~30 events, all three proposals greenfield |
| Durable event shape | session-event.ts:27-49 — `Base = {timestamp, sessionID}` + `durable: {aggregate:"sessionID", version:1}` | **Confirmed** — proposed payloads (`{timestamp, sessionID}` for pause/resume; +`title` for renamed) fit exactly |
| `session.execution.*` consumed but never emitted | server-session.ts:963-969 (busy→idle); emitter grep across core/server/opencode | **Confirmed** — no emitter anywhere |
| V2 protocol has no rename/update/pause/resume | protocol/src/groups/session.ts endpoint list (:146-411) | **Confirmed** — interrupt only (:396-409) |
| V1 httpapi has no pause/resume/regenerate route | opencode/.../httpapi/groups/session.ts `SessionPaths` (:78-105) | **Confirmed** — `abort` (:91) exists; no new routes |
| Desktop sidecar defaults V1 | desktop/src/main/index.ts:67 (`OPENCODE_SIDECAR_V2 === "1" ? "v2" : "v1"`) | **Confirmed** |
| V1 rename → legacy `session.update`; compat has rename/interrupt | server-compat.ts:183-185, :197 | **Confirmed** |
| V1 title write → `session.updated` | opencode/src/session/session.ts:755-757 (`setTitle` → `patch` → publishes `SessionV1.Event.Updated`, :740-748) | **Confirmed** — retitle's "zero app wiring on V1" claim holds |
| i18n keys greenfield | packages/app/src/i18n/en.ts | **Confirmed** — no `command.session.stop/pause/resume/regenerateTitle`, no `command.tab.openRepository`, no `toast.title.*`/`toast.tab.*` |

---

## 1. Seam 1 — V2 event model (schema/src/session-event.ts)

**Verdict: CONSISTENT — no namespace collision.**

- Stop/pause proposes `session.next.paused` / `session.next.resumed` `{timestamp, sessionID}`;
  retitle proposes `session.next.renamed` `{timestamp, sessionID, title}`. All three are
  greenfield in the existing `session.next.*` namespace (verified: no such types today).
  Distinct suffixes, no prefix shadowing, same SSE path (`GET /api/session/:sessionID/event`)
  and `session.history`.
- Both docs correctly require adding to **BOTH `DurableDefinitions`** (session-event.ts:448)
  and **`Definitions`** (:479). Payload shape matches the `Base` + `durable{aggregate:"sessionID",
  version:1}` convention exactly — no schema-level conflict.
- **App reducer coverage — the real seam, and it is correctly handled in both docs:**
  - `applyV2` (server-session.ts:936) currently matches **no** `session.next.*` event for
    session-info/title/status. Every feature must add its own case — there is no shared
    "handles all `session.next.*`" path. Both docs state this.
  - The legacy `session.renamed` consumers (server-session.ts:946 v2 shape `event.data.title`;
    event-reducer.ts:193 v1 shape `event.properties.title`) read **different payload paths**, so
    retitle's mapping is correctly specified as **one case per file**, matching each file's
    existing field. `session.next.renamed` becomes the first real publisher of a renamed event —
    confirmed zero emitters today.
  - Stop/pause correctly extends **both** app consumers (server-session.ts `applyV2` **and**
    global-sync/event-reducer.ts:267-271 + child-store path) so the sidebar doesn't drift from
    the session page. This mirrors retitle's "one case per file" requirement.
- `session.execution.*` busy/idle: confirmed consumed (server-session.ts:963-969) and never
  emitted. Both docs correctly refuse to depend on it (stop/pause S5; retitle doesn't touch
  session_status at all). No cross-doc conflict.

**No change required.**

---

## 2. Seam 2 — Session.Info field collisions

**Verdict: CONSISTENT — zero overlap.**

| Feature | Info/schema surface | Notes |
|---|---|---|
| Stop/Pause | `Session.Info.pausedAt?: DateTimeUtcFromMillis` + `SessionTable.paused_at` column | Additive optional; `fromRow` maps it. No other Info change. |
| Retitle | **None.** Uses existing `Info.title` + process-local pending registry (`Ref<Map<SessionID,...>>`), not a schema field | Correct — pending state is process-local by design, like SessionExecution. |
| Project actions | **None on Session.** `session.directory` already exists. New surface is `Vcs.Info.remote` (V1) / `ProjectV2.Resolved.remote` (V2) + new `vcs` protocol group | Different domain contract (project/vcs), not session. |

- The only shared mutable cell is the session row's `title` column. Pause never writes title;
  retitle never writes `paused_at`; project actions write neither. Mutually disjoint writes.
- `pausedAt` naming vs retitle's `pending`/`titleGeneration` naming: retitle's names are
  client-side registry keys, not Info fields — no schema conflict.
- Retitle §4.4 persisted setting key `settings.general.titleGeneration` is app-local persisted
  state, not `Session.Info` — out of scope of this seam.

**No change required.**

---

## 3. Seam 3 — i18n key collisions

**Verdict: CONSISTENT — no collisions (verified against en.ts). One LOW style nit.**

| Namespace | Stop/pause | Retitle | Project actions | Collision? |
|---|---|---|---|---|
| `command.session.*` | stop, pause, resume (+.description) | regenerateTitle (+.description, .pending) | — | No — distinct keys; existing keys (previous/next/archive/compact/fork/…) untouched |
| `command.tab.*` | — | — | openRepository | No — existing close/reopenClosed/closeLeft/closeRight/closeOthers/closeAll untouched |
| `common.*` | stopSession/pauseSession/resumeSession | reset/save/cancel (reuse) | requestFailed (reuse) | No |
| `tab.state.*` | working, paused | — | — | No (greenfield) |
| `prompt.action.*` | paused | — | — | No (`prompt.action.stop` reused, :382) |
| `toast.title.*` | — | regenerated, failed, keepExisting | — | Greenfield — **but see style nit** |
| `toast.tab.*` | — | — | copyPathFailed | Greenfield — same style nit |
| `session.header.*` / `session.share.*` | — | — | open.finder/fileExplorer/fileManager, open.copyPath, share.copy.copied — **reuse existing** (:826-848, :869) | No — reuse is exactly right; verified those keys exist |
| `settings.general.*` / `dialog.titlePrompt.*` | — | section/rows/dialog keys | — | No (greenfield) |

**Style nit (LOW, no action required):** the repo's toast-key convention is
`<domain>.toast.<name>.title` (e.g. `prompt.toast.pasteUnsupported.title`,
`provider.connect.toast.connected.title`). `toast.title.*` and `toast.tab.*` deviate from it.
Optional rename to `session.toast.titleRegenerated.title` etc. — cosmetic; not a collision and
not worth churn this round. Project-actions' avoidance of `toast.session.share.copyFailed.title`
(URL-specific) is correct.

**No change required.**

---

## 4. Seam 4 — Menu layout contract

**Verdict: CONSISTENT — one binding contract, three docs at decreasing precision. No conflicting separators or grouping.**

Binding contract (pathfinder §3, adopted by retitle §5.1):

```
[Stop session]          ← stop/pause group (t4/uxsmith; disabled when not applicable)
[Pause session]
[Resume session]
─────── separator ───────
[Regenerate title]      ← retitle (t6); enabled while paused
─────── separator ───────
[Open in Finder/Explorer…]  ← project group (P1 disabled on web/remote; P2 always; P3 hidden w/o remote)
[Copy path]
[Open repository]
─────── separator ───────
[Close tab] … [Close all tabs]  ← existing Close group, unchanged, last
```

| Doc | Statement | vs contract |
|---|---|---|
| Project actions §3 | Exact 4-group order + separators between every group + Close last | Binding contract itself |
| Retitle §5.1 | Prose adopts the exact 4-group order; ASCII sketch shows only one divider (before Close) | **Consistent** — sketch is schematic; prose is explicit |
| Stop/pause §4.1 | "Stop / Pause / Resume items above the Close group" | **Compatible but least precise** — title + project groups also sit above Close, so nothing conflicts; should point at pathfinder's contract as binding (§R4) |

Shared conventions, all three agree:
- **Icon-free in v1** (uxsmith t4 v7 resolution, adopted by pathfinder §3 + retitle §5.2).
- **No keybinds** (stop/pause S8 no-default-keybinds; retitle "No keybind"; pathfinder "none").
- **Draft tabs**: project group renders nothing; Close unchanged. Stop/pause doc doesn't address
  draft tabs (its inline button is per-session too) — no conflict, same behavior.
- Disabled-vs-hidden variance (P1 disabled, P3 hidden) is deliberate and documented — not a conflict.

Retitle item enabled-while-paused (§5.2, §7 edge #10) is consistent with the pause doc: pause
gates the drain pipeline, not the menu (see §9 Q6).

**No change required (one LOW precision pointer in §R4).**

---

## 5. Seam 5 — V1 vs V2 protocol split coherence

**Verdict: retitle and project-actions are coherent dual-path designs. Stop/pause has ONE real gap — MEDIUM (CONFLICT with the shared V1-default reality).**

The shared reality (verified): the desktop app's actual surface is **V1** by default —
`detectServerProtocol` (server-protocol.ts) resolves "v1", and the sidecar defaults to V1
(desktop main/index.ts:67). Both the retitle and project-actions docs are built on that fact.
The stop/pause doc is not.

### 5.1 Retitle — coherent ✓
- V1 httpapi route ships **first** (the desktop path); V2 protocol + durable
  `session.next.renamed` is the mirror. V1 handler writes through legacy `Session.setTitle` →
  `patch` → publishes `SessionV1.Event.Updated` — verified; the app's `session.updated`
  consumers (server-session.ts:1002-1007, event-reducer.ts:146) already render full info, so
  "zero app event wiring on V1" is correct.
- Dual regens called out (`packages/client` `bun run generate` + `packages/sdk/js` build).
- **App consumes V1 or V2 per protocol:** V1 path → `session.updated` (full info, incl. new title);
  V2 path → `session.next.renamed`. Correct.

### 5.2 Project actions — coherent ✓
- V1 first (extend `Vcs.Info` with `remote?` + re-enable `compat.vcs.get`), V2 mirror (new `vcs`
  protocol group, `remote?` on `ProjectV2.Resolved`), single client entry via compat — the menu
  never branches on protocol. Explicitly notes the app's V1 surface. Correct.

### 5.3 Stop/pause — GAP (MEDIUM)
The backend spec (§5.1, §5.4) defines the endpoints **only** in the V2 protocol
(`protocol/src/groups/session.ts` + `server/src/handlers/session.ts`) and the app wiring (§5.3)
says `server-compat` gets pause/resume passthroughs + `applyV2` gets `session.next.paused/resumed`
cases. But:

1. **No V1 httpapi route exists** (verified — the V1 session group has `abort` but no pause/resume),
   and the doc's changed-files list never touches the V1 httpapi. On the default V1 desktop
   connection there is **no endpoint to call** — the compat passthrough has nothing to pass
   through to.
2. **No V1 event path exists.** `session.next.paused/resumed` flow over the V2 SSE only. On V1,
   the app never sees them; the sidecar would only ever be seeded, never updated live (and
   `session.active` on V1 is not widened either, since `SessionActive` lives in the V2 protocol).
3. Net effect: **pause/resume would silently not exist on the primary desktop surface** — the
   same class of gap the stop/pause doc itself flagged as High severity in its own stress-test
   (S1: "would ship a handler against a non-existent endpoint"). Here it's the inverse: ships an
   endpoint no reachable client can hit.

**Resolution (R1, amended into the stop/pause doc — critic's own doc, flagged):** mirror retitle's
V1-first treatment:

- **V1 httpapi routes**: `POST /api/session/:sessionID/pause` + `/resume` in the V1 session group
  (abort pattern, `SessionPaths`), V1 handler in `handlers/session.ts` calling the same core
  `SessionV2.pause/resume` the V2 handler calls.
- **V1 event path**: route the `paused_at` write through the legacy `patch()` (like `setTitle`
  does) so the **existing** `session.updated` event carries `pausedAt` in its full `info` payload.
  The app then derives the sidecar from `info.pausedAt` on the V1 path (server-session.ts
  `session.updated` consumer already remembers full info) and from `session.next.paused/resumed`
  on the V2 path — **plus** `session.active`/`session.get` seeding on both. No new V1 event type;
  the durable V2 events remain the V2-side live signal.
- **Compat routing**: `pause`/`resume` passthroughs dispatch to the legacy routes when
  protocol === v1, to the V2 client otherwise (exactly the rename pattern at server-compat.ts:183-185).
- Fallback if V1 route work is deferred: **gate the pause UI on `protocol === "v2"` in slice 1**
  (Stop needs no gate — `interrupt` already exists on both surfaces).

### 5.4 Summary of per-feature app consumption

| Feature | V1 (default desktop) | V2 (opt-in sidecar) |
|---|---|---|
| Stop | `session.interrupt` (exists on both) | `session.interrupt` |
| Pause/Resume | **R1: V1 route + `session.updated` carries `pausedAt`** (gap today) | V2 endpoint + `session.next.paused/resumed` |
| Retitle | V1 route + `session.updated` (title) | V2 endpoint + `session.next.renamed` |
| Open repo | `compat.vcs.get` → legacy `instance.vcs` (extended) | `compat.vcs.get` → new `client.vcs.remote` |

---

## 6. Seam 6 — cross-feature interactions (regenerate × pause × project)

- **Regenerate-while-paused**: consistent across docs (see §9 Q6). No interaction with the
  paused sidecar, `session_status`, or `session.active` — `SessionTitle` never touches them.
- **Pause × project actions**: P3's Vcs round-trip is client/server plumbing, no session-state
  interaction. P1/P2 read `session.directory` only. No seam.
- **Queued/pending vocabulary**: pause's "queued" (unpromoted `session_input` rows) vs retitle's
  "pending" (title-generation registry) — distinct concepts, no collision of meaning or code.
- **Both events share the SSE + `session.history` path**: `session.next.paused/resumed/renamed`
  interleave on the same stream; the reducer cases are per-type and disjoint. No ordering hazard
  beyond what per-type matching already provides (a rename while paused is fine; a pause during
  generation is fine — both sides stated).

**Verdict: CONSISTENT.**

---

## 7. Seam verdict table

| # | Seam | Verdict | Severity |
|---|---|---|---|
| 1 | V2 event namespace + app reducer coverage | Consistent | — |
| 2 | Session.Info field collisions | Consistent | — |
| 3 | i18n key collisions | Consistent (1 LOW style nit) | LOW (optional) |
| 4 | Menu layout contract | Consistent + 1 ruled discrepancy (Pause idle-disabled vs pause-while-idle) | LOW (R4, R6) |
| 5 | V1/V2 protocol split | **Conflict in stop/pause doc** — no V1 route/event path | **MEDIUM** (R1) |
| 6 | Cross-feature interactions | Consistent | — |

---

## 8. Retitle §9 rulings (critic, after store reset)

Retitle §9 already records decisions with peer endorsements; as the returning critic I
re-rule on each (source-checked above). **All stand.**

| # | Question | Ruling | Rationale (critic) |
|---|---|---|---|
| Q1 | Async vs sync endpoint | **ASYNC — CONFIRM** | Title gen is "post-run bounded background work"; a sync endpoint blocks an HTTP request on an LLM call. Client pending map + toast mirrors the Stop-button pattern (optimistic fire + event-driven settle). The baseline-compare apply guard makes async safe against rename races. |
| Q2 | Supersede vs 409 on concurrent regenerate | **SUPERSEDE — CONFIRM** | 409 is a lost race the clients can't win (app + TUI can fire concurrently; the menu-disabled guard is client-local). Per-session requestID replacement + baseline compare is deterministic and mirrors the existing "manual rename wins" invariant. Process-local registry is fine: both clients of one server share it; a server restart loses it (edge #11) — no partial write possible (atomic row update). |
| Q3 | Prompt editor: modal vs inline | **MODAL — CONFIRM** | Multi-line textarea + token legend + reset-to-default + read-only default reference needs a dialog, not a settings row. Matches dialog-settings-v2 pattern; Esc-to-close retained. |
| Q4 | `title_prompt` config key | **INCLUDE — CONFIRM** | Load-bearing: the S6 auto-title path (V2 runner post-run hook) has no client to send `prompt` — without the key auto-title is stuck on the default forever. Precedent: `small_model`. Cascade `request.prompt → config → default` is unambiguous and collides with nothing in the other two docs. |
| Q5 | Menu placement | **SIGNED OFF** | The 4-group order + separators is now the binding contract (pathfinder §3, adopted retitle §5.1); verified consistent across all three docs (§4). Icon-free, no keybinds — agreed on all sides. |
| Q6 | Regenerate while paused | **RUNS — CONFIRM** | Boundary principle holds structurally: the pause gate sits at the top of `SessionRunner.run()` (drain pipeline); `SessionTitle` calls the LLM directly and is never routed through `run()` (coremith's structural condition), so the gate cannot block it. It never un-pauses, never promotes inputs, never touches `paused_at` or the sidecar — the tab stays visibly paused. Auto-title is excluded for free: a paused session's drain never reaches the post-run hook, plus S6's non-interrupted-completion condition. **One cross-doc wording fix needed**: stop/pause §2.1's "no provider turn" reads as if ALL LLM calls are gated while paused; it must be scoped to the session drain's provider turn (R2 — amended into the stop/pause doc). |
| Q7 | Resolve default-model label in picker | **DEFER — CONFIRM** | Requires a location-scoped catalog read in settings context + agent/session config; a concrete label could mislead. YAGNI for v1. No cross-doc impact. |

---

## 8.5 uxsmith §10.2 flag — Pause disabled-when-idle vs pause-while-idle state model

**Flag** (uxsmith, t9 handoff, routed to critic): the combined menu spec (project-actions §10)
keeps `Pause disabled = !working`, but the t5 state model (§3 transitions, edge cases, user
story) treats **pause-while-idle** as first-class — specifically "idle with queued inputs held
so nothing drains while away", the second half of the user story.

**Ruling: adopt the refined rule `disabled = paused OR (idle AND no pending inputs)` for the
Pause menu item (and the palette command where applicable).** Rationale:

- The t5 gate exists precisely so that steers/follow-ups arriving during pause never start
  anything. The natural moment to set that hold is often when the session is **idle with queued
  follow-ups** (or right before a step-away) — not only mid-run. A menu that disables Pause when
  idle makes that scenario reachable only via the palette, undercutting the primary affordance.
- Server-side cost is zero: idle-pause is already spec'd as "flag + event only; held inputs stay"
  (edge case) and is idempotent. The refined rule only changes *reachability*, not semantics.
- Implementation dependency: the rule needs a client-side pending-input count. The t5 doc's
  optional queued-badge derives from the same `SessionInput.hasPending`-style read — promote that
  read into the tab store (slice 3) so both the badge and the menu rule share it. If the pending
  count is deferred, interim fallback: keep `!working` in the menu, keep the palette `pause`
  command always-available (it already has no disabled state), and flip to the refined rule with
  the badge slice.
- Everything else in uxsmith §10.2 stands: fixed 3 slots, disabled-only switching (never reorder),
  Stop/Pause enabled while working, Resume while paused, stopped-transient all-disabled, retitle
  always enabled except while pending.

This reconciles t5 §4.1 (as amended, §R6) with uxsmith §10.2 — the discrepancy was flagged on
both sides and is now resolved by ruling, not by silent edit of either doc.

---

## 9. Reconciliation appendix (exact resolutions)

Applied/flagged corrections. Only the stop/pause doc (critic's own) is edited; the other two are
not touched.

| # | Severity | Doc | Resolution |
|---|---|---|---|
| **R1** | MEDIUM | stop/pause | **V1 desktop path for pause/resume.** Add V1 httpapi routes (`POST /api/session/:sessionID/pause\|resume`, abort pattern) + V1 handler; route the `paused_at` write through legacy `patch()` so the existing `session.updated` event carries `pausedAt` in its full info (app's `session.updated` consumer remembers full info already — server-session.ts:1002-1007); compat passthroughs dispatch legacy-vs-V2 by protocol (rename pattern, server-compat.ts:183-185). Fallback: gate pause UI on `protocol === "v2"` in slice 1. **Amended into stop/pause §5.1 + §5.4; flagged in this doc and the handoff.** |
| **R2** | LOW | stop/pause | **Scope the §2.1 gate language.** "no promotion, no provider turn, no wake" must read "no **drain** provider turn" — side-channel maintenance (e.g. retitle's `SessionTitle`) is not gated. One-line clarification, **amended**; resolves the only wording that could make Q6 look like a conflict. |
| **R3** | LOW | retitle (NOT edited) | Toast key naming nit: `toast.title.*` / `toast.tab.*` deviate from the `<domain>.toast.<name>.title` convention (`prompt.toast.*`, `provider.connect.toast.*`). Optional: `session.toast.titleRegenerated.title` etc. No collision; no action required. |
| **R4** | LOW | stop/pause | §4.1 menu prose should reference pathfinder §3 as the binding layout contract (it currently only says "above the Close group" — compatible, but the authoritative separators/grouping live in the project-actions doc). Point added. |
| **R6** | LOW | stop/pause | **Pause menu rule refined** (uxsmith §10.2 flag): `disabled = paused OR (idle AND no pending inputs)` instead of `disabled = !working`, so pause-while-idle-with-queued-work is menu-reachable (first-class user-story scenario). Requires the pending-input count in the tab store (promote the queued-badge read to slice 3). Ruling detailed in §8.5; amended into stop/pause §4.1. |
| R5 | — | none | Project-actions doc needs no corrections. |

---

## 10. Files changed by this review

- `docs/swarm-cross-doc-review.md` — this deliverable (NEW).
- `docs/swarm-tab-stop-pause.md` — amendments R1, R2, R4, R6 (critic's own doc; flagged above).

---

## 12. t8 merge review — coremith §5.1 `CompatibleVcsApi` re-type (2026-08-13)

coremith requested a double-check of the `CompatibleVcsApi` re-type after the t8 handoff
(docs/swarm-v2-vcs.md §5.1). Source-verified verdict:

**CONFIRMED necessary + directionally correct. One scope expansion — MEDIUM (compile break
across 9 files if missed; mechanical fix, caught at typecheck).**

Verified:
1. **Necessary.** After `bun run generate`, `ServerApi["vcs"]` becomes `{ remote }` only. The
   active compat `status`/`diff` overrides (server-compat.ts:339/:343) are typed against
   `Parameters<ServerApi["vcs"]["status"]>`/`["diff"]` → compile break. `CompatibleApi` must add
   `"vcs"` to its `Omit` list — the proposed `Omit<ServerApi, "session" | "permission" | "vcs">`
   is correct.
2. **Shape.** `CompatibleVcsApi = ServerApi["vcs"] & { get, status, diff }` → post-regen
   `{ remote, get, status, diff }`. Correct; the `...input.current.vcs` spread in the compat
   namespace then carries `remote` (needed for the v2 `get` → `input.current.vcs.remote` passthrough).
3. **Inputs.** The narrower re-typed inputs (no `workspace`, no `requestOptions`) typecheck all
   real call sites: `layout.tsx:1537/:1605` `status({ location: { directory } })`,
   `session.tsx:703/:751` `diff({ location: { directory }, mode, context? })`, menu
   `get({ location: { directory } })`. Narrow is sound today; flag for future widening if a call
   site ever passes `workspace`.
4. **Not affected by the client regen:** `bootstrap.ts:429` uses the LEGACY sdk
   (`OpencodeClient`, `@opencode-ai/sdk/v2`) and is v1-guarded; `session.tsx` `VcsFileDiff` comes
   from the legacy sdk too. Both survive; the legacy sdk regen (`build.ts`) keeps status/diff
   because the v1 server keeps them.

**Scope expansion (the flag):**
- `VcsStatusOutput` / `VcsDiffOutput` / `FileDiffInfo` / `VcsFileStatus` **vanish from
  `@opencode-ai/client` after regen** — verified: zero references in protocol/schema/core/server;
  they exist only in the stale vendored dist (types.d.ts:39 `FileDiffInfo`, :797 `VcsFileStatus`,
  :6464/:6501 outputs).
- `FileDiffInfo` is imported from `@opencode-ai/client/promise` in **11 app files** (count
  corrected by coremith, re-verified): server-session.ts:14 (session_diff store),
  global-sync/{types,session-cache(+test),event-reducer}.ts, pages/session/{review-tab,
  session-side-panel}.tsx, pages/session/v2/{review-diff-kinds,review-panel-v2}.ts(x),
  utils/diffs.ts(+test). All 11 break after regen.
- **Fix:** define local byte-identical copies (`packages/app/src/utils/vcs-types.ts`:
  `FileDiffInfo`, `VcsFileStatus`) copied from the stale dist **before** regen overwrites it;
  repoint the 9 imports and the §5.1 re-type signatures at the local types. coremith §11.1's
  "copy the stale dist .d.ts shapes" is the right mechanism — it must be extended from the two
  method signatures to the element/output types + the 9 importing files. The §5.1 code sketch's
  `Promise<VcsStatusOutput>`/`Promise<VcsDiffOutput>` must reference the local copies, not the
  generated names.

Everything else in t8 is consistent with the t7 verdicts (V1-first contract, single compat entry,
menu never branches on protocol, `webUrl` port-preservation is an improvement over pathfinder's
accepted §6.4 edge case, one-protocol-group-serves-both-servers verified via
opencode server.ts:181-185/ProjectV2.node :272). No correction to docs/swarm-v2-vcs.md made by
critic; flag delivered to coremith for §5.1/§11.1 scoping.
