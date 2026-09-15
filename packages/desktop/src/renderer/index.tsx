// @refresh reload

import type { Platform } from "../../../app/src/context/platform"
import type { ServerConnection } from "../../../app/src/context/server"
import type { UpdaterState } from "@opencode-ai/app/updater"
import { createResource, createSignal, lazy, Show, Suspense } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { resetZoom, setPinchZoomEnabled, webviewZoom, zoomIn, zoomOut } from "./webview-zoom"
import { windowFullscreen } from "./window-fullscreen"
import { createDesktopStorage } from "./storage"

function createLazyDesktopDraftStore(): NonNullable<Platform["draftStore"]> {
  let store: Promise<NonNullable<Platform["draftStore"]>> | undefined
  const load = () => {
    store ??= import("../../../app/src/utils/draft-store").then(({ createDraftStore }) =>
      createDraftStore({
        get: window.api.draftGet,
        set: window.api.draftSet,
        remove: window.api.draftDelete,
        putBlob: (blob) => blob.arrayBuffer().then(window.api.draftBlobPut),
        getBlob: (id) => window.api.draftBlobGet(id).then((data) => data && new Blob([data])),
      }),
    )
    return store
  }

  return {
    getItem: (key) => load().then((value) => value.getItem(key)),
    setItem: (key, value) => load().then((item) => item.setItem(key, value)),
    removeItem: (key) => load().then((value) => value.removeItem(key)),
    putBlob: (blob) => load().then((value) => value.putBlob(blob)),
    flush: () => load().then((value) => value.flush()),
  }
}

function initSentryAfterFirstPaint() {
  if (!import.meta.env.VITE_SENTRY_DSN) return
  void import("@sentry/solid").then((Sentry) =>
    Sentry.init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
      release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop@${pkg.version}`,
      initialScope: {
        tags: {
          platform: "desktop",
        },
      },
      integrations: (integrations) =>
        integrations.filter(
          (i) =>
            i.name !== "Breadcrumbs" &&
            !(
              import.meta.env.OPENCODE_CHANNEL === "prod" &&
              (i.name === "GlobalHandlers" || i.name === "BrowserApiErrors")
            ),
        ),
    }),
  )
}

const startupLog = (name: string) => {
  if (!import.meta.env.DEV) return
  console.info(`[startup-perf] ${JSON.stringify({ name, ms: Math.round(performance.now() * 100) / 100 })}`)
}
startupLog("desktop.bootstrap.module")

// ── Desktop outside Electron (5173 preview) ─────────────────────────────────
// 5173 is electron-vite’s renderer dev server, NOT the mobile PWA. The PWA
// lives on 3001 (packages/mobile/vite.config.ts). When the renderer is
// opened raw in a browser, window.api (Electron preload) is absent and every
// top-level window.api.* access throws. Install a no-op shim early so the
// renderer degrades gracefully instead of white-screening.
if (typeof window !== "undefined" && !(window as unknown as { api?: unknown }).api) {
  console.warn("[desktop] window.api missing – running outside Electron (5173 preview). Mobile PWA is on 3001. Using no-op shim.")
  const noop = (..._a: unknown[]) => Promise.resolve(null) as unknown as Promise<never>
  const sub = () => () => {}
  ;(window as unknown as { api: Record<string, unknown> }).api = new Proxy(
    {
      updater: { subscribe: sub, check: noop, install: noop },
      onDeepLink: sub,
      onMenuCommand: sub,
      consumeInitialDeepLinks: async () => [] as string[],
      awaitInitialization: async () => null,
      getWindowID: async () => "browser",
      setBackgroundColor: noop,
      setNativeTranslations: noop,
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string, unknown>)[prop as string]
        return (..._a: unknown[]) => Promise.resolve(null)
      },
    },
  ) as unknown as typeof window.api
}

// Start downloading/transforming the heavy shell as soon as the tiny bootstrap
// has established its Electron-or-preview API contract. Window identity is
// still required before we *mount* the shell (it selects the correct persisted
// route), but it must not serialize the shell graph behind that IPC round-trip.
const desktopAppShellModule = import("./app-shell")
const DesktopAppShell = lazy(() => desktopAppShellModule)
startupLog("desktop.app-shell.requested")

window.addEventListener(
  "error",
  (event) => {
    if (event.message === "ResizeObserver loop completed with undelivered notifications.") {
      event.preventDefault()
    }
  },
  true,
)

window.addEventListener("contextmenu", (event) => {
  event.preventDefault()
})

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error("Desktop renderer root not found")
}

const [updaterState, setUpdaterState] = createSignal<UpdaterState>({ status: "disabled" })
void window.api.updater.subscribe(setUpdaterState)

const deepLinkEvent = "opencode:deep-link"

type DesktopWindowState = {
  id?: string
}

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

const createPlatform = (windowState: DesktopWindowState): Platform => {
  const attachmentPaths = new WeakMap<File, string>()
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const runDesktopMenuAction: Platform["runDesktopMenuAction"] = (action) => {
    switch (action) {
      case "view.resetZoom":
        resetZoom()
        return
      case "view.zoomIn":
        zoomIn()
        return
      case "view.zoomOut":
        zoomOut()
        return
    }

    return window.api.runDesktopMenuAction(action)
  }

  const storage = createDesktopStorage(window.api)

  const wslServersApi = os === "windows" ? window.api.wslServers : undefined

  return {
    platform: "desktop",
    os,
    version: pkg.version,
    windowID: windowState.id,

    async openDirectoryPickerDialog(opts) {
      return window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title,
      })
    },

    async openAttachmentPickerDialog(opts, onFile) {
      const extensions =
        opts?.extensions ??
        (await import("../../../app/src/constants/file-picker")).ACCEPTED_FILE_EXTENSIONS
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title,
        defaultPath: opts?.defaultPath,
        extensions,
      })
      if (!result) return
      try {
        for (const file of result.files) {
          const selected = new File([await window.api.readPickedFile(result.token, file.path)], file.name)
          attachmentPaths.set(selected, file.path)
          await onFile(selected)
        }
      } finally {
        await window.api.releasePickedFiles(result.token)
      }
    },

    getPathForFile(file) {
      return attachmentPaths.get(file) ?? window.api.getPathForFile(file)
    },

    async saveFilePickerDialog(opts) {
      return window.api.saveFilePicker({
        title: opts?.title,
        defaultPath: opts?.defaultPath,
      })
    },

    async compressExport(json) {
      try {
        return await window.api.compressExport(json)
      } catch {
        return null
      }
    },

    openExternal(url: string) {
      window.api.openExternal(url)
    },
    openLocalFile(url: string) {
      window.api.openLocalFile(url)
    },
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        return window.api.openPath(path, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },
    async revealPath(path: string) {
      return window.api.revealPath(path)
    },
    async pathExists(path: string) {
      return window.api.pathExists(path)
    },
    ...(typeof window.api.resolveExistingPath === "function"
      ? {
          async resolveExistingPath(paths: readonly string[]) {
            return window.api.resolveExistingPath(Array.from(paths))
          },
        }
      : {}),

    storage,
    draftStore: createLazyDesktopDraftStore(),

    updater: {
      state: updaterState,
      check: () => window.api.updater.check(),
      install: () => window.api.updater.install(),
    },

    exportDebugLogs: () => window.api.exportDebugLogs(),

    setForceFocus: (enabled) => window.api.setForceFocus(enabled),

    recordFatalRendererError: (error) => window.api.recordFatalRendererError(error),

    refresh: async () => {
      await window.api.runDesktopMenuAction("view.reload")
    },

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, onClick) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "https://opencode.ai/favicon-96x96-v3.png",
      })
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        onClick?.()
        notification.close()
      }
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return url as ServerConnection.Key
    },

    setDefaultServer: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    wslServers: wslServersApi,

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    webviewZoom,

    windowFullscreen,

    getPinchZoomEnabled: () => window.api.getPinchZoomEnabled(),

    setPinchZoomEnabled,

    runDesktopMenuAction,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
listenForDeepLinks()

function LoadingSplash() {
  const dark = document.documentElement.dataset.colorScheme === "dark"
  return (
    <div
      class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base"
      style={{
        position: "fixed",
        inset: "0",
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        width: "100vw",
        height: "100vh",
        background: dark ? "#080808" : "#fafafa",
      }}
    >
      <svg
        viewBox="0 0 80 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ width: "48px", height: "60px", color: dark ? "#e8e8e8" : "#1b1b1b", opacity: "0.52" }}
      >
        <path d="M60 80H20V40H60V80Z" fill="currentColor" opacity="0.45" />
        <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="currentColor" />
      </svg>
    </div>
  )
}

function DesktopRoot(props: { windowState: DesktopWindowState }) {
  const platform = createPlatform(props.windowState)
  return (
    <Suspense fallback={<LoadingSplash />}>
      <DesktopAppShell
        platform={platform}
        windowID={platform.windowID ?? "browser"}
        sidecar={startupSidecar}
        defaultServer={startupDefaultServer}
        onboardingPending={startupOnboardingPending}
        fallback={<LoadingSplash />}
        setMenuTrigger={(trigger) => {
          menuTrigger = trigger
        }}
      />
    </Suspense>
  )
}

// None of these operations depends on the window id. Starting them at module
// evaluation overlaps backend readiness and persistent-store IPC with the
// window-id lookup and app-shell transform instead of creating a serial chain.
const startupSidecar = window.api.awaitInitialization()
const startupDefaultServer = window.api
  .getDefaultServerUrl()
  .then((url) => (url ? (url as ServerConnection.Key) : null))
  .catch(() => null)
const startupOnboardingPending = window.api.isFirstLaunchOnboardingPending().catch(() => false)
void startupSidecar.then(() => startupLog("desktop.sidecar.ready"))
void startupDefaultServer.then(() => startupLog("desktop.default-server.ready"))
void startupOnboardingPending.then(() => startupLog("desktop.onboarding-check.ready"))

render(() => {
  const [windowState] = createResource(async () => {
    const api = window.api as typeof window.api & {
      getWindowID?: () => Promise<string>
    }
    const id = await api.getWindowID?.()
    startupLog("desktop.window-id.ready")
    return { id }
  })

  return (
    <Show when={windowState.latest} fallback={<LoadingSplash />} keyed>
      {(state) => <DesktopRoot windowState={state} />}
    </Show>
  )
}, root!)

// The document contains a dependency-free splash so Electron's first paint is
// never an empty background while Vite/bootstrap JS is still loading. Solid's
// fallback above is now mounted and self-styled, so hand off immediately.
document.getElementById("oc-bootstrap-splash")?.remove()
document.getElementById("oc-bootstrap-style")?.remove()
startupLog("desktop.bootstrap.solid-mounted")
requestAnimationFrame(() => {
  startupLog("desktop.bootstrap.first-frame")
  initSentryAfterFirstPaint()
})
