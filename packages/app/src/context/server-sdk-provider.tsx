import type { Accessor, ParentProps } from "solid-js"
import { createMemo } from "solid-js"
import { useGlobal } from "./global"
import { useLanguage } from "./language"
import { ServerConnection, useServer } from "./server"
import { ServerSDKValueProvider, type ServerSDK } from "./server-sdk"

/**
 * Resolves the SDK from app-level contexts outside the SDK module itself.
 * Keeping this adapter separate prevents global.tsx and server-sdk.tsx from
 * importing each other through their provider initialization paths.
 */
export function ServerSDKProvider(props: ParentProps<{ server?: Accessor<ServerConnection.Any | undefined> }>) {
  const global = useGlobal()
  const language = useLanguage()
  const server = useServer()

  const sdk = createMemo<ServerSDK>(() => {
    const connection = props.server?.() ?? server.current
    if (!connection) throw new Error(language.t("error.serverSDK.noServerAvailable"))
    return global.ensureServerCtx(connection).sdk
  })

  return <ServerSDKValueProvider value={sdk}>{props.children}</ServerSDKValueProvider>
}
