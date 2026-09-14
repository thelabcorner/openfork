"use strict";
(() => {
  // src/content/active-tab-favicon.ts
  var ACTIVE_TAB_ICON_ATTRIBUTE = "data-opencode-active-tab-icon";
  function setActiveTabFavicon(document2, active, iconUrl) {
    const selector = `link[${ACTIVE_TAB_ICON_ATTRIBUTE}]`;
    const existing = document2.querySelector(selector);
    if (!active) {
      existing?.remove();
      return;
    }
    if (existing) {
      if (document2.head && existing.parentElement !== document2.head) document2.head.appendChild(existing);
      return;
    }
    if (!iconUrl) return;
    const icon = document2.createElement("link");
    icon.rel = "icon";
    icon.type = "image/png";
    icon.href = iconUrl;
    icon.setAttribute(ACTIVE_TAB_ICON_ATTRIBUTE, "");
    (document2.head ?? document2.documentElement).appendChild(icon);
  }

  // src/content/content.ts
  (() => {
    const OVERLAY_ATTRIBUTE = "data-opencode-overlay";
    const Z_INDEX = 2147483646;
    let hostEl = null;
    let shadow = null;
    let outlineLayer = null;
    let drawLayer = null;
    let cursorEl = null;
    let pingEl = null;
    let domObserver = null;
    let rafHandle = null;
    let pendingHighlight = [];
    let pendingCursor = null;
    let hiddenForCapture = false;
    let activeTimeout = null;
    let lastSequence = null;
    const CURSOR_ACTIVE_MS = 700;
    const AGENT_CURSOR_MOVE_MS = 150;
    const STYLE_SHEET = `
    :host { all: initial; }
    .overlay-root {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 1;
    }
    .outline-layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }
    .box {
      position: fixed;
      box-sizing: border-box;
      border: 2px solid #4f46e5;
      background: rgba(79, 70, 229, 0.08);
      border-radius: 4px;
      pointer-events: none;
    }
    .box.neutral { border-color: #4f46e5; background: rgba(79,70,229,0.08); }
    .box.info    { border-color: #0ea5e9; background: rgba(14,165,233,0.10); }
    .box.success { border-color: #22c55e; background: rgba(34,197,94,0.10); }
    .box.warning { border-color: #f59e0b; background: rgba(245,158,11,0.12); }
    .box.danger  { border-color: #ef4444; background: rgba(239,68,68,0.12); }
    .box-label {
      position: absolute;
      top: -20px;
      left: 0;
      background: #4f46e5;
      color: #fff;
      font: 11px/14px ui-sans-serif, system-ui, sans-serif;
      padding: 2px 6px;
      border-radius: 4px;
      white-space: nowrap;
      pointer-events: none;
    }
    .box.info .box-label    { background: #0ea5e9; }
    .box.success .box-label { background: #22c55e; }
    .box.warning .box-label { background: #f59e0b; }
    .box.danger .box-label  { background: #ef4444; }
    .draw-layer {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: visible;
    }
    @keyframes browser-status-ping {
      75%, 100% { transform: scale(2.4); opacity: 0; }
    }
    .animate-status-ping {
      animation: browser-status-ping 0.9s cubic-bezier(0, 0, 0.2, 1) infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .animate-status-ping { animation: none; }
    }
    .agent-cursor {
      position: absolute;
      left: 0;
      top: 0;
      z-index: 3;
      pointer-events: none;
      will-change: transform, opacity;
      transition: transform 150ms ease-out, opacity 150ms ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .agent-cursor { transition: none; }
    }
    .agent-cursor-icon {
      width: 20px;
      height: 20px;
      transform: translate(-2px, -2px);
      fill: white;
      color: #4f46e5;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.25));
    }
    .click-ping {
      position: absolute;
      left: 2px;
      top: 2px;
      width: 16px;
      height: 16px;
      border-radius: 9999px;
      background: rgba(79, 70, 229, 0.25);
    }
  `;
    function ensureHost() {
      if (hostEl && shadow && outlineLayer && cursorEl) return;
      if (hostEl && !shadow) {
        hostEl.remove();
        hostEl = null;
      }
      if (!hostEl) {
        hostEl = document.createElement("div");
        hostEl.setAttribute(OVERLAY_ATTRIBUTE, "");
        hostEl.setAttribute("role", "presentation");
        hostEl.setAttribute("aria-hidden", "true");
        Object.assign(hostEl.style, {
          position: "fixed",
          inset: "0",
          zIndex: String(Z_INDEX),
          pointerEvents: "none",
          margin: "0",
          padding: "0",
          display: hiddenForCapture ? "none" : "block"
        });
        document.documentElement.appendChild(hostEl);
        try {
          shadow = hostEl.attachShadow({ mode: "closed" });
        } catch {
          shadow = hostEl.attachShadow({ mode: "open" });
        }
        const style = document.createElement("style");
        style.textContent = STYLE_SHEET;
        const root = document.createElement("div");
        root.className = "overlay-root";
        outlineLayer = document.createElement("div");
        outlineLayer.className = "outline-layer";
        drawLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        drawLayer.setAttribute("class", "draw-layer");
        drawLayer.setAttribute("width", "100%");
        drawLayer.setAttribute("height", "100%");
        cursorEl = document.createElement("div");
        cursorEl.className = "agent-cursor";
        cursorEl.setAttribute("aria-hidden", "true");
        cursorEl.style.opacity = "0";
        cursorEl.style.transform = "translate3d(0, 0, 0)";
        const svgNS = "http://www.w3.org/2000/svg";
        const arrow = document.createElementNS(svgNS, "svg");
        arrow.setAttribute("viewBox", "0 0 24 24");
        arrow.setAttribute("fill", "none");
        arrow.setAttribute("stroke", "currentColor");
        arrow.setAttribute("stroke-width", "2");
        arrow.setAttribute("stroke-linecap", "round");
        arrow.setAttribute("stroke-linejoin", "round");
        arrow.setAttribute("class", "agent-cursor-icon");
        arrow.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", "m4 4 7.07 17 2.51-7.39L21 11.07z");
        arrow.appendChild(path);
        cursorEl.appendChild(arrow);
        shadow.appendChild(style);
        shadow.appendChild(outlineLayer);
        shadow.appendChild(drawLayer);
        shadow.appendChild(cursorEl);
        if (typeof MutationObserver === "function" && !domObserver) {
          domObserver = new MutationObserver(() => {
            if (hostEl && !document.documentElement.contains(hostEl)) {
              try {
                document.documentElement.appendChild(hostEl);
              } catch {
              }
            }
          });
          domObserver.observe(document.documentElement, { childList: true });
        }
        if (!ensureHost._wired) {
          ensureHost._wired = true;
          window.addEventListener("pagehide", teardown, true);
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") {
              if (rafHandle !== null) {
                cancelAnimationFrame(rafHandle);
                rafHandle = null;
              }
            }
          });
        }
      }
    }
    ensureHost._wired = false;
    function teardown() {
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
      domObserver?.disconnect();
      try {
        hostEl?.remove();
      } catch {
      }
      hostEl = null;
      shadow = null;
      outlineLayer = null;
      drawLayer = null;
      cursorEl = null;
      pingEl = null;
      if (activeTimeout !== null) {
        window.clearTimeout(activeTimeout);
        activeTimeout = null;
      }
      lastSequence = null;
      pendingHighlight = [];
      pendingCursor = null;
      domObserver = null;
    }
    function clampRect(r) {
      return {
        x: Math.max(0, Math.round(r.x)),
        y: Math.max(0, Math.round(r.y)),
        width: Math.max(1, Math.round(r.width)),
        height: Math.max(1, Math.round(r.height))
      };
    }
    function scheduleRender() {
      if (rafHandle !== null) return;
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        flush();
      });
    }
    function flush() {
      ensureHost();
      if (!outlineLayer || !cursorEl) return;
      if (pendingHighlight.length > 0) {
        for (const item of pendingHighlight) {
          const rect = clampRect(item.rect);
          const box = document.createElement("div");
          box.className = `box ${item.tone ?? "neutral"}`;
          box.style.left = `${rect.x}px`;
          box.style.top = `${rect.y}px`;
          box.style.width = `${rect.width}px`;
          box.style.height = `${rect.height}px`;
          if (item.label) {
            const label = document.createElement("div");
            label.className = "box-label";
            label.textContent = item.label;
            box.appendChild(label);
          }
          outlineLayer.appendChild(box);
        }
        pendingHighlight = [];
      }
      if (pendingCursor) {
        const c = pendingCursor;
        pendingCursor = null;
        if (cursorEl) {
          const x = Math.round(c.x);
          const y = Math.round(c.y);
          cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          cursorEl.style.opacity = "1";
          if (activeTimeout !== null) window.clearTimeout(activeTimeout);
          activeTimeout = window.setTimeout(() => {
            if (cursorEl) cursorEl.style.opacity = "0.35";
            activeTimeout = null;
          }, CURSOR_ACTIVE_MS);
          if (c.phase === "click" && c.sequence !== lastSequence) {
            lastSequence = c.sequence ?? Date.now();
            if (pingEl) pingEl.remove();
            pingEl = document.createElement("span");
            pingEl.className = "click-ping animate-status-ping";
            pingEl.setAttribute("aria-hidden", "true");
            cursorEl.appendChild(pingEl);
            window.setTimeout(() => {
              if (pingEl && !pingEl.isConnected) pingEl = null;
              else if (pingEl) {
                pingEl.remove();
                pingEl = null;
              }
            }, 950);
          } else if (c.phase !== "click") {
            if (pingEl) {
              pingEl.remove();
              pingEl = null;
            }
          }
        }
      }
    }
    function setHidden(hidden) {
      hiddenForCapture = hidden;
      if (!hostEl) return;
      if (hostEl) hostEl.style.display = hidden ? "none" : "";
    }
    function reactComponentName(el) {
      const key = Object.keys(el).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      );
      if (!key) return null;
      const fiber = el[key];
      let cur = fiber;
      for (let d = 0; d < 40 && cur && typeof cur === "object" && cur !== null; d++) {
        const f = cur;
        const t = f.type;
        if (typeof t === "function") {
          const fn = t;
          const n = fn.displayName || fn.name;
          if (n) return n;
        } else if (t && typeof t === "object") {
          const o = t;
          const n = o.displayName || o.name || o.render?.displayName || o.render?.name;
          if (n) return n;
        }
        cur = f.return;
      }
      return null;
    }
    const runtime = globalThis.chrome?.runtime;
    let activeTabIconObserver = null;
    function applyActiveTabIcon(active) {
      const iconUrl = runtime?.getURL?.("assets/icon48.png");
      setActiveTabFavicon(document, active, iconUrl);
      if (!active) {
        activeTabIconObserver?.disconnect();
        activeTabIconObserver = null;
        return;
      }
      if (activeTabIconObserver || typeof MutationObserver !== "function") return;
      const root = document.head ?? document.documentElement;
      activeTabIconObserver = new MutationObserver((records) => {
        let faviconChanged = false;
        for (const record of records) {
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            if (!(node instanceof HTMLLinkElement)) continue;
            if (node.hasAttribute(ACTIVE_TAB_ICON_ATTRIBUTE) || node.rel.toLowerCase().includes("icon")) {
              faviconChanged = true;
              break;
            }
          }
          if (faviconChanged) break;
        }
        if (!faviconChanged) return;
        const marker = document.querySelector(`link[${ACTIVE_TAB_ICON_ATTRIBUTE}]`);
        if (!marker) {
          setActiveTabFavicon(document, true, iconUrl);
          return;
        }
        if (marker.parentElement && marker.parentElement.lastElementChild !== marker) marker.parentElement.appendChild(marker);
      });
      activeTabIconObserver.observe(root, { childList: true });
    }
    function handleMessage(msg, _sender, sendResponse) {
      if (!msg || typeof msg !== "object") return;
      const m = msg;
      switch (m.type) {
        case "opencode:cursor": {
          const x = typeof m.x === "number" ? m.x : 0;
          const y = typeof m.y === "number" ? m.y : 0;
          const phase = m.phase === "click" ? "click" : "move";
          const sequence = typeof m.sequence === "number" ? m.sequence : void 0;
          pendingCursor = { x, y, phase, sequence };
          scheduleRender();
          sendResponse?.({ ok: true });
          return false;
        }
        case "opencode:highlight": {
          if (m.clear) {
            pendingHighlight = [];
            if (outlineLayer) outlineLayer.replaceChildren();
            if (drawLayer) drawLayer.replaceChildren();
          }
          const rect = m.rect;
          if (rect && typeof rect.x === "number" && typeof rect.y === "number") {
            pendingHighlight.push({
              rect,
              label: typeof m.label === "string" ? m.label : void 0,
              tone: typeof m.tone === "string" ? m.tone : void 0
            });
            scheduleRender();
          }
          sendResponse?.({ ok: true });
          return false;
        }
        case "opencode:clear": {
          pendingHighlight = [];
          outlineLayer?.replaceChildren();
          drawLayer?.replaceChildren();
          sendResponse?.({ ok: true });
          return false;
        }
        case "opencode:hide": {
          setHidden(true);
          sendResponse?.({ ok: true, hidden: true });
          return false;
        }
        case "opencode:show": {
          setHidden(false);
          sendResponse?.({ ok: true, hidden: false });
          return false;
        }
        case "opencode:active-tab-icon": {
          applyActiveTabIcon(m.active === true);
          sendResponse?.({ ok: true, active: m.active === true });
          return false;
        }
        case "opencode:ping": {
          sendResponse?.({ pong: true, hasHost: !!hostEl, hidden: hiddenForCapture });
          return false;
        }
        case "opencode:react-probe": {
          const x = typeof m.x === "number" ? m.x : -1;
          const y = typeof m.y === "number" ? m.y : -1;
          let found = null;
          if (x >= 0 && y >= 0) {
            for (const el of document.elementsFromPoint(x, y)) {
              if (!(el instanceof Element)) continue;
              if (el.hasAttribute?.(OVERLAY_ATTRIBUTE)) continue;
              const n = reactComponentName(el);
              if (n) {
                found = n;
                break;
              }
            }
          }
          sendResponse?.({ pong: true, reactComponent: found });
          return false;
        }
        default:
          return;
      }
    }
    if (runtime?.onMessage) {
      runtime.onMessage.addListener(handleMessage);
    }
  })();
})();
