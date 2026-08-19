import { createResource, For, Show } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { browserHostClient, type BrowserAppearance } from "./browserHostClient"

/**
 * Chrome-style browser menu (vertical dots) in each tab's address bar: DevTools,
 * hard reload, guest appearance (system/light/dark), storage clears, and an
 * Extensions submenu (MV3 extensions loaded into the browser partition, e.g. a
 * bundled uBlock Origin) with enable/disable toggles. All actions are host-level.
 */
export function BrowserChromeMenu(props: { tabId: string }) {
  const language = useLanguage()
  const [extensions, { refetch }] = createResource(
    () => props.tabId,
    (tabId) => browserHostClient.listExtensions(tabId),
  )
  const extensionList = () => extensions() ?? []

  const setAppearance = (appearance: BrowserAppearance) => {
    void browserHostClient.setAppearance(appearance).then(() => void browserHostClient.refreshState())
  }

  return (
    <MenuV2>
      <MenuV2.Trigger
        as="button"
        type="button"
        class="flex size-6 shrink-0 items-center justify-center rounded-[4px] text-v2-text-text-muted transition-colors duration-100 hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
        aria-label={language.t("browser.chrome.menu")}
        data-testid="browser-chrome-menu"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="4" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="8" cy="12" r="1.4" />
        </svg>
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content>
          <MenuV2.Item onSelect={() => void browserHostClient.openDevtools(props.tabId)}>
            {language.t("browser.chrome.devtools")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => void browserHostClient.hardReload(props.tabId)}>
            {language.t("browser.chrome.hardReload")}
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Sub gutter={0} overlap overflowPadding={8}>
            <MenuV2.SubTrigger>{language.t("browser.chrome.appearance")}</MenuV2.SubTrigger>
            <MenuV2.Portal>
              <MenuV2.SubContent>
                <MenuV2.CheckboxItem
                  checked={browserHostClient.state().appearance === "system"}
                  onSelect={() => setAppearance("system")}
                >
                  {language.t("browser.chrome.appearance.system")}
                </MenuV2.CheckboxItem>
                <MenuV2.CheckboxItem
                  checked={browserHostClient.state().appearance === "light"}
                  onSelect={() => setAppearance("light")}
                >
                  {language.t("browser.chrome.appearance.light")}
                </MenuV2.CheckboxItem>
                <MenuV2.CheckboxItem
                  checked={browserHostClient.state().appearance === "dark"}
                  onSelect={() => setAppearance("dark")}
                >
                  {language.t("browser.chrome.appearance.dark")}
                </MenuV2.CheckboxItem>
              </MenuV2.SubContent>
            </MenuV2.Portal>
          </MenuV2.Sub>
          <MenuV2.Separator />
          <MenuV2.Item onSelect={() => void browserHostClient.clearCookies(props.tabId)}>
            {language.t("browser.chrome.clearCookies")}
          </MenuV2.Item>
          <MenuV2.Item onSelect={() => void browserHostClient.clearCache(props.tabId)}>
            {language.t("browser.chrome.clearCache")}
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Sub gutter={0} overlap overflowPadding={8}>
            <MenuV2.SubTrigger>{language.t("browser.chrome.extensions")}</MenuV2.SubTrigger>
            <MenuV2.Portal>
              <MenuV2.SubContent>
                <Show
                  when={extensionList().length > 0}
                  fallback={<MenuV2.Item disabled>{language.t("browser.chrome.extensions.none")}</MenuV2.Item>}
                >
                  <For each={extensionList()}>
                    {(extension) => (
                      <MenuV2.CheckboxItem
                        checked={extension.enabled}
                        onSelect={() =>
                          void browserHostClient
                            .setExtensionEnabled(props.tabId, extension.id, !extension.enabled)
                            .then(() => refetch())
                        }
                      >
                        <span class="min-w-0 flex-1 truncate">{extension.name}</span>
                      </MenuV2.CheckboxItem>
                    )}
                  </For>
                </Show>
              </MenuV2.SubContent>
            </MenuV2.Portal>
          </MenuV2.Sub>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
