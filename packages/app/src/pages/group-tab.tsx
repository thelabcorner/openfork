import { Show, Suspense, createMemo, lazy } from "solid-js"
import { useParams, useNavigate } from "@solidjs/router"
import { useSessionGroups } from "@/context/session-groups"
import { useTabs, groupHref } from "@/context/tabs"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { GroupTabHeader } from "./group-tab-header"

const SessionPage = lazy(() => import("./session").then((m) => ({ default: m.SessionPage })))

export default function GroupTabPage() {
  const params = useParams<{ serverKey: string; groupId: string; sessionId?: string }>()
  const navigate = useNavigate()
  const groups = useSessionGroups()
  const tabs = useTabs()
  const server = useServer()
  const language = useLanguage()

  const group = createMemo(() => groups.byID(params.groupId))
  const activeSessionId = () => params.sessionId ?? group()?.sessionIds[0]

  const switchSession = (sessionId: string) => {
    navigate(`${groupHref(server.key, params.groupId)}/session/${sessionId}`)
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show when={group()}>
        <GroupTabHeader
          group={group()!}
          activeSessionId={activeSessionId()}
          server={server.key}
        />
      </Show>
      <Show
        when={activeSessionId()}
        fallback={
          <div class="flex min-h-0 flex-1 flex-col items-center gap-4 px-6 pt-[52px] text-center">
            <span class="text-[13px] text-v2-text-text-base [font-weight:530]">
              {language.t("groupTab.noSessions")}
            </span>
            <p class="text-[13px] text-v2-text-text-muted [font-weight:440]">
              {language.t("sessionGroup.empty.description")}
            </p>
          </div>
        }
      >
        <div class="flex-1 min-h-0 overflow-hidden">
          <Suspense
            fallback={
              <div class="flex min-h-0 flex-1 items-center justify-center">
                <span class="text-13-regular text-v2-text-text-muted">
                  {language.t("common.loading")}
                </span>
              </div>
            }
          >
            <SessionPage />
          </Suspense>
        </div>
      </Show>
    </div>
  )
}
