import { Icon } from "@opencode-ai/ui/icon"
import { createSignal, Show, type Component, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import "./large-title.css"

const BAR_HEIGHT = 44

export interface PwaLargeTitleBack {
  onClick: () => void
  label?: string
}

export interface PwaLargeTitleProps {
  title: string
  back?: PwaLargeTitleBack
  actions?: JSX.Element
  children: JSX.Element
}

export const PwaLargeTitle: Component<PwaLargeTitleProps> = (props) => {
  const language = useLanguage()
  const [collapsed, setCollapsed] = createSignal(false)
  let scroller: HTMLDivElement | undefined
  let title: HTMLHeadingElement | undefined

  const onScroll = () => {
    if (!scroller || !title) return
    const threshold = title.offsetTop + title.offsetHeight - BAR_HEIGHT
    setCollapsed(scroller.scrollTop >= threshold)
  }

  return (
    <div class="pwa-large-title">
      <div class="pwa-large-title__scroller" ref={scroller} onScroll={onScroll}>
        <div class="pwa-large-title__bar" data-collapsed={collapsed() ? "" : undefined}>
          <Show when={props.back} keyed>
            {(back) => (
              <button
                type="button"
                class="pwa-large-title__back"
                aria-label={back.label ?? language.t("common.goBack")}
                onClick={() => back.onClick()}
              >
                <Icon name="arrow-left" size="small" />
                <Show when={back.label}>
                  <span>{back.label}</span>
                </Show>
              </button>
            )}
          </Show>
          <div class="pwa-large-title__bar-title" data-visible={collapsed() ? "" : undefined} aria-hidden={!collapsed()}>
            {props.title}
          </div>
          <div class="pwa-large-title__actions">{props.actions}</div>
        </div>
        <h1 class="pwa-large-title__title" ref={title}>
          {props.title}
        </h1>
        {props.children}
      </div>
    </div>
  )
}
