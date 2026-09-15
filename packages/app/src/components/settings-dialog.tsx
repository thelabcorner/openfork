import { onCleanup } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useSettings } from "@/context/settings"
import { normalizeSettingsTab, useSettingsNavigation } from "./settings-v2/navigation"

export function useSettingsDialog(defaultValue?: string) {
  const dialog = useDialog()
  const settings = useSettings()
  const navigation = useSettingsNavigation()
  let run = 0
  let dead = false

  onCleanup(() => {
    dead = true
  })

  return () => {
    if (settings.general.newLayoutDesigns()) {
      navigation.open(normalizeSettingsTab(defaultValue))
      return
    }
    const current = ++run
    void import("@/components/dialog-settings").then((module) => {
      if (dead || run !== current) return
      void dialog.show(() => <module.DialogSettings defaultValue={defaultValue} />)
    })
  }
}

export function useSettingsCommand() {
  const command = useCommand()
  const language = useLanguage()
  const show = useSettingsDialog()

  command.register("settings", () => [
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      keybind: "mod+comma",
      onSelect: show,
    },
  ])

  return show
}
