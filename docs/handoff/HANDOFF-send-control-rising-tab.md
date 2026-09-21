# Handoff — Prompt Input V2 send control: "Rising Tab"

**Status:** design selected, ready to implement.
**Selected direction:** Concept **J — Rising Tab**, from the send/stop concept lab.
**Prototype (dev-only, do not ship):** `packages/app/src/lab/send-control/`
**Lab URL while `packages/desktop` dev is running:** `http://[::1]:5173/lab-send-control.html` → rail → **J · Rising Tab**

---

## 1. What is being built

Replace the composer's send/stop affordance with a right-anchored **turn lane**.

```
        ┌─ transient ──────────┐   ┌ permanent ┐
   ●  57 tok/s     4.2s   [ ■ ]          [ ↑ ]
   └ footer rate ┘  clock  baton          send
                                           ▲
                                     [⌄] rising tab (on hover / focus / armed)
```

| Element        | Size      | Lifetime                          | Meaning                        |
| -------------- | --------- | --------------------------------- | ------------------------------ |
| Clock          | 48px      | only while a turn is live         | elapsed wall time for the turn |
| Baton (stop)   | 28×28     | only while a turn is live         | **only ever interrupts**       |
| Primary (send) | 28×28     | always                            | **only ever sends / queues**   |
| Rising tab     | 20×13     | hover, focus-within, or armed     | opens the send-policy menu     |

**Non-negotiable invariants**

1. **The primary never becomes Stop.** Today `stopping = working() && blank()` flips the same button to a stop square. Under this design the baton owns interrupt and the primary is simply *disabled* when there is nothing to send. Keyboard is unchanged (see §6).
2. **The primary never moves.** The lane is right-anchored (`justify-content: flex-end`); the turn group grows leftward. The primary stays 8px from the composer's trailing edge in every phase. No reserved gutter is needed — verified in the prototype across idle / arming / running / stopping / settled.
3. **The turn group collapses to width 0** when idle (`width: 0` **and** `padding-right: 0` — `box-sizing: border-box` floors a 0 width at the padding and will otherwise park a permanent 6px sliver).
4. **The tab costs zero layout width.** It is `position: absolute`, rising out of the primary's top edge.

**Turn group width:** `86px` = clock 48 + gap 4 + baton 28 + trailing 6 (border-box). Declared, not measured — the clock is fixed-width tabular text and measuring it makes the group breathe once a second as digits roll over.

---

## 2. Motion spec (all of it is already in the prototype)

| Moment                    | Behaviour                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Press send                | Arrow launches up out of the button and re-enters from below — 260ms, `lab-launch`            |
| Arming (pre-first-token)  | Baton shows a 1px accent "charge" line filling its bottom edge — `lab-charge`                  |
| Running                   | One 1px dash orbits the baton's perimeter — 2200ms linear, `lab-orbit`, `stroke-dasharray: 24 76` on a `pathLength="100"` rect |
| Stop requested            | Orbit collapses to a closed static ring; the filled square hollows out (same silhouette)       |
| Settled                   | Check mark at 60% opacity; the clock freezes at the final elapsed and dims for ~900ms          |
| **Minimum visible turn**  | **340ms floor.** A turn shorter than that still renders as a turn. Without this, an instant turn strobes send → stop → done → send faster than the eye resolves. |

Budget: glyph swap 120ms · geometry 200ms · enter 140ms / exit 110ms · ambient loop 2200ms.
Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)` in, `cubic-bezier(0.4, 0, 1, 1)` out.

**Reduced motion:** honour `prefers-reduced-motion: reduce`. Flattening durations is not enough for the orbit — a 1ms animation freezes the 24/76 dash as a stub somewhere on the perimeter. Close the ring instead (`stroke-dasharray: none; stroke-dashoffset: 0`) so "a turn is live" still reads with nothing moving.

---

## 3. The bug to fix on the way in

The prototype screenshot shows the accent tab bleeding **through** the dimmed send button. Measured cause:

- The tab tucks **8px under** the primary (`bottom: calc(100% - 4px)`), and is painted *below* it in DOM order.
- The disabled primary uses `opacity: 0.4` — in the prototype from `[data-lab-tl-send][aria-disabled="true"]`, and in production from `packages/ui/src/v2/components/icon-button-v2.css` (`[data-variant="contrast"]:is(:disabled,…) { opacity: 0.4 }`).
- A translucent element shows whatever is painted beneath it. Hence the tab through the button.

**Required fix — do not use `opacity` for this control's disabled state.** Give the primary an explicit *opaque* disabled treatment:

```css
/* opaque, so nothing painted behind the button can show through it */
[data-slot="prompt-send-primary"][aria-disabled="true"] {
  background-image: linear-gradient(
    90deg,
    var(--v2-background-bg-layer-03) 0%,
    var(--v2-background-bg-layer-03) 100%
  );
  color: var(--v2-icon-icon-muted);
  box-shadow: 0 0 0 0.5px var(--v2-border-border-base);
}
```

Plus belt-and-braces stacking so the tuck can never invert:

```css
[data-slot="prompt-send-group"] { isolation: isolate; }
[data-slot="prompt-send-tab"]   { z-index: 0; }
[data-slot="prompt-send-primary"] { position: relative; z-index: 1; }
```

**Do not** fix this by editing `icon-button-v2.css` — that opacity is shared by every contrast icon button in the app. Either scope an override onto this control, or build the primary as a plain `<button>` carrying the same token treatment (the prototype does the latter; see `turn-lane.css` → `[data-lab-tl-send]`).

While you are there: today's control sets the primary's icon to `!text-v2-icon-icon-base` over `--v2-background-bg-contrast`, and `PromptInputV2SubmitButton` in session-ui uses `text-v2-icon-icon-muted` on the same surface — that measures **1.6:1** in dark theme. Use `--v2-icon-icon-contrast` (measured 6.4:1).

---

## 4. Files

**Replace (this is the whole job):**

- `packages/app/src/components/prompt-input-v2.tsx` → `function PromptInputV2SendControl` (~line 822).
  Currently: a `relative size-[30px]` box, a hand-drawn `<svg>` "pocket", an `IconButtonV2` primary, and an **11×11** `MenuV2.Trigger` chevron carved into the bottom-left corner. All of that goes.

**Leave alone:**

- `packages/session-ui/src/v2/components/prompt-input/index.tsx` → `PromptInputV2SubmitButton`. It is only the fallback when no `submitControl` is passed; the app always passes one. (Optionally apply the §3 contrast fix there too.)
- The composer shell, `footerControl` (keep `PromptInputV2LiveRate` — the clock and the rate are different facts and read fine side by side), and the send-policy **menu contents**.

**Read for reference:**

| Prototype file | What it gives you |
| -------------- | ----------------- |
| `packages/app/src/lab/send-control/turn-lane-core.tsx` | `useTurnLane` — every memo you need, incl. the 340ms floor and the launch latch. `LabTurnGroup` — clock + baton, complete. |
| `packages/app/src/lab/send-control/turn-lane.css` | Lane, turn group, baton choreography, primary surface, reduced motion. |
| `packages/app/src/lab/send-control/turn-lane-disclosures.css` | `§ J — Rising Tab` block: the tab's geometry, reveal, and armed pin. |
| `packages/app/src/lab/send-control/turn-lane-hybrids.tsx` | `ConceptJControl` — how the tab, the menu root, and the primary compose. |

The prototype's policy logic already imports the **real** `packages/app/src/components/prompt-input/send-policy.ts`, so `resolvePromptPrimaryAction` / `isPromptTextRevisable` / `promptOneShotRevisionAction` behaviour transfers 1:1. Keep using that module; do not re-derive.

---

## 5. The one open data question — resolve it bottom-up before writing UI

The clock needs the turn's elapsed wall time. **Do not start a `Date.now()` stopwatch in the composer on click.** It would be wrong across remount, reload, session switch, and any turn already in flight when the component mounts, and it violates the ownership rules in `AGENTS.md` ("dense UI consumes projections, it does not reconstruct the runtime").

The authoritative producer already exists: `SessionTelemetry`, consumed via `useServerSync().telemetry` and typed in `packages/schema/src/session-telemetry.ts`. Today `Info` carries:

- `phase`, `phaseStartedAt`
- `step.requestSentAt`, `step.firstTokenAt`, `step.streamedAt`, `step.completedAt`
- `step.generatedMs`, `step.toolMs`, and session-level `generatedMs` / `toolMs`

`packages/app/src/components/prompt-input/live-generation-rate.ts` is the precedent for reading it — including its own warning: *"SessionTelemetry already owns streamed character counters, semantic phase, and generation-only wall time. Do not hydrate messages/parts to reconstruct those facts in the renderer."*

**The gap:** `step.*` is per *provider step*, and a turn with tool loops has many steps, so `step.requestSentAt` resets mid-turn. There is no turn-level start timestamp on the projection.

Pick one, explicitly:

- **(A, recommended)** Add `turnStartedAt` to the telemetry projection at the producer — `packages/core/src/session/telemetry.ts` + `packages/schema/src/session-telemetry.ts` — set when a turn begins and cleared when it settles. Then the clock is `now - turnStartedAt`, correct on mount, and free for every other surface that wants it. Regenerate the SDK afterwards (`bun run build` from `packages/sdk/js`; see `packages/app/AGENTS.md` § API Clients).
- **(B)** Scope the clock to the current step using `step.requestSentAt`, and label it as such. Cheaper, but the number visibly resets mid-turn on tool use — check that is acceptable before choosing it.

Reuse the existing 200ms shared tick (`TICK_MS` in `live-generation-rate.ts`) rather than adding a second timer. One clock, not N.

---

## 6. Behaviour that must not change

- `Enter` → `controller.submit()` → `submitFromPrimary()`, including its `action === "stop"` branch (empty composer + working = stop). **Only the pointer control stops doing that; the keyboard keeps it.**
- `Escape` and `Ctrl+G` while working → stop. Owned by `packages/session-ui/src/v2/components/prompt-input/interaction.ts`. Do not touch.
- `Shift+Enter` → newline.
- Focus restoration: today's control calls `requestAnimationFrame(() => props.controller.restoreFocus())` after activation, and on menu close via `onOpenChange`. Preserve both.
- Shell mode: primary gets `tabIndex={-1}`, and the send-policy menu is unavailable (`menuAvailable = working || mode === "normal"`).
- The send-policy menu keeps its current items, order, disabled rules and strings:
  `prompt.revision.send.stopCurrent` (shortcut `Esc`) · separator · `withRevisor` / `withoutRevisor` one-shot · separator · `autoBeforeSend` · `autoSendAfterRevision`.

---

## 7. Armed state — the reason the tab exists

`autoBeforeSend` means pressing the primary **rewrites the prompt before sending**. Today that is signalled only by tinting an 11px chevron, which is unreadable.

Two distinct signals, both required:

1. **Tab pinned + accent** whenever `autoBeforeSend` is on, so a non-default setting is never hidden behind a hover.
2. **Primary glyph becomes the revisor mark** (`pencil-sparkles`) when `resolvePromptPrimaryAction` actually returns `"revise"` — with a slow opacity breath (2200ms) while `revisionSend.busy()`.

These deliberately disagree when the draft is a slash command: `isPromptTextRevisable` rejects `/…`, so the setting stays armed (tab pinned) while that particular press is a plain send (arrow glyph). Today's control cannot express that at all. Verify this case.

Also keep the staged-revision dot: a 3px accent dot at the primary's top-right when `revisionSend.readyForSend()`.

---

## 8. Accessibility

- Tab is `20×13` — under WCAG 2.5.8's 24px minimum. This was accepted knowingly: it is a secondary disclosure, it is **above** the primary rather than beside it, so an overshoot lands on composer chrome and never on send. Do not "fix" it by widening into the primary's row.
- Tab must be reachable by keyboard. `focus-within` on the wrapper reveals it; it must be a real focusable `<button>` in DOM order before the primary.
- Focus rings: `2px solid var(--v2-border-border-focus)`. The primary keeps `outline-offset: 2.5px`; the tab uses `1px` so the ring is not clipped by the button below it.
- Disabled vs busy are different states. "Nothing to send" and "unavailable" are inert and dim; a revision in flight is **busy** — keep it at full strength with `cursor: progress` and the accent mark, not faded out.
- `aria-label` on the primary must track the resolved action (Send / Send next / Revise and send / Revise before sending / Revising prompt before send…).
- The collapsed turn group must be `inert` so the baton is not reachable when no turn exists.

---

## 9. i18n

`packages/app/AGENTS.md` forbids hardcoded user-visible English. Reuse existing keys where they exist (`prompt.action.send`, `prompt.action.stop`, all of `prompt.revision.send.*`). The prototype's placeholder strings are collected in one marked file — `packages/app/src/lab/send-control/copy.ts` — and each needs a real key before ship:

| Prototype literal | State |
| ----------------- | ----- |
| `Send next` | turn running, composer has a draft (queue) |
| `Stopping…` | stop requested, not yet acknowledged |
| `Starting…` | accepted locally, nothing streamed yet |
| `Done` | turn settled |
| `Unavailable` | no model / disconnected |

Preserve existing English byte-for-byte; only add new keys.

---

## 10. Acceptance checks

Geometry (verified this way in the prototype — measure offsets from the composer form's right edge, not the viewport):

- [ ] Primary is `28×28` and **8px** from the composer's trailing edge in **every** phase: idle, arming, running, stopping, settled.
- [ ] Turn group is `0px` wide when idle and `86px` when live, with no residual sliver.
- [ ] Tab has `opacity: 0` at rest, `1` on hover / focus-within / armed, and never changes the lane's width.

Behaviour:

- [ ] Disabled primary is **opaque** — the tab is not visible through it. (This is the reported bug.)
- [ ] Empty composer + running turn → primary disabled, baton live, `Esc` still stops.
- [ ] Draft + running turn → primary queues, baton still live and clickable.
- [ ] Instant turn (< 340ms) does not strobe; the turn presentation holds for the floor.
- [ ] Slash-command draft with auto-revise armed → tab pinned accent, primary shows the arrow, not the sparkle.
- [ ] Menu opens from the tab with the current six rows while working, four while idle.
- [ ] `prefers-reduced-motion` → no orbit, no launch; the ring is closed and static.
- [ ] Light and dark both pass; primary glyph ≥ 4.5:1 on the contrast surface.

Do **not** ship anything from `packages/app/src/lab/**`, `packages/app/lab-send-control.html`, or `packages/desktop/src/renderer/lab-send-control.*`. They are dev-only and deliberately absent from every Rollup build input.

---

## 11. Out of scope

Concepts A–I and K in the lab; redesigning the send-policy menu itself; the composer's other footer controls; the session-ui fallback button beyond the contrast fix.
