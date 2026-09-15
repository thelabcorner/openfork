import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { createMemo, createResource } from "solid-js"

function showRequestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

/**
 * Server-list operations shared by Home and the server-management dialog.
 * Keep this module presentation-free: Home needs default/remove behavior on
 * startup, but should not pull the entire server dialog component graph with it.
 */
export function useServerManagementState() {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const tabs = useTabs()
  const [defaultKey, defaultUrlActions] = createResource(
    async () => {
      try {
        return (await platform.getDefaultServer?.()) ?? null
      } catch (err) {
        showRequestError(language, err)
        return null
      }
    },
    { initialValue: null },
  )

  const canDefault = createMemo(() => !!platform.getDefaultServer && !!platform.setDefaultServer)
  const setDefault = async (key: ServerConnection.Key | null) => {
    try {
      await platform.setDefaultServer?.(key)
      defaultUrlActions.mutate(key)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  const remove = async (key: ServerConnection.Key) => {
    try {
      if (key.startsWith("wsl:")) await platform.wslServers?.removeServer(key)
      tabs.removeServer(key)
      server.remove(key)
      if ((await platform.getDefaultServer?.()) === key) await setDefault(null)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return {
    defaultKey: () => defaultKey.latest,
    canDefault,
    setDefault,
    remove,
  }
}
