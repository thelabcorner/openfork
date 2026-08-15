import { createSignal } from "solid-js"
import type { CompatibleApi } from "@/utils/server-compat"
import type { ServerCtx } from "@/context/global"

// Forward-compat control surface: `pause` / `resume` / `regenerateTitle` land on
// the app's session API via the vendored client refresh + server-compat passthroughs
// (swarm slices 2/3). Signatures mirror the regenerated client types exactly
// (SessionsPauseInput / SessionsResumeInput / SessionsRegenerateTitleInput).
type TabSessionControl = {
  pause(input: { sessionID: string }): Promise<unknown>
  resume(input: { sessionID: string }): Promise<unknown>
  regenerateTitle(input: { sessionID: string; model?: { id: string; providerID: string; variant?: string }; prompt?: string }): Promise<unknown>
}

export type TabSessionApi = CompatibleApi["session"] & TabSessionControl

const sessionControl = (api: CompatibleApi["session"]) => api as unknown as TabSessionApi

export function sessionApiOf(ctx: ServerCtx | undefined): TabSessionApi | undefined {
  return ctx?.sdk.api.session ? sessionControl(ctx.sdk.api.session) : undefined
}

// Client-side regenerate pending registry, keyed by sessionID (retitle §5.2 —
// the disabled + label-swap double-fire guard). Process-local like SessionExecution.
const [regenerating, setRegenerating] = createSignal<ReadonlySet<string>>(new Set())

export const isTitleRegenerationPending = (sessionID: string | undefined) =>
  !!sessionID && regenerating().has(sessionID)

export function beginTitleRegeneration(sessionID: string) {
  setRegenerating((set) => new Set(set).add(sessionID))
}

export function endTitleRegeneration(sessionID: string) {
  setRegenerating((set) => {
    if (!set.has(sessionID)) return set
    const next = new Set(set)
    next.delete(sessionID)
    return next
  })
}
