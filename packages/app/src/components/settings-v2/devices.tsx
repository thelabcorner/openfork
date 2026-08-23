import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, For, Show, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"
import { DialogPairDevice } from "./dialog-pair-device"
import { listDevices, revokeDevice, type PairedDevice } from "./pairing"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

export const SettingsDevicesV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const [devices, { refetch }] = createResource(() => listDevices(sdk()))
  const [confirmingRevoke, setConfirmingRevoke] = createSignal<string | undefined>()
  const [revoking, setRevoking] = createSignal<string | undefined>()

  const dateTimeFormat = () => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" })
  const formatDate = (value: number) => dateTimeFormat().format(value)

  const openPair = () => {
    dialog.push(() => <DialogPairDevice />)
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
          <ButtonV2 size="small" variant="outline" onClick={openPair}>
            <IconV2 name="plus" size="small" />
            {language.t("settings.devices.pair.action")}
          </ButtonV2>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-devices">
        <Show when={!devices.loading || devices()} fallback={
          <div class="settings-v2-devices-status">
            <Spinner class="size-4 shrink-0" />
            <span>{language.t("common.loading")}</span>
          </div>
        }>
          <Show
            when={(devices.latest ?? []).length > 0}
            fallback={
              <div class="settings-v2-devices-status">
                <span>{language.t("settings.devices.empty")}</span>
                <span class="settings-v2-devices-status-description">{language.t("settings.devices.empty.description")}</span>
              </div>
            }
          >
            <SettingsListV2>
              <For each={devices.latest ?? []}>
                {(device) => (
                  <div class="settings-v2-devices-row">
                    <div class="settings-v2-devices-lead">
                      <IconV2 name="monitor" class="text-v2-icon-icon-muted" />
                      <div class="settings-v2-devices-copy">
                        {/* Device names are user-supplied — isolate bidi. */}
                        <bdi class="settings-v2-devices-name" dir="auto">
                          {device.name}
                        </bdi>
                        <span class="settings-v2-devices-meta">
                          {language.t("settings.devices.row.added", { date: formatDate(device.created) })}
                          <Show when={device.lastSeen !== undefined}>
                            {" • "}
                            {language.t("settings.devices.row.lastSeen", { date: formatDate(device.lastSeen!) })}
                          </Show>
                          {" • "}
                          {/* Token prefix is a code token — keep LTR. */}
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
    </>
  )
}
