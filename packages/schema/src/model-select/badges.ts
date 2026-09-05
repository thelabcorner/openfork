// Unlimited-tier detection shared by model pickers: the models.dev entry
// advertises "(Unlimited)" in its display name and publishes $0 input cost.
// Paid providers marketing an "unlimited" plan do not qualify.
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
