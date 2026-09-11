// extension-operations.ts — operation adaptation for chrome.debugger vs webContents.debugger
//
// Maps packages/desktop/src/main/browser/operations.ts (Electron webContents.debugger)
// to the extension lane (chrome.debugger + chrome.scripting). Kept as a thin adapter
// so desktop-bridge can route via ExtensionHost without duplicating BrowserOperations
// logic.
//
// Design rule: no new wire shapes — the adapter translates at the CDP command
// boundary and at the scripting fallback boundary. BrokerRequest/BrokerResponse
// and ResolvedTarget echoes stay byte-identical.

import type { BrowserOperation, BrokerRequest } from "../contracts"

// ---------------------------------------------------------------------------
// CDP transport differences (the core of the port)
// ---------------------------------------------------------------------------
//
// | Concern               | webContents.debugger (Electron)              | chrome.debugger (extension lane)          |
// |-----------------------|----------------------------------------------|-------------------------------------------|
// | Attach                | `wc.debugger.attach("1.3")` on WebContents   | `chrome.debugger.attach({tabId}, "1.3")`   |
// |                       | fails with `Error: debugger already attached`| `chrome.runtime.lastError.message` match  |
// |                       |                                              |   /another debugger/i or /already attached/i |
// | Detach reason         | `webContents` destroyed -> `detach` promise  | `chrome.debugger.onDetach` {reason:       |
// |                       |                                              |    "target_closed"|"canceled_by_user"|…} |
// | SendCommand           | `wc.debugger.sendCommand(method, params)`    | `chrome.debugger.sendCommand({tabId},     |
// |                       | Promise resolves with result                 |    method, params, cb)` + lastError check |
// | AutoAttach flatten    | manual via `Target.setAutoAttach`            | same CDP but routed via tabId+flatten:true|
// | Target multiplex      | sessionId on ControlSessionManager           | attached.childSessions Map + flat routing |
// | Screenshot            | `wc.capturePage(rect)` (NativeImage)         | `Page.captureScreenshot({captureBeyondViewport})` |
// |                       | + `Page.startScreencast` for recording       | + fallback `chrome.tabs.captureVisibleTab`  |
// | Input emulation       | CDP Input.* via wc.debugger                  | same CDP via chrome.debugger               |
// | DOM access            | `wc.debugger.sendCommand("Runtime.evaluate")`| same + `chrome.scripting.executeScript`    |
// |                       | for DOM reads                                | for robust query/snapshot fallback         |
// | Viewport              | `wc.setZoomFactor` + BrowserView bounds      | `Emulation.setDeviceMetricsOverride`       |
// | a11y tree             | `Accessibility.getFullAXTree` via wc.debugger| same via chrome.debugger (primary)         |
// | Style/selector synth  | in-page Runtime.evaluate highlightScript     | same but shadow DOM overlay for highlight  |
// | Perf profiler         | in-page Runtime.evaluate installReactHook    | same (isolated world sees same fiber keys) |
//
// Both lanes share the same pacing constants — AGENT_CURSOR_MOVE_MS=160 and
// AGENT_CURSOR_CLICK_LEAD_MS=40 — and emit the same BrowserPointerEvent shape
// so the timeline stream is lane-agnostic.

// ---------------------------------------------------------------------------
// Error tag mapping (extension lane -> BrowserErrorTag) — matches bridge-api §7
// ---------------------------------------------------------------------------

export const extensionDebuggerErrorToTag = (message: string): string => {
  const m = message.toLowerCase()
  if (m.includes("another debugger") || m.includes("already attached") || m.includes("isdevtoolsopened")) {
    return "BrowserDebuggerConflict"
  }
  if (m.includes("target_closed") || m.includes("no tab with id") || m.includes("no target")) {
    // Genuine tab/ guest crash vs not-found distinguished by context in caller
    return "BrowserGuestCrashed"
  }
  if (m.includes("canceled_by_user") || m.includes("canceled by user")) {
    return "BrowserControlInterrupted"
  }
  if (m.includes("stale") || m.includes("snapshotversion")) {
    return "BrowserStaleRefError"
  }
  if (m.includes("not a react")) {
    return "BrowserNotAReactAppError"
  }
  return "BrowserOperationFailed"
}

// ---------------------------------------------------------------------------
// Snapshot / query locator mapping (unifies css|text|role|testid|xpath)
// ---------------------------------------------------------------------------

export type LocatorResolver = (locator: { type: string; value: string; exact?: boolean }) => string

/**
 * Produce a JS expression (for chrome.scripting.executeScript func arg) that finds
 * one element for a locator and returns its center coords + rect + selector.
 * Caller supplies the locator; the executeScript callee is injected as a pure function
 * so it never depends on page globals that could be poisoned.
 *
 * Mirrors operations.ts scripts-resolve `findLocatorExpression` but rendered as a
 * string function body for chrome.scripting.executeScript's `func` parameter.
 */
export function locatorToExecuteScriptArgs(locator: { type: string; value: string; exact?: boolean }): {
  selector: string
  resolver: string
} {
  switch (locator.type) {
    case "css":
      return { selector: locator.value, resolver: "css" }
    case "text": {
      // Text search: scan * for includes; exact flag requires full trimmed equality
      return { selector: locator.value, resolver: locator.exact ? "text-exact" : "text" }
    }
    case "role":
      return { selector: locator.value, resolver: "role" }
    case "testid":
      return { selector: locator.value, resolver: "testid" }
    case "xpath":
      return { selector: locator.value, resolver: "xpath" }
    case "placeholder":
      return { selector: locator.value, resolver: "placeholder" }
    case "label":
      return { selector: locator.value, resolver: "label" }
    case "name":
      return { selector: locator.value, resolver: "name" }
    default:
      return { selector: locator.value, resolver: "css" }
  }
}

/**
 * Fallback chain for snapshot when CDP Accessibility tree is empty (common on
 * extension-initialized tabs before debugger attach settles):
 * 1) CDP Accessibility.getFullAXTree (primary)
 * 2) chrome.scripting.executeScript outerHTML harvest (already in sw.ts)
 * 3) Runtime.evaluate document.documentElement.innerText scan for wait_for polling
 *
 * This module does not execute the fallback — sw.ts does — but documents the
 * contract so desktop-bridge and overlay-ops share the same fallback invariant.
 */
export const SNAPSHOT_FALLBACK_CHAIN = [
  "Accessibility.getFullAXTree (CDP)",
  "chrome.scripting.executeScript outerHTML harvest (up to 20k chars)",
  "Runtime.evaluate innerText polling (wait_for loop, 100ms cadence)",
] as const

// ---------------------------------------------------------------------------
// wait_for polling (mirrors operations.ts WAIT_FOR_POLL_MS=100)
// ---------------------------------------------------------------------------

export interface WaitForAdaptation {
  pollMs: number
  maxPollMs: number
  fallback: "scripting" | "cdp"
}

/**
 * Extension lane wait_for uses the same poll contract as the desktop lane:
 * - selector: resolved via executeScript (locator mapping above), satisfied on first visible/attached state
 * - text:     executeScript innerText includes/equals check
 * - url:      chrome.tabs.get polling (no CDP needed)
 * - expression: Runtime.evaluate truthy check
 *
 * CDP is not required for wait_for polling; chrome.scripting suffices and avoids
 * needing debugger attach for pure selectors. Attach is deferred until a CDP-op
 * (snapshot/click/type/...) actually needs it — matches sw.ts needsDebugger set.
 */
export const WAIT_FOR_EXTENSION_ADAPTATION: WaitForAdaptation = {
  pollMs: 100,
  maxPollMs: 30_000,
  fallback: "scripting",
}

// ---------------------------------------------------------------------------
// HIDE/SHOW capture invariant (screenshot hygiene)
// ---------------------------------------------------------------------------

export const SCREENSHOT_OVERLAY_INVARIANT = {
  // Contracts invariant #5: Page.captureScreenshot MUST NOT include agent overlay
  sequence: ["opencode:hide (barrier ack)", "Page.captureScreenshot (captureBeyondViewport)", "opencode:show"],
  ack: "synchronous chrome.tabs.sendMessage response before capture",
  fallback: "tabs.captureVisibleTab when CDP capture fails",
  rAFYieldMs: 16,
} as const

// ---------------------------------------------------------------------------
// Tab grouping (session-affine chrome.tabGroups)
// ---------------------------------------------------------------------------

export const TAB_GROUP_EXTENSION_LANE = {
  // SW creates group: chrome.tabs.group({tabIds}) then
  title: (sessionId: string) => `opencode — ${sessionId.slice(0, 8)}`,
  color: "blue" as const,
  collapseFallback: "no collapse (keep open for agent tab visibility)",
} as const

// ---------------------------------------------------------------------------
// Dispatch adapter shape (what desktop-bridge's ExtensionBridge calls)
// ---------------------------------------------------------------------------

export type ExtensionDispatch = (
  tabId: string | undefined,
  operation: BrowserOperation,
  sessionId: string,
) => Promise<Record<string, unknown>>

export interface ExtensionOperationsAdapterOptions {
  dispatch: ExtensionDispatch
  onPointerEvent?: (event: { tabId: string; phase: "move" | "click"; x: number; y: number; sequence: number; createdAt: string }) => void
}

/**
 * Small adapter wrapper that documents the multiplex point where BrowserEngine
 * hands a BrokerRequest to either the webview lane (BrowserOperations) or the
 * extension lane (this module via native messaging / WS fallback).
 *
 * Real routing lives in extension-bridge.ts ExtensionBridge.resolveLane(); this
 * adapter carries the operation-level translation table for code-searchable docs.
 */
export class ExtensionOperationsAdapter {
  constructor(private readonly opts: ExtensionOperationsAdapterOptions) {}

  async dispatch(request: BrokerRequest): Promise<Record<string, unknown>> {
    return this.opts.dispatch(request.tabId, request.operation, request.sessionId)
  }
}

// ---------------------------------------------------------------------------
// Operation -> CDP method table (the only behavior that actually differs)
// ---------------------------------------------------------------------------

export const OPERATION_TO_CDP: Record<string, string[]> = {
  snapshot: ["Accessibility.getFullAXTree", "Runtime.evaluate (fallback outerHTML)", "chrome.scripting.executeScript (text harvest)"],
  screenshot: ["Page.captureScreenshot (captureBeyondViewport)", "tabs.captureVisibleTab (fallback)"],
  click: ["Input.dispatchMouseEvent mouseMoved (DevTools cursor)", "opencode:cursor (overlay)", "Input.dispatchMouseEvent mousePressed/mouseReleased"],
  type: ["Input.dispatchMouseEvent focus (if target)", "Input.dispatchKeyEvent (clear)", "Runtime.evaluate DOM editing (preferred over Input.insertText)", "Input.dispatchKeyEvent Enter (submit)"],
  press: ["Input.dispatchKeyEvent keyDown/keyUp"],
  scroll: ["Input.dispatchMouseEvent mouseWheel (delta) | Runtime.evaluate window.scrollTo (top/bottom)"],
  evaluate: ["Runtime.evaluate (returnByValue, awaitPromise)"],
  wait_for: ["chrome.tabs.get (url) | chrome.scripting.executeScript (text/selector) | Runtime.evaluate (expression)"],
  highlight: ["opencode:highlight (overlay box)"],
  annotate: ["opencode:highlight[] (overlay box per target)"],
  query: ["chrome.scripting.executeScript querySelectorAll + getBoundingClientRect batch (maxResults clamp)"],
  resize: ["Emulation.setDeviceMetricsOverride"],
  set_appearance: ["Emulation.setEmulatedMedia (prefers-color-scheme)"],
  recording_start: ["Page.startScreencast (JPEG q80 12fps) — NOT YET: stub BrowserUnsupportedOperation"],
  recording_stop: ["Page.stopScreencast — NOT YET: stub"],
  react_inspect: ["Runtime.evaluate __reactFiber$ probe (same fiber-key trick as annotation-overlay)"],
  profiler_start: ["Runtime.evaluate installReactHookScript"],
  profiler_stop: ["Runtime.evaluate profilerStopScript"],
}
