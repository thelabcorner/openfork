import { Icon } from "@opencode-ai/ui/v2/icon"
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
  labelKey: string
  ariaLabelKey: string
}

const TABS: PwaTabDef[] = [
  { key: "sessions", labelKey: "pwa.tab.sessions", ariaLabelKey: "pwa.tab.sessions.ariaLabel" },
  { key: "search", labelKey: "pwa.tab.search", ariaLabelKey: "pwa.tab.search.ariaLabel" },
  { key: "settings", labelKey: "pwa.tab.settings", ariaLabelKey: "pwa.tab.settings.ariaLabel" },
]

function TabIcon(props: { tab: PwaTabKey }) {
  if (props.tab === "sessions") {
    return (
      <svg class="pwa-tab-bar__bubble" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M18.3327 9.99935C18.3327 5.57227 15.0919 2.91602 9.99935 2.91602C4.90676 2.91602 1.66602 5.57227 1.66602 9.99935C1.66602 11.1487 2.45505 13.1006 2.57637 13.3939C2.58707 13.4197 2.59766 13.4434 2.60729 13.4697C2.69121 13.6987 3.04209 14.9354 1.66602 16.7674C3.51787 17.6528 5.48453 16.1973 5.48453 16.1973C6.84518 16.9193 8.46417 17.0827 9.99935 17.0827C15.0919 17.0827 18.3327 14.4264 18.3327 9.99935Z"
          stroke="currentColor"
          stroke-linecap="square"
        />
      </svg>
    )
  }

  return <Icon name={props.tab === "search" ? "magnifying-glass" : "settings-gear"} />
}

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
      <div class="pwa-tab-bar__dock">
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
              <span class="pwa-tab-bar__icon">
                <TabIcon tab={tab.key} />
              </span>
              <span class="pwa-tab-bar__label">{language.t(tab.labelKey)}</span>
            </button>
          )}
        </For>
      </div>
    </nav>
  )
}
