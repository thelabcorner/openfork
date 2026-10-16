import { Component, createEffect, createMemo, createSignal, lazy, onMount, Show, startTransition, type Accessor } from "solid-js"
import { useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { SettingsDevicesV2 } from "./devices"
import { SettingsOxpV2 } from "./oxp"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLayout } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { normalizeSettingsTab, useSettingsNavigation, type SettingsTab } from "./navigation"
import { normalizeSettingsSection, settingsSectionQuery, type SettingsSection } from "./sections"
import { SettingsSubnav } from "./subnav"

const SettingsSpecialAgentsV2 = lazy(() => import("./special-agents"))
const SettingsWakaTimeV2 = lazy(() => import("./wakatime"))
const SettingsTelegramV2 = lazy(() => import("./telegram"))

type SettingsViewProps = {
  tab: Accessor<SettingsTab>
  setTab: (value: SettingsTab) => void
  section: Accessor<SettingsSection | undefined>
  setSection: (value: SettingsSection) => void
  directory: Accessor<string | undefined>
  sessionID?: string
  onClose?: () => void
  onProviderBack: () => void
}

const SettingsView: Component<SettingsViewProps> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()

  createEffect(() => {
    if (props.tab() === "oxp" && !platform.oxp) props.setTab("general")
  })

  return (
    <TabsV2
      orientation="vertical"
      variant="settings"
      value={props.tab()}
      onChange={(value) => void startTransition(() => props.setTab(normalizeSettingsTab(value)))}
      class="settings-v2"
    >
      <TabsV2.List>
        <div class="flex flex-col justify-between h-full w-full">
          <div class="flex flex-col gap-3 w-full">
            {props.onClose && (
              <button type="button" class="settings-v2-back" onClick={props.onClose}>
                <Icon name="arrow-left" size="small" />
                <span>{language.t("settings.backToApp")}</span>
              </button>
            )}
            <div class="flex flex-col gap-3">
              <div class="flex flex-col gap-1.5">
                <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                <div class="flex flex-col gap-1.5 w-full">
                  <TabsV2.Trigger value="general">
                     <Icon name="sliders" />
                     {language.t("settings.tab.general")}
                     <span class="settings-v2-parent-chevron" aria-hidden="true">⌄</span>
                   </TabsV2.Trigger>
                   <SettingsSubnav tab="general" parentLabel={language.t("settings.tab.general")}
                     activeTab={props.tab} section={props.section} setSection={props.setSection} />
                  <TabsV2.Trigger value="shortcuts">
                    <Icon name="keyboard" />
                    {language.t("settings.tab.shortcuts")}
                  </TabsV2.Trigger>
                  <Show when={platform.oxp}>
                    <TabsV2.Trigger value="oxp">
                       <Icon name="link" />
                       {language.t("settings.oxp.nav")}
                       <span class="settings-v2-parent-chevron" aria-hidden="true">⌄</span>
                     </TabsV2.Trigger>
                     <SettingsSubnav tab="oxp" parentLabel={language.t("settings.oxp.nav")}
                       activeTab={props.tab} section={props.section} setSection={props.setSection} />
                  </Show>
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                <div class="flex flex-col gap-1.5 w-full">
                  <TabsV2.Trigger value="servers">
                    <Icon name="server" />
                    {language.t("status.popover.tab.servers")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="providers">
                    <Icon name="providers" />
                    {language.t("settings.providers.title")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="models">
                    <Icon name="models" />
                    {language.t("settings.models.title")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="special-agents">
                    <Icon name="brain" />
                    {language.t("settings.specialAgents.nav")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="wakatime">
                    <Icon name="code" />
                    {language.t("settings.wakatime.nav")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="telegram">
                     <Icon name="bubble-5" />
                     Telegram
                     <span class="settings-v2-parent-chevron" aria-hidden="true">⌄</span>
                   </TabsV2.Trigger>
                   <SettingsSubnav tab="telegram" parentLabel="Telegram"
                     activeTab={props.tab} section={props.section} setSection={props.setSection} />
                  <TabsV2.Trigger value="devices">
                    <Icon name="shield" />
                    {language.t("settings.devices.title")}
                  </TabsV2.Trigger>
                </div>
              </div>
            </div>
          </div>
          <div class="settings-v2-nav-footer">
            <span>{language.t("app.name.desktop")}</span>
            <span>v{platform.version}</span>
          </div>
        </div>
      </TabsV2.List>
      <TabsV2.Content value="general" class="settings-v2-panel">
        <SettingsGeneralV2 sessionID={props.sessionID} section={props.section} />
      </TabsV2.Content>
      <TabsV2.Content value="shortcuts" class="settings-v2-panel">
        <SettingsKeybinds v2 />
      </TabsV2.Content>
      <TabsV2.Content value="oxp" class="settings-v2-panel">
        <SettingsOxpV2 section={props.section} />
      </TabsV2.Content>
      <TabsV2.Content value="servers" class="settings-v2-panel">
        <SettingsServersV2 />
      </TabsV2.Content>
      <TabsV2.Content value="providers" class="settings-v2-panel">
        <SettingsProvidersV2 directory={props.directory} onBack={props.onProviderBack} />
      </TabsV2.Content>
      <TabsV2.Content value="models" class="settings-v2-panel">
        <Show when={props.tab() === "models"}>
          <SettingsModelsV2 />
        </Show>
      </TabsV2.Content>
      <TabsV2.Content value="special-agents" class="settings-v2-panel">
        <Show when={props.tab() === "special-agents"}>
          <SettingsSpecialAgentsV2 />
        </Show>
      </TabsV2.Content>
      <TabsV2.Content value="wakatime" class="settings-v2-panel">
        <Show when={props.tab() === "wakatime"}>
          <SettingsWakaTimeV2 />
        </Show>
      </TabsV2.Content>
      <TabsV2.Content value="telegram" class="settings-v2-panel">
        <Show when={props.tab() === "telegram"}>
          <SettingsTelegramV2 section={props.section} />
        </Show>
      </TabsV2.Content>
      <TabsV2.Content value="devices" class="settings-v2-panel">
        <SettingsDevicesV2 />
      </TabsV2.Content>
    </TabsV2>
  )
}

export const DialogSettings: Component<{
  sessionID?: string
  defaultValue?: string
}> = (props) => {
  const dialog = useDialog()
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  const [tab, setActiveTab] = createSignal<SettingsTab>(normalizeSettingsTab(props.defaultValue))
  const [section, setActiveSection] = createSignal<SettingsSection | undefined>(normalizeSettingsSection(tab(), undefined))
  const setTab = (value: SettingsTab) => {
    setActiveTab(value)
    setActiveSection(normalizeSettingsSection(value, undefined))
  }
  const setSection = (value: SettingsSection) => {
    if (normalizeSettingsSection(tab(), value) === value) setActiveSection(value)
  }
  const directory = createMemo(() => {
    const route = layout.route()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return undefined
  })

  const showProviders = () => {
    void dialog.show(() => <DialogSettings sessionID={props.sessionID} defaultValue="providers" />)
  }

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <SettingsView
        tab={tab}
        setTab={setTab}
        section={section}
        setSection={setSection}
        directory={directory}
        sessionID={props.sessionID}
        onProviderBack={showProviders}
      />
    </Dialog>
  )
}

export const SettingsRouteSurface: Component = () => {
  const dialog = useDialog()
  const navigation = useSettingsNavigation()
  const location = useLocation()
  const navigate = useNavigate()
  const [search] = useSearchParams<{ tab?: string; section?: string; directory?: string; session?: string }>()
  const tab = createMemo(() => normalizeSettingsTab(search.tab))
  const section = createMemo(() => normalizeSettingsSection(tab(), search.section))
  const directory = createMemo(() => search.directory)
  let root: HTMLDivElement | undefined

  const setTab = (value: SettingsTab) => {
    const query = settingsSectionQuery(location.search, value)
    navigate(`/settings?${query}`, { replace: true, state: location.state })
  }

  const setSection = (value: SettingsSection) => {
    if (normalizeSettingsSection(tab(), value) !== value) return
    const query = settingsSectionQuery(location.search, tab(), value)
    navigate(`/settings?${query}`, { replace: true, state: location.state })
  }

  const showProviders = () => {
    dialog.close()
    setTab("providers")
  }

  onMount(() => root?.focus({ preventScroll: true }))

  return (
    <div
      ref={root}
      data-testid="settings-screen"
      class="settings-v2-screen"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || dialog.active) return
        event.preventDefault()
        navigation.close()
      }}
    >
      <SettingsView
        tab={tab}
        setTab={setTab}
        section={section}
        setSection={setSection}
        directory={directory}
        sessionID={search.session}
        onClose={navigation.close}
        onProviderBack={showProviders}
      />
    </div>
  )
}
