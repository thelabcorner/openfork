(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };

  // src/background/sw.ts
  var exports_sw = {};
  __export(exports_sw, {
    toBrokerErrorBody: () => toBrokerErrorBody,
    handleBrokerRequest: () => handleBrokerRequest,
    getNativePort: () => getNativePort,
    getDebuggerManager: () => getDebuggerManager,
    getActiveTabIconController: () => getActiveTabIconController,
    dispatchOperation: () => dispatchOperation
  });

  // src/shared/protocol.ts
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
    "visual_capture",
    "visual_diff",
    "visual_record",
    "visual_history",
    "visual_artifact",
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
    if (!isRecord(value))
      return false;
    if (typeof value.requestId !== "string" || value.requestId.length === 0)
      return false;
    if (typeof value.sessionId !== "string" || value.sessionId.length === 0)
      return false;
    if (typeof value.windowId !== "string" || value.windowId.length === 0)
      return false;
    if (typeof value.messageId !== "string" || value.messageId.length === 0)
      return false;
    if (value.workspaceId !== undefined && typeof value.workspaceId !== "string")
      return false;
    if (value.directory !== undefined && typeof value.directory !== "string")
      return false;
    if (value.toolCallId !== undefined && typeof value.toolCallId !== "string")
      return false;
    if (typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0)
      return false;
    if (!isRecord(value.operation))
      return false;
    if (!isBrokerOperationName(value.operation.name))
      return false;
    if (!("input" in value.operation))
      return false;
    if (value.tabId !== undefined && typeof value.tabId !== "string")
      return false;
    return true;
  };

  // src/background/debugger.ts
  class DebuggerError extends Error {
    tag;
    retryable;
    constructor(tag, message, retryable) {
      super(message);
      this.name = tag;
      this.tag = tag;
      this.retryable = retryable;
    }
  }

  class BrowserDebuggerConflictError extends DebuggerError {
    constructor(message = "The guest debugger is unavailable (DevTools open or debugger already attached)") {
      super("BrowserDebuggerConflict", message, false);
    }
  }

  class BrowserNotAttachedError extends DebuggerError {
    constructor(message = "The browser tab is not attached via chrome.debugger") {
      super("BrowserNotAttached", message, true);
    }
  }

  class DebuggerManager {
    attached = new Map;
    attaching = new Map;
    opts;
    constructor(opts) {
      this.opts = opts;
      this.opts.debuggerApi.onDetach.addListener(this.handleDebuggerDetach);
    }
    dispose() {
      this.opts.debuggerApi.onDetach.removeListener(this.handleDebuggerDetach);
    }
    getAttachedTabIds() {
      return [...this.attached.keys()];
    }
    isAttached(tabId) {
      return this.attached.has(tabId);
    }
    async attach(tabId) {
      if (this.attached.has(tabId))
        return;
      const pending = this.attaching.get(tabId);
      if (pending)
        return pending;
      const attach = new Promise((resolve, reject) => {
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
          this.attached.set(tabId, { tabId });
          this.opts.log?.("debugger attached", { tabId });
          resolve();
        });
      });
      this.attaching.set(tabId, attach);
      try {
        await attach;
      } finally {
        if (this.attaching.get(tabId) === attach)
          this.attaching.delete(tabId);
      }
    }
    async detach(tabId) {
      const pending = this.attaching.get(tabId);
      if (pending)
        await pending.catch(() => {
          return;
        });
      const entry = this.attached.get(tabId);
      if (!entry)
        return;
      this.attached.delete(tabId);
      await new Promise((resolve) => {
        this.opts.debuggerApi.detach({ tabId }, () => {
          this.opts.runtime.lastError;
          this.opts.log?.("debugger detached", { tabId });
          resolve();
        });
      });
    }
    async detachAll() {
      const ids = [...this.attached.keys()];
      await Promise.all(ids.map((id) => this.detach(id)));
    }
    async sendCommand(tabId, method, params, opts) {
      if (!this.attached.has(tabId))
        throw new BrowserNotAttachedError;
      const effectiveTarget = opts?.sessionId ? { tabId, sessionId: opts.sessionId } : { tabId };
      return await new Promise((resolve, reject) => {
        this.opts.debuggerApi.sendCommand(effectiveTarget, method, params, (result) => {
          const err = this.opts.runtime.lastError;
          if (err) {
            const msg = err.message ?? `CDP ${method} failed`;
            if (/not attached/i.test(msg))
              reject(new BrowserNotAttachedError(msg));
            else if (/another debugger/i.test(msg) || /already attached/i.test(msg))
              reject(new BrowserDebuggerConflictError(msg));
            else
              reject(new DebuggerError("BrowserOperationFailed", msg, true));
            return;
          }
          resolve(result);
        });
      });
    }
    handleDebuggerDetach = (source, reason) => {
      this.attached.delete(source.tabId);
      this.opts.log?.("debugger onDetach", { tabId: source.tabId, reason });
    };
  }

  // src/background/native-port.ts
  class NativePortV2 {
    opts;
    port = null;
    pending = new Map;
    pendingArtifact = new Map;
    connecting = false;
    constructor(opts) {
      this.opts = opts;
    }
    get isConnected() {
      return this.port !== null;
    }
    get pendingCount() {
      return this.pending.size;
    }
    get pendingArtifactCount() {
      return this.pendingArtifact.size;
    }
    connect() {
      if (this.port || this.connecting)
        return;
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
      if (!this.port)
        return;
      const port = this.port;
      this.port = null;
      try {
        port.onMessage.removeListener(this.onMessage);
        port.onDisconnect.removeListener(this.onDisconnect);
        port.disconnect();
      } catch {}
      this.failPending("Native host disconnected");
    }
    send(request) {
      if (!this.port)
        this.connect();
      const port = this.port;
      if (!port)
        return Promise.resolve({ ok: false, requestId: request.requestId, error: { tag: "BrowserHostUnavailable", message: "Native host not connected", retryable: true }, elapsedMs: 0 });
      const startedAt = Date.now();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const entry = this.pending.get(request.requestId);
          if (!entry)
            return;
          this.pending.delete(request.requestId);
          const r = { ok: false, requestId: request.requestId, error: { tag: "BrowserTimeout", message: `request ${request.requestId} exceeded ${request.timeoutMs}ms`, retryable: true }, elapsedMs: Date.now() - startedAt };
          resolve(r);
          this.opts.onResponse?.(r);
        }, request.timeoutMs);
        this.pending.set(request.requestId, { request, timer, resolve });
        try {
          port.postMessage({ type: "request", request });
        } catch (e) {
          clearTimeout(timer);
          this.pending.delete(request.requestId);
          const r = { ok: false, requestId: request.requestId, error: { tag: "BrowserHostUnavailable", message: String(e), retryable: true }, elapsedMs: Date.now() - startedAt };
          resolve(r);
          this.opts.onResponse?.(r);
        }
      });
    }
    abort(requestId) {
      const entry = this.pending.get(requestId);
      if (!entry)
        return;
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      const r = { ok: false, requestId, error: { tag: "BrowserControlInterrupted", message: "Request aborted by caller", retryable: true }, elapsedMs: 0 };
      entry.resolve(r);
      this.opts.onResponse?.(r);
      try {
        this.port?.postMessage({ type: "abort", requestId });
      } catch {}
    }
    artifactRpc(request, timeoutMs = 30000) {
      if (!request?.id)
        return Promise.reject(new Error("visual artifact RPC requires an id"));
      if (!this.port)
        this.connect();
      const port = this.port;
      if (!port)
        return Promise.reject(new Error("Native host not connected"));
      if (this.pendingArtifact.has(request.id))
        return Promise.reject(new Error(`duplicate visual artifact RPC id ${request.id}`));
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const entry = this.pendingArtifact.get(request.id);
          if (!entry)
            return;
          this.pendingArtifact.delete(request.id);
          resolve({ ok: false, id: request.id, error: { code: "VISUAL_TIMEOUT", message: `Visual artifact RPC ${request.id} timed out` } });
        }, Math.max(1, timeoutMs));
        this.pendingArtifact.set(request.id, { timer, resolve });
        try {
          port.postMessage({ type: "artifact_rpc", request });
        } catch (error) {
          clearTimeout(timer);
          this.pendingArtifact.delete(request.id);
          resolve({ ok: false, id: request.id, error: { code: "VISUAL_HOST_UNAVAILABLE", message: String(error) } });
        }
      });
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
      if (!msg || typeof msg !== "object")
        return;
      if (msg.type === "request" && msg.request) {
        this.opts.onRequest?.(msg.request);
      } else if (msg.type === "abort" && typeof msg.requestId === "string") {
        this.opts.onAbort?.(msg.requestId);
      } else if (msg.type === "response" && msg.response) {
        const response = msg.response;
        const entry = this.pending.get(response.requestId);
        if (!entry)
          return;
        clearTimeout(entry.timer);
        this.pending.delete(response.requestId);
        entry.resolve(response);
        this.opts.onResponse?.(response);
      } else if (msg.type === "artifact_rpc_result" && msg.response) {
        const response = msg.response;
        if (typeof response.id !== "string")
          return;
        const entry = this.pendingArtifact.get(response.id);
        if (!entry)
          return;
        clearTimeout(entry.timer);
        this.pendingArtifact.delete(response.id);
        entry.resolve(msg.response);
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
            this.opts.onResponse?.(r);
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
        } catch {}
      }
      this.failPending("Native host disconnected");
      this.opts.onDisconnect?.(err);
    };
    failPending(message) {
      for (const { timer, resolve, request } of this.pending.values()) {
        clearTimeout(timer);
        const response = {
          ok: false,
          requestId: request.requestId,
          error: { tag: "BrowserHostUnavailable", message, retryable: true },
          elapsedMs: 0
        };
        resolve(response);
        this.opts.onResponse?.(response);
      }
      this.pending.clear();
      for (const [id, { timer, resolve }] of this.pendingArtifact) {
        clearTimeout(timer);
        resolve({ ok: false, id, error: { code: "VISUAL_HOST_UNAVAILABLE", message } });
      }
      this.pendingArtifact.clear();
    }
  }

  // src/background/active-tab-icon.ts
  var ACTIVE_TAB_ICON_MESSAGE = "opencode:active-tab-icon";

  class ActiveTabIconController {
    tabs;
    log;
    activeByWindow = new Map;
    started = false;
    epoch = 0;
    constructor(tabs, log) {
      this.tabs = tabs;
      this.log = log;
    }
    async start() {
      if (this.started)
        return;
      this.started = true;
      this.tabs.onActivated.addListener(this.onActivated);
      this.tabs.onUpdated.addListener(this.onUpdated);
      this.tabs.onRemoved.addListener(this.onRemoved);
      const epoch = this.epoch;
      const active = await this.tabs.query({ active: true }).catch(() => []);
      if (!this.started || this.epoch !== epoch)
        return;
      for (const tab of active) {
        if (tab.id === undefined || tab.windowId === undefined)
          continue;
        this.setWindowActive(tab.windowId, tab.id);
      }
    }
    stop() {
      if (!this.started)
        return;
      this.started = false;
      this.epoch++;
      this.tabs.onActivated.removeListener(this.onActivated);
      this.tabs.onUpdated.removeListener(this.onUpdated);
      this.tabs.onRemoved.removeListener(this.onRemoved);
      for (const tabId of this.activeByWindow.values())
        this.send(tabId, false);
      this.activeByWindow.clear();
    }
    onActivated = ({ tabId, windowId }) => {
      this.epoch++;
      this.setWindowActive(windowId, tabId);
    };
    onUpdated = (tabId, changeInfo) => {
      if (changeInfo.status !== "complete")
        return;
      for (const activeId of this.activeByWindow.values()) {
        if (activeId !== tabId)
          continue;
        this.send(tabId, true);
        return;
      }
    };
    onRemoved = (tabId, { windowId }) => {
      if (this.activeByWindow.get(windowId) !== tabId)
        return;
      this.epoch++;
      this.activeByWindow.delete(windowId);
    };
    setWindowActive(windowId, tabId) {
      const previous = this.activeByWindow.get(windowId);
      if (previous === tabId) {
        this.send(tabId, true);
        return;
      }
      if (previous !== undefined)
        this.send(previous, false);
      this.activeByWindow.set(windowId, tabId);
      this.send(tabId, true);
    }
    send(tabId, active) {
      this.tabs.sendMessage(tabId, { type: ACTIVE_TAB_ICON_MESSAGE, active }).catch((error) => this.log?.("active-tab icon message skipped", { tabId, active, error: String(error) }));
    }
  }

  // src/background/tab-waits.ts
  function createTabWait(tabs, tabId, timeoutMs, matches) {
    let finish = () => {};
    const done = new Promise((resolve) => {
      let settled = false;
      const onUpdated = (updatedTabId, changeInfo, tab) => {
        if (updatedTabId === tabId && matches(changeInfo, tab))
          finish(tab);
      };
      const onRemoved = (removedTabId) => {
        if (removedTabId === tabId)
          finish(null);
      };
      const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
      finish = (tab) => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timer);
        tabs.onUpdated.removeListener(onUpdated);
        tabs.onRemoved.removeListener(onRemoved);
        resolve(tab);
      };
      tabs.onUpdated.addListener(onUpdated);
      tabs.onRemoved.addListener(onRemoved);
    });
    return { done, finish };
  }
  async function waitForTabComplete(tabs, tabId, timeoutMs) {
    const wait = createTabWait(tabs, tabId, timeoutMs, (changeInfo, tab) => changeInfo.status === "complete" || tab.status === "complete");
    const current = await tabs.get(tabId).catch(() => null);
    if (!current || current.status === "complete")
      wait.finish(current);
    await wait.done;
  }
  async function waitForUrl(tabs, tabId, pattern, timeoutMs) {
    const wait = createTabWait(tabs, tabId, timeoutMs, (changeInfo, tab) => (changeInfo.url ?? tab.url ?? "").includes(pattern));
    const current = await tabs.get(tabId).catch(() => null);
    if (!current || current.url?.includes(pattern))
      wait.finish(current);
    return wait.done;
  }

  // src/background/dispatch-policy.ts
  var ALWAYS_DEBUGGER_OPERATIONS = new Set([
    "snapshot",
    "screenshot",
    "click",
    "type",
    "press",
    "scroll",
    "evaluate",
    "resize",
    "set_appearance"
  ]);
  var VISUAL_OPERATIONS = new Set(["visual_capture", "visual_diff", "visual_record"]);
  function operationNeedsDebugger(name, input) {
    if (ALWAYS_DEBUGGER_OPERATIONS.has(name))
      return true;
    if (!VISUAL_OPERATIONS.has(name) || !input || typeof input !== "object")
      return false;
    const target = input.target;
    return !!target && typeof target === "object" && target.kind === "element";
  }

  // ../../packages/desktop/src/main/browser/contracts.ts
  var MAX_VISIBLE_TEXT_LENGTH = 20000;
  var MAX_INTERACTIVE_ELEMENTS = 200;
  var RECORDING_FRAME_INTERVAL_MS = Math.ceil(1000 / 12);
  var RECORDING_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
  // ../../packages/desktop/src/main/browser/scripts-resolve.ts
  function synthesizeSelectorScript() {
    return String.raw`
    (function synthesizeSelector(el) {
      const escape = (v) => CSS.escape(String(v));
      if (el.dataset && el.dataset.testid) return { selector: '[data-testid="' + escape(el.dataset.testid) + '"]', kind: 'testid', confidence: 'high' };
      if (el.id) return { selector: '#' + escape(el.id), kind: 'id', confidence: 'high' };
      const label = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-label'));
      if (label) return { selector: '[aria-label="' + escape(label) + '"]', kind: 'aria', confidence: 'high' };
      const role = el.getAttribute && el.getAttribute('role');
      const name = (el.getAttribute && el.getAttribute('aria-label')) || (el.textContent || '').trim().slice(0, 80);
      if (role && name) return { selector: '[role="' + escape(role) + '"][aria-label="' + escape(name) + '"]', kind: 'role-name', confidence: 'med' };
      let chain = [];
      let node = el;
      for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
        chain.unshift(part);
        node = parent;
      }
      return { selector: chain.join(' > '), kind: 'structural', confidence: 'low' };
    })
  `;
  }
  function visibleFilterSource(includeHidden) {
    if (includeHidden)
      return "";
    return `if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) { const cs = window.getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return null; }`;
  }
  function findLocatorExpression(locator, filter = "") {
    const value = JSON.stringify(locator.value);
    switch (locator.type) {
      case "css":
        return `function() {
        let el;
        try { el = document.querySelector(${value}); } catch (e) { throw new Error('Invalid css selector: ' + e.message); }
        if (!el) return null;
        ${filter}
        return el;
      }`;
      case "testid":
        return `function() {
        const el = document.querySelector('[data-testid="' + CSS.escape(${value}) + '"]');
        if (!el) return null;
        ${filter}
        return el;
      }`;
      case "xpath":
        return `function() {
        let el = null;
        try {
          const res = document.evaluate(${value}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          el = res.singleNodeValue;
        } catch (e) { throw new Error('Invalid xpath: ' + e.message); }
        if (!el || el.nodeType !== 1) return null;
        ${filter}
        return el;
      }`;
      case "placeholder":
        return `function() {
        const el = Array.prototype.find.call(document.querySelectorAll('input,textarea'), (n) => (n.getAttribute('placeholder') || '') === ${value});
        if (!el) return null;
        ${filter}
        return el;
      }`;
      case "label":
        return `function() {
        let el = null;
        const label = Array.prototype.find.call(document.querySelectorAll('label'), (n) => (n.textContent || '').trim() === ${value});
        if (label) {
          if (label.htmlFor) el = document.getElementById(label.htmlFor);
          if (!el) el = label.querySelector('input,textarea,select,button');
        }
        if (!el) {
          el = Array.prototype.find.call(document.querySelectorAll('input,textarea,select'), (n) => {
            const id = n.id;
            if (!id) return false;
            const l = document.querySelector('label[for="' + CSS.escape(id) + '"]');
            return l !== null && (l.textContent || '').trim() === ${value};
          });
        }
        if (!el) return null;
        ${filter}
        return el;
      }`;
      case "text":
        return `function() {
        const exact = ${JSON.stringify(locator.exact ?? false)};
        const el = Array.prototype.find.call(document.querySelectorAll('a[href],button,input,textarea,select,[role],[tabindex]'), (n) => {
          const text = (n.innerText || n.textContent || (n.value != null ? String(n.value) : '') || '').trim();
          if (exact) return text === ${value};
          return text.includes(${value});
        });
        if (!el) return null;
        ${filter}
        return el;
      }`;
      case "role":
      case "name":
        return `function() {
        const exact = ${JSON.stringify(locator.exact ?? false)};
        const wantedRole = ${locator.type === "role" ? value : "null"};
        const wantedName = ${locator.type === "name" ? value : "null"};
        const q = ${locator.type === "role" ? `'[role],a[href],button,input,textarea,select'` : `'a[href],button,input,textarea,select,[role]'`};
        const el = Array.prototype.find.call(document.querySelectorAll(q), (n) => {
          const role = n.getAttribute ? (n.getAttribute('role') || (n.tagName === 'A' && n.href ? 'link' : n.tagName === 'BUTTON' ? 'button' : null)) : null;
          const name = (n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('data-label'))) || (n.innerText || n.textContent || (n.value != null ? String(n.value) : '') || '').trim();
          if (wantedRole && role !== wantedRole) return false;
          if (wantedName != null && name != null) {
            if (exact) return name === wantedName;
            return name.includes(wantedName);
          }
          return wantedName == null;
        });
        if (!el) return null;
        ${filter}
        return el;
      }`;
    }
  }
  function findCoordsExpression(x, y) {
    return `function() {
    const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    return el ? (el.closest('a[href],button,input,textarea,select,[role],[tabindex]') || el) : null;
  }`;
  }
  function resolveElementScript(target, includeHidden = false) {
    const find = "value" in target ? findLocatorExpression(target, visibleFilterSource(includeHidden)) : findCoordsExpression(target.x, target.y);
    return `(() => {
    const find = ${find};
    let el;
    try { el = find(); } catch (e) { return { error: e.message }; }
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && cs.display !== 'none' && cs.visibility !== 'hidden';
    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute ? (el.getAttribute('role') || (tagName === 'a' && el.href ? 'link' : tagName === 'button' ? 'button' : tagName === 'input' || tagName === 'textarea' || tagName === 'select' ? tagName : null)) : null;
    const name = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-label'))) || (el.innerText || el.textContent || (el.value != null ? String(el.value) : '') || '').trim().slice(0, 200) || null;
    const synth = ${synthesizeSelectorScript()}(el);
    const state = {
      visible: visible || ${includeHidden ? "true" : "false"},
      enabled: !el.disabled,
      checked: (el.type === 'checkbox' || el.type === 'radio') ? !!el.checked : false,
      focused: document.activeElement === el,
      readonly: !!el.readOnly || el.getAttribute('aria-readonly') === 'true',
    };
    return {
      selector: { kind: synth.kind, value: synth.selector, confidence: synth.confidence },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
      role: role || null,
      name: name || null,
      tagName,
      state,
      display: cs.display,
      position: cs.position,
      zIndex: Number(cs.zIndex) || null,
      text: ((el.innerText || el.textContent || '') || '').trim().slice(0, 200) || null,
    };
  })()`;
  }
  function interactiveElementsScanScript() {
    return `(() => {
    const all = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role],[tabindex]'));
    const seen = new Set();
    const elements = [];
    let count = 0;
    for (const el of all) {
      if (seen.has(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      count++;
      if (elements.length >= ${MAX_INTERACTIVE_ELEMENTS}) continue;
      const synth = ${synthesizeSelectorScript()}(el);
      const tagName = el.tagName.toLowerCase();
      const role = el.getAttribute ? (el.getAttribute('role') || (tagName === 'a' && el.href ? 'link' : tagName === 'button' ? 'button' : tagName === 'input' || tagName === 'textarea' || tagName === 'select' ? tagName : null)) : null;
      const name = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-label'))) || (el.innerText || el.textContent || (el.value != null ? String(el.value) : '') || '').trim().slice(0, 120) || null;
      const state = {
        visible: true,
        enabled: !el.disabled,
        checked: (el.type === 'checkbox' || el.type === 'radio') ? !!el.checked : false,
        focused: document.activeElement === el,
        readonly: !!el.readOnly || el.getAttribute('aria-readonly') === 'true',
      };
      elements.push({
        ref: 'e' + (elements.length + 1),
        role: role || 'generic',
        name: name || '',
        selector: { kind: synth.kind, value: synth.selector, confidence: synth.confidence },
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
        state,
        locator: synth.kind === 'testid' ? { type: 'testid', value: el.dataset.testid } : synth.kind === 'id' ? { type: 'css', value: synth.selector } : synth.kind === 'aria' ? { type: 'css', value: synth.selector } : undefined,
        display: cs.display,
        position: cs.position,
        zIndex: Number(cs.zIndex) || null,
      });
    }
    const text = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, ${MAX_VISIBLE_TEXT_LENGTH});
    return {
      elements,
      text,
      truncated: count > ${MAX_INTERACTIVE_ELEMENTS} || (document.body && document.body.innerText ? document.body.innerText.length > ${MAX_VISIBLE_TEXT_LENGTH} : false),
      count,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY },
      title: document.title,
      readyState: document.readyState,
      url: location.href,
    };
  })()`;
  }

  // src/background/snapshot-refs.ts
  var KEY_PREFIX = "opencode:snapshot-refs:";

  class SnapshotRefRegistry {
    storage;
    now;
    cache = new Map;
    sequence = 0;
    constructor(storage, now = Date.now) {
      this.storage = storage;
      this.now = now;
    }
    async replace(tabId, elements) {
      const previous = await this.get(tabId);
      const candidate = this.now() * 1000 + this.sequence++ % 1000;
      const version = Math.max(candidate, (previous?.version ?? 0) + 1);
      const refs = {};
      for (const element of elements) {
        if (typeof element.ref !== "string" || !element.ref)
          continue;
        const x = Number(element.center?.x);
        const y = Number(element.center?.y);
        const selector = element.selector?.value;
        if (!Number.isFinite(x) || !Number.isFinite(y) || typeof selector !== "string" || !selector)
          continue;
        refs[element.ref] = {
          x: Math.round(x),
          y: Math.round(y),
          selector,
          ...isLocator(element.locator) ? { locator: element.locator } : {}
        };
      }
      const state = { version, refs };
      this.cache.set(tabId, state);
      await this.storage?.set({ [key(tabId)]: state });
      return state;
    }
    async get(tabId) {
      const cached = this.cache.get(tabId);
      if (cached)
        return cached;
      if (!this.storage)
        return;
      const stored = (await this.storage.get(key(tabId)))[key(tabId)];
      if (!isState(stored))
        return;
      this.cache.set(tabId, stored);
      return stored;
    }
    async clear(tabId) {
      this.cache.delete(tabId);
      await this.storage?.remove?.(key(tabId));
    }
  }
  var key = (tabId) => `${KEY_PREFIX}${tabId}`;
  var isLocator = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const candidate = value;
    return typeof candidate.value === "string" && ["css", "text", "role", "testid", "xpath", "placeholder", "label", "name"].includes(String(candidate.type)) && (candidate.exact === undefined || typeof candidate.exact === "boolean");
  };
  var isState = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const candidate = value;
    if (!Number.isSafeInteger(candidate.version) || Number(candidate.version) < 1)
      return false;
    if (!candidate.refs || typeof candidate.refs !== "object" || Array.isArray(candidate.refs))
      return false;
    for (const ref of Object.values(candidate.refs)) {
      if (!ref || typeof ref !== "object" || Array.isArray(ref))
        return false;
      const record = ref;
      if (!Number.isFinite(record.x) || !Number.isFinite(record.y) || typeof record.selector !== "string" || !record.selector)
        return false;
      if (record.locator !== undefined && !isLocator(record.locator))
        return false;
    }
    return true;
  };

  // src/background/visual-runtime-loader.ts
  class VisualRuntimeLoader {
    options;
    installing = new Map;
    constructor(options) {
      this.options = options;
    }
    async ensure(tabId) {
      if (await this.options.probe(tabId))
        return "warm";
      let install = this.installing.get(tabId);
      if (!install) {
        const pending = Promise.resolve().then(() => this.options.inject(tabId)).then(async () => {
          if (!await this.options.probe(tabId))
            throw new Error("Chrome visual runtime did not become ready after injection");
        }).finally(() => {
          if (this.installing.get(tabId) === pending)
            this.installing.delete(tabId);
        });
        install = pending;
        this.installing.set(tabId, install);
      }
      await install;
      return "cold";
    }
  }

  // src/background/visual-lifecycle.ts
  class VisualRequestTracker {
    byRequest = new Map;
    tryTrack(requestId, tabId) {
      for (const candidate of this.byRequest.values()) {
        if (candidate.tabId === tabId)
          return false;
      }
      this.byRequest.set(requestId, { tabId });
      return true;
    }
    untrack(requestId) {
      this.byRequest.delete(requestId);
    }
    tabId(requestId) {
      return this.byRequest.get(requestId)?.tabId;
    }
    interrupt(requestId, reason) {
      const entry = this.byRequest.get(requestId);
      if (!entry)
        return false;
      entry.interruption ??= reason;
      return true;
    }
    interruption(requestId) {
      return this.byRequest.get(requestId)?.interruption;
    }
    requestIdsForTab(tabId) {
      const out = [];
      for (const [requestId, candidate] of this.byRequest) {
        if (candidate.tabId === tabId)
          out.push(requestId);
      }
      return out;
    }
    get size() {
      return this.byRequest.size;
    }
  }
  async function abortVisualRequestsForTab(tracker, tabId, reason, sendAbort) {
    const requestIds = tracker.requestIdsForTab(tabId);
    for (const requestId of requestIds)
      tracker.interrupt(requestId, reason);
    await Promise.allSettled(requestIds.map((requestId) => sendAbort(tabId, requestId)));
    return requestIds.length;
  }

  // src/background/sw.ts
  function toError(tag, message, retryable, details) {
    return { tag, message, retryable, ...details ? { details } : {} };
  }
  function toBrokerErrorBody(err) {
    if (err && typeof err.tag === "string" && typeof err.message === "string" && typeof err.retryable === "boolean") {
      const out = { tag: err.tag, message: err.message, retryable: err.retryable };
      if (err.details)
        out.details = err.details;
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
  var activeTabIconController = null;
  var activeVisualRequests = new VisualRequestTracker;
  var snapshotRefs = new SnapshotRefRegistry(chrome.storage?.session);
  var visualRuntime = new VisualRuntimeLoader({
    probe: async (tabId) => {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: "opencode:visual-ready" });
        return response?.ready === true && response?.version === 1;
      } catch {
        return false;
      }
    },
    inject: async (tabId) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/content/visual.bundle.js"],
        world: "ISOLATED"
      });
    }
  });
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
        onRequest: (request) => {
          handleBrokerRequest(request, "native");
        },
        onAbort: (requestId) => {
          abortBrokerRequest(requestId);
        },
        onDisconnect: (err) => {
          console.warn("[sw:native] disconnected", err);
          setTimeout(() => {
            try {
              getNativePort().connect();
            } catch {}
          }, 2000);
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
  function getActiveTabIconController() {
    if (!activeTabIconController) {
      activeTabIconController = new ActiveTabIconController(chrome.tabs, (message, meta) => {
        console.debug(`[sw:icon] ${message}`, meta ?? "");
      });
    }
    return activeTabIconController;
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
      const result = await dispatchOperation(req);
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
  async function dispatchOperation(request) {
    const { tabId: tabIdStr, operation, sessionId } = request;
    const tabId = tabIdStr ? Number.parseInt(tabIdStr, 10) : await resolveActiveTabId();
    if (!Number.isFinite(tabId))
      throw Object.assign(new Error(`Invalid tabId ${tabIdStr}`), { tag: "BrowserTabNotFound", retryable: true });
    const name = operation.name;
    const input = operation.input ?? {};
    const needsDebugger = operationNeedsDebugger(name, input);
    const dm = needsDebugger ? getDebuggerManager() : debuggerManager;
    if (needsDebugger && !dm.isAttached(tabId)) {
      await dm.attach(tabId);
    }
    switch (name) {
      case "status": {
        const [tabs, focusedActiveTabs] = await Promise.all([
          chrome.tabs.query({}),
          chrome.tabs.query({ active: true, lastFocusedWindow: true })
        ]);
        const active = focusedActiveTabs[0] ?? tabs.find((t) => t.active);
        return {
          status: {
            connected: true,
            host: { hostId: "chrome-ext", protocolVersion: 2, hostEpoch: 1 },
            guest: active ? { windowId: String(active.windowId), state: "attached", activeTab: { tabId: String(active.id), url: active.url ?? "", title: active.title ?? "", readyState: active.status === "complete" ? "Success" : "Loading", viewport: { width: active.width ?? 1280, height: active.height ?? 800, dpr: 1, scrollX: 0, scrollY: 0 } } } : undefined,
            appearance: "system",
            recording: { active: false }
          },
          tabs: tabs.map((t) => ({ tabId: String(t.id), url: t.url ?? "", title: t.title ?? "", active: !!t.active, owner: { kind: "user" }, muted: !!t.mutedInfo?.muted }))
        };
      }
      case "open": {
        const url = input.url;
        if (!url)
          throw Object.assign(new Error("open requires url"), { tag: "BrowserInvalidSelector" });
        let targetTabId = tabIdStr;
        if (input.newTab || !tabIdStr) {
          const created = await chrome.tabs.create({ url, active: input.activate ?? true });
          targetTabId = String(created.id);
          if (chrome.tabGroups) {
            try {
              const groupId = await chrome.tabs.group({ tabIds: created.id });
              await chrome.tabGroups.update(groupId, { title: `opencode — ${sessionId.slice(0, 8)}`, color: "blue" });
            } catch {}
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
        await snapshotRefs.clear(tabId);
        await chrome.tabs.update(tabId, { url: input.url });
        await waitForTabComplete(chrome.tabs, tabId, input.timeoutMs ?? 15000);
        const tab = await chrome.tabs.get(tabId);
        return { navigated: { tabId: String(tabId), url: tab.url ?? input.url, title: tab.title ?? "", readyState: "Success", viewport: { width: tab.width ?? 1280, height: tab.height ?? 800, dpr: 1, scrollX: 0, scrollY: 0 } } };
      }
      case "close": {
        const closeId = input.tabId ? Number.parseInt(input.tabId, 10) : tabId;
        await snapshotRefs.clear(closeId);
        try {
          await debuggerManager?.detach(closeId);
        } catch {}
        await chrome.tabs.remove(closeId);
        return { closed: { tabId: String(closeId), wasActive: true, guestsRemaining: 0 } };
      }
      case "snapshot": {
        const scan = await evaluatePage(dm, tabId, interactiveElementsScanScript());
        if (!scan || typeof scan !== "object" || !Array.isArray(scan.elements)) {
          throw Object.assign(new Error("Chrome snapshot scanner returned an invalid result"), { tag: "BrowserOperationFailed", retryable: true });
        }
        const elements = scan.elements;
        const refState = await snapshotRefs.replace(tabId, elements);
        let tree = [];
        try {
          const cdpTree = await dm.sendCommand(tabId, "Accessibility.getFullAXTree", {});
          tree = cdpTree?.nodes ?? [];
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
            snapshotVersion: refState.version
          }
        };
      }
      case "screenshot": {
        try {
          await chrome.tabs.sendMessage(tabId, { type: "opencode:hide" });
        } catch {}
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        let result;
        try {
          try {
            const res = await dm.sendCommand(tabId, "Page.captureScreenshot", { format: input.format ?? "png", captureBeyondViewport: !!input.fullPage });
            result = { screenshot: { tabId: String(tabId), url: tab?.url ?? "", title: tab?.title ?? "", mime: input.format === "jpeg" ? "image/jpeg" : "image/png", data: res.data, width: 1280, height: 800, viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, capturedAt: Date.now() } };
          } catch {
            const winId = tab?.windowId;
            const dataUrl = winId !== undefined ? await chrome.tabs.captureVisibleTab(winId, { format: input.format ?? "png" }) : await chrome.tabs.captureVisibleTab({ format: input.format ?? "png" });
            const data = dataUrl.split(",")[1] ?? "";
            result = { screenshot: { tabId: String(tabId), url: tab?.url ?? "", title: tab?.title ?? "", mime: input.format === "jpeg" ? "image/jpeg" : "image/png", data, width: 1280, height: 800, viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 }, capturedAt: Date.now() } };
          }
        } finally {
          try {
            await chrome.tabs.sendMessage(tabId, { type: "opencode:show" });
          } catch {}
        }
        return result;
      }
      case "visual_capture":
      case "visual_diff":
      case "visual_record": {
        const visual = input.__opencodeVisual;
        if (!visual || typeof visual.capability !== "string" || typeof visual.runId !== "string" || !Number.isSafeInteger(visual.maxChunkBytes) || visual.maxChunkBytes < 1) {
          throw Object.assign(new Error("Visual operation is missing its Desktop capability"), { tag: "BrowserOperationFailed", retryable: false });
        }
        if (!activeVisualRequests.tryTrack(request.requestId, tabId)) {
          throw Object.assign(new Error(`A visual operation is already active on tab ${tabId}`), {
            tag: "BrowserOperationFailed",
            retryable: true
          });
        }
        try {
          const target = await resolveVisualTarget(dm, tabId, input.target);
          const options = {
            ...input.stabilize !== undefined ? { stabilize: input.stabilize } : {},
            ...input.waitFor !== undefined ? { waitFor: input.waitFor } : {},
            ...input.waitTimeout !== undefined ? { waitTimeout: input.waitTimeout } : {},
            ...input.settle !== undefined ? { settle: input.settle } : {},
            ...input.settleTimeout !== undefined ? { settleTimeout: input.settleTimeout } : {},
            ...input.scale !== undefined ? { scale: input.scale } : {},
            ...input.svg !== undefined ? { svg: input.svg } : {},
            ...name === "visual_diff" ? {
              diffOptions: {
                ...input.threshold !== undefined ? { threshold: input.threshold } : {},
                ...input.includeAA !== undefined ? { includeAA: input.includeAA } : {},
                ...input.diffMask !== undefined ? { diffMask: input.diffMask } : {}
              },
              regionOptions: {
                ...input.tileSize !== undefined ? { tileSize: input.tileSize } : {},
                ...input.gapTiles !== undefined ? { gapTiles: input.gapTiles } : {},
                ...input.minRegionCssSide !== undefined ? { minRegionCssSide: input.minRegionCssSide } : {},
                ...input.minRegionCssArea !== undefined ? { minRegionCssArea: input.minRegionCssArea } : {},
                ...input.maxRegions !== undefined ? { maxRegions: input.maxRegions } : {}
              }
            } : {},
            ...name === "visual_record" ? {
              ...input.duration !== undefined ? { duration: input.duration } : {},
              ...input.fps !== undefined ? { fps: input.fps } : {},
              ...input.format !== undefined ? { format: input.format } : {},
              ...input.bitrate !== undefined ? { bitrate: input.bitrate } : {},
              filmstripOptions: {
                ...input.filmstripMaxCells !== undefined ? { maxCells: input.filmstripMaxCells } : {},
                ...input.filmstripMaxColumns !== undefined ? { maxColumns: input.filmstripMaxColumns } : {},
                ...input.filmstripMaxWidth !== undefined ? { maxWidth: input.filmstripMaxWidth } : {},
                ...input.filmstripGap !== undefined ? { gap: input.filmstripGap } : {},
                ...input.filmstripBackground !== undefined ? { background: input.filmstripBackground } : {}
              }
            } : {}
          };
          try {
            await chrome.tabs.sendMessage(tabId, { type: "opencode:hide" });
          } catch {}
          await visualRuntime.ensure(tabId);
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
              options
            }
          });
          if (!response?.ok) {
            const interruption = await visualInterruptionReason(request.requestId, tabId);
            const lostContext = response == null;
            const interrupted = lostContext || response?.aborted === true || interruption !== undefined;
            throw Object.assign(new Error(response?.error ?? (lostContext ? "Visual browser context disappeared" : "Chrome visual runtime failed")), {
              tag: interrupted ? "BrowserControlInterrupted" : "BrowserOperationFailed",
              retryable: true
            });
          }
          return { visual: response.result };
        } catch (error) {
          const interruption = await visualInterruptionReason(request.requestId, tabId);
          if (interruption) {
            throw Object.assign(new Error(`Visual operation interrupted: ${interruption}`), {
              tag: "BrowserControlInterrupted",
              retryable: true
            });
          }
          throw error;
        } finally {
          activeVisualRequests.untrack(request.requestId);
          try {
            await chrome.tabs.sendMessage(tabId, { type: "opencode:show" });
          } catch {}
        }
      }
      case "click": {
        const target = input.target;
        const coords = await resolveTargetToCoords(dm, tabId, target);
        try {
          await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: coords.x, y: coords.y });
        } catch {}
        try {
          await chrome.tabs.sendMessage(tabId, { type: "opencode:cursor", x: coords.x, y: coords.y, phase: "move", sequence: input.sequence });
        } catch {}
        await new Promise((r) => setTimeout(r, 160));
        try {
          await chrome.tabs.sendMessage(tabId, { type: "opencode:cursor", x: coords.x, y: coords.y, phase: "click", sequence: input.sequence });
        } catch {}
        await new Promise((r) => setTimeout(r, 40));
        const button = input.button ?? "left";
        const clickCount = input.clickCount ?? 1;
        const modifiers = Array.isArray(input.modifiers) ? input.modifiers : [];
        await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: coords.x, y: coords.y, button, clickCount });
        await dm.sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.x, y: coords.y, button, clickCount });
        return { clicked: { target: { kind: "coords", center: coords }, coords, clickCount } };
      }
      case "type": {
        const text = input.text ?? "";
        if (input.target) {
          const c = await resolveTargetToCoords(dm, tabId, input.target);
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
        const key2 = input.key;
        await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: key2, code: key2 });
        await dm.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: key2, code: key2 });
        return { pressed: { key: key2, repeat: false, modifiers: [] } };
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
        const timeout = input.timeoutMs ?? 5000;
        if (input.condition?.type === "url") {
          const tab = await waitForUrl(chrome.tabs, tabId, input.condition.pattern, timeout);
          if (tab)
            return { waited: { satisfied: true, at: { time: Date.now(), url: tab.url ?? "", title: tab.title ?? "" } } };
        } else if (input.condition?.type === "text") {
          const [{ result: found }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (text, timeoutMs) => {
              if (document.body?.innerText?.includes(text))
                return Promise.resolve(true);
              return new Promise((resolve) => {
                let checkTimer = 0;
                const finish = (value) => {
                  observer.disconnect();
                  clearTimeout(timer);
                  if (checkTimer)
                    clearTimeout(checkTimer);
                  resolve(value);
                };
                const observer = new MutationObserver(() => {
                  if (checkTimer)
                    return;
                  checkTimer = setTimeout(() => {
                    checkTimer = 0;
                    if (document.body?.innerText?.includes(text))
                      finish(true);
                  }, 25);
                });
                const timer = setTimeout(() => finish(false), timeoutMs);
                observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
              });
            },
            args: [input.condition.text, timeout]
          }).catch(() => [{ result: false }]);
          if (found)
            return { waited: { satisfied: true, at: { time: Date.now(), url: "", title: "" } } };
        }
        throw Object.assign(new Error("wait_for timeout"), { tag: "BrowserTimeout", retryable: true });
      }
      case "highlight":
      case "annotate": {
        const targets = input.targets ?? (input.target ? [{ target: input.target }] : []);
        for (const t of targets) {
          const coords = await resolveTargetToCoords(dm, tabId, t.target);
          try {
            await chrome.tabs.sendMessage(tabId, { type: "opencode:highlight", rect: { x: coords.x - 20, y: coords.y - 10, width: 40, height: 20 }, label: t.label, tone: t.tone });
          } catch {}
        }
        if (input.clear)
          try {
            await chrome.tabs.sendMessage(tabId, { type: "opencode:clear" });
          } catch {}
        return { annotated: { tabId: String(tabId), count: targets.length, cleared: !!input.clear, at: { time: Date.now() } } };
      }
      case "query": {
        const selector = input.target?.value ?? input.selector ?? "*";
        const results = await chrome.scripting.executeScript({ target: { tabId }, func: (sel, max) => {
          const els = [...document.querySelectorAll(sel)].slice(0, max ?? 20);
          return els.map((el) => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, center: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, visibility: r.width > 0 && r.height > 0 ? "visible" : "hidden", display: style.display, position: style.position, text: el.textContent?.slice(0, 200) ?? "" };
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
        } catch {}
        return { appearance: input.appearance, effective: scheme === "dark" ? "dark" : "light" };
      }
      default:
        throw Object.assign(new Error(`Unsupported operation ${name} in extension lane`), { tag: "BrowserUnsupportedOperation", retryable: false });
    }
  }
  async function resolveTargetToCoords(dm, tabId, target) {
    if (!target)
      throw browserTargetNotFound("A browser element target is required");
    if (isRefTarget(target)) {
      const { record } = await requireSnapshotRef(tabId, target);
      return { x: record.x, y: record.y };
    }
    if (typeof target.x === "number" && typeof target.y === "number") {
      return { x: Math.round(target.x), y: Math.round(target.y) };
    }
    const resolved = await resolveLiveTarget(dm, tabId, target);
    return resolved.center;
  }
  async function resolveVisualTarget(dm, tabId, target) {
    if (!target || target.kind === "document")
      return;
    if (target.kind === "css") {
      if (typeof target.selector !== "string" || !target.selector)
        throw browserInvalidSelector("visual target requires a non-empty CSS selector");
      return target.selector;
    }
    if (target.kind !== "element" || !target.target)
      throw browserInvalidSelector("Unsupported visual target");
    const elementTarget = target.target;
    if (isRefTarget(elementTarget)) {
      const { record } = await requireSnapshotRef(tabId, elementTarget);
      return record.selector;
    }
    const manager = dm ?? getDebuggerManager();
    if (!manager.isAttached(tabId))
      await manager.attach(tabId);
    const resolved = await resolveLiveTarget(manager, tabId, elementTarget);
    if (typeof resolved.selector?.value !== "string" || !resolved.selector.value) {
      throw browserTargetNotFound("Visual target could not be converted to a stable selector");
    }
    return resolved.selector.value;
  }
  async function resolveLiveTarget(dm, tabId, target) {
    const value = await evaluatePage(dm, tabId, resolveElementScript(target, false));
    if (value && typeof value === "object" && typeof value.error === "string")
      throw browserInvalidSelector(value.error);
    if (!value || typeof value !== "object" || !value.center)
      throw browserTargetNotFound();
    return value;
  }
  async function requireSnapshotRef(tabId, target) {
    const state = await snapshotRefs.get(tabId);
    const expected = state?.version ?? 0;
    if (!state || target.snapshotVersion !== state.version || !state.refs[target.ref]) {
      const error = new Error(`Snapshot ref "${target.ref}" is stale (bound to snapshot ${target.snapshotVersion}, current snapshot ${expected}). Re-run browser snapshot and use the new ref.`);
      Object.assign(error, {
        tag: "BrowserStaleRefError",
        retryable: false,
        details: { ref: target.ref, expectedSnapshot: expected, actualSnapshot: target.snapshotVersion }
      });
      throw error;
    }
    return { state, record: state.refs[target.ref] };
  }
  async function evaluatePage(dm, tabId, expression) {
    const response = await dm.sendCommand(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (response?.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Runtime.evaluate failed";
      throw Object.assign(new Error(String(detail)), { tag: "BrowserOperationFailed", retryable: true });
    }
    return response?.result?.value;
  }
  function isRefTarget(target) {
    return !!target && typeof target.ref === "string" && typeof target.snapshotVersion === "number";
  }
  function browserInvalidSelector(message) {
    return Object.assign(new Error(message), { tag: "BrowserInvalidSelector", retryable: false });
  }
  function browserTargetNotFound(message = "Browser target was not found") {
    return Object.assign(new Error(message), { tag: "BrowserTargetNotFound", retryable: true });
  }
  async function resolveActiveTabId() {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return active?.id ?? null;
  }
  async function abortBrokerRequest(requestId) {
    const tabId = activeVisualRequests.tabId(requestId);
    if (tabId !== undefined) {
      activeVisualRequests.interrupt(requestId, "caller-abort");
      try {
        await chrome.tabs.sendMessage(tabId, { type: "opencode:visual-abort", requestId });
      } catch {}
    }
    console.debug("[sw:native] abort", { requestId, visual: tabId !== undefined });
  }
  async function abortVisualTab(tabId, reason) {
    const count = await abortVisualRequestsForTab(activeVisualRequests, tabId, reason, async (targetTabId, requestId) => {
      await chrome.tabs.sendMessage(targetTabId, { type: "opencode:visual-abort", requestId });
    });
    if (count > 0)
      console.debug("[sw:visual] tab lifecycle abort", { tabId, reason, count });
  }
  async function visualInterruptionReason(requestId, tabId) {
    const tracked = activeVisualRequests.interruption(requestId);
    if (tracked)
      return tracked;
    try {
      await chrome.tabs.get(tabId);
      return;
    } catch {
      activeVisualRequests.interrupt(requestId, "tab-removed");
      return "tab-removed";
    }
  }
  chrome.runtime.onInstalled.addListener(() => {
    console.log("[sw] installed", chrome.runtime.getManifest().version);
    try {
      getNativePort().connect();
    } catch {}
  });
  chrome.runtime.onStartup.addListener(() => {
    try {
      getNativePort().connect();
    } catch {}
  });
  try {
    getNativePort().connect();
  } catch {}
  getActiveTabIconController().start();
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "loading" && typeof changeInfo.url !== "string")
      return;
    abortVisualTab(tabId, "navigation");
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    abortVisualTab(tabId, "tab-removed");
  });
  if (chrome.runtime.onConnectNative) {}
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const m = msg;
    if (!m || typeof m !== "object")
      return;
    if (m.type === "opencode:request" && m.request) {
      (async () => {
        const startedAt = Date.now();
        try {
          if (!isBrokerRequest(m.request))
            throw Object.assign(new Error("Invalid BrokerRequest"), { tag: "BrowserOperationFailed" });
          const result = await dispatchOperation(m.request);
          sendResponse({ ok: true, requestId: m.request.requestId, result, elapsedMs: Date.now() - startedAt });
        } catch (err) {
          sendResponse({ ok: false, requestId: m.request?.requestId ?? "", elapsedMs: Date.now() - startedAt, error: toBrokerErrorBody(err) });
        }
      })();
      return true;
    }
    if (m.type === "opencode:visual-rpc" && m.request) {
      if (sender.id !== chrome.runtime.id || typeof sender.tab?.id !== "number") {
        sendResponse({ ok: false, id: m.request?.id ?? "", error: { code: "VISUAL_SCOPE_VIOLATION", message: "Untrusted visual RPC sender" } });
        return false;
      }
      getNativePort().artifactRpc(m.request, 30000).then((response) => sendResponse(response), (error) => sendResponse({ ok: false, id: m.request?.id ?? "", error: { code: "VISUAL_HOST_UNAVAILABLE", message: String(error) } }));
      return true;
    }
    if (m.type === "opencode:visual-wait" && typeof m.requestId === "string") {
      const tabId = sender.tab?.id;
      const durationMs = Number(m.durationMs);
      if (sender.id !== chrome.runtime.id || typeof tabId !== "number" || activeVisualRequests.tabId(m.requestId) !== tabId || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 1000) {
        sendResponse({ ok: false, error: "Invalid visual frame-clock request" });
        return false;
      }
      setTimeout(() => sendResponse({ ok: true }), durationMs);
      return true;
    }
    if (m.type === "opencode:abort" && m.requestId) {
      abortBrokerRequest(String(m.requestId)).then(() => sendResponse({ ok: true, aborted: true }), (error) => sendResponse({ ok: false, aborted: false, error: String(error) }));
      return true;
    }
    if (m.type === "opencode:ping") {
      sendResponse({ pong: true, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
      return false;
    }
  });
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "opencode:request" && msg.request) {
      (async () => {
        const startedAt = Date.now();
        try {
          if (!isBrokerRequest(msg.request))
            throw Object.assign(new Error("Invalid BrokerRequest"), { tag: "BrowserOperationFailed" });
          const result = await dispatchOperation(msg.request);
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
})();
