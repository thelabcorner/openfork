import { PROFILER_MAX_COMMITS, PROFILER_MAX_COMPONENTS, PROFILER_MAX_FIBERS_PER_COMMIT, PROFILER_MAX_PROPS } from "./types"

// React profiler in-page scripts (premium-UX amendment §3, T3-inspired).
// Mechanism: ensure __REACT_DEVTOOLS_GLOBAL_HOOK__ exists (install a minimal
// hook when absent), subscribe onCommitFiberRoot, record per-commit timestamps
// plus a BOUNDED fiber walk (render counts per component name via alternate
// deltas; props diff for a named component, capped). On stop, aggregate into a
// wire ProfilerResult. Non-React page -> { noReact: true } so the host throws
// BrowserNotAReactAppError.
//
// Honesty: commit TIMING comes from the DevTools commit listener (real);
// per-component RENDER COUNTS come from fiber-walk deltas (approximation —
// documented in the tool description, never presented as wall-clock profiling).

export const PROFILER_STATE_KEY = "__opencode_browser_profiler__"

/** Install the DevTools global hook when absent (React 16.5+ contract). */
export function installReactHookScript() {
  return `(() => {
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return { installed: false, present: true };
    const listeners = new Map();
    const renderers = new Map();
    const hook = {
      renderers,
      supportsFiber: true,
      inject(renderer) {
        const id = renderers.size + 1;
        renderers.set(id, renderer);
        return id;
      },
      on(event, fn) { const set = listeners.get(event) || new Set(); set.add(fn); listeners.set(event, set); },
      off(event, fn) { const set = listeners.get(event); if (set) set.delete(fn); },
      emit(event, ...args) { const set = listeners.get(event); if (set) for (const fn of set) fn(...args); },
      sub(event, fn) { this.on(event, fn); return () => this.off(event, fn); },
      unsub(event, fn) { this.off(event, fn); },
      checkDCE() {},
      getFiberRoots(id) { return new Set(); },
      onCommitFiberRoot: null,
      onCommitFiberUnmount: null,
    };
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true });
    return { installed: true, present: false };
  })()`
}

/** Subscribe the commit listener and start bounded recording. Idempotent. */
export function profilerStartScript(component?: string) {
  const target = component ? JSON.stringify(component) : "null"
  return `(() => {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.supportsFiber) return { noReact: true };
    if (window[${JSON.stringify(PROFILER_STATE_KEY)}]) return { already: true };
    const state = {
      commits: [],
      startedAt: performance.now(),
      renderCounts: new Map(),
      component: ${target},
      truncated: false,
    };
    const walk = (root) => {
      let visited = 0;
      const stack = [root];
      while (stack.length > 0 && visited < ${PROFILER_MAX_FIBERS_PER_COMMIT}) {
        const fiber = stack.pop();
        if (!fiber) continue;
        visited++;
        const type = fiber.elementType || fiber.type;
        let name = null;
        if (typeof type === 'function') name = type.displayName || type.name || null;
        else if (typeof type === 'string') name = type;
        else if (type && typeof type === 'object' && typeof type.render === 'function') name = type.displayName || null;
        if (name) {
          const count = state.renderCounts.get(name) || 0;
          // alternate !== null means the fiber re-rendered in this commit
          state.renderCounts.set(name, count + (fiber.alternate ? 1 : 0));
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
      if (visited >= ${PROFILER_MAX_FIBERS_PER_COMMIT}) state.truncated = true;
    };
    state.onCommit = (rendererID, root) => {
      if (state.commits.length >= ${PROFILER_MAX_COMMITS}) { state.truncated = true; return; }
      state.commits.push({ at: performance.now(), root });
      try { walk(root.current); } catch (e) { /* fiber walk is best-effort */ }
    };
    hook.on('commitFiberRoot', state.onCommit);
    state.unsubscribe = () => hook.off('commitFiberRoot', state.onCommit);
    window[${JSON.stringify(PROFILER_STATE_KEY)}] = state;
    return { started: true };
  })()`
}

/** Stop recording, unsubscribe, and aggregate a bounded ProfilerResult body. */
export function profilerStopScript() {
  return `(() => {
    const state = window[${JSON.stringify(PROFILER_STATE_KEY)}];
    if (!state) return { noReact: true };
    state.unsubscribe();
    delete window[${JSON.stringify(PROFILER_STATE_KEY)}];
    const windowMs = Math.max(0, performance.now() - state.startedAt);
    const sorted = Array.from(state.renderCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, ${PROFILER_MAX_COMPONENTS});
    const topRenders = sorted.map(([name, count]) => ({ name, count }));
    let propsDiff = null;
    if (state.component) {
      const wanted = state.component;
      const lastCommit = state.commits[state.commits.length - 1];
      if (lastCommit && lastCommit.root) {
        const stack = [lastCommit.root.current];
        let visited = 0;
        while (stack.length > 0 && visited < ${PROFILER_MAX_FIBERS_PER_COMMIT}) {
          const fiber = stack.pop();
          if (!fiber) continue;
          visited++;
          const type = fiber.elementType || fiber.type;
          let name = null;
          if (typeof type === 'function') name = type.displayName || type.name || null;
          if (name === wanted && fiber.memoizedProps && fiber.alternate && fiber.alternate.memoizedProps) {
            const keys = Object.keys(fiber.alternate.memoizedProps);
            const props = [];
            for (const key of keys) {
              if (props.length >= ${PROFILER_MAX_PROPS}) break;
              const before = fiber.alternate.memoizedProps[key];
              const after = fiber.memoizedProps[key];
              if (before !== after) {
                props.push({ key, before: before === undefined ? null : before, after: after === undefined ? null : after });
              }
            }
            if (props.length > 0) propsDiff = { component: wanted, props };
            break;
          }
          if (fiber.child) stack.push(fiber.child);
          if (fiber.sibling) stack.push(fiber.sibling);
        }
      }
    }
    const truncate = (v) => {
      const s = JSON.stringify(v);
      if (!s) return v;
      return s.length > 400 ? s.slice(0, 400) : v;
    };
    return {
      commits: state.commits.length,
      windowMs: Math.round(windowMs),
      topRenders,
      propsDiff: propsDiff ? { component: propsDiff.component, props: propsDiff.props.map((p) => ({ key: p.key, before: truncate(p.before), after: truncate(p.after) })) } : undefined,
      truncated: state.truncated,
    };
  })()`
}

/** Cheap React presence probe (used before starting, for a friendlier error). */
export function reactPresentScript() {
  return `(() => {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook && hook.supportsFiber && hook.renderers && hook.renderers.size > 0) return true;
    // Fall back to a fiber-root DOM scan (React attaches __reactFiber$* to roots).
    const keys = Object.keys(window);
    if (keys.some((k) => k.startsWith('__reactContainer$') || k.startsWith('__REACT_DEVTOOLS'))) return true;
    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      let found = false;
      let scanned = 0;
      while (node && scanned < 500) {
        scanned++;
        for (const key of Object.keys(node)) {
          if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) { found = true; break; }
        }
        if (found) break;
        node = walker.nextNode();
      }
      return found;
    }
    return false;
  })()`
}
