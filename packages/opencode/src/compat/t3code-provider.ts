import { ModelV2 } from "@opencode-ai/core/model"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import { splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"
import type { AccountModelProjection, Info } from "@/provider/provider"
import { t3CodeAccountModelID } from "./t3code"

export interface T3CodeProviderProjection {
  readonly providers: Record<ProviderV2.ID, Info>
  readonly connected: ReadonlySet<string>
}

export function filterT3CodeAccountModels(
  accountModels: readonly AccountModelProjection[],
  input: {
    readonly enabledProviders?: readonly string[]
    readonly disabledProviders?: readonly string[]
  },
): readonly AccountModelProjection[] {
  const disabled = new Set(input.disabledProviders ?? [])
  const enabled = input.enabledProviders ? new Set(input.enabledProviders) : undefined
  return accountModels.filter(
    (entry) =>
      (enabled ? enabled.has(entry.provider.id) : true) &&
      !disabled.has(entry.provider.id),
  )
}

function alreadyProjectsAccount(
  provider: Info | undefined,
  baseModelID: string,
  accountID: string,
): boolean {
  if (!provider) return false
  return Object.keys(provider.models).some((modelID) => {
    const split = splitModelIDForProvider(modelID, provider.id)
    return split.baseModelID === baseModelID && split.accountID === accountID
  })
}

/**
 * Add the legacy one-row-per-(model, account) view T3 expects without mutating
 * OpenFork's canonical account-neutral provider catalog.
 */
export function projectT3CodeAccountModels(
  providers: Record<ProviderV2.ID, Info>,
  accountModels: readonly AccountModelProjection[],
): T3CodeProviderProjection {
  const output = Object.fromEntries(
    Object.entries(providers).map(([id, provider]) => [
      id,
      { ...provider, models: { ...provider.models } },
    ]),
  ) as Record<ProviderV2.ID, Info>
  const connected = new Set<string>()

  for (const entry of accountModels) {
    const providerID = entry.provider.id
    let target = output[providerID]
    if (!target) {
      target = { ...entry.provider, models: {} }
      output[providerID] = target
    }
    // Deduplicate by physical account identity, never by provider family. A
    // provider can simultaneously expose provider-native @wb-/@zen- aliases and
    // distinct Console-backed accounts. Only an existing alias for this exact
    // (provider, base model, stable account) makes the compatibility row redundant.
    if (alreadyProjectsAccount(target, entry.model.id, entry.accountID)) {
      connected.add(providerID)
      continue
    }
    const aliasID = ModelV2.ID.make(t3CodeAccountModelID(entry.model.id, entry.accountID))
    if (target.models[aliasID]) {
      connected.add(providerID)
      continue
    }
    const label = entry.accountLabel.trim() || entry.accountID
    target.models[aliasID] = {
      ...entry.model,
      id: aliasID,
      providerID,
      name: `${entry.model.name} (${label})`,
    }
    connected.add(providerID)
  }

  return { providers: output, connected }
}