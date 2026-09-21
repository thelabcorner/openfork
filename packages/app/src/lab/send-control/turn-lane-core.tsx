/**
 * Shared core for the Turn Lane hybrids (G–K). DEV-ONLY.
 *
 * Every one of them is the same agreed skeleton:
 *
 *     [ 12.4s ] [ ■ ]      [ ↑ ]
 *      clock   baton       send
 *      └── turn group ──┘  └ permanent ┘
 *
 *   · Concept A's dual lane — Send only ever sends, the baton only ever stops,
 *     and neither turns into the other. Right-anchored, so the turn group grows
 *     leftward and Send never moves a pixel.
 *   · Concept B's choreography — launch, charge, orbit, freeze, and the 340ms
 *     minimum-visible-turn floor.
 *   · Concept C's one good part — the elapsed clock, and nothing else from it.
 *
 * They differ in exactly one thing: **where the Prompt Revisor send-policy menu
 * is triggered from.** That is the variable under test, so it is the only thing
 * that should vary. Everything above lives here, once.
 *
 * The menu's contents are production's, verbatim, from the real dictionary.
 */

import { createEffect, createMemo, createSignal, on, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { dict } from "@/i18n/en"
import { isPromptTextRevisable } from "@/components/prompt-input/send-policy"
import { LabGlyphStack, LabQueueGlyph, LabStoppingGlyph } from "./glyphs"
import { LAB_COPY } from "./copy"
import type { LabConceptProps } from "./concept"
import { labCanSubmit, labElapsedLabel, labInterruptible, labOneShot, labSendPolicyAction } from "./types"
import "./turn-lane.css"

/** Concept B's floor: a turn shorter than this still gets this much airtime. */
const MIN_VISIBLE_TURN_MS = 340

/** clock 48 + gap 4 + baton 28 + trailing 6 (border-box). */
export const TURN_GROUP_WIDTH = 86

type BatonView = "none" | "arming" | "stop" | "stopping" | "settled"

export type TurnLane = ReturnType<typeof useTurnLane>

export function useTurnLane(props: LabConceptProps) {
  const i18n = useI18n()
  const phase = () => props.model.turn.phase
  const revisor = () => props.model.revisor
  const shell = () => props.model.composer.mode === "shell"

  // ── Concept B's latch and launch ────────────────────────────────────────
  const [latched, setLatched] = createSignal(false)
  const [launching, setLaunching] = createSignal(false)
  let latch: ReturnType<typeof setTimeout> | undefined
  let launch: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (latch) clearTimeout(latch)
    if (launch) clearTimeout(launch)
  })

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

  const baton = createMemo<BatonView>(() => {
    const current = phase()
    if (current === "stopping") return "stopping"
    if (current === "arming") return "arming"
    if (current === "running") return "stop"
    // Settling or already idle, but the floor has not expired: still a turn. An
    // instant turn therefore reads as a turn rather than as a flicker.
    if (latched()) return "stop"
    if (current === "settling") return "settled"
    return "none"
  })

  const turnLive = createMemo(() => baton() !== "none")
  const interruptible = createMemo(() => labInterruptible(props.model) || latched())

  // ── the primary ─────────────────────────────────────────────────────────
  const action = createMemo(() => labSendPolicyAction(props.model))
  const sendable = createMemo(() => labCanSubmit(props.model))
  const revising = () => revisor().busy
  const staged = () => revisor().readyForSend && !revising()

  const sendDisabled = createMemo(() => {
    if (props.model.composer.unavailable) return true
    if (revising()) return true
    // The policy's "stop" means "a turn is running and there is nothing to
    // send". Here the baton owns that; the primary simply has no work.
    return !sendable() || action() === "stop"
  })

  const sendGlyph = createMemo(() => {
    if (revising() || action() === "revise") return "revise"
    if (shell()) return "shell"
    if (turnLive() && sendable()) return "queue"
    return "send"
  })

  const sendLabel = createMemo(() => {
    if (props.model.composer.unavailable) return LAB_COPY.unavailable
    if (revising()) return dict["prompt.revision.send.revising"]
    if (action() === "revise") {
      return revisor().autoSendAfterRevision
        ? dict["prompt.revision.send.reviseAndSend"]
        : dict["prompt.revision.send.reviseBeforeSend"]
    }
    if (turnLive() && sendable()) return LAB_COPY.queue
    return i18n.t("ui.promptInput.send")
  })

  const activateSend = () => {
    if (sendDisabled()) return
    if (action() === "revise") {
      props.actions.revisor.revise()
      return
    }
    props.actions.send()
  }

  // ── send policy ─────────────────────────────────────────────────────────
  // Mirrors production's `menuAvailable`: shell mode has no send policy, but an
  // in-flight turn still has something to offer.
  const menuAvailable = createMemo(() => labInterruptible(props.model) || !shell())
  const armed = createMemo(() => revisor().autoBeforeSend && !shell())
  const oneShot = createMemo(() => labOneShot(props.model))
  const oneShotDisabled = createMemo(
    () => !sendable() || revising() || (oneShot() === "send-with-revisor" && !isPromptTextRevisable(revisor().draft)),
  )

  const batonLabel = createMemo(() => {
    if (baton() === "stopping") return LAB_COPY.stopping
    if (baton() === "arming") return LAB_COPY.starting
    if (baton() === "settled") return LAB_COPY.done
    return i18n.t("ui.promptInput.stop")
  })

  const forced = () => (props.model.forced === "none" ? undefined : props.model.forced)

  return {
    baton,
    batonLabel,
    turnLive,
    interruptible,
    launching,
    action,
    sendable,
    revising,
    staged,
    sendDisabled,
    sendGlyph,
    sendLabel,
    activateSend,
    menuAvailable,
    armed,
    oneShot,
    oneShotDisabled,
    forced,
    shell,
  }
}

/** Clock + baton. Collapses to zero width when no turn owns the session. */
export function LabTurnGroup(props: {
  lane: TurnLane
  model: LabConceptProps["model"]
  actions: LabConceptProps["actions"]
}) {
  const lane = props.lane
  return (
    <div
      data-lab-tl-turn
      data-lab-tl-live={lane.turnLive() ? "true" : "false"}
      style={{ width: `${lane.turnLive() ? TURN_GROUP_WIDTH : 0}px` }}
      inert={lane.turnLive() ? undefined : true}
    >
      <span data-lab-tl-clock data-lab-tl-settled={lane.baton() === "settled" ? "true" : "false"} aria-hidden="true">
        {labElapsedLabel(props.model.turn.elapsedMs)}
      </span>

      <TooltipV2
        placement="top"
        gutter={5}
        inactive={!lane.interruptible()}
        value={
          <span class="flex items-center gap-1.5">
            <span>{lane.batonLabel()}</span>
            <KeybindV2 keys={["Esc"]} variant="ghost" />
          </span>
        }
      >
        <button
          type="button"
          data-lab-tl-baton
          data-lab-tl-quiet={
            lane.baton() === "arming" || lane.baton() === "stopping" || lane.baton() === "settled" ? "true" : "false"
          }
          data-lab-force={lane.forced()}
          data-lab-action="interrupt"
          aria-label={lane.batonLabel()}
          aria-disabled={lane.interruptible() ? undefined : "true"}
          tabIndex={lane.turnLive() ? undefined : -1}
          onClick={(event) => {
            event.preventDefault()
            if (!lane.interruptible()) return
            props.actions.stop()
          }}
        >
          {/*
           * Concept B's live edge: one 1px dash orbiting the perimeter. It says
           * "running" without implying a completion percentage the runtime does
           * not have, and it collapses to a closed static ring the moment the
           * interrupt is acknowledged.
           */}
          <svg
            data-lab-tl-arc
            data-lab-tl-frozen={lane.baton() === "stopping" || lane.baton() === "settled" ? "true" : "false"}
            viewBox="0 0 28 28"
            fill="none"
            aria-hidden="true"
          >
            <rect data-lab-tl-track x="0.5" y="0.5" width="27" height="27" rx="7.5" stroke-width="1" />
            <rect
              data-lab-tl-runner
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

          {/* Accepted locally, nothing streamed yet: a literal charging edge. */}
          <Show when={lane.baton() === "arming"}>
            <span data-lab-tl-charge aria-hidden="true" />
          </Show>

          <LabGlyphStack
            active={() => (lane.baton() === "stopping" ? "stopping" : lane.baton() === "settled" ? "done" : "stop")}
            items={[
              { id: "stop", node: <Icon name="stop" size="small" /> },
              { id: "stopping", node: <LabStoppingGlyph /> },
              { id: "done", node: <Icon name="check" size="small" class="opacity-60" /> },
            ]}
          />
        </button>
      </TooltipV2>
    </div>
  )
}

/** The primary's glyph stack, including Concept B's launch. */
export function LabSendGlyph(props: { lane: TurnLane }) {
  return (
    <span data-lab-tl-launch={props.lane.launching() ? "true" : "false"} class="grid place-items-center">
      <LabGlyphStack
        active={props.lane.sendGlyph}
        items={[
          { id: "send", node: <Icon name="arrow-up" size="small" /> },
          { id: "queue", node: <LabQueueGlyph /> },
          { id: "shell", node: <Icon name="arrow-undo-down" size="small" /> },
          {
            id: "revise",
            node: (
              <Icon name="pencil-sparkles" size="small" data-lab-tl-revising={props.lane.revising() ? "" : undefined} />
            ),
          },
        ]}
      />
    </span>
  )
}

/** Tooltip body for the primary: label plus the key that does the same thing. */
export function LabSendTooltip(props: { lane: TurnLane; hint?: JSX.Element }) {
  return (
    <span class="flex flex-col items-start gap-1">
      <span class="flex items-center gap-1.5">
        <span>{props.lane.sendLabel()}</span>
        <KeybindV2 keys={["Enter"]} variant="ghost" />
      </span>
      <Show when={props.hint}>{props.hint}</Show>
    </span>
  )
}

/**
 * The send-policy menu body. Production's items, production's strings, in
 * production's order. Every hybrid wires its own `MenuV2` root and trigger
 * around this — the trigger is the variable, the menu is not.
 */
export function LabSendMenuContent(props: {
  lane: TurnLane
  model: LabConceptProps["model"]
  actions: LabConceptProps["actions"]
}) {
  const revisor = () => props.model.revisor
  return (
    <MenuV2.Portal>
      <MenuV2.Content>
        <Show when={labInterruptible(props.model)}>
          <MenuV2.Item shortcut="Esc" onSelect={() => props.actions.stop()}>
            <span class="text-v2-state-fg-danger">{dict["prompt.revision.send.stopCurrent"]}</span>
          </MenuV2.Item>
          <Show when={!props.lane.shell()}>
            <MenuV2.Separator />
          </Show>
        </Show>
        <Show when={!props.lane.shell()}>
          <MenuV2.Item disabled={props.lane.oneShotDisabled()} onSelect={() => props.actions.revisor.oneShot()}>
            {props.lane.oneShot() === "send-without-revisor"
              ? dict["prompt.revision.send.withoutRevisor"]
              : dict["prompt.revision.send.withRevisor"]}
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.CheckboxItem
            checked={revisor().autoBeforeSend}
            onSelect={() => props.actions.revisor.setAutoBeforeSend(!revisor().autoBeforeSend)}
          >
            {dict["prompt.revision.send.autoBeforeSend"]}
          </MenuV2.CheckboxItem>
          <MenuV2.CheckboxItem
            checked={revisor().autoSendAfterRevision}
            disabled={!revisor().autoBeforeSend}
            onSelect={() => props.actions.revisor.setAutoSendAfterRevision(!revisor().autoSendAfterRevision)}
          >
            {dict["prompt.revision.send.autoSendAfterRevision"]}
          </MenuV2.CheckboxItem>
        </Show>
      </MenuV2.Content>
    </MenuV2.Portal>
  )
}

export const SEND_OPTIONS_LABEL = dict["prompt.revision.send.options"]

/** Shared accessor bundle so a concept can keep its own menu open-state. */
export function useMenuState(available: Accessor<boolean>) {
  const [open, setOpen] = createSignal(false)
  return { open, setOpen: (next: boolean) => setOpen(next && available()) }
}
