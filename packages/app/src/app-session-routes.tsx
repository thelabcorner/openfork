import { Navigate, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, lazy, Show, Suspense, type ParentProps } from "solid-js"
import { ForkUsageProvider } from "@/context/fork-usage"
import { GoalsProvider } from "@/context/goals"
import { PersonalUsageProvider } from "@/context/personal-usage"
import { ServerConnection, useServer } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { useGlobal } from "@/context/global"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useTabs } from "@/context/tabs"
import { RoutePlaceholder } from "@/components/route-placeholder"
import { createSessionLineage } from "@/pages/session/session-lineage"
import {
  legacySessionHref,
  legacySessionServer,
  parseServerKey,
  sessionHref,
} from "@/utils/session-route"

const SessionPage = lazy(() => import("@/pages/session").then((module) => ({ default: module.SessionPage })))
const SessionRouteErrorBoundary = lazy(() =>
  import("@/pages/session").then((module) => ({ default: module.SessionRouteErrorBoundary })),
)
const TargetSessionRouteContent = lazy(() =>
  import("@/pages/session").then((module) => ({ default: module.TargetSessionRouteContent })),
)
const GroupTabPage = lazy(() => import("@/pages/group-tab"))
const ErrorPage = lazy(() => import("@/pages/error").then((module) => ({ default: module.ErrorPage })))

function ErrorSurface(props: { error: unknown }) {
  return (
    <Suspense fallback={<div class="h-dvh w-screen bg-background-base" />}>
      <ErrorPage error={props.error} />
    </Suspense>
  )
}

export function SessionRouteController() {
  const settings = useSettings()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const sdk = useSDK()
  const server = useServer()
  const tabs = useTabs()

  if (params.id && settings.general.newLayoutDesigns()) {
    const sessionID = params.id
    const persisted = tabs.store.filter((item) => item.type === "session")
    return <Navigate href={sessionHref(legacySessionServer(persisted, sessionID, server.key), sessionID)} />
  }

  createEffect(() => {
    if (!settings.general.newLayoutDesigns()) return
    if (params.id || search.draftId) return
    if (!tabs.ready() || !sdk().directory) return
    void tabs.newDraft({ server: server.key, directory: sdk().directory }, search.prompt)
  })

  return (
    <SessionRouteErrorBoundary sessionID={params.id}>
      <SessionPage />
    </SessionRouteErrorBoundary>
  )
}

function TargetServerRoute(props: ParentProps) {
  const params = useParams<{ serverKey: string; id: string }>()
  const global = useGlobal()
  const serverKey = createMemo(() => parseServerKey(params.serverKey))
  const conn = createMemo(() => {
    const key = serverKey()
    if (!key) return
    return global.servers.list().find((item) => ServerConnection.key(item) === key)
  })

  return (
    <Show when={serverKey()} keyed fallback={<ErrorSurface error={new Error("Invalid server route")} />}>
      <ServerSDKProvider server={conn}>
        <PersonalUsageProvider>
          <ServerSyncProvider server={conn}>
            <GoalsProvider>
              <ForkUsageProvider>{props.children}</ForkUsageProvider>
            </GoalsProvider>
          </ServerSyncProvider>
        </PersonalUsageProvider>
      </ServerSDKProvider>
    </Show>
  )
}

export function TargetSessionRouteController() {
  return (
    <TargetServerRoute>
      <TargetSessionRouteContent />
    </TargetServerRoute>
  )
}

export function LegacyTargetSessionRouteController() {
  const params = useParams<{ serverKey: string; id: string }>()
  const serverKey = createMemo(() => parseServerKey(params.serverKey))
  return (
    <TargetServerRoute>
      <Show when={serverKey()} keyed fallback={<ErrorSurface error={new Error("Invalid server route")} />}>
        {(key) => (
          <SessionRouteErrorBoundary sessionID={params.id} serverKey={key}>
            <LegacyTargetSessionRedirect />
          </SessionRouteErrorBoundary>
        )}
      </Show>
    </TargetServerRoute>
  )
}

function LegacyTargetSessionRedirect() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const sync = useServerSync()
  const current = createSessionLineage(
    () => params.id,
    () => sync().session.lineage,
  )

  createEffect(() => {
    const directory = current()?.session.directory
    if (!directory) return
    navigate(legacySessionHref(directory, params.id), { replace: true })
  })

  return null
}

export function GroupTabRouteController() {
  const params = useParams<{ serverKey: string; groupId: string; sessionId?: string }>()
  const global = useGlobal()
  const serverKey = createMemo(() => parseServerKey(params.serverKey))
  const conn = createMemo(() => {
    const key = serverKey()
    if (!key) return
    return global.servers.list().find((item) => ServerConnection.key(item) === key)
  })

  return (
    <Show when={serverKey()} keyed fallback={<ErrorSurface error={new Error("Invalid group route")} />}>
      <ServerSDKProvider server={conn}>
        <PersonalUsageProvider>
          <ServerSyncProvider server={conn}>
            <ForkUsageProvider>
              <Suspense fallback={<RoutePlaceholder />}>
                <GroupTabPage />
              </Suspense>
            </ForkUsageProvider>
          </ServerSyncProvider>
        </PersonalUsageProvider>
      </ServerSDKProvider>
    </Show>
  )
}

export function NewLayoutLegacySessionRedirectController() {
  const server = useServer()
  const tabs = useTabs()
  const params = useParams<{ id: string }>()

  return (
    <Navigate
      href={sessionHref(
        legacySessionServer(
          tabs.store.filter((item) => item.type === "session"),
          params.id,
          server.key,
        ),
        params.id,
      )}
    />
  )
}
