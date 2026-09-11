// Background service worker — MV3 module.
// Owns chrome.debugger multiplex, Target flattening, nativeMessaging Port,
// and routes BrokerRequest -> CDP + chrome.tabs scripting back to BrokerResponse.
// @ts-nocheck — Chrome extension global types not in tsconfig

import { NATIVE_HOST_NAME, isBrokerRequest } from "../shared/protocol.js"
import { DebuggerManager } from "./debugger.js"
import { NativePortV2 } from "./native-port.js"

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
      onResponse: () => {},
      onRequest: (request) => { void handleBrokerRequest(request, "native") },
      onAbort: (requestId) => console.debug("[sw:native] abort", { requestId }),
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
    const result = await dispatchOperation(req.tabId, req.operation, req.sessionId)
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

async function dispatchOperation(tabIdStr, operation, sessionId) {
  const tabId = tabIdStr ? Number.parseInt(tabIdStr, 10) : await resolveActiveTabId()
  if (!Number.isFinite(tabId)) throw Object.assign(new Error(`Invalid tabId ${tabIdStr}`), { tag: "BrowserTabNotFound", retryable: true })

  const dm = getDebuggerManager()
  const name = operation.name
  const input = operation.input ?? {}

  // Ensure attached for CDP ops
  const needsDebugger = new Set([
    "snapshot","click","type","press","scroll","evaluate","wait_for","screenshot",
    "highlight","annotate","query","profiler_start","profiler_stop","react_inspect",
    "resize","recording_start","recording_stop","open_devtools",
  ])
  if (needsDebugger.has(name) && !dm.isAttached(tabId)) {
    await dm.attach(tabId)
  }

  switch (name) {
    case "status": {
      const tabs = await chrome.tabs.query({})
      const active = tabs.find(t => t.active)
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
      await chrome.tabs.update(tabId, { url: input.url })
      await waitForTabComplete(tabId, input.timeoutMs ?? 15000)
      const tab = await chrome.tabs.get(tabId)
      return { navigated: { tabId: String(tabId), url: tab.url ?? input.url, title: tab.title ?? "", readyState: "Success", viewport: { width: tab.width ?? 1280, height: tab.height ?? 800, dpr: 1, scrollX: 0, scrollY: 0 } } }
    }
    case "close": {
      const closeId = input.tabId ? Number.parseInt(input.tabId, 10) : tabId
      try { await dm.detach(closeId) } catch {}
      await chrome.tabs.remove(closeId)
      return { closed: { tabId: String(closeId), wasActive: true, guestsRemaining: 0 } }
    }
    case "snapshot": {
      // Use chrome.scripting to inject a11y scanner (fallback) + CDP Accessibility tree primary
      let tree = []; let elements = []; let text = ""
      try {
        const cdpTree = await dm.sendCommand(tabId, "Accessibility.getFullAXTree", {})
        tree = cdpTree?.nodes ?? []
        text = tree.map(n => n.name?.value ?? "").join(" ")
      } catch {}
      // Augment with scripting fallback if CDP tree empty
      if (tree.length === 0) {
        try {
          const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.documentElement?.outerHTML?.slice(0, 20000) ?? "" })
          text = results?.[0]?.result ?? text
        } catch {}
      }
      return { snapshot: { tabId: String(tabId), url: (await chrome.tabs.get(tabId)).url ?? "", tree, elements, text: text.slice(0, 20000), truncated: text.length > 20000, count: elements.length, viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, snapshotVersion: Date.now() } }
    }
    case "screenshot": {
      // HIDE_FOR_TOOL_USE barrier (matches annotation-overlay.ts:801-812 + contracts screenshot invariant #5):
      // 1) ask content to hide overlay (Synchronous ack barrier), 2) capture, 3) show.
      // Non-fatal if content not present — still captured without ghost.
      try { await chrome.tabs.sendMessage(tabId, { type: "opencode:hide" }) } catch {}
      // Small yield so hide display:none has been applied before capture (rAF boundary)
      await new Promise(r => requestAnimationFrame(() => r(null) as unknown as void)).catch(() => new Promise(r => setTimeout(r, 16)))
      let result
      try {
        try {
          const res = await dm.sendCommand(tabId, "Page.captureScreenshot", { format: input.format ?? "png", captureBeyondViewport: !!input.fullPage })
          result = { screenshot: { tabId: String(tabId), url: (await chrome.tabs.get(tabId)).url ?? "", title: (await chrome.tabs.get(tabId)).title ?? "", mime: input.format === "jpeg" ? "image/jpeg" : "image/png", data: res.data, width: 1280, height: 800, viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, capturedAt: Date.now() } }
        } catch {
          const winId = (await chrome.tabs.get(tabId))?.windowId
          const dataUrl = winId !== undefined
            ? await chrome.tabs.captureVisibleTab(winId, { format: input.format ?? "png" })
            : await chrome.tabs.captureVisibleTab({ format: input.format ?? "png" } as unknown as chrome.tabs.CaptureVisibleTabOptions)
          const data = (dataUrl as string).split(",")[1] ?? ""
          result = { screenshot: { tabId: String(tabId), url: "", title: "", mime: input.format === "jpeg" ? "image/jpeg" : "image/png", data, width: 1280, height: 800, viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, capturedAt: Date.now() } }
        }
      } finally {
        try { await chrome.tabs.sendMessage(tabId, { type: "opencode:show" }) } catch {}
      }
      return result
    }
    case "click": {
      const target = input.target
      const coords = await resolveTargetToCoords(tabId, target)
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
        const c = await resolveTargetToCoords(tabId, input.target)
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
      const start = Date.now()
      while (Date.now() - start < timeout) {
        if (input.condition?.type === "url") {
          const tab = await chrome.tabs.get(tabId)
          if (tab.url?.includes(input.condition.pattern)) {
            return { waited: { satisfied: true, at: { time: Date.now(), url: tab.url ?? "", title: tab.title ?? "" } } }
          }
        } else if (input.condition?.type === "text") {
          const [{ result: found }] = await chrome.scripting.executeScript({ target: { tabId }, func: (t) => document.body?.innerText?.includes(t) ?? false, args: [input.condition.text] }).catch(() => [{ result: false }])
          if (found) return { waited: { satisfied: true, at: { time: Date.now(), url: "", title: "" } } }
        }
        await new Promise(r => setTimeout(r, 100))
      }
      throw Object.assign(new Error("wait_for timeout"), { tag: "BrowserTimeout", retryable: true })
    }
    case "highlight":
    case "annotate": {
      const targets = input.targets ?? (input.target ? [{ target: input.target }] : [])
      for (const t of targets) {
        const coords = await resolveTargetToCoords(tabId, t.target)
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
          return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, center: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, visibility: r.width > 0 && r.height > 0 ? "visible" : "hidden", display: getComputedStyle(el).display, position: getComputedStyle(el).position, text: el.textContent?.slice(0, 200) ?? "" }
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

async function resolveTargetToCoords(tabId, target) {
  if (!target) return { x: 100, y: 100 }
  if (typeof target.x === "number" && typeof target.y === "number") return { x: target.x, y: target.y }
  // Locator or ref — resolve via scripting
  const locator = target.value ? target : target.locator
  const selector = locator?.value
  if (selector) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel, type) => {
          let el = null
          if (type === "css") el = document.querySelector(sel)
          else if (type === "text") el = [...document.querySelectorAll("*")].find(e => e.textContent?.includes(sel))
          else if (type === "role") el = document.querySelector(`[role="${sel}"]`)
          else if (type === "testid") el = document.querySelector(`[data-testid="${sel}"]`)
          else el = document.querySelector(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        },
        args: [selector, locator.type ?? "css"],
      })
      if (result) return result
    } catch {}
  }
  // Ref fallback — try chrome.storage-stored snapshot refs (M2)
  return { x: 100, y: 100 }
}

async function resolveActiveTabId() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  return active?.id ?? null
}

async function waitForTabComplete(tabId, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (tab?.status === "complete") return
    await new Promise(r => setTimeout(r, 200))
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
        const result = await dispatchOperation(m.request.tabId, m.request.operation, m.request.sessionId)
        sendResponse({ ok: true, requestId: m.request.requestId, result, elapsedMs: Date.now() - startedAt })
      } catch (err) {
        sendResponse({ ok: false, requestId: m.request?.requestId ?? "", elapsedMs: Date.now() - startedAt, error: toBrokerErrorBody(err) })
      }
    })()
    return true
  }
  if (m.type === "opencode:abort" && m.requestId) {
    // No per-op abort needed yet — placeholder for session abort propagation
    sendResponse({ ok: true, aborted: true })
    return false
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
        const result = await dispatchOperation(msg.request.tabId, msg.request.operation, msg.request.sessionId)
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

// Debugger events -> forward to content.js / native host as needed
chrome.debugger.onEvent.addListener((source, method, params) => {
  // Forward screencast frames etc to host if recording
})

chrome.debugger.onDetach.addListener((source, reason) => {
  console.log("[sw] debugger detached", source, reason)
})

// Keep service worker alive during native port session (offscreen fallback if needed)
// We use chrome.alarms as keepalive if available, otherwise rely on Port lifetime.
try {
  chrome.alarms?.create("keepalive", { periodInMinutes: 0.5 })
  chrome.alarms?.onAlarm.addListener(a => { if (a.name === "keepalive") void chrome.runtime.getPlatformInfo(() => {}) })
} catch {}

export { getDebuggerManager, getNativePort, handleBrokerRequest, dispatchOperation, toBrokerErrorBody }
