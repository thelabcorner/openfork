import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { AccountVariant, AccountModelItem } from "./dialog-select-model-accounts"
import type { ForkCapacityPredictiveRange } from "@/utils/fork-client"
import { stretchHeadroom, stretchTone } from "./model-stretch-bar"
import { toneForRemaining } from "@/utils/limits-format"

export type AccountOptionUsage = {
  estimatedRequests?: number
  remainingPercent?: number
  predictiveRange?: ForkCapacityPredictiveRange
  status?: "ready" | "learning" | "unavailable" | "unlimited"
  reason?: string
  account?: string
  creditsExhausted?: boolean
}

export function accountLabelForVariant<T extends AccountModelItem>(
  variant: AccountVariant<T>,
  labels?: Readonly<Record<string, string>> | ReadonlyMap<string, string>,
): string {
  if (labels) {
    const mapped =
      labels instanceof Map ? labels.get(variant.accountID) : (labels as Record<string, string>)[variant.accountID]
    if (mapped) return mapped
  }
  const parts = [...variant.item.name.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]!.trim()).filter(Boolean)
  if (parts.length === 0) return variant.accountID
  if (parts.length === 1) return parts[0]!
  const isContext = (value: string) => /^\d+\s*[kKmM]$/.test(value.trim())
  const last = parts[parts.length - 1]!
  const secondLast = parts[parts.length - 2]!
  // WorkBuddy: Name (account) (300K) → last is context, second-last is account.
  // Detect which token is the context window and return the other.
  if (isContext(last) && !isContext(secondLast)) return secondLast
  if (!isContext(last) && isContext(secondLast)) return last
  // Fallback to the WorkBuddy shape when both or neither look like context.
  if (variant.item.provider.id === "workbuddy") return secondLast
  return isContext(last) ? secondLast : last
}

/**
 * Account picker body for the multi-account model submenu. Rendered under the
 * embedded model inspector in the same visual language (model-inspector.css):
 * a Routing section with the Auto policy, then an Accounts section whose rows
 * mirror the Session preview card's member rows — state dot, title, headroom
 * meter, request estimate, accent rail on the selected account.
 *
 * Every per-row value is an O(1) read of the Capacity projection the parent
 * already resolved (`usageForAccount`); nothing here fetches.
 */
export function AccountOptionList<T extends AccountModelItem>(props: {
  variants: readonly AccountVariant<T>[]
  auto?: T
  selectedAuto?: boolean
  onSelectAuto?: () => void
  selectedAccountID?: string
  usageForAccount?: (accountID: string) => AccountOptionUsage | undefined
  accountLabels?: Readonly<Record<string, string>> | ReadonlyMap<string, string>
  onSelect: (accountID: string) => void
}) {
  const language = useLanguage()
  return (
    <>
      <Show when={props.auto && props.onSelectAuto}>
        <div data-slot="pick-section">
          <div data-slot="section-head">
            <Icon name="status" size="small" class="size-3 shrink-0" />
            <span data-slot="section-label">{language.t("dialog.model.account.section.routing")}</span>
          </div>
          <div data-slot="pick-list">
            <MenuV2.Item
              data-slot="pick-row"
              data-selected={props.selectedAuto ? true : undefined}
              aria-label={language.t("dialog.model.account.auto")}
              onSelect={props.onSelectAuto}
            >
              <span data-slot="pick-state" aria-hidden="true">
                <i data-slot="dot" />
              </span>
              <span data-slot="pick-title">{language.t("dialog.model.account.auto")}</span>
              <Show when={props.selectedAuto}>
                <Icon name="check" size="small" data-slot="pick-check" />
              </Show>
            </MenuV2.Item>
          </div>
        </div>
      </Show>
      <div data-slot="pick-section" data-grow>
        <div data-slot="section-head">
          <Icon name="layers" size="small" class="size-3 shrink-0" />
          <span data-slot="section-label">{language.t("dialog.model.account.section.accounts")}</span>
          <span data-slot="count">{props.variants.length}</span>
        </div>
        <ScrollView data-slot="pick-scroll" class="max-h-[280px] [&_.scroll-view__viewport]:overscroll-contain">
          <div data-slot="pick-list">
            <For each={props.variants}>
              {(variant) => {
                const label = accountLabelForVariant(variant, props.accountLabels)
                const selected = () => props.selectedAccountID === variant.accountID
                const usage = () => props.usageForAccount?.(variant.accountID)
                const usageLabel = () => {
                  const value = usage()
                  if (!value) return ""
                  if (value.status === "learning" && value.estimatedRequests === undefined)
                    return language.t("model.tooltip.capacity.learning")
                  if (value.status === "unavailable" && value.estimatedRequests === undefined) return "—"
                  if (value.estimatedRequests === undefined) return ""
                  if (!Number.isFinite(value.estimatedRequests)) return "∞"
                  return `~${Math.round(value.estimatedRequests).toLocaleString(language.intl())}`
                }
                const predictiveLabel = () => {
                  const range = usage()?.predictiveRange
                  if (!range) return ""
                  if (range.status === "calibrated") {
                    return language.t("model.tooltip.usage.rangeValue", {
                      lower: range.lowerRequests.toLocaleString(language.intl()),
                      upper: range.upperRequests.toLocaleString(language.intl()),
                    })
                  }
                  if (range.status === "learning") return language.t("model.tooltip.usage.range.learning")
                  return language.t("model.tooltip.usage.range.unavailable")
                }
                // Same precedence as the model row's stretch bar: a real
                // percentage beats a request estimate; neither means "draw no
                // meter", never an empty one that reads as depleted.
                const headroom = () => {
                  const value = usage()
                  if (!value) return undefined
                  const remainingPercent = value.remainingPercent
                  const estimatedRequests = value.estimatedRequests
                  const result = stretchHeadroom({
                    requests: estimatedRequests,
                    remainingPercent,
                    tone:
                      remainingPercent !== undefined
                        ? toneForRemaining(remainingPercent)
                        : estimatedRequests !== undefined && Number.isFinite(estimatedRequests)
                          ? stretchTone(estimatedRequests)
                          : undefined,
                  })
                  return result.fraction === null ? undefined : result
                }
                const usageTitle = () => {
                  const value = usage()
                  if (!value) return undefined
                  return [
                    language.t("dialog.model.account.remaining", {
                      account: value.account ?? label,
                      percent: value.remainingPercent?.toFixed(1) ?? "—",
                    }),
                    predictiveLabel(),
                    value.reason,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                }
                return (
                  <MenuV2.Item
                    data-slot="pick-row"
                    data-selected={selected() ? true : undefined}
                    aria-label={label}
                    title={usageTitle()}
                    onSelect={() => props.onSelect(variant.accountID)}
                  >
                    <span data-slot="pick-state" aria-hidden="true">
                      <i data-slot="dot" />
                    </span>
                    <span data-slot="pick-title">{label}</span>
                    <Show when={usage()}>
                      <span data-slot="pick-trail">
                        <Show when={headroom()}>
                          {(value) => (
                            <span
                              data-slot="meter"
                              data-tone={value().tone === "muted" ? undefined : value().tone}
                              aria-hidden="true"
                            >
                              <span style={{ width: `${Math.max(4, value().fraction! * 100)}%` }} />
                            </span>
                          )}
                        </Show>
                        <span
                          class="min-w-9 text-right"
                          data-tone={usage()?.creditsExhausted ? "danger" : undefined}
                        >
                          {usageLabel()}
                        </span>
                      </span>
                    </Show>
                    <Show when={selected()}>
                      <Icon name="check" size="small" data-slot="pick-check" />
                    </Show>
                  </MenuV2.Item>
                )
              }}
            </For>
          </div>
        </ScrollView>
      </div>
    </>
  )
}
