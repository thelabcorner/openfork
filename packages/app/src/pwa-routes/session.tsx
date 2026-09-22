import "@/pwa-session.css"
import {
  GroupTabRouteController as SharedGroupTabRouteController,
  NewLayoutLegacySessionRedirectController as SharedNewLayoutLegacySessionRedirectController,
  TargetSessionCenterRouteController as SharedTargetSessionCenterRouteController,
} from "@/app-session-routes"
import { useLanguage } from "@/context/language"
import { projectExplorerDict } from "@/i18n/en-project-explorer"
import { promptRevisionDict } from "@/i18n/en-prompt-revision"
import { sessionPermissionDict } from "@/i18n/en-session-permissions"

function registerSessionTranslations() {
  const language = useLanguage()
  language.registerTranslations(projectExplorerDict)
  language.registerTranslations(promptRevisionDict)
  language.registerTranslations(sessionPermissionDict)
}

export function GroupTabRouteController() {
  registerSessionTranslations()
  return <SharedGroupTabRouteController />
}

export function NewLayoutLegacySessionRedirectController() {
  registerSessionTranslations()
  return <SharedNewLayoutLegacySessionRedirectController />
}

export function TargetSessionCenterRouteController() {
  registerSessionTranslations()
  return <SharedTargetSessionCenterRouteController />
}
