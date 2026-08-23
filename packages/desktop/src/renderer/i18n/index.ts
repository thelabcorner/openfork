import * as i18n from "@solid-primitives/i18n"
import {
  DESKTOP_NATIVE_LOCALES,
  detectDesktopNativeLocale,
  type DesktopNativeLocale,
} from "../../../../app/src/i18n/desktop-native"

import { dict as desktopEn } from "./en"

export type Locale = DesktopNativeLocale

type RawDictionary = typeof desktopEn
type Dictionary = Record<keyof i18n.Flatten<RawDictionary>, string>

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"
  return detectDesktopNativeLocale(navigator.languages?.length ? navigator.languages : [navigator.language])
}

function parseLocale(value: unknown): Locale | null {
  if (!value) return null
  if (typeof value !== "string") return null
  if ((DESKTOP_NATIVE_LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

function parseStored(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pickLocale(value: unknown): Locale | null {
  const direct = parseLocale(value)
  if (direct) return direct

  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return parseLocale(record.locale)
}

const base = i18n.flatten(desktopEn)

const state = {
  locale: detectLocale(),
  dict: base as Dictionary,
  init: undefined as Promise<Locale> | undefined,
}

const translate = i18n.translator(() => state.dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}

export function initI18n(): Promise<Locale> {
  const cached = state.init
  if (cached) return cached

  const promise = (async () => {
    const raw = await window.api.storeGet("opencode.global.dat", "language").catch(() => null)
    const next = pickLocale(parseStored(raw)) ?? state.locale

    state.locale = next
    state.dict = base
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
