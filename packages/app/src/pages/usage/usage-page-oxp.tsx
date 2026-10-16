import { createMemo, createResource, onCleanup } from "solid-js"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { OxpAttributionPanel } from "@/pages/oxp/oxp-attribution-panel"
import { oxpLocalDonorForModel, oxpLocalDonorProfile } from "@/pages/oxp/oxp-local-donor"
import { OXP_API_MODELS } from "@/pages/oxp/oxp-api-equivalent"
import type { OxpWorkloadProfile } from "@/pages/oxp/oxp-workload-panel"
import type { OxpAttributionSnapshot } from "@opencode-ai/sdk/v2/client"

export function UsagePageOxp(props: {
  active: boolean
  since: number
  until: number
  refreshTick: number
  donorRows?: UsageSummaryResponse["models"]
}) {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  // Reuse the Usage-owned durable settlement aggregate. This computation
  // lives in the lazy OXP tab, not the default Usage first-paint path.
  const donor = createMemo(() => oxpLocalDonorProfile(props.donorRows ?? []))
  const modelDonors = createMemo(() => Object.fromEntries(
    OXP_API_MODELS.flatMap((model) => {
      const profile = oxpLocalDonorForModel(props.donorRows ?? [], model.id)
      return profile ? [[model.id, profile] as const] : []
    }),
  ))
  let controller: AbortController | undefined
  const [snapshot, actions] = createResource(
    () =>
      props.active
        ? {
            scope: serverSDK().scope,
            since: props.since,
            until: props.until,
            refreshTick: props.refreshTick,
          }
        : undefined,
    async (input) => {
      controller?.abort()
      const current = new AbortController()
      controller = current
      try {
        // Workload is an opt-in, bounded Tier-0 read. The endpoint refuses
        // intervals longer than 90 days; the OXP context estimate still works.
        const includeWorkload = input.until - input.since <= 90 * 24 * 60 * 60 * 1000
        const query = {
          since: String(input.since),
          until: String(input.until),
          ...(includeWorkload ? { includeWorkload: "true" as const } : {}),
        }
        // This additive opt-in query is already declared in the server's
        // HttpApi; go through the authenticated SDK transport so we don't lose
        // includeWorkload in an older generated parameter allowlist.
        const response = await serverSDK().client.analyticsProjection(
          "/global/oxp/attribution", query, { signal: current.signal },
        )
        return response.data as OxpAttributionSnapshot & { workload?: OxpWorkloadProfile }
      } catch (error) {
        // Resource source changes and tab unmounts are ordinary cancellations,
        // not user-visible errors. Solid discards the superseded response.
        if (current.signal.aborted) return undefined
        throw error
      } finally {
        if (controller === current) controller = undefined
      }
    },
  )
  onCleanup(() => controller?.abort())

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--usage-line)] bg-[var(--usage-panel)]">
      <OxpAttributionPanel
        snapshot={snapshot.error ? undefined : snapshot()}
        loading={snapshot.loading}
        error={snapshot.error}
        onRefresh={() => void actions.refetch()}
        title={language.t("usage.nav.oxp")}
        donor={donor()}
        modelDonors={modelDonors()}
      />
    </div>
  )
}