import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { constants, brotliCompress } from "node:zlib"
import { promisify } from "node:util"
import { app, BrowserWindow, clipboard, dialog, ipcMain, session as electronSession, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { parseDesktopNativeBundle, type DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"
import type { FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { setForceFocus } from "./debug"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import {
  getPinchZoomEnabled,
  getWindowID,
  openExternalURL,
  openLocalFileURL,
  setPinchZoomEnabled,
  setTitlebar,
  updateTitlebar,
} from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { getStatus as getChromePairingStatus, writeHosts as writeChromeHosts, removeHosts as removeChromeHosts, getInstructions as getChromeInstructions } from "./browser/extension-bridge/pairing"
import { createDesktopDraftStore } from "./draft-store"
import { nativeT } from "./native-translations"
import { BrowserEngine, resolveGuestPreloadPath } from "./browser"
import { RendererTrust } from "./browser/renderer-trust"
import type { HostOwner, VisualApprovalExpectation } from "./browser/contracts"
import type { SidecarLivenessState } from "./sidecar-status"
import { expandHomePath, firstExistingPath } from "./path-resolution"
import { createSidecarControlTransport } from "./sidecar-control-transport"
import { sidecarControlLane, type SidecarControlFetchInput } from "@opencode-ai/app/sidecar-control-request"
const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: nativeT("desktop.dialog.files"), extensions: ext }]
}
const pickedFiles = createPickedFileAuthorizations()

function expandFilesystemPath(path: string) {
  return expandHomePath(path, app.getPath("home"))
}

async function filesystemPathExistsResolved(path: string) {
  try {
    await stat(path)
    return true
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
}

async function filesystemPathExists(path: string) {
  return filesystemPathExistsResolved(expandFilesystemPath(path))
}

async function firstExistingFilesystemPath(paths: readonly string[]) {
  return firstExistingPath(paths, filesystemPathExistsResolved, expandFilesystemPath)
}

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  getSidecarURL: () => string | null
  rendererTrust: RendererTrust
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  isFirstLaunchOnboardingPending: () => Promise<boolean> | boolean
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null> | string | null
  isOldLayoutEligible: () => Promise<boolean> | boolean
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  setNativeTranslations: (bundle: DesktopNativeBundle) => void
  sidecarStatus: {
    subscribe: (listener: (state: SidecarLivenessState) => void) => () => void
  }
}
export function registerIpcHandlers(deps: Deps) {
  // Draft persistence is not required to create or paint a window. Opening the
  // SQLite store performs schema setup plus an orphan-blob sweep, so paying it
  // during IPC registration made startup cost grow with draft history. Create
  // it on the first draft operation instead.
  let drafts: ReturnType<typeof createDesktopDraftStore> | undefined
  const draftStore = () => (drafts ??= createDesktopDraftStore(join(app.getPath("userData"), "drafts.sqlite")))
  const updaterSubscriptions = createUpdaterSubscriptions()
  const sidecarStatusSubscriptions = new Map<number, () => void>()
  const sidecarControlSession = electronSession.fromPartition("openfork-control-transport-v1", { cache: false })
  const sidecarAdmissionSession = electronSession.fromPartition("openfork-admission-transport-v1", { cache: false })
  const sidecarControlFetch = createSidecarControlTransport({
    sidecarURL: deps.getSidecarURL,
    fetch: (url, init) => sidecarControlSession.fetch(url.href, init),
    fetchAdmission: (url, init) => sidecarAdmissionSession.fetch(url.href, init),
  })
  const sidecarControlRequests = new Map<
    string,
    { senderID: number; controller: AbortController; lane: "urgent" | "admission" }
  >()
  app.once("will-quit", () => {
    for (const request of sidecarControlRequests.values()) request.controller.abort()
    sidecarControlRequests.clear()
  })
  app.once("will-quit", updaterSubscriptions.clear)
  app.once("will-quit", () => {
    for (const unsubscribe of sidecarStatusSubscriptions.values()) unsubscribe()
    sidecarStatusSubscriptions.clear()
  })
  app.on("before-quit", () => drafts?.flush())
  app.once("will-quit", () => drafts?.close())
  app.on("browser-window-created", (_event, win) => win.on("session-end", () => drafts?.flush()))
  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle(
    "sidecar-control-fetch",
    async (event: IpcMainInvokeEvent, requestID: string, input: SidecarControlFetchInput) => {
      if (!deps.rendererTrust.isTrusted(event))
        throw new Error("Untrusted sidecar control sender")
      if (
        typeof requestID !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestID)
      )
        throw new Error("Invalid sidecar control request ID")
      if (
        !input ||
        typeof input !== "object" ||
        typeof input.url !== "string" ||
        typeof input.method !== "string" ||
        !input.headers ||
        typeof input.headers !== "object" ||
        (input.body !== undefined && typeof input.body !== "string")
      )
        throw new Error("Invalid sidecar control request")
      const key = `${event.sender.id}:${requestID}`
      const lane = sidecarControlLane(input.url, { method: input.method })
      if (!lane) throw new Error("Route is not eligible for control transport")
      if (sidecarControlRequests.has(key)) throw new Error("Duplicate sidecar control request ID")
      if (sidecarControlRequests.size >= 64) throw new Error("Too many active sidecar control requests")
      const active = [...sidecarControlRequests.values()]
      const laneCount = active.filter((request) => request.lane === lane).length
      const senderCount = active.filter((request) => request.senderID === event.sender.id && request.lane === lane).length
      // Six stalled runtime admissions cannot occupy cancellation/interest
      // network sockets or the reserved IPC slots that reach those sockets.
      if (laneCount >= (lane === "urgent" ? 16 : 48) || senderCount >= (lane === "urgent" ? 8 : 6))
        throw new Error("Too many active sidecar control requests")
      const controller = new AbortController()
      const onDestroyed = () => controller.abort()
      const state = { senderID: event.sender.id, controller, lane }
      sidecarControlRequests.set(key, state)
      event.sender.once("destroyed", onDestroyed)
      try {
        return await sidecarControlFetch(input, controller.signal)
      } finally {
        event.sender.removeListener("destroyed", onDestroyed)
        if (sidecarControlRequests.get(key) === state) sidecarControlRequests.delete(key)
      }
    },
  )
  ipcMain.on("sidecar-control-fetch-abort", (event, requestID: unknown) => {
    if (!deps.rendererTrust.isTrusted(event)) return
    if (typeof requestID !== "string") return
    sidecarControlRequests.get(`${event.sender.id}:${requestID}`)?.controller.abort()
  })
  ipcMain.handle("sidecar-liveness-subscribe", (event: IpcMainInvokeEvent) => {
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Untrusted sidecar status sender")
    }
    const id = event.sender.id
    if (sidecarStatusSubscriptions.has(id)) return
    const sender = event.sender
    let dead = false
    let unsubscribe = () => {}
    const remove = () => {
      if (dead) return
      dead = true
      unsubscribe()
      sender.removeListener("destroyed", remove)
      if (sidecarStatusSubscriptions.get(id) === remove) sidecarStatusSubscriptions.delete(id)
    }
    // Publish ownership before subscribe(): the status store immediately
    // replays its current value and that send may synchronously tear down.
    sidecarStatusSubscriptions.set(id, remove)
    const stop = deps.sidecarStatus.subscribe((state) => {
      if (dead) return
      if (sender.isDestroyed()) {
        remove()
        return
      }
      try {
        sender.send("sidecar-liveness", state)
      } catch {
        remove()
      }
    })
    unsubscribe = stop
    // subscribe() immediately replays the current state. If that synchronous
    // send failed, `remove()` ran before `unsubscribe` had been assigned; now
    // that it has, finish tearing down instead of retaining a dead listener.
    if (dead || sender.isDestroyed()) {
      dead = true
      stop()
      if (sidecarStatusSubscriptions.get(id) === remove) sidecarStatusSubscriptions.delete(id)
      return
    }
    sender.once("destroyed", remove)
  })
  ipcMain.handle("sidecar-liveness-unsubscribe", (event: IpcMainInvokeEvent) => {
    sidecarStatusSubscriptions.get(event.sender.id)?.()
    sidecarStatusSubscriptions.delete(event.sender.id)
  })
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("is-first-launch-onboarding-pending", () => deps.isFirstLaunchOnboardingPending())
  ipcMain.handle("finish-first-launch-onboarding", (_event: IpcMainInvokeEvent, createDefaultProject: boolean) =>
    deps.finishFirstLaunchOnboarding(createDefaultProject),
  )
  ipcMain.handle("is-old-layout-eligible", () => deps.isOldLayoutEligible())
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    const sender = event.sender
    // Dispose a previous renderer subscription before the new subscription's
    // immediate state replay can overlap it.
    updaterSubscriptions.delete(id)
    let dead = false
    let unsubscribe = () => {}
    const remove = () => {
      if (dead) return
      dead = true
      unsubscribe()
      sender.removeListener("destroyed", remove)
      if (updaterSubscriptions.get(id) === remove) updaterSubscriptions.delete(id)
    }
    updaterSubscriptions.set(id, remove)
    const stop = deps.updater.subscribe((state) => {
      if (dead) return
      if (sender.isDestroyed()) {
        remove()
        return
      }
      try {
        sender.send("updater-state", state)
      } catch {
        // A renderer can close between the destroyed check and send().
        // Keep that teardown race from escaping into the updater's state
        // transition and remove the dead observer.
        remove()
      }
    })
    unsubscribe = stop
    if (dead) {
      stop()
      return
    }
    sender.once("destroyed", remove)
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  // Callback-based zlib runs on the libuv threadpool, so compressing large
  // session exports never blocks the main loop (a sync q2 pass on a ~55MB
  // transcript costs ~300ms — enough to stall window chrome).
  const brotliCompressAsync = promisify(brotliCompress)
  ipcMain.handle("compress-export", (_event: IpcMainInvokeEvent, json: string) => {
    const rawBytes = Buffer.byteLength(json, "utf8")
    const quality = rawBytes < 1024 * 1024 ? 5 : 2
    return brotliCompressAsync(json, {
      params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: rawBytes },
    })
  })
  ipcMain.handle("set-force-focus", (event: IpcMainInvokeEvent, enabled: boolean) =>
    setForceFocus(event.sender, enabled),
  )
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("set-native-translations", (event: IpcMainInvokeEvent, value: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Invalid native translation sender")
    }
    const bundle = parseDesktopNativeBundle(value)
    if (!bundle) throw new Error("Invalid native translation bundle")
    deps.setNativeTranslations(bundle)
  })
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-get-all", (_event: IpcMainInvokeEvent, name: string) => {
    try {
      const store = getStore(name)
      const entries: Record<string, string> = {}
      const max = 64 * 1024
      for (const [key, value] of Object.entries(store.store)) {
        const encoded = typeof value === "string" ? value : JSON.stringify(value)
        if (encoded.length > max) continue
        entries[key] = encoded
      }
      return entries
    } catch {
      return {}
    }
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })
  ipcMain.handle("draft-get", (_event, key: string) => draftStore().get(key))
  ipcMain.handle("draft-set", (_event, key: string, value: string) => draftStore().set(key, value))
  ipcMain.handle("draft-delete", (_event, key: string) => draftStore().set(key, null))
  ipcMain.handle("draft-blob-put", (_event, data: ArrayBuffer) => draftStore().putBlob(new Uint8Array(data)))
  ipcMain.handle("draft-blob-get", (_event, id: string) => {
    const data = draftStore().getBlob(id)
    return data ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null
  })
  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? nativeT("desktop.dialog.chooseFolder"),
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )
  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? nativeT("desktop.dialog.chooseFile"),
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )
  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })
  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })
  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? nativeT("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )
  ipcMain.on("open-external", (_event: IpcMainEvent, url: string) => {
    openExternalURL(url)
  })
  ipcMain.on("open-local-file", (_event: IpcMainEvent, url: string) => {
    openLocalFileURL(url)
  })
  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    path = expandFilesystemPath(path)
    if (!app) {
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })
  ipcMain.handle("path-exists", async (_event: IpcMainInvokeEvent, path: string) => filesystemPathExists(path))
  ipcMain.handle("resolve-existing-path", async (_event: IpcMainInvokeEvent, paths: string[]) =>
    firstExistingFilesystemPath(Array.isArray(paths) ? paths : []),
  )
  ipcMain.handle("reveal-path", async (_event: IpcMainInvokeEvent, path: string) => {
    path = expandFilesystemPath(path)
    const exists = await filesystemPathExistsResolved(path)
    if (!exists) return false
    shell.showItemInFolder(path)
    return true
  })
  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })
  ipcMain.handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })
  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })
  ipcMain.handle("get-window-fullscreen", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFullScreen() ?? false
  })
  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })
  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })
  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })
  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}
export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}
export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
// --- browser engine IPC (window.api.browser) ---------------------------------
export function registerBrowserIpcHandlers(engine: BrowserEngine, trust: RendererTrust) {
  // Only registered app-renderer webContents in their MAIN frame may drive the
  // browser engine. A guest <webview> (or any other webContents) is never in
  // the allowlist, so it cannot reach these handlers — and a sub-frame sender
  // is rejected by the mainFrame assertion. This replaces the coarse
  // `BrowserWindow.fromWebContents(sender) !== null` check (whose semantics
  // for <webview> guests vary by Electron version) with a positive allowlist.
  const trusted = (event: IpcMainInvokeEvent): boolean => trust.isTrusted(event)
  ipcMain.handle("browser-get-state", (event) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.getState()
  })
  ipcMain.handle("browser-open-tab", (event, url: string, opts?: { activate?: boolean; newTab?: boolean }) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.openTab(url, opts)
  })
  ipcMain.handle("browser-activate-tab", (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.activateTab(tabId)
  })
  ipcMain.handle("browser-close-tab", (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.closeTab(tabId)
  })
  ipcMain.handle("browser-register-webview", (event, runtimeTabId: string, webContentsId: number, generation: number, lifecycleGeneration: number) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.registerWebview(runtimeTabId, webContentsId, generation, lifecycleGeneration)
  })
  ipcMain.handle("browser-unregister-webview", (event, runtimeTabId: string, webContentsId: number | undefined, generation: number | undefined, lifecycleGeneration: number) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.unregisterWebview(runtimeTabId, webContentsId, generation, lifecycleGeneration)
  })
  ipcMain.handle("browser-human-input", (event, runtimeTabId: string, signal: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    engine.api.humanInput(runtimeTabId, signal)
  })
  ipcMain.handle("browser-assign-tab", (event, tabId: string, owner: HostOwner) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.assignTab(tabId, owner)
  })
  ipcMain.handle("browser-close-range", (event, tabId: string, mode: "left" | "right" | "others" | "all") => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.closeRange(tabId, mode)
  })
  ipcMain.handle("browser-refresh-tab", async (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    try {
      return await engine.api.refreshTab(tabId)
    } catch {
      return
    }
  })
  ipcMain.handle("browser-duplicate-tab", async (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    try {
      return await engine.api.duplicateTab(tabId)
    } catch {
      return { tabId, url: "" }
    }
  })
  ipcMain.handle("browser-set-tab-muted", async (event, tabId: string, muted: boolean) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    try {
      return await engine.api.setTabMuted(tabId, muted)
    } catch {
      return
    }
  })
  ipcMain.handle("browser-open-devtools", async (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    try {
      return await engine.api.openDevtools(tabId)
    } catch {
      return
    }
  })
  ipcMain.handle("browser-hard-reload", async (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    try {
      return await engine.api.hardReload(tabId)
    } catch {
      return
    }
  })
  ipcMain.handle("browser-clear-cookies", async (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    try {
      return await engine.api.clearCookies(tabId)
    } catch {
      return
    }
  })
  ipcMain.handle("browser-clear-cache", async (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    try {
      return await engine.api.clearCache(tabId)
    } catch {
      return
    }
  })
  ipcMain.handle("browser-set-appearance", (event, appearance: "system" | "light" | "dark") => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.setAppearance(appearance)
  })
  ipcMain.handle("browser-list-extensions", async (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    try {
      return await engine.api.listExtensions(tabId)
    } catch {
      // Stale tab (agent session) must not crash the renderer chrome menu
      return []
    }
  })
  ipcMain.handle("browser-set-extension-enabled", async (event, tabId: string, extensionId: string, enabled: boolean) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    try {
      return await engine.api.setExtensionEnabled(tabId, extensionId, enabled)
    } catch {
      return
    }
  })
  ipcMain.handle("browser-get-guest-preload", (event) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return resolveGuestPreloadPath()
  })
  ipcMain.handle("browser-start-annotation", (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.startAnnotation(tabId)
  })
  ipcMain.handle("browser-cancel-annotation", (event, tabId: string) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    engine.api.cancelAnnotation(tabId)
  })
  ipcMain.handle("browser-visual-history", (event, context, input) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.visualHistory(context, input)
  })
  ipcMain.handle("browser-visual-artifact", (event, context, input) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.visualArtifact(context, input)
  })
  ipcMain.handle("browser-visual-artifact-preview", (event, context, input) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.visualArtifactPreview(context, input)
  })
  ipcMain.handle("browser-visual-approve-run", (event, context, runId: string, expected: VisualApprovalExpectation) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return engine.api.visualApproveRun(context, runId, expected)
  })
  // Chrome pairing (native host manifest) — exposed as window.api.chrome
  ipcMain.handle("chrome-get-status", (event) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return getChromePairingStatus()
  })
  ipcMain.handle("chrome-write-hosts", (event, opts: { hostBinaryPath: string; allowedOrigins: string[] }) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    if (!opts?.hostBinaryPath || !Array.isArray(opts.allowedOrigins)) throw new Error("Invalid chrome-write-hosts payload")
    return writeChromeHosts({ hostBinaryPath: opts.hostBinaryPath, allowedOrigins: opts.allowedOrigins })
  })
  ipcMain.handle("chrome-remove-hosts", (event) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return removeChromeHosts()
  })
  ipcMain.handle("chrome-get-instructions", (event) => {
    if (!trusted(event)) throw new Error("Untrusted browser sender")
    return getChromeInstructions()
  })
}
