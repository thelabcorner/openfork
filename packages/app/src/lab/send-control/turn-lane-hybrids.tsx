/**
 * Turn Lane hybrids G–K. DEV-ONLY prototypes.
 *
 * All five are the same control: Concept A's dual lane, Concept B's baton
 * choreography, Concept C's elapsed clock. That skeleton lives in
 * `turn-lane-core.tsx` and is imported, not re-typed, so the five are directly
 * comparable.
 *
 * They differ in exactly one decision — **where the Prompt Revisor send-policy
 * menu is triggered from** — and they are deliberately ordered from "most
 * chrome" to "least":
 *
 *   G  Seam Gutter       10px gutter inside the send silhouette      38px
 *   H  Revisor Owns It   trigger relocated to the revisor control    28px
 *   I  Dog-ear           gesture only; a corner fold is the cue      28px
 *   J  Rising Tab        a tab rises above Send on hover/focus       28px
 *   K  Contextual Chip   a chip appears only when policy applies     28 / 44px
 *
 * For reference, today's trigger is an 11x11 chevron carved into the send
 * button's bottom-left corner, and Concept F's 24px cheek — which was too big —
 * made the whole control 52px.
 */

import { createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import type { LabConcept, LabConceptProps } from "./concept"
import {
  LabSendGlyph,
  LabSendMenuContent,
  LabSendTooltip,
  LabTurnGroup,
  SEND_OPTIONS_LABEL,
  useTurnLane,
  type TurnLane,
} from "./turn-lane-core"
import "./turn-lane-disclosures.css"

/** The primary, identical in all five. Only its container differs. */
function Primary(props: {
  lane: TurnLane
  actions: LabConceptProps["actions"]
  onContext?: (event: MouseEvent) => void
  /** Return true to consume the click instead of sending (Concept I). */
  intercept?: (event: MouseEvent) => boolean
}) {
  return (
    <button
      type="button"
      data-lab-tl-send
      data-lab-force={props.lane.forced()}
      data-lab-busy={props.lane.revising() ? "true" : undefined}
      data-lab-action="send"
      aria-label={props.lane.sendLabel()}
      aria-disabled={props.lane.sendDisabled() ? "true" : undefined}
      onClick={(event) => {
        event.preventDefault()
        if (props.intercept?.(event)) return
        props.lane.activateSend()
      }}
      onContextMenu={props.onContext}
    >
      <LabSendGlyph lane={props.lane} />
      <Show when={props.lane.staged()}>
        <span data-lab-tl-staged aria-hidden="true" />
      </Show>
    </button>
  )
}

function PrimaryTooltip(props: { lane: TurnLane; hint?: string; children: unknown }) {
  return (
    <TooltipV2
      placement="top"
      gutter={6}
      inactive={props.lane.sendDisabled() && !props.lane.revising()}
      value={
        <LabSendTooltip
          lane={props.lane}
          hint={props.hint ? <span class="text-v2-text-text-faint">{props.hint}</span> : undefined}
        />
      }
    >
      {props.children as never}
    </TooltipV2>
  )
}

/* ══════════════════════ G — Seam Gutter ═════════════════════════════════════ */

function ConceptGControl(props: LabConceptProps) {
  const lane = useTurnLane(props)
  return (
    <div data-lab-concept="g" data-lab-tl>
      <LabTurnGroup lane={lane} model={props.model} actions={props.actions} />
      <div data-lab-g-group data-lab-g-dim={props.model.composer.unavailable ? "true" : "false"}>
        <MenuV2 gutter={8} modal={false} placement="top-end">
          <TooltipV2 placement="top" gutter={8} inactive={!lane.menuAvailable()} value={SEND_OPTIONS_LABEL}>
            <MenuV2.Trigger
              as="button"
              type="button"
              data-lab-g-gutter
              data-lab-g-armed={lane.armed() ? "true" : "false"}
              data-lab-force={lane.forced()}
              data-lab-action="send-options"
              aria-label={SEND_OPTIONS_LABEL}
              aria-disabled={lane.menuAvailable() ? undefined : "true"}
              tabIndex={lane.menuAvailable() ? undefined : -1}
            >
              <Icon name="chevron-down" size="small" class="!size-[7px]" data-lab-g-chevron />
            </MenuV2.Trigger>
          </TooltipV2>
          <LabSendMenuContent lane={lane} model={props.model} actions={props.actions} />
        </MenuV2>
        <PrimaryTooltip lane={lane}>
          <Primary lane={lane} actions={props.actions} />
        </PrimaryTooltip>
      </div>
    </div>
  )
}

export const conceptG: LabConcept = {
  id: "g",
  name: "Seam Gutter",
  tagline: "Today's idea, corrected: a 10px full-height gutter, not a corner notch.",
  Control: ConceptGControl,
  notes: {
    idea:
      "Keep the disclosure inside the send silhouette, but make it a full-height 10px gutter with a real " +
      "hairline seam instead of an 11x11 chevron carved into the bottom-left corner.",
    signal:
      "The seam. Two surfaces in one silhouette, the gutter recessed under a dark scrim and brightening to " +
      "meet Send on hover. Armed fills the gutter with accent — there is no room for a dot, so the whole " +
      "strip becomes the indicator.",
    distinct:
      "The only one that keeps the disclosure attached to Send. It is the smallest change from today's " +
      "control and the only one where the trigger is always visible and always in the same place.",
    tradeoff:
      "10x28 is still under WCAG 2.5.8's 24px minimum, and it is the widest of the five at 38px. " +
      "The gutter also eats into the black mass of the composer's only filled control.",
  },
}

/* ══════════════════════ H — Revisor Owns It ═════════════════════════════════ */

function ConceptHLeading(props: LabConceptProps) {
  const lane = useTurnLane(props)
  return (
    <div data-lab-concept="h" class="contents">
      <MenuV2 gutter={6} modal={false} placement="top-start">
        <TooltipV2 placement="top" gutter={5} inactive={!lane.menuAvailable()} value={SEND_OPTIONS_LABEL}>
          <MenuV2.Trigger
            as="button"
            type="button"
            data-lab-h-revisor
            data-lab-h-armed={lane.armed() ? "true" : "false"}
            data-lab-force={lane.forced()}
            data-lab-action="send-options"
            aria-label={SEND_OPTIONS_LABEL}
            aria-disabled={lane.menuAvailable() ? undefined : "true"}
            tabIndex={lane.menuAvailable() ? undefined : -1}
          >
            <Icon name="pencil-sparkles" size="small" />
            <Icon name="chevron-down" size="small" class="!size-[7px]" data-lab-h-caret />
          </MenuV2.Trigger>
        </TooltipV2>
        <LabSendMenuContent lane={lane} model={props.model} actions={props.actions} />
      </MenuV2>
    </div>
  )
}

function ConceptHControl(props: LabConceptProps) {
  const lane = useTurnLane(props)
  return (
    <div data-lab-concept="h" data-lab-tl>
      <LabTurnGroup lane={lane} model={props.model} actions={props.actions} />
      <PrimaryTooltip lane={lane}>
        <Primary lane={lane} actions={props.actions} />
      </PrimaryTooltip>
    </div>
  )
}

export const conceptH: LabConcept = {
  id: "h",
  name: "Revisor Owns It",
  tagline: "The menu moves to the revisor control. Send goes back to a clean square.",
  Control: ConceptHControl,
  Leading: ConceptHLeading,
  notes: {
    idea:
      "Stop attaching the menu to Send. Every item in it is about the Prompt Revisor, and the composer " +
      "already has a revisor control in its leading cluster — so put the disclosure there, where there is " +
      "room for a 28px target and a legible armed state.",
    signal:
      "The revisor's own mark, with a caret in its corner. Armed turns that mark accent at full size " +
      "rather than tinting a 7px chevron. Send says nothing about policy because it no longer owns any.",
    distinct:
      "The only one that questions the premise that this menu belongs to Send at all. It is also the only " +
      "one that makes the control *smaller* than today: a bare 28px square with no notch in it.",
    tradeoff:
      "The menu is now far from the button it affects, and 'Stop current generation' ends up on the " +
      "opposite side of the footer from the stop button. Discovery depends on the user connecting the " +
      "revisor control to send behaviour.",
  },
}

/* ══════════════════════ I — Dog-ear ═════════════════════════════════════════ */

const LONG_PRESS_MS = 450

function ConceptIControl(props: LabConceptProps) {
  const lane = useTurnLane(props)
  const [open, setOpen] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Set by a long-press so the click it fires afterwards does not also send. */
  let consumeNextClick = false

  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  onCleanup(cancel)

  /*
   * Deferred by a tick on purpose. Opening synchronously inside the
   * contextmenu/pointer sequence means the rest of that same sequence lands
   * outside the freshly-mounted menu, and Kobalte dismisses it immediately.
   */
  const openMenu = () => {
    if (!lane.menuAvailable()) return
    setTimeout(() => setOpen(true), 0)
  }

  return (
    <div data-lab-concept="i" data-lab-tl>
      <LabTurnGroup lane={lane} model={props.model} actions={props.actions} />
      <MenuV2 gutter={8} modal={false} placement="top-end" open={open()} onOpenChange={setOpen}>
        <div
          data-lab-i-send-wrap
          class="relative flex"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            consumeNextClick = false
            cancel()
            timer = setTimeout(() => {
              consumeNextClick = true
              openMenu()
            }, LONG_PRESS_MS)
          }}
          onPointerUp={cancel}
          onPointerLeave={cancel}
        >
          {/* Anchor only: never painted, never hit. Kobalte positions off it. */}
          <MenuV2.Trigger as="span" data-lab-i-anchor aria-hidden="true" tabIndex={-1} />
          <PrimaryTooltip lane={lane} hint="Right-click, hold, or Alt-click for send options">
            <Primary
              lane={lane}
              actions={props.actions}
              intercept={(event) => {
                if (consumeNextClick) {
                  consumeNextClick = false
                  return true
                }
                if (!event.altKey) return false
                openMenu()
                return true
              }}
              onContext={(event) => {
                if (!lane.menuAvailable()) return
                event.preventDefault()
                event.stopPropagation()
                openMenu()
              }}
            />
          </PrimaryTooltip>
          <span
            data-lab-i-fold
            data-lab-i-armed={lane.armed() ? "true" : "false"}
            data-lab-i-open={open() ? "true" : "false"}
            aria-hidden="true"
          />
        </div>
        <LabSendMenuContent lane={lane} model={props.model} actions={props.actions} />
      </MenuV2>
    </div>
  )
}

export const conceptI: LabConcept = {
  id: "i",
  name: "Dog-ear",
  tagline: "No trigger at all. Right-click, hold, or Alt-click; a folded corner is the cue.",
  Control: ConceptIControl,
  notes: {
    idea:
      "Delete the trigger. The menu opens on right-click, long-press or Alt-click on Send, and the only " +
      "chrome is a 9px folded corner that is paint rather than a target.",
    signal:
      "The fold. It brightens on hover and turns accent when auto-revise is armed, so the one persistent " +
      "state this menu has is still visible without spending a single pixel of layout on a button.",
    distinct:
      "The only one with no second target anywhere — no added width, no extra tab stop, and structurally " +
      "zero chance of a mis-aim sending the prompt, because there is nothing to mis-aim at.",
    tradeoff:
      "Discoverability rests on a tooltip line and a 9px mark. Keyboard users get no path to the menu at " +
      "all unless a binding is added, which would mean inventing one.",
  },
}

/* ══════════════════════ J — Rising Tab ══════════════════════════════════════ */

function ConceptJControl(props: LabConceptProps) {
  const lane = useTurnLane(props)
  return (
    <div data-lab-concept="j" data-lab-tl>
      <LabTurnGroup lane={lane} model={props.model} actions={props.actions} />
      <MenuV2 gutter={6} modal={false} placement="top-end">
        <div data-lab-j-wrap>
          <TooltipV2 placement="top" gutter={6} inactive={!lane.menuAvailable()} value={SEND_OPTIONS_LABEL}>
            <MenuV2.Trigger
              as="button"
              type="button"
              data-lab-j-tab
              data-lab-j-armed={lane.armed() ? "true" : "false"}
              data-lab-j-pinned={lane.armed() ? "true" : "false"}
              data-lab-force={lane.forced()}
              data-lab-action="send-options"
              aria-label={SEND_OPTIONS_LABEL}
              aria-disabled={lane.menuAvailable() ? undefined : "true"}
              tabIndex={lane.menuAvailable() ? undefined : -1}
            >
              <Icon name="chevron-down" size="small" class="!size-[7px]" />
            </MenuV2.Trigger>
          </TooltipV2>
          <PrimaryTooltip lane={lane}>
            <Primary lane={lane} actions={props.actions} />
          </PrimaryTooltip>
        </div>
        <LabSendMenuContent lane={lane} model={props.model} actions={props.actions} />
      </MenuV2>
    </div>
  )
}

export const conceptJ: LabConcept = {
  id: "j",
  name: "Rising Tab",
  tagline: "A tab rises out of Send's top edge on hover or focus. Zero layout cost.",
  Control: ConceptJControl,
  notes: {
    idea:
      "Move the disclosure off the horizontal axis entirely. A 20x13 tab slides up out of the send " +
      "button's top edge when the pointer is already there, or when the group takes keyboard focus.",
    signal:
      "The tab itself, plus the primary staying a clean square. When auto-revise is armed the tab is " +
      "pinned open and turns accent, so a non-default setting is never hidden behind a hover.",
    distinct:
      "The only one that spends vertical space instead of horizontal. It costs nothing at rest, and " +
      "because the tab is above Send rather than beside it, an overshoot lands on the composer, never on " +
      "the primary action.",
    tradeoff:
      "Hover-gated chrome in the highest-frequency control in the app — it will flicker in and out as the " +
      "pointer crosses the footer. It also breaks the button's silhouette, which is the one shape users " +
      "aim at thousands of times.",
  },
}

/* ══════════════════════ K — Contextual Chip ═════════════════════════════════ */

function ConceptKControl(props: LabConceptProps) {
  const lane = useTurnLane(props)
  const present = () => lane.sendable() || lane.turnLive()
  return (
    <div data-lab-concept="k" data-lab-tl>
      <LabTurnGroup lane={lane} model={props.model} actions={props.actions} />
      <MenuV2 gutter={6} modal={false} placement="top-end">
        <TooltipV2 placement="top" gutter={5} inactive={!present() || !lane.menuAvailable()} value={SEND_OPTIONS_LABEL}>
          <MenuV2.Trigger
            as="button"
            type="button"
            data-lab-k-chip
            data-lab-k-present={present() && lane.menuAvailable() ? "true" : "false"}
            data-lab-k-armed={lane.armed() ? "true" : "false"}
            data-lab-force={lane.forced()}
            data-lab-action="send-options"
            aria-label={SEND_OPTIONS_LABEL}
            aria-disabled={present() && lane.menuAvailable() ? undefined : "true"}
            tabIndex={present() && lane.menuAvailable() ? undefined : -1}
          >
            <Icon name="chevron-down" size="small" class="!size-[9px]" data-lab-k-chevron />
          </MenuV2.Trigger>
        </TooltipV2>
        <LabSendMenuContent lane={lane} model={props.model} actions={props.actions} />
      </MenuV2>
      <PrimaryTooltip lane={lane}>
        <Primary lane={lane} actions={props.actions} />
      </PrimaryTooltip>
    </div>
  )
}

export const conceptK: LabConcept = {
  id: "k",
  name: "Contextual Chip",
  tagline: "The disclosure exists only when there is a draft to have a policy about.",
  Control: ConceptKControl,
  notes: {
    idea:
      "Gate the trigger on relevance. An empty composer has no send policy worth opening, so the footer " +
      "shows a bare 28px square; a 16px ghost chip slides in the moment a draft exists or a turn starts.",
    signal:
      "Presence. The chip's existence says 'there is something to send and a choice about how', and it " +
      "goes accent when auto-revise is armed. Send stays a clean square in both cases.",
    distinct:
      "The only one whose trigger is state-dependent. It is free in the state the composer spends most of " +
      "its life in, and it is a comfortable ghost target — outside Send's silhouette — in the state where " +
      "it matters.",
    tradeoff:
      "Chrome that comes and goes beside the most-used button in the app is exactly the kind of motion " +
      "that gets annoying after a thousand uses, and the settings become unreachable when the composer is " +
      "empty — which is when a user is most likely to go looking for them.",
  },
}
