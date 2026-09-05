import { For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { useSessionGroups, type SessionGroupEntry } from "@/context/session-groups"
import { useTabs, groupHref } from "@/context/tabs"
import type { ServerConnection } from "@/context/server"

type GroupTabHeaderProps = {
  group: SessionGroupEntry
  activeSessionId: string | undefined
  server: ServerConnection.Key
}

export function GroupTabHeader(props: GroupTabHeaderProps) {
  const language = useLanguage()
  const navigate = useNavigate()
  const tabs = useTabs()
  const groups = useSessionGroups()

  const sessionTitle = (sessionId: string) => props.group.sessions.find((session) => session.id === sessionId)?.title

  const switchSession = (sessionId: string) => {
    navigate(`${groupHref(props.server, props.group.id)}/session/${sessionId}`)
  }

  const removeSession = async (sessionId: string) => {
    const member = props.group.sessions.find((session) => session.id === sessionId)
    if (member?.locked) return
    await groups.removeSessionFromGroup({ sessionId, groupId: props.group.id })
    const remaining = props.group.sessionIds.filter((id) => id !== sessionId)
    if (remaining.length > 0 && props.activeSessionId === sessionId) {
      switchSession(remaining[0])
    } else if (remaining.length === 0) {
      tabs.removeGroupTab({ server: props.server, groupId: props.group.id })
    }
  }

  return (
    <div class="flex h-10 shrink-0 items-center gap-2 border-b border-v2-border-border-base px-3">
      <span class="text-13-medium text-v2-text-text-base truncate max-w-[200px]">{props.group.name}</span>
      <div class="w-px h-4 bg-v2-border-border-base" />
      <div class="flex items-center gap-1 overflow-x-auto min-w-0">
        <For each={props.group.sessionIds}>
          {(sessionId) => (
            <div
              role="group"
              class={`flex items-center gap-1 px-2 py-1 rounded-[4px] text-[12px] whitespace-nowrap transition-colors ${
                sessionId === props.activeSessionId
                  ? "bg-v2-background-bg-layer-03 text-v2-text-text-base"
                  : "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"
              }`}
              onClick={() => switchSession(sessionId)}
            >
              <button
                type="button"
                class="min-w-0 max-w-[120px] truncate text-start focus-visible:outline-none"
                onClick={() => switchSession(sessionId)}
                aria-label={sessionTitle(sessionId) || sessionId.slice(0, 8)}
              >
                {sessionTitle(sessionId) || sessionId.slice(0, 8)}
              </button>
              <Show
                when={!props.group.sessions.find((session) => session.id === sessionId)?.locked}
                fallback={
                  <span
                    class="ml-0.5"
                    title={language.t("groupTab.lockedMembership")}
                    aria-label={language.t("groupTab.lockedMembership")}
                  >
                    🔒
                  </span>
                }
              >
                <button
                  type="button"
                  class="ml-0.5 inline-flex size-4 items-center justify-center rounded text-v2-text-text-faint hover:text-v2-text-text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-base"
                  aria-label={language.t("groupTab.removeSession")}
                  title={language.t("groupTab.removeSession")}
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeSession(sessionId)
                  }}
                >
                  ×
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={props.group.sessionIds.length === 0}>
        <span class="text-12-regular text-v2-text-text-muted">{language.t("groupTab.noSessions")}</span>
      </Show>
    </div>
  )
}
