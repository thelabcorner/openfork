import type { FilePart, Part, Project, UserMessage } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import {
  batch,
  ErrorBoundary,
  lazy,
  onCleanup,
  Suspense,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createComputed,
  createSignal,
  on,
  onMount,
  type ParentProps,
  untrack,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { debounce } from "@solid-primitives/scheduled"
import { useLocal } from "@/context/local"
import { FileProvider, selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Spinner } from "@opencode-ai/ui/spinner"
import { RouteLoadingFallback } from "@/components/route-loading-fallback"

const ProjectExplorerPanel = lazy(() =>
  import("@/pages/session/v2/project-explorer-panel").then((m) => ({ default: m.ProjectExplorerPanel })),
)
import { createProjectExplorerPanelState } from "@/pages/session/v2/project-explorer-panel-state"
import { isScrollKeyTarget, scrollKey, scrollKeyOwner } from "@opencode-ai/ui/scroll-view"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { previewSelectedLines } from "@opencode-ai/session-ui/pierre/selection-bridge"
import { FileSearchBar } from "@opencode-ai/session-ui/file-search"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useLocation, useNavigate, useParams, useSearchParams, type RouteSectionProps } from "@solidjs/router"
import { NewSessionView, SessionHeader } from "@/components/session"
import { ErrorPage } from "@/pages/error"
import { CommentsProvider, useComments } from "@/context/comments"
import { useCommand } from "@/context/command"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { useNotification } from "@/context/notification"
import { PromptProvider, usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection, serverName, useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { TerminalProvider, useTerminal } from "@/context/terminal"
import { TextField } from "@opencode-ai/ui/text-field"
import { PromptInput } from "@/components/prompt-input"
import { PromptInputV2Composer, usePromptInputV2Controller } from "@/components/prompt-input-v2"
import { useSettingsCommand } from "@/components/settings-dialog"
import { setCursorPosition } from "@/components/prompt-input/editor-dom"
import { promptLength } from "@/components/prompt-input/history"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import {
  createPromptInputController,
  createSessionComposerController,
  createSessionComposerRegionController,
  SessionComposerRegion,
} from "@/pages/session/composer"
import { createSessionTabs, createSizing, shouldShowFileTree, createSwitchGate } from "@/pages/session/helpers"
import { safeQueryData } from "@/utils/safe-query-data"
import { MessageTimeline } from "@/pages/session/timeline/message-timeline"
import { createTimelineModel } from "@/pages/session/timeline/model"
import { createSessionFindBarPosition, createSessionFindMatcher } from "@/pages/session/session-find"
import "@/pages/session/session-find.css"
import { createSessionTextHighlighter } from "@/pages/session/session-text-highlighter"
import { useSessionLayout } from "@/pages/session/session-layout"
import { restorePromptModel, syncPromptModel, syncSessionModel } from "@/pages/session/session-model-helpers"
import {
  clampSessionPanelWidth,
  SESSION_PANEL_WIDTH_MIN,
  sessionPanelWidthMax,
} from "@/pages/session/session-panel-width"
import { USAGE_PANEL_WIDTH_MIN } from "@/pages/session/usage-panel-state"
import { MODELS_PANEL_WIDTH_MIN } from "@/pages/session/models-panel-state"
import { LIMITS_PANEL_WIDTH_MIN } from "@/pages/session/limits-panel-state"
import { CONTEXT_PANEL_WIDTH_MIN } from "@/pages/session/context-panel-state"
import {
  PROJECT_EXPLORER_TREE_WIDTH_MIN,
  PROJECT_EXPLORER_TREE_WIDTH_MAX,
  PROJECT_EXPLORER_EDITOR_WIDTH_MIN,
  PROJECT_EXPLORER_EDITOR_WIDTH_MAX,
} from "@/pages/session/v2/project-explorer-panel-state"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { ContextPanel } from "@/pages/session/context-panel"
import { createContextPanelState } from "@/pages/session/context-panel-state"
import { UsagePanel } from "@/pages/session/usage-panel"
import { createUsagePanelState } from "@/pages/session/usage-panel-state"
import { ModelsPanel } from "@/pages/session/models-panel"
import { createModelsPanelState } from "@/pages/session/models-panel-state"
import { LimitsPanel } from "@/pages/session/limits-panel"
import { createLimitsPanelState } from "@/pages/session/limits-panel-state"
import { sessionPanelLayout } from "@/pages/session/session-panel-layout"

/**
 * One pane in the horizontal session row. `absorb` marks the single `flex: 1`
 * pane whose width is layout-derived rather than stored -- see `orderedPanes`.
 */
interface RowPane {
  id: string
  size: () => number
  min: number
  max?: number
  resize: (width: number) => void
  el: () => HTMLElement | null
  absorb?: boolean
}
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { TerminalPanelV2 } from "@/pages/session/terminal-panel-v2"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { Identifier } from "@/utils/id"
import { createFileOpsPort } from "@/utils/file-ops-port"
import { Persist, persisted } from "@/utils/persist"
import { extractPromptFromParts } from "@/utils/prompt"
import { formatServerError, isLocalSessionNotFoundError, isSessionNotFoundError } from "@/utils/server-errors"
import { legacySessionHref, parseServerKey, requireServerKey, sessionHref } from "@/utils/session-route"
import { useUsageExceededDialogs } from "./session/usage-exceeded-dialogs"
import { createSessionOwnership } from "./session/session-ownership"
import { createSessionLineage } from "./session/session-lineage"

type FollowupItem = FollowupDraft & { id: string }
type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">
const emptyFollowups: FollowupItem[] = []

const sessionViewState = () => ({
  messageId: undefined as string | undefined,
  mobileTab: "session" as "session" | "changes",
})

function isCurrentSessionNotFoundError(error: unknown, sessionID: string | undefined) {
  if (!sessionID) return false
  return isSessionNotFoundError(error, sessionID) || isLocalSessionNotFoundError(error, sessionID)
}

async function runPromptRollbackMutation<T, R>(input: {
  capturePrompt: () => { current: () => T[]; set: (value: T[]) => void; reset: () => void }
  optimistic: (prompt: { set: (value: T[]) => void; reset: () => void }) => void
  request: () => Promise<R>
  complete: (result: R) => void
  rollback: () => void
  fail: (error: unknown) => void
}) {
  const prompt = input.capturePrompt()
  const previous = prompt.current().slice()
  batch(() => input.optimistic(prompt))
  await input
    .request()
    .then(input.complete)
    .catch((error) => {
      batch(() => {
        input.rollback()
        prompt.set(previous)
      })
      input.fail(error)
    })
}

/**
 * "pane" renders the full desktop session page (header + pane row + side
 * panels). "center" renders only the center column (timeline + composer
 * mount) for shells that supply their own chrome — see SessionCenterColumn.
 */
type SessionPageVariant = "pane" | "center"

export function SessionPage(props: { variant?: SessionPageVariant; suppressMobileTabs?: boolean }) {
  return (
    <SessionProviders>
      <Page variant={props.variant} suppressMobileTabs={props.suppressMobileTabs} />
    </SessionProviders>
  )
}

// Mobile-shell entry point (F2 extraction): the session center column without
// the desktop pane scaffold. Requires the same provider subtree as SessionPage.
// suppressMobileTabs hides the in-column session/changes tab strips (both
// placements) when the shell supplies its own bottom chrome.
export function SessionCenterColumn(props: { suppressMobileTabs?: boolean }) {
  return (
    <SessionProviders>
      <Page variant="center" suppressMobileTabs={props.suppressMobileTabs} />
    </SessionProviders>
  )
}

// Rendered under app.tsx's TargetSessionRoute, which owns the per-server keyed
// remount around the server-scoped providers. Nothing here may key on the
// session ID: session tabs on the same server share this route instance, and
// workspace-scoped state (terminal, directory providers) lives below.
export function TargetSessionRouteContent(props: { variant?: SessionPageVariant; suppressMobileTabs?: boolean }) {
  const params = useParams<{ serverKey: string; id: string }>()
  const serverSync = useServerSync()
  const directory = createMemo(() => serverSync().session.lineage.peek(params.id)?.session.directory)
  return (
    <SessionRouteErrorBoundary sessionID={params.id} serverKey={parseServerKey(params.serverKey)} padded>
      {/* Settings must keep the target-server SDK, sync, and models context and remain registered
          when session content falls back to the route error boundary. */}
      <TargetServerScopedProviders directory={directory} sessionID={() => params.id}>
        <TargetSessionSettingsCommand />
        <ResolvedTargetSessionRoute variant={props.variant} suppressMobileTabs={props.suppressMobileTabs} />
      </TargetServerScopedProviders>
    </SessionRouteErrorBoundary>
  )
}

// Route-ready center-column mount (lineage resolution, error boundary, and
// target-server providers included) for mobile shells. Partial RouteSectionProps
// keeps it usable both as a router `component` and as a plain JSX element.
export function TargetSessionCenterRoute(
  props: Partial<RouteSectionProps<unknown>> & { suppressMobileTabs?: boolean },
) {
  return <TargetSessionRouteContent variant="center" suppressMobileTabs={props.suppressMobileTabs} />
}

function TargetSessionSettingsCommand() {
  useSettingsCommand()
  return null
}

export function SessionRouteErrorBoundary(
  props: ParentProps<{ sessionID?: string; serverKey?: ServerConnection.Key; padded?: boolean }>,
) {
  const settings = useSettings()
  return (
    <ErrorBoundary
      fallback={(error) =>
        settings.general.newLayoutDesigns() ? (
          <SessionRouteFrame padded={props.padded}>
            <SessionPanelFrame newLayout raised={!!props.sessionID}>
              <SessionErrorFallback error={error} sessionID={props.sessionID} serverKey={props.serverKey} />
            </SessionPanelFrame>
          </SessionRouteFrame>
        ) : (
          <ErrorPage error={error} />
        )
      }
    >
      {props.children}
    </ErrorBoundary>
  )
}

function SessionErrorFallback(props: { error: unknown; sessionID?: string; serverKey?: ServerConnection.Key }) {
  const language = useLanguage()
  const server = useServer()
  const platform = usePlatform()
  const tabs = useTabs()
  const formatted = () => formatRouteError(props.error)
  const displayServer = createMemo(() => {
    const key = props.serverKey ?? server.key
    const conn = server.list.find((item) => ServerConnection.key(item) === key)
    return conn ? serverName(conn) : key
  })
  const closeTab = () => {
    if (!props.sessionID) return
    tabs.removeSessionTab({ server: props.serverKey ?? server.key, sessionId: props.sessionID })
  }
  if (isCurrentSessionNotFoundError(props.error, props.sessionID)) {
    return (
      <div class="flex-1 min-h-0 overflow-hidden">
        <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-4">
          <div class="flex flex-col items-center gap-2">
            <div class="text-16-medium text-text max-w-md">{language.t("session.error.notFound")}</div>
            <div class="text-13-regular text-text-weak max-w-md">
              {language.t("session.error.notFound.description")}
            </div>
          </div>
          <Show when={props.sessionID}>
            {(sessionID) => (
              <div class="max-w-full flex flex-col items-center gap-1">
                <div class="max-w-full text-11-regular text-text-faint break-all">{displayServer()}</div>
                <code class="max-w-full rounded-[4px] px-1 py-0.5 font-mono text-xs font-medium leading-4 text-text-base break-all bg-[color-mix(in_oklch,var(--v2-text-text-base)_8%,transparent)]">
                  {sessionID()}
                </code>
              </div>
            )}
          </Show>
          <ButtonV2 variant="neutral" size="normal" icon="xmark-small" onClick={closeTab}>
            {language.t("session.error.notFound.closeTab")}
          </ButtonV2>
        </div>
      </div>
    )
  }
  return (
    <div class="flex-1 min-h-0 overflow-hidden">
      <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-4">
        <div class="flex flex-col items-center gap-2 w-full max-w-2xl">
          <div class="text-16-medium text-text">{language.t("error.page.title")}</div>
          <TextField
            value={formatted()}
            readOnly
            copyable
            multiline
            class="max-h-96 w-full font-mono text-xs no-scrollbar"
          />
        </div>
        <div class="flex flex-row items-center gap-2">
          <ButtonV2 variant="neutral" size="normal" onClick={() => platform.refresh()}>
            {language.t("error.page.action.refresh")}
          </ButtonV2>
          <Show when={props.sessionID}>
            <ButtonV2 variant="neutral" size="normal" icon="xmark-small" onClick={closeTab}>
              {language.t("session.error.notFound.closeTab")}
            </ButtonV2>
          </Show>
        </div>
      </div>
    </div>
  )
}

function formatRouteError(error: unknown) {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error, null, 2)
  } catch {
    return String(error)
  }
}

function ResolvedTargetSessionRoute(props: { variant?: SessionPageVariant; suppressMobileTabs?: boolean }) {
  const params = useParams<{ serverKey: string; id: string }>()
  const language = useLanguage()
  const tabs = useTabs()
  const sync = useServerSync()
  const serverKey = createMemo(() => requireServerKey(params.serverKey))
  const current = createSessionLineage(
    () => params.id,
    () => sync().session.lineage,
  )
  const directory = createMemo(() => current()?.session.directory)
  const targetDirectory = () => directory()!

  createEffect(() => {
    const session = current()
    if (!session) return
    tabs.addSessionTab({
      server: serverKey(),
      sessionId: session.root.id,
    })
  })

  return (
    // Non-keyed Show on directory(): loading fallback ONLY for uncached lineage
    // (preserves SDKProvider + DirectoryDataProvider + TargetSessionPage shell
    // on same-workspace session-id switches). Warm targets resolve sync from
    // cache → instant keep-alive. See TargetSessionPage workspace key + now
    // workspaceKey()-keyed panel shell (no remount of composer/panels on id change).
    <Show when={directory()} fallback={<SessionLoadingFallback language={language} sessionID={params.id} />}>
      <SDKProvider directory={targetDirectory}>
        <DirectoryDataProvider directory={targetDirectory} server={serverKey}>
          <TargetSessionPage variant={props.variant} suppressMobileTabs={props.suppressMobileTabs} />
        </DirectoryDataProvider>
      </SDKProvider>
    </Show>
  )
}

function SessionLoadingFallback(props: { language: ReturnType<typeof useLanguage>; sessionID?: string }) {
  return (
    <div class="relative size-full overflow-hidden flex flex-col" style={{ height: "calc(100% - 1px)" }}>
      <div class="flex-1 min-h-0 flex flex-col items-center justify-center text-center gap-4 p-6">
        <Spinner class="size-8" style={{ color: "var(--icon-weak)" }} />
        <div class="flex flex-col items-center gap-1 max-w-md">
          <div class="text-14-medium text-text-weak">{props.language.t("session.loading")}</div>
          <div class="text-12-regular text-text-faint">
            {props.language.t("session.loading.description")}
          </div>
        </div>
      </div>
    </div>
  )
}

// Owns the workspace-identity remount (scope+directory key). Session ID changes
// within same workspace DO NOT remount here (or SDKProvider/DirectoryDataProvider
// above it, or SessionProviders below). See ResolvedTargetSessionRoute:310
// non-keyed dir Show + sessionPanelKey now workspaceKey() (line ~475). Provider
// teardown only on Home↔session (higher serverKey in app.tsx) or dir change.
// SessionPage handles id changes reactively; avoids destroying terminal PTYs,
// file/prompt providers, persisted trees, composer controller.
function TargetSessionPage(props: { variant?: SessionPageVariant; suppressMobileTabs?: boolean }) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  return (
    <Show when={`${serverSDK().scope}\0${sdk().directory}`} keyed fallback={
      <div class="flex-1 min-h-0 overflow-hidden flex items-center justify-center p-6">
        <Spinner class="size-6" style={{ color: "var(--icon-weak)" }} />
      </div>
    }>
      <SessionPage variant={props.variant} suppressMobileTabs={props.suppressMobileTabs} />
    </Show>
  )
}

function TargetServerScopedProviders(
  props: ParentProps<{ directory?: () => string | undefined; sessionID?: () => string | undefined }>,
) {
  return (
    <>
      <MarkSessionNotificationsViewed sessionID={props.sessionID} />
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </>
  )
}

function MarkSessionNotificationsViewed(props: { sessionID?: () => string | undefined }) {
  const notification = useNotification()
  createEffect(() => {
    const sessionID = props.sessionID?.()
    if (!notification.ready() || !sessionID) return
    if (notification.session.unseenCount(sessionID) === 0) return
    notification.session.markViewed(sessionID)
  })
  return null
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function SessionRouteFrame(props: ParentProps<{ padded?: boolean }>) {
  return (
    <div class="relative size-full overflow-hidden flex flex-col" classList={{ "p-2": props.padded }}>
      {props.children}
    </div>
  )
}

function SessionPanelFrame(props: ParentProps<{ newLayout: boolean; raised?: boolean }>) {
  return (
    <div
      classList={{
        "flex-1 min-h-0 flex flex-col": true,
        "bg-v2-background-bg-base": props.newLayout,
        "bg-background-stronger": !props.newLayout,
        "rounded-[10px] overflow-hidden": props.newLayout,
        "shadow-[var(--v2-elevation-raised)]": props.newLayout && props.raised,
      }}
    >
      {props.children}
    </div>
  )
}

export default function Page(props: { variant?: SessionPageVariant; suppressMobileTabs?: boolean }) {
  const serverSync = useServerSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const queryClient = useQueryClient()
  // Needs useFile()/useSDK() (directory scope), which only exists inside
  // this SessionProviders subtree — see the note in layout-new.tsx for why
  // this isn't mounted at the app-shell level despite otherwise mirroring
  // the browser panel. layout.projectExplorer's open/close toggle is still
  // shared/global; only the width state and the DOM mount are session-local.
  const projectExplorerState = createProjectExplorerPanelState()
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const fileOps = createMemo(() => createFileOpsPort(sdk().client))
  const serverSDK = useServerSDK()
  const settings = useSettings()
  const platform = usePlatform()
  const prompt = usePrompt()
  const comments = useComments()
  const command = useCommand()
  const terminal = useTerminal()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { params, sessionKey, workspaceKey, tabs, view } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const newSessionDesign = createMemo(() => settings.general.newLayoutDesigns())

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const composer = createSessionComposerController()
  const inputController = createPromptInputController({
    sessionKey,
    sessionID: () => params.id,
    queryOptions: serverSync().queryOptions,
  })

  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))
  // workspace-keyed (not per-session-id): keeps panel shell + ErrorBoundary + composer
  // controller creation across same-workspace tab switches. Inner reactivity (sessionKey,
  // params.id, timeline out-of-lane) updates without remount. Matches TargetSessionPage
  // dir-keyed Show and non-keyed dir Show in ResolvedTargetSessionRoute (preserves
  // SDKProvider/DirectoryDataProvider/SessionProviders). Only remounts on dir/server change
  // or uncached lineage fallback.
  const sessionPanelKey = createMemo(() => (params.id ? workspaceKey() : undefined))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }
        if (pending.scope !== serverSDK().scope) return

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== base64Encode(sdk().directory)) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  const terminalOpen = createMemo(() => view().terminal.opened())
  const desktopTerminalOpen = createMemo(() => isDesktop() && terminalOpen())
  const desktopFileTreeOpen = createMemo(
    () =>
      isDesktop() &&
      shouldShowFileTree({
        visible: settings.visibility.fileTree(),
        opened: layout.fileTree.opened(),
      }),
  )
  const desktopProjectExplorerOpen = createMemo(() => isDesktop() && layout.projectExplorer.opened())
  const desktopContextPanelOpen = createMemo(() => isDesktop() && layout.sessionContext.opened())
  const desktopUsagePanelOpen = createMemo(() => isDesktop() && layout.usage.opened())
  const desktopModelsPanelOpen = createMemo(() => isDesktop() && layout.models.opened())
  const desktopLimitsPanelOpen = createMemo(() => isDesktop() && layout.limits.opened())
  const contextPanelState = createContextPanelState()
  const usagePanelState = createUsagePanelState()
  const modelsPanelState = createModelsPanelState()
  const limitsPanelState = createLimitsPanelState()
  const desktopSessionResizeOpen = createMemo(() => newSessionDesign() && desktopTerminalOpen())
  const desktopSidePanelOpen = createMemo(() => desktopSessionResizeOpen() || desktopFileTreeOpen())
  const desktopSessionSiblingOpen = createMemo(
    () =>
      desktopSidePanelOpen() ||
      desktopProjectExplorerOpen() ||
      desktopContextPanelOpen() ||
      desktopUsagePanelOpen() ||
      desktopModelsPanelOpen() ||
      desktopLimitsPanelOpen(),
  )
  const sessionPanelGapCount = createMemo(
    () =>
      Number(desktopProjectExplorerOpen()) +
      Number(desktopSidePanelOpen()) +
      Number(desktopContextPanelOpen()) +
      Number(desktopUsagePanelOpen()) +
      Number(desktopModelsPanelOpen()) +
      Number(desktopLimitsPanelOpen()),
  )
  const sessionPanelReservedWidth = createMemo(
    () =>
      (desktopProjectExplorerOpen() ? projectExplorerState.panelWidth() : 0) +
      (desktopFileTreeOpen() && !desktopSessionResizeOpen() ? layout.fileTree.width() : 0) +
      (desktopContextPanelOpen() ? contextPanelState.sidebarWidth() : 0) +
      (desktopUsagePanelOpen() ? usagePanelState.sidebarWidth() : 0) +
      (desktopModelsPanelOpen() ? modelsPanelState.sidebarWidth() : 0) +
      (desktopLimitsPanelOpen() ? limitsPanelState.sidebarWidth() : 0),
  )
  const sessionPanelReservedGap = createMemo(() =>
    settings.general.newLayoutDesigns() ? sessionPanelGapCount() * 8 : 0,
  )
  let panelRow: HTMLDivElement | undefined
  const [panelRowWidth, setPanelRowWidth] = createSignal<number>()
  createResizeObserver(
    () => panelRow,
    ({ width }) => setPanelRowWidth(width),
  )
  // The observer reports the content-box width, which already excludes row
  // padding; subtract fixed sibling panes and flex gaps before clamping chat.
  const sessionPanelAvailable = createMemo(() => {
    const width = panelRowWidth()
    if (width === undefined) return undefined
    return width - sessionPanelReservedWidth() - sessionPanelReservedGap()
  })
  const sessionPanelMax = createMemo(() => {
    const available = sessionPanelAvailable()
    if (available === undefined) return 1000
    return sessionPanelWidthMax({ available, split: false })
  })
  // Clamp at render time so window or sidebar resizes squeeze the chat panel
  // instead of the side panel, without overwriting the persisted width.
  const sessionPanelResizedWidth = createMemo(() =>
    clampSessionPanelWidth({
      width: layout.session.width(),
      available: sessionPanelAvailable(),
      split: false,
    }),
  )
  const byId = (id: string) => () => document.getElementById(id)
  const FILE_TREE_PANE_WIDTH_MIN = 240

  const orderedRightPanes = createMemo(() => {
    const list: RowPane[] = []
    if (desktopFileTreeOpen())
      list.push({
        id: "fileTree",
        size: () => layout.fileTree.width(),
        resize: (v) => layout.fileTree.resize(v),
        min: FILE_TREE_PANE_WIDTH_MIN,
        el: byId("session-side-panel"),
      })
    if (desktopUsagePanelOpen())
      list.push({
        id: "usage",
        size: () => usagePanelState.sidebarWidth(),
        resize: (v) => usagePanelState.resizeSidebar(v),
        min: USAGE_PANEL_WIDTH_MIN,
        el: byId("usage-panel"),
      })
    if (desktopModelsPanelOpen())
      list.push({
        id: "models",
        size: () => modelsPanelState.sidebarWidth(),
        resize: (v) => modelsPanelState.resizeSidebar(v),
        min: MODELS_PANEL_WIDTH_MIN,
        el: byId("models-panel"),
      })
    if (desktopLimitsPanelOpen())
      list.push({
        id: "limits",
        size: () => limitsPanelState.sidebarWidth(),
        resize: (v) => limitsPanelState.resizeSidebar(v),
        min: LIMITS_PANEL_WIDTH_MIN,
        el: byId("limits-panel"),
      })
    if (desktopContextPanelOpen())
      list.push({
        id: "context",
        size: () => contextPanelState.sidebarWidth(),
        resize: (v) => contextPanelState.resizeSidebar(v),
        min: CONTEXT_PANEL_WIDTH_MIN,
        el: byId("context-panel"),
      })
    return list
  })

  // The terminal is a horizontal pane only when it is the session's SOLE
  // right-hand neighbour. Otherwise it is stacked below the right-pane row
  // inside a content-sized wrapper and takes no part in the horizontal model.
  const terminalAbsorbs = createMemo(() => desktopSessionResizeOpen() && orderedRightPanes().length === 0)

  // The session pane is either the full row, an explicitly sized pane (when the
  // terminal absorbs), or the absorber itself -- in which case it carries no
  // width at all and `flex: 1` derives it. Never `calc()`: a derived width
  // cannot be moved by a divider, and would clobber transient drag styles.
  const sessionPanelWidth = createMemo(() => {
    if (!desktopSessionSiblingOpen()) return "100%"
    if (terminalAbsorbs()) return `${sessionPanelResizedWidth()}px`
    return undefined
  })
  // Per-session view state (e.g. terminal open) can change sessionPanelWidth() in
  // the same commit as a tab switch; suppress the width transition while a keyed
  // swap settles so switching tabs never animates panel width.
  const switching = createSwitchGate(sessionKey)
  const centered = createMemo(() => isDesktop() && newSessionDesign())
  const desktopV2PanelLayout = createMemo(() =>
    sessionPanelLayout({
      terminal: desktopTerminalOpen(),
      files: desktopFileTreeOpen(),
      context: desktopContextPanelOpen(),
      usage: desktopUsagePanelOpen(),
      models: desktopModelsPanelOpen(),
      limits: desktopLimitsPanelOpen(),
    }),
  )

  /**
   * Anchor-invariant pane row (see the Anchor-Invariant Pane Resizing doc).
   *
   * The row is modelled as ONE ordered list of visible panes with exactly
   * `N - 1` internal dividers between them. Every pane carries an explicit
   * pixel width except a single "absorber" -- the pane that is `flex: 1` and
   * therefore takes whatever width the others do not. Because the absorber's
   * width is layout-derived, a divider touching it only needs to write its
   * *other* participant: flexbox transfers exactly the complementary amount,
   * which conserves the pair sum and leaves every other boundary fixed.
   *
   * The absorber is the session pane, except when the terminal is the only
   * thing to the session's right (then the session is explicitly sized and the
   * terminal group absorbs).
   */
  const sessionRowPane = createMemo<RowPane>(() => ({
    id: "session",
    size: () => sessionPanelResizedWidth(),
    min: SESSION_PANEL_WIDTH_MIN,
    resize: (v: number) => {
      size.touch()
      layout.session.resize(v)
    },
    el: () => document.querySelector<HTMLElement>("[data-session-panel]"),
    absorb: !terminalAbsorbs(),
  }))

  /**
   * The complete ordered pane row. `N` panes => `N - 1` dividers; each divider
   * is owned by the pane on its right (an `edge="start"` handle) except the
   * explorer's, which is owned by the pane on its left.
   */
  const orderedPanes = createMemo<RowPane[]>(() => {
    const list: RowPane[] = []
    if (desktopProjectExplorerOpen()) {
      list.push({
        id: "explorerTree",
        size: () => projectExplorerState.treeWidth(),
        resize: projectExplorerState.resizeTree,
        min: PROJECT_EXPLORER_TREE_WIDTH_MIN,
        max: PROJECT_EXPLORER_TREE_WIDTH_MAX,
        el: byId("project-explorer-tree-pane"),
      })
      if (projectExplorerState.editorOpened())
        list.push({
          id: "explorerEditor",
          size: () => projectExplorerState.editorWidth(),
          resize: projectExplorerState.resizeEditor,
          min: PROJECT_EXPLORER_EDITOR_WIDTH_MIN,
          max: PROJECT_EXPLORER_EDITOR_WIDTH_MAX,
          el: byId("project-explorer-editor-pane"),
        })
    }
    list.push(sessionRowPane())
    list.push(...orderedRightPanes())
    if (terminalAbsorbs())
      list.push({
        id: "terminal",
        size: () => 0,
        resize: () => {},
        min: 200,
        el: byId("terminal-panel"),
        absorb: true,
      })
    return list
  })

  const toPairSide = (pane: RowPane) => ({
    size: pane.size(),
    min: pane.min,
    max: pane.max,
    onResize: pane.resize,
    el: pane.el,
    absorb: pane.absorb,
  })

  /**
   * The divider immediately to the LEFT of `paneId` (owned by an `edge="start"`
   * handle). For the first right-side pane this is a plain pair with whatever
   * precedes it (the session pane). For every later right-side pane, "left" is
   * the whole group of right-side panes before it: dragging pane 4's edge in a
   * `session | 2 | 3 | 4` row shares the delta across panes 2 and 3
   * evenly, delta/n across the n panes in the group, rather than only shrinking pane 3, so
   * pane 1 (session) and every other unrelated pane never move.
   */
  const dividerBefore = (paneId: string) => {
    const rightPanes = orderedRightPanes()
    const rightIdx = rightPanes.findIndex((p) => p.id === paneId)
    if (rightIdx > 0) {
      return {
        left: rightPanes.slice(0, rightIdx).map(toPairSide),
        right: toPairSide(rightPanes[rightIdx]),
        // Proportional to current size: a pane that's already big keeps its
        // relative size (it gives up more px but a similar %), and a pane
        // that's already small isn't crushed disproportionately the way an
        // even split would crush it.
        groupMode: "weighted",
      }
    }
    const list = orderedPanes()
    const idx = list.findIndex((p) => p.id === paneId)
    if (idx <= 0) return undefined
    return { left: toPairSide(list[idx - 1]), right: toPairSide(list[idx]) }
  }

  // The hosted browser panel is mounted outside this component (app-shell
  // scoped, see layout-new.tsx) but its resize divider should still share
  // its delta evenly across every pane in this row -- session pane plus
  // every open right panel -- instead of only whatever happens to be the
  // sole flex absorber at that outer level. Publish the current row's
  // resizable sides through the shared layout context so the browser panel
  // can build the same n-way-split group pair used for `dividerBefore`.
  createEffect(() => {
    const group = [sessionRowPane(), ...orderedRightPanes()].map(toPairSide)
    layout.sessionRow.setGroup(() => () => group)
  })
  onCleanup(() => layout.sessionRow.setGroup(undefined))

  /** The divider immediately to the RIGHT of `paneId` (owned by an `edge="end"` handle). */
  const dividerAfter = (paneId: string) => {
    const list = orderedPanes()
    const idx = list.findIndex((p) => p.id === paneId)
    if (idx < 0 || idx >= list.length - 1) return undefined
    return { left: toPairSide(list[idx]), right: toPairSide(list[idx + 1]) }
  }

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const isChildSession = createMemo(() => !!info()?.parentID)
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
  })
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const timeline = createTimelineModel({ sessionID: () => params.id, revertMessageID })
  const historyLoading = timeline.history.loading
  const historyMore = timeline.history.more
  const lastUserMessage = timeline.lastUserMessage
  const messages = timeline.messages
  const messagesReady = timeline.ready
  const sessionSync = timeline.resource
  const userMessages = timeline.userMessages
  const visibleUserMessages = timeline.visibleUserMessages

  // A session with no cached data yet renders zero timeline rows until the first fetch
  // resolves -- the panel sits blank, then the whole timeline pops in at once, which reads
  // as a flash. A hot session (already cached) has messagesReady() true immediately, so
  // this never engages for it. For a genuinely cold one, debounce BEFORE showing the
  // indicator (not after) so loads that resolve inside the window never show it either --
  // only a load slow enough to actually need one gets a smooth "loading" state instead of
  // sitting blank.
  const [showTimelineLoading, setShowTimelineLoading] = createSignal(false)
  createEffect(() => {
    const id = params.id
    if (!id || messagesReady()) {
      setShowTimelineLoading(false)
      return
    }
    const timer = window.setTimeout(() => setShowTimelineLoading(true), 150)
    onCleanup(() => window.clearTimeout(timer))
  })

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) void file.load(path)
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  let restoredModelSession: string | undefined
  createEffect(() => {
    const id = params.id
    if (!id || !prompt.ready() || !local.session.ready()) return
    if (restoredModelSession !== id) {
      restoredModelSession = id
      if (restorePromptModel(local, prompt)) return
    }
    syncPromptModel(local, prompt)
  })

  createEffect(
    on(
      () => ({ dir: sdk().directory, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    ...sessionViewState(),
    newSessionWorktree: "main",
    deferRender: false,
  })

  const [followup, setFollowup] = persisted(
    Persist.serverWorkspace(serverSDK().scope, sdk().directory, "followup", ["followup.v1"]),
    createStore<{
      items: Record<string, FollowupItem[] | undefined>
      failed: Record<string, string | undefined>
      paused: Record<string, boolean | undefined>
      edit: Record<string, FollowupEdit | undefined>
    }>({
      items: {},
      failed: {},
      paused: {},
      edit: {},
    }),
  )

  // deferRender's only reader is the composer-region ready latch below, which
  // latches true on first ready and never resets across same-workspace switches.
  // Once that latch is held, pulsing deferRender on every sessionKey change is
  // unobservable work (two store writes + a rAF/setTimeout hop per switch), so
  // only pulse on mount or when the target timeline isn't already readable
  // (cold switch).
  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev && (prev === undefined || !messagesReady())) {
      setStore("deferRender", true)
      const owner = sessionOwnership.capture()
      requestAnimationFrame(() => {
        setTimeout(() => owner.run(() => setStore("deferRender", false)), 0)
      })
    }
    return key
  })

  let todoFrame: number | undefined
  let todoTimer: number | undefined

  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")
  const wantsVcs = createMemo(() => sync().project?.vcs === "git")
  const vcsKey = createMemo(
    () =>
      ["session-vcs", sdk().directory, sync().data.vcs?.branch ?? "", sync().data.vcs?.default_branch ?? ""] as const,
  )
  const vcsQuery = createQuery(() => ({
    queryKey: [...vcsKey(), "git"] as const,
    enabled: wantsVcs(),
    queryFn: () =>
      sdk()
        .api.vcs.diff({ location: { directory: sdk().directory }, mode: "working" })
        .then((result) => result.data)
        .catch((error) => {
          console.debug("[session-vcs] failed to load vcs diff", { error })
          return []
        }),
  }))
  const refreshVcs = debounce(() => void queryClient.invalidateQueries({ queryKey: vcsKey() }), 100)
  /**
   * JSDOC: TanStack Solid-Query suspension guard for VCS diffs.
   *
   * `vcsQuery.data` accesses the internal `createResource()` backing the
   * query. Reading it while `isPending` is true would park the route under
   * `<Suspense>` (black screen until `/vcs` resolves). Gate with
   * `isPending` first; only read `.data` once the query has a cached result.
   */
  // D.R.Y: uses the shared suspension-safe query reader (see safe-query-data.ts).
  const vcsDiffs = () => safeQueryData(vcsQuery, [])
  const vcsCount = () => vcsDiffs().length
  const hasVcsChanges = () => vcsCount() > 0
  const vcsReady = () => !vcsQuery.isPending

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync().project
    if (project && sdk().directory !== project.worktree) return sdk().directory
    return "main"
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  function upsert(next: Project) {
    const list = serverSync().data.project
    sync().set("project", next.id)
    const idx = list.findIndex((item) => item.id === next.id)
    if (idx >= 0) {
      serverSync().set(
        "project",
        list.map((item, i) => (i === idx ? { ...item, ...next } : item)),
      )
      return
    }
    const at = list.findIndex((item) => item.id > next.id)
    if (at >= 0) {
      serverSync().set("project", [...list.slice(0, at), next, ...list.slice(at)])
      return
    }
    serverSync().set("project", [...list, next])
  }

  const gitMutation = useMutation(() => ({
    mutationFn: () => sdk().client.project.initGit(),
    onSuccess: (x) => {
      if (!x.data) return
      upsert(x.data)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    },
  }))

  function initGit() {
    if (gitMutation.isPending) return
    gitMutation.mutate()
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let sessionFindOverlay: HTMLDivElement | undefined
  let revealMessage = (_id: string, _rowIndex?: number) => {}
  let revealRow = (_rowIndex: number) => {}
  let scrollToEnd = () => {}
  let scrollMark = 0
  let messageMark = 0

  const emptyFindParts: Part[] = []
  const sessionFind = createSessionFindMatcher({
    turns: visibleUserMessages,
    sessionMessages: messages,
    parts: (messageID) => sync().data.part[messageID] ?? emptyFindParts,
  })
  createEffect(
    on(sessionFind.activeTurnID, (id) => {
      if (!id) return
      autoScroll.pause()
      // First: scroll to the turn (ensures the virtualizer renders its rows)
      revealMessage(id)
      // Then: after scan, scroll to the EXACT row containing the active match.
      // The virtualizer's messageRowIndex only maps to the first row of a turn,
      // but the match might be deep in assistant content.
      requestAnimationFrame(() => {
        if (!sessionFind.open() || !scroller) return
        textHighlighter.scan(scroller)
        const container = textHighlighter.getActiveContainer()
        if (container) {
          // scrollIntoView on the container element — the browser scrolls the
          // nearest scrollable ancestor (the virtualizer's scroll container).
          // This is more precise than scrollToIndex because it targets the
          // exact DOM element containing the match, not an estimated row offset.
          container.scrollIntoView({ block: "center", behavior: "instant" })
        }
      })
    }),
  )
  let sessionFindInput: HTMLInputElement | undefined
  const sessionFindPos = createSessionFindBarPosition(() => content ?? scroller)

  // Text-level highlighting: scan visible turn DOM for query matches
  const textHighlighter = createSessionTextHighlighter()
  createEffect(
    on(
      () => sessionFind.query(),
      (query) => {
        textHighlighter.setQuery(query)
      },
    ),
  )
  createEffect(
    on(
      () => sessionFind.index(),
      (index) => {
        textHighlighter.setActiveIndex(index)
      },
    ),
  )
  createEffect(
    on(
      () => sessionFind.open(),
      (open) => {
        if (!open) {
          textHighlighter.clear()
          return
        }
        // Initial scan after the bar opens and the virtualizer renders
        requestAnimationFrame(() => {
          if (scroller) textHighlighter.scan(scroller)
        })
      },
    ),
  )
  // Re-scan on scroll and DOM changes (virtualizer swapping rows)
  createEffect(
    on(
      () => sessionFind.open(),
      (open) => {
        if (!open || !scroller) return
        const rescan = () => {
          if (sessionFind.open() && scroller) textHighlighter.scan(scroller)
        }
        const scrollCleanup = makeEventListener(scroller, "scroll", rescan, { passive: true })
        // Debounced MutationObserver: during streaming, mutations fire hundreds
        // of times per second. Debounce to batch them into periodic rescans.
        let mutationTimer: ReturnType<typeof setTimeout> | undefined
        const debouncedRescan = () => {
          if (mutationTimer !== undefined) clearTimeout(mutationTimer)
          mutationTimer = setTimeout(() => {
            mutationTimer = undefined
            rescan()
          }, 100)
        }
        const observer = new MutationObserver(debouncedRescan)
        observer.observe(scroller, { childList: true, subtree: true })
        requestAnimationFrame(rescan)
        onCleanup(() => {
          scrollCleanup()
          observer.disconnect()
          if (mutationTimer !== undefined) clearTimeout(mutationTimer)
        })
      },
    ),
  )
  onCleanup(() => textHighlighter.dispose())

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on(
      () => {
        const id = params.id
        return [
          sdk().directory,
          id,
          id ? (sync().data.session_status[id]?.type ?? "idle") : "idle",
          id ? composer.blocked() : false,
        ] as const
      },
      ([dir, id, status, blocked]) => {
        if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
        if (todoTimer !== undefined) window.clearTimeout(todoTimer)
        todoFrame = undefined
        todoTimer = undefined
        if (!id) return
        if (status === "idle" && !blocked) return
        const cached = untrack(() => sync().data.todo[id] !== undefined)

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(() => {
            todoTimer = undefined
            if (sdk().directory !== dir || params.id !== id) return
            untrack(() => {
              void sync().session.todo(id, cached ? { force: true } : undefined)
            })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore(sessionViewState())
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  const stopVcs = sdk().event.listen((evt) => {
    const details = evt.details as { type: string; properties?: unknown }
    if (details.type !== "file.watcher.updated" && details.type !== "filesystem.changed") return
    const props =
      typeof details.properties === "object" && details.properties
        ? (details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    if (!file || file.startsWith(".git/")) return
    refreshVcs()
  })
  onCleanup(stopVcs)

  createEffect(
    on(
      () => sdk().directory,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    const key = scrollKey(event)
    if (key) {
      if (!scroller || !isScrollKeyTarget(target ?? null, key)) return
      if (scrollKeyOwner(scroller, target ?? null, key) !== scroller) return
      markScrollGesture(scroller)
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composer.blocked() || isChildSession()) return
      const input = inputRef
      if (!input) return
      input.focus()
      setCursorPosition(input, prompt.cursor() ?? promptLength(prompt.current()))
    }
  }

  createEffect(
    on(
      () => sync().data.session_status[params.id ?? ""]?.type,
      (next, prev) => {
        if (next !== "idle" || prev === undefined || prev === "idle") return
        refreshVcs()
      },
      { defer: true },
    ),
  )

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => {
    if (isChildSession()) return
    inputRef?.focus()
  }

  useComposerCommands()
  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    fileBrowser: () => newSessionDesign() && isDesktop() && !!params.id,
    find: {
      open: () => {
        sessionFind.focus()
        requestAnimationFrame(() => {
          sessionFindInput?.focus()
          sessionFindInput?.select()
        })
      },
      next: sessionFind.next,
      prev: sessionFind.prev,
      isOpen: sessionFind.open,
    },
  })
  command.register("session-palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: () => command.trigger("file.open", "palette"),
    },
  ])

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    sdk().directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync().status === "loading") return

    fileTreeTab()
    // Always the non-forced list: the tree store's own `loaded` flag (seeded from its
    // module-level cache on mount, and correctly cleared by switchScope on a real
    // directory change) already decides whether a fetch is needed. A local "did the
    // directory change" flag can't do that job -- it resets to unknown on every
    // component remount (e.g. navigating to Home and back), which forced a refetch on
    // every such remount even for a directory whose tree was already warm.
    void file.tree.list("")
  })

  createEffect(
    on(
      () => sdk().directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "none",
  })
  createEffect(
    on(
      () => params.id,
      (id, previous) => {
        if (!id || !previous || id === previous) return
        if (location.hash || store.messageId || ui.pendingMessage) return
        autoScroll.resume()
      },
    ),
  )

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.resume()
    scrollToEnd()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  let captureHistoryAnchor = () => {}
  let restoreHistoryAnchor = (_done: boolean) => {}
  const historyRequests = new Set<string>()
  let historyContinuationFrame: number | undefined
  const loadOlder = async () => {
    const owner = sessionOwnership.capture()
    if (historyLoading() || historyRequests.has(owner.key)) return
    historyRequests.add(owner.key)
    const before = timeline.messages().length
    try {
      await timeline.history.loadOlder({
        before: () => owner.run(captureHistoryAnchor),
        after: (done) => owner.run(() => restoreHistoryAnchor(done)),
      })
    } finally {
      historyRequests.delete(owner.key)
    }
    if (!owner.current() || timeline.messages().length <= before) return
    if (!autoScroll.userScrolled() || !scroller || scroller.scrollTop >= 200 || !historyMore()) return
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
    historyContinuationFrame = requestAnimationFrame(() => {
      historyContinuationFrame = undefined
      owner.run(onHistoryScroll)
    })
  }
  // Find must see the whole session, not just whatever page happens to be
  // loaded — otherwise matches appear/disappear as the user scrolls up and
  // pulls in more history, which reads as broken. Pull every older page in
  // while find is open; `loadOlder` already dedupes concurrent calls.
  let findHistoryLoadID: string | undefined
  const loadAllSessionHistoryForFind = async () => {
    const id = params.id
    if (!id || findHistoryLoadID === id) return
    findHistoryLoadID = id
    try {
      while (params.id === id && sessionFind.open() && historyMore()) {
        await loadOlder()
      }
    } finally {
      if (findHistoryLoadID === id) findHistoryLoadID = undefined
    }
  }
  createEffect(
    on(sessionFind.open, (open) => {
      if (open) void loadAllSessionHistoryForFind()
    }),
  )

  const onHistoryScroll = () => {
    if (
      historyRequests.has(sessionOwnership.key()) ||
      historyLoading() ||
      !autoScroll.userScrolled() ||
      !scroller ||
      scroller.scrollTop >= 200
    )
      return
    void loadOlder()
  }

  onCleanup(() => {
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (!historyMore()) return

      void loadOlder()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (!more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync().data.part[id] ?? [], {
      directory: sdk().directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>, target = sync()) => target.session.remember(next)

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"], target = sync()) => {
    const session = target.session.get(sessionID)
    if (!session) return
    target.session.remember({ ...session, revert: next })
  }

  const busy = (sessionID: string) => sync().data.session_working(sessionID)

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; id: string; manual?: boolean }) => {
      const owner = sessionOwnership.capture()
      const item = (followup.items[input.sessionID] ?? []).find((entry) => entry.id === input.id)
      if (!item) return

      if (input.manual) setFollowup("paused", input.sessionID, undefined)
      setFollowup("failed", input.sessionID, undefined)

      const ok = await sendFollowupDraft({
        api: sdk().api.session,
        sync: sync(),
        serverSync: serverSync(),
        draft: item,
        optimisticBusy: item.sessionDirectory === sdk().directory,
      }).catch((err) => {
        setFollowup("failed", input.sessionID, input.id)
        fail(err)
        return false
      })
      if (!ok) return

      setFollowup("items", input.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== input.id))
      if (input.manual) owner.run(resumeScroll)
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    if (!followupBusy(id)) return
    return followupMutation.variables?.id
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && busy(id) && !composer.blocked() && !isChildSession()
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })))

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    if (sync().session.get(sessionID)?.parentID) return Promise.resolve()
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followupBusy(sessionID)) return Promise.resolve()

    return followupMutation.mutateAsync({ sessionID, id, manual: opts?.manual })
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  const halt = (sessionID: string) =>
    busy(sessionID)
      ? sdk()
          .api.session.interrupt({ sessionID })
          .catch(() => {})
      : Promise.resolve()

  const revertMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID: string }) => {
      const session = sdk().api.session
      const target = sync()
      const last = target.session.get(input.sessionID)?.revert
      const value = draft(input.messageID)
      await runPromptRollbackMutation({
        capturePrompt: prompt.capture,
        optimistic: (prompt) => {
          roll(input.sessionID, { messageID: input.messageID }, target)
          prompt.set(value)
        },
        request: () => halt(input.sessionID).then(() => session.revert.stage(input)),
        complete: () => undefined,
        rollback: () => roll(input.sessionID, last, target),
        fail,
      })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      const sessionID = params.id
      if (!sessionID) return

      const session = sdk().api.session
      const target = sync()
      const index = userMessages().findIndex((item) => item.id === id)
      if (index < 0) return
      const next = userMessages()[index + 1]
      const last = target.session.get(sessionID)?.revert

      await runPromptRollbackMutation({
        capturePrompt: prompt.capture,
        optimistic: (promptSession) => {
          roll(sessionID, next ? { messageID: next.id } : undefined, target)
          if (next) {
            promptSession.set(draft(next.id))
            return
          }
          promptSession.reset()
        },
        request: () =>
          !next
            ? halt(sessionID).then(() => session.revert.clear({ sessionID }))
            : halt(sessionID).then(() => session.revert.stage({ sessionID, messageID: next.id }).then(() => undefined)),
        complete: () => undefined,
        rollback: () => roll(sessionID, last, target),
        fail,
      })
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => (restoreMutation.isPending ? restoreMutation.variables : undefined))

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    return revertMutation.mutateAsync(input)
  }

  const restore = (id: string) => {
    if (!params.id || reverting()) return
    return restoreMutation.mutateAsync(id)
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    const index = userMessages().findIndex((item) => item.id === id)
    if (index < 0) return []
    return userMessages()
      .slice(index)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  // attachment bytes are embedded as a data URL, so downloading always works;
  // revealing requires the on-disk path captured by the client that attached the file
  const openAttachment = (file: FilePart) => {
    const download = () => {
      const anchor = document.createElement("a")
      anchor.href = file.url
      anchor.download = getFilename(file.filename) || "attachment"
      anchor.click()
    }
    const path = file.filename ?? ""
    const absolute = path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(path)
    if (platform.revealPath && absolute) {
      void platform.revealPath(path).then(
        (revealed) => {
          if (!revealed) download()
        },
        () => download(),
      )
      return
    }
    download()
  }

  const actions = { revert, openAttachment }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const item = queuedFollowups()[0]
    if (!item) return
    if (followupBusy(sessionID)) return
    if (followup.failed[sessionID] === item.id) return
    if (followup.paused[sessionID]) return
    if (isChildSession()) return
    if (composer.blocked()) return
    if (busy(sessionID)) return

    void sendFollowup(sessionID, item.id)
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) scrollToEnd()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    autoScroll: {
      pause: autoScroll.pause,
      forceScrollToBottom: () => {
        autoScroll.resume()
        scrollToEnd()
      },
    },
    scroller: () => scroller,
    anchor,
    revealMessage: (id) => revealMessage(id),
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  onMount(() => {
    makeEventListener(document, "keydown", handleKeyDown)
  })

  onCleanup(() => {
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  useUsageExceededDialogs()

  const mobileTabs = (compact = false, bottom = false) => (
    <Tabs value={store.mobileTab} class="h-auto">
      <Tabs.List
        classList={{
          "!h-9": compact,
          "[&::after]:!border-b-0 [&::after]:!border-t [&::after]:!border-border-weak-base": bottom,
        }}
      >
        <Tabs.Trigger
          value="session"
          classList={{
            "!w-1/2 !max-w-none": true,
            "!border-b-0 !border-t !border-border-weak-base [&:has([data-selected])]:!border-t-transparent": bottom,
          }}
          classes={{ button: compact ? "w-full !py-2" : "w-full" }}
          onClick={() => setStore("mobileTab", "session")}
        >
          {language.t("session.tab.session")}
        </Tabs.Trigger>
        <Tabs.Trigger
          value="changes"
          classList={{
            "!w-1/2 !max-w-none !border-r-0": true,
            "!border-b-0 !border-t !border-border-weak-base [&:has([data-selected])]:!border-t-transparent": bottom,
          }}
          classes={{ button: compact ? "w-full !py-2" : "w-full" }}
          onClick={() => setStore("mobileTab", "changes")}
        >
          {hasVcsChanges()
            ? language.t("session.changes.filesChanged", { count: vcsCount() })
            : language.t("session.changes.change.other")}
        </Tabs.Trigger>
      </Tabs.List>
    </Tabs>
  )
  const mobileTabsBottom = createMemo(
    () => !isDesktop() && settings.general.newLayoutDesigns() && settings.general.mobileTitlebarPosition() === "bottom",
  )

  const sessionErrorFallback = (error: unknown, reset: () => void) => {
    createEffect(on(sessionKey, reset, { defer: true }))
    return <SessionErrorFallback error={error} sessionID={params.id} />
  }

  const sessionPanelContent = () => (
    <>
      {sessionSync.latest ?? ""}
      <Show
        when={
          !isDesktop() && !!params.id && settings.general.newLayoutDesigns() && !mobileTabsBottom() && !props.suppressMobileTabs
        }
      >
        {mobileTabs(true)}
      </Show>
      <div class="flex-1 min-h-0 overflow-hidden">
        <Switch>
          <Match when={params.id && mobileChanges()}>
            <div class="relative h-full overflow-hidden">
              <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                <div class="text-14-regular text-text-weak max-w-56">
                  {language.t("session.changes.noChanges")}
                </div>
              </div>
            </div>
          </Match>
          <Match when={params.id}>
            <Show when={params.id}>
              {(_id) => (
                <MessageTimeline
                  actions={actions}
                  scroll={ui.scroll}
                  onResumeScroll={resumeScroll}
                  setScrollRef={setScrollRef}
                  onScheduleScrollState={scheduleScrollState}
                  onAutoScrollHandleScroll={autoScroll.handleScroll}
                  onMarkScrollGesture={markScrollGesture}
                  hasScrollGesture={hasScrollGesture}
                  onUserScroll={markUserScroll}
                  onHistoryScroll={onHistoryScroll}
                  onAutoScrollInteraction={autoScroll.handleInteraction}
                  shouldAnchorBottom={() =>
                    !location.hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()
                  }
                  centered={centered()}
                  setContentRef={(el) => {
                    content = el
                    autoScroll.contentRef(el)

                    const root = scroller
                    if (root) scheduleScrollState(root)
                  }}
                  userMessages={visibleUserMessages()}
                  setHistoryAnchor={(handlers) => {
                    captureHistoryAnchor = handlers.capture
                    restoreHistoryAnchor = handlers.restore
                  }}
                  anchor={anchor}
                  setRevealMessage={(fn) => {
                    revealMessage = fn
                  }}
                  setRevealRow={(fn) => {
                    revealRow = fn
                  }}
                  setScrollToEnd={(fn) => {
                    scrollToEnd = fn
                  }}
                  findMatches={{
                    matched: sessionFind.matchedTurnIDs,
                    active: sessionFind.activeTurnID,
                  }}
                />
              )}
            </Show>
            <Show when={showTimelineLoading()}>
              <div
                data-slot="session-panel-loading"
                style={{ position: "absolute", inset: 0, "pointer-events": "none", "z-index": 30 }}
                class="flex items-center justify-center"
              >
                <Spinner class="size-5" style={{ color: "var(--icon-weak)" }} />
              </div>
            </Show>
            <Show when={sessionFind.open()}>
              <FileSearchBar
                pos={sessionFindPos}
                query={sessionFind.query}
                index={sessionFind.index}
                count={sessionFind.count}
                setInput={(el) => {
                  sessionFindInput = el
                }}
                onInput={sessionFind.setQuery}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault()
                    sessionFind.close()
                    return
                  }
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  if (event.shiftKey) sessionFind.prev()
                  else sessionFind.next()
                }}
                onClose={sessionFind.close}
                onPrev={sessionFind.prev}
                onNext={sessionFind.next}
              />
            </Show>
            <Show when={sessionFind.open()}>
              <div
                ref={(el) => {
                  sessionFindOverlay = el
                  textHighlighter.setOverlayContainer(el)
                }}
                style={{ position: "absolute", inset: 0, "pointer-events": "none", "z-index": 40 }}
              />
            </Show>
          </Match>
          <Match when={true}>
            <NewSessionView worktree={newSessionWorktree()} />
          </Match>
        </Switch>
      </div>

      <Show when={(params.id || !newSessionDesign()) && !mobileChanges()}>
        {(_) => {
          const controller = createSessionComposerRegionController({
            state: composer,
            sessionKey,
            sessionID: () => params.id,
            prompt,
            ready: () => !store.deferRender && messagesReady(),
            centered,
            todo: {
              collapsed: () => view().todoCollapsed.get(),
              onToggle: () => view().todoCollapsed.set(!view().todoCollapsed.get()),
            },
            followup: () =>
              params.id && !isChildSession()
                ? {
                    items: followupDock(),
                    sending: sendingFollowup(),
                    onSend: (id) => void sendFollowup(params.id!, id, { manual: true }),
                    onEdit: editFollowup,
                  }
                : undefined,
            revert: () =>
              rolled().length > 0
                ? {
                    items: rolled(),
                    restoring: restoring(),
                    disabled: reverting(),
                    onRestore: restore,
                  }
                : undefined,
            onResponseSubmit: resumeScroll,
            openParent: () => {
              const id = info()?.parentID
              if (!id) return
              navigate(
                params.serverKey
                  ? sessionHref(requireServerKey(params.serverKey), id)
                  : legacySessionHref(sdk().directory, id),
              )
            },
            setPromptRef: (el) => {
              inputRef = el
            },
            setDockRef: (el) => {
              promptDock = el
            },
          })
          return (
            <SessionComposerRegion
              controller={controller}
              promptInput={
                <Show
                  when={newSessionDesign()}
                  fallback={
                    <PromptInput
                      controls={inputController()}
                      ref={(el) => {
                        inputRef = el
                      }}
                      newSessionWorktree={newSessionWorktree()}
                      onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
                      onSubmit={() => {
                        comments.clear()
                        resumeScroll()
                      }}
                      edit={editingFollowup()}
                      onEditLoaded={clearFollowupEdit}
                      shouldQueue={queueEnabled}
                      onQueue={queueFollowup}
                      onAbort={() => {
                        const id = params.id
                        if (!id) return
                        setFollowup("paused", id, true)
                      }}
                    />
                  }
                >
                  {(_) => {
                    const controller = usePromptInputV2Controller({
                      get controls() {
                        return inputController()
                      },
                      ref: (el) => {
                        inputRef = el
                      },
                      get newSessionWorktree() {
                        return newSessionWorktree()
                      },
                      onNewSessionWorktreeReset: () => setStore("newSessionWorktree", "main"),
                      onSubmit: () => {
                        comments.clear()
                        resumeScroll()
                      },
                      get edit() {
                        return editingFollowup()
                      },
                      onEditLoaded: clearFollowupEdit,
                      shouldQueue: queueEnabled,
                      onQueue: queueFollowup,
                      onAbort: () => {
                        const id = params.id
                        if (!id) return
                        setFollowup("paused", id, true)
                      },
                    })
                    return <PromptInputV2Composer controller={controller} borderUnderlay />
                  }}
                </Show>
              }
            />
          )
        }}
      </Show>
      <Show when={!!params.id && mobileTabsBottom() && !props.suppressMobileTabs}>
        {mobileTabs(true, true)}
      </Show>
    </>
  )

  // Center-column variant: timeline + composer mount only, no desktop pane
  // scaffold (no header, explorer, side panels, terminal, or pane-row width
  // model). Same provider subtree and remount semantics as the pane variant.
  if (props.variant === "center") {
    return (
      <div data-session-panel class="@container relative flex w-full min-w-0 flex-col min-h-0 h-full flex-1">
        {settings.general.newLayoutDesigns() ? (
          <Show when={sessionPanelKey()} keyed>
            {(_) => (
              <SessionPanelFrame newLayout raised={!!params.id}>
                <ErrorBoundary fallback={sessionErrorFallback}>{sessionPanelContent()}</ErrorBoundary>
              </SessionPanelFrame>
            )}
          </Show>
        ) : (
          <SessionPanelFrame newLayout={false} raised={!!params.id}>
            {sessionPanelContent()}
          </SessionPanelFrame>
        )}
      </div>
    )
  }

  return (
    <SessionRouteFrame>
      <SessionHeader />
      <div
        ref={panelRow}
        class="flex-1 min-h-0 flex flex-col md:flex-row"
        classList={{
          "gap-2 p-2": settings.general.newLayoutDesigns(),
        }}
      >
        <Show when={isDesktop() && layout.projectExplorer.opened()}>
          <Suspense fallback={<RouteLoadingFallback />}>
            <ProjectExplorerPanel
              state={projectExplorerState}
              onClose={layout.projectExplorer.close}
              onAddToChat={(path) => prompt.context.add({ type: "file", path })}
              fileOps={fileOps()}
              gitStatus={file.gitStatus()}
              treePair={dividerAfter("explorerTree")}
              editorPair={dividerAfter("explorerEditor")}
            />
          </Suspense>
        </Show>
        <Show when={!isDesktop() && !!params.id && !settings.general.newLayoutDesigns()}>{mobileTabs()}</Show>

        <div
          data-session-panel
          classList={{
            "@container relative flex flex-col min-h-0 h-full flex-1": true,
            // Absorber: no stored width, `flex: 1` derives it from the row.
            "md:min-w-0": !sessionPanelWidth(),
            "shrink-0 md:flex-none": !!sessionPanelWidth(),
            "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none":
              !size.active() && !switching() && !!sessionPanelWidth(),
          }}
          style={{
            width: sessionPanelWidth(),
          }}
        >
          {settings.general.newLayoutDesigns() ? (
            <Show when={sessionPanelKey()} keyed>
              {(_) => (
                <SessionPanelFrame newLayout raised={!!params.id}>
                  <ErrorBoundary fallback={sessionErrorFallback}>{sessionPanelContent()}</ErrorBoundary>
                </SessionPanelFrame>
              )}
            </Show>
          ) : (
            <SessionPanelFrame newLayout={false} raised={!!params.id}>
              {sessionPanelContent()}
            </SessionPanelFrame>
          )}

          {/* Divider on the session's right edge: session|terminal. */}
          <Show when={terminalAbsorbs()}>
            <div onPointerDown={() => size.start()}>
              <ResizeHandle
                classList={{
                  "-end-1": settings.general.newLayoutDesigns(),
                }}
                direction="horizontal"
                size={sessionPanelResizedWidth()}
                min={SESSION_PANEL_WIDTH_MIN}
                max={sessionPanelMax()}
                onResize={(width) => {
                  size.touch()
                  layout.session.resize(width)
                }}
                pair={dividerAfter("session")}
              />
            </div>
          </Show>
        </div>

        <Show when={!newSessionDesign() && desktopSidePanelOpen()}>
          <Suspense fallback={<RouteLoadingFallback />}>
            <SessionSidePanel
              diffs={vcsDiffs}
              diffsReady={vcsReady}
              empty={() => ""}
              hasChanges={hasVcsChanges}
              changeCount={vcsCount}
              activeDiff={undefined}
              focusChangeDiff={() => {}}
              size={size}
            />
          </Suspense>
        </Show>
        <Show when={!newSessionDesign() && desktopUsagePanelOpen()}>
          <UsagePanel
            state={usagePanelState}
            opened={desktopUsagePanelOpen()}
            onClose={() => layout.usage.close()}
          />
        </Show>
        <Show when={!newSessionDesign() && desktopModelsPanelOpen()}>
          <ModelsPanel
            state={modelsPanelState}
            opened={desktopModelsPanelOpen()}
            onClose={() => layout.models.close()}
          />
        </Show>
        <Show when={!newSessionDesign() && desktopLimitsPanelOpen()}>
          <LimitsPanel
            state={limitsPanelState}
            opened={desktopLimitsPanelOpen()}
            onClose={() => layout.limits.close()}
          />
        </Show>
        <Show when={!newSessionDesign() && desktopContextPanelOpen()}>
          <ContextPanel
            state={contextPanelState}
            opened={desktopContextPanelOpen()}
            onClose={() => layout.sessionContext.close()}
          />
        </Show>
        <Show when={newSessionDesign()}>
          <Show when={isDesktop() ? desktopV2PanelLayout().visible : terminalOpen()}>
            <Show
              when={
                (isDesktop() &&
                  (desktopFileTreeOpen() ||
                    desktopContextPanelOpen() ||
                    desktopUsagePanelOpen() ||
                    desktopModelsPanelOpen() ||
                    desktopLimitsPanelOpen())) ||
                terminalOpen()
              }
            >
              {/*
                The right group is content-sized (its panes carry explicit px
                widths) so the session pane absorbs the row. It only becomes
                the absorber itself when the terminal is the session's sole
                right-hand neighbour.
              */}
              <div
                classList={{
                  "h-full flex flex-col": true,
                  "min-w-0 flex-1": terminalAbsorbs(),
                  "shrink-0": !terminalAbsorbs(),
                }}
              >
                <Show
                  when={
                    isDesktop() &&
                    (desktopFileTreeOpen() ||
                      desktopContextPanelOpen() ||
                      desktopUsagePanelOpen() ||
                      desktopModelsPanelOpen() ||
                      desktopLimitsPanelOpen())
                  }
                >
              <div class="min-h-0 flex-1 flex flex-row gap-2">
                <Show when={desktopFileTreeOpen()}>
                  <Suspense fallback={<RouteLoadingFallback />}>
                    <SessionSidePanel
                      diffs={vcsDiffs}
                      diffsReady={vcsReady}
                      empty={() => ""}
                      hasChanges={hasVcsChanges}
                      changeCount={vcsCount}
                      activeDiff={undefined}
                      focusChangeDiff={() => {}}
                      size={size}
                      pair={dividerBefore("fileTree")}
                    />
                  </Suspense>
                </Show>
                <Show when={desktopUsagePanelOpen()}>
                  <UsagePanel
                    state={usagePanelState}
                    opened={desktopUsagePanelOpen()}
                    onClose={() => layout.usage.close()}
                    pair={dividerBefore("usage")}
                  />
                </Show>
                <Show when={desktopModelsPanelOpen()}>
                  <ModelsPanel
                    state={modelsPanelState}
                    opened={desktopModelsPanelOpen()}
                    onClose={() => layout.models.close()}
                    pair={dividerBefore("models")}
                  />
                </Show>
                <Show when={desktopLimitsPanelOpen()}>
                  <LimitsPanel
                    state={limitsPanelState}
                    opened={desktopLimitsPanelOpen()}
                    onClose={() => layout.limits.close()}
                    pair={dividerBefore("limits")}
                  />
                </Show>
                <Show when={desktopContextPanelOpen()}>
                  <ContextPanel
                    state={contextPanelState}
                    opened={desktopContextPanelOpen()}
                    onClose={() => layout.sessionContext.close()}
                    pair={dividerBefore("context")}
                  />
                </Show>
              </div>
                </Show>
                <Show when={desktopV2PanelLayout().stacked}>
                  <div class="relative h-2 shrink-0" onPointerDown={() => size.start()}>
                    <ResizeHandle
                      class="!relative !inset-auto !h-full !w-full !transform-none"
                      direction="vertical"
                      size={layout.terminal.height()}
                      min={100}
                      max={typeof window === "undefined" ? 600 : window.innerHeight * 0.6}
                      collapseThreshold={50}
                      onResize={(height) => {
                        size.touch()
                        layout.terminal.resize(height)
                      }}
                      onCollapse={() => view().terminal.close()}
                    />
                  </div>
                </Show>
                <Show when={terminalOpen()}>
                  <div
                    classList={{
                      "min-h-0 shrink-0": desktopV2PanelLayout().stacked,
                      "min-h-0 flex-1": !desktopV2PanelLayout().stacked,
                    }}
                  >
                    <TerminalPanelV2 stacked={desktopV2PanelLayout().stacked} />
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
      </div>

      <Show when={!newSessionDesign()}>
        <TerminalPanel />
      </Show>
    </SessionRouteFrame>
  )
}
