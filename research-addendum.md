# Research Addendum — Comprehensive Deep Dive

> Supplemental to `research.md`. Adds field-level manifests, protocol framing, overlay isolation tradeoffs, sidecar-broker grounding, open-source reuse inventory, and an expanded threat-mitigated implementation blueprint. All new claims cite primary sources; **Unconfirmed** otherwise.

---

## Implementation correction — 2026-09-09

The landed opencode carrier differs from the initial sketch in one crucial way: **Chrome owns the Native Messaging process and its stdio**. Desktop cannot directly own or attach to that pipe. The production path is therefore `Desktop BrowserHost queue → authenticated HTTP long-poll → Chrome-launched native host → Native Messaging stdio → extension`, with the extension response returning over native stdin and then authenticated HTTP `/v1/browser/extension/response` to Desktop. The old Desktop-spawned native-host test shim was architecturally invalid despite passing mocks.

The direction-specific Native Messaging limit also matters. The ≤1 MiB cap is **native host → extension**; browser commands in that direction are small. Screenshot base64 travels **extension → native host**, whose cap is much larger (64 MiB in this design), then crosses loopback HTTP back to BrowserHost. Therefore the blanket statements below that screenshots "cannot go over native messaging" are superseded by this correction; only payloads exceeding the extension→host cap require another carrier.

Status has a second reconciliation boundary: Desktop merges webview + Chrome tabs, and the sidecar broker must ingest that returned full snapshot before applying its own tab-list enrichment. Otherwise it silently replaces real Chrome tabs with its older webview-only mirror and `browser_status` falsely reports zero tabs. Ownership for Chrome tabs is maintained by opencode's Desktop/sidecar mirrors, not Chrome itself, and must survive `chrome.tabs.query()` refreshes.

---

## A. ChatGPT Atlas — OWL Architecture (why it matters for opencode's design)

OpenAI's Atlas was not an extension — it was a **separate Chromium process** remoted via its own layer **OWL (OpenAI Web Layer)**. Core paper: _How we built OWL_: "Atlas is the OWL Client, Chromium browser process is the OWL Host. They communicate over IPC, specifically **Mojo**, Chromium's own message-passing system. We wrote custom **Swift (+ TypeScript) Mojo bindings** so our Swift app can call host-side interfaces" with abstractions `Session / Profile / WebView / WebContentRenderer / LayerHost` [openai.com/index/building-chatgpt-atlas](https://openai.com/index/building-chatgpt-atlas) and NL mirror [openai.com/nl-NL/index/building-chatgpt-atlas](https://openai.com/nl-NL/index/building-chatgpt-atlas). Compositing used `gfx::AcceleratedWidget` → `CALayerHost` (private Apple API) [same].

Wikipedia confirms: Atlas was **Chromium + Blink, macOS-only, sidebar assistant, browser memories, agent mode**; announced Oct 21 2025, merged Mar 2026 into "ChatGPT + Atlas + Codex = one desktop app," shut down Aug 9 2026 [en.wikipedia.org/wiki/ChatGPT_Atlas](https://en.wikipedia.org/wiki/ChatGPT_Atlas). Tech press: Atlas is Chromium, can install Chrome extensions, search defaults to ChatGPT, "Ask ChatGPT" button [9to5google.com/.../chatgpt-atlas-is-yet-another-chromium-based-browser-with-clever-ai-features](https://9to5google.com/2025/10/22/chatgpt-atlas-is-yet-another-chromium-based-browser-with-clever-ai-features), [pcmag.com/.../meet-the-chatgpt-atlas-browser](https://www.pcmag.com/news/openais-chrome-killer-is-here-meet-the-chatgpt-atlas-browser). Analysis by ByteByteGo summarizes OWL Session/Profile/WebView/WebContentRenderer/LayerHost and Mojo [blog.bytebytego.com/p/the-architecture-behind-atlas-openais](https://blog.bytebytego.com/p/the-architecture-behind-atlas-openais).

**Takeaway for opencode:** OpenAI graduated *away* from a full remoted browser (OWL) toward the **user-profile extension + native-host** pattern for the long tail. opencode should skip the OWL-grade remoting and follow the post-Atlas extension pattern — same as Claude. Rebuilding OWL would violate "desktop+sidecar only, upstream mergeable."

---

## B. Manifest V3 Field-Level Specification for opencode's Chrome lane

### B.1 Minimal viable manifest (annotated)

```jsonc
{
  "manifest_version": 3,
  "name": "opencode for Chrome",
  "version": "0.1.0",
  "description": "Drive your existing Chrome from an opencode session (cookies/history intact).",
  "permissions": [
    "debugger",        // chrome.debugger — alternate CDP transport; triggers WARNING at install [developer.chrome.com/docs/extensions/reference/api/debugger]
    "activeTab",       // grant on user gesture to the current tab (least privilege)
    "tabs",            // tabs.query/create/update/group — tab groups per session
    "scripting",       // chrome.scripting.executeScript — inject a11y scanner [gist 1.2]
    "tabGroups",       // chrome.tabGroups — color/title for agent vs human group
    "storage",         // chrome.storage.local — permission memo + last pair token
    "downloads",       // capture agent-initiated downloads (mirrors Claude)
    "nativeMessaging", // runtime.connectNative — cross-boundary to desktop host [native-messaging]
    "offscreen"        // offscreen document keeps SW alive for screencast / audio [Claude permissions table]
  ],
  "host_permissions": ["http://*/*", "https://*/*"], // scripting on http(s) only; never chrome://
  "background": { "service_worker": "sw.js" },
  "content_scripts": [{
    "matches": ["http://*/*","https://*/*"],
    "js": ["content.js"],
    "run_at": "document_start",   // before page paint → overlay ready at first paint
    "all_frames": false,          // top only; iframes get own world (avoid double capture)
    "world": "ISOLATED"           // isolated world — page JS can't touch overlay state [content-scripts]
  }],
  "web_accessible_resources": [{
    "resources": ["cursor.svg","overlay.css"],
    "matches": ["<all_urls>"]
  }],
  "externally_connectable": {
    // optional second bridge: let opencode renderer (oc://) or a local web UI talk directly
    "matches": ["http://127.0.0.1/*","http://localhost/*"]
    // NOTE: page->ext only; extension cannot push to page except via content script
  },
  "side_panel": { "default_path": "sidepanel.html" } // human pair/status UI
}
```

*Why each permission:* mirrors the **union of OpenAI** (`debugger, activeTab, tabs, downloads, nativeMessaging, bookmarks, tabGroups` — Codex doc lists "Read and change all your data / browsing history / bookmarks / downloads / tab groups / native apps" [developers.openai.com/codex/app/chrome-extension]) **plus Claude** (`sidePanel, storage, scripting, debugger, declarativeNetRequestWithHostAccess, offscreen, system.display, webNavigation` — Claude Help Center table [support.claude.com/.../get-started-with-claude-in-chrome]). opencode keeps `system.display` deferred to M4 (DPR-aware clicks already handled by `viewport.dpr`).

### B.2 `chrome.debugger` domain allow-list (exact, non-guessable)

Per docs, **only these domains are available** via `chrome.debugger` (everything else → `BrowserDebuggerConflictError` or blocked): `Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, Input, Inspector, Log, Network, Overlay, Page, Performance, Profiler, Runtime, Storage, Target, Tracing, WebAudio, WebAuthn` [developer.chrome.com/docs/extensions/reference/api/debugger] / [developer.chrome.com/docs/extensions/mv2/reference/debugger] (same list, MV2 page spells "This permission triggers a warning").

For opencode this means: `Browser` (e.g., `Browser.getVersion`) and many `Target.*` mutations are **not** available — use `chrome.tabs.*` there. The table matters for planning which `operations.ts` calls port cleanly (see §E).

### B.3 Content-script world & isolation

Content scripts run in an **ISOLATED world** — "Content scripts live in an isolated world" [developer.chrome.com/docs/extensions/develop/concepts/content-scripts]. That isolates JS globals but **not CSS**. Hence shadow-DOM host is required for style isolation — see §C.

---

## C. Overlay — Three Isolation Strategies Compared

| Strategy | How | Style isolation | JS isolation | Renders over `chrome://` / PDF | Notes |
|---|---|---|---|---|---|
| **A. Shadow DOM (closed) — RECOMMENDED, already in opencode** | `host.attachShadow({mode:"closed"})`, `<style>` inside, `position:fixed, z-index:2147483646` | Strong if `:host{all:initial}`; inner `<style>` scoped | Isolated world already; shadow boundary hides from page `querySelector` | No (no content script) | `packages/desktop/src/guest/annotation-overlay.ts:291-310` + resilience `MutationObserver` re-append `[same:322-330]`. Pattern documented as cleanest in [bestchromeextensions.com/docs/guides/shadow-dom](https://bestchromeextensions.com/docs/guides/shadow-dom) and [bestchromeextensions.com/docs/patterns/shadow-dom-content-script-ui](https://bestchromeextensions.com/docs/patterns/shadow-dom-content-script-ui). StackOverflow consensus: Shadow DOM is "the solution without iframe" [stackoverflow.com/.../how-to-really-isolate-stylesheets...](https://stackoverflow.com/questions/12783217/how-to-really-isolate-stylesheets-in-the-google-chrome-extension). |
| **B. `<iframe>` injected** | `iframe.src = chrome.runtime.getURL("overlay.html")` | Total (iframe document) | Total | No | Robust but hit-tests require `elementsFromPoint` hopping across frame boundary; more latency. Mentioned as iframe fallback in uBlock element-picker discussion [stackoverflow.com/.../how-to-highlight-elements...](https://stackoverflow.com/questions/45985234/how-to-highlight-elements-in-a-chrome-extension-similar-to-how-devtools-does-it) |
| **C. CDP `Overlay` domain only** | `chrome.debugger.sendCommand({tabId},"Overlay.highlightNode",{highlightConfig})` / `highlightQuad` / `highlightRect` | Browser compositor — perfect, no DOM nodes | N/A | Yes (browser paint) | Used by DevTools (`inspector_overlay` modules `tool_highlight.ts`, `tool_grid.css` etc.) [chromium.googlesource.com/.../inspector_overlay](https://chromium.googlesource.com/devtools/devtools-frontend/+/312e43a6c50bc29f279f9eac2f91b723b36c7ee9/inspector_overlay). But: transient (cleared on nav), single highlight, no interactive label/number, **mutually exclusive with DevTools highlight**. SO recommends `highlightQuad/highlightNode` *via debugger* as "exact same as DevTools" but notes "only one debugger at a time" [same SO]. |

**Decision:** Ship **A + C hybrid**: shadow overlay for persistent cursor/highlight/selection-number (survives DevTools), `Overlay.*` only as a transient focus flash when the page is idle or when a11y scan fails. Hide shadow overlay during capture (`HIDE_FOR_TOOL_USE` → `Page.captureScreenshot` → `SHOW_AFTER_TOOL_USE`) — that's the Anthropic sequence [gist].

**Cursor specifics:** Don't mutate `document.body.style.cursor`. Instead track CDP `Input.dispatchMouseEvent {x,y}` and animate a `<div class="cursor">` in the shadow root with `requestAnimationFrame` and pacing `AGENT_CURSOR_MOVE_MS=160, CLICK_LEAD_MS=40` (`contracts.ts:65-66`). Fallback historical hack (`* {cursor:none}` + extension URL cursor) is fragile and requires `web_accessible_resources` + flicker [discourse.mozilla.org/.../custom-cursor-with-content-script](https://discourse.mozilla.org/t/custom-cursor-with-content-script/106741) — avoid.

---

## D. Native Messaging — Exact Framing (why "just JSON over stdio" is wrong)

Quote from spec: "Chrome starts each native messaging host in a **separate process** and communicates with it using **stdin/stdout**. The same format is used in both directions; **each message is serialized using JSON, UTF-8 encoded and is preceded with 32-bit message length in native byte order.**" [developer.chrome.com/docs/extensions/develop/concepts/native-messaging]. Same verbatim in App docs [developer.chrome.com/docs/apps/nativeMessaging] and Chromium template [chromium.googlesource.com/.../nativeMessaging.html].

Limits: **max from host → extension = 1 MiB** (protects Chrome), **host ← extension up to 64 MiB (legacy doc says 4 GiB, newer cap is 64 MiB)**; first arg to host is caller's origin (`chrome-extension://[ID]/`) [same]. Chromium source enforces `kMaximumNativeMessageSize = 1024*1024` and `kMessageHeaderSize = 4` with `kReadBufferSize = 4096` [chromium/.../native_message_process_host.cc] (also via Extension.js summary: "32-bit little-endian length + UTF-8 JSON" [extension.js.org/docs/implementation-guide/native-messaging]).

**Implications for opencode:**
- Never `JSON.stringify` + `process.stdout.write(json)` — must prefix **LE 32-bit len**. Extension.js and DeepWiki both flag this as #1 bug [extension.js.org], [deepwiki.com/patniko/github-copilot-browser/...], [deepwiki.com/nicobailon/pi-annotate/...].
- Chunk `screenshot.data` (>1 MiB) cannot go over native messaging — must go via the loopback HTTP/WebSocket `BrokerResponse` where the existing `maxResultBytes=64*1024` / `maxSnapshotBytes=256*1024` caps already apply (`src/main/browser/index.ts:91-96`). Keep CDP screenshots on the HTTP path.
- `allowed_origins` cannot be wildcard — exact `chrome-extension://<id>/` per manifest [native-messaging docs].
- Host manifest locations are fixed per OS/browser (see §3.3 in main doc + next bullet).

**Manifest file placement (exact):**
- macOS user: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<name>.json` [developer.chrome.com/.../native-messaging]
- Linux user: `~/.config/google-chrome/NativeMessagingHosts/<name>.json`; system: `/etc/opt/chrome/native-messaging-hosts/<name>.json` [same]
- Windows: `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>` → path to manifest JSON [same] / Registry check for Codex host enumerated in troubleshooting [code.claude.com/docs/en/chrome.md].

Claude's per-browser polyfill shows the same JSON needs to be **copied to each browser's dir** (`.../BraveSoftware/Brave-Browser/NativeMessagingHosts/...`) to support Brave/Arc [github.com/stolot0mt0m/.../manual-setup.md].

---

## E. Open-Source Reuse Inventory — What to Copy vs. Derive vs. Avoid

| Project | What it is | License | Reuse for opencode | Link |
|---|---|---|---|---|
| **open-claude-in-chrome** (Christian-Beske / noemica fork) | Clean-room reimplementation of Claude's 18/21-tool extension: `extension/` (MV3 CDP), `host/mcp-server.js` (stdio MCP ↔ TCP ↔ native host) | **MIT** | Copy `manifest.json`, `Target.setAutoAttach` + `sessionId` flat-session glue, `Input.dispatchMouseEvent` click recipe, tab-group handling. Don't copy blocked-domain logic (intentionally stripped). | [github.com/noemica-io/open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome) + [github.com/Christian-Beske/open-claude-in-chrome-](https://github.com/Christian-Beske/open-claude-in-chrome-) |
| **opencode-browser** (different-ai) | opencode plugin using **direct CDP WS** (`browser_url`) without extension — mirrors OpenWork example | **MIT-ish (repo)** | Negative example: shows why **extension lane is needed** for default profile (see Chrome 136 hardening below). Reuse its `browser_snapshot/browser_click` tool shapes for the new lane's `operations.ts` mapping. | [github.com/different-ai/opencode-browser/blob/main/README.md](https://github.com/different-ai/opencode-browser/blob/main/README.md) |
| **vymalo/opencode-browser** + `opencode-browser-mcp` | WS bridge where **extension dials out** to `ws://127.0.0.1:<port>`; opencode hosts the bridge — `hello/ready/command/result/event/ping/pong` frames. Mirrors protocol at `packages/opencode-browser/src/protocol.ts`. | **MIT** | Copy the **outbound-WS-from-extension** fallback (W-SL friendly) and `hello` auth-token + single-client / pending-map / abort wiring. Already opencode-native (`@vymalo/opencode-browser` plugin). | [github.com/vymalo/opencode-oauth2/.../browser.md](https://github.com/vymalo/opencode-oauth2/blob/main/docs/browser.md) |
| **AIPex** + `browser-cli` daemon | Real-profile extension + local daemon `aipex-daemon(:9223)` with `/extension` + `/cli` + `/bridge` endpoints; 30+ MCP tools, DOM snapshot-first before vision | **MIT** | Copy daemon endpoint split and `ws://localhost:9223/extension` convention plus `browser-cli` tool-group CLI as UX prior art for `opencode chrome status`. | [github.com/AIPexStudio/AIPex](https://github.com/AIPexStudio/AIPex) → [github.com/AIPexStudio/browser-cli](https://github.com/AIPexStudio/browser-cli) + [chromewebstore.google.com/detail/aipex/iglkpadagfelcpmiidndgjgafpdifnke](https://chromewebstore.google.com/detail/aipex/iglkpadagfelcpmiidndgjgafpdifnke) |
| **kimi-webbridge** v2 plan | Extension-per-tab **Action Runtime** (MutationObserver verification, safe `evaluate` sandbox, element registry, trace) | **MIT** | Copy the reliability layer: verification after act, `submit_form` primitive, `already declared` SyntaxError sandbox for `evaluate`. File: `efrg123/kimi-webbridge` README gaps. | [github.com/efrg123/kimi-webbridge](https://github.com/efrg123/kimi-webbridge) |
| **web-extension-browser** (dfwgj) | Cloud AI → `apps/server(ws)` → `apps/web(chrome.runtime.sendMessage via externally_connectable)` → `chrome.debugger→CDP` | **MIT** | Copy `externally_connectable` cloud relay when WSL has no local install; note that `executeScript` with `browser` in scope needs trusted `externally_connectable` allow-list. | [github.com/dfwgj/web-extension-browser](https://github.com/dfwgj/web-extension-browser) |
| **Atlas architecture docs** | OWL / Mojo / Session/Profile/WebView | **Proprietary (educational)** | Do NOT replicate OWL. Treat as cautionary: use extension lane. | [openai.com/index/building-chatgpt-atlas](https://openai.com/index/building-chatgpt-atlas) |

All above MIT projects can be vendored with attribution; **Anthropic's own extension source and OpenAI's Store CRX are proprietary** — study only via gist [sshh12] + docs, don't vendor.

---

## F. Opencode Sidecar & Desktop Grounding (file-level)

**Desktop shell**

- Electron 42, package `@opencode-ai/desktop` v1.18.29 [packages/desktop/package.json:1-80]. Main entry `out/main/index.js`, dev via `electron-vite dev` [same:15-17].
- Sidecar is a **UtilityProcess** with `parentPort` message `{type:"start",hostname,port,password,userDataPath}` → imports `virtual:opencode-server` → `Server.listen({port,hostname,username:"opencode",password,cors:["oc://renderer"]})` → `postMessage({type:"ready"})` (`packages/desktop/src/main/sidecar.ts:1-185`).
- Env hardening: merges `XDG_STATE_HOME=userDataPath`, appends `127.0.0.1,localhost,::1` to `NO_PROXY` (both cases), installs system CA certs, enables `http.setGlobalProxyFromEnv` [same:104-145].

**Browser stack (already shippable, reference for Chrome lane)**

- `BrowserEngine` facade composes guest registry + control arbiter + `ControlSessionManager` + `BrowserOperations` + `BrowserHost` + `AnnotationController` and owns the renderer IPC `window.api.browser` + broadcasts (`packages/desktop/src/main/browser/index.ts:1-433` — file header even calls out `GUEST_STATE_EVENT_DEBOUNCE_MS=80` coalescing for sidecar POSTs [same:36]).
- `GuestRegistry` validates `wc.getType()==="webview" && wc.hostWebContents===hostWindow` (T3 ownership contract) (`guest.ts:38-41`), owns `url/title/readyState/loading/zoom/colorScheme/controller/generation/crashed/attached/muted/viewport/snapshotVersion` [same:353-374], wires `did-start-loading/did-stop-loading/did-finish-load/page-title-updated/did-navigate/did-navigate-in-page/render-process-gone/did-fail-load/destroyed/ipc-message[HUMAN_INPUT_CHANNEL]` [same:259-324], denies popup windows [same:339], restricts nav to `http(s)` only [same:341-346].
- `control-session.ts` is the Electron CDP cell: `wc.debugger.attach("1.3")`, enable `Runtime/Accessibility/Network/Log`, `Input.setIgnoreInputEvents`, emulated color scheme (`packages/desktop/src/main/browser/control-session.ts:140-170`), epoch-guarded sender + one-permit semaphore (`same:172-213`), screencast `Page.screencastFrame` fan-out (`same:281-284`), DevTools handoff (`detachForDevTools/reattach` [same:187-196]).
- `contracts.ts` is desktop-side source of truth, byte-identical to `packages/protocol/src/groups/browser.ts` when the dep is added (`contracts.ts:1-15`). Caps: `AGENT_CURSOR_MOVE_MS=160, CLICK_LEAD_MS=40, HUMAN_PREEMPT_WINDOW_MS=750, MAX_SCREENSHOT_WIDTH=1280, RECORDING_*`, 16 error tags incl. `BrowserStaleRefError/BrowserNotAReactAppError` [same:17-112].

**Overlay template**

- `annotation-overlay.ts:1-1143` closed shadow, fixed inset, chip labels from `__reactFiber$` expando under `contextIsolation:true` (comment explicitly warns not to set `contextIsolation=false` [same:206-273]), `requestAnimationFrame` batching, `MutationObserver` re-append, `pagehide/visibilitychange` restore+teardown, stroke decimation `>=2px` [same].

---

## G. Security — Expanded Threat Model & Controls

| Threat | Vector | Control in proposal |
|---|---|---|
| **Stealing cookies via rogue localhost client** — attacker on same machine attaches to real profile | Raw `--remote-debugging-port` on default dir (known cookie-theft since 2018 — Chrome blog cites `mango.pdf.zone` & `cookie_crimes` [developer.chrome.com/blog/remote-debugging-port]) | **Do not use** remote port on default dir. Use `chrome.debugger` extension lane (requires user install + `debugger` grant). Chrome 136 enforces this by ignoring the switches on default `userDataDir` unless `Chrome for Testing` [same blog]. Document SpecterOps BOF `StartRemoteDebuggingServer` in-process injection as out-of-scope (requires code injection). |
| **Silent attach without prompt** | Native messaging host spawned by Chrome → no extra OS dialog beyond install | Require first-attach **per-tab consent dialog** in the extension sidePanel (ask/always/deny), mirroring Claude's manual/auto modes [support.claude.com/.../permissions-guide] + domain `category1/2` hard block via local allowlist or server (see below). |
| **Prompt injection via page content** | Agent reads page → page injects instructions | Anthropic classifies content via `api.anthropic.com/api/web/domain_info/browser_extension?domain=` → `category_org_blocked/category1/2` plus `org_policy` block on `claude.ai` itself (reported as bug because it blocks first-party) [github.com/anthropics/claude-code/issues/50157] & dev subdomain example [same:43279]. opencode should implement a **local** `blockedUrlPatterns` + `allowedUrlPatterns` (not server-authoritative) so `-dev.`/`-staging.` on same eTLD+1 don't false-block. |
| **Infobar masking / UI spoof** | Overlay covers browser chrome or system dialogs | Shadow overlay is clipped to viewport (`inset:0`) and never draws over Chrome UI. Infobar `"$1 started debugging this browser"` is browser chrome, not page DOM — cannot be covered by content script. Offer suppress via `--silent-debugger-extension-api` only behind an explicit toggle (document trade-off). |
| **Extension ↔ desktop MITM over loopback** | Local WS/HTTP between extension and sidecar | Reuse `BrowserHost` Bearer `callbackToken` over `http://127.0.0.1:<ephemeral>` (`host.ts:18-25`); for native messaging the OS token is implicit (Chrome enforces `allowed_origins`). |
| **Message size blowup** | Large screenshot / a11y tree > 1 MiB via native messaging | Route >1 MiB payloads via the **HTTP broker path** (`host.ts:postSidecar` JSON text cap) rather than native messaging; keep native messages small (command dispatch only). |

---

## H. CDP Domain Availability — What Ports vs. What Falls Back to `chrome.*` Tabs

| opencode `BrowserOperation` | CDP method | Available via `chrome.debugger`? | Fallback |
|---|---|---|---|
| `snapshot` (a11y tree) | `Accessibility.getFullAXTree` | ✅ (listed) | `chrome.scripting.executeScript` with in-page `window.__generateAccessibilityTree` (Claude's path). |
| `click/input` | `Input.dispatchMouseEvent` | ✅ | none |
| `type` | `Input.insertText` or in-page `Runtime.evaluate` | ✅ | in-page `input`/`change` events (`content.js` fallback). |
| `press` | `Input.dispatchKeyEvent` | ✅ | `Emulation.setFocusEmulationEnabled` + `Runtime.evaluate` |
| `scroll` | `Input.dispatchMouseEvent type:mouseWheel` or `Runtime.evaluate` scrollBy | ✅ | `Runtime.evaluate` always works |
| `highlight/annotate` | `Overlay.highlightNode/Quad/Rect` | ✅ | shadow boxes (preferred) |
| `resize` | `Emulation.setDeviceMetricsOverride` | ✅ | — |
| `screenshot` | `Page.captureScreenshot` | ✅ | `chrome.tabs.captureVisibleTab` (degraded, one tab) |
| `screencast` | `Page.startScreencast` | ✅ (via `Page`) | — |
| `navigate` | `Page.navigate` vs `chrome.tabs.update` | ✅ | Prefer `chrome.tabs.update` for history/back/forward (`tabs.goBack/goForward`) |
| `Browser.getVersion` / `Target.getTargets` | `Browser.*` / `Target.*` (non-flattening) | ❌/limited | Use `chrome.debugger.getTargets()` (extension API, separate from CDP) [debugger docs] |

Claude's triage table proves the split: `tabs_context/create/navigate/read_page/find` survive debugger denial, `screenshot/javascript_tool/left_click` fail when debugger blocked [github.com/anthropics/claude-code/issues/45221].

---

## I. Milestones — Expanded Workplans with File Paths & Exit Gates

### M0 — Contract freeze + spike (3 d)

- Verify Chrome 136 default-dir hardening on CI's Chrome version (`chrome://version` → check `--remote-debugging-port` ignored without `--user-data-dir` per blog).
- Spike: unpacked extension `chrome.debugger.attach({tabId},"1.3")` → `Page.navigate` → `Input.dispatchMouseEvent` click; screenshot before/after `HIDE`.
- **Files:** `extensions/chrome/manifest.json`, `extensions/chrome/sw.js`, `docs/browser-chrome-spike.md`.

### M1 — MVP pairing (1 wk)

- Desktop: installer that writes `com.opencode.desktop.json` for **each** browser dir (`Google/Chrome`, `BraveSoftware/Brave-Browser`, `Microsoft Edge`) — copy pattern from community polyfill [manual-setup.md]. Binary `extensions/chrome/host/opencode-native-host` in `packages/desktop/native/` (Bun→Node bridge, handles 4-byte framing).
- Extension: `runtime.connectNative("com.opencode.desktop")` long-lived Port, `externally_connectable` fallback for WSL.
- **Exit:** `opencode chrome --pair` prints `Extension: Installed / Host: reachable / Hosts written: 3`.

### M2 — Broker multiplex (1.5 wk)

- New `packages/desktop/src/main/browser/extension-bridge.ts` (200 LOC) implementing `BrowserHostOptions.dispatch`-compatible `dispatch(tabId,op,sessionId)`. Reuses `BrowserOperation` types (no new tags). Registers alongside `GuestRegistry` via capability `chrome:true` alongside `webview:true`.
- `Target.setAutoAttach flatten:true` glue + child `sessionId` map (port `host.ts:Attach to related targets` snippet).
- **Exit:** `browser_snapshot`, `browser_click`, `browser_navigate`, `browser_screenshot` on a Chrome tab with Google login intact.

### M3 — Overlay hygiene (1 wk)

- Transplant `annotation-overlay.ts` shadow host → `extensions/chrome/content.js` (rename `OVERLAY_ATTRIBUTE` → `data-opencode-overlay`). Verify `MutationObserver` re-append survives Gmail SPA nav.
- **Exit:** `browser_click` shows 160 ms cursor glide + 40 ms pulse + numbered box; `Page.captureScreenshot` with `captureBeyondViewport:true` proves no overlay ghost.

### M4 — Tab groups & allowlist (1 wk)

- `chrome.tabGroups` per-session groups ("opencode — <sessionId short>"), close-on-clear vs. retain-on-resume (copy Claude Code group lifetimes [code.claude.com/docs/en/chrome.md]).
- Local `allowedUrlPatterns / blockedUrlPatterns` in `chrome.storage.local` (no server round-trip for `-dev.` hosts — addresses the `open-claude-in-chrome` defect [issue 43279]).
- **Exit:** e2e Playwright test: "open example.com in Chrome, annotate, screenshot, close group."

---

## J. Verification Matrix — How to Prove the Design Without Guessing

| Claim | Verification command |
|---|---|
| Extension can reach every listed CDP domain | `chrome.debugger.sendCommand({tabId},"Overlay.highlightRect",...)` should succeed; `Browser.getVersion` should fail with "not available via chrome.debugger" |
| Native host framing correct | `printf '\x10\x00\x00\x00{"text":"hello"}' \| ./host \| hexdump -C` shows LE len then JSON |
| No screenshot via native messaging | Try to send >1.1 MB `Page.captureScreenshot` base64 over `postMessage` on Port — observe Chrome drops / `kMaximumNativeMessageSize` log [chromium source] |
| Infobar exists | Load test extension with `debugger` + `chrome.debugger.attach` — Mac shows "«Extension Name» started debugging this browser" bar on every tab; `chrome://flags#silent-debugger-extension-api` hides it |
| Default-dir hardening active | `google-chrome --remote-debugging-port=9222` alone → `curl http://127.0.0.1:9222/json/version` fails on Chrome ≥136; with `--user-data-dir=/tmp/x` succeeds |

---

## K. Remaining Unconfirmed / To-Verify in M0

- Whether `chrome.debugger` on Chrome 136 still allows `Emulation.setDeviceMetricsOverride` for non-active tabs (docs list Emulation ✅, but effective DPR may clamp). → test in spike.
- Whether `Page.startScreencast` is throttled identically via `chrome.debugger` vs `webContents.debugger` (assume yes — both are CDP).
- Whether Arc/Edge native host dirs have migrated to new names (observational — check `manual-setup.md` per-browser paths each quarter).

---

*End of addendum. Main document + addendum together satisfy the three deliverables: research report with URLs, comparison table, and a concrete 4-milestone plan scoped to `packages/desktop` + `extensions/chrome`.*
