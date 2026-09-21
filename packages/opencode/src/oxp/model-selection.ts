import {
  providerModelID,
  splitModelIDForProvider,
} from "@opencode-ai/schema/model-select/account-identity"
import { multiAccountProvider } from "@opencode-ai/schema/model-select/multi-account-providers"
import { OxpError } from "./error"
import { OxpSchema } from "./schema"

export type AccountMode = "automatic" | "explicit"

export interface Materialized {
  readonly selection: OxpSchema.ModelSelection
  /**
   * Provider-runtime model id. This may contain an account suffix because some
   * existing provider adapters still use that as their internal routing ABI.
   * It must never be surfaced as the OXP modelId contract.
   */
  readonly providerModelID: string
  readonly accountMode: AccountMode
}

const invalid = (detail: string) => new OxpError.InvalidArgument({ detail })

function trimmed(value: string, field: string) {
  const next = value.trim()
  if (!next) throw invalid(`${field} must not be empty`)
  if (next.length > 256) throw invalid(`${field} is too long`)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(next)) throw invalid(`${field} contains a control character`)
  return next
}

/**
 * Normalize an externally supplied OXP selection without consulting provider
 * runtime state. Account-qualified model ids are intentionally rejected: OXP's
 * public contract is provider + model + account + variant, never an encoded
 * model string whose suffix downstream heuristics must rediscover.
 */
export function normalize(input: OxpSchema.ModelSelection): OxpSchema.ModelSelection {
  const providerID = trimmed(input.providerID, "providerID")
  const modelID = trimmed(input.modelID, "modelID")
  const split = splitModelIDForProvider(modelID, providerID)
  if (split.accountID) {
    throw invalid("OXP modelID must be account-neutral; use accountID for explicit provider-account selection")
  }

  const accountID = input.accountID ? trimmed(input.accountID, "accountID") : undefined
  const variant = input.variant ? trimmed(input.variant, "variant") : undefined
  if (accountID) {
    const descriptor = multiAccountProvider(providerID)
    if (!descriptor) {
      throw invalid(`Provider ${providerID} does not expose first-class account selection`)
    }
    if (!accountID.startsWith(descriptor.accountPrefix) || accountID.includes("@")) {
      throw invalid(`accountID does not belong to provider ${providerID}`)
    }
  }

  return Object.freeze({
    providerID,
    modelID,
    ...(accountID ? { accountID } : {}),
    ...(variant ? { variant } : {}),
  })
}

/**
 * Lower OXP's first-class model/account selection into the provider adapter's
 * current model-id ABI. The lowering is intentionally isolated here so callers,
 * prompts, Session metadata and provider routers never need to invent account
 * suffixes themselves.
 */
export function materialize(input: OxpSchema.ModelSelection): Materialized {
  const selection = normalize(input)
  return Object.freeze({
    selection,
    providerModelID: providerModelID(selection.modelID, selection.providerID, selection.accountID),
    accountMode: selection.accountID ? "explicit" : "automatic",
  })
}

/**
 * Project a provider/runtime model id back into OXP's first-class shape. This is
 * used by selection/status surfaces so an existing account-qualified native
 * Session never leaks the provider's encoded transport string as OXP modelId.
 */
export function fromProviderModel(
  providerID: string,
  providerModelID: string,
  variant?: string,
  accountID?: string,
): OxpSchema.ModelSelection {
  const provider = trimmed(providerID, "providerID")
  const model = trimmed(providerModelID, "modelID")
  const split = splitModelIDForProvider(model, provider)
  return normalize({
    providerID: provider,
    modelID: split.baseModelID,
    ...(accountID ?? split.accountID ? { accountID: accountID ?? split.accountID } : {}),
    ...(variant ? { variant } : {}),
  })
}

export * as OxpModelSelection from "./model-selection"
