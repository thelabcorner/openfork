import { useQuery } from "@tanstack/solid-query"
import { createContext, createMemo, createSignal, type Accessor, type ParentProps, useContext } from "solid-js"
import { ModelsProvider } from "@/context/models"
import { useLayout } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { pathKey } from "@/utils/path-key"

type PickerToken = object

export function createModelPickerOpenGate() {
  const [count, setCount] = createSignal(0)
  const open = new Set<PickerToken>()

  const set = (token: PickerToken, value: boolean) => {
    const had = open.has(token)
    if (value === had) return
    if (value) open.add(token)
    else open.delete(token)
    setCount(open.size)
  }

  return {
    active: () => count() > 0,
    set,
  }
}

type SettingsModelCatalogScopeState = {
  directory: Accessor<string | undefined>
  setPickerOpen: (token: PickerToken, open: boolean) => void
}

const SettingsModelCatalogContext = createContext<SettingsModelCatalogScopeState>()

export function useSettingsModelCatalogScope() {
  return useContext(SettingsModelCatalogContext)
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

/**
 * Narrow settings-only model scope.
 *
 * Special-agent model configuration needs a workspace model catalog, not the
 * full directory/session runtime. Keep that Tier-2 dependency explicit and
 * lazy: one shared catalog query is enabled only while any settings picker is
 * open, and ModelsProvider consumes the query result directly without creating
 * SDKProvider -> DirectoryDataProvider -> DataProvider -> LocalProvider.
 */
export function SettingsModelCatalogScope(props: ParentProps) {
  const serverSync = useServerSync()
  const directory = useSettingsDirectory()
  const target = createMemo(() => pathKey(directory()?.trim()))
  const gate = createModelPickerOpenGate()
  const catalogQuery = useQuery(() => ({
    ...serverSync().queryOptions.providers(target()),
    enabled: gate.active() && !!target(),
  }))
  // Suspension-safe read: Solid Query's unresolved `.data` accessor may park
  // the nearest Suspense boundary and produce a route-level black frame.
  const catalog = () => (catalogQuery.isPending ? undefined : catalogQuery.data)

  return (
    <SettingsModelCatalogContext.Provider value={{ directory, setPickerOpen: gate.set }}>
      <ModelsProvider catalog={catalog} warmUsage={false}>
        {props.children}
      </ModelsProvider>
    </SettingsModelCatalogContext.Provider>
  )
}
