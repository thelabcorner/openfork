import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { createSignal, onMount, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { disablePwaPush, enablePwaPush, pwaPushState, refreshPwaPushState } from "@/utils/pwa-push"

function enableErrorCopy(language: ReturnType<typeof useLanguage>, reason?: string) {
  switch (reason) {
    case "denied":
      return language.t("pwa.notifications.error.denied")
    case "dismissed":
      return language.t("pwa.notifications.error.dismissed")
    case "insecure":
      return language.t("pwa.notifications.error.insecure")
    case "not-found":
    case "no-public-key":
      return language.t("pwa.notifications.error.serverUnavailable")
    case "unauthorized":
      return language.t("pwa.notifications.error.unauthorized")
    case "unsupported":
      return language.t("pwa.notifications.error.unsupported")
    case "invalid-subscription":
      return language.t("pwa.notifications.error.invalidSubscription")
    default:
      return reason && reason !== "unknown"
        ? language.t("pwa.notifications.error.detail", { reason })
        : language.t("pwa.notifications.error.generic")
  }
}

export function PwaNotificationSettings() {
  const language = useLanguage()
  const sdk = useServerSDK()
  const platform = usePlatform()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  onMount(() => void refreshPwaPushState())

  const enable = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await enablePwaPush(sdk().client)
      if (!result.ok) setError(enableErrorCopy(language, result.reason))
    } catch (cause) {
      setError(enableErrorCopy(language, cause instanceof Error ? cause.message : "unknown"))
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await disablePwaPush(sdk().client)
    } finally {
      setBusy(false)
    }
  }

  const install = async () => {
    setError(undefined)
    const outcome = await platform.installPrompt?.promptInstall?.()
    if (outcome === "dismissed") setError(language.t("pwa.notifications.installDismissed"))
  }

  return (
    <div class="flex flex-col gap-4 pb-4">
      <div class="rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-4">
        <div class="flex items-start gap-3">
          <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-v2-background-bg-layer-02 text-v2-icon-icon-base">
            <Icon name="bell" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-[530] text-v2-text-text-strong">{language.t("pwa.notifications.title")}</div>
            <p class="mt-1 text-[12px] leading-5 text-v2-text-text-muted">
              {language.t("pwa.notifications.description")}
            </p>
          </div>
        </div>
      </div>

      <Show when={pwaPushState() === "subscribed"}>
        <div class="flex items-center justify-between gap-3 rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-base px-4 py-3">
          <div class="flex items-center gap-2 text-[13px] font-[530] text-v2-text-text-base">
            <Icon name="check" class="text-v2-state-icon-success" />
            {language.t("pwa.notifications.enabled")}
          </div>
          <ButtonV2 variant="neutral" size="normal" disabled={busy()} onClick={() => void disable()}>
            {busy() ? language.t("pwa.notifications.turningOff") : language.t("pwa.notifications.turnOff")}
          </ButtonV2>
        </div>
      </Show>

      <Show when={pwaPushState() === "permission-default" || pwaPushState() === "permission-granted-unsubscribed"}>
        <ButtonV2 variant="contrast" size="normal" disabled={busy()} onClick={() => void enable()}>
          {busy() ? language.t("pwa.notifications.enabling") : language.t("pwa.notifications.enable")}
        </ButtonV2>
      </Show>

      <Show when={pwaPushState() === "needs-install"}>
        <div class="rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-01 p-4 text-[12px] leading-5 text-v2-text-text-muted">
          {language.t("pwa.notifications.needsInstall")}
          <Show
            when={platform.installPrompt?.available?.()}
            fallback={<p class="mt-2 text-v2-text-text-faint">{language.t("pwa.notifications.installIosHint")}</p>}
          >
            <div class="mt-3">
              <ButtonV2 variant="contrast" size="normal" onClick={() => void install()}>
                {language.t("pwa.notifications.install")}
              </ButtonV2>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={pwaPushState() === "permission-denied"}>
        <div class="rounded-[10px] border border-v2-state-border-danger/40 bg-v2-state-bg-danger/10 px-4 py-3 text-[12px] leading-5 text-v2-text-text-base">
          {language.t("pwa.notifications.blocked")}
        </div>
      </Show>

      <Show when={pwaPushState() === "unsupported"}>
        <div class="rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-4 py-3 text-[12px] leading-5 text-v2-text-text-muted">
          {language.t("pwa.notifications.unsupported")}
        </div>
      </Show>

      <Show when={error()}>
        <div role="alert" class="rounded-[10px] border border-v2-state-border-danger/40 bg-v2-state-bg-danger/10 px-4 py-3 text-[12px] leading-5 text-v2-text-text-base">
          {error()}
        </div>
      </Show>
    </div>
  )
}
