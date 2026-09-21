/**
 * Concept F — Turn Lane. DEV-ONLY prototype.
 *
 * The hybrid: Concept A's dual lane, Concept B's baton choreography, Concept C's
 * elapsed readout — and, unlike any of the first five, a real home for the
 * Prompt Revisor send-policy menu.
 *
 * ── Anatomy, right-anchored ───────────────────────────────────────────────
 *
 *     [ 12.4s ] [ ■ ]        [ ⌄ │ ↑ ]
 *      clock   baton          send group
 *      └─── turn group ───┘   └── permanent ──┘
 *
 * Two objects, two lifetimes, two meanings, and neither one ever changes into
 * the other:
 *
 *   Turn group — transient. Exists only while a turn does. Carries the clock
 *   and the interrupt. Grows leftward, so the send group's distance from the
 *   composer's trailing edge is constant and no gutter has to be reserved
 *   (Concept A held an empty 28px slot open forever; this does not).
 *
 *   Send group — permanent. A split button: the primary half commits, the
 *   24px cheek opens send policy. One silhouette, one elevation, because they
 *   are one control — "send" and "how to send".
 *
 * ── The disclosure ────────────────────────────────────────────────────────
 *
 * Today's trigger is an 11x11 chevron carved into the *inside* of the send
 * button's own silhouette. Three things are wrong with that, and this fixes all
 * three without touching the menu itself:
 *
 *   1. A mis-aim on an 11px target inside the send button sends the prompt.
 *      Here the halves are separate targets in one silhouette, and the cheek is
 *      24x28 — over WCAG 2.5.8's minimum rather than a fifth of it.
 *   2. A 7px chevron in a carved notch does not read as an affordance. A
 *      full-height recessed cheek with a hairline seam does, and it brightens to
 *      meet Send on hover so the relationship is legible before the click.
 *   3. The armed state (auto-revise) was an 11px colour tint. Here it splits
 *      into two honest signals: a 3px accent dot on the cheek for "the setting
 *      is on", and the revisor's own sparkle mark on the primary half for "this
 *      particular press will rewrite first". Those disagree when the draft is a
 *      slash command — which `isPromptTextRevisable` rejects — and today's
 *      control cannot say so at all.
 *
 * The menu's contents are production's, verbatim, from the real dictionary.
 *
 * ── Policy ────────────────────────────────────────────────────────────────
 *
 * The primary half runs the real `resolvePromptPrimaryAction`, with one
 * deliberate departure: it never becomes Stop. The policy returns "stop" exactly
 * when a turn is running and the composer is empty — which is also exactly when
 * there is nothing to send — so here that resolves to a disabled primary and a
 * live baton. Enter keeps production's behaviour untouched.
 */

import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { dict } from "@/i18n/en"
import { isPromptTextRevisable } from "@/components/prompt-input/send-policy"
import { LabGlyphStack, LabQueueGlyph, LabStoppingGlyph } from "./glyphs"
import { LAB_COPY } from "./copy"
import type { LabConcept, LabConceptProps } from "./concept"
import { labCanSubmit, labInterruptible, labOneShot, labSendPolicyAction, labElapsedLabel } from "./types"
import "./concept-f.css"

/** Concept B's floor: a turn shorter than this still gets this much airtime. */
const MIN_VISIBLE_TURN_MS = 340

/** clock 48 + gap 4 + baton 28 + trailing 6 (border-box). */
const TURN_GROUP_WIDTH = 86

type BatonView = "none" | "arming" | "stop" | "stopping" | "settled"

function ConceptFControl(props: LabConceptProps) {
  const i18n = useI18n()
  const phase = () => props.model.turn.phase
  const revisor = () => props.model.revisor
  const shell = () => props.model.composer.mode === "shell"

  // ── Concept B's latch and launch, verbatim ──────────────────────────────
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
    // Settling or already idle, but the floor has not expired: still a turn.
    // An instant turn therefore reads as a turn, not as a flicker.
    if (latched()) return "stop"
    if (current === "settling") return "settled"
    return "none"
  })

  const turnLive = createMemo(() => baton() !== "none")
  const interruptible = createMemo(() => labInterruptible(props.model) || latched())

  // ── the primary half ────────────────────────────────────────────────────
  const action = createMemo(() => labSendPolicyAction(props.model))
  const sendable = createMemo(() => labCanSubmit(props.model))
  const revising = () => revisor().busy
  const staged = () => revisor().readyForSend && !revising()

  const sendDisabled = createMemo(() => {
    if (props.model.composer.unavailable) return true
    if (revising()) return true
    // "stop" from the policy means "a turn is running and there is nothing to
    // send". Here the baton owns that; the primary half simply has no work.
    return !sendable() || action() === "stop"
  })

  const sendGlyph = createMemo(() => {
    if (revising()) return "revise"
    if (action() === "revise") return "revise"
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

  // ── the disclosure ──────────────────────────────────────────────────────
  const [menuOpen, setMenuOpen] = createSignal(false)
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

  const batonGlyph = createMemo(() => {
    if (baton() === "stopping") return "stopping"
    if (baton() === "settled") return "done"
    return "stop"
  })

  return (
    <div data-lab-concept="f" class="min-w-0 shrink-0">
      <div data-lab-f-lane>
        {/* ── turn group: clock + baton ── */}
        <div
          data-lab-f-turn
          data-lab-f-live={turnLive() ? "true" : "false"}
          style={{ width: `${turnLive() ? TURN_GROUP_WIDTH : 0}px` }}
          inert={turnLive() ? undefined : true}
        >
          <span data-lab-f-clock data-lab-f-settled={baton() === "settled" ? "true" : "false"} aria-hidden="true">
            {labElapsedLabel(props.model.turn.elapsedMs)}
          </span>

          <TooltipV2
            placement="top"
            gutter={5}
            inactive={!interruptible()}
            value={
              <span class="flex items-center gap-1.5">
                <span>{batonLabel()}</span>
                <KeybindV2 keys={["Esc"]} variant="ghost" />
              </span>
            }
          >
            <button
              type="button"
              data-lab-f-baton
              data-lab-f-quiet={
                baton() === "arming" || baton() === "stopping" || baton() === "settled" ? "true" : "false"
              }
              data-lab-force={props.model.forced === "none" ? undefined : props.model.forced}
              data-lab-action="interrupt"
              aria-label={batonLabel()}
              aria-disabled={interruptible() ? undefined : "true"}
              tabIndex={turnLive() ? undefined : -1}
              onClick={(event) => {
                event.preventDefault()
                if (!interruptible()) return
                props.actions.stop()
              }}
            >
              {/*
               * Concept B's live edge: one 1px dash orbiting the perimeter. It
               * says "running" without implying a completion percentage the
               * runtime does not have, and it collapses to a closed static ring
               * the moment the interrupt is acknowledged.
               */}
              <svg
                data-lab-f-arc
                data-lab-f-frozen={baton() === "stopping" || baton() === "settled" ? "true" : "false"}
                viewBox="0 0 28 28"
                fill="none"
                aria-hidden="true"
              >
                <rect data-lab-f-track x="0.5" y="0.5" width="27" height="27" rx="7.5" stroke-width="1" />
                <rect
                  data-lab-f-runner
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
              <Show when={baton() === "arming"}>
                <span data-lab-f-charge aria-hidden="true" />
              </Show>

              <LabGlyphStack
                active={batonGlyph}
                items={[
                  { id: "stop", node: <Icon name="stop" size="small" /> },
                  { id: "stopping", node: <LabStoppingGlyph /> },
                  { id: "done", node: <Icon name="check" size="small" class="opacity-60" /> },
                ]}
              />
            </button>
          </TooltipV2>
        </div>

        {/* ── send group: primary + send-policy disclosure ── */}
        <div data-lab-f-send-group data-lab-f-dim={props.model.composer.unavailable ? "true" : "false"}>
          <MenuV2
            gutter={8}
            modal={false}
            placement="top-end"
            open={menuOpen()}
            onOpenChange={(open) => setMenuOpen(open && menuAvailable())}
          >
            <TooltipV2
              placement="top"
              gutter={8}
              inactive={!menuAvailable()}
              value={<span>{dict["prompt.revision.send.options"]}</span>}
            >
              <MenuV2.Trigger
                as="button"
                type="button"
                data-lab-f-cheek
                data-lab-force={props.model.forced === "none" ? undefined : props.model.forced}
                data-lab-action="send-options"
                aria-label={dict["prompt.revision.send.options"]}
                aria-disabled={menuAvailable() ? undefined : "true"}
                tabIndex={menuAvailable() ? undefined : -1}
              >
                <Icon name="chevron-down" size="small" class="!size-[9px]" data-lab-f-chevron />
                {/* "The setting is on" — persistent, and distinct from the
                    primary half's "this press will rewrite first". */}
                <Show when={armed()}>
                  <span data-lab-f-armed aria-hidden="true" />
                </Show>
              </MenuV2.Trigger>
            </TooltipV2>

            {/* The menu itself is production's, unchanged, from the real dictionary. */}
            <MenuV2.Portal>
              <MenuV2.Content>
                <Show when={labInterruptible(props.model)}>
                  <MenuV2.Item shortcut="Esc" onSelect={() => props.actions.stop()}>
                    <span class="text-v2-state-fg-danger">{dict["prompt.revision.send.stopCurrent"]}</span>
                  </MenuV2.Item>
                  <Show when={!shell()}>
                    <MenuV2.Separator />
                  </Show>
                </Show>
                <Show when={!shell()}>
                  <MenuV2.Item disabled={oneShotDisabled()} onSelect={() => props.actions.revisor.oneShot()}>
                    {oneShot() === "send-without-revisor"
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
          </MenuV2>

          <TooltipV2
            placement="top"
            gutter={8}
            inactive={sendDisabled() && !revising()}
            value={
              <span class="flex items-center gap-1.5">
                <span>{sendLabel()}</span>
                <KeybindV2 keys={["Enter"]} variant="ghost" />
              </span>
            }
          >
            <button
              type="button"
              data-lab-f-send
              data-lab-force={props.model.forced === "none" ? undefined : props.model.forced}
              data-lab-action="send"
              aria-label={sendLabel()}
              aria-disabled={sendDisabled() ? "true" : undefined}
              onClick={(event) => {
                event.preventDefault()
                activateSend()
              }}
              /*
               * Right-click opens the same menu. A free, learnable power-user
               * path that adds no chrome and changes no keyboard behaviour.
               */
              onContextMenu={(event: MouseEvent) => {
                if (!menuAvailable()) return
                event.preventDefault()
                setMenuOpen(true)
              }}
            >
              <span data-lab-f-launch={launching() ? "true" : "false"} class="grid place-items-center">
                <LabGlyphStack
                  active={sendGlyph}
                  items={[
                    { id: "send", node: <Icon name="arrow-up" size="small" /> },
                    { id: "queue", node: <LabQueueGlyph /> },
                    { id: "shell", node: <Icon name="arrow-undo-down" size="small" /> },
                    {
                      id: "revise",
                      node: (
                        <Icon name="pencil-sparkles" size="small" data-lab-f-revising={revising() ? "" : undefined} />
                      ),
                    },
                  ]}
                />
              </span>
              {/* A revision is staged and the next press will send it. */}
              <Show when={staged()}>
                <span data-lab-f-staged aria-hidden="true" />
              </Show>
            </button>
          </TooltipV2>
        </div>
      </div>
    </div>
  )
}

export const conceptF: LabConcept = {
  id: "f",
  name: "Turn Lane",
  tagline: "A + B + C, plus a real home for send policy.",
  Control: ConceptFControl,
  notes: {
    idea:
      "Two right-anchored objects with different lifetimes. A transient turn group (elapsed clock + " +
      "Concept B's baton) and a permanent send group built as a split button: primary half commits, " +
      "24px cheek opens send policy. Nothing ever changes into anything else.",
    signal:
      "Position and lifetime, not state decoding. Black filled square on the right is always Send. " +
      "A raised neutral square with a red mark and a 1px orbiting edge only exists while a turn does, " +
      "and only ever stops it. The clock beside it says how long it has been running.",
    distinct:
      "It keeps A's two permanent meanings without A's permanently reserved gutter — right-anchoring makes " +
      "the reservation unnecessary, so an idle composer pays 52px instead of 84px. It keeps B's full " +
      "choreography (launch, charge, orbit, freeze, 340ms floor) and C's elapsed readout, but drops C's " +
      "capsule. And it is the only one that solves the Prompt Revisor disclosure: a 24x28 cheek instead of " +
      "an 11x11 notch carved inside the send button.",
    tradeoff:
      "The send group is 52px at rest versus today's 30px, and the black silhouette is the heaviest " +
      "element in the footer. The armed state now speaks twice — a dot on the cheek and a sparkle mark on " +
      "Send — which is precise but is two things to learn instead of one.",
    deviation:
      'The primary half never becomes Stop. The real policy still runs, but its "stop" outcome (turn ' +
      "running, composer empty) resolves to a disabled primary and a live baton instead. Enter, Escape and " +
      "Ctrl+G are untouched.",
  },
}
