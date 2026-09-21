/**
 * Concept B — Turn Baton. DEV-ONLY prototype.
 *
 * Premise: the control is not a button that happens to have two labels. It is
 * the physical representation of *the turn*. You hand the turn over by pressing
 * it, and you take the turn back by pressing it. One target, 28px, fixed
 * position, and its meaning is read off the runtime alone — never off the
 * composer's contents.
 *
 * That resolves the ambiguity by removing it: during a turn, this control is
 * Stop even when you have typed a follow-up. Queueing stays where it already
 * is on the keyboard (Enter), and gets its own non-interactive confirmation
 * chip beside the control so the pointer path and the keyboard path never
 * contradict each other.
 *
 * Two lifecycle ideas are prototyped here that the current control does not
 * have:
 *
 *   - an *arming* presentation for the window between the click and the first
 *     streamed token, so the optimistic state is honest rather than instant;
 *   - a minimum-visible-turn latch, so a 180ms turn cannot strobe the glyph
 *     through send -> stop -> done -> send faster than the eye can resolve it.
 */

import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { LabGlyphStack, LabQueueGlyph, LabStoppingGlyph } from "./glyphs"
import { LAB_COPY } from "./copy"
import type { LabConcept, LabConceptProps } from "./concept"
import { labCanSubmit, labInterruptible } from "./types"

/** A turn shorter than this still gets this much visible "running" time. */
const MIN_VISIBLE_TURN_MS = 340

type BatonView = "send" | "arming" | "stop" | "stopping" | "settled"

function ConceptBControl(props: LabConceptProps) {
  const i18n = useI18n()
  const phase = () => props.model.turn.phase
  const [latched, setLatched] = createSignal(false)
  const [launching, setLaunching] = createSignal(false)

  let latch: ReturnType<typeof setTimeout> | undefined
  let launch: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (latch) clearTimeout(latch)
    if (launch) clearTimeout(launch)
  })

  // Hold the turn presentation for a floor duration once a turn begins.
  createEffect(
    on(phase, (next, previous) => {
      if (next !== "arming" && next !== "running") return
      if (previous === "arming" || previous === "running") return
      setLatched(true)
      if (latch) clearTimeout(latch)
      latch = setTimeout(() => setLatched(false), MIN_VISIBLE_TURN_MS)
      setLaunching(true)
      if (launch) clearTimeout(launch)
      launch = setTimeout(() => setLaunching(false), 260)
    }),
  )

  const view = createMemo<BatonView>(() => {
    const current = phase()
    if (current === "stopping") return "stopping"
    if (current === "arming") return "arming"
    if (current === "running") return "stop"
    // Settling or already idle, but the latch has not expired: keep showing the
    // turn. An instant turn therefore reads as a turn, not as a flicker.
    if (latched()) return "stop"
    if (current === "settling") return "settled"
    return "send"
  })

  const live = createMemo(() => view() === "arming" || view() === "stop")
  const interruptable = () => labInterruptible(props.model) || latched()
  const sendable = createMemo(() => labCanSubmit(props.model))

  const label = createMemo(() => {
    switch (view()) {
      case "arming":
        return LAB_COPY.starting
      case "stop":
        return i18n.t("ui.promptInput.stop")
      case "stopping":
        return LAB_COPY.stopping
      case "settled":
        return LAB_COPY.done
      default:
        if (props.model.composer.unavailable) return LAB_COPY.unavailable
        if (props.model.composer.blocked) return LAB_COPY.blocked
        return i18n.t("ui.promptInput.send")
    }
  })

  const glyph = createMemo(() => {
    switch (view()) {
      case "arming":
      case "stop":
        return "stop"
      case "stopping":
        return "stopping"
      case "settled":
        return "done"
      default:
        if (props.model.composer.blocked) return "blocked"
        return props.model.composer.mode === "shell" ? "shell" : "send"
    }
  })

  const surface = createMemo(() => (live() || view() === "stopping" ? "neutral" : "contrast"))
  const disabled = createMemo(() => {
    if (view() === "stopping" || view() === "settled") return true
    if (live()) return false
    return !sendable()
  })

  const activate = () => {
    if (disabled()) return
    if (interruptable()) {
      props.actions.stop()
      return
    }
    props.actions.send()
  }

  return (
    <div data-lab-concept="b" class="shrink-0">
      <div class="flex items-center gap-2">
        {/*
         * Queue confirmation. Deliberately not a button and deliberately not on
         * the control: it reports what the keyboard already did, so the pointer
         * target keeps exactly one meaning.
         */}
        <Show when={props.model.turn.queued > 0}>
          <span data-lab-b-queue>
            <LabQueueGlyph class="!size-3 text-v2-icon-icon-muted" />
            {LAB_COPY.queuedCount(props.model.turn.queued)}
          </span>
        </Show>

        <TooltipV2
          placement="top"
          gutter={5}
          inactive={disabled() && !live()}
          value={
            <span class="flex flex-col items-start gap-1">
              <span class="flex items-center gap-1.5">
                <span>{label()}</span>
                <KeybindV2 keys={live() ? ["Esc"] : ["Enter"]} variant="ghost" />
              </span>
              <Show when={live() && sendable()}>
                <span class="flex items-center gap-1.5 text-v2-text-text-faint">
                  <KeybindV2 keys={["Enter"]} variant="ghost" />
                  <span>{LAB_COPY.queue}</span>
                </span>
              </Show>
            </span>
          }
        >
          <button
            type="button"
            data-lab-action={live() ? "interrupt" : "send"}
            data-lab-surface={surface()}
            data-lab-force={props.model.forced === "none" ? undefined : props.model.forced}
            data-lab-b-core
            data-lab-busy={props.model.composer.blocked ? "true" : undefined}
            aria-label={label()}
            aria-disabled={disabled() ? "true" : undefined}
            class="!rounded-[8px]"
            classList={{
              "!text-v2-state-fg-danger": view() === "stop",
              "!text-v2-icon-icon-muted": view() === "arming" || view() === "stopping" || view() === "settled",
            }}
            onClick={(event) => {
              event.preventDefault()
              activate()
            }}
          >
            {/*
             * Live edge. 1px, border-strong, one travelling dash. It says "this
             * is running" without implying a completion percentage the runtime
             * does not have.
             */}
            <Show when={live() || view() === "stopping" || view() === "settled"}>
              <svg
                data-lab-b-arc
                data-lab-b-settled={view() === "stopping" || view() === "settled" ? "true" : "false"}
                viewBox="0 0 28 28"
                fill="none"
                aria-hidden="true"
              >
                <rect data-lab-b-track x="0.5" y="0.5" width="27" height="27" rx="7.5" stroke-width="1" />
                <rect
                  data-lab-b-runner
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
            </Show>

            {/* In flight, nothing streamed yet: a literal charging edge. */}
            <Show when={view() === "arming"}>
              <span data-lab-b-charge aria-hidden="true" />
            </Show>

            <span data-lab-b-launch={launching() ? "true" : "false"} class="grid place-items-center">
              <LabGlyphStack
                active={glyph}
                items={[
                  { id: "send", node: <Icon name="arrow-up" size="small" /> },
                  { id: "shell", node: <Icon name="arrow-undo-down" size="small" /> },
                  { id: "stop", node: <Icon name="stop" size="small" /> },
                  { id: "stopping", node: <LabStoppingGlyph /> },
                  { id: "done", node: <Icon name="check" size="small" class="opacity-60" /> },
                  {
                    id: "blocked",
                    node: <Icon name="pencil-sparkles" size="small" class="!text-v2-icon-icon-accent" />,
                  },
                ]}
              />
            </span>
          </button>
        </TooltipV2>
      </div>
    </div>
  )
}

export const conceptB: LabConcept = {
  id: "b",
  name: "Turn Baton",
  tagline: "One target that is the turn. Runtime decides, never the draft.",
  Control: ConceptBControl,
  notes: {
    idea:
      "The control represents the turn, not the message. Press to hand the turn over, press to take it back. " +
      "Its meaning comes from the runtime alone, so the composer's contents can never change what it does.",
    signal:
      "Glyph plus surface, in lockstep: filled black square with an arrow = Send. " +
      "Raised neutral square with a red stop mark and a 1px travelling edge = the turn is live and this stops it.",
    distinct:
      "The only concept that refuses to put two intents on the pointer at all. " +
      "It also prototypes two lifecycle ideas the others do not: an honest arming state for pre-stream latency, " +
      "and a 340ms minimum-visible-turn latch so an instant turn cannot strobe the glyph.",
    tradeoff:
      "Queueing a follow-up becomes keyboard-only. A mouse-driven user who has typed during a turn " +
      "has no pointer path to send it, and the queue chip reports the action rather than offering it.",
    deviation:
      "During a turn the control is Stop even when the composer has text. " +
      "Today it reverts to Send the moment you type, which is precisely the ambiguity this rejects.",
  },
}
