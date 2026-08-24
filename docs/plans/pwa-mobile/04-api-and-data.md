# 04 — API & Data Layer (mobile PWA)

Owner: api-data · Status: DONE · Scope: V1 HTTP API only (repo AGENTS.md mandate; V2/`SessionV2` off-limits).
Every endpoint claim carries a `path:line` citation read from this working tree. Inferences are labeled.

Companion docs: IA/screens → `01-ux-architecture.md`; tokens/components → `02`; source-of-truth/package strategy → `03`; SW/manifest/offline storage deep dive → `06`.

---

## 0. Answers to seeded questions (00-handoff §4)

| Question | Answer |
|---|---|
| Does `opencode serve` host static assets? | **Yes.** Raw catch-all UI route serves an embedded web UI (build-time generated file map) with SPA fallback to `index.html`, else proxies to `https://app.opencode.ai`. See §3. |
| SSE vs WebSocket for live sync | **SSE** — it is the *only* event transport that exists today. The sole WS route is PTY connect (ticket auth); `websocket-tracker.ts` is shutdown lifecycle plumbing, not an event channel. See §2. |
| Auth model for LAN access from a phone | Optional HTTP Basic (`OPENCODE_SERVER_PASSWORD` env), also accepted as `?auth_token=` (base64 `user:pass`) query param — and the existing web entry already consumes token-in-URL and strips it. A pairing QR flow needs **zero new server code**. See §4. |
| Service-worker caching boundary vs SSE/query invalidation | Contract split defined in §5 (what may be cached vs never); SW mechanics itself is pwa-platform's §06. |

---

## 1. Endpoint inventory (scoped features only)

Route registration: every instance route group mounts `InstanceContextMiddleware + WorkspaceRoutingMiddleware + Authorization` (e.g. groups/session.ts:506–508); the tree assembly is httpapi/server.ts:140–216. Per-directory routing rides a `directory` query field (`WorkspaceRoutingQueryFields`, imported at groups/session.ts:18–22) or the `x-opencode-directory` header (cli/cmd/web.ts:35–37 comment).

### 1.1 Cross-project browsing (Home tab)

| Method+Path | Mobile screen | Payload notes | Pagination |
|---|---|---|---|
| `GET /project` — groups/project.ts:22–31 | Home: project chips/filter | `Project.Info[]` of opened projects | none |
| `GET /project/current` — groups/project.ts:32–41 | Home default selection | single `Project.Info` | none |
| `GET /project/:projectID/directories` — groups/project.ts:65–75 | project→directory drill-down | `ProjectV2.Directories` | none |
| `GET /session?scope=project&limit&start&search&roots` — groups/session.ts:36–44,126–135; handler handlers/session.ts:67–78 | Sessions list (per directory AND per project via `scope=project`) | `Session.Info[]`, "sorted by most recently updated" (declared summary :133); `roots=true` filters root sessions; `search` server-side title filter | `start` offset + `limit` params declared :41,:43 |
| `GET /session/status` — groups/session.ts:136–146; handler handlers/session.ts:80–82 | busy/idle badges on list rows | `Record<sessionID, SessionStatus.Info>` — one call for all sessions, not per-row | none |

Cross-project event feed: `GET /global/event` (SSE) carries `{directory, project?, workspace?, payload}` per frame (groups/global.ts:35–48) — one stream can drive all projects' badges. Global health/config: `/global/health` :76–84, `/global/config` GET/PATCH :94–113.

### 1.2 Session chat (chat route)

| Method+Path | Mobile screen | Payload notes | Pagination |
|---|---|---|---|
| `GET /session/:sessionID` — groups/session.ts:147–158 | chat header/meta | `Session.Info` | none |
| `GET /session/:sessionID/message?limit&before` — groups/session.ts:49–53,194–205; handler handlers/session.ts:109–148 | timeline | `SessionV1.WithParts[]`. **Cursor paging:** `before` requires `limit` (400 otherwise, handler :113–114); next-page cursor returned as `Link: <…>; rel="next"` + `X-Next-Cursor` headers (:141–147). Omitting limit returns ALL messages (:122–124) — mobile must always page (§6) | keyset via `before` cursor |
| `GET /session/:sessionID/message/:messageID` — groups/session.ts:206–217 | jump-to-message deep link | single `WithParts` | none |
| `POST /session/:sessionID/message` (prompt) — groups/session.ts:370–382; handler handlers/session.ts:409–423 | composer send | **Synchronous**: resolves only after the assistant turn completes, returning final `WithParts` (handler streams one JSON blob :420–422). Streaming during the turn arrives via SSE events, not this response | n/a |
| `POST /session/:sessionID/prompt_async` — groups/session.ts:383–396; handler handlers/session.ts:425–443 | composer send (preferred on mobile) | 204 immediately; run forked server-side; failures surface as session error events (:430–441). This is the fire-and-forget primitive the offline outbox flushes into (§5) | n/a |
| `POST /session/:sessionID/command` / `/shell` — groups/session.ts:397–422 | slash commands; shell chip | command→`WithParts`; shell declares `SessionBusyError` :415 | n/a |
| `POST /session/:sessionID/abort` — groups/session.ts:268–279; handler :239–242 | stop button | boolean | n/a |
| `POST /session/:sessionID/pause`·`/resume` — groups/session.ts:280–304; handler :247–267 | backgrounding long runs | pause cancels in-flight run durably; resume drains admitted input (forked) | n/a |
| `POST /session/:sessionID/fork` — groups/session.ts:255–267 | "branch from here" | optional `messageID` payload | n/a |
| `POST /session/:sessionID/summarize` — groups/session.ts:357–369 | context overflow action | compaction trigger `{providerID, modelID, auto?}` | n/a |
| `POST /session/:sessionID/revert`·`/unrevert` — groups/session.ts:423–448 | edit-and-resend UX | both declare `SessionBusyError` | n/a |
| `DELETE /session/:sessionID/message/:messageID` (+ `/part/:partID`, `PATCH …/part/:partID`) — groups/session.ts:463–498 | message/part edit-delete menus | deleteMessage asserts not-busy (handler :498) | n/a |
| `GET /session/:sessionID/todo` — groups/session.ts:171–182 | todo sheet | `Todo.Info[]` | none |
| `GET /session/:sessionID/diff?messageID` — groups/session.ts:183–193; handler :102–107 | per-turn changes review | `Snapshot.FileDiff[]` | none |
| `GET /session/:sessionID/children` — groups/session.ts:159–170 | subagent/fork browser | `Session.Info[]` | none |
| `PATCH /session/:sessionID` — groups/session.ts:242–254; handler :190–211 | rename, archive, permission rules | partial `{title?, metadata?, permission?, time.archived?}` (**row actions for 01's list rows**) | n/a |
| `DELETE /session/:sessionID` — groups/session.ts:230–241 | swipe-to-delete | boolean | n/a |
| `POST /session/:sessionID/share` / `DELETE` same path — groups/session.ts:333–356 | share sheet | share link creation/removal | n/a |
| `POST /session/create` (`POST /session`) — groups/session.ts:218–229; handler :158–179 | new-session flow | `Session.CreateInput` (raw body tolerated empty, handler :162–166) | n/a |

Steer/queue semantics: **V1 has no dedicated steer/queue endpoint.** Steering = issuing another `prompt`/`prompt_async` while a run is active; explicit busy-rejection exists only where declared (`shell`, `revert`, `unrevert`, `deleteMessage` — citations above). Prompt-while-busy behavior was NOT traced into `SessionPrompt.loop` — flagged open question §7.

### 1.3 Permissions (never-cached, live-only)

| Method+Path | Mobile screen | Notes |
|---|---|---|
| `GET /permission` — groups/permission.ts:21–30 | global pending-permission badge/sheet | "all pending permission requests across all sessions" — one pollable/list call |
| `POST /permission/:requestID/reply` — groups/permission.ts:31–43 | approve/deny buttons | `{reply, message?}` |
| `POST /session/:sessionID/permissions/:permissionID` — groups/session.ts:449–462 | legacy alias | **declared deprecated** — use `/permission/:requestID/reply` |

### 1.4 @mention spotlight search

Server truth: `GET /find/search?q&limit≤1000&offset&symbols` — "Fuzzy-search files, directories, and symbols for @mention typeahead… merged score-ranked list with match highlight positions and offset pagination" (groups/file.ts:267–277; result union file|symbol with `positions` :45–63; query schema :35–43).
Client reality: `createAtMentionSearch` debounces 70 ms, pages 200/req with AbortController (at-mention-search.ts:6–7,59–103); wired at prompt-input.tsx:696 → `files.searchMentions` — which **currently falls back to legacy `GET /find/file`** because "/find/search [hasn't] shipped in the generated client" (context/file.tsx:318–330, fetch at :300–309). The server route exists; only the regenerated client is missing (§6 recommendation R2 unlocks it).
External-directory mentions: `GET /fs/external-list?path&sessionID&query&limit≤200` with typed 400/403/409 permission errors (groups/file.ts:366–377,97–132).

### 1.5 Context breakdown pane

No dedicated endpoint — computed **client-side**: `getSessionContext(messages, providers)` sums the last assistant message's `tokens.{input,output,reasoning,cache.read,cache.write}` and divides by the provider model's `limit.context` (session-context-metrics.ts:29–67); the component reads messages from the sync cache and cost from `Session.Info.cost` (session-context-usage.tsx:41–55). Data sources are therefore just §1.2 messages + provider list below. Zero new API surface needed.

### 1.6 Reference data (providers/models/config)

| Method+Path | Used for | Citation |
|---|---|---|
| `GET /config/providers` | model picker + context limits | groups/config.ts:38–47 |
| `GET /provider` · `GET /provider/auth` | connected-state, auth methods | groups/provider.ts:38–57 |
| `POST /provider/:providerID/oauth/authorize`·`/callback` | add-provider flow (rare on mobile; desktop-first) | groups/provider.ts:58–83 |
| `GET/PATCH /config` | settings screen | groups/config.ts:16–37 |
| `GET /tool/reload`→`POST /tool/reload` | dev-mode tool refresh | groups/tool.ts:31–40 |
| `GET /file/content?path` | read-only tool-output file preview | groups/file.ts:298–307 (content incl. `diff`/`patch` fields :156–181) |
| `GET /file/status` | git status chips | groups/file.ts:356–365 |
| `GET /find?pattern` (ripgrep text search) | search tab (if scoped later) | groups/file.ts:247–256 |

Out of scope per handoff §1: file explorer (`/file` list, write/delete/rename/mkdir — groups/file.ts:288–355 stay unused) and browser pane.

---

## 2. Realtime design

### 2.1 Transport: SSE, decisively

- The instance event stream is `GET /event`, success type `text/event-stream` (groups/event.ts:14–16). There is **no** general-purpose WebSocket event channel: the only declared WS upgrade is PTY connect with ticket auth (httpapi/server.ts:143,160–163); `websocket-tracker.ts` merely tracks sockets to close them on shutdown (websocket-tracker.ts:17–46).
- Wire shape: each frame is `event: message` with `data: {"id","type","properties"}`; the SSE `id:` field is deliberately left `undefined` (handlers/event.ts:30–37) ⇒ **no `Last-Event-ID` resume**. Reconnect = refetch, not replay (§2.3).
- Liveness: initial `server.connected` frame (:98) + `server.heartbeat` every 10 s (:91–94). On mobile, heartbeat absence > ~25 s = treat socket dead; iOS kills sockets quickly in background, so expect reconnect storms on foreground — cheap because reconnect is refetch-based.
- Server filters frames per directory/workspace before send (:63–67) and ends the stream on `server.instance.disposed` (:89).
- Battery/budget rationale: one long-lived GET vs WS framing + ping/pong protocol; EventSource auto-reconnect is native; and since we must refetch state after reconnect anyway (no resume cursor), WS's bidirectionality buys nothing. WS remains the right transport only if a future terminal/PTY feature ships (already exists server-side).
- Cross-project: subscribe `/global/event` once for all-directory badges (frame carries directory/project/workspace, groups/global.ts:35–48); open per-directory `/event` lazily only for the open session's directory.

### 2.2 Cache integration pattern (match the existing app)

The desktop/web app already defines the pattern a PWA inherits for free (server-sync.tsx):

- tanstack-query keys are `[scope, directory, name]` tuples (e.g. :107, :150, :208) — PWA keeps identical keys so extracted hooks keep working.
- Live data lives in Solid stores fed by an event listener applying reducers per event type (:553–672); queries are used for boot/reference data and invalidated from events (mcp/resources/tools invalidations :642–647).
- Burst coalescing: a refresh queue dedupes per-directory re-bootstraps (:371–376); rAF-deferred stream start (:689–704).
- PWA delta: same machinery, plus (a) suspend the stream on `visibilitychange hidden` (fork-usage.tsx already listens to visibility :67), resume+refetch on foreground; (b) tighter `staleTime` defaults on metered connections; (c) `refetchOnReconnect` left ON for queries (the app disables it only for the active-sessions seed query, :154–167).

### 2.3 Backfill-on-reconnect semantics (evidence-based)

Because SSE frames carry no usable cursor (§2.1), the app's own reconnect story is **state-refetch, not replay**: on `server.connected` it re-runs bootstrap for every active directory (server-sync.tsx:610–616 pushes all active dirs through the refresh queue; global events like `config.updated` refetch bootstrap :603–609). A PWA copies this exactly:

1. Foreground/online → reopen SSE.
2. On `server.connected`: invalidate `[scope, dir, "loadSessions"]` + active-sessions + open session's messages/todos/status; let tanstack-query refetch what's mounted.
3. Timeline gap-filling uses the messages cursor API: fetch pages with `before` until overlap with cached newest message (§1.2 pagination).
4. Do **not** build on `/sync/history` for UI backfill: it is the workspace-sync delta protocol over durable EventTable rows ("keys are aggregate IDs… values are last known sequence ID", groups/sync.ts:83–95; SQL diff query handlers/sync.ts:72–85) — designed for opencode↔workspace replication (`/sync/start|replay|steal`), not client catch-up. Cite it as future multi-device work, not PWA scope.

---

## 3. Serving strategy decision: SAME-ORIGIN, hosted by `opencode serve`

**Decision: the PWA ships as the embedded web UI served by opencode itself. No separate origin, no CORS.**

Evidence chain:
- Route tree reserves a raw catch-all `* /*` UI route whose comment states intent: "auth is router middleware so public static assets can bypass it" (httpapi/server.ts:140–146,207–216).
- That route calls `serveUIEffect` which serves an **embedded UI map** imported from a build-time generated module `opencode-web-ui.gen.ts` (shared/ui.ts:44–49; produced by packages/opencode/script/build.ts:184–190), with SPA fallback to `index.html` (shared/ui.ts:69). If the embedded map is absent it proxies to `https://app.opencode.ai` (UI_UPSTREAM shared/ui.ts:9; proxy path :88–106). Today's embedded bundle IS the current web app — i.e., "PWA as another build of the shared app" slots into an existing mechanism rather than inventing one.
- CSP is already set for hosted HTML: `default-src 'self'; … connect-src * data: blob:` (shared/ui.ts:11–13) — same-origin scripts/connect allowed; `connect-src *` even tolerates dev-mode cross-origin API targets.
- CORS would only matter for a separate origin: default allowlist is localhost/127.0.0.1/tauri/`*.opencode.ai` + user-added `--cors` entries (packages/server/src/cors.ts:11–20). A LAN-hosted PWA at `http://192.168.x.x:5173` calling `http://192.168.x.x:4096` would be blocked unless the user passes `--cors` — an unacceptable setup tax. Same-origin needs none of it.
- Platform seam: the web entry computes the API base as `location.origin` in prod builds (entry.tsx:103–108) and implements `Platform.getDefaultServer/setDefaultServer` over localStorage (entry.tsx:131–135; interface platform.tsx:88–91). Same-origin serving means zero-config server discovery on the phone; multi-server support stays available through the existing server-picker (dialog-select-server.tsx:57–71).
- Dev workflow unchanged: backend `serve --port 4096` + `bun dev --port 4444` cross-origin (repo/app AGENTS.md) keeps working because dev origins hit the CORS allowlist (localhost, cors.ts:13–14).

Consequences: install/manifest/SW assets are served by opencode (cache headers for `/` HTML must stay no-store so app updates land — flag to pwa-platform); mDNS naming (`opencode.local`) becomes the canonical phone URL (§4).

---

## 4. Auth & LAN pairing (minimal flow, zero new endpoints)

What exists today:
- Auth is **optional Basic**: enabled iff `OPENCODE_SERVER_PASSWORD` is set non-empty; username defaults `opencode` (server/auth.ts:17–26); constant comparison against decoded Basic credentials (auth.ts:28–34; decode middleware/authorization.ts:57–83). Challenge header `WWW-Authenticate: Basic realm="Secure Area"` (authorization.ts:14,48–51).
- Credentials are ALSO accepted as `?auth_token=<base64(user:pass)>` query param, checked first (authorization.ts:12,77–79) — this exists precisely because EventSource/img contexts can't set headers.
- The web app already implements the full consume-path: read `auth_token` → parse via `authFromToken` (utils/server.ts:10–19) → strip from URL via history.replaceState (entry.tsx:116–121,159–160) → attach `Authorization: Basic …` on all SDK calls (utils/server.ts:27–41,52–59).
- LAN exposure UX exists: `--mdns` publishes Bonjour `_http._tcp` `opencode-{port}` at `opencode.local` (mdns.ts:6–34) and defaults hostname to `0.0.0.0` (cli/network.ts:17–19,70–74); `opencode web` prints Local/Network/mDNS URLs and warns "! OPENCODE_SERVER_PASSWORD is not set; server is unsecured." (cli/cmd/web.ts:40–42,49–72).

Minimal pairing flow (design; pairs with 01's pairing screen):
1. Desktop/TUI shows QR encoding `http://<lan-ip>:<port>/?auth_token=<base64("opencode:" + password)>` — pure presentation layer over existing outputs (web.ts prints the URLs; password comes from the env the operator already set).
2. Phone scans → PWA loads same-origin → entry-path token consumption strips the secret from the URL/history (existing code) → store credentials in the PWA storage layer (ownership: pwa-platform §06 storage; ITP eviction risk noted §5).
3. Subsequent launches use stored Basic credentials; `Platform.getDefaultServer` returns the paired origin.

Security flags (explicit, per assignment):
- Basic auth over plain HTTP on LAN = credentials + all session content (source code, tool output, secrets agents touch) traversing unencrypted Wi-Fi. Anyone on the network can read traffic; captive/rogue APs trivially MITM. Acceptable for hobbyist LAN use, NOT for shared/office networks without a tunnel (Tailscale/WireGuard recommendation belongs in 06/07).
- `?auth_token=` leaks into server logs, browser history pre-strip, and iOS screen snapshots of the QR moment; the existing URL-strip mitigates history but not upstream logging.
- No rate limiting on auth attempts was observed in the middleware (authorization.ts) — brute-force feasible on weak passwords; pairing copy should require ≥16-char random tokens.
- Unauthenticated mode (no password) + `--mdns` exposes full filesystem/tool control to the LAN; the existing warning (web.ts:40–42) should be escalated in mobile onboarding copy (i18n keys proposed in §8).

---

## 5. Offline / stale policy boundary

Split by data class (SW mechanics = pwa-platform §06; this is the API-side contract):

| Class | Examples | Policy |
|---|---|---|
| Reference/slow | projects, providers, config, agents, commands, model limits | cache-first, stale-while-revalidate; safe to persist across launches |
| Session meta | `Session.Info`, status map, todos | stale-while-revalidate; refetch on reconnect (§2.3) |
| Messages | timeline pages | persist last N pages per session for instant cold-start; keyset cursors make refetch cheap; NEVER synthesize sends from cache |
| Derived | context metrics (client-computed, §1.5), markdown render cache | recomputed locally; free offline |
| File previews | `/file/content` | memory/session-cache only; do not persist repo contents to disk (device theft surface) |
| **Never cached / live-only** | **SSE stream state; pending permissions (`GET /permission`)** | permissions MUST be fetched fresh on foreground — acting on a stale permission list can approve an already-superseded request; show explicit "reconnecting" gate on approve/deny buttons when offline |
| Writes | prompt/command/shell/abort/reply/archive/delete | online-only with an explicit **outbox**: queue `prompt_async` submissions while offline (204-style fire-and-forget maps perfectly, §1.2), flush FIFO on reconnect, surface per-item retry/cancel UI. Flush must be **serial** (await each 204 before sending the next) so server-side admission order — and therefore timeline chronology via SSE `message.created` — matches queue order across reconnects (per 01 §5 UX requirement). Note: `prompt_async` returns no message ID, so queued→created mapping is reconciled from SSE events, not from the POST response. No server-side offline admission exists in V1 — this is client-side only (answers 01's offline-submit question) |

Storage-eviction pointer: Safari ITP can purge script-writable storage after 7 days of non-use — everything persisted above is reproducible from the server, so eviction degrades to refetch, never data loss. Deep dive + mitigation (install-as-app heuristic) is pwa-platform's.

---

## 6. Client layer & performance

### 6.1 Client library recommendation

Keep BOTH clients the app already uses, unchanged (03 owns packaging):
- `@opencode-ai/client` — vendored tgz `file:vendor/opencode-ai-client-1.17.13-v3.tgz` (packages/app/package.json:67), promise-style client used for V1 calls (`OpenCode.make`, utils/server.ts:44–62).
- `@opencode-ai/sdk` — workspace dep (package.json:70), the v2/client used by server-sync for dual-protocol branching (server-sync.tsx:1–8,441–445).
Implication for the PWA: reuse-strategist's extraction decides which package the mobile shell imports; the PWA adds NO third client. Vendored-tgz risk: it lags the server surface — concrete proof: `/find/search` exists server-side but the vendored/generated client lacks it, forcing the legacy fallback (context/file.tsx:318–330).
Regeneration rules (binding, repo AGENTS.md): after any HttpApi change run `bun run generate` in packages/client (script at packages/client/package.json:12; never hand-edit `src/generated*`); legacy JS SDK regenerates via `./packages/sdk/js/script/build.ts`. Recommendation R2: regenerate so `find.search` replaces the fallback — one-line swap at context/file.tsx:320–330 per its own TODO comment.

### 6.2 Payload/N+1 observations

- Sessions list is flat `Session.Info[]` (no message previews embedded) — a recents list showing "last message snippet" would need N× `GET /session/:id/message` calls. Avoid: show title/time/agent/status (status is ONE batched call, §1.1). If previews become a hard requirement, fetch lazily for visible rows only (virtualizer callback), never eagerly.
- Messages: omitting `limit` returns the ENTIRE session (handlers/session.ts:122–124) — catastrophic on 500-part sessions over WAN latency. Mobile contract: always `limit≤100` + `before` cursor; `X-Next-Cursor` drives infinite-upward-scroll (headers exposed via `Access-Control-Expose-Headers: Link, X-Next-Cursor`, :143).
- `POST /message` (sync prompt) holds the HTTP request open for the whole assistant turn (:409–423) — on flaky mobile radio this times out and looks like failure even though the run continues. Use `prompt_async` exclusively on mobile; progress arrives via SSE parts.
- SSE fan-out is server-cheap (per-event serialize-once cache, bound 1024, handlers/event.ts:14–18) — multiple PWA tabs/devices are fine.
- Virtualization hooks already present: `@tanstack/solid-virtual` is an app dependency (package.json:91); pair with messages keyset paging upward + capped downward window; session list virtualizes above ~50 rows with `limit` pages.

---

## 7. Open questions & risks

1. ⚠️ Prompt-while-running semantics: is a second `prompt` during an active run queued by `SessionPrompt.loop` or rejected? Not traced (lives outside httpapi). Determines whether mobile "send" during streaming is steer or must-be-disabled. Owner: api-data follow-up or core-savvy peer.
2. ⚠️ Embedded-UI update path: how the embedded map is refreshed for installed PWAs (HTML no-store vs versioned assets) — needs a joint decision with pwa-platform (their §06) before shipping updates.
3. HTTPS on LAN: PWA installability (and some SW features) generally requires secure context; `http://opencode.local` may degrade install prompts/push. Mitigation options (mkcert, Tailscale Serve) owned by pwa-platform/06; API side unaffected. **Doubly motivated** (confirmed against 06 §7.2): HTTPS fixes BOTH the service-worker secure-context requirement AND the plaintext-Basic credential/session-content exposure flagged in §4 — one mitigation, two risk classes closed.
4. `/global/event` auth: group has no Authorization middleware declaration visible in groups/global.ts (mounted under RootHttpApi which carries `.middleware(Authorization)` at api.ts:63–64) — behavior when password auth is ON should be smoke-tested (expect 401 without credentials; SSE then needs `?auth_token=`).
5. Rate limiting/lockout absent on Basic auth (§4) — acceptable risk to document, not solve, in ideation phase.
6. Message `before` cursor format is opaque (`MessageV2.cursor.decode`, handlers/session.ts:117) — treat as a black-box token; never construct cursors client-side.
7. `search.limit` ≤1000 vs app page size 200 mismatch is fine, but symbol results can dominate on large repos — mobile popover should cap rendered rows (~30) regardless of page size (UX: 01/05).

## 8. i18n keys proposed (naming only; copy lives with 01/05)

`pwa.pair.scanTitle`, `pwa.pair.tokenWarning`, `pwa.offline.queued`, `pwa.offline.flushFailed`, `pwa.permission.reconnectingGate`, `pwa.server.unsecuredWarning`.

— end of 04 —
