import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, For, Show, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { DialogPairDevice } from "./dialog-pair-device"
import { listDevices, revokeDevice, type PairedDevice } from "./pairing"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

export const SettingsDevicesV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useServerSDK()
  const [devices, { refetch }] = createResource(() => listDevices(sdk()))
  const [pairOpen, setPairOpen] = createSignal(false)

  const [pwaUrlResource] = createResource(async () => {
    // Only show an explicit PWA URL when the deployment has one.
    // In local dev OPENCODE_PWA_URL is unset and the QR is same-origin
    // via the vite proxy, so showing the API origin (localhost:4096) is
    // misleading. Prefer to show "Not configured".
    try {
      const meta = import.meta as unknown as { env?: Record<string, string> }
      const configured = (meta.env?.OPENCODE_PWA_URL ?? meta.env?.VITE_OPENCODE_PWA_URL ?? "") as string
      if (configured?.trim()) {
        const u = new URL(configured.trim())
        if (u.protocol === "http:" || u.protocol === "https:") return u.toString()
      }
    } catch {}
    return ""
  })
  const pwaUrl = () => pwaUrlResource() ?? ""

  // Keep the list fresh: newly paired devices appear without manual refresh.
  // Poll continuously while the tab is mounted, and more aggressively while
  // the pairing dialog is open. Also refetch a few times after close to catch
  // a claim that may still be in flight.
  onMount(() => {
    const id = setInterval(() => void refetch(), 5000)
    onCleanup(() => clearInterval(id))
  })
  createEffect(() => {
    if (!pairOpen()) return
    const id = setInterval(() => void refetch(), 2000)
    onCleanup(() => clearInterval(id))
  })

  const [confirmingRevoke, setConfirmingRevoke] = createSignal<string | undefined>()
  const [revoking, setRevoking] = createSignal<string | undefined>()

  const dateTimeFormat = () => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" })
  const formatDate = (value: number) => dateTimeFormat().format(value)

  const openPair = () => {
    setPairOpen(true)
    dialog.push(() => <DialogPairDevice />, () => {
      setPairOpen(false)
      void refetch()
      setTimeout(() => void refetch(), 1200)
      setTimeout(() => void refetch(), 3500)
    })
  }

  const revoke = async (device: PairedDevice) => {
    setRevoking(device.id)
    try {
      await revokeDevice(sdk(), device.id)
      setConfirmingRevoke(undefined)
      await refetch()
      showToast({ variant: "success", icon: "check", title: language.t("settings.devices.revoke.toast.title") })
    } catch {
      showToast({ variant: "error", title: language.t("settings.devices.error") })
    } finally {
      setRevoking(undefined)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-devices-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.devices.title")}</h2>
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <IconButtonV2
              type="button"
              size="small"
              variant="ghost-muted"
              icon={<IconV2 name="reset" size="small" />}
              aria-label={language.t("limits.refresh")}
              title={language.t("limits.refresh")}
              disabled={devices.loading}
              onClick={() => void refetch()}
            />
            <ButtonV2 size="small" variant="outline" onClick={openPair}>
              <IconV2 name="plus" size="small" />
              {language.t("settings.devices.pair.action")}
            </ButtonV2>
          </div>
        </div>
        <p class="settings-v2-devices-intro">{language.t("settings.devices.description")}</p>
      </div>

      <div class="settings-v2-tab-body settings-v2-devices">
        <Show when={pwaUrl()}>
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">Configuration</h3>
            <SettingsListV2>
              <div data-component="settings-v2-row">
                <div data-slot="settings-v2-row-copy">
                  <div data-slot="settings-v2-row-title">PWA URL</div>
                  <div data-slot="settings-v2-row-description">
                    Origin encoded in the QR. Set <code class="settings-v2-devices-code">OPENCODE_PWA_URL</code> for tunnels or hosted deployments.
                  </div>
                </div>
                <div data-slot="settings-v2-row-control">
                  <span class="settings-v2-devices-pwa-url" title={pwaUrl()}>
                    {pwaUrl()}
                  </span>
                </div>
              </div>
            </SettingsListV2>
          </div>
        </Show>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.devices.list.title")}</h3>
          <Show when={devices.error}>
            <div class="settings-v2-devices-error">
              <span>{language.t("settings.devices.error")}</span>
              <ButtonV2 size="small" variant="neutral" onClick={() => void refetch()}>
                {language.t("limits.refresh")}
              </ButtonV2>
            </div>
          </Show>
          <Show when={!devices.loading || devices()} fallback={
            <div class="settings-v2-devices-status">
              <Spinner class="size-4 shrink-0" />
              <span>{language.t("common.loading")}</span>
            </div>
          }>
            <Show
              when={(devices.latest ?? devices() ?? []).length > 0}
              fallback={
                <div class="settings-v2-devices-status">
                  <span>{language.t("settings.devices.empty")}</span>
                  <span class="settings-v2-devices-status-description">{language.t("settings.devices.empty.description")}</span>
                </div>
              }
            >
              <SettingsListV2>
                <For each={devices.latest ?? devices() ?? []}>
                  {(device) => (
                    <div class="settings-v2-devices-row">
                      <div class="settings-v2-devices-lead">
                        <IconV2 name="monitor" class="text-v2-icon-icon-muted" />
                        <div class="settings-v2-devices-copy">
                          <bdi class="settings-v2-devices-name" dir="auto">
                            {device.name}
                          </bdi>
                          <span class="settings-v2-devices-meta">
                            {language.t("settings.devices.row.added", { date: formatDate(device.created) })}
                            <Show when={device.lastSeen !== undefined}>
                              {" \u2022 "}
                              {language.t("settings.devices.row.lastSeen", { date: formatDate(device.lastSeen!) })}
                            </Show>
                            {" \u2022 "}
                            <bdi dir="ltr">{device.prefix}</bdi>
                          </span>
                        </div>
                      </div>
                      <div class="settings-v2-devices-actions">
                        <Show
                          when={confirmingRevoke() === device.id}
                          fallback={
                            <IconButtonV2
                              type="button"
                              size="small"
                              variant="ghost-muted"
                              icon={<IconV2 name="trash" size="small" class="!text-v2-state-fg-danger" />}
                              aria-label={language.t("settings.devices.revoke")}
                              onClick={() => setConfirmingRevoke(device.id)}
                            />
                          }
                        >
                          <ButtonV2
                            size="small"
                            variant="danger"
                            disabled={revoking() === device.id}
                            onClick={() => void revoke(device)}
                          >
                            {language.t("settings.devices.revoke")}
                          </ButtonV2>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </SettingsListV2>
            </Show>
          </Show>
        </div>
      </div>
    </>
  )
}
