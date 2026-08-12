import type { ParentProps } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { tabKey, useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"

// Right-click menu for a titlebar tab: Close / close left / right / other / all.
// The anchor is the tab's store key (`id`); the store index is derived at open
// and at select time so "left"/"right" follow full store order, not the
// visible/overflow-filtered order the strip renders.
export function TitlebarTabContextMenu(props: ParentProps<{ id: string }>) {
  const tabs = useTabs()
  const language = useLanguage()
  const index = () => tabs.store.findIndex((item) => tabKey(item) === props.id)
  const count = () => tabs.store.length

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger class="block h-full w-full min-w-0" as="div">
        {props.children}
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content>
          <MenuV2.Item disabled={index() < 0} onSelect={() => tabs.closeTab(index())}>
            {language.t("command.tab.close")}
          </MenuV2.Item>
          <MenuV2.Item disabled={index() <= 0} onSelect={() => tabs.closeTabsLeftOf(index())}>
            {language.t("command.tab.closeLeft")}
          </MenuV2.Item>
          <MenuV2.Item disabled={index() >= count() - 1} onSelect={() => tabs.closeTabsRightOf(index())}>
            {language.t("command.tab.closeRight")}
          </MenuV2.Item>
          <MenuV2.Item disabled={count() <= 1} onSelect={() => tabs.closeOtherTabs(index())}>
            {language.t("command.tab.closeOthers")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => tabs.closeAllTabs()}>
            {language.t("command.tab.closeAll")}
          </MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}
