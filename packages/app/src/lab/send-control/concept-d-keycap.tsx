/**
 * Concept D — Keycap Parity. DEV-ONLY prototype.
 *
 * Premise: the pointer control is not a second, parallel way to do this. It is
 * the on-screen face of a key, and the ambiguity people actually hit is that
 * they cannot predict *which* key it currently is.
 *
 * So this concept keeps today's behaviour exactly — Enter is the composer's key
 * and sends or queues, Escape is the turn's key and interrupts — and spends its
 * entire design budget on making that switch legible *before* it happens:
 *
 *   - the control is a physical keycap carrying the glyph plus the legend of the
 *     key it currently corresponds to;
 *   - a fixed-width key strip sits to its left showing both keys at all times,
 *     with the armed one lit. You can see Escape arm the instant a turn starts,
 *     and see Enter re-arm the instant you type, before you commit a pointer to
 *     anything;
 *   - real key presses strike the on-screen keys, so the two input paths are
 *     visibly the same mechanism.
 *
 * It is the only concept in the set that changes no runtime semantics at all.
 */

import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { LabGlyphStack, LabQueueGlyph, LabStoppingGlyph } from "./glyphs"
import { LAB_COPY } from "./copy"
import type { LabConcept, LabConceptProps } from "./concept"
import { labCanSubmit, labInterruptible, labProductionIntent } from "./types"

/** Keyboard legends are retained English in this product, like `KeybindV2` keys. */
const ENTER_LEGEND = "Enter"
const ESC_LEGEND = "Esc"

function ConceptDControl(props: LabConceptProps) {
  const i18n = useI18n()
  const intent = createMemo(() => labProductionIntent(props.model))
  const live = createMemo(() => labInterruptible(props.model))
  const stopping = () => props.model.turn.phase === "stopping"

  /** Which physical key the cap currently *is*. This is production semantics. */
  const armed = createMemo<"enter" | "esc">(() => {
    if (intent() === "stop" || stopping()) return "esc"
    return "enter"
  })

  const [struck, setStruck] = createSignal<"enter" | "esc" | undefined>()
  let strikeTimer: ReturnType<typeof setTimeout> | undefined
  const strike = (key: "enter" | "esc") => {
    setStruck(key)
    if (strikeTimer) clearTimeout(strikeTimer)
    strikeTimer = setTimeout(() => setStruck(undefined), 220)
  }

  // Visual only. This listener never invokes an action — the composer's own
  // key handling already owns that, and mirroring it here would double-fire.
  createEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) strike("enter")
      else if (event.key === "Escape") strike("esc")
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  // Reset the strike when the turn changes underneath it.
  createEffect(
    on(
      () => props.model.turn.phase,
      () => setStruck(undefined),
      { defer: true },
    ),
  )
  onCleanup(() => {
    if (strikeTimer) clearTimeout(strikeTimer)
  })

  const glyph = createMemo(() => {
    if (props.model.composer.blocked) return "blocked"
    if (stopping()) return "stopping"
    if (intent() === "stop") return "stop"
    if (intent() === "queue") return "queue"
    if (props.model.composer.mode === "shell") return "shell"
    return "send"
  })

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

  const disabled = createMemo(() => {
    if (stopping() || props.model.composer.blocked || props.model.composer.unavailable) return true
    if (intent() === "stop") return false
    return !labCanSubmit(props.model)
  })

  const role = createMemo(() => (intent() === "stop" || stopping() ? "stop" : "send"))

  return (
    <div data-lab-concept="d" class="shrink-0">
      <div data-lab-d-cluster>
        {/*
         * Both keys, always visible, fixed width. The lit one is what the
         * keyboard will do and therefore what the cap will do.
         */}
        <div data-lab-d-strip aria-hidden="true">
          <span
            data-lab-d-key
            data-lab-d-kind="send"
            data-lab-d-armed={armed() === "enter" && !disabled() ? "true" : "false"}
            data-lab-d-struck={struck() === "enter" ? "true" : "false"}
          >
            {ENTER_LEGEND}
          </span>
          <span
            data-lab-d-key
            data-lab-d-kind="stop"
            data-lab-d-armed={live() || stopping() ? "true" : "false"}
            data-lab-d-struck={struck() === "esc" ? "true" : "false"}
          >
            {ESC_LEGEND}
          </span>
        </div>

        <TooltipV2
          placement="top"
          gutter={6}
          inactive={disabled() && intent() !== "stop"}
          value={
            <span class="flex flex-col items-start gap-0.5">
              <span>{label()}</span>
              <Show when={live() && labCanSubmit(props.model)}>
                <span class="text-v2-text-text-faint">{`${ESC_LEGEND} stops · ${ENTER_LEGEND} queues`}</span>
              </Show>
            </span>
          }
        >
          <button
            type="button"
            data-lab-d-cap
            data-lab-d-role={role()}
            data-lab-force={props.model.forced === "none" ? undefined : props.model.forced}
            data-lab-d-struck={struck() === armed() ? "true" : "false"}
            data-lab-action={role() === "stop" ? "interrupt" : "send"}
            data-lab-busy={props.model.composer.blocked ? "true" : undefined}
            aria-label={label()}
            aria-disabled={disabled() ? "true" : undefined}
            onClick={(event) => {
              event.preventDefault()
              if (disabled()) return
              strike(armed())
              if (role() === "stop") {
                props.actions.stop()
                return
              }
              props.actions.send()
            }}
          >
            <LabGlyphStack
              active={glyph}
              class="!size-3"
              items={[
                { id: "send", node: <Icon name="arrow-up" class="!size-3" /> },
                { id: "queue", node: <LabQueueGlyph class="!size-3" /> },
                { id: "shell", node: <Icon name="arrow-undo-down" class="!size-3" /> },
                { id: "stop", node: <Icon name="stop" class="!size-3" /> },
                { id: "stopping", node: <LabStoppingGlyph class="!size-3" /> },
                { id: "blocked", node: <Icon name="pencil-sparkles" class="!size-3 !text-v2-icon-icon-accent" /> },
              ]}
            />
            <span data-lab-d-legend>{armed() === "esc" ? ESC_LEGEND : ENTER_LEGEND}</span>
            <Show when={live()}>
              <span data-lab-d-life aria-hidden="true" />
            </Show>
          </button>
        </TooltipV2>
      </div>
    </div>
  )
}

export const conceptD: LabConcept = {
  id: "d",
  name: "Keycap Parity",
  tagline: "The control is the key. Both keys stay visible, the armed one lights.",
  Control: ConceptDControl,
  notes: {
    idea:
      "Render the pointer control as the physical face of a key, and put a fixed-width strip of both keys " +
      "(Enter / Esc) beside it with the armed one lit. Real key presses strike the on-screen keys.",
    signal:
      "The legend on the cap, plus the lit key in the strip — so the switch is predictable a moment before " +
      "you commit a pointer to it, rather than discovered afterwards. Glyph and legend always agree.",
    distinct:
      "The only concept that changes no runtime semantics whatsoever, and the only one that treats the " +
      "ambiguity as a *legibility* problem rather than a layout problem. It is also the only one that makes " +
      "the keyboard path visible at rest, which is what actually retires the pointer for heavy users.",
    tradeoff:
      "It leans on legends, so it carries text width in every locale, and it hardcodes an assumption about " +
      "the user's keybinds. The keycap metaphor also reads as slightly more decorative than the rest of the " +
      "composer, which is otherwise flat.",
  },
}
