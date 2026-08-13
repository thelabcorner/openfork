// Browser operations: the browser_* ops executed against a webview guest
// via CDP, using the premium agent-UX primitives (versioned refs, selector
// synthesis, element-state, React profiling — decisions/browser-premium-agent-ux)
// and the T3 mappings (deliverable/browser-phase0-embedding §2.5-2.6):
//   click -> Input.dispatchMouseEvent (RAW CSS px coords)
//   press -> Input.dispatchKeyEvent + focus emulation
//   type  -> in-page Runtime.evaluate DOM editing (NOT Input.insertText)
//   scroll-> in-page Runtime.evaluate scrollBy (NOT wheel)
//   recording -> Page.startScreencast / stop (JPEG q80 ~12fps)
// Every op returns an explicit object; failures throw typed errors (./errors)
// which the host maps to BrokerResponse.error (HTTP stays 200).

import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { nativeTheme } from "electron"

import type { ControlSessionManager, SendCommand } from "./control-session"
import type { GuestRecord, GuestRegistry } from "./guest"
import {
  BrowserError,
  BrowserGuestCrashedError,
  BrowserInvalidSelectorError,
  BrowserNotAReactAppError,
  BrowserNotAttachedError,
  BrowserOperationFailedError,
  BrowserStaleRefError,
  BrowserTabNotFoundError,
  BrowserTargetNotFoundError,
  BrowserTimeoutError,
  BrowserUnsupportedOperationError,
} from "./errors"
import {
  findCoordsExpression,
  findLocatorExpression,
  highlightScript,
  interactiveElementsScanScript,
  queryElementsScript,
  resolveElementScript,
  toElementState,
} from "./scripts-resolve"
import {
  AGENT_CURSOR_CLICK_LEAD_MS,
  AGENT_CURSOR_MOVE_MS,
  MAX_EVALUATION_BYTES,
  MAX_SCREENSHOT_WIDTH,
  NAVIGATE_TIMEOUT_MS,
  OPEN_ATTACH_TIMEOUT_MS,
  PROFILER_MAX_COMMITS,
  PROFILER_MAX_COMPONENTS,
  PROFILER_MAX_FIBERS_PER_COMMIT,
  PROFILER_MAX_PROPS,
  RECORDING_DEFAULT_MAX_BYTES,
  RECORDING_DEFAULT_MAX_DURATION_MS,
  RECORDING_FRAME_INTERVAL_MS,
  RECORDING_JPEG_QUALITY,
  WAIT_FOR_POLL_MS,
  type A11yNode,
  type AnnotateInput,
  type AnnotateOutput,
  type AnnotationTarget,
  type BrowserOperation,
  type BrowserPointerEvent,
  type ClickInput,
  type ClickOutput,
  type Coords,
  type ElementState,
  type ElementTarget,
  type HighlightOutput,
  type Locator,
  type OpenInput,
  type OpenOutput,
  type QueryOutput,
  type RefTarget,
  type ResolvedElement,
  type ScreenshotInput,
  type ScreenshotOutput,
  type SnapshotElement,
  type SnapshotOutput,
  type StatusOutput,
  type WaitForOutput,
  type WireGuestTabState,
} from "./contracts"
import { isCoords, isLocator, isRefTarget } from "./contracts"

export interface BrowserOperationsOptions {
  registry: GuestRegistry
  sessions: ControlSessionManager
  recordingDirectory: string
  maxResultBytes: number
  /** Renderer must mount a <webview> for the tab and register it. */
  onTabRequest: (request: { tabId: string; url: string; activate?: boolean }) => void
  /** Renderer must remove the <webview> DOM for the tab. */
  onTabClose: (tabId: string) => void
  /** Cursor choreography broadcast (browser-pointer-event). */
  onPointerEvent: (event: BrowserPointerEvent) => void
}

interface SnapshotRef {
  x: number
  y: number
  locator?: Locator
}

type AnnotationScriptItem = Pick<AnnotationTarget, "label" | "tone"> & {
  expression: string
}

export class BrowserOperations {
  private readonly pendingOpens = new Map<string, { resolve: (tab: GuestRecord) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly activeRecordings = new Map<string, ActiveRecording>()
  private pointerSequence = 0

  constructor(private readonly deps: BrowserOperationsOptions) {}

  /** Engine calls this when the renderer registers a webview for an open tab. */
  resolveOpen(runtimeTabId: string, tab: GuestRecord): void {
    const pending = this.pendingOpens.get(runtimeTabId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingOpens.delete(runtimeTabId)
    pending.resolve(tab)
  }

  async dispatch(tabId: string | undefined, operation: BrowserOperation): Promise<Record<string, unknown>> {
    switch (operation.name) {
      case "status":
        return (await this.status(tabId)) as unknown as Record<string, unknown>
      case "open":
        return (await this.open(operation.input)) as unknown as Record<string, unknown>
      case "navigate":
        return (await this.navigate(tabId, operation.input)) as unknown as Record<string, unknown>
      case "resize":
        return (await this.resize(tabId, operation.input)) as unknown as Record<string, unknown>
      case "set_appearance":
        return (await this.setAppearance(operation.input)) as unknown as Record<string, unknown>
      case "snapshot":
        return (await this.snapshot(tabId)) as unknown as Record<string, unknown>
      case "screenshot":
        return (await this.screenshot(tabId, operation.input)) as unknown as Record<string, unknown>
      case "click":
        return (await this.click(tabId, operation.input)) as unknown as Record<string, unknown>
      case "type":
        return (await this.type(tabId, operation.input)) as unknown as Record<string, unknown>
      case "press":
        return (await this.press(tabId, operation.input)) as unknown as Record<string, unknown>
      case "scroll":
        return (await this.scroll(tabId, operation.input)) as unknown as Record<string, unknown>
      case "evaluate":
        return (await this.evaluateOp(tabId, operation.input)) as unknown as Record<string, unknown>
      case "wait_for":
        return (await this.waitFor(tabId, operation.input)) as unknown as Record<string, unknown>
      case "recording_start":
        return (await this.recordingStart(tabId, operation.input)) as unknown as Record<string, unknown>
      case "recording_stop":
        return (await this.recordingStop(tabId, operation.input)) as unknown as Record<string, unknown>
      case "close":
        return (await this.close(tabId, operation.input)) as unknown as Record<string, unknown>
      case "highlight":
        return (await this.highlight(tabId, operation.input)) as unknown as Record<string, unknown>
      case "annotate":
        return (await this.annotate(tabId, operation.input)) as unknown as Record<string, unknown>
      case "query":
        return (await this.query(tabId, operation.input)) as unknown as Record<string, unknown>
      case "profiler_start":
        return (await this.profilerStart(tabId)) as unknown as Record<string, unknown>
      case "profiler_stop":
        return (await this.profilerStop(tabId)) as unknown as Record<string, unknown>
      default:
        throw new BrowserUnsupportedOperationError(`Unknown operation`)
    }
  }

  // --- status -----------------------------------------------------------------

  private async status(tabId: string | undefined): Promise<StatusOutput> {
    const active = this.activeTab(tabId)
    const tabs: WireGuestTabState[] = this.deps.registry.list().map((record) => this.deps.registry.tabState(record))
    return {
      status: {
        host: {
          connected: false,
          hostId: null,
          hostEpoch: null,
          connectionId: null,
          windowId: this.deps.registry.list()[0]?.windowId ?? "",
          capabilities: {
            maxSnapshotBytes: MAX_EVALUATION_BYTES,
            maxResultBytes: this.deps.maxResultBytes,
            supportedAppearances: ["system", "light", "dark"],
            supportsRecording: true,
            cdp: true,
          },
        },
        guest: {
          attached: this.deps.registry.size > 0,
          activeTabId: active?.runtimeTabId ?? null,
          url: active?.url ?? null,
          controller: active ? this.deps.registry.controller(active.runtimeTabId) : "none",
          zoomFactor: active?.zoomFactor ?? 1,
        },
        tabs,
      },
    }
  }

  // --- open / navigate / close ------------------------------------------------

  private async open(input: OpenInput): Promise<OpenOutput> {
    const runtimeTabId = randomUUID()
    const pending = new Promise<GuestRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOpens.delete(runtimeTabId)
        reject(new BrowserTimeoutError("open", OPEN_ATTACH_TIMEOUT_MS))
      }, OPEN_ATTACH_TIMEOUT_MS)
      this.pendingOpens.set(runtimeTabId, { resolve, timer })
    })
    this.deps.onTabRequest({ tabId: runtimeTabId, url: input.url, activate: input.activate ?? true })
    const attached = await pending
    const viewport = await this.readViewport(attached)
    return {
      opened: {
        tabId: attached.runtimeTabId,
        url: attached.url || input.url,
        title: attached.title,
        readyState: "Success",
        viewport,
      },
    }
  }

  private async navigate(
    tabId: string | undefined,
    input: { url: string; waitUntil?: string },
  ): Promise<Record<string, unknown>> {
    const tab = this.resolveTab(tabId)
    const from = tab.url
    await this.withControl(tab, "navigate", async (send) => {
      await send("Page.navigate", { url: input.url })
      await this.waitForNavigation(tab.runtimeTabId)
    })
    const viewport = await this.readViewport(tab)
    return {
      navigated: {
        tabId: tab.runtimeTabId,
        url: tab.url || input.url,
        title: tab.title,
        readyState: "Success",
        redirectedFrom: from === input.url || from === "" ? undefined : from,
        viewport,
      },
    }
  }

  private async close(tabId: string | undefined, input: { tabId?: string }): Promise<Record<string, unknown>> {
    const target = input.tabId ?? tabId
    const tab = target ? this.deps.registry.get(target) : this.deps.registry.list()[0]
    if (!tab) throw new BrowserTabNotFoundError(target)
    const wasActive = this.deps.registry.list()[0]?.runtimeTabId === tab.runtimeTabId
    this.deps.registry.unregister(tab.runtimeTabId)
    this.deps.onTabClose(tab.runtimeTabId)
    return {
      closed: {
        tabId: tab.runtimeTabId,
        wasActive,
        guestsRemaining: this.deps.registry.size,
      },
    }
  }

  // --- resize / appearance ----------------------------------------------------

  private async resize(
    tabId: string | undefined,
    input: { width: number; height: number; deviceScaleFactor?: number },
  ): Promise<Record<string, unknown>> {
    const tab = this.resolveTab(tabId)
    const width = Math.max(1, Math.round(input.width))
    const height = Math.max(1, Math.round(input.height))
    const dpr = input.deviceScaleFactor ?? 1
    await this.withControl(tab, "resize", async (send) => {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: dpr,
        mobile: false,
        screenWidth: width,
        screenHeight: height,
      })
    })
    const viewport = await this.readViewport(tab)
    return {
      resized: { width, height, dpr, actualWidth: viewport.width, actualHeight: viewport.height },
    }
  }

  private async setAppearance(input: { appearance: "light" | "dark" | "system" }): Promise<Record<string, unknown>> {
    const effective: "light" | "dark" =
      input.appearance === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : input.appearance
    this.deps.registry.setAppearance(input.appearance)
    const tab = this.deps.registry.list()[0]
    if (tab) {
      await this.withControl(tab, "set_appearance", async (send) => {
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: effective }],
        })
      })
    }
    return { appearance: input.appearance, effective }
  }

  // --- snapshot (premium: refs + selector synthesis + state) -------------------

  private async snapshot(tabId: string | undefined): Promise<SnapshotOutput> {
    const tab = this.resolveTab(tabId)
    const version = this.deps.registry.bumpSnapshotVersion(tab.runtimeTabId)
    const result = await this.withControl(tab, "snapshot", async (send) => {
      const scan = (await this.evaluate(send, interactiveElementsScanScript(), true)) as
        | { error: string }
        | {
            elements: Array<Record<string, unknown>>
            text: string
            truncated: boolean
            count: number
            viewport: { width: number; height: number; dpr: number; scrollX: number; scrollY: number }
            title: string
            readyState: string
            url: string
          }
        | null
      if (scan && "error" in scan) throw new BrowserOperationFailedError(scan.error)
      const axTree = await send("Accessibility.getFullAXTree").catch(() => undefined)
      const tree = buildA11yTree(axTree, 4)
      return { scan, tree }
    })
    const scan = result.scan
    const elements: SnapshotElement[] = []
    const refs = new Map<string, SnapshotRef>()
    if (scan && "elements" in scan) {
      for (const raw of scan.elements) {
        const ref = typeof raw["ref"] === "string" ? raw["ref"] : `e${elements.length + 1}`
        const rect = asRect(raw["rect"])
        const center = asPoint(raw["center"]) ?? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        const selector = asSelector(raw["selector"])
        const locator = raw["locator"] && isLocator(raw["locator"]) ? (raw["locator"] as Locator) : undefined
        refs.set(ref, { x: center.x, y: center.y, locator })
        elements.push({
          ref,
          tagName: typeof raw["tagName"] === "string" ? raw["tagName"] : typeof raw["role"] === "string" ? String(raw["role"]) : "element",
          text: typeof raw["text"] === "string" ? raw["text"] : null,
          selector: selector?.value ?? "",
          confidence: selector?.confidence ?? "low",
          rect,
          role: typeof raw["role"] === "string" ? raw["role"] : null,
          name: typeof raw["name"] === "string" ? raw["name"] : null,
          state: toElementState(raw["state"]),
          display: typeof raw["display"] === "string" ? raw["display"] : null,
          position: typeof raw["position"] === "string" ? raw["position"] : null,
          zIndex: typeof raw["zIndex"] === "number" ? raw["zIndex"] : null,
        })
      }
    }
    this.deps.registry.setSnapshotRefs(tab.runtimeTabId, refs)
    const viewport = scan && "viewport" in scan ? { ...scan.viewport, dpr: scan.viewport.dpr } : { width: 0, height: 0, dpr: 1, scrollX: 0, scrollY: 0 }
    return {
      snapshot: {
        tabId: tab.runtimeTabId,
        url: scan && "url" in scan ? String(scan.url) : tab.url,
        tree: result.tree,
        elements,
        text: scan && "text" in scan ? scan.text : "",
        truncated: scan && "truncated" in scan ? scan.truncated : false,
        count: scan && "count" in scan ? scan.count : elements.length,
        viewport,
        snapshotVersion: version,
      },
    }
  }

  private async screenshot(tabId: string | undefined, input: ScreenshotInput): Promise<ScreenshotOutput> {
    const tab = this.resolveTab(input.tabId ?? tabId)
    return this.withControl(tab, "screenshot", async (send) => {
      const format = input.format ?? "png"
      const params =
        format === "jpeg"
          ? { format, quality: Math.max(1, Math.min(100, input.quality ?? RECORDING_JPEG_QUALITY)), fromSurface: true, captureBeyondViewport: input.fullPage ?? false }
          : { format, fromSurface: true, captureBeyondViewport: input.fullPage ?? false }
      const captured = (await send("Page.captureScreenshot", params)) as { data?: unknown }
      if (typeof captured.data !== "string") throw new BrowserOperationFailedError("Screenshot capture returned no image data")
      const viewport = await this.readViewport(tab)
      return {
        screenshot: {
          tabId: tab.runtimeTabId,
          url: tab.url,
          title: tab.title,
          mime: format === "jpeg" ? "image/jpeg" : "image/png",
          data: captured.data,
          width: viewport.width,
          height: viewport.height,
          viewport,
          capturedAt: Date.now(),
        },
      }
    })
  }

  // --- click / highlight ------------------------------------------------------

  private async click(tabId: string | undefined, input: ClickInput): Promise<ClickOutput> {
    const tab = this.resolveTab(tabId)
    return this.withControl(tab, "click", async (send) => {
      const { coords, resolved } = await this.resolveTarget(send, tab, input.target)
      const viewport = (await this.evaluate(send, "({ width: window.innerWidth, height: window.innerHeight })", true)) as {
        width: number
        height: number
      }
      if (coords.x < 0 || coords.y < 0 || coords.x > viewport.width || coords.y > viewport.height) {
        throw new BrowserTargetNotFoundError(`Click coordinates (${coords.x},${coords.y}) outside viewport ${viewport.width}x${viewport.height}`)
      }
      const button = input.button ?? "left"
      const clickCount = input.clickCount ?? 1
      this.emitPointer(tab.runtimeTabId, "move", coords)
      await sleep(AGENT_CURSOR_MOVE_MS)
      this.emitPointer(tab.runtimeTabId, "click", coords)
      await sleep(AGENT_CURSOR_CLICK_LEAD_MS)
      this.deps.registry.expectAgentInput({
        kind: "pointer",
        x: coords.x,
        y: coords.y,
        button: button === "left" ? 0 : button === "middle" ? 1 : 2,
      })
      const params = { x: coords.x, y: coords.y, button, clickCount }
      await send("Input.dispatchMouseEvent", { ...params, type: "mousePressed" })
      await send("Input.dispatchMouseEvent", { ...params, type: "mouseReleased" })
      const after = this.deps.registry.get(tab.runtimeTabId)
      return {
        clicked: {
          target: resolved,
          coords,
          clickCount,
          afterUrl: after?.url || undefined,
          afterTitle: after?.title || undefined,
        },
      }
    })
  }

  private async highlight(
    tabId: string | undefined,
    input: { target: ElementTarget },
  ): Promise<HighlightOutput> {
    const tab = this.resolveTab(tabId)
    return this.withControl(tab, "highlight", async (send) => {
      const findExpr = await this.targetExpression(send, tab, input.target)
      const result = (await this.evaluate(send, highlightScript(findExpr), true)) as
        | { error: string }
        | { center?: { x: number; y: number } }
        | null
      if (result && "error" in result) throw new BrowserOperationFailedError(result.error)
      const center = result?.center ?? { x: 0, y: 0 }
      return {
        highlighted: {
          target: {
            selector: "",
            confidence: "low",
            rect: { x: center.x, y: center.y, width: 0, height: 0 },
            role: null,
            name: null,
            state: emptyState(),
            display: null,
            position: null,
            zIndex: null,
          },
          coords: center,
        },
      }
    })
  }

  private async annotate(tabId: string | undefined, input: AnnotateInput): Promise<AnnotateOutput> {
    const tab = this.resolveTab(input.tabId ?? tabId)
    return this.withControl(tab, "annotate", async (send) => {
      const targets = input.targets ?? []
      const annotations = await Promise.all(
        targets.map(async (item) => ({
          expression: await this.targetExpression(send, tab, item.target),
          label: item.label,
          tone: item.tone,
        })),
      )
      const result = (await this.evaluate(
        send,
        annotationScript(annotations, input.clear !== false, input.durationMs),
        true,
      )) as { count?: unknown } | null
      return {
        annotated: {
          tabId: tab.runtimeTabId,
          count: typeof result?.count === "number" ? result.count : 0,
          cleared: input.clear !== false,
          at: { time: Date.now() },
        },
      }
    })
  }

  // --- type / press / scroll --------------------------------------------------

  private async type(
    tabId: string | undefined,
    input: { text: string; target?: ElementTarget; clear?: boolean; submit?: boolean },
  ): Promise<Record<string, unknown>> {
    const tab = this.resolveTab(tabId)
    return this.withControl(tab, "type", async (send) => {
      const focusExpr = input.target
        ? await this.targetExpression(send, tab, input.target)
        : "document.activeElement"
      const encoded = JSON.stringify(input.text)
      const clear = input.clear ?? false
      const expression = `(() => {
        try {
          const target = ${focusExpr};
          if (!target) return { notFound: true };
          const isText = (el) => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
          const control = isText(target) ? target : target.isContentEditable ? target : null;
          if (!control) return { notText: true };
          ${clear ? "control.value = '';" : ""}
          const setter = Object.getOwnPropertyDescriptor(control.constructor.prototype, 'value')?.set;
          if (setter) setter.call(control, ${encoded});
          control.dispatchEvent(new Event('input', { bubbles: true }));
          control.dispatchEvent(new Event('change', { bubbles: true }));
          const caret = control.selectionStart ?? (control.textContent ?? '').length;
          ${input.submit ? "control.closest('form')?.requestSubmit();" : ""}
          return { ok: true, caret, submitted: ${input.submit ? "true" : "false"} };
        } catch (error) { return { error: String(error) }; }
      })()`
      const result = (await this.evaluate(send, expression, true)) as Record<string, unknown>
      if (result["error"]) throw new BrowserOperationFailedError(String(result["error"]))
      return {
        typed: {
          value: input.text,
          caret: typeof result["caret"] === "number" ? result["caret"] : input.text.length,
          submitted: result["submitted"] === true,
        },
      }
    })
  }

  private async press(
    tabId: string | undefined,
    input: { key: string },
  ): Promise<Record<string, unknown>> {
    const tab = this.resolveTab(tabId)
    const sequence = keySequence(input.key)
    return this.withControl(tab, "press", async (send, cleanup) => {
      try {
        await send("Page.bringToFront")
        await send("Emulation.setFocusEmulationEnabled", { enabled: true })
        this.deps.registry.expectAgentInput({ kind: "key", key: sequence.key, code: sequence.code })
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: sequence.key,
          code: sequence.code,
          modifiers: sequence.modifiers,
          windowsVirtualKeyCode: sequence.virtualKeyCode,
          nativeVirtualKeyCode: sequence.virtualKeyCode,
        })
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: sequence.key,
          code: sequence.code,
          modifiers: sequence.modifiers,
          windowsVirtualKeyCode: sequence.virtualKeyCode,
          nativeVirtualKeyCode: sequence.virtualKeyCode,
        })
      } finally {
        await cleanup("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined)
      }
      return {
        pressed: { key: input.key, repeat: false, modifiers: modifierNames(sequence.modifiers) },
      }
    })
  }

  private async scroll(
    tabId: string | undefined,
    input: { target?: ElementTarget; delta?: { x?: number; y?: number }; to?: "top" | "bottom" | "start" | "end" },
  ): Promise<Record<string, unknown>> {
    const tab = this.resolveTab(tabId)
    return this.withControl(tab, "scroll", async (send) => {
      const targetExpr = input.target ? await this.targetExpression(send, tab, input.target) : "window"
      const deltaX = input.delta?.x ?? 0
      const deltaY = input.delta?.y ?? 0
      const position =
        input.to === "top" ? "target.scrollTo({top: 0, behavior: 'instant'});"
        : input.to === "bottom" ? "target.scrollTo({top: target.scrollHeight, behavior: 'instant'});"
        : input.to === "start" ? "target.scrollTo({left: 0, behavior: 'instant'});"
        : input.to === "end" ? "target.scrollTo({left: target.scrollWidth, behavior: 'instant'});"
        : `target.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: 'instant' });`
      const expression = `(() => { try { const target = ${targetExpr}; if (!target) return { notFound: true }; ${position} return { ok: true }; } catch (error) { return { error: String(error) }; } })()`
      const result = (await this.evaluate(send, expression, true)) as Record<string, unknown>
      if (result["notFound"]) throw new BrowserTargetNotFoundError("Scroll target not found")
      if (result["error"]) throw new BrowserOperationFailedError(String(result["error"]))
      const viewport = await this.readViewport(tab)
      return { scrolled: { viewport, scrollX: viewport.scrollX, scrollY: viewport.scrollY } }
    })
  }

  // --- evaluate / wait_for ----------------------------------------------------

  private async evaluateOp(
    tabId: string | undefined,
    input: { script: string; awaitPromise?: boolean; maxResultBytes?: number },
  ): Promise<Record<string, unknown>> {
    const tab = this.resolveTab(tabId)
    const maxBytes = Math.min(input.maxResultBytes ?? this.deps.maxResultBytes, this.deps.maxResultBytes)
    const value = await this.withControl(tab, "evaluate", async (send) =>
      this.evaluate(send, input.script, input.awaitPromise ?? true),
    )
    const serialized = JSON.stringify(value)
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
      const prefix = serialized.slice(0, Math.max(0, maxBytes - 32))
      let result: unknown = null
      try {
        result = JSON.parse(prefix) ?? null
      } catch {
        result = null
      }
      return { evaluated: { result, type: Array.isArray(value) ? "array" : typeof value, truncated: true } }
    }
    return {
      evaluated: {
        result: value,
        type: Array.isArray(value) ? "array" : typeof value,
        truncated: false,
      },
    }
  }

  private async waitFor(
    tabId: string | undefined,
    input: { condition: { type: string; value?: string; text?: string; pattern?: string; script?: string; selector?: Locator }; state?: string; timeoutMs?: number },
  ): Promise<WaitForOutput> {
    const tab = this.resolveTab(tabId)
    const deadline = Date.now() + Math.min(input.timeoutMs ?? 10_000, 60_000)
    const conditionExpr = conditionExpression(input.condition)
    const state = input.state ?? "visible"
    let satisfied = false
    while (Date.now() < deadline) {
      const result = await this.withControl(tab, "wait_for", async (send) =>
        this.evaluate(
          send,
          `(() => {
            const r = ${conditionExpr};
            if (!r.found) return { satisfied: false };
            if (r.element) {
              const rect = r.element.getBoundingClientRect();
              const visible = rect.width > 0 && rect.height > 0;
              if (${state === "visible" ? "!visible" : "false"}) return { satisfied: false };
              return { satisfied: true };
            }
            return { satisfied: true };
          })()`,
          true,
        ),
      )
      if ((result as { satisfied?: boolean }).satisfied) {
        satisfied = true
        break
      }
      await sleep(WAIT_FOR_POLL_MS)
    }
    if (!satisfied) throw new BrowserTimeoutError("wait_for", input.timeoutMs ?? 10_000)
    return {
      waited: {
        condition: input.condition as WaitForOutput["waited"]["condition"],
        satisfied: true,
        at: { time: new Date().toISOString(), url: tab.url, title: tab.title },
      },
    }
  }

  // --- recording --------------------------------------------------------------

  private async recordingStart(
    tabId: string | undefined,
    input: { format?: string; maxBytes?: number; maxDurationMs?: number },
  ): Promise<Record<string, unknown>> {
    const tab = this.resolveTab(tabId)
    const recordingId = randomUUID()
    const maxBytes = input.maxBytes ?? RECORDING_DEFAULT_MAX_BYTES
    const maxDurationMs = input.maxDurationMs ?? RECORDING_DEFAULT_MAX_DURATION_MS
    const startedAt = new Date().toISOString()
    const frames: string[] = []
    let budget = maxBytes

    const unsubscribe = this.deps.sessions.onScreencastFrame((params) => {
      if (typeof params["sessionId"] === "number") {
        this.sendRaw(tab, "Page.screencastFrameAck", { sessionId: params["sessionId"] }, 1).catch(() => undefined)
      }
      if (typeof params["data"] !== "string") return
      if (budget - params["data"].length < 0) {
        this.sendRaw(tab, "Page.stopScreencast", undefined, 1).catch(() => undefined)
        return
      }
      budget -= params["data"].length
      frames.push(params["data"])
    })
    const timer = setTimeout(() => {
      this.sendRaw(tab, "Page.stopScreencast", undefined, 1).catch(() => undefined)
    }, maxDurationMs)
    const record: ActiveRecording = { recordingId, tabId: tab.runtimeTabId, startedAt, frames, timer, unsubscribe }
    this.activeRecordings.set(recordingId, record)

    try {
      await this.withControl(tab, "recording_start", async (send) => {
        await send("Page.startScreencast", {
          format: "jpeg",
          quality: RECORDING_JPEG_QUALITY,
          maxWidth: MAX_SCREENSHOT_WIDTH,
          everyNthFrame: 1,
        })
      })
    } catch (error) {
      clearTimeout(timer)
      unsubscribe()
      this.activeRecordings.delete(recordingId)
      throw error
    }
    return {
      recording: { recordingId, format: input.format ?? "jpeg-sequence", startedAt, tabId: tab.runtimeTabId },
    }
  }

  private async recordingStop(
    tabId: string | undefined,
    input: { recordingId?: string },
  ): Promise<Record<string, unknown>> {
    void tabId
    const recordingId = input.recordingId ?? Array.from(this.activeRecordings.keys())[0]
    const record = recordingId ? this.activeRecordings.get(recordingId) : undefined
    if (!record) throw new BrowserUnsupportedOperationError("No active recording to stop")
    const stoppedAt = Date.now()
    clearTimeout(record.timer)
    const tab = this.deps.registry.get(record.tabId)
    if (tab) {
      try {
        await this.withControl(tab, "recording_stop", async (send) => {
          await send("Page.stopScreencast")
        })
      } finally {
        record.unsubscribe()
        this.activeRecordings.delete(recordingId)
      }
    }
    const dir = this.deps.recordingDirectory
    mkdirSync(dir, { recursive: true })
    const artifactPath = join(dir, `${recordingId}.html`)
    writeFileSync(artifactPath, framesToHtml(record.frames))
    const sizeBytes = record.frames.reduce((acc, frame) => acc + Math.ceil((frame.length * 3) / 4), 0)
    return {
      recording: {
        recordingId,
        stoppedAt: new Date(stoppedAt).toISOString(),
        durationMs: Math.max(0, stoppedAt - Date.parse(record.startedAt)),
        sizeBytes,
        artifact: {
          type: "file",
          mime: "text/html",
          url: `file://${artifactPath.replace(/\\/g, "/")}`,
          path: artifactPath,
        },
      },
    }
  }

  // --- premium: query / profiler ----------------------------------------------

  private async query(
    tabId: string | undefined,
    input: { selector?: string; role?: string; text?: string; maxResults?: number },
  ): Promise<QueryOutput> {
    const tab = this.resolveTab(tabId)
    const maxResults = Math.min(input.maxResults ?? 50, 100)
    const locator: Locator = input.selector
      ? { type: "css", value: input.selector }
      : input.role
        ? { type: "role", value: input.role }
        : input.text
          ? { type: "text", value: input.text }
          : { type: "css", value: "*" }
    const result = await this.withControl(tab, "query", async (send) =>
      this.evaluate(send, queryElementsScript(locator, maxResults), true),
    )
    const parsed = result as { matches?: Array<Record<string, unknown>>; truncated?: boolean } | null
    const matches: ResolvedElement[] = (parsed?.matches ?? []).map((raw) => ({
      selector: asSelector(raw["selector"])?.value ?? "",
      confidence: asSelector(raw["selector"])?.confidence ?? "low",
      rect: asRect(raw["rect"]),
      role: typeof raw["role"] === "string" ? raw["role"] : null,
      name: typeof raw["name"] === "string" ? raw["name"] : null,
      state: {
        visible: raw["visibility"] !== "hidden",
        enabled: true,
        checked: false,
        focused: false,
        readonly: false,
      },
      display: typeof raw["display"] === "string" ? raw["display"] : null,
      position: typeof raw["position"] === "string" ? raw["position"] : null,
      zIndex: typeof raw["zIndex"] === "number" ? raw["zIndex"] : null,
    }))
    return { queried: { matches, truncated: parsed?.truncated ?? false } }
  }

  private async profilerStart(tabId: string | undefined): Promise<Record<string, unknown>> {
    const tab = this.resolveTab(tabId)
    const detected = await this.withControl(tab, "profiler_start", async (send) =>
      this.evaluate(send, PROFILER_INSTALL_SCRIPT, true),
    )
    if (detected === false) throw new BrowserNotAReactAppError()
    return { profiler: { started: true, tabId: tab.runtimeTabId } }
  }

  private async profilerStop(tabId: string | undefined): Promise<Record<string, unknown>> {
    const tab = this.resolveTab(tabId)
    const result = await this.withControl(tab, "profiler_stop", async (send) =>
      this.evaluate(send, PROFILER_COLLECT_SCRIPT, true),
    )
    const parsed = (result ?? {}) as { commitCount?: number; windowMs?: number; components?: Array<{ name: string; renders: number }>; propsDiff?: unknown }
    return {
      profiler: {
        commitCount: parsed.commitCount ?? 0,
        windowMs: parsed.windowMs ?? 0,
        components: (parsed.components ?? []).slice(0, PROFILER_MAX_COMPONENTS),
        propsDiff: parsed.propsDiff,
        tabId: tab.runtimeTabId,
      },
    }
  }

  // --- helpers ----------------------------------------------------------------

  private resolveTab(tabId?: string): GuestRecord {
    const tab = this.deps.registry.requireTab(tabId)
    if (tab) return tab
    const first = this.deps.registry.list()[0]
    if (first) return first
    throw new BrowserTabNotFoundError(tabId)
  }

  private activeTab(tabId?: string): GuestRecord | undefined {
    return this.deps.registry.requireTab(tabId) ?? this.deps.registry.list()[0]
  }

  private async withControl<T>(
    tab: GuestRecord,
    action: string,
    use: (send: SendCommand, cleanup: SendCommand) => Promise<T>,
  ): Promise<T> {
    if (tab.crashed) throw new BrowserGuestCrashedError(tab.runtimeTabId)
    this.deps.registry.setController(tab.runtimeTabId, "agent")
    try {
      return await this.deps.sessions.withSession(tab.runtimeTabId, tab.webContents, action, use, 15_000)
    } catch (error) {
      if (error instanceof BrowserError) throw error
      if (error instanceof Error && error.message.includes("permit")) {
        throw new BrowserTimeoutError(action, 15_000)
      }
      throw new BrowserOperationFailedError(`${action}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.deps.registry.setController(tab.runtimeTabId, "none")
    }
  }

  /** Fire a CDP command with a short permit wait (frame acks / teardown). */
  private sendRaw(tab: GuestRecord, method: string, params?: Record<string, unknown>, waitMs = 15_000): Promise<unknown> {
    return this.deps.sessions.withSession(tab.runtimeTabId, tab.webContents, "raw", (send) => send(method, params), waitMs)
  }

  private async evaluate(send: SendCommand, expression: string, awaitPromise: boolean): Promise<unknown> {
    const response = (await send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })) as { result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    if (response.exceptionDetails) {
      const detail =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Evaluation failed"
      throw new BrowserOperationFailedError(String(detail))
    }
    return response.result?.value
  }

  /**
   * Resolve an ElementTarget to a CSS-viewport point. RefTargets are versioned:
   * a stale snapshotVersion (or an unknown ref) raises BrowserStaleRefError —
   * no silent re-binding (premium amendment §1).
   */
  private async resolveTarget(
    send: SendCommand,
    tab: GuestRecord,
    target: ElementTarget,
  ): Promise<{ coords: Coords; resolved: ResolvedElement }> {
    if (isRefTarget(target)) {
      const version = this.deps.registry.get(tab.runtimeTabId)?.snapshotVersion ?? 0
      if (target.snapshotVersion !== version) {
        throw new BrowserStaleRefError(target.ref, version, target.snapshotVersion)
      }
      const ref = this.deps.registry.getSnapshotRefs(tab.runtimeTabId)?.get(target.ref) as SnapshotRef | undefined
      if (!ref) throw new BrowserStaleRefError(target.ref, version, target.snapshotVersion)
      return {
        coords: { x: ref.x, y: ref.y },
        resolved: {
          selector: "",
          confidence: "low",
          rect: { x: ref.x, y: ref.y, width: 0, height: 0 },
          role: null,
          name: target.ref,
          state: emptyState(),
          display: null,
          position: null,
          zIndex: null,
        },
      }
    }
    if (isCoords(target)) {
      return {
        coords: { x: target.x, y: target.y },
        resolved: {
          selector: "",
          confidence: "low",
          rect: { x: target.x, y: target.y, width: 0, height: 0 },
          role: null,
          name: null,
          state: emptyState(),
          display: null,
          position: null,
          zIndex: null,
        },
      }
    }
    if (isLocator(target)) {
      const result = (await this.evaluate(send, resolveElementScript(target, false), true)) as
        | { error: string }
        | { center?: { x: number; y: number }; rect?: { x: number; y: number; width: number; height: number }; selector?: { kind: string; value: string; confidence: string }; role?: string | null; name?: string | null; state?: Record<string, unknown>; display?: string | null; position?: string | null; zIndex?: number | null }
        | null
      if (result && "error" in result) throw new BrowserInvalidSelectorError(result.error)
      if (!result || !result.center) throw new BrowserTargetNotFoundError()
      const center = result.center
      const rect = result.rect ?? { x: center.x, y: center.y, width: 0, height: 0 }
      return {
        coords: { x: Math.round(center.x), y: Math.round(center.y) },
        resolved: {
          selector: result.selector?.value ?? "",
          confidence: (result.selector?.confidence as ResolvedElement["confidence"]) ?? "low",
          rect,
          role: result.role ?? null,
          name: result.name ?? null,
          state: result.state ? toElementState(result.state) : emptyState(),
          display: result.display ?? null,
          position: result.position ?? null,
          zIndex: result.zIndex ?? null,
        },
      }
    }
    throw new BrowserInvalidSelectorError("Unsupported target")
  }

  /** Build the in-page expression that finds the element for a target. */
  private async targetExpression(send: SendCommand, tab: GuestRecord, target: ElementTarget): Promise<string> {
    if (isRefTarget(target)) {
      const version = this.deps.registry.get(tab.runtimeTabId)?.snapshotVersion ?? 0
      if (target.snapshotVersion !== version) {
        throw new BrowserStaleRefError(target.ref, version, target.snapshotVersion)
      }
      const ref = this.deps.registry.getSnapshotRefs(tab.runtimeTabId)?.get(target.ref) as SnapshotRef | undefined
      if (ref?.locator) return findLocatorExpression(ref.locator)
      if (ref) return findCoordsExpression(ref.x, ref.y)
      throw new BrowserStaleRefError(target.ref, version, target.snapshotVersion)
    }
    if (isLocator(target)) return findLocatorExpression(target)
    if (isCoords(target)) return findCoordsExpression(target.x, target.y)
    throw new BrowserInvalidSelectorError("Unsupported target")
  }

  private emitPointer(runtimeTabId: string, phase: "move" | "click", coords: Coords): void {
    this.pointerSequence += 1
    const event: BrowserPointerEvent = {
      tabId: runtimeTabId,
      phase,
      x: coords.x,
      y: coords.y,
      sequence: this.pointerSequence,
      createdAt: new Date().toISOString(),
    }
    this.deps.onPointerEvent(event)
  }

  private async readViewport(tab: GuestRecord): Promise<{ width: number; height: number; dpr: number; scrollX: number; scrollY: number }> {
    if (tab.crashed) return { width: 0, height: 0, dpr: 1, scrollX: 0, scrollY: 0 }
    try {
      const result = await this.withControl(tab, "readViewport", async (send) =>
        this.evaluate(send, "({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY })", true),
      )
      const parsed = (result ?? {}) as Record<string, unknown>
      return {
        width: Math.max(0, Math.round(Number(parsed["width"] ?? 0))),
        height: Math.max(0, Math.round(Number(parsed["height"] ?? 0))),
        dpr: Number(parsed["dpr"] ?? 1) || 1,
        scrollX: Math.round(Number(parsed["scrollX"] ?? 0)),
        scrollY: Math.round(Number(parsed["scrollY"] ?? 0)),
      }
    } catch {
      return { width: 0, height: 0, dpr: 1, scrollX: 0, scrollY: 0 }
    }
  }

  private waitForNavigation(runtimeTabId: string): Promise<void> {
    const deadline = Date.now() + NAVIGATE_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const poll = () => {
        const tab = this.deps.registry.get(runtimeTabId)
        if (!tab) {
          reject(new BrowserTabNotFoundError(runtimeTabId))
          return
        }
        if (tab.crashed) {
          reject(new BrowserGuestCrashedError(runtimeTabId))
          return
        }
        if (!tab.loading && tab.readyState !== "loading") {
          resolve()
          return
        }
        if (Date.now() > deadline) {
          reject(new BrowserTimeoutError("navigate", NAVIGATE_TIMEOUT_MS))
          return
        }
        setTimeout(poll, 100)
      }
      poll()
    })
  }
}

interface ActiveRecording {
  recordingId: string
  tabId: string
  startedAt: string
  frames: string[]
  timer: ReturnType<typeof setTimeout>
  unsubscribe: () => void
}

// --- small helpers -----------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const emptyState = (): ElementState => ({ visible: false, enabled: true, checked: false, focused: false, readonly: false })

const asRect = (value: unknown): { x: number; y: number; width: number; height: number } => {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>
  return {
    x: Math.round(Number(record["x"] ?? 0)),
    y: Math.round(Number(record["y"] ?? 0)),
    width: Math.round(Number(record["width"] ?? 0)),
    height: Math.round(Number(record["height"] ?? 0)),
  }
}

const asPoint = (value: unknown): { x: number; y: number } | undefined => {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>
  if (typeof record["x"] !== "number" || typeof record["y"] !== "number") return undefined
  return { x: Math.round(record["x"]), y: Math.round(record["y"]) }
}

const asSelector = (value: unknown): { kind: string; value: string; confidence: "high" | "med" | "low" } | undefined => {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>
  if (typeof record["value"] !== "string") return undefined
  const confidence = record["confidence"] === "high" || record["confidence"] === "med" ? record["confidence"] : "low"
  return { kind: typeof record["kind"] === "string" ? record["kind"] : "structural", value: record["value"], confidence }
}

const annotationScript = (items: AnnotationScriptItem[], clear: boolean, durationMs: number | undefined): string => {
  const rootId = "__opencode_browser_annotations"
  const duration = Math.max(0, Math.min(60_000, durationMs ?? 0))
  const blocks = items
    .map((item, index) => {
      const label = JSON.stringify(item.label ?? `A${index + 1}`)
      const tone = JSON.stringify(item.tone ?? "info")
      return `try { const find = ${item.expression}; const el = find(); if (el && annotate(el, ${label}, ${tone})) count += 1; } catch {}`
    })
    .join("\n")
  return `(() => {
    const rootId = ${JSON.stringify(rootId)};
    if (${clear}) document.getElementById(rootId)?.remove();
    let root = document.getElementById(rootId);
    if (!root) {
      root = document.createElement('div');
      root.id = rootId;
      root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
      document.body.appendChild(root);
    }
    const colors = {
      neutral: ['rgb(161 161 170)', 'rgb(24 24 27 / 0.92)'],
      info: ['rgb(96 165 250)', 'rgb(30 64 175 / 0.92)'],
      success: ['rgb(74 222 128)', 'rgb(22 101 52 / 0.92)'],
      warning: ['rgb(251 191 36)', 'rgb(146 64 14 / 0.94)'],
      danger: ['rgb(248 113 113)', 'rgb(127 29 29 / 0.94)'],
    };
    const annotate = (el, label, tone) => {
      const rect = el.getBoundingClientRect();
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return false;
      const color = colors[tone] || colors.info;
      const box = document.createElement('div');
      box.setAttribute('data-opencode-browser-annotation', 'true');
      box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid ' + color[0] + ';background:transparent;border-radius:5px;box-shadow:0 0 0 1px rgb(0 0 0 / 0.45);';
      box.style.left = Math.max(0, rect.left) + 'px';
      box.style.top = Math.max(0, rect.top) + 'px';
      box.style.width = Math.max(1, rect.width) + 'px';
      box.style.height = Math.max(1, rect.height) + 'px';
      const badge = document.createElement('div');
      badge.textContent = String(label).slice(0, 48);
      badge.style.cssText = 'position:absolute;left:-1px;top:-20px;max-width:220px;height:18px;padding:0 6px;border-radius:4px;background:' + color[1] + ';color:white;font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgb(0 0 0 / 0.35);';
      box.appendChild(badge);
      root.appendChild(box);
      return true;
    };
    let count = 0;
    ${blocks}
    if (${duration} > 0) setTimeout(() => document.getElementById(rootId)?.remove(), ${duration});
    return { count };
  })()`
}

const KEY_SEQUENCES: Record<string, { key: string; code: string; virtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", virtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", virtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", virtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", virtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", virtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", virtualKeyCode: 36 },
  End: { key: "End", code: "End", virtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", virtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", virtualKeyCode: 34 },
  " ": { key: " ", code: "Space", virtualKeyCode: 32 },
  Space: { key: " ", code: "Space", virtualKeyCode: 32 },
}

interface KeySequence {
  key: string
  code: string
  virtualKeyCode: number
  modifiers: number
}

const keySequence = (raw: string): KeySequence => {
  let modifiers = 0
  const keys: string[] = []
  for (const part of raw.split("+")) {
    const lower = part.trim().toLowerCase()
    if (lower === "ctrl" || lower === "control") {
      modifiers |= 2
      continue
    }
    if (lower === "alt" || lower === "option") {
      modifiers |= 1
      continue
    }
    if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "win") {
      modifiers |= 4
      continue
    }
    if (lower === "shift") {
      modifiers |= 8
      continue
    }
    keys.push(part.trim())
  }
  const base = keys[0] ?? raw
  const shifted = (modifiers & 8) !== 0
  const known = KEY_SEQUENCES[base] ?? KEY_SEQUENCES[shifted ? base.toLowerCase() : base]
  if (known) {
    const key = shifted && known.key.length === 1 ? known.key.toUpperCase() : known.key
    return { key, code: known.code, virtualKeyCode: known.virtualKeyCode, modifiers }
  }
  if (base.length === 1) {
    const upper = base.toUpperCase()
    const code = /^[a-zA-Z]$/.test(base) ? `Key${upper}` : /^[0-9]$/.test(base) ? `Digit${base}` : "Unknown"
    return { key: shifted ? upper : base, code, virtualKeyCode: upper.charCodeAt(0), modifiers }
  }
  return { key: base, code: "Unknown", virtualKeyCode: 0, modifiers }
}

const modifierNames = (bitmask: number): string[] => {
  const names: string[] = []
  if (bitmask & 1) names.push("alt")
  if (bitmask & 2) names.push("control")
  if (bitmask & 4) names.push("meta")
  if (bitmask & 8) names.push("shift")
  return names
}

const conditionExpression = (condition: { type: string; value?: string; text?: string; pattern?: string; script?: string; selector?: Locator }): string => {
  switch (condition.type) {
    case "selector": {
      const locator = condition.selector ?? { type: "css" as const, value: condition.value ?? "" }
      const value = JSON.stringify(locator.value)
      if (locator.type === "css") {
        return `(() => { const el = document.querySelector(${value}); return { found: !!el, element: el }; })()`
      }
      return `(() => { const find = ${findLocatorExpression(locator)}; const el = find(); return { found: !!el, element: el }; })()`
    }
    case "text": {
      const value = JSON.stringify(condition.text ?? condition.value ?? "")
      return `(() => { const found = (document.body?.innerText ?? '').includes(${value}); return { found, element: null }; })()`
    }
    case "url": {
      const value = JSON.stringify(condition.pattern ?? condition.value ?? "")
      return `(() => { const found = location.href.includes(${value}); return { found, element: null }; })()`
    }
    case "expression": {
      const script = condition.script ?? condition.value ?? "true"
      const safe = script.startsWith("(") ? script : `Boolean(${script})`
      return `(() => { try { const found = ${safe}; return { found: !!found, element: null }; } catch { return { found: false, element: null }; } })()`
    }
    default:
      throw new BrowserUnsupportedOperationError(`Unsupported condition kind ${condition.type}`)
  }
}

const buildA11yTree = (axTree: unknown, maxDepth: number): A11yNode[] => {
  const raw = axTree as { nodes?: Array<Record<string, unknown>> } | null
  if (!raw || !Array.isArray(raw.nodes)) return []
  const nodes = raw.nodes
  const byId = new Map<number, Record<string, unknown>>()
  for (const node of nodes) {
    if (typeof node["nodeId"] === "number") byId.set(node["nodeId"], node)
  }
  const convert = (node: Record<string, unknown>, depth: number): A11yNode | null => {
    if (depth > maxDepth) return null
    const role =
      typeof node["role"] === "object" && node["role"] !== null
        ? String((node["role"] as Record<string, unknown>)["value"] ?? "generic")
        : "generic"
    if (role === "none" || role === "presentation") return null
    const name =
      typeof node["name"] === "object" && node["name"] !== null
        ? String((node["name"] as Record<string, unknown>)["value"] ?? "")
        : ""
    const value =
      typeof node["value"] === "object" && node["value"] !== null
        ? String((node["value"] as Record<string, unknown>)["value"] ?? undefined)
        : undefined
    const states: Record<string, boolean> = {}
    if (Array.isArray(node["states"])) {
      for (const state of node["states"]) {
        if (typeof state === "object" && state !== null) {
          const record = state as Record<string, unknown>
          const key = String(record["name"] ?? "")
          if (key) states[key] = record["value"] !== false
        }
      }
    }
    const children: A11yNode[] = []
    for (const child of Array.isArray(node["childIds"]) ? (node["childIds"] as number[]) : []) {
      const childNode = byId.get(child)
      if (!childNode) continue
      const converted = convert(childNode, depth + 1)
      if (converted) children.push(converted)
    }
    const box = (typeof node["boundingBox"] === "object" && node["boundingBox"] !== null ? node["boundingBox"] : {}) as Record<string, unknown>
    const w = Number(box["width"] ?? 0)
    const h = Number(box["height"] ?? 0)
    const target =
      w > 0 && h > 0
        ? {
            locator: { type: "role" as const, value: name ? `${role}: "${name}"` : role },
            coords: { x: Math.round(Number(box["x"] ?? 0) + w / 2), y: Math.round(Number(box["y"] ?? 0) + h / 2) },
          }
        : undefined
    return { role, name, value, states, ...(target ? { target } : {}), children }
  }
  const roots: A11yNode[] = []
  for (const node of nodes) {
    const isRoot =
      node["nodeId"] === 1 ||
      (typeof node["parentId"] !== "number" &&
        !Array.from(byId.values()).some(
          (n) => Array.isArray(n["childIds"]) && (n["childIds"] as number[]).includes(node["nodeId"] as number),
        ))
    if (isRoot) {
      const converted = convert(node, 0)
      if (converted) roots.push(converted)
    }
  }
  return roots
}

const framesToHtml = (frames: string[]): string => {
  const images = frames
    .map((frame) => `<img src="data:image/jpeg;base64,${frame}" alt="" style="display:none">`)
    .join("\n")
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Browser recording</title></head>
<body style="margin:0;background:#111;display:grid;place-items:center;height:100vh">
<div id="stage" style="max-width:100%;max-height:100%"></div>
<script>
const frames = document.querySelectorAll('img');
let i = 0;
const stage = document.getElementById('stage');
function play() {
  if (frames.length === 0) return;
  stage.innerHTML = '';
  const img = frames[i % frames.length].cloneNode(true);
  img.style.display = 'block';
  img.style.maxWidth = '100%';
  img.style.maxHeight = '100vh';
  stage.appendChild(img);
  i += 1;
  setTimeout(play, ${RECORDING_FRAME_INTERVAL_MS});
}
play();
</script>
${images}
</body></html>`
}

// --- React profiler in-page scripts (premium amendment §3) --------------------

// Installs a DevTools hook when absent (for FUTURE commits), detects React via
// DOM fiber keys when the hook is missing, and records bounded per-commit
// fiber-walk render counts. Returns false when the page is not a React app.
const PROFILER_INSTALL_SCRIPT = `(() => {
  const MAX_FIBERS = ${PROFILER_MAX_FIBERS_PER_COMMIT};
  const MAX_COMMITS = ${PROFILER_MAX_COMMITS};
  const MAX_PROPS = ${PROFILER_MAX_PROPS};
  const hasReact =
    (typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' && window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers && window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size > 0) ||
    (document.body && Object.keys(document.body).some((k) => k.startsWith('__reactFiber')));
  if (!hasReact) return false;
  if (!window.__opencodeProfiler) {
    window.__opencodeProfiler = { startedAt: Date.now(), commits: [], renderCounts: {}, propsDiff: undefined };
  }
  const profiler = window.__opencodeProfiler;
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const walk = (fiber, counts) => {
    const seen = new Set();
    let budget = MAX_FIBERS;
    const visit = (node) => {
      if (!node || budget <= 0) return;
      budget--;
      if (typeof node.type === 'function' || typeof node.type === 'string') {
        const name = (node.type.name || node.type.displayName || node.elementType?.name || 'Anonymous');
        counts[name] = (counts[name] || 0) + 1;
      }
      if (node.child) visit(node.child);
      if (node.sibling) visit(node.sibling);
    };
    visit(fiber);
    void seen;
  };
  const onCommit = (fiberRoot) => {
    if (profiler.commits.length >= MAX_COMMITS) return;
    const counts = {};
    const root = fiberRoot && (fiberRoot.current || fiberRoot);
    if (root) walk(root, counts);
    profiler.commits.push({ at: Date.now(), counts });
    for (const key of Object.keys(counts)) {
      profiler.renderCounts[key] = (profiler.renderCounts[key] || 0) + counts[key];
    }
  };
  if (hook && !profiler.wired) {
    profiler.wired = true;
    if (typeof hook.onCommitFiberRoot === 'function') {
      const original = hook.onCommitFiberRoot;
      hook.onCommitFiberRoot = function (rendererID, root, priorityLevel, didFatal) {
        try { onCommit(root); } catch {}
        return original.call(this, rendererID, root, priorityLevel, didFatal);
      };
    } else {
      hook.onCommitFiberRoot = onCommit;
    }
  }
  return true;
})()`

const PROFILER_COLLECT_SCRIPT = `(() => {
  const profiler = window.__opencodeProfiler;
  if (!profiler) return { commitCount: 0, windowMs: 0, components: [] };
  const components = Object.entries(profiler.renderCounts)
    .map(([name, renders]) => ({ name, renders }))
    .sort((a, b) => b.renders - a.renders)
    .slice(0, ${PROFILER_MAX_COMPONENTS});
  return {
    commitCount: profiler.commits.length,
    windowMs: Date.now() - profiler.startedAt,
    components,
    propsDiff: profiler.propsDiff,
  };
})()`
