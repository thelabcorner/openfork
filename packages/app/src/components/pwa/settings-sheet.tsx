import { BottomSheet, BottomSheetBody, BottomSheetHeader, BottomSheetTitle } from "@opencode-ai/ui/v2/bottom-sheet-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { createResource, createSignal, For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { settingsGeneralDict } from "@/i18n/en-settings-general"

// Settings-as-sheet (Q5, docs/pwa-mobile/03 §5): settings render as a bottom
// sheet over any route; no shell registers a /settings route. General settings
// reuse the desktop source of truth, while connection/network gets a dedicated
// mobile presentation over the same Server + OFXP domain contexts. The desktop
// Servers panel brings WSL/SSH/server-management chrome that is neither useful
// nor cheap for a paired phone.
type SettingsSection = "general" | "connection" | "notifications"

export const PwaSettingsSheet: Component<{ open: boolean; onClose: () => void }> = (props) => {
  const language = useLanguage()
  language.registerTranslations(settingsGeneralDict)
  const [section, setSection] = createSignal<SettingsSection>("general")
  const [panel] = createResource(
    () => (props.open ? section() : undefined),
    async (key) => {
      if (key === "connection") return (await import("@/components/pwa/connection-settings")).PwaConnectionSettings
      if (key === "notifications") return (await import("@/components/pwa/notification-settings")).PwaNotificationSettings
      return (await import("@/components/settings-v2/general")).SettingsGeneralV2
    },
  )

  const sections: Array<{ key: SettingsSection; label: string }> = [
    { key: "general", label: language.t("settings.tab.general") },
    { key: "connection", label: language.t("pwa.settings.connection") },
    { key: "notifications", label: language.t("pwa.settings.notifications") },
  ]

  return (
    <BottomSheet
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose()
      }}
      snapPoints={[0.92]}
      allowSkippingSnapPoints={false}
    >
      <BottomSheetHeader>
        <div class="flex items-center justify-between">
          <BottomSheetTitle>{language.t("pwa.tab.settings")}</BottomSheetTitle>
          <button
            type="button"
            aria-label={language.t("common.close")}
            class="flex size-8 items-center justify-center rounded-[6px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
            onClick={() => props.onClose()}
          >
            <Icon name="xmark-small" />
          </button>
        </div>
        <SegmentedControlV2
          value={section()}
          onChange={(value) => setSection((value ?? "general") as SettingsSection)}
          aria-label={language.t("pwa.tab.settings")}
        >
          <For each={sections}>
            {(item) => <SegmentedControlItemV2 value={item.key}>{item.label}</SegmentedControlItemV2>}
          </For>
        </SegmentedControlV2>
      </BottomSheetHeader>
      <BottomSheetBody class="px-4 py-3">
        <Show
          when={panel()}
          keyed
          fallback={
            <div class="flex min-h-32 items-center justify-center gap-2 text-[12px] text-v2-text-text-muted">
              <Spinner class="size-4" />
              <span>{language.t("common.loading")}</span>
            </div>
          }
        >
          {(Panel) => <Panel />}
        </Show>
      </BottomSheetBody>
    </BottomSheet>
  )
}
