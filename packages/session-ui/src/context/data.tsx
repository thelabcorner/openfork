import type { Message, Session, Part, SnapshotFileDiff, SessionStatus, Provider } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"

export type NormalizedProviderListResponse = {
  all: Map<string, Provider>
  defaultModel?: {
    providerID: string
    modelID: string
  } | null
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: (SnapshotFileDiff | FileDiffInfo)[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta?: {
    [partID: string]: string
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

export type KillShellInput = {
  sessionID: string
  callID?: string
  jobId?: string
}

export type KillShellResult = {
  killed: boolean
  status?: string
}

export type KillShellFn = (input: KillShellInput) => Promise<KillShellResult>

export type SessionNavigationInput = {
  sessionID: () => string | undefined
  href: () => string | undefined
  navigateToSession?: NavigateToSessionFn
}

/**
 * Shared Session-entry interaction semantics.
 *
 * This layer is deliberately context-free: callers own Session addressing
 * (directory-scoped, global, group-scoped, etc.) and provide only an href plus
 * optional in-app navigation callback. Modifier clicks retain ordinary anchor
 * behavior; plain clicks use the app router when available.
 */
export function createSessionNavigation(input: SessionNavigationInput) {
  const clickable = () => !!(input.sessionID() && (input.navigateToSession || input.href()))

  const open = () => {
    const id = input.sessionID()
    if (!id) return
    input.navigateToSession?.(id)
  }

  const navigate = (event: MouseEvent) => {
    if (!input.navigateToSession) return
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const id = input.sessionID()
    if (!id) return
    event.preventDefault()
    input.navigateToSession(id)
  }

  const navigateKey = (event: KeyboardEvent) => {
    if (!clickable() || input.href()) return
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    open()
  }

  return { href: input.href, clickable, open, navigate, navigateKey }
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    sessionID?: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    onKillShell?: KillShellFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      get sessionID() {
        return props.sessionID
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      killShell: props.onKillShell,
    }
  },
})

/**
 * Shared child-Session navigation contract.
 *
 * Session-producing surfaces (Task, Goal Auditor, future special agents) supply
 * only an already-materialized Session ID. This helper owns the common
 * href/in-app-navigation/modifier-key behavior so each presentation surface does
 * not reimplement Session entry semantics.
 */
export function useSessionNavigation(sessionID: () => string | undefined) {
  const data = useData()
  return createSessionNavigation({
    sessionID,
    href: () => {
      const id = sessionID()
      if (!id) return undefined
      return data.sessionHref?.(id)
    },
    navigateToSession: data.navigateToSession,
  })
}
