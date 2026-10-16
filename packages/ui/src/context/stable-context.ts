import { createContext, type Context } from "solid-js"

// A long-lived provider can survive a lazy consumer's hot replacement. A
// re-created context would use a different Symbol and make useContext return
// undefined even when the provider is visibly still mounted.
//
// Reuse *tokens*, never context values. Scoped keys are opt-in because unrelated
// provider families can legitimately share the same display name. HMR data
// preserves the registry even when this module itself is hot-reloaded.
type ContextToken = Context<any>
const hotData = import.meta.hot?.data as { contextTokens?: Map<string, ContextToken> } | undefined
const tokens = hotData
  ? (hotData.contextTokens ?? (hotData.contextTokens = new Map<string, ContextToken>()))
  : new Map<string, ContextToken>()

export function createStableContext<T>(key?: string): Context<T | undefined> {
  if (!key) return createContext<T>()
  const existing = tokens.get(key)
  if (existing) return existing as Context<T | undefined>
  const created = createContext<T>()
  tokens.set(key, created)
  return created
}
