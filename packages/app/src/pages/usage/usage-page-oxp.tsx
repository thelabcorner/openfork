import { createResource } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { OxpAttributionPanel } from "@/pages/oxp/oxp-attribution-panel"

export function UsagePageOxp(props: {
  active: boolean
  since: number
  until: number
  refreshTick: number
}) {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const [snapshot, actions] = createResource(
    () =>
      props.active
        ? {
            since: props.since,
            until: props.until,
            refreshTick: props.refreshTick,
          }
        : undefined,
    async (input) => {
      const response = await serverSDK().client.global.oxpAttribution(
        {
          since: String(input.since),
          until: String(input.until),
        },
        { throwOnError: true },
      )
      return response.data
    },
  )

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--usage-line)] bg-[var(--usage-panel)]">
      <OxpAttributionPanel
        snapshot={snapshot()}
        loading={snapshot.loading}
        error={snapshot.error}
        onRefresh={() => void actions.refetch()}
        title={language.t("usage.nav.oxp")}
      />
    </div>
  )
}