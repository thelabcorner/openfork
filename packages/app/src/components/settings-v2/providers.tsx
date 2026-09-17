import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { showToast } from "@/utils/toast"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { useProviderSettings } from "@/hooks/use-provider-settings"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  type Accessor,
  type Component,
  For,
  onCleanup,
  Show,
} from "solid-js"
import { createStore } from "solid-js/store"
import type { ConnectionCredentialInfo, IntegrationInfo } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useServerProtocol, useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { DialogConnectProvider, useProviderConnectController } from "../dialog-connect-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { SettingsListV2 } from "./parts/list"
import { activeCredentialAccount, credentialAccounts } from "./provider-accounts"
import "./settings-v2.css"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = {
  id: string
  name: string
  source: ProviderSource
  connected: boolean
  hasPaidModels: boolean
}

const PROVIDER_NOTES = [
  { match: (id: string) => id === "opencode", key: "dialog.provider.opencode.note" },
  { match: (id: string) => id === "opencode-go", key: "dialog.provider.opencodeGo.tagline" },
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

const PROVIDER_ICON_SIZE = 16
const EMPTY_INTEGRATIONS = new Map<string, IntegrationInfo>()

export const SettingsProvidersV2: Component<{
  directory: Accessor<string | undefined>
  onBack?: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const protocol = useServerProtocol()
  const serverSync = useServerSync()
  const providers = useProviders(props.directory)
  const providerSettings = useProviderSettings({ enabled: () => !props.directory() })
  const providerConnect = useProviderConnectController({ onBack: props.onBack })

  const connect = (provider?: string) => {
    providerConnect.select(provider)
    void dialog.show(() => <DialogConnectProvider directory={props.directory} controller={providerConnect} />)
  }

  const items = createMemo<ProviderItem[]>(() => {
    if (!props.directory()) return providerSettings.data().providers
    const connected = new Set(providers.connected().map((provider) => provider.id))
    return [...providers.all().values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: provider.source,
      connected: connected.has(provider.id),
      hasPaidModels: Object.values(provider.models).some((model) => (model.cost?.input ?? 0) > 0),
    }))
  })
  const connected = createMemo(() => items().filter((provider) => provider.connected && (provider.id !== "opencode" || provider.hasPaidModels)))

  const integrationRequest = createMemo(() => {
    if (protocol() !== "v2") return
    const directory = props.directory()
    if (!directory) return
    const ids = connected().map((provider) => provider.id)
    return { ids, directory }
  })
  const [integrations, integrationActions] = createResource(
    integrationRequest,
    async ({ ids, directory }) => {
      const entries = await Promise.all(
        ids.map(async (providerID) => {
          const info = await serverSdk()
            .api.integration.get({ integrationID: providerID, location: { directory } })
            .then((result) => result.data)
            .catch(() => undefined)
          return info ? ([providerID, info] as const) : undefined
        }),
      )
      return new Map(entries.filter((entry): entry is readonly [string, IntegrationInfo] => entry !== undefined))
    },
    { initialValue: EMPTY_INTEGRATIONS },
  )

  createEffect(() => {
    if (protocol() !== "v2") return
    const unsub = serverSdk().event.listen((envelope) => {
      if (envelope.details.type !== "integration.connection.updated") return
      if (props.directory()) void integrationActions.refetch()
      else void providerSettings.refresh()
    })
    onCleanup(unsub)
  })

  const integration = (providerID: string) => (integrations.latest ?? EMPTY_INTEGRATIONS).get(providerID)
  const connections = (providerID: string) =>
    props.directory() ? (integration(providerID)?.connections ?? []) : (providerSettings.get(providerID)?.connections ?? [])
  const accounts = (providerID: string) => credentialAccounts(connections(providerID))
  const activeAccount = (providerID: string) => activeCredentialAccount(connections(providerID))
  const canAddAccount = (providerID: string) => {
    if (!props.directory()) return protocol() === "v2"
    return integration(providerID)?.methods.some((method) => method.type !== "env") ?? false
  }
  const refreshAccounts = async () => {
    if (!props.directory()) {
      await providerSettings.refresh()
      return
    }
    await Promise.allSettled([integrationActions.refetch(), serverSync().refreshProviders()])
  }

  const mutateAccount = async (run: () => Promise<unknown>) => {
    const result = await run()
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }))
    if (!result.ok) {
      const message = result.error instanceof Error ? result.error.message : String(result.error)
      showToast({ title: language.t("common.requestFailed"), description: message })
      return false
    }
    await refreshAccounts()
    return true
  }

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    const result = items()
      .filter((p) => popularProviders.includes(p.id))
      .filter((p) => !connectedIDs.has(p.id))
      .slice()
    result.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))
    return result
  })

  const source = (item: ProviderItem): ProviderSource | undefined => {
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      if (isConfigCustom(item.id)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => protocol() === "v1" && source(item) !== "env"

  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

  const isConfigCustom = (providerID: string) => {
    const provider = serverSync().data.config.provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  const disableProvider = async (providerID: string, name: string) => {
    if (protocol() !== "v1") return
    const before = serverSync().data.config.disabled_providers ?? []
    const next = before.includes(providerID) ? before : [...before, providerID]
    serverSync().set("config", "disabled_providers", next)

    await serverSync()
      .updateConfig({ disabled_providers: next })
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        serverSync().set("config", "disabled_providers", before)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const disconnect = async (providerID: string, name: string) => {
    if (isConfigCustom(providerID)) {
      await serverSdk()
        .client.auth.remove({ providerID })
        .catch(() => undefined)
      await disableProvider(providerID, name)
      return
    }
    await serverSdk()
      .client.auth.remove({ providerID })
      .then(async () => {
        await serverSdk().client.global.dispose()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const selectAccount = (credential: ConnectionCredentialInfo) =>
    mutateAccount(() =>
      props.directory()
        ? serverSdk().client.v2.credential.select(
            { credentialID: credential.id, location: { directory: props.directory()! } },
            { throwOnError: true },
          )
        : providerSettings.credential.select(credential.id),
    )

  const renameAccount = (credential: ConnectionCredentialInfo) =>
    dialog.show(() => (
      <DialogRenameProviderAccount
        credential={credential}
        onSave={(label) =>
          mutateAccount(() =>
            props.directory()
              ? serverSdk().client.v2.credential.update(
                  { credentialID: credential.id, label, location: { directory: props.directory()! } },
                  { throwOnError: true },
                )
              : providerSettings.credential.update(credential.id, label),
          )
        }
      />
    ))

  const removeAccount = (provider: ProviderItem, credential: ConnectionCredentialInfo) =>
    dialog.show(() => (
      <DialogRemoveProviderAccount
        provider={provider.name}
        credential={credential}
        onRemove={() =>
          mutateAccount(() =>
            props.directory()
              ? serverSdk().client.v2.credential.remove(
                  { credentialID: credential.id, location: { directory: props.directory()! } },
                  { throwOnError: true },
                )
              : providerSettings.credential.remove(credential.id),
          )
        }
      />
    ))

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.providers.title")}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-providers">
        <div class="settings-v2-section" data-component="connected-providers-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.connected")}</h3>
          <SettingsListV2>
            <Show
              when={connected().length > 0}
              fallback={
                <div class="settings-v2-provider-empty">{language.t("settings.providers.connected.empty")}</div>
              }
            >
              <For each={connected()}>
                {(item) => {
                  const providerAccounts = () => accounts(item.id)
                  const active = () => activeAccount(item.id)
                  const accountReady = () =>
                    protocol() === "v2" &&
                    (props.directory() ? integration(item.id) !== undefined : providerSettings.get(item.id) !== undefined)
                  return (
                    <div class="settings-v2-provider-group">
                      <div class="settings-v2-provider-row settings-v2-provider-row--header group">
                        <div class="settings-v2-provider-lead">
                          <ProviderIcon
                            id={item.id}
                            width={PROVIDER_ICON_SIZE}
                            height={PROVIDER_ICON_SIZE}
                            class="settings-v2-provider-icon shrink-0"
                          />
                          <div class="settings-v2-provider-main">
                            <span class="settings-v2-provider-name truncate">{item.name}</span>
                            <Show
                              when={accountReady() && providerAccounts().length > 0}
                              fallback={<Tag>{type(item)}</Tag>}
                            >
                              <Tag>
                                {language.plural("settings.providers.accounts.count", providerAccounts().length)}
                              </Tag>
                            </Show>
                          </div>
                        </div>
                        <Show
                          when={protocol() === "v2"}
                          fallback={
                            <Show
                              when={canDisconnect(item)}
                              fallback={
                                <span class="settings-v2-provider-env-hint">
                                  {language.t("settings.providers.connected.environmentDescription")}
                                </span>
                              }
                            >
                              <ButtonV2
                                size="normal"
                                variant="ghost-muted"
                                onClick={() => void disconnect(item.id, item.name)}
                              >
                                {language.t("common.disconnect")}
                              </ButtonV2>
                            </Show>
                          }
                        >
                          <Show
                            when={canAddAccount(item.id)}
                            fallback={
                              <Show when={accountReady() && providerAccounts().length === 0}>
                                <span class="settings-v2-provider-env-hint">
                                  {language.t("settings.providers.connected.environmentDescription")}
                                </span>
                              </Show>
                            }
                          >
                            <ButtonV2 size="normal" variant="ghost-muted" icon="plus" onClick={() => connect(item.id)}>
                              {language.t("settings.providers.accounts.add")}
                            </ButtonV2>
                          </Show>
                        </Show>
                      </div>
                      <Show when={protocol() === "v2" && providerAccounts().length > 0}>
                        <div class="settings-v2-provider-accounts">
                          <For each={providerAccounts()}>
                            {(credential) => (
                              <div class="settings-v2-provider-account-row" data-credential-id={credential.id}>
                                <div class="settings-v2-provider-account-copy">
                                  <div class="settings-v2-provider-account-title">
                                    <span class="truncate">{credential.label}</span>
                                    <Show when={active()?.id === credential.id}>
                                      <Tag>{language.t("common.default")}</Tag>
                                    </Show>
                                  </div>
                                  <span class="settings-v2-provider-account-meta">{credential.id}</span>
                                </div>
                                <div class="settings-v2-provider-account-actions">
                                  <Show when={active()?.id !== credential.id}>
                                    <ButtonV2
                                      size="small"
                                      variant="ghost-muted"
                                      onClick={() => void selectAccount(credential)}
                                    >
                                      {language.t("settings.providers.accounts.setDefault")}
                                    </ButtonV2>
                                  </Show>
                                  <ButtonV2
                                    size="small"
                                    variant="ghost-muted"
                                    onClick={() => renameAccount(credential)}
                                  >
                                    {language.t("common.rename")}
                                  </ButtonV2>
                                  <ButtonV2
                                    size="small"
                                    variant="ghost-muted"
                                    onClick={() => removeAccount(item, credential)}
                                  >
                                    {language.t("common.delete")}
                                  </ButtonV2>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.popular")}</h3>
          <SettingsListV2>
            <For each={popular()}>
              {(item) => (
                <div class="settings-v2-provider-row">
                  <div class="settings-v2-provider-lead">
                    <ProviderIcon
                      id={item.id}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-provider-icon shrink-0"
                    />
                    <div class="settings-v2-provider-copy">
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name">{item.name}</span>
                        <Show when={item.id === "opencode" || item.id === "opencode-go"}>
                          <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
                        </Show>
                      </div>
                      <Show when={note(item.id)}>
                        {(key) => <p class="settings-v2-provider-description">{language.t(key())}</p>}
                      </Show>
                    </div>
                  </div>
                  <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={() => connect(item.id)}>
                    {language.t("common.connect")}
                  </ButtonV2>
                </div>
              )}
            </For>

            <Show when={protocol() === "v1"}>
              <div class="settings-v2-provider-row" data-component="custom-provider-section">
                <div class="settings-v2-provider-lead">
                  <ProviderIcon
                    id="synthetic"
                    width={PROVIDER_ICON_SIZE}
                    height={PROVIDER_ICON_SIZE}
                    class="settings-v2-provider-icon shrink-0"
                  />
                  <div class="settings-v2-provider-copy">
                    <div class="settings-v2-provider-main">
                      <span class="settings-v2-provider-name">{language.t("provider.custom.title")}</span>
                      <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                    </div>
                    <p class="settings-v2-provider-description">
                      {language.t("settings.providers.custom.description")}
                    </p>
                  </div>
                </div>
                <ButtonV2
                  size="normal"
                  variant="neutral"
                  icon="plus"
                  onClick={() => {
                    dialog.show(() => <DialogCustomProvider onBack={dialog.close} />)
                  }}
                >
                  {language.t("common.connect")}
                </ButtonV2>
              </div>
            </Show>
          </SettingsListV2>

          <button type="button" class="settings-v2-providers-view-all" onClick={() => connect()}>
            {language.t("dialog.provider.viewAll")}
          </button>
        </div>
      </div>
    </>
  )
}

function DialogRenameProviderAccount(props: {
  credential: ConnectionCredentialInfo
  onSave: (label: string) => Promise<boolean>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [form, setForm] = createStore({ label: props.credential.label })
  const [busy, setBusy] = createSignal(false)

  const save = async () => {
    if (busy()) return
    const label = form.label.trim()
    if (!label || label === props.credential.label) {
      dialog.close()
      return
    }
    setBusy(true)
    try {
      if (await props.onSave(label)) dialog.close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit class="settings-v2-account-dialog">
      <DialogHeader hideClose={busy()}>
        <DialogTitleGroup
          title={language.t("settings.providers.accounts.rename.title")}
          description={language.t("settings.providers.accounts.rename.description", {
            account: props.credential.label,
          })}
        />
      </DialogHeader>
      <DialogBody class="settings-v2-account-dialog-body">
        <TextInputV2
          autofocus
          appearance="large"
          value={form.label}
          disabled={busy()}
          onInput={(event) => setForm("label", event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.isComposing) return
            event.preventDefault()
            void save()
          }}
          placeholder={language.t("settings.providers.accounts.rename.placeholder")}
        />
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={busy() || !form.label.trim()} onClick={() => void save()}>
          {language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

function DialogRemoveProviderAccount(props: {
  provider: string
  credential: ConnectionCredentialInfo
  onRemove: () => Promise<boolean>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)

  const remove = async () => {
    if (busy()) return
    setBusy(true)
    try {
      if (await props.onRemove()) dialog.close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit class="settings-v2-account-dialog">
      <DialogHeader hideClose={busy()}>
        <DialogTitleGroup
          title={language.t("settings.providers.accounts.remove.title")}
          description={language.t("settings.providers.accounts.remove.confirm", {
            account: props.credential.label,
            provider: props.provider,
          })}
        />
      </DialogHeader>
      <DialogBody class="settings-v2-account-dialog-body">
        <p class="settings-v2-account-dialog-warning">
          {language.t("settings.providers.accounts.remove.warning", { provider: props.provider })}
        </p>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="danger" disabled={busy()} onClick={() => void remove()}>
          {language.t("settings.providers.accounts.remove.button")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
