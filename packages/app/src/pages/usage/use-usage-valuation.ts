import { createMemo, type Accessor } from "solid-js"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { useProviders } from "@/hooks/use-providers"
import {
  buildFuzzyPricingFallbackMap,
  buildPricingFallbackMap,
  mergePricingFallbacks,
  resolveEffectiveCost,
  type CheapnessModel,
  type EffectiveCost,
} from "@/utils/model-cost"
import { computeSubsidy, type SubsidyReport } from "@/utils/usage-subsidy"

/**
 * One shared valuation pass for the whole Usage page.
 *
 * Every section that needs to know what a model is worth — the free-value
 * panel, the model leaderboards, the model table's inferred $/M column — reads
 * from this instead of rebuilding its own fallback maps. Besides being O(n·m)
 * work done once instead of three times, it guarantees the page can never show
 * two different answers for the same model: the ranking, the price badge and
 * the subsidy figure are all derived from one set of maps.
 *
 * Fallback maps are built from the FULL live catalog rather than just the
 * models used in the current window, so a used-but-unpriced model can still
 * borrow a sibling's price even when that sibling was never used.
 *
 * The catalog here is every KNOWN provider (`providers.all()`), not just the
 * connected ones that `useModels` exposes. Two reasons, one of them a bug the
 * connected-only source was actively causing:
 *
 *  - Price inference works by borrowing a paid sibling's rate. Restricting the
 *    donor pool to connected providers means a free variant can only be valued
 *    if you happen to also have its paid counterpart's provider configured,
 *    which is precisely the case where you do NOT — the whole point is that
 *    you are getting for free something you would otherwise buy elsewhere.
 *  - `connected` is a directory-scoped notion. On this directory-agnostic
 *    route it can legitimately be empty, which silently zeroed every price on
 *    the page rather than degrading.
 *
 * Nothing here needs a model to be usable — only priced — so the wider list is
 * both safer and strictly more capable.
 */
export type UsageValuation = {
  catalog: Accessor<CheapnessModel[]>
  catalogByKey: Accessor<Map<string, CheapnessModel>>
  exactFallback: Accessor<ReturnType<typeof buildPricingFallbackMap> | undefined>
  fuzzyFallback: Accessor<ReturnType<typeof buildFuzzyPricingFallbackMap> | undefined>
  /** Exact-then-fuzzy merged map, in the shape `sortByCheapness` expects. */
  mergedFallback: Accessor<Map<string, import("@/utils/model-cost").ModelCost> | undefined>
  /** Free/subsidised usage valued against the merged fallback chain. */
  subsidy: Accessor<SubsidyReport>
  /** Best-known rate card for a usage row, with `borrowed` set when inferred. */
  effectiveCostFor: (providerID: string, modelID: string) => EffectiveCost
  /** Catalog display name for a usage row, falling back to the raw model id. */
  nameFor: (providerID: string, modelID: string) => string
  /** False while the provider catalog is empty — nothing can be priced, and
   * callers must say so rather than render a confident $0. */
  catalogReady: Accessor<boolean>
}

/** Provider catalogs are user-extensible (custom providers, v1 configs), so a
 * model can arrive with a partial or absent cost block. Everything downstream
 * reads `cache.read`/`cache.write` unconditionally, so normalise once here
 * rather than null-guarding at each of the arithmetic sites. */
function normalizeCost(cost: Partial<CheapnessModel["cost"]> | undefined): CheapnessModel["cost"] {
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cache: { read: cost?.cache?.read ?? 0, write: cost?.cache?.write ?? 0 },
  }
}

export function createUsageValuation(data: Accessor<UsageSummaryResponse | null | undefined>): UsageValuation {
  // No directory: `useProviders` treats any directory as an explicit scope
  // whose per-directory store is never bootstrapped from here, so passing one
  // yields an empty catalog. Undefined takes the global-catalog path.
  const providers = useProviders(() => undefined)

  const catalog = createMemo<CheapnessModel[]>(() =>
    [...providers.all().values()].flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        id: model.id,
        // models.dev republishes one canonical name per model across every
        // provider that serves it, which is what makes fuzzy name matching
        // work at all; strip the "(latest)" marker the catalog appends so it
        // does not skew similarity against an unmarked sibling.
        name: (model.name ?? model.id).replace("(latest)", "").trim(),
        family: model.family,
        provider: { id: provider.id, name: provider.name },
        cost: normalizeCost(model.cost),
      })),
    ),
  )

  const catalogByKey = createMemo(() => {
    const map = new Map<string, CheapnessModel>()
    for (const model of catalog()) map.set(`${model.provider.id}:${model.id}`, model)
    return map
  })

  const exactFallback = createMemo(() => {
    const list = catalog()
    if (list.length === 0) return undefined
    const map = buildPricingFallbackMap(list)
    return map.size > 0 ? map : undefined
  })

  const fuzzyFallback = createMemo(() => {
    const list = catalog()
    if (list.length === 0) return undefined
    const map = buildFuzzyPricingFallbackMap(list)
    return map.size > 0 ? map : undefined
  })

  const mergedFallback = createMemo(() => mergePricingFallbacks(exactFallback(), fuzzyFallback()))

  const subsidy = createMemo<SubsidyReport>(() =>
    computeSubsidy({
      rows: data()?.models ?? [],
      catalogByKey: catalogByKey(),
      exactFallback: exactFallback(),
      fuzzyFallback: fuzzyFallback(),
    }),
  )

  // A usage row whose model has since left the catalog (discontinued model,
  // disconnected provider) still resolves — as an unpriced stand-in that the
  // fallback maps may yet rescue — rather than being dropped from view.
  const resolveModel = (providerID: string, modelID: string): CheapnessModel =>
    catalogByKey().get(`${providerID}:${modelID}`) ?? {
      id: modelID,
      name: modelID,
      provider: { id: providerID },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    }

  return {
    catalog,
    catalogByKey,
    exactFallback,
    fuzzyFallback,
    mergedFallback,
    subsidy,
    effectiveCostFor: (providerID, modelID) =>
      resolveEffectiveCost(resolveModel(providerID, modelID), exactFallback(), fuzzyFallback()),
    nameFor: (providerID, modelID) => resolveModel(providerID, modelID).name || modelID,
    catalogReady: () => catalog().length > 0,
  }
}
