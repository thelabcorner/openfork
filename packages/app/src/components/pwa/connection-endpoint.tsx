import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Show, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import type { PwaEndpointMigrationResult } from "@/context/pwa-connection"

export function PwaConnectionEndpoint(props: {
  serverUrl: string
  migrate: (nextUrl: string) => Promise<PwaEndpointMigrationResult>
  onClose: () => void
}) {
  const language = useLanguage()
  const [draft, setDraft] = createSignal(props.serverUrl)
  const [busy, setBusy] = createSignal(false)
  const [message, setMessage] = createSignal<string>()

  const messageFor = (result: PwaEndpointMigrationResult) => {
    if (result === "migrated") return language.t("pwa.connection.endpoint.migrated")
    if (result === "invalid-url") return language.t("pwa.connection.endpoint.invalidUrl")
    if (result === "unpinned") return language.t("pwa.connection.endpoint.unpinned")
    if (result === "identity-unavailable") return language.t("pwa.connection.endpoint.identityUnavailable")
    if (result === "identity-mismatch") return language.t("pwa.connection.endpoint.identityMismatch")
    if (result === "credential-invalid") return language.t("pwa.connection.endpoint.credentialInvalid")
    return language.t("pwa.connection.endpoint.unreachable")
  }

  const submit = async () => {
    if (busy()) return
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await props.migrate(draft())
      setMessage(messageFor(result))
      if (result === "migrated") props.onClose()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : language.t("pwa.connection.endpoint.unreachable"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex flex-col gap-2">
      <input
        inputmode="url"
        autocomplete="url"
        spellcheck={false}
        value={draft()}
        placeholder="https://api.example.com"
        class="h-9 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-3 font-mono text-[11px] text-v2-text-text-base outline-none focus:border-v2-border-border-strong"
        onInput={(event) => {
          setDraft(event.currentTarget.value)
          setMessage(undefined)
        }}
      />
      <div class="flex gap-2">
        <ButtonV2 variant="contrast" size="small" disabled={busy()} onClick={() => void submit()}>
          {busy() ? language.t("pwa.connection.endpoint.checking") : language.t("pwa.connection.endpoint.confirm")}
        </ButtonV2>
        <ButtonV2 variant="neutral" size="small" disabled={busy()} onClick={() => props.onClose()}>
          {language.t("pwa.connection.endpoint.cancel")}
        </ButtonV2>
      </div>
      <Show when={message()}>
        <div class="text-[11px] leading-4 text-v2-text-text-muted">{message()}</div>
      </Show>
    </div>
  )
}
