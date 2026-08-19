# Shared-Browser / Session-Owned-Tabs Overhaul — Implementation-Ready Design

Status: READY FOR BUILD (design lead deliverable for `browser-overhaul` lane)
Owner: browser-designer · Consumes: browser-builder · Verifies: browser-verifier
Date: 2026-08-15
Companion refs: `deliverable/browser-phase0-protocol` (v4), `decisions/browser-premium-agent-ux`,
`decisions/browser-ownership-policy` + amendments (full tab-list visibility, user-initiated
assignment, close-range ops, claim ergonomics — 2026-08-15).

---

## 0. TL;DR

The Desktop browser becomes **ONE shared instance owned by the app window, never by a session**.
**Sessions (chat sessions, identified by their `sessionID`) own TABS inside it.** Routing is by
tab; isolation is enforced per-tab; the host registration is session-agnostic.

- `HostRegistration` drops `sessionId`/`workspaceId`/`directory`; broker registry is keyed by
  **window/hostId** (not session).
- Every tab carries an **owner**: exactly one of `{ kind: "user" }` or `{ kind: "agent", sessionId }`.
- **Agents can LIST the FULL browser tab list (read-only)** — `browser_status` returns ALL tabs with
  owner/url/title/active/tabId. **Read is broad; CONTROL stays ownership-scoped.**
- Broker dispatch **resolves the window, then the tab, then enforces ownership**, fills
  `windowId`+`tabId` on the forwarded envelope. Cross-session tab → `BrowserPermissionDenied`;
  no session tab → `BrowserTabNotFound` with prose `call browser_open to create a tab for this
  session`; no host → `BrowserHostUnavailable`.
- **Claiming is first-class**: `browser_claim { tabId }` claims a **user-owned** tab for the
  requesting session in ONE call (first-come-wins, visible to the user); `browser_open { url, tabId,
  claim: true }` claims-and-navigates in the same call. Never another agent's tab.
- **User authority**: the user can always delete any tab (incl. mid-operation — aborts the in-flight
  op), and can set a tab's owner to ANY value via the context menu — assign to a session,
  **reassign** from one session to another, or return to `user` (`assign(tabId, owner)` where
  `owner ∈ { user, agent(<sessionId>) }`, fully general). Close ranges (left/right/others/all) are
  also user-only.
- **Context menu** (user): Refresh · Duplicate · Mute/Unmute · Close · Close all to the left/right ·
  Close all but this · Assign to session… · Return to me. **Duplicate inherits the original tab's
  owner** (an agent's tab cloned → the copy is owned by that same session; a user tab → user-owned).
  Mute is a per-tab `webContents` audio toggle surfaced in tab state.
- Lifecycle: session-delete **orphans** its tabs (owner flips to `user`, content kept); explicit
  `browser_close` destroys; agent-side claiming is explicit-only, never implicit.
- Protocol version bump **1 → 2** so `BrowserProtocolMismatch` guards old hosts.
- `packages/protocol/src/groups/browser.ts` carries pre-existing feature work (the whole group is
  new vs `origin/dev`, committed locally) — **the builder merges additively on top of the current
  working-tree content, never regenerates from `origin/dev`** (where the file does not exist).

---

## 1. Settled Decisions (coordinator + product owner — binding, not relitigatable)

| # | Decision |
|---|---|
| D1 | ONE shared host per window; registration is **session-agnostic** (`register({hostId, windowId, capabilities})`), keyed by window/hostId, NOT sessionId. Hello drops the session key. |
| D2 | Sessions own **tabs** (`owner: { kind: "user" } \| { kind: "agent", sessionId }`). A tab has exactly one owner — never both, never two agents. |
| D3 | Broker dispatch order: (a) resolve host = the window whose tab the session targets (v1 = the single registered window); (b) resolve tab = explicit `tabId` VERIFIED to belong to `request.sessionId`, or the session's most-recently-active owned tab; (c) fail fast per error taxonomy below; forward with `windowId`+`tabId` filled. |
| D4 | Cross-session `tabId` → `BrowserPermissionDenied`; no session tab → `BrowserTabNotFound` (prose `call browser_open to create a tab for this session`); no host → `BrowserHostUnavailable`; agent targeting a **user** tab without explicit claim → `BrowserPermissionDenied` (agents never peek at user tabs implicitly). |
| D5 | **Full tab-list visibility**: `browser_status` returns ALL tabs — `tabId/url/title/active` + `owner` (`user` vs `agent(<sessionId>)`). Read is broad for every agent; CONTROL remains ownership-scoped (own tabs + explicit claim of user tabs). |
| D6 | **Claiming is a first-class one-call action**: dedicated `claim` op + `browser_claim { tabId }` tool flips a user-owned tab to the requesting session; `browser_open { url, tabId, claim: true }` claims-and-navigates in one call. Claim requires user-owned (never another agent's — `BrowserPermissionDenied`), first-come-wins, visible to the user. |
| D7 | **User-initiated assignment**: the tab context menu gets "Assign to session…" (lists open chat sessions) and "Return to me". Ownership is **fully fluid and never permanent**: the user may set a tab's owner to ANY value via `assign(tabId, owner)` — `owner ∈ { user, agent(<sessionId>) }` — i.e. assign to a session, REASSIGN from one session to another, or UNASSIGN back to `user`. Invoked from the UI/main — NOT from an agent tool. User authority bypasses the agent-must-explicitly-claim rule. Agents, by contrast, can only CLAIM user-owned tabs (agent→agent reassignment is user-only, preserving isolation). |
| D8 | **Tab context menu (UI)**: Refresh · Duplicate · Mute/Unmute · Close · Close all to the left · Close all to the right · Close all but this · Assign to session… · Return to me. Refresh/duplicate/mute are host-level webview ops; close-range is `closeRange(tabId, mode: left\|right\|others\|all)`; the user's delete-any-tab authority applies (closing an agent tab aborts its in-flight op). **Duplicate inherits the original tab's owner** (flag: PO chose inherit to keep session context intact; user-owned duplicates were considered and rejected). |
| D8a | **Refresh**: host-level reload of the tab's webview. **Verified: no host reload op exists today** — the current reload is a renderer-side DOM call (`webviewEl().reload()` in `HostedBrowserWebview.tsx`; `browserHostClient.reload` is a no-op stub). A real host op must be ADDED, and the existing renderer reload button should be rewired through it (or left as-is with the menu item using the new host path — builder's call, flagged). |
| D8b | **Mute**: per-tab `webContents` audio-mute toggle; `muted` state flows in tab state (`GuestTabState`/`SessionTabInfo`) so the UI and broker mirror reflect it. |
| D9 | USER AUTHORITY on delete: the user can always delete any tab (user-owned or any agent's), including mid-operation → in-flight op fails with `BrowserControlInterrupted`/`BrowserOperationFailed` (never hangs). The per-tab human-input arbiter stays and extends to close-driven preemption. |
| D10 | Lifecycle: session-delete ORPHANS its tabs (release ownership → `user`, keep content for the human); explicit `browser_close` destroys. Multi-tab default = most-recently-active owned tab. |
| D11 | Protocol `BROWSER_PROTOCOL_VERSION` 1 → 2 so `BrowserProtocolMismatch` guards old hosts. |
| D12 | Status: `StatusOutput` gains the FULL tab list (D5) — broker-enriched `tabs` field; a dedicated `tabs` op was considered and rejected for v1 (no extra round-trip; additive op can follow without a version bump). |
| D13 | Cross-cutting: protocol + core (broker) + desktop (host/ipc/preload) + app (renderer client + tab-strip context menu) + opencode (broker-client/shared/tools). |
| D14 | `packages/protocol/src/groups/browser.ts` has pre-existing uncommitted/feature work — builder **merges additively** (see §8.4). |

---

## 2. Current-State Shapes (verified against the working tree)

All verified today (2026-08-15) against the actual sources. Used as the `before` for every delta.

### 2.1 `packages/protocol/src/groups/browser.ts` (wire source of truth)

- `BROWSER_PROTOCOL_VERSION = 1`
- `HostRegistration = HostHello.fields + { sessionId: Session.ID, workspaceId?, directory?, callbackUrl, callbackToken }` — the stickiness context (session + workspace + window) rides INSIDE the registration.
- `HostRegistrationInfo` — same minus `callbackToken`, plus `status/registeredAt/lastSeenAt`.
- `GuestTabState = { tabId, url, title, readyState, controller, zoomFactor, attached }` — **no owner, no active**.
- `StatusOutput = { status: BrowserState }` — `BrowserState` has `connected/host/guest/appearance/recording`; **no tab list on the wire** (desktop sends a global `tabs` inside its internal status shape, but the protocol `BrowserState` has no `tabs` field, so it is stripped on decode).
- `OpenInput = { url, newTab?, activate?, appearance?, timeoutMs? }` — **no tabId, no claim**.
- `OpenOutput = { opened: { tabId, url, title, readyState, viewport } }` — **no owner**.
- `BrowserOperation` union: 21 ops (`status … react_inspect`); **no `claim`, no `set_tab_owner`**.
- `HostEvent` union: `guest.crashed`, `guest.stateChanged`, `host.stopping`, `request.aborted` — **no `tab.closed`**.
- Broker group endpoints: `browser.host.hello`, `browser.event`, `browser.hosts` — **no `browser.assign`**.
- `BrokerRequest` already carries `{ requestId, sessionId, windowId, workspaceId?, directory?, messageId, toolCallId?, tabId?, operation, timeoutMs }`.

### 2.2 `packages/core/src/browser/host-broker.ts` (structural mirror; must NOT import protocol)

- Registry keyed by **stickiness key** `${sessionID}@${workspaceID ?? sha1(directory)}#${windowID}` (`stickinessKey`, `bySession` map, last-hello-wins per key, heartbeat idempotent by `hostId+connectionId`).
- `resolveConnection(request)`: looks up `bySession[${sessionId}@${workspace}]`, prefers a live connection whose `guest.activeTabId === request.tabId`, else most recent.
- `dispatch`: resolves connection → fills `windowId` → forwards `BrokerRequest` to the host callback URL → races forward / abort-signal / supersede → returns typed `BrokerResponse`; `unavailable()` on no connection.
- `Interface`: `register`, `dispatch`, `abort`, `pushEvent`, `list`. **No `listTabs`, no `assign`, no `orphanSession`.**
- Typed error classes + `ErrorDefaults` prose (e.g. `BrowserTabNotFound: "The requested tab does not exist. Call browser_open first."`).

### 2.3 `packages/desktop/src/main/browser/*` (engine + host + IPC)

- `contracts.ts` (single desktop source of truth; `types.ts` mirrors it): local `HostRegistration` includes `sessionId/workspaceId/directory`; `WireGuestTabState` has **no owner**; `StatusOutput.status` includes a global `tabs: WireGuestTabState[]`; operation union has 21 ops; `BROWSER_PROTOCOL_VERSION = 1`.
- `host.ts` (`BrowserHost`): `registerHello()` builds `{ protocolVersion, hostId, hostEpoch, connectionId, windowId, capabilities, guest, ...this.options.getSessionContext(), callbackUrl, callbackToken }` — spreads the **session context into the registration**. `dispatch: (tabId, operation) => Promise` — **no sessionId passed to operations**.
- `index.ts` (`BrowserEngine`): holds `private sessionContext: SessionContext`, `setSessionContext` renderer API, `scheduleSessionContextRegister()` + `SESSION_CONTEXT_REGISTER_DEBOUNCE_MS` → calls `host.reRegister()` on active-session change; `BrowserHost` gets `getSessionContext: () => this.sessionContext`. `GuestRegistry` records are created with `sessionId: ""`. `api.closeTab` unregisters without preempting the arbiter.
- `operations.ts`: `dispatch(tabId, operation)`; `open()` creates a fresh tab via `onTabRequest` broadcast (owner-less); `close()` unregisters; `resolveTab(tabId?)` falls back to `list()[0]` (global first tab, session-agnostic); no claiming/assignment/close-range.
- `guest.ts` (`GuestRegistry`): `tabs: Map<runtimeTabId, GuestRecord>`; `activeTab` = first map value; `register()` initializes `sessionId: ""`.
- `ipc.ts`: `browser-set-session-context` handler calls `engine.api.setSessionContext(...)`.
- `preload/index.ts` + `preload/types.ts`: `BrowserAPI` exposes `setSessionContext`; no assign/close-range.
- App renderer: `packages/app/src/pages/session/v2/browser/browserHostClient.ts` exposes `setSessionContext` → `window.api.browser.setSessionContext`; `packages/app/src/pages/session.tsx` calls it in a `createEffect` on active-session change (the rebind-on-active-session flow). The tab strip is `BrowserTabPill` inside `packages/app/src/pages/session/v2/browser-panel-v2.tsx` (per-tab pill with activate/close buttons; **no context menu**).

### 2.4 `packages/opencode/src/browser/*` + `tool/browser/*`

- `broker-client.ts`: `RunInput { sessionID, messageID, toolCallID?, tabId?, operation, input, timeoutMs, abort }` → resolves session workspace/directory → `broker.dispatch({ sessionId, workspaceId?, directory?, messageId, toolCallId?, tabId?, operation, timeoutMs }, { signal })` → decodes `OperationOutput[name]` → typed error via `toBrowserError`.
- `shared.ts`: re-exports wire schemas; `OperationInput`/`OperationOutput` maps (21 ops); `DEFAULT_TIMEOUT_MS`; `FAMILY`; `ERROR_MESSAGE` prose; `permissionPattern`, `formatViewport`, `formatTarget`.
- `tool/browser/status.ts`: renders `result.status` (host/guest/appearance/recording); **no tab list** (wire strips it today).
- `tool/browser/open.ts`: passes `operation: "open"`; no ownership; description says "Open a URL in the visible Desktop browser guest for this session".
- `tool/browser/close.ts`: `tabId: params.tabId`; closes "the active tab"; session-agnostic.
- Other tools (`snapshot`, `navigate`, `click`, …): pass `tabId: params.tabId` through `broker.run`; defaulting today is host-side (`resolveTab` → first tab).

### 2.5 Server bridge

- `packages/server/src/handlers/browser.ts`: `browser.host.hello` → `broker.register(ctx.payload)`; `browser.event` → `broker.pushEvent`; `browser.hosts` → `broker.list()` re-encoded via `Schema.decodeUnknownSync(HostRegistrationInfo)`.

---

## 3. Shape Deltas (before → after), by file

### 3.1 `packages/protocol/src/groups/browser.ts`

```
BROWSER_PROTOCOL_VERSION: 1 → 2
```

**New: `HostOwner`** (a tab's owner — exactly one kind):
```ts
export const HostOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("agent"), sessionId: Session.ID }),
])
export type HostOwner = Schema.Schema.Type<typeof HostOwner>
```

**`HostRegistration`** — session-agnostic:
```ts
// before
export const HostRegistration = Schema.Struct({
  ...HostHello.fields,
  sessionId: Session.ID,                      // DROP
  workspaceId: Schema.optional(Workspace.ID), // DROP
  directory: Schema.optional(AbsolutePath),   // DROP
  callbackUrl: Schema.String,
  callbackToken: Schema.String,
})
// after
export const HostRegistration = Schema.Struct({
  ...HostHello.fields,                        // protocolVersion, hostId, hostEpoch,
                                              // connectionId, windowId, capabilities, guest
  callbackUrl: Schema.String,
  callbackToken: Schema.String,
})
```
> Note: `HostHello` itself never carried session (verified) — "hello drops session" is realized by
> removing it from `HostRegistration` (the hello payload). `HostGuestState` is unchanged
> (`attached/activeTabId/url`).

**`HostRegistrationInfo`** — mirror the drop (remove `sessionId/workspaceId/directory`).

**`GuestTabState`** — gains owner + active + muted:
```ts
export const GuestTabState = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  readyState: Schema.Literals(["Idle", "Loading", "Success", "LoadFailed"]),
  controller: Schema.Literals(["human", "agent", "none"]),
  zoomFactor: Schema.Number,
  attached: Schema.Boolean,
  owner: HostOwner,                           // NEW
  active: Schema.Boolean,                     // NEW — host-set; drives "most-recently-active"
  muted: Schema.Boolean,                      // NEW — per-tab audio mute (D8b)
})
```
(`HostEvent` `guest.stateChanged` already carries the full `GuestTabState` — it now carries owner+active+muted for free.)

**`StatusOutput`** — gains the FULL tab list (D5/D12):
```ts
export const SessionTabInfo = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  active: Schema.Boolean,
  owner: HostOwner,
  muted: Schema.Boolean,                      // NEW (D8b)
})
export type SessionTabInfo = Schema.Schema.Type<typeof SessionTabInfo>

// before: StatusOutput = { status: BrowserState }
// after:  tabs = ALL tabs on the shared host (read broad; ownership-scoped control unchanged)
export const StatusOutput = Schema.Struct({
  status: BrowserState,
  tabs: Schema.Array(SessionTabInfo),         // NEW — broker-enriched, full list
})
```

**`OpenInput`** — gains `tabId` + `claim` (claim-and-navigate, D6):
```ts
export const OpenInput = Schema.Struct({
  url: Schema.String,
  tabId: Schema.optional(Schema.String),      // NEW — target a specific tab (with claim, a user tab)
  claim: Schema.optional(Schema.Boolean),     // NEW — claim the named tab for this session, then navigate
  newTab: Schema.optional(Schema.Boolean),
  activate: Schema.optional(Schema.Boolean),
  appearance: Schema.optional(Schema.Literals(["system", "light", "dark"])),
  timeoutMs: Schema.optional(Schema.Number),
})
```

**`OpenOutput`** — result states ownership:
```ts
// before: opened: { tabId, url, title, readyState, viewport }
// after:
export const OpenOutput = Schema.Struct({
  opened: Schema.Struct({
    tabId: Schema.String,
    url: Schema.String,
    title: Schema.String,
    readyState: Schema.String,
    viewport: Viewport,
    owner: HostOwner,                        // NEW — agent(sessionId) for tool opens
  }),
})
```

**New `ClaimInput` / `ClaimOutput`** (first-class claiming, D6 — this replaces the earlier
"adopt" naming from the first ownership-policy amendment; claim is the settled name):
```ts
export const ClaimInput = Schema.Struct({
  tabId: Schema.String,                      // required — the user-owned tab to claim
  timeoutMs: Schema.optional(Schema.Number),
})
export const ClaimOutput = Schema.Struct({
  claimed: Schema.Struct({
    tabId: Schema.String,
    owner: HostOwner,                        // now { kind: "agent", sessionId }
  }),
})
```

**New `SetTabOwnerInput` / `SetTabOwnerOutput`** (broker-internal control op — user-initiated
assignment, D7; NEVER surfaced as an agent tool):
```ts
export const SetTabOwnerInput = Schema.Struct({
  tabId: Schema.String,
  owner: HostOwner,                          // the new owner (agent(sessionId) or user)
})
export const SetTabOwnerOutput = Schema.Struct({
  assigned: Schema.Struct({
    tabId: Schema.String,
    owner: HostOwner,
  }),
})
```

**`BrowserOperation`** union — add `claim` + `set_tab_owner`:
```ts
Schema.Struct({ name: Schema.Literal("claim"), input: ClaimInput }),
Schema.Struct({ name: Schema.Literal("set_tab_owner"), input: SetTabOwnerInput }),
```
> `set_tab_owner` is broker-minted (from `assign`), never mapped in the opencode `OperationInput`
> map — agents have no tool for it. The host handles it like any op.

**`HostEvent`** — add `tab.closed` (so the broker mirror stays in sync on ANY destroy path —
agent close, user UI close, close-range):
```ts
Schema.Struct({ type: Schema.Literal("tab.closed"), tabId: Schema.String, timestamp: Schema.String }),
```

**New broker-group endpoint** (user-initiated assignment, D7 — fully general owner):
```ts
// before (amendment draft): AssignRequest = { tabId, sessionId: Session.ID | null }
// after — the user may set ANY owner; "Return to me" = owner { kind: "user" }.
export const AssignRequest = Schema.Struct({
  tabId: Schema.String,
  owner: HostOwner,                          // user | agent(<sessionId>) — assign/reassign/unassign
})
export const AssignResponse = Schema.Struct({ data: Schema.Struct({ tabId: Schema.String, owner: HostOwner }) })

// in BrowserHostGroup:
HttpApiEndpoint.post("browser.assign", "/api/browser/assign", {
  payload: AssignRequest,
  success: AssignResponse,
  error: InvalidRequestError,
})
```

**Unchanged:** `BrokerRequest` (already has `sessionId` + `tabId`), all other operation
inputs/outputs, error taxonomy, paths.

> **Context-menu ops are host-internal, not agent ops (D8/D8a/D8b):** `refresh`, `duplicate`, and
> `set_muted` are host/webview operations invoked by the renderer context menu through main-process
> IPC — they are handled by `BrowserOperations.dispatch` but are **NOT** added to the agent-facing
> `BrowserOperation` union on the wire, and get no tool mapping in `packages/opencode`. They are
> documented with the desktop contracts (§3.3) and engine (§3.5-3.6) deltas only.

### 3.2 `packages/core/src/browser/host-broker.ts` (structural mirror — keep `no @opencode-ai/protocol` import)

Mirror every protocol change structurally:
- `BROWSER_PROTOCOL_VERSION = 2`.
- New `HostOwner` type + `SessionTabInfo` interface.
- `HostRegistration` interface: **drop `sessionId`/`workspaceId`/`directory`**.
- `HostRegistrationInfo`: drop those three.
- `GuestTabState` (event payload mirror) gains `owner: HostOwner`, `active: boolean`, `muted: boolean`.
- `OpenOutput` result shape gains `owner` (decode passthrough).
- New `ClaimInput`/`ClaimOutput`, `SetTabOwnerInput`/`SetTabOwnerOutput` mirrors.
- **Registry** (the core change):

```ts
// before
const connections = new Map<string, Connection>()          // keyed by stickiness key
const bySession = new Map<string, string[]>()              // session@workspace → stickiness keys
const stickinessKey = (i) => `${i.sessionId}@${workspace}#${i.windowId}`

// after — one host per window, plus a TAB registry mirroring host state
const connections = new Map<string, Connection>()          // keyed by windowId (D1)
interface TabRecord {
  readonly windowId: string
  readonly tabId: string
  readonly url: string
  readonly title: string
  readonly readyState: "Idle" | "Loading" | "Success" | "LoadFailed"
  readonly controller: "human" | "agent" | "none"
  readonly zoomFactor: number
  readonly attached: boolean
  readonly active: boolean
  readonly muted: boolean                                  // D8b
  readonly owner: HostOwner
  readonly lastActiveAt: number                             // updated when active:true is reported
}
const tabs = new Map<string, TabRecord>()                   // keyed by `${windowId}#${tabId}`
```

- **`register`**: version check (reject mismatch, return `accepted:false` + `brokerProtocolVersion:2`); key = `windowId`; same `hostId`+`connectionId` = heartbeat (idempotent, revives dead); new `connectionId`/host supersedes the old connection for that window (fail its in-flight requests with `BrowserControlInterrupted`, same as today).
- **`Interface`** gains:
  - `listTabs: () => Effect.Effect<ReadonlyArray<SessionTabInfo>>` — the FULL mirror list (D5; the server/tool surface reads it via status enrichment).
  - `assign: (tabId: string, owner: HostOwner) => Effect.Effect<AssignResult>` — user-initiated ownership change (D7, fully general): update the mirror, mint a `set_tab_owner` control op to the owning host (best-effort; host flips its record + emits `stateChanged` → mirror re-syncs idempotently). `owner { kind: "user" }` = "Return to me". Any value the user chooses is accepted — this is the user-authority channel (agent→agent reassignment happens HERE, not via `claim`).
  - `orphanSession: (sessionId: string) => Effect.Effect<void>` — flip every tab owned by `agent(sessionId)` to `{ kind: "user" }` (release ownership, keep content, D10) and best-effort mint `set_tab_owner` control ops per tab.
- **`pushEvent`**: handle `tab.closed` by removing the mirror row (also `guest.crashed` removes as today).
- **`dispatch`** — new resolution + enforcement (§4). Fills `windowId` AND `tabId` on the forwarded envelope; intercepts `open` reuse/claim and `status` enrichment.
- **Error prose** (`ErrorDefaults`):
  - `BrowserTabNotFound` → `"This session has no browser tab. Call browser_open to create a tab for this session."` (retryable: true)
  - `BrowserPermissionDenied` → `"This browser tab belongs to another session (or to the user). You may not control it. Claim a user tab with browser_claim, or open your own."` (retryable: false)
  - `BrowserHostUnavailable` → `"No live Desktop browser host is registered. Call browser_open to re-establish the browser."` (unchanged spirit; drop "for this session")

### 3.3 `packages/desktop/src/main/browser/contracts.ts` (+ `types.ts` mirror)

- `BROWSER_PROTOCOL_VERSION = 1 → 2`.
- `HostRegistration` interface: drop `sessionId`/`workspaceId`/`directory`.
- New `HostOwner = { kind: "user" } | { kind: "agent"; sessionId: string }`.
- `GuestTabState` (engine record) gains `owner: HostOwner`, `muted: boolean`; `WireGuestTabState` gains `owner` + `active` + `muted`.
- `StatusOutput` (desktop internal) keeps its global `tabs` (engine truth); the WIRE `StatusOutput` gains `tabs: SessionTabInfo[]` — the broker owns the full-list `tabs` field. Add `SessionTabInfo` to the wire-side section.
- New `ClaimInput`/`ClaimOutput`; `OpenInput` gains `tabId?`/`claim?`; `OpenOutput.opened` gains `owner`; `SetTabOwnerInput`/`SetTabOwnerOutput`; `BrowserOperation` union gains `claim` + `set_tab_owner`; `OPERATION_NAMES` guard array gains both; `HostEvent` gains `tab.closed`.
- **Host-internal context-menu ops (D8/D8a/D8b — engine dispatch only, NOT in the wire/agent union):** add `refresh` (`RefreshTabInput = { tabId }`), `duplicate` (`DuplicateTabInput = { tabId }`), `set_muted` (`SetMutedInput = { tabId, muted: boolean }`) to the desktop `BrowserOperation` union + `OPERATION_NAMES`; `GuestTabState`/`WireGuestTabState` gain `muted`; `isBrowserOperationName` picks them up. These are invoked by the renderer context menu via main IPC, never over the broker wire, and get no opencode tool mapping.
- `toWireGuestTabState` maps `owner` + `active` + `muted` from the record.

### 3.4 `packages/desktop/src/main/browser/host.ts`

- `BrowserHostOptions`: **delete `getSessionContext`**; change `dispatch` to pass session identity:
  ```ts
  // before
  getSessionContext: () => { sessionId: string; workspaceId?: string; directory?: string }
  dispatch: (tabId: string | undefined, operation: BrowserOperation) => Promise<Record<string, unknown>>
  // after
  dispatch: (tabId: string | undefined, operation: BrowserOperation, sessionId: string) => Promise<Record<string, unknown>>
  ```
- `registerHello()`: remove `...this.options.getSessionContext()` from the registration payload — hello becomes session-agnostic (D1). `reRegister()` stays (hello retry/heartbeat only; **no longer triggered by session switches**).
- `handleRequest`: call `this.options.dispatch(request.tabId, request.operation, request.sessionId)` so operations can attribute ownership from the envelope.

### 3.5 `packages/desktop/src/main/browser/index.ts` (`BrowserEngine`)

- **Delete** the whole session-context rebind flow: `sessionContext` field, `setSessionContext` in `BrowserRenderApi` + impl, `scheduleSessionContextRegister()`, `sameSessionContext()`, `SESSION_CONTEXT_REGISTER_DEBOUNCE_MS`, and the `getSessionContext: () => this.sessionContext` option passed to `BrowserHost`.
- `BrowserHost` construction: pass the new `dispatch(tabId, operation, sessionId)` that forwards `sessionId` into `this.operations.dispatch`.
- **Human-opened tabs = owner user** (D2/D6): `GuestRegistry.register()` initializes `owner: { kind: "user" }` by default (replacing `sessionId: ""`); the broker-`open` path overrides it to `agent(sessionId)` (see 3.6). `api.openTab` (renderer chrome) therefore produces user tabs automatically.
- **`BrowserRenderApi` gains**:
  - `assignTab: (tabId: string, owner: HostOwner) => Promise<{ tabId: string; owner: HostOwner }>` — user-initiated ownership change (D7, fully general): POST to the sidecar `POST {sidecar}/api/browser/assign` with Basic auth (mirroring the host's `postSidecar` pattern); `owner { kind: "user" }` = "Return to me". Any owner the user picks (assign/reassign/unassign) is accepted.
  - `closeRange: (tabId: string, mode: "left" | "right" | "others" | "all") => { closed: string[] }` — host-level tab management (D8): compute the target set from the registry order, then for each target run the user-authority close (preempt arbiter + detach control session + unregister + emit `tab.closed` + broadcast `browser-tab-close`).
  - `refreshTab: (tabId: string) => Promise<void>` — host-level webview reload (D8a, NEW — no such host op exists today; the current renderer reload is a DOM call).
  - `duplicateTab: (tabId: string) => Promise<{ tabId: string; url: string }>` — clone the tab with the same URL; **the duplicate INHERITS the original's owner** (agent's tab → the copy is owned by that same session; user tab → user-owned) (D8). Implemented via `BrowserOperations.duplicate` (see §3.6); the new tab is broadcast via `browser-tab-request` and registered like any open.
  - `setTabMuted: (tabId: string, muted: boolean) => Promise<void>` — per-tab `webContents.setAudioMuted` (D8b); the muted state flows through `stateChanged` → broker mirror → UI.
- **User authority close** (D9): `api.closeTab(tabId)` — before `registry.unregister`, **preempt the arbiter and detach the control session** so an in-flight agent op aborts:
  ```ts
  closeTab: (tabId) => {
    const tab = this.registry.get(tabId)
    if (!tab) return { closed: false }
    this.arbiter.preempt(tabId)                          // NEW — interrupt in-flight agent control
    this.sessions.detach(tab.webContentsId ?? -1).catch(() => undefined)  // kill the CDP session
    this.pendingActivation.delete(tabId)
    this.annotation.cancel(tabId)
    this.registry.unregister(tabId)
    this.host.emitHostEvent({ type: "tab.closed", tabId, timestamp: new Date().toISOString() })
    this.options.broadcast("browser-tab-close", { tabId })
    return { closed: true }
  }
  ```
  (`ControlArbiter.preempt` — new method wrapping the existing human-preemption path so the arbiter
  state resets and any waiting `withControl` permit fails with `BrowserControlInterrupted`.)
- `operations` wiring: `BrowserOperations.dispatch` signature becomes `dispatch(tabId, operation, sessionId)`; `BrowserHost` forwards it.

### 3.6 `packages/desktop/src/main/browser/operations.ts`

- `dispatch(tabId: string | undefined, operation: BrowserOperation, sessionId: string)` — thread `sessionId` through `open`/`claim`/`set_tab_owner`/`close`.
- `open(input, sessionId)`:
  - `input.tabId` present → target that tab: if `input.claim` → flip `record.owner` to `agent(sessionId)` (enforce: user-owned or own; another agent's → `BrowserPermissionDenied`) then navigate; else the tab must already be `agent(sessionId)` (broker enforces; host double-checks) → navigate.
  - no `tabId` → fresh tab via `onTabRequest` broadcast; on `resolveOpen`, set `record.owner = { kind: "agent", sessionId }`, `record.active = true`.
  - Return `opened` including `owner` (OpenOutput delta). Store pending `sessionId` on the pendingOpen entry at `open()` time.
- **New `claim(input, sessionId)`**: resolve tab by `input.tabId`; enforce:
  - tab missing → `BrowserTabNotFound` (new prose);
  - `owner.kind === "agent"` and `owner.sessionId !== sessionId` → `BrowserPermissionDenied` (never steals, D6);
  - `owner.kind === "agent"` and `owner.sessionId === sessionId` → idempotent success;
  - else (user/unowned) → **first-come-wins**: `record.owner = { kind: "agent", sessionId }`, `registry.sync(tabId)` (host emits `stateChanged` → broker mirror updates), return `ClaimOutput`.
- **New `setTabOwner(input, sessionId)`**: broker-minted control op (D7) — set `record.owner = input.owner` (validation: only the broker may mint this; an agent tool can never invoke it), `registry.sync(tabId)`, return `SetTabOwnerOutput`.
- `close(tabId, input, sessionId)`: target = `input.tabId ?? tabId`; verify ownership (broker is authoritative; host double-checks: `agent(other)` → `BrowserPermissionDenied`); default = session's owned tab (broker fills `tabId`). Destroy via unregister + `onTabClose` + emit `tab.closed` (explicit-destroy path, D10).
- **New `refresh(tabId)`** (D8a): resolve tab, `tab.webContents.reload()` — a real host-side reload op (new; today the renderer reloads the DOM directly). Also rewire the existing renderer reload button to this path where cheap.
- **New `duplicate(tabId)`** (D8): resolve the source tab, mint a fresh `runtimeTabId`, broadcast `onTabRequest({ tabId, url: source.url, activate: true })`; on registration, **copy `source.owner`** onto the new record (owner-inherit, D8) and mark it active. Returns `{ tabId, url }`.
- **New `setMuted(tabId, muted)`** (D8b): resolve tab, `tab.webContents.setAudioMuted(muted)`, set `record.muted`, `registry.sync(tabId)` (→ `stateChanged` → broker mirror + UI).
- `status(tabId, sessionId)`: unchanged global state (broker enriches the wire `tabs` from its mirror — host does not need session filtering).
- `resolveTab`: keep the fallback; the broker now resolves+defaults per session before forwarding.

### 3.7 `packages/desktop/src/main/ipc.ts`

- **Delete** the `browser-set-session-context` handler (the renderer rebind flow, D1).
- **Add**:
  - `browser-assign-tab` `(tabId, owner: HostOwner)` → `engine.api.assignTab(tabId, owner)` (trusted-webContents guarded like the rest).
  - `browser-close-range` `(tabId, mode)` → `engine.api.closeRange(tabId, mode)`.
  - `browser-refresh-tab` `(tabId)` → `engine.api.refreshTab(tabId)`.
  - `browser-duplicate-tab` `(tabId)` → `engine.api.duplicateTab(tabId)`.
  - `browser-set-tab-muted` `(tabId, muted)` → `engine.api.setTabMuted(tabId, muted)`.

### 3.8 `packages/desktop/src/preload`

- `index.ts` + `types.ts` `BrowserAPI`: remove `setSessionContext`; add `assignTab` (`ipcRenderer.invoke("browser-assign-tab", tabId, owner)`), `closeRange` (`ipcRenderer.invoke("browser-close-range", tabId, mode)`), `refreshTab`, `duplicateTab`, `setTabMuted` (matching the handlers above).

### 3.9 App renderer (`packages/app`)

- `packages/app/src/pages/session/v2/browser/browserHostClient.ts`: remove `setSessionContext` from `BrowserAPI` + the wrapper + the test stub (`browserHostClient.test.ts`); add `assignTab(tabId, owner)`, `closeRange(tabId, mode)`, `refreshTab(tabId)`, `duplicateTab(tabId)`, `setTabMuted(tabId, muted)` wrappers (replacing the existing no-op `reload` stub).
- `packages/app/src/pages/session.tsx`: remove the `createEffect(() => { void browserHostClient.setSessionContext(sessionId) })` block (~lines 1379-1385) and its comment.
- **Tab context menu** (D8) — `BrowserTabPill` in `packages/app/src/pages/session/v2/browser/browser-panel-v2.tsx`: add a right-click context menu (new component, e.g. `BrowserTabContextMenu`) with:
  - **Refresh** → `browserHostClient.refreshTab(tabId)` (D8a)
  - **Duplicate** → `browserHostClient.duplicateTab(tabId)` (owner inherited, D8)
  - **Mute / Unmute** → `browserHostClient.setTabMuted(tabId, !muted)` — label reflects the tab's `muted` state (D8b)
  - Close tab → `browserHostClient.close(tabId)`
  - Close all to the left / right → `browserHostClient.closeRange(tabId, "left" | "right")`
  - Close all but this → `closeRange(tabId, "others")`
  - Assign to session… → submenu listing the open chat sessions (populate from the existing session list store/query used by the app — exact hook is implementation detail, flagged) → `browserHostClient.assignTab(tabId, { kind: "agent", sessionId })`
  - **Return to me** → `browserHostClient.assignTab(tabId, { kind: "user" })` (shown when the tab is agent-owned; first-class item, D7)
  - The pill should also surface the owner + mute affordances (e.g. a small `user`/`agent` glyph or tooltip from the guest state, and a mute icon) so assignment/claim/mute changes are visible to the user (D6/D7/D8b).

> The IPC handlers are gone/added in the same release; stale renderers calling
> `browser-set-session-context` simply reject harmlessly.

### 3.10 `packages/opencode/src/browser/shared.ts`

- Re-export new wire schemas: `HostOwner`, `SessionTabInfo`, `ClaimInput`, `ClaimOutput`.
  (`SetTabOwnerInput/Output` deliberately NOT re-exported — agents have no such tool.)
- `OperationInput`/`OperationOutput` gain `claim: ClaimInput` / `claim: ClaimOutput`. `OpenInput`
  already picks up `tabId`/`claim` from the schema re-export.
- `DEFAULT_TIMEOUT_MS.claim = 10_000`.
- `FAMILY.claim = "browser.navigate"` (tab-lifecycle action; flag: could be `browser.interact` — pick one, document in the tool description).
- `ERROR_MESSAGE` prose updates:
  - `BrowserTabNotFound` → `"This session has no browser tab. Call browser_open to create a tab for this session."`
  - `BrowserPermissionDenied` → `"This tab belongs to another session or to the user; you may not control it. Claim a user tab with browser_claim, or open your own tab."`
  - `BrowserHostUnavailable` → drop "for this session".

### 3.11 `packages/opencode/src/browser/broker-client.ts`

- No structural change required: `RunInput.tabId` is already optional and forwarded; the broker fills the resolved/defaulted `tabId` on the envelope. `sessionID` already flows (used for ownership resolution + status enrichment). Optional: add a comment noting the broker is authoritative for tab defaulting.

### 3.12 `packages/opencode/src/tool/browser/*.ts`

- **`status.ts`** — report the FULL tab list (D5):
  - Render: after the existing host/guest/recording line, append the tabs block:
    `tabs (N total):` then per tab `tabId url "title" [active?] [muted?] owner=<user|agent(sessionId)>`, highlighting the session's own tabs (e.g. `(mine)` suffix).
  - Metadata gains `tabCount: tabs.length`.
- **`open.ts`**:
  - Description: "Open a URL in a browser tab **owned by this session**. With `tabId` + `claim: true`, claims a **user-owned** tab for this session and navigates it in one call. With no `tabId` and `newTab` unset, reuses the session's most-recently-active owned tab (navigates it); otherwise creates a new owned tab. The result reports the tab's owner. Use this after BrowserTabNotFound / BrowserGuestCrashed / BrowserHostUnavailable, or to claim a user tab."
  - Output line states ownership: `opened tab <tabId> (owner agent(<sessionID>)) -> <url> ...`.
- **New `claim.ts` (`browser_claim`)**: parameters `ClaimInput`; description — "Claim a **user-owned** browser tab (`tabId`) for this session — ownership flips to this session and the change is visible to the user. First-come-wins: if another agent already owns the tab (or claims it first), this fails with BrowserPermissionDenied. Read browser_status to see each tab's owner before claiming."
- **`close.ts`**: description — "Close a browser tab **owned by this session** (default the session's active owned tab; explicit `tabId` must be this session's own tab). The user can always close any tab from the UI. Re-open with browser_open when needed."
- **All other tools** (snapshot/navigate/click/type/press/scroll/evaluate/wait_for/screenshot/query/highlight/annotate/resize/recording_*/profiler_*/react_inspect): no code change to the dispatch path — `tabId: params.tabId` already forwards and the broker defaults it per-session. **Prose sweep only**: replace session-agnostic "the active tab" phrasing with "this session's active owned tab" in `description` strings.

### 3.13 `packages/server/src/handlers/browser.ts`

- `decodeHostInfo = Schema.decodeUnknownSync(HostRegistrationInfo)` — re-encode still typechecks after the registration drops the session fields; the hello handler forwards the (now session-agnostic) payload to `broker.register` unchanged.
- **Add** `browser.assign` handler → `broker.assign(payload.tabId, payload.owner)` mapped to `AssignResponse` (with `InvalidRequestError` on failure).

---

## 4. Dispatch Resolution (broker) — pseudocode

The broker's `dispatch` is the single enforcement point for AGENT control (D3/D4/D6). `assign` is a
separate user-initiated path (D7). Order matters: window first, then tab, then ownership.

```ts
dispatch(request: BrokerRequestInput, opts): BrokerResponse {
  // (0) Host resolution — session-agnostic, window-scoped (D1). v1: the single live window;
  //     future: the window whose tab this session's most-recently-active owned tab lives in.
  const window = resolveWindow(request)           // live connections; prefer window of session's
                                                  //   active owned tab, else sole live
  if (!window) return error(request, "BrowserHostUnavailable",
    "No live Desktop browser host is registered. Call browser_open to re-establish the browser.")

  // (1) open: claim-and-navigate, or reuse-or-create (D5/D6)
  if (request.operation.name === "open") {
    const input = request.operation.input
    if (input.tabId !== undefined) {
      const tab = tabs.get(`${window.windowId}#${input.tabId}`)
      if (!tab) return error(request, "BrowserTabNotFound",
        "This session has no browser tab. Call browser_open to create a tab for this session.")
      if (tab.owner.kind === "agent" && tab.owner.sessionId !== request.sessionId)
        return error(request, "BrowserPermissionDenied", "This tab belongs to another session.")
      if (tab.owner.kind === "user" && input.claim !== true)
        return error(request, "BrowserPermissionDenied",
          "This tab belongs to the user. Claim it with browser_open { tabId, claim: true } or browser_claim.")
      // claim=true on user tab → forward open-with-claim; host flips owner then navigates.
      return await forward(window, request)       // host sets owner=agent(sessionId), navigates, returns owner
    }
    if (!input.newTab) {
      const owned = sessionTabs(request.sessionId, window.windowId)
      if (owned.length > 0) {
        const target = owned[0]                   // most-recently-active owned tab
        const nav = await forward(window, {
          ...request,
          tabId: target.tabId,
          operation: { name: "navigate",
                       input: { url: input.url, waitUntil: input.waitUntil } },
        })
        if (!nav.ok) return nav
        return ok(request, normalizeOpenFromNavigate(nav, target, request.sessionId))  // OpenOutput shape + owner
      }
    }
    // open with newTab=true (or no owned tab) → create: forward as-is; host sets owner=agent(sessionId)
    const response = await forward(window, request)
    if (response.ok) mirrorOpenTab(response.result.opened, request.sessionId, window.windowId)  // registry sync
    return response
  }

  // (2) claim: explicit, first-come-wins (D6)
  if (request.operation.name === "claim") {
    const tab = tabs.get(`${window.windowId}#${request.operation.input.tabId}`)
    if (!tab) return error(request, "BrowserTabNotFound",
      "This session has no browser tab. Call browser_open to create a tab for this session.")
    if (tab.owner.kind === "agent" && tab.owner.sessionId !== request.sessionId)
      return error(request, "BrowserPermissionDenied", "…owned by another session…")
    // own-agent tab → idempotent; user/unowned → host flips (first-come-wins) → stateChanged → mirror sync
    return await forward(window, request)
  }

  // (3) status: host-level forward + FULL tab-list enrichment (D5/D12)
  if (request.operation.name === "status") {
    const response = await forward(window, request)        // no tabId — host global state
    if (response.ok) response.result.tabs = listTabs(window.windowId)   // ALL tabs, each with owner
    return response
  }

  // (4) tab-resolving ops (everything else): resolve + verify ownership (D3/D4)
  const tabId = resolveOwnedTab(request, window.windowId)
  if (tabId instanceof ErrorResponse) return tabId         // BrowserTabNotFound / BrowserPermissionDenied
  return await forward(window, { ...request, tabId })      // fill tabId; windowId already filled
}

resolveOwnedTab(request, windowId): string | ErrorResponse {
  if (request.tabId !== undefined) {
    const tab = tabs.get(`${windowId}#${request.tabId}`)
    if (!tab) return error("BrowserTabNotFound",
      "This session has no browser tab. Call browser_open to create a tab for this session.")
    if (tab.owner.kind === "agent" && tab.owner.sessionId !== request.sessionId)
      return error("BrowserPermissionDenied", "This tab belongs to another session.")
    if (tab.owner.kind === "user")
      return error("BrowserPermissionDenied", "This tab belongs to the user. Claim it with browser_claim first.")
    return tab.tabId
  }
  const owned = sessionTabs(request.sessionId, windowId)   // agent-owned, most-recently-active first
  if (owned.length === 0) return error("BrowserTabNotFound",
    "This session has no browser tab. Call browser_open to create a tab for this session.")
  return owned[0].tabId                                     // multi-tab default (D10)
}

sessionTabs(sessionId, windowId): TabRecord[] {
  return [...tabs.values()]
    .filter(t => t.windowId === windowId && t.owner.kind === "agent" && t.owner.sessionId === sessionId)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}
```

**User-initiated `assign` (D7) — separate from agent dispatch, fully general:**
```ts
assign(tabId: string, owner: HostOwner): AssignResult {
  const tab = tabs.get(`${resolveWindowIdForTab(tabId)}#${tabId}`)   // locate by tabId across windows
  if (!tab) throw BrowserTabNotFound("This tab does not exist.")
  // owner is whatever the USER chose: user | agent(<sessionId>) — assign/reassign/unassign.
  // mint the control op to the owning host (best-effort; host flips + emits stateChanged)
  forwardControl(windowOf(tab), { name: "set_tab_owner", input: { tabId, owner } })
  tabs.set(`${tab.windowId}#${tabId}`, { ...tab, owner, lastActiveAt: Date.now() })  // mirror sync
  return { tabId, owner }
}
```

**Mirror sync** (host → broker tab registry): `pushEvent("guest.stateChanged")` upserts the
`TabRecord` (`lastActiveAt = now` when `active`); `guest.crashed` / **`tab.closed`** → remove.
`register()`'s `guest.activeTabId` marks the active tab. The host is the source of truth for tab
existence + owner; the broker mirror is the routing/enforcement cache.

---

## 5. Ownership Enforcement Rules

| # | Situation | Result |
|---|---|---|
| O1 | Agent dispatches to a tab owned by `agent(otherSession)` (explicit tabId or claimed) | `BrowserPermissionDenied` — absolute single-agent exclusivity, no exceptions |
| O2 | Agent dispatches to a tab owned by `agent(itself)` | Allowed |
| O3 | Agent dispatches to a **user** tab (no claim) | `BrowserPermissionDenied` — agents never peek at user tabs implicitly (D4) |
| O4 | Agent calls `browser_claim { tabId }` on a user/unowned tab | Claims: owner flips to `agent(sessionId)` — first-come-wins, visible to the user (D6) |
| O5 | Agent calls `browser_claim` on `agent(otherSession)` tab | `BrowserPermissionDenied` — never steals |
| O6 | Agent calls `browser_claim` on its own tab | Idempotent success (no-op) |
| O7 | Agent with no owned tab dispatches without tabId | `BrowserTabNotFound` — `call browser_open to create a tab for this session` |
| O8 | No live host | `BrowserHostUnavailable` |
| O9 | User closes any tab (user-owned OR any agent's), mid-operation, incl. via close-range | Allowed — arbiter preempt + control-session detach; in-flight op → `BrowserControlInterrupted`/`BrowserOperationFailed`, never a hang (D8/D9) |
| O10 | Session deleted | Its agent-owned tabs ORPHAN → owner flips to `user`, content kept (D10) |
| O11 | Tab closed explicitly via `browser_close` | Destroyed (registry + webview removed) (D10) |
| O12 | Host hello version ≠ broker version | `BrowserProtocolMismatch` — hello rejected, host retries (D11) |
| O13 | Agent lists tabs (`browser_status`) | Full list with owner/url/title/active/muted — read is broad for every agent (D5) |
| O14 | User assigns/reassigns a tab via context menu (`assign(tabId, owner)`, owner = any value) | Ownership set to exactly that owner — user authority, bypasses O3/O4/O5; agent→agent reassignment is USER-ONLY (D7) |
| O15 | User returns a tab to themselves (`assign(tabId, { kind: "user" })` — "Return to me") | Ownership flips to `user` (D7) |
| O16 | Agent `open { tabId, claim: true }` on a user tab | Claims AND navigates in one call (D6); same first-come-wins + never-steal checks |
| O17 | User duplicates a tab (context menu) | New tab with same URL; **owner INHERITED** from the original (agent's tab → same session; user tab → user) (D8) |
| O18 | User refreshes or mutes a tab (context menu) | Host-level webview op; `muted` reflected in tab state (D8a/D8b); no ownership change |

---

## 6. Lifecycle & State Flow

- **Creation**: renderer chrome `openTab` → owner `user`. Tool `browser_open` (no tabId, new tab)
  → owner `agent(sessionId)` (set host-side on webview registration; reported in
  `OpenOutput.opened.owner`).
- **State**: every tab-state change → `guest.stateChanged` (with `owner` + `active`) → broker mirror
  upsert. Activation → `lastActiveAt` bump → multi-tab default picks the most-recently-active owned tab.
- **Claim**: `browser_claim { tabId }` or `open { tabId, claim: true }` on a user tab → host flips
  owner to `agent(sessionId)` → `stateChanged` → mirror sync → UI shows the new owner (O4/O16).
- **Assign (user)**: context menu "Assign to session…" / "Return to me" → `browser-assign-tab` IPC →
  main POSTs `{sidecar}/api/browser/assign` → broker `assign` → mirror + `set_tab_owner` control op →
  host flips + `stateChanged` → UI shows new owner. Fully general: assign/reassign/unassign (O14/O15).
- **Duplicate (user)**: context menu → `browser-duplicate-tab` IPC → host `duplicate` → new tab
  registered with the ORIGINAL's owner copied → `stateChanged` → mirror sync (O17).
- **Refresh / Mute (user)**: context menu → `browser-refresh-tab` / `browser-set-tab-muted` IPC →
  host `refresh`/`setMuted`; mute flows through `stateChanged` (owner unchanged) (O18).
- **Close**: broker `close` op (session's own tab, O11) or user UI close/close-range (any tab, O9).
  Both destroy; any destroy path emits `tab.closed` so the mirror drops the row.
- **Orphan (session-delete)**: the session-delete path calls `broker.orphanSession(sessionId)`:
  broker flips mirror owners to `user` and best-effort mints `set_tab_owner` control ops to the
  owning hosts (host flips records, emits `stateChanged`; UI shows the tab as user-owned).
  Content is preserved for the human; the tab is now claimable (O4).
- **Human-input arbiter**: unchanged per-tab preemption (`BrowserControlInterrupted` when the user
  takes over mid-op); extended by close-driven preemption (O9) — closing a tab preempts the arbiter
  and detaches the CDP session before unregistering.

---

## 7. Migration / Back-Compat Note

- **Version gate**: `BROWSER_PROTOCOL_VERSION` 1 → 2. The broker rejects any hello whose
  `protocolVersion !== 2` with `accepted:false` + `brokerProtocolVersion:2`; the host treats a
  rejected hello as `BrowserProtocolMismatch` and retries (existing behavior).
- **Old host (v1) → new broker (v2)**: hello carries extra `sessionId/workspaceId/directory` fields
  but version 1 → rejected at the version gate. No silent misrouting is possible: an old host simply
  never registers. Tabs never appear; tools report host-unavailable/restart-the-panel prose.
- **New host (v2) → old broker (v1)**: the old broker's version check (`!== 1`) rejects the v2 hello
  the same way. Symmetric and safe.
- **Deploy order**: ship protocol + core broker + desktop host/ipc/preload + app renderer + opencode
  tools + server handler as one release; the version gate makes mixed old/new binaries safe
  (degraded to "no browser" rather than wrong routing).
- **In-flight during upgrade**: a re-registering v2 host supersedes the old connection per window;
  in-flight requests fail with `BrowserControlInterrupted` (existing behavior, unchanged).
- **Renderer rebind flow**: deleted in the same release as the IPC handler removal; any stale renderer
  call to `browser-set-session-context` rejects (harmless — no handler). App call sites removed (§3.9).
- **New endpoints/ops**: `browser.assign` endpoint, `claim`/`set_tab_owner` ops, and `tab.closed`
  event are additive within v2 (old-v2-era hosts ignore unknown ops only if they run a v2 build —
  since v2 ships atomically, treat them as always-present).
- **Data compatibility**: no persisted state changes; the broker registry and host records are
  in-memory. Existing `HostRegistrationInfo` consumers (debug endpoint) only lose the session fields.

---

## 8. Implementation Checklist (ordered)

> Pre-requisite note: `packages/protocol/src/groups/browser.ts` carries pre-existing feature work
> (the whole group is new vs `origin/dev` — committed locally on `openfork`, clean working tree).
> **The builder must merge additively on top of the current file content; do NOT regenerate from
> `origin/dev` (the file does not exist there) and do NOT rebase it away.**

1. **Protocol** (`packages/protocol/src/groups/browser.ts`) — additive edits:
   - `BROWSER_PROTOCOL_VERSION = 2`.
   - Add `HostOwner`; `GuestTabState` +`owner`/`active`/`muted`; `SessionTabInfo`; `StatusOutput` +`tabs`;
     `OpenInput` +`tabId`/`claim`; `OpenOutput.opened` +`owner`; `ClaimInput`/`ClaimOutput`;
     `SetTabOwnerInput`/`SetTabOwnerOutput`; `BrowserOperation` +`claim`+`set_tab_owner`;
     `HostEvent` +`tab.closed`; `AssignRequest`/`AssignResponse` (owner-based) + `browser.assign` endpoint;
     `HostRegistration`/`HostRegistrationInfo` −session fields.
   - Context-menu ops (`refresh`/`duplicate`/`set_muted`) stay OUT of the protocol group (host-internal).
2. **Core broker** (`packages/core/src/browser/host-broker.ts`):
   - Mirror shapes (version 2, `HostOwner`, `SessionTabInfo`, registration drops).
   - Registry: `connections` keyed by `windowId` (remove `bySession`/`stickinessKey` session parts);
     add `tabs` mirror + `TabRecord` (incl. `muted`).
   - `register` window-keyed last-hello-wins; supersede per window.
   - `dispatch` per §4 (window → tab → ownership; open claim/reuse; status enrichment; claim pass-through).
   - `listTabs`/`assign(tabId, owner)`/`orphanSession` on the `Interface`; `set_tab_owner` control-op minting.
   - `pushEvent` handles `tab.closed` (remove mirror row).
   - Error prose updates (§3.2).
3. **Desktop host/ipc**:
   - `contracts.ts` (+ `types.ts` mirror): version 2, `HostOwner`, `GuestTabState`/`WireGuestTabState`
     +owner/+active/+muted, `SessionTabInfo`, `OpenInput` +tabId/claim, `OpenOutput` +owner,
     `ClaimInput`/`ClaimOutput`, `SetTabOwnerInput`/`SetTabOwnerOutput`, `BrowserOperation`
     +claim+set_tab_owner+**refresh+duplicate+set_muted**, `OPERATION_NAMES` additions,
     `HostEvent` +tab.closed, `toWireGuestTabState` update.
   - `host.ts`: drop `getSessionContext`; `dispatch(tabId, operation, sessionId)`; hello payload
     without session context.
   - `operations.ts`: `dispatch(..., sessionId)`; `open` (claim/reuse/create + owner attribution);
     `claim` enforcement; `setTabOwner` control op; `refresh`/`duplicate` (owner-inherit)/`setMuted`;
     `close` ownership check + destroy + `tab.closed`.
   - `index.ts`: delete session-context flow; `openTab` → user owner (registry default); `closeTab`
     preempts arbiter + detaches control session + emits `tab.closed`; add `assignTab` (sidecar POST,
     general owner), `closeRange`, `refreshTab`, `duplicateTab`, `setTabMuted`; host options update.
   - `ipc.ts`: delete `browser-set-session-context`; add `browser-assign-tab`, `browser-close-range`,
     `browser-refresh-tab`, `browser-duplicate-tab`, `browser-set-tab-muted`.
   - `preload/index.ts` + `types.ts`: remove `setSessionContext`; add the five new invokes.
4. **App renderer**: `browserHostClient.ts` (remove setSessionContext, add assignTab/closeRange/
   refreshTab/duplicateTab/setTabMuted, update test stub); `session.tsx` (remove the rebind
   `createEffect`); `browser-panel-v2.tsx` `BrowserTabPill` → add owner + mute affordances and a
   `BrowserTabContextMenu` (Refresh · Duplicate · Mute/Unmute · Close · close-ranges · Assign to
   session… submenu · Return to me); rewire the existing renderer reload button to `refreshTab`
   where cheap (D8a).
5. **opencode tools**:
   - `shared.ts`: re-exports (`HostOwner`, `SessionTabInfo`, `ClaimInput`, `ClaimOutput`),
     `OperationInput/Output` +`claim`, `DEFAULT_TIMEOUT_MS.claim`, `FAMILY.claim`,
     `ERROR_MESSAGE` prose.
   - `tool/browser/status.ts` (full tab list render), `open.ts` (claim/reuse description + owner in
     result), new `claim.ts`, `close.ts` (session-own prose); prose sweep across the rest.
   - `broker-client.ts`: no change (comment optional).
6. **Server bridge**: `packages/server/src/handlers/browser.ts` — recompile against new schemas;
   add `browser.assign` handler → `broker.assign`.
7. **Session-delete wiring**: call `broker.orphanSession(sessionID)` from the session-delete paths
   (`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` delete handler +
   `packages/opencode/src/cli/cmd/session.ts`), best-effort/fire-and-forget after the row is gone.
8. **Tests** (§9) + `bun typecheck` per package (`packages/protocol`, `packages/core`,
   `packages/desktop`, `packages/opencode`, `packages/app`).

---

## 9. Test Plan (pure tests — no live browser, no network)

### 9.1 Core broker — pure resolution/enforcement (primary)

Extract the dispatch-resolution logic (§4) into pure, exported helpers on the broker module so they
are unit-testable WITHOUT any HTTP/host:

```ts
export const resolveDispatch = (input: {
  request: BrokerRequestInput
  windowId: string | undefined
  tabs: readonly TabRecord[]                 // mirror snapshot
}): { kind: "forward"; windowId: string; tabId?: string; rewrite?: {...} }
 | { kind: "error"; tag: BrowserErrorTag; message: string }
```

Tests (in `packages/core/test/browser/host-broker.test.ts`, plain `describe`/`it` — **no** fake
host server needed for these):

| Case | Expect |
|---|---|
| no window | `BrowserHostUnavailable` |
| no tabId, session has no owned tab | `BrowserTabNotFound` with `call browser_open` prose |
| no tabId, session owns 2 tabs | forwards to most-recently-active owned tab (`lastActiveAt` ordering) |
| explicit tabId of own agent tab | forwards with that tabId |
| explicit tabId of `agent(other)` tab | `BrowserPermissionDenied` |
| explicit tabId of **user** tab (no claim) | `BrowserPermissionDenied` (no implicit peek) |
| `open { url, tabId, claim: true }` on user tab | forwards open-with-claim; result owner = `agent(sessionId)` |
| `open` + no tabId + `newTab:false` + session owns a tab | rewrite to `navigate` on the owned tab; result normalized to OpenOutput shape with `owner` |
| `open` + no owned tab | forward create; `OpenOutput.opened.owner === agent(sessionId)` |
| `claim` on user tab | allowed (host flips; mirror sync) |
| `claim` on `agent(other)` tab | `BrowserPermissionDenied` |
| `claim` on own tab | idempotent success |
| `status` | result gains `tabs` = FULL list with owner/url/title/active/muted for every tab (incl. user + other-agent tabs) |
| `assign(tabId, { kind: "agent", sessionId })` | mirror owner flips to `agent(sessionId)`; `set_tab_owner` control op minted |
| `assign` — REASSIGN sessionA→sessionB | owner flips to `agent(sessionB)` (user authority; agent-claim never does this) |
| `assign(tabId, { kind: "user" })` ("Return to me") | owner flips to `user` |
| `orphanSession` | all `agent(sessionId)` tabs flip to `user`; other agents' tabs untouched |
| `sessionTabs` ordering | most-recently-active first |
| `tab.closed` event | mirror row removed |
| `duplicate` owner-inherit (broker-visible) | mirrored owner of the new tabId equals the source tab's owner (agent session or user) |

Keep the existing fake-host tests (loopback-only, already present) for **forwarding** behavior
(envelope gets `windowId`+`tabId` filled; supersede; abort; transport) — these use the current
`startHost` local-loopback pattern, which is not a browser and needs no external network.

### 9.2 Ownership helper unit tests (shared logic)

Extract pure helpers (e.g. `ownership.ts` in core or desktop `contracts.ts`):
`canDispatch(owner, sessionId)`, `canClaim(owner, sessionId)`, `orphanOwnedTabs(tabs, sessionId)`,
`rangeTargets(tabIds, tabId, mode)` (close-range computation, D8) → table-test the O1–O18 matrix
(§5) as pure functions. `rangeTargets` cases: left/right/others/all relative to `tabId`, empty
sets, `tabId` not in list.

### 9.3 Protocol / contracts guards

- `packages/desktop/src/main/browser/contracts.test.ts`: `isBrowserOperationName("claim") === true`,
  `isBrowserOperationName("set_tab_owner") === true`; `isBrokerRequest` accepts envelopes with
  `claim`/`set_tab_owner` ops + `tabId`; `toWireGuestTabState` includes `owner` + `active`.
- Protocol schema round-trips (`Schema.decodeUnknownSync`) for `HostRegistration` without session
  fields, `GuestTabState` with owner/active/muted, `StatusOutput` with `tabs`, `AssignRequest` with
  `owner: { kind: "user" }` and `owner: { kind: "agent", sessionId }`.

### 9.4 Desktop host/engine (loopback-only, no browser)

- `packages/desktop/src/main/browser/host.test.ts` (existing pattern, local loopback): hello payload
  no longer contains `sessionId` (drop `getSessionContext`; assert registration body); `handleRequest`
  forwards `sessionId` into `dispatch(tabId, operation, sessionId)` (spy).
- `operations` ownership branches via a stubbed registry (no CDP/webview — assert the error path
  before any CDP call): claim flips owner; claim on `agent(other)` throws `BrowserPermissionDenied`;
  `setTabOwner` flips owner (any value — user or any session); close with wrong-owner tabId throws;
  close-range preempts the arbiter per target; **duplicate copies the source owner to the new tab**;
  **setMuted flips the record's `muted` and syncs**.
- `arbitration.test.ts`: extend for `preempt` (close-driven preemption) behavior.

### 9.5 Tool-layer (no broker/host — parameters + prose)

Existing `packages/opencode/test/tool/parameters.test.ts` snapshot style:
- `browser_claim` parameters = `ClaimInput`; appears in the tool registry.
- `browser_open` parameters include `tabId`/`claim`; `browser_close`/`browser_status` descriptions
  contain the ownership/reuse prose (or rely on the parameters snapshot for shape only).
- `shared.ts` maps: `OperationInput.claim`, `OperationOutput.claim`, `FAMILY.claim`,
  `DEFAULT_TIMEOUT_MS.claim` present; `SetTabOwnerInput/Output` NOT in `OperationInput/Output` maps.

### 9.6 App renderer (unit only)

- `browserHostClient.test.ts`: `setSessionContext` removed; `assignTab`/`closeRange`/`refreshTab`/
  `duplicateTab`/`setTabMuted` wrappers invoke the raw API; the stub API shape matches the preload
  surface.
- Context-menu logic: extract the menu command handlers (refresh/duplicate/mute/close/closeRange/
  assign/return-to-me → client calls) into a pure/testable helper or a thin component test asserting
  the right client method fires per command; duplicate fires `duplicateTab`, mute toggles with the
  tab's current `muted` state.

> No test spins up a browser, opens a window, or dials an external host. The only sockets are the
> pre-existing local-loopback fake-host servers in the broker/host tests (localhost only).
