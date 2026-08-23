import { BottomSheet, BottomSheetBody, BottomSheetHeader, BottomSheetTitle } from "@opencode-ai/ui/v2/bottom-sheet-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { createResource, createSignal, For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"

// Settings-as-sheet (Q5, docs/pwa-mobile/03 §5): settings render as a bottom
// sheet over any route; no shell registers a /settings route. Sections reuse
// the desktop settings-v2 panels so both presentations share one source of
// truth. The keyboard-centric shortcuts panel is omitted on mobile per 03 §2.7.
type SettingsSection = "general" | "servers"

export const PwaSettingsSheet: Component<{ open: boolean; onClose: () => void }> = (props) => {
  const language = useLanguage()
  const [section, setSection] = createSignal<SettingsSection>("general")
  const [modules] = createResource(
    () => props.open,
    (open) =>
      open ? Promise.all([import("@/components/settings-v2/general"), import("@/components/settings-v2/servers")]) : null,
  )

  const sections: Array<{ key: SettingsSection; label: string }> = [
    { key: "general", label: language.t("settings.tab.general") },
    { key: "servers", label: language.t("status.popover.tab.servers") },
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
        <Show when={modules()} keyed>
          {(loaded) => {
            const General = loaded[0].SettingsGeneralV2
            const Servers = loaded[1].SettingsServersV2
            return (
              <Show when={section() === "servers"} fallback={<General />}>
                <Servers />
              </Show>
            )
          }}
        </Show>
      </BottomSheetBody>
    </BottomSheet>
  )
}
