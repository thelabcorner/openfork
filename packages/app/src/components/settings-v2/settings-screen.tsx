import { Navigate, useSearchParams } from "@solidjs/router"
import { createMemo, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { SettingsRouteSurface } from "./dialog-settings-v2"

export function SettingsScreen() {
  const settings = useSettings()
  const global = useGlobal()
  const server = useServer()
  const [search] = useSearchParams<{ server?: string }>()
  const connection = createMemo(() => {
    const key = search.server
    if (!key) return server.current
    return global.servers.list().find((item) => ServerConnection.key(item) === key) ?? server.current
  })

  return (
    <Show when={settings.general.newLayoutDesigns()} fallback={<Navigate href="/" />}>
      <ServerSDKProvider server={connection}>
        <ServerSyncProvider server={connection}>
          <SettingsRouteSurface />
        </ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
  )
}
