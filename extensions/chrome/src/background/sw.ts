// Background service worker — MV3 module.
// Owns chrome.debugger multiplex, Target flattening, nativeMessaging Port,
// and routes BrokerRequest -> CDP + chrome.tabs scripting back to BrokerResponse.
// @ts-nocheck — Chrome extension global types not in tsconfig

import { NATIVE_HOST_NAME, isBrokerRequest } from "../shared/protocol.js"
import { DebuggerManager } from "./debugger.js"
import { NativePortV2 } from "./native-port.js"
import { ActiveTabIconController } from "./active-tab-icon.js"
import { waitForTabComplete, waitForUrl } from "./tab-waits.js"
import { operationNeedsDebugger } from "./dispatch-policy.js"
import { interactiveElementsScanScript, resolveElementScript } from "@opencode-ai/browser-targeting"
import { SnapshotRefRegistry } from "./snapshot-refs.js"
import { VisualRuntimeLoader } from "./visual-runtime-loader.js"
import { VisualRequestTracker, abortVisualRequestsForTab } from "./visual-lifecycle.js"

// ---- helpers ---------------------------------------------------------------

function toError(tag, message, retryable, details) {
  return { tag, message, retryable, ...(details ? { details } : {}) }
}

/** Map thrown DebuggerError / generic Error to BrokerResponse error body */
function toBrokerErrorBody(err) {
  if (err && typeof err.tag === "string" && typeof err.message === "string" && typeof err.retryable === "boolean") {
    const out = { tag: err.tag, message: err.message, retryable: err.retryable }
    if (err.details) out.details = err.details
    return out
  }
  if (err instanceof Error) {
    return { tag: "BrowserOperationFailed", message: err.message, retryable: true, details: { stack: err.stack } }
  }
  return { tag: "BrowserOperationFailed", message: String(err), retryable: true }
}

// ---- singletons (lazy so tests can inject mocks) -------------------------

let debuggerManager = null
let nativePort = null
let wsFallback = null // optional WS transport for WSL — see notes below
let activeTabIconController = null
const activeVisualRequests = new VisualRequestTracker()
const snapshotRefs = new SnapshotRefRegistry(chrome.storage?.session)
const visualRuntime = new VisualRuntimeLoader({
  probe: async (tabId) => {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "opencode:visual-ready" })
      return response?.ready === true && response?.version === 1
    } catch {
      return false
    }
  },
  inject: async (tabId) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/visual.bundle.js"],
      world: "ISOLATED",
    })
  },
})

function getDebuggerManager() {
  if (!debuggerManager) {
    debuggerManager = new DebuggerManager({
      debuggerApi: chrome.debugger,
      runtime: chrome.runtime,
      log: (msg, meta) => console.debug(`[sw:debugger] ${msg}`, meta ?? ""),
    })
  }
  return debuggerManager
}

function getNativePort() {
  if (!nativePort) {
    nativePort = new NativePortV2({
      hostName: NATIVE_HOST_NAME,
      connectNative: (name) => chrome.runtime.connectNative(name),
      onRequest: (request) => { void handleBrokerRequest(request, "native") },
      onAbort: (requestId) => { void abortBrokerRequest(requestId) },
      onDisconnect: (err) => {
        console.warn("[sw:native] disconnected", err)
        // Backoff reconnect for resilience (service worker may go idle)
        setTimeout(() => {
          try { getNativePort().connect() } catch {}
        }, 2000)
      },
      log: (msg, meta) => console.debug(`[sw:native] ${msg}`, meta ?? ""),
    })
    try { nativePort.connect() } catch (e) { console.warn("[sw:native] initial connect failed", e) }
  }
  return nativePort
}

function getActiveTabIconController() {
  if (!activeTabIconController) {
    activeTabIconController = new ActiveTabIconController(chrome.tabs, (message, meta) => {
      console.debug(`[sw:icon] ${message}`, meta ?? "")
    })
  }
  return activeTabIconController
}

// ---- WS fallback (WSL) -----------------------------------------------------
// Primary is nativeMessaging; WS is fallback for WSL where native host dirs are awkward.
// Convention mirrors vymalo/opencode-browser + AIPex: ws://127.0.0.1:<port>/extension
// Discovery: sidecar hello reply's callbackUrl port. Extension reads it from storage or hello.
// See docs/browser-chrome-fallback.md for detail. We stub the shape here; full impl in M2.

class WsFallback {
  constructor(url, token) { this.url = url; this.token = token; this.ws = null }
  connect() {
    if (this.ws) return
    try {
      const ws = new WebSocket(this.url)
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", token: this.token, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version }))
      }
      ws.onmessage = (ev) => this.handleMessage(ev.data)
      ws.onclose = () => { this.ws = null }
      ws.onerror = (e) => console.warn("[sw:ws] error", e)
      this.ws = ws
    } catch (e) { console.warn("[sw:ws] connect failed", e) }
  }
  handleMessage(data) {
    try {
      const msg = JSON.parse(data)
      if (msg.type === "command" && msg.request) void handleBrokerRequest(msg.request, "ws")
    } catch {}
  }
  send(msg) { try { this.ws?.send(JSON.stringify(msg)) } catch {} }
}

// ---- Broker dispatch (shared entry for native + ws + chrome.runtime messages) ----

async function handleBrokerRequest(raw, source) {
  const startedAt = Date.now()
  let requestId = ""
  try {
    if (!isBrokerRequest(raw)) {
      const resp = { ok: false, requestId: "", elapsedMs: Date.now() - startedAt, error: toError("BrowserOperationFailed", "Invalid BrokerRequest envelope", true) }
      reply(source, resp)
      return
    }
    const req = raw
    requestId = req.requestId
    const result = await dispatchOperation(req)
    const resp = { ok: true, requestId, result, elapsedMs: Date.now() - startedAt }
    reply(source, resp)
  } catch (err) {
    const resp = { ok: false, requestId, elapsedMs: Date.now() - startedAt, error: toBrokerErrorBody(err) }
    reply(source, resp)
  }
}

function reply(source, response) {
  if (source === "native") {
    getNativePort().respond(response)
  } else if (source === "ws") {
    wsFallback?.send({ type: "result", response })
  }
  // runtime.sendMessage replies are handled via sendResponse callback in the listener below
}

// ---- per-operation CDP bridge ---------------------------------------------

async function dispatchOperation(request) {
  const { tabId: tabIdStr, operation, sessionId } = request
  const tabId = tabIdStr ? Number.parseInt(tabIdStr, 10) : await resolveActiveTabId()
  if (!Number.isFinite(tabId)) throw Object.assign(new Error(`Invalid tabId ${tabIdStr}`), { tag: "BrowserTabNotFound", retryable: true })

  const name = operation.name
  const input = operation.input ?? {}
  const needsDebugger = operationNeedsDebugger(name, input)
  const dm = needsDebugger ? getDebuggerManager() : debuggerManager

  // Attach only for operations that actually issue chrome.debugger commands.
  // Scripting-only and unsupported operations should never flash Chrome's
  // debugging infobar or subscribe the tab to CDP unnecessarily.
  if (needsDebugger && !dm.isAttached(tabId)) {
    await dm.attach(tabId)
  }

  switch (name) {
    case "status": {
      const [tabs, focusedActiveTabs] = await Promise.all([
        chrome.tabs.query({}),
        chrome.tabs.query({ active: true, lastFocusedWindow: true }),
      ])
      const active = focusedActiveTabs[0] ?? tabs.find(t => t.active)
      return {
        status: {
          connected: true,
          host: { hostId: "chrome-ext", protocolVersion: 2, hostEpoch: 1 },
          guest: active ? { windowId: String(active.windowId), state: "attached", activeTab: { tabId: String(active.id), url: active.url ?? "", title: active.title ?? "", readyState: active.status === "complete" ? "Success" : "Loading", viewport: { width: active.width ?? 1280, height: active.height ?? 800, dpr: 1, scrollX: 0, scrollY: 0 } } } : undefined,
          appearance: "system",
          recording: { active: false },
        },
        tabs: tabs.map(t => ({ tabId: String(t.id), url: t.url ?? "", title: t.title ?? "", active: !!t.active, owner: { kind: "user" }, muted: !!t.mutedInfo?.muted })),
      }
    }
    case "open": {
      const url = input.url
      if (!url) throw Object.assign(new Error("open requires url"), { tag: "BrowserInvalidSelector" })
      let targetTabId = tabIdStr
      if (input.newTab || !tabIdStr) {
        const created = await chrome.tabs.create({ url, active: input.activate ?? true })
        targetTabId = String(created.id)
        // Optionally group
        if (chrome.tabGroups) {
          try {
            const groupId = await chrome.tabs.group({ tabIds: created.id })
            await chrome.tabGroups.update(groupId, { title: `opencode — ${sessionId.slice(0, 8)}`, color: "blue" })
          } catch {}
        }
      } else {
        await chrome.tabs.update(Number.parseInt(targetTabId, 10), { url })
      }
      const tab = await chrome.tabs.get(Number.parseInt(targetTabId, 10))
      return { opened: { tabId: targetTabId, url: tab.url ?? url, title: tab.title ?? "", readyState: "Loading", viewport: { width: tab.width ?? 1280, height: tab.height ?? 800, dpr: 1, scrollX: 0, scrollY: 0 }, owner: { kind: "agent", sessionId } } }
    }
    case "claim": {
      // Ownership is enforced by the sidecar/Desktop mirrors. Chrome does not
      // need a second ownership database; return the canonical transition so
      // the broker can atomically update its routing gate.
      return { claimed: { tabId: String(tabId), owner: { kind: "agent", sessionId } } }
    }
    case "set_tab_owner": {
      const owner = input.owner
      if (!owner || (owner.kind !== "user" && !(owner.kind === "agent" && typeof owner.sessionId === "string"))) {
        throw Object.assign(new Error("set_tab_owner requires a valid owner"), { tag: "BrowserOperationFailed", retryable: false })
      }
      return { assigned: { tabId: String(tabId), owner } }
    }
    case "navigate": {
      await snapshotRefs.clear(tabId)
      await chrome.tabs.update(tabId, { url: input.url })
      await waitForTabComplete(chrome.tabs, tabId, input.timeoutMs ?? 15000)
      const tab = await chrome.tabs.get(tabId)
      return { navigated: { tabId: String(tabId), url: tab.url ?? input.url, title: tab.title ?? "", readyState: "Success", viewport: { width: tab.width ?? 1280, height: tab.height ?? 800, dpr: 1, scrollX: 0, scrollY: 0 } } }
    }
    case "close": {
      const closeId = input.tabId ? Number.parseInt(input.tabId, 10) : tabId
      await snapshotRefs.clear(closeId)
      try { await debuggerManager?.detach(closeId) } catch {}
      await chrome.tabs.remove(closeId)
      return { closed: { tabId: String(closeId), wasActive: true, guestsRemaining: 0 } }
    }
    case "snapshot": {
      // Use the same page scanner/selector synthesis as the built-in webview.
      // Running it through CDP keeps the extension lane byte-for-byte aligned
      // with Desktop's Runtime.evaluate semantics and gives us real versioned
      // refs instead of the old `elements: []` placeholder.
      const scan = await evaluatePage(dm, tabId, interactiveElementsScanScript())
      if (!scan || typeof scan !== "object" || !Array.isArray(scan.elements)) {
        throw Object.assign(new Error("Chrome snapshot scanner returned an invalid result"), { tag: "BrowserOperationFailed", retryable: true })
      }
      const elements = scan.elements
      const refState = await snapshotRefs.replace(tabId, elements)
      let tree = []
      try {
        const cdpTree = await dm.sendCommand(tabId, "Accessibility.getFullAXTree", {})
        tree = cdpTree?.nodes ?? []
      } catch {}
      return {
        snapshot: {
          tabId: String(tabId),
          url: typeof scan.url === "string" ? scan.url : (await chrome.tabs.get(tabId)).url ?? "",
          tree,
          elements,
          text: typeof scan.text === "string" ? scan.text : "",
          truncated: !!scan.truncated,
          count: Number.isFinite(scan.count) ? scan.count : elements.length,
          viewport: scan.viewport ?? { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 },
          snapshotVersion: refState.version,
        },
      }
    }
    case "screenshot": {
      // HIDE_FOR_TOOL_USE barrier (matches annotation-overlay.ts:801-812 + contracts screenshot invariant #5):
      // 1) ask content to hide overlay (Synchronous ack barrier), 2) capture, 3) show.
      // Non-fatal if content not present — still captured without ghost.
      try { await chrome.tabs.sendMessage(tabId, { type: "opencode:hide" }) } catch {}
      // sendMessage resolves after the content script has synchronously applied
      // display:none and acknowledged the barrier. MV3 service workers have no
      // requestAnimationFrame; the previous code always paid its exception +
      // 16ms fallback path here.
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      let result
      try {
        try {
          const res = await dm.sendCommand(tabId, "Page.captureScreenshot", { format: input.format ?? "png", captureBeyondViewport: !!input.fullPage })
          result = { screenshot: { tabId: String(tabId), url: tab?.url ?? "", title: tab?.title ?? "", mime: input.format === "jpeg" ? "image/jpeg" : "image/png", data: res.data, width: 1280, height: 800, viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, capturedAt: Date.now() } }
        } catch {
          const winId = tab?.windowId
          const dataUrl = winId !== undefined
            ? await chrome.tabs.captureVisibleTab(winId, { format: input.format ?? "png" })
            : await chrome.tabs.captureVisibleTab({ format: input.format ?? "png" } as unknown as chrome.tabs.CaptureVisibleTabOptions)
          const data = (dataUrl as string).split(",")[1] ?? ""
          result = { screenshot: { tabId: String(tabId), url: tab?.url ?? "", title: tab?.title ?? "", mime: input.format === "jpeg" ? "image/jpeg" : "image/png", data, width: 1280, height: 800, viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, capturedAt: Date.now() } }
        }
      } finally {
        try { await chrome.tabs.sendMessage(tabId, { type: "opencode:show" }) } catch {}
      }
      return result
    }
    case "visual_capture":
    case "visual_diff":
    case "visual_record": {
      const visual = input.__opencodeVisual
      if (
        !visual ||
        typeof visual.capability !== "string" ||
        typeof visual.runId !== "string" ||
        !Number.isSafeInteger(visual.maxChunkBytes) ||
        visual.maxChunkBytes < 1
      ) {
        throw Object.assign(new Error("Visual operation is missing its Desktop capability"), { tag: "BrowserOperationFailed", retryable: false })
      }
      if (!activeVisualRequests.tryTrack(request.requestId, tabId)) {
        throw Object.assign(new Error(`A visual operation is already active on tab ${tabId}`), {
          tag: "BrowserOperationFailed",
          retryable: true,
        })
      }
      try {
        const target = await resolveVisualTarget(dm, tabId, input.target)
        const options = {
          ...(input.stabilize !== undefined ? { stabilize: input.stabilize } : {}),
          ...(input.waitFor !== undefined ? { waitFor: input.waitFor } : {}),
          ...(input.waitTimeout !== undefined ? { waitTimeout: input.waitTimeout } : {}),
          ...(input.settle !== undefined ? { settle: input.settle } : {}),
          ...(input.settleTimeout !== undefined ? { settleTimeout: input.settleTimeout } : {}),
          ...(input.scale !== undefined ? { scale: input.scale } : {}),
          ...(input.svg !== undefined ? { svg: input.svg } : {}),
          ...(name === "visual_diff"
            ? {
                diffOptions: {
                  ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
                  ...(input.includeAA !== undefined ? { includeAA: input.includeAA } : {}),
                  ...(input.diffMask !== undefined ? { diffMask: input.diffMask } : {}),
                },
                regionOptions: {
                  ...(input.tileSize !== undefined ? { tileSize: input.tileSize } : {}),
                  ...(input.gapTiles !== undefined ? { gapTiles: input.gapTiles } : {}),
                  ...(input.minRegionCssSide !== undefined ? { minRegionCssSide: input.minRegionCssSide } : {}),
                  ...(input.minRegionCssArea !== undefined ? { minRegionCssArea: input.minRegionCssArea } : {}),
                  ...(input.maxRegions !== undefined ? { maxRegions: input.maxRegions } : {}),
                },
              }
            : {}),
          ...(name === "visual_record"
            ? {
                ...(input.duration !== undefined ? { duration: input.duration } : {}),
                ...(input.fps !== undefined ? { fps: input.fps } : {}),
                ...(input.format !== undefined ? { format: input.format } : {}),
                ...(input.bitrate !== undefined ? { bitrate: input.bitrate } : {}),
                filmstripOptions: {
                  ...(input.filmstripMaxCells !== undefined ? { maxCells: input.filmstripMaxCells } : {}),
                  ...(input.filmstripMaxColumns !== undefined ? { maxColumns: input.filmstripMaxColumns } : {}),
                  ...(input.filmstripMaxWidth !== undefined ? { maxWidth: input.filmstripMaxWidth } : {}),
                  ...(input.filmstripGap !== undefined ? { gap: input.filmstripGap } : {}),
                  ...(input.filmstripBackground !== undefined ? { background: input.filmstripBackground } : {}),
                },
              }
            : {}),
        }
        // Use the same synchronous hide barrier as compositor screenshots in
        // addition to SnapEye's reserved-selector hiding. The barrier protects
        // against any current/future OpenCode shadow UI that is not represented
        // by a known host selector.
        try { await chrome.tabs.sendMessage(tabId, { type: "opencode:hide" }) } catch {}
        await visualRuntime.ensure(tabId)
        const response = await chrome.tabs.sendMessage(tabId, {
          type: "opencode:visual-run",
          command: {
            requestId: request.requestId,
            operation: name === "visual_capture" ? "capture" : name === "visual_diff" ? "diff" : "record",
            name: input.name,
            runId: visual.runId,
            capability: visual.capability,
            maxChunkBytes: visual.maxChunkBytes,
            target,
            redaction: visual.redaction,
            options,
          },
        })
        if (!response?.ok) {
          const interruption = await visualInterruptionReason(request.requestId, tabId)
          // `ensureVisualRuntime()` proved a responder existed immediately
          // before this long-lived message. If Chrome later resolves it with no
          // response, the isolated document context disappeared (navigation or
          // tab teardown) while the visual operation was pending.
          const lostContext = response == null
          const interrupted = lostContext || response?.aborted === true || interruption !== undefined
          throw Object.assign(new Error(
            response?.error ?? (lostContext ? "Visual browser context disappeared" : "Chrome visual runtime failed"),
          ), {
            tag: interrupted ? "BrowserControlInterrupted" : "BrowserOperationFailed",
            retryable: true,
          })
        }
        return { visual: response.result }
      } catch (error) {
        const interruption = await visualInterruptionReason(request.requestId, tabId)
        if (interruption) {
          throw Object.assign(new Error(`Visual operation interrupted: ${interruption}`), {
            tag: "BrowserControlInterrupted",
            retryable: true,
          })
        }
        throw error
      } finally {
        activeVisualRequests.untrack(request.requestId)
        try { await chrome.tabs.sendMessage(tabId, { type: "opencode:show" }) } catch {}
      }
    }
    case "click": {
      const target = input.target
      const coords = await resolveTargetToCoords(dm, tabId, target)
      // Cursor choreography: move glide 160ms -> click pulse 40ms -> mousePressed/Released
      // Mirrors packages/desktop/src/main/browser/operations.ts desktop lane:
      //   emitPointer("move") -> sleep(160) -> emitPointer("click") -> sleep(40) -> mousePressed/Released
      // MouseMoved event for DevTools cursor visibility (no page effect until pressed)
      try { await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: coords.x, y: coords.y }) } catch {}
      try { await chrome.tabs.sendMessage(tabId, { type: "opencode:cursor", x: coords.x, y: coords.y, phase: "move", sequence: input.sequence }) } catch {}
      await new Promise(r => setTimeout(r, 160))
      try { await chrome.tabs.sendMessage(tabId, { type: "opencode:cursor", x: coords.x, y: coords.y, phase: "click", sequence: input.sequence }) } catch {}
      await new Promise(r => setTimeout(r, 40))
      const button = input.button ?? "left"
      const clickCount = input.clickCount ?? 1
      const modifiers = Array.isArray(input.modifiers) ? input.modifiers : []
      // modifiers -> Input.dispatchMouseEvent modifiers bitmask is handled by cdpsession; pass through as meta
      void modifiers
      await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: coords.x, y: coords.y, button, clickCount })
      await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.x, y: coords.y, button, clickCount })
      return { clicked: { target: { kind: "coords", center: coords }, coords, clickCount } }
    }
    case "type": {
      const text = input.text ?? ""
      if (input.target) {
        const c = await resolveTargetToCoords(dm, tabId, input.target)
        await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 })
        await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 })
      }
      if (input.clear) {
        await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 })
        await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 })
        await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" })
        await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" })
      }
      // Prefer in-page DOM editing via Runtime.evaluate (more reliable than insertText)
      if (text) {
        await dm.sendCommand(tabId, "Runtime.evaluate", { expression: `(() => { const el=document.activeElement; if(el && (el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable)){ if(el.isContentEditable) document.execCommand('insertText', false, ${JSON.stringify(text)}); else { el.value+=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } } return true })()`, awaitPromise: false })
      }
      if (input.submit) {
        await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" })
        await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" })
      }
      return { typed: { value: text, caret: { selectionStart: text.length, selectionEnd: text.length }, submitted: !!input.submit } }
    }
    case "press": {
      const key = input.key
      await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key, code: key })
      await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code: key })
      return { pressed: { key, repeat: false, modifiers: [] } }
    }
    case "scroll": {
      if (input.delta) {
        await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: input.delta.x ?? 0, deltaY: input.delta.y ?? 0 })
      } else if (input.to === "top") {
        await dm.sendCommand(tabId, "Runtime.evaluate", { expression: "window.scrollTo(0,0)" })
      } else if (input.to === "bottom") {
        await dm.sendCommand(tabId, "Runtime.evaluate", { expression: "window.scrollTo(0, document.body.scrollHeight)" })
      }
      return { scrolled: { viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, scrollX: 0, scrollY: 0 } }
    }
    case "evaluate": {
      const res = await dm.sendCommand(tabId, "Runtime.evaluate", { expression: input.script, awaitPromise: !!input.awaitPromise, returnByValue: true })
      const result = res.result?.value ?? res.result ?? null
      const type = typeof result
      return { evaluated: { result, type, truncated: false } }
    }
    case "wait_for": {
      const timeout = input.timeoutMs ?? 5000
      if (input.condition?.type === "url") {
        const tab = await waitForUrl(chrome.tabs, tabId, input.condition.pattern, timeout)
        if (tab) return { waited: { satisfied: true, at: { time: Date.now(), url: tab.url ?? "", title: tab.title ?? "" } } }
      } else if (input.condition?.type === "text") {
        const [{ result: found }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (text, timeoutMs) => {
            if (document.body?.innerText?.includes(text)) return Promise.resolve(true)
            return new Promise((resolve) => {
              let checkTimer = 0
              const finish = (value) => {
                observer.disconnect()
                clearTimeout(timer)
                if (checkTimer) clearTimeout(checkTimer)
                resolve(value)
              }
              const observer = new MutationObserver(() => {
                // Mutation-heavy applications can produce thousands of records
                // per second. Coalesce expensive innerText reads while keeping
                // the wait entirely in-page (zero extension round-trips).
                if (checkTimer) return
                checkTimer = setTimeout(() => {
                  checkTimer = 0
                  if (document.body?.innerText?.includes(text)) finish(true)
                }, 25)
              })
              const timer = setTimeout(() => finish(false), timeoutMs)
              observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
            })
          },
          args: [input.condition.text, timeout],
        }).catch(() => [{ result: false }])
        if (found) return { waited: { satisfied: true, at: { time: Date.now(), url: "", title: "" } } }
      }
      throw Object.assign(new Error("wait_for timeout"), { tag: "BrowserTimeout", retryable: true })
    }
    case "highlight":
    case "annotate": {
      const targets = input.targets ?? (input.target ? [{ target: input.target }] : [])
      for (const t of targets) {
        const coords = await resolveTargetToCoords(dm, tabId, t.target)
        try { await chrome.tabs.sendMessage(tabId, { type: "opencode:highlight", rect: { x: coords.x - 20, y: coords.y - 10, width: 40, height: 20 }, label: t.label, tone: t.tone }) } catch {}
      }
      if (input.clear) try { await chrome.tabs.sendMessage(tabId, { type: "opencode:clear" }) } catch {}
      return { annotated: { tabId: String(tabId), count: targets.length, cleared: !!input.clear, at: { time: Date.now() } } }
    }
    case "query": {
      const selector = input.target?.value ?? input.selector ?? "*"
      const results = await chrome.scripting.executeScript({ target: { tabId }, func: (sel, max) => {
        const els = [...document.querySelectorAll(sel)].slice(0, max ?? 20)
        return els.map(el => {
          const r = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, center: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, visibility: r.width > 0 && r.height > 0 ? "visible" : "hidden", display: style.display, position: style.position, text: el.textContent?.slice(0, 200) ?? "" }
        })
      }, args: [selector, input.maxResults ?? 20] }).catch(() => [{ result: [] }])
      const matches = results?.[0]?.result ?? []
      return { queried: { tabId: String(tabId), url: (await chrome.tabs.get(tabId)).url ?? "", matches, count: matches.length, truncated: matches.length >= (input.maxResults ?? 20) } }
    }
    case "resize": {
      await dm.sendCommand(tabId, "Emulation.setDeviceMetricsOverride", { width: input.width, height: input.height, deviceScaleFactor: input.deviceScaleFactor ?? 1, mobile: false })
      return { resized: { width: input.width, height: input.height, dpr: input.deviceScaleFactor ?? 1, actualWidth: input.width, actualHeight: input.height } }
    }
    case "set_appearance": {
      const scheme = input.appearance === "dark" ? "dark" : input.appearance === "light" ? "light" : "no-preference"
      try { await dm.sendCommand(tabId, "Emulation.setEmulatedMedia", { media: "prefers-color-scheme", features: [{ name: "prefers-color-scheme", value: scheme }] }) } catch {}
      return { appearance: input.appearance, effective: scheme === "dark" ? "dark" : "light" }
    }
    default:
      throw Object.assign(new Error(`Unsupported operation ${name} in extension lane`), { tag: "BrowserUnsupportedOperation", retryable: false })
  }
}

async function resolveTargetToCoords(dm, tabId, target) {
  if (!target) throw browserTargetNotFound("A browser element target is required")
  if (isRefTarget(target)) {
    const { record } = await requireSnapshotRef(tabId, target)
    return { x: record.x, y: record.y }
  }
  if (typeof target.x === "number" && typeof target.y === "number") {
    return { x: Math.round(target.x), y: Math.round(target.y) }
  }
  const resolved = await resolveLiveTarget(dm, tabId, target)
  return resolved.center
}

async function resolveVisualTarget(dm, tabId, target) {
  if (!target || target.kind === "document") return undefined
  if (target.kind === "css") {
    if (typeof target.selector !== "string" || !target.selector) throw browserInvalidSelector("visual target requires a non-empty CSS selector")
    return target.selector
  }
  if (target.kind !== "element" || !target.target) throw browserInvalidSelector("Unsupported visual target")
  const elementTarget = target.target
  if (isRefTarget(elementTarget)) {
    const { record } = await requireSnapshotRef(tabId, elementTarget)
    return record.selector
  }
  const manager = dm ?? getDebuggerManager()
  if (!manager.isAttached(tabId)) await manager.attach(tabId)
  const resolved = await resolveLiveTarget(manager, tabId, elementTarget)
  if (typeof resolved.selector?.value !== "string" || !resolved.selector.value) {
    throw browserTargetNotFound("Visual target could not be converted to a stable selector")
  }
  return resolved.selector.value
}

async function resolveLiveTarget(dm, tabId, target) {
  const value = await evaluatePage(dm, tabId, resolveElementScript(target, false))
  if (value && typeof value === "object" && typeof value.error === "string") throw browserInvalidSelector(value.error)
  if (!value || typeof value !== "object" || !value.center) throw browserTargetNotFound()
  return value
}

async function requireSnapshotRef(tabId, target) {
  const state = await snapshotRefs.get(tabId)
  const expected = state?.version ?? 0
  if (!state || target.snapshotVersion !== state.version || !state.refs[target.ref]) {
    const error = new Error(`Snapshot ref "${target.ref}" is stale (bound to snapshot ${target.snapshotVersion}, current snapshot ${expected}). Re-run browser snapshot and use the new ref.`)
    Object.assign(error, {
      tag: "BrowserStaleRefError",
      retryable: false,
      details: { ref: target.ref, expectedSnapshot: expected, actualSnapshot: target.snapshotVersion },
    })
    throw error
  }
  return { state, record: state.refs[target.ref] }
}

async function evaluatePage(dm, tabId, expression) {
  const response = await dm.sendCommand(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (response?.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Runtime.evaluate failed"
    throw Object.assign(new Error(String(detail)), { tag: "BrowserOperationFailed", retryable: true })
  }
  return response?.result?.value
}

function isRefTarget(target) {
  return !!target && typeof target.ref === "string" && typeof target.snapshotVersion === "number"
}

function browserInvalidSelector(message) {
  return Object.assign(new Error(message), { tag: "BrowserInvalidSelector", retryable: false })
}

function browserTargetNotFound(message = "Browser target was not found") {
  return Object.assign(new Error(message), { tag: "BrowserTargetNotFound", retryable: true })
}

async function resolveActiveTabId() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return active?.id ?? null
}

async function abortBrokerRequest(requestId) {
  const tabId = activeVisualRequests.tabId(requestId)
  if (tabId !== undefined) {
    activeVisualRequests.interrupt(requestId, "caller-abort")
    try { await chrome.tabs.sendMessage(tabId, { type: "opencode:visual-abort", requestId }) } catch {}
  }
  console.debug("[sw:native] abort", { requestId, visual: tabId !== undefined })
}

async function abortVisualTab(tabId, reason) {
  const count = await abortVisualRequestsForTab(activeVisualRequests, tabId, reason, async (targetTabId, requestId) => {
    await chrome.tabs.sendMessage(targetTabId, { type: "opencode:visual-abort", requestId })
  })
  if (count > 0) console.debug("[sw:visual] tab lifecycle abort", { tabId, reason, count })
}

async function visualInterruptionReason(requestId, tabId) {
  const tracked = activeVisualRequests.interruption(requestId)
  if (tracked) return tracked
  // `tabs.sendMessage()` may reject because the tab disappeared before Chrome
  // delivers tabs.onRemoved. Verify tab existence while the request is still
  // tracked so that this scheduling race cannot degrade a user-authority close
  // into a generic BrowserOperationFailed.
  try {
    await chrome.tabs.get(tabId)
    return undefined
  } catch {
    activeVisualRequests.interrupt(requestId, "tab-removed")
    return "tab-removed"
  }
}

// ---- listeners -------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[sw] installed", chrome.runtime.getManifest().version)
  // Warm native port (optional — lazy otherwise)
  try { getNativePort().connect() } catch {}
})

chrome.runtime.onStartup.addListener(() => {
  try { getNativePort().connect() } catch {}
})

// A service worker can be started by an external/runtime event long after
// onInstalled/onStartup fired. Establish the native Port on every worker boot;
// getNativePort()/connect() are idempotent, so this costs no duplicate process.
try { getNativePort().connect() } catch {}
void getActiveTabIconController().start()

// Match the built-in webview lane's fail-closed lifecycle semantics. A visual
// observation belongs to one document lifetime: navigation start or tab loss
// invalidates it before the old isolated content world disappears. Dispatch's
// finally block remains responsible for untracking and Desktop capability
// revocation, so these listeners only signal cancellation and never publish a
// competing terminal state.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" && typeof changeInfo.url !== "string") return
  void abortVisualTab(tabId, "navigation")
})
chrome.tabs.onRemoved.addListener((tabId) => {
  void abortVisualTab(tabId, "tab-removed")
})

// Native host -> extension commands (primary)
if (chrome.runtime.onConnectNative) {
  // Not a real API; native host initiates connectNative from extension side only.
  // Host->ext messages arrive via Port.onMessage.
}

// Fallback: typed chrome.runtime messages (renderer or host-bridge via externally_connectable)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const m = msg
  if (!m || typeof m !== "object") return
  if (m.type === "opencode:request" && m.request) {
    // runtime.sendMessage requires its callback response, so dispatch exactly
    // once here rather than routing through reply(), whose runtime arm is empty.
    void (async () => {
      const startedAt = Date.now()
      try {
        if (!isBrokerRequest(m.request)) throw Object.assign(new Error("Invalid BrokerRequest"), { tag: "BrowserOperationFailed" })
        const result = await dispatchOperation(m.request)
        sendResponse({ ok: true, requestId: m.request.requestId, result, elapsedMs: Date.now() - startedAt })
      } catch (err) {
        sendResponse({ ok: false, requestId: m.request?.requestId ?? "", elapsedMs: Date.now() - startedAt, error: toBrokerErrorBody(err) })
      }
    })()
    return true
  }
  if (m.type === "opencode:visual-rpc" && m.request) {
    // Only our own isolated content world may use the artifact side channel.
    // Web pages do not have chrome.runtime access, but sender validation is a
    // second boundary against cross-extension/external message confusion.
    if (sender.id !== chrome.runtime.id || typeof sender.tab?.id !== "number") {
      sendResponse({ ok: false, id: m.request?.id ?? "", error: { code: "VISUAL_SCOPE_VIOLATION", message: "Untrusted visual RPC sender" } })
      return false
    }
    void getNativePort().artifactRpc(m.request, 30_000).then(
      (response) => sendResponse(response),
      (error) => sendResponse({ ok: false, id: m.request?.id ?? "", error: { code: "VISUAL_HOST_UNAVAILABLE", message: String(error) } }),
    )
    return true
  }
  if (m.type === "opencode:visual-wait" && typeof m.requestId === "string") {
    const tabId = sender.tab?.id
    const durationMs = Number(m.durationMs)
    if (
      sender.id !== chrome.runtime.id ||
      typeof tabId !== "number" ||
      activeVisualRequests.tabId(m.requestId) !== tabId ||
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      durationMs > 1_000
    ) {
      sendResponse({ ok: false, error: "Invalid visual frame-clock request" })
      return false
    }
    setTimeout(() => sendResponse({ ok: true }), durationMs)
    return true
  }
  if (m.type === "opencode:abort" && m.requestId) {
    // Keep the runtime-message fallback semantically identical to the native
    // host's abort frame. For visual flights this reaches the isolated runtime;
    // non-visual operations remain governed by their existing control path.
    void abortBrokerRequest(String(m.requestId)).then(
      () => sendResponse({ ok: true, aborted: true }),
      (error) => sendResponse({ ok: false, aborted: false, error: String(error) }),
    )
    return true
  }
  if (m.type === "opencode:ping") {
    sendResponse({ pong: true, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version })
    return false
  }
})

// External (WS/discovery) — allow http://127.0.0.1 to ping us
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "opencode:request" && msg.request) {
    void (async () => {
      const startedAt = Date.now()
      try {
        if (!isBrokerRequest(msg.request)) throw Object.assign(new Error("Invalid BrokerRequest"), { tag: "BrowserOperationFailed" })
        const result = await dispatchOperation(msg.request)
        sendResponse({ ok: true, requestId: msg.request.requestId, result, elapsedMs: Date.now() - startedAt })
      } catch (err) {
        sendResponse({ ok: false, requestId: msg.request?.requestId ?? "", elapsedMs: Date.now() - startedAt, error: toBrokerErrorBody(err) })
      }
    })()
    return true
  }
  if (msg?.type === "opencode:health") {
    sendResponse({ ok: true, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version })
    return false
  }
})

// connectNative() itself keeps an MV3 service worker alive on supported Chrome
// versions, and active chrome.debugger sessions do as well. Do not wake the
// extension on a synthetic 30s alarm when its native port already supplies the
// intended lifetime signal.

export { getDebuggerManager, getNativePort, getActiveTabIconController, handleBrokerRequest, dispatchOperation, toBrokerErrorBody }
