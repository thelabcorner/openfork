import { Show } from "solid-js"
import { Tag as TagV2 } from "@opencode-ai/ui/v2/badge-v2"
import { useLanguage } from "@/context/language"

/**
 * "Free now" badge for WorkBuddy models the provider is currently promoting.
 *
 * Provider-reported, not inferred: the catalog publishes a per-model promotion
 * (`modelPromotions[].badge.label`, e.g. "Free now") alongside a credit rate of
 * `x0.00`. The badge shows the provider's own wording when present and falls
 * back to the localized "Free" tag otherwise, so a promo the user recognizes in
 * the WorkBuddy app reads identically here.
 *
 * Deliberately distinct from `model.tag.free`: that tag is driven by token
 * pricing being zero, which WorkBuddy does not publish at all.
 *
 * PURE BY DESIGN — it takes a resolved string rather than calling
 * `useWorkBuddyUsage()`. This component renders once per row inside a
 * virtualized list; instantiating a hook here (one `useLimits()` per row, each
 * with its own effect and network resource) produced a request storm and a
 * reactive feedback loop that destroyed the popover's anchor, collapsing the
 * selector to the top-left corner. Row components must stay presentational.
 */
export function WorkBuddyFreeBadge(props: { label?: string }) {
  const language = useLanguage()
  const text = () => props.label || language.t("model.tag.free")
  return (
    <Show when={props.label !== undefined}>
      <TagV2 class="shrink-0" title={language.t("model.tooltip.workbuddy.free")}>
        {text()}
      </TagV2>
    </Show>
  )
}

/**
 * Resolve a model's promotion badge label, or `undefined` when it is not free.
 *
 * Returns `undefined` (not a label) for an unpublished rate, so a model whose
 * rate is merely unknown can never render as free.
 */
export function workBuddyFreeLabel(
  rate: { free: boolean; promotion?: string } | undefined,
): string | undefined {
  if (!rate?.free) return undefined
  return rate.promotion ?? ""
}
