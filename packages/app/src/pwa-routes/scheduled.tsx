import { ScheduledTasksProvider } from "@/context/scheduled-tasks"
import { useLanguage } from "@/context/language"
import { scheduledTasksDict } from "@/i18n/en-scheduled-tasks"
import { promptRevisionDict } from "@/i18n/en-prompt-revision"
import { ScheduledPage } from "@/pages/scheduled-page"

/** Route-owned Scheduled state and copy stay outside the connected-home graph. */
export default function PwaScheduledRoute() {
  const language = useLanguage()
  language.registerTranslations(scheduledTasksDict)
  language.registerTranslations(promptRevisionDict)
  return (
    <ScheduledTasksProvider>
      <ScheduledPage />
    </ScheduledTasksProvider>
  )
}
