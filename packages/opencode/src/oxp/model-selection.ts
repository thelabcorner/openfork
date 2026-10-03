import {
  providerModelID,
  splitModelIDForProvider,
} from "@opencode-ai/schema/model-select/account-identity"
import { multiAccountProvider } from "@opencode-ai/schema/model-select/multi-account-providers"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { OxpError } from "./error"
import { OxpRouteIntent } from "./route-intent"

export type AccountMode = OxpRouteIntent.AccountMode

export interface Materialized {
  readonly selection: OxpRouteIntent.RouteSelection
  /**
   * Provider-runtime model id. This may contain an account suffix because some
   * existing provider adapters still use that as their internal routing ABI.
   * It must never be surfaced as the OXP modelId contract.
   */
  readonly providerModelID: string
  readonly accountMode: AccountMode
  /**
   * Canonical migration-window route intent. Intent only: this is not a bound
   * route, not a lease, and not credential resolution, all of which stay with
   * the routing owner.
   */
  readonly routeIntent: ProviderRouteIntent.Info
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

function canonical(input: OxpRouteIntent.RouteSelection) {
  const providerID = trimmed(input.providerID, "providerID")
  const modelID = trimmed(input.modelID, "modelID")
  const split = splitModelIDForProvider(modelID, providerID)
  if (split.accountID) {
    throw invalid("OXP modelID must be account-neutral; use accountID for explicit provider-account selection")
  }

  const accountID = input.accountID ? trimmed(input.accountID, "accountID") : undefined
  const variant = input.variant ? trimmed(input.variant, "variant") : undefined
  const routeIntent = OxpRouteIntent.normalize({
    routeIntent: input.routeIntent,
    legacyAccountID: accountID,
  })
  if (OxpRouteIntent.accountRouteID(routeIntent) && !multiAccountProvider(providerID)) {
    throw invalid(`Provider ${providerID} does not expose first-class account selection`)
  }

  return {
    selection: Object.freeze({
      providerID,
      modelID,
      ...(accountID ? { accountID } : {}),
      ...(variant ? { variant } : {}),
      ...(input.routeIntent ? { routeIntent: input.routeIntent } : {}),
    }),
    routeIntent,
  }
}

/**
 * Normalize an externally supplied OXP selection without consulting provider
 * runtime state. Account-qualified model ids are intentionally rejected: OXP's
 * public contract is provider + model + account + variant, never an encoded
 * model string whose suffix downstream heuristics must rediscover.
 *
 * An explicit route intent is carried through once it is proven consistent with
 * the legacy account field, so an intentional Public selection cannot be
 * silently downgraded to automatic routing. A conflicting intent/account pair
 * fails closed instead of resolving to either one.
 */
export function normalize(input: OxpRouteIntent.RouteSelection): OxpRouteIntent.RouteSelection {
  return canonical(input).selection
}

/**
 * Lower OXP's first-class model/account selection into the provider adapter's
 * current model-id ABI. The lowering is intentionally isolated here so callers,
 * prompts, Session metadata and provider routers never need to invent account
 * suffixes themselves.
 *
 * All route classes retain an account-neutral provider model id here. The
 * canonical routeIntent remains the authority carried downstream to
 * SessionPrompt/P5A, where Public/account are durably bound before provider
 * transport materialization. This layer never chooses a credential.
 */
export function materialize(input: OxpRouteIntent.RouteSelection): Materialized {
  const { selection, routeIntent } = canonical(input)
  const accountID = OxpRouteIntent.accountRouteID(routeIntent)
  if (accountID) {
    const descriptor = multiAccountProvider(selection.providerID)
    if (!accountID.startsWith(descriptor.accountPrefix) || accountID.includes("@")) {
      throw invalid(
        "OXP accountID must be resolved to the provider's stable internal account id before materialization",
      )
    }
  }
  return Object.freeze({
    selection,
    providerModelID: providerModelID(selection.modelID, selection.providerID, accountID),
    accountMode: OxpRouteIntent.accountMode(routeIntent),
    routeIntent,
  })
}

/**
 * Project a provider/runtime model id back into OXP's first-class shape. This is
 * used by selection/status surfaces so an existing account-qualified native
 * Session never leaks the provider's encoded transport string as OXP modelId.
 *
 * A bound model id proves which account is selected, never which route class the
 * caller asked for, so an explicit intent is carried only when the caller
 * supplies it. Public is never inferred from a missing account suffix.
 */
export function fromProviderModel(
  providerID: string,
  providerModelID: string,
  variant?: string,
  accountID?: string,
  routeIntent?: ProviderRouteIntent.Info,
): OxpRouteIntent.RouteSelection {
  const provider = trimmed(providerID, "providerID")
  const model = trimmed(providerModelID, "modelID")
  const split = splitModelIDForProvider(model, provider)
  return normalize({
    providerID: provider,
    modelID: split.baseModelID,
    ...(accountID ?? split.accountID ? { accountID: accountID ?? split.accountID } : {}),
    ...(variant ? { variant } : {}),
    ...(routeIntent ? { routeIntent } : {}),
  })
}

export * as OxpModelSelection from "./model-selection"
