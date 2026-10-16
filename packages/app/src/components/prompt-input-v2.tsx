import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Popover } from "@opencode-ai/ui/popover"
import { ScrollViewOverlayScrollbar } from "@opencode-ai/ui/scroll-view"
import type { ReferenceInfo } from "@opencode-ai/sdk/v2/client"
import { getFilename } from "@opencode-ai/core/util/path"
import type { SessionTelemetry } from "@opencode-ai/schema/session-telemetry"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  lazy,
  on,
  onCleanup,
  Show,
  Suspense,
  untrack,
} from "solid-js"
import { useParams, useSearchParams } from "@solidjs/router"
import { DialogSelectModelUnpaidV2 } from "@/components/dialog-select-model-unpaid-v2"
const ModelSelectorPopoverV2 = lazy(async () => {
  const mod = await import("@/components/dialog-select-model")
  return { default: mod.ModelSelectorPopoverV2 }
})
import type { PromptInputProps } from "@/components/prompt-input/contracts"
import { normalizePromptHistoryEntry, promptLength, type PromptHistoryComment } from "@/components/prompt-input/history"
import { createPersistedPromptInputHistory } from "@/components/prompt-input/history-store"
import { promptDesignPlaceholder, promptPlaceholder } from "@/components/prompt-input/placeholder"
import type { QuestionDetailsBinding } from "@/pages/session/composer/question-controller"
import { questionDetailsText } from "@/pages/session/composer/question-details"
import { createPromptSubmit } from "@/components/prompt-input/submit"
import { createPromptHarper } from "@/components/prompt-input/harper-controller"
import { snapshotPrompt } from "@/context/prompt-snapshot"
import { correctPromptParts } from "@/components/prompt-input/correction"
import { promptCorrectionReviewFingerprint } from "@/components/prompt-input/correction-review"
import { DialogPromptCorrectionReview } from "@/components/dialog-prompt-correction-review"
import { formatServerError } from "@/utils/server-errors"
import {
  createLiveGenerationRate,
  type LiveGenerationRateState,
  useLiveTelemetryNow,
} from "@/components/prompt-input/live-generation-rate"
import {
  promptTurnElapsedLabel,
  promptTurnElapsedMs,
  promptTurnLocalStartedAt,
} from "@/components/prompt-input/send-turn-lane-time"
import { sessionTelemetryClientNow } from "@/utils/session-telemetry-time"
import "@/components/prompt-input/send-turn-lane.css"
import {
  isPromptTextRevisable,
  promptOneShotRevisionAction,
  resolveAutomaticRevisionIntent,
  resolvePromptPrimaryAction,
} from "@/components/prompt-input/send-policy"
import {
  promptRevisionDraftContext,
  promptRevisionArtifactIsApplied,
  promptRevisionUsablePath,
  promptRevisionFingerprint,
  promptRevisionPrefix,
  promptRevisionRevealBoundaries,
  promptRevisionText,
  pollRevisionProgress,
  revisedPromptParts,
  cancelRevisionRun,
  resumeRevisionRun,
  type RevisionFailedStatus,
} from "@/components/prompt-input/prompt-revision"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import { useComments } from "@/context/comments"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePermission } from "@/context/permission"
import { type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useForkUsage } from "@/context/fork-usage"
import { useSync } from "@/context/sync"
import { useSettings } from "@/context/settings"
import { useServerSync } from "@/context/server-sync"
import { isSubagentMentionableAgent } from "@/context/local-agent"
import { SessionUsageWarningBanner } from "@/components/session-usage-warning-banner"
import { createSessionTabs } from "@/pages/session/helpers"
import { focusLimitsProvider } from "@/pages/session/limits-panel-state"
import { useLimits } from "@/hooks/use-limits"
import { splitModelIDForProvider } from "@/utils/model-account-identity"
import { providerModelID } from "@opencode-ai/schema/model-select/account-identity"
import { useNow } from "@/hooks/use-now"
import { buildArcModel, type ArcModel } from "@/components/prompt-input/limit-arc"
import { LimitArcCard, LimitArcGlyph } from "@/components/prompt-input/limit-arc-view"
import { showToast } from "@/utils/toast"
import { activeGenerationMismatch, modelIdentityKey, shouldFollowActiveModel, type ModelIdentity } from "@/components/prompt-input/model-mismatch"
import { modelSwitchSelection } from "@/components/prompt-input/model-switch-selection"
import type { CompatibleRevisionDraftArtifact, CompatibleRevisionProgress } from "@/utils/server-compat"
import {
  promptRevisionTargetKey,
  promptRevisionSourceFingerprint,
  revisionCanApplyNow,
  revisionRecoveryDecision,
  type RevisionDraftTarget,
} from "@/utils/revision-draft"
import { PromptInputV2, type PromptInputV2Suggestion } from "@opencode-ai/session-ui/v2/prompt-input"
import { GoalComposerLauncher } from "@/components/goal-composer-shelf"
import { goalArmKey, useGoals } from "@/context/goals"
import { SettingsModelPickerV2, type SettingsModelRef } from "@/components/settings-v2/parts/model-picker"
import {
  createPromptInputV2Controller,
  createPromptInputV2State,
  type PromptInputV2Interaction,
} from "@opencode-ai/session-ui/v2/prompt-input/interaction"

export type PromptInputV2ComposerProps = {
  class?: string
  controller: PromptInputV2ComposerController
  borderUnderlay?: boolean
}

export type PromptInputV2ControllerProps = Omit<PromptInputProps, "class" | "submission"> & {
  /**
   * Hands the composer over to a pending question: the editor becomes that
   * question's "additional details" field instead of a message draft, so the
   * full mention system (`@file`, `@agent`, `@skill`) works while answering.
   */
  question?: PromptInputV2QuestionIntegration
}

export type PromptInputV2QuestionIntegration = {
  active: () => boolean
  /** Placeholder describing the question being answered. */
  placeholder: () => string
  /** Whether the primary action can fire (an option is picked or details exist). */
  canSubmit: () => boolean
  /** Advance to the next question, or send the reply on the last one. */
  submit: () => void
  /** Registers the composer as the details editor; returns an unbind callback. */
  bind: (binding: QuestionDetailsBinding) => () => void
}
type PromptRevisionSendRegistration = {
  run: (intent: PromptRevisionFlow["intent"]) => void
  busy: () => boolean
  readyForSend: () => boolean
  cancel: (options?: { notify?: boolean }) => void
  /** Latest advisory progress for the in-flight revision; undefined while idle. */
  progress: () => CompatibleRevisionProgress | undefined
}

export type PromptInputV2ComposerController = PromptInputV2Interaction & {
  readonly model: PromptInputProps["controls"]["model"]
  readonly autoAccept: { active: () => boolean; toggle: () => void }
  readonly liveRate: () => LiveGenerationRateState
  readonly sessionID: () => string | undefined
  readonly grammar: {
    enabled: () => boolean
    issues: () => readonly import("@/components/prompt-input/harper-projection").PromptGrammarIssue[]
    state: () => "off" | "idle" | "loading" | "ready" | "unavailable"
    undo: () => boolean
    undoAvailable: () => boolean
    apply: (id: string, replacement: string) => boolean
    ignore: (word: string) => void
    onCompositionChange: (active: boolean) => void
    autoChanges: () => readonly import("@/components/prompt-input/harper-autofix").AutoHarperChange[]
    rejectAuto: (id: string) => boolean
    dismiss: (id: string) => boolean
  }
  readonly revisionSend: {
    autoBeforeSend: () => boolean
    setAutoBeforeSend: (value: boolean) => void
    autoSendAfterRevision: () => boolean
    setAutoSendAfterRevision: (value: boolean) => void
    available: () => boolean
    busy: () => boolean
    readyForSend: () => boolean
    progress: () => CompatibleRevisionProgress | undefined
    register: (registration: PromptRevisionSendRegistration) => () => void
    sendWithRevision: () => void
    sendWithoutRevision: (options?: { skipCorrection?: boolean; selectedPatchStarts?: readonly number[] }) => Promise<boolean>
    sendExact: () => Promise<boolean>
    reviewCorrections: () => void
  }
  readonly questionActive: () => boolean
  readonly awaitDraftReady: () => Promise<void>
  readonly flushDraft: () => Promise<void>
}

export function PromptInputV2Composer(props: PromptInputV2ComposerProps) {
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const params = useParams<{ id?: string }>()
  const [search] = useSearchParams<{ draftId?: string }>()
  const sessionID = () => params.id
  const telemetry = () => {
    const id = sessionID()
    return id ? serverSync().telemetry.get(id) : undefined
  }
  const switchModel = async (
    target: ModelIdentity,
    attempt: { assistantMessageID: string; requestSentAt: number },
  ) => {
    const id = sessionID()
    if (!id) return
    await sdk().client.session.switchModel({
      sessionID: id,
      assistantMessageID: attempt.assistantMessageID,
      requestSentAt: attempt.requestSentAt,
      providerID: target.providerID,
      modelID: target.modelID,
      ...(target.accountID ? { accountID: target.accountID } : {}),
      ...(target.variant ? { variant: target.variant } : {}),
    })
  }
  const armKey = () => goalArmKey({ sessionID: sessionID(), draftID: search.draftId, directory: sdk().directory })

  return (
    <div class="flex flex-col gap-3">
      <SessionUsageWarningBanner providerID={props.controller.model.selection.current()?.provider?.id} />
      <PromptInputV2
        controller={props.controller}
        writingAssistance={{
          enabled: props.controller.grammar.enabled(),
          status: props.controller.grammar.state(),
          issues: props.controller.grammar.issues(),
          onApply: props.controller.grammar.apply,
          onIgnore: props.controller.grammar.ignore,
          onCompositionChange: props.controller.grammar.onCompositionChange,
          undoAvailable: props.controller.grammar.undoAvailable(),
          onUndo: props.controller.grammar.undo,
          autoChanges: props.controller.grammar.autoChanges(),
          onRejectAuto: props.controller.grammar.rejectAuto,
          onDismiss: props.controller.grammar.dismiss,
        }}
        borderUnderlay={props.borderUnderlay}
        class={props.class}
        variantControlVisible={!props.controller.model.loading}
        attachKeybind={command.keybindParts("file.attach")}
        attachShortcut={command.keybind("file.attach")}
        usageControl={<PromptInputV2UsageArc model={props.controller.model.selection} />}
        autoAcceptControl={
          <PromptInputV2AutoAcceptToggle
            active={props.controller.autoAccept.active()}
            onToggle={props.controller.autoAccept.toggle}
          />
        }
        goalControl={<GoalComposerLauncher sessionID={sessionID()} armKey={armKey()} promptText={() => props.controller.value()} />}
        revisionControl={
          <PromptInputV2RevisionControl
            controller={props.controller}
            sessionID={sessionID()}
            draftID={search.draftId}
          />
        }
        submitControl={<PromptInputV2SendControl controller={props.controller} />}
        footerControl={<PromptInputV2LiveRate value={props.controller.liveRate()} />}
        modelControl={
          <PromptInputV2ModelControl
            loading={props.controller.model.loading}
            paid={props.controller.model.paid}
            title={language.t("command.model.choose")}
            keybind={command.keybindParts("model.choose")}
            model={props.controller.model.selection}
            sessionID={sessionID()}
            telemetry={telemetry}
            onSwitch={switchModel}
            providerID={props.controller.model.selection.current()?.provider?.id}
            modelName={props.controller.model.selection.current()?.name ?? language.t("dialog.model.select.title")}
            onClose={props.controller.restoreFocus}
            onUnpaidClick={() =>
              dialog.show(() => <DialogSelectModelUnpaidV2 model={props.controller.model.selection} />)
            }
          />
        }
      />
    </div>
  )
}

type PromptRevisionFlow = {
  token: number
  intent: "review" | "send"
  draft: string
  before: ReturnType<PromptInputV2ComposerController["parts"]>
  beforeFingerprint: string
  restoreBefore: ReturnType<PromptInputV2ComposerController["parts"]>
  restoreDraft: string
  guidance?: string
  model?: { providerID: string; id: string; accountID?: string; variant?: string }
  fallbackModel?: { providerID: string; id: string; accountID?: string; variant?: string }
  directory: string
  sessionID?: string
  target: RevisionDraftTarget
}

function promptRevisionModelRef(providerID: string, qualifiedModelID: string, variant?: string) {
  const split = splitModelIDForProvider(qualifiedModelID, providerID)
  return {
    providerID,
    id: split.baseModelID,
    ...(split.accountID ? { accountID: split.accountID } : {}),
    ...(variant ? { variant } : {}),
  }
}

/**
 * Correlation id for one revision operation. The host keys its advisory
 * latest-value progress projection by exactly this id, and the composer polls
 * it only while the matching revise request is in flight.
 */
function createRevisionOperationID() {
  try {
    return crypto.randomUUID()
  } catch {
    return `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  }
}

/**
 * Failures already surfaced by a returning composer, keyed by locator + the
 * registry's failure timestamp. The registry retains failures for a bounded
 * TTL; this only keeps a remount (tab switch back and forth) from repeating
 * the same toast.
 */
const surfacedRevisionFailures = new Set<string>()
const markRevisionFailureSurfaced = (key: string, at: number) => {
  const id = `${key}\0${at}`
  if (surfacedRevisionFailures.has(id)) return false
  if (surfacedRevisionFailures.size >= 64) {
    const oldest = surfacedRevisionFailures.values().next().value
    if (oldest !== undefined) surfacedRevisionFailures.delete(oldest)
  }
  surfacedRevisionFailures.add(id)
  return true
}

function PromptRevisionBusyIcon() {
  // Re-seed each revision run (this component only mounts while busy). The
  // pencil has a restrained breath while each sparkle gets its own irregular
  // cadence, so the motion feels organic instead of like three synchronized
  // loading dots.
  const sparkle = () => ({
    duration: `${(2.4 + Math.random() * 1.8).toFixed(2)}s`,
    begin: `-${(Math.random() * 3.2).toFixed(2)}s`,
  })
  const top = sparkle()
  const right = sparkle()
  const left = sparkle()

  return (
    <svg
      data-slot="icon-svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      class="text-v2-icon-icon-accent"
    >
      <g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <g>
          <path d="m15.007 5.008 3.987 3.986" />
          <path d="M21.174 6.813a2.82 2.82 0 0 0-3.986-3.987L3.842 16.175a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
          <animate attributeName="opacity" values="0.78;1;0.9;1;0.78" dur="2.8s" repeatCount="indefinite" />
        </g>

        <g>
          <path d="M10 3H8" />
          <path d="M9 2v2" />
          <animate
            attributeName="opacity"
            values="0.34;0.78;0.52;1;0.42;0.7;0.34"
            dur={top.duration}
            begin={top.begin}
            repeatCount="indefinite"
          />
        </g>

        <g>
          <path d="M20 15v4" />
          <path d="M22 17h-4" />
          <animate
            attributeName="opacity"
            values="0.42;0.86;0.36;0.72;0.5;1;0.42"
            dur={right.duration}
            begin={right.begin}
            repeatCount="indefinite"
          />
        </g>

        <g>
          <path d="M4 5v4" />
          <path d="M6 7H2" />
          <animate
            attributeName="opacity"
            values="0.38;0.66;0.94;0.46;0.8;0.54;0.38"
            dur={left.duration}
            begin={left.begin}
            repeatCount="indefinite"
          />
        </g>
      </g>
    </svg>
  )
}

function PromptInputV2RevisionControl(props: {
  controller: PromptInputV2ComposerController
  sessionID?: string
  draftID?: string
}) {
  const sdk = useSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const settings = useSettings()
  const [busy, setBusy] = createSignal(false)
  const [progress, setProgress] = createSignal<CompatibleRevisionProgress | undefined>()
  const [open, setOpen] = createSignal(false)
  const [guidance, setGuidance] = createSignal("")
  const [modelOverride, setModelOverride] = createSignal<SettingsModelRef | undefined>()
  const [restoreState, setRestoreState] = createSignal<{
    before: ReturnType<PromptInputV2ComposerController["parts"]>
    text: string
    afterFingerprint: string
    artifactID?: string
    targetKey: string
    directory: string
  }>()
  let guidanceTextarea: HTMLTextAreaElement | undefined
  let guidanceEditorArea: HTMLDivElement | undefined
  let request = 0
  let abort: AbortController | undefined
  let progressPoll: AbortController | undefined
  let resumePoll: AbortController | undefined
  let activeRun: { key: string; operationID?: string } | undefined
  const questionReleaseWaiters = new Set<() => void>()
  const releaseQuestionWaiters = () => {
    for (const resolve of questionReleaseWaiters) resolve()
    questionReleaseWaiters.clear()
  }
  createEffect(() => {
    if (props.controller.questionActive()) return
    releaseQuestionWaiters()
  })
  // Component teardown abandons local waiters only. With a durable target the
  // run is owned by the server-side registry; explicit cancellation goes
  // through `cancelRevision` and the cancel endpoint instead.
  onCleanup(() => {
    request += 1
    abort?.abort()
    progressPoll?.abort()
    resumePoll?.abort()
    releaseQuestionWaiters()
  })

  const awaitQuestionRelease = () =>
    props.controller.questionActive()
      ? new Promise<void>((resolve) => questionReleaseWaiters.add(resolve))
      : Promise.resolve()

  const targetKey = () =>
    promptRevisionTargetKey({
      sessionID: props.sessionID,
      draftID: props.draftID,
      directory: sdk().directory,
      windowID: platform.windowID,
    })
  let recoveredScope: string | undefined

  const consumeArtifact = async (id: string | undefined) => {
    if (!id) return false
    try {
      await sdk().api.revisionDraft.consume({ id })
      return true
    } catch {
      return false
    }
  }

  const applyRecovered = async (artifact: CompatibleRevisionDraftArtifact, expectedFingerprint: string) => {
    if (!artifact) return
    if (artifact.key !== targetKey()) {
      changedToast()
      return
    }
    const currentFingerprint = await promptRevisionSourceFingerprint({
      directory: sdk().directory,
      promptFingerprint: promptRevisionFingerprint(props.controller.parts()),
    })
    if (artifact.key !== targetKey()) {
      changedToast()
      return
    }
    if (
      !revisionCanApplyNow({
        expectedFingerprint,
        currentFingerprint,
      })
    ) {
      changedToast()
      return
    }
    const before = props.controller.parts().map((part) => ({ ...part })) as ReturnType<
      PromptInputV2ComposerController["parts"]
    >
    const next = revisedPromptParts(artifact.prompt, before, artifact.references)
    props.controller.addHistory(before, "normal")
    props.controller.onInput(artifact.prompt, next, artifact.prompt.length)
    props.controller.restoreFocus()
    await props.controller.flushDraft()
    await consumeArtifact(artifact.id)
    showToast({
      variant: "success",
      title: language.t("prompt.revision.recovery.restored"),
    })
  }

  /**
   * Recover one durable revision artifact for this composer target and report
   * whether it was handled. Shared by the mount effect and the resumed-run
   * supervisor, so both paths use the same fingerprint fences and conflict UI.
   */
  const recoverPendingArtifact = async (input: {
    directory: string
    key: string
    signal?: AbortSignal
  }): Promise<boolean> => {
    const { directory, key } = input
    const artifact = await sdk()
      .api.revisionDraft.recover({ kind: "prompt", key })
      .catch(() => null)
    if (input.signal?.aborted) return false
    if (!artifact || artifact.kind !== "prompt" || artifact.key !== key || sdk().directory !== directory) return false
    const current = props.controller.parts()
    const currentText = props.controller.value()
    const structurallyApplied = promptRevisionArtifactIsApplied(current, artifact.prompt, artifact.references)
    const currentFingerprint = await promptRevisionSourceFingerprint({
      directory,
      promptFingerprint: promptRevisionFingerprint(current),
    })
    if (input.signal?.aborted) return false
    if (targetKey() !== key || sdk().directory !== directory) return false
    if (structurallyApplied) {
      await props.controller.flushDraft()
      await consumeArtifact(artifact.id)
      return true
    }
    const decision = revisionRecoveryDecision({
      sourceFingerprint: artifact.sourceFingerprint,
      currentFingerprint,
      currentText,
      revisedText: artifact.prompt,
      consumeIfEqual: false,
    })
    if (decision === "apply") {
      await applyRecovered(artifact, artifact.sourceFingerprint)
      return true
    }
    showToast({
      title: language.t("prompt.revision.recovery.title"),
      description: language.t("prompt.revision.recovery.description"),
      actions: [
        {
          label: language.t("prompt.revision.recovery.apply"),
          onClick: () => void applyRecovered(artifact, currentFingerprint),
        },
        { label: language.t("common.dismiss"), onClick: () => void consumeArtifact(artifact.id) },
      ],
    })
    return true
  }

  /**
   * A failed run that outlived its composer is surfaced once, and only while
   * the visible draft is still the source that was being revised.
   */
  const surfaceRunFailure = async (failed: RevisionFailedStatus, directory: string, key: string) => {
    if (!markRevisionFailureSurfaced(key, failed.at)) return
    const currentFingerprint = await promptRevisionSourceFingerprint({
      directory,
      promptFingerprint: promptRevisionFingerprint(props.controller.parts()),
    })
    if (targetKey() !== key || sdk().directory !== directory) return
    if (currentFingerprint !== failed.sourceFingerprint) return
    showToast({
      variant: "error",
      title: language.t("prompt.revision.error.title"),
      description: failed.message,
    })
  }

  createEffect(() => {
    const directory = sdk().directory
    const key = targetKey()
    const scope = `${directory}\0${key}`
    if (scope === recoveredScope) return
    recoveredScope = scope
    const controller = new AbortController()
    resumePoll?.abort()
    resumePoll = controller
    void (async () => {
      await props.controller.awaitDraftReady()
      if (controller.signal.aborted) return
      if (await recoverPendingArtifact({ directory, key, signal: controller.signal })) return
      if (controller.signal.aborted || targetKey() !== key || sdk().directory !== directory) return
      const status = await sdk()
        .api.promptRevisor.runStatus({ kind: "prompt", key, signal: controller.signal })
        .catch(() => null)
      if (controller.signal.aborted || targetKey() !== key || sdk().directory !== directory) return
      if (status?.state === "failed") {
        await surfaceRunFailure(status, directory, key)
        return
      }
      if (!status || status.state !== "running") return
      // The composer that started this run is gone (tab switch, reload), but
      // the process-global registry still owns it. Show the in-flight state
      // and keep the existing bounded progress poll under the correlation id
      // the registry reports, then recover the committed artifact on settle.
      setBusy(true)
      activeRun = { key, operationID: status.operationID }
      const run = resumeRevisionRun({
        readStatus: (signal) => sdk().api.promptRevisor.runStatus({ kind: "prompt", key, signal }),
        ...(status.operationID === undefined
          ? {}
          : {
              readProgress: (operationID: string, signal: AbortSignal) =>
                sdk().api.promptRevisor.progress({ operationID, signal }),
            }),
        recover: (signal) => recoverPendingArtifact({ directory, key, signal }),
        onRunning: () => {},
        onProgress: (next) => {
          if (!controller.signal.aborted && targetKey() === key) setProgress(next)
        },
        onFailed: (failed) => void surfaceRunFailure(failed, directory, key),
        isCurrent: () => !controller.signal.aborted && targetKey() === key && sdk().directory === directory,
      })
      await run.done
      if (controller.signal.aborted) return
      setProgress(undefined)
      setBusy(false)
      if (activeRun?.key === key) activeRun = undefined
    })()
    onCleanup(() => controller.abort())
  })

  const targetChanged = (flow: PromptRevisionFlow) =>
    sdk().directory !== flow.directory || targetKey() !== flow.target.key || props.sessionID !== flow.sessionID

  const changed = (flow: PromptRevisionFlow) =>
    promptRevisionFingerprint(props.controller.parts()) !== flow.beforeFingerprint || targetChanged(flow)

  const changedToast = () =>
    showToast({
      title: language.t("prompt.revision.error.title"),
      description: language.t("prompt.revision.changedDuringRequest"),
    })

  const restorable = createMemo(() => {
    const state = restoreState()
    if (!state) return undefined
    if (state.targetKey !== targetKey() || state.directory !== sdk().directory) return undefined
    return promptRevisionFingerprint(props.controller.parts()) === state.afterFingerprint ? state : undefined
  })

  createEffect(() => {
    const state = restoreState()
    if (!state || busy()) return
    if (state.targetKey !== targetKey() || state.directory !== sdk().directory) {
      setRestoreState(undefined)
      return
    }
    if (promptRevisionFingerprint(props.controller.parts()) === state.afterFingerprint) return
    setRestoreState(undefined)
  })

  const restoreOriginal = async (state = restorable()) => {
    if (!state || busy()) return
    if (
      state.targetKey !== targetKey() ||
      state.directory !== sdk().directory ||
      promptRevisionFingerprint(props.controller.parts()) !== state.afterFingerprint
    ) {
      setRestoreState(undefined)
      return
    }
    const revised = props.controller.parts().map((part) => ({ ...part })) as ReturnType<
      PromptInputV2ComposerController["parts"]
    >
    props.controller.addHistory(revised, "normal")
    setRestoreState(undefined)
    props.controller.onInput(state.text, state.before, state.text.length)
    props.controller.restoreFocus()
    await props.controller.flushDraft()
    await consumeArtifact(state.artifactID)
  }

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  const apply = async (
    flow: PromptRevisionFlow,
    prompt: string,
    references: Parameters<typeof revisedPromptParts>[2] = [],
    artifactID?: string,
  ) => {
    const next = revisedPromptParts(prompt, flow.before, references)
    const appliedFingerprint = promptRevisionFingerprint(next)
    props.controller.addHistory(flow.before, "normal")
    setOpen(false)
    props.controller.restoreFocus()

    const reducedMotion =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    if (reducedMotion) {
      props.controller.onInput(prompt, next, prompt.length)
    } else {
      const boundaries = promptRevisionRevealBoundaries(next)
      const empty = promptRevisionPrefix(next, 0)
      let expectedFingerprint = flow.beforeFingerprint
      if (
        flow.token !== request ||
        targetChanged(flow) ||
        promptRevisionFingerprint(props.controller.parts()) !== expectedFingerprint
      )
        return false

      props.controller.onInput("", empty, 0)
      expectedFingerprint = promptRevisionFingerprint(empty)

      const frameCount = Math.max(1, boundaries.length)
      const targetDuration = Math.min(2600, Math.max(700, frameCount * 36))
      const baseDelay = Math.min(70, Math.max(24, targetDuration / frameCount))
      let previous = 0

      for (const boundary of boundaries) {
        const segment = prompt.slice(previous, boundary)
        const punctuationPause = /\n\s*$/u.test(segment) ? 42 : /[.!?;:]\s*$/u.test(segment) ? 16 : 0
        await wait(baseDelay + punctuationPause)
        if (flow.token !== request) return false
        if (targetChanged(flow)) return false
        if (promptRevisionFingerprint(props.controller.parts()) !== expectedFingerprint) return false

        const partial = promptRevisionPrefix(next, boundary)
        const partialText = promptRevisionText(partial)
        props.controller.onInput(partialText, partial, partialText.length)
        expectedFingerprint = promptRevisionFingerprint(partial)
        previous = boundary
      }
    }

    if (
      flow.token !== request ||
      targetChanged(flow) ||
      promptRevisionFingerprint(props.controller.parts()) !== appliedFingerprint
    )
      return false
    setGuidance("")
    setModelOverride(undefined)
    props.controller.restoreFocus()
    if (flow.intent === "send") {
      setRestoreState(undefined)
      return true
    }

    const restored = {
      before: flow.restoreBefore,
      text: flow.restoreDraft,
      afterFingerprint: appliedFingerprint,
      artifactID,
      targetKey: flow.target.key,
      directory: flow.directory,
    }
    setRestoreState(restored)
    showToast({
      variant: "success",
      title: language.t("prompt.revision.success.title"),
      description: language.t("prompt.revision.success.description"),
      actions: [
        {
          label: language.t("prompt.revision.restore"),
          onClick: () => void restoreOriginal(restored),
        },
      ],
    })
    return true
  }

  const send = async (flow: PromptRevisionFlow) => {
    if (flow.token !== request) return
    if (changed(flow)) {
      changedToast()
      setOpen(false)
      return
    }
    setBusy(true)
    const controller = new AbortController()
    abort?.abort()
    abort = controller
    // One client-generated correlation id per revision: the host reports live
    // advisory progress under exactly this id and clears it when the operation
    // settles, so a superseded or finished flow never shows a stale number.
    const operationID = createRevisionOperationID()
    activeRun = { key: flow.target.key, operationID }
    progressPoll?.abort()
    const progressController = new AbortController()
    progressPoll = progressController
    setProgress(undefined)
    void pollRevisionProgress({
      operationID,
      read: (id, signal) => sdk().api.promptRevisor.progress({ operationID: id, signal }),
      isCurrent: () => flow.token === request,
      onUpdate: (next) => {
        if (flow.token === request) setProgress(next)
      },
      signal: progressController.signal,
    })
    try {
      const result = await sdk().api.promptRevisor.revise({
        prompt: flow.draft,
        target: flow.target,
        draft: promptRevisionDraftContext(flow.before),
        sessionID: flow.sessionID,
        guidance: flow.guidance,
        model: flow.model,
        fallbackModel: flow.fallbackModel,
        operationID,
        location: { directory: flow.directory },
        signal: controller.signal,
      })
      if (flow.token !== request) return
      await awaitQuestionRelease()
      if (flow.token !== request) return
      if (changed(flow)) {
        changedToast()
        setOpen(false)
        return
      }
      if (result.type === "cancelled") {
        showToast({
          title: language.t("prompt.revision.cancelled.title"),
          description: language.t("prompt.revision.cancelled.description"),
        })
        return
      }
      const applied = await apply(flow, result.prompt, result.references ?? [], result.artifactID)
      if (!applied) return
      await props.controller.flushDraft()
      if (flow.intent === "send") {
        // Revise-and-send remains recoverable while the optimistic composer clear
        // is in flight. Acknowledgement happens only after server admission.
        const sent = await props.controller.revisionSend.sendWithoutRevision({ skipCorrection: true })
        if (sent) await consumeArtifact(result.artifactID)
        return
      }
      await consumeArtifact(result.artifactID)
    } catch (error) {
      if (flow.token !== request) return
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return
      showToast({
        variant: "error",
        title: language.t("prompt.revision.error.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      progressController.abort()
      if (progressPoll === progressController) progressPoll = undefined
      if (abort === controller) abort = undefined
      if (activeRun?.operationID === operationID) activeRun = undefined
      if (flow.token === request) {
        setBusy(false)
        setProgress(undefined)
      }
    }
  }

  const run = async (extra?: string, intent: PromptRevisionFlow["intent"] = "review") => {
    const draft = props.controller.value()
    if (busy() || props.controller.questionActive() || props.controller.state.mode !== "normal" || !draft.trim()) return
    const token = ++request
    const before = props.controller.parts().map((part) => ({ ...part })) as ReturnType<
      PromptInputV2ComposerController["parts"]
    >
    const beforeFingerprint = promptRevisionFingerprint(before)
    const directory = sdk().directory
    const key = targetKey()
    const sourceFingerprint = await promptRevisionSourceFingerprint({
      directory,
      promptFingerprint: beforeFingerprint,
    })
    if (
      token !== request ||
      sdk().directory !== directory ||
      targetKey() !== key ||
      promptRevisionFingerprint(props.controller.parts()) !== beforeFingerprint
    )
      return
    const priorRestore = restorable()
    // Persistent Prompt Revisor model selection is owned by the canonical
    // `prompt-revisor` agent configuration on the server. The request-level
    // model is reserved for an explicit one-shot override from this control.
    const configured = modelOverride()
    const current = props.controller.model.selection.current()
    const variant = props.controller.model.selection.variant.current()
    if (intent === "send") setOpen(false)
    void send({
      token,
      intent,
      draft,
      before,
      beforeFingerprint,
      restoreBefore: priorRestore?.before ?? before,
      restoreDraft: priorRestore?.text ?? draft,
      guidance: extra?.trim() || undefined,
      model: configured ? promptRevisionModelRef(configured.providerID, configured.modelID) : undefined,
      fallbackModel: current ? promptRevisionModelRef(current.provider.id, current.id, variant) : undefined,
      directory,
      sessionID: props.sessionID,
      target: {
        kind: "prompt",
        key,
        sourceFingerprint,
      },
    })
  }

  /**
   * Explicit cancellation. A raw client abort no longer stops the detached
   * run, so the server cancel endpoint is the only thing that actually ends
   * it; the local waiters are torn down either way. `notify` is false when the
   * cancellation is a side effect of sending without the Revisor.
   */
  const cancelRevision = async (notify: boolean) => {
    const active = activeRun
    request += 1
    abort?.abort()
    abort = undefined
    progressPoll?.abort()
    progressPoll = undefined
    resumePoll?.abort()
    resumePoll = undefined
    activeRun = undefined
    setProgress(undefined)
    releaseQuestionWaiters()
    setBusy(false)
    setOpen(false)
    setModelOverride(undefined)
    props.controller.restoreFocus()
    if (!active) return false
    const cancelled = await cancelRevisionRun({
      kind: "prompt",
      key: active.key,
      operationID: active.operationID,
      cancel: (input) => sdk().api.promptRevisor.cancel(input),
    })
    if (notify) {
      showToast({
        title: language.t("prompt.revision.cancelled.title"),
        description: language.t("prompt.revision.cancelled.description"),
      })
    }
    return cancelled
  }

  const unregisterRevisionSend = props.controller.revisionSend.register({
    run: (intent) => void run(undefined, intent),
    busy,
    readyForSend: () => !!restorable(),
    cancel: (options) => void cancelRevision(options?.notify !== false),
    progress,
  })
  onCleanup(unregisterRevisionSend)

  const hasDraft = () =>
    props.controller.state.mode === "normal" &&
    !props.controller.questionActive() &&
    props.controller.value().trim().length > 0

  // A guidance popover opened for one composer owner must never survive a
  // transition into shell mode, question ownership, or an emptied draft. Apart
  // from looking stale, its keyboard shortcut would otherwise remain an
  // alternate entry point into revision after the primary policy changed.
  createEffect(() => {
    if (!hasDraft()) setOpen(false)
  })

  return (
    <div data-prompt-revision-split-control="" class="flex shrink-0 items-center">
      <TooltipV2
        placement="top"
        gutter={4}
        value={busy() ? language.t("prompt.revision.cancel") : language.t("prompt.revision.description")}
      >
        <IconButtonV2
          type="button"
          size="large"
          variant="ghost-muted"
          class={`shrink-0 !rounded-r-[3px] ${busy() ? "!text-v2-icon-icon-accent !opacity-100" : ""}`}
          disabled={!busy() && !hasDraft()}
          aria-label={busy() ? language.t("prompt.revision.cancel") : language.t("prompt.revision.title")}
          icon={
            <Show when={busy()} fallback={<Icon name="pencil-sparkles" size="small" />}>
              <PromptRevisionBusyIcon />
            </Show>
          }
          onClick={() => (busy() ? void cancelRevision(true) : void run())}
        />
      </TooltipV2>
      <Show when={restorable()}>
        {(state) => (
          <TooltipV2 placement="top" gutter={4} value={language.t("prompt.revision.restore")}>
            <IconButtonV2
              type="button"
              size="large"
              variant="ghost-muted"
              class="shrink-0 !w-5 !rounded-[3px]"
              aria-label={language.t("prompt.revision.restore")}
              icon={<Icon name="reset" size="small" class="size-3" />}
              onClick={() => restoreOriginal(state())}
            />
          </TooltipV2>
        )}
      </Show>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        placement="top-start"
        gutter={6}
        onOpenAutoFocus={(event) => event.preventDefault()}
        ownedPortalSelector='[data-component="menu-v2-content"]'
        triggerAs={IconButtonV2}
        triggerProps={{
          type: "button",
          size: "large",
          variant: "ghost-muted",
          disabled: busy() || !hasDraft(),
          "aria-label": language.t("prompt.revision.guidance.open"),
          class: "shrink-0 !w-5 !rounded-l-[3px]",
        }}
        trigger={<Icon name="chevron-down" size="small" class="size-3" />}
        class="w-[min(370px,calc(100vw-16px))] overflow-hidden rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)] [&_[data-slot=popover-body]]:p-0"
      >
        <div class="flex flex-col bg-v2-background-bg-base">
              <div class="flex h-8 items-center justify-between gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5">
                <div class="flex min-w-0 items-center gap-1.5">
                  <Icon name="pencil-sparkles" size="small" class="size-3.5 shrink-0 text-v2-icon-icon-muted" />
                  <span class="truncate text-[11px] font-[600] text-v2-text-text-base">
                    {language.t("prompt.revision.title")}
                  </span>
                </div>
                <div class="flex min-w-0 items-center gap-1">
                  <span class="text-[8px] font-[600] uppercase tracking-[0.05em] text-v2-text-text-faint">
                    {language.t("prompt.revision.model")}
                  </span>
                  <SettingsModelPickerV2
                    action="prompt-revision-run-model"
                    value={modelOverride()}
                    defaultLabel={language.t("prompt.revision.model.inherit")}
                    compact
                    onChange={setModelOverride}
                  />
                </div>
              </div>
              <div ref={(element) => (guidanceEditorArea = element)} class="relative bg-v2-background-bg-base">
                <textarea
                  ref={(element) => (guidanceTextarea = element)}
                  value={guidance()}
                  rows={2}
                  maxlength={1000}
                  placeholder={language.t("prompt.revision.guidance.placeholder")}
                  class="block h-[66px] min-h-[54px] max-h-[min(260px,40vh)] w-full resize-y overflow-y-auto border-0 bg-v2-background-bg-base px-2.5 py-2 pr-4 text-[11px] leading-[15px] text-v2-text-text-base outline-none no-scrollbar placeholder:text-v2-text-text-faint"
                  onInput={(event) => setGuidance(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault()
                      void run(guidance())
                    }
                  }}
                />
                <ScrollViewOverlayScrollbar viewport={() => guidanceTextarea} hoverTarget={() => guidanceEditorArea} />
              </div>
              <div class="flex min-h-9 items-center justify-between gap-2 border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1.5">
                <span class="px-0.5 text-[9px] text-v2-text-text-faint">⌘/Ctrl + Enter</span>
                <ButtonV2
                  type="button"
                  size="small"
                  variant="contrast"
                  disabled={busy() || !hasDraft()}
                  onClick={() => void run(guidance())}
                >
                  {language.t("prompt.revision.guidance.run")}
                </ButtonV2>
              </div>
        </div>
      </Popover>
    </div>
  )
}

const PROMPT_MIN_VISIBLE_TURN_MS = 340
const PROMPT_SETTLED_VISIBLE_MS = 900

type PromptTurnBaton = "none" | "arming" | "stop" | "stopping" | "settled"

function PromptQueueGlyph() {
  return (
    <svg data-slot="icon-svg" width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M9.99991 1.74121L16.0921 7.83343L15.2083 8.71731L10.6249 4.13397V14.4001H9.37492V4.13398L4.7916 8.71731L3.90771 7.83343L9.99991 1.74121Z"
        fill="currentColor"
      />
      <path d="M4 17.25H16" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
    </svg>
  )
}

function PromptStoppingGlyph() {
  return (
    <svg data-slot="icon-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.25" y="5.25" width="5.5" height="5.5" stroke="currentColor" stroke-width="1.25" />
    </svg>
  )
}

function PromptInputV2SendControl(props: { controller: PromptInputV2ComposerController }) {
  const language = useLanguage()
  const settings = useSettings()
  const serverSync = useServerSync()
  const mode = () => props.controller.state.mode
  const working = () => props.controller.view.submit.working?.() ?? false
  const recoveryRequired = () => !working() && props.controller.view.submit.stopping()
  const canSubmit = () => props.controller.canSubmit()
  const autoRevise = () => props.controller.revisionSend.autoBeforeSend()
  const autoSend = () => props.controller.revisionSend.autoSendAfterRevision()
  const revisionBusy = () => props.controller.revisionSend.busy()
  const revisionAvailable = () => props.controller.revisionSend.available()
  const revisionReadyForSend = () => props.controller.revisionSend.readyForSend()
  const questionActive = () => props.controller.questionActive()
  const hasRevisableText = () => isPromptTextRevisable(props.controller.value())
  const revisorArmed = () => autoRevise() && mode() === "normal"
  const revisorOwnsPrimary = () => revisionBusy() && mode() === "normal" && !questionActive()
  const action = createMemo(() =>
    resolvePromptPrimaryAction({
      mode: mode(),
      working: working(),
      canSubmit: canSubmit(),
      hasRevisableText: hasRevisableText(),
      autoReviseBeforeSending: autoRevise(),
      revisionBusy: revisionBusy(),
      revisionReadyForSend: revisionReadyForSend(),
      recoveryRequired: recoveryRequired(),
      questionActive: questionActive(),
    }),
  )
  const oneShot = createMemo(() => promptOneShotRevisionAction(autoRevise()))
  const menuAvailable = () => working() || mode() === "normal"
  const revisionUnavailable = () => action() === "revise" && !revisionAvailable()
  const primaryDisabled = () =>
    action() === "blocked" || (action() === "stop" && !recoveryRequired()) || (!recoveryRequired() && !canSubmit()) || revisionUnavailable()
  const unavailable = () => mode() === "normal" && !canSubmit() && !props.controller.model.selection.current()
  const primaryLabel = () => {
    if (action() === "stop") return language.t("prompt.action.stop")
    if (questionActive()) return language.t("prompt.action.send")
    if (revisionUnavailable()) return language.t("prompt.revision.send.unavailableAction")
    if (revisorOwnsPrimary()) {
      const state = props.controller.revisionSend.progress()
      if (state) {
        const detail = state.note?.trim() || state.phase?.trim()
        return detail
          ? language.t("prompt.revision.send.revisingProgressDetail", { percent: state.percent, detail })
          : language.t("prompt.revision.send.revisingProgress", { percent: state.percent })
      }
      return language.t("prompt.revision.send.revising")
    }
    if (action() === "revise")
      return autoSend()
        ? language.t("prompt.revision.send.reviseAndSend")
        : language.t("prompt.revision.send.reviseBeforeSend")
    if (revisionReadyForSend())
      return working()
        ? language.t("prompt.revision.send.stagedNext")
        : language.t("prompt.revision.send.staged")
    if (working() && canSubmit()) return language.t("prompt.turnLane.sendNext")
    if (unavailable()) return language.t("prompt.turnLane.unavailable")
    return language.t("prompt.action.send")
  }
  const optionsLabel = () => {
    if (!revisorArmed()) return language.t("prompt.revision.send.options")
    return autoSend()
      ? language.t("prompt.revision.send.options.autoSend")
      : language.t("prompt.revision.send.options.autoRevise")
  }
  const sendOneShot = () => {
    if (questionActive() || recoveryRequired()) return
    if (oneShot() === "send-without-revisor") {
      props.controller.revisionSend.sendWithoutRevision()
      return
    }
    props.controller.revisionSend.sendWithRevision()
  }

  const telemetry = () => {
    const id = props.controller.sessionID()
    return id ? serverSync().telemetry.get(id) : undefined
  }
  const telemetryReceivedAt = () => {
    const id = props.controller.sessionID()
    return id ? serverSync().telemetry.receivedAt(id) : undefined
  }
  createEffect(() => {
    const id = props.controller.sessionID()
    if (!id || !working()) return
    serverSync().telemetry.ensure([id])
  })

  const [presentation, setPresentation] = createSignal<{
    sourceStartedAt?: number
    startedAt?: number
    completedAt?: number
  }>()
  const [stopping, setStopping] = createSignal(false)
  const [launchAt, setLaunchAt] = createSignal<number>()
  const now = useLiveTelemetryNow(() => working() || presentation()?.completedAt !== undefined)

  createEffect(() => {
    const currentTelemetry = telemetry()
    const sourceStartedAt = currentTelemetry?.turnStartedAt
    if (sourceStartedAt === undefined) {
      // Core clears turnStartedAt at a semantic turn boundary even when the
      // session stays working because another queued turn is about to start.
      // Drop the previous presentation latch so its clock cannot leak forward.
      if (working()) {
        setPresentation((current) => {
          if (
            current?.sourceStartedAt === undefined &&
            current?.startedAt === undefined &&
            current?.completedAt === undefined
          )
            return current
          return {}
        })
      }
      return
    }
    const observedAt = sessionTelemetryClientNow()
    setPresentation((current) => {
      const startedAt = promptTurnLocalStartedAt({
        turnStartedAt: sourceStartedAt,
        sampledAt: currentTelemetry?.sampledAt,
        updatedAt: currentTelemetry?.updatedAt,
        receivedAt: telemetryReceivedAt(),
        observedAt,
        previousTurnStartedAt: current?.sourceStartedAt,
        previousLocalStartedAt: current?.startedAt,
      })
      if (
        current?.sourceStartedAt === sourceStartedAt &&
        current?.startedAt === startedAt &&
        (working() || current?.completedAt === undefined)
      )
        return current
      return {
        sourceStartedAt,
        startedAt,
        ...(working() ? {} : current?.completedAt === undefined ? {} : { completedAt: current.completedAt }),
      }
    })
  })

  createEffect(
    on(
      () => [props.controller.sessionID(), working()] as const,
      ([sessionID, next], previous) => {
        const [previousSessionID, previousWorking] = previous ?? [undefined, undefined]
        if (sessionID !== previousSessionID) {
          // This control survives route/session switches. Never interpret a
          // different Session's busy/idle value as a lifecycle edge for the
          // current one or carry its stop/settled presentation across tabs.
          setStopping(false)
          if (!next) {
            setLaunchAt(undefined)
            setPresentation(undefined)
            return
          }
          const observedAt = sessionTelemetryClientNow()
          const currentTelemetry = telemetry()
          setLaunchAt(observedAt)
          setPresentation({
            sourceStartedAt: currentTelemetry?.turnStartedAt,
            startedAt: promptTurnLocalStartedAt({
              turnStartedAt: currentTelemetry?.turnStartedAt,
              sampledAt: currentTelemetry?.sampledAt,
              updatedAt: currentTelemetry?.updatedAt,
              receivedAt: telemetryReceivedAt(),
              observedAt,
            }),
          })
          return
        }
        if (next) {
          setStopping(false)
          const observedAt = sessionTelemetryClientNow()
          // A same-Session idle -> busy edge can arrive before the new turn's
          // telemetry frame. Never seed it from the previous settled turn.
          setPresentation({})
          if (previousWorking === false) setLaunchAt(observedAt)
          return
        }
        if (!previousWorking) return
        setStopping(false)
        const completedAt = sessionTelemetryClientNow()
        const currentTelemetry = telemetry()
        setPresentation((current) => ({
          sourceStartedAt: current?.sourceStartedAt ?? currentTelemetry?.turnStartedAt,
          startedAt:
            current?.startedAt ??
            promptTurnLocalStartedAt({
              turnStartedAt: currentTelemetry?.turnStartedAt,
              sampledAt: currentTelemetry?.sampledAt,
              updatedAt: currentTelemetry?.updatedAt,
              receivedAt: telemetryReceivedAt(),
              observedAt: completedAt,
            }),
          completedAt,
        }))
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const current = presentation()
    if (working() || current?.completedAt === undefined) return
    const startedAt = current.startedAt ?? current.completedAt
    const deadline = Math.max(current.completedAt + PROMPT_SETTLED_VISIBLE_MS, startedAt + PROMPT_MIN_VISIBLE_TURN_MS)
    if (now() < deadline) return
    setPresentation(undefined)
  })

  const baton = createMemo<PromptTurnBaton>(() => {
    if (working()) {
      if (stopping()) return "stopping"
      const current = telemetry()
      if (!current || current.phase === "requesting" || current.phase === "retrying") return "arming"
      return "stop"
    }
    const current = presentation()
    if (current?.completedAt === undefined) return "none"
    const startedAt = current.startedAt ?? current.completedAt
    if (current.completedAt < startedAt + PROMPT_MIN_VISIBLE_TURN_MS && now() < startedAt + PROMPT_MIN_VISIBLE_TURN_MS)
      return "stop"
    return "settled"
  })
  const turnLive = () => baton() !== "none"
  const interruptible = () => working() && !stopping()
  const elapsedMs = createMemo(() => {
    const current = presentation()
    return promptTurnElapsedMs({
      working: working(),
      liveStartedAt: current?.startedAt,
      presentationStartedAt: current?.startedAt,
      completedAt: current?.completedAt,
      now: now(),
    })
  })
  const batonLabel = () => {
    if (baton() === "stopping") return language.t("prompt.turnLane.stopping")
    if (baton() === "arming") return language.t("prompt.turnLane.starting")
    if (baton() === "settled") return language.t("prompt.turnLane.done")
    return language.t("prompt.action.stop")
  }
  const sendGlyph = () => {
    if (action() === "stop") return "stop"
    if (questionActive()) return "send"
    if (revisorOwnsPrimary() || action() === "revise") return "revise"
    if (mode() === "shell") return "shell"
    if (working() && canSubmit()) return "queue"
    return "send"
  }
  const launching = () => {
    const value = launchAt()
    return value !== undefined && working() && now() - value < 260
  }
  const interrupt = () => {
    if (!interruptible()) return
    setStopping(true)
    props.controller.stop()
  }

  return (
    <div data-slot="prompt-turn-lane">
      <div
        data-slot="prompt-turn-group"
        data-live={turnLive() ? "true" : "false"}
        style={{ width: turnLive() ? "86px" : "0px" }}
        inert={turnLive() ? undefined : true}
      >
        <span data-slot="prompt-turn-clock" data-settled={baton() === "settled" ? "true" : "false"} aria-hidden="true">
          {promptTurnElapsedLabel(elapsedMs())}
        </span>
        <TooltipV2
          placement="top"
          gutter={5}
          inactive={!interruptible()}
          value={
            <span class="flex items-center gap-1.5">
              <span>{batonLabel()}</span>
              <KeybindV2 keys={["Esc"]} variant="ghost" />
            </span>
          }
        >
          <button
            type="button"
            data-slot="prompt-turn-baton"
            data-quiet={baton() === "arming" || baton() === "stopping" || baton() === "settled" ? "true" : "false"}
            aria-label={batonLabel()}
            aria-disabled={interruptible() ? undefined : "true"}
            tabIndex={turnLive() ? undefined : -1}
            onClick={(event) => {
              event.preventDefault()
              interrupt()
            }}
          >
            <svg
              data-slot="prompt-turn-arc"
              data-frozen={baton() === "stopping" || baton() === "settled" ? "true" : "false"}
              viewBox="0 0 28 28"
              fill="none"
              aria-hidden="true"
            >
              <rect data-slot="prompt-turn-track" x="0.5" y="0.5" width="27" height="27" rx="7.5" stroke-width="1" />
              <rect
                data-slot="prompt-turn-runner"
                x="0.5"
                y="0.5"
                width="27"
                height="27"
                rx="7.5"
                stroke-width="1"
                stroke-linecap="round"
                pathLength="100"
              />
            </svg>
            <Show when={baton() === "arming"}>
              <span data-slot="prompt-turn-charge" aria-hidden="true" />
            </Show>
            <span data-slot="prompt-turn-glyph-stack">
              <span data-active={baton() === "stop" || baton() === "arming" ? "true" : "false"}>
                <Icon name="stop" size="small" />
              </span>
              <span data-active={baton() === "stopping" ? "true" : "false"}>
                <PromptStoppingGlyph />
              </span>
              <span data-active={baton() === "settled" ? "true" : "false"}>
                <Icon name="check" size="small" class="opacity-60" />
              </span>
            </span>
          </button>
        </TooltipV2>
      </div>
      <MenuV2
        gutter={6}
        modal={false}
        placement="top-end"
        onOpenChange={(open) => {
          if (!open) requestAnimationFrame(() => props.controller.restoreFocus())
        }}
      >
        <div data-slot="prompt-send-group">
          <TooltipV2 placement="top" gutter={6} inactive={!menuAvailable()} value={optionsLabel()}
            contentStyle={{ "pointer-events": "none" }}>
            <MenuV2.Trigger
              as="button"
              type="button"
              data-slot="prompt-send-tab"
              data-action="prompt-send-options"
              data-armed={revisorArmed() ? "true" : "false"}
              data-pinned={revisorArmed() ? "true" : "false"}
              data-auto-send={revisorArmed() && autoSend() ? "true" : "false"}
              aria-label={optionsLabel()}
              aria-disabled={menuAvailable() ? undefined : "true"}
              disabled={!menuAvailable()}
              tabIndex={menuAvailable() ? undefined : -1}
            >
              <Icon name="chevron-down" size="small" class="!size-[7px]" />
            </MenuV2.Trigger>
          </TooltipV2>
            <TooltipV2
              placement="top"
              gutter={6}
              contentStyle={{ "pointer-events": "none" }}
              inactive={primaryDisabled() && !revisorOwnsPrimary() && !revisionUnavailable()}
              value={
              <span class="flex items-center gap-1.5">
                <span>{primaryLabel()}</span>
                <KeybindV2 keys={["Enter"]} variant="ghost" />
              </span>
            }
          >
            <button
              type="button"
              data-slot="prompt-send-primary"
              data-action="prompt-submit"
              data-busy={revisorOwnsPrimary() ? "true" : undefined}
              aria-label={primaryLabel()}
              aria-disabled={primaryDisabled() ? "true" : undefined}
              tabIndex={mode() === "normal" ? undefined : -1}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                if (primaryDisabled()) return
                if (action() === "submit") setLaunchAt(Date.now())
                props.controller.submit()
                requestAnimationFrame(() => props.controller.restoreFocus())
              }}
            >
              <span data-slot="prompt-send-launch" data-launching={launching() ? "true" : "false"}>
                <span data-slot="prompt-send-glyph-stack">
                  <span data-active={sendGlyph() === "send" ? "true" : "false"}>
                    <Icon name="arrow-up" size="small" />
                  </span>
                  <span data-active={sendGlyph() === "queue" ? "true" : "false"}>
                    <PromptQueueGlyph />
                  </span>
                  <span data-active={sendGlyph() === "shell" ? "true" : "false"}>
                    <Icon name="arrow-undo-down" size="small" />
                  </span>
                  <span data-active={sendGlyph() === "revise" ? "true" : "false"}>
                    <Icon
                      name="pencil-sparkles"
                      size="small"
                      data-slot={revisorOwnsPrimary() ? "prompt-send-revising" : undefined}
                    />
                  </span>
                  <span data-active={sendGlyph() === "stop" ? "true" : "false"}>
                    <Icon name="stop" size="small" />
                  </span>
                </span>
              </span>
              <Show when={revisionReadyForSend() && !questionActive() && !revisorOwnsPrimary()}>
                <span data-slot="prompt-send-staged" aria-hidden="true" />
              </Show>
            </button>
          </TooltipV2>
        </div>
        <MenuV2.Portal>
          <MenuV2.Content>
            <Show when={working()}>
              <MenuV2.Item shortcut="Esc" onSelect={interrupt}>
                <span class="text-v2-state-text-danger">{language.t("prompt.revision.send.stopCurrent")}</span>
              </MenuV2.Item>
              <Show when={mode() === "normal"}>
                <MenuV2.Separator />
              </Show>
            </Show>
            <Show when={mode() === "normal"}>
              <MenuV2.Item
                disabled={
                  recoveryRequired() ||
                  questionActive() ||
                  !canSubmit() ||
                  revisionBusy() ||
                  (oneShot() === "send-with-revisor" && (!hasRevisableText() || !revisionAvailable()))
                }
                onSelect={sendOneShot}
              >
                {oneShot() === "send-without-revisor"
                  ? language.t("prompt.revision.send.withoutRevisor")
                  : language.t("prompt.revision.send.withRevisor")}
              </MenuV2.Item>
              <Show when={settings.general.promptAutocorrection()}>
                <MenuV2.Item
                  disabled={recoveryRequired() || questionActive() || !canSubmit() || revisionBusy() || autoRevise()}
                  onSelect={() => props.controller.revisionSend.reviewCorrections()}
                >
                  {language.t("prompt.autocorrection.review.open")}
                </MenuV2.Item>
                <MenuV2.Item
                  disabled={recoveryRequired() || questionActive() || !canSubmit() || revisionBusy()}
                  onSelect={() => void props.controller.revisionSend.sendExact()}
                >
                  {language.t("prompt.autocorrection.sendExact")}
                </MenuV2.Item>
                <MenuV2.Separator />
              </Show>
              <MenuV2.Separator />
              <MenuV2.CheckboxItem
                checked={autoRevise()}
                onSelect={() => props.controller.revisionSend.setAutoBeforeSend(!autoRevise())}
              >
                {language.t("prompt.revision.send.autoBeforeSend")}
              </MenuV2.CheckboxItem>
              <MenuV2.CheckboxItem
                checked={autoSend()}
                disabled={!autoRevise()}
                onSelect={() => props.controller.revisionSend.setAutoSendAfterRevision(!autoSend())}
              >
                {language.t("prompt.revision.send.autoSendAfterRevision")}
              </MenuV2.CheckboxItem>
            </Show>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </div>
  )
}

function PromptInputV2LiveRate(props: { value: LiveGenerationRateState }) {
  const language = useLanguage()
  const [display, setDisplay] = createSignal(0)
  let raf: number | undefined
  let current = 0

  const target = () => {
    const { current: rate, last } = props.value
    if (typeof rate === "number") return rate
    if (last !== null) return last
    return 0
  }

  const isLive = () => typeof props.value.current === "number"
  const isWaiting = () => props.value.current === "paused"
  const hasRate = () => isLive() || props.value.last !== null
  const isMeasured = () => props.value.source === "measured"

  const tick = () => {
    const t = target()
    const diff = t - current
    if (Math.abs(diff) < 0.5) {
      current = t
      setDisplay(Math.round(t))
      return
    }
    current += diff * 0.15
    setDisplay(Math.round(current))
    raf = requestAnimationFrame(tick)
  }

  createEffect(() => {
    void target()
    if (raf !== undefined) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(tick)
  })

  onCleanup(() => {
    if (raf !== undefined) cancelAnimationFrame(raf)
  })

  return (
    <div class="flex h-[30px] items-center gap-1.5 px-1 text-[11px] leading-4 text-text-weaker tabular-nums select-none">
      <Show when={hasRate()}>
        <Show when={isLive()} fallback={<span class="size-1.5 rounded-full bg-current" />}>
          <span class="relative flex size-1.5 shrink-0">
            <span class="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
            <span class="relative inline-flex size-1.5 rounded-full bg-current" />
          </span>
        </Show>
        <span class={isWaiting() ? "opacity-60" : ""}>
          {isMeasured()
            ? language.t("prompt.liveRate.measured", { value: display().toLocaleString(language.intl()) })
            : language.t("prompt.liveRate.value", { value: display().toLocaleString(language.intl()) })}
        </span>
      </Show>
      <Show when={isWaiting() && !hasRate()}>
        <span class="size-1.5 rounded-full bg-current" />
        <span>{language.t("prompt.liveRate.waiting")}</span>
      </Show>
    </div>
  )
}

export function PromptInputV2AutoAcceptToggle(props: { active: boolean; onToggle: () => void }) {
  const language = useLanguage()
  const label = () =>
    props.active
      ? language.t("command.permissions.autoaccept.disable")
      : language.t("command.permissions.autoaccept.enable")

  return (
    <TooltipV2 placement="top" gutter={4} value={label()}>
      <IconButtonV2
        type="button"
        data-action="prompt-permissions-autoaccept"
        variant="ghost-muted"
        size="large"
        aria-pressed={props.active}
        aria-label={label()}
        classList={{ "!text-v2-state-fg-warning": props.active }}
        icon={<Icon name={props.active ? "shield-check" : "shield"} />}
        onClick={props.onToggle}
      />
    </TooltipV2>
  )
}

/**
 * The composer's limit arc.
 *
 * Was a hard-wired OpenCode-Go tripartite ring: it drew Go's 5h/week/month
 * fork spend regardless of which provider the composer was actually pointed
 * at, so a Claude or WorkBuddy session got a ring describing an account it
 * would never bill. Now the arity and the contents follow the SELECTED model's
 * provider — three sectors for a provider with three real cadences, two for a
 * credit-pack provider, one for an IP-based free tier — and every number is the
 * same projection the Limits pane renders, so the two can never disagree.
 *
 * `useLimits` is instantiated here rather than lifted into a context because
 * that is the established pattern in this app (see `use-workbuddy-usage`): it
 * owns a resource plus a side-effecting fetch loop, is guarded against trees
 * that cannot provide its SDK context, and its requests are deduped by the
 * server's own quota cache.
 */
function PromptInputV2UsageArc(props: { model: PromptInputV2ComposerController["model"]["selection"] }) {
  const dialog = useDialog()
  const language = useLanguage()
  const layout = useLayout()
  const sdk = useSDK()
  const params = useParams<{ id?: string }>()
  const forkUsage = useForkUsage()

  let limits: ReturnType<typeof useLimits> | undefined
  try {
    limits = useLimits()
  } catch {
    limits = undefined
  }

  // The hover card is the only thing that needs a live clock, so the global
  // 1s tick is subscribed to only while the pointer is on the button — the
  // composer is mounted for the whole session and must not hold a timer open
  // for a countdown nobody is reading.
  const [hovering, setHovering] = createSignal(false)
  const now = useNow(hovering)

  const selected = () => props.model.current()
  const providerID = () => selected()?.provider?.id
  const modelID = () => selected()?.id
  const modelName = () => selected()?.name

  // Deliberately does not fall back to `usage.latest.aggregate` — that spans
  // every credential the account has ever used, which pins the ring near 100%
  // regardless of the active key's real spend. See the identical note in
  // `session-usage-warning-banner.tsx`. Prefers the SELECTED model's account
  // suffix (`@zen-<id>`), falling back to the pool default for bare ids.
  const forkAccountID = () => {
    const id = modelID()
    if (!id) return forkUsage.activeCredentialID()
    const split = splitModelIDForProvider(id, providerID() ?? "")
    return split.accountID ?? forkUsage.activeCredentialID()
  }
  const forkWindows = () => forkUsage.usageWindowsFor(forkAccountID())
  const forkLabel = () => {
    const id = forkAccountID()
    for (const provider of limits?.providers() ?? []) {
      const accounts = (provider as { result?: { usage?: { zenAccounts?: { keyId?: string; label?: string }[] } } })
        .result?.usage?.zenAccounts
      const label = accounts?.find((account) => account.keyId === id)?.label
      if (label) return label
    }
    return forkUsage.activeCredentialLabel()
  }

  // Already polled by `useLimits` via the shared singleton — reading it here
  // costs nothing extra and is the only limit that can stop a `:free` model.
  const openRouterFree = () => {
    const report = limits?.openRouterFree()
    if (!report) return undefined
    return { remainingPercent: report.free.remainingPercent, resetsAt: report.free.window.resetsAt }
  }

  const arc = createMemo<ArcModel>(() =>
    buildArcModel({
      modelProviderID: providerID(),
      modelID: modelID(),
      modelName: modelName(),
      providers: limits?.providers(),
      openRouterFree: openRouterFree(),
      fork: {
        windows: forkWindows(),
        credentialLabel: forkLabel(),
        credentialCount: forkUsage.credentials.latest?.length ?? 0,
      },
    }),
  )

  const openSwitcher = () => {
    void import("./dialog-credential-switcher").then((module) => {
      void dialog.show(() => <module.DialogCredentialSwitcherV2 directory={() => sdk().directory} />)
    })
  }

  const openLimits = () => {
    // Limits render in two places — the standalone pane and the session
    // context tab — and both mount the same `LimitsPanelContent`, so honour
    // whichever the user already has open instead of stacking a second one.
    // `selectTab` toggles the tab shut when it is already showing; clicking
    // the arc is always "show me this", never "hide it", hence the guard.
    if (!layout.limits.opened() && !(layout.sessionContext.opened() && layout.sessionContext.tab() === "limits")) {
      // Session routes own the integrated Context / Limits pane. Draft/new-
      // session routes do not mount ContextPanel at all, so opening that state
      // there is a visible no-op; use the app-shell LimitsPanel instead.
      if (params.id) layout.sessionContext.selectTab("limits")
      else layout.limits.open()
    }
    const target = arc().quotaProviderID
    if (target) focusLimitsProvider(target)
  }

  const onClick = (event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
    event.currentTarget.blur()
    if (arc().switchable && (event.altKey || event.shiftKey)) {
      openSwitcher()
      return
    }
    openLimits()
  }

  const hint = () =>
    arc().switchable ? language.t("prompt.limits.hint.openAndSwitch") : language.t("prompt.limits.hint.open")

  const ariaLabel = () => {
    const model = arc()
    if (model.status !== "ready" || model.worst === null) {
      return language.t("prompt.limits.aria.unknown", { provider: model.providerName ?? "" })
    }
    return language.t("prompt.limits.aria.remaining", {
      provider: model.providerName ?? "",
      percent: Math.round(model.worst),
    })
  }

  return (
    <TooltipV2
      placement="top"
      gutter={6}
      openDelay={220}
      contentStyle={{ padding: "0", "flex-direction": "column", "align-items": "stretch" }}
      value={<LimitArcCard model={arc()} modelName={modelName()} now={now()} hint={hint()} />}
    >
      <IconButtonV2
        type="button"
        data-action="prompt-usage"
        data-limit-provider={arc().quotaProviderID ?? undefined}
        variant="ghost-muted"
        size="large"
        class="group"
        icon={<LimitArcGlyph model={arc()} />}
        aria-label={ariaLabel()}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
        onContextMenu={(event: MouseEvent) => {
          if (!arc().switchable) return
          event.preventDefault()
          openSwitcher()
        }}
        onClick={onClick}
      />
    </TooltipV2>
  )
}

export function usePromptInputV2Controller(props: PromptInputV2ControllerProps): PromptInputV2ComposerController {
  const sdk = useSDK()
  const serverSync = useServerSync()
  const sync = useSync()
  const files = useFile()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const command = useCommand()
  const permission = usePermission()
  const goals = useGoals()
  const settings = useSettings()
  const language = useLanguage()
  const platform = usePlatform()
  const prompt = props.state ?? usePrompt()
  let editor: HTMLDivElement | undefined

  const interaction = createPromptInputV2State()
  const mode = () => interaction[0].mode
  const history = props.history ?? createPersistedPromptInputHistory()
  const tabs = () => props.controls.session.tabs
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab
  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((tab) => tab !== active)] : all
    return order.reduce<string[]>((result, tab) => {
      const path = files.pathFromTab(tab)
      if (!path || result.includes(path)) return result
      return [...result, path]
    }, [])
  })
  const info = createMemo(() => (props.controls.session.id ? sync().session.get(props.controls.session.id) : undefined))
  const working = createMemo(() => sync().data.session_working(props.controls.session.id ?? ""))
  const interrupted = createMemo(() => {
    const id = props.controls.session.id
    return !!id && sync().data.session_status[id]?.type === "interrupted"
  })
  const sessionID = () => props.controls.session.id
  const liveRate = createLiveGenerationRate({ sessionID, working })
  const attachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )
  const commentCount = createMemo(() => {
    if (mode() === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    if (attachments().length > 0 || commentCount() > 0) return false
    return prompt.current().every((part) => !("content" in part) || part.content.trim().length === 0)
  })
  const stopping = createMemo(() => working() && blank())
  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: mode(),
      commentCount: commentCount(),
      example: mode() === "shell" ? "git status" : "",
      suggest: false,
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )
  const questionActive = () => props.question?.active() === true
  const [grammarComposing, setGrammarComposing] = createSignal(false)
  const harper = createPromptHarper({
    enabled: () => settings.general.promptGrammarHarper() && mode() === "normal" && !questionActive() &&
      !info()?.humanInterjection && !grammarComposing(),
    parts: () => prompt.current(),
    locale: () => language.locale(),
    ignoredWords: () => settings.general.promptGrammarIgnoredWords(),
    autoApply: () => settings.general.promptGrammarAutoApply(),
    cursor: () => prompt.cursor(),
    replace: (parts, cursor, source) => {
      prompt.set(parts, cursor)
      // Automatic edits must NEVER steal focus from whichever input is active.
      // Explicit suggestion/rejection clicks intentionally return editor focus.
      if (source !== "auto") controller.restoreFocus(cursor)
    },
  })
  const grammar = {
    enabled: () => settings.general.promptGrammarHarper() && mode() === "normal" && !questionActive() &&
      !grammarComposing(),
    onCompositionChange: setGrammarComposing,
    issues: harper.issues,
    state: harper.state,
    undo: harper.undo,
    undoAvailable: harper.undoAvailable,
    autoChanges: harper.autoChanges,
    rejectAuto: harper.reject,
    dismiss: harper.dismiss,
    apply: (id: string, replacement: string) => {
      const issue = harper.issues().find((item) => item.id === id)
      return issue ? harper.apply(issue, replacement) : false
    },
    ignore: (word: string) => {
      if (!/^[a-z]{2,40}$/i.test(word)) return
      settings.general.setPromptGrammarIgnoredWords([...settings.general.promptGrammarIgnoredWords(), word])
    },
  }
  const designPlaceholder = () => {
    if (questionActive() && mode() === "normal") return props.question!.placeholder()
    return promptDesignPlaceholder(mode(), placeholder(), (key, params) =>
      language.t(key as Parameters<typeof language.t>[0], params as never),
    )
  }

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      const comment = item.comment?.trim()
      if (!comment) return []
      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({ start: item.selection.startLine, end: item.selection.endLine } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []
      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }
  const restoreHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file",
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  // Not-yet-created ("draft") sessions get their own local flag rather than
  // binding to permission.isAutoAcceptingDirectory: that would enable
  // auto-accept for every future chat in this directory, not just the one
  // being composed. Until the user overrides it, the draft reflects the
  // configured new-session default (settings.general
  // autoAcceptPermissionsDefault), which also honors an explicit
  // directory-wide choice. On submit, createPromptSubmit materializes the
  // effective value onto the freshly created session only.
  const [draftAutoAccept, setDraftAutoAccept] = createSignal<boolean | undefined>(undefined)
  const accepting = createMemo(() => {
    const id = props.controls.session.id
    if (!id) return draftAutoAccept() ?? permission.autoAcceptForNewSession(sdk().directory)
    return permission.isAutoAccepting(id, sdk().directory)
  })
  const toggleAutoAccept = () => {
    const id = props.controls.session.id
    if (!id) {
      setDraftAutoAccept(!accepting())
      return
    }
    permission.toggleAutoAccept(id, sdk().directory)
  }
  const submission = createPromptSubmit({
    prompt,
    info,
    commentCount,
    autoAccept: accepting,
    correctBeforeSubmit: () => settings.general.promptAutocorrection() && !settings.general.promptRevision()?.autoBeforeSend,
    correctionIgnoredWords: () => [
      ...settings.general.promptAutocorrectionIgnore(),
      ...harper.rejectedWords(),
    ],
    correctionUserReplacements: () => settings.general.promptAutocorrectionCustom(),
    mode,
    working,
    editor: () => editor,
    queueScroll: () => requestAnimationFrame(() => editor?.scrollIntoView({ block: "nearest" })),
    promptLength,
    addToHistory: (value, mode) => controller.addHistory(value, mode),
    resetHistoryNavigation: () => controller.resetHistory(),
    setMode: (next) => controller.dispatch({ type: next === "shell" ? "mode.shell" : "mode.normal" }),
    setPopover: (popover) => {
      if (!popover) controller.dispatch({ type: "popover.close" })
    },
    newSessionWorktree: () => props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    shouldQueue: props.shouldQueue,
    onQueue: props.onQueue,
    onAbort: props.onAbort,
    onSubmit: props.onSubmit,
    model: props.controls.model.selection,
    goal: {
      key: goalArmKey,
      consume: goals.consumeArm,
      restore: goals.restoreArm,
      quickStart: goals.quickStart,
      refreshFocused: goals.refreshFocused,
      focused: goals.focused,
    },
  })

  let controller!: PromptInputV2ComposerController
  const [revisionSendRegistration, setRevisionSendRegistration] = createSignal<PromptRevisionSendRegistration>()
  const autoReviseBeforeSending = () => settings.general.promptRevision()?.autoBeforeSend === true
  const autoSendAfterRevision = () =>
    autoReviseBeforeSending() && settings.general.promptRevision()?.autoSendAfterRevision === true
  const setAutoReviseBeforeSending = (value: boolean) => {
    const current = settings.general.promptRevision() ?? {}
    settings.general.setPromptRevision({
      ...current,
      autoBeforeSend: value || undefined,
      // Dependency invariant: disabling auto-revise must also disable the
      // child auto-send preference immediately, not merely hide it in the UI.
      autoSendAfterRevision: value ? current.autoSendAfterRevision : undefined,
    })
  }
  const setAutoSendAfterRevision = (value: boolean) => {
    const current = settings.general.promptRevision() ?? {}
    settings.general.setPromptRevision({
      ...current,
      autoSendAfterRevision: current.autoBeforeSend === true && value ? true : undefined,
    })
  }
  const directSubmit = (options?: { skipCorrection?: boolean; selectedPatchStarts?: readonly number[] }) => {
    if (interrupted()) {
      void submission.abort()
      return Promise.resolve(false)
    }
    revisionSendRegistration()?.cancel({ notify: false })
    return submission.handleSubmit(new Event("submit"), options)
  }
  const reviewCorrections = () => {
    // Preview is strictly on demand: no correction scanner runs on keystrokes.
    // Revisor auto-send and delegated human-interjection paths own their own
    // send semantics; this optional inspection must never intercept them.
    if (!settings.general.promptAutocorrection() || settings.general.promptRevision()?.autoBeforeSend ||
      mode() !== "normal" || props.question?.active() || interrupted() || !controller.canSubmit() ||
      (sessionID() && sync().session.get(sessionID()!)?.humanInterjection === true)) return

    const configuration = () => ({
      excludedWords: settings.general.promptAutocorrectionIgnore(),
      userReplacements: settings.general.promptAutocorrectionCustom(),
      locale: language.locale(),
    })
    const preview = correctPromptParts(snapshotPrompt(prompt.current()), true, configuration())

    // Include the effective submission scope, not just visible characters.
    // An image, mention, context comment, model or personal dictionary can
    // change asynchronously while a modal is open. Never send on stale review.
    const fingerprint = () => promptCorrectionReviewFingerprint({
      prompt: prompt.current(),
      context: prompt.context.items(),
      sessionID: sessionID(),
      directory: sdk().directory,
      modelID: props.controls.model.selection.current()?.id,
      providerID: props.controls.model.selection.current()?.provider.id,
      variant: props.controls.model.selection.variant.current(),
      locale: language.locale(),
      ignored: settings.general.promptAutocorrectionIgnore(),
      custom: settings.general.promptAutocorrectionCustom(),
    })
    const original = fingerprint()
    if (original === undefined) {
      showToast({
        title: language.t("prompt.autocorrection.review.title"),
        description: language.t("prompt.autocorrection.review.changed"),
      })
      return
    }
    dialog.show(() => (
      <DialogPromptCorrectionReview
        patches={preview.patches}
        bypassed={preview.status === "bypassed"}
        onSend={(selectedPatchStarts) => {
          if (fingerprint() !== original || !controller.canSubmit() ||
            !settings.general.promptAutocorrection() || settings.general.promptRevision()?.autoBeforeSend ||
            mode() !== "normal" || interrupted() || props.question?.active() ||
            (sessionID() && sync().session.get(sessionID()!)?.humanInterjection === true)) {
            dialog.close()
            showToast({
              title: language.t("prompt.autocorrection.review.title"),
              description: language.t("prompt.autocorrection.review.changed"),
            })
            return false
          }
          void directSubmit(selectedPatchStarts === undefined
            ? { skipCorrection: true }
            : { selectedPatchStarts })
          return true
        }}
      />
    ))
  }

  const revisionUnavailable = () =>
    showToast({
      variant: "error",
      title: language.t("prompt.revision.error.title"),
      description: language.t("prompt.revision.send.unavailable"),
    })
  const runRevision = (intent: PromptRevisionFlow["intent"]) => {
    if (interrupted()) {
      void submission.abort()
      return
    }
    if (mode() !== "normal" || questionActive() || !controller.canSubmit()) return
    if (!isPromptTextRevisable(controller.value())) {
      void directSubmit()
      return
    }
    const registration = revisionSendRegistration()
    if (!registration) {
      revisionUnavailable()
      return
    }
    if (registration.busy()) return
    registration.run(intent)
  }
  const sendWithRevision = () => runRevision("send")
  const revisionSend = {
    autoBeforeSend: autoReviseBeforeSending,
    setAutoBeforeSend: setAutoReviseBeforeSending,
    autoSendAfterRevision,
    setAutoSendAfterRevision,
    available: () => revisionSendRegistration() !== undefined,
    busy: () => revisionSendRegistration()?.busy() ?? false,
    readyForSend: () => revisionSendRegistration()?.readyForSend() ?? false,
    progress: () => revisionSendRegistration()?.progress(),
    register(registration: PromptRevisionSendRegistration) {
      setRevisionSendRegistration(() => registration)
      return () => {
        if (revisionSendRegistration() === registration) setRevisionSendRegistration(undefined)
      }
    },
    sendWithRevision,
    sendWithoutRevision: directSubmit,
    sendExact: () => directSubmit({ skipCorrection: true }),
    reviewCorrections,
  }
  const submitFromPrimary = () => {
    // A pending question owns the composer: Enter (and the send button) answer
    // it rather than starting a new turn. Revision/queue/goal paths are
    // deliberately skipped — none of them apply to an answer.
    if (questionActive() && mode() === "normal" && !interrupted()) {
      if (!props.question!.canSubmit()) return
      props.question!.submit()
      return
    }
    const action = resolvePromptPrimaryAction({
      mode: mode(),
      working: working(),
      canSubmit: controller.canSubmit(),
      hasRevisableText: isPromptTextRevisable(controller.value()),
      autoReviseBeforeSending: autoReviseBeforeSending(),
      revisionBusy: revisionSend.busy(),
      revisionReadyForSend: revisionSend.readyForSend(),
      recoveryRequired: interrupted(),
      questionActive: questionActive(),
    })
    if (action === "blocked") return
    if (action === "stop") {
      void submission.abort()
      return
    }
    if (action === "revise") {
      const intent = resolveAutomaticRevisionIntent({
        autoReviseBeforeSending: autoReviseBeforeSending(),
        autoSendAfterRevision: autoSendAfterRevision(),
      })
      if (intent) runRevision(intent)
      return
    }
    directSubmit()
  }

  const referenceDescription = (reference: ReferenceInfo) =>
    reference.source.type === "git" ? reference.source.repository : reference.source.path
  const references = createMemo(() =>
    sync()
      .data.reference.filter((reference) => !reference.hidden)
      .flatMap((reference) => {
        const path = promptRevisionUsablePath((reference as { path?: unknown }).path)
        if (!path) return []
        return [
          {
            id: `reference:${reference.name}`,
            kind: "reference" as const,
            label: `@${reference.name}`,
            path,
            description: reference.description ?? referenceDescription(reference),
            mention: {
              type: "file" as const,
              path,
              content: `@${reference.name}`,
              start: 0,
              end: 0,
              mime: "application/x-directory",
              filename: reference.name,
            },
          },
        ]
      }),
  )
  const resources = createMemo(() =>
    Object.values(sync().data.mcp_resource).map((resource) => ({
      id: `resource:${resource.server}:${resource.uri}`,
      kind: "resource" as const,
      label: `@${resource.name}`,
      path: resource.uri,
      description: resource.description,
      mention: {
        type: "file" as const,
        path: resource.uri,
        content: `@${resource.name}`,
        start: 0,
        end: 0,
        mime: resource.mimeType ?? "text/plain",
        filename: resource.name,
        url: resource.uri,
        source: {
          type: "resource" as const,
          text: { value: `@${resource.name}`, start: 0, end: resource.name.length + 1 },
          clientName: resource.server,
          uri: resource.uri,
        },
      },
      resource,
    })),
  )
  const sdkClient = useSDK()
  const [skillItems, setSkillItems] = createSignal<any[]>([])
  let skillListLoaded = false
  let skillListLoading: Promise<void> | undefined
  const skillListAbort = new AbortController()
  onCleanup(() => skillListAbort.abort())
  const refreshSkills = () => {
    if (skillListLoaded || skillListLoading) return skillListLoading
    skillListLoading = (async () => {
      try {
        const result: any = await sdkClient().client.v2.skill.list({}, { signal: skillListAbort.signal })
        const list = Array.isArray(result) ? result
          : Array.isArray(result?.data) ? result.data
            : Array.isArray(result?.data?.data) ? result.data.data
              : Array.isArray(result?.data?.data?.data) ? result.data.data.data
                : []
        setSkillItems(list)
        skillListLoaded = true
      } catch {
        // Context autocomplete can still offer other suggestions. A skill
        // lookup failure must not block route rendering.
      } finally {
        skillListLoading = undefined
      }
    })()
    return skillListLoading
  }
  const skills = createMemo<PromptInputV2Suggestion[]>(() => {
    return skillItems().map((skill: any) => ({
      id: `skill:${skill.name}`,
      kind: "skill" as const,
      label: `@${skill.name}`,
      title: skill.name,
      description: skill.description ?? "",
      mention: { type: "skill" as const, name: skill.name, content: `@${skill.name}`, start: 0, end: 0 },
    }))
  })
  const toolCatalogTarget = createMemo(() => {
    const model = props.controls.model.selection.current()
    if (!model) return undefined
    const request = {
      provider: model.provider.id,
      model: model.id,
      agent: props.controls.agents.current || undefined,
      sessionID: props.controls.session.id || undefined,
    }
    return {
      request,
      // A resolved catalog from another session/model must never bleed into a
      // newly selected target while its own request is pending, particularly
      // because the endpoint is permission-aware.
      key: [request.provider, request.model, request.agent ?? "", request.sessionID ?? ""].join("\u0000"),
    }
  })
  // Do not model this autocomplete cache as a Solid resource. Resource reads
  // participate in Suspense, and this controller lives beneath the session
  // route's Suspense boundary. A slow/refetched tool catalog must never be
  // capable of blanking the route just because the user opened `@`.
  const [toolCatalog, setToolCatalog] = createSignal<{ key: string; items: any[] }>()
  let toolCatalogGeneration = 0
  let toolCatalogLoadingKey: string | undefined
  const refreshToolCatalog = async (target = toolCatalogTarget()) => {
    if (!target) return
    if (toolCatalogLoadingKey === target.key) return
    const generation = ++toolCatalogGeneration
    toolCatalogLoadingKey = target.key
    try {
      const result: any = await sdkClient().client.tool.catalog(target.request)
      const items = Array.isArray(result)
        ? result
        : Array.isArray(result?.data)
          ? result.data
          : Array.isArray(result?.data?.data)
            ? result.data.data
            : Array.isArray(result?.data?.data?.data)
              ? result.data.data.data
              : []
      if (generation !== toolCatalogGeneration || toolCatalogTarget()?.key !== target.key) return
      setToolCatalog({ key: target.key, items })
    } catch {
      if (generation !== toolCatalogGeneration || toolCatalogTarget()?.key !== target.key) return
      // Preserve a last-known-good catalog across transient refresh failures.
      // On a first-load failure, settle to an empty list instead.
      if (toolCatalog()?.key !== target.key) setToolCatalog({ key: target.key, items: [] })
    } finally {
      if (generation === toolCatalogGeneration) toolCatalogLoadingKey = undefined
    }
  }
  createEffect(
    on(toolCatalogTarget, (target) => {
      if (!target) {
        toolCatalogGeneration++
        toolCatalogLoadingKey = undefined
        setToolCatalog(undefined)
        return
      }
      // Drop data from another model/session immediately. The catalog is
      // permission-aware, so stale cross-target suggestions are not acceptable.
      if (toolCatalog()?.key !== target.key) setToolCatalog(undefined)
    }),
  )
  const tools = createMemo<PromptInputV2Suggestion[]>(() => {
    const target = toolCatalogTarget()
    const latest = toolCatalog()
    const list: any[] = target && latest?.key === target.key ? latest.items : []
    return list.map((item: any) => {
      const description = typeof item.description === "string" ? item.description : ""
      const lazy = item.exposure === "lazy"
      return {
        id: `tool:${item.id}`,
        kind: "tool" as const,
        label: `@${item.id}`,
        title: item.id,
        description: lazy ? (description ? `Lazy-loaded · ${description}` : "Lazy-loaded tool") : description,
        mention: {
          type: "tool" as const,
          name: item.id,
          content: `@${item.id}`,
          start: 0,
          end: 0,
          exposure: lazy ? ("lazy" as const) : ("default" as const),
          ...(item.source === "mcp" || item.source === "mcp-resource" || item.source === "registry"
            ? { source: item.source }
            : {}),
        },
      }
    })
  })
  const context = createMemo<PromptInputV2Suggestion[]>(() => [
    ...references(),
    ...skills(),
    ...props.controls.agents.available
      .filter(isSubagentMentionableAgent)
      .map((agent) => ({
        id: `agent:${agent.name}`,
        kind: "agent" as const,
        label: `@${agent.name}`,
        mention: { type: "agent" as const, name: agent.name, content: `@${agent.name}`, start: 0, end: 0 },
      })),
    ...tools(),
    ...resources(),
    ...recent().map((path) => ({
      id: `file:${path}`,
      kind: "file" as const,
      label: path,
      path,
      recent: true,
      mention: { type: "file" as const, path, content: `@${path}`, start: 0, end: 0 },
    })),
  ])
  const slashCommands = createMemo(() => [
    ...sync().data.command.map((item) => ({
      id: `custom.${item.name}`,
      trigger: item.name,
      title: item.name,
      description: item.description,
      type: "custom" as const,
    })),
    ...command.options
      .filter((item) => !item.disabled && !item.id.startsWith("suggested.") && item.slash)
      .map((item) => ({
        id: item.id,
        trigger: item.slash!,
        title: item.title,
        description: item.description,
        type: "builtin" as const,
      })),
  ])
  const commands = createMemo<PromptInputV2Suggestion[]>(() =>
    slashCommands().map((item) => ({
      id: item.id,
      kind: "command",
      label: `/${item.trigger}`,
      trigger: item.trigger,
      title: item.title,
      description: item.description,
      keybind: command.keybindParts(item.id),
    })),
  )
  const variants = createMemo(() => ["default", ...props.controls.model.selection.variant.list()])
  controller = createPromptInputV2Controller({
    store: () => prompt.capture().store,
    state: interaction,
    identity: () => prompt.capture(),
    history: {
      entries: (mode) =>
        history.entries(mode).map((value) => {
          const entry = normalizePromptHistoryEntry(value)
          return { prompt: entry.prompt, metadata: entry.comments }
        }),
      add: (value, mode) => history.add(value, mode, mode === "shell" ? [] : historyComments()),
      capture: historyComments,
      restore: (metadata) => restoreHistoryComments(metadata as PromptHistoryComment[]),
    },
    commands,
    context,
    onContextOpen() {
      // Tool catalogs initialize the execution instance. Fetch only after the
      // user opens context autocomplete, never while a session route mounts.
      // Reopening refreshes the permission-aware catalog after MCP/tool changes.
      sync().mcp.ensure()
      void refreshToolCatalog()
      // Skill suggestions are likewise loaded on explicit autocomplete
      // demand, never while a session route mounts.
      void refreshSkills()
    },
    searchContextFiles: async (query, options) =>
      (await files.searchMentions(query, { ...options, symbols: false })).results.flatMap((entry) => {
        if (entry.kind !== "file") return []
        const isDir = entry.type === "directory"
        // normalizeMentionPage projects positions onto the basename; this label
        // is the FULL path, so shift them back into label space.
        const dirOffset = entry.baseOffset !== undefined && entry.baseOffset > 0 ? entry.baseOffset : 0
        return [
          {
            id: `file:${entry.path}`,
            kind: "file" as const,
            label: entry.path,
            path: entry.path,
            isDir,
            positions: entry.positions?.map((p) => p + dirOffset),
            // File-only metrics are intentionally absent for directories. This
            // is both semantically correct and protects the UI from stale zero
            // sentinels emitted by older/cold indexes.
            size: isDir ? undefined : entry.size,
            mtime: isDir ? undefined : entry.mtime,
            lineCount: isDir ? undefined : entry.lineCount,
            mention: {
              type: "file",
              path: entry.path,
              content: `@${entry.path}`,
              start: 0,
              end: 0,
              ...(isDir ? { mime: "application/x-directory", filename: getFilename(entry.path) } : {}),
            },
          },
        ]
      }),
    onContextRemove(item) {
      if (item?.commentID) comments.remove(item.path, item.commentID)
    },
    openAttachment: (attachment) =>
      dialog.show(() => <ImagePreview src={attachment.blob.url} alt={attachment.filename} />),
    openContext(key) {
      const item = controller.contextItem(key)
      if (item) openComment(item, props, sync, layout, files, comments)
    },
    onEditor(element) {
      editor = element as HTMLDivElement
      props.ref?.(editor)
    },
    onCommandOpen() {
      const directory = sdk().directory
      const sessionID = props.controls.session.id
      void serverSync()
        .commands.ensure(directory, {
          isCurrent: () => sdk().directory === directory && (!sessionID || props.controls.session.id === sessionID),
        })
        .catch((err: unknown) => {
          showToast({
            variant: "error",
            title: language.t("toast.project.reloadFailed.title", { project: getFilename(directory) }),
            description: formatServerError(err, language.t),
          })
        })
    },
    onSuggestionSelect(item) {
      if (item.kind !== "command") return
      const selected = slashCommands().find((entry) => entry.id === item.id)
      if (!selected || selected.type === "custom") return
      return () => command.trigger(selected.id, "slash")
    },
    attachments: {
      picker: platform.openAttachmentPickerDialog,
      directory: () => sdk().directory,
      isDialogActive: () => !!dialog.active,
      warn: () =>
        showToast({
          title: language.t("prompt.toast.pasteUnsupported.title"),
          description: language.t("prompt.toast.pasteUnsupported.description"),
        }),
      duplicate: () => showToast({ title: language.t("prompt.toast.attachmentDuplicate.title") }),
      onError: (error) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      readClipboardImage: platform.readClipboardImage,
      getPathForFile: platform.getPathForFile,
      store: platform.draftStore?.putBlob,
    },
    view: {
      placeholder: designPlaceholder,
      get agent() {
        return props.controls.agents.visible && props.controls.agents.options.length > 0
          ? {
              options: () => props.controls.agents.options.map((name) => ({ id: name, label: name })),
              current: () => props.controls.agents.current,
              onSelect: (value: string) => props.controls.agents.select(value),
              keybind: () => command.keybindParts("agent.cycle"),
              manage: props.controls.agents.manage
                ? {
                    label: language.t("agents.manage"),
                    onSelect: props.controls.agents.manage,
                  }
                : undefined,
            }
          : undefined
      },
      variant: {
        options: () => variants().map((value) => ({ id: value, label: value })),
        current: () => props.controls.model.selection.variant.current() ?? "default",
        onSelect: (value) => props.controls.model.selection.variant.set(value === "default" ? undefined : value),
        keybind: () => command.keybindParts("model.variant.cycle"),
      },
      submit: {
        stopping: () => interrupted() || stopping(),
        working,
        onSubmit: submitFromPrimary,
        onStop: () => void submission.abort(),
      },
    },
  }) as PromptInputV2ComposerController
  Object.defineProperty(controller, "model", { get: () => props.controls.model })
  Object.defineProperty(controller, "autoAccept", {
    get: () => ({ active: accepting, toggle: toggleAutoAccept }),
  })
  Object.defineProperty(controller, "liveRate", { get: () => liveRate })
  Object.defineProperty(controller, "grammar", { get: () => grammar })
  Object.defineProperty(controller, "sessionID", { get: () => sessionID })
  Object.defineProperty(controller, "revisionSend", { get: () => revisionSend })
  Object.defineProperty(controller, "questionActive", { get: () => questionActive })
  Object.defineProperty(controller, "awaitDraftReady", {
    value: async () => {
      const pending = prompt.ready.promise
      if (pending) await pending.catch(() => undefined)
    },
  })
  Object.defineProperty(controller, "flushDraft", { value: () => prompt.flush() })

  // While a question owns the composer the send affordance follows the
  // question's readiness, not "is there a draft" — picking an option with no
  // typed details is already a complete answer.
  const baseCanSubmit = controller.canSubmit
  Object.defineProperty(controller, "canSubmit", {
    value: () => (questionActive() && mode() === "normal" ? props.question!.canSubmit() : baseCanSubmit()),
  })

  // A pending question temporarily owns the normal composer. Snapshot the
  // interrupted chat draft and cursor outside the question controller, then
  // restore them when question ownership ends. Question drafts remain owned by
  // the controller and can change independently while this snapshot stays put.
  createEffect(() => {
    const question = props.question
    if (!question?.active()) return

    // Keep typing and question-step state out of this effect's dependency set.
    // Only question ownership should create or destroy the saved chat draft.
    const original = untrack(() => {
      const parts = prompt.current().map((part) => ({ ...part })) as Prompt
      return { parts, cursor: prompt.cursor() ?? promptLength(parts) }
    })

    untrack(() => prompt.reset())
    const dispose = untrack(() =>
      question.bind({
        read: () => {
          const parts = prompt.current()
          return { text: questionDetailsText(parts), parts: parts.map((part) => ({ ...part })) }
        },
        write: (draft) => {
          const parts = draft.parts as Prompt | undefined
          if (parts && parts.length > 0) {
            prompt.set(
              parts.map((part) => ({ ...part })),
              promptLength(parts),
            )
            return
          }
          if (!draft.text) return
          prompt.set([{ type: "text", content: draft.text, start: 0, end: draft.text.length }], draft.text.length)
        },
        clear: () => prompt.reset(),
        focus: () => requestAnimationFrame(() => editor?.focus()),
      }),
    )

    onCleanup(() => {
      dispose()
      prompt.set(original.parts, original.cursor)
      requestAnimationFrame(() => controller.restoreFocus(original.cursor))
    })
  })

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: controller.state.mode !== "normal",
      onSelect: () => controller.attach(),
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+x",
      disabled: controller.state.mode === "shell",
      onSelect: () => controller.dispatch({ type: "mode.shell" }),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+e",
      disabled: controller.state.mode === "normal",
      onSelect: () => controller.dispatch({ type: "mode.normal" }),
    },
  ])

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return
        prompt.context.items().forEach((item) => prompt.context.remove(item.key))
        edit.context.forEach((item) =>
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          }),
        )
        controller.dispatch({ type: "mode.normal" })
        controller.resetHistory()
        prompt.set(edit.prompt, promptLength(edit.prompt))
        controller.restoreFocus()
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

  return controller as PromptInputV2ComposerController
}

function PromptInputV2ModelControl(props: {
  loading: boolean
  paid: boolean
  title: string
  keybind: string[]
  model: PromptInputV2ComposerController["model"]["selection"]
  sessionID?: string
  telemetry: () => SessionTelemetry.Info | undefined
  onSwitch: (target: ModelIdentity, attempt: { assistantMessageID: string; requestSentAt: number }) => Promise<void>
  providerID?: string
  modelName: string
  onClose: () => void
  onUnpaidClick: () => void
}) {
  const language = useLanguage()
  const settings = useSettings()
  const selectorIdentity = () => modelSwitchSelection(props.model.current(), props.model.variant.current())
  const telemetry = () => props.telemetry()
  const mismatch = () =>
    activeGenerationMismatch({ selected: selectorIdentity(), telemetry: telemetry(), sessionID: props.sessionID })
  const attempt = () => {
    const info = telemetry()
    if (!info || info.sessionID !== props.sessionID || info.isCompaction) return
    if (info.phase !== "requesting" && info.phase !== "reasoning" && info.phase !== "generating") return
    const assistantMessageID = info.step?.assistantMessageID
    const requestSentAt = info.step?.requestSentAt
    if (!assistantMessageID || requestSentAt === undefined) return
    return { assistantMessageID, requestSentAt }
  }
  let previousAttemptKey: string | undefined
  let previousSelectionKey: string | undefined
  let previousActiveKey: string | undefined
  createEffect(() => {
    const info = telemetry()
    const selected = selectorIdentity()
    const attemptKey =
      info && info.sessionID === props.sessionID && !info.isCompaction &&
      (info.phase === "requesting" || info.phase === "reasoning" || info.phase === "generating") &&
      info.step?.assistantMessageID && info.step.requestSentAt !== undefined
        ? `${info.step.assistantMessageID}:${info.step.requestSentAt}`
        : undefined
    const selectedKey = modelIdentityKey(selected)
    const activeKey = attemptKey ? modelIdentityKey(info?.model) : undefined
    const shouldFollow = shouldFollowActiveModel({
      enabled: settings.general.autoUpdateModelSelectorOnGeneratingMismatch(),
      nextAttemptKey: attemptKey,
      previousAttemptKey,
      selectedKey,
      previousSelectedKey: previousSelectionKey,
      activeKeyBefore: previousActiveKey,
      activeKey,
    })
    previousAttemptKey = attemptKey
    if (activeKey) previousActiveKey = activeKey
    if (shouldFollow && info?.model) {
      props.model.set({
        providerID: info.model.providerID,
        modelID: providerModelID(info.model.modelID, info.model.providerID, info.model.accountID),
        ...(info.model.variant ? { variant: info.model.variant } : {}),
      })
    }
    previousSelectionKey = shouldFollow && info?.model ? modelIdentityKey(info.model) : selectedKey
  })
  const selectRunningModel = () => {
    const model = mismatch()?.model
    if (!model) return
    props.model.set({
      providerID: model.providerID,
      modelID: providerModelID(model.modelID, model.providerID, model.accountID),
      ...(model.variant ? { variant: model.variant } : {}),
    })
  }
  const autoInterruptFor = (target: ModelIdentity | undefined) => {
    if (!target || !settings.general.autoInterruptOnModelSelectorChange()) return
    const currentMismatch = activeGenerationMismatch({
      selected: target,
      telemetry: telemetry(),
      sessionID: props.sessionID,
    })
    const currentAttempt = attempt()
    if (!currentMismatch || !currentAttempt) return
    void props.onSwitch(target, currentAttempt).catch((error) =>
      showToast({
        title: language.t("prompt.modelSwitch.failed"),
        description: error instanceof Error ? error.message : String(error),
        variant: "error",
      }),
    )
  }
  const modelSelection = {
    ...props.model,
    set(item: Parameters<typeof props.model.set>[0], options?: Parameters<typeof props.model.set>[1]) {
      const previous = selectorIdentity()
      props.model.set(item, options)
      const next = selectorIdentity()
      if (item && modelIdentityKey(previous) !== modelIdentityKey(next)) autoInterruptFor(next)
    },
    variant: {
      ...props.model.variant,
      set(value: Parameters<typeof props.model.variant.set>[0]) {
        const current = selectorIdentity()
        props.model.variant.set(value)
        if (!current) return
        const next = { ...current, ...(value ? { variant: value } : { variant: undefined }) }
        if (modelIdentityKey(current) !== modelIdentityKey(next)) autoInterruptFor(next)
      },
    },
  } as typeof props.model
  const shouldAnimate = createMemo<boolean>((previous) => previous ?? props.loading)
  const content = () => (
    <>
      <Show when={props.providerID}>
        {(providerID) => (
          <ProviderIcon
            id={providerID()}
            class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
            style={{ "will-change": "opacity", transform: "translateZ(0)" }}
          />
        )}
      </Show>
      <span class="truncate leading-4">{props.modelName}</span>
      <span class="-ml-0.5 -mr-1 flex shrink-0">
        <Icon name="chevron-down" />
      </span>
    </>
  )
  // Never unmount while providers/agents queries load. The trigger used to hide
  // behind !loading, which blanked the whole control whenever the
  // directory-keyed [scope, dir, "providers"/"agents"] queries were cold — i.e.
  // every switch to a tab in another workspace — and the selector then appeared
  // to "take forever" until the fetch resolved. modelName already falls back to
  // the localized placeholder, so the last-known selection stays visible through
  // refetches instead of vanishing.
  return (
    <div data-slot="prompt-model-group" data-mismatch={mismatch() ? "true" : undefined}>
    <MenuV2
      gutter={6}
      modal={false}
      placement="top"
      onOpenChange={(open) => {
        if (!open) requestAnimationFrame(() => props.onClose())
      }}
    >
      <Show when={mismatch()}>
        <TooltipV2 placement="top" gutter={6} value={language.t("prompt.modelSwitch.options")}>
          <MenuV2.Trigger
            as="button"
            type="button"
            data-slot="prompt-model-tab"
            data-action="prompt-model-mismatch-options"
            aria-label={language.t("prompt.modelSwitch.options")}
          >
            <Icon name="chevron-down" size="small" class="!size-[7px]" />
          </MenuV2.Trigger>
        </TooltipV2>
      </Show>
      <MenuV2.Portal>
        <MenuV2.Content>
          <MenuV2.Item
            disabled={!mismatch() || !attempt()}
            onSelect={() => {
              const selected = selectorIdentity()
              const currentMismatch = mismatch()
              const currentAttempt = attempt()
              if (!selected || !currentMismatch || !currentAttempt) return
              void props.onSwitch(selected, currentAttempt).catch((error) =>
                showToast({
                  title: language.t("prompt.modelSwitch.failed"),
                  description: error instanceof Error ? error.message : String(error),
                  variant: "error",
                }),
              )
            }}
          >
            <span class="flex min-w-0 flex-col gap-0.5">
              <span>{language.t("prompt.modelSwitch.resumeSelected")}</span>
              <span class="truncate text-xs opacity-65">
                {language.t("prompt.modelSwitch.selectedModel")}: {props.modelName}
              </span>
            </span>
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item onSelect={selectRunningModel}>
            <span class="flex min-w-0 flex-col gap-0.5">
              <span>{language.t("prompt.modelSwitch.useRunning")}</span>
              <span class="truncate text-xs opacity-65">
                {language.t("prompt.modelSwitch.runningModel")}: {mismatch()?.model.name ?? mismatch()?.model.modelID}
              </span>
            </span>
          </MenuV2.Item>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
    <TooltipV2
      placement="top"
      gutter={4}
      value={
        <>
          {props.title}
          <KeybindV2 keys={props.keybind} variant="neutral" />
        </>
      }
    >
      <Show
        when={props.paid}
        fallback={
          <ButtonV2
            data-action="prompt-model"
            data-control-type="dialog"
            variant="ghost-muted"
            size="normal"
            class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group"
            classList={{ "animate-in fade-in": shouldAnimate() }}
            style={{ height: "28px" }}
            onClick={props.onUnpaidClick}
          >
            {content()}
          </ButtonV2>
        }
      >
        <Suspense
          fallback={
            <ButtonV2
              variant="ghost-muted"
              size="normal"
              style={{ height: "28px" }}
              class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group"
              classList={{ "animate-in fade-in": shouldAnimate() }}
              data-action="prompt-model"
              data-control-type="popover"
            >
              {content()}
            </ButtonV2>
          }
        >
          <ModelSelectorPopoverV2
            model={modelSelection}
            trigger={(triggerProps) => (
              <ButtonV2
                {...triggerProps}
                variant="ghost-muted"
                size="normal"
                style={{ height: "28px" }}
                class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group"
                classList={{ "animate-in fade-in": shouldAnimate() }}
                data-action="prompt-model"
                data-control-type="popover"
              >
                {content()}
              </ButtonV2>
            )}
            onClose={props.onClose}
          />
        </Suspense>
      </Show>
    </TooltipV2>
    </div>
  )
}

function openComment(
  item: { path: string; commentID?: string; commentOrigin?: "review" | "file" },
  props: PromptInputV2ControllerProps,
  sync: ReturnType<typeof useSync>,
  layout: ReturnType<typeof useLayout>,
  files: ReturnType<typeof useFile>,
  comments: ReturnType<typeof useComments>,
) {
  if (!item.commentID) return
  const focus = { file: item.path, id: item.commentID }
  comments.setActive(focus)
  const queueFocus = (attempts = 6) => {
    requestAnimationFrame(() => {
      comments.setFocus({ ...focus })
      if (attempts <= 0) return
      requestAnimationFrame(() => {
        const current = comments.focus()
        if (current?.file === focus.file && current.id === focus.id) queueFocus(attempts - 1)
      })
    })
  }
  const diffs = props.controls.session.id ? sync().data.session_diff[props.controls.session.id] : undefined
  const wantsChanges =
    item.commentOrigin === "review" || (item.commentOrigin !== "file" && diffs?.some((diff) => diff.file === item.path))
  layout.fileTree.setTab(wantsChanges ? "changes" : "all")
  const tab = files.tab(item.path)
  void props.controls.session.tabs.open(tab)
  props.controls.session.tabs.setActive(tab)
  void Promise.resolve(files.load(item.path)).finally(() => queueFocus())
}
