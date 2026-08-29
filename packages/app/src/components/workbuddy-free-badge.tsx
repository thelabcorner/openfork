import { Show } from "solid-js"
import { Tag as TagV2 } from "@opencode-ai/ui/v2/badge-v2"
import { useLanguage } from "@/context/language"
import { useWorkBuddyUsage } from "@/hooks/use-workbuddy-usage"
import { splitWorkBuddyModelID } from "@/hooks/use-workbuddy-usage"

/**
 * "Free now" badge for WorkBuddy models the provider is currently promoting.
 *
 * This is provider-reported, not inferred: the catalog publishes a per-model
 * promotion (`modelPromotions[].badge.label`, e.g. "Free now") alongside a
 * credit rate of `x0.00`. The badge shows the provider's own wording when
 * present and falls back to the localized "Free" tag otherwise, so a promo the
 * user recognizes in the WorkBuddy app reads identically here.
 *
 * Deliberately distinct from `model.tag.free` in one respect: that tag is
 * driven by token pricing being zero, which WorkBuddy does not publish at all.
 * Rendering is gated on `rateFor(...)` so the badge cannot appear for a model
 * whose rate is simply unknown.
 */
export function WorkBuddyFreeBadge(props: { modelID: string }) {
  const language = useLanguage()
  const workbuddy = useWorkBuddyUsage()
  const rate = () => workbuddy.rateFor(props.modelID)
  const label = () => {
    const value = rate()
    if (!value?.free) return undefined
    return value.promotion || language.t("model.tag.free")
  }
  return (
    <Show when={label()}>
      {(text) => (
        <TagV2 class="shrink-0" title={language.t("model.tooltip.workbuddy.free")}>
          {text()}
        </TagV2>
      )}
    </Show>
  )
}

/** Convenience guard so call sites don't repeat the provider check. */
export function isWorkBuddyModel(providerID: string) {
  return providerID === "workbuddy"
}

export { splitWorkBuddyModelID }
