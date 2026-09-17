// Free-tier *taxonomy* — "is this model free?" — shared by model pickers and
// the yield ranking. Deliberately distinct from the OpenRouter FUT quota
// classifier (`isOpenRouterFreeModel` in the selector, `isFreeModel` in
// openrouter/free-usage): a stealth/preview model is free but is NOT subject to
// the daily free-model quota, so it must not render a quota bar.
//
// `isUnlimitedModel` covers the models.dev "(Unlimited)" entries: the display
// name advertises it and the catalog publishes $0 input cost. Paid providers
// marketing an "unlimited" plan do not qualify.
export function isUnlimitedModel(model: { id: string; name?: string; cost?: { input?: number } | undefined }): boolean {
  const text = `${model.name ?? ""} ${model.id}`.toLowerCase()
  if (!text.includes("unlimited")) return false
  return model.cost?.input === 0
}

// Strips the "(Unlimited)" marketing suffix — it renders as a badge instead.
export function stripUnlimitedSuffix(name: string): string {
  return name.replace(/\s*\(unlimited\)\s*$/i, "").trim()
}

// True when the catalog publishes at least one nonzero token rate. Absent
// pricing (e.g. image-gen models, which have no per-token rates anywhere)
// collapses to zeros by the time it reaches the client; rendering "$0.00"
// for those reads as free when it just means unpriced. The model tooltip
// applies the same all-zero guard before showing its cost table.
export function hasPublishedPricing(cost: { input?: number; output?: number } | undefined): boolean {
  if (!cost) return false
  return (cost.input ?? 0) > 0 || (cost.output ?? 0) > 0
}

/**
 * Free-tier classification shared by the badge predicates and the yield
 * ranking, so a model cannot be tagged "Free" in one surface and sorted as
 * paid in another.
 *
 * A free tier is a *published* property of the provider's catalog, not merely
 * an all-zero price: most providers leave pricing absent (collapsed to zeros on
 * the wire) for models this app cannot price. Only providers whose zero is
 * meaningful participate.
 *
 * - OpenRouter: the `:free` suffix and the synthetic `openrouter/free` router.
 *   The `stealth/` namespace is OpenRouter's free preview tier — a stealth
 *   model that publishes an all-zero price is free even though it ships
 *   without the `:free` suffix (`stealth/union-alpha`). A stealth model that
 *   publishes real rates (`kilo`'s `stealth/claude-opus-*`) is not.
 *   Meta-routers under the `openrouter/` namespace (`auto`, `pareto-code`, …)
 *   are excluded: their price is variable, not free.
 * - OpenCode Zen (`opencode`) and OpenCode Go (`opencode-go`) publish real
 *   rates for every paid model, so an all-zero entry is the free tier.
 *
 * Deliberately NOT a general "zero price means free" rule: on OpenRouter an
 * all-zero non-stealth entry is an unpriced model that must borrow its paid
 * sibling's price (`buildPricingFallbackMap`), not be reclassified as free.
 * Returns `undefined` for paid models. Capacity is unknown from the catalog
 * alone; the yield layer that owns the OpenRouter FUT report upgrades it to
 * `free-limited-known`.
 */
export function freeTierOf(model: {
  id: string
  provider: { id: string }
  cost?: { input?: number; output?: number }
}): "free-limited-unknown" | undefined {
  if (model.provider.id === "openrouter") {
    if (model.id === "openrouter/free" || model.id.endsWith(":free")) return "free-limited-unknown"
    if (model.id.startsWith("openrouter/")) return undefined
    if (model.id.startsWith("stealth/") && model.cost?.input === 0 && model.cost?.output === 0) {
      return "free-limited-unknown"
    }
    return undefined
  }
  if (model.provider.id === "opencode" || model.provider.id === "opencode-go") {
    return hasPublishedPricing(model.cost) ? undefined : "free-limited-unknown"
  }
  return undefined
}
