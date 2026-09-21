/**
 * Concept E — Ambient Composer Edge. DEV-ONLY prototype.
 *
 * Premise: the other four all concentrate turn state inside a 28px square. This
 * one inverts the hierarchy — the *composer* says a turn is running, and the
 * control stays a quiet mark that only says what pressing it will do.
 *
 * A 1px hairline orbits the composer's own 12px silhouette while the turn is
 * live, and spins down as it is interrupted. The control inherits that state's
 * colour, so the edge and the mark read as one system rather than two
 * independent indicators.
 *
 * Send's prominence comes from a contrast ramp instead of a filled CTA: a faint
 * mark when there is nothing to send, a full-strength mark inside a hairline box
 * when there is. Nothing in the footer is ever the loudest thing on screen,
 * which is the point — the prompt is.
 */

import { createMemo, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { LabGlyphStack, LabQueueGlyph, LabStoppingGlyph } from "./glyphs"
import { LAB_COPY } from "./copy"
import type { LabConcept, LabConceptProps } from "./concept"
import { labCanSubmit, labInterruptible, labProductionIntent } from "./types"

function ConceptEOverlay(props: LabConceptProps) {
  const phase = () => props.model.turn.phase
  const mode = createMemo(() => (phase() === "stopping" ? "stopping" : "running"))
  const quiet = createMemo(() => !labInterruptible(props.model) && phase() !== "stopping")

  return (
    <div data-lab-concept="e" class="pointer-events-none absolute inset-0">
      <div data-lab-e-edge data-lab-e-quiet={quiet() ? "true" : "false"} data-lab-e-mode={mode()} aria-hidden="true">
        <div data-lab-e-ring>
          <div data-lab-e-runner />
        </div>
      </div>
    </div>
  )
}

function ConceptEControl(props: LabConceptProps) {
  const i18n = useI18n()
  const intent = createMemo(() => labProductionIntent(props.model))
  const live = createMemo(() => labInterruptible(props.model))
  const stopping = () => props.model.turn.phase === "stopping"
  const isStop = createMemo(() => intent() === "stop" || stopping())

  const label = createMemo(() => {
    switch (intent()) {
      case "stop":
        return i18n.t("ui.promptInput.stop")
      case "stopping":
        return LAB_COPY.stopping
      case "queue":
        return LAB_COPY.queue
      case "blocked":
        return LAB_COPY.blocked
      case "unavailable":
        return LAB_COPY.unavailable
      default:
        return i18n.t("ui.promptInput.send")
    }
  })

  const glyph = createMemo(() => {
    if (props.model.composer.blocked) return "blocked"
    if (stopping()) return "stopping"
    if (intent() === "stop") return "stop"
    if (intent() === "queue") return "queue"
    if (props.model.composer.mode === "shell") return "shell"
    return "send"
  })

  const disabled = createMemo(() => {
    if (stopping() || props.model.composer.blocked || props.model.composer.unavailable) return true
    if (isStop()) return false
    return !labCanSubmit(props.model)
  })

  return (
    <div data-lab-concept="e" class="shrink-0">
      <TooltipV2
        placement="top"
        gutter={5}
        inactive={disabled() && !isStop()}
        value={
          <span class="flex items-center gap-1.5">
            <span>{label()}</span>
            <KeybindV2 keys={isStop() ? ["Esc"] : ["Enter"]} variant="ghost" />
          </span>
        }
      >
        <button
          type="button"
          data-lab-surface="ghost"
          data-lab-e-button
          data-lab-e-role={isStop() ? "stop" : "send"}
          data-lab-e-ready={labCanSubmit(props.model) ? "true" : "false"}
          data-lab-e-halted={props.model.composer.unavailable ? "true" : undefined}
          data-lab-busy={props.model.composer.blocked ? "true" : undefined}
          data-lab-force={props.model.forced === "none" ? undefined : props.model.forced}
          data-lab-action={isStop() ? "interrupt" : "send"}
          aria-label={label()}
          aria-disabled={disabled() ? "true" : undefined}
          onClick={(event) => {
            event.preventDefault()
            if (disabled()) return
            if (isStop()) {
              props.actions.stop()
              return
            }
            props.actions.send()
          }}
        >
          {/* Stop's only boundary: a crisp hairline box, no fill. */}
          <span data-lab-e-frame data-lab-e-hidden={isStop() ? "false" : "true"} aria-hidden="true" />
          <LabGlyphStack
            active={glyph}
            items={[
              { id: "send", node: <Icon name="arrow-up" size="small" /> },
              { id: "queue", node: <LabQueueGlyph /> },
              { id: "shell", node: <Icon name="arrow-undo-down" size="small" /> },
              { id: "stop", node: <Icon name="stop" size="small" /> },
              { id: "stopping", node: <LabStoppingGlyph /> },
              { id: "blocked", node: <Icon name="pencil-sparkles" size="small" class="!text-v2-icon-icon-accent" /> },
            ]}
          />
          <Show when={live() && props.model.turn.queued > 0}>
            <span class="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-v2-background-bg-accent" />
          </Show>
        </button>
      </TooltipV2>
    </div>
  )
}

export const conceptE: LabConcept = {
  id: "e",
  name: "Ambient Edge",
  tagline: "The composer carries the turn. The control stays quiet.",
  Control: ConceptEControl,
  Overlay: ConceptEOverlay,
  notes: {
    idea:
      "Invert the hierarchy. A 1px hairline orbits the composer's own border while a turn runs and spins " +
      "down as it is interrupted; the control is a ghost-weight mark that only states what pressing it does.",
    signal:
      "Peripherally, the composer's orbiting edge. Locally, a contrast ramp: faint mark when empty, " +
      "full-strength mark in a hairline box when ready, red stop mark in a crisp 18px frame while interruptible.",
    distinct:
      "The only concept where turn state does not live in the control at all, and the only one with no filled " +
      "button anywhere — so the prompt text stays the loudest element in the composer at every phase.",
    tradeoff:
      "Quietest Send in the set: a first-time user has no obvious primary button to aim at, and the edge " +
      "depends on peripheral perception of a 1px line that a busy background can swallow. " +
      "It is also the most invasive to implement, because the control now owns composer chrome.",
  },
}
