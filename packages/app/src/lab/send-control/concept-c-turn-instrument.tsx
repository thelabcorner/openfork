/**
 * Concept C — Turn Instrument. DEV-ONLY prototype.
 *
 * Premise: the control is the right-hand terminus of the composer, so anchor it
 * there and let it *grow leftward* into an instrument while a turn is live.
 *
 * The trailing 28px segment is invariant. At rest it is the filled Send square.
 * During a turn it is Stop, occupying exactly the same pixels — so a pointer
 * already in flight toward the corner lands on the right thing either way, and
 * there is no target translation to track.
 *
 * Everything the turn is worth saying grows in behind it: elapsed time and rate
 * (today those live in a separate footer readout, which is why this concept
 * takes that slot over), and — when the composer has content during a turn — a
 * third leading segment for the follow-up. So both intents stay on the pointer,
 * spatially separated, without either of them moving.
 */

import { createMemo, Show, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { LabGlyphStack, LabQueueGlyph, LabStoppingGlyph } from "./glyphs"
import { LAB_COPY } from "./copy"
import type { LabConcept, LabConceptProps } from "./concept"
import { labCanSubmit, labElapsedLabel, labInterruptible } from "./types"

/** Segment (28px) + its 0.5px trailing divider. */
const FOLLOWUP_WIDTH = 28.5
/** Fixed readout (100px, see lab.css) + its 0.5px trailing divider. */
const READOUT_WIDTH = 100.5

/**
 * Horizontal reveal between 0 and a fixed width. The width is declared rather
 * than measured on purpose — see the note in `lab.css`: measuring the content
 * makes the capsule breathe every time an elapsed digit rolls over.
 */
function Grow(props: { open: boolean; width: number; children: JSX.Element }) {
  return (
    <div
      data-lab-c-grow
      data-lab-c-open={props.open ? "true" : "false"}
      style={{ width: `${props.open ? props.width : 0}px` }}
      inert={props.open ? undefined : true}
    >
      <div data-lab-c-measure style={{ width: `${props.width}px` }}>
        {props.children}
      </div>
    </div>
  )
}

function ConceptCControl(props: LabConceptProps) {
  const i18n = useI18n()
  const phase = () => props.model.turn.phase
  const live = createMemo(() => labInterruptible(props.model))
  const stopping = () => phase() === "stopping"
  const settling = () => phase() === "settling"
  const expanded = createMemo(() => live() || stopping() || settling())
  const sendable = createMemo(() => labCanSubmit(props.model))
  const forced = () => (props.model.forced === "none" ? undefined : props.model.forced)

  /** Follow-up segment: only meaningful while a turn is live and there is a draft. */
  const followup = createMemo(() => live() && sendable())

  const primaryLabel = createMemo(() => {
    if (stopping()) return LAB_COPY.stopping
    if (live()) return i18n.t("ui.promptInput.stop")
    if (props.model.composer.unavailable) return LAB_COPY.unavailable
    if (props.model.composer.blocked) return LAB_COPY.blocked
    return i18n.t("ui.promptInput.send")
  })

  const primaryGlyph = createMemo(() => {
    if (props.model.composer.blocked) return "blocked"
    if (stopping()) return "stopping"
    if (live()) return "stop"
    if (settling()) return "done"
    return props.model.composer.mode === "shell" ? "shell" : "send"
  })

  const primaryDisabled = createMemo(() => {
    if (stopping() || settling()) return true
    if (live()) return false
    return !sendable()
  })

  const primaryFill = createMemo(() => (live() || stopping() ? "danger" : "contrast"))

  return (
    <div data-lab-concept="c" class="flex min-w-0 shrink-0 justify-end">
      <div data-lab-c-capsule data-lab-c-bare={expanded() ? "false" : "true"} role="group" aria-label="Turn control">
        {/* Follow-up segment — grows in only while a live turn coexists with a draft. */}
        <Grow open={followup()} width={FOLLOWUP_WIDTH}>
          <TooltipV2
            placement="top"
            gutter={7}
            value={
              <span class="flex items-center gap-1.5">
                <span>{LAB_COPY.queue}</span>
                <KeybindV2 keys={["Enter"]} variant="ghost" />
              </span>
            }
          >
            <button
              type="button"
              data-lab-c-seg
              data-lab-c-role="queue"
              data-lab-force={forced()}
              data-lab-action="queue"
              aria-label={LAB_COPY.queue}
              onClick={(event) => {
                event.preventDefault()
                props.actions.send()
              }}
            >
              <LabQueueGlyph />
            </button>
          </TooltipV2>
          <div data-lab-c-divider />
        </Grow>

        {/* Turn readout — absorbs the composer's separate live-rate footer. */}
        <Grow open={expanded()} width={READOUT_WIDTH}>
          <div data-lab-c-readout aria-live="off">
            <Show
              when={phase() !== "arming"}
              fallback={
                <>
                  <span data-lab-c-wait aria-hidden="true" />
                  <span data-lab-c-dim>{LAB_COPY.starting}</span>
                </>
              }
            >
              <Show
                when={!stopping()}
                fallback={
                  <>
                    <LabStoppingGlyph class="!size-3 text-v2-state-fg-danger" />
                    <span data-lab-c-dim>{LAB_COPY.stopping}</span>
                  </>
                }
              >
                <span>{labElapsedLabel(props.model.turn.elapsedMs)}</span>
                <Show when={!settling()} fallback={<span data-lab-c-dim>{LAB_COPY.done}</span>}>
                  <span data-lab-c-dim>·</span>
                  <span data-lab-c-dim>{props.model.turn.tokensPerSecond} tok/s</span>
                  <Show when={props.model.turn.queued > 0}>
                    <span data-lab-c-dim>·</span>
                    <span data-lab-c-dim>{LAB_COPY.queuedCount(props.model.turn.queued)}</span>
                  </Show>
                </Show>
              </Show>
            </Show>
          </div>
          <div data-lab-c-divider />
        </Grow>

        {/* Invariant trailing segment. Same pixels for Send and for Stop. */}
        <TooltipV2
          placement="top"
          gutter={7}
          inactive={primaryDisabled() && !live()}
          value={
            <span class="flex items-center gap-1.5">
              <span>{primaryLabel()}</span>
              <KeybindV2 keys={live() ? ["Esc"] : ["Enter"]} variant="ghost" />
            </span>
          }
        >
          <button
            type="button"
            data-lab-c-seg
            data-lab-c-role={live() || stopping() ? "stop" : "send"}
            data-lab-c-fill={primaryFill()}
            data-lab-force={forced()}
            data-lab-action={live() ? "interrupt" : "send"}
            data-lab-busy={props.model.composer.blocked ? "true" : undefined}
            aria-label={primaryLabel()}
            aria-disabled={primaryDisabled() ? "true" : undefined}
            onClick={(event) => {
              event.preventDefault()
              if (primaryDisabled()) return
              if (live()) {
                props.actions.stop()
                return
              }
              props.actions.send()
            }}
          >
            <LabGlyphStack
              active={primaryGlyph}
              items={[
                { id: "send", node: <Icon name="arrow-up" size="small" /> },
                { id: "shell", node: <Icon name="arrow-undo-down" size="small" /> },
                { id: "stop", node: <Icon name="stop" size="small" /> },
                { id: "stopping", node: <LabStoppingGlyph /> },
                { id: "done", node: <Icon name="check" size="small" class="opacity-60" /> },
                { id: "blocked", node: <Icon name="pencil-sparkles" size="small" class="!text-v2-icon-icon-accent" /> },
              ]}
            />
          </button>
        </TooltipV2>
      </div>
    </div>
  )
}

export const conceptC: LabConcept = {
  id: "c",
  name: "Turn Instrument",
  tagline: "Trailing-anchored. Grows leftward into the turn while it runs.",
  Control: ConceptCControl,
  hidesLiveRate: true,
  notes: {
    idea:
      "Anchor the control to the composer's trailing edge and let it expand into a segmented instrument " +
      "during a turn: follow-up · elapsed / rate · stop. The trailing 28px never moves or resizes.",
    signal:
      "Fill colour on an invariant square. Black = Send, pale state-bg-danger = Stop, " +
      "with the readout beside it naming the turn in words and numbers rather than asking the glyph to carry it.",
    distinct:
      "The only concept that makes the control carry the turn's telemetry — it takes over the separate " +
      "live-rate footer readout — and the only one that keeps both intents on the pointer while still " +
      "guaranteeing that neither target ever translates.",
    tradeoff:
      "By far the widest footprint: ~150px at full extension, which competes with the model/agent/usage " +
      "controls on a narrow composer. It is also the loudest Stop in the set (a red tint at rest, not just a red mark), " +
      "and it has the most internal state to keep aligned.",
  },
}
