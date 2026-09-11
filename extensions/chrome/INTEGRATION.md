# chrome-attach — Cross-Peer Integration Contract (Coordinator Landing)

**Swarm:** `chrome-attach-feature` · 3 peers · model `muse-spark-1.2-contributor@xhigh` · **First-party only** (`desktop+sidecar`)

This file is the **single integration point** the three peers reconcile against. It captures the interfaces already published to `swarm_memory` and the file-system artifacts verified on disk.

## Verified artifacts (2026-09-09)

- `extensions/chrome/manifest.json` — MV3, permissions `debugger,activeTab,tabs,scripting,tabGroups,storage,downloads,nativeMessaging,offscreen`, `host_permissions <all_urls>`, classic bundled `background.service_worker src/background/sw.bundle.js`, content `ISOLATED world=document_start all_frames:false`, `externally_connectable http://127.0.0.1 + localhost`, side_panel — **verified 56 lines**.
- `extensions/chrome/src/background/sw.ts` — `DebuggerManager` + `NativePortV2` + `dispatchOperation`, including `claim/set_tab_owner` ownership transitions and the browser CDP operations; native host connection is eager on every MV3 worker boot. Exactly one native request listener is installed — **verified**.
- `extensions/chrome/host/com.opencode.desktop.json.template` — native host skeleton — **verified via glob**.
- `extensions/chrome/src/shared/{protocol,framing}.ts` — `isBrokerRequest`, framing helpers — **verified via glob**.
- `extensions/chrome/src/content/content.ts` → `content.js` — UTF-8 closed-shadow overlay with arrow cursor, click ping, hide/show barrier — **verified and built**.
- `packages/desktop/src/main/browser/{index,host,guest,control-session,contracts}.ts` — BrowserEngine/BrowserHost/GuestRegistry/ControlSession — **ground truth from research md §3.1**.

## Wire contract (byte-identical to `contracts.ts` — do not drift)

```
BrokerRequest { requestId, sessionId, windowId, workspaceId?, directory?, messageId, toolCallId?, tabId?, operation:{name,input}, timeoutMs }
BrokerResponse = {ok:true,requestId,result,elapsedMs,snapshotAfter?} | {ok:false,requestId,error:{tag,message,retryable,details?},elapsedMs}
BROWSER_PROTOCOL_VERSION = 2 (unchanged; chrome lane adds capabilities.chrome?:true)
Paths: POST /v1/browser/request + POST /v1/browser/request/:id/abort + POST /api/browser/host/hello + POST /api/browser/event
Extension relay: POST /v1/browser/extension/hello + GET /v1/browser/extension/poll + POST /v1/browser/extension/response + POST /v1/browser/extension/disconnect
Auth: every loopback BrowserHost path uses Bearer <callbackToken>; Chrome→native-host launch is additionally constrained by exact allowed_origins
Framing: native stdio = [4-byte LE len][UTF-8 JSON], host→ext ≤1 MiB (kMaximumNativeMessageSize), ext→host ≤64 MiB
```

## Lane routing (ExtensionBridge — desktop-bridge track)

```
Lane resolve:
  tabId present & extensionHost.hasTab(tabId) → extension
  else if registry.requireTab(tabId) → webview
  else → BrowserTabNotFound
  tabId absent & extension activeTab exists & capabilities.chrome → extension else webview activeTab
  status → merges both lanes' tab lists
Single responder: InFlight {request,timer,respond} — one writer, as host.ts:87-91
Health when Chrome is paired: GET /health → {ok,connected,chrome:true,lanes:["extension","webview"]}
```

## Overlay contract (overlay-ops track)

- Closed shadow `host.attachShadow({mode:"closed"})` at `z-index:2147483646`, `position:fixed inset:0 pointerEvents:none`, `MutationObserver` re-append — transplant from `packages/desktop/src/guest/annotation-overlay.ts:291-330`.
- Cursor: `BrowserPointerEvent {tabId,phase:"move"|"click",x,y,sequence,createdAt}` with pacing `AGENT_CURSOR_MOVE_MS=160` / `CLICK_LEAD_MS=40` (contracts.ts:65-66), `requestAnimationFrame` batch, `chrome.tabs.sendMessage({type:"opencode:cursor"|"opencode:highlight"})`.
- Hygiene: `HIDE_FOR_TOOL_USE` → `Page.captureScreenshot` → `SHOW_AFTER_TOOL_USE`; teardown on `onDetach/pagehide/navigation`.

## Native host pairing (all peers)

**Critical topology rule:** Chrome owns Native Messaging process lifetime and stdio. Desktop must never try to spawn/own Chrome's Native Messaging pipe. `chrome.runtime.connectNative()` causes Chrome to launch `native-host.ts`; that Chrome-launched process keeps an authenticated loopback long-poll to Desktop BrowserHost. Normal control is:

`sidecar → BrowserHost → ExtensionBridge → ExtensionHost queue → /extension/poll → native host stdout → MV3 worker → chrome.debugger → worker response → native host stdin → /extension/response → original BrowserHost request`.

This is why the old Desktop-child-process `ExtensionHost` shim was invalid even though mock tests passed.

Write per-browser JSON `com.opencode.desktop` to:
- Chrome macOS `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- Chrome Linux `~/.config/google-chrome/NativeMessagingHosts/`
- Brave/Edge variant dirs (BraveSoftware/Brave-Browser, Microsoft Edge) — polyfill from stolo community
- Windows `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencode.desktop` (REG_SZ → manifest path)
JSON: `{name, description, path:"<hostBinary>", type:"stdio", allowed_origins:["chrome-extension://<id>/"]}` — no wildcard.

## Current landed state (2026-09-09)

- Sidecar status reconciliation now treats the host's Chrome+webview status list as authoritative, so Chrome tabs are not overwritten by the broker's older webview-only mirror.
- Chrome ownership is preserved in Desktop across raw `chrome.tabs.query()` refreshes; new Chrome tabs enter as `user`, `browser_claim` transitions to `agent(sessionId)`, and `set_tab_owner` is supported.
- Disconnect clears the Chrome mirror and fails queued/pending extension work instead of leaking stale commands into a later reconnect.
- Regression validation: core BrowserHostBroker `50/50`, Desktop extension integration `10/10`, NativePort duplex `1/1`; `sw.bundle.js` rebuilt; `bun run build` succeeds and `out/main/index.js` contains `/v1/browser/extension/poll`.
- Live activation requires a Desktop main-process relaunch and Chrome extension reload. Do not kill all Electron processes; the currently running pre-fix main reports `/health chrome:false` and 404 for `/v1/browser/extension/hello` until intentionally relaunched.
