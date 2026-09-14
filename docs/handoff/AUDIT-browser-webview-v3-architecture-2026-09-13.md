# Browser WebView V3 Architecture Audit and Hardening Plan

**Date:** 2026-09-13  
**Status:** V3 lifecycle + hot-path hardening implemented; browser suites and full desktop production build green in dirty worktree  
**Scope:** built-in collaborative browser (`packages/app/src/pages/session/v2/browser/*`, `packages/desktop/src/main/browser/*`)

## Executive decision

Keep Electron `<webview>` as the **presentation primitive** for the built-in browser, while moving logical tab authority, lifecycle, policy, and automation decisively into the main process.

This is not an endorsement of renderer-owned browser lifetime. It is a deliberate hybrid:

```text
Renderer / Solid                           Electron main
--------------------------------------    --------------------------------------
DOM composition + geometry                logical tab authority
<webview> presentation                    lifecycle epochs / stale IPC rejection
agent cursor / badges / annotation        owner / mute / appearance policy
viewport frame / resize handles           CDP / recording / snapshots
CSS transform / scroll coordinate space   security / arbitration / crash state
           |                                         ^
           +---- presentation identity IPC ----------+
```

The renderer is allowed to say **"this presentation exists"**. It is not allowed to decide **"this logical tab exists"**.

A full `WebContentsView` migration is deferred. It should only return as a benchmarked experiment if it demonstrates a material Pareto gain large enough to pay for native-view geometry, overlay-composition, DPI, scrolling, and transform complexity.

## Evidence reviewed

### T3Code

Reference checkout: `../t3code-reference`, commit `66e39ca2aabde054bc50312a9c34f05dbd1f6f9e`.

Relevant implementation:

- `apps/web/src/browser/HostedBrowserWebview.tsx`
- `apps/web/src/browser/ElectronBrowserHost.tsx`
- `apps/web/src/browser/browserSurfaceStore.ts`
- `apps/web/src/browser/desktopTabLifetime.ts`
- `apps/desktop/src/preview/Manager.ts`
- `apps/desktop/src/preview/Manager.test.ts`
- `apps/desktop/src/preview/WebviewPreferences.ts`

T3 still uses renderer-owned `<webview>` for the actual composited browser surface. The important sophistication lives around it: logical tab creation precedes presentation attachment, lifetime is reference-managed, registration is serialized, stale guests are rejected, attachment/replacement is generation-aware, persistent settings are restored before publication, and the manager has an unusually large race/failure test matrix.

Particularly relevant T3 invariants:

1. **Logical tab != DOM node.** A DOM presentation may disappear/reappear without redefining tab authority.
2. **Lifecycle generation guards.** Async registration/close/replacement cannot act on a successor lifetime.
3. **Serialized destructive transitions.** Close/register/replacement races are explicitly tested.
4. **State before publication.** Zoom, mute, ownership-derived state, and listeners are established before the newly attached guest is treated as current.
5. **Stale-source event rejection.** Events from a replaced `WebContents` do not mutate its successor.
6. **Replacement cleanup.** Debugger/listener/capture state belonging to an old guest is detached before the replacement is committed.
7. **Presentation leases.** UI mount churn is not synonymous with logical tab destruction.

These are more important to OpenCode than copying T3's framework or Effect implementation.

### OpenChamber

Reference checkout: `../openchamber-reference`, commit `b8e25f46a205f07bfa34828c1d02fe1b5dc1016b`.

Relevant implementation:

- `packages/ui/src/components/browser/BrowserPane.tsx`
- `packages/ui/src/lib/browser/viewport.ts`
- `packages/ui/src/components/browser/useWebviewNavigation.ts`
- `packages/electron/main.mjs`

OpenChamber also uses `<webview>`. Its implementation illustrates the key compositing advantage directly: viewport simulation is ordinary DOM width/height plus CSS `transform: scale(...)`. Page surface, frame, loading UI, and other overlays share the same coordinate system.

OpenChamber is less useful than T3 as a race-hardening reference, but it is strong evidence that `<webview>` remains a practical primitive for a browser pane whose UI deeply composes around the page.

### Codex Desktop / harness evidence

No comparable complete local source implementation was available for direct code-level adoption. Codex Desktop's browser/sidebar behavior and public failure modes remain useful adversarial evidence around attach/route/teardown lifetime, but they are not being treated as authoritative implementation guidance.

## Why not WebContentsView now?

`WebContentsView` improves direct main-process ownership, but OpenCode's difficult problem is not simply "display a page." The current browser surface includes:

- agent cursor over the guest
- element badges
- annotation overlays
- device frames and resize rails
- logical CSS viewport simulation
- CSS presentation scaling
- a scrollable centered canvas
- browser loading/crash overlays
- action timeline overlays

With `<webview>`, all of these participate in one DOM coordinate/composition model. With a native `WebContentsView`, renderer DOM cannot simply z-index over the guest and CSS transforms cannot directly position/scale it. That would require a window-space geometry protocol, DPI/app-zoom conversion, native view bounds synchronization, and a separate overlay strategy.

Expected raw Chromium memory/rendering cost is also broadly similar because both ultimately host Chromium `WebContents`. The migration therefore has a high known complexity cost and no demonstrated large resource win.

## V3 ownership model

### Logical tab lifetime

Main owns whether a tab exists.

A logical lifetime follows:

```text
requested -> attached <-> detached -> closing -> removed
```

`detached` means **presentation absent**, not tab deleted. Owner, mute, URL, viewport-associated state, and other logical metadata survive.

`closing` is claimed before destructive cleanup or renderer close notification. Once a tab is closing, no new presentation may attach.

Closed lifetime entries are removed from the lifecycle map. Lifecycle generations come from a process-monotonic allocator so stale IPC from a prior same-ID lifetime cannot match a successor while closed-tab metadata does not accumulate forever.

### Two independent generations

Do not merge these concepts.

**`lifecycleGeneration`**

- allocated in main
- identifies one logical tab lifetime
- included in `browser-tab-request`
- returned on register/unregister IPC
- rejects stale attach/detach after close or same-ID recreation

**presentation `generation`**

- renderer `<webview>` remount generation
- increments for crash recovery/replacement inside one logical lifetime
- protects annotation and guest-specific callbacks from a replaced Chromium guest

Example:

```text
logical tab A / lifecycle 41
  webview generation 0
  webview generation 1  <- crash recovery
  webview generation 2  <- replacement
close A

logical tab A reused later / lifecycle 57
  webview generation 0

late IPC from (41, 2) cannot act on (57, 0)
```

### Attach, detach, remove

`GuestRegistry` now has distinct operations:

- `register(...)`: attach/replace current presentation
- `detach(...)`: presentation disappeared, logical state remains
- `remove(...)`: permanent logical deletion

Renderer cleanup is only permitted to `detach`.

User/agent close paths call `remove` only after main claims the lifecycle as closing.

This distinction fixes an architectural bug in which a transient Solid unmount previously deleted the authoritative tab record.

### Configure before publish

The first published `attached=true` state must already be semantically correct.

Before `GuestRegistry.sync()` publishes a new attachment:

- correct owner is applied for agent-created/duplicated tabs
- requested activation is applied
- persisted guest zoom is restored
- persisted mute is restored
- old guest listeners are detached before replacement
- the new guest listener binding is installed

There must be no observable intermediate state in which, for example, an agent-created tab briefly appears user-owned.

### Stale source rejection

Every guest listener closure is bound to:

- runtime tab id
- WebContents id/object identity
- presentation generation

A listener from a replaced guest becomes a no-op. Bindings are explicitly disposed on replacement/detach/removal rather than trusting garbage collection.

Lifecycle IPC additionally carries `lifecycleGeneration`, so a renderer event from a logically closed tab is rejected before it reaches guest registration.

The lifecycle epoch is **renderer/main-private**. It is carried by `browser-tab-request` and register/unregister IPC, but is stripped before `guest.stateChanged` and is not part of broker `browser_status`. The sidecar protocol `GuestTabState` remains byte-shape compatible; renderer state uses a separate `RendererGuestTabState` extension.

### Detached behavior

A detached logical tab is visible in host state as `attached=false` but cannot be used for CDP/browser operations. `requireTab()` requires:

- attached
- non-null current webContents id
- non-crashed
- non-destroyed WebContents

This prevents retained logical metadata from becoming an accidental handle to dead Chromium state.

## Resource/performance policy

The V3 lifecycle model is intended to enable resource policy rather than hiding it inside component teardown.

Already implemented in the current optimization campaign:

- browser panel has no arbitrary maximum width
- scroll/presentation path no longer forces layout reads
- requestAnimationFrame work is genuinely coalesced rather than cancel/requeue-starved
- inactive surfaces do not retain unnecessary resize observers
- browser host guest lookup is indexed rather than repeated linear scan
- equivalent host pushes preserve object/signal identity
- preload path is cached
- positive webview support detection is cached
- renderer registration is single-flight/coalesced; stale async completion unregisters itself instead of attaching after unmount/replacement
- main has an exact-presentation identity fast path, so duplicate registration does not repeat guest validation/listener/state work
- pending attach-timeout timers are `unref()`'d so abandoned opens cannot unnecessarily pin process shutdown
- browser-surface deletion is an O(1) keyed Solid-store delete instead of cloning the entire tab map
- crash-recovery remount scheduling is single-flight and cleanup-owned, so stale retry timers cannot double-remount a successor presentation
- full host-state reconciliation reuses the existing guest index and constructs the live-tab set in the same pass
- unused persistent CDP Runtime/Accessibility/Network/Log domains are not enabled
- emulated appearance CDP writes are deduplicated
- debugger `message` listeners exist only while screencast subscribers need them
- screencast frames are source-tab filtered
- WebContents reuse detaches stale debugger/listener ownership

Measured surface-store teardown microbenchmark (Bun/Solid store, synthetic 500-tab map, 5,000 add/remove cycles):

- keyed path deletion: **31.02 ms**
- previous clone-the-whole-map deletion: **2,656.46 ms**
- measured speedup: **~85.6x** for this scaling case

This is intentionally a microbenchmark, not a claim that browser tab close is 85x faster end-to-end. It demonstrates that the old store-cleanup primitive itself scaled unnecessarily with total open-tab count, while the replacement does not.

Potential future resource policy should be explicit and benchmarked:

1. visible active tab: full rendering/automation
2. mounted inactive tab: Chromium background throttling/default hidden behavior
3. detached logical tab: no CDP session, no overlay observers, no live presentation work
4. long-idle tab: only consider discard/recreate if navigation/session persistence can be proven equivalent

Do not add aggressive suspend/discard heuristics without measuring wake latency, websocket/HMR behavior, media state, auth state, and agent-operation semantics.

An explicit browser-pane collapse currently unmounts the `<webview>` presentation. Under V3 this transitions the logical tab to `detached` rather than deleting it, so ownership/mute/URL metadata survives and reopening creates a replacement guest. This intentionally does **not** yet promise preservation of page-JS heap, live sockets, ephemeral scroll state, or media state across a collapsed pane. Keeping collapsed Chromium guests paintable/alive would improve continuity but costs memory and carries platform-specific hidden-webview behavior; benchmark before changing this policy.

## Race matrix / required tests

The following cases are architectural acceptance criteria, not optional edge cases:

| Race / transition | Required result |
|---|---|
| duplicate register same guest | no-op |
| replacement guest same logical lifetime | old listeners detached; logical state preserved |
| renderer detach then reattach | owner/mute/logical metadata preserved |
| close then late register | rejected by lifecycle generation |
| old unregister after successor lifetime | cannot detach successor |
| close while CDP operation active | arbiter preempt + debugger detach; operation cannot hang |
| annotation during guest replacement | old result rejected; no stale screenshot ack |
| stale human-input IPC from old guest | cannot seize control of successor |
| agent open | first published attached state already agent-owned |
| duplicate tab | owner inherited before first publication |
| replacement guest | zoom/mute restored before attached publication |
| attach timeout | lifecycle is closed; late attachment rejected |
| close while still requested/unattached | logical lifetime closes immediately; pending agent open rejects rather than timing out |
| renderer UI remount | must not logically close the tab |

Current new tests cover lifecycle state transitions, detach/re-attach persistence, late attach after close, requested-before-attach close, immediate cancellation of pending agent opens, first-publication ownership, forced annotation replacement, reused WebContents listener cleanup, exact duplicate registration no-op behavior, protocol lifecycle-field isolation, state-push deduplication, surface-store write deduplication, and O(1) keyed surface deletion with unrelated identity preservation.

## Remaining implementation campaign

### P0 — lifecycle correctness

- [x] introduce main-owned lifecycle generation
- [x] propagate lifecycle generation through tab request -> preload/IPC -> register/unregister
- [x] split presentation detach from logical remove
- [x] reject late registrations after logical close
- [x] preserve owner/mute metadata across presentation replacement
- [x] restore mute/zoom before attached publication
- [x] configure agent ownership before first state publication
- [x] use process-monotonic lifecycle generations and remove closed entries
- [x] cancel requested-but-unattached logical tabs without waiting for attach timeout
- [x] keep lifecycle generation off the sidecar/broker protocol wire
- [x] add explicit close-vs-unregister and old-lifetime-vs-successor adversarial tests
- [x] transition crashed/destroyed presentations to logical `detached` state
- [x] reject annotation startup against detached/destroyed presentations

### P1 — per-tab lifecycle serialization

T3 serializes create/register/replace/close transitions. The current OpenCode flow is mostly synchronous in main, so lifecycle generations already eliminate the dangerous late-commit class. If tab creation/removal gains awaited work, introduce a small per-tab serialized mutation queue rather than a broad global lock.

Do **not** add a mutex merely to imitate T3; add it at the first async commit boundary where generation checks alone cannot make the transition atomic.

### P1 — renderer presentation lease

The logical/presentation split now makes transient unmount safe in main. A renderer-level lease/grace mechanism may further reduce unnecessary Chromium teardown during route/layout churn, but only if profiling proves such churn remains common. Prefer stable Solid identity first; avoid timers as a substitute for correct keyed ownership.

### P1 — background-tab benchmark campaign

Measure rather than assume:

- 1 / 5 / 20 tabs
- visible vs hidden vs detached
- CPU idle
- working set / renderer process private bytes
- GPU process activity
- tab-switch latency
- websocket/HMR continuity
- automation wake latency

Then choose throttling policy.

### P2 — WebContentsView falsification prototype

Only build this prototype if there is a concrete reason to suspect a significant gain. It must be disposable and must retain the `<webview>` V3 implementation as behavioral oracle.

Minimum parity matrix:

- viewport geometry at app zoom 80/100/125%
- OS scale 100/125/150/200%
- mixed-DPI monitor transition
- fixed/freeform viewport transforms
- scroll alignment
- agent cursor
- element badges
- annotation overlay
- resize rails
- tab switching
- crash recovery
- DevTools
- recording/screenshot
- 1/5/20-tab CPU and memory

Adopt only if the measured gain is substantial enough to offset the composition complexity. A small single-digit CPU difference with similar memory is not sufficient.

## Validation gates

A browser architecture patch is not done unless:

1. desktop browser unit/integration suites pass
2. app browser suites pass
3. browser-specific type diagnostics are clean (whole-repo typecheck may have unrelated concurrent failures)
4. diff check is clean
5. no lifecycle IPC path omits `lifecycleGeneration`
6. no renderer cleanup path permanently removes a logical tab
7. late/stale registration is covered by executable tests
8. no change depends on `WebContents` object identity surviving destruction

### Current validation result

- desktop browser unit/integration suite: **122 pass, 0 fail, 356 assertions** across 11 files
- app browser suite: **51 pass, 0 fail, 146 assertions, 6 snapshots** across 4 files
- browser-scoped `git diff --check`: clean (line-ending conversion warnings only)
- full desktop production build: **exit 0**
  - main SSR bundle: 74 modules, **40.85 s**
  - preload bundle: 5 modules, **80 ms**
  - renderer bundle: 4,924 modules, **1m 05s**
- app repo-native typecheck remains red only in unrelated dirty-worktree context/history/chat-sidebar files; no browser-path diagnostic was emitted
- direct desktop `tsc --noEmit` has one matched preload diagnostic outside this browser campaign (`compressExport` uses a generic `Uint8Array<ArrayBuffer>` against the active TS lib); no browser-main diagnostic was emitted
- localMCP scoped TS checker is not authoritative on this machine because its bundled TypeScript installation is missing `lib.esnext.full.d.ts`; repository-native checks/builds are used instead

## Non-goals

- Do not migrate to `WebContentsView` by default.
- Do not rewrite the viewport solver that is already pure/tested.
- Do not move visual overlays into guest pages merely to accommodate native-view layering.
- Do not introduce a framework-wide state manager for browser lifecycle.
- Do not enable persistent CDP domains without a demonstrated event consumer.
- Do not trade deterministic lifecycle correctness for speculative tab suspension savings.

## Architectural summary

The Pareto-oriented target is:

> **DOM-native presentation, main-owned authority.**

`<webview>` is retained because it is the strongest presentation primitive for OpenCode's deeply composited browser UX. Its historical weakness—renderer-coupled lifecycle—is addressed directly rather than by replacing the rendering primitive. The result should keep the geometry/overlay advantages demonstrated by T3Code and OpenChamber while importing the stronger lifetime discipline that T3's desktop manager has learned through extensive adversarial testing.
