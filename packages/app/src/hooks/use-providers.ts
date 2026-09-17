import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { createEffect, createMemo, type Accessor } from "solid-js"
import { selectProviderCatalog } from "./provider-catalog"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "claude",
  "claude-api",
  "claude-code",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

const EMPTY = selectProviderCatalog({ explicit: true, directory: undefined })

export function useProviders(
  directory: Accessor<string | undefined>,
  options: { allowGlobal?: boolean } = {},
) {
  const serverSync = useServerSync()
  const params = useParams()
  const dir = () => (directory ? directory() : decode64(params.dir))
  // Undefined means "location not resolved", never "use process.cwd()".
  // The compatibility global catalog is opt-in only; new server-level UI uses
  // the Tier-0 provider-settings / usage-pricing surfaces instead.
  createEffect(() => {
    if (dir()) return
    if (!options.allowGlobal) return
    serverSync().providers.ensure()
  })
  const providers = () => {
    const value = dir()
    const projectStore = value ? serverSync().child(value, { bootstrap: false })[0] : undefined
    if (value)
      return selectProviderCatalog({
        explicit: true,
        directory: value,
        catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      })
    if (!options.allowGlobal) return EMPTY
    return selectProviderCatalog({
      explicit: false,
      directory: value,
      catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      global: serverSync().data.provider,
    })
  }

  return {
    all: () => providers().all,
    default: () => providers().default,
    defaultModel: () => providers().defaultModel,
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      const paid = [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connected.has(id) &&
            (id !== "opencode" || Object.values(providers().all.get(id)?.models ?? {}).some((m) => m.cost?.input)),
        ),
      ]
      return paid
    },
  }
}
