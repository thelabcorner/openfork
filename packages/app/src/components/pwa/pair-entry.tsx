import { Button } from "@opencode-ai/ui/button"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { claimDeviceToken, PAIR_CODE_ALPHABET, storeDeviceToken } from "@/utils/pwa-pairing"

const CODE_LENGTH = 6
const GROUP_SIZE = 3

// Normalize typed input: uppercase, strip separators, cap at the code length.
export function normalizePairCodeInput(raw: string) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH)
}

/** Strict check against the server's issued alphabet (no 0/1/I/O). */
export function isValidPairCode(code: string) {
  return code.length === CODE_LENGTH && [...code].every((char) => PAIR_CODE_ALPHABET.includes(char))
}

/** Grouped display form (K7M-2XQ) matching the desktop pair dialog. */
export function formatPairCode(code: string) {
  const groups: string[] = []
  for (let index = 0; index < code.length; index += GROUP_SIZE) {
    groups.push(code.slice(index, index + GROUP_SIZE))
  }
  return groups.join("-")
}

/**
 * Manual pairing fallback on the PWA connect surface: enter the 6-character
 * code shown by the desktop pair dialog, then run the same claim+store path
 * as claim-on-boot. A successful claim reloads so entry-pwa boots with the
 * fresh token through the normal path.
 */
export function PwaPairEntry() {
  const language = useLanguage()
  const server = useServer()
  const [value, setValue] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<"invalidCode" | "failed" | undefined>()

  const handleSubmit = async () => {
    if (busy()) return
    const code = normalizePairCodeInput(value())
    if (!isValidPairCode(code)) {
      setError("invalidCode")
      return
    }
    setError(undefined)
    setBusy(true)
    try {
      const url = server.current?.type === "http" ? server.current.http.url : location.origin
      const result = await claimDeviceToken(url, code)
      if (!result.ok) {
        setError("failed")
        return
      }
      storeDeviceToken(result.token)
      window.location.reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex flex-col gap-2 w-full max-w-sm">
      <span class="text-12-regular text-text-base text-center">{language.t("pwa.pair.heading")}</span>
      <p class="text-12-regular text-text-weak text-center">{language.t("pwa.pair.description")}</p>
      <form
        class="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
      >
        <input
          type="text"
          inputmode="text"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck={false}
          aria-label={language.t("pwa.pair.placeholder")}
          placeholder={formatPairCode("X".repeat(CODE_LENGTH))}
          value={formatPairCode(normalizePairCodeInput(value()))}
          disabled={busy()}
          class="flex-1 min-w-0 h-10 px-3 rounded-md bg-surface-base text-text-strong text-14-regular tracking-[0.2em] uppercase placeholder:text-text-weak border border-transparent focus:border-text-weak outline-none disabled:opacity-50"
          onInput={(event) => {
            setValue(event.currentTarget.value)
            setError(undefined)
          }}
        />
        <Button type="submit" variant="primary" size="large" disabled={busy()} class="px-3 py-1.5 shrink-0">
          {busy() ? language.t("pwa.pair.working") : language.t("pwa.pair.submit")}
        </Button>
      </form>
      <Show when={error()}>
        <p class="text-12-regular text-text-strong text-center">
          {error() === "invalidCode" ? language.t("pwa.pair.invalidCode") : language.t("pwa.pair.failed")}
        </p>
      </Show>
    </div>
  )
}
