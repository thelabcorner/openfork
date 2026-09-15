import { AppBaseProviders, AppInterface } from "../../../app/src/app"
import { useCommand } from "../../../app/src/context/command"
import { useLanguage } from "../../../app/src/context/language"
import { type Platform, PlatformProvider } from "../../../app/src/context/platform"
import { ServerConnection } from "../../../app/src/context/server"
import { useWslServers } from "../../../app/src/wsl/context"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { createMemoryHistory, MemoryRouter, type BaseRouterProps } from "@solidjs/router"
import { createEffect, createMemo, createResource, type JSX, onCleanup, Show } from "solid-js"
import type { ServerReadyData } from "../preload/types"
import { initializationData } from "./initialization"
import { DesktopFirstLaunchOnboarding } from "./onboarding"
import { availableStartupServer, readyWslConnections } from "./wsl/connections"
import { startupMark } from "../../../app/src/utils/startup-perf"

startupMark("desktop.app-shell.module")

function windowLastActiveUrlKey(windowID: string) {
  return `opencode.desktop.window.${windowID}.last-active-url`
}

function getLastActiveUrl(windowID: string) {
  if (typeof localStorage !== "object") return "/"
  try {
    const value = localStorage.getItem(windowLastActiveUrlKey(windowID))
    if (value?.startsWith("/") && !value.startsWith("//")) return value
  } catch {}
  return "/"
}

function setLastActiveUrl(windowID: string, value: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.setItem(windowLastActiveUrlKey(windowID), value)
  } catch {}
}

function DesktopMemoryRouter(props: BaseRouterProps & { windowID: string }) {
  const history = createMemoryHistory()
  const initialUrl = getLastActiveUrl(props.windowID)
  if (initialUrl !== "/") history.set({ value: initialUrl, replace: true, scroll: false })
  onCleanup(history.listen((value) => setLastActiveUrl(props.windowID, value)))
  return <MemoryRouter {...props} history={history} />
}

export default function DesktopAppShell(props: {
  platform: Platform
  windowID: string
  sidecar: Promise<ServerReadyData>
  defaultServer: Promise<ServerConnection.Key | null>
  onboardingPending: Promise<boolean>
  fallback: JSX.Element
  setMenuTrigger: (trigger: (id: string) => void) => void
}) {
  startupMark("desktop.app-shell.component")
  const initialUrl = getLastActiveUrl(props.windowID)
  // The home surface is route-only and no longer belongs in app.tsx's
  // synchronous startup graph. If this window is actually restoring home,
  // speculatively load it while backend/persistence work is already in flight;
  // restored session/draft windows pay nothing for the home graph.
  if (initialUrl === "/") {
    void import("../../../app/src/pages/home").then(() => startupMark("desktop.home.preloaded"))
  }
  // These promises are started by the tiny renderer bootstrap before this lazy
  // chunk is requested, so application graph loading and backend startup run in
  // parallel instead of serializing behind each other.
  const [sidecar] = createResource(() => props.sidecar)
  const [defaultServer] = createResource(() => props.defaultServer)
  const router = (routerProps: BaseRouterProps) => (
    <DesktopMemoryRouter {...routerProps} windowID={props.windowID} />
  )
  const onboarding = Promise.withResolvers<void>()
  // Existing installs should never wait for deferred tab/recent-state
  // hydration just to remove the startup overlay. The tiny renderer bootstrap
  // begins this main-process store check in parallel with sidecar/app-shell
  // startup. Only a genuinely pending first launch waits for onboarding work.
  const startup = props.onboardingPending.then(async (pending) => {
    if (pending) await onboarding.promise
  })

  function Inner() {
    const command = useCommand()
    props.setMenuTrigger((id) => command.trigger(id))

    const theme = useTheme()
    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) void window.api.setBackgroundColor(bg)
    })
    return null
  }

  function App() {
    const wslServers = useWslServers()
    const language = useLanguage()
    // WSL discovery is auxiliary and updates through the provider subscription.
    // Only the selected local server identity is required for the first app mount.
    const ready = createMemo(() => !defaultServer.loading && !sidecar.loading)
    createEffect(() => {
      if (ready()) startupMark("desktop.app-shell.backend-inputs-ready")
    })
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: language.t("desktop.server.local"),
          type: "sidecar",
          variant: "base",
          http: {
            url: data.url,
            username: data.username ?? undefined,
            password: data.password ?? undefined,
          },
        })
      }
      list.push(...readyWslConnections(wslServers.data, language.t("wsl.server.label")))
      return list
    })
    const effectiveDefaultServer = createMemo(() =>
      ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data)),
    )

    return (
      <Show when={ready()} fallback={props.fallback}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface
              defaultServer={key}
              servers={servers()}
              router={router}
              // The base desktop sidecar key is published only after
              // Server.listen() resolves. A second blocking HTTP health loop
              // here serializes router/layout mount (and therefore sidebar
              // session hydration) behind readiness we already proved.
              disableHealthCheck={key === ServerConnection.Key.make("sidecar")}
              startup={startup}
              serverScoped={
                <DesktopFirstLaunchOnboarding
                  initialUrl={initialUrl}
                  pending={props.onboardingPending}
                  onLoaded={onboarding.resolve}
                />
              }
            >
              <Inner />
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  return (
    <PlatformProvider value={props.platform}>
      <AppBaseProviders
        onNativeTranslations={(bundle) => void window.api.setNativeTranslations(bundle).catch(() => undefined)}
      >
        <App />
      </AppBaseProviders>
    </PlatformProvider>
  )
}
