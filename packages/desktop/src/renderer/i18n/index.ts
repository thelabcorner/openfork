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
type DictModule = { dict: Record<string, string> }

const loaders: Record<Exclude<Locale, "en">, () => Promise<DictModule>> = {
  zh: () => import("./zh"),
  zht: () => import("./zht"),
  ko: () => import("./ko"),
  de: () => import("./de"),
  es: () => import("./es"),
  fr: () => import("./fr"),
  da: () => import("./da"),
  ja: () => import("./ja"),
  pl: () => import("./pl"),
  ru: () => import("./ru"),
  uk: () => import("./uk"),
  ar: () => import("./ar"),
  no: () => import("./no"),
  br: () => import("./br"),
  bs: () => import("./bs"),
  tr: () => import("./tr"),
  hi: () => import("./hi"),
  nl: () => import("./nl"),
  id: () => import("./id"),
  vi: () => import("./vi"),
  it: () => import("./it"),
  ur: () => import("./ur"),
  pa: () => import("./pa"),
  az: () => import("./az"),
  fi: () => import("./fi"),
  sv: () => import("./sv"),
  th: () => import("./th"),
  am: () => import("./am"),
  bg: () => import("./bg"),
  bn: () => import("./bn"),
  ca: () => import("./ca"),
  cs: () => import("./cs"),
  dv: () => import("./dv"),
  dz: () => import("./dz"),
  el: () => import("./el"),
  et: () => import("./et"),
  fa: () => import("./fa"),
  fo: () => import("./fo"),
  hr: () => import("./hr"),
  hu: () => import("./hu"),
  hy: () => import("./hy"),
  is: () => import("./is"),
  ka: () => import("./ka"),
  km: () => import("./km"),
  lo: () => import("./lo"),
  lt: () => import("./lt"),
  lv: () => import("./lv"),
  mk: () => import("./mk"),
  mn: () => import("./mn"),
  ms: () => import("./ms"),
  my: () => import("./my"),
  ne: () => import("./ne"),
  ro: () => import("./ro"),
  si: () => import("./si"),
  sk: () => import("./sk"),
  sl: () => import("./sl"),
  sq: () => import("./sq"),
  sr: () => import("./sr"),
  tg: () => import("./tg"),
  tk: () => import("./tk"),
  uz: () => import("./uz"),
}

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

function parseRecord(value: unknown) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
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

  const record = parseRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

const base = i18n.flatten(desktopEn)

async function build(locale: Locale): Promise<Dictionary> {
  if (locale === "en") return base
  const loaded = await (loaders[locale] ?? loaders.ko)()
  return { ...base, ...i18n.flatten(loaded.dict) }
}

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
    const value = parseStored(raw)
    const next = pickLocale(value) ?? state.locale

    state.locale = next
    state.dict = await build(next)
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
