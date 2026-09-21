import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import {
  isOxpPlatform,
  type OxpDesktopState,
  type OxpGrant,
  type OxpLifecycle,
} from "@/oxp/platform"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type BusyAction =
  | "enabled"
  | "connection"
  | "root-add"
  | "tunnel-id"
  | "openai-key"
  | "openai-key-reset"
  | "migration"
  | "diagnostics"
  | `root:${string}`
  | `grant:${keyof OxpGrant}`
  | `lifecycle:${keyof OxpLifecycle}`

const activeAugmentationRows = [
  ["read", "settings.oxp.capability.read.title", "settings.oxp.capability.read.description"],
  ["automation", "settings.oxp.capability.automation.title", "settings.oxp.capability.automation.description"],
  ["write", "settings.oxp.capability.write.title", "settings.oxp.capability.write.description"],
  ["process", "settings.oxp.capability.process.title", "settings.oxp.capability.process.description"],
  ["git", "settings.oxp.capability.git.title", "settings.oxp.capability.git.description"],
  ["integrations", "settings.oxp.capability.integrations.title", "settings.oxp.capability.integrations.description"],
  ["browser", "settings.oxp.capability.browser.title", "settings.oxp.capability.browser.description"],
  ["filesReceive", "settings.oxp.capability.filesReceive.title", "settings.oxp.capability.filesReceive.description"],
  ["filesSend", "settings.oxp.capability.filesSend.title", "settings.oxp.capability.filesSend.description"],
] as const

const lifecycleRows = [
  ["autoConnect", "settings.oxp.lifecycle.autoConnect.title", "settings.oxp.lifecycle.autoConnect.description"],
  ["launchAtLogin", "settings.oxp.lifecycle.launchAtLogin.title", "settings.oxp.lifecycle.launchAtLogin.description"],
  ["startHidden", "settings.oxp.lifecycle.startHidden.title", "settings.oxp.lifecycle.startHidden.description"],
  ["closeToTray", "settings.oxp.lifecycle.closeToTray.title", "settings.oxp.lifecycle.closeToTray.description"],
] as const

function connectionLabel(language: ReturnType<typeof useLanguage>, state: OxpDesktopState["tunnel"]["state"]) {
  if (state === "starting") return language.t("settings.oxp.connection.state.starting")
  if (state === "connected") return language.t("settings.oxp.connection.state.connected")
  if (state === "offline") return language.t("settings.oxp.connection.state.offline")
  if (state === "auth-failed") return language.t("settings.oxp.connection.state.authFailed")
  if (state === "unavailable") return language.t("settings.oxp.connection.state.unavailable")
  return language.t("settings.oxp.connection.state.disconnected")
}

function formatWhen(language: ReturnType<typeof useLanguage>, value: number | undefined) {
  if (!value) return language.t("settings.oxp.never")
  return new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }).format(value)
}

export const SettingsOxpV2 = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const api = isOxpPlatform(platform.oxp) ? platform.oxp : undefined
  const [store, setStore] = createStore<{
    state?: OxpDesktopState
    loading: boolean
    error?: string
    busy?: BusyAction
    tunnelID: string
    editingRootID?: string
    rootAlias: string
  }>({
    loading: true,
    tunnelID: "",
    rootAlias: "",
  })
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let tunnelInput: HTMLInputElement | undefined
  let apiKeyInput: HTMLInputElement | undefined

  const apply = (next: OxpDesktopState) => {
    if (disposed) return
    if (store.state && next.stateRevision < store.state.stateRevision) return
    setStore("state", next)
    setStore("error", undefined)
    if (document.activeElement !== tunnelInput) setStore("tunnelID", next.tunnel.tunnelID)
  }

  onMount(() => {
    if (!api) {
      setStore({ loading: false, error: language.t("settings.oxp.unavailable") })
      return
    }
    void api.getState().then(
      (next) => {
        apply(next)
        setStore("loading", false)
      },
      () => {
        if (disposed) return
        setStore({ loading: false, error: language.t("settings.oxp.loadFailed") })
      },
    )
    void Promise.resolve(api.subscribe(apply)).then(
      (stop) => {
        if (disposed) stop()
        else unsubscribe = stop
      },
      (error) => {
        if (disposed) return
        showToast({
          variant: "error",
          title: language.t("settings.oxp.actionFailed"),
          description: error instanceof Error ? error.message : language.t("settings.oxp.loadFailed"),
        })
      },
    )
  })

  onCleanup(() => {
    disposed = true
    unsubscribe?.()
  })

  const run = async (busy: BusyAction, action: () => Promise<OxpDesktopState>) => {
    if (!api || store.busy) return false
    setStore("busy", busy)
    try {
      apply(await action())
      return true
    } catch (error) {
      try {
        apply(await api.getState())
      } catch {
        // Keep the original action error visible; best-effort refresh only
        // prevents stale renderer projections from hiding recovery affordances.
      }
      showToast({
        variant: "error",
        title: language.t("settings.oxp.actionFailed"),
        description: error instanceof Error ? error.message : undefined,
      })
      return false
    } finally {
      if (!disposed) setStore("busy", undefined)
    }
  }

  const state = () => store.state
  const connectionActive = createMemo(() => {
    const value = state()?.tunnel.state
    return value === "starting" || value === "connected" || value === "offline"
  })
  const capabilityCount = createMemo(() => {
    const grant = state()?.grant
    if (!grant) return 0
    return activeAugmentationRows.reduce((count, [key]) => count + Number(grant[key] === true), 0)
  })
  const agentSupportCount = createMemo(() => {
    const grant = state()?.grant
    if (!grant) return 0
    return (
      Number(grant.sessionSupervision !== "none") +
      Number(grant.requestSupervision) +
      Number(grant.delegation !== "disabled") +
      Number(grant.nestedDelegation)
    )
  })


  const setGrant = (key: keyof OxpGrant, value: boolean) => {
    const current = state()
    if (!api || !current) return
    const patch: Partial<OxpGrant> = {}
    if (key === "sessionSupervision") {
      patch.sessionSupervision = value ? "approved-roots" : "none"
      if (!value) patch.requestSupervision = false
    } else if (key === "delegation") {
      patch.delegation = value ? "spawn" : "disabled"
      if (!value) patch.nestedDelegation = false
    }
    else Object.assign(patch, { [key]: value })
    void run(`grant:${key}`, () => api.setGrant(patch))
  }

  const setLifecycle = (key: keyof OxpLifecycle, value: boolean) => {
    if (!api) return
    void run(`lifecycle:${key}`, () => api.setLifecycle({ [key]: value }))
  }


  const saveTunnelID = () => {
    if (!api) return
    const value = store.tunnelID.trim()
    if (value === state()?.tunnel.tunnelID) return
    void run("tunnel-id", () => api.setTunnelID(value))
  }

  const saveApiKey = () => {
    if (!api || !apiKeyInput) return
    const secureStorage = state()?.secureStorage
    if (!secureStorage?.available || secureStorage.credentialState === "unreadable") return
    const value = apiKeyInput.value.trim()
    if (!value) return
    apiKeyInput.value = ""
    void run("openai-key", () => api.setOpenAiApiKey(value)).then((saved) => {
      if (saved) showToast({ variant: "success", icon: "check", title: language.t("settings.oxp.openai.apiKeySaved") })
    })
  }

  const resetUnreadableCredentialStore = () => {
    if (!api) return
    void run("openai-key-reset", () => api.resetUnreadableCredentialStore()).then((reset) => {
      if (reset) {
        showToast({
          variant: "success",
          icon: "check",
          title: language.t("settings.oxp.openai.apiKey.resetSuccess"),
        })
      }
    })
  }

  const manualImportLocalMcp = () => {
    if (!api) return
    void run("migration", () => api.importLocalMcp()).then((imported) => {
      if (imported) {
        showToast({
          variant: "success",
          icon: "check",
          title: language.t("settings.oxp.migration.importedToast"),
        })
      }
    })
  }

  const autoImportLocalMcp = () => {
    if (!api) return
    void run("migration", () => api.autoImportLocalMcp()).then((imported) => {
      if (imported) {
        showToast({
          variant: "success",
          icon: "check",
          title: language.t("settings.oxp.migration.importedToast"),
        })
      }
    })
  }

  const retireLocalMcp = () => {
    if (!api) return
    void run("migration", () => api.retireLocalMcp()).then((retired) => {
      if (retired) {
        showToast({
          variant: "success",
          icon: "check",
          title: language.t("settings.oxp.migration.retiredToast"),
        })
      }
    })
  }

  const editRoot = (rootID: string, alias: string) => {
    setStore("editingRootID", rootID)
    setStore("rootAlias", alias)
  }

  const cancelRootEdit = () => {
    setStore("editingRootID", undefined)
    setStore("rootAlias", "")
  }

  const saveRootAlias = (rootID: string) => {
    if (!api) return
    const alias = store.rootAlias.trim()
    if (!alias) return
    void run(`root:${rootID}`, () => api.renameRoot(rootID, alias)).then((saved) => {
      if (saved) cancelRootEdit()
    })
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-oxp-header">
        <div class="settings-v2-tab-header-row">
          <div class="settings-v2-oxp-title-group">
            <h2 class="settings-v2-tab-title">{language.t("settings.oxp.title")}</h2>
            <Tag variant="accent">{language.t("settings.oxp.badge")}</Tag>
          </div>
          <Show when={state()}>
            {(current) => (
              <div class="settings-v2-oxp-master-toggle">
                <span>{language.t("settings.oxp.enabled")}</span>
                <Switch
                  checked={current().enabled}
                  disabled={!!store.busy}
                  onChange={(enabled) => api && void run("enabled", () => api.setEnabled(enabled))}
                />
              </div>
            )}
          </Show>
        </div>
        <p class="settings-v2-oxp-intro">{language.t("settings.oxp.description")}</p>
      </div>

      <div class="settings-v2-tab-body settings-v2-oxp">
        <Show when={!store.loading} fallback={<div class="settings-v2-oxp-loading"><Spinner class="size-4" />{language.t("common.loading")}</div>}>
          <Show when={state()} fallback={<div class="settings-v2-oxp-error"><Icon name="warning" />{store.error ?? language.t("settings.oxp.loadFailed")}</div>}>
            {(current) => (
              <>
                <section class="settings-v2-oxp-hero" data-state={current().tunnel.state}>
                  <div class="settings-v2-oxp-hero-main">
                    <div class="settings-v2-oxp-status-mark" aria-hidden="true">
                      <span class="settings-v2-oxp-status-dot" />
                      <Icon name="globe" size="large" />
                    </div>
                    <div class="settings-v2-oxp-hero-copy">
                      <div class="settings-v2-oxp-hero-eyebrow">{language.t("settings.oxp.connection.title")}</div>
                      <div class="settings-v2-oxp-hero-title">{connectionLabel(language, current().tunnel.state)}</div>
                      <div class="settings-v2-oxp-hero-detail">
                        {current().tunnel.detail ?? language.t("settings.oxp.connection.defaultDetail")}
                      </div>
                    </div>
                  </div>
                  <ButtonV2
                    size="small"
                    variant={connectionActive() ? "outline" : "contrast"}
                    disabled={!current().enabled || store.busy === "connection"}
                    onClick={() => api && void run("connection", () => (connectionActive() ? api.disconnect() : api.connect()))}
                  >
                    {store.busy === "connection"
                      ? language.t("settings.oxp.connection.working")
                      : connectionActive()
                        ? language.t("settings.oxp.connection.disconnect")
                        : language.t("settings.oxp.connection.connect")}
                  </ButtonV2>
                  <div class="settings-v2-oxp-hero-stats">
                    <div><strong>{current().roots.length}</strong><span>{language.t("settings.oxp.stat.folders")}</span></div>
                          <div><strong>{capabilityCount()}/{activeAugmentationRows.length}</strong><span>{language.t("settings.oxp.stat.capabilities")}</span></div>
                    <div><strong>{agentSupportCount()}/4</strong><span>{language.t("settings.oxp.stat.agentSupport")}</span></div>
                    <div><strong>{current().metrics.calls.toLocaleString()}</strong><span>{language.t("settings.oxp.stat.calls")}</span></div>
                  </div>
                </section>

                <div class="settings-v2-section">
                  <div class="settings-v2-oxp-section-heading">
                    <div>
                      <h3 class="settings-v2-section-title">{language.t("settings.oxp.folders.title")}</h3>
                      <p>{language.t("settings.oxp.folders.description")}</p>
                    </div>
                    <ButtonV2
                      size="small"
                      variant="outline"
                      icon="folder-add-left"
                      disabled={!!store.busy}
                      onClick={() => api && void run("root-add", () => api.addRoot())}
                    >
                      {language.t("settings.oxp.folders.add")}
                    </ButtonV2>
                  </div>
                  <Show
                    when={current().roots.length > 0}
                    fallback={<div class="settings-v2-oxp-empty"><Icon name="folder" /><strong>{language.t("settings.oxp.folders.empty")}</strong><span>{language.t("settings.oxp.folders.emptyDescription")}</span></div>}
                  >
                    <SettingsListV2>
                      <For each={current().roots}>
                        {(root) => (
                          <div class="settings-v2-oxp-root-row">
                            <div class="settings-v2-oxp-root-lead">
                              <span class="settings-v2-oxp-root-status" data-available={root.available ? "true" : "false"} />
                              <div class="settings-v2-oxp-root-copy">
                                <Show
                                  when={store.editingRootID === root.id}
                                  fallback={
                                    <div class="flex min-w-0 items-center gap-2">
                                      <span class="settings-v2-oxp-root-name">/{root.alias}</span>
                                      <Show when={root.managedByProject}>
                                        <Tag>{language.t("settings.oxp.folders.projectManaged")}</Tag>
                                      </Show>
                                    </div>
                                  }
                                >
                                  <div class="settings-v2-oxp-root-editor">
                                    <span aria-hidden="true">/</span>
                                    <TextInputV2
                                      type="text"
                                      appearance="base"
                                      value={store.rootAlias}
                                      onInput={(event) => setStore("rootAlias", event.currentTarget.value)}
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter") saveRootAlias(root.id)
                                        if (event.key === "Escape") cancelRootEdit()
                                      }}
                                      spellcheck={false}
                                      autocorrect="off"
                                      autocomplete="off"
                                      autocapitalize="off"
                                      aria-label={language.t("settings.oxp.folders.alias")}
                                    />
                                    <ButtonV2 size="small" variant="outline" disabled={!!store.busy} onClick={() => saveRootAlias(root.id)}>
                                      {language.t("common.save")}
                                    </ButtonV2>
                                    <ButtonV2 size="small" variant="ghost-muted" disabled={!!store.busy} onClick={cancelRootEdit}>
                                      {language.t("common.cancel")}
                                    </ButtonV2>
                                  </div>
                                </Show>
                                <bdi class="settings-v2-oxp-root-path" dir="auto">{root.path}</bdi>
                              </div>
                            </div>
                            <div class="settings-v2-oxp-root-actions">
                              <IconButtonV2
                                type="button"
                                size="small"
                                variant="ghost-muted"
                                icon={<Icon name="edit" size="small" />}
                                aria-label={language.t("settings.oxp.folders.rename")}
                                title={language.t("settings.oxp.folders.rename")}
                                disabled={!!store.busy}
                                onClick={() => editRoot(root.id, root.alias)}
                              />
                              <IconButtonV2
                                type="button"
                                size="small"
                                variant="ghost-muted"
                                icon={<Icon name="folder" size="small" />}
                                aria-label={language.t("settings.oxp.folders.reveal")}
                                title={language.t("settings.oxp.folders.reveal")}
                                onClick={() => void api?.revealRoot(root.id)}
                              />
                              <IconButtonV2
                                type="button"
                                size="small"
                                variant="ghost-muted"
                                icon={<Icon name="trash" size="small" class="!text-v2-state-fg-danger" />}
                                aria-label={root.managedByProject ? language.t("settings.oxp.folders.projectManaged") : language.t("settings.oxp.folders.remove")}
                                title={root.managedByProject ? language.t("settings.oxp.folders.projectManagedDescription") : language.t("settings.oxp.folders.remove")}
                                disabled={!!store.busy || root.managedByProject}
                                onClick={() => api && void run(`root:${root.id}`, () => api.removeRoot(root.id))}
                              />
                            </div>
                          </div>
                        )}
                      </For>
                    </SettingsListV2>
                  </Show>
                </div>

                <div class="settings-v2-section">
                  <div class="settings-v2-oxp-section-heading">
                    <div>
                      <h3 class="settings-v2-section-title">{language.t("settings.oxp.capabilities.title")}</h3>
                      <p>{language.t("settings.oxp.capabilities.description")}</p>
                    </div>
                  </div>
                  <SettingsListV2>
                    <For each={activeAugmentationRows}>
                      {([key, title, description]) => (
                        <SettingsRowV2 title={language.t(title)} description={language.t(description)}>
                          <Switch
                            checked={current().grant[key] === true}
                            disabled={!!store.busy}
                            onChange={(value) => setGrant(key, value)}
                          />
                        </SettingsRowV2>
                      )}
                    </For>
                  </SettingsListV2>
                </div>

                <div class="settings-v2-section">
                  <div class="settings-v2-oxp-section-heading">
                    <div>
                      <h3 class="settings-v2-section-title">{language.t("settings.oxp.migration.title")}</h3>
                      <p>{language.t("settings.oxp.migration.description")}</p>
                    </div>
                    <Show when={current().migration.imported}>
                      <Tag>
                        {current().migration.retired
                          ? language.t("settings.oxp.migration.state.retired")
                          : language.t("settings.oxp.migration.state.imported")}
                      </Tag>
                    </Show>
                  </div>
                  <SettingsListV2>
                    <SettingsRowV2
                      title={language.t("settings.oxp.migration.import.title")}
                      description={language.t("settings.oxp.migration.import.description")}
                    >
                      <div class="flex items-center gap-2">
                        <ButtonV2
                          size="small"
                          variant="contrast"
                          disabled={!!store.busy}
                          onClick={autoImportLocalMcp}
                        >
                          {language.t("settings.oxp.migration.import.auto")}
                        </ButtonV2>
                        <ButtonV2
                          size="small"
                          variant="outline"
                          disabled={!!store.busy}
                          onClick={manualImportLocalMcp}
                        >
                          {language.t("settings.oxp.migration.import.manual")}
                        </ButtonV2>
                      </div>
                    </SettingsRowV2>
                    <SettingsRowV2
                      title={language.t("settings.oxp.migration.retire.title")}
                      description={
                        current().migration.retired
                          ? language.t("settings.oxp.migration.retire.retired")
                          : current().migration.canRetire
                            ? language.t("settings.oxp.migration.retire.ready")
                            : language.t("settings.oxp.migration.retire.blocked")
                      }
                    >
                      <ButtonV2
                        size="small"
                        variant="outline"
                        disabled={!!store.busy || !current().migration.canRetire}
                        onClick={retireLocalMcp}
                      >
                        {language.t("settings.oxp.migration.retire.action")}
                      </ButtonV2>
                    </SettingsRowV2>
                  </SettingsListV2>
                </div>

                <div class="settings-v2-section">
                  <div class="settings-v2-oxp-section-heading">
                    <div>
                      <h3 class="settings-v2-section-title">{language.t("settings.oxp.agentSupport.title")}</h3>
                      <p>{language.t("settings.oxp.agentSupport.description")}</p>
                    </div>
                  </div>
                  <SettingsListV2>
                    <SettingsRowV2 title={language.t("settings.oxp.agentSupport.sessions.title")} description={language.t("settings.oxp.agentSupport.sessions.description")}>
                      <Switch
                        checked={current().grant.sessionSupervision !== "none"}
                        disabled={!!store.busy}
                        onChange={(value) => setGrant("sessionSupervision", value)}
                      />
                    </SettingsRowV2>
                    <SettingsRowV2 title={language.t("settings.oxp.agentSupport.requests.title")} description={language.t("settings.oxp.agentSupport.requests.description")}>
                      <Switch
                        checked={current().grant.requestSupervision}
                        disabled={!!store.busy || current().grant.sessionSupervision === "none"}
                        onChange={(value) => setGrant("requestSupervision", value)}
                      />
                    </SettingsRowV2>
                    <SettingsRowV2 title={language.t("settings.oxp.agentSupport.delegation.title")} description={language.t("settings.oxp.agentSupport.delegation.description")}>
                      <Switch
                        checked={current().grant.delegation !== "disabled"}
                        disabled={!!store.busy}
                        onChange={(value) => setGrant("delegation", value)}
                      />
                    </SettingsRowV2>

                    <SettingsRowV2 title={language.t("settings.oxp.agentSupport.nested.title")} description={language.t("settings.oxp.agentSupport.nested.description")}>
                      <Switch
                        checked={current().grant.nestedDelegation}
                        disabled={!!store.busy || current().grant.delegation === "disabled"}
                        onChange={(value) => setGrant("nestedDelegation", value)}
                      />
                    </SettingsRowV2>
                  </SettingsListV2>
                </div>

                <div class="settings-v2-section">
                  <div class="settings-v2-oxp-section-heading">
                    <div>
                      <h3 class="settings-v2-section-title">{language.t("settings.oxp.tunnel.title")}</h3>
                      <p>{language.t("settings.oxp.tunnel.description")}</p>
                    </div>
                    <Tag>{current().endpoint.state === "ready" ? language.t("settings.oxp.endpoint.ready") : language.t("settings.oxp.endpoint.notReady")}</Tag>
                  </div>
                  <SettingsListV2>
                    <SettingsRowV2 title={language.t("settings.oxp.tunnel.id.title")} description={language.t("settings.oxp.tunnel.id.description")}>
                      <div class="settings-v2-oxp-field-actions">
                        <TextInputV2
                          ref={tunnelInput}
                          type="text"
                          appearance="base"
                          value={store.tunnelID}
                          onInput={(event) => setStore("tunnelID", event.currentTarget.value)}
                          onKeyDown={(event) => event.key === "Enter" && saveTunnelID()}
                          placeholder={language.t("settings.oxp.tunnel.id.placeholder")}
                          spellcheck={false}
                          autocorrect="off"
                          autocomplete="off"
                          autocapitalize="off"
                          aria-label={language.t("settings.oxp.tunnel.id.title")}
                        />
                        <ButtonV2 size="small" variant="outline" disabled={!!store.busy} onClick={saveTunnelID}>
                          {language.t("common.save")}
                        </ButtonV2>
                      </div>
                    </SettingsRowV2>
                    <SettingsRowV2
                      title={language.t("settings.oxp.openai.apiKey.title")}
                      description={
                        !current().secureStorage.available
                          ? current().secureStorage.detail ?? language.t("settings.oxp.openai.apiKey.unavailable")
                          : current().secureStorage.credentialState === "unreadable"
                            ? language.t("settings.oxp.openai.apiKey.unreadable")
                            : language.t("settings.oxp.openai.apiKey.description")
                      }
                    >
                      <div class="settings-v2-oxp-key-control">
                        <div class="settings-v2-oxp-field-actions">
                          <TextInputV2
                            ref={apiKeyInput}
                            type="password"
                            appearance="base"
                            placeholder={
                              current().openai.apiKeyPresent
                                ? language.t("settings.oxp.openai.apiKey.replacePlaceholder")
                                : language.t("settings.oxp.openai.apiKey.placeholder")
                            }
                            disabled={!current().secureStorage.available}
                            autocomplete="off"
                            spellcheck={false}
                            aria-label={language.t("settings.oxp.openai.apiKey.title")}
                            onKeyDown={(event) => event.key === "Enter" && saveApiKey()}
                          />
                          <ButtonV2
                            size="small"
                            variant="outline"
                            disabled={
                              !!store.busy ||
                              !current().secureStorage.available ||
                              current().secureStorage.credentialState === "unreadable"
                            }
                            onClick={saveApiKey}
                          >
                            {language.t("common.save")}
                          </ButtonV2>
                        </div>
                        <Show when={current().secureStorage.available && current().secureStorage.credentialState === "unreadable"}>
                          <button
                            class="settings-v2-oxp-clear-key"
                            type="button"
                            disabled={!!store.busy}
                            onClick={resetUnreadableCredentialStore}
                          >
                            {language.t("settings.oxp.openai.apiKey.reset")}
                          </button>
                        </Show>
                        <Show when={current().openai.apiKeyPresent}>
                          <button class="settings-v2-oxp-clear-key" type="button" disabled={!!store.busy} onClick={() => api && void run("openai-key", () => api.clearOpenAiApiKey())}>
                            {language.t("settings.oxp.openai.apiKey.clear")}
                          </button>
                        </Show>
                      </div>
                    </SettingsRowV2>
                  </SettingsListV2>
                </div>

                <div class="settings-v2-section">
                  <div class="settings-v2-oxp-section-heading">
                    <div>
                      <h3 class="settings-v2-section-title">{language.t("settings.oxp.lifecycle.title")}</h3>
                      <p>{language.t("settings.oxp.lifecycle.description")}</p>
                    </div>
                  </div>
                  <SettingsListV2>
                    <For each={lifecycleRows}>
                      {([key, title, description]) => (
                        <SettingsRowV2 title={language.t(title)} description={language.t(description)}>
                          <Switch
                            checked={current().lifecycle[key]}
                            disabled={!!store.busy}
                            onChange={(value) => setLifecycle(key, value)}
                          />
                        </SettingsRowV2>
                      )}
                    </For>
                  </SettingsListV2>
                </div>

                <div class="settings-v2-section">
                  <div class="settings-v2-oxp-section-heading">
                    <div>
                      <h3 class="settings-v2-section-title">{language.t("settings.oxp.activity.title")}</h3>
                      <p>{language.t("settings.oxp.activity.description")}</p>
                    </div>
                    <Show when={api?.exportDiagnostics}>
                      <ButtonV2
                        size="small"
                        variant="outline"
                        icon="download"
                        disabled={!!store.busy}
                        onClick={() => {
                          const exportDiagnostics = api?.exportDiagnostics
                          if (!exportDiagnostics) return
                          setStore("busy", "diagnostics")
                          void exportDiagnostics()
                            .then(() =>
                              showToast({
                                variant: "success",
                                icon: "check",
                                title: language.t("settings.oxp.activity.exported"),
                              }),
                            )
                            .catch(() =>
                              showToast({
                                variant: "error",
                                title: language.t("settings.oxp.actionFailed"),
                              }),
                            )
                            .finally(() => !disposed && setStore("busy", undefined))
                        }}
                      >
                        {language.t("settings.oxp.activity.export")}
                      </ButtonV2>
                    </Show>
                  </div>
                  <div class="settings-v2-oxp-diagnostics">
                    <div><span>{language.t("settings.oxp.activity.handshake")}</span><strong>{formatWhen(language, current().tunnel.lastHandshakeAt)}</strong></div>
                    <div><span>{language.t("settings.oxp.activity.lastRequest")}</span><strong>{formatWhen(language, current().metrics.lastRequestAt)}</strong></div>
                    <div><span>{language.t("settings.oxp.activity.lastOperation")}</span><strong>{formatWhen(language, current().metrics.lastOperationAt)}</strong></div>
                    <div><span>{language.t("settings.oxp.activity.failures")}</span><strong>{current().metrics.failures.toLocaleString()}</strong></div>
                  </div>
                </div>
              </>
            )}
          </Show>
        </Show>
      </div>
    </>
  )
}
