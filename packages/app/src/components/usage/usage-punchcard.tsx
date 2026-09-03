import { For, Show } from "solid-js"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { formatNumber, formatTokens, formatUSD, hourLabel } from "./usage-format"
import { UsageTooltipContent } from "./usage-chart"

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const HOUR_LABEL_EVERY = 3

/**
 * Day-of-week x hour-of-day punchcard.
 *
 * The page previously showed the two marginals — a 7-bar day chart and a
 * 24-bar hour chart — side by side, which cannot answer the only interesting
 * question of the pair: *when* do you actually work. "Busy on Tuesdays" and
 * "busy at 9pm" are compatible with working Tuesday mornings and Friday
 * nights. This renders the cross product the server now aggregates, so the
 * real shape of a week is visible directly.
 *
 * Intensity is driven by turn count, which is the honest measure of activity —
 * colouring by cost would make one expensive afternoon outshine a week of
 * steady work — with cost and tokens available on hover.
 */
export function UsagePunchcard(props: { punchcard: UsageSummaryResponse["punchcard"] }) {
  const language = useLanguage()

  const max = () => {
    let value = 0
    for (const bucket of props.punchcard) value = Math.max(value, bucket.messages)
    return value
  }

  const fillFor = (messages: number) => {
    if (messages <= 0) return "var(--usage-track, var(--v2-background-bg-layer-03))"
    const top = max()
    // Square-root ramp: linear scaling makes everything but the single busiest
    // hour look empty once one slot dominates, which is the normal shape of
    // real usage.
    const intensity = top > 0 ? Math.sqrt(messages / top) : 0
    const percent = 14 + intensity * 76
    return `color-mix(in srgb, var(--usage-accent-strong, var(--v2-text-text-accent)) ${percent.toFixed(1)}%, transparent)`
  }

  const bucket = (dow: number, hour: number) => props.punchcard[dow * 24 + hour] ?? { cost: 0, tokens: 0, messages: 0 }

  return (
    <Show
      when={props.punchcard.length === 7 * 24}
      fallback={<div class="py-3 text-center text-[10px] font-[440] text-v2-text-text-faint">—</div>}
    >
      <div class="flex min-w-0 flex-col gap-1">
        <For each={DOW_LABELS}>
          {(label, dowIndex) => (
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="w-6 shrink-0 text-[9px] font-[500] leading-3 text-v2-text-text-faint">{label}</span>
              <div class="flex min-w-0 flex-1 gap-[2px]">
                <For each={Array.from({ length: 24 }, (_, hour) => hour)}>
                  {(hour) => {
                    const cell = () => bucket(dowIndex(), hour)
                    return (
                      <TooltipV2
                        placement="top"
                        class="min-w-0 flex-1"
                        value={
                          <UsageTooltipContent
                            title={`${label} · ${hourLabel(hour)}`}
                            rows={[
                              { label: language.t("usage.table.turns"), value: formatNumber(cell().messages, language.intl()) },
                              { label: language.t("usage.metric.cost"), value: formatUSD(cell().cost, language.intl()) },
                              { label: language.t("usage.metric.tokens"), value: formatTokens(cell().tokens, language.intl()) },
                            ]}
                          />
                        }
                      >
                        <div
                          class="h-4 w-full rounded-[2px]"
                          style={{ "background-color": fillFor(cell().messages) }}
                        />
                      </TooltipV2>
                    )
                  }}
                </For>
              </div>
            </div>
          )}
        </For>
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="w-6 shrink-0" />
          <div class="flex min-w-0 flex-1 gap-[2px]">
            <For each={Array.from({ length: 24 }, (_, hour) => hour)}>
              {(hour) => (
                <span class="min-w-0 flex-1 text-center text-[8px] font-[440] leading-3 text-v2-text-text-faint">
                  {hour % HOUR_LABEL_EVERY === 0 ? hourLabel(hour) : ""}
                </span>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}
