// @refresh reload

import * as Sentry from "@sentry/solid"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { loadInitialLocale, type Locale } from "@/context/language"
import { type Platform, PlatformProvider } from "@/context/platform"
import { createBrowserDraftStore } from "@/utils/draft-store"
import { dict as en } from "@/i18n/en"
import { authFromToken } from "@/utils/server"
import {
  claimDeviceToken,
  clearDeviceToken,
  deviceCredentials,
  parsePairCode,
  readStoredDeviceToken,
  storeDeviceToken,
  stripPairHash,
  verifyDeviceToken,
} from "@/utils/pwa-pairing"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

// The PWA entry is served at /pwa.html (dev server, manual visits), but the
// router has no route for that path — normalize to "/" via replaceState so the
// launch URL never becomes a history entry (docs/pwa-mobile/03 §5 redirect
// hygiene: back must exit the app, not replay the launch URL).
if (location.pathname.endsWith("/pwa.html")) {
  history.replaceState(null, "", `/${location.search}${location.hash}`)
}

type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

let deferredInstallPrompt: BeforeInstallPromptEvent | undefined

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault()
  deferredInstallPrompt = event as BeforeInstallPromptEvent
})

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  return en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, onClick) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    window.focus()
    onClick?.()
    notification.close()
  }
}

const openExternal: Platform["openExternal"] = (value) => {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return
  window.open(url.href, "_blank", "noopener,noreferrer")
}

const refresh: Platform["refresh"] = async () => {
  window.location.reload()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const share: Platform["share"] = async (payload) => {
  const supported = typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare(payload))
  if (!supported) return "unsupported"

  try {
    await navigator.share(payload)
    return "shared"
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled"
    throw error
  }
}

const installPrompt: NonNullable<Platform["installPrompt"]> = {
  available: () => deferredInstallPrompt !== undefined,
  isStandalone: () =>
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true,
  promptInstall: async () => {
    const event = deferredInstallPrompt
    if (!event) return "unavailable"
    deferredInstallPrompt = undefined
    await event.prompt()
    return (await event.userChoice).outcome
  },
}

const haptics: Platform["haptics"] = (style) => {
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
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

const platform: Platform = {
  platform: "pwa",
  draftStore: createBrowserDraftStore(),
  version: pkg.version,
  openExternal,
  refresh,
  restart,
  notify,
  share,
  installPrompt,
  haptics,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `pwa@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "pwa",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

// Claim-on-boot + durable device token (task p3):
// 1. #pair=<code> in the fragment (never a query param — fragments are not
//    sent upstream, so the code stays out of logs/referrers) is exchanged for
//    a device token via plain fetch BEFORE the SDK boots, stored durably,
//    and stripped from the URL.
// 2. A stored token boots straight in as Basic credentials (username
//    "device", password <token>) — same ServerConnection.Http shape the web
//    entry uses, zero type changes.
// 3. A revoked token is detected by a pre-boot /global/health probe: 401
//    clears the stored token and the boot lands on the ConnectionGate
//    connect surface with the manual code entry (health check enabled for
//    exactly this reason — unlike the web entry).
const boot = async (locale: Locale, mountTarget: HTMLElement | null) => {
  if (!(mountTarget instanceof HTMLElement)) return
  const root = mountTarget
  const urlToken = new URLSearchParams(location.search).get("auth_token")
  clearAuthToken()

  const code = parsePairCode(location.hash)
  if (code) {
    stripPairHash()
    const claimed = await claimDeviceToken(getCurrentUrl(), code)
    if (claimed.ok) storeDeviceToken(claimed.token)
  }

  let credentials = authFromToken(urlToken)
  if (!credentials) {
    const stored = readStoredDeviceToken()
    if (stored) {
      const verdict = await verifyDeviceToken(getCurrentUrl(), stored)
      if (verdict === "invalid") clearDeviceToken()
      else credentials = deviceCredentials(stored)
    }
  }

  const server: ServerConnection.Http = {
    type: "http",
    authToken: !!credentials,
    http: {
      url: getCurrentUrl(),
      ...credentials,
    },
  }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders locale={locale}>
          <AppInterface
            defaultServer={ServerConnection.Key.make(getDefaultUrl())}
            canonicalLocalServer={ServerConnection.key(server)}
            servers={[server]}
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}

if (root instanceof HTMLElement) {
  void loadInitialLocale().then((locale) => void boot(locale, root))
}
