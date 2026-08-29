import type { OpencodeClient, Provider } from "@opencode-ai/sdk/v2/client"
import { For, Show } from "solid-js"
import { NotificationSettings } from "../components/NotificationSettings"
import { IconChevronRight, IconDownload, IconGlobe, IconInfo, IconKey, IconPackage } from "../icons"
import { ProviderBadge } from "../components/ProviderBadge"

export function SettingsView(props: {
  serverUrl: string
  serverVersion: string
  token: string
  providers: Provider[]
  client?: OpencodeClient
  installPrompt: boolean
  onInstall: () => void
  onForgetDevice: () => void | Promise<void>
  onDisconnect: () => void
}) {
  return (
    <div class="view-root">
      <div class="sessions-header">
        <div class="sessions-titlebar">
          <div class="brand-mark">
            <span class="brand-title">Settings</span>
          </div>
        </div>
      </div>
      <div class="view-scroll settings-scroll">
        <div class="settings-section-head">
          <IconPackage size={11} />
          <span>Providers</span>
        </div>
        <div class="settings-card">
          <For each={props.providers}>
            {(provider) => (
              <div class="settings-account-row">
                <ProviderBadge providerID={provider.id} size="sm" />
                <div style={{ flex: 1, "min-width": 0 }}>
                  <div class="name">{provider.name}</div>
                  <div class="tags">
                    <Show when={provider.key} fallback={<span class="badge badge-count">{provider.source}</span>}>
                      <span class="badge badge-active">Connected</span>
                    </Show>
                  </div>
                </div>
                <IconChevronRight size={12} />
              </div>
            )}
          </For>
          <Show when={props.providers.length === 0}>
            <div class="settings-account-row"><span class="muted">No providers configured</span></div>
          </Show>
        </div>

        <NotificationSettings client={props.client} />

        <div class="settings-section-head">
          <IconGlobe size={11} />
          <span>Connection</span>
        </div>
        <div class="settings-card">
          <div class="settings-static-row">
            <span class="label">Server URL</span>
            <span class="value">{props.serverUrl}</span>
          </div>
          <div class="settings-static-row">
            <span class="label">Server version</span>
            <span class="value tnum">{props.serverVersion || "unknown"}</span>
          </div>
          <button class="settings-row" onClick={props.onForgetDevice}>
            <IconKey size={13} />
            <span class="label">Device token</span>
            <span class="value tnum">{props.token ? `${props.token.slice(0, 8)}…` : "not paired"}</span>
          </button>
          <button class="settings-row" onClick={props.onDisconnect}>
            <span class="label">Disconnect</span>
          </button>
        </div>

        <div class="settings-section-head">
          <IconInfo size={11} />
          <span>About</span>
        </div>
        <div class="settings-card">
          <div class="settings-static-row">
            <span class="label">Client</span>
            <span class="value">OpenCode Mobile</span>
          </div>
        </div>

        <Show when={props.installPrompt}>
          <button class="settings-install-btn" onClick={props.onInstall}>
            <IconDownload size={12} />
            <span>Install as app</span>
          </button>
        </Show>
      </div>
    </div>
  )
}
