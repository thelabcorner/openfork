/**
 * OXP activity transcript lab — mount. DEV-ONLY.
 *
 * Reached only from `lab-oxp-activity.html`, which is deliberately absent from
 * every `build.rollupOptions.input`, so this module never enters a shipped
 * bundle. It imports the app's real stylesheet and the minimum provider set the
 * transcript needs — theme tokens, language, the shared UI i18n bridge, and the
 * file/diff component — and nothing else: no router, no SDK, no platform bridge,
 * no server connection.
 */

import "@/index.css"
import { render } from "solid-js/web"
import type { ParentProps } from "solid-js"
import { I18nProvider } from "@opencode-ai/ui/context"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { File } from "@opencode-ai/session-ui/file"
import { LanguageProvider, useLanguage } from "@/context/language"
import { PlatformProvider, type Platform } from "@/context/platform"
import { dict as appEnglish } from "@/i18n/en"
import { DESKTOP_NATIVE_ENGLISH } from "@/i18n/desktop-native"
import { OxpActivityLab } from "./harness"

/**
 * `LanguageProvider` persists the selected locale, and persistence is
 * platform-owned — so the lab supplies the smallest honest web platform rather
 * than stubbing the language context itself.
 */
const LAB_PLATFORM: Platform = {
  platform: "web",
  openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
  refresh: async () => window.location.reload(),
  restart: async () => window.location.reload(),
  notify: async () => undefined,
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return (
    <I18nProvider
      value={{ locale: language.intl, layoutLocale: language.layoutLocale, t: language.t, plural: language.plural }}
    >
      {props.children}
    </I18nProvider>
  )
}

const root = document.getElementById("root")

if (root instanceof HTMLElement) {
  render(
    () => (
      <PlatformProvider value={LAB_PLATFORM}>
        <ThemeProvider>
          <LanguageProvider dictionary={appEnglish} nativeEnglish={DESKTOP_NATIVE_ENGLISH}>
            <UiI18nBridge>
              <FileComponentProvider component={File}>
                <OxpActivityLab />
              </FileComponentProvider>
            </UiI18nBridge>
          </LanguageProvider>
        </ThemeProvider>
      </PlatformProvider>
    ),
    root,
  )
} else if (import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.error("[oxp-activity lab] missing #root")
}
