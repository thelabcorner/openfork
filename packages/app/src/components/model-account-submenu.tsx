import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { AccountVariant, AccountModelItem } from "./dialog-select-model-accounts"
import { ModelStretchBar, stretchTone } from "./model-stretch-bar"
import { toneForRemaining } from "@/utils/limits-format"

export type AccountOptionUsage = {
  estimatedRequests: number
  remainingPercent?: number
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
  // WorkBuddy: Name (account) (300K) → last is context, second-last is account
  // Verdent:  Name (300K) (account) → last is account, second-last is context
  // Detect which one is the context window and return the other.
  if (isContext(last) && !isContext(secondLast)) return secondLast
  if (!isContext(last) && isContext(secondLast)) return last
  // Fallback to provider-aware heuristic when both or neither look like context
  if (variant.item.provider.id === "verdent") return last
  if (variant.item.provider.id === "workbuddy") return secondLast
  return isContext(last) ? secondLast : last
}

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
    <div class="w-full min-w-0 px-1 pb-1" data-model-account-options>
      <Show when={props.auto && props.onSelectAuto}>
        <div class="px-1 pb-1">
          <div class="flex h-6 items-center px-2 text-[9px] font-[600] uppercase tracking-[0.04px] text-v2-text-text-faint">
            {language.t("dialog.model.account.section.routing")}
          </div>
          <MenuV2.Item
            class="min-h-[28px] w-full min-w-0 !gap-1 !px-2 !py-1"
            style={{ width: "100%", "min-width": "0" }}
            data-selected={props.selectedAuto ? true : undefined}
            aria-label={language.t("dialog.model.account.auto")}
            onSelect={props.onSelectAuto}
          >
            <span class="size-1 shrink-0 rounded-full border border-v2-text-text-muted" />
            <span class="min-w-0 flex-1 truncate text-[11px] font-[500] leading-4 text-v2-text-text-base">
              {language.t("dialog.model.account.auto")}
            </span>
            <Show when={props.selectedAuto}>
              <Icon name="check" size="small" class="size-3 shrink-0 text-v2-text-text-accent" />
            </Show>
          </MenuV2.Item>
        </div>
        <MenuV2.Separator class="my-0.5" />
      </Show>
      <div class="flex h-6 items-center justify-between px-2 text-[9px] font-[600] uppercase tracking-[0.04px] text-v2-text-text-faint">
        <span>{language.t("dialog.model.account.section.accounts")}</span>
        <span>{language.t("dialog.model.account.count", { count: props.variants.length })}</span>
      </div>
      <ScrollView class="max-h-[280px] w-full min-w-0 [&_.scroll-view__viewport]:overscroll-contain">
        <div class="flex flex-col">
          <For each={props.variants}>
            {(variant) => {
              const label = accountLabelForVariant(variant, props.accountLabels)
              const selected = () => props.selectedAccountID === variant.accountID
              const usage = () => props.usageForAccount?.(variant.accountID)
              const usageLabel = () => {
                const value = usage()
                if (!value) return ""
                if (!Number.isFinite(value.estimatedRequests)) return "∞"
                return `~${Math.round(value.estimatedRequests).toLocaleString()}`
              }
              return (
                <MenuV2.Item
                  class="min-h-[28px] w-full min-w-0 !items-stretch !gap-0 !p-0"
                  style={{ width: "100%", "min-width": "0" }}
                  data-selected={selected() ? true : undefined}
                  aria-label={label}
                  onSelect={() => props.onSelect(variant.accountID)}
                >
                  <div class="flex w-full items-center gap-1.5 px-2 py-1">
                    <span class="size-[3px] shrink-0 rounded-full bg-v2-text-text-muted" />
                    <span
                      class="min-w-0 flex-1 truncate text-[11px] font-[450] leading-4 text-v2-text-text-base"
                      title={label}
                    >
                      {label}
                    </span>
                    <Show when={usage()}>
                      {(value) => (
                        <>
                          <ModelStretchBar
                            requests={value().estimatedRequests}
                            remainingPercent={value().remainingPercent}
                            tone={
                              value().remainingPercent !== undefined
                                ? (toneForRemaining(value().remainingPercent ?? null) as
                                    | "danger"
                                    | "warning"
                                    | "success")
                                : stretchTone(value().estimatedRequests)
                            }
                          />
                          <span
                            class="w-12 shrink-0 truncate text-right text-[9px] font-[520] leading-4 tabular-nums text-v2-text-text-faint"
                            classList={{ "text-v2-state-fg-danger": value().creditsExhausted }}
                            title={`${value().account ?? label} · ${value().remainingPercent?.toFixed(1) ?? "—"}% remaining`}
                          >
                            {usageLabel()}
                          </span>
                        </>
                      )}
                    </Show>
                    <Show when={selected()}>
                      <Icon name="check" size="small" class="size-3 shrink-0 text-v2-text-text-accent" />
                    </Show>
                  </div>
                </MenuV2.Item>
              )
            }}
          </For>
        </div>
      </ScrollView>
    </div>
  )
}
