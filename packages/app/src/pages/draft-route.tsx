import { Navigate } from "@solidjs/router"
import { createMemo, lazy, Show, Suspense, type ParentProps } from "solid-js"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ForkUsageProvider } from "@/context/fork-usage"
import { PersonalUsageProvider } from "@/context/personal-usage"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { SDKProvider } from "@/context/sdk"
import { useGlobal } from "@/context/global"
import { useSearchParams } from "@solidjs/router"
import { useTabs, type DraftTab } from "@/context/tabs"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { RoutePlaceholder } from "@/components/route-placeholder"

const NewSession = lazy(() => import("@/pages/new-session"))

function DraftProviders(props: ParentProps) {
  return (
    <FileProvider>
      <PromptProvider>
        <CommentsProvider>{props.children}</CommentsProvider>
      </PromptProvider>
    </FileProvider>
  )
}

function ResolvedDraftRoute(props: { draft: DraftTab }) {
  const global = useGlobal()
  const conn = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === props.draft.server))
  const directory = () => props.draft.directory
  const serverKey = () => props.draft.server

  return (
    <Show when={`${props.draft.server}\0${props.draft.directory}`} keyed>
      <ServerSDKProvider server={conn}>
        <PersonalUsageProvider>
          <ServerSyncProvider server={conn}>
            <ForkUsageProvider>
              <SDKProvider directory={directory}>
                <DirectoryDataProvider directory={directory} server={serverKey}>
                  <DraftProviders>
                    <Suspense fallback={<RoutePlaceholder />}>
                      <NewSession />
                    </Suspense>
                  </DraftProviders>
                </DirectoryDataProvider>
              </SDKProvider>
            </ForkUsageProvider>
          </ServerSyncProvider>
        </PersonalUsageProvider>
      </ServerSDKProvider>
    </Show>
  )
}

export default function DraftRoute() {
  const [search] = useSearchParams<{ draftId?: string }>()
  const settings = useSettings()
  const tabs = useTabs()
  const draft = createMemo(() =>
    search.draftId ? tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId) : undefined,
  )
  const draftKey = createMemo(() => {
    const found = draft()
    return found ? `${found.server}\0${found.directory}\0${found.draftID}` : undefined
  })

  return (
    <Show when={tabs.ready()} fallback={<RoutePlaceholder />}>
      <Show when={draftKey()} keyed fallback={<Navigate href="/" />}>
        {(_) => {
          const found = draft()!
          return (
            <Show
              when={settings.general.newLayoutDesigns()}
              fallback={<Navigate href={`/${base64Encode(found.directory)}/session`} />}
            >
              <ResolvedDraftRoute draft={found} />
            </Show>
          )
        }}
      </Show>
    </Show>
  )
}
