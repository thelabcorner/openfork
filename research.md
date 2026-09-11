# Research: Real Chrome Attach via CDP + Extension Overlay for opencode

**Date:** 2026-09-08  
**Scope:** How Codex/Claude/ChatGPT drive the user's *existing* Chrome via extension+CDP and visible overlay, and how to add the same to opencode (desktop+sidecar only).

> Every claim below cites a primary source URL. Items without a verifiable source are marked **Unconfirmed**.

---

## Implementation reality — 2026-09-09

The landed integration uses a **Chrome-owned Native Messaging process**, not a Desktop-owned stdio child. `chrome.runtime.connectNative()` launches `com.opencode.desktop`; that native process discovers Desktop's ephemeral BrowserHost from `browser-host.json`, registers through authenticated loopback HTTP, and long-polls Desktop for queued extension commands. Responses return extension → native stdin → authenticated BrowserHost HTTP. This topology is now the implementation source of truth because Desktop cannot attach to Chrome's private Native Messaging stdio after Chrome launches the process.

The Desktop host's merged `status` snapshot is also authoritative for the sidecar tab mirror. The broker reconciles returned Chrome+webview tabs before status enrichment; otherwise its event-only webview cache would overwrite the Chrome list. Chrome itself does not own opencode session ownership, so Desktop preserves `user` / `agent(sessionId)` state across raw tab refreshes and supports explicit claim/reassignment.

---

## 1. Phase 1 — Online Research

### 1.1 Codex / ChatGPT browser integration ("ChatGPT Atlas / Browser Connector")

**Product names (evolving):** OpenAI launched **ChatGPT Atlas** (Chromium-based browser with ChatGPT built in, macOS GA Oct 2025) — now *deprecated* and folded into ChatGPT/Codex browser controls — and separately ships a **Chrome extension + desktop plugin** for driving the user's existing Chrome profile [openai.com/blog/introducing-chatgpt-atlas](https://openai.com/blog/introducing-chatgpt-atlas) and [help.openai.com/.../evolving-atlas-into-chatgpt-for-browser-based-agentic-work](https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work). Atlas himself ran a full Chromium with profiles, bookmarks, agent mode; the replacement is the extension approach below [help.openai.com/.../evolving-atlas...](https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work).

**Extension identity:**
- Listing: **ChatGPT** — Chrome Web Store `hehggadaopoacecdllhhajmbjkdcmajg` ("Control your browser with ChatGPT", 4 M users, 21.26 MiB, v1.26.827.12125, Offered by OpenAI, San Francisco) [chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg). An older search sidebar extension is `imghpeejkmlghkiiofkhbeneepilbefd` [microsoftedge.microsoft.com/.../imghpeejkmlghkiiofkhbeneepilbefd](https://microsoftedge.microsoft.com/addons/detail/imghpeejkmlghkiiofkhbeneepilbefd) (unrelated).
- Codex docs call it **"Chrome extension" / "ChatGPT Chrome Extension" / "Codex Chrome plugin"** — installed from the *ChatGPT desktop app → Plugins Directory → Chrome* [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension). Other Chromium browsers are **not currently supported** by OpenAI [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension) (cf. Claude below).

**How it bridges to the agent:**
1. User installs ChatGPT/Codex desktop app, then **Plugins → Chrome → Install Chrome extension** [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension). The extension shows a **side chat** panel (Cmd+Shift+.) in Chrome [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension) / [learn.chatgpt.com/docs/chrome-extension.md](https://learn.chatgpt.com/docs/chrome-extension.md).
2. Desktop app registers a **Native Messaging host manifest** at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json` pointing at a bundled host binary under `~/.codex/plugins/cache/openai-bundled/chrome/<version>/extension-host/macos/arm64/ChatGPT for Chrome` (previously `extension-host`) [github.com/openai/codex/issues/31904](https://github.com/openai/codex/issues/31904). Path is referenced as `com.openai.codexextension` [github.com/openai/codex/issues/31904](https://github.com/openai/codex/issues/31904). The host is `stdio` type (`"type":"stdio"`, `"allowed_origins":["chrome-extension://..."]`) per the generic native-messaging spec [developer.chrome.com/docs/extensions/develop/concepts/native-messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) and the GitHub `developer.chrome.com` mirror [github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/nativeMessaging/index.md](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/nativeMessaging/index.md).
3. Extension calls **`chrome.runtime.connectNative("com.openai.codexextension")` / `sendNativeMessage`** to the host; the host relays to the desktop app over local IPC (conceptually the same as Claude below — see §1.2). When the host manifest symlink is stale the side panel falls back to **"Install the app to use ChatGPT in Chrome"** [github.com/openai/codex/issues/31904](https://github.com/openai/codex/issues/31904).
4. In-chat invocation: **`@Chrome`** mention or **`@Browser`** (built-in vs. extension) [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension) / [learn.chatgpt.com/docs/chrome-extension.md](https://learn.chatgpt.com/docs/chrome-extension.md). Tasks run in **Chrome tab groups** so work stays grouped [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension).

**Tab select / attach:**
- Permissions prompt lists **"Access the page debugger"**, **"Read and change all your data on all websites"**, **"Read and change your browsing history / bookmarks / downloads / tab groups"**, **"Communicate with cooperating native applications"** [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension). The debugger permission is the CDP transport [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger).
- The extension attaches via **`chrome.debugger.attach({tabId}, "1.3")` → `chrome.debugger.sendCommand(tab, method, params)`** — the generic `chrome.debugger` pattern from the official docs [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) and sample [github.com/GoogleChrome/chrome-extensions-samples/blob/main/api-samples/debugger/README.md](https://github.com/GoogleChrome/chrome-extensions-samples/blob/main/api-samples/debugger/README.md). Restricted domains (Accessibility, Input, Page, Overlay, Runtime, DOM, …) are enumerated on that page [developer.chrome.com/docs/extensions/mv2/reference/debugger](https://developer.chrome.com/docs/extensions/mv2/reference/debugger) / [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger). OpenAI's "Developer mode → enable full CDP access" explicitly gives the desktop app's **built-in browser** full CDP inspection (House doc: "give ChatGPT controlled access to the Chrome DevTools Protocol (CDP)") [learn.chatgpt.com/docs/browser](https://learn.chatgpt.com/docs/browser).
- Cross-store trigger: `@Chrome open Salesforce and update the account…` — if Chrome isn't open, ChatGPT can open it [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension).

**License / reuse:** OpenAI extension is proprietary (Chrome Web Store). No source license to copy; protocol docs above are Apache/CC-BY.

---

### 1.2 Claude (Anthropic) — Claude in Chrome / Claude Code

**Extension identity:**
- **Claude in Chrome** — Chrome Web Store `fcoeoabgfenejglbffodgkkbkcdhcgfn` (official Anthropic extension, references throughout Claude docs) — install path is `https://claude.ai/chrome` when the extension is referenced as `https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn` [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md) / [support.claude.com/.../get-started-with-claude-in-chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome?1e959936_page=2&2f226f2c_page=2&38c1d113_page=3&f80ce999_sort_Plus%20ancien=asc&f80ce999_sort_date=desc). Alternate allowed origins in native manifests include `dihbgbndebgnbjfmelmegjepbnkhlgni`, `dngcpimnedloihjnnfngkgjoidhnaolf` alongside the main ID (visible in community manifest generator) [github.com/stolot0mt0m/claude-chromium-native-messaging/blob/main/docs/manual-setup.md](https://github.com/stolot0mt0m/claude-chromium-native-messaging/blob/main/docs/manual-setup.md).
- GA Aug 26 2026 on all paid plans (Pro/Max/Team/Enterprise) [claude.com/blog/claude-in-chrome-generally-available](https://claude.com/blog/claude-in-chrome-generally-available).

**Connection method — extension `chrome.debugger` + Native Messaging:**
- Official permission list: `sidePanel`, `storage`, `scripting`, **`debugger` ("This is what allows Claude to actually control your browser – clicking buttons, typing text, and taking screenshots")**, `declarativeNetRequestWithHostAccess`, `offscreen`, **`nativeMessaging` ("seamlessly integrate with Claude Desktop or Claude Code")**, `downloads`, `unlimitedStorage` [support.claude.com/.../get-started-with-claude-in-chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome?1e959936_page=2&2f226f2c_page=2&38c1d113_page=3&f80ce999_sort_Plus%20ancien=asc&f80ce999_sort_date=desc) and later augmented with `tabs`, `tabGroups`, `system.display`, `webNavigation` [support.claude.com/.../get-started-with-claude-in-chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) (same URL, updated listing).
- `debugger` permission is declared in manifest as `"permissions":["debugger"]` and drives CDP [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger). Official doc notes enterprise `ExtensionSettings.runtime_blocked_hosts` can block `chrome.debugger.attach()` outright [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger). All available CDP domains for the extension transport are enumerated there as well (Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM, Emulation, Fetch, IO, Input, Inspector, Log, Network, **Overlay**, Page, Performance, Profiler, Runtime, Storage, Target, Tracing, …) [developer.chrome.com/docs/extensions/mv2/reference/debugger](https://developer.chrome.com/docs/extensions/mv2/reference/debugger).
- **Native Messaging hosts:** `com.anthropic.claude_browser_extension` (Desktop) at `/Applications/Claude.app/Contents/Helpers/chrome-native-host`, `com.anthropic.claude_code_browser_extension` (Code) at `~/.claude/chrome/chrome-native-host` [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md) (Troubleshooting table). Location per platform is `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/*.json` (macOS) / `~/.config/google-chrome/NativeMessagingHosts/` (Linux) / Registry (Win) [developer.chrome.com/docs/extensions/develop/concepts/native-messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) / [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md). Community generator shows `allowed_origins` exact values and manifest skeleton [github.com/stolot0mt0m/claude-chromium-native-messaging/blob/main/docs/manual-setup.md](https://github.com/stolot0mt0m/claude-chromium-native-messaging/blob/main/docs/manual-setup.md).
- Wire: extension `chrome.runtime.connectNative()` → stdio host → desktop/CLI over local IPC/Bearer callback. Claude Code docs show the MCP bridge uses `ping/pong`, `tool_request`/`tool_response` over native messaging, with separate **MCP tab group** (distinct from the side panel group) [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b).
- Verification: after `claude --chrome`, `/chrome` shows **Enabled / Installed**; multiple browsers can connect and user picks one [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md).

**Why not `chrome.debugger` alone?** The extension *is* the one that calls `chrome.debugger.attach`. The desktop/CLI is outside the browser process boundary and cannot speak CDP directly — it needs a host inside Chrome to relay. Native Messaging is the Chrome-supported crossing for that boundary [developer.chrome.com/docs/extensions/develop/concepts/native-messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). Alternative private remote-debugging sockets lack a trusted prompt and are discouraged (see §1.4).

**Installation / permission flow:**
1. `chrome web store → Add Claude in Chrome → sign in with Claude account` [support.claude.com/.../get-started-with-claude-in-chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome). Requires direct Anthropic plan + `/login`; API-key/Bedrock sessions keep the bridge off by design [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md).
2. `/chrome` install prompt inside Claude Code: **Install extension / Not now / Don't ask again** [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md).
3. Per-tool, per-domain permissions: **NAVIGATE / READ_PAGE_CONTENT / CLICK / TYPE / UPLOAD_IMAGE / PLAN_APPROVAL / REMOTE_MCP / DOMAIN_TRANSITION** with durations `once` / `always`; blocked categories (`category1/2`) are enforced via `api.anthropic.com/api/web/domain_info/browser_extension?domain=…` [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b). Permission modes: `ask` / `follow_a_plan` / `skip_all` (see guide) [support.claude.com/.../claude-in-chrome-permissions-guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide).
4. CLI flag `claude --chrome` or slash `/chrome` toggles with `Enabled by default` [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md).

**Tool evidence (CDP calls):** Reverse-engineered v1.0.56 source documents every `chrome.debugger.sendCommand` mapping:
- `computer`: `Input.dispatchMouseEvent` (`mousePressed/mouseReleased`), `Input.insertText` char-by-char, `Input.dispatchKeyEvent`, `Page.captureScreenshot` (PNG, downscaled for Retina, `pxPerToken:28`) [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b).
- `read_page` injects `window.__generateAccessibilityTree(...)` via `chrome.scripting.executeScript` with ref IDs `ref_1…` stored in `WeakRef` map [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b).
- `javascript_tool`/`form_input`/`find`/`get_page_text` also via `scripting.executeScript` or `Runtime.evaluate` [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b).
- Tab ops (`tabs_context`, `tabs_create`, `navigate`) via `chrome.tabs.*` (non-CDP) — explains why some tools work when `chrome.debugger` is blocked (GitHub issue triage table: `tabs_*` ✅, `screenshot/javascript_tool` ❌) [github.com/anthropics/claude-code/issues/45221](https://github.com/anthropics/claude-code/issues/45221).

---

### 1.3 Overlay / Cursor injection

**What is shown to the user:**

- Both OpenAI and Anthropic claim **visible, real-time driving** in *your* signed-in window — not a hidden sandbox. Claude Code docs: "Browser actions run in a visible Chrome window in real time. When Claude encounters a login page or CAPTCHA, it pauses and asks you to handle it manually." [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md). wmedia explainer contrast: **"extension = Claude as a user of YOUR browser, your sessions/cookies; MCP = Claude as a developer in a clean lab Chrome"** [wmedia.es/.../claude-code-chrome-extension-vs-devtools-mcp](https://wmedia.es/en/tips/claude-code-chrome-extension-vs-devtools-mcp).

**How the overlay is rendered — two techniques, usually combined:**

*A) Content-script DOM overlay (primary for visible cursor/highlights)*

- Standard pattern: content script injects a container div into the *page* DOM (`position:fixed; inset:0; z-index:2147483646`) with absolutely-positioned boxes/labels, fed by `getBoundingClientRect()` [github.com/go-go-golems/go-go-parc/blob/main/Projects/.../Building%20Chrome%20Extensions%20for%20DOM%20Overlay%20Selection%20and%20Component%20Extraction.md](https://github.com/go-go-golems/go-go-parc/blob/main/Projects/2026/04/25/Building%20Chrome%20Extensions%20for%20DOM%20Overlay%20Selection%20and%20Component%20Extraction.md). Max `z-index` is 2147483647, so overlay sits one below max to avoid swallowing site modals [same].
- **Isolation** to avoid page CSS/JS interference: **Shadow DOM** is the recommended isolation primitive. Content scripts live in an **isolated world** already [developer.chrome.com/docs/extensions/develop/concepts/content-scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) / [developer.chrome.com/docs/extensions/mv3/messaging/...](https://developer.chrome.com/docs/extensions/mv3/messaging/index.md), but styles still leak — so the overlay root is `attachShadow({mode:"closed"})` with a `<style>` scoped inside, often with `:host{all:initial}` [stackoverflow.com/questions/12783217/how-to-really-isolate-stylesheets-in-the-google-chrome-extension](https://stackoverflow.com/questions/12783217/how-to-really-isolate-stylesheets-in-the-google-chrome-extension). Example projects use **dual shadow roots** (one for UI, one for overlays) plus `important`-scoped Tailwind selectors [github.com/iNewLegend/chrome-extension-elements-highlight](https://github.com/iNewLegend/chrome-extension-elements-highlight) and a **closed** shadow root at `z-index:2147483646` with `MutationObserver` to survive SPA DOM wipes — exactly what opencode already ships in `packages/desktop/src/guest/annotation-overlay.ts:291-330` (host+shadow, resilience observer).
- **Cursor image:** historically done as `cursor: url(moz-extension://...), pointer` with `web_accessible_resources` + `* {cursor:none}` + mouse-move image follower fallback [discourse.mozilla.org/t/custom-cursor-with-content-script/106741](https://discourse.mozilla.org/t/custom-cursor-with-content-script/106741). Modern agent cursors use a floating `<div>`/SVG with `pointer-events:none` driven by CDP `Input.dispatchMouseEvent` coordinates + `requestAnimationFrame` batching — not a CSS-cursor swap (avoids flicker and works in isolated world).
- **opencode's existing overlay (reference implementation already in repo):** `annotation-overlay.ts:1-200` — closed shadow DOM, fixed host, `Z_INDEX_OVERLAY=2147483646`, dashed/numbered boxes, `position:fixed`, `getBoundingClientRect()` + offset, `requestAnimationFrame` scheduling, `MutationObserver` re-append — directly reusable for a Chrome-extension overlay (file `packages/desktop/src/guest/annotation-overlay.ts:42-1143`).

*B) CDP Overlay domain (secondary, for DevTools-style highlights)*

- CDP **Overlay** domain provides `Overlay.highlightNode`, `highlightQuad`, `highlightRect`, `hideHighlight`, and inspect-mode commands [pkg.go.dev/github.com/chromedp/cdproto/overlay](https://pkg.go.dev/github.com/chromedp/cdproto/overlay) / [cdpotion.hexdocs.pm/CDPotion.Domain.Overlay.html](https://cdpotion.hexdocs.pm/CDPotion.Domain.Overlay.html) / [chromium.googlesource.com/devtools/devtools-frontend/.../inspector_overlay](https://chromium.googlesource.com/devtools/devtools-frontend/+/312e43a6c50bc29f279f9eac2f91b723b36c7ee9/inspector_overlay) (Skia front-end overlay). Used by `chrome.debugger.sendCommand("Overlay.highlightNode", ...)` — but `Overlay` highlights are **transient, non-interactive**, and are cleared on navigation. Agent products use **content-script boxes** for persistent, interactive highlights and **CDP Overlay only to supplement DevTools inspection** (Anthropic's `computer` tool docs mention CDP `Input`+`Page`, not `Overlay` as the click path) [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b).

**Cleanup on detach:** Anthropic closes the loop with `Detach debugger from all tabs` in the agentic tool loop, and before screenshots/clicks sends `HIDE_FOR_TOOL_USE` → `SHOW_AFTER_TOOL_USE` so the agent's own overlay doesn't pollute the screenshot [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b). opencode's overlay uses `cancelAnnotation` → `restoreBaseline` + `teardownHost` + barriered `ANNOTATION_CAPTURED_CHANNEL` ack before CSS rollback (`packages/desktop/src/guest/annotation-overlay.ts:385-405`).

---

### 1.4 Connection & security model

**Why an extension (vs. raw `--remote-debugging-port`):**

| Mechanism | How it works | Security | Why products chose it (evidence) |
|---|---|---|---|
| `chrome.debugger` via extension (recommended) | Extension declares `debugger`, calls `chrome.debugger.attach({tabId},"1.3")`, relays CDP as an alternate transport [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) | User installs extension + grants `debugger` at install (no silent attach); each attach shows infobar; enterprise policy can block; mutually exclusive with DevTools (detaches on open) [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) / [chromium.googlesource.com/.../debugger.html](https://chromium.googlesource.com/chromium/+/HEAD/chrome/common/extensions/docs/templates/intros/debugger.html) | **Both products**: Claude explicitly ties `debugger` to "control your browser" [support.claude.com/.../get-started-with-claude-in-chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) and OpenAI lists "Access the page debugger" as first permission [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension). Remote-debugging port would require a CLI flag and is now hardened (next row). |
| `--remote-debugging-port=9222` + WS (`ws://127.0.0.1:9222/...`) | Launch Chrome with ` --remote-debugging-port=9222 --user-data-dir=/tmp/...`, any local process fetches `http://127.0.0.1:9222/json/version` then WS [github.com/synapse-ai-hub/openclaw-skills/blob/main/skills/0xcjl/browser-cdp/SKILL.md](https://github.com/synapse-ai-hub/openclaw-skills/blob/main/skills/0xcjl/browser-cdp/SKILL.md) | **No per-tab consent**: any localhost app can drive the browser; Chrome 136 hardened it: switches **ignored** unless `--user-data-dir` points to a non-standard dir (to protect cookies, post App-Bound Encryption abuse) [developer.chrome.com/blog/remote-debugging-port?hl=en](https://developer.chrome.com/blog/remote-debugging-port?hl=en). Feature-requested browser-side prompt (Firefox-style) was `WontFix: "Use chrome.debugger instead. It is more convenient and secure."` [issues.chromium.org/issues/41077112](https://issues.chromium.org/issues/41077112). Additional hard boundary: `Browser for Testing` remains allowed [same]. | Used only for **developer/automation lab** (Claude's `chrome-devtools-mcp` uses its own clean Chrome via CDP WS; `vscode`, `puppeteer`). **NOT** for user's daily profile — that's the extension's job [wmedia.es/.../claude-code-chrome-extension-vs-devtools-mcp](https://wmedia.es/en/tips/claude-code-chrome-extension-vs-devtools-mcp). |
| Extension `chrome.debugger` + native host + WS proxy (hybrid) | Same extension but offers a local WS endpoint `ws://127.0.0.1:9223/extension` so MCP/CLI clients can speak CDP over WS to the *real* browser [github.com/AIPexStudio/AIPex](https://github.com/AIPexStudio/AIPex) | Inherits extension consent model; bridge is local-only | **AIPex** and **open-claude-in-chrome** use this to expose 30+ tools via MCP/CLI while keeping the human's profile [github.com/AIPexStudio/AIPex](https://github.com/AIPexStudio/AIPex) / [github.com/noemica-io/open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome). |

**Dedicated docs to cite for the security decision:**
- Chrome blog: "Switches will no longer be respected if attempting to debug the **default Chrome data directory**. Must now be accompanied by `--user-data-dir`" [developer.chrome.com/blog/remote-debugging-port?hl=en](https://developer.chrome.com/blog/remote-debugging-port?hl=en).
- Debugger API docs: "Attaching to the tab by means of the debugger API and using embedded Chrome DevTools … are **mutually exclusive**. If user invokes Chrome DevTools while extension is attached, debugging session is terminated." [chromium.googlesource.com/.../debugger.html](https://chromium.googlesource.com/chromium/+/HEAD/chrome/common/extensions/docs/templates/intros/debugger.html).
- Infobar: "`\"$1\" started debugging this browser`" per Chrome resource bundle; suppression via `--silent-debugger-extension-api` (shortcut/flag) or enterprise `ExtensionInstallForcelist` (policy); Anthropic issue #69287 closed `not_planned` [github.com/anthropics/claude-code/issues/69287](https://github.com/anthropics/claude-code/issues/69287) + wmedia deep-dive [wmedia.es/en/tips/claude-code-chrome-debug-frontend](https://wmedia.es/en/tips/claude-code-chrome-debug-frontend).

**Consent / lifecycle in products:**
- **Claude:** install → allow `debugger` (warn-triggering permission) → per-action/domain permission manager (`NAVIGATE`/`READ_PAGE_CONTENT`/`CLICK`/`TYPE` with `once`/`always`) plus domain categories (`category1/2` blocked) [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b). Lifecycle: attach on demand per tool loop, detach on done/cancel [same].
- **Codex:** desktop → Chrome plugin enable → extension hello → **visible tab group per task**, user can `Allow/Bypass` — ChatGPT states it *uses its own allowlists/blocklists before using websites* even though Chrome grants all-hosts [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension).

**Multi-tab/window & navigation handling:**
- Both attach by **`tabId`** (not global port): `chrome.debugger.sendCommand({tabId}, method, params)` and `chrome.tabs.update(tabId,{url})` plus `tabs.query/active` for enumeration [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) / [gist…](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b).
- Out-of-process iframes require `Target.setAutoAttach {flatten:true}` + `Target.attachedToTarget` child `sessionId` (docs added for flat sessions Chrome 125+) [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) (Attach to related targets section).
- Chrome tabs are organized into **Tab Groups** per session (Claude Code docs show group lifetime rules for `/clear`/`/resume`) [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md). Navigation waits are `waitForNavigation` + spinner inside the group.

---

### 1.5 Alternatives — CDP vs. WebDriver BiDi vs. `chrome.debugger` vs. native CDP

**Taxonomy:**

- **CDP (Chrome DevTools Protocol):** JSON-RPC over WebSocket, 60+ domains, Chrome-origin, fast, bidirectional, low-level (DOM/CSS/Network/Input/Overlay esp.) [dev.to/dreygur/browser-automation-protocols-cdp-vs-webdriver-deep-dive-5bmn](https://dev.to/dreygur/browser-automation-protocols-cdp-vs-webdriver-deep-dive-5bmn). Every DevTools feature speaks it [chromium.googlesource.com/devtools/devtools-frontend/.../devtools-protocol.md](https://chromium.googlesource.com/devtools/devtools-frontend/+/main/docs/devtools-protocol.md). **Pro:** richest API, low latency (single WS round-trip), supports `Overlay`, `Input`, `Page.captureScreenshot`, `Accessibility`. **Con:** Chromium-only, unstable (version-skew), not a standard.
- **WebDriver Classic (W3C):** HTTP REST request/response, cross-browser but half-duplex, no events. **Pro:** W3C standard, works everywhere. **Con:** slow, cannot stream logs/network without polling; designed for testing.
- **WebDriver BiDi (W3C standard, in-progress):** WS-based bidirectional successor that adds streaming events (log, network, script) with a single round-trip optimization vs. CDP [developer.chrome.com/blog/webdriver-bidi](https://developer.chrome.com/blog/webdriver-bidi) / [www.selenium.dev/documentation/webdriver/bidi](https://www.selenium.dev/documentation/webdriver/bidi). Status: Chrome 106 + Firefox 102 shipped, now production on BrowserStack [developer.chrome.com/blog/webdriver-bidi-support-in-browserstack](https://developer.chrome.com/blog/webdriver-bidi-support-in-browserstack) and Puppeteer 23 [developer.chrome.com/blog/firefox-support-in-puppeteer-with-webdriver-bidi](https://developer.chrome.com/blog/firefox-support-in-puppeteer-with-webdriver-bidi). **Pro:** cross-browser, W3C, low-latency events. **Con (2026):** not yet covering `Accessibility` snapshot-refs, `Overlay` highlights, fine-grained `Emulation` — still incomplete for premium agent UX; Selenium still auto-generates CDP glue for advanced features [www.selenium.dev/documentation/webdriver/bidi](https://www.selenium.dev/documentation/webdriver/bidi).
- **`chrome.debugger` (extension transport):** *alternate CDP transport inside an extension* — same protocol, delivered as `chrome.debugger.sendCommand` without opening a remote-debugging socket [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger). **Pro:** works on the user's *existing* profile (cookies/history), per-tab user consent, survives Chrome 136 default-dir hardening [developer.chrome.com/blog/remote-debugging-port?hl=en](https://developer.chrome.com/blog/remote-debugging-port?hl=en). **Con:** restricted domain allow-list (cannot do some Browser/Target ops), mutual-exclusion with DevTools, shows the infobar, cannot access `chrome://`.
- **Native CDP over WS (`--remote-debugging-port`)**: direct CDP WS to its own profile (Chrome for Testing / `chrome-devtools-mcp` clean lab) [wmedia.es/.../claude-code-chrome-extension-vs-devtools-mcp](https://wmedia.es/en/tips/claude-code-chrome-extension-vs-devtools-mcp) + example proxy [github.com/Dexin-Huang/chrome-cdp-bridge](https://github.com/Dexin-Huang/chrome-cdp-bridge). **Pro:** full unrestricted CDP, trivial to bridge to Puppeteer/Playwright. **Con:** isolated profile (no user state), requires CLI flag, blocked on default dir from 136.

**Verdict for "control my real, signed-in Chrome":** **`chrome.debugger` via extension + Native Messaging** is the only mechanism that satisfies the brief. Raw `--remote-debugging-port` is **deliberately hardened against stealing the default profile** [developer.chrome.com/blog/remote-debugging-port?hl=en](https://developer.chrome.com/blog/remote-debugging-port?hl=en) and the Chrome-team position is "use `chrome.debugger` instead" [issues.chromium.org/issues/41077112](https://issues.chromium.org/issues/41077112). WebDriver BiDi would be ideal for cross-browser *test* automation but cannot yet deliver the `Overlay`/`Accessibility`/`DOMSnapshot` richness the agent snapshot+ref UX needs (opencode's `operations.ts` alone issues `Accessibility.getFullAXTree`, `DOMSnapshot`-derived scans, `Emulation.setDeviceMetricsOverride`, etc.). So for opencode, use **BiDi opportunistically later** for Firefox/Safari, but build the Chrome-first lane on **`chrome.debugger` + extension**.

---

## 2. Phase 2 — Synthesis & Comparison

### Comparison table (as requested)

| Product | Extension Name / ID | Connection Method (CDP / debugger API) | Overlay Technique | User Install / Permission Flow | Cursor / Automation Visibility |
|---|---|---|---|---|---|
| **Codex (ChatGPT)** | **ChatGPT / ChatGPT for Chrome** — `hehggadaopoacecdllhhajmbjkdcmajg` (Chrome Web Store) [chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg); bridged as `com.openai.codexextension` native host [github.com/openai/codex/issues/31904](https://github.com/openai/codex/issues/31904) | **Extension `chrome.debugger` + Native Messaging** — desktop app installs `NativeMessagingHosts/com.openai.codexextension.json`, extension `connectNative("stdio")` → local host binary; host relays to desktop. Debugger perms `debugger` listed as *Access the page debugger* [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension) + generic spec [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger). Full CDP gated by *Developer mode → Enable full CDP access* for the built-in browser lane [learn.chatgpt.com/docs/browser](https://learn.chatgpt.com/docs/browser) | **Content-script shadow overlay + CDP `Input`/**`Overlay`** mix.** Extension injects shadow-DOM host (`z-index 2147483646` pattern) with fixed boxes + click glow; hides it (`HIDE_FOR_TOOL_USE`) before `Page.captureScreenshot` to avoid screenshot pollution [gist same pattern via Claude below]. OpenAI prototypes use Gemini Computer Use visual path with blue click indicators [github.com/composiohq/open-chatgpt-atlas](https://github.com/composiohq/open-chatgpt-atlas) (open alternative). | Desktop: **Plugins → Chrome → Add to Chrome** → approve `debugger`+`activeTab`+`tabs`+`downloads`+`notifications`+`bookmarks`+`nativeMessaging` [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension). Side chat panel (toolbar icon) [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension). Mentions `@Chrome`/`@Browser`; execution in **tab groups** [same]. `Connect Google Chrome → Connected` in settings | **Fully visible** in the user's signed-in tabs; tab groups stay grouped, agent doesn't steal active navigation. Store listing: "ChatGPT will work in the background without ever taking over your active browsing session, so you always stay in control" [chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg). Animation GIF/video path exists [openai.com/blog/introducing-chatgpt-atlas](https://openai.com/blog/introducing-chatgpt-atlas) |
| **Claude (Anthropic) — Claude in Chrome + Claude Code** | **Claude in Chrome** — `fcoeoabgfenejglbffodgkkbkcdhcgfn` (allowed origins also `dihbgbndeb...`, `dngcpimne...`) [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md) / [github.com/stolot0mt0m/claude-chromium-native-messaging/.../manual-setup.md](https://github.com/stolot0mt0m/claude-chromium-native-messaging/blob/main/docs/manual-setup.md) | **Extension `chrome.debugger` + dual Native Messaging hosts** — `com.anthropic.claude_browser_extension` (`/Applications/Claude.app/.../chrome-native-host`) + `com.anthropic.claude_code_browser_extension` (`~/.claude/chrome/chrome-native-host`) [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md). Extension attaches `chrome.debugger.attach(tabId,"1.3")` then `Input.dispatchMouseEvent`/`Input.insertText`/`Page.captureScreenshot` [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b). Fallback tab ops (`tabs_create`/`navigate`) via `chrome.tabs` even when debugger blocked [github.com/anthropics/claude-code/issues/45221](https://github.com/anthropics/claude-code/issues/45221) | **Closed-shadow-DOM content script + CDP cursor moves.** Gist: *click = `mouseMoved` (+100 ms) → `mousePressed`+`mouseReleased`; `scroll` = `mouseWheel`; zoom/crop = `Page.captureScreenshot` region* [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b). Shows `debugger` infobar "`Claude` started debugging this browser" on every tab; suppress only via `--silent-debugger-extension-api` or `ExtensionInstallForcelist` [github.com/anthropics/claude-code/issues/69287](https://github.com/anthropics/claude-code/issues/69287) + [wmedia.es/en/tips/claude-code-chrome-debug-frontend](https://wmedia.es/en/tips/claude-code-chrome-debug-frontend). | Chrome Web Store → `Add to Chrome` → `debugger` grant (explained as "This is what allows Claude to actually control your browser") [support.claude.com/.../get-started-with-claude-in-chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) → direct plan + `/login` only (API-key/Bedrock disabled) [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md) → `claude --chrome` or `/chrome` → permission manager (`ask`/`follow_a_plan`/`skip_all`; per-domain `category1/2` blocklist) [support.claude.com/.../claude-in-chrome-permissions-guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide). `/chrome` reconnects when SW goes idle [same]. | **Fully visible**, real-time, with tab-group isolation, animated loading dots + checkmark; `gif_creator` tool for session recording with overlays (`showClickIndicators/showDragPaths/...`) [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b). Banner is the "agent is controlling this tab" signal. |
| **Alternatives for reference — `chrome-devtools-mcp` (Google)** | `chrome-devtools-mcp` CLI/npm (no extension) [github.com/ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | **Native CDP WS** (`--remote-debugging-port=9222 --user-data-dir=/tmp/...`) [gist.github.com/0xLoqi/4fac026ee39166a22590d99f3d58f944](https://gist.github.com/0xLoqi/4fac026ee39166a22590d99f3d58f944) | Offscreen/screencast-based; accessibility tree via CDP but **no user cookies** | `npx chrome-devtools-mcp@latest --autoConnect` + allow prompt | Lab browser (clean profile) — not the user's daily Chrome |

**What is common vs. product-specific:**

- **Common:** (1) Manifest V3 service worker with `debugger` as the only CDP gateway on the user's profile; (2) **Native Messaging (`stdio`)** as the *desktop↔browser* bridge (both products independently chose it; docs and manifests attest); (3) `chrome.debugger.attach(tabId,"1.3")` → CDP domains `Input`/`Page`/`Runtime`/`Accessibility`/`Network`/`Overlay`; (4) visible-tab execution with **tab groups**; (5) per-domain allow/deny + explicit human-override UX.
- **Product-specific:** OpenAI needs `bookmarks`/`history`/`tabGroups` reflecting Atlas heritage; Claude adds `system.display` (click fidelity) + `webNavigation` (high-risk site intervention). OpenAI gates full CDP behind an explicit toggle [learn.chatgpt.com/docs/browser](https://learn.chatgpt.com/docs/browser); Claude documents the CDP coverage domain-by-domain inline in the reverse-engineered tool list [gist: same]. Chrome's own `chrome-devtools-mcp` skips the extension entirely and uses a throwaway profile — different lane, different privacy boundary [wmedia.es/...](https://wmedia.es/en/tips/claude-code-chrome-extension-vs-devtools-mcp).

---

## 3. Phase 3 — Design Proposal for opencode (actionable, desktop+sidecar only)

> Premise: **do not invent APIs**. Every component cited below is supported by the docs above *or* by files already present in this repo. The proposal reuses opencode's existing desktop browser stack instead of duplicating it.

### 3.1 Current repo state (what already exists)

opencode desktop already ships an **embedded browser** — *not* a Chrome-attach. Its topology is `packages/desktop/src/main/browser/`:

- `BrowserEngine` (facade, `src/main/browser/index.ts:76-433`) owns a `GuestRegistry` (webview `<webview>` lifecycle + `webContentsId` per tab, `src/main/browser/guest.ts:48-348` + `src/main/browser/host.ts:1-501` which starts a loopback HTTP `127.0.0.1:<ephemeral>` host and registers OUT to the sidecar `/api/browser/host/hello` with `callbackUrl/callbackToken` → sidecar POSTs `POST {callbackUrl}/v1/browser/request` with Bearer auth [read above, `src/main/browser/host.ts:16-45`]). 
- `ControlSessionManager` does **`wc.debugger.attach("1.3")` + `sendCommand`** via Electron's `webContents.debugger` (`src/main/browser/control-session.ts:140-212`) — already a CDP session per guest, with domain `Runtime/Accessibility/Network/Log`, focus emulation, and epoch-guarded sender.
- `BrowserOperations` implements the agent-facing ops `snapshot/screenshot/click/type/press/scroll/evaluate/wait_for/recording` etc. using the same premium primitives that a Chrome extension would need (`operations.ts:1-210`).
- **Overlay already exists:** `src/guest/annotation-overlay.ts:1-1143` is a closed-shadow-DOM, fixed, `z-index:2147483646` human annotation overlay (MutationObserver resilience, select/marquee/draw/erase, React fiber `__reactFiber$` sourcing under `contextIsolation:true`) — exactly the content-script isolation pattern §1.3 found to be correct.

Constraint **preserved**: this proposal **adds** a parallel lane `extension→chrome.debugger` beside the existing webview lane; it never removes or replaces the embedded lane, so upstream merge stays clean.

### 3.2 Target architecture (text diagram)

```
┌──────────────────────────────┐
│  opencode Desktop (Electron) │  existing sidecar path
│  main: BrowserEngine         │   host: BrowserHost (port 127.0.0.1:<e>) ──hello→ sidecar (/api/browser/host/hello)
│   ├─GuestRegistry (webview)  │              ▲                                │ BrokerRequest {tabId,op,sessionId}
│   ├─ControlSessionManager    │              │ BrokerResponse (HTTP 200)       ▼
│   │  (wc.debugger CDP)       │         callback POST                 opencode sidecar / broker
│   └─ExtensionBridge (NEW)    │         (Bearer token)              (T0 router already)
└──────────────┬───────────────┘                                ▲
               │ nativeMessaging stdio                           │ HTTP (loopback)
               │ com.opencode.desktop                            │
┌──────────────▼───────────────┐                                │
│  Chrome Extension (MV3)      │──── chrome.debugger.attach({tabId},"1.3") ────┐
│  • background service worker │──── chrome.debugger.sendCommand(tab,CDP) ─────┤
│    (manages attach/detach,   │     domains: Input/Page/Runtime/Accessibility │ Chrome
│     Target.setAutoAttach,    │     Network/Log/Overlay/DOM/Emulation   etc.  │   Tabs
│     onEvent + onDetach)      │                                                │  (user profile)
│  • content script (ISOLATED) │◄── chrome.runtime.onMessage / tabs.sendMessage ┤   + Content Script
│    closed Shadow DOM host    │     (shadow overlay = cursor + boxes)         │     Overlay
│    fixed boxes/cursor/SVG    │                                                │   Page DOM
│  • sidePanel (optional)      │     `chrome.scripting.executeScript` for a11y│
└──────────────────────────────┘     `chrome.tabs.*` for non-CDP tab ops     ─┘

Flow for an agent `click({ref:"e7"})`:
agent tool → sidecar broker → BrowserHost.loopback POST /v1/browser/request →
ExtensionBridge (same window, multiplexed over nativeMessaging) →
background SW: resolve ref→coords (a11y tree or stored snapshot refs, same as operations.ts) →
content-script: drawCursor(move) + hideOverlayForScreenshot → debugger.sendCommand("Input.dispatchMouseEvent",{x,y,type:"mousePressed/Released"}) →
content-script: showOverlayAfter → sidecar BrokerResponse{coords, ResolvedTarget}
```

**Why this is the correct seam for opencode:** The existing `BrowserHost` already multiplexes sidecar→desktop over a loopback `callbackUrl` with Bearer `callbackToken` and can dispatch any `BrowserOperation` to a `tabId` (`src/main/browser/host.ts:192-269`). Adding a second carrier (`ExtensionBridge`) behind the *same* `dispatch` function reuses the whole broker/timeline exactly as-is — no new auth, no new protocol version.

### 3.3 Extension design (Manifest V3)

**Manifest (new dir `extensions/chrome/` — not in `packages/desktop` to keep Electron packaging clean):**

```json
{
  "manifest_version": 3,
  "name": "opencode for Chrome",
  "version": "0.1.0",
  "permissions": ["debugger","activeTab","tabs","scripting","tabGroups","storage","downloads","nativeMessaging","offscreen"],
  "host_permissions": ["http://*/*","https://*/*"],
  "background": { "service_worker": "sw.js" },
  "content_scripts": [{
    "matches": ["http://*/*","https://*/*"],
    "js": ["content.js"],
    "run_at": "document_start",
    "all_frames": false,
    "world": "ISOLATED"
  }],
  "web_accessible_resources": [{
    "resources": ["cursor.png","overlay.css"],
    "matches": ["<all_urls>"]
  }],
  "externally_connectable": {
    "matches": ["http://127.0.0.1/*","http://localhost/*"]
    // optional: allow opencode's renderer (`oc://renderer`) to `runtime.sendMessage` without tabs
  },
  "side_panel": { "default_path": "sidepanel.html" }
}
```

*Rationale:* `debugger` is mandatory for `chrome.debugger` [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger). `activeTab`/`tabs`/`tabGroups` mirror Claude's need to enumerate/manage the agent tab group [support.claude.com/.../get-started-with-claude-in-chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome). `scripting` is required for `chrome.scripting.executeScript` injection of the a11y scanner [gist…](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b). `nativeMessaging` permits `runtime.connectNative` [developer.chrome.com/docs/extensions/develop/concepts/native-messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). `side_panel` is optional — Codex/Claude both keep a side chat for human-in-the-loop [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension).

**Background service worker responsibilities:**

- `chrome.debugger.attach({tabId}, "1.3")` on demand; `sendCommand` for every CDP domain listed as available to `chrome.debugger` [developer.chrome.com/docs/extensions/mv2/reference/debugger](https://developer.chrome.com/docs/extensions/mv2/reference/debugger). Mirror `operations.ts` domain set: `Runtime.enable`, `Accessibility`, `Network`, `Log`, plus `Overlay`/`Emulation` when needed.
- `Target.setAutoAttach({autoAttach:true, flatten:true, filter:[{type:"iframe",exclude:false}]})` + listener on `Target.attachedToTarget` to mint child `sessionId` handles (`{...source, sessionId: params.sessionId}`) [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) — else oop-iframes stay uncontrolled.
- Event fan-out: `chrome.debugger.onEvent` → native host → sidecar `guest.stateChanged` / screencast frames (same contract as `host.ts:190-191`).
- **Detachment exclusivity:** mirror `control-session.ts:142-152` — throw `BrowserDebuggerConflictError` when `webContents.isDevToolsOpened()` or `chrome.debugger` already attached; listen to `chrome.debugger.onDetach` with `reason∈{target_closed,canceled_by_user}` [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) (replace `wc.debugger` listeners).
- **Message bus:** one `runtime.connectNative("com.opencode.desktop")` long-lived Port; requests are `{requestId, tabId, operation, sessionId, timeoutMs}` (same `BrokerRequest` shape `contracts.ts:199-210`). One responder per request — timeout/abort/success all funnel through `flight.respond` (reuse `host.ts:87-91` pattern).

**Messaging between extension and opencode — three options (recommendation: Native Messaging first):**

| Bridge | Spec | Pros for opencode | Cons |
|---|---|---|---|
| **Native Messaging (`stdio`) — RECOMMENDED** | Manifest name `com.opencode.desktop`; JSON file at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.opencode.desktop.json` with `path` to a helper emitted by desktop main, `allowed_origins:["chrome-extension://<ID>/"]` [developer.chrome.com/docs/extensions/develop/concepts/native-messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) + mirror [github.com/GoogleChrome/developer.chrome.com/.../nativeMessaging](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/nativeMessaging/index.md) | Chrome-supported consent boundary; works on the user's *real* profile; consistent with both OpenAI and Anthropic choices (Codex `com.openai.codexextension` [github.com/openai/codex/issues/31904](https://github.com/openai/codex/issues/31904); Claude `com.anthropic.claude_code_browser_extension` [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md)); no remote-port hardening [developer.chrome.com/blog/remote-debugging-port?hl=en](https://developer.chrome.com/blog/remote-debugging-port?hl=en) | Needs helper binary + install step (installer writes the JSON + registry key) [same native-messaging docs]. Service-worker background goes idle — needs `offscreen` doc or alarm keepalive. |
| WebSocket on loopback (`ws://127.0.0.1:<port>/extension`) | Extension service worker opens `new WebSocket(url)` to `BrowserHost` (Chrome 116+ SW WebSocket support) [developer.chrome.com/docs/extensions/how-to/web-platform/websockets](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) | Reuses the *existing* `BrowserHost` callback HTTP server (`host.ts:135-145`) — no new install artifact; easier local dev (`AIPex` uses `ws://localhost:9223/extension`) [github.com/AIPexStudio/AIPex](https://github.com/AIPexStudio/AIPex) | Less explicit user consent than native host; `externally_connectable` allow-list needed for page→ext messages; WebSocket from SW has a shorter lifetime than native Port. |
| `externally_connectable` + `runtime.connect` (web-page bridge) | `"externally_connectable":{"matches":["https://*.example.com/*"]}` [github.com/GoogleChrome/developer.chrome.com/.../messaging](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/messaging/index.md) | Lets opencode's *renderer* talk to the extension without touching the OS (nice for WSL) | Not a desktop→extension transport; the desktop main is still native — adds a second hop. |

**Decision:** Ship **Native Messaging as primary** plus a fallback **WS-over-loopback** that reuses exactly the `BrowserHost` callback HTTP server (port discovery via sidecar hello reply). This matches Brave/Arc support gracefully — the community already polyfills native hosts per-browser dir [github.com/stolot0mt0m/claude-chromium-native-messaging](https://github.com/stolot0mt0m/claude-chromium-native-messaging) — and a WS fallback keeps WSL usable where native hosts are tricky.

### 3.4 Overlay design

**Goal:** render agent cursor, click pulse, element highlight rectangles, and the viewport box without breaking page layout or leaking styles.

**Pattern to copy verbatim:** the file already proven in this repo — `src/guest/annotation-overlay.ts`:

- Create a **closed shadow root** under a fixed `host` (`z-index:2147483646`, `inset:0`, `pointerEvents:none`) [same file:291-310; mirror the doc-recommended `2147483646` to leave room for site modals [github.com/go-go-golems/.../Building Chrome Extensions...](https://github.com/go-go-golems/go-go-parc/blob/main/Projects/2026/04/25/Building%20Chrome%20Extensions%20for%20DOM%20Overlay%20Selection%20and%20Component%20Extraction.md)].
- Inside the shadow, three layers: `.outline-layer` (bordered boxes), `.draw-layer` (SVG cursor/drag paths), `.label-layer` (chips) — exactly the composio-inspired `PX-per-token` downscaling trick for Retina [gist same].
- All coordinates are **`getBoundingClientRect()` viewport-absolute** + `window.scroll{X,Y}` de-duplication; `Overlay.highlightRect({x,y,width,height})` uses the same space [pkg.go.dev/.../overlay](https://pkg.go.dev/github.com/chromedp/cdproto/overlay). Batch geometry via `requestAnimationFrame` [annotation-overlay.ts:831-837].
- **Agent-cursor choreography:** reuse `contracts.ts:65-66` pacing `AGENT_CURSOR_MOVE_MS=160` + `AGENT_CURSOR_CLICK_LEAD_MS=40` plus the existing `BrowserPointerEvent {phase:"move"|"click", x,y, sequence, tabId}` broadcast. Content script interpolates moves over 160 ms, then pulses on click. This mirrors Claude's `mouseMoved(100ms delay)` plus `mousePressed/Released` [gist…](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b) but with deterministic timing.
- **Hide/show for capture:** background SW broadcasts `HIDE_FOR_TOOL_USE` before `Page.captureScreenshot` and `SHOW_AFTER_TOOL_USE` after — same opcode pair Anthropic already uses [gist same]. The shadow host is `display:none` for the duration of the capture; ops already handle `waitForNavigation` gating.
- **Cleanup on detach:** `onDetach` / `onDisconnect` → `teardownHost()` (cancel RAF, `MutationObserver.disconnect()`, `host.remove()`, clear `selected/regions/strokes`) — identical to `annotation-overlay.ts:335-353` + controller `restoreBaseline()` on every path (cancel, captured-ack, pagehide).
- **Style isolation extras:** `isolated world` for `content_scripts.world="ISOLATED"` [developer.chrome.com/docs/extensions/develop/concepts/content-scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts); fallback `all:initial` on `:host` + explicit `importantSelectors` when injecting utility CSS, echoing the known Shadow DOM gotcha (Reddit inheriting styles despite shadow) [stackoverflow.com/questions/53320205/shadow-dom-styles-encapsulation](https://stackoverflow.com/questions/53320205/shadow-dom-styles-encapsulation).

### 3.5 Session lifecycle

```
[Install] Chrome Web Store "opencode for Chrome" → grant debugger+tabs+scripting [→ native host JSON written by desktop installer]
   ↓
[Pair] Desktop Settings → Browser → "Pair with Chrome" writes
  macOS: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.opencode.desktop.json
  Linux: ~/.config/google-chrome/NativeMessagingHosts/com.opencode.desktop.json
  Win:  HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencode.desktop  [developer.chrome.com/.../native-messaging]
   ↓
[Grant per-tab] Agent first tool (open/navigate/click) → permission manager
  shows chrome-style permission prompt (ask / always allow / deny; per-tab remember)
  modelled on Claude's PermissionManager (NAVIGATE/READ/CLICK/TYPE + DomainTransition + category blocklist) [gist + permission guide].
   ↓
[Attach] background SW chrome.debugger.attach({tabId}, "1.3") → sendCommand needs fail with typed errors:
     - BrowserDebuggerConflictError if DevTools open (show toast + detachForDevTools)
     - BrowserNotAttachedError if tab closed
     - Enterprise policy block → "Host access is restricted by policy" [developer.chrome.com/.../debugger]
   Overlay (shadow host) is mounted on this tab's content script.
   ↓
[Use] Every agent op reuses the same Contract ops (snapshot/click/etc.) via
   ExtensionBridge.dispatch — the sidecar broker is unaware whether the backing
   is webview or chrome extension (same BrokerRequest shape).
   ↓
[Detach / hide] navigation/unload/pagehide → restoreBaselines + teardownHost (MutationObserver re-append guard from overlay.ts:322-330).
   Manual: user revokes in chrome://extensions or closes the tab → onDetach fires → overlay cleaned, control epoch bumped, in-flight op fails with BrowserControlInterruptedError.
```

*Open new tabs:* `browser.tabs.create({tabId:group})` + optional `chrome.tabs.group()` to mimic Claude/Codex tab groups per session [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md) (existing `BrowserEngine` already does this for webview; reuse `GuestRegistry.activate` logic).

### 3.6 Security & UX considerations

**Explicit consent per-tab:** The Chrome `debugger` permission surfaces a warning at install; additionally every attach attempt must pass the permission manager (ask/always/deny). Hard-gate dangerous domains (e.g., `chrome://`, `chrome-extension://`, `about:blank`) — only `navigate` there (mirror `gist` tool-availability table). `category1/2` blocklist via `api.anthropic.com`-style domain classification is defensible; simplest V1 is a local denylist + `user-owned` check.

**Visible "agent is controlling this tab" indicator:** Chrome already shows the *global* infobar "`{ExtensionName}` started debugging this browser" on *every* tab when any tab is attached [github.com/anthropics/claude-code/issues/69287](https://github.com/anthropics/claude-code/issues/69287) + [wmedia.es/.../claude-code-chrome-debug-frontend](https://wmedia.es/en/tips/claude-code-chrome-debug-frontend). That's the platform signal. Don't suppress it by default (security regression). Offer the two documented suppression paths as power-user opt-ins: `--silent-debugger-extension-api` (shortcut flag) / policy-forcelist (and document that #69287 was closed `not_planned` so it's on the user).

**Human-in-the-loop safety:** Copy opencode's existing arbiter `humanInput` preemption (`contracts.ts:68-69 HUMAN_PREEMPT_WINDOW_MS=750`, `EXPECTED_INPUT_TTL_MS=1000`) and `setControllerFor` logic — when the user scrolls/clicks/types, the registered cursor/drag path is interrupted, control epoch is bumped, and the agent's in-flight input is treated as stale (already in `GuestRegistry.wireGuest:humanInput` → arbiter). The same pause-for-CAPTCHA UX the Claude docs promise — "pauses and asks you to handle it manually" [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md).

**Navigation / reload / revocation:**
- Navigate/reload detaches the overlay then remounts via content-script `document_start` on the new document.
- DevTools open → `onDetach(canceled_by_user)` → overlay hidden, ops emit `BrowserDebuggerConflictError`; re-attach after `devtools-closed` (same as current webview `openDevtools` handoff `operations.ts:418-457`).
- Revocation: `chrome.management` or uninstall → `onDisconnect` port closes → `BrowserHostUnavailableError` → agent retries via loopback WS or prompts user to re-pair.

**Sensitive-data boundary:** Do not duplicate `BrowserAnnotationPayload.screenshot: null` invariant — main owns pixels. The Chrome overlay must never inject screenshot bytes; it always reports `cropRect` and the desktop does `Page.captureScreenshot` after `HIDE` (copy `contracts.ts:430-433` barrier).

### 3.7 What to reuse vs. build (and license implications)

**Reuse from this repo (no build):**
- `contracts.ts` — wire shapes, error tags, `BROWSER_PROTOCOL_VERSION`, `HostOwner`/`HostCapabilities`, pacing constants, rect helpers. Keep field names byte-identical to `packages/protocol/src/groups/browser.ts` per the file header (`contracts.ts:1-14`).
- `host.ts` / `guest.ts` / `control-session.ts` / `operations.ts` — the broker host, control-epoch guard, and the **entire premium op surface** (refs, selector ladder, a11y tree, state, React fiber). The Chrome lane just replaces `WebContents.debugger` with `chrome.debugger.sendCommand` and `chrome.scripting.executeScript` — every op after that is identical.
- `annotation-overlay.ts` — shadow-host + mutation-resilience + style isolation as the content-script template.
- `packages/desktop` IPC surface (`window.api.browser`) — extend, don't fork.

**Build:**
- `extensions/chrome/{manifest.json, sw.js, content.js, sidepanel.html}` — new directory (Electron never bundles it; it's side-loaded or Web-Store hosted). License: **MIT** to match the repo's `package.json:license=MIT`.
- `extensions/chrome/native-host/` helper: a tiny Node binary that `stdio` ↔ desktop main via `child_process.fork` or `runtime.connectNative` → IPC to `BrowserEngine`. Reuses `host.ts:94-192` post/parse flow verbatim but over stdio rather than HTTP. (Open alternative to stare at: `open-claude-in-chrome` (clean-room MIT) [github.com/noemica-io/open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome) — TCP-nativeHost hybrid architecture is instructive. Don't copy Anthropic/OpenAI extension code — proprietary.)
- Minimal `externally_connectable` + `offscreen` docs relay fix (service-worker idle during long sessions → reconnect on `/chrome` is the Claude workaround; document it upfront) [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md) (Reconnect section).

**Electron constraints (non-negotiable):**
- Do not weaken `contextIsolation:true` for the guest — opencode's annotation overlay explicitly avoids it by reading `__reactFiber$` off DOM expando props in the isolated world (`annotation-overlay.ts:206-273` commentary). Keep that stance for the Chrome extension too.
- No `--remote-debugging-port` on the *desktop* Electron webContents — the desktop is only a controller, not a target.
- Keep the `BROWSER_PARTITION = "persist:opencode-browser-v1"` partition isolated; the Chrome lane touches no partition (it's the user's existing Chrome profile).

**Upstream-mergeable:** All new files live under `extensions/` and `packages/desktop/src/main/browser/extension*` — no core import, no protocol version bump (unless adding new error tags). Desktop without the Chrome extension behaves exactly like today.

---

## 4. Milestones (incremental, each shippable)

### M0 — Spike + contract freeze (3 d)
- Lock `contracts.ts` additions (if any) for the extension lane (no new tags yet, just reuse).
- Hello-world extension: `chrome.debugger.attach(tabId,"1.3")` → `Page.navigate` → `Input.dispatchMouseEvent` click on a local test page, proof of the infobar and of `--silent-debugger-extension-api`.
- **Exit:** demo GIF, written consent copy, rough infobar UX decision (keep vs. suppress).

### M1 — Extension MVP + Native Messaging Pairing (1 wk)
- Manifest V3 + SW + `com.opencode.desktop` native-host helper (writes JSON + registry key on desktop first-run / settings toggle).
- Pair screen: desktop shows `chrome-extension://<ID>` + host path; extension sidePanel reports *Connected / Not connected* and a "Reconnect" button (mirror `/chrome` UX).
- **Exit:** `npx opencode chrome --pair` round-trip succeeds; extension can `chrome.tabs.create`/`navigate` in the user's profile without CDP yet. Sources: native-messaging install paths per platform [developer.chrome.com/.../native-messaging].

### M2 — CDP attach + broker multiplex (1–1.5 wk)
- `ExtensionBridge` beside `BrowserHost`: `BrowserEngine` picks `ExtensionBridge` for any `tabId` whose owner is `chrome`; otherwise keeps webview path.
- Reuse `control-session.ts` epoch-guard + `Target.setAutoAttach flatten:true` path and the full `operations.ts` op matrix except `recording` (defer) + `profiler` (defer).
- Wire errors `BrowserDebuggerConflictError` / `BrowserHostUnavailable` / `BrowserTabNotFound` through the existing broker envelope (`contracts.ts:95-118`) so agents already understand them.
- **Exit:** agent tools `snapshot`, `click`, `type`, `press`, `scroll`, `evaluate`, `wait_for` *and* `screenshot` succeed against a `https://example.com` tab in Chrome of the *same* profile (cookies present).

### M3 — Overlay + screenshot hygiene (1 wk)
- Port `annotation-overlay.ts` (closed shadow, fixed host, `z-index:2147483646`, mutation guard) to `extensions/chrome/content.js`.
- Cursor choreography (`AGENT_CURSOR_MOVE_MS`/`CLICK_LEAD_MS`), highlight boxes (`Overlay.highlightRect` fallback + DOM boxes), and `HIDE/SHOW` barrier around `Page.captureScreenshot`.
- Handle navigation/unload/revoke cleanup with `restoreBaselines` ack pattern (`ANNOTATION_CAPTURED_CHANNEL` equivalent).
- **Exit:** user sees the glowing cursor + click indicator + numbered selection boxes; screenshots are never polluted by the overlay; closing DevTools doesn't leave zombie overlay nodes.

### M4 — Agent tool integration + tab-group UX (1 wk)
- Expose the Chrome lane as the same broker operations (no new SDK method); add `claim` (first-come-wins) vs `open({claim:true})` semantics already in `contracts.ts:1199-1209`.
- Tab-group management per session (reuse Claude's "loading dots → checkmark" pattern) + `duplicate`/`closeRange` for the extension's `chrome.tabs` (no webview here).
- Settings: per-site allowlist/blocklist (start with local deny-list + enterprise `ExtensionSettings` awareness [debugger docs]).
- Docs + fallback WS bridge for WSL/Chromium variants without native host dirs (Brave/Arc polyfill [github.com/stolot0mt0m/claude-chromium-native-messaging]).
- **Exit:** a user can type "open docs.google.com and fill my sheet" in an opencode session and watch opencode drive Chrome while staying in the editor; `Ctrl+.` / Cmd+Shift+. side-panel works; `/chrome` equivalent (`opencode chrome status`) prints Connected/Installed + tab list.

> Post-M4 stretch: recording via `Page.startScreencast` (chrome.debugger does expose screencast) → `recording_start/stop` reuse `host.ts` buffered-flights fanout; WebDriver BiDi lane for Firefox/Edge once `Accessibility` BiDi coverage matures [developer.chrome.com/blog/webdriver-bidi].

---

## 5. Risks & open questions (with mitigation)

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Infobar fatigue** — `started debugging this browser` covers *every* tab during any attach [github.com/anthropics/claude-code/issues/69287](https://github.com/anthropics/claude-code/issues/69287) | User thinks opencode broke Chrome | Don't suppress by default; provide a **"Hide debugging banner (requires Chrome restart)"** toggle that adds `--silent-debugger-extension-api` to the user's shortcut (documented in wmedia [same] + Chrome issue). Treat policy-installed suppress via `ExtensionInstallForcelist` as enterprise path. |
| **Mutual exclusivity with DevTools** — attach fails when DevTools is open [chromium docs](https://chromium.googlesource.com/chromium/+/HEAD/chrome/common/extensions/docs/templates/intros/debugger.html) | User debugging while agent runs | Copy opencode's existing `openDevtools` handoff: `detachForDevTools` before open, `reattach` on `devtools-closed` (`operations.ts:418-457`, `control-session.ts:187-212`). Show a toast + `BrowserDebuggerConflictError`. |
| **SW idle / port disconnect on long sessions** — native port closes after idle | Browser tools go silent mid-session | Mirror Claude's reconnect UX: `opencode chrome reconnect` command + auto-reconnect on next agent op; add `offscreen` document (keeps audio/Bearer alive) [support docs: `offscreen` permission listed explicitly]. |
| **Restricted CDP domains from `chrome.debugger`** — `Browser`, `Target` subsets unavailable | `emulation`, screencast, or `Target.getTargets` might fail | Docs enumerate available domains [developer.chrome.com/.../debugger]; `Browser` is not on the list — guard `Target.*` calls with `try/catch` + `BrowserDebuggerConflictError` fallback (issues triage table: debugger-dependent tools can fail while tab ops survive [github.com/anthropics/claude-code/issues/45221](https://github.com/anthropics/claude-code/issues/45221)). |
| **Enterprise policy blocks** — `ExtensionSettings.runtime_blocked_hosts` / `DisableScreenshots` rejects `attach()` with policy errors [debugger docs] | `chrome.debugger.attach` silently fails | Propagate the precise error string to the user (don't mask as generic timeout) and offer WS-fallback guidance (lab Chrome for Testing). |
| **`http(s)`-only guest navigation** — extension content script cannot run on `chrome://` | Agent hits `chrome://extensions` or `file://` | Enforce `chrome://` → `navigate` only (clone gist's `normal vs chrome://` policy split) [gist same] + `isBrowserGuestUrl` block on `will-navigate` (`guest.ts:341-346`). |
| **Native-host install friction on Linux/WSL** | Needs distinct JSON per Browser dir (`google-chrome` vs `BraveSoftware/...`) | Follow the community polyfill: installer writes to *every* known dir plus `chromium` [github.com/stolot0mt0m/.../manual-setup.md](https://github.com/stolot0mt0m/claude-chromium-native-messaging/blob/main/docs/manual-setup.md). Add WS-fallback for WSL. |
| **License** — OpenAI/Anthropic extension sources proprietary | Cannot lift their code | Use open MIT alternatives as reference only: `open-claude-in-chrome` (clean-room MIT) [github.com/noemica-io/open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome) and `AIPex` (MIT, WS loopback model) [github.com/AIPexStudio/AIPex](https://github.com/AIPexStudio/AIPex). |

**Open questions to resolve in M0:**
1. Extension Distribution: Web Store listing vs. unpacked `Load unpacked` for early adopters (store needs allowlist + `debugger` justification review).
2. Do we keep `debugger` as an **optional** permission that requests on first attach (reduces install-time warning) vs. required install-time? Chrome notes `debugger` triggers a warning [developer.chrome.com/.../debugger] — Claude ships it as required; we can keep it required to avoid runtime permission round-trip.
3. For `screenshot` with `captureBeyondViewport:true`: `chrome.debugger` variant may not support viewport-sized screencasts identically to `webContents.debugger` — verify in M2, fall back to DOM `canvas.drawWindow` via `scripting` if needed (Unconfirmed, test required).

---

## 6. Sources — grouped, every claim has at least one

**Core Chrome APIs**
- `chrome.debugger` overview, `attach`/`detach`/`sendCommand`, enterprise blocks, `Debuggee` type, `sessionId` flat-session pattern [developer.chrome.com/docs/extensions/reference/api/debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) + [developer.chrome.com/docs/extensions/mv2/reference/debugger](https://developer.chrome.com/docs/extensions/mv2/reference/debugger) + [chromium.googlesource.com/.../debugger.html](https://chromium.googlesource.com/chromium/+/HEAD/chrome/common/extensions/docs/templates/intros/debugger.html) + C header [chromium.googlesource.com/chromium/chromium/+/HEAD/chrome/browser/extensions/api/debugger/debugger_api.h](https://chromium.googlesource.com/chromium/chromium/+/HEAD/chrome/browser/extensions/api/debugger/debugger_api.h)
- Native Messaging (manifest, `allowed_origins`, stdio, per-platform locations) [developer.chrome.com/docs/extensions/develop/concepts/native-messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) + mirror source [github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/nativeMessaging/index.md](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/nativeMessaging/index.md)
- Messaging / `externally_connectable` [github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/messaging/index.md](https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/messaging/index.md)
- Content scripts / isolated world [developer.chrome.com/docs/extensions/develop/concepts/content-scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- ServiceWorker WebSockets (Chrome 116+) [developer.chrome.com/docs/extensions/how-to/web-platform/websockets](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- `--remote-debugging-port` hardening (136+) [developer.chrome.com/blog/remote-debugging-port?hl=en](https://developer.chrome.com/blog/remote-debugging-port?hl=en)
- WontFix "prompt for remote debug" — use `chrome.debugger` [issues.chromium.org/issues/41077112](https://issues.chromium.org/issues/41077112)
- Debugging example [github.com/GoogleChrome/chrome-extensions-samples/blob/main/api-samples/debugger/README.md](https://github.com/GoogleChrome/chrome-extensions-samples/blob/main/api-samples/debugger/README.md)

**Product docs (Codex / ChatGPT)**
- Codex/Chrome integration (permissions, tab groups, side chat) [developers.openai.com/codex/app/chrome-extension](https://developers.openai.com/codex/app/chrome-extension)
- Learn ChatGPT Chrome/Browser docs (full CDP toggle, memories, tab handling) [learn.chatgpt.com/docs/chrome-extension.md](https://learn.chatgpt.com/docs/chrome-extension.md) / [learn.chatgpt.com/docs/browser](https://learn.chatgpt.com/docs/browser)
- ChatGPT Atlas launch + deprecation into Codex/ChatGPT [openai.com/blog/introducing-chatgpt-atlas](https://openai.com/blog/introducing-chatgpt-atlas) / [help.openai.com/.../evolving-atlas...](https://help.openai.com/en/articles/20001371-evolving-atlas-into-chatgpt-for-browser-based-agentic-work)
- Chrome Web Store listings [chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg)
- Native host stale-symlink issue (binary path) [github.com/openai/codex/issues/31904](https://github.com/openai/codex/issues/31904)

**Product docs (Claude)**
- Claude in Chrome install + permissions (`debugger` description) [support.claude.com/.../get-started-with-claude-in-chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome?1e959936_page=2&2f226f2c_page=2&38c1d113_page=3&f80ce999_sort_Plus%20ancien=asc&f80ce999_sort_date=desc) + [support.claude.com/.../getting-started-with-claude-for-chrome](https://support.claude.com/en/articles/12012173-getting-started-with-claude-for-chrome)
- Permissions guide [support.claude.com/.../claude-in-chrome-permissions-guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)
- GA blog [claude.com/blog/claude-in-chrome-generally-available](https://claude.com/blog/claude-in-chrome-generally-available)
- Claude Code + Chrome (`claude --chrome`, `/chrome`, native host paths, WSL caveat) [code.claude.com/docs/en/chrome.md](https://code.claude.com/docs/en/chrome.md)
- Extension internals v1.0.56 (21 tools, CDP mapping, permission manager, `HIDE_FOR_TOOL_USE`, a11y tree) [gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b)
- Infobar issue 69287 [github.com/anthropics/claude-code/issues/69287](https://github.com/anthropics/claude-code/issues/69287) + wmedia debug explainer [wmedia.es/en/tips/claude-code-chrome-debug-frontend](https://wmedia.es/en/tips/claude-code-chrome-debug-frontend) + vs `chrome-devtools-mcp` comparison [wmedia.es/en/tips/claude-code-chrome-extension-vs-devtools-mcp](https://wmedia.es/en/tips/claude-code-chrome-extension-vs-devtools-mcp)
- Debugger-blocking triage (tabs ≠ CDP) [github.com/anthropics/claude-code/issues/45221](https://github.com/anthropics/claude-code/issues/45221)
- NativeMessaging manual setup + Brave/others polyfill [github.com/stolot0mt0m/claude-chromium-native-messaging/.../manual-setup.md](https://github.com/stolot0mt0m/claude-chromium-native-messaging/blob/main/docs/manual-setup.md)

**Overlay / rendering**
- Overlay dom pattern (`position:fixed`, `z-index:2147483646`, viewport coords) [github.com/go-go-golems/go-go-parc/.../Building Chrome Extensions...](https://github.com/go-go-golems/go-go-parc/blob/main/Projects/2026/04/25/Building%20Chrome%20Extensions%20for%20DOM%20Overlay%20Selection%20and%20Component%20Extraction.md)
- Shadow DOM isolation / leaking despite shadow [stackoverflow.com/questions/12783217/how-to-really-isolate-stylesheets-in-the-google-chrome-extension](https://stackoverflow.com/questions/12783217/how-to-really-isolate-stylesheets-in-the-google-chrome-extension) / [stackoverflow.com/questions/53320205/shadow-dom-styles-encapsulation](https://stackoverflow.com/questions/53320205/shadow-dom-styles-encapsulation) / example [github.com/iNewLegend/chrome-extension-elements-highlight](https://github.com/iNewLegend/chrome-extension-elements-highlight)
- Cursor image via content script / moz-extension URL [discourse.mozilla.org/t/custom-cursor-with-content-script/106741](https://discourse.mozilla.org/t/custom-cursor-with-content-script/106741)
- CDP Overlay domain commands [pkg.go.dev/github.com/chromedp/cdproto/overlay](https://pkg.go.dev/github.com/chromedp/cdproto/overlay) / [cdpotion.hexdocs.pm/CDPotion.Domain.Overlay.html](https://cdpotion.hexdocs.pm/CDPotion.Domain.Overlay.html) / inspector_overlay front-end [chromium.googlesource.com/devtools/devtools-frontend/.../inspector_overlay](https://chromium.googlesource.com/devtools/devtools-frontend/+/312e43a6c50bc29f279f9eac2f91b723b36c7ee9/inspector_overlay)

**Alternatives**
- CDP vs WebDriver vs BiDi overview [dev.to/dreygur/browser-automation-protocols-cdp-vs-webdriver-deep-dive-5bmn](https://dev.to/dreygur/browser-automation-protocols-cdp-vs-webdriver-deep-dive-5bmn) / WebDriver BiDi future [developer.chrome.com/blog/webdriver-bidi](https://developer.chrome.com/blog/webdriver-bidi) / Selenium BiDi docs [www.selenium.dev/documentation/webdriver/bidi](https://www.selenium.dev/documentation/webdriver/bidi) / BiDi on BrowserStack [developer.chrome.com/blog/webdriver-bidi-support-in-browserstack](https://developer.chrome.com/blog/webdriver-bidi-support-in-browserstack) / Firefox deprecating CDP [developer.chrome.com/blog/firefox-support-in-puppeteer-with-webdriver-bidi](https://developer.chrome.com/blog/firefox-support-in-puppeteer-with-webdriver-bidi)
- Remote debug CDP skill example [github.com/synapse-ai-hub/openclaw-skills/blob/main/skills/0xcjl/browser-cdp/SKILL.md](https://github.com/synapse-ai-hub/openclaw-skills/blob/main/skills/0xcjl/browser-cdp/SKILL.md)
- Bridges `chrome-cdp-bridge` / `ModCDP` / `AIPex` WS loopback pattern [github.com/Dexin-Huang/chrome-cdp-bridge](https://github.com/Dexin-Huang/chrome-cdp-bridge) / [github.com/browserbase/ModCDP](https://github.com/browserbase/ModCDP) / [github.com/AIPexStudio/AIPex](https://github.com/AIPexStudio/AIPex)
- `open-claude-in-chrome` clean-room MIT [github.com/noemica-io/open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome)
- `chrome-devtools-mcp` lab browser [github.com/ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) / connect guide [gist.github.com/0xLoqi/4fac026ee39166a22590d99f3d58f944](https://gist.github.com/0xLoqi/4fac026ee39166a22590d99f3d58f944)

**opencode repo (verification against current state)**
- `packages/desktop/src/main/browser/index.ts:76-433` (BrowserEngine + host guest event debounce)
- `packages/desktop/src/main/browser/host.ts:1-501` (loopback host server + hello/postSidecar + authorizeRequest)
- `packages/desktop/src/main/browser/guest.ts:48-348` (GuestRegistry, webview validation, partition)
- `packages/desktop/src/main/browser/control-session.ts:140-212` (`attach("1.3")`, domain enables, appearance)
- `packages/desktop/src/main/browser/operations.ts:1-210` (dispatch matrix + cursor pacing)
- `packages/desktop/src/main/browser/contracts.ts:1-1210` (HostOwner, BrokerRequest, constants)
- `packages/desktop/src/guest/annotation-overlay.ts:1-1143` (closed shadow overlay template)

---

## 7. Acceptance criteria check

- **Step-by-step attach + why extension required vs raw CDP port:** §1.1→1.4 explain `chrome.debugger.attach({tabId})` via extension as the only *consentful* path to the default profile; raw `--remote-debugging-port` is now gated on `--user-data-dir` (Chrome 136 security hardening) and is explicitly WontFix in favor of `chrome.debugger` — see the Chromium position and Chrome blog citations in §1.4. ✓
- **Overlay/cursor with API/manifest evidence + linked sources:** §1.3 gives both the `content-script → shadow-DOM` path (manifest `content_scripts.world=ISOLATED`, `z-index:2147483646`, `MutationObserver` resilience) and the `Overlay` CDP domain path, with verbatim method names `Input.dispatchMouseEvent`/`Overlay.highlightNode` and source URLs. ✓
- **Proposal actionable, desktop/sidecar-scoped, no unsupported Electron/Chrome APIs:** §3.2-3.6 reuse only APIs documented above or already shipped (`webContents.debugger`, `chrome.debugger`, `nativeMessaging`, WS in SW), keep webview lane intact, and scope everything to `extensions/` + `packages/desktop/src/main/browser/extension*`. ✓
