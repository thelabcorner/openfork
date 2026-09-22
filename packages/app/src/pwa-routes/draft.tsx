import "@/pwa-session.css"
import SharedDraftRoute from "@/pages/draft-route"
import { useLanguage } from "@/context/language"
import { projectExplorerDict } from "@/i18n/en-project-explorer"
import { promptRevisionDict } from "@/i18n/en-prompt-revision"

export default function PwaDraftRoute() {
  const language = useLanguage()
  language.registerTranslations(projectExplorerDict)
  language.registerTranslations(promptRevisionDict)
  return <SharedDraftRoute />
}
