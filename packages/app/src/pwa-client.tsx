import "./pwa.css"
import { createSignal, onCleanup, onMount, type Component } from "solid-js"
import { type Locale } from "./context/language"
import { type Platform, PlatformProvider } from "./context/platform"
import {
  PwaConnectionProvider,
  type PwaEndpointMigrationResult,
  type PwaNetworkIdentity,
} from "./context/pwa-connection"
import { ServerConnection } from "./context/server"
import { PwaAppRuntime } from "./pwa-runtime"
import { createBrowserDraftStore } from "./utils/draft-store"
import { sessionHref } from "./utils/session-route"

type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

export type PwaClientAppProps = {
  /** Remote API origin. The static PWA origin is deliberately unrelated. */
  serverUrl: string
  /** Device token issued by pair.claim. Omit only for an intentionally unauthenticated server. */
  deviceToken?: string
  deviceID?: string
  networkIdentity?: PwaNetworkIdentity
  onForgetDevice?: () => void
  migrateEndpoint?: (nextUrl: string) => Promise<PwaEndpointMigrationResult>
  locale?: Locale
}

export type { PwaEndpointMigrationResult } from "./context/pwa-connection"

function navigationSessionID(raw: string) {
  try {
    const url = new URL(raw, location.origin)
    const query = url.searchParams.get("session")?.trim()
    if (query) return query
    const match = url.pathname.match(/^\/session\/([^/]+)\/?$/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

/**
 * Browser/PWA platform adapter around the authoritative application runtime.
 *
 * This is intentionally the only rendering seam a separately deployed mobile
 * shell needs. Session state, routing, timeline projection, prompt assembly,
 * tools, permissions, goals and model semantics remain owned by packages/app.
 */
export const PwaClientApp: Component<PwaClientAppProps> = (props) => {
  const serverKey = ServerConnection.Key.make(props.serverUrl)
  const server: ServerConnection.Http = {
    type: "http",
    authToken: !!props.deviceToken,
    http: {
      url: props.serverUrl,
      ...(props.deviceToken ? { username: "device", password: props.deviceToken } : {}),
    },
  }
  const draftStore = createBrowserDraftStore()
  const [installPrompt, setInstallPrompt] = createSignal<BeforeInstallPromptEvent>()

  const routeSession = (sessionID: string, replace: boolean) => {
    const next = sessionHref(serverKey, sessionID)
    if (location.pathname === next) return
    history[replace ? "replaceState" : "pushState"](null, "", next)
    if (!replace) window.dispatchEvent(new PopStateEvent("popstate"))
  }

  // Normalize the standalone client's historical notification/deep-link shape
  // before the router reads location. Warm notification clicks use the same
  // canonical route through the event bridge below.
  const initialSession = navigationSessionID(location.href)
  if (initialSession) routeSession(initialSession, true)

  const platform: Platform = {
    platform: "pwa",
    draftStore,
    openExternal(value) {
      if (!URL.canParse(value)) return
      const url = new URL(value)
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) return
      window.open(url.href, "_blank", "noopener,noreferrer")
    },
    refresh: async () => window.location.reload(),
    restart: async () => window.location.reload(),
    notify: async (title, description, onClick) => {
      // Permission prompts must come from the explicit Settings user gesture.
      // A background lifecycle event is neither a valid nor predictable place
      // to ask the browser for notification permission.
      if (!("Notification" in window) || Notification.permission !== "granted") return
      if (document.visibilityState === "visible" && document.hasFocus()) return
      const notification = new Notification(title, { body: description ?? "" })
      notification.onclick = () => {
        window.focus()
        onClick?.()
        notification.close()
      }
    },
    share: async (payload) => {
      const supported = typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare(payload))
      if (!supported) return "unsupported"
      try {
        await navigator.share(payload)
        return "shared"
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return "cancelled"
        throw error
      }
    },
    installPrompt: {
      available: () => !!installPrompt(),
      isStandalone: () =>
        window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true,
      promptInstall: async () => {
        const current = installPrompt()
        if (!current) return "unavailable"
        setInstallPrompt(undefined)
        await current.prompt()
        return (await current.userChoice).outcome
      },
    },
    haptics(style) {
      if (typeof navigator.vibrate !== "function") return
      const patterns = {
        light: 10,
        medium: 20,
        heavy: 30,
        success: [10, 40, 10],
        warning: [20, 60, 20],
        error: [30, 50, 30, 50, 30],
      }
      navigator.vibrate(patterns[style])
    },
    getDefaultServer: async () => serverKey,
    setDefaultServer: () => {},
  }

  const onInstallPrompt = (event: Event) => {
    event.preventDefault()
    setInstallPrompt(event as BeforeInstallPromptEvent)
  }
  const onPushNavigate = (event: Event) => {
    const raw = (event as CustomEvent<{ url?: string }>).detail?.url
    if (!raw) return
    const sessionID = navigationSessionID(raw)
    if (sessionID) routeSession(sessionID, false)
  }

  onMount(() => {
    window.addEventListener("beforeinstallprompt", onInstallPrompt)
    window.addEventListener("opencode:push-navigate", onPushNavigate)
  })
  onCleanup(() => {
    window.removeEventListener("beforeinstallprompt", onInstallPrompt)
    window.removeEventListener("opencode:push-navigate", onPushNavigate)
  })

  return (
    <PlatformProvider value={platform}>
      <PwaConnectionProvider
        value={{
          serverUrl: props.serverUrl,
          deviceID: props.deviceID,
          networkIdentity: props.networkIdentity,
          forgetDevice: props.onForgetDevice,
          migrateEndpoint: props.migrateEndpoint,
        }}
      >
        <PwaAppRuntime server={server} locale={props.locale} />
      </PwaConnectionProvider>
    </PlatformProvider>
  )
}
