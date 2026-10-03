import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { Navigate, Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import {
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  ErrorBoundary,
  lazy,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { CommandProvider } from "@/context/command"
import { ForkUsageProvider } from "@/context/fork-usage"
import { GlobalProvider, useGlobal } from "@/context/global"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { eagerDict as appEnglish } from "@/i18n/en-core"
import { LayoutProvider } from "@/context/layout"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { ServerConnection, ServerProvider, useServer } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk-provider"
import { ServerSyncProvider } from "@/context/server-sync"
import { SessionGroupsProvider } from "@/context/session-groups"
import { SettingsProvider } from "@/context/settings"
import { TabsProvider } from "@/context/tabs"
import MobileLayout from "@/pages/layout-mobile"


const File = lazy(() => import("@opencode-ai/session-ui/file").then((module) => ({ default: module.File })))
const ErrorPage = lazy(() => import("@/pages/error").then((module) => ({ default: module.ErrorPage })))
const MobileHome = lazy(() => import("@/pages/home-mobile").then((module) => ({ default: module.MobileHome })))
const DraftRoute = lazy(() => import("@/pwa-routes/draft"))
const UsagePage = lazy(() => import("@/pages/usage-page").then((module) => ({ default: module.UsagePage })))
const MarkdownTargetActions = lazy(() =>
  import("@/components/markdown-target-actions").then((module) => ({ default: module.MarkdownTargetActions })),
)
const TargetSessionCenterRoute = lazy(() =>
  import("@/pwa-routes/session").then((module) => ({ default: module.TargetSessionCenterRouteController })),
)
const GroupTabRoute = lazy(() =>
  import("@/pwa-routes/session").then((module) => ({ default: module.GroupTabRouteController })),
)
const LegacySessionRedirect = lazy(() =>
  import("@/pwa-routes/session").then((module) => ({ default: module.NewLayoutLegacySessionRedirectController })),
)
const ScheduledRoute = lazy(() => import("@/pwa-routes/scheduled"))
const OxpRoute = lazy(() =>
  import("@/pwa-routes/oxp").then((module) => ({ default: module.PwaOxpRoute })),
)
const OxpActivityRoute = lazy(() =>
  import("@/pwa-routes/oxp").then((module) => ({ default: module.PwaOxpActivityRoute })),
)

const pwaQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnReconnect: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
    },
  },
})

function PwaErrorSurface(props: { error: unknown }) {
  return (
    <Suspense fallback={<div class="h-dvh w-screen bg-background-base" />}>
      <ErrorPage error={props.error} />
    </Suspense>
  )
}

function PwaI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return (
    <I18nProvider
      value={{ locale: language.intl, layoutLocale: language.layoutLocale, t: language.t, plural: language.plural }}
    >
      {props.children}
    </I18nProvider>
  )
}

/**
 * PWA base providers intentionally omit desktop-only WSL/update/native chrome
 * infrastructure. Business contexts are still the exact same contexts used by
 * the desktop app; only the platform shell is specialized.
 */
function PwaBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <LanguageProvider locale={props.locale} dictionary={appEnglish}>
          <PwaI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                void import("@sentry/solid").then((Sentry) => Sentry.captureException(error))
                return <PwaErrorSurface error={error} />
              }}
            >
              <QueryClientProvider client={pwaQueryClient}>
                <DialogProvider>
                  <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                </DialogProvider>
              </QueryClientProvider>
            </ErrorBoundary>
          </PwaI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function PwaBodyDesignClass() {
  createRenderEffect(() => {
    document.body.setAttribute("data-new-layout", "")
    document.body.classList.remove("text-12-regular")
    document.body.classList.add("font-(family-name:--font-family-text)", "text-[13px]", "font-[440]")
  })
  onCleanup(() => {
    document.body.removeAttribute("data-new-layout")
    document.body.classList.remove("font-(family-name:--font-family-text)", "text-[13px]", "font-[440]")
  })
  return null
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
 * Mobile home needs sync + session groups. Expensive feature-specific stores
 * are mounted only by the routes/components that consume them instead of
 * subscribing globally while hidden.
 */
function PwaSelectedServerProviders(props: ParentProps) {
  return (
    <ServerSDKProvider>
      <ServerSyncProvider>
        <ForkUsageProvider>
          <SessionGroupsProvider>
            <LayoutProvider>{props.children}</LayoutProvider>
          </SessionGroupsProvider>
        </ForkUsageProvider>
      </ServerSyncProvider>
    </ServerSDKProvider>
  )
}

function PwaConnectionGate(props: ParentProps) {
  const server = useServer()
  const global = useGlobal()
  const language = useLanguage()
  const health = createMemo(() => global.servers.health[server.key])
  const state = createMemo<"checking" | "online" | "offline">(() => {
    const current = health()
    if (!current) return "checking"
    return current.healthy ? "online" : "offline"
  })

  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  return (
    <Show
      when={state() === "online"}
      fallback={
        <div class="flex h-dvh w-screen flex-col items-center justify-center gap-4 bg-background-base px-6 text-center">
          <Splash class="h-15 w-12 opacity-60" />
          <Show when={state() === "offline"}>
            <div class="flex max-w-sm flex-col gap-1">
              <div class="text-14-regular text-text-base">
                {unreachable()[0]}
                <span class="font-medium text-text-strong">{name()}</span>
                {unreachable()[1]}
              </div>
              <div class="text-12-regular text-text-weak">{language.t("app.server.retrying")}</div>
            </div>
          </Show>
        </div>
      }
    >
      {props.children}
    </Show>
  )
}

function PwaRoutes() {
  return (
    <>
      <Route path="/" component={MobileHome} />
      <Route path="/new-session" component={DraftRoute} />
      <Route path="/usage" component={UsagePage} />
      <Route path="/scheduled" component={ScheduledRoute} />
      <Route path="/oxp" component={OxpRoute} />
      <Route path="/oxp/activity/:activityID" component={OxpActivityRoute} />
      <Route path="/:dir/session/:id" component={LegacySessionRedirect} />
      <Route path="/server/:serverKey/session/:id" component={TargetSessionCenterRoute} />
      <Route path="/server/:serverKey/group/:groupId/session/:sessionId" component={GroupTabRoute} />
      <Route path="/server/:serverKey/group/:groupId" component={GroupTabRoute} />
      <Route path="/settings" component={() => <Navigate href="/" />} />
    </>
  )
}

export function PwaAppRuntime(props: { server: ServerConnection.Http; locale?: Locale }) {
  const serverKey = createMemo(() => ServerConnection.key(props.server))
  return (
    <PwaBaseProviders locale={props.locale}>
      <ServerProvider
        defaultServer={serverKey()}
        canonicalLocalServer={serverKey()}
        servers={[props.server]}
        includeStoredServers={false}
      >
        <GlobalProvider>
          <SettingsProvider>
            <PwaConnectionGate>
              <Router
                root={(routerProps) => (
                  <TabsProvider>
                    <PermissionProvider>
                      <NotificationProvider>
                        <PwaSelectedServerProviders>
                          <CommandProvider>
                            <PwaBodyDesignClass />
                            <DeferredMarkdownTargetActions />
                            <MobileLayout>{routerProps.children}</MobileLayout>
                          </CommandProvider>
                        </PwaSelectedServerProviders>
                      </NotificationProvider>
                    </PermissionProvider>
                  </TabsProvider>
                )}
              >
                <PwaRoutes />
              </Router>
            </PwaConnectionGate>
          </SettingsProvider>
        </GlobalProvider>
      </ServerProvider>
    </PwaBaseProviders>
  )
}
