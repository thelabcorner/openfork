# com.opencode.desktop — Native Messaging Host

Chrome launches this process when the `opencode for Chrome` extension calls `chrome.runtime.connectNative("com.opencode.desktop")`.

## Framing

Each message is ` [4-byte LE length][UTF-8 JSON] ` — see `native-host.ts` + `src/shared/framing.ts`.

- `host -> ext` limit: **1 MiB** (`kMaximumNativeMessageSize`)
- `ext -> host` limit: **64 MiB**
- Large payloads (screenshots) must use the HTTP broker path (`BrowserHost` callback), never native messaging.

Chrome passes the caller origin (`chrome-extension://<id>/`) as `argv[2]`; `allowed_origins` in the manifest must exactly match `chrome-extension://<id>/`.

## Manifest locations (user-level)

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.opencode.desktop.json` |
| Linux (Chrome) | `~/.config/google-chrome/NativeMessagingHosts/com.opencode.desktop.json` |
| Linux (system) | `/etc/opt/chrome/native-messaging-hosts/com.opencode.desktop.json` |
| Windows | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencode.desktop` → path to JSON file |
| Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/` (macOS) / `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` (Linux) |
| Edge | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/` etc. |

Each browser dir needs a **copy** of the same JSON — the community polyfill does this; `install.ts` writes all three by default.

References:
- https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- https://github.com/GoogleChrome/developer.chrome.com/blob/main/site/en/docs/extensions/mv3/nativeMessaging/index.md
- Mirrors: Codex `com.openai.codexextension` at `~/.codex/plugins/cache/openai-bundled/chrome/...`, Claude `com.anthropic.claude_code_browser_extension` at `~/.claude/chrome/chrome-native-host` (research.md §1.1/1.2)

## Install

```sh
# After building the extension and noting its ID (chrome://extensions in developer mode)
bun extensions/chrome/host/install.ts --extension-id <id> --host-path /absolute/path/to/native-host.js

# Dry run (prints paths without writing)
bun extensions/chrome/host/install.ts --extension-id <id> --dry-run

# Windows adds registry instruction — run as:
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencode.desktop" /ve /t REG_SZ /d "C:\path\to\com.opencode.desktop.json" /f
```

The desktop app's `ExtensionBridge` also writes `browser-host.json` with `callbackUrl` + `callbackToken` that `native-host.ts` reads to forward to `BrowserHost`.

## How the host bridges

```
Chrome extension  --(native messaging stdio: {type:"request",request:BrokerRequest})-->  native-host.ts
native-host.ts    --(HTTP POST {callbackUrl}/v1/browser/request, Bearer token)-->       desktop BrowserHost
desktop           --(BrokerResponse)--> native-host.ts --(native {type:"response"})--> extension
```

## WS fallback (WSL)

Primary is native messaging. For WSL where native host dirs are awkward, the extension also supports `ws://127.0.0.1:<ephemeral>/extension` — see `docs/browser-chrome-fallback.md` and `src/background/sw.ts` `WsFallback` stub. That path reuses the same `BrowserHost` loopback HTTP server, with `ws://` upgrade.

## Security notes (Chrome 136+)

- No `--remote-debugging-port` on the default profile — Chrome 136 ignores it unless `--user-data-dir` points to a non-standard dir (https://developer.chrome.com/blog/remote-debugging-port). We use `chrome.debugger` via extension instead.
- Each `chrome.debugger.attach({tabId}, "1.3")` shows infobar "`<ext name>` started debugging this browser" — browser chrome, not page DOM, cannot be covered by content script overlay.
- `chrome.debugger` and DevTools are mutually exclusive; `onDetach` with `reason: canceled_by_user` when DevTools opens.
