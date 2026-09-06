# Annotation Subsystem Audit (P0, read-only)

Sole-writer: `auditor`. Scope: per-file enumeration of what the OpenFork browser
annotation feature already discharges vs. what is genuinely missing. Goal: stop
other lanes from rebuilding working subsystems.

Verified blackboard facts consumed (do not relitigate): `context/baseline-corrections`,
`decisions/context-isolation-adr` (ADR-001 Option B), `contracts/invariants`,
`context/repo-conventions`. These are treated as authoritative.

Convention: status is **PRESENT** (works, trust boundary intact), **PARTIAL**
(works but a gap remains that a lane must close), or **MISSING** (absent).

---

## Per-file responsibility matrix

### `packages/desktop/src/main/browser/annotation.ts` (host AnnotationController)
| Responsibility | Status | Evidence |
|---|---|---|
| One-active-session-per-tab; new pick cancels stale | PRESENT | `start()` calls `cancel(tabId)` (35); `sessions` map (29) |
| Settle/teardown on all terminal paths | PRESENT | `settle`→`teardown` (39-44); `teardown` removes listeners (70-80) |
| Payload gate at trust boundary | PRESENT | `isBrowserAnnotationPayload(raw)` (88); malformed → cancel+settle null (92-93) |
| `ackCapture` on BOTH success and failure paths | PRESENT | `ackCapture(wc)` at 112, 126, 135 |
| Screenshot-null degradation on capture failure | PRESENT | catch → `settle({...base, screenshot:null})` (131-136) |
| Cancel is not an error (resolves null) | PRESENT | `onDestroyed`/`onNavigate` → `settle(null)` (49-50) |
| Navigation teardown (did-start-navigation subscription) | PRESENT | `wc.on("did-start-navigation", onNavigate)` (54), `onNavigate`→settle null (50) |
| Capture is rect-clamped/rounded against live viewport | PARTIAL | `Math.max/round` on rect (118-123) — but NO generation re-assert before `capturePage` (see missing) |
| Generation guard (re-assert registry generation before capture) | MISSING | `start(tabId,wc,...)` takes no generation arg (34); no `registry.get(tabId).generation` check before `wc.capturePage(rect)` (124) |
| Timeout on submit/capture | MISSING | no `setTimeout`/`AbortController` anywhere in file |
| IPC sender allowlist (fine-grained) | MISSING (coarse) | relies on `trusted()` in ipc.ts only; controller itself adds no sender authz |

### `packages/desktop/src/main/browser/contracts.ts` (canonical contract + guards)
| Responsibility | Status | Evidence |
|---|---|---|
| 5 annotation channels | PRESENT | 32-36 |
| Hard caps: MARQUEE_MAX_ELEMENTS=20, CROP_PADDING_PX=20, MIN_MARQUEE_SIZE_PX=3 | PRESENT (constants) | 38-40 |
| Structural payload type `BrowserAnnotationPayload` (screenshot:null) | PRESENT | 410-423 |
| Trust guard: reject `screenshot !== null` | PRESENT | `if (value.screenshot !== null) return false` (1096) |
| Shape validation of nested arrays (elements/regions/strokes/styleChanges) | PRESENT | 1092-1095 |
| Enforce hard caps on element count | PRESENT (post-P1) | `isBrowserAnnotationPayload` now enforces element<=64 (contracts-eng P1, 2026-09-04) |
| Enforce `htmlPreview` / `styles` byte length | PRESENT (post-P1) | htmlPreview<=2048, styles<=2048 enforced (P1) |
| Enforce stroke count / points-per-stroke count | PRESENT (post-P1) | strokes<=16, points/stroke<=2000 enforced (P1) |
| Enforce comment length | PRESENT (post-P1) | comment<=4000 enforced (P1) |
| Enforce style-change count | PRESENT (post-P1) | styleChanges<=64 enforced (P1) |
| Rect finiteness/non-negativity | PRESENT (post-P1) | payload rects validated finite + non-negative (P1) |
| React-source frame validation | PRESENT | `isAnnotationSourceFrame` (1045-1049) |

> The validator enforces the **screenshot===null trust boundary** and structural
> shape, but **none** of the hard size caps. All caps are enforced (if at all)
> only client-side in the overlay, NOT at the trust boundary. A guest bypassing
> the overlay (or a malformed-but-shaped payload) can send unbounded arrays/strings.

### `packages/desktop/src/main/browser/index.ts` (BrowserEngine facade)
| Responsibility | Status | Evidence |
|---|---|---|
| Owns `AnnotationController` instance | PRESENT | `readonly annotation = new AnnotationController()` (82) |
| Exposes `startAnnotation`/`cancelAnnotation` via `BrowserRenderApi` | PRESENT | 73-74, 358-365 |
| `startAnnotation` resolves null when tab unknown | PRESENT | `if (!tab) return Promise.resolve(null)` (360) |
| Cancels annotation on stop / tab close | PRESENT | `stop()` loops `annotation.cancel` (177); `closeTabInternal` calls cancel (375) |
| Resolves guest preload path | PRESENT | `resolveGuestPreloadPath()` (398-399) |
| Generation passed through to registry | PRESENT | `registerWebview(..., generation=0)` (234-235) |

### `packages/desktop/src/main/browser/guest.ts` (GuestRegistry)
| Responsibility | Status | Evidence |
|---|---|---|
| Guest identity/lifecycle registry | PRESENT | whole file |
| Trusted-host check on register | PRESENT | `isTrustedHost` (114), `isValidGuestWebContents` (38-42) |
| `generation` field + registration-staleness guard | PRESENT (but NOT navigation-tracked) | `record.generation = generation` (138); `if (existing && generation < existing.generation) throw` (105) |
| **Bump `generation` on did-navigate main-frame** | **MISSING** | `wireGuest` handlers `did-navigate`/`did-navigate-in-page`/`did-start-loading` (282-291) update `url`/`readyState`/`loading` only — **never touch `record.generation`**. No `bump` exists. |
| Per-tab state broadcast | PRESENT | `sync`, `onStateChange` |
| Human-input IPC handling | PRESENT | `wc.on("ipc-message", ...)` (328-333) |
| URL scheme lockdown | PRESENT | `will-navigate` guard (341-346) |

> **Critical consequence (Q1):** `generation` is a registration-monotonicity
> value, NOT a navigation epoch. The controller therefore CANNOT rely on
> `generation` to detect navigation — and correctly does not; it subscribes to
> `did-start-navigation` itself (annotation.ts:54). Any lane that assumes "watch
> generation for navigation" is wrong; navigation is handled by the controller's
> own listener.

### `packages/desktop/src/main/browser/arbitration.ts` (control arbitration)
| Responsibility | Status | Evidence |
|---|---|---|
| Epoch-guarded debugger sender (preempt mid-action) | PRESENT | `createEpochGuardedSender` (40-53) |
| Expected-agent-input queue (human vs echo) | PRESENT | `ExpectedAgentInputQueue` (75-110) |
| Human-preempt decision + window | PRESENT | `handleHumanInput` (121-132), `ControllerState` (138-168) |
| Annotation-specific arbitration | NOT APPLICABLE | arbitration is browser-input general; annotation reuses it via human-input path (P9/P10 lane). No annotation-specific gap. |

### `packages/desktop/src/guest/annotation-overlay.ts` (guest overlay)
| Responsibility | Status | Evidence |
|---|---|---|
| Closed-shadow-DOM overlay (Z_INDEX_OVERLAY=2147483646) | PRESENT | `attachShadow({mode:"closed"})` (310), `Z_INDEX_OVERLAY` (36) |
| Marquee with element-center hit test, capped 20 | PRESENT | `finishMarquee` (517-551), `ANNOTATION_MARQUEE_MAX_ELEMENTS` slice (542) |
| Strokes (smoothed path) + erase | PRESENT | `finishDraw` (585-588), `eraseAt` (598-618) |
| Style editor (transactional baseline capture) | PRESENT | `applyStyleChange` (634-650), `restoreBaseline` (385-391) |
| `elementsFromPoint` recursive + same-origin iframe descent | PRESENT | `pickFromPointIn` (107-132), `collectFrameCandidates` (139-150) |
| Always sends `screenshot: null` | PRESENT | payload `screenshot: null` (710) |
| Keyboard IME `isComposing` short-circuit on submit | PRESENT | `if (event.key !== "Enter" || event.isComposing) return` (470) |
| Tool shortcuts r/R/d/e/v/V + Escape cancel | PRESENT | 478-481, 462-467 |
| React-fiber metadata via DOM expando (degrades to null) | PRESENT | `reactComponentContext` (267-283), degrades (272-282) |
| Hide EDITOR CHROME at submit, keep marks + temp CSS | PARTIAL | `setChromeVisible(false)` hides `toolbarEl`+`stylePanelEl` (751-754) and `submit` keeps cropRect; marks (outlineLayer/drawSvg) and temp CSS (!important) remain; **BUT `commentEl`/comment bar is NOT hidden** (see gap below) |
| Restore baselines only after host capture-complete ack | PRESENT | `ipcRenderer.on(ANNOTATION_CAPTURED_CHANNEL, restoreAndTeardown)` (724-726) |
| Temp-CSS restoration correct (setProperty vs removeProperty) | PRESENT | `restoreBaseline` (385-391) |
| Teardown on every terminal path | PRESENT | `restoreAndTeardown` called by cancel/nav/ack (360-378) |
| Hide COMMENT BOX at submit (per invariant #5) | MISSING | `setChromeVisible` only toggles `toolbarEl` and `stylePanelEl`; `commentEl` (module-scoped, 63) and its `commentBar` are never hidden → comment textarea appears in the captured crop |

### `packages/desktop/src/guest/preview-preload.ts` (guest preload composition)
| Responsibility | Status | Evidence |
|---|---|---|
| Composes annotation-overlay into guest preload | PRESENT | `import "./annotation-overlay"` (14) |
| Reports human input over `HUMAN_INPUT_CHANNEL` | PRESENT | `send` → `ipcRenderer.send` (16-18) |
| Sandbox-only surface (`ipcRenderer`) | PRESENT | imports `ipcRenderer` only (11) |

### `packages/desktop/src/preload/index.ts` (renderer→main bridge)
| Responsibility | Status | Evidence |
|---|---|---|
| `startAnnotation`/`cancelAnnotation` exposed on `window.api.browser` | PRESENT | 61-62 |
| `getGuestPreloadPath` exposed | PRESENT | 22 |
| All other browser.* surface mirrored | PRESENT | 13-63 |

### `packages/app/src/pages/session/v2/browser-panel-v2.tsx`
| Responsibility | Status | Evidence |
|---|---|---|
| Hosts the Annotate control (P4 entry point) | **NOT HERE** | grep "annotat" → **0 matches** in this file. The control lives in the sibling `browser/HostedBrowserWebview.tsx` (data-testid="browser-annotate" at 673, `toggleAnnotate` at 534). **Correction to baseline:** the P4 entry point is PRESENT, just in `HostedBrowserWebview.tsx`, not this file. Do NOT rebuild it. |
| Renders HostedBrowserWebview tab strip | PRESENT | 144-154 |

### `packages/app/src/pages/session/v2/browser/browserAnnotationPrompt.ts` + `browserHostClient.ts`
| Responsibility | Status | Evidence |
| Prompt serializer (structured → `<browser_annotation>` text block) | PRESENT | `buildBrowserAnnotationPrompt` (41-65) |
| `BrowserAnnotationResult` app-side mirror type | PRESENT | `browserHostClient.ts` 107-119 |
| `startAnnotation`/`cancelAnnotation` client wrappers | PRESENT | 461-462 |
| `annotationTarget` bridge to composer (attach/send) | PRESENT | `setAnnotationTarget` (349-351) |
| Blob-store image attachment (per-annotation PNG) | PARTIAL | `HostedBrowserWebview.tsx` `buildAnnotationParts` uses `platform.draftStore.putBlob`/`createBlobReference` (468-489) — but note `platform.draftStore` is the **IndexedDB renderer store** (`draft-store.ts:136`), NOT the IPC `draft-blob-put`/`draft-blob-get` handlers (those string literals appear NOWHERE in `packages/app/src`). |
| **Draft persistence across reload** | **MISSING** | `buildAnnotationParts` returns parts that are placed into the composer's LIVE capture buffer (`capture.set(...)`, 495). Nothing calls `platform.draftStore.setItem`/persist (or the `draft-blob-put` IPC) for the annotation, so the annotation is **memory-only today and does not survive a reload**. This is renderer-eng's actual P6 job (see v2 corrections below). |
| Screenshot-failure degradation (text still lands) | PRESENT | catch keeps text parts (484-487); `sendAnnotation` falls back to attach (508-515) |
| i18n for all visible copy (annotate/unavailable toasts) | PRESENT | `language.t("browser.annotate.toast.*")` (513,541,554) |

### `packages/desktop/src/main/ipc.ts` (browser-* handlers, lines 320-444)
| Responsibility | Status | Evidence |
|---|---|---|
| `browser-start-annotation` / `browser-cancel-annotation` handlers | PRESENT | 437-444 |
| Trusted-sender check on every handler | PARTIAL (coarse) | `trusted = BrowserWindow.fromWebContents(event.sender) !== null` (318-319) — verifies it is *a* renderer window, not a guest webview, but does not pin a specific allowed sender identity/allowlist (per invariant: "trusted check still coarse") |
| `browser-get-guest-preload` handler | PRESENT | 433-436 |

### `packages/desktop/src/main/windows.ts` (`wireWebviewHardening`)
| Responsibility | Status | Evidence |
|---|---|---|
| Force `contextIsolation=true`, `sandbox=true`, `nodeIntegration=false` | PRESENT (policy, do NOT weaken) | 136-139 |
| Force guest preload; delete any caller preload | PRESENT | `delete webPreferences.preload` (135) then `= guestPreloadPath` (145) |
| Force `BROWSER_PARTITION` (defense-in-depth) | PRESENT | 149 |
| Block non-http(s)/about: guest src | PRESENT | 152-156 |
| `webSecurity=true`, `allowRunningInsecureContent=false`, `experimentalFeatures=false`, `webviewTag=false` | PRESENT | 140-144 |
| Legitimate escape hatch | **MISSING BY DESIGN** | No conditional/opt-out path; this is the policy ADR-001 mandates. |

### `packages/desktop/electron.vite.config.ts`
| Responsibility | Status | Evidence |
|---|---|---|
| Guest preload `preview` entry = `src/guest/preview-preload.ts` | PRESENT | 97 |
| Preload `index` entry | PRESENT | 93 |

---

## Genuinely missing (the real P-work)

1. **Generation guard in the controller (invariant #8).** ~~`AnnotationController.start` takes
   no `generation`; nothing re-asserts `registry.get(tabId).generation` between `handlePicked`
   and `wc.capturePage`.~~ **CLOSED by host-eng P2/P5 (2026-09-04):** identity.generation is
   captured at start and re-asserted before AND after the async `capturePage` via
   `isActionable()` (registry getCurrentGeneration === generation); mismatch resolves null and
   sends NO capture-complete to a stranger's guest. Per Q1, generation does NOT bump on
   did-navigate, so the separate `did-start-navigation` subscription (main-frame only) plus the
   post-capture settled guard both catch navigation — not removed.

2. **Timeout on submit/capture.** ~~No timeout guards `start`/`handlePicked`/`capturePage`.~~
   **CLOSED by host-eng P2/P5:** a 5s hard cap on submitting+capturing; on expiry settles
   `{annotation, screenshot:null}` instead of hanging the Annotate button.

3. **Hard caps NOT enforced at the trust boundary.** ~~`isBrowserAnnotationPayload` validates
   shape + `screenshot===null` but enforces zero of: element count, `htmlPreview`/`styles`
   byte length, stroke count, points-per-stroke, comment length, style-change count.~~
   **CLOSED by contracts-eng P1 (2026-09-04):** element<=64, strokes<=16, points/stroke<=2000,
   styleChanges<=64, comment<=4000, htmlPreview<=2048, styles<=2048, rect finiteness +
   non-negativity, and screenshot must be exactly null (rejects `undefined` too). Whole
   message rejected on breach. Caps are now enforced at the trust boundary, not just
   guest-side. No further work for this lane; host-eng/guest-eng should import the new
   `packages/desktop/src/main/browser/annotation-geometry.ts` pure helpers (normalizeRect,
   unionCropRect, harvestMarquee, smoothStrokePath, annotationEnterKey, applyRegionRetention)
   instead of reinventing crop-union / marquee / keyboard math.

4. **Comment box not hidden at submit (invariant #5).** `setChromeVisible(false)` hides
   toolbar + style panel but leaves `commentEl`/comment bar visible, so the capture
   crop shows the user's comment textarea. Marks + temp CSS are correctly kept.
   **Lane: guest-eng (P3/P7/P8).**

5. **Fine-grained IPC sender allowlist.** `trusted()` only checks "is a renderer
   window". Acceptable as a coarse gate, but no per-channel/per-identity allowlist.
   **Lane: integration-eng (P9/P10) — tighten if threat model requires.**

6. **Main-world React bridge (P10) is absent — BY DESIGN (last phase).** The overlay
   already reads React fiber off DOM expandos (works under contextIsolation) and
   **degrades** to `componentName:null`/`source:null` when unavailable (the mandated
   Option-C fallback, PRESENT). The bounded main-world bridge (CDP
   `addScriptToEvaluateOnNewDocument`/`Runtime.evaluate` or `webFrame.executeJavaScript`)
   returning size-capped JSON is the strict enhancement that is intentionally last.
   **Lane: integration-eng (P10). Do not block P1–P9 on it.**

7. **P4 entry point: NOT missing.** Baseline flagged `browser-panel-v2.tsx` as the
   absent entry point; in fact the Annotate control + attach/send already exist in
   `browser/HostedBrowserWebview.tsx` (toggleAnnotate, buildAnnotationParts, sendAnnotation,
   blob-store). **renderer-eng should extend, not rebuild.** Confirmed by coordinator
   (baseline-corrections-v2): do NOT add a second control in `browser-panel-v2.tsx` — that
   would create two competing entry points and two sources of truth for `annotating`.

8. **P6 draft persistence: MISSING (coordinator correction).** `draft-blob-put` /
   `draft-blob-get` IPC handlers exist in `ipc.ts` but are called NOWHERE in
   `packages/app/src`; the renderer's `platform.draftStore` is IndexedDB-backed and the
   annotation only puts its blob there transiently — the annotation is never written into a
   persisted draft document. Annotations are memory-only and do not survive a reload. This
   is renderer-eng's actual P6 job. (The blob *image* can be stored; the *draft reference*
   is what is unpersisted.)

---

## Discovery questions (file:line evidence)

**Q1. Does GuestRegistry increment `generation` on did-navigate main-frame, or only on
webview element replacement?**
Only on webview element (re)registration. `record.generation = generation` is set once in
`register()` (`guest.ts:138`) from the renderer-supplied value (`index.ts:235`,
`HostedBrowserWebview.tsx` `mountGeneration()` starts at `0` and is never incremented in
the renderer). The `wireGuest` navigation handlers — `did-navigate` (282),
`did-navigate-in-page` (287), `did-start-loading` (259), `did-finish-load` (271) — update
only `url`/`readyState`/`loading`; **none mutate `record.generation`**. There is no bump
API on `GuestRegistry`. Therefore the controller must (and does) subscribe to navigation
directly via `wc.on("did-start-navigation", onNavigate)` (`annotation.ts:54`) rather than
relying on `generation`. `generation` is purely a registration-staleness guard
(`guest.ts:105`).

**Q2. Is there a `captureRect` primitive, or only `captureViewport`? Does `capturePage`
get retry/visibility handling elsewhere?**
Only `capturePage`. `annotation.ts:124` calls `wc.capturePage(rect)` (Electron's
`WebContents.capturePage` accepts a `rect` arg — that is the "capture rect" primitive;
there is no separate `captureRect`/`captureViewport` named function). `operations.ts:584`
uses CDP `Page.captureScreenshot` for the *agent* screenshot op — unrelated to
annotation. No retry or visibility-wait wraps the annotation `capturePage`; failure is
caught and degraded to `screenshot: null` (`annotation.ts:131-136`). No "wait until
visible/stable" guard exists.

**Q3. What exactly does `wireWebviewHardening` force, and is there any legitimate escape hatch?**
Forces, in `will-attach-webview` (`windows.ts:130-158`): deletes any caller preload then
sets `preload = guestPreloadPath` (135,145); `nodeIntegration=false` (136);
`nodeIntegrationInSubFrames=false` (137); `contextIsolation=true` (138); `sandbox=true`
(139); `webSecurity=true` (140); `allowRunningInsecureContent=false` (141);
`experimentalFeatures=false` (142); `webviewTag=false` (144); `partition=BROWSER_PARTITION`
(149, defense-in-depth); and `preventDefault()` for any non-`http(s)`/`about:` src
(152-156). **No escape hatch** — every value is hard-set with no conditional, and bad src
is prevented. This is the enforced policy of ADR-001 and must not be weakened.

**Q4. Does `isBrowserAnnotationPayload` enforce ALL hard caps and reject `screenshot != null`?**
Rejects `screenshot != null`: **YES** (`contracts.ts:1096`, `if (value.screenshot !== null) return false`).
Enforces hard caps: **YES as of P1 (contracts-eng, 2026-09-04).** Originally this audit found the
validator checked JS *types/shapes* only and enforced **none** of the caps (element/htmlPreview/
styles/stroke/points/comment/style-change length). P1 wired every cap into
`isBrowserAnnotationPayload` plus rect finiteness/non-negativity, and additionally rejects
`screenshot === undefined` (not just `!== null`) as a spoof. Original finding (pre-P1):
- element count: not checked (`isAnnotationElementContext`, 1051-1060; array validated via `.every` with no length bound).
- `htmlPreview` byte length: not checked (1056, string type only).
- `styles` byte length: not checked (1059, string type only).
- stroke count: not checked (`isAnnotationStroke` 1065-1072, `points` is array-checked but not length-bounded).
- points per stroke: not checked.
- comment length: not checked (1091, string type only).
- style-change count: not checked (1095, array-every only).
All caps that exist are guest-side constants (`ANNOTATION_MARQUEE_MAX_ELEMENTS` etc.) used
only by the overlay. The trust boundary does not re-enforce any of them.

**Q5. Does `annotation-overlay.ts` hide editor chrome but KEEP marks+temp CSS at submit,
and restore baselines only after host capture-complete ack?**
Yes, with one gap. `submit()` (`annotation-overlay.ts:692-720`): builds payload, calls
`setChromeVisible(false)` (718), then `ipcRenderer.send(ANNOTATION_PICKED_CHANNEL, payload)`
(719). `setChromeVisible(false)` (751-754) hides `toolbarEl` and `stylePanelEl` only.
Marks — selection outlines, region boxes, ink (`outlineLayer`/`drawSvg`) — are never
touched and remain visible. Temp CSS (`!important` edits applied via `applyStyleChange`,
634-650) stays on the live page elements. Baselines are restored **only** on
`ANNOTATION_CAPTURED_CHANNEL` → `restoreAndTeardown` (724-726), which calls
`restoreBaseline` per target (385-391) using correct `setProperty`/`removeProperty`
semantics (388-389). **Gap:** the comment textarea (`commentEl`/`commentBar`) is NOT hidden
by `setChromeVisible`, so it appears in the crop. Invariant #5 says "toolbar, comment box,
hover outline" should be hidden; toolbar+style-panel are, comment box is not.

**Q6. Is there a keyboard handler with `isComposing` short-circuit?**
Yes, on the submit path. `onKeyDown` (`annotation-overlay.ts:458-482`): when the comment is
focused, `if (event.key !== "Enter" || event.isComposing) return` (470) — IME composition
never submits. Tool-key shortcuts (v/r/d/e) do not check `isComposing`, but they are
non-destructive. The critical submit/Enter path is correctly guarded.

**Q7. How does the guest reach the host today — direct send, or sendToHost → webview
ipc-message → window.api.browser.* ?**
**Direct `ipcRenderer.send` from the guest preload to the main process** — there is no
`sendToHost`/renderer-window.api hop for annotation traffic. The overlay uses
`ipcRenderer.send(ANNOTATION_PICKED_CHANNEL, payload)` (719) and `ipcRenderer.on(...)` for
the annotation channels (724-739). Human input uses `ipcRenderer.send(HUMAN_INPUT_CHANNEL)`
(`preview-preload.ts:17`), handled in `guest.ts` via `wc.on("ipc-message", ...)` (328-333).
The renderer only *initiates* start/cancel through `window.api.browser.startAnnotation`
(`preload/index.ts:61` → `ipcRenderer.invoke("browser-start-annotation")` → `ipc.ts:437` →
`engine.api.startAnnotation` → `controller.start` → `wc.send(ANNOTATION_START_CHANNEL)`),
which is a separate renderer→main `invoke`, not a guest→renderer bridge. So guest↔main is
direct IPC; the renderer is only the start/cancel trigger.

---

## ADR-001 — `contextIsolation` decision (recorded, do not relitigate)

**Status: DECIDED (Option B).** Source of truth: blackboard `decisions/context-isolation-adr`.

- OpenFork **forces** `contextIsolation=true`, `sandbox=true`, `nodeIntegration=false`
  via `wireWebviewHardening` (`windows.ts:136-139`). This is a BETTER security posture than
  T3Code and **must not be weakened**. Option A (mirror T3 by setting
  `contextIsolation=false`) is **REJECTED**.
- Consequence: an isolated preload world cannot see the page's
  `__REACT_DEVTOOLS_GLOBAL_HOOK__`. Therefore all DOM/geometry/drawing/style work stays in
  the isolated preload (`annotation-overlay.ts`); React component/source metadata comes
  through a **separate bounded main-world channel** (CDP `addScriptToEvaluateOnNewDocument`
  / `Runtime.evaluate`, or `webFrame.executeJavaScript`), returning only a
  structurally-validated, size-capped JSON string.
- **Option C (DOM-only, no React metadata) is the MANDATORY FALLBACK and the Phase-1
  default.** Absence of React metadata MUST degrade the annotation to
  `selector + HTML preview` (already implemented: `reactComponentContext` returns
  `componentName:null`/`source:null`, `annotation-overlay.ts:267-283`), NEVER fail it.
- Ordering: ship P1–P9 with DOM-only context as an explicitly acceptable state; P10
  (main-world bridge) is last and a strict enhancement.

**Security invariant (non-negotiable):** a compromised guest must never inject a
base64 "screenshot" as trusted host-captured evidence — `isBrowserAnnotationPayload`
rejects `screenshot !== null` and the host owns pixel capture. (contracts.ts:1096,
annotation.ts:88-95.)

---

## Lanes that should NOT rebuild working code

- **host-eng**: extend `AnnotationController` (generation guard Q1, timeout Q2) — do not
  rewrite; settle/teardown/payload-gate/ackCapture/screenshot-null degradation are PRESENT.
- **guest-eng**: extend overlay (hide comment box Q5) — marquee/strokes/style editor/a11y/
  isComposing are PRESENT; do not rewrite.
- **contracts-eng**: P1 DONE — caps enforced at boundary + pure geometry module; API frozen, do
  not rewrite.
- **renderer-eng**: the Annotate control + attach/send already exist in
  `browser/HostedBrowserWebview.tsx` (NOT `browser-panel-v2.tsx`). Extend (P6 draft
  persistence), do not rebuild. **Do not add a second control in `browser-panel-v2.tsx`.**
- **integration-eng**: tighten IPC allowlist (Q5-coarse) and build the P10 main-world bridge
  last.

---

## Reconciliation log (coordinator decisions, applied post-first-draft)

- **v2 correction #1 (entry point):** `browser-panel-v2.tsx` is NOT the missing P4 entry
  point. The control lives in `browser/HostedBrowserWebview.tsx` (toggleAnnotate,
  buildAnnotationParts, attachAnnotation, sendAnnotation, canAnnotate, i18n keys). Lanes
  must extend that file; a duplicate control in `browser-panel-v2.tsx` would create two
  sources of truth for `annotating`. (Audit already reflected this under per-file matrix +
  missing-gap #7.)
- **v2 correction #2 (P6 real gap):** the actual P6 work is draft persistence. The
  `draft-blob-put`/`draft-blob-get` IPC handlers are unused in the renderer; the annotation
  is memory-only and will not survive reload. The blob *image* can be IndexedDB-stored, but
  the annotation is never written into a persisted draft document. Audit updated: the
  "Draft persistence across reload" row is now MISSING (was overstated as PRESENT); added
  missing-gap #8.
- **Q1 (host-eng):** GuestRegistry does NOT bump `generation` on `did-navigate` — generation
  is registration-staleness ONLY. Generation alone does NOT protect against navigation; the
  separate `did-start-navigation` subscription (annotation.ts:54) must be kept. Do not
  "simplify" it away.
- **Q3:** `wireWebviewHardening` has NO escape hatch; ADR Option B is the only route.
- **Q7 (integration-eng):** the guest reaches the host via DIRECT `ipcRenderer.send`, not
  through the renderer's `window.api`. Correct trust-boundary shape; allowlist work must
  account for it.
- **Out of scope by agreement:** a stack trace is NOT emitted by the overlay and is not a gap
  to close. (contracts-eng removed the dead `ANNOTATION_MAX_STACK_FRAMES` constant so no
  reader assumes a cap is enforced.)

### P1 closure (contracts-eng, 2026-09-04)
The trust-boundary cap gap (missing-gap #3) is **CLOSED**. `isBrowserAnnotationPayload` now
enforces: element<=64, strokes<=16, points/stroke<=2000, styleChanges<=64, comment<=4000,
htmlPreview<=2048, styles<=2048, rect finiteness + non-negativity, and `screenshot===null`
(rejects `undefined` too). New pure, Electron-free module
`packages/desktop/src/main/browser/annotation-geometry.ts` holds `normalizeRect`,
`unionCropRect`, `harvestMarquee`, `smoothStrokePath`, `decimateStroke`, `strokeBounds`,
`annotationEnterKey`, `applyRegionRetention` (+ `REGION_COEXISTS_WITH_ELEMENTS`, default true —
the deliberate labelled divergence from T3 main; both branches unit-tested). 41 unit tests
pass. host-eng/guest-eng should import these instead of reinventing crop-union/marquee/
keyboard math. API frozen; later changes to those two files are announced before editing.
