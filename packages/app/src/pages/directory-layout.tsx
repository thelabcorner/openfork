import { DataProvider } from "@opencode-ai/session-ui/context"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, onCleanup, type ParentProps, Show, untrack } from "solid-js"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { decode64 } from "@/utils/base64"
import { Schema } from "effect"
import type { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"

export function DirectoryDataProvider(
  props: ParentProps<{
    directory: string | Accessor<string>
    draftID?: string
    server?: Accessor<ServerConnection.Key | undefined>
  }>,
) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const serverSync = useServerSync()
  const sdk = useSDK()
  const language = useLanguage()
  const directory = createMemo(() => (typeof props.directory === "function" ? props.directory() : props.directory))
  const slug = createMemo(() => base64Encode(directory()))
  const href = (sessionID: string) => {
    const server = props.server?.()
    if (server) return sessionHref(server, sessionID)
    return `/${slug()}/session/${sessionID}`
  }

  const killShell = async (input: { sessionID: string; callID?: string; jobId?: string }) => {
    try {
      const response = await sdk().client.tool.kill({ toolKillPayload: input }, { throwOnError: true })
      if (!response.data.killed) {
        showToast({
          title: language.t("ui.tool.shell.stop.notRunning.title"),
          description:
            input.jobId ?
              language.t("ui.tool.shell.stop.notRunning.descriptionJob")
            : language.t("ui.tool.shell.stop.notRunning.description"),
        })
      }
      return response.data
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("ui.tool.shell.stop.failed.title"),
        description: errorMessage(error),
      })
      return { killed: false }
    }
  }

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "message" in err) {
      const value = (err as { message?: unknown }).message
      if (typeof value === "string") return value
    }
    if (err instanceof Error) return err.message
    return language.t("ui.tool.shell.stop.failed.description")
  }

  createEffect(() => {
    const next = sync().data.path.directory
    if (!next) return
    // Draft / server-scoped routes don't participate in directory normalization.
    // Read these via untrack so the effect only re-runs when the synced directory changes
    // (not on every location change) — avoids extra navigate checks and keeps prompt/scroll stable.
    if (untrack(() => props.draftID || props.server?.())) return
    // Compare via pathKey so same directory with different slash/casing doesn't remount DataProvider.
    if (pathKey(next) === pathKey(directory())) return
    const path = untrack(() => location.pathname.slice(slug().length + 1))
    const search = untrack(() => location.search)
    const hash = untrack(() => location.hash)
    navigate(`/${base64Encode(next)}${path}${search}${hash}`, { replace: true })
  })

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    serverSync().session.pin(sessionID)
    onCleanup(() => serverSync().session.unpin(sessionID))
  })

  return (
    <Show when={directory()} keyed fallback={null}>
      {(dir) => (
        <DataProvider
          data={sync().data}
          directory={dir}
          sessionID={params.id}
          onNavigateToSession={(sessionID: string) => navigate(href(sessionID))}
          onSessionHref={href}
          onKillShell={killShell}
        >
          <LocalProvider>{props.children}</LocalProvider>
        </DataProvider>
      )}
    </Show>
  )
}

export const ProjectDirString = Schema.String.pipe(Schema.brand("ProjectDirString"))
export type ProjectDirString = Schema.Schema.Type<typeof ProjectDirString>

export function decodeDirectory(dir: string): ProjectDirString | undefined {
  const decoded = decode64(dir)
  if (!decoded) return
  return ProjectDirString.make(decoded)
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  let invalid = ""

  // Return undefined (not "") for missing/invalid so Show's `when` is `string | undefined`
  // — avoids an extra "" remount and makes the keyed value non-nullable inside the child.
  const resolved = createMemo(() => {
    try {
      const dir = params.dir
      if (!dir) return undefined
      return decodeDirectory(dir)
    } catch {
      return undefined
    }
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    const value = resolved()
    if (value) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    <Show when={resolved()} keyed fallback={null}>
      {(value) => (
        <SDKProvider directory={value}>
          <DirectoryDataProvider directory={value}>{props.children}</DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
