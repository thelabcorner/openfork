import { For, Show, type Accessor, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { sectionsForTab, type SettingsSection } from "./sections"
import type { SettingsTab } from "./navigation"
import "./settings-subnav.css"

/** A compact child navigation tree inside the existing Settings sidebar. */
export const SettingsSubnav: Component<{
  tab: SettingsTab
  parentLabel: string
  activeTab: Accessor<SettingsTab>
  section: Accessor<SettingsSection | undefined>
  setSection: (value: SettingsSection) => void
}> = (props) => {
  const language = useLanguage()
  const sections = sectionsForTab(props.tab)

  return (
    <Show when={props.activeTab() === props.tab}>
      <div
        class="settings-v2-subnav"
        role="group"
        aria-label={`${props.parentLabel} sections`}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".settings-v2-subnav-item"))
          const index = buttons.findIndex((button) => button === event.target)
          if (index < 0 || !buttons.length) return
          event.preventDefault()
          event.stopPropagation()
          const next =
            event.key === "Home" ? 0 :
            event.key === "End" ? buttons.length - 1 :
            (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
          buttons[next]?.focus()
          buttons[next]?.click()
        }}
      >
        <For each={sections}>
          {(section) => (
            <button
              type="button"
              class="settings-v2-subnav-item"
              data-section={section.id}
              aria-current={props.section() === section.id ? "page" : undefined}
              onClick={() => props.setSection(section.id)}
            >
              <span class="settings-v2-subnav-label">{section.labelKey ? language.t(section.labelKey) : section.label}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
