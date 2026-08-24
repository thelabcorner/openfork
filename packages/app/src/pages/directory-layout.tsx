import { DataProvider } from "@opencode-ai/session-ui/context"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, onCleanup, type ParentProps, Show } from "solid-js"
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
  const directory = () => (typeof props.directory === "function" ? props.directory() : props.directory)
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
    // A draft lives at /new-session?draftId=… and has no directory segment to normalize.
    if (props.draftID || props.server?.()) return
    const next = sync().data.path.directory
    if (!next) return
    // Normalize both sides — `pathKey` handles trailing slashes / casing so a
    // periodic `path` refetch that returns the same directory with different
    // allocation or slash doesn't trigger a `navigate` loop that remounts the
    // keyed `DataProvider`/`LocalProvider` and wipes prompt + scroll.
    if (pathKey(next) === pathKey(directory())) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    serverSync().session.pin(sessionID)
    onCleanup(() => serverSync().session.unpin(sessionID))
  })

  return (
    <Show when={directory()} keyed>
      {(directory) => (
        <DataProvider
          data={sync().data}
          directory={directory}
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

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decodeDirectory(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
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
    <Show when={resolved()} keyed>
      {(resolved) => (
        <SDKProvider directory={resolved}>
          <DirectoryDataProvider directory={resolved}>{props.children}</DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
