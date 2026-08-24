import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { BrowserAPI, ElectronAPI, WslServersEvent } from "./types"
import type { UpdaterState } from "@opencode-ai/app/updater"

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

const browserApi: BrowserAPI = {
  getState: () => ipcRenderer.invoke("browser-get-state"),
  openTab: (url, opts) => ipcRenderer.invoke("browser-open-tab", url, opts),
  activateTab: (tabId) => ipcRenderer.invoke("browser-activate-tab", tabId),
  closeTab: (tabId) => ipcRenderer.invoke("browser-close-tab", tabId),
  registerWebview: (runtimeTabId, webContentsId, generation) =>
    ipcRenderer.invoke("browser-register-webview", runtimeTabId, webContentsId, generation),
  unregisterWebview: (runtimeTabId, webContentsId, generation) =>
    ipcRenderer.invoke("browser-unregister-webview", runtimeTabId, webContentsId, generation),
  getGuestPreloadPath: () => ipcRenderer.invoke("browser-get-guest-preload"),
  assignTab: (tabId, owner) => ipcRenderer.invoke("browser-assign-tab", tabId, owner),
  closeRange: (tabId, mode) => ipcRenderer.invoke("browser-close-range", tabId, mode),
  refreshTab: (tabId) => ipcRenderer.invoke("browser-refresh-tab", tabId),
  duplicateTab: (tabId) => ipcRenderer.invoke("browser-duplicate-tab", tabId),
  setTabMuted: (tabId, muted) => ipcRenderer.invoke("browser-set-tab-muted", tabId, muted),
  openDevtools: (tabId) => ipcRenderer.invoke("browser-open-devtools", tabId),
  hardReload: (tabId) => ipcRenderer.invoke("browser-hard-reload", tabId),
  clearCookies: (tabId) => ipcRenderer.invoke("browser-clear-cookies", tabId),
  clearCache: (tabId) => ipcRenderer.invoke("browser-clear-cache", tabId),
  setAppearance: (appearance) => ipcRenderer.invoke("browser-set-appearance", appearance),
  listExtensions: (tabId) => ipcRenderer.invoke("browser-list-extensions", tabId),
  setExtensionEnabled: (tabId, extensionId, enabled) =>
    ipcRenderer.invoke("browser-set-extension-enabled", tabId, extensionId, enabled),
  onState: (cb) => {
    const handler = (_: unknown, tab: Parameters<typeof cb>[0]) => cb(tab)
    ipcRenderer.on("browser-state", handler)
    return () => ipcRenderer.removeListener("browser-state", handler)
  },
  onTabRequest: (cb) => {
    const handler = (_: unknown, request: Parameters<typeof cb>[0]) => cb(request)
    ipcRenderer.on("browser-tab-request", handler)
    return () => ipcRenderer.removeListener("browser-tab-request", handler)
  },
  onTabClose: (cb) => {
    const handler = (_: unknown, request: Parameters<typeof cb>[0]) => cb(request)
    ipcRenderer.on("browser-tab-close", handler)
    return () => ipcRenderer.removeListener("browser-tab-close", handler)
  },
  onPointerEvent: (cb) => {
    const handler = (_: unknown, event: Parameters<typeof cb>[0]) => cb(event)
    ipcRenderer.on("browser-pointer-event", handler)
    return () => ipcRenderer.removeListener("browser-pointer-event", handler)
  },
  onHostState: (cb) => {
    const handler = (_: unknown, state: Parameters<typeof cb>[0]) => cb(state)
    ipcRenderer.on("browser-host-state", handler)
    return () => ipcRenderer.removeListener("browser-host-state", handler)
  },
  startAnnotation: (tabId) => ipcRenderer.invoke("browser-start-annotation", tabId),
  cancelAnnotation: (tabId) => ipcRenderer.invoke("browser-cancel-annotation", tabId),
}

const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  wslServers: {
    getState: () => ipcRenderer.invoke("wsl-servers-get-state"),
    subscribe: (cb) => {
      const handler = (_: unknown, event: WslServersEvent) => cb(event)
      ipcRenderer.on("wsl-servers-event", handler)
      void ipcRenderer.invoke("wsl-servers-subscribe")
      return () => {
        ipcRenderer.removeListener("wsl-servers-event", handler)
        void ipcRenderer.invoke("wsl-servers-unsubscribe")
      }
    },
    probeRuntime: () => ipcRenderer.invoke("wsl-servers-probe-runtime"),
    refreshDistros: () => ipcRenderer.invoke("wsl-servers-refresh-distros"),
    installWsl: () => ipcRenderer.invoke("wsl-servers-install-wsl"),
    installDistro: (name) => ipcRenderer.invoke("wsl-servers-install-distro", name),
    probeAddable: (distros) => ipcRenderer.invoke("wsl-servers-probe-addable", distros),
    installOpencode: (name) => ipcRenderer.invoke("wsl-servers-install-opencode", name),
    openTerminal: (name) => ipcRenderer.invoke("wsl-servers-open-terminal", name),
    addServer: (distro) => ipcRenderer.invoke("wsl-servers-add", distro),
    removeServer: (id) => ipcRenderer.invoke("wsl-servers-remove", id),
    startServer: (id) => ipcRenderer.invoke("wsl-servers-start", id),
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    install: () => ipcRenderer.invoke("updater-install"),
  },
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  isFirstLaunchOnboardingPending: () => ipcRenderer.invoke("is-first-launch-onboarding-pending"),
  finishFirstLaunchOnboarding: (createDefaultProject) =>
    ipcRenderer.invoke("finish-first-launch-onboarding", createDefaultProject),
  isOldLayoutEligible: () => ipcRenderer.invoke("is-old-layout-eligible"),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeGetAll: (name) => ipcRenderer.invoke("store-get-all", name),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),
  draftGet: (key) => ipcRenderer.invoke("draft-get", key),
  draftSet: (key, value) => ipcRenderer.invoke("draft-set", key, value),
  draftDelete: (key) => ipcRenderer.invoke("draft-delete", key),
  draftBlobPut: (data) => ipcRenderer.invoke("draft-blob-put", data),
  draftBlobGet: (id) => ipcRenderer.invoke("draft-blob-get", id),

  getWindowID: () => ipcRenderer.invoke("get-window-id"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openExternal: (url) => ipcRenderer.send("open-external", url),
  openLocalFile: (url) => ipcRenderer.send("open-local-file", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  revealPath: (path) => ipcRenderer.invoke("reveal-path", path),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  getWindowFullscreen: () => ipcRenderer.invoke("get-window-fullscreen"),
  onWindowFullscreenChanged: (cb) => {
    const handler = (_: unknown, fullscreen: boolean) => cb(fullscreen)
    ipcRenderer.on("window-fullscreen-changed", handler)
    return () => ipcRenderer.removeListener("window-fullscreen-changed", handler)
  },
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  getPinchZoomEnabled: () => ipcRenderer.invoke("get-pinch-zoom-enabled"),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke("set-pinch-zoom-enabled", enabled),
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on("pinch-zoom-enabled-changed", handler)
    return () => ipcRenderer.removeListener("pinch-zoom-enabled-changed", handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on("zoom-factor-changed", handler)
    return () => ipcRenderer.removeListener("zoom-factor-changed", handler)
  },
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  runDesktopMenuAction: (action) => ipcRenderer.invoke("run-desktop-menu-action", action),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  exportDebugLogs: () => ipcRenderer.invoke("export-debug-logs"),
  compressExport: (json: string) => ipcRenderer.invoke("compress-export", json),
  setForceFocus: (enabled) => ipcRenderer.invoke("set-force-focus", enabled),
  recordFatalRendererError: (error) => ipcRenderer.invoke("record-fatal-renderer-error", error),
  setNativeTranslations: (bundle) => ipcRenderer.invoke("set-native-translations", bundle),
  browser: browserApi,
}

contextBridge.exposeInMainWorld("api", api)
