import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { EditorState, Compartment, type Extension } from "@codemirror/state"
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  type ViewUpdate,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  LanguageDescription,
  type LanguageSupport,
} from "@codemirror/language"
import { searchKeymap } from "@codemirror/search"
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { tags } from "@lezer/highlight"
import { languages as codemirrorLanguages } from "@codemirror/language-data"
import { LineCommentEditorV2 } from "@opencode-ai/ui/v2/line-comment-v2"
import { previewSelectedLines } from "@opencode-ai/session-ui/pierre/selection-bridge"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { selectionFromLines, useFile, type SelectedLineRange } from "@/context/file"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { normalizeFileTreeV2Path } from "@/components/file-tree-v2-model"
import { showToast } from "@/utils/toast"
import {
  FileOpsConflictError,
  FileOpsNotImplementedError,
  notImplementedFileOpsPort,
  type FileOpsPort,
} from "@/utils/file-ops-port"
import {
  binaryDataUrl,
  projectExplorerFileKind,
  projectExplorerMime,
  type ProjectExplorerFileKind,
} from "./project-explorer-file-kind"
import { ProjectExplorerImageViewer } from "./project-explorer-image-viewer"
import { ProjectExplorerMarkdownViewer } from "./project-explorer-markdown-viewer"
import { ProjectExplorerPdfViewer } from "./project-explorer-pdf-viewer"
import { ProjectExplorerSvgViewer } from "./project-explorer-svg-viewer"
import "./project-explorer-editor-pane.css"
import { ProjectExplorerScrollbar } from "./project-explorer-scrollbar"
import "./project-explorer-scrollbar.css"

type OpenBuffer = {
  path: string
  savedContent: string
  savedHash: string
  dirty: boolean
  /** Base64 payload for binary files (viewer-only kinds); undefined for text buffers. */
  binary?: string
}

type EditorViewMode = "render" | "source"

const cmTheme = EditorView.theme(
  {
    "&": { height: "100%", color: "var(--v2-text-text-base)", backgroundColor: "var(--v2-background-bg-base)" },
    ".cm-content": {
      fontFamily: "var(--v2-font-family-mono, ui-monospace, monospace)",
      fontSize: "12.5px",
      caretColor: "var(--v2-text-text-accent)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--v2-background-bg-base)",
      color: "var(--v2-text-text-faint)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--v2-overlay-simple-overlay-hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--v2-overlay-simple-overlay-hover)" },
    ".cm-selectionBackground": { backgroundColor: "var(--v2-overlay-simple-overlay-pressed) !important" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "var(--v2-text-text-accent)" },
    ".cm-scroller": { overflow: "auto" },
  },
  { dark: true },
)

const cmHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "var(--v2-text-text-faint)", fontStyle: "italic" },
  { tag: tags.keyword, color: "var(--v2-syntax-keyword, #c586c0)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--v2-syntax-string, #ce9178)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--v2-syntax-number, #b5cea8)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--v2-syntax-function, #dcdcaa)",
  },
  { tag: [tags.typeName, tags.className], color: "var(--v2-syntax-type, #4ec9b0)" },
  { tag: tags.propertyName, color: "var(--v2-syntax-property, #9cdcfe)" },
  { tag: tags.operator, color: "var(--v2-text-text-muted)" },
])

function baseExtensions(onDocChanged: () => void, onSelectionChanged: () => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    syntaxHighlighting(cmHighlightStyle),
    cmTheme,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged) onDocChanged()
      if (update.selectionSet || update.docChanged || update.geometryChanged) onSelectionChanged()
    }),
  ]
}

async function languageExtensionFor(path: string): Promise<Extension> {
  if (projectExplorerFileKind(path) === "svg") {
    const svgLanguage = await svgLanguageExtension()
    if (svgLanguage) return [svgLanguage]
  }
  const description = LanguageDescription.matchFilename(codemirrorLanguages, path)
  if (!description) return []
  try {
    const support = await description.load()
    return [support]
  } catch {
    return []
  }
}

type SvgViewerModule = typeof import("./project-explorer-svg-viewer") & {
  projectExplorerSvgLanguage?: () => Promise<LanguageSupport>
}

async function svgLanguageExtension(): Promise<LanguageSupport | undefined> {
  const module = (await import("./project-explorer-svg-viewer")) as SvgViewerModule
  const svgLanguage = module.projectExplorerSvgLanguage?.()
  if (!svgLanguage) return undefined
  return await svgLanguage
}

const defaultViewModeFor = (kind: ProjectExplorerFileKind): EditorViewMode =>
  kind === "markdown" || kind === "svg" ? "render" : "source"

export type ProjectExplorerEditorPaneHandle = { openFile: (path: string) => Promise<void> }

function cloneSelection(selection: SelectedLineRange): SelectedLineRange {
  return {
    start: selection.start,
    end: selection.end,
  }
}

export function ProjectExplorerEditorPane(props: {
  fileOps?: FileOpsPort
  onCloseAll?: () => void
  /** Tree actions for tab-menu items that operate on the project explorer
   * tree (reveal, rename/delete, new file/folder). Resolved at call time so
   * the tree's ref may still be mounting when the pane renders. */
  tree?: {
    reveal: (path: string) => void
    startCreate: (parentDir: string, kind: "file" | "directory") => void
    startRename: (path: string) => void
    startDelete: (path: string) => void
  }
  onAddToChat?: (path: string) => void
  isFavorite?: (path: string) => boolean
  onToggleFavorite?: (path: string) => void
  ref?: (handle: ProjectExplorerEditorPaneHandle) => void
}) {
  const file = useFile()
  const comments = useComments()
  const language = useLanguage()
  const platform = usePlatform()
  const prompt = usePrompt()
  const sdk = useSDK()
  const fileOps = () => props.fileOps ?? notImplementedFileOpsPort

  const [buffers, setBuffers] = createSignal<OpenBuffer[]>([])
  const [activePath, setActivePath] = createSignal<string>()
  const [conflict, setConflict] = createSignal<string>()
  const [comment, setComment] = createStore({
    selected: null as SelectedLineRange | null,
    draft: null as SelectedLineRange | null,
    value: "",
    top: 0,
  })

  let host: HTMLDivElement | undefined
  let editorFrame: HTMLDivElement | undefined
  let tabBar: HTMLDivElement | undefined
  let view: EditorView | undefined
  const [editorView, setEditorView] = createSignal<EditorView>()
  const languageCompartment = new Compartment()
  const viewsByPath = new Map<string, { state: EditorState }>()

  // Bumped whenever the shared CodeMirror doc changes (swapToBuffer doc
  // replacement OR user typing). view.state.doc is not reactive on its own, so
  // without this the activeContent memo would serve a STALE doc — the markdown/
  // svg viewers would render the previous file's content (or nothing on first
  // open, when the fresh view starts with an empty doc).
  const [docVersion, setDocVersion] = createSignal(0)

  const activeBuffer = createMemo(() => buffers().find((buffer) => buffer.path === activePath()))
  const commentButtonSelection = createMemo(() => (comment.draft ? null : comment.selected))
  const [viewModes, setViewModes] = createStore<Record<string, EditorViewMode>>({})

  const activeKind = createMemo(() => {
    const path = activePath()
    return path ? projectExplorerFileKind(path) : "text"
  })

  const activeViewMode = createMemo(() => {
    const path = activePath()
    if (!path) return defaultViewModeFor(activeKind())
    return viewModes[path] ?? defaultViewModeFor(activeKind())
  })

  const editorInteractive = createMemo(() => {
    const kind = activeKind()
    if (kind === "text") return true
    if (kind === "image" || kind === "pdf") return false
    return activeViewMode() === "source"
  })

  const activeContent = createMemo(() => {
    docVersion()
    const buffer = activeBuffer()
    if (!buffer) return ""
    return editorView()?.state.doc.toString() ?? buffer.savedContent
  })

  const activeBinaryDataUrl = createMemo(() => {
    const buffer = activeBuffer()
    if (!buffer?.binary) return ""
    return binaryDataUrl(buffer.binary, projectExplorerMime(buffer.path))
  })

  const activeViewerPath = createMemo(() => {
    const path = activePath()
    if (!path) return undefined
    const kind = projectExplorerFileKind(path)
    if (kind === "image" || kind === "pdf") return path
    if (kind === "markdown" || kind === "svg") return activeViewMode() === "render" ? path : undefined
    return undefined
  })

  const setViewMode = (mode: EditorViewMode) => {
    const path = activePath()
    if (path) setViewModes(path, mode)
  }

  const mountEditor = () => {
    if (!host) return
    view?.destroy()
    const next = new EditorView({
      state: EditorState.create({ doc: "", extensions: baseExtensions(onDocChanged, updateLineSelection) }),
      parent: host,
    })
    view = next
    setEditorView(next)
  }

  onMount(mountEditor)
  onCleanup(() => {
    view?.destroy()
    setEditorView(undefined)
  })

  const onDocChanged = () => {
    const path = activePath()
    if (!path || !view) return
    setDocVersion((value) => value + 1)
    setBuffers((list) =>
      list.map((buffer) =>
        buffer.path === path ? { ...buffer, dirty: view!.state.doc.toString() !== buffer.savedContent } : buffer,
      ),
    )
  }

  const rangeFromEditorSelection = (): SelectedLineRange | null => {
    if (!view) return null
    const range = view.state.selection.main
    if (range.empty) return null
    const start = view.state.doc.lineAt(Math.min(range.from, range.to)).number
    const end = view.state.doc.lineAt(Math.max(range.from, range.to)).number
    return { start, end }
  }

  const updateLineSelection = () => {
    const range = rangeFromEditorSelection()
    if (!range) {
      if (!comment.draft) setComment("selected", null)
      return
    }

    setComment("selected", cloneSelection(range))
    const coords = view?.coordsAtPos(view.state.doc.line(range.end).to)
    const frame = editorFrame?.getBoundingClientRect()
    if (!coords || !frame) return
    setComment("top", Math.max(8, coords.bottom - frame.top + 8))
  }

  const selectionLabel = (selection: SelectedLineRange) => {
    if (selection.start === selection.end) {
      return language.t("session.changes.selection.line", { line: selection.start })
    }
    return language.t("session.changes.selection.lines", { start: selection.start, end: selection.end })
  }

  const submitComment = (value: string) => {
    const buffer = activeBuffer()
    const selection = comment.draft
    if (!buffer || !selection) return

    const contextSelection = selectionFromLines(selection)
    const content = view?.state.doc.toString() ?? buffer.savedContent
    const saved = comments.add({
      file: buffer.path,
      selection,
      comment: value,
    })
    prompt.context.add({
      type: "file",
      path: buffer.path,
      selection: contextSelection,
      comment: value,
      commentID: saved.id,
      commentOrigin: "file",
      preview: previewSelectedLines(content, {
        start: contextSelection.startLine,
        end: contextSelection.endLine,
      }),
    })
    setComment(reconcile({ selected: null, draft: null, value: "", top: comment.top }))
  }

  const bufferFromFileState = (path: string, hashFallback = "") => {
    const state = file.get(path)
    const content = state?.content
    const binary = content?.type === "binary"
    return {
      path,
      savedContent: binary ? "" : (content?.content ?? ""),
      savedHash: content?.hash ?? hashFallback,
      dirty: false,
      binary: binary ? content?.content : undefined,
    }
  }

  const openFile = async (path: string) => {
    setActivePath(path)
    if (!buffers().some((buffer) => buffer.path === path)) {
      await file.load(path)
      setBuffers((list) => [...list, bufferFromFileState(path)])
    }
    swapToBuffer(path)
  }

  const reloadCleanBuffer = async (path: string) => {
    const buffer = buffers().find((entry) => entry.path === path)
    if (!buffer) return
    if (buffer.dirty) {
      setConflict(path)
      return
    }

    await file.load(path, { force: true })
    const next = bufferFromFileState(path, buffer.savedHash)
    setBuffers((list) => list.map((entry) => (entry.path === path ? next : entry)))
    if (activePath() === path) swapToBuffer(path)
  }

  createEffect(() => {
    const stop = sdk().event.on("file.edited", (event) => {
      void reloadCleanBuffer(file.normalize(event.properties.file))
    })
    onCleanup(stop)
  })

  const swapToBuffer = (path: string) => {
    const buffer = buffers().find((entry) => entry.path === path)
    if (!buffer || !view) return
    const extensions = [...baseExtensions(onDocChanged, updateLineSelection), languageCompartment.of([])]
    view.setState(
      EditorState.create({
        doc:
          view.state.doc.toString() === buffer.savedContent && activePath() === path
            ? view.state.doc
            : buffer.savedContent,
        extensions,
      }),
    )
    // EditorView.setState destroys/recreates plugins and does NOT run the
    // update pipeline, so the doc-changed listener never fires here — bump
    // explicitly so activeContent (which feeds the markdown/svg render views)
    // re-reads the freshly swapped doc instead of serving the previous one.
    setDocVersion((value) => value + 1)
    setComment(reconcile({ selected: null, draft: null, value: "", top: 0 }))
    void languageExtensionFor(path).then((extension) => {
      if (activePath() !== path || !view) return
      view.dispatch({ effects: languageCompartment.reconfigure(extension) })
    })
  }

  createEffect(() => {
    const path = activePath()
    if (path) swapToBuffer(path)
  })

  const closeBuffer = (path: string) => {
    setBuffers((list) => list.filter((buffer) => buffer.path !== path))
    if (activePath() === path) {
      const next = buffers()[0]?.path
      setActivePath(next)
      if (!next) props.onCloseAll?.()
    }
  }

  const absolutePath = (path: string) => `${sdk().directory}/${path}`.replace("//", "/")

  const copyTabPath = async (path: string, absolute: boolean) => {
    const value = absolute ? absolutePath(path) : path
    await navigator.clipboard.writeText(value)
    showToast({ title: language.t("projectExplorer.contextMenu.pathCopied") })
  }

  const revealInOs = async (path: string) => {
    if (!platform.revealPath) {
      showToast({ variant: "error", title: language.t("projectExplorer.contextMenu.revealUnavailable") })
      return
    }
    const ok = await platform.revealPath(absolutePath(path))
    if (!ok) showToast({ variant: "error", title: language.t("projectExplorer.contextMenu.revealFailed") })
  }

  const addToChat = (path: string) => {
    if (!props.onAddToChat) {
      showToast({ variant: "error", title: language.t("projectExplorer.contextMenu.noActiveChat") })
      return
    }
    props.onAddToChat(path)
  }

  /** The tab's parent directory (normalized), for new-file/new-folder actions. */
  const parentDirOf = (path: string) => {
    const index = path.lastIndexOf("/")
    return index === -1 ? "" : path.slice(0, index)
  }

  const revealThen = (path: string, action: (normalized: string) => void) => {
    const normalized = normalizeFileTreeV2Path(path)
    props.tree?.reveal(normalized)
    action(normalized)
  }

  const closeRange = (path: string, mode: "left" | "right" | "others") => {
    const list = buffers()
    const index = list.findIndex((buffer) => buffer.path === path)
    if (index < 0) return
    const keep = list.filter((buffer, i) => {
      if (mode === "left") return i >= index
      if (mode === "right") return i <= index
      return buffer.path === path
    })
    setBuffers(keep)
    if (keep.some((buffer) => buffer.path === activePath())) return
    const next = keep[0]?.path
    setActivePath(next)
    if (!next) props.onCloseAll?.()
  }

  const save = async () => {
    const buffer = activeBuffer()
    if (!buffer || buffer.binary || !view) return
    const content = view.state.doc.toString()
    try {
      const result = await fileOps().write({ path: buffer.path, content, expectedHash: buffer.savedHash })
      setBuffers((list) =>
        list.map((entry) =>
          entry.path === buffer.path
            ? { ...entry, savedContent: content, savedHash: result.hash, dirty: false }
            : entry,
        ),
      )
      showToast({
        title: language.t("projectExplorer.editor.saved", { name: buffer.path.split("/").pop() ?? buffer.path }),
      })
    } catch (error) {
      if (error instanceof FileOpsConflictError) {
        setConflict(buffer.path)
        return
      }
      if (error instanceof FileOpsNotImplementedError) {
        showToast({
          variant: "error",
          title: language.t("projectExplorer.editor.saveUnavailable.title"),
          description: language.t("projectExplorer.editor.saveUnavailable.description"),
        })
        return
      }
      showToast({ variant: "error", title: language.t("common.requestFailed") })
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      void save()
    }
  }

  props.ref?.({ openFile })

  return (
    <div
      class="flex h-full min-w-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
      data-component="project-explorer-editor-pane"
    >
      <div class="relative h-8 shrink-0 border-b border-v2-border-border-base bg-v2-background-bg-base">
        <div
          ref={(el) => {
            tabBar = el
          }}
          data-slot="project-explorer-editor-tabbar"
          class="flex h-8 items-center gap-0.5 overflow-x-auto px-1"
        >
        <For each={buffers()}>
          {(buffer) => (
            <MenuV2.Context>
              {/* display:contents so the wrapper doesn't disturb the flex tab bar */}
              <MenuV2.Context.Trigger class="contents" as="div">
                <button
                  type="button"
                  data-slot="project-explorer-editor-tab"
                  data-active={activePath() === buffer.path ? "" : undefined}
                  onClick={() => setActivePath(buffer.path)}
                >
                  <FileIcon
                    node={{ path: buffer.path, type: "file" }}
                    class="size-4 shrink-0"
                    data-slot="project-explorer-editor-tab-icon"
                  />
                  <span class="truncate">{buffer.path.split("/").pop()}</span>
                  <span data-slot="project-explorer-editor-tab-dot" data-dirty={buffer.dirty ? "" : undefined} />
                  <span
                    data-slot="project-explorer-editor-tab-close"
                    onClick={(event) => {
                      event.stopPropagation()
                      closeBuffer(buffer.path)
                    }}
                  >
                    <Icon name="close" size="small" />
                  </span>
                </button>
              </MenuV2.Context.Trigger>
              <MenuV2.Context.Portal>
                <MenuV2.Context.Content>
                  <MenuV2.Item onSelect={() => props.tree?.reveal(buffer.path)}>
                    {language.t("projectExplorer.contextMenu.reveal")}
                  </MenuV2.Item>
                  <MenuV2.Item onSelect={() => void revealInOs(buffer.path)}>
                    {language.t("session.header.reveal.fileExplorer")}
                  </MenuV2.Item>
                  <MenuV2.Separator />
                  <MenuV2.Item onSelect={() => addToChat(buffer.path)}>
                    {language.t("projectExplorer.contextMenu.addToChat")}
                  </MenuV2.Item>
                  <MenuV2.Item onSelect={() => props.onToggleFavorite?.(buffer.path)}>
                    {props.isFavorite?.(buffer.path)
                      ? language.t("model.favorite.remove")
                      : language.t("model.favorite.add")}
                  </MenuV2.Item>
                  <MenuV2.Separator />
                  <MenuV2.Item onSelect={() => props.tree?.startCreate(parentDirOf(buffer.path), "file")}>
                    {language.t("projectExplorer.contextMenu.newFile")}
                  </MenuV2.Item>
                  <MenuV2.Item onSelect={() => props.tree?.startCreate(parentDirOf(buffer.path), "directory")}>
                    {language.t("projectExplorer.contextMenu.newFolder")}
                  </MenuV2.Item>
                  <MenuV2.Item onSelect={() => revealThen(buffer.path, (path) => props.tree?.startRename(path))}>
                    {language.t("projectExplorer.contextMenu.rename")}
                  </MenuV2.Item>
                  <MenuV2.Item onSelect={() => revealThen(buffer.path, (path) => props.tree?.startDelete(path))}>
                    {language.t("projectExplorer.contextMenu.delete")}
                  </MenuV2.Item>
                  <MenuV2.Separator />
                  <MenuV2.Item onSelect={() => void copyTabPath(buffer.path, false)}>
                    {language.t("projectExplorer.contextMenu.copyPath")}
                  </MenuV2.Item>
                  <MenuV2.Item onSelect={() => void copyTabPath(buffer.path, true)}>
                    {language.t("projectExplorer.contextMenu.copyAbsolutePath")}
                  </MenuV2.Item>
                  <MenuV2.Separator />
                  <MenuV2.Item onSelect={() => closeRange(buffer.path, "left")}>
                    {language.t("command.tab.closeLeft")}
                  </MenuV2.Item>
                  <MenuV2.Item onSelect={() => closeRange(buffer.path, "right")}>
                    {language.t("command.tab.closeRight")}
                  </MenuV2.Item>
                  <MenuV2.Item onSelect={() => closeRange(buffer.path, "others")}>
                    {language.t("command.tab.closeOthers")}
                  </MenuV2.Item>
                </MenuV2.Context.Content>
              </MenuV2.Context.Portal>
            </MenuV2.Context>
          )}
        </For>
        <Show when={activeBuffer() && activeKind() !== "image" && activeKind() !== "pdf"}>
          <div class="ml-auto flex shrink-0 items-center gap-1 pr-1">
            <Show when={activeKind() === "markdown" || activeKind() === "svg"}>
              <div class="flex items-center" data-slot="project-explorer-editor-view-toggle">
                <button
                  type="button"
                  data-active={activeViewMode() === "render" ? "" : undefined}
                  onClick={() => setViewMode("render")}
                >
                  {language.t("projectExplorer.editor.viewRender")}
                </button>
                <button
                  type="button"
                  data-active={activeViewMode() === "source" ? "" : undefined}
                  onClick={() => setViewMode("source")}
                >
                  {language.t("projectExplorer.editor.viewSource")}
                </button>
              </div>
            </Show>
            <TooltipV2 value={language.t("projectExplorer.editor.save")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                disabled={!activeBuffer()?.dirty}
                onClick={() => void save()}
                aria-label={language.t("projectExplorer.editor.save")}
                icon={<Icon name="check" />}
              />
            </TooltipV2>
          </div>
        </Show>
        </div>
        <ProjectExplorerScrollbar viewport={() => tabBar} axes="horizontal" />
      </div>
      <Show when={conflict()}>
        {(path) => (
          <div data-slot="project-explorer-editor-conflict">
            {language.t("projectExplorer.editor.conflict", { name: path().split("/").pop() ?? path() })}
            <button type="button" onClick={() => setConflict(undefined)}>
              {language.t("common.dismiss")}
            </button>
          </div>
        )}
      </Show>
      <Show when={buffers().length === 0}>
        <div class="flex flex-1 items-center justify-center text-[12px] text-v2-text-text-faint">
          {language.t("projectExplorer.editor.empty")}
        </div>
      </Show>
      <div
        ref={(el) => {
          editorFrame = el
        }}
        data-slot="project-explorer-editor-frame"
        class="relative min-h-0 flex-1"
        classList={{ hidden: buffers().length === 0 }}
      >
        <div ref={host} class="h-full min-h-0" classList={{ hidden: !editorInteractive() }} />
        <Show when={activeViewerPath()}>
          {(path) => (
            <div class="absolute inset-0" data-slot="project-explorer-editor-viewer">
              <Switch>
                <Match when={activeKind() === "markdown"}>
                  <ProjectExplorerMarkdownViewer path={path()} content={activeContent()} />
                </Match>
                <Match when={activeKind() === "svg"}>
                  <ProjectExplorerSvgViewer path={path()} content={activeContent()} />
                </Match>
                <Match when={activeKind() === "image"}>
                  <ProjectExplorerImageViewer
                    path={path()}
                    content={activeBinaryDataUrl()}
                    mime={projectExplorerMime(path())}
                  />
                </Match>
                <Match when={activeKind() === "pdf"}>
                  <ProjectExplorerPdfViewer path={path()} content={activeBinaryDataUrl()} />
                </Match>
              </Switch>
            </div>
          )}
        </Show>
        <Show when={editorInteractive()}>
          <ProjectExplorerScrollbar
            viewport={() => editorView()?.scrollDOM}
            hoverTarget={() => editorView()?.scrollDOM}
            onScroll={updateLineSelection}
          />
          <Show when={commentButtonSelection()}>
            {(selection) => (
              <div class="project-explorer-editor-comment-anchor" style={{ top: `${comment.top}px` }}>
                <TooltipV2 value={language.t("ui.lineComment.submit")}>
                  <button
                    type="button"
                    data-slot="project-explorer-editor-comment-button"
                    aria-label={language.t("ui.lineComment.submit")}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setComment("draft", cloneSelection(selection()))}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M2.5 3.5h11v6.5H8.25L5.25 12.75V10H2.5V3.5Z"
                        stroke="currentColor"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </button>
                </TooltipV2>
              </div>
            )}
          </Show>
          <Show when={comment.draft}>
            {(selection) => (
              <LineCommentEditorV2
                data-slot="project-explorer-editor-comment"
                style={{ top: `${comment.top}px` }}
                value={comment.value}
                onInput={(value) => setComment("value", value)}
                onCancel={() => setComment(reconcile({ selected: null, draft: null, value: "", top: comment.top }))}
                onSubmit={submitComment}
                selection={selectionLabel(selection())}
                mention={{ items: file.searchFilesAndDirectories }}
              />
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}
