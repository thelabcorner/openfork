/**
 * Send / Stop concept lab — composer stage. DEV-ONLY.
 *
 * Renders each concept inside the *real* `PromptInputV2` from
 * `@opencode-ai/session-ui`, through its existing `submitControl` slot, driven
 * by a mock controller. Nothing here reaches a session, an SDK client, or an
 * abort controller anyone else owns:
 *
 *   view.submit.onSubmit -> local driver.send()
 *   view.submit.onStop   -> local driver.stop()
 *
 * Using the real shell matters. A concept has to survive the actual footer row
 * (44px, `px-2`, sharing space with the add menu, agent/model/variant selects,
 * the usage arc and the auto-accept toggle) and the actual keyboard handling in
 * `interaction.ts` — Enter submits, Escape and Ctrl+G stop. Judging a control on
 * a blank page would hide exactly the constraints that decide this.
 */

import { createEffect, createMemo, on, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { createStore } from "solid-js/store"
import { SessionProgressIndicatorV2 } from "@opencode-ai/session-ui/v2/session-progress-indicator-v2"
import { PromptInputV2 } from "@opencode-ai/session-ui/v2/prompt-input"
import type { PromptInputV2PersistedState, PromptInputV2Suggestion } from "@opencode-ai/session-ui/v2/prompt-input"
import { createPromptInputV2Controller } from "@opencode-ai/session-ui/v2/prompt-input/interaction"
import { createPromptInputV2Store } from "@opencode-ai/session-ui/v2/prompt-input/store"
import type { LabConcept } from "./concept"
import type { LabDriver } from "./simulator"
import { labCanSubmit, labElapsedLabel, labInterruptible, labSendPolicyAction } from "./types"
import type { LabActions, LabComposerFacts, LabForced, LabModel, LabRevisorFacts } from "./types"
import type { LabRevisor } from "./revisor"

const AGENTS = [
  { id: "build", label: "Build" },
  { id: "plan", label: "Plan" },
  { id: "review", label: "Review" },
]

const VARIANTS = [
  { id: "default", label: "Default" },
  { id: "thinking", label: "Thinking" },
]

const MODELS = [
  { id: "claude-opus-5", name: "Claude Opus 5", providerID: "anthropic" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", providerID: "anthropic" },
  { id: "gpt-5", name: "GPT-5", providerID: "openai" },
]

const CONTEXT: PromptInputV2Suggestion[] = [
  {
    id: "file-prompt-input-v2",
    kind: "file",
    label: "prompt-input-v2.tsx",
    path: "packages/app/src/components/prompt-input-v2.tsx",
    recent: true,
    mention: {
      type: "file",
      path: "packages/app/src/components/prompt-input-v2.tsx",
      content: "@packages/app/src/components/prompt-input-v2.tsx",
      start: 0,
      end: 0,
    },
  },
  {
    id: "file-send-policy",
    kind: "file",
    label: "send-policy.ts",
    path: "packages/app/src/components/prompt-input/send-policy.ts",
    mention: {
      type: "file",
      path: "packages/app/src/components/prompt-input/send-policy.ts",
      content: "@packages/app/src/components/prompt-input/send-policy.ts",
      start: 0,
      end: 0,
    },
  },
]

const COMMANDS: PromptInputV2Suggestion[] = [
  { id: "command-review", kind: "command", label: "/review", trigger: "review", title: "Review" },
  { id: "command-test", kind: "command", label: "/test", trigger: "test", title: "Test" },
]

export type LabStageControls = {
  mode: () => "normal" | "shell"
  unavailable: () => boolean
  forced: () => LabForced
  reducedMotion: () => boolean
  attachment: () => boolean
  /** Bumping `rev` re-applies `text` to every stage's editor. */
  seed: { text: string; rev: number }
}

const emptyPrompt = (): PromptInputV2PersistedState["prompt"] => [{ type: "text", content: "", start: 0, end: 0 }]

export function LabComposerStage(props: {
  concept: LabConcept
  driver: LabDriver
  revisor: LabRevisor
  controls: LabStageControls
  /** Compact mode trims the fake timeline so five stages fit on one screen. */
  compact?: boolean
}) {
  const persisted = createStore<PromptInputV2PersistedState>({
    prompt: emptyPrompt(),
    cursor: 0,
    model: { providerID: "anthropic", modelID: "claude-opus-5", variant: null },
    context: { items: [] },
  })
  const store = createPromptInputV2Store(persisted)

  const hasAttachment = createMemo(() => persisted[0].prompt.some((part) => part.type === "image"))
  const hasText = createMemo(() =>
    persisted[0].prompt.some((part) => part.type !== "image" && "content" in part && !!part.content.trim()),
  )
  /** Raw draft text, so the real `isPromptTextRevisable` can run against it. */
  const draftText = createMemo(() =>
    persisted[0].prompt
      .filter((part) => part.type !== "image" && "content" in part)
      .map((part) => ("content" in part ? part.content : ""))
      .join(""),
  )

  // Getter-based so every field tracks individually — a concept that only reads
  // `turn.phase` must not re-run on every rate tick.
  const composer: LabComposerFacts = {
    get hasText() {
      return hasText()
    },
    get hasAttachment() {
      return hasAttachment()
    },
    get mode() {
      return props.controls.mode()
    },
    get unavailable() {
      return props.controls.unavailable()
    },
    get blocked() {
      // Production's "blocked" *is* a revision in flight. One source of truth.
      return props.revisor.busy()
    },
  }

  const revisorFacts: LabRevisorFacts = {
    get autoBeforeSend() {
      return props.revisor.autoBeforeSend()
    },
    get autoSendAfterRevision() {
      return props.revisor.autoSendAfterRevision()
    },
    get busy() {
      return props.revisor.busy()
    },
    get readyForSend() {
      return props.revisor.readyForSend()
    },
    get draft() {
      return draftText()
    },
  }

  const model: LabModel = {
    composer,
    revisor: revisorFacts,
    get turn() {
      return props.driver.turn
    },
    get forced() {
      return props.controls.forced()
    },
    get reducedMotion() {
      return props.controls.reducedMotion()
    },
  }

  const actions: LabActions = {
    send: () => {
      if (!labCanSubmit(model)) return
      // Production clears the composer on send, which is precisely why the same
      // button becomes Stop a frame later. Reproduce it, or the concepts get
      // judged against a state the real composer never sits in.
      props.revisor.consume()
      store.reset()
      props.driver.send()
    },
    stop: () => props.driver.stop(),
    revisor: {
      setAutoBeforeSend: props.revisor.setAutoBeforeSend,
      setAutoSendAfterRevision: props.revisor.setAutoSendAfterRevision,
      oneShot: () => {
        // The menu's one-shot is always the opposite of the current default.
        if (props.revisor.autoBeforeSend()) {
          actions.send()
          return
        }
        void props.revisor.run({ autoSend: true }).then((send) => {
          if (send) actions.send()
        })
      },
      revise: () => {
        void props.revisor.run().then((send) => {
          if (send) actions.send()
        })
      },
    },
  }

  /**
   * The composer's primary action, resolved the same way
   * `submitFromPrimary` does in `prompt-input-v2.tsx`. This is what Enter hits.
   */
  const primary = () => {
    // The real policy, so Enter honours auto-revise exactly as it does today.
    const action = labSendPolicyAction(model)
    if (action === "blocked") return
    if (action === "stop") {
      actions.stop()
      return
    }
    if (action === "revise") {
      actions.revisor.revise()
      return
    }
    actions.send()
  }

  const controller = createPromptInputV2Controller({
    store: persisted,
    commands: () => COMMANDS,
    context: () => CONTEXT,
    searchContextFiles: (query) => {
      const needle = query.trim().toLowerCase()
      if (!needle) return CONTEXT
      return CONTEXT.filter((item) => `${item.label} ${item.path ?? ""}`.toLowerCase().includes(needle))
    },
    view: {
      placeholder: () =>
        props.controls.mode() === "shell" ? "Enter shell command…" : "Ask anything, / for commands, @ for context…",
      add: {
        onAttach: () => {
          if (hasAttachment()) return
          store.addAttachment({
            type: "image",
            id: "lab-attachment",
            filename: "screenshot.png",
            mime: "image/png",
            blob: { id: "lab-attachment", url: "" },
          })
        },
      },
      agent: {
        options: () => AGENTS,
        current: () => "build",
        onSelect: () => {},
      },
      model: {
        options: () => MODELS.map((item) => ({ id: item.id, label: item.name, providerID: item.providerID })),
        current: () => persisted[0].model?.modelID ?? "",
        onSelect: (id) => {
          const next = MODELS.find((item) => item.id === id)
          if (!next) return
          store.setModel({ providerID: next.providerID, modelID: next.id, variant: persisted[0].model?.variant })
        },
      },
      variant: {
        options: () => VARIANTS,
        current: () => persisted[0].model?.variant ?? "default",
        onSelect: (variant) => store.setVariant(variant === "default" ? null : variant),
      },
      submit: {
        // Faithful to production: `stopping` is true only while a turn runs AND
        // the composer is empty. The default session-ui button is replaced by the
        // concept, but the flag still drives the shell's own bookkeeping.
        stopping: () => labSendPolicyAction(model) === "stop",
        working: () => labInterruptible(model),
        onSubmit: primary,
        onStop: actions.stop,
      },
    },
  })

  // Harness -> editor. Re-applied whenever the preset is (re)picked.
  createEffect(
    on(
      () => props.controls.seed.rev,
      () => store.setText(props.controls.seed.text),
    ),
  )

  createEffect(
    on(
      () => props.controls.attachment(),
      (enabled) => {
        if (enabled) {
          if (!hasAttachment()) {
            store.addAttachment({
              type: "image",
              id: "lab-attachment",
              filename: "screenshot.png",
              mime: "image/png",
              blob: { id: "lab-attachment", url: "" },
            })
          }
          return
        }
        if (hasAttachment()) store.removeAttachment("lab-attachment")
      },
    ),
  )

  createEffect(
    on(
      () => props.controls.mode(),
      (mode) => (mode === "shell" ? controller.openShell() : controller.closeShell()),
    ),
  )

  const running = () => labInterruptible(model) || props.driver.turn.phase === "stopping"

  return (
    <div class="flex flex-col gap-2">
      {/* A minimal, static stand-in for the timeline above the composer. It is
       * here so the composer's hierarchy can be judged against something —
       * specifically, whether a concept's turn signalling is redundant with the
       * indicator the timeline already shows. */}
      <Show when={!props.compact}>
        <div class="flex flex-col gap-3 px-1 pb-1 text-[13px] leading-5">
          <div class="self-end rounded-lg rounded-br-[4px] bg-v2-background-bg-layer-02 px-3 py-2 text-v2-text-text-base">
            Rework the send / stop control in the composer.
          </div>
          <div class="flex items-start gap-2 text-v2-text-text-muted">
            <Show
              when={running()}
              fallback={<span class="mt-[3px] size-4 shrink-0 rounded-[3px] bg-v2-background-bg-layer-02" />}
            >
              <SessionProgressIndicatorV2 class="mt-[3px] shrink-0" />
            </Show>
            <span>
              <Show
                when={running()}
                fallback={<>Read the composer and its primitives, then laid out five directions.</>}
              >
                Reading <span class="text-v2-text-text-accent">prompt-input-v2.tsx</span>
                <span class="text-v2-text-text-faint">
                  {" · "}
                  {labElapsedLabel(props.driver.turn.elapsedMs)}
                </span>
              </Show>
            </span>
          </div>
        </div>
      </Show>

      <div class="relative isolate">
        <PromptInputV2
          controller={controller}
          attachKeybind={["Mod", "U"]}
          attachShortcut="Mod+U"
          submitControl={<Dynamic component={props.concept.Control} model={model} actions={actions} />}
          revisionControl={
            props.concept.Leading ? (
              <Dynamic component={props.concept.Leading} model={model} actions={actions} />
            ) : undefined
          }
          footerControl={props.concept.hidesLiveRate ? undefined : <LabLiveRate driver={props.driver} model={model} />}
        />
        <Show when={props.concept.Overlay} keyed>
          {(Overlay) => <Dynamic component={Overlay} model={model} actions={actions} />}
        </Show>
      </div>
    </div>
  )
}

/**
 * Stand-in for `PromptInputV2LiveRate`. Reproduced rather than imported because
 * the real one needs the app's language context and a live session; its purpose
 * here is only to occupy the footer slot the concepts have to coexist with.
 */
function LabLiveRate(props: { driver: LabDriver; model: LabModel }) {
  const live = () => labInterruptible(props.model)
  return (
    <div class="flex h-[30px] items-center gap-1.5 px-1 text-[11px] leading-4 text-v2-text-text-faint tabular-nums select-none">
      <Show when={live() || props.driver.turn.phase === "stopping"}>
        <span class="relative flex size-1.5 shrink-0">
          <Show when={props.driver.turn.phase === "running"}>
            <span class="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
          </Show>
          <span class="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
        <span>{props.driver.turn.tokensPerSecond} tok/s</span>
      </Show>
    </div>
  )
}
