import { MAX_INTERACTIVE_ELEMENTS, MAX_VISIBLE_TEXT_LENGTH, type ElementSelector, type ElementState, type Locator, type QueryMatch } from "./types"

// In-page script builders for element resolution + snapshot scans. These run
// inside the guest page via Runtime.evaluate (browser-process CDP path, not
// gated by guest sandbox). Pure string builders — testable without Electron.

export type SynthSelector = { selector: string; kind: ElementSelector["kind"]; confidence: ElementSelector["confidence"] }

// Selector synthesis ladder: data-testid -> id -> aria-label/name -> role+name
// -> bounded structural chain. Returns the wire ElementSelector shape.
export function synthesizeSelectorScript() {
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
  `
}

function visibleFilterSource(includeHidden: boolean) {
  if (includeHidden) return ""
  return `if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) { const cs = window.getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return null; }`
}

/** Expression that resolves a Locator to an element (or null). */
export function findLocatorExpression(locator: Locator, filter = "") {
  const value = JSON.stringify(locator.value)
  switch (locator.type) {
    case "css":
      return `function() {
        let el;
        try { el = document.querySelector(${value}); } catch (e) { throw new Error('Invalid css selector: ' + e.message); }
        if (!el) return null;
        ${filter}
        return el;
      }`
    case "testid":
      return `function() {
        const el = document.querySelector('[data-testid="' + CSS.escape(${value}) + '"]');
        if (!el) return null;
        ${filter}
        return el;
      }`
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
      }`
    case "placeholder":
      return `function() {
        const el = Array.prototype.find.call(document.querySelectorAll('input,textarea'), (n) => (n.getAttribute('placeholder') || '') === ${value});
        if (!el) return null;
        ${filter}
        return el;
      }`
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
      }`
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
      }`
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
      }`
  }
}

/** Expression that resolves a raw CSS-viewport point to the top element. */
export function findCoordsExpression(x: number, y: number) {
  return `function() {
    const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    return el ? (el.closest('a[href],button,input,textarea,select,[role],[tabindex]') || el) : null;
  }`
}

/** Resolve a Locator|Coords target to its full descriptor (wire ResolvedTarget body + rect). */
export function resolveElementScript(target: Locator | { x: number; y: number }, includeHidden = false) {
  const find =
    "value" in target
      ? findLocatorExpression(target, visibleFilterSource(includeHidden))
      : findCoordsExpression(target.x, target.y)
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
  })()`
}

/** Interactive-element scan for snapshot badge data (bounded, wire SnapshotElement shapes). */
export function interactiveElementsScanScript() {
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
  })()`
}

/** Bounded DOM query for browser_query — wire QueryMatch[] shapes. */
export function queryElementsScript(locator: Locator, maxResults: number): string {
  const value = JSON.stringify(locator.value)
  const exact = JSON.stringify(locator.exact ?? false)
  const candidateExpr: string =
    locator.type === "css"
      ? `Array.from(document.querySelectorAll(${value}))`
      : locator.type === "xpath"
        ? `(() => { const out = []; try { const res = document.evaluate(${value}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); for (let i = 0; i < res.snapshotLength; i++) out.push(res.snapshotItem(i)); } catch (e) { throw new Error('Invalid xpath: ' + e.message); } return out; })()`
        : `Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role],[tabindex]'))`

  const matchExpr = (el: string): string => {
    switch (locator.type) {
      case "css":
      case "xpath":
        return "true"
      case "testid":
        return `(${el}.dataset && ${el}.dataset.testid === ${value})`
      case "placeholder":
        return `(${el}.getAttribute && ${el}.getAttribute('placeholder') === ${value})`
      case "text": {
        const textOf = `(${el}.innerText || ${el}.textContent || (${el}.value != null ? String(${el}.value) : '') || '').trim()`
        return `((${textOf}) ${exact ? "===" : ".includes("} ${exact ? value : value + ")"})`
      }
      case "role": {
        const roleOf = `(${el}.getAttribute ? (${el}.getAttribute('role') || (${el}.tagName === 'A' && ${el}.href ? 'link' : ${el}.tagName === 'BUTTON' ? 'button' : null)) : null)`
        return `((${roleOf}) === ${value})`
      }
      case "name": {
        const nameOf = `((${el}.getAttribute && (${el}.getAttribute('aria-label') || ${el}.getAttribute('data-label'))) || (${el}.innerText || ${el}.textContent || '') || '').trim()`
        return `((${nameOf}) ${exact ? "===" : ".includes("} ${exact ? value : value + ")"})`
      }
      case "label": {
        return `(() => { const id = ${el}.id; if (!id) return false; const l = document.querySelector('label[for="' + CSS.escape(id) + '"]'); return !!l && ((l.textContent || '').trim() === ${value}); })()`
      }
    }
  }

  return `(() => {
    const nodes = ${candidateExpr};
    const seen = new Set();
    const out = [];
    let count = 0;
    for (const el of nodes) {
      if (!el || el.nodeType !== 1) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      let match = false;
      try { match = ${matchExpr("el")}; } catch (e) { match = false; }
      if (!match) continue;
      count++;
      if (out.length >= ${maxResults}) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const cs = window.getComputedStyle(el);
      const synth = ${synthesizeSelectorScript()}(el);
      const tagName = el.tagName.toLowerCase();
      const role = el.getAttribute ? (el.getAttribute('role') || (tagName === 'a' && el.href ? 'link' : null)) : null;
      const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && cs.display !== 'none' && cs.visibility !== 'hidden';
      out.push({
        role: role || undefined,
        name: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-label'))) || undefined,
        selector: { kind: synth.kind, value: synth.selector, confidence: synth.confidence },
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
        visibility: visible ? 'visible' : 'hidden',
        display: cs.display,
        position: ['static', 'relative', 'absolute', 'fixed', 'sticky'].includes(cs.position) ? cs.position : 'static',
        text: ((el.innerText || el.textContent || '') || '').trim().slice(0, 200) || undefined,
      });
    }
    return { matches: out, count, truncated: count > ${maxResults} };
  })()`
}

// --- highlight ---------------------------------------------------------------

/** Flash an outline + badge on the target element for durationMs (default 800). */
export function highlightScript(resolveExpr: string, durationMs = 800) {
  return `(() => {
    const find = ${resolveExpr};
    let el;
    try { el = find(); } catch (e) { return { error: e.message }; }
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const doc = el.ownerDocument;
    const host = doc.createElement('div');
    host.setAttribute('data-opencode-browser-highlight', 'true');
    host.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-shadow:0 0 0 2px rgb(99 102 241),0 0 0 6px rgb(99 102 241 / 0.25);border-radius:4px;transition:opacity 120ms ease;';
    host.style.left = rect.left + 'px';
    host.style.top = rect.top + 'px';
    host.style.width = rect.width + 'px';
    host.style.height = rect.height + 'px';
    const synth = ${synthesizeSelectorScript()}(el);
    const label = doc.createElement('span');
    label.textContent = synth.selector.slice(0, 60);
    label.style.cssText = 'position:absolute;top:-20px;left:0;background:#6366f1;color:#fff;font:11px/16px ui-monospace,monospace;padding:0 6px;border-radius:4px;white-space:nowrap;';
    host.appendChild(label);
    doc.body.appendChild(host);
    setTimeout(() => { host.style.opacity = '0'; setTimeout(() => host.remove(), 140); }, ${Math.max(100, Math.min(5_000, durationMs))});
    return { center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } };
  })()`
}

// --- react inspect -----------------------------------------------------------

/**
 * Walk the target's React Fiber tree via DOM expando properties (React
 * attaches `__reactFiber$<key>` to every node it manages) — no
 * `contextIsolation=false` needed, no React DevTools protocol dependency.
 * Only `_debugSource` is available on DEVELOPMENT builds of React (stripped
 * in production), which is exactly the case this tool targets: a coding
 * agent's local dev server. Bounded: props/hooks are recursively serialized
 * to depth 3, ancestor chain capped at 12 components, hook list capped at 15.
 */
export function reactInspectScript(resolveExpr: string) {
  return `(() => {
    const find = ${resolveExpr};
    let el;
    try { el = find(); } catch (e) { return { error: e.message }; }
    if (!el) return null;

    const MAX_DEPTH = 3;
    const safe = (value, depth) => {
      if (depth > MAX_DEPTH) return '[Truncated]';
      if (value === null || value === undefined) return value === undefined ? null : value;
      if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
      if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof Element !== 'undefined' && value instanceof Element) return '[Element <' + value.tagName.toLowerCase() + '>]';
      if (Array.isArray(value)) return value.slice(0, 20).map((v) => safe(v, depth + 1));
      if (typeof value === 'object') {
        const out = {};
        let count = 0;
        for (const key in value) {
          if (key === 'children' || key.charAt(0) === '_') continue;
          if (count++ >= 20) { out['…'] = 'truncated'; break; }
          try { out[key] = safe(value[key], depth + 1); } catch { out[key] = '[Unserializable]'; }
        }
        return out;
      }
      return String(value);
    };

    const fiberKey = Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0);
    if (!fiberKey) return { hasReact: false, ancestors: [] };

    const componentNameOfType = (type) => {
      if (typeof type === 'string') return null;
      if (typeof type === 'function') return type.displayName || type.name || null;
      if (type && typeof type === 'object') return type.displayName || type.name || (type.render && (type.render.displayName || type.render.name)) || null;
      return null;
    };

    const sourceOf = (fiber) => {
      const s = fiber._debugSource;
      if (!s) return undefined;
      return { file: s.fileName, line: s.lineNumber, column: s.columnNumber };
    };

    const readHooks = (fiber) => {
      const hooks = [];
      let hook = fiber.memoizedState;
      let guard = 0;
      while (hook && guard++ < 25 && hooks.length < 15) {
        if ('memoizedState' in hook) hooks.push(safe(hook.memoizedState, 0));
        hook = hook.next;
      }
      return hooks;
    };

    let fiber = el[fiberKey];
    let component;
    const ancestors = [];
    let guard = 0;
    while (fiber && guard++ < 60) {
      const name = componentNameOfType(fiber.type);
      if (name) {
        const entry = { name, source: sourceOf(fiber) };
        if (!component) {
          component = { name, source: entry.source, props: fiber.memoizedProps ? safe(fiber.memoizedProps, 0) : undefined, hooks: fiber.memoizedState ? readHooks(fiber) : undefined };
        } else if (ancestors.length < 12) {
          ancestors.push(entry);
        }
      }
      fiber = fiber.return;
    }

    return { hasReact: true, component, ancestors };
  })()`
}

// --- helpers ---------------------------------------------------------------

export function isQueryMatch(value: unknown): value is QueryMatch {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record["rect"] === "object" && record["rect"] !== null && typeof record["center"] === "object" && record["center"] !== null
}

export function toElementState(value: unknown): ElementState {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>
  return {
    visible: record["visible"] !== false,
    enabled: record["enabled"] !== false,
    checked: record["checked"] === true,
    focused: record["focused"] === true,
    readonly: record["readonly"] === true,
  }
}
