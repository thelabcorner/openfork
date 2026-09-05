import type { AccountVariant, ModelGroup } from "@opencode-ai/schema/model-select/accounts"
import { For, Show } from "solid-js"
import type { AccountUsage } from "../model-accounts"
import { IconCheck, IconX, IconZap } from "../icons"
import { Sheet } from "./Sheet"

function usageLabel(value: AccountUsage | undefined): string {
  if (!value) return ""
  if (!Number.isFinite(value.estimatedRequests)) return "∞"
  return `~${Math.round(value.estimatedRequests).toLocaleString()}`
}

/** 0-100 fill for the usage pill, or undefined when there is nothing to show. */
function fillPercent(value: AccountUsage): number | undefined {
  const percent = value.remainingPercent
  if (typeof percent === "number" && Number.isFinite(percent)) return Math.min(100, Math.max(0, percent))
  if (!Number.isFinite(value.estimatedRequests)) return undefined
  // Requests are unbounded in scale, so compress logarithmically against a
  // generous ceiling - a linear bar would read as empty for every real value.
  return Math.min(100, (Math.log1p(Math.max(0, value.estimatedRequests)) / Math.log1p(20_000)) * 100)
}

function toneFor(value: AccountUsage): "success" | "warning" | "danger" | "muted" {
  const percent = value.remainingPercent
  if (typeof percent === "number" && Number.isFinite(percent)) {
    if (percent <= 10) return "danger"
    if (percent <= 30) return "warning"
    return "success"
  }
  if (!Number.isFinite(value.estimatedRequests)) return "success"
  if (value.estimatedRequests <= 8) return "danger"
  if (value.estimatedRequests <= 40) return "warning"
  return "success"
}

export function AccountPickerSheet(props: {
  open: boolean
  onClose: () => void
  /** Canonical (unqualified) model name shown in the header. */
  title: string
  group: ModelGroup<any> | undefined
  /** Accounts offered, already merged with any quota-synthesized roster. */
  variants: readonly AccountVariant<any>[]
  /** True when the provider exposes a bare/auto variant. */
  hasAuto: boolean
  selectedAccountID: string | undefined
  selectedAuto: boolean
  usageForAccount?: (accountID: string) => AccountUsage | undefined
  accountLabels?: ReadonlyMap<string, string>
  onSelectAuto?: () => void
  onSelectAccount: (accountID: string) => void
}) {
  const label = (variant: AccountVariant<any>) =>
    props.accountLabels?.get(variant.accountID) ?? variant.accountID

  return (
    <Sheet open={props.open} onClose={props.onClose} title={props.title} height="tall">
      <div class="account-sheet">
        <Show when={props.hasAuto}>
          <div class="account-sheet-section">
            <div class="account-sheet-head">
              <span>Routing</span>
            </div>
            <button
              type="button"
              class="account-opt"
              classList={{ selected: props.selectedAuto }}
              onClick={() => props.onSelectAuto?.()}
            >
              <span class="account-dot auto" />
              <span class="account-opt-name">Auto</span>
              <span class="account-opt-note">Let the provider choose</span>
              <Show when={props.selectedAuto}>
                <IconCheck size={13} class="account-opt-check" />
              </Show>
            </button>
          </div>
        </Show>

        <div class="account-sheet-section">
          <div class="account-sheet-head">
            <span>Accounts</span>
            <span class="count">{props.variants.length}</span>
          </div>

          <Show when={props.variants.length > 0} fallback={<div class="empty-list"><p>No accounts enrolled</p></div>}>
            <div class="account-list">
              <For each={props.variants as AccountVariant<any>[]}>
                {(variant) => {
                  const usage = () => props.usageForAccount?.(variant.accountID)
                  const selected = () => props.selectedAccountID === variant.accountID
                  const fill = () => (usage() ? fillPercent(usage()!) : undefined)
                  const exhausted = () => usage()?.creditsExhausted === true
                  return (
                    <button
                      type="button"
                      class="account-opt"
                      classList={{ selected: selected() }}
                      onClick={() => props.onSelectAccount(variant.accountID)}
                    >
                      <span class="account-dot" />
                      <span class="account-opt-name">{label(variant)}</span>

                      <Show when={usage()}>
                        {(value) => (
                          <>
                            <Show when={fill() !== undefined}>
                              <span class="account-usage-bar">
                                <span
                                  class={`account-usage-fill tone-${toneFor(value())}`}
                                  classList={{ exhausted: exhausted() }}
                                  style={{ width: `${fill()}%` }}
                                />
                              </span>
                            </Show>
                            <span
                              class="account-usage-value tnum"
                              classList={{ exhausted: exhausted() }}
                              title={
                                value().accountWide
                                  ? `${value().account ?? label(variant)} - whole-account headroom; this model has no quota row of its own`
                                  : `${value().account ?? label(variant)} - ${value().remainingPercent?.toFixed(1) ?? "?"}% remaining`
                              }
                            >
                              {usageLabel(value())}
                              <Show when={value().accountWide}>
                                <span class="account-usage-scope" aria-hidden="true">
                                  *
                                </span>
                              </Show>
                            </span>
                          </>
                        )}
                      </Show>

                      <Show when={exhausted()}>
                        <IconZap size={11} class="account-opt-warn" />
                      </Show>

                      <Show when={selected()}>
                        <IconCheck size={13} class="account-opt-check" />
                      </Show>
                    </button>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Sheet>
  )
}
