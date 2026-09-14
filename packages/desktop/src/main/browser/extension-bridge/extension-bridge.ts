// extension-bridge.ts — multiplex between webview (GuestRegistry) and extension (ExtensionHost)
//
// Routes each BrokerRequest to exactly one lane. The BrowserHost `InFlight.respond`
// contract (host.ts:87) is preserved: only ONE responder ever writes the HTTP
// response — this bridge merely SELECTS the lane that produces the result.
//
// Topology (deliverable/browser-phase0-protocol v4 + chrome lane):
//   - webview lane:  GuestRegistry + BrowserOperations + ControlSessionManager (CDP over electron debugger)
//   - extension lane: ExtensionHost (native messaging) + chrome.debugger in the extension SW
// Both share the same ControlArbiter epoch (human preemption kills either lane) and the
// same timeout/abort semantics; error tags remain the 16 canonical ones.

import type { GuestRegistry, GuestRecord } from "../guest"
import type { BrowserOperations } from "../operations"
import {
  BrowserGuestCrashedError,
  BrowserTabNotFoundError,
  BrowserControlInterruptedError,
  BrowserDebuggerConflictError,
  BrowserStaleRefError,
  BrowserNotAReactAppError,
  BrowserError,
  type BrowserError as BrowserErrorType,
} from "../errors"
import type { BrowserOperation, HostCapabilities, WireGuestTabState, SessionTabInfo } from "../contracts"
import { BROWSER_PROTOCOL_VERSION } from "../contracts"
import type { ExtensionHost } from "./extension-host"

// ---------------------------------------------------------------------------
// Lane types
// ---------------------------------------------------------------------------

export type Lane = "webview" | "extension" | "unavailable"

export interface ExtensionTabRecord {
  tabId: string
  url: string
  title: string
  windowId?: string
  active?: boolean
  muted?: boolean
  owner?: { kind: "user" } | { kind: "agent"; sessionId: string }
  readyState?: WireGuestTabState["readyState"]
  controller?: WireGuestTabState["controller"]
}

export interface ExtensionBridgeOptions {
  /** Owning BrowserEngine window id; avoids materializing the webview registry on every Chrome request. */
  windowId: string
  registry: GuestRegistry
  operations: BrowserOperations
  extensionHost: ExtensionHost
  /** Live mirror of extension tabs (from SW `chrome.tabs` + ownership map). */
  getExtensionTabs: () => ExtensionTabRecord[]
  /** Indexed lookup supplied by BrowserEngine for per-operation lane routing. */
  getExtensionTab?: (tabId: string) => ExtensionTabRecord | undefined
  /** Active extension tab id, if any (e.g. chrome.tabs.query active). */
  getExtensionActiveTabId?: () => string | null
  /** Replace the live Chrome tab mirror after extension operations return authoritative state. */
  onExtensionSnapshot?: (tabs: ExtensionTabRecord[], activeTabId: string | null) => void
  logger?: { log: (message: string, meta?: unknown) => void; error: (message: string, meta?: unknown) => void }
}

// ---------------------------------------------------------------------------
// Chrome error → canonical tag mapping (no new tags)
// ---------------------------------------------------------------------------

export function mapChromeErrorToTag(message: string): InstanceType<typeof BrowserError> | null {
  const normalized = message.toLowerCase()
  if (normalized.includes("target_closed") || normalized.includes("target closed") || normalized.includes("no tab with id") || normalized.includes("tab was closed") || normalized.includes("target does not exist")) {
    // Cheap synthetic tabId recovery: look for numeric/string id in context, else "unknown"
    const idMatch = /tab[^0-9a-z]*([0-9a-z\-_]+)/i.exec(message)
    return new BrowserGuestCrashedError(idMatch?.[1] ?? "unknown")
  }
  if (normalized.includes("already attached") || normalized.includes("debugger is already attached") || normalized.includes("isdevtoolsopened") || normalized.includes("another debugger is attached") || normalized.includes("cannot attach to this target")) {
    return new BrowserDebuggerConflictError(message)
  }
  if (normalized.includes("canceled_by_user") || normalized.includes("cancelled") || normalized.includes("infobar") || normalized.includes("user canceled") || normalized.includes("detached while handling")) {
    return new BrowserControlInterruptedError(message)
  }
  if (normalized.includes("stale") && normalized.includes("snapshot")) {
    const refMatch = /ref\s+"([^"]+)"/i.exec(message)
    const expectedMatch = /current snapshot\s+(\d+)/i.exec(message)
    const boundMatch = /bound to snapshot\s+(\d+)/i.exec(message)
    return new BrowserStaleRefError(refMatch?.[1] ?? "unknown", expectedMatch ? Number(expectedMatch[1]) : 0, boundMatch ? Number(boundMatch[1]) : 0)
  }
  if (normalized.includes("no react") || normalized.includes("not a react") || normalized.includes("no react renderer") || normalized.includes("react is not detected")) {
    return new BrowserNotAReactAppError(message)
  }
  return null
}

// ---------------------------------------------------------------------------
// ExtensionBridge
// ---------------------------------------------------------------------------

export class ExtensionBridge {
  private readonly options: ExtensionBridgeOptions

  constructor(options: ExtensionBridgeOptions) {
    this.options = options
  }

  get isAvailable(): boolean {
    return this.options.extensionHost.isConnected
  }

  hasTab(tabId: string): boolean {
    if (this.options.getExtensionTab) return this.options.getExtensionTab(tabId) !== undefined
    return this.options.getExtensionTabs().some((t) => t.tabId === tabId)
  }

  get extensionTabCount(): number {
    return this.options.getExtensionTabs().length
  }

  private log(message: string, meta?: unknown): void {
    this.options.logger?.log(message, meta as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Lane resolution — mirrors core/host-broker resolveDispatch O1-O7
  // -------------------------------------------------------------------------
  resolveLane(tabId?: string, operation?: BrowserOperation): Lane {
    if (operation?.name === "status") return this.resolveStatusLane()
    if (tabId !== undefined) {
      if (this.hasTab(tabId)) return "extension"
      const rec = this.options.registry.requireTab(tabId)
      if (rec) return "webview"
      return "unavailable"
    }
    // No tabId — prefer extension active tab when chrome lane is live
    if (this.isAvailable) {
      const activeExt = this.getActiveExtensionTab()
      if (activeExt) return "extension"
    }
    const activeWeb = this.options.registry.activeTab
    if (activeWeb) return "webview"
    // Even if chrome is available but has no tabs, prefer extension for `open`
    if (operation?.name === "open" && this.isAvailable) return "extension"
    // Fallback: if extension has any tab, route there
    if (this.isAvailable && this.options.getExtensionTabs().length > 0) return "extension"
    return "unavailable"
  }

  private resolveStatusLane(): Lane {
    const hasWeb = this.options.registry.size > 0
    const hasExt = this.options.getExtensionTabs().length > 0
    if (hasWeb && hasExt) return "webview" // status merges both regardless; primary lane is webview for ordering
    if (hasExt) return "extension"
    if (hasWeb) return "webview"
    return this.isAvailable ? "extension" : "webview"
  }

  private getActiveExtensionTab(): ExtensionTabRecord | undefined {
    const activeId = this.options.getExtensionActiveTabId?.() ?? null
    if (activeId && this.options.getExtensionTab) {
      const indexed = this.options.getExtensionTab(activeId)
      if (indexed) return indexed
    }
    const tabs = this.options.getExtensionTabs()
    if (activeId) return tabs.find((t) => t.tabId === activeId) ?? tabs.find((t) => t.active)
    return tabs.find((t) => t.active)
  }

  // -------------------------------------------------------------------------
  // Dispatch — single responder contract
  // -------------------------------------------------------------------------
  async dispatch(tabId: string | undefined, operation: BrowserOperation, sessionId: string): Promise<Record<string, unknown>> {
    const lane = this.resolveLane(tabId, operation)

    // Status always succeeds and merges both lanes
    if (operation.name === "status") return this.dispatchStatus(sessionId, tabId)

    // Create-path for `open` without tabId goes to the preferred creation lane
    if (operation.name === "open" && tabId === undefined) {
      const createLane = this.isAvailable ? "extension" : "webview"
      // If createLane is extension but extension unavailable for creation, let it fall through to webview
      if (createLane === "extension") {
        try {
          return await this.dispatchExtension(undefined, operation, sessionId)
        } catch (error) {
          // If extension creation fails with unavailable, fall back to webview
          if (isUnavailable(error)) {
            return this.dispatchWebview(tabId, operation, sessionId)
          }
          throw this.normalizeChromeError(error)
        }
      }
      return this.dispatchWebview(tabId, operation, sessionId)
    }

    if (lane === "extension") return this.dispatchExtension(tabId, operation, sessionId)
    if (lane === "webview") return this.dispatchWebview(tabId, operation, sessionId)
    throw new BrowserTabNotFoundError(tabId)
  }

  private async dispatchWebview(tabId: string | undefined, operation: BrowserOperation, sessionId: string): Promise<Record<string, unknown>> {
    try {
      return await this.options.operations.dispatch(tabId, operation, sessionId)
    } catch (error) {
      throw this.normalizeChromeError(error)
    }
  }

  private async dispatchExtension(tabId: string | undefined, operation: BrowserOperation, sessionId: string): Promise<Record<string, unknown>> {
    // Build a BrokerRequest envelope and send via native host framing.
    // The extension SW mirrors the same contracts.ts BrokerRequest shape (byte-identical).
    const requestId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const timeoutMs = (operation.input as { timeoutMs?: number })?.timeoutMs ?? 15000
    const envelope = {
      requestId,
      sessionId,
      windowId: this.options.windowId,
      messageId: requestId,
      tabId,
      operation,
      timeoutMs,
    }
    try {
      // Cooperative timeout races the native host send; host.ts InFlight timer handles the outer envelope,
      // but extension sends also need an inner bound so a stalled native host doesn't hang forever.
      const response = await this.options.extensionHost.send(envelope as never)
      if (!response.ok) {
        // Error body already has canonical tag if the extension mapped it; else map chrome strings.
        const mapped = mapChromeErrorToTag(response.error.message)
        if (mapped) throw mapped
        // Re-throw as typed error preserving tag
        const { tag, message, retryable, details } = response.error
        throw new BrowserError(tag, message, retryable, details as Record<string, unknown>)
      }
      const result = response.result as Record<string, unknown>
      this.captureExtensionState(operation, result, sessionId)
      return result
    } catch (error) {
      // Native host transport down → BrowserHostUnavailable so caller can retry via webview or fail fast
      if (isHostTransportError(error)) {
        throw new BrowserError("BrowserHostUnavailable", `Extension host transport failed: ${(error as Error).message}`, true, { lane: "extension" })
      }
      throw this.normalizeChromeError(error)
    }
  }

  private async dispatchStatus(_sessionId: string, _tabId?: string): Promise<Record<string, unknown>> {
    // The two status lanes are independent. Refresh them concurrently instead
    // of serializing one complete desktop status traversal ahead of Chrome.
    const [webviewStatus] = await Promise.all([
      this.options.operations.dispatch(undefined, { name: "status", input: {} }, "").catch(() => null) as Promise<{ status?: unknown; tabs?: SessionTabInfo[] } | null>,
      this.isAvailable
        ? this.dispatchExtension(undefined, { name: "status", input: {} }, _sessionId).catch((error) => {
            this.log("extension status refresh failed", { error: String(error) })
            return null
          })
        : Promise.resolve(null),
    ])
    const extensionTabs: WireGuestTabState[] = this.options.getExtensionTabs().map((t) => toExtensionWireTab(t, t.active ?? false))
    const webviewTabs: WireGuestTabState[] = (webviewStatus?.tabs ?? []) as unknown as WireGuestTabState[]
    // De-duplicate by tabId (extension wins on collision — same URL opened in both lanes)
    const seen = new Set<string>()
    const merged: WireGuestTabState[] = []
    for (const tab of extensionTabs) {
      seen.add(tab.tabId)
      merged.push(tab)
    }
    for (const tab of webviewTabs) {
      if (seen.has(tab.tabId)) continue
      seen.add(tab.tabId)
      merged.push(tab)
    }
    const activeExtensionTab = this.getActiveExtensionTab()
    // Include chrome state optional so old sidecars ignore it (protocol v2 stable)
    return {
      status: (webviewStatus?.status ?? { connected: true, appearance: "system", recording: { active: false } }),
      tabs: merged,
      chrome: {
        attached: this.isAvailable,
        activeTabId: activeExtensionTab?.tabId ?? null,
        url: activeExtensionTab?.url ?? null,
        tabs: extensionTabs,
      },
    } as unknown as Record<string, unknown>
  }

  /** Abort a request by its extension requestId (host.ts abort path). */
  abort(requestId: string): void {
    this.options.extensionHost.abort(requestId)
    this.log("extension bridge abort", { requestId })
  }

  health(): { connected: boolean; chrome: boolean; lanes: Lane[] } {
    // Supported lanes, not current tab counters: webview remains a valid
    // creation/fallback lane even while it has no attached guest.
    const lanes: Lane[] = this.isAvailable ? ["extension", "webview"] : ["webview"]
    return { connected: true, chrome: this.isAvailable, lanes }
  }

  /** Capability advertisement for host hello — additive, no version bump. */
  hostHelloCapabilities(base: HostCapabilities): HostCapabilities {
    if (!this.isAvailable) return base
    return { ...base, chrome: true as const }
  }

  private captureExtensionState(operation: BrowserOperation, result: Record<string, unknown>, sessionId: string): void {
    const publish = this.options.onExtensionSnapshot
    if (!publish) return

    // Click/type/screenshot/snapshot/query/etc. cannot change the Chrome tab
    // mirror. Avoid cloning every tab and republishing identical state on the
    // overwhelmingly common automation hot path.
    if (
      operation.name !== "status" &&
      operation.name !== "open" &&
      operation.name !== "navigate" &&
      operation.name !== "close" &&
      operation.name !== "claim" &&
      operation.name !== "set_tab_owner"
    ) return

    if (operation.name === "status") {
      const previous = new Map(this.options.getExtensionTabs().map((tab) => [tab.tabId, tab]))
      const rawTabs = Array.isArray(result.tabs) ? result.tabs : []
      const tabs = rawTabs.flatMap((value): ExtensionTabRecord[] => {
        if (typeof value !== "object" || value === null) return []
        const tab = value as Record<string, unknown>
        if (typeof tab.tabId !== "string") return []
        return [{
          tabId: tab.tabId,
          url: typeof tab.url === "string" ? tab.url : "",
          title: typeof tab.title === "string" ? tab.title : "",
          windowId: typeof tab.windowId === "string" ? tab.windowId : undefined,
          active: tab.active === true,
          muted: tab.muted === true,
          // Chrome itself does not know opencode session ownership. Preserve
          // Desktop's owner for known tabs; genuinely new Chrome tabs are users'.
          owner: previous.get(tab.tabId)?.owner ?? (isOwner(tab.owner) ? tab.owner : { kind: "user" }),
          readyState: tab.readyState === "Idle" || tab.readyState === "Loading" || tab.readyState === "LoadFailed" || tab.readyState === "Success" ? tab.readyState : "Success",
        }]
      })
      const nestedActive = (((result.status as Record<string, unknown> | undefined)?.guest as Record<string, unknown> | undefined)?.activeTab as Record<string, unknown> | undefined)?.tabId
      const activeTabId = typeof nestedActive === "string" ? nestedActive : tabs.find((tab) => tab.active)?.tabId ?? null
      publish(tabs, activeTabId)
      return
    }

    const current = this.options.getExtensionTabs().map((tab) => ({ ...tab }))
    let activeTabId = this.options.getExtensionActiveTabId?.() ?? current.find((tab) => tab.active)?.tabId ?? null

    if (operation.name === "open") {
      const opened = asRecord(result.opened)
      const tabId = typeof opened?.tabId === "string" ? opened.tabId : null
      if (tabId) {
        const openedOwner = opened?.owner
        const next: ExtensionTabRecord = {
          tabId,
          url: typeof opened?.url === "string" ? opened.url : "",
          title: typeof opened?.title === "string" ? opened.title : "",
          active: true,
          owner: isOwner(openedOwner) ? openedOwner : { kind: "agent", sessionId },
          readyState: "Loading",
        }
        const index = current.findIndex((tab) => tab.tabId === tabId)
        if (index >= 0) current[index] = { ...current[index], ...next }
        else current.push(next)
        for (const tab of current) tab.active = tab.tabId === tabId
        activeTabId = tabId
      }
    } else if (operation.name === "navigate") {
      const navigated = asRecord(result.navigated)
      const tabId = typeof navigated?.tabId === "string" ? navigated.tabId : null
      if (tabId) {
        const tab = current.find((entry) => entry.tabId === tabId)
        if (tab) {
          if (typeof navigated?.url === "string") tab.url = navigated.url
          if (typeof navigated?.title === "string") tab.title = navigated.title
          tab.readyState = "Success"
        }
      }
    } else if (operation.name === "close") {
      const closed = asRecord(result.closed)
      const tabId = typeof closed?.tabId === "string" ? closed.tabId : null
      if (tabId) {
        const index = current.findIndex((tab) => tab.tabId === tabId)
        if (index >= 0) current.splice(index, 1)
        if (activeTabId === tabId) activeTabId = current.find((tab) => tab.active)?.tabId ?? current[0]?.tabId ?? null
      }
    } else if (operation.name === "claim" || operation.name === "set_tab_owner") {
      const resultKey = operation.name === "claim" ? "claimed" : "assigned"
      const changed = asRecord(result[resultKey])
      const tabId = typeof changed?.tabId === "string" ? changed.tabId : null
      const owner = changed?.owner
      if (tabId && isOwner(owner)) {
        const tab = current.find((entry) => entry.tabId === tabId)
        if (tab) tab.owner = owner
      }
    }
    publish(current, activeTabId)
  }

  private normalizeChromeError(error: unknown): unknown {
    if (error instanceof BrowserError) return error
    if (error instanceof Error) {
      const mapped = mapChromeErrorToTag(error.message)
      if (mapped) return mapped
    }
    return error
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toExtensionWireTab(record: ExtensionTabRecord, active: boolean): WireGuestTabState {
  return {
    tabId: record.tabId,
    url: record.url,
    title: record.title,
    readyState: record.readyState ?? "Success",
    controller: record.controller ?? "none",
    zoomFactor: 1,
    attached: true,
    owner: record.owner ?? { kind: "user" },
    active,
    muted: record.muted ?? false,
  }
}

function isUnavailable(error: unknown): boolean {
  return error instanceof BrowserError && (error.tag === "BrowserNotAttached" || error.tag === "BrowserHostUnavailable" || error.tag === "BrowserTabNotFound")
}

function isHostTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return msg.includes("extension host not started") || msg.includes("host stopping") || msg.includes("transport") || msg.includes("pipe") || msg.includes("spawn")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined
}

function isOwner(value: unknown): value is ExtensionTabRecord["owner"] {
  const owner = asRecord(value)
  if (!owner) return false
  if (owner.kind === "user") return true
  return owner.kind === "agent" && typeof owner.sessionId === "string"
}
