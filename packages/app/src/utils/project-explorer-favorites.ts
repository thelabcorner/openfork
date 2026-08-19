import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

// Standalone favorited-file paths for the project explorer — deliberately
// not shared with the model-selector's favorites store (context/models.tsx);
// different domain, same lightweight pattern.
export function createProjectExplorerFavorites() {
  const [store, setStore] = persisted(Persist.global("project-explorer-favorites"), createStore({ paths: [] as string[] }))
  const set = createMemo(() => new Set(store.paths))

  return {
    isFavorite: (path: string) => set().has(path),
    list: () => store.paths,
    toggle: (path: string) => {
      if (set().has(path)) {
        setStore("paths", (paths) => paths.filter((entry) => entry !== path))
        return
      }
      setStore("paths", (paths) => [...paths, path])
    },
  }
}

export type ProjectExplorerFavorites = ReturnType<typeof createProjectExplorerFavorites>
