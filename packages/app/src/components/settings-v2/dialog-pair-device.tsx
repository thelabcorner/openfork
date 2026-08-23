import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, Show, createEffect, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useNow } from "@/hooks/use-now"
import { beginPairing, formatPairingCode, type PairingSession } from "./pairing"
import { QrCode } from "./qr-code"
import "./settings-v2.css"

export const DialogPairDevice: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const now = useNow()
  const [store, setStore] = createStore({
    session: undefined as PairingSession | undefined,
    error: undefined as string | undefined,
    loading: false,
  })

  const begin = async () => {
    if (store.loading) return
    setStore("loading", true)
    try {
      const session = await beginPairing(sdk())
      setStore({ session, error: undefined, loading: false })
    } catch {
      setStore({ error: language.t("settings.pair.error"), loading: false })
    }
  }

  onMount(() => void begin())

  const remaining = () => {
    const session = store.session
    if (!session) return 0
    return Math.max(0, Math.ceil((session.expiresAt - now()) / 1000))
  }
  const expired = () => store.session !== undefined && remaining() <= 0

  // Auto-refresh: a fresh session begins the moment the current one lapses.
  createEffect(() => {
    if (!expired() || store.loading) return
    void begin()
  })

  onCleanup(() => setStore({ session: undefined, error: undefined, loading: false }))

  return (
    <Dialog fit class="settings-v2-pair-dialog">
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("settings.pair.title")}
          description={language.t("settings.pair.description")}
        />
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col items-center px-6 pt-6 pb-2">
        <Show
          when={store.session}
          fallback={
            <div class="settings-v2-pair-status">
              <Show when={!store.error} fallback={<IconV2 name="warning" size="large" class="text-v2-state-fg-danger" />}>
                <Spinner class="size-5" />
              </Show>
              <span classList={{ "settings-v2-pair-error": !!store.error }}>
                {store.error ?? language.t("common.loading")}
              </span>
              <Show when={store.error}>
                <ButtonV2 size="small" variant="outline" onClick={() => void begin()}>
                  {language.t("settings.pair.refresh")}
                </ButtonV2>
              </Show>
            </div>
          }
        >
          {(session) => (
            <>
              <div class="settings-v2-pair-qr">
                <QrCode value={session().url} label={language.t("settings.pair.qr.alt")} />
              </div>
              <div class="settings-v2-pair-code-block">
                <span class="settings-v2-pair-code-label">{language.t("settings.pair.code.label")}</span>
                {/* OTP is a Latin code token — keep LTR in RTL locales. */}
                <bdi class="settings-v2-pair-code" dir="ltr">
                  {formatPairingCode(session().code)}
                </bdi>
              </div>
              <div class="settings-v2-pair-countdown" classList={{ "settings-v2-pair-countdown--expired": expired() }}>
                <Show when={!expired()} fallback={<span>{language.t("settings.pair.expired")}</span>}>
                  {language.t("settings.pair.expires", { seconds: remaining() })}
                </Show>
              </div>
            </>
          )}
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.close")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
