import "@/index.css"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import {
  type BaseRouterProps,
  Navigate,
  Route,
  Router,
  useNavigate,
} from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import { CommandProvider, useCommand, type CommandOption } from "@/context/command"
import { ForkUsageProvider } from "@/context/fork-usage"
import { SessionGroupsProvider } from "@/context/session-groups"
import { GoalsProvider } from "@/context/goals"
import { OxpActivityProvider } from "@/context/oxp-activity"
import { ScheduledTasksProvider } from "@/context/scheduled-tasks"
import { ServerSDKProvider } from "@/context/server-sdk"
import { OfxpServerSeedBridge } from "@/context/ofxp-server-seed-bridge"
import { ServerSyncProvider } from "@/context/server-sync"
import { GlobalProvider, useGlobal } from "@/context/global"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { dict as appEnglish } from "@/i18n/en"
import { DESKTOP_NATIVE_ENGLISH } from "@/i18n/desktop-native"
import { LayoutProvider } from "@/context/layout"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TabsProvider } from "@/context/tabs"
import { WslServersProvider } from "@/wsl/context"
import { PersonalUsageProvider } from "@/context/personal-usage"
import { RoutePlaceholder } from "@/components/route-placeholder"
import { GenericContextMenuProvider } from "@/components/generic-context-menu"
import { useCheckServerHealth } from "./utils/server-health"
import { requireServerKey } from "./utils/session-route"

// Route-only surfaces are deliberately split out of the startup graph. In Vite
// dev, static imports are transformed on every server restart even when the
// route is never visited; session/usage/mobile in particular pull in large
// editor, markdown, terminal, browser, and analytics subgraphs. Keep the home
// and active desktop shell eager so first paint does not pay an extra chunk hop.
const loadNewLayout = () => import("@/pages/layout-new")
// Mobile never renders the desktop pane/titlebar shell, so keep it completely
// out of the PWA core graph. Desktop/web still starts this request immediately
// at module evaluation, preserving the previous eager-loading behavior while
// allowing the bundler to isolate the shell from PWA consumers.
const prefetchedNewLayout = import.meta.env.VITE_OPENCODE_PWA === "true" ? undefined : loadNewLayout()
const NewLayout = lazy(() => prefetchedNewLayout ?? loadNewLayout())
const LegacyLayout = lazy(() => import("@/pages/layout"))
const MobileLayout = lazy(() => import("@/pages/layout-mobile"))
const DirectoryLayout = lazy(() => import("@/pages/directory-layout"))
const DraftRoute = lazy(() => import("@/pages/draft-route"))
const LegacyHome = lazy(() => import("@/pages/home/legacy-home").then((m) => ({ default: m.LegacyHome })))
const UsagePage = lazy(() => import("@/pages/usage-page").then((m) => ({ default: m.UsagePage })))
const OxpActivityPage = lazy(() =>
  import("@/pages/oxp-activity-page").then((m) => ({ default: m.OxpActivityPage })),
)
const OxpActivityLandingPage = lazy(() =>
  import("@/pages/oxp-activity-page").then((m) => ({ default: m.OxpActivityLandingPage })),
)
const ScheduledPage = lazy(() => import("@/pages/scheduled-page").then((m) => ({ default: m.ScheduledPage })))
const SettingsPage = lazy(() =>
  import("@/components/settings-v2/settings-screen").then((m) => ({ default: m.SettingsScreen })),
)
const SessionRoute = lazy(() =>
  import("./app-session-routes").then((m) => ({ default: m.SessionRouteController })),
)
const TargetSessionRoute = lazy(() =>
  import("./app-session-routes").then((m) => ({ default: m.TargetSessionRouteController })),
)
const TargetSessionCenterRoute = lazy(() =>
  import("./app-session-routes").then((m) => ({ default: m.TargetSessionCenterRouteController })),
)
const LegacyTargetSessionRoute = lazy(() =>
  import("./app-session-routes").then((m) => ({ default: m.LegacyTargetSessionRouteController })),
)
const GroupTabRoute = lazy(() =>
  import("./app-session-routes").then((m) => ({ default: m.GroupTabRouteController })),
)
const NewLayoutLegacySessionRedirect = lazy(() =>
  import("./app-session-routes").then((m) => ({ default: m.NewLayoutLegacySessionRedirectController })),
)
const File = lazy(() => import("@opencode-ai/session-ui/file").then((m) => ({ default: m.File })))
const NewHome = lazy(() => import("@/pages/home").then((m) => ({ default: m.NewHome })))
const MobileHome = lazy(() => import("@/pages/home-mobile").then((m) => ({ default: m.MobileHome })))
const PwaPairEntry = lazy(() => import("@/components/pwa/pair-entry").then((m) => ({ default: m.PwaPairEntry })))
const MarkdownTargetActions = lazy(() =>
  import("@/components/markdown-target-actions").then((m) => ({ default: m.MarkdownTargetActions })),
)
const DeferredHighlightsProvider = lazy(() =>
  import("@/context/highlights").then((m) => ({ default: m.HighlightsProvider })),
)
const ErrorPage = lazy(() => import("./pages/error").then((m) => ({ default: m.ErrorPage })))

function ErrorSurface(props: { error: unknown }) {
  return (
    <Suspense fallback={<div class="h-dvh w-screen bg-background-base" />}>
      <ErrorPage error={props.error} />
    </Suspense>
  )
}

function DeferredMarkdownTargetActions() {
  const [ready, setReady] = createSignal(false)
  onMount(() => {
    const idle = globalThis.requestIdleCallback?.(() => setReady(true), { timeout: 750 })
    if (idle !== undefined) {
      onCleanup(() => globalThis.cancelIdleCallback?.(idle))
      return
    }
    const timer = globalThis.setTimeout(() => setReady(true), 0)
    onCleanup(() => globalThis.clearTimeout(timer))
  })
  return (
    <Show when={ready()}>
      <Suspense>
        <MarkdownTargetActions />
      </Suspense>
    </Show>
  )
}

/**
 * Release-note discovery is a side effect, not application infrastructure.
 * There are currently no useHighlights() consumers; the provider only checks
 * the persisted version and, on an upgrade, fetches changelog metadata before
 * eventually opening a dialog. Keep that whole branch out of first paint.
 *
 * Do not use requestIdleCallback alone here: Chromium can report idle while it
 * is blocked on Vite/network module discovery. A real elapsed-time embargo
 * guarantees release-note work cannot join the startup transform wave.
 */
function DeferredHighlightsRuntime() {
  const [ready, setReady] = createSignal(false)
  onMount(() => {
    const timer = globalThis.setTimeout(() => setReady(true), 1500)
    onCleanup(() => globalThis.clearTimeout(timer))
  })
  return (
    <Show when={ready()}>
      <Suspense>
        <DeferredHighlightsProvider>{null}</DeferredHighlightsProvider>
      </Suspense>
    </Show>
  )
}


// Wraps the non-draft routes. They are gated on (and keyed to) the globally selected
// server via ServerKey, then provide the server-scoped shell for that server.
function SelectedServerProviders(props: ParentProps) {
  return (
    <ServerKey>
      <ServerSDKProvider>
        <OfxpServerSeedBridge />
        <PersonalUsageProvider>
          <ServerSyncProvider>
            <GoalsProvider>
              <SessionGroupsProvider>
                <ForkUsageProvider>
                  <ScheduledTasksProvider>
                    <OxpActivityProvider>{props.children}</OxpActivityProvider>
                  </ScheduledTasksProvider>
                </ForkUsageProvider>
              </SessionGroupsProvider>
            </GoalsProvider>
          </ServerSyncProvider>
        </PersonalUsageProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
}

function LegacyServerLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  return (
    <SelectedServerProviders>
      <LegacyServerScopedShell serverScoped={props.serverScoped}>{props.children}</LegacyServerScopedShell>
    </SelectedServerProviders>
  )
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return (
    <I18nProvider
      value={{ locale: language.intl, layoutLocale: language.layoutLocale, t: language.t, plural: language.plural }}
    >
      {props.children}
    </I18nProvider>
  )
}


function LayoutCompatibility(props: ParentProps) {
  const global = useGlobal()
  const navigate = useNavigate()
  const server = useServer()
  const settings = useSettings()
  const platform = usePlatform()

  createEffect(() => {
    if (platform.platform === "pwa" || settings.general.newLayoutDesigns()) return
    const current = server.current
    if (!current) return
    const protocol = global.ensureServerCtx(current).sdk.protocolKind()
    if (protocol !== "v2") return
    const next = global.servers.list().find((s) => {
      if (ServerConnection.key(s) === ServerConnection.key(current)) return false
      return global.ensureServerCtx(s).sdk.protocolKind() !== "v2"
    })
    if (!next) return
    navigate("/")
    queueMicrotask(() => server.setActive(ServerConnection.key(next)))
  })

  return <>{props.children}</>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      deepLinks?: string[]
    }
  }
}

function setNativeTitlebarTheme(theme: { mode: "light" | "dark"; scheme?: "system" | "light" | "dark" }) {
  const bridge = (window as typeof window & {
    api?: { setTitlebar?: (value: typeof theme) => Promise<void> }
  }).api
  void bridge?.setTitlebar?.(theme)
}

const sharedQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnReconnect: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
    },
  },
})

function QueryProvider(props: ParentProps) {
  return <QueryClientProvider client={sharedQueryClient}>{props.children}</QueryClientProvider>
}

function BodyDesignClass() {
  const settings = useSettings()
  const platform = usePlatform()

  createRenderEffect(() => {
    if (typeof document === "undefined") return

    // The PWA is a first-class V2 presentation surface, not an experiment
    // controlled by the desktop layout preference stored in this browser.
    const enabled = platform.platform === "pwa" || settings.general.newLayoutDesigns()
    document.body.toggleAttribute("data-new-layout", enabled)
    document.body.classList.toggle("text-12-regular", !enabled)
    document.body.classList.toggle("font-(family-name:--font-family-text)", enabled)
    document.body.classList.toggle("text-[13px]", enabled)
    document.body.classList.toggle("font-[440]", enabled)
  })

  return null
}

// Server-agnostic providers shared across every route. These live in the shared
// shell (router root) so they stay mounted regardless of the active server/route.
function SharedProviders(props: ParentProps) {
  return (
    <>
      <BodyDesignClass />
      <CommandProvider>
        <DesktopCommands />
        <DeferredHighlightsRuntime />
        {props.children}
      </CommandProvider>
    </>
  )
}

function DesktopCommands() {
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()
  const navigate = useNavigate()

  command.register("desktop", () => {
    const commands: CommandOption[] = [
      {
        id: "scheduledTasks.open",
        title: language.t("command.scheduledTasks.open"),
        category: language.t("command.category.view"),
        onSelect: () => navigate("/scheduled"),
      },
    ]
    if (platform.platform === "desktop" && platform.exportDebugLogs) {
      commands.push({
        id: "logs.export",
        title: language.t("command.logs.export"),
        category: language.t("command.category.settings"),
        onSelect: () => {
          void platform.exportDebugLogs?.()
        },
      })
    }
    return commands
  })

  return null
}

// Server-scoped providers shared by the legacy shell and the top-level new shell.
type ServerScopedShellProps = ParentProps<{
  directory?: () => string | undefined
  serverScoped?: JSX.Element
}>

function ServerScopedProviders(props: ServerScopedShellProps) {
  return (
    <LayoutProvider>
      {props.serverScoped}
      {props.children}
    </LayoutProvider>
  )
}

function LegacyServerScopedShell(props: ServerScopedShellProps) {
  return (
    <ServerScopedProviders directory={props.directory} serverScoped={props.serverScoped}>
      <LegacyLayout>{props.children}</LegacyLayout>
    </ServerScopedProviders>
  )
}

function NewAppLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  return (
    <SelectedServerProviders>
      <ServerScopedProviders serverScoped={props.serverScoped}>
        <NewLayout>{props.children}</NewLayout>
      </ServerScopedProviders>
    </SelectedServerProviders>
  )
}

// Third layout arm (docs/pwa-mobile/03 §1.4): same provider stack as the new
// shell, mobile chrome instead of desktop titlebar/panes.
function MobileAppLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  return (
    <SelectedServerProviders>
      <ServerScopedProviders serverScoped={props.serverScoped}>
        <MobileLayout>{props.children}</MobileLayout>
      </ServerScopedProviders>
    </SelectedServerProviders>
  )
}

export function AppBaseProviders(
  props: ParentProps<{
    locale?: Locale
    onNativeTranslations?: Parameters<typeof LanguageProvider>[0]["onNativeTranslations"]
  }>,
) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode, scheme) => {
          setNativeTitlebarTheme({ mode, scheme })
        }}
      >
        <LanguageProvider
          locale={props.locale}
          dictionary={appEnglish}
          nativeEnglish={DESKTOP_NATIVE_ENGLISH}
          onNativeTranslations={props.onNativeTranslations}
        >
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                void import("@sentry/solid").then((Sentry) => Sentry.captureException(error))
                return <ErrorSurface error={error} />
              }}
            >
              <QueryProvider>
                <WslServersProvider>
                  <DialogProvider>
                    <FileComponentProvider component={File}>
                      <GenericContextMenuProvider>{props.children}</GenericContextMenuProvider>
                    </FileComponentProvider>
                  </DialogProvider>
                </WslServersProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(
  props: ParentProps<{ disableHealthCheck?: boolean; startup?: Promise<void>; showPwaPairEntry?: boolean }>,
) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )
  const checking = createMemo(
    () => checkMode() === "blocking" && ["unresolved", "pending"].includes(startupHealthCheck.state),
  )
  const [startup] = createResource(async () => {
    if (!props.startup) return true
    await props.startup.catch((error) => {
      console.error("[startup] startup gate failed", error)
    })
    return true
  })
  const startupChecking = createMemo(
    () => startupHealthCheck.latest === true && ["unresolved", "pending"].includes(startup.state),
  )
  const loading = createMemo(() => checking() || startupChecking())

  return (
    <>
      <Show when={!checking()}>
        <Show
          when={startupHealthCheck.latest}
          fallback={
            <ConnectionError
              showPwaPairEntry={props.showPwaPairEntry}
              onRetry={() => {
                if (checkMode() === "background") void healthCheckActions.refetch()
              }}
              onServerSelected={(key) => {
                setCheckMode("blocking")
                server.setActive(key)
                void healthCheckActions.refetch()
              }}
            />
          }
        >
          {props.children}
        </Show>
      </Show>
      <Show when={loading()}>
        <div class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      </Show>
    </>
  )
}

function ConnectionError(props: {
  onRetry?: () => void
  onServerSelected?: (key: ServerConnection.Key) => void
  showPwaPairEntry?: boolean
}) {
  const language = useLanguage()
  const server = useServer()
  const pwa = usePlatform().platform === "pwa"
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      {/* PWA pairing fallback: manual 6-char code entry on the connect surface (task p3). */}
      <Show when={pwa && props.showPwaPairEntry !== false}>
        <Suspense>
          <PwaPairEntry />
        </Suspense>
      </Show>

      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  includeStoredServers?: boolean
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
  showPwaPairEntry?: boolean
  startup?: Promise<void>
  serverScoped?: JSX.Element
}) {
  const pwa = usePlatform().platform === "pwa"
  // The visual new layout lives in the router root so it remains mounted across
  // route changes. Draft and session routes override only their server-bound data
  // providers beneath it.
  const ServerShell = (shellProps: ParentProps) => (
    <QueryProvider>
      <SharedProviders>
        {props.children}
        {shellProps.children}
      </SharedProviders>
    </QueryProvider>
  )

  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      canonicalLocalServer={props.canonicalLocalServer}
      servers={props.servers}
      includeStoredServers={props.includeStoredServers}
    >
      <GlobalProvider>
        <SettingsProvider>
          <ConnectionGate
            disableHealthCheck={props.disableHealthCheck}
            startup={props.startup}
            showPwaPairEntry={props.showPwaPairEntry}
          >
            <Dynamic
              component={props.router ?? Router}
              root={(routerProps) => (
                <TabsProvider>
                  <PermissionProvider>
                    <NotificationProvider>
                      <ServerShell>
                        {/* Global affordance for paths/URLs in markdown. Sits
                            above the layout arms so its delegated listeners are
                            not torn down when a route swaps. */}
                        <DeferredMarkdownTargetActions />
                        {/* PWA renders the mobile arm regardless of the layout flag;
                            web/desktop keep the legacy/new arms byte-identical. */}
                        {pwa ? (
                          <MobileAppLayout serverScoped={props.serverScoped}>
                            {routerProps.children}
                          </MobileAppLayout>
                        ) : (
                          <Show
                            when={useSettings().general.newLayoutDesigns()}
                            fallback={routerProps.children}
                          >
                            <NewAppLayout serverScoped={props.serverScoped}>
                              {routerProps.children}
                            </NewAppLayout>
                          </Show>
                        )}
                      </ServerShell>
                    </NotificationProvider>
                  </PermissionProvider>
                </TabsProvider>
              )}
            >
              <Routes serverScoped={props.serverScoped} />
            </Dynamic>
          </ConnectionGate>
        </SettingsProvider>
      </GlobalProvider>
    </ServerProvider>
  )
}

function Routes(props: { serverScoped?: JSX.Element }) {
  const settings = useSettings()
  const pwa = usePlatform().platform === "pwa"
  const modern = () => pwa || settings.general.newLayoutDesigns()

  return (
    <>
      <Route
        component={(routeProps) => (
          <LegacyServerLayout serverScoped={props.serverScoped}>{routeProps.children}</LegacyServerLayout>
        )}
      >
        <Show when={!modern()}>
          {
            <>
              <Route path="/" component={LegacyHome} />
              <Route path="/server/:serverKey/session/:id" component={LegacyTargetSessionRoute} />
            </>
          }
        </Show>
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={() => <Navigate href="session" />} />
          <Route path="/session/:id?" component={SessionRoute} />
        </Route>
      </Route>
      <Show when={modern()}>
        <Route path="/" component={pwa ? MobileHome : NewHome} />
        <Route path="/usage" component={UsagePage} />
        <Route path="/oxp" component={OxpActivityLandingPage} />
        <Route path="/oxp/activity/:activityID" component={OxpActivityPage} />
        <Route path="/scheduled" component={ScheduledPage} />
        <Route path="/:dir/session/:id" component={NewLayoutLegacySessionRedirect} />
        <Route
          path="/server/:serverKey/session/:id"
          component={
            pwa ? TargetSessionCenterRoute : TargetSessionRoute
          }
        />
        <Route path="/server/:serverKey/group/:groupId/session/:sessionId" component={GroupTabRoute} />
        <Route path="/server/:serverKey/group/:groupId" component={GroupTabRoute} />
      </Show>
      <Route path="/settings" component={SettingsPage} />
      <Route path="/new-session" component={DraftRoute} />
    </>
  )
}
