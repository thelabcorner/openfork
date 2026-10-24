import { splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"
import type { AccountModelItem, ModelGroup } from "@opencode-ai/schema/model-select/accounts"
import type { Strategy } from "@opencode-ai/schema/model-select/provider-route-intent"

export const isHostedAccountProvider = (providerID: string) => providerID === "opencode" || providerID === "opencode-go"

const HOSTED_ROUTING_STRATEGIES = ["adaptive", "round-robin"] as const satisfies readonly Strategy[]

/**
 * Routing strategies only choose among live accounts. With zero or one
 * account/key there is nothing to route across, so offering them is a no-op.
 * Uses the live roster count, never catalog variants.
 */
export const hostedAccountRoutingStrategies = (providerID: string, supportsRouteIntent: boolean, accountCount: number) =>
  isHostedAccountProvider(providerID) && supportsRouteIntent && accountCount > 1 ? HOSTED_ROUTING_STRATEGIES : undefined

/**
 * Hosted Zen/Go routing choices are session intent, never a model identity.
 * A model-only configuration field (Goal agent, scheduled task, settings)
 * cannot persist that intent and must not expose controls that silently
 * discard a selection. Catalog-qualified providers, such as WorkBuddy,
 * remain selectable via real model IDs even in model-only fields.
 */
export const showAccountSubmenu = (providerID: string, accountCount: number, supportsRouteIntent = true) =>
  isHostedAccountProvider(providerID) ? supportsRouteIntent : providerID === "workbuddy" ? accountCount > 0 : accountCount > 1

/** O(accounts) once per quota update; account-list rows use the O(1) revision. */
export function hostedAccountRosterRevision(accounts: ReadonlyMap<string, { label: string }>) {
  // Account discovery order is not an account-identity change. Avoid
  // remounting a submenu (and moving the active pointer target) on poll reorder.
  return JSON.stringify(
    Array.from(accounts, ([id, info]) => [id, info.label] as const).sort(([a], [b]) => a.localeCompare(b)),
  )
}

/** Display-only account rows: never mint model IDs to represent routing choices. */
export function hostedAccountDisplayVariants<T extends { id: string; name: string }>(
  model: T,
  accounts: ReadonlyMap<string, { label: string }>,
) {
  return Array.from(accounts, ([accountID, info]) => ({
    accountID,
    item: { ...model, name: info.label ? `${model.name} (${info.label})` : model.name },
  })).sort((a, b) => a.accountID.localeCompare(b.accountID))
}

/** Live hosted account rows may never fall back to cached catalog variants. */
export function hostedAccountDisplayGroup<T extends AccountModelItem>(
  model: T,
  accounts: ReadonlyMap<string, { label: string }>,
  catalogGroup?: ModelGroup<T>,
): ModelGroup<T> {
  // Search can return a legacy `model@account` catalog variant rather than
  // the bare model. Use the group's account-neutral catalog item where one
  // exists, and always strip any legacy account suffix from the display-only
  // canonical identity. Never use the group's account *variants* as roster.
  const requestedBase = splitModelIDForProvider(model.id, model.provider.id).baseModelID
  const belongsToModel =
    catalogGroup?.key === `${model.provider.id}:${requestedBase}` &&
    catalogGroup.canonical.provider.id === model.provider.id &&
    splitModelIDForProvider(catalogGroup.canonical.id, model.provider.id).baseModelID === requestedBase
  const compatibleGroup = belongsToModel ? catalogGroup : undefined
  const source = compatibleGroup?.auto ?? compatibleGroup?.canonical ?? model
  const baseID = splitModelIDForProvider(source.id, source.provider.id).baseModelID
  const canonical = baseID === source.id && (!compatibleGroup || source.name === compatibleGroup.label)
    ? source
    : { ...source, id: baseID, name: compatibleGroup?.label ?? source.name }
  return {
    key: `${canonical.provider.id}:${canonical.id}`,
    canonical,
    label: canonical.name,
    auto: canonical,
    variants: hostedAccountDisplayVariants(canonical, accounts),
  }
}

/** A pointer click must revalidate a live row, not trust a stale submenu snapshot. */
export function hostedAccountStillVisible(
  accountID: string,
  variants: readonly { readonly accountID: string }[],
): boolean {
  return variants.some((entry) => entry.accountID === accountID)
}

/** Hosted Zen/Go account selection is a routing intent, not a catalog model variant. */
export function pinnedHostedAccount(
  model: { id: string; provider: { id: string } },
  accountID: string,
) {
  const providerID = model.provider.id
  if (!isHostedAccountProvider(providerID)) return
  if (!accountID || accountID.length > 256 || accountID.trim() !== accountID) return
  const base = splitModelIDForProvider(model.id, providerID).baseModelID
  if (!base) return
  return {
    providerID,
    modelID: base,
    routeIntent: { kind: "account", accountID, pin: "hard" } as const,
  }
}
