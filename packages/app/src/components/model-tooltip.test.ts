import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { parseModelAccount, qualifyInferred } from "./model-tooltip"

describe("parseModelAccount", () => {
  test("parses WorkBuddy account ids after a context alias", () => {
    expect(parseModelAccount("hy4-preview#ctx-262144@wb-account-a", "workbuddy")).toBe("wb-account-a")
  })

  test("does not treat bare or unrelated ids as account-qualified", () => {
    expect(parseModelAccount("hy4-preview", "workbuddy")).toBeUndefined()
    expect(parseModelAccount("foo@bar", "workbuddy")).toBeUndefined()
    expect(parseModelAccount("foo@wb-", "workbuddy")).toBeUndefined()
    expect(parseModelAccount("foo@wb-account", "opencode")).toBeUndefined()
  })

  test("rejects malformed suffixes without a non-empty account id", () => {
    expect(parseModelAccount("@wb-account", "workbuddy")).toBeUndefined()
    expect(parseModelAccount("foo@wb-account@extra", "workbuddy")).toBeUndefined()
  })
})

/**
 * Negative invariants for the V2 inspector overhaul. These rows were removed on
 * purpose and nothing else asserts it: the standardized corpus yield and its
 * Light/Heavy bands are a population benchmark that duplicated the user's own
 * workload block and crowded out the request-capacity section, which is the one
 * block that can actually change a model choice.
 */
describe("V2 inspector surface", () => {
  const source = readFileSync(new URL("./model-tooltip.tsx", import.meta.url), "utf8")
  const pickerSource = readFileSync(new URL("./dialog-select-model.tsx", import.meta.url), "utf8")
  const gensparkSource = readFileSync(new URL("../hooks/use-genspark-usage.ts", import.meta.url), "utf8")

  test("renders no standardized-corpus usage-yield rows", () => {
    expect(source).not.toContain("usageYield")
    expect(source).not.toContain("evaluateModelUsageYield")
    expect(source).not.toContain("FALLBACK_WORKLOAD_CORPUS")
  })

  test("leads with the request-capacity section, ahead of workload and pricing", () => {
    const capacity = source.indexOf("language.t(\"model.tooltip.capacity.title\")")
    const workload = source.indexOf("language.t(\"model.tooltip.workload.title\")")
    const pricing = source.indexOf("language.t(\"model.tooltip.pricing.title\")")
    expect(capacity).toBeGreaterThan(-1)
    expect(capacity).toBeLessThan(workload)
    expect(workload).toBeLessThan(pricing)
  })

  test("keeps the dense 5h/week capacity hierarchy and does not resurrect Light/Heavy", () => {
    // Both windows are drawn from the one server-published window list; there is
    // no second, coarser tier to fall back into.
    expect(source).toContain("language.t(\"model.tooltip.capacity.fiveHour\")")
    expect(source).toContain("language.t(\"model.tooltip.capacity.week\")")
    expect(source).not.toMatch(/\b(Light|Heavy)\b/)
    // Density stays: no placeholder rows that only re-state the section head.
    expect(source).toContain("formatRequestPointEstimate")
    expect(source).toContain("data-slot=\"dim\"")
  })

  test("declares hasBand above its first reader so no helper shadows its dependency", () => {
    const hasBand = source.indexOf("const hasBand = () =>")
    expect(hasBand).toBeGreaterThan(-1)
    expect(hasBand).toBeLessThan(source.indexOf("const capacitySource = () =>"))
    // Exactly one declaration, so the earlier one is the live one.
    expect(source.split("const hasBand = () =>").length - 1).toBe(1)
  })

  test("presentation lives in the shared inspector stylesheet, not ad-hoc utility chrome", () => {
    expect(source).toContain("import \"./model-inspector.css\"")
    expect(source).toContain("data-component=\"model-inspector\"")
    expect(source).not.toContain("<ScrollView")
    expect(source).not.toMatch(/rounded-\d|shadow-\[|bg-gradient|backdrop-blur/)
  })


  test("V2 hover never ensures personal usage and never fabricates pricing", () => {
    // Both halves must be provable, not just plausible: the only calls in the
    // file live inside one helper, and that helper is called only on the
    // `!props.v2` arm of a ternary.
    const guardStart = source.indexOf("The one and only durable personal-usage binding")
    const guardEnd = source.indexOf("export const ModelTooltip")
    expect(guardStart).toBeGreaterThan(-1)
    expect(guardEnd).toBeGreaterThan(guardStart)
    const indexesOf = (needle: string) =>
      [...source.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((match) => match.index!)
    for (const needle of ["usePersonalUsage()", ".ensure()"]) {
      const at = indexesOf(needle)
      expect(at.length).toBeGreaterThan(0)
      // Every reference - code or prose - sits inside the one guarded helper, so
      // nothing else in this file can reach the durable store.
      expect(at.every((index) => index > guardStart && index < guardEnd)).toBe(true)
    }

    // The one call site is the legacy arm.
    expect(source).toContain("const personalForCtx = props.v2 ? undefined : legacyPersonalUsage()")
    expect(source.split("legacyPersonalUsage()").length - 1).toBe(2)

    expect(source).not.toContain("input: 0.6, output: 0.6")
  })

  /**
   * Genspark truthfulness: a real credit balance may be shown, a rate nobody
   * published may not. The old code invented $0.60/M (225 credits/M) whenever the
   * catalog had no price, which turned a missing fact into both a price and a
   * "requests left" number.
   */
  test("never invents a Genspark rate or a request count derived from one", () => {
    for (const text of [source, pickerSource, gensparkSource]) {
      expect(text).not.toContain("225")
      expect(text).not.toMatch(/0\.6\b/)
    }
    expect(gensparkSource).not.toContain("cost = 0.6")
    // The unknown-rate cells dash out instead of printing a number.
    expect(source).toContain("gs().rateCreditsPerM === undefined ? CAPACITY_DASH")
    expect(source).not.toContain("gs().estimatedRequests")
  })

  test("embedded V2 tooltips receive the already-materialized hit rate", () => {
    const openRouter = pickerSource.slice(
      pickerSource.indexOf("function OpenRouterRow("),
      pickerSource.indexOf("function MultiAccountRow("),
    )
    const multi = pickerSource.slice(
      pickerSource.indexOf("function MultiAccountRow("),
      pickerSource.indexOf("function ModelFavoriteToggle("),
    )
    expect(openRouter).toContain("hitRate?: number")
    expect(openRouter).toContain("hitRate={props.hitRate}")
    expect(multi).toContain("hitRate?: number")
    expect(multi).toContain("hitRate={props.hitRate}")
    // Resolved by the view from the materialized maps — no new fetch or history work.
    expect(pickerSource).toContain("const hitRateForItem = (item: ModelItem): number | undefined =>")
    expect(pickerSource.split("hitRate={hitRateForItem(item)}").length - 1).toBeGreaterThanOrEqual(2)
  })

  test("capacity provenance never promotes raw server reason codes to visible copy", () => {
    expect(source).not.toContain("capacity().unavailableReason")
    expect(source).not.toContain("props.usage?.capacityReason ??")
  })
})

/**
 * Pricing provenance. A model whose provider publishes no rate is priced from a
 * sibling provider's rate (the shared `resolveEffectiveCost` fallback) so the
 * picker can still sort and explain the row. That inference is useful and must
 * stay visible, but the pooled card used to receive only the substituted cost:
 * `effective.borrowed` died at the call site, and a sibling provider's rate was
 * rendered as this provider's published pricing - in dollars, or for the
 * credit-denominated Genspark converted into credits.
 */
describe("inferred pricing provenance", () => {
  const source = readFileSync(new URL("./model-tooltip.tsx", import.meta.url), "utf8")
  const pickerSource = readFileSync(new URL("./dialog-select-model.tsx", import.meta.url), "utf8")

  test("marks a borrowed figure and leaves a published figure unmarked", () => {
    expect(qualifyInferred("225 credits/M", true)).toBe("~225 credits/M")
    expect(qualifyInferred("$1.50", true)).toBe("~$1.50")
    expect(qualifyInferred("$1.50", false)).toBe("$1.50")
    // Absent provenance (every other ModelTooltip caller) must not invent a marker.
    expect(qualifyInferred("$1.50")).toBe("$1.50")
  })

test("a borrowed effective price reaches the pooled card with its provenance", () => {
    // One resolution produces both halves, so the cost and its provenance can
    // never disagree: the flag is read from the same `effective` that supplied
    // the price rather than from a second lookup of its own.
    expect(pickerSource).toContain("const tooltipPricing = createMemo(() => {")
    expect(pickerSource).toContain("const effective = resolveEffectiveCost(item, mergedPricingFallbackForDisplay())")
    expect(pickerSource).toContain("model: effective.borrowed ? ({ ...item, cost: effective.cost } as never) : item,")
    expect(pickerSource).toContain("inferred: effective.borrowed,")
    expect(pickerSource).toContain("model={tooltipPricing()!.model}")
    expect(pickerSource).toContain("pricingInferred={tooltipPricing()!.inferred}")
    // The card owns the flag as display state; the shared model object does not.
    expect(pickerSource).not.toContain("...m, cost: effective.cost, pricing")
    expect(source).toContain("pricingInferred?: boolean")
    expect(source).toContain("const pricingInferred = () => props.pricingInferred === true")
  })

  test("every figure derived from an inferred price is marked", () => {
    // $/M and /1B cells, in both the dollars and the credits formatter path.
    expect(source).toContain("qualifyInferred(perMillion(value), props.inferred)")
    expect(source).toContain("qualifyInferred(perBillion(value), props.inferred)")
    expect(source).toContain("inferred={pricingInferred()}")
    // Dependent economics: generalized $/request and requests per $1.
    expect(source).toContain("qualifyInferred(usd(yielded().costPerEquivalentRequest ?? 0), pricingInferred())")
    expect(source).toMatch(
      /Math\.round\(yielded\(\)\.equivalentRequestsPerDollar \?\? 0\)\.toLocaleString\(language\.intl\(\)\),\s*pricingInferred\(\)/,
    )
    // The workload-sensitivity capacity band is repriced through this model, so
    // its spread is qualified too; server-owned point totals stay the anchor.
    expect(source).toContain("{(window) => <InspectorCapacityWindow view={window} inferred={pricingInferred()} />}")
    expect(source).toContain(
      "function InspectorCapacityWindow(props: { view: CapacityWindowView; inferred?: boolean })",
    )
  })

  test("an inferred rate is explained, not only marked", () => {
expect(source).toContain('{language.t("model.tag.inferred")}')
    // Plain label: the "~" marks the figures, not the qualifier word.
    expect(source).not.toContain('qualifyInferred(language.t("model.tag.inferred")')
    expect(source).toContain("hint={inferredHint()}")
    expect(source).toContain('asideTitle={inferredHint() ?? language.t("model.tooltip.cacheHitRate.label")}')
    expect(source).toContain('language.t("model.tooltip.pricing.inferredHint")')
  })

  test("inferred pricing stays on screen for Genspark and every other provider", () => {
    // The defect was provenance, not the presence of the number: a borrowed rate
    // remains the price shown, and no section is gated on the flag.
    expect(source).toContain("const showPricing = () => !!props.model.cost && hasPublishedPricing(props.model.cost)")
    expect(source).toContain("cost={props.model.cost!}")
    expect(source).not.toContain("publishedModelCost")
    expect(source).not.toContain("pricingInferred() && ")
    // Credit-denominated rows keep the borrowed estimate, marked "~".
    expect(source).toContain("qualifyInferred(fmt(props.model.cost?.input ?? 0), pricingInferred())")
  })
})

describe("model inspector stylesheet", () => {
  const css = readFileSync(new URL("./model-inspector.css", import.meta.url), "utf8")

  test("sections are separated by hairlines in the Session preview card language", () => {
    expect(css).toContain("border-top: 1px solid var(--v2-border-border-muted)")
    expect(css).toContain("height: 26px")
  })

  test("the pooled floating card never takes the pointer from the model list", () => {
    const float = css.slice(css.indexOf("[data-component=\"model-inspector-float\"]"))
    expect(float.slice(0, float.indexOf("}"))).toContain("pointer-events: none")
  })

  test("submenus are capped to the space Kobalte measured for them", () => {
    expect(css).toContain("var(--kb-popper-content-available-height")
  })
})

describe("account picker copy", () => {
  const source = readFileSync(new URL("./model-account-submenu.tsx", import.meta.url), "utf8")

  test("renders no hardcoded English", () => {
    expect(source).not.toContain("\"Learning\"")
    expect(source).not.toContain("% remaining")
  })
})
