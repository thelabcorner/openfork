export * as ScheduledTaskRouteIntent from "./route-intent"

import { ProviderRouteIntentRuntime } from "@opencode-ai/core/provider-route-intent"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { Effect } from "effect"

export type Error = ProviderRouteIntentRuntime.Error

/**
 * Normalize a persisted Scheduled Task action at the Tier-3 execution boundary.
 *
 * Absence remains absence so reuse/auto/existing Session policies can preserve
 * an existing healthy binding. Legacy model.accountID remains
 * backward-compatible and lowers to an explicit hard account intent. Explicit
 * Public/account intent is carried unchanged inside SyntheticExecution; the
 * SessionPrompt/P5A boundary owns the later durable ProviderRoute bind/CAS and
 * exact transport materialization.
 */
export const normalizeAction = Effect.fn("ScheduledTaskRouteIntent.normalizeAction")(function* (
  action: ScheduledTask.Action,
) {
  const hasPersistedIntent = action.routeIntent !== undefined || action.model?.accountID !== undefined
  const normalized = yield* ProviderRouteIntentRuntime.normalize({
    routeIntent: action.routeIntent,
    legacyAccountID: action.model?.accountID,
  })

  return hasPersistedIntent ? normalized : undefined
})

export function errorMessage(error: Error) {
  switch (error._tag) {
    case "ProviderRouteIntent.InvalidLegacyAccount":
      return `invalid legacy model.accountID: ${JSON.stringify(error.accountID)}`
    case "ProviderRouteIntent.Conflict":
      return error.routeKind === "account"
        ? `legacy model.accountID ${JSON.stringify(error.legacyAccountID)} conflicts with explicit account ${JSON.stringify(error.routeAccountID)}`
        : `legacy model.accountID ${JSON.stringify(error.legacyAccountID)} conflicts with explicit ${error.routeKind} route intent`
  }
}

/** Route intent carried inside the durable SessionInput SyntheticExecution envelope. */
export type DurableIntent = ProviderRouteIntent.Info | undefined
