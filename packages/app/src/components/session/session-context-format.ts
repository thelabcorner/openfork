import { DateTime } from "luxon"

export function createSessionContextFormatter(locale: string) {
  return {
    number(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale)
    },
    percent(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale) + "%"
    },
    time(value: number | undefined) {
      if (!value) return "—"
      return DateTime.fromMillis(value).setLocale(locale).toLocaleString(DateTime.DATETIME_MED)
    },
    currency(value: number | null | undefined) {
      if (value === undefined || value === null) return "—"
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
      }).format(value)
    },
    tokensPerSecond(value: number | null | undefined) {
      if (value === undefined || value === null) return "—"
      return `~${value.toLocaleString(locale, { maximumFractionDigits: 1 })}`
    },
    duration(value: number | null | undefined) {
      if (value === undefined || value === null) return "—"
      if (value < 60) return `${value.toFixed(1)}s`
      const minutes = Math.floor(value / 60)
      const seconds = Math.round(value % 60)
      return `${minutes}m ${seconds}s`
    },
  }
}
