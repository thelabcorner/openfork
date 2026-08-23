import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { useLocation, useNavigate } from "@solidjs/router"
import { For, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { resolveActiveTab, type PwaTabKey } from "./tab-bar-active"
import "./tab-bar.css"

export interface PwaTabBarProps {
  active?: PwaTabKey
  onSearch?: () => void
  onSettings?: () => void
}

interface PwaTabDef {
  key: PwaTabKey
  icon: IconProps["name"]
  labelKey: string
  ariaLabelKey: string
}

const TABS: PwaTabDef[] = [
  { key: "sessions", icon: "bubble-5", labelKey: "pwa.tab.sessions", ariaLabelKey: "pwa.tab.sessions.ariaLabel" },
  { key: "search", icon: "magnifying-glass", labelKey: "pwa.tab.search", ariaLabelKey: "pwa.tab.search.ariaLabel" },
  { key: "settings", icon: "settings-gear", labelKey: "pwa.tab.settings", ariaLabelKey: "pwa.tab.settings.ariaLabel" },
]

export const PwaTabBar: Component<PwaTabBarProps> = (props) => {
  const language = useLanguage()
  const location = useLocation()
  const navigate = useNavigate()

  const active = () => props.active ?? resolveActiveTab(location.pathname)

  const onSelect = (tab: PwaTabDef) => {
    if (tab.key === "sessions") {
      if (location.pathname !== "/") navigate("/")
      return
    }
    if (tab.key === "search") {
      props.onSearch?.()
      return
    }
    props.onSettings?.()
  }

  return (
    <nav class="pwa-tab-bar" aria-label={language.t("pwa.tab.bar.ariaLabel")}>
      <For each={TABS}>
        {(tab) => (
          <button
            type="button"
            class="pwa-tab-bar__item"
            data-active={active() === tab.key ? "" : undefined}
            aria-current={active() === tab.key ? "page" : undefined}
            aria-label={language.t(tab.ariaLabelKey)}
            onClick={() => onSelect(tab)}
          >
            <Icon name={tab.icon} />
            <span>{language.t(tab.labelKey)}</span>
          </button>
        )}
      </For>
    </nav>
  )
}
