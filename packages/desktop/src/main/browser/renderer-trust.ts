// Positive renderer-IPC trust boundary for the browser engine.
//
// The browser engine is driven exclusively by the app's OWN renderer windows.
// A guest <webview> (or any other webContents) must never reach these
// handlers. The previous check — `BrowserWindow.fromWebContents(sender) !==
// null` — is coarse and its behavior for <webview> guests varies by Electron
// version. We instead keep an EXPLICIT allowlist of registered app-renderer
// webContents ids and additionally require the sender to be in the renderer's
// MAIN frame, mirroring the stricter pattern already used by the
// set-native-translations handler in ipc.ts.
//
// Note: the guest reaches the host over its OWN direct preload channels
// (HUMAN_INPUT_CHANNEL, the annotation channels) via ipcRenderer.send — those
// are scoped per-guest-webContents and are intentionally NOT gated here. The
// handler in this file only guards the engine's renderer-facing window.api
// surface (the "browser-*" invoke handlers).
import type { IpcMainInvokeEvent } from "electron"

export class RendererTrust {
  private readonly ids = new Set<number>()

  /** Register an app-renderer webContents as authorized to drive the engine. */
  register(wc: { id: number }): void {
    this.ids.add(wc.id)
  }

  /** Drop a destroyed/closed renderer window from the allowlist. */
  unregister(webContentsId: number): void {
    this.ids.delete(webContentsId)
  }

  /** Is `event.sender` an authorized app-renderer webContents in its MAIN
   * frame? Guests and sub-frames fail on both conditions. */
  isTrusted(event: IpcMainInvokeEvent): boolean {
    if (!this.ids.has(event.sender.id)) return false
    if (event.senderFrame !== event.sender.mainFrame) return false
    return true
  }
}
