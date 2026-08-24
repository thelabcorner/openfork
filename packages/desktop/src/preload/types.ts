import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"
import type { BrowserAnnotationResult, BrowserPointerEvent, BrowserState, HostOwner, WireGuestTabState } from "../main/browser/contracts"
export type { BrowserAnnotationResult } from "../main/browser/contracts"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@opencode-ai/app/wsl/types"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
  scheme?: "system" | "light" | "dark"
}
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type BrowserTabRequest = {
  tabId: string
  url: string
  activate?: boolean
  newTab?: boolean
}

export type BrowserAPI = {
  getState: () => Promise<BrowserState>
  openTab: (url: string, opts?: { activate?: boolean; newTab?: boolean }) => Promise<{ tabId: string }>
  activateTab: (tabId: string) => Promise<BrowserState>
  closeTab: (tabId: string) => Promise<{ closed: boolean }>
  registerWebview: (runtimeTabId: string, webContentsId: number, generation?: number) => Promise<{ ok: true }>
  unregisterWebview: (runtimeTabId: string, webContentsId?: number, generation?: number) => Promise<{ ok: true }>
  getGuestPreloadPath: () => Promise<string>
  assignTab: (tabId: string, owner: HostOwner) => Promise<{ tabId: string; owner: HostOwner }>
  closeRange: (tabId: string, mode: "left" | "right" | "others" | "all") => Promise<{ closed: string[] }>
  refreshTab: (tabId: string) => Promise<void>
  duplicateTab: (tabId: string) => Promise<{ tabId: string; url: string }>
  setTabMuted: (tabId: string, muted: boolean) => Promise<void>
  openDevtools: (tabId: string) => Promise<void>
  hardReload: (tabId: string) => Promise<void>
  clearCookies: (tabId: string) => Promise<void>
  clearCache: (tabId: string) => Promise<void>
  setAppearance: (appearance: "system" | "light" | "dark") => Promise<void>
  listExtensions: (tabId: string) => Promise<Array<{ id: string; name: string; version: string; enabled: boolean }>>
  setExtensionEnabled: (tabId: string, extensionId: string, enabled: boolean) => Promise<void>
  onState: (cb: (tab: WireGuestTabState) => void) => () => void
  onTabRequest: (cb: (request: BrowserTabRequest) => void) => () => void
  onTabClose: (cb: (request: { tabId: string }) => void) => () => void
  onPointerEvent: (cb: (event: BrowserPointerEvent) => void) => () => void
  onHostState: (cb: (state: { connected: boolean }) => void) => () => void
  startAnnotation: (tabId: string) => Promise<BrowserAnnotationResult | null>
  cancelAnnotation: (tabId: string) => Promise<void>
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: () => Promise<ServerReadyData>
  wslServers: WslServersAPI
  updater: UpdaterAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  isFirstLaunchOnboardingPending: () => Promise<boolean>
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null>
  isOldLayoutEligible: () => Promise<boolean>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  checkAppExists: (appName: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeGetAll: (name: string) => Promise<Record<string, string>>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
  draftGet: (key: string) => Promise<string | null>
  draftSet: (key: string, value: string) => Promise<void>
  draftDelete: (key: string) => Promise<void>
  draftBlobPut: (data: ArrayBuffer) => Promise<string>
  draftBlobGet: (id: string) => Promise<ArrayBuffer | null>

  getWindowID: () => Promise<string>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  getPathForFile: (file: File) => string
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openExternal: (url: string) => void
  openLocalFile: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  revealPath: (path: string) => Promise<boolean>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  getWindowFocused: () => Promise<boolean>
  getWindowFullscreen: () => Promise<boolean>
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  compressExport: (json: string) => Promise<Uint8Array<ArrayBuffer> | null>
  setForceFocus: (enabled: boolean) => Promise<void>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
  setNativeTranslations: (bundle: DesktopNativeBundle) => Promise<void>
  browser: BrowserAPI
}
