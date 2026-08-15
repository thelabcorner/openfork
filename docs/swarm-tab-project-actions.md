# Tab context menu: project actions (pathfinder / AIDEN)

Status: DESIGN ONLY — ideation for the swarm's tab-stop-pause effort. No code changed.
Scope: project-related actions in the session tab's right-click context menu
(`packages/app/src/components/titlebar-tab-context-menu.tsx`, currently CLOSE-ONLY).
Companion designs: uxsmith t4 (Stop/Pause/Resume items + inline tab button, deliverable/t4),
retitler t6 (Regenerate session title — LANDED, docs/swarm-session-retitle.md §5.1 adopts the
4-group layout below). The full-menu layout below assumes t4's session-state group and a title
group from t6; the coordination contract is confirmed on all sides — see §4 and §9.

## 1. Action inventory

| # | Action | Label | Data needed | Availability | Execution |
|---|---|---|---|---|---|
| P1 | Open project folder | Platform-aware (Finder / File Explorer / File Manager) | `session.directory` | Desktop + local server only | `platform.openPath(directory)` |
| P2 | Copy project path | "Copy path" | `session.directory` | Always | shared clipboard util + success toast |
| P3 | Open repository | "Open repository" | git remote URL (server round-trip) | When remote resolvable (any platform) | `platform.openExternal(webUrl)` |

Rejected candidates (kept the set tight):
- **Open in new window** — no project-scoped window plumbing exists; the home surface owns
  that concept. Reject.
- **Open terminal in project** — session-header already implements an "Open with…" app menu
  (`session.header.open.app.terminal` + vscode/cursor/zed/ghostty/warp/iterm2/powershell via
  `platform.openPath(dir, app)`, session-header.tsx:257-271). Duplicating it in the tab menu
  gold-plates; a tab-level "Open with…" submenu is optional slice-4 polish reusing the same
  app list.
- **Copy repo URL** — same data source as P3 for marginal value; fold into P3. Optional
  follow-up if P3 lands and users ask.
- **Reveal in file manager** (select the folder in its parent) — `platform.revealPath` is for
  revealing a *file*; opening the folder (`openPath`) IS the folder's reveal. No separate item.

## 2. Per-action spec

### P1 — Open project folder
- **Trigger**: menu item select.
- **Data**: `session.directory` (the session's own directory — equals `project.worktree` for
  root sessions, the sandbox directory for sandbox sessions; matches what the tab preview
  card already shows, titlebar-tab-nav.tsx:65-70). Resolved via the existing
  `projectForSession(session, projects)` (pages/layout/helpers.ts:96) only when a `Project`
  object is needed; the path itself comes straight off the Session.
- **Execution path**: `platform.openPath(directory)` — exactly the home-projects-controller
  reveal pattern (home-projects-controller.tsx:111-119): gate, call, `.catch` → error toast.
  No server round-trip; the path is already client-side.
- **Gate** (same as session-header.tsx:226): `platform.platform === "desktop" && !!platform.openPath && server.isLocal()`.
  Disabled (not hidden) when the gate fails — consistent with t4's disabled-item convention.
  Note: WSL sidecars count as *non-local* connections (server.test.ts:64) — correctly
  disabled, since the path lives in the Linux filesystem.
- **Error handling**: `openPath` rejection → `showToast({ title: common.requestFailed, description: errorMessage(cause) })`
  (home-projects-controller.tsx:113-118 precedent). Covers deleted/moved worktrees.

### P2 — Copy project path
- **Trigger**: menu item select.
- **Data**: `session.directory` string.
- **Execution path**: shared clipboard helper. There is no shared util today:
  session-header.tsx:273-287 uses raw `navigator.clipboard.writeText`; use-session-commands.tsx:154-176
  has a robust local `write()` (textarea `execCommand("copy")` fallback → `navigator.clipboard`).
  **Recommendation**: extract `utils/clipboard.ts` `copyText(value): Promise<boolean>` from the
  `write()` implementation and migrate session-header's copyPath to it (small refactor, flagged
  for uxsmith). Success → `showToast({ variant: "success", icon: "circle-check", title: session.share.copy.copied, description: path })`
  (session-header.tsx:279-284 precedent — the description doubles as visible confirmation of
  what was copied). Failure → new toast key (§5).
- **Availability**: always enabled — works on web, remote servers, and drafts-with-session
  alike. Copying a remote path is harmless and matches session-header, which does not gate
  copyPath on locality.

### P3 — Open repository
- **Trigger**: menu item select.
- **Data**: the project's git remote URL. **Client cannot learn it without a server
  round-trip today** — verified: `Project.Info` carries `vcs: "git"` but no URL
  (schema/src/project.ts:11,31-40); the sync store has no git data; the V2 protocol has no
  git/vcs surface; the V2 `fs` group is experimental and `.git/config` parsing breaks on
  linked worktrees/submodules. See §6 for the full feasibility finding and recommendation.
- **Execution path**: `platform.openExternal(webUrl)` (available on web + desktop,
  platform.tsx:36). Per the agreed wire contract (§6), both servers return the remote
  already normalized to a browser-openable HTTPS URL (scp-style
  `git@github.com:org/repo.git` → `https://github.com/org/repo`), so P3 opens the received
  value as-is — no client-side URL rewriting.
- **Availability**: item **hidden** until the lazy fetch resolves; stays hidden when the
  project is not git or has no remote. Rationale: a disabled "Open repository" with no
  explanation is noise for the (common) no-remote case; conditional visibility is standard
  for data-dependent actions. Draft tabs never show the item (no session).
- **Fetch timing**: lazily on first menu open, cached per directory (in-memory map, ~60s
  TTL, negative results cached ~30s). Zero cost for tabs whose menu never opens.
- **Error handling**: fetch failure → hide item (cache the negative); `openExternal` is
  void and does not throw for our purposes (browser handles it).

## 3. Menu layout proposal (full menu, top → bottom)

```
─────────────────────────────────
Stop session        (disabled when not working)      ← t4 (uxsmith)
Pause session       (disabled when idle/paused)      ← t4
Resume session      (disabled unless paused)         ← t4
─────────────────────────────────
Regenerate title                                     ← t6 (retitler)
─────────────────────────────────
Open in Finder / File Explorer / File Manager        ← P1 (disabled on web/remote)
Copy path                                            ← P2
Open repository                                      ← P3 (hidden without remote)
─────────────────────────────────
Close tab                                            ← existing
Close tabs to the left                               ← existing
Close tabs to the right                              ← existing
Close other tabs                                     ← existing
Close all tabs                                       ← existing
```

- **Coordination contract** (retitler's t6 is unpublished; this doc is written to the plan):
  (1) t4's session-state group is first — it is the tab's primary job; (2) the title group
  sits between session state and project actions; (3) project actions sit between title and
  the Close group; (4) Close stays last, untouched, as the final destructive group.
  Separators via `MenuV2.Separator` (menu-v2.tsx:163-172). If retitler's final layout
  conflicts, the binding rule is: **session-state first, Close last, project group directly
  above Close**.
- **Icons**: none in v1 — RESOLVED with uxsmith (t4 v7): icon-free is uniform across all
  four groups (MenuV2.Item has no first-class leading-icon slot; the existing Close group
  is icon-free; partial iconography reads as broken). If icons are ever wanted: add a
  proper `icon` prop to MenuV2.Item (16px leading column) and apply to ALL items in one
  change, never piecemeal.
- **Draft tabs**: `TitlebarTabContextMenu` also wraps `DraftTabItem` (strip.tsx:200) which
  has no session — the project group renders nothing there; Close group unchanged.
- **Keybinds**: none for project actions (consistent with t5's no-default-keybind decision
  for stop/pause). No palette commands in v1 (menu-only); optional follow-up.

## 4. Data flow: how the menu gets session/project

Today `TitlebarTabContextMenu` receives only `{ id }` (context-menu.tsx:10). The strip
already has everything needed two levels up:

- `SessionTabSlot` (strip.tsx:25-74) has `session: () => Session | undefined` and `tab.server`;
  `SessionTabEntry` (strip.tsx:76-171) has `serverCtx` and the resolved `session`.
- **Change**: extend the menu props to `{ id, session: () => Session | undefined, server: ServerConnection.Key }`
  and pass them from `SessionTabSlot` (strip.tsx:55). `DraftTabSlot` passes `session: () => undefined`.
- Inside the menu: resolve the server context with `useGlobal()` +
  `global.ensureServerCtx(conn)` (exact pattern of TabNavItem, titlebar-tab-nav.tsx:49-52),
  then `projectForSession(session, serverCtx()?.projects.list() ?? [])` (helpers.ts:96) when
  a `Project` is needed (P3's remote fetch). P1/P2 need only `session.directory`.
- P3's remote fetch: `serverCtx.sdk.client.vcs.get({ directory })`-shaped call via the
  compatible API (§6); the menu holds no state — the cache lives in a small module-scoped
  map keyed by `pathKey(directory)`.

## 5. i18n keys

All new keys added to en.ts AND every locale (parity test packages/app/src/i18n/parity.test.ts).

| Key | EN copy | Use | Status |
|---|---|---|---|
| `session.header.open.finder` | Finder | P1 label (macOS) | EXISTING, reuse via `fileManagerApp(platform.os)` (utils/file-manager.ts) |
| `session.header.open.fileExplorer` | File Explorer | P1 label (Windows) | EXISTING, reuse |
| `session.header.open.fileManager` | File Manager | P1 label (Linux/unknown) | EXISTING, reuse |
| `session.header.open.copyPath` | Copy path | P2 label | EXISTING, reuse |
| `session.share.copy.copied` | Copied | P2 success toast title | EXISTING, reuse |
| `common.requestFailed` | Request failed | P1 error toast title | EXISTING, reuse |
| `command.tab.openRepository` | Open repository | P3 label | NEW |
| `toast.tab.copyPathFailed` | Failed to copy path | P2 failure toast title | NEW (do NOT reuse `toast.session.share.copyFailed.title` — it is URL-specific) |

## 6. Git remote feasibility finding (verified)

- **Client-side: nothing.** `Project.Info` = `{ id, worktree, vcs?: "git", name?, icon?,
  commands?, time, sandboxes }` (schema/src/project.ts) — no URL. Session carries
  `directory`/`projectID` only. The sync store (global-sync/utils.ts:170) stores only
  `vcs: "git" | undefined`. No client-side git config cache exists.
- **Server-side: both servers can do it cheaply.**
  - V1 (Desktop's primary surface — the app's `legacy()` client is the directory-scoped
    instance httpapi client, `createOpencodeClient` from `@opencode-ai/sdk/v2/client`, which
    exposes `.vcs` with `get/status/diff`, sdk.gen.ts:2242): the `instance.vcs` endpoint
    (httpapi/groups/instance.ts:83-93) already returns `Vcs.Info` = `{ branch?,
    default_branch? }` (project/vcs.ts:240-244), served by the `@/git` service which can run
    `git remote get-url <name>` (proven pattern: cli/cmd/github.handler.ts:218) and already
    resolves the primary remote name (`primary()`, git/index.ts:156-162). **Cost: ~2 git
    subprocess calls, cacheable.**
  - V2: no git/vcs surface in `packages/protocol` (verified empty grep); core GitV2 has
    `Git.remote.get(repository, "origin")` (core/src/git.ts:205-209) available server-side.
- **Compat layer**: `server-compat.ts:333-338` maps vcs.status/diff to legacy; `vcs.get` is
  COMMENTED OUT — it was previously the Vcs.Info bridge and is the natural re-enable point.
- **Conclusion**: a server round-trip is unavoidable for the remote URL.

**Recommendation (agreed with coremith — v1 AND v2 both land):**
1. **V1 first** (Desktop's real surface): add `remote?: string` to `Vcs.Info`
   (project/vcs.ts) served via `@/git` (`primary()` + `remote get-url`, cached in the Vcs
   InstanceState), and re-enable `compat.vcs.get` (server-compat.ts:335-338) mapping
   `{ branch, defaultBranch, remote }` into the v2-shaped surface. No client regeneration.
2. **V2 mirror — cheaper than v1 (verified, coremith finding)**: `ProjectV2.resolve()`
   (core/src/project.ts:110-122) ALREADY runs `git.remote.get(repo)` — one
   `git remote get-url origin` subprocess (git.ts:205-206) — on every project resolve,
   normalizes BOTH https and scp syntax into host/pathname via `url()`/`parts()`
   (project.ts:81-103), then discards the URL and only hashes it into the project ID
   (project.ts:78). Surfacing it = keep the normalized value on the resolved project.
   coremith's plan: (a) schema `Vcs.Info = { remote?: string }`; (b) `remote?` on
   `ProjectV2.Resolved`, HTTPS-reconstructed server-side via the existing `parts()`
   (one place); (c) NEW protocol group `vcs` — `GET /api/vcs/remote?directory=` →
   `{ data: { remote?: string } }` (absent when no git/origin); (d) server handler →
   resolve → remote; (e) `bun run generate` + legacy sdk rebuild. The current generated
   client (`@opencode-ai/client`) has NO vcs group today (verified: packages/client/src
   has no vcs surface), so the new group does not collide; the legacy sdk's `.vcs`
   (sdk.gen.ts:2242) is a different client.
3. **Single client entry point**: re-enable `compat.vcs.get` as THE menu-facing method —
   v1 servers route it to legacy `instance.vcs` (extended), v2 servers to the new
   `client.vcs.remote`. The menu never branches on protocol.
4. **Wire contract**: both surfaces return a browser-openable HTTPS URL (server-side
   scp→https conversion), so P3 opens the received value with `platform.openExternal`
   as-is — no client-side URL rewriting. Edge case: `parts()` strips scheme/port, so
   remotes on non-default git hosts lose the port in the reconstructed URL — acceptable
   for browser-open (the web UI is on default-port https); noted for coremith's review.
5. Do NOT ship client-side `.git/config` parsing (fs.read is experimental; linked
   worktrees/submodules break naive reads; branch+gitdir resolution is server work).

## 7. Edge cases

| Case | Behavior |
|---|---|
| Draft tab (no session) | Project group not rendered; Close group untouched |
| Web platform | P1 disabled (no `openPath`); P2, P3 enabled (`openExternal` + clipboard exist) |
| Remote server (incl. WSL sidecar) | P1 disabled (path is not local); P2 enabled; P3 enabled if remote resolvable |
| Non-git project / no remote | P3 hidden (lazy fetch resolves empty) |
| Deleted/moved worktree | P1 toast error (common.requestFailed); P2/P3 unaffected |
| Sandbox session | P1 opens `session.directory` (the sandbox), not the parent worktree |
| Fetch failure (P3) | Item hidden; negative cached ~30s |
| Menu opened mid-fetch (P3) | Item appears only after the fetch resolves (cache makes subsequent opens instant) |
| RTL | No directional assets: menu order and separators are flow-driven; labels come from i18n |

## 8. Files that would change (implementation slice)

1. `packages/app/src/components/titlebar-tab-context-menu.tsx` — new props, three groups +
   separators, disabled/hidden logic, handlers.
2. `packages/app/src/components/titlebar-tab-strip.tsx` — pass `session`/`server` into the
   menu from `SessionTabSlot`; `DraftTabSlot` passes `undefined`.
3. `packages/app/src/utils/clipboard.ts` (new) — extract `copyText` from
   use-session-commands.tsx `write()`; migrate session-header copyPath (optional, same PR).
4. `packages/app/src/i18n/en.ts` + all locales — `command.tab.openRepository`,
   `toast.tab.copyPathFailed` (§5, parity test).
5. `packages/app/src/utils/server-compat.ts` — re-enable `vcs.get` bridging `remote`.
6. `packages/opencode/src/project/vcs.ts` + `server/routes/instance/httpapi/groups/instance.ts`
   (and its handler) — add `remote` to `Vcs.Info` (v1 server).
7. coremith's v2 path: `remote?` on `ProjectV2.Resolved` (core/src/project.ts, reuse
   `parts()`), NEW protocol group `vcs` with `GET /api/vcs/remote?directory=` (protocol
   src/groups/vcs.ts), server handler, then `bun run generate` from packages/client.

## 9. Open questions

1. **P3 on v2 servers**: RESOLVED with coremith (verified: ProjectV2.resolve already runs
   `git.remote.get` and discards the normalized URL — core/src/project.ts:73-103). v1 and
   v2 both land; new protocol `vcs` group (`GET /api/vcs/remote?directory=`) + `remote?`
   on `ProjectV2.Resolved`; single client entry via re-enabled `compat.vcs.get`. Wire
   contract: HTTPS-normalized URL from both servers; P3 opens as-is. Port-stripping edge
   case in `parts()` accepted (noted for coremith).
2. **Menu icons**: RESOLVED (uxsmith, t4 v7) — icon-free v1, uniform across all groups;
   future icons via a first-class `icon` prop on MenuV2.Item applied to all items at once.
3. **P2 toast description**: show the full path as the toast description (session-header
   precedent) — confirm it isn't noisy for long paths; alternative is title-only "Copied".
4. **retitler coordination**: RESOLVED — retitler adopted the exact 4-group ordering in
   docs/swarm-session-retitle.md §5.1: [t4 Stop/Pause/Resume] → [Regenerate title] →
   [P1/P2/P3 project actions] → divider → [existing Close group]; no icons, no keybinds
   for the retitle item (palette command only).

---

## 10. Combined menu visual spec (uxsmith sign-off — t9)

Status: DESIGN ONLY, appended by uxsmith (t9, visual sign-off on the combined tab context
menu). Rules the visual contract across t4 (Stop/Pause/Resume), t6 (Regenerate title), and
P1–P3 (project actions) in `titlebar-tab-context-menu.tsx`. IconV2 names verified against
`packages/ui/src/v2/components/icon.tsx` (2026-08-13); MenuV2 verified against
`packages/ui/src/v2/components/menu-v2.tsx`.

### 10.1 Final menu order (top → bottom)

```
─────────────────────────────────
Stop session           disabled when not working
Pause session          disabled when paused OR (idle AND no pending inputs)
Resume session         disabled unless paused
─────────────────────────────────
Regenerate session title   disabled + label → "Generating title…" while pending
─────────────────────────────────
Open in Finder / File Explorer / File Manager   disabled on web/remote
Copy path                                       always enabled
Open repository                                 disabled while in-flight; HIDDEN when no remote
─────────────────────────────────
Close tab / to the left / to the right / other / all   existing, unchanged
```

### 10.2 Ordering-stability ruling (state-dependent items)

**RULING: fixed slots, disabled-only state switching.** The session-state group always
renders exactly three items — Stop, Pause, Resume — in fixed order behind one fixed
separator. State transitions change ONLY the `disabled` flags; never visibility, order,
separators, or group boundaries. The menu height is constant across
working↔paused↔idle, so hit targets and keyboard positions never move.

Rationale:
1. The menu opens under the pointer / at the focused tab; a reorder or pop-in under the
   cursor is a misclick. Disabled items are learnable ("exists but unavailable now") and
   are skipped automatically by arrow navigation.
2. Kobalte measures content at open; mid-open growth/shrink causes hover drift and scroll
   jumps. Constant height = constant hit targets.
3. Disabled-not-hidden matches the t4 convention and keeps the item count constant, so
   muscle memory and keyboard order hold across transitions.

State matrix (context-menu items — NOT the inline tab button, which keeps t4 §4.1's
one-button semantics):

| session state | Stop | Pause | Resume |
|---|---|---|---|
| idle, no pending inputs | disabled | disabled | disabled |
| idle, pending inputs | disabled | **enabled** | disabled |
| working | **enabled** | **enabled** | disabled |
| paused | disabled | disabled | **enabled** |
| stopped (transient ~2s) | disabled | disabled | disabled |

**Pause rule — RESOLVED by critic t7 (R6): `disabled = paused OR (idle AND no pending
inputs)`.** Adopted from the flag below: pause-while-idle-with-queued-work is a first-class
scenario in the state model (stop-pause doc §3 idle→paused transition, §6 edge cases, user
story), and idle-pause is idempotent server-side, so the t4 §4.1 `!working` rule makes it
unreachable from the menu. **Dependency:** the rule needs the pending-input count
client-side — promote the queued-badge read (`SessionInput.hasPending`-style) into the tab
store in slice 3; the badge overlay and this rule share it. **Interim fallback if the badge
slice lands late:** keep `!working` in the menu, keep palette `pause` always-available,
flip to the R6 rule with the badge slice. (Amended in stop-pause doc §4.1 R6 +
docs/swarm-cross-doc-review.md §8.5.)

Retitle item: enabled in ALL session states (runs while paused — retitler Q6 signed off;
never touches the state group's disabled flags), disabled only while pending.

### 10.3 Icon spec — item → IconV2 name → fallback (verified)

Registry status, verified line-by-line against `packages/ui/src/v2/components/icon.tsx`:
`folder`, `globe`, `outline-copy`, `reset`/`outline-reset`, `xmark-small`, `edit`, `check`,
`close` all EXIST. **`stop`, `pause`, `play`, `sparkles`, `refresh` do NOT exist.**

**RULING: icon-free v1 (unchanged — pathfinder §3, resolved t4 v7).** Verified structural
reason: `MenuV2.Item` has NO first-class leading-icon slot — `ItemBody` is
content + `shortcut` + `badge` + `trailing` only (menu-v2.tsx:32-47; the `icon=` props seen
in app code belong to `IconButtonV2` triggers/buttons, not menu items). The table below is
the AGREED icon set for the future icon slice, which ships ONLY as a new `icon` prop on
`MenuV2.Item` (16px leading column) applied to ALL items — including the Close group — in
one change, never piecemeal.

| # | Menu item | IconV2 name | Registry status | Fallback / note |
|---|---|---|---|---|
| 1 | Stop session | `stop` (NEW — filled 16px square) | **ADD** | Required by the inline tab button + `data-session-state` regardless of menu icons (t4 §8 slice 3) — add to icon.tsx with the feature, not with the icon slice |
| 2 | Pause session | `pause` (NEW — two vertical bars, 16px) | **ADD** | Same — inline button + avatar-slot pause glyph (t4 §4.2) need it |
| 3 | Resume session | `play` (NEW — right-pointing triangle, 16px) | **ADD** | Same — inline button glyph |
| 4 | Regenerate session title | `outline-reset` (rotate-arrow) | **EXISTS** | `outline-reset`/`reset` share one body; `outline-reset` already in use (session-revert-dock, usage-gauge). `sparkles` considered but absent — no new artwork needed |
| 5 | Open project folder | `folder` | **EXISTS** | Plain open folder; NOT `folder-add-left` (that is the add-folder affordance) |
| 6 | Copy path | `outline-copy` | **EXISTS** | Already the copy affordance in message-timeline |
| 7 | Open repository | `globe` | **EXISTS** | Already the open-external affordance in session-header |
| — | Close group (5 items) | `xmark-small` | **EXISTS** | Matches the tab close button; only when the icon slice lands |

Notes:
- Items 1–3 are the ONLY additions, and they are required by the primary inline button and
  avatar glyphs anyway — the menu icon slice then has zero new glyph work.
- All proposed icons are stroke-based and non-directional → RTL-safe (no mirroring).
- v1 ships icon-free and uniform; partial iconography (icons on 3 of 7 items) is rejected.

### 10.4 Disabled / loading states

| Item | Disabled rule | Loading state |
|---|---|---|
| Stop | `!working` | none |
| Pause | `paused OR (idle AND no pending inputs)` (R6; interim fallback `!working` until the queued-badge slice lands) | none |
| Resume | `!paused` | none |
| Regenerate title | pending (per-session in-flight map) | Label-only swap to `command.session.regenerateTitle.pending` ("Generating title…"); **no spinner** (menu closes on select, so the pending label shows only on re-open — no mid-open width shift; disabled + label swap together form the double-fire guard) |
| Open project folder | gate fails: web / remote server / no `openPath` | none |
| Copy path | none — always enabled, even remote (copying a remote path is harmless) | none |
| Open repository | in-flight on the FIRST open per directory | Disabled only, **label unchanged** (sub-100ms window; a label change would shift menu width). After negative resolution → **HIDDEN** (pathfinder §2; negative cached ~30s) |
| Close group | existing index rules (unchanged) | none |

Reconciliation of the assignment's "disabled Open repository (no remote)" vs pathfinder's
HIDDEN: both hold, in different phases — **disabled while loading, hidden once proven
absent**. And "hidden project items on remote sessions": P1 (Open folder) stays DISABLED on
web/remote per pathfinder §2 (capability-gated action; disabled-not-hidden convention) —
NOT hidden. Only P3 (Open repository) is ever hidden (data-gated). Draft tabs: P1/P2/P3 all
absent (no session); Close group unchanged.

### 10.5 Keyboard ruling

**CONFIRMED: no app-level keybinds for any of the 7 items in v1** — consistent across all
four groups (stop-pause S8: no-default; retitler: none; pathfinder: none). The composer's
context-local Esc (blur / stop-when-stopping / menu dismiss) plus destructive-stop
ambiguity rule out bare global binds.

Keyboard access is fully covered by the existing Kobalte ContextMenu:
1. The tab link is focusable → Shift+F10 / ContextMenu key fires the native contextmenu
   event on the focused tab → menu opens.
2. Arrow keys navigate; disabled items are skipped automatically.
3. Enter / Space activates; Esc closes.

Future hook (slice-4, settings-suggested keybinds only): `MenuV2.Item` ALREADY accepts a
`shortcut` prop rendering `data-slot="menu-v2-item-shortcut"` (menu-v2.tsx:42) — the
KeybindV2 hint pattern (titlebar-tab-nav.tsx:44-63 precedent) applies with zero component
changes.

### 10.6 A11y notes

- Disabled items: Kobalte `aria-disabled` + existing menu-v2 disabled styling; skipped by
  arrow navigation; no custom focus management.
- All 7 labels use existing/planned i18n keys (t4 §4.4, retitler §4.5, §5 of this doc) —
  none hardcoded; parity test applies.
- Retitle pending: the label swap is the announcement — no aria-live, no spinner (matches
  t4 §4.5 "no aria-live on the tab").
- The inline tab-state button keeps its own aria-label (t4 §4.5); menu items announce their
  own labels.
- RTL: menu order and separators are flow-driven; all proposed icons non-directional
  (per .opencode/skills/rtl-aware-development/SKILL.md).
- Reduced motion: nothing animated in any state (no spinners) — no motion-reduce gating
  beyond the existing avatar-slot spinner (t4 §4.5).
- Touch: long-press opens via Kobalte; disabled states identical.

### 10.7 Visual-layer files this spec touches

- `packages/ui/src/v2/components/icon.tsx` — ADD `stop`, `pause`, `play` glyphs (needed by
  the inline tab button + avatar regardless of the menu icon slice).
- `packages/ui/src/v2/components/menu-v2.tsx` — (future icon slice) add `icon` prop to
  `ItemBody`.
- `packages/app/src/components/titlebar-tab-context-menu.tsx` — the combined menu: state
  group (fixed 3 slots) + retitle item + project group + close group; disabled matrix;
  P3 in-flight → hidden logic; new props per §4.
- No CSS changes: separators and disabled styling already exist (menu-v2.css); no new
  animations.
