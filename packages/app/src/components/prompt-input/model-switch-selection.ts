import { splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"
import type { ModelIdentity } from "./model-mismatch"

/**
 * An in-flight model switch targets the picker selection, never an ephemeral
 * prompt-draft model override. Model/variant are resolved by the same local
 * model state the picker displays; it already excludes unsupported variants.
 */
export function modelSwitchSelection(
  picked: { id: string; provider: { id: string } } | undefined,
  variant: string | undefined,
): ModelIdentity | undefined {
  if (!picked) return
  const providerID = picked.provider.id
  const account = splitModelIDForProvider(picked.id, providerID)
  return {
    providerID,
    modelID: account.baseModelID,
    ...(account.accountID ? { accountID: account.accountID } : {}),
    ...(variant && variant !== "default" ? { variant } : {}),
  }
}
