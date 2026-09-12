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
import { ScrollView, ScrollViewOverlayScrollbar } from "@opencode-ai/ui/scroll-view"
import type { ReferenceInfo } from "@opencode-ai/sdk/v2/client"
import { getFilename } from "@opencode-ai/core/util/path"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  on,
  onCleanup,
  Show,
  Suspense,
  untrack,
} from "solid-js"
import { createStore } from "solid-js/store"
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
import { createLiveGenerationRate, type LiveGenerationRateState } from "@/components/prompt-input/live-generation-rate"
import {
  isPromptTextRevisable,
  promptOneShotRevisionAction,
  resolveAutomaticRevisionIntent,
  resolvePromptPrimaryAction,
} from "@/components/prompt-input/send-policy"
import {
  promptRevisionClarifications,
  promptRevisionDraftContext,
  promptRevisionUsablePath,
  promptRevisionFingerprint,
  promptRevisionPrefix,
  promptRevisionRevealBoundaries,
  promptRevisionResponse,
  promptRevisionText,
  revisedPromptParts,
  type PromptRevisionClarification,
  type PromptRevisionResponse,
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
import { SessionUsageWarningBanner } from "@/components/session-usage-warning-banner"
import { createSessionTabs } from "@/pages/session/helpers"
import { focusLimitsProvider } from "@/pages/session/limits-panel-state"
import { useLimits } from "@/hooks/use-limits"
import { splitModelIDForProvider } from "@/utils/model-account-identity"
import { useNow } from "@/hooks/use-now"
import { buildArcModel, type ArcModel } from "@/components/prompt-input/limit-arc"
import { LimitArcCard, LimitArcGlyph } from "@/components/prompt-input/limit-arc-view"
import { showToast } from "@/utils/toast"
import { PromptInputV2, type PromptInputV2Suggestion } from "@opencode-ai/session-ui/v2/prompt-input"
import { GoalComposerLauncher, GoalComposerShelf } from "@/components/goal-composer-shelf"
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
  awaitingClarification: () => boolean
  readyForSend: () => boolean
  showPending: () => void
  cancel: () => void
}

export type PromptInputV2ComposerController = PromptInputV2Interaction & {
  readonly model: PromptInputProps["controls"]["model"]
  readonly autoAccept: { active: () => boolean; toggle: () => void }
  readonly liveRate: () => LiveGenerationRateState
  readonly revisionSend: {
    autoBeforeSend: () => boolean
    setAutoBeforeSend: (value: boolean) => void
    autoSendAfterRevision: () => boolean
    setAutoSendAfterRevision: (value: boolean) => void
    busy: () => boolean
    awaitingClarification: () => boolean
    readyForSend: () => boolean
    register: (registration: PromptRevisionSendRegistration) => () => void
    sendWithRevision: () => void
    sendWithoutRevision: () => void
  }
}

export function PromptInputV2Composer(props: PromptInputV2ComposerProps) {
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()
  const sdk = useSDK()
  const params = useParams<{ id?: string }>()
  const [search] = useSearchParams<{ draftId?: string }>()
  const sessionID = () => params.id
  const armKey = () => goalArmKey({ sessionID: sessionID(), draftID: search.draftId, directory: sdk().directory })

  return (
    <div class="flex flex-col gap-3">
      <SessionUsageWarningBanner providerID={props.controller.model.selection.current()?.provider?.id} />
      <PromptInputV2
        controller={props.controller}
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
        goalControl={
          <GoalComposerLauncher sessionID={sessionID()} armKey={armKey()} promptText={() => props.controller.value()} />
        }
        revisionControl={<PromptInputV2RevisionControl controller={props.controller} sessionID={sessionID()} />}
        submitControl={<PromptInputV2SendControl controller={props.controller} />}
        goalShelf={
          <Show when={sessionID()}>
            {(id) => <GoalComposerShelf sessionID={id()} promptText={() => props.controller.value()} />}
          </Show>
        }
        footerControl={<PromptInputV2LiveRate value={props.controller.liveRate()} />}
        modelControl={
          <PromptInputV2ModelControl
            loading={props.controller.model.loading}
            paid={props.controller.model.paid}
            title={language.t("command.model.choose")}
            keybind={command.keybindParts("model.choose")}
            model={props.controller.model.selection}
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

type PromptRevisionQuestion = {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
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
  model?: { providerID: string; id: string; variant?: string }
  fallbackModel?: { providerID: string; id: string; variant?: string }
  directory: string
  sessionID?: string
  clarifications: PromptRevisionClarification[]
  clarificationRound: number
}

function PromptRevisionQuestions(props: {
  questions: PromptRevisionQuestion[]
  busy: boolean
  onSubmit: (response: PromptRevisionResponse) => void
  onCancel: () => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({
    selected: [] as string[][],
    custom: [] as string[],
  })

  createEffect(
    on(
      () => props.questions,
      (questions) => {
        setState(
          "selected",
          questions.map(() => []),
        )
        setState(
          "custom",
          questions.map(() => ""),
        )
      },
      { defer: false },
    ),
  )

  const toggle = (index: number, label: string, multiple: boolean) => {
    if (props.busy) return
    if (!multiple) {
      setState("selected", index, [label])
      return
    }
    setState("selected", index, (current = []) =>
      current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
    )
  }

  const setCustom = (index: number, value: string) => {
    setState("custom", index, value)
  }

  const response = () => promptRevisionResponse(props.questions, state.selected, state.custom)

  const complete = () =>
    props.questions.every(
      (_, index) => (response().answers[index]?.length ?? 0) > 0 || (response().details[index]?.length ?? 0) > 0,
    )

  return (
    <div class="flex max-h-[min(440px,64vh)] flex-col overflow-hidden bg-v2-background-bg-base">
      <div class="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2.5">
        <div class="flex min-w-0 items-center gap-1.5">
          <Icon name="pencil-sparkles" size="small" class="size-3.5 shrink-0 text-v2-icon-icon-muted" />
          <span class="truncate text-[11px] font-[600] leading-4 text-v2-text-text-base">
            {language.t("prompt.revision.question.title")}
          </span>
        </div>
        <Show when={props.questions.length > 1}>
          <span class="shrink-0 text-[9px] font-[540] tabular-nums text-v2-text-text-faint">
            {props.questions.length} questions
          </span>
        </Show>
      </div>

      <ScrollView class="min-h-0 flex-1 bg-v2-background-bg-base">
        <div class="flex flex-col divide-y divide-v2-border-border-muted">
          <For each={props.questions}>
            {(question, index) => {
              const multi = () => question.multiple === true
              const selected = (label: string) => state.selected[index()]?.includes(label) ?? false
              return (
                <section class="bg-v2-background-bg-base px-2.5 py-1.5">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <div class="text-[9px] font-[620] uppercase tracking-[0.055em] text-v2-text-text-faint">
                        {question.header}
                      </div>
                      <div class="mt-0.5 text-[11px] font-[500] leading-[15px] text-v2-text-text-base">
                        {question.question}
                      </div>
                    </div>
                    <Show when={multi()}>
                      <span class="mt-px shrink-0 rounded-sm bg-v2-overlay-simple-overlay-hover px-1 py-0.5 text-[8px] font-[560] uppercase tracking-[0.04em] leading-3 text-v2-text-text-faint">
                        {language.t("prompt.revision.question.multiple")}
                      </span>
                    </Show>
                  </div>

                  <Show when={question.options.length > 0}>
                    <div class="mt-1 flex flex-col gap-0.5" role={multi() ? "group" : "radiogroup"}>
                      <For each={question.options}>
                        {(option) => (
                          <button
                            type="button"
                            disabled={props.busy}
                            role={multi() ? "checkbox" : "radio"}
                            aria-checked={selected(option.label)}
                            onClick={() => toggle(index(), option.label, multi())}
                            class="group flex min-h-7 w-full items-start gap-1.5 rounded-[4px] border px-1.5 py-1 text-left transition-colors disabled:opacity-50"
                            classList={{
                              "border-v2-border-border-strong bg-v2-overlay-simple-overlay-pressed": selected(
                                option.label,
                              ),
                              "border-v2-border-border-muted bg-transparent hover:border-v2-border-border-strong hover:bg-v2-overlay-simple-overlay-hover":
                                !selected(option.label),
                            }}
                          >
                            <span
                              class="mt-[2px] flex size-3 shrink-0 items-center justify-center border border-v2-border-border-strong"
                              classList={{ "rounded-[3px]": multi(), "rounded-full": !multi() }}
                            >
                              <Show when={selected(option.label)}>
                                <Show
                                  when={multi()}
                                  fallback={<span class="size-1.5 rounded-full bg-v2-icon-icon-base" />}
                                >
                                  <Icon name="check" size="small" class="size-2 text-v2-icon-icon-base" />
                                </Show>
                              </Show>
                            </span>
                            <span class="min-w-0 flex-1">
                              <span class="block text-[10.5px] font-[540] leading-[14px] text-v2-text-text-base">
                                {option.label}
                              </span>
                              <Show when={option.description}>
                                <span class="block text-[9px] leading-3.5 text-v2-text-text-muted">
                                  {option.description}
                                </span>
                              </Show>
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={question.custom !== false}>
                    <div class="mt-1.5 overflow-hidden rounded-[5px] border border-v2-border-border-muted bg-v2-background-bg-base focus-within:border-v2-border-border-strong">
                      <div class="flex h-5 items-center border-b border-v2-border-border-muted bg-v2-background-bg-layer-01 px-1.5">
                        <span class="text-[8px] font-[600] uppercase tracking-[0.045em] text-v2-text-text-faint">
                          {question.options.length === 0
                            ? language.t("prompt.revision.question.customOnly")
                            : multi()
                              ? language.t("prompt.revision.question.customMultiple")
                              : language.t("prompt.revision.question.custom")}
                        </span>
                      </div>
                      <textarea
                        rows={1}
                        maxlength={800}
                        disabled={props.busy}
                        value={state.custom[index()] ?? ""}
                        placeholder={language.t("prompt.revision.question.customPlaceholder")}
                        class="min-h-8 w-full resize-none border-0 bg-v2-background-bg-base px-1.5 py-1.5 text-[10.5px] leading-[14px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint disabled:opacity-50"
                        onInput={(event) => setCustom(index(), event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && complete()) {
                            event.preventDefault()
                            props.onSubmit(response())
                          }
                        }}
                      />
                    </div>
                  </Show>
                </section>
              )
            }}
          </For>
        </div>
      </ScrollView>

      <div class="flex min-h-8 shrink-0 items-center justify-between gap-2 border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1">
        <ButtonV2 type="button" size="small" variant="ghost-muted" disabled={props.busy} onClick={props.onCancel}>
          {language.t("prompt.revision.question.cancel")}
        </ButtonV2>
        <ButtonV2
          type="button"
          size="small"
          variant="contrast"
          disabled={props.busy || !complete()}
          onClick={() => props.onSubmit(response())}
        >
          {language.t("prompt.revision.question.continue")}
        </ButtonV2>
      </div>
    </div>
  )
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

function PromptInputV2RevisionControl(props: { controller: PromptInputV2ComposerController; sessionID?: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const settings = useSettings()
  const [busy, setBusy] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  const [guidance, setGuidance] = createSignal("")
  const [modelOverride, setModelOverride] = createSignal<SettingsModelRef | undefined>()
  const [restoreState, setRestoreState] = createSignal<{
    before: ReturnType<PromptInputV2ComposerController["parts"]>
    text: string
    afterFingerprint: string
  }>()
  const [questionState, setQuestionState] = createSignal<{
    flow: PromptRevisionFlow
    questions: PromptRevisionQuestion[]
    clarificationRound: number
  }>()
  let guidanceTextarea: HTMLTextAreaElement | undefined
  let guidanceEditorArea: HTMLDivElement | undefined
  let request = 0
  onCleanup(() => {
    request += 1
  })

  const changed = (flow: PromptRevisionFlow) =>
    promptRevisionFingerprint(props.controller.parts()) !== flow.beforeFingerprint ||
    sdk().directory !== flow.directory ||
    props.sessionID !== flow.sessionID

  const changedToast = () =>
    showToast({
      title: language.t("prompt.revision.error.title"),
      description: language.t("prompt.revision.changedDuringRequest"),
    })

  const restorable = createMemo(() => {
    const state = restoreState()
    if (!state) return undefined
    return promptRevisionFingerprint(props.controller.parts()) === state.afterFingerprint ? state : undefined
  })

  createEffect(() => {
    const state = restoreState()
    if (!state || busy()) return
    if (promptRevisionFingerprint(props.controller.parts()) === state.afterFingerprint) return
    setRestoreState(undefined)
  })

  const restoreOriginal = (state = restorable()) => {
    if (!state || busy()) return
    if (promptRevisionFingerprint(props.controller.parts()) !== state.afterFingerprint) {
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
  }

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  const apply = async (
    flow: PromptRevisionFlow,
    prompt: string,
    references: Parameters<typeof revisedPromptParts>[2] = [],
  ) => {
    const next = revisedPromptParts(prompt, flow.before, references)
    const appliedFingerprint = promptRevisionFingerprint(next)
    props.controller.addHistory(flow.before, "normal")
    setQuestionState(undefined)
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
      if (flow.token !== request || promptRevisionFingerprint(props.controller.parts()) !== expectedFingerprint)
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
        if (promptRevisionFingerprint(props.controller.parts()) !== expectedFingerprint) return false

        const partial = promptRevisionPrefix(next, boundary)
        const partialText = promptRevisionText(partial)
        props.controller.onInput(partialText, partial, partialText.length)
        expectedFingerprint = promptRevisionFingerprint(partial)
        previous = boundary
      }
    }

    if (flow.token !== request || promptRevisionFingerprint(props.controller.parts()) !== appliedFingerprint)
      return false
    setGuidance("")
    setModelOverride(undefined)
    props.controller.restoreFocus()
    if (flow.intent === "send") {
      // Revise-and-send is an atomic user intent. Once the revised draft has
      // finished its reveal animation, bypass the auto-revise interceptor so
      // the exact artifact we just committed is submitted once rather than
      // recursively entering another revision cycle.
      setRestoreState(undefined)
      props.controller.revisionSend.sendWithoutRevision()
      return true
    }

    const restored = {
      before: flow.restoreBefore,
      text: flow.restoreDraft,
      afterFingerprint: appliedFingerprint,
    }
    setRestoreState(restored)
    showToast({
      variant: "success",
      title: language.t("prompt.revision.success.title"),
      description: language.t("prompt.revision.success.description"),
      actions: [
        {
          label: language.t("prompt.revision.restore"),
          onClick: () => restoreOriginal(restored),
        },
      ],
    })
    return true
  }

  const send = async (flow: PromptRevisionFlow) => {
    if (flow.token !== request) return
    if (changed(flow)) {
      changedToast()
      setQuestionState(undefined)
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      const result = await sdk().api.promptRevisor.revise({
        prompt: flow.draft,
        draft: promptRevisionDraftContext(flow.before),
        sessionID: flow.sessionID,
        guidance: flow.guidance,
        model: flow.model,
        fallbackModel: flow.fallbackModel,
        clarifications: flow.clarifications,
        clarificationRound: flow.clarificationRound,
        location: { directory: flow.directory },
      })
      if (flow.token !== request) return
      if (changed(flow)) {
        changedToast()
        setQuestionState(undefined)
        setOpen(false)
        return
      }
      if (result.type === "question") {
        setQuestionState({
          flow,
          questions: result.questions,
          clarificationRound: result.clarificationRound,
        })
        setOpen(true)
        return
      }
      await apply(flow, result.prompt, result.references ?? [])
    } catch (error) {
      if (flow.token !== request) return
      showToast({
        variant: "error",
        title: language.t("prompt.revision.error.title"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (flow.token === request) setBusy(false)
    }
  }

  const run = (extra?: string, intent: PromptRevisionFlow["intent"] = "review") => {
    const draft = props.controller.value()
    if (busy() || !draft.trim()) return
    const token = ++request
    const before = props.controller.parts().map((part) => ({ ...part })) as ReturnType<
      PromptInputV2ComposerController["parts"]
    >
    const beforeFingerprint = promptRevisionFingerprint(before)
    const priorRestore = restorable()
    const configured = modelOverride() ?? settings.general.promptRevision()?.model
    const current = props.controller.model.selection.current()
    const variant = props.controller.model.selection.variant.current()
    setQuestionState(undefined)
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
      model: configured ? { providerID: configured.providerID, id: configured.modelID } : undefined,
      fallbackModel: current ? { providerID: current.provider.id, id: current.id, variant } : undefined,
      directory: sdk().directory,
      sessionID: props.sessionID,
      clarifications: [],
      clarificationRound: 0,
    })
  }

  const answerQuestions = (response: PromptRevisionResponse) => {
    const pending = questionState()
    if (!pending || busy()) return
    if (changed(pending.flow)) {
      changedToast()
      setQuestionState(undefined)
      setOpen(false)
      return
    }
    const clarifications = promptRevisionClarifications(pending.questions, response)
    const next: PromptRevisionFlow = {
      ...pending.flow,
      clarifications: [...pending.flow.clarifications, ...clarifications],
      clarificationRound: pending.clarificationRound,
    }
    void send(next)
  }

  const cancelQuestions = () => {
    request += 1
    setBusy(false)
    setQuestionState(undefined)
    setOpen(false)
    setModelOverride(undefined)
    props.controller.restoreFocus()
  }

  const unregisterRevisionSend = props.controller.revisionSend.register({
    run: (intent) => run(undefined, intent),
    busy,
    awaitingClarification: () => !!questionState(),
    readyForSend: () => !!restorable(),
    showPending: () => {
      if (questionState()) setOpen(true)
    },
    cancel: cancelQuestions,
  })
  onCleanup(unregisterRevisionSend)

  const hasDraft = () => props.controller.state.mode === "normal" && props.controller.value().trim().length > 0

  return (
    <div data-prompt-revision-split-control="" class="flex shrink-0 items-center">
      <TooltipV2 placement="top" gutter={4} value={language.t("prompt.revision.description")}>
        <IconButtonV2
          type="button"
          size="large"
          variant="ghost-muted"
          class={`shrink-0 !rounded-r-[3px] ${
            busy()
              ? "!text-v2-icon-icon-accent !opacity-100"
              : questionState()
                ? "!text-v2-icon-icon-accent bg-v2-overlay-simple-overlay-hover"
                : ""
          }`}
          disabled={busy() || !hasDraft()}
          aria-label={language.t("prompt.revision.title")}
          icon={
            <Show when={busy()} fallback={<Icon name="pencil-sparkles" size="small" />}>
              <PromptRevisionBusyIcon />
            </Show>
          }
          onClick={() => (questionState() ? setOpen(true) : run())}
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
          disabled: busy(),
          "aria-label": language.t("prompt.revision.guidance.open"),
          class: "shrink-0 !w-5 !rounded-l-[3px]",
        }}
        trigger={<Icon name="chevron-down" size="small" class="size-3" />}
        class="w-[min(370px,calc(100vw-16px))] overflow-hidden rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)] [&_[data-slot=popover-body]]:p-0"
      >
        <Show
          when={questionState()}
          fallback={
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
                    lightweightSelector
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
                      run(guidance())
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
                  onClick={() => run(guidance())}
                >
                  {language.t("prompt.revision.guidance.run")}
                </ButtonV2>
              </div>
            </div>
          }
        >
          {(pending) => (
            <PromptRevisionQuestions
              questions={pending().questions}
              busy={busy()}
              onSubmit={answerQuestions}
              onCancel={cancelQuestions}
            />
          )}
        </Show>
      </Popover>
    </div>
  )
}

function PromptInputV2SendControl(props: { controller: PromptInputV2ComposerController }) {
  const language = useLanguage()
  const mode = () => props.controller.state.mode
  const working = () => props.controller.view.submit.working?.() ?? false
  const canSubmit = () => props.controller.canSubmit()
  const autoRevise = () => props.controller.revisionSend.autoBeforeSend()
  const autoSend = () => props.controller.revisionSend.autoSendAfterRevision()
  const revisionBusy = () => props.controller.revisionSend.busy()
  const awaitingClarification = () => props.controller.revisionSend.awaitingClarification()
  const revisionReadyForSend = () => props.controller.revisionSend.readyForSend()
  const hasRevisableText = () => isPromptTextRevisable(props.controller.value())
  const action = createMemo(() =>
    resolvePromptPrimaryAction({
      mode: mode(),
      working: working(),
      canSubmit: canSubmit(),
      hasRevisableText: hasRevisableText(),
      autoReviseBeforeSending: autoRevise(),
      revisionBusy: revisionBusy(),
      awaitingClarification: awaitingClarification(),
      revisionReadyForSend: revisionReadyForSend(),
    }),
  )
  const oneShot = createMemo(() => promptOneShotRevisionAction(autoRevise() || awaitingClarification()))
  const menuAvailable = () => working() || mode() === "normal"
  const primaryDisabled = () =>
    action() === "blocked" || (!canSubmit() && action() !== "stop" && action() !== "clarify")
  const primaryLabel = () => {
    if (revisionBusy()) return language.t("prompt.revision.send.revising")
    if (action() === "clarify") return language.t("prompt.revision.send.needsInput")
    if (action() === "stop") return language.t("prompt.action.stop")
    if (action() === "revise")
      return autoSend()
        ? language.t("prompt.revision.send.reviseAndSend")
        : language.t("prompt.revision.send.reviseBeforeSend")
    return language.t("prompt.action.send")
  }
  const sendOneShot = () => {
    if (oneShot() === "send-without-revisor") {
      props.controller.revisionSend.sendWithoutRevision()
      return
    }
    props.controller.revisionSend.sendWithRevision()
  }

  return (
    <div
      data-prompt-send-split=""
      data-auto-revise={autoRevise() ? "true" : "false"}
      data-auto-send-after-revision={autoSend() ? "true" : "false"}
      data-revision-busy={revisionBusy() ? "true" : "false"}
      class="relative size-[30px] shrink-0"
    >
      {/* The disclosure is embedded into the main surface instead of extending
       * the outer silhouette. The control is a true 30x30 square. The pocket is
       * intentionally a little larger than the source-SVG scale for legibility;
       * its top-left and bottom-right stay square while only its smaller
       * top-right and larger bottom-left arcs round. */}
      <svg
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 z-0 overflow-visible"
        viewBox="0 0 30 30"
        fill="none"
        style={{
          filter: "drop-shadow(0 1px 2px color-mix(in srgb, var(--v2-background-bg-deep) 38%, transparent))",
        }}
      >
        <rect
          x="0.5"
          y="0.5"
          width="29"
          height="29"
          rx="8"
          ry="8"
          fill="var(--v2-background-bg-layer-02)"
        />
        <path
          d="M0.5 18.5H8C9.933 18.5 11.5 20.067 11.5 22V29.5H8.5C4.082 29.5 0.5 25.918 0.5 21.5V18.5Z"
          fill="color-mix(in srgb, var(--v2-background-bg-layer-02) 68%, var(--v2-background-bg-deep) 32%)"
        />
        <rect
          x="0.5"
          y="0.5"
          width="29"
          height="29"
          rx="8"
          ry="8"
          fill="none"
          stroke="var(--v2-border-border-muted)"
          stroke-width="1"
        />
      </svg>

      <TooltipV2 placement="top" gutter={4} value={primaryLabel()}>
        <IconButtonV2
          data-action="prompt-submit"
          type="button"
          size="large"
          variant="ghost"
          disabled={primaryDisabled()}
          tabIndex={mode() === "normal" ? undefined : -1}
          aria-label={primaryLabel()}
          class={`absolute inset-0 z-[2] shrink-0 !size-[30px] !rounded-[8px] !bg-transparent !text-v2-icon-icon-base !shadow-none hover:!bg-transparent active:!bg-transparent ${
            action() === "stop" ? "!text-v2-state-fg-danger" : ""
          }`}
          icon={
            <Show
              when={revisionBusy()}
              fallback={
                <Show
                  when={action() === "stop"}
                  fallback={
                    <Show
                      when={action() === "clarify"}
                      fallback={
                        <Show when={mode() === "shell"} fallback={<Icon name="arrow-up" size="small" />}>
                          <Icon name="arrow-undo-down" size="small" />
                        </Show>
                      }
                    >
                      <Icon name="pencil-sparkles" size="small" class="text-v2-icon-icon-accent" />
                    </Show>
                  }
                >
                  <Icon name="stop" size="small" />
                </Show>
              }
            >
              <PromptRevisionBusyIcon />
            </Show>
          }
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.controller.submit()
            requestAnimationFrame(() => props.controller.restoreFocus())
          }}
        />
      </TooltipV2>

      <MenuV2
        gutter={6}
        modal={false}
        placement="top-start"
        onOpenChange={(open) => {
          if (!open) requestAnimationFrame(() => props.controller.restoreFocus())
        }}
      >
        <MenuV2.Trigger
          as={IconButtonV2}
          type="button"
          size="small"
          variant="ghost-muted"
          disabled={!menuAvailable()}
          data-action="prompt-send-options"
          aria-label={language.t("prompt.revision.send.options")}
          class={`absolute bottom-0 left-0 z-[3] !size-[11px] !rounded-none !rounded-bl-[8px] !rounded-tr-[3.5px] !bg-transparent !shadow-none hover:!bg-v2-overlay-simple-overlay-hover hover:!text-v2-icon-icon-base ${
            autoRevise() && mode() === "normal" ? "!text-v2-icon-icon-accent" : "!text-v2-icon-icon-faint"
          }`}
          icon={<Icon name="chevron-down" size="small" class="size-[7px]" />}
        />
        <MenuV2.Portal>
          <MenuV2.Content>
            <Show when={working()}>
              <MenuV2.Item shortcut="Esc" onSelect={() => props.controller.stop()}>
                <span class="text-v2-state-text-danger">{language.t("prompt.revision.send.stopCurrent")}</span>
              </MenuV2.Item>
              <Show when={mode() === "normal"}>
                <MenuV2.Separator />
              </Show>
            </Show>
            <Show when={mode() === "normal"}>
              <MenuV2.Item
                disabled={!canSubmit() || revisionBusy() || (oneShot() === "send-with-revisor" && !hasRevisableText())}
                onSelect={sendOneShot}
              >
                {oneShot() === "send-without-revisor"
                  ? language.t("prompt.revision.send.withoutRevisor")
                  : language.t("prompt.revision.send.withRevisor")}
              </MenuV2.Item>
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
      layout.sessionContext.selectTab("limits")
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
  const liveRate = createLiveGenerationRate({ sessionID: () => props.controls.session.id, working })
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
  // being composed. On submit, createPromptSubmit promotes this onto the
  // freshly created session only (see submit.ts's shouldAutoAccept).
  const [draftAutoAccept, setDraftAutoAccept] = createSignal(false)
  const accepting = createMemo(() => {
    const id = props.controls.session.id
    if (!id) return draftAutoAccept()
    return permission.isAutoAccepting(id, sdk().directory)
  })
  const toggleAutoAccept = () => {
    const id = props.controls.session.id
    if (!id) {
      setDraftAutoAccept((value) => !value)
      return
    }
    permission.toggleAutoAccept(id, sdk().directory)
  }
  const submission = createPromptSubmit({
    prompt,
    info,
    imageAttachments: attachments,
    commentCount,
    autoAccept: accepting,
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
  let revisionSendRegistration: PromptRevisionSendRegistration | undefined
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
  const directSubmit = () => {
    revisionSendRegistration?.cancel()
    void submission.handleSubmit(new Event("submit"))
  }
  const revisionUnavailable = () =>
    showToast({
      variant: "error",
      title: language.t("prompt.revision.error.title"),
      description: language.t("prompt.revision.send.unavailable"),
    })
  const runRevision = (intent: PromptRevisionFlow["intent"]) => {
    if (mode() !== "normal" || !controller.canSubmit()) return
    if (!isPromptTextRevisable(controller.value())) {
      directSubmit()
      return
    }
    const registration = revisionSendRegistration
    if (!registration) {
      revisionUnavailable()
      return
    }
    if (registration.busy()) return
    if (registration.awaitingClarification()) {
      registration.showPending()
      return
    }
    registration.run(intent)
  }
  const sendWithRevision = () => runRevision("send")
  const revisionSend = {
    autoBeforeSend: autoReviseBeforeSending,
    setAutoBeforeSend: setAutoReviseBeforeSending,
    autoSendAfterRevision,
    setAutoSendAfterRevision,
    busy: () => revisionSendRegistration?.busy() ?? false,
    awaitingClarification: () => revisionSendRegistration?.awaitingClarification() ?? false,
    readyForSend: () => revisionSendRegistration?.readyForSend() ?? false,
    register(registration: PromptRevisionSendRegistration) {
      revisionSendRegistration = registration
      return () => {
        if (revisionSendRegistration === registration) revisionSendRegistration = undefined
      }
    },
    sendWithRevision,
    sendWithoutRevision: directSubmit,
  }
  const submitFromPrimary = () => {
    // A pending question owns the composer: Enter (and the send button) answer
    // it rather than starting a new turn. Revision/queue/goal paths are
    // deliberately skipped — none of them apply to an answer.
    if (questionActive() && mode() === "normal") {
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
      awaitingClarification: revisionSend.awaitingClarification(),
      revisionReadyForSend: revisionSend.readyForSend(),
    })
    if (action === "blocked") return
    if (action === "stop") {
      void submission.abort()
      return
    }
    if (action === "clarify") {
      sendWithRevision()
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
  const [skillsResource] = createResource(async () => {
    try {
      const result: any = await sdkClient().client.v2.skill.list({})
      if (Array.isArray(result)) return result
      if (Array.isArray(result?.data)) {
        // Unified SDK wrapper vs Location.response shape: data may be the array or { location, data: [...] }
        const inner = result.data
        if (Array.isArray(inner)) return inner
      }
      if (Array.isArray(result?.data?.data)) return result.data.data
      if (Array.isArray(result?.data?.data?.data)) return result.data.data.data
      return []
    } catch {
      return []
    }
  })
  const skills = createMemo<PromptInputV2Suggestion[]>(() => {
    // Context suggestions are rendered beneath the session route Suspense
    // boundary. Never call a pending resource accessor from this path: doing
    // so parks the whole route and presents as a full-tab black flash when the
    // user types `@`. `latest` is explicitly non-suspending and is sufficient
    // for autocomplete, where an empty list while the first fetch resolves is
    // preferable to blanking the session UI.
    const raw = skillsResource.latest as unknown
    const list: any[] = Array.isArray(raw) ? raw : []
    return list.map((skill: any) => ({
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
      void refreshToolCatalog(target)
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
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
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
      // Initial loading is started by the target effect. This is a no-op while
      // that request is in flight; later opens refresh so MCP/tool reloads show
      // up without turning autocomplete into a route-level loading state.
      void refreshToolCatalog()
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
        stopping,
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
  Object.defineProperty(controller, "revisionSend", { get: () => revisionSend })

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
  providerID?: string
  modelName: string
  onClose: () => void
  onUnpaidClick: () => void
}) {
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
            model={props.model}
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
