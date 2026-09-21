import { Show, Suspense, createMemo, createSignal, lazy } from "solid-js"
import { useParams, useNavigate } from "@solidjs/router"
import { useSessionGroups } from "@/context/session-groups"
import { groupHref } from "@/context/tabs"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { GroupTabHeader } from "./group-tab-header"

const SessionPage = lazy(() => import("./session").then((m) => ({ default: m.SessionPage })))
const SwarmPanel = lazy(() => import("./swarm/swarm-panel").then((m) => ({ default: m.SwarmPanel })))

export default function GroupTabPage() {
  const params = useParams<{ serverKey: string; groupId: string; sessionId?: string }>()
  const navigate = useNavigate()
  const groups = useSessionGroups()
  const server = useServer()
  const language = useLanguage()
  const [swarmPanelOpen, setSwarmPanelOpen] = createSignal(false)

  const group = createMemo(() => groups.byID(params.groupId))
  const swarmID = createMemo(() => {
    const current = group()
    if (current?.kind !== "swarm") return
    return current.ownerRef
  })
  const activeSessionId = () => params.sessionId ?? group()?.sessionIds[0]

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show when={group()}>
        <GroupTabHeader
          group={group()!}
          activeSessionId={activeSessionId()}
          server={server.key}
          swarmPanelOpen={swarmPanelOpen()}
          onToggleSwarmPanel={() => setSwarmPanelOpen((open) => !open)}
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
            <button
              type="button"
              class="rounded-md bg-v2-background-bg-layer-02 px-3 py-1.5 text-12-medium text-v2-text-text-base hover:bg-v2-background-bg-layer-03 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-base"
              onClick={() => navigate("/")}
            >
              {language.t("sessionGroup.addSessions")}
            </button>
          </div>
        }
      >
        <div class="flex min-h-0 flex-1 overflow-hidden">
          <div class="min-w-0 flex-1 overflow-hidden">
            <Suspense
              fallback={
                <div class="flex min-h-0 flex-1 items-center justify-center">
                  <span class="text-13-regular text-v2-text-text-muted">{language.t("common.loading")}</span>
                </div>
              }
            >
              <SessionPage />
            </Suspense>
          </div>
          <Show when={swarmPanelOpen() && swarmID()}>
            {(id) => (
              <Suspense
                fallback={
                  <aside class="flex h-full w-[390px] shrink-0 items-center justify-center border-s border-v2-border-border-base bg-v2-background-bg-base text-11-regular text-v2-text-text-muted">
                    {language.t("swarm.panel.loading")}
                  </aside>
                }
              >
                <SwarmPanel swarmID={id()} onClose={() => setSwarmPanelOpen(false)} />
              </Suspense>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}
