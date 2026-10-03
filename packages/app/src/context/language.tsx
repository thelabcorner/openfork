import * as i18n from "@solid-primitives/i18n"
import { createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { pluralCategory, type UiI18nPluralKey } from "@opencode-ai/ui/context/i18n"
import { Persist, persisted } from "@/utils/persist"
import type { dict as fullEnglishDictionary } from "@/i18n/en"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import {
  createDesktopNativeBundle,
  DESKTOP_NATIVE_LABELS,
  DESKTOP_NATIVE_LOCALE_TAGS,
  DESKTOP_NATIVE_LOCALES,
  type DesktopNativeBundle,
  type DesktopNativeLocale,
} from "@/i18n/desktop-native"

export type Locale = DesktopNativeLocale
export type Direction = "ltr" | "rtl"

type RawDictionary = typeof fullEnglishDictionary & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>
type AppDictionary = Partial<typeof fullEnglishDictionary>
type PluralKey =
  | UiI18nPluralKey
  | "session.question.pending"
  | "session.followupDock.summary"
  | "session.revertDock.summary"
  | "usage.calls"
  | "usage.turns"
  | "usage.sessions"
  | "home.sessions.search.sessionsResult"
  | "home.sessions.search.messagesResult"
  | "home.sessions.archived.count"
  | "sessionGroup.sessions"
  | "groupTab.summary.running"
  | "groupTab.summary.waiting"
  | "chats.metric.messages"
  | "chats.showMoreCount"
  | "chats.footer.sessions"
  | "chats.footer.active"
  | "chats.archived.count"
  | "projectExplorer.folder.count"
  | "settings.providers.accounts.count"
  | "goal.auditor.runs"
  | "scheduledTasks.calendar.reset.partial"
  | "scheduledTasks.calendar.reset.count"
  | "oxpActivity.calls"
  | "oxpActivity.concurrent"
  | "oxpActivity.result.edits"
  | "oxpActivity.result.entries"
  | "oxpActivity.result.files"
  | "oxpActivity.result.lines"
  | "oxpActivity.result.matches"
  | "oxpActivity.result.workers"

const pluralCountFormatters = new Map<string, Intl.NumberFormat>()
/** Locale-grouped rendering of a plural string's `{{count}}` placeholder. */
function pluralCount(locale: string, count: number) {
  let formatter = pluralCountFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
    pluralCountFormatters.set(locale, formatter)
  }
  return formatter.format(count)
}

export function loadInitialLocale(): Promise<Locale> {
  return Promise.resolve("en")
}

export function loadLocaleDict(_locale: Locale) {
  return Promise.resolve()
}

export function normalizeLocale(_value: string): Locale {
  return "en"
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  gate: false,
  init: (props: {
    locale?: Locale
    dictionary: AppDictionary
    nativeEnglish?: Readonly<Record<string, string>>
    onNativeTranslations?: (bundle: DesktopNativeBundle) => void
  }) => {
    const [, setStore, _, ready] = persisted(
      Persist.global("language", ["language.v1"]),
      createStore({
        locale: "en" as Locale,
      }),
    )
    const locale = createMemo<Locale>(() => "en")
    const intl = createMemo(() => DESKTOP_NATIVE_LOCALE_TAGS[locale()])
    const direction = createMemo<Direction>(() => "ltr")
    const layoutLocale = createMemo(() => intl())

    const [dictionary, setDictionary] = createSignal(
      i18n.flatten({ ...props.dictionary, ...uiEn }) as Dictionary,
    )
    const t = i18n.translator(dictionary, i18n.resolveTemplate) as (
      key: keyof Dictionary,
      params?: Record<string, string | number | boolean>,
    ) => string

    const registerTranslations = (next: Readonly<Record<string, string>>) => {
      setDictionary((current) => {
        const source = current as Record<string, string>
        let changed = false
        for (const [key, value] of Object.entries(next)) {
          if (source[key] === value) continue
          changed = true
          break
        }
        if (!changed) return current
        return { ...current, ...next } as Dictionary
      })
    }

    const plural = (key: PluralKey, count: number, params?: Record<string, string | number | boolean>) => {
      const category = pluralCategory(intl(), count)
      const current = dictionary() as Record<string, string>
      const candidate = `${key}.${category}`
      const fallback = `${key}.other`
      // `{{count}}` is display text, so it goes through the locale's number
      // format — otherwise every plural string in the app renders a bare
      // `26662 turns` with no group separators. The plural CATEGORY is still
      // chosen from the numeric value above, before formatting.
      return i18n.resolveTemplate(current[candidate] ?? current[fallback] ?? fallback, {
        ...params,
        count: pluralCount(intl(), count),
      })
    }

    const label = (value: Locale) => DESKTOP_NATIVE_LABELS[value]

    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.lang = intl()
      document.documentElement.dir = direction()
    })

    createEffect(() => {
      if (!props.onNativeTranslations || !props.nativeEnglish) return
      const current = dictionary() as Record<string, string>
      props.onNativeTranslations(
        createDesktopNativeBundle(locale(), (key) => current[key] ?? props.nativeEnglish?.[key] ?? key),
      )
    })

    return {
      ready,
      locale,
      intl,
      direction,
      layoutLocale,
      locales: DESKTOP_NATIVE_LOCALES,
      label,
      t,
      plural,
      registerTranslations,
      setLocale(_next: Locale) {
        setStore("locale", "en")
      },
      setDirection(_next: Direction) {},
    }
  },
})
