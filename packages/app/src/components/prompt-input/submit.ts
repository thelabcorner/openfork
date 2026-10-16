import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, startTransition, type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { snapshotPrompt } from "@/context/prompt-snapshot"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { stopSession } from "@/utils/session-stop"
import { createPromptSubmissionState } from "./submission-state"
import { correctPromptParts, shouldCorrectPromptSubmission } from "./correction"
import { normalizeSessionInfo } from "@/utils/session"
import { Event } from "@opencode-ai/schema/event"
import { blobDataUrl } from "@/utils/draft-store"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string; routeIntent?: import("@opencode-ai/schema/model-select/provider-route-intent").Info }
  variant?: string
  subProvider?: string
  goal?: {
    armKey: string
    projectID: string
    workspaceID?: string
    objective: string
  }
}

type FollowupSendInput = {
  api: DirectorySDK["api"]["session"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
  prepare?: (draft: FollowupDraft) => Promise<void>
  isCurrent?: () => boolean
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const humanInterjection = input.sync.session.get(input.draft.sessionID)?.humanInterjection === true
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = !humanInterjection && head?.startsWith("/") ? head.slice(1) : undefined
  const commands = cmd
    ? await input.serverSync.commands.ensure(input.draft.sessionDirectory, { isCurrent: input.isCurrent })
    : input.sync.data.command
  if (input.isCurrent && !input.isCurrent()) return false
  if (cmd && commands.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }
      await input.prepare?.(input.draft)

      const messageID = Identifier.ascending("message")
      await input.api.command({
        sessionID: input.draft.sessionID,
        id: messageID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: {
          id: input.draft.model.modelID,
          providerID: input.draft.model.providerID,
          variant: input.draft.variant,
        },
        routeIntent: input.draft.model.routeIntent,
        files: await Promise.all(
          images.map(async (attachment) => ({
            uri: await blobDataUrl(attachment.blob, attachment.mime),
            name: attachment.filename,
          })),
        ),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const encodedImages = await Promise.all(
    images.map(async (attachment) => ({
      ...attachment,
      dataUrl: await blobDataUrl(attachment.blob, attachment.mime),
    })),
  )
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images: encodedImages,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }
    await input.prepare?.(input.draft)

    await input.api.prompt({
      sessionID: input.draft.sessionID,
      id: messageID,
      agent: humanInterjection ? undefined : input.draft.agent,
      model: input.draft.model,
      variant: input.draft.variant,
      subProvider: input.draft.subProvider,
      legacyParts: requestParts,
      text: requestParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      files: requestParts.flatMap((part) => {
        if (part.type !== "file") return []
        const text = part.source?.text
        return [
          {
            uri: part.url,
            name: part.filename,
            mention: text ? { start: text.start, end: text.end, text: text.value } : undefined,
          },
        ]
      }),
      agents: requestParts.flatMap((part) =>
        part.type === "agent"
          ? [
              {
                name: part.name,
                mention: part.source
                  ? { start: part.source.start, end: part.source.end, text: part.source.value }
                  : undefined,
              },
            ]
          : [],
      ),
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  /** Only explicit first-party human composers may opt into normalization. */
  correctBeforeSubmit?: Accessor<boolean>
  correctionIgnoredWords?: Accessor<readonly string[]>
  correctionUserReplacements?: Accessor<Readonly<Record<string, string>>>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  model?: ModelSelection
  goal?: {
    key: (input: { sessionID?: string; draftID?: string; directory: string }) => string
    consume: (key: string) => true | undefined
    restore: (key: string, intent: true | undefined) => void
    quickStart: (
      sessionID: string,
      input: {
        objective: string
      },
    ) => Promise<unknown>
    refreshFocused: (sessionID: string) => Promise<void>
    focused: (sessionID: string) => unknown
  }
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
    if (err && typeof err === "object" && "data" in err) {
      const data = err.data
      if (data && typeof data === "object" && "message" in data && typeof data.message === "string")
        return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
    }
    // Cancelling a locally queued prompt is not the same as stopping an
    // already-admitted turn. Always run the server's exact-generation Stop as
    // well: another worker may already own this Session. Do not optimistically
    // erase durable TODO state or silently present a failed stop as success.
    return stopSession(sdk().api.session, sessionID).catch((error) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: errorMessage(error),
      })
    })
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    serverSync().session.remember(info)
    const [, setStore] = serverSync().child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event, options?: {
    skipCorrection?: boolean
    selectedPatchStarts?: readonly number[]
  }): Promise<boolean> => {
    event.preventDefault()

    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: snapshotPrompt(target.current()),
      context: target.context.items().map((item) => ({
        ...item,
        selection: item.selection ? { ...item.selection } : undefined,
      })),
    })
    const mode = input.mode()
    const worker = params.id ? sync().session.get(params.id) : undefined
    const humanInterjection = worker?.humanInterjection === true
    const correction = correctPromptParts(
      submission.prompt,
      shouldCorrectPromptSubmission({
        mode,
        enabled: input.correctBeforeSubmit?.() === true,
        skip: options?.skipCorrection,
        humanInterjection,
      }),
      {
        excludedWords: input.correctionIgnoredWords?.(),
        userReplacements: input.correctionUserReplacements?.(),
        locale: language.locale(),
        selectedPatchStarts: options?.selectedPatchStarts ? new Set(options.selectedPatchStarts) : undefined,
      },
    )
    const currentPrompt = correction.effective
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    // Read image descriptors from the same immutable admission snapshot as text.
    // A live composer accessor can change while session/worktree setup awaits.
    const images = draftImages(submission.prompt)
    const notifyCorrection = () => {
      if (!correction.patches.length) return
      showToast({
        title: language.t(correction.patches.length === 1
          ? "prompt.autocorrection.toast.one"
          : "prompt.autocorrection.toast.many"),
        description: language.t("prompt.autocorrection.toast.description", {
          changes: correction.patches.slice(0, 3).map((patch) => `${patch.original} → ${patch.replacement}`).join(", ") +
            (correction.patches.length > 3 ? "…" : ""),
        }),
      })
    }

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return false
    }

    const modelSelection = input.model ?? local.model
    // The composer selector is the execution choice for this prompt, including
    // when a human is steering a delegated worker. Keep the worker assignment
    // only as a fallback for older/temporarily unavailable selector state.
    const selectedModel = modelSelection.current()
    const currentModel = selectedModel ?? (humanInterjection && worker.model
      ? { id: worker.model.id, provider: { id: worker.model.providerID } }
      : undefined)
    const currentAgent = humanInterjection && worker.agent ? { name: worker.agent } : local.agent.current()
    const variant = selectedModel ? modelSelection.variant.current() : worker?.model?.variant ?? modelSelection.variant.current()
    const routeIntent = selectedModel ? modelSelection.routeIntent.current() : worker?.model?.routeIntent
    const subProvider =
      currentModel?.provider.id === "openrouter"
        ? modelSelection.subProvider.current()
        : undefined
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return false
    }

    const armKey = input.goal?.key({ sessionID: params.id, draftID: search.draftId, directory: sdk().directory })
    const goalArm = armKey && mode === "normal" && text.trim().length > 0 ? input.goal?.consume(armKey) : undefined
    const restoreGoalArm = () => {
      if (!armKey) return
      input.goal?.restore(armKey, goalArm)
    }

    // Preserve exactly what was in the editor at send time for history/undo.
    input.addToHistory(submission.prompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk().directory
    const permissionState = permission.currentServerState()
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk().client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          restoreGoalArm()
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return false
        }
        WorktreeState.pending(sdk().scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk().createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync().child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    const submittedSessionID = params.id
    let session = input.info()
    if (!session && submittedSessionID) {
      try {
        // The selected session may not have reached the renderer's in-memory
        // projection yet (for example, while the directory session list is
        // still loading). Resolve only this explicitly addressed session from
        // the global durable metadata owner; never turn a cache miss into a
        // new session or hydrate its message history.
        const resolved = await serverSync().session.resolve(submittedSessionID, { priority: "control" })
        if (params.id !== submittedSessionID || sdk().directory !== projectDirectory) return false
        sessionDirectory = resolved.directory || sessionDirectory
        seed(sessionDirectory, resolved)
        session = resolved
      } catch (err) {
        if (params.id !== submittedSessionID || sdk().directory !== projectDirectory) return false
        restoreGoalArm()
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err),
        })
        return false
      }
    }
    if (!session && isNewSession) {
      const created = await sdk()
        .api.session.create({
          agent: currentAgent.name,
          model: {
            id: currentModel.id,
            providerID: currentModel.provider.id,
            variant,
            ...(routeIntent ? { routeIntent } : {}),
          },
          location: { directory: sessionDirectory },
        })
        .then(normalizeSessionInfo)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        // Built-in Chat sessions are isolated by the server. The returned
        // directory is authoritative: a renderer may be connected to another
        // machine and must never derive that machine's HOME/USERPROFILE path.
        if (created.directory && created.directory !== sessionDirectory) {
          sessionDirectory = created.directory
          client = sdk().createClient({
            directory: sessionDirectory,
            throwOnError: true,
          })
          serverSync().child(sessionDirectory)
        }
        seed(sessionDirectory, created)
        session = created
        await startTransition(() => {
          if (!session) return
          // Materialize the effective new-session auto-accept as an explicit
          // per-session choice. Stamping both ON and OFF means later default or
          // directory changes cannot silently rewrite this session, and an
          // explicit OFF is never overwritten by the ON default.
          if (isNewSession) permissionState.initializeAutoAccept(session.id, sessionDirectory, shouldAutoAccept)
          local.session.promote(sessionDirectory, session.id, {
            agent: currentAgent.name,
            model: {
              providerID: currentModel.provider.id,
              modelID: currentModel.id,
              ...(routeIntent ? { routeIntent } : {}),
            },
            variant: variant ?? null,
          })
          layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
          const draftID = search.draftId
          if (draftID) tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: session.id })
          else navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
          submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id }))
        })
      }
    }
    if (!session) {
      restoreGoalArm()
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return false
    }

    if (!humanInterjection && !(await permissionState.synchronizeAutoAccept(session.id, sessionDirectory))) {
      restoreGoalArm()
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("common.requestFailed"),
      })
      return false
    }

    const authoritativeSession = sync().session.get(session.id)
    if (goalArm && !authoritativeSession) {
      restoreGoalArm()
      showToast({
        title: language.t("goal.error.title"),
        description: language.t("common.requestFailed"),
      })
      return false
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
      ...(routeIntent ? { routeIntent } : {}),
    }
    const agent = currentAgent.name
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
      subProvider,
      goal: goalArm
        ? {
            armKey: armKey!,
            projectID: authoritativeSession!.projectID,
            workspaceID: authoritativeSession!.workspaceID,
            objective: text.trim(),
          }
        : undefined,
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(submission.prompt))
        input.queueScroll()
      })
      return true
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      notifyCorrection()
      clearContext(submission.target())
      clearInput()
      return true
    }

    input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      const eventID = Event.ID.create()
      sdk()
        .api.session.shell({
          sessionID: session.id,
          id: eventID,
          command: text,
          agent,
          model,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return true
    }

    if (!humanInterjection && text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const commands = commandName
        ? await serverSync().commands.ensure(sessionDirectory, {
            isCurrent: () => sdk().directory === projectDirectory && (!params.id || params.id === session.id),
          })
        : sync().data.command
      if (params.id && params.id !== session.id) return false
      const customCommand = commands.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        const messageID = Identifier.ascending("message")
        serverSync().session.set("session_status", session.id, { type: "busy" })
        sdk()
          .api.session.command({
            sessionID: session.id,
            id: messageID,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: { id: model.modelID, providerID: model.providerID, variant },
            routeIntent: model.routeIntent,
            files: await Promise.all(
              images.map(async (attachment) => ({
                uri: await blobDataUrl(attachment.blob, attachment.mime),
                name: attachment.filename,
              })),
            ),
          })
          .catch((err) => {
            serverSync().session.set("session_status", session.id, { type: "idle" })
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return true
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sdk().scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    return sendFollowupDraft({
      api: sdk().api.session,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      isCurrent: () => sdk().directory === projectDirectory && (!params.id || params.id === draft.sessionID),
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
      prepare: async (next) => {
        if (!next.goal) return
        await input.goal!.quickStart(next.sessionID, {
          objective: next.goal.objective,
        })
      },
    })
      .then((sent) => {
        if (sent) notifyCorrection()
        return sent
      })
      .catch(async (err) => {
        pending.delete(pendingKey(session.id))
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        if (draft.goal) {
          await input.goal?.refreshFocused(draft.sessionID).catch(() => undefined)
          if (!input.goal?.focused(draft.sessionID)) {
            input.goal?.restore(draft.goal.armKey, true)
          }
        }
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err),
        })
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
        return false
      })
  }

  return {
    abort,
    handleSubmit,
  }
}
