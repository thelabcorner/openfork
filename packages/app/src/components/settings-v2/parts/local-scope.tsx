import { createMemo, Show, type JSX, type ParentProps } from "solid-js"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { SDKProvider } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { DirectoryDataProvider } from "@/pages/directory-layout"

function tryUseLocal() {
  try {
    return useLocal()
  } catch {
    return undefined
  }
}

function useSettingsDirectory() {
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  return createMemo(() => {
    const route = layout.route()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return layout.projects.list()[0]?.worktree
  })
}

export function SettingsLocalScope(props: ParentProps<{ fallback?: JSX.Element }>) {
  if (tryUseLocal()) return props.children
  return <SettingsLocalScopeMount fallback={props.fallback}>{props.children}</SettingsLocalScopeMount>
}

function SettingsLocalScopeMount(props: ParentProps<{ fallback?: JSX.Element }>) {
  const directory = useSettingsDirectory()
  return (
    <Show when={directory()} keyed fallback={props.fallback ?? null}>
      {(dir) => (
        <SDKProvider directory={dir}>
          <DirectoryDataProvider directory={dir}>{props.children}</DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
