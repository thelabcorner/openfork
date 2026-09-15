import type { WebContents } from "electron"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  VISUAL_ABORT_CHANNEL,
  VISUAL_RPC_CHANNEL,
  VISUAL_RPC_RESPONSE_CHANNEL,
  canDispatchTab,
  type Appearance,
  type BrowserDispatchContext,
  type GuestTabState,
  type VisualCaptureInput,
  type VisualDiffInput,
  type VisualRecordInput,
  type VisualResult,
} from "../contracts"
import { BrowserControlInterruptedError, BrowserOperationFailedError, BrowserPermissionDeniedError } from "../errors"
import type { GuestRecord } from "../guest"
import { VisualObservationCoordinator } from "./coordinator"
import { runVisualRpcLocal } from "./rpc"

const SNAPEYE_VERSION = "0.4.0"
const SNAPDOM_VERSION = "3.0.0"

interface ActiveVisualRun {
  requestId: string
  capability: string
  tabId: string
  wc: WebContents
  settled: boolean
  onRpc: (_event: unknown, payload: unknown) => void
  onDestroyed: () => void
  onNavigate: (_event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean) => void
  onAbort?: () => void
  interrupt: (reason: string) => void
  cleanup: () => void
}

type VisualInput = VisualCaptureInput | VisualDiffInput | VisualRecordInput

const ELECTRON_PRELOAD_WORLD_ID = 999
const VISUAL_RUNTIME_KEY = "__opencodeVisualRuntimeV1"

export interface WebviewVisualControllerOptions {
  runtimeSource?: () => Promise<string>
}

/**
 * Executes SnapEye inside the already-sandboxed Electron guest preload.
 * The page itself never receives Electron IPC or the artifact capability.
 */
export class WebviewVisualController {
  private readonly active = new Map<string, ActiveVisualRun>()
  private runtimeSourcePromise?: Promise<string>

  constructor(
    private readonly coordinator: VisualObservationCoordinator,
    private readonly options: WebviewVisualControllerOptions = {},
  ) {}

  async run(
    tab: GuestRecord,
    operation: "capture" | "diff" | "record",
    input: VisualInput,
    context: BrowserDispatchContext,
    appearance: Appearance,
  ): Promise<{ visual: VisualResult }> {
    if (context.signal?.aborted) throw new BrowserControlInterruptedError("Visual operation was already aborted")
    if (canDispatchTab(tab.owner, context.sessionId) !== "ok") throw new BrowserPermissionDeniedError()
    if (this.active.has(tab.runtimeTabId)) {
      throw new BrowserOperationFailedError(`A visual operation is already active on tab ${tab.runtimeTabId}`)
    }
    if (tab.webContents.isDestroyed() || tab.crashed || !tab.attached) {
      throw new BrowserOperationFailedError(`Browser tab ${tab.runtimeTabId} is not available for visual capture`)
    }

    const grant = await this.coordinator.begin({
      context,
      lane: "webview",
      tabId: tab.runtimeTabId,
      operation,
      name: input.name,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.redact ? { redaction: input.redact } : {}),
      environment: {
        engineMajor: chromiumMajor(),
        appearance,
        snapeyeVersion: SNAPEYE_VERSION,
        snapdomVersion: SNAPDOM_VERSION,
      },
    })

    const wc = tab.webContents
    return new Promise<{ visual: VisualResult }>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown, result?: VisualResult) => {
        if (settled) return
        settled = true
        active.settled = true
        active.cleanup()
        if (error) reject(error)
        else if (result) resolve({ visual: result })
        else reject(new BrowserOperationFailedError("Visual operation ended without a result"))
      }

      const active: ActiveVisualRun = {
        requestId: context.requestId,
        capability: grant.capability,
        tabId: tab.runtimeTabId,
        wc,
        settled: false,
        onRpc: (_event, raw) => {
          void this.handleRpc(active, raw)
        },
        onDestroyed: () => finish(new BrowserControlInterruptedError("Browser guest was destroyed during visual capture")),
        onNavigate: (_event, _url, _isInPlace, isMainFrame) => {
          if (isMainFrame) finish(new BrowserControlInterruptedError("Browser navigated during visual capture"))
        },
        interrupt: (reason) => finish(new BrowserControlInterruptedError(reason)),
        cleanup: () => {
          if (this.active.get(tab.runtimeTabId) === active) this.active.delete(tab.runtimeTabId)
          if (!wc.isDestroyed()) {
            try { wc.send(VISUAL_ABORT_CHANNEL, { requestId: context.requestId }) } catch {}
          }
          wc.ipc.removeListener(VISUAL_RPC_CHANNEL, active.onRpc)
          wc.removeListener("destroyed", active.onDestroyed)
          wc.removeListener("did-start-navigation", active.onNavigate)
          if (active.onAbort && context.signal) context.signal.removeEventListener("abort", active.onAbort)
          void this.coordinator.abort(grant.capability)
        },
      }
      this.active.set(tab.runtimeTabId, active)
      wc.ipc.on(VISUAL_RPC_CHANNEL, active.onRpc)
      wc.once("destroyed", active.onDestroyed)
      wc.on("did-start-navigation", active.onNavigate)

      if (context.signal) {
        active.onAbort = () => finish(new BrowserControlInterruptedError("Visual operation aborted"))
        context.signal.addEventListener("abort", active.onAbort, { once: true })
        // The signal may have flipped while coordinator.begin() was awaiting.
        // Check again only after every cleanup hook is installed so finish()
        // cannot leave listeners or a capability behind.
        if (context.signal.aborted) {
          active.onAbort()
          return
        }
      }

      void this.executeInGuest(wc, {
        requestId: context.requestId,
        capability: grant.capability,
        runId: grant.runId,
        maxChunkBytes: grant.maxChunkBytes,
        operation,
        input: serializeVisualInput(input, grant.redaction),
      }).then(
        (result) => {
          if (isVisualResult(result, operation)) finish(undefined, result)
          else finish(new BrowserOperationFailedError("Sandboxed SnapEye runtime returned an invalid result"))
        },
        (error) => finish(new BrowserOperationFailedError(
          error instanceof Error ? error.message : String(error),
          { requestId: context.requestId, tabId: tab.runtimeTabId },
        )),
      )
    })
  }

  cancel(tabId: string, reason = "Visual operation cancelled"): void {
    const run = this.active.get(tabId)
    if (!run) return
    run.interrupt(reason)
  }

  stop(): void {
    for (const run of [...this.active.values()]) run.interrupt("Visual controller stopped")
  }

  private async handleRpc(run: ActiveVisualRun, raw: unknown): Promise<void> {
    if (!isRecord(raw) || raw.requestId !== run.requestId || !isRecord(raw.request)) return
    if (raw.request.capability !== run.capability) return
    const response = await runVisualRpcLocal(this.coordinator, raw.request)
    if (run.settled || run.wc.isDestroyed()) return
    run.wc.send(VISUAL_RPC_RESPONSE_CHANNEL, { requestId: run.requestId, response })
  }

  private async executeInGuest(wc: WebContents, command: Record<string, unknown>): Promise<unknown> {
    await this.ensureRuntime(wc)
    const json = JSON.stringify(command)
    const literal = JSON.stringify(json).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
    const serialized = await wc.executeJavaScriptInIsolatedWorld(
      ELECTRON_PRELOAD_WORLD_ID,
      [{ code: `globalThis.${VISUAL_RUNTIME_KEY}.run(JSON.parse(${literal})).then((value) => JSON.stringify(value))` }],
    )
    if (typeof serialized !== "string") throw new BrowserOperationFailedError("Sandboxed SnapEye runtime returned a non-serializable result")
    return JSON.parse(serialized) as unknown
  }

  private async ensureRuntime(wc: WebContents): Promise<void> {
    const installed = await wc.executeJavaScriptInIsolatedWorld(
      ELECTRON_PRELOAD_WORLD_ID,
      [{ code: `typeof globalThis.${VISUAL_RUNTIME_KEY}?.run === "function"` }],
    )
    if (installed === true) return
    const source = await this.loadRuntimeSource()
    // Force the script completion value to undefined. Rollup's final assignment
    // stores an object containing functions on globalThis; returning that object
    // through Electron's isolated-world boundary triggers "object could not be
    // cloned" even though installation itself succeeded.
    await wc.executeJavaScriptInIsolatedWorld(ELECTRON_PRELOAD_WORLD_ID, [{ code: `${source}\n;void 0` }])
    const ready = await wc.executeJavaScriptInIsolatedWorld(
      ELECTRON_PRELOAD_WORLD_ID,
      [{ code: `typeof globalThis.${VISUAL_RUNTIME_KEY}?.run === "function"` }],
    )
    if (ready !== true) throw new BrowserOperationFailedError("Failed to initialize the sandboxed SnapEye runtime")
  }

  private loadRuntimeSource(): Promise<string> {
    if (!this.runtimeSourcePromise) {
      this.runtimeSourcePromise = this.options.runtimeSource
        ? this.options.runtimeSource()
        : readFile(resolveVisualRuntimePath(), "utf8")
    }
    return this.runtimeSourcePromise
  }
}

const resolveVisualRuntimePath = (): string =>
  process.env.OPENCODE_VISUAL_RUNTIME_PATH ||
  join(dirname(fileURLToPath(import.meta.url)), "../preload/visual-runtime.js")

const serializeVisualInput = (
  input: VisualInput,
  redaction: { blocks: string[]; attributes: Array<{ selector: string; names: string[] }> },
): Record<string, unknown> => {
  const target = input.target?.kind === "css" ? input.target.selector : undefined
  const options: Record<string, unknown> = {
    ...(input.stabilize !== undefined ? { stabilize: input.stabilize } : {}),
    ...(input.waitFor !== undefined ? { waitFor: input.waitFor } : {}),
    ...(input.waitTimeout !== undefined ? { waitTimeout: input.waitTimeout } : {}),
    ...(input.settle !== undefined ? { settle: input.settle } : {}),
    ...(input.settleTimeout !== undefined ? { settleTimeout: input.settleTimeout } : {}),
    ...(input.scale !== undefined ? { scale: input.scale } : {}),
    ...(input.svg !== undefined ? { svg: input.svg } : {}),
  }
  if ("threshold" in input) {
    options.diffOptions = {
      ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
      ...(input.includeAA !== undefined ? { includeAA: input.includeAA } : {}),
      ...(input.diffMask !== undefined ? { diffMask: input.diffMask } : {}),
    }
    options.regionOptions = {
      ...(input.tileSize !== undefined ? { tileSize: input.tileSize } : {}),
      ...(input.gapTiles !== undefined ? { gapTiles: input.gapTiles } : {}),
      ...(input.minRegionCssSide !== undefined ? { minRegionCssSide: input.minRegionCssSide } : {}),
      ...(input.minRegionCssArea !== undefined ? { minRegionCssArea: input.minRegionCssArea } : {}),
      ...(input.maxRegions !== undefined ? { maxRegions: input.maxRegions } : {}),
    }
  }
  if ("duration" in input || "fps" in input || "format" in input || "bitrate" in input) {
    Object.assign(options, {
      ...(input.duration !== undefined ? { duration: input.duration } : {}),
      ...(input.fps !== undefined ? { fps: input.fps } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.bitrate !== undefined ? { bitrate: input.bitrate } : {}),
      filmstripOptions: {
        ...(input.filmstripMaxCells !== undefined ? { maxCells: input.filmstripMaxCells } : {}),
        ...(input.filmstripMaxColumns !== undefined ? { maxColumns: input.filmstripMaxColumns } : {}),
        ...(input.filmstripMaxWidth !== undefined ? { maxWidth: input.filmstripMaxWidth } : {}),
        ...(input.filmstripGap !== undefined ? { gap: input.filmstripGap } : {}),
        ...(input.filmstripBackground !== undefined ? { background: input.filmstripBackground } : {}),
      },
    })
  }
  return {
    name: input.name,
    target,
    redaction,
    options,
  }
}

const chromiumMajor = (): number | undefined => {
  const value = Number.parseInt(process.versions.chrome?.split(".")[0] ?? "", 10)
  return Number.isFinite(value) ? value : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isVisualResult = (value: unknown, operation: "capture" | "diff" | "record"): value is VisualResult =>
  isRecord(value) &&
  value.schemaVersion === 1 &&
  value.protocolVersion === 1 &&
  (value.status === "ok" || value.status === "error") &&
  value.operation === operation &&
  typeof value.runId === "string"
