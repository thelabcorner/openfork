import { onCleanup, onMount } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { reconcilePwaPush, refreshPwaPushState } from "@/utils/pwa-push"

/** No-UI bridge that keeps the browser subscription and server registration in sync. */
export function PwaPushRuntime() {
  const sdk = useServerSDK()

  const reconcile = async () => {
    const state = await refreshPwaPushState()
    if (state === "subscribed") await reconcilePwaPush(sdk().client)
  }

  const onVisibility = () => {
    if (document.visibilityState === "visible") void reconcile()
  }

  onMount(() => {
    void reconcile()
    document.addEventListener("visibilitychange", onVisibility)
  })
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibility))
  return null
}
