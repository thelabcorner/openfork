/** Cap speculative endpoint lookups: connected catalogs can contain hundreds of models. */
export const MAX_OPENROUTER_PREWARM_MODELS = 24

type ModelRef = { readonly providerID: string; readonly modelID: string }
type Preference = ModelRef & { readonly favorite?: boolean; readonly visibility?: "show" | "hide" }

/** Recent choices, explicit favorites, and provider pins outrank catalog discovery.
 * Catalog iteration is lazy, so the common case does not scan a large provider catalog.
 * Foreground endpoint resolution is deliberately unlimited by this background budget. */
export function selectOpenRouterPrewarmModels(
  recent: readonly ModelRef[],
  user: readonly Preference[],
  pins: Readonly<Record<string, string | undefined>> | undefined,
  catalog: () => Iterable<string>,
  limit = MAX_OPENROUTER_PREWARM_MODELS,
): string[] {
  const chosen: string[] = []
  const seen = new Set<string>()
  const cap = Math.max(0, Math.floor(limit))
  const push = (modelID: string | undefined) => {
    if (!modelID || seen.has(modelID) || chosen.length >= cap) return
    seen.add(modelID)
    chosen.push(modelID)
  }
  for (const item of recent) {
    if (chosen.length >= cap) return chosen
    if (item.providerID === "openrouter") push(item.modelID)
  }
  for (const item of user) {
    if (chosen.length >= cap) return chosen
    if (item.providerID === "openrouter" && (item.favorite || item.visibility === "show")) push(item.modelID)
  }
  for (const [key, value] of Object.entries(pins ?? {})) {
    if (chosen.length >= cap) return chosen
    if (value && key.startsWith("openrouter:")) push(key.slice("openrouter:".length))
  }
  if (chosen.length >= cap) return chosen
  for (const modelID of catalog()) {
    if (chosen.length >= cap) break
    push(modelID)
  }
  return chosen
}