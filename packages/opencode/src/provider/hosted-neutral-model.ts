import { splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"
import type { Info, Model } from "./provider"

/** Scan only the rare candidate-alias projection, never each model request. */
function containsTransportAuthority(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object") return false
  // Reject cyclic/opaque oversized configuration rather than blessing a
  // partially inspected bearer override. Model options should be shallow.
  if (depth > 8) return true
  return Object.entries(value).some(([key, nested]) =>
    /(?:^|[-_])(?:api[-_]?key|authorization|auth|token|secret|password|bearer|fetch|base[-_]?url|endpoint|proxy|transport)$/i.test(key) ||
    containsTransportAuthority(nested, depth + 1),
  )
}

/**
 * Recover account-neutral *catalog metadata* from legacy hosted aliases only
 * when every alias explicitly advertises the same unsuffixed API identity and
 * agrees on its execution-relevant metadata.
 *
 * This does NOT authorize a provider route, credential, or upstream Public
 * transport. V1 ProviderRoute still validates the selected account's actual
 * capabilities and materializes exactly that lease at inference time.
 *
 * Never guess a base model by stripping arbitrary @ suffixes, choosing an
 * arbitrary account's API ID, or combining contradictory account metadata.
 */
export function projectHostedNeutralModels(
  provider: Info,
  allowed: (baseModelID: string) => boolean = () => true,
): Info {
  if (provider.id !== "opencode" && provider.id !== "opencode-go") return provider

  const groups = new Map<string, Model[]>()
  for (const [key, model] of Object.entries(provider.models)) {
    const parts = splitModelIDForProvider(key, provider.id)
    if (!parts.accountID || !parts.baseModelID) continue
    const group = groups.get(parts.baseModelID) ?? []
    group.push(model)
    groups.set(parts.baseModelID, group)
  }

  const projected: Record<string, Model> = {}
  for (const [baseModelID, candidates] of groups) {
    if (Object.hasOwn(provider.models, baseModelID) || !allowed(baseModelID)) continue
    // An account-backed fallback must never relay its committed bearer to a
    // URL chosen by account-qualified catalog metadata. This is the exact
    // upstream-operated Zen/Go host contract, NOT a generic custom-provider
    // alias compatibility rule.
    const hostedURL = provider.id === "opencode-go"
      ? "https://opencode.ai/zen/go/v1"
      : "https://opencode.ai/zen/v1"
    // Reject the ENTIRE group if any alias lacks an explicit underlying API
    // witness. Never use one known alias to bless a conflicting sibling.
    if (candidates.some((model) =>
      model.api.id !== baseModelID || model.api.url !== hostedURL || model.providerID !== provider.id ||
      splitModelIDForProvider(model.id, provider.id).baseModelID !== baseModelID
    )) continue
    // Account-scoped metadata must not become a generic routable model with
    // an embedded bearer/transport override. Real authorization belongs to
    // the exact bound account lease, never a projected catalog alias.
    if (candidates.some((model) =>
      containsTransportAuthority(model.options) ||
      containsTransportAuthority(model.headers)
    )) continue
    // A mismatch may represent per-account capabilities/pricing. Refusing
    // the projection is safer than giving the picker false guarantees.
    const identity = (model: Model) => JSON.stringify({
      api: model.api,
      primitive: model.primitive,
      status: model.status,
      capabilities: model.capabilities,
      limit: model.limit,
      cost: model.cost,
      options: model.options,
      headers: model.headers,
      variants: model.variants,
      family: model.family,
      release_date: model.release_date,
    })
    if (candidates.length === 0 || candidates.some((model) => identity(model) !== identity(candidates[0]!)))
      continue
    const source = candidates[0]!
    if (source.status === "deprecated" || source.status === "alpha") continue
    projected[baseModelID] = {
      ...source,
      id: baseModelID as Model["id"],
      // Qualified display labels can include account-specific identity.
      // Without a trusted unqualified name, the canonical ID is truthful.
      name: baseModelID,
    }
  }

  return Object.keys(projected).length
    ? { ...provider, models: { ...provider.models, ...projected } }
    : provider
}
