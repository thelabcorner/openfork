"use strict";
(() => {
  // extensions/chrome/src/shared/protocol.ts
  var NATIVE_HOST_NAME = "com.opencode.desktop";
  var NATIVE_MESSAGE_MAX_HOST_TO_EXT_BYTES = 1 * 1024 * 1024;
  var NATIVE_MESSAGE_MAX_EXT_TO_HOST_BYTES = 64 * 1024 * 1024;
  var OPERATION_NAMES = [
    "status",
    "open",
    "claim",
    "set_tab_owner",
    "navigate",
    "resize",
    "set_appearance",
    "snapshot",
    "screenshot",
    "click",
    "type",
    "press",
    "scroll",
    "evaluate",
    "wait_for",
    "recording_start",
    "recording_stop",
    "close",
    "highlight",
    "annotate",
    "query",
    "profiler_start",
    "profiler_stop",
    "react_inspect",
    "refresh",
    "duplicate",
    "set_muted",
    "open_devtools",
    "hard_reload",
    "clear_cookies",
    "clear_cache",
    "extensions_list",
    "extension_set_enabled"
  ];
  var isBrokerOperationName = (value) => typeof value === "string" && OPERATION_NAMES.includes(value);
  var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  var isBrokerRequest = (value) => {
    if (!isRecord(value)) return false;
    if (typeof value.requestId !== "string") return false;
    if (typeof value.sessionId !== "string") return false;
    if (typeof value.messageId !== "string") return false;
    if (typeof value.timeoutMs !== "number") return false;
    if (!isRecord(value.operation)) return false;
    if (!isBrokerOperationName(value.operation.name)) return false;
    if (!("input" in value.operation)) return false;
    if (value.tabId !== void 0 && typeof value.tabId !== "string") return false;
    return true;
  };

  // extensions/chrome/src/background/debugger.ts
  var DebuggerError = class extends Error {
    tag;
    retryable;
    constructor(tag, message, retryable) {
      super(message);
      this.name = tag;
      this.tag = tag;
      this.retryable = retryable;
    }
  };
  var BrowserDebuggerConflictError = class extends DebuggerError {
    constructor(message = "The guest debugger is unavailable (DevTools open or debugger already attached)") {
      super("BrowserDebuggerConflict", message, false);
    }
  };
  var BrowserNotAttachedError = class extends DebuggerError {
    constructor(message = "The browser tab is not attached via chrome.debugger") {
      super("BrowserNotAttached", message, true);
    }
  };
  var DebuggerManager = class {
    attached = /* @__PURE__ */ new Map();
    opts;
    constructor(opts) {
      this.opts = opts;
      this.opts.debuggerApi.onEvent.addListener(this.handleDebuggerEvent);
      this.opts.debuggerApi.onDetach.addListener(this.handleDebuggerDetach);
    }
    dispose() {
      this.opts.debuggerApi.onEvent.removeListener(this.handleDebuggerEvent);
      this.opts.debuggerApi.onDetach.removeListener(this.handleDebuggerDetach);
    }
    getAttachedTabIds() {
      return [...this.attached.keys()];
    }
    isAttached(tabId) {
      return this.attached.has(tabId);
    }
    getChildSessions(tabId) {
      return this.attached.get(tabId)?.childSessions;
    }
    // ---- attach / detach ----------------------------------------------------
    async attach(tabId) {
      if (this.attached.has(tabId)) return;
      await new Promise((resolve, reject) => {
        this.opts.debuggerApi.attach({ tabId }, "1.3", () => {
          const err = this.opts.runtime.lastError;
          if (err) {
            const msg = err.message ?? "unknown debugger error";
            if (/another debugger/i.test(msg) || /already attached/i.test(msg)) {
              reject(new BrowserDebuggerConflictError(msg));
            } else if (/no tab with id/i.test(msg)) {
              reject(new BrowserNotAttachedError(`No tab with id ${tabId}: ${msg}`));
            } else {
              reject(new DebuggerError("BrowserOperationFailed", msg, true));
            }
            return;
          }
          this.attached.set(tabId, { tabId, childSessions: /* @__PURE__ */ new Map() });
          this.opts.log?.("debugger attached", { tabId });
          resolve();
        });
      });
      try {
        await this.sendCommand(tabId, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }]
        });
      } catch (e) {
        this.opts.log?.("Target.setAutoAttach failed (non-fatal)", { tabId, error: String(e) });
      }
    }
    async detach(tabId) {
      const entry = this.attached.get(tabId);
      if (!entry) return;
      this.attached.delete(tabId);
      await new Promise((resolve) => {
        this.opts.debuggerApi.detach({ tabId }, () => {
          void this.opts.runtime.lastError;
          this.opts.log?.("debugger detached", { tabId });
          resolve();
        });
      });
    }
    async detachAll() {
      const ids = [...this.attached.keys()];
      await Promise.all(ids.map((id) => this.detach(id)));
    }
    // ---- sendCommand multiplex ----------------------------------------------
    async sendCommand(tabId, method, params, opts) {
      const attached = this.attached.get(tabId);
      if (!attached) throw new BrowserNotAttachedError();
      const target = opts?.sessionId ? (() => {
        const entry = [...attached.childSessions.values()].find((v) => v.targetId);
        return { tabId };
      })() : { tabId };
      const effectiveTarget = opts?.sessionId ? { tabId, sessionId: opts.sessionId } : target;
      return await new Promise((resolve, reject) => {
        ;
        this.opts.debuggerApi.sendCommand(effectiveTarget, method, params, (result) => {
          const err = this.opts.runtime.lastError;
          if (err) {
            const msg = err.message ?? `CDP ${method} failed`;
            if (/not attached/i.test(msg)) reject(new BrowserNotAttachedError(msg));
            else if (/another debugger/i.test(msg) || /already attached/i.test(msg))
              reject(new BrowserDebuggerConflictError(msg));
            else reject(new DebuggerError("BrowserOperationFailed", msg, true));
            return;
          }
          resolve(result);
        });
      });
    }
    // ---- event handlers -----------------------------------------------------
    handleDebuggerEvent = (source, method, params) => {
      if (method === "Target.attachedToTarget") {
        const p = params;
        if (!p) return;
        const entry = this.attached.get(source.tabId);
        if (!entry) return;
        entry.childSessions.set(p.sessionId, { targetId: p.targetInfo.targetId, type: p.targetInfo.type });
        this.opts.log?.("Target.attachedToTarget", {
          tabId: source.tabId,
          sessionId: p.sessionId,
          targetId: p.targetInfo.targetId,
          type: p.targetInfo.type
        });
      } else if (method === "Target.detachedFromTarget") {
        const p = params;
        if (!p) return;
        this.attached.get(source.tabId)?.childSessions.delete(p.sessionId);
        this.opts.log?.("Target.detachedFromTarget", { tabId: source.tabId, sessionId: p.sessionId });
      }
    };
    handleDebuggerDetach = (source, reason) => {
      this.attached.delete(source.tabId);
      this.opts.log?.("debugger onDetach", { tabId: source.tabId, reason });
    };
  };

  // extensions/chrome/src/background/native-port.ts
  var NativePortV2 = class {
    constructor(opts) {
      this.opts = opts;
    }
    opts;
    port = null;
    pending = /* @__PURE__ */ new Map();
    connecting = false;
    get isConnected() {
      return this.port !== null;
    }
    get pendingCount() {
      return this.pending.size;
    }
    connect() {
      if (this.port || this.connecting) return;
      this.connecting = true;
      try {
        const port = this.opts.connectNative(this.opts.hostName);
        this.port = port;
        this.connecting = false;
        port.onMessage.addListener(this.onMessage);
        port.onDisconnect.addListener(this.onDisconnect);
        this.opts.log?.("native port v2 connected", { hostName: this.opts.hostName });
      } catch (e) {
        this.connecting = false;
        this.opts.log?.("native connect v2 failed", { error: String(e) });
        throw e;
      }
    }
    disconnect() {
      if (!this.port) return;
      const port = this.port;
      this.port = null;
      try {
        port.onMessage.removeListener(this.onMessage);
        port.onDisconnect.removeListener(this.onDisconnect);
        port.disconnect();
      } catch {
      }
      for (const { timer, resolve, request } of this.pending.values()) {
        clearTimeout(timer);
        const r = { ok: false, requestId: request.requestId, error: { tag: "BrowserHostUnavailable", message: "Native host disconnected", retryable: true }, elapsedMs: 0 };
        resolve(r);
        this.opts.onResponse(r);
      }
      this.pending.clear();
    }
    send(request) {
      if (!this.port) this.connect();
      const port = this.port;
      if (!port) return Promise.resolve({ ok: false, requestId: request.requestId, error: { tag: "BrowserHostUnavailable", message: "Native host not connected", retryable: true }, elapsedMs: 0 });
      const startedAt = Date.now();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const entry = this.pending.get(request.requestId);
          if (!entry) return;
          this.pending.delete(request.requestId);
          const r = { ok: false, requestId: request.requestId, error: { tag: "BrowserTimeout", message: `request ${request.requestId} exceeded ${request.timeoutMs}ms`, retryable: true }, elapsedMs: Date.now() - startedAt };
          resolve(r);
          this.opts.onResponse(r);
        }, request.timeoutMs);
        this.pending.set(request.requestId, { request, timer, resolve });
        try {
          port.postMessage({ type: "request", request });
        } catch (e) {
          clearTimeout(timer);
          this.pending.delete(request.requestId);
          const r = { ok: false, requestId: request.requestId, error: { tag: "BrowserHostUnavailable", message: String(e), retryable: true }, elapsedMs: Date.now() - startedAt };
          resolve(r);
          this.opts.onResponse(r);
        }
      });
    }
    abort(requestId) {
      const entry = this.pending.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      const r = { ok: false, requestId, error: { tag: "BrowserControlInterrupted", message: "Request aborted by caller", retryable: true }, elapsedMs: 0 };
      entry.resolve(r);
      this.opts.onResponse(r);
      try {
        this.port?.postMessage({ type: "abort", requestId });
      } catch {
      }
    }
    respond(response) {
      try {
        this.port?.postMessage({ type: "response", response });
      } catch (e) {
        this.opts.log?.("native response send failed", { error: String(e), requestId: response.requestId });
      }
    }
    onMessage = (raw) => {
      const msg = raw;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "request" && msg.request) {
        this.opts.onRequest?.(msg.request);
      } else if (msg.type === "abort" && typeof msg.requestId === "string") {
        this.opts.onAbort?.(msg.requestId);
      } else if (msg.type === "response" && msg.response) {
        const response = msg.response;
        const entry = this.pending.get(response.requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(response.requestId);
        entry.resolve(response);
        this.opts.onResponse(response);
      } else if (msg.type === "pong" || msg.type === "hello_ack" || msg.type === "event_ack") {
        this.opts.log?.("native control", { type: msg.type });
      } else if (msg.type === "error") {
        const { requestId, code, message } = msg;
        if (requestId) {
          const entry = this.pending.get(requestId);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(requestId);
            const r = { ok: false, requestId, error: { tag: code ?? "BrowserOperationFailed", message: message ?? "host error", retryable: true }, elapsedMs: 0 };
            entry.resolve(r);
            this.opts.onResponse(r);
          }
        }
        this.opts.log?.("native host error", { code, message, requestId });
      }
    };
    onDisconnect = () => {
      const err = this.port?.error ?? new Error("native port disconnected");
      this.opts.log?.("native port disconnected v2", { error: String(err) });
      const port = this.port;
      this.port = null;
      if (port) {
        try {
          port.onMessage.removeListener(this.onMessage);
          port.onDisconnect.removeListener(this.onDisconnect);
        } catch {
        }
      }
      for (const { timer, resolve, request } of this.pending.values()) {
        clearTimeout(timer);
        const r = { ok: false, requestId: request.requestId, error: { tag: "BrowserHostUnavailable", message: "Native host disconnected", retryable: true }, elapsedMs: 0 };
        resolve(r);
        this.opts.onResponse(r);
      }
      this.pending.clear();
      this.opts.onDisconnect?.(err);
    };
  };

  // extensions/chrome/src/background/sw.ts
  function toError(tag, message, retryable, details) {
    return { tag, message, retryable, ...details ? { details } : {} };
  }
  function toBrokerErrorBody(err) {
    if (err && typeof err.tag === "string" && typeof err.message === "string" && typeof err.retryable === "boolean") {
      const out = { tag: err.tag, message: err.message, retryable: err.retryable };
      if (err.details) out.details = err.details;
      return out;
    }
    if (err instanceof Error) {
      return { tag: "BrowserOperationFailed", message: err.message, retryable: true, details: { stack: err.stack } };
    }
    return { tag: "BrowserOperationFailed", message: String(err), retryable: true };
  }
  var debuggerManager = null;
  var nativePort = null;
  var wsFallback = null;
  function getDebuggerManager() {
    if (!debuggerManager) {
      debuggerManager = new DebuggerManager({
        debuggerApi: chrome.debugger,
        runtime: chrome.runtime,
        log: (msg, meta) => console.debug(`[sw:debugger] ${msg}`, meta ?? "")
      });
    }
    return debuggerManager;
  }
  function getNativePort() {
    if (!nativePort) {
      nativePort = new NativePortV2({
        hostName: NATIVE_HOST_NAME,
        connectNative: (name) => chrome.runtime.connectNative(name),
        onResponse: () => {
        },
        onRequest: (request) => {
          void handleBrokerRequest(request, "native");
        },
        onAbort: (requestId) => console.debug("[sw:native] abort", { requestId }),
        onDisconnect: (err) => {
          console.warn("[sw:native] disconnected", err);
          setTimeout(() => {
            try {
              getNativePort().connect();
            } catch {
            }
          }, 2e3);
        },
        log: (msg, meta) => console.debug(`[sw:native] ${msg}`, meta ?? "")
      });
      try {
        nativePort.connect();
      } catch (e) {
        console.warn("[sw:native] initial connect failed", e);
      }
    }
    return nativePort;
  }
  async function handleBrokerRequest(raw, source) {
    const startedAt = Date.now();
    let requestId = "";
    try {
      if (!isBrokerRequest(raw)) {
        const resp2 = { ok: false, requestId: "", elapsedMs: Date.now() - startedAt, error: toError("BrowserOperationFailed", "Invalid BrokerRequest envelope", true) };
        reply(source, resp2);
        return;
      }
      const req = raw;
      requestId = req.requestId;
      const result = await dispatchOperation(req.tabId, req.operation, req.sessionId);
      const resp = { ok: true, requestId, result, elapsedMs: Date.now() - startedAt };
      reply(source, resp);
    } catch (err) {
      const resp = { ok: false, requestId, elapsedMs: Date.now() - startedAt, error: toBrokerErrorBody(err) };
      reply(source, resp);
    }
  }
  function reply(source, response) {
    if (source === "native") {
      getNativePort().respond(response);
    } else if (source === "ws") {
      wsFallback?.send({ type: "result", response });
    }
  }
  async function dispatchOperation(tabIdStr, operation, sessionId) {
    const tabId = tabIdStr ? Number.parseInt(tabIdStr, 10) : await resolveActiveTabId();
    if (!Number.isFinite(tabId)) throw Object.assign(new Error(`Invalid tabId ${tabIdStr}`), { tag: "BrowserTabNotFound", retryable: true });
    const dm = getDebuggerManager();
    const name = operation.name;
    const input = operation.input ?? {};
    const needsDebugger = /* @__PURE__ */ new Set([
      "snapshot",
      "click",
      "type",
      "press",
      "scroll",
      "evaluate",
      "wait_for",
      "screenshot",
      "highlight",
      "annotate",
      "query",
      "profiler_start",
      "profiler_stop",
      "react_inspect",
      "resize",
      "recording_start",
      "recording_stop",
      "open_devtools"
    ]);
    if (needsDebugger.has(name) && !dm.isAttached(tabId)) {
      await dm.attach(tabId);
    }
    switch (name) {
      case "status": {
        const tabs = await chrome.tabs.query({});
        const active = tabs.find((t) => t.active);
        return {
          status: {
            connected: true,
            host: { hostId: "chrome-ext", protocolVersion: 2, hostEpoch: 1 },
            guest: active ? { windowId: String(active.windowId), state: "attached", activeTab: { tabId: String(active.id), url: active.url ?? "", title: active.title ?? "", readyState: active.status === "complete" ? "Success" : "Loading", viewport: { width: active.width ?? 1280, height: active.height ?? 800, dpr: 1, scrollX: 0, scrollY: 0 } } } : void 0,
            appearance: "system",
            recording: { active: false }
          },
          tabs: tabs.map((t) => ({ tabId: String(t.id), url: t.url ?? "", title: t.title ?? "", active: !!t.active, owner: { kind: "user" }, muted: !!t.mutedInfo?.muted }))
        };
      }
      case "open": {
        const url = input.url;
        if (!url) throw Object.assign(new Error("open requires url"), { tag: "BrowserInvalidSelector" });
        let targetTabId = tabIdStr;
        if (input.newTab || !tabIdStr) {
          const created = await chrome.tabs.create({ url, active: input.activate ?? true });
          targetTabId = String(created.id);
          if (chrome.tabGroups) {
            try {
              const groupId = await chrome.tabs.group({ tabIds: created.id });
              await chrome.tabGroups.update(groupId, { title: `opencode \u2014 ${sessionId.slice(0, 8)}`, color: "blue" });
            } catch {
            }
          }
        } else {
          await chrome.tabs.update(Number.parseInt(targetTabId, 10), { url });
        }
        const tab = await chrome.tabs.get(Number.parseInt(targetTabId, 10));
        return { opened: { tabId: targetTabId, url: tab.url ?? url, title: tab.title ?? "", readyState: "Loading", viewport: { width: tab.width ?? 1280, height: tab.height ?? 800, dpr: 1, scrollX: 0, scrollY: 0 }, owner: { kind: "agent", sessionId } } };
      }
      case "claim": {
        return { claimed: { tabId: String(tabId), owner: { kind: "agent", sessionId } } };
      }
      case "set_tab_owner": {
        const owner = input.owner;
        if (!owner || owner.kind !== "user" && !(owner.kind === "agent" && typeof owner.sessionId === "string")) {
          throw Object.assign(new Error("set_tab_owner requires a valid owner"), { tag: "BrowserOperationFailed", retryable: false });
        }
        return { assigned: { tabId: String(tabId), owner } };
      }
      case "navigate": {
        await chrome.tabs.update(tabId, { url: input.url });
        await waitForTabComplete(tabId, input.timeoutMs ?? 15e3);
        const tab = await chrome.tabs.get(tabId);
        return { navigated: { tabId: String(tabId), url: tab.url ?? input.url, title: tab.title ?? "", readyState: "Success", viewport: { width: tab.width ?? 1280, height: tab.height ?? 800, dpr: 1, scrollX: 0, scrollY: 0 } } };
      }
      case "close": {
        const closeId = input.tabId ? Number.parseInt(input.tabId, 10) : tabId;
        try {
          await dm.detach(closeId);
        } catch {
        }
        await chrome.tabs.remove(closeId);
        return { closed: { tabId: String(closeId), wasActive: true, guestsRemaining: 0 } };
      }
      case "snapshot": {
        let tree = [];
        let elements = [];
        let text = "";
        try {
          const cdpTree = await dm.sendCommand(tabId, "Accessibility.getFullAXTree", {});
          tree = cdpTree?.nodes ?? [];
          text = tree.map((n) => n.name?.value ?? "").join(" ");
        } catch {
        }
        if (tree.length === 0) {
          try {
            const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.documentElement?.outerHTML?.slice(0, 2e4) ?? "" });
            text = results?.[0]?.result ?? text;
          } catch {
          }
        }
        return { snapshot: { tabId: String(tabId), url: (await chrome.tabs.get(tabId)).url ?? "", tree, elements, text: text.slice(0, 2e4), truncated: text.length > 2e4, count: elements.length, viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, snapshotVersion: Date.now() } };
      }
      case "screenshot": {
        try {
          await chrome.tabs.sendMessage(tabId, { type: "opencode:hide" });
        } catch {
        }
        await new Promise((r) => requestAnimationFrame(() => r(null))).catch(() => new Promise((r) => setTimeout(r, 16)));
        let result;
        try {
          try {
            const res = await dm.sendCommand(tabId, "Page.captureScreenshot", { format: input.format ?? "png", captureBeyondViewport: !!input.fullPage });
            result = { screenshot: { tabId: String(tabId), url: (await chrome.tabs.get(tabId)).url ?? "", title: (await chrome.tabs.get(tabId)).title ?? "", mime: input.format === "jpeg" ? "image/jpeg" : "image/png", data: res.data, width: 1280, height: 800, viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, capturedAt: Date.now() } };
          } catch {
            const winId = (await chrome.tabs.get(tabId))?.windowId;
            const dataUrl = winId !== void 0 ? await chrome.tabs.captureVisibleTab(winId, { format: input.format ?? "png" }) : await chrome.tabs.captureVisibleTab({ format: input.format ?? "png" });
            const data = dataUrl.split(",")[1] ?? "";
            result = { screenshot: { tabId: String(tabId), url: "", title: "", mime: input.format === "jpeg" ? "image/jpeg" : "image/png", data, width: 1280, height: 800, viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, capturedAt: Date.now() } };
          }
        } finally {
          try {
            await chrome.tabs.sendMessage(tabId, { type: "opencode:show" });
          } catch {
          }
        }
        return result;
      }
      case "click": {
        const target = input.target;
        const coords = await resolveTargetToCoords(tabId, target);
        try {
          await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: coords.x, y: coords.y });
        } catch {
        }
        try {
          await chrome.tabs.sendMessage(tabId, { type: "opencode:cursor", x: coords.x, y: coords.y, phase: "move", sequence: input.sequence });
        } catch {
        }
        await new Promise((r) => setTimeout(r, 160));
        try {
          await chrome.tabs.sendMessage(tabId, { type: "opencode:cursor", x: coords.x, y: coords.y, phase: "click", sequence: input.sequence });
        } catch {
        }
        await new Promise((r) => setTimeout(r, 40));
        const button = input.button ?? "left";
        const clickCount = input.clickCount ?? 1;
        const modifiers = Array.isArray(input.modifiers) ? input.modifiers : [];
        void modifiers;
        await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: coords.x, y: coords.y, button, clickCount });
        await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.x, y: coords.y, button, clickCount });
        return { clicked: { target: { kind: "coords", center: coords }, coords, clickCount } };
      }
      case "type": {
        const text = input.text ?? "";
        if (input.target) {
          const c = await resolveTargetToCoords(tabId, input.target);
          await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
          await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
        }
        if (input.clear) {
          await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
          await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
          await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
          await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
        }
        if (text) {
          await dm.sendCommand(tabId, "Runtime.evaluate", { expression: `(() => { const el=document.activeElement; if(el && (el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.isContentEditable)){ if(el.isContentEditable) document.execCommand('insertText', false, ${JSON.stringify(text)}); else { el.value+=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } } return true })()`, awaitPromise: false });
        }
        if (input.submit) {
          await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
          await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
        }
        return { typed: { value: text, caret: { selectionStart: text.length, selectionEnd: text.length }, submitted: !!input.submit } };
      }
      case "press": {
        const key = input.key;
        await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key, code: key });
        await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
        return { pressed: { key, repeat: false, modifiers: [] } };
      }
      case "scroll": {
        if (input.delta) {
          await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: input.delta.x ?? 0, deltaY: input.delta.y ?? 0 });
        } else if (input.to === "top") {
          await dm.sendCommand(tabId, "Runtime.evaluate", { expression: "window.scrollTo(0,0)" });
        } else if (input.to === "bottom") {
          await dm.sendCommand(tabId, "Runtime.evaluate", { expression: "window.scrollTo(0, document.body.scrollHeight)" });
        }
        return { scrolled: { viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, scrollX: 0, scrollY: 0 } };
      }
      case "evaluate": {
        const res = await dm.sendCommand(tabId, "Runtime.evaluate", { expression: input.script, awaitPromise: !!input.awaitPromise, returnByValue: true });
        const result = res.result?.value ?? res.result ?? null;
        const type = typeof result;
        return { evaluated: { result, type, truncated: false } };
      }
      case "wait_for": {
        const timeout = input.timeoutMs ?? 5e3;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (input.condition?.type === "url") {
            const tab = await chrome.tabs.get(tabId);
            if (tab.url?.includes(input.condition.pattern)) {
              return { waited: { satisfied: true, at: { time: Date.now(), url: tab.url ?? "", title: tab.title ?? "" } } };
            }
          } else if (input.condition?.type === "text") {
            const [{ result: found }] = await chrome.scripting.executeScript({ target: { tabId }, func: (t) => document.body?.innerText?.includes(t) ?? false, args: [input.condition.text] }).catch(() => [{ result: false }]);
            if (found) return { waited: { satisfied: true, at: { time: Date.now(), url: "", title: "" } } };
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw Object.assign(new Error("wait_for timeout"), { tag: "BrowserTimeout", retryable: true });
      }
      case "highlight":
      case "annotate": {
        const targets = input.targets ?? (input.target ? [{ target: input.target }] : []);
        for (const t of targets) {
          const coords = await resolveTargetToCoords(tabId, t.target);
          try {
            await chrome.tabs.sendMessage(tabId, { type: "opencode:highlight", rect: { x: coords.x - 20, y: coords.y - 10, width: 40, height: 20 }, label: t.label, tone: t.tone });
          } catch {
          }
        }
        if (input.clear) try {
          await chrome.tabs.sendMessage(tabId, { type: "opencode:clear" });
        } catch {
        }
        return { annotated: { tabId: String(tabId), count: targets.length, cleared: !!input.clear, at: { time: Date.now() } } };
      }
      case "query": {
        const selector = input.target?.value ?? input.selector ?? "*";
        const results = await chrome.scripting.executeScript({ target: { tabId }, func: (sel, max) => {
          const els = [...document.querySelectorAll(sel)].slice(0, max ?? 20);
          return els.map((el) => {
            const r = el.getBoundingClientRect();
            return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, center: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, visibility: r.width > 0 && r.height > 0 ? "visible" : "hidden", display: getComputedStyle(el).display, position: getComputedStyle(el).position, text: el.textContent?.slice(0, 200) ?? "" };
          });
        }, args: [selector, input.maxResults ?? 20] }).catch(() => [{ result: [] }]);
        const matches = results?.[0]?.result ?? [];
        return { queried: { tabId: String(tabId), url: (await chrome.tabs.get(tabId)).url ?? "", matches, count: matches.length, truncated: matches.length >= (input.maxResults ?? 20) } };
      }
      case "resize": {
        await dm.sendCommand(tabId, "Emulation.setDeviceMetricsOverride", { width: input.width, height: input.height, deviceScaleFactor: input.deviceScaleFactor ?? 1, mobile: false });
        return { resized: { width: input.width, height: input.height, dpr: input.deviceScaleFactor ?? 1, actualWidth: input.width, actualHeight: input.height } };
      }
      case "set_appearance": {
        const scheme = input.appearance === "dark" ? "dark" : input.appearance === "light" ? "light" : "no-preference";
        try {
          await dm.sendCommand(tabId, "Emulation.setEmulatedMedia", { media: "prefers-color-scheme", features: [{ name: "prefers-color-scheme", value: scheme }] });
        } catch {
        }
        return { appearance: input.appearance, effective: scheme === "dark" ? "dark" : "light" };
      }
      default:
        throw Object.assign(new Error(`Unsupported operation ${name} in extension lane`), { tag: "BrowserUnsupportedOperation", retryable: false });
    }
  }
  async function resolveTargetToCoords(tabId, target) {
    if (!target) return { x: 100, y: 100 };
    if (typeof target.x === "number" && typeof target.y === "number") return { x: target.x, y: target.y };
    const locator = target.value ? target : target.locator;
    const selector = locator?.value;
    if (selector) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel, type) => {
            let el = null;
            if (type === "css") el = document.querySelector(sel);
            else if (type === "text") el = [...document.querySelectorAll("*")].find((e) => e.textContent?.includes(sel));
            else if (type === "role") el = document.querySelector(`[role="${sel}"]`);
            else if (type === "testid") el = document.querySelector(`[data-testid="${sel}"]`);
            else el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          },
          args: [selector, locator.type ?? "css"]
        });
        if (result) return result;
      } catch {
      }
    }
    return { x: 100, y: 100 };
  }
  async function resolveActiveTabId() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return active?.id ?? null;
  }
  async function waitForTabComplete(tabId, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status === "complete") return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  chrome.runtime.onInstalled.addListener(() => {
    console.log("[sw] installed", chrome.runtime.getManifest().version);
    try {
      getNativePort().connect();
    } catch {
    }
  });
  chrome.runtime.onStartup.addListener(() => {
    try {
      getNativePort().connect();
    } catch {
    }
  });
  try {
    getNativePort().connect();
  } catch {
  }
  if (chrome.runtime.onConnectNative) {
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const m = msg;
    if (!m || typeof m !== "object") return;
    if (m.type === "opencode:request" && m.request) {
      void (async () => {
        const startedAt = Date.now();
        try {
          if (!isBrokerRequest(m.request)) throw Object.assign(new Error("Invalid BrokerRequest"), { tag: "BrowserOperationFailed" });
          const result = await dispatchOperation(m.request.tabId, m.request.operation, m.request.sessionId);
          sendResponse({ ok: true, requestId: m.request.requestId, result, elapsedMs: Date.now() - startedAt });
        } catch (err) {
          sendResponse({ ok: false, requestId: m.request?.requestId ?? "", elapsedMs: Date.now() - startedAt, error: toBrokerErrorBody(err) });
        }
      })();
      return true;
    }
    if (m.type === "opencode:abort" && m.requestId) {
      sendResponse({ ok: true, aborted: true });
      return false;
    }
    if (m.type === "opencode:ping") {
      sendResponse({ pong: true, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
      return false;
    }
  });
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "opencode:request" && msg.request) {
      void (async () => {
        const startedAt = Date.now();
        try {
          const result = await dispatchOperation(msg.request.tabId, msg.request.operation, msg.request.sessionId);
          sendResponse({ ok: true, requestId: msg.request.requestId, result, elapsedMs: Date.now() - startedAt });
        } catch (err) {
          sendResponse({ ok: false, requestId: msg.request?.requestId ?? "", elapsedMs: Date.now() - startedAt, error: toBrokerErrorBody(err) });
        }
      })();
      return true;
    }
    if (msg?.type === "opencode:health") {
      sendResponse({ ok: true, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
      return false;
    }
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    console.log("[sw] debugger detached", source, reason);
  });
  try {
    chrome.alarms?.create("keepalive", { periodInMinutes: 0.5 });
    chrome.alarms?.onAlarm.addListener((a) => {
      if (a.name === "keepalive") void chrome.runtime.getPlatformInfo(() => {
      });
    });
  } catch {
  }
})();
