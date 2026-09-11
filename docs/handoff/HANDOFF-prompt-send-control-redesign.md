# Handoff — Redesign the composer Send/Stop control ("split button" replacement)

- **Date:** 2026-09-09
- **Sending agent:** Claude Opus 5 (research + spec, no code written)
- **Receiving agent:** design agent (visual design + UI implementation)
- **Repo:** `opencode`, branch `main`
- **Anchor component:** `PromptInputV2SendControl` — `packages/app/src/components/prompt-input-v2.tsx:869-1050`
- **Trust level:** every path, line number, token name, and behavioral claim in §2–§4 was
  read off disk during this session. §5 onward (concepts, recommendation, motion spec) is
  design synthesis — it is a proposal, not user-confirmed. §6 is the one part the user
  must sign off on before implementation.

---

## 1. The brief, in the user's words

> "i like the current start/stop split button but i dont at the same time, specifically
> the split button is what i am not liking; it just feels awkward."
>
> "i don't want it to necessarily be just like a normal split button, I want it to be
> premium, unique ui."

Three screenshots were attached showing the control in its three visible resting states:

1. `● 3 tok/s` + light stop-square glyph in the notched pill (streaming, empty draft)
2. `● 0 tok/s` + up-arrow glyph (idle / draft present)
3. `● 0 tok/s` + **red** stop-square glyph (stop state, danger foreground)

### How to read the ask

The user is **not** asking to remove the secondary menu, and **not** asking to fix Send
or Stop individually. They are objecting to the *split-button form factor* — the notched,
two-target, one-contour blob. Two things are true at once and both must survive:

- **Keep:** a single-glyph primary affordance at the composer's trailing edge, with the
  Send↔Stop identity change, and access to send options / stop-current.
- **Change:** the geometry and interaction model. "Not necessarily a normal split button"
  is explicit permission to abandon the adjacent-segments pattern entirely. "Premium,
  unique" means the replacement should be a signature interaction — something a user would
  screenshot — not a Bootstrap dropdown-button.

**Do not** interpret "premium" as "add a gradient and a glow." Premium here means: one
continuous piece of geometry, motion that carries state rather than decorating it, zero
visible seams, and an interaction that resolves the awkwardness rather than restyling it.

---

## 2. Verified current implementation

### 2.1 Where it lives

| Path | Role |
|---|---|
| `packages/app/src/components/prompt-input-v2.tsx:869-1050` | `PromptInputV2SendControl` — **the component to redesign** |
| `packages/app/src/components/prompt-input-v2.tsx:154` | Mounted as the `submitControl` slot prop |
| `packages/app/src/components/prompt-input-v2.tsx:1052-1115` | `PromptInputV2LiveRate` — the `● N tok/s` readout immediately to its left (`footerControl`, line 160) |
| `packages/app/src/components/prompt-input/send-policy.ts` | Pure state machine: `resolvePromptPrimaryAction`, `promptOneShotRevisionAction`, `isPromptTextRevisable` |
| `packages/app/src/components/prompt-input/send-policy.test.ts` | Unit tests for the above |
| `packages/session-ui/src/v2/components/prompt-input/index.tsx:252-334` | The 44px footer bar (`h-11`) that lays out left controls → live rate → submit slot |
| `packages/session-ui/src/v2/components/prompt-input/index.tsx:1052-1092` | `PromptInputV2SubmitButton` — **unused fallback** (app always passes `submitControl`). Style reference only; changing it does not affect the app. |
| `packages/ui/src/v2/components/icon-button-v2.tsx` | `IconButtonV2` — `size: small\|normal\|large`, `variant: neutral\|contrast\|ghost\|ghost-muted` |
| `packages/ui/src/v2/components/icon.tsx:294-301` | `Icon` — `size: small (14px) \| normal (16px) \| large (20px)` |
| `packages/ui/src/v2/styles/theme.css` | 419 `--v2-*` design tokens; light, dark, and high-contrast blocks |
| `packages/app/src/i18n/en.ts:973-976, 1034-1035, 1891-1901` | All strings for this control |

### 2.2 The current geometry (this is the thing being rejected)

Container: `class="relative h-[30px] w-[46px] shrink-0"` with `data-prompt-send-split=""`.

The surface is drawn **once** as an inline `<svg viewBox="0 0 46 30">` at
`prompt-input-v2.tsx:926-941`, with a single path:

```
M24 0.5H38C42.142 0.5 45.5 3.858 45.5 8V22C45.5 26.142 42.142 29.5 38 29.5H8
C3.858 29.5 0.5 26.142 0.5 22V14.5H15.5V8C15.5 3.858 18.858 0.5 24 0.5Z
```

That is an **L-shaped / notched rounded rect**: a 30×30 Send body on the right, plus an
18×15 "ear" hanging off the bottom-left. Fill `--v2-background-bg-layer-02`, stroke
`--v2-border-border-muted` at 1px, plus `drop-shadow(0 1px 2px …bg-deep 38%)`.

Two independent `<button>`s are absolutely positioned on top of it, both `!bg-transparent`
`!shadow-none` so the SVG is the only visible chrome:

- Primary: `IconButtonV2` `size="large"`, `!size-[30px]`, `!rounded-[8px]`, `absolute right-0 top-0 z-[3]`
- Disclosure: `MenuV2.Trigger as={IconButtonV2}` `size="small"`, `!h-[15px] !w-[18px]`,
  `!rounded-none !rounded-l-[8px]`, `absolute bottom-0 left-0 z-[2]`, chevron-down at `size-2.5`

The code comment at `:922-924` states the intent honestly: *"One continuous contour … Drawing
the surface once avoids internal seams/double borders while preserving two independent hit targets."*

### 2.3 Why it reads as awkward (diagnosis — act on this)

1. **Non-orthogonal silhouette.** Every other control in the 44px footer is a circle or a
   rounded rect. This one is an L. It is the only shape in the composer that does not tile,
   and the notch points *into* the live-rate readout, so the negative space between `tok/s`
   and the button is a wedge rather than a gap.
2. **The ear is undersized and off-axis.** 18×15 CSS px is well under the 24px minimum
   comfortable pointer target and roughly half the primary's height. Anchoring it at
   *bottom-left* puts the disclosure diagonally opposite the icon's optical center, so the
   composite has no shared axis — the eye can't decide where the control's center is.
3. **Two hit targets, one surface, no seam.** The seamlessness that was engineered to look
   clean actively hurts affordance: there is no visual boundary telling you where Send stops
   and "options" begins, so the whole thing feels like one button that sometimes does the
   wrong thing on click. This is the specific source of "awkward."
4. **Weight inversion in the Stop state.** During streaming the primary is the *most* urgent
   thing on screen, but it renders as `variant="ghost"` on a low `bg-layer-02` fill — quieter
   than the neutral `bg-contrast` gradient the unused fallback button uses. Screenshot 3's
   red glyph is the only urgency signal, and it's 14px.
5. **The menu is mostly latent.** Four of its five items are Prompt-Revisor settings that
   change maybe twice in a user's lifetime; only "Stop current generation" is situational.
   The disclosure ear therefore pays permanent geometric cost for near-zero daily use.

---

## 3. The behavioral contract — do not break any of this

### 3.1 The primary-action state machine

`resolvePromptPrimaryAction` (`send-policy.ts:14-33`) resolves **in this order**:

| # | Condition | Action | Glyph today | Label key |
|---|---|---|---|---|
| 1 | `revisionBusy` | `"blocked"` | `PromptRevisionBusyIcon` (animated) | `prompt.revision.send.revising` |
| 2 | `awaitingClarification` | `"clarify"` | `pencil-sparkles`, accent color | `prompt.revision.send.needsInput` |
| 3 | `working && !canSubmit` | `"stop"` | `stop`, `!text-v2-state-fg-danger` | `prompt.action.stop` |
| 4 | normal mode + `canSubmit` + revisable text + `autoReviseBeforeSending` + not already revised | `"revise"` | `pencil-sparkles` | `prompt.revision.send.reviseAndSend` / `.reviseBeforeSend` |
| 5 | otherwise | `"submit"` | `arrow-up` (normal) / `arrow-undo-down` (shell) | `prompt.action.send` |

**That is five primary states, not two.** Any redesign must render all five distinctly. The
current design already struggles here — states 1, 2, and 4 all live in the same 30px box
with only a glyph swap. This is an opportunity, not just a constraint.

**Critical subtlety:** `"stop"` requires `working && !canSubmit`. `canSubmit` is driven by
`blank()` (`prompt-input-v2.tsx:1348-1351`: no text, no attachments, no comments). So while
a generation streams:

- **empty draft → button is Stop**
- **user starts typing → button flips back to Send** (the message queues), and stopping is
  only reachable via `Esc` or the menu's "Stop current generation"

This flip is invisible and unexplained today. The redesign should make "there is a live
generation AND you have a draft" a legible situation rather than a silent identity swap.

### 3.2 Disabled logic

`primaryDisabled()` (`:894-895`) = `action === "blocked"` OR (`!canSubmit` and action is
neither `stop` nor `clarify`). `tabIndex` is `-1` whenever `mode !== "normal"` (shell mode).

### 3.3 The secondary menu contents

`MenuV2`, `placement="top-start"`, `gutter={6}`, `modal={false}`, refocuses the editor on
close (`:996-1000`). Trigger is disabled unless `working() || mode() === "normal"`.

| Item | Visibility | Notes |
|---|---|---|
| Stop current generation | only when `working()` | `shortcut="Esc"`, `text-v2-state-text-danger` |
| Send with / without Prompt Revisor | normal mode | one-shot inverse of the current auto setting (`promptOneShotRevisionAction`) |
| ☑ Auto-revise before sending | normal mode | persisted setting |
| ☑ Auto-send after revising | normal mode | disabled unless the above is checked |

The disclosure also carries a **status** job: it renders `!text-v2-icon-icon-accent` when
`autoRevise() && mode === "normal"`, otherwise `!text-v2-icon-icon-faint`. That accent tint
is currently the *only* persistent indicator that auto-revise is armed. Preserve that signal
in whatever replaces the ear.

### 3.4 Hard contracts (breaking these breaks tests or a11y)

- **Accessible names are load-bearing for e2e.** These specs select by role name:
  - `packages/app/e2e/regression/session-timeline-history-root.spec.ts:179,192,203` → `getByRole("button", { name: "Stop", exact: true })`
  - `packages/app/e2e/regression/session-todo-dock-navigation.spec.ts:76` → same
  - `packages/app/e2e/regression/goal-mode-lifecycle.spec.ts:416` → `getByRole("button", { name: "Send" })`

  The primary must remain a single `<button>` whose accessible name is exactly `Stop` in the
  stop state and starts with `Send` in the submit state. If the redesign merges the two
  buttons, **the merged element must still expose those names**, or those specs need updating
  in the same change.
- `data-action="prompt-submit"` and `data-action="prompt-send-options"` — currently no app
  e2e spec depends on them (`prompt-input.tsx:1684` is the legacy v1 composer, unrelated),
  but keep them; they're cheap and they're the natural hook for new tests.
- Keyboard: `Enter` submits from the editor (`session-ui/.../index.tsx:230`). `Esc` stops.
  Tab order must reach the primary, then the secondary, and must skip both in shell mode.
- After any click or menu close, focus returns to the editor via
  `requestAnimationFrame(() => controller.restoreFocus())`. Non-negotiable — losing it breaks
  the type→send→type flow.
- All five states need a tooltip (`TooltipV2 placement="top" gutter={4}`) and an `aria-label`.

---

## 4. Design system constraints

- **Framework:** SolidJS + Tailwind. No React. Use `class`/`classList`, `Show`, `createMemo`.
- **Tokens only.** Never hardcode a hex. Relevant tokens (all in
  `packages/ui/src/v2/styles/theme.css`, defined in light, dark, and high-contrast blocks):
  - Surfaces: `--v2-background-bg-layer-02`, `--v2-background-bg-contrast`, `--v2-background-bg-deep`
  - Borders: `--v2-border-border-muted`, `--v2-border-border-strong`
  - Icon fg: `--v2-icon-icon-base`, `--v2-icon-icon-muted`, `--v2-icon-icon-faint`, `--v2-icon-icon-accent`
  - State: `--v2-state-fg-danger`, `--v2-state-text-danger`
  - Elevation: `--v2-elevation-button-neutral`, `--v2-elevation-button-contrast`
  - Alpha ramps: `--v2-alpha-light-{0,6,8,20}`, `--v2-alpha-dark-{4,8,40}`
  - Overlay: `--v2-overlay-simple-overlay-hover`
- **Blend, don't tint:** the codebase derives colors with
  `color-mix(in srgb, var(--token) N%, …)` (see `titlebar.tsx:788`). Follow that; it keeps
  theme switching correct.
- **Motion:** every animated element in this repo pairs with `motion-reduce:transition-none`
  or a `prefers-reduced-motion` guard. See `titlebar.tsx:785-794` (width/opacity/translate,
  `duration-150 ease-out`) and `layout.tsx:2380` (`cubic-bezier(0.22,1,0.36,1)`, 200–240ms)
  for the house easing vocabulary. `prompt-input-v2.tsx:547-548` shows the JS-side
  `matchMedia("(prefers-reduced-motion: reduce)")` pattern for non-CSS animation.
- **Precedent for bespoke SVG:** `PromptRevisionBusyIcon` (`prompt-input-v2.tsx:398-440`) is
  a hand-authored SVG with randomized sparkle cadence and an explicit comment about wanting
  *organic, non-synchronized* motion. That is the aesthetic north star for "premium" in this
  codebase — restrained, irregular, no spinner clichés. Match that bar.
- **Available icons are limited** (`packages/ui/src/v2/components/icon.tsx` registry).
  `stop`, `arrow-up`, `arrow-undo-down`, `chevron-down`, `pencil-sparkles` are confirmed in
  use. Anything new must be authored into that registry or drawn inline.
- **Size budget:** the footer bar is `h-11` (44px) with `px-2`. The control currently occupies
  46×30. There is roughly **36px of vertical headroom**, and horizontal room can be taken from
  the live-rate gap — but the live rate must stay legible; it is the only streaming-throughput
  signal in the UI.

---

## 5. Concept directions

Four directions, ordered by how far they move from the current pattern. Each is a genuine
answer to "premium and unique," not a restyle. Prototype two or three; don't silently pick one.

### A. Morphing capsule — *one target, zero disclosure at rest*

Kill the second hit target at rest. The control is a single clean 30–32px rounded square. The
five states are expressed by **morphing the glyph and the fill**, not by adding chrome:

- Submit: arrow-up on `bg-contrast`, standard elevation.
- Stop: the capsule **elongates** to ~46px and its fill becomes a live surface — the tok/s
  rate literally drives a subtle internal shimmer or left-to-right sweep whose period maps to
  throughput. Square glyph centered. Danger color applies to the glyph on hover/focus
  (matching screenshot 3 as the *hover* state).
- Revise: accent hairline + `pencil-sparkles` glyph.
- Options: revealed **on hover/focus only**, as a chevron that fades in on the leading edge
  and nudges the glyph 2px trailing — or bound entirely to right-click plus a shortcut.

Pros: solves every diagnosed problem at once; silhouette becomes orthogonal; the tok/s readout
can be absorbed into the button, reclaiming footer space. Cons: hidden disclosure is a
discoverability risk — mitigate with a first-run hint and by keeping the menu on right-click.
**Highest ceiling.**

### B. Stacked rail — *rotate the split 90°*

Keep two targets but stack them vertically inside one 30×30 capsule: a 22px primary cap on top
and an 8px full-width "grip" strip along the bottom edge with a chevron or three-dot grip.
Because the grip spans the full width and shares the vertical axis with the glyph, the
composite has one center and one silhouette (a plain rounded rect).

Pros: minimal behavioral change, preserves both targets, fixes the L-shape and the axis
problem. Cons: 8px is a smaller target than today's 15px — must expand the hit area with a
transparent `::before` padding box. **Lowest risk, lowest ceiling.**

### C. Radial / press-and-hold — *the signature interaction*

Single circular target. Tap = primary action. **Press-and-hold ~350ms** blooms the button into
a small radial menu of the 2–4 relevant options arranged in an arc above it, with a ring that
fills during the hold as a progress affordance. Release over an option commits it; release in
place commits the primary.

Pros: genuinely unique, feels expensive, zero permanent chrome cost, and the hold-ring doubles
as the "revising" progress indicator for state 1. Cons: press-and-hold is undiscoverable to
mouse users and needs a keyboard equivalent (`Alt+↵` or a context menu); highest implementation
cost. **Most "premium," most risk.** If chosen it must be additive — keep right-click → standard
menu as the accessible path.

### D. Contextual segment — *the split only exists when it's useful*

A plain single capsule ~95% of the time. The disclosure segment **only materializes** when the
menu has something situational to say — `working()` is true (so "Stop current generation"
exists) or `awaitingClarification()`. The Prompt-Revisor preference toggles move out to the
existing revision control (`PromptInputV2RevisionControl`, mounted at `prompt-input-v2.tsx:153`)
or to settings, where they belong.

Pros: directly attacks diagnosis #5 — the geometry stops paying rent for latent options. Cons:
a control that changes width mid-stream can shift the live-rate readout; needs reserved width
or a grow-from-edge animation to avoid layout jitter. Requires a small IA decision (moving the
two checkbox items). **Best cost/benefit if the user agrees to relocate the revisor settings.**

---

## 6. Recommendation, and what needs the user's sign-off

**Recommend: A as the visual language + D as the information architecture.**

Concretely: a single orthogonal capsule that morphs across the five states; the disclosure
segment appears only when it has situational content (working / clarify) and otherwise on
hover-focus; the two persistent Prompt-Revisor checkboxes relocate. That combination fixes all
five diagnosed problems, and the "premium" comes from the state morph and the
throughput-driven Stop surface rather than from added ornament.

**Ask the user before building:**

1. **Disclosure at rest — hidden, hover-revealed, or always present?** This is the whole
   ballgame and it's a taste call.
2. **Can the two auto-revise checkboxes move out of this menu** (to the revision control or
   settings)? Direction D depends on it.
3. **Is a press-and-hold interaction (C) desirable or gimmicky** for this product?
4. **Should the `tok/s` readout be absorbed into the Stop state** or stay a separate sibling?
   Absorbing it is the strongest single "premium" move available and reclaims ~60px of footer
   width — but it makes the button change width, which is a real cost.

---

## 7. Spec requirements for whichever direction wins

### States to design (all five, plus modifiers)

| State | Trigger | Must communicate |
|---|---|---|
| Submit (normal) | default with text | "press this to send" |
| Submit (shell) | `mode === "shell"` | shell submission — `arrow-undo-down` glyph today; note the whole left control group is `inert` in shell mode |
| Submit-while-working | `working && canSubmit` | **currently indistinguishable from plain submit.** Must read as "queue this after the current run" |
| Revise | auto-revise armed | that the prompt will be rewritten first; `reviseAndSend` vs `reviseBeforeSend` differ |
| Clarify | `awaitingClarification` | the revisor is blocked on user input — a *prompt to act*, currently just an accent glyph |
| Blocked / busy | `revisionBusy` | in-progress work; today the animated `PromptRevisionBusyIcon`. Keep or supersede |
| Stop | `working && !canSubmit` | urgency; today the only signal is a 14px red glyph — under-weighted |
| Disabled | `!canSubmit`, none of the above | non-actionable without looking broken |
| Auto-revise armed | `autoRevise && normal` | persistent accent tint (currently on the chevron) — must survive |

Also design: hover, active/pressed, `focus-visible` ring, and all of the above in **light,
dark, and high-contrast** themes (theme.css defines all three).

### Motion

- House easing: `ease-out` at 150ms for micro-states; `cubic-bezier(0.22,1,0.36,1)` at
  200–240ms for anything that changes size or position.
- The Send→Stop transition is the money shot. It should be a **morph**, not a swap: the arrow's
  shaft collapsing into the square is a natural interpolation and is worth hand-authoring as an
  SVG path animation.
- Every animation needs a `motion-reduce` path. For JS-driven motion, use the `matchMedia` guard
  from `prompt-input-v2.tsx:547-548`.
- **No layout thrash.** If the control changes width, either reserve max width or animate the
  growth toward the trailing edge so the live-rate readout never jumps.

### Deliverables

1. Static comps for all nine rows above × light/dark (high-contrast can be a token audit rather
   than full comps).
2. A motion prototype (or a precise timing/easing table) for Send→Stop, disclosure reveal, and
   the busy state.
3. The SVG path(s) at 1× with a note on the intended `viewBox`, since the current implementation
   draws its own contour and the replacement likely will too.
4. Redlines against the token names in §4 — token names, not hexes.
5. A short note on any string changes needed in `packages/app/src/i18n/en.ts` (§3.4: the `Send`
   and `Stop` accessible names are frozen unless the e2e specs are updated in the same change).

---

## 8. Do not touch

- `packages/app/src/components/prompt-input/send-policy.ts` — the state machine is correct and
  unit-tested. The redesign renders it; it does not change it. If a concept needs a new state,
  that's a spec change to raise, not an edit to make quietly.
- `packages/app/src/components/prompt-input.tsx` — the **legacy v1 composer**. Unrelated; its
  `data-action="prompt-submit"` at :1761 is a different button.
- `packages/session-ui/src/v2/components/prompt-input/index.tsx:1052-1092`
  (`PromptInputV2SubmitButton`) — dead code path in the app. Don't spend time on it, and don't
  assume changing it changes anything the user sees.
- Focus restoration and the `Enter` / `Esc` bindings.
- The `MenuV2` / `TooltipV2` / `IconButtonV2` primitives themselves — style around them via
  `class`, as the current code does, rather than forking the primitives.

---

## 9. Verification

- **Live app, not just tests.** This repo has a documented history of green tests over a broken
  runtime. Use the `/run` skill to launch and actually look at the composer in a real session,
  streaming and idle, in both themes.
- Targeted e2e after implementation:
  - `packages/app/e2e/regression/session-timeline-history-root.spec.ts`
  - `packages/app/e2e/regression/session-todo-dock-navigation.spec.ts`
  - `packages/app/e2e/regression/goal-mode-lifecycle.spec.ts`
- Unit: `bun test packages/app/src/components/prompt-input/send-policy.test.ts` (should stay
  untouched and green).
- Typecheck: `packages/app` has a **non-zero error baseline** — diff the error count against
  `main`, don't expect zero.
- Manual matrix worth walking: idle→type→send; send→stream→Stop; stream→type (verify the
  Send/Stop flip is now legible); auto-revise armed→send; revisor asks a question→clarify state;
  shell mode (control must be unreachable by Tab).

---

## 10. Open questions for the user

Consolidated repeat of §6 — get answers before comps:

1. Disclosure at rest: hidden / hover-revealed / always present?
2. May the two auto-revise checkboxes relocate out of this menu?
3. Press-and-hold radial (C): desirable or gimmicky?
4. Absorb the `tok/s` readout into the Stop state, or keep it a separate sibling?
5. Is the *stop* action allowed to become visually louder than *send*? Today it is quieter,
   which is arguably backwards during an active run — but making it loud makes the streaming
   composer more visually aggressive.
