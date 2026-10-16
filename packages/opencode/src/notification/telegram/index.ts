import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "@/auth"
import { Quota } from "@/quota/quota"
import { TelegramNotificationHub, type TelegramConnectionStatus } from "./hub"
import { QuotaNotificationSource, type QuotaNotificationSettings } from "./quota-source"
import type { TelegramQuotaSubscription } from "@/quota/telegram-reset-policy"
import type { ResetAgendaResult } from "@/quota/schema"

export interface TelegramNotificationService {
  readonly hub: TelegramNotificationHub
  /** Each notification source owns its configuration; Telegram owns transport. */
  readonly quota: {
    status: () => QuotaNotificationSettings
    update: (input: { enabled: boolean; subscriptions: readonly TelegramQuotaSubscription[] }) =>
      Promise<QuotaNotificationSettings>
  }
  readonly status: () => Promise<TelegramConnectionStatus>
}

export class Service extends Context.Service<Service, TelegramNotificationService>()("@openfork/Telegram") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const quota = yield* Quota.Service
    const quotaSource = new QuotaNotificationSource(async (from, to, providerIds): Promise<ResetAgendaResult> => {
      const results: ResetAgendaResult[] = []
      // Bound per-provider reads. A 5h Go subscription does not authorize
      // probing unrelated quota adapters every five minutes.
      for (let i = 0; i < providerIds.length; i += 4) {
        const batch = await Promise.all(providerIds.slice(i, i + 4).map(async (providerID) => {
          try {
            return await Effect.runPromise(quota.resetsForProvider({ providerID, from, to }))
          } catch {
            return {
              from,
              to,
              generatedAt: Date.now(),
              occurrences: [],
              failures: [{ providerId: providerID, providerName: providerID, error: "Usage data unavailable" }],
            } satisfies ResetAgendaResult
          }
        }))
        results.push(...batch)
      }
      return {
        from,
        to,
        generatedAt: Date.now(),
        occurrences: results.flatMap((row) => row.occurrences),
        failures: results.flatMap((row) => row.failures),
      }
    })
    const hub = new TelegramNotificationHub(auth, [quotaSource])
    yield* Effect.promise(() => hub.initialize())
    return Service.of({
      hub,
      status: () => hub.status(),
      quota: {
        status: () => quotaSource.status(),
        update: async (input) => {
          const updated = await quotaSource.update(input)
          await hub.refresh()
          return updated
        },
      },
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Auth.node, Quota.node] })
