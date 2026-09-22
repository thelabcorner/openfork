import { OxpActivityProvider } from "@/context/oxp-activity"
import { useLanguage } from "@/context/language"
import { oxpActivityDict } from "@/i18n/en-oxp-activity"
import { OxpActivityLandingPage, OxpActivityPage } from "@/pages/oxp-activity-page"

/** OXP Activity is a management surface; load its provider and copy only on demand. */
export function PwaOxpRoute() {
  useLanguage().registerTranslations(oxpActivityDict)
  return (
    <OxpActivityProvider>
      <OxpActivityLandingPage />
    </OxpActivityProvider>
  )
}

export function PwaOxpActivityRoute() {
  useLanguage().registerTranslations(oxpActivityDict)
  return (
    <OxpActivityProvider>
      <OxpActivityPage />
    </OxpActivityProvider>
  )
}
