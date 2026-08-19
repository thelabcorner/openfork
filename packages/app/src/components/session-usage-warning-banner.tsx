import { createMemo, createSignal, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useForkUsage } from "@/context/fork-usage"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import type { ForkWindowUsage } from "@/utils/fork-client"
import { percent as usagePercent, toneFor, colorFor } from "./usage-gauge-v2"

// Tiers, ascending: once dismissed at a tier, the banner stays hidden until
// usage climbs past the *next* one — so it doesn't reappear on every render
// once you've acknowledged it, but does re-surface if things get worse
// (e.g. dismiss at 75%, it's quiet until 90%, dismiss that, quiet until 100%).
const TIERS = [75, 90, 100]

const windowLabelKey = (label: ForkWindowUsage["label"]) =>
  label === "5h" ? "usage.window.5h" : label === "week" ? "usage.window.week" : "usage.window.month"

export function SessionUsageWarningBanner(props: { providerID: string | undefined }) {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useSDK()
  const forkUsage = useForkUsage()
  const [dismissedTier, setDismissedTier] = createSignal(0)

  // Deliberately does not fall back to `usage.latest.aggregate` — see
  // dialog-select-model.tsx's identical note: aggregate spans every credential
  // the account has ever used, which previously caused a usage indicator to
  // pin at ~100% regardless of actual spend. No resolved per-credential
  // window means "we don't know," not "assume the worst."
  const windows = createMemo<ForkWindowUsage[] | undefined>(() => {
    const credentialID = forkUsage.activeCredentialID()
    if (!credentialID) return undefined
    return forkUsage.usage.latest?.byCredential.find((entry) => entry.credentialID === credentialID)?.windows
  })

  const worst = createMemo(() => {
    const list = windows()
    if (!list) return undefined
    let best: { window: ForkWindowUsage; pct: number } | undefined
    for (const window of list) {
      const pct = usagePercent(window)
      if (!best || pct > best.pct) best = { window, pct }
    }
    return best
  })

  const tier = createMemo(() => {
    const pct = worst()?.pct ?? 0
    return TIERS.filter((value) => pct >= value).at(-1) ?? 0
  })

  const visible = createMemo(
    () => props.providerID === "opencode-go" && tier() > 0 && tier() > dismissedTier(),
  )

  const openCredentials = () => {
    void import("./dialog-credential-switcher").then((module) => {
      void dialog.show(() => <module.DialogCredentialSwitcherV2 directory={() => sdk().directory} />)
    })
  }

  return (
    <Show when={visible()}>
      {(() => {
        const entry = worst()!
        const tone = toneFor(entry.pct)
        const color = colorFor(tone)
        return (
          <div
            data-component="session-usage-warning-banner"
            role="status"
            class="flex w-full items-center gap-2 rounded-[10px] border-[0.5px] px-3 py-2"
            style={{
              "border-color": `color-mix(in srgb, ${color} 32%, var(--v2-border-border-base))`,
              "background-color": `color-mix(in srgb, ${color} 8%, var(--v2-background-bg-layer-01))`,
            }}
          >
            <Icon name="warning" size="small" class="shrink-0" style={{ color }} />
            <span class="min-w-0 flex-1 text-[12.5px] font-[440] leading-5 tracking-[-0.03px] text-v2-text-text-base">
              {language.t("session.usageWarning.message", {
                percent: Math.round(entry.pct),
                window: language.t(windowLabelKey(entry.window.label)),
              })}
            </span>
            <button
              type="button"
              class="shrink-0 text-[12px] font-[560] text-v2-text-text-accent hover:underline"
              onClick={openCredentials}
            >
              {language.t("session.usageWarning.manage")}
            </button>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              aria-label={language.t("common.dismiss")}
              onClick={() => setDismissedTier(tier())}
              icon={<Icon name="close" />}
            />
          </div>
        )
      })()}
    </Show>
  )
}
