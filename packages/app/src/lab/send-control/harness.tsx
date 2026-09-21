/**
 * Send / Stop concept lab — harness. DEV-ONLY.
 *
 * Two views:
 *
 *   Compare — every concept stacked at the same width, driven by one shared
 *   mock turn driver and one shared mock revisor, so a state change lands on
 *   all of them simultaneously.
 *
 *   Single — one concept with a fake timeline above it, its design notes, and a
 *   static state matrix that renders the control in every canonical state at once
 *   (including forced hover / focus / pressed) so a reviewer can read them
 *   without having to drive the lifecycle into each one.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import type { LabConcept, LabConceptId } from "./concept"
import { LAB_CONCEPT_LETTER, LAB_CONCEPTS, labConcept } from "./concepts"
import { createLabDriver, LAB_LATENCIES, LAB_TURN_LENGTHS } from "./simulator"
import { createLabRevisor } from "./revisor"
import { LabComposerStage, type LabStageControls } from "./stage"
import { LAB_TURN_PHASES, type LabForced, type LabModel, type LabTurnPhase } from "./types"
import "./lab.css"

const DRAFTS = [
  { id: "empty", label: "No draft", text: "" },
  { id: "short", label: "Short draft", text: "Why does this flake?" },
  // A slash command is executable composer syntax, so `isPromptTextRevisable`
  // rejects it: auto-revise stays armed but the primary action is a plain send.
  { id: "slash", label: "Slash draft", text: "/review" },
  {
    id: "long",
    label: "Long draft",
    text:
      "Walk the composer's submit path from the keydown handler down to the abort controller, " +
      "then tell me where the send and stop intents actually diverge and which layer owns that decision.",
  },
] as const

const FORCED: { id: LabForced; label: string }[] = [
  { id: "none", label: "None" },
  { id: "hover", label: "Hover" },
  { id: "focus", label: "Focus" },
  { id: "pressed", label: "Press" },
]

const PHASE_LABEL: Record<LabTurnPhase, string> = {
  idle: "Idle",
  arming: "Submitting",
  running: "Generating",
  stopping: "Stopping",
  settling: "Settled",
}

type View = "compare" | LabConceptId

/** A frozen model for the static state matrix. Never touches the driver. */
function staticModel(input: {
  phase?: LabTurnPhase
  hasText?: boolean
  hasAttachment?: boolean
  mode?: "normal" | "shell"
  unavailable?: boolean
  blocked?: boolean
  forced?: LabForced
  queued?: number
  elapsedMs?: number
  tokensPerSecond?: number
  autoRevise?: boolean
  autoSend?: boolean
  revisionStaged?: boolean
  draft?: string
}): LabModel {
  const hasText = input.hasText ?? false
  return {
    composer: {
      hasText,
      hasAttachment: input.hasAttachment ?? false,
      mode: input.mode ?? "normal",
      unavailable: input.unavailable ?? false,
      blocked: input.blocked ?? false,
    },
    revisor: {
      autoBeforeSend: input.autoRevise ?? false,
      autoSendAfterRevision: input.autoSend ?? false,
      busy: input.blocked ?? false,
      readyForSend: input.revisionStaged ?? false,
      draft: input.draft ?? (hasText ? "Why does this flake?" : ""),
    },
    turn: {
      phase: input.phase ?? "idle",
      elapsedMs: input.elapsedMs ?? 0,
      pressure: 0.42,
      tokensPerSecond: input.tokensPerSecond ?? 0,
      queued: input.queued ?? 0,
    },
    forced: input.forced ?? "none",
    reducedMotion: false,
  }
}

const MATRIX: { label: string; model: LabModel }[] = [
  { label: "Idle · empty", model: staticModel({}) },
  { label: "Idle · ready", model: staticModel({ hasText: true }) },
  { label: "Ready · hover", model: staticModel({ hasText: true, forced: "hover" }) },
  { label: "Ready · focus", model: staticModel({ hasText: true, forced: "focus" }) },
  { label: "Ready · pressed", model: staticModel({ hasText: true, forced: "pressed" }) },
  { label: "Attachment only", model: staticModel({ hasAttachment: true }) },
  { label: "Submitting", model: staticModel({ phase: "arming", elapsedMs: 180 }) },
  { label: "Generating · empty", model: staticModel({ phase: "running", elapsedMs: 12_400, tokensPerSecond: 48 }) },
  {
    label: "Generating · draft",
    model: staticModel({ phase: "running", hasText: true, elapsedMs: 12_400, tokensPerSecond: 48 }),
  },
  {
    label: "Generating · 2 queued",
    model: staticModel({ phase: "running", queued: 2, elapsedMs: 44_100, tokensPerSecond: 51 }),
  },
  {
    label: "Stop · hover",
    model: staticModel({ phase: "running", forced: "hover", elapsedMs: 12_400, tokensPerSecond: 48 }),
  },
  {
    label: "Stop · pressed",
    model: staticModel({ phase: "running", forced: "pressed", elapsedMs: 12_400, tokensPerSecond: 48 }),
  },
  { label: "Stopping", model: staticModel({ phase: "stopping", elapsedMs: 12_800 }) },
  { label: "Settled", model: staticModel({ phase: "settling", elapsedMs: 12_800 }) },
  { label: "Shell · ready", model: staticModel({ hasText: true, mode: "shell" }) },
  { label: "Unavailable", model: staticModel({ hasText: true, unavailable: true }) },
  { label: "Long turn", model: staticModel({ phase: "running", elapsedMs: 184_000, tokensPerSecond: 33 }) },
  // ── Prompt Revisor ──
  { label: "Revisor armed", model: staticModel({ hasText: true, autoRevise: true }) },
  { label: "Revisor armed · auto-send", model: staticModel({ hasText: true, autoRevise: true, autoSend: true }) },
  {
    label: "Armed · slash command",
    model: staticModel({ hasText: true, autoRevise: true, draft: "/review" }),
  },
  { label: "Revising", model: staticModel({ hasText: true, autoRevise: true, blocked: true }) },
  { label: "Revision staged", model: staticModel({ hasText: true, autoRevise: true, revisionStaged: true }) },
  {
    label: "Armed · generating",
    model: staticModel({ phase: "running", hasText: true, autoRevise: true, elapsedMs: 12_400 }),
  },
]

const NOOP = {
  send: () => {},
  stop: () => {},
  revisor: {
    setAutoBeforeSend: () => {},
    setAutoSendAfterRevision: () => {},
    oneShot: () => {},
    revise: () => {},
  },
}

function Chip(props: { active?: boolean; disabled?: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      data-lab-chrome-button
      data-lab-active={props.active ? "true" : "false"}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function Group(props: { label: string; hint?: string; children: unknown }) {
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline gap-2">
        <span data-lab-eyebrow>{props.label}</span>
        <Show when={props.hint}>
          <span class="text-[10px] text-v2-text-text-faint">{props.hint}</span>
        </Show>
      </div>
      <div class="flex flex-wrap gap-1">{props.children as never}</div>
    </div>
  )
}

function Note(props: { label: string; children: string; accent?: boolean }) {
  return (
    <div class="flex flex-col gap-1">
      <span data-lab-eyebrow>{props.label}</span>
      <p
        class="text-[12px] leading-[17px]"
        classList={{
          "text-v2-text-text-muted": !props.accent,
          "text-v2-state-fg-warning": props.accent,
        }}
      >
        {props.children}
      </p>
    </div>
  )
}

function ConceptNotes(props: { concept: LabConcept }) {
  return (
    <div data-lab-panel class="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
      <Note label="Central idea">{props.concept.notes.idea}</Note>
      <Note label="How it says send vs stop">{props.concept.notes.signal}</Note>
      <Note label="What makes it different">{props.concept.notes.distinct}</Note>
      <Note label="Primary tradeoff">{props.concept.notes.tradeoff}</Note>
      <Show when={props.concept.notes.deviation}>
        {(deviation) => (
          <div class="md:col-span-2">
            <Note label="Deviates from today's behaviour" accent>
              {deviation()}
            </Note>
          </div>
        )}
      </Show>
    </div>
  )
}

function StateMatrix(props: { concept: LabConcept }) {
  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-baseline gap-2">
        <span data-lab-eyebrow>State matrix</span>
        <span class="text-[10px] text-v2-text-text-faint">
          Frozen models on a replica of the composer footer row (44px, px-2, trailing aligned)
        </span>
      </div>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
        <For each={MATRIX}>
          {(cell) => (
            <div data-lab-panel class="flex flex-col gap-0 overflow-hidden">
              <div class="flex h-11 items-center justify-end px-2">
                <Dynamic component={props.concept.Control} model={cell.model} actions={NOOP} />
              </div>
              <div class="border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1 text-[10px] text-v2-text-text-faint">
                {cell.label}
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={props.concept.Overlay}>
        <p class="text-[11px] text-v2-text-text-faint">
          This concept also renders composer-level chrome. The matrix shows the control only — use the live composer
          above to judge the edge treatment.
        </p>
      </Show>
    </div>
  )
}

export function SendControlLab() {
  const driver = createLabDriver()
  // Shared across every stage so the compare view stays in lockstep; the draft
  // text stays per-stage, because `isPromptTextRevisable` runs against it.
  const revisor = createLabRevisor()
  const [view, setView] = createSignal<View>("compare")
  const [ui, setUi] = createStore({
    mode: "normal" as "normal" | "shell",
    unavailable: false,
    forced: "none" as LabForced,
    reducedMotion: false,
    attachment: false,
    scheme: "dark" as "light" | "dark",
    draft: "short" as (typeof DRAFTS)[number]["id"],
  })
  const [seed, setSeed] = createStore({ text: DRAFTS[1].text as string, rev: 0 })

  const applyDraft = (id: (typeof DRAFTS)[number]["id"]) => {
    const draft = DRAFTS.find((item) => item.id === id) ?? DRAFTS[0]
    setUi("draft", id)
    setSeed({ text: draft.text, rev: seed.rev + 1 })
  }

  createEffect(() => {
    const root = document.documentElement
    root.dataset.colorScheme = ui.scheme
    root.style.backgroundColor = ui.scheme === "dark" ? "#080808" : "#fafafa"
  })

  // Space toggles the turn so a reviewer can watch the transition repeatedly
  // without moving the pointer off the control they are inspecting.
  createEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input,textarea"))) return
      event.preventDefault()
      if (driver.turn.phase === "arming" || driver.turn.phase === "running") driver.stop()
      else driver.send()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  const controls: LabStageControls = {
    mode: () => ui.mode,
    unavailable: () => ui.unavailable,
    forced: () => ui.forced,
    reducedMotion: () => ui.reducedMotion,
    attachment: () => ui.attachment,
    seed,
  }

  const current = createMemo(() => (view() === "compare" ? undefined : labConcept(view() as LabConceptId)))
  const live = () => driver.turn.phase === "arming" || driver.turn.phase === "running"

  return (
    <div
      data-lab="send-control"
      data-lab-motion={ui.reducedMotion ? "off" : "on"}
      class="flex h-dvh min-h-0 flex-col bg-v2-background-bg-deep font-[family-name:var(--v2-font-family-sans)] text-v2-text-text-base"
    >
      <header class="flex h-11 shrink-0 items-center gap-3 border-b border-v2-border-border-muted bg-v2-background-bg-base px-3">
        <span class="text-[12px] font-[560]">Prompt Input V2 · Send / Stop concept lab</span>
        <span class="rounded-[4px] bg-v2-state-bg-warning px-1.5 py-[2px] text-[9px] font-[600] uppercase tracking-[0.6px] text-v2-state-fg-warning">
          Nonfunctional prototype
        </span>
        <span class="hidden text-[11px] text-v2-text-text-faint lg:inline">
          Mock state only — no send handler, no session abort
        </span>
        <div class="ml-auto flex items-center gap-1">
          <Chip active={ui.scheme === "light"} onClick={() => setUi("scheme", "light")}>
            Light
          </Chip>
          <Chip active={ui.scheme === "dark"} onClick={() => setUi("scheme", "dark")}>
            Dark
          </Chip>
          <Chip active={ui.reducedMotion} onClick={() => setUi("reducedMotion", !ui.reducedMotion)}>
            Reduce motion
          </Chip>
        </div>
      </header>

      <div class="flex min-h-0 flex-1">
        {/* ── concept rail ── */}
        <aside class="flex w-[216px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-v2-border-border-muted bg-v2-background-bg-base p-2">
          <button
            type="button"
            data-lab-rail-item
            data-lab-active={view() === "compare" ? "true" : "false"}
            onClick={() => setView("compare")}
          >
            <span class="text-[12px] font-[560]">Compare all {LAB_CONCEPTS.length}</span>
            <span class="mt-0.5 block text-[10px] leading-[14px] text-v2-text-text-faint">
              One shared turn driver, identical width
            </span>
          </button>
          <div class="my-1 h-px bg-v2-border-border-muted" />
          <For each={LAB_CONCEPTS}>
            {(concept) => (
              <button
                type="button"
                data-lab-rail-item
                data-lab-active={view() === concept.id ? "true" : "false"}
                onClick={() => setView(concept.id)}
              >
                <span class="flex items-baseline gap-1.5">
                  <span class="text-[10px] font-[600] text-v2-text-text-faint">{LAB_CONCEPT_LETTER[concept.id]}</span>
                  <span class="text-[12px] font-[560]">{concept.name}</span>
                </span>
                <span class="mt-0.5 block text-[10px] leading-[14px] text-v2-text-text-faint">{concept.tagline}</span>
              </button>
            )}
          </For>
        </aside>

        {/* ── stage ── */}
        <main class="min-w-0 flex-1 overflow-y-auto">
          <Show
            when={current()}
            fallback={
              <div class="mx-auto flex max-w-[760px] flex-col gap-4 p-6">
                <For each={LAB_CONCEPTS}>
                  {(concept) => (
                    <section class="flex flex-col gap-2">
                      <div class="flex items-baseline gap-2">
                        <span class="text-[10px] font-[600] text-v2-text-text-faint">
                          {LAB_CONCEPT_LETTER[concept.id]}
                        </span>
                        <span class="text-[12px] font-[560]">{concept.name}</span>
                        <span class="text-[11px] text-v2-text-text-faint">{concept.tagline}</span>
                        <button
                          type="button"
                          data-lab-chrome-button
                          class="ml-auto"
                          onClick={() => setView(concept.id)}
                        >
                          Open
                        </button>
                      </div>
                      <LabComposerStage
                        concept={concept}
                        driver={driver}
                        revisor={revisor}
                        controls={controls}
                        compact
                      />
                    </section>
                  )}
                </For>
              </div>
            }
          >
            {(concept) => (
              <div class="mx-auto flex max-w-[860px] flex-col gap-5 p-6">
                <div class="flex items-baseline gap-2">
                  <span class="text-[11px] font-[600] text-v2-text-text-faint">{LAB_CONCEPT_LETTER[concept().id]}</span>
                  <h1 class="text-[15px] font-[560]">{concept().name}</h1>
                  <span class="text-[12px] text-v2-text-text-faint">{concept().tagline}</span>
                </div>
                <div class="mx-auto w-full max-w-[720px]">
                  <LabComposerStage concept={concept()} driver={driver} revisor={revisor} controls={controls} />
                </div>
                <ConceptNotes concept={concept()} />
                <StateMatrix concept={concept()} />
              </div>
            )}
          </Show>
        </main>

        {/* ── simulated state ── */}
        <aside class="flex w-[252px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-v2-border-border-muted bg-v2-background-bg-base p-3">
          <Group label="Turn" hint="Space toggles">
            <Chip onClick={() => driver.send()} disabled={live()}>
              Run turn
            </Chip>
            <Chip onClick={() => driver.stop()} disabled={!live()}>
              Stop
            </Chip>
            <Chip onClick={() => driver.reset()}>Reset</Chip>
          </Group>

          <Group label="Pin phase" hint="freezes the lifecycle">
            <For each={LAB_TURN_PHASES}>
              {(phase) => (
                <Chip active={driver.turn.phase === phase} onClick={() => driver.pin(phase)}>
                  {PHASE_LABEL[phase]}
                </Chip>
              )}
            </For>
          </Group>

          <Group label="Turn length">
            <For each={LAB_TURN_LENGTHS}>
              {(item) => (
                <Chip active={driver.length() === item.id} onClick={() => driver.setLength(item.id)}>
                  {item.label}
                </Chip>
              )}
            </For>
          </Group>

          <Group label="Pre-stream latency" hint="click → first token">
            <For each={LAB_LATENCIES}>
              {(item) => (
                <Chip active={driver.latency() === item.id} onClick={() => driver.setLatency(item.id)}>
                  {item.label}
                </Chip>
              )}
            </For>
          </Group>

          <div class="h-px bg-v2-border-border-muted" />

          <Group label="Draft">
            <For each={DRAFTS}>
              {(draft) => (
                <Chip active={ui.draft === draft.id} onClick={() => applyDraft(draft.id)}>
                  {draft.label}
                </Chip>
              )}
            </For>
          </Group>

          <Group label="Composer">
            <Chip active={ui.attachment} onClick={() => setUi("attachment", !ui.attachment)}>
              Attachment
            </Chip>
            <Chip active={ui.mode === "shell"} onClick={() => setUi("mode", ui.mode === "shell" ? "normal" : "shell")}>
              Shell mode
            </Chip>
            <Chip active={ui.unavailable} onClick={() => setUi("unavailable", !ui.unavailable)}>
              Unavailable
            </Chip>
          </Group>

          <Group label="Prompt Revisor" hint="drives the real send policy">
            <Chip
              active={revisor.autoBeforeSend()}
              onClick={() => revisor.setAutoBeforeSend(!revisor.autoBeforeSend())}
            >
              Auto-revise
            </Chip>
            <Chip
              active={revisor.autoSendAfterRevision()}
              disabled={!revisor.autoBeforeSend()}
              onClick={() => revisor.setAutoSendAfterRevision(!revisor.autoSendAfterRevision())}
            >
              Auto-send
            </Chip>
            <Chip active={revisor.busy()} onClick={() => void revisor.run({ autoSend: false })}>
              Revise now
            </Chip>
            <Chip active={revisor.readyForSend()} onClick={() => revisor.reset()}>
              Clear staged
            </Chip>
            <Chip active={ui.draft === "slash"} onClick={() => applyDraft("slash")}>
              Slash draft
            </Chip>
          </Group>

          <Group label="Force interaction state">
            <For each={FORCED}>
              {(item) => (
                <Chip active={ui.forced === item.id} onClick={() => setUi("forced", item.id)}>
                  {item.label}
                </Chip>
              )}
            </For>
          </Group>

          <div class="h-px bg-v2-border-border-muted" />

          <div class="flex flex-col gap-2">
            <span data-lab-eyebrow>Keyboard (real, via interaction.ts)</span>
            <div class="flex flex-col gap-1.5 text-[11px] text-v2-text-text-muted">
              <span class="flex items-center gap-2">
                <KeybindV2 keys={["Enter"]} />
                <span>Primary action</span>
              </span>
              <span class="flex items-center gap-2">
                <KeybindV2 keys={["Esc"]} />
                <span>Stop while a turn runs</span>
              </span>
              <span class="flex items-center gap-2">
                <KeybindV2 keys={["Ctrl", "G"]} />
                <span>Stop (alternate)</span>
              </span>
              <span class="flex items-center gap-2">
                <KeybindV2 keys={["Shift", "Enter"]} />
                <span>Newline</span>
              </span>
            </div>
          </div>

          <div class="mt-auto flex items-start gap-1.5 rounded-lg bg-v2-background-bg-layer-01 p-2 text-[10px] leading-[14px] text-v2-text-text-faint">
            <Icon name="help" class="mt-px size-3 shrink-0" />
            <span>
              Every action here mutates local signals only. The stages mount the real{" "}
              <span class="text-v2-text-text-muted">PromptInputV2</span> shell with a mock controller.
            </span>
          </div>
        </aside>
      </div>
    </div>
  )
}
