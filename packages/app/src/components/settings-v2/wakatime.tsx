import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { type Component, createMemo, createSignal, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import {
  cliPath,
  cliSource,
  connectionState,
  didApplyWakaTimeEnabled,
  parseWakaTimeStatus,
  type WakaTimeStatusView,
} from "./wakatime-model"
import "./settings-v2.css"
import "./settings-wakatime.css"

/**
 * WakaTime settings panel.
 *
 * This is a projection, not an owner. The process-global Core exporter owns the
 * opt-in, resolves the CLI, and holds authentication; the panel reads that
 * Tier-0 status and forwards one intent (the opt-in toggle). It stores nothing
 * locally, accepts no credential input, and derives no state Core does not
 * already publish.
 */
export const SettingsWakaTimeV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const sdk = useServerSDK()
  const [status, setStatus] = createSignal<WakaTimeStatusView>()
  const [loading, setLoading] = createSignal(true)
  const [loadError, setLoadError] = createSignal<"load" | "unsupported">()
  const [saving, setSaving] = createSignal(false)

  const client = () => sdk().client
  const canRestartLocalSidecar = createMemo(() => {
    const current = server.current
    return platform.platform === "desktop" && current !== undefined && ServerConnection.builtin(current)
  })
  const connection = createMemo(() => connectionState(status()))
  const cli = createMemo(() => cliPath(status()))
  const source = createMemo(() => cliSource(status()))

  const acceptStatus = (value: unknown) => {
    const next = parseWakaTimeStatus(value)
    if (!next) {
      setStatus(undefined)
      setLoadError("unsupported")
      return
    }
    setStatus(next)
    setLoadError(undefined)
    return next
  }

  const load = async () => {
    setLoading(true)
    setLoadError(undefined)
    try {
      const response = await client().wakatime.status({ throwOnError: true })
      acceptStatus(response.data)
    } catch {
      setStatus(undefined)
      setLoadError("load")
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  const statusLabel = () => language.t(`settings.wakatime.status.${connection()}`)

  const setEnabled = async (enabled: boolean) => {
    if (saving()) return
    setSaving(true)
    try {
      const response = await client().wakatime.update({ wakaTimeUpdatePayload: { enabled } }, { throwOnError: true })
      const next = acceptStatus(response.data)
      if (!next) {
        showToast({ variant: "error", title: language.t("settings.wakatime.error.unsupported.title") })
        return
      }
      if (!didApplyWakaTimeEnabled(next, enabled)) {
        showToast({ variant: "error", title: language.t("settings.wakatime.error.notApplied") })
        return
      }
      showToast({
        variant: "success",
        icon: "check",
        title: language.t(enabled ? "settings.wakatime.toast.enabled" : "settings.wakatime.toast.disabled"),
      })
    } catch {
      showToast({ variant: "error", title: language.t("settings.wakatime.error.save") })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-wakatime-header">
        <div class="settings-v2-tab-header-row">
          <div class="settings-wakatime-title-group">
            <h2 class="settings-v2-tab-title">{language.t("settings.wakatime.title")}</h2>
            <Tag>{language.t("settings.wakatime.badge")}</Tag>
          </div>
          <IconButtonV2
            type="button"
            size="small"
            variant="ghost-muted"
            icon={<IconV2 name="reset" size="small" />}
            aria-label={language.t("limits.refresh")}
            title={language.t("limits.refresh")}
            disabled={loading()}
            onClick={() => void load()}
          />
        </div>
        <p class="settings-wakatime-intro">{language.t("settings.wakatime.description")}</p>
      </div>

      <div class="settings-v2-tab-body settings-wakatime">
        <Show
          when={!loading() && status()}
          fallback={
            <div class="settings-wakatime-status" role="status" aria-live="polite">
              <Show
                when={loading()}
                fallback={
                  <Show
                    when={loadError() === "unsupported"}
                    fallback={
                      <>
                        <span>{language.t("settings.wakatime.error.load")}</span>
                        <ButtonV2 size="small" variant="outline" onClick={() => void load()}>
                          {language.t("settings.ofxp.retry")}
                        </ButtonV2>
                      </>
                    }
                  >
                    <span>
                      {language.t(
                        canRestartLocalSidecar()
                          ? "settings.wakatime.error.unsupported.local"
                          : "settings.wakatime.error.unsupported.remote",
                      )}
                    </span>
                    <Show when={canRestartLocalSidecar()}>
                      <ButtonV2 size="small" variant="outline" onClick={() => void platform.restart()}>
                        {language.t("settings.wakatime.action.restart")}
                      </ButtonV2>
                    </Show>
                  </Show>
                }
              >
                <Spinner class="size-4 shrink-0" />
                <span>{language.t("common.loading")}</span>
              </Show>
            </div>
          }
        >
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("settings.wakatime.status.title")}</h3>
            <SettingsListV2>
              <SettingsRowV2
                title={language.t("settings.wakatime.toggle.title")}
                description={language.t("settings.wakatime.toggle.description")}
              >
                <Switch
                  checked={status()?.enabled === true}
                  disabled={saving()}
                  onChange={(checked) => void setEnabled(checked)}
                />
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.wakatime.status.title")}
                description={
                  <Show
                    when={connection() !== "missing-key"}
                    fallback={<span>{language.t("settings.wakatime.status.missingKey.hint")}</span>}
                  >
                    <span>{statusLabel()}</span>
                  </Show>
                }
              >
                <span class="settings-wakatime-connection-state" data-state={connection()}>
                  {statusLabel()}
                </span>
              </SettingsRowV2>
            </SettingsListV2>
          </div>

          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("settings.wakatime.configuration.title")}</h3>
            <SettingsListV2>
              <SettingsRowV2
                title={language.t("settings.wakatime.configuration.cli")}
                description={language.t("settings.wakatime.configuration.cli.description")}
              >
                <Show
                  when={cli()}
                  fallback={
                    <div class="settings-wakatime-cli-unresolved">
                      <span class="settings-wakatime-connection-state">
                        {language.t("settings.wakatime.configuration.cli.unresolved")}
                      </span>
                      <Show when={connection() === "missing-cli"}>
                        <ButtonV2
                          size="small"
                          variant="outline"
                          disabled={saving()}
                          onClick={() => void setEnabled(true)}
                        >
                          {language.t("settings.wakatime.action.prepareCli")}
                        </ButtonV2>
                      </Show>
                    </div>
                  }
                >
                  <code class="settings-wakatime-cli">{cli()}</code>
                </Show>
              </SettingsRowV2>
              <Show when={source() !== undefined}>
                <SettingsRowV2
                  title={language.t("settings.wakatime.configuration.source")}
                  description={language.t("settings.wakatime.configuration.source.description")}
                >
                  <span class="settings-wakatime-connection-state">
                    {language.t(`settings.wakatime.configuration.source.${source()}`)}
                  </span>
                </SettingsRowV2>
              </Show>
            </SettingsListV2>
          </div>

          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("settings.wakatime.privacy.title")}</h3>
            <p class="settings-wakatime-privacy">{language.t("settings.wakatime.privacy.sent")}</p>
            <p class="settings-wakatime-privacy">{language.t("settings.wakatime.privacy.excluded")}</p>
            <p class="settings-wakatime-privacy">{language.t("settings.wakatime.privacy.credentials")}</p>
          </div>
        </Show>
      </div>
    </>
  )
}

export default SettingsWakaTimeV2
