/**
 * Concept A — Dual Lane. DEV-ONLY prototype.
 *
 * Premise rejected: that one pointer target should carry two opposite meanings.
 *
 * Send is a permanent control that only ever sends. Interrupt is a separate
 * sibling that only ever interrupts, and it lives in a 28px slot that is
 * *always* reserved in the layout — empty and non-interactive when there is
 * nothing to interrupt. Send therefore occupies the same pixels for the entire
 * life of the composer, and an interrupt can never appear underneath a pointer
 * that was already travelling toward Send.
 *
 * Built out of the real `IconButtonV2` on purpose: it is the proof that this
 * direction needs no new primitive, and it is the reference the other four
 * concepts' hand-rolled geometry is matched against.
 */

import { createMemo, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { LabGlyphStack, LabQueueGlyph, LabStoppingGlyph } from "./glyphs"
import { LAB_COPY } from "./copy"
import type { LabConcept, LabConceptProps } from "./concept"
import { labCanSubmit, labForcedButtonState, labInterruptible, labProductionIntent } from "./types"

function LabTooltipBody(props: { label: string; keys: string[] }) {
  return (
    <span class="flex items-center gap-1.5">
      <span>{props.label}</span>
      <KeybindV2 keys={props.keys} variant="ghost" />
    </span>
  )
}

function ConceptAControl(props: LabConceptProps) {
  const i18n = useI18n()
  const intent = createMemo(() => labProductionIntent(props.model))
  const interruptVisible = createMemo(() => labInterruptible(props.model) || props.model.turn.phase === "stopping")
  const stopping = () => props.model.turn.phase === "stopping"
  const forced = () => labForcedButtonState(props.model.forced)

  const sendGlyph = createMemo(() => {
    // A transient pre-send transform is busy, not disabled: say so with the
    // same mark the prompt revisor already uses elsewhere in this composer.
    if (intent() === "blocked") return "blocked"
    if (props.model.composer.mode === "shell") return "shell"
    if (intent() === "queue") return "queue"
    return "send"
  })

  const sendLabel = createMemo(() => {
    if (intent() === "unavailable") return LAB_COPY.unavailable
    if (intent() === "blocked") return LAB_COPY.blocked
    if (intent() === "queue") return LAB_COPY.queue
    return i18n.t("ui.promptInput.send")
  })

  const stopLabel = () => (stopping() ? LAB_COPY.stopping : i18n.t("ui.promptInput.stop"))

  // Send is disabled by emptiness only. It is never disabled *because* a turn is
  // running: sending the next message while the assistant works is a real and
  // frequent intent, and it keeps this target's meaning constant.
  const sendDisabled = createMemo(() => !labCanSubmit(props.model))
  // A revision in flight is busy, not off. Use `aria-disabled` so the
  // primitive's own disabled dimming does not fade out a working control.
  const busy = () => intent() === "blocked"

  return (
    <div data-lab-concept="a" class="shrink-0">
      <div data-lab-a-lane>
        {/* Reserved interrupt slot. Present in layout at all times. */}
        <div data-lab-a-slot data-lab-a-present={interruptVisible() ? "true" : "false"}>
          <Show when={interruptVisible()}>
            <TooltipV2 placement="top" gutter={5} value={<LabTooltipBody label={stopLabel()} keys={["Esc"]} />}>
              <IconButtonV2
                type="button"
                size="large"
                variant="neutral"
                state={forced()}
                data-lab-action="interrupt"
                aria-label={stopLabel()}
                aria-disabled={stopping() ? "true" : undefined}
                /*
                 * Restrained on purpose. The interrupt earns its urgency from the
                 * red mark and from sitting beside a black Send, not from a red
                 * fill — a permanently red control in the composer reads as a
                 * broken session rather than an interruptible one.
                 */
                class="!size-7 !rounded-[7px] !text-v2-state-fg-danger"
                classList={{ "!text-v2-icon-icon-muted": stopping() }}
                icon={
                  <LabGlyphStack
                    active={() => (stopping() ? "stopping" : "stop")}
                    items={[
                      { id: "stop", node: <Icon name="stop" size="small" /> },
                      { id: "stopping", node: <LabStoppingGlyph /> },
                    ]}
                  />
                }
                onClick={(event) => {
                  event.preventDefault()
                  if (stopping()) return
                  props.actions.stop()
                }}
              />
            </TooltipV2>
          </Show>
        </div>

        <div class="relative">
          <TooltipV2
            placement="top"
            gutter={5}
            inactive={sendDisabled()}
            value={<LabTooltipBody label={sendLabel()} keys={["Enter"]} />}
          >
            <IconButtonV2
              type="button"
              size="large"
              variant="contrast"
              state={forced()}
              data-lab-action="send"
              data-lab-busy={busy() ? "true" : undefined}
              disabled={sendDisabled() && !busy()}
              aria-disabled={busy() ? "true" : undefined}
              aria-label={sendLabel()}
              class="!size-7 !rounded-[7px] !text-v2-icon-icon-contrast"
              icon={
                <LabGlyphStack
                  active={sendGlyph}
                  items={[
                    { id: "send", node: <Icon name="arrow-up" size="small" /> },
                    { id: "queue", node: <LabQueueGlyph /> },
                    { id: "shell", node: <Icon name="arrow-undo-down" size="small" /> },
                    {
                      id: "blocked",
                      node: <Icon name="pencil-sparkles" size="small" class="!text-v2-icon-icon-accent" />,
                    },
                  ]}
                />
              }
              onClick={(event) => {
                event.preventDefault()
                if (busy()) return
                props.actions.send()
              }}
            />
          </TooltipV2>
          <Show when={props.model.turn.queued > 0}>
            <span data-lab-a-queued aria-hidden="true">
              {props.model.turn.queued}
            </span>
          </Show>
        </div>
      </div>
    </div>
  )
}

export const conceptA: LabConcept = {
  id: "a",
  name: "Dual Lane",
  tagline: "Two permanent targets. Neither ever changes meaning.",
  Control: ConceptAControl,
  notes: {
    idea:
      "Split the control instead of toggling it. Send is permanent and only sends; " +
      "an interrupt button occupies a reserved 28px slot to its left and only interrupts.",
    signal:
      "Position plus weight, not state decoding. Black filled square on the right is always Send; " +
      "raised neutral square with a red mark on the left is always Stop. Nothing has to be read.",
    distinct:
      "The only concept where the two intents never share a target, and the only one where the " +
      "interrupt survives typing — you can keep drafting a follow-up and still stop the turn with the mouse.",
    tradeoff:
      "Costs a permanent 32px of composer footer even when idle, and splits one piece of muscle memory " +
      "into two. Two targets 4px apart also means a mis-aim lands on the other intent rather than on nothing.",
    deviation:
      "Send stays enabled during a turn (it queues), so the pointer never switches to Stop. " +
      "Today the same button becomes Stop as soon as the composer is empty.",
  },
}
