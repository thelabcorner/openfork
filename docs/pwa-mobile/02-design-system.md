# 02 — Design System & Tokens (Mobile PWA)

Owner: design-system · Swarm `pwa-mobile` · Phase: IDEATION ONLY (no code changes)
Reads: [00-handoff.md](./00-handoff.md) · Upstream peers: ux-architect (01), reuse-strategist (03) · Consumers: chat-tool-ux (05), pwa-platform (06)

**Purpose:** define the shadcn-zinc, New-York-dense, iOS-PWA-first skin **on top of the existing `@opencode-ai/ui` token system** — current-state inventory, zinc mapping decision, density vs touch-target rules, component disposition, mobile-only additions and their owning layer, safe-area tokens, motion language, iconography/haptics notes, risks.

**Trust rule compliance:** every claim carries a `path:line` citation (all read for this doc) or an explicit *inference* label. External references (Apple HIG, Tailwind zinc hex values) are labeled as such.

---

## 1. Current token inventory (`@opencode-ai/ui`) — verified

### 1.1 Two-layer architecture

| Layer | Files | Mechanism |
|---|---|---|
| **Runtime themes** | `packages/ui/src/theme/` — `context.tsx`, `resolve.ts`, `themes/*.json` (37 themes) | JSON theme → resolved token map → CSS custom properties injected into a `<style id="oc-theme">` at runtime |
| **Static fallback + scaffolding** | `packages/ui/src/styles/` — `theme.css`, `colors.css`, `base.css`, `tailwind/index.css`, `animations.css` | Hand-written `:root` vars (OC-2 values), Radix-style raw scales, Tailwind preflight/@theme bridge |

Runtime flow (verified in `packages/ui/src/theme/context.tsx`):
- Themes discovered by `import.meta.glob("./themes/*.json")` — **adding a JSON file is zero-code registration** (`context.tsx:26-38`).
- `applyThemeCss()` writes `:root { color-scheme; --text-mix-blend-mode; …tokens }` into the style element, sets `data-theme` / `data-color-scheme` on `<html>`, hardcodes page background `#080808`/`#fafafa`, and syncs the `<meta name="theme-color">` tag (`context.tsx:133-160`). The theme-color sync is a free win for PWA chrome blending (see §6).
- Persistence via localStorage keys `opencode-theme-id`, `opencode-color-scheme`, cached resolved CSS per mode (`context.tsx:14-19`); cross-tab sync via `storage` event (`context.tsx:234-253`); system-scheme tracking via `matchMedia("(prefers-color-scheme: dark)")` (`context.tsx:128-131, 255-263`).
- Default theme `oc-2`; `oc-1` normalizes to `oc-2` (`context.tsx:87-89, 180`). `defaultTheme` prop exists for embedders (`context.tsx:176-181`) — this is the PWA's hook.
- Live preview machinery (`previewTheme`/`previewColorScheme`/`commitPreview`, `context.tsx:327-370`) — reusable for a future mobile settings sheet.
- Non-oc-2 themes' resolved CSS is cached to localStorage per mode (`context.tsx:162-172`) — relevant to cold-start flash risk (§9).

### 1.2 Theme JSON format

`DesktopTheme { name, id, light, dark }` where each variant is **either** `seeds` **or** `palette`, plus optional `overrides` / `v2Overrides` (`packages/ui/src/theme/types.ts:35-50`):

```jsonc
{ "light": {
    "palette":   { "neutral", "ink", "primary", "success", "warning",
                   "error", "info", "interactive", "diffAdd?", "diffDelete?" },  // types.ts:21-33
    "overrides":   { "<v1 token>": "#hex | var(--…)" },
    "v2Overrides": { "v2-grey-100": "#…" } } }
```

- `palette` ⇒ `compact = true`: text/border/icon tones derive from an explicit `ink` hue; `seeds` ⇒ classic generator path (`resolve.ts:473-514`).
- Neutrals: `generateNeutralScale(neutral, isDark, ink)` builds a 12-step ramp by mixing background↔ink in OKLCH (`color.ts:171-195`) — so **the neutral seed + ink pair fully determines zinc-ness**.
- Accent-ish hues: `generateScale(seed)` builds 12-step ramps for primary/accent/success/warning/error/info/interactive + derived amber/blue/diffAdd/diffDelete (`resolve.ts:8-28`, `color.ts:133-169`).
- ~300 resolved v1 tokens per mode: `background-*`, `surface-*` (base/inset/raised/float/brand/interactive/state/diff), `text-*`, `border-*`, `icon-*`, `input-*`, `button-*`, `syntax-*`, `markdown-*`, `avatar-*` (`resolve.ts:114-455`); emitted as `--token-name: value` by `themeToCss` (`resolve.ts:536-540`).
- Per-theme escape hatch: `overrides` patch any resolved token after generation (`resolve.ts:429-431`) — oc-2 uses it heavily (`themes/oc-2.json:18-48`).

### 1.3 The v2 token namespace

A second, semantic namespace is generated alongside v1 (`packages/ui/src/theme/v2/`):
- Primitive ramps `v2-{grey,red,orange,yellow,green,blue,purple,pink,cyan}-100…1200` (12 steps, wider spread than v1) from the same palette seeds (`v2/resolve.ts:9, 109-120`).
- Semantic map: `v2-background-bg-{base,deep,layer-01…04,inverse,contrast}`, `v2-text-text-*`, `v2-border-border-{muted,base,strong,inverse,focus}`, `v2-overlay-simple-overlay-{hover,pressed,scrim,…}`, `v2-state-{bg,fg,border}-{success,warning,danger,info}`, agent identity colors, and elevation shadows `v2-elevation-{raised,floating,overlay,button-neutral,switch-off/on}` (`v2/mapping.ts:34-97` light, dark from :99).
- Themes pin exact primitive hexes via `v2Overrides` (oc-2 pins its full grey ramp, `themes/oc-2.json:49-62`).
- A parallel v2 component layer exists: `src/v2/components/*` (button-v2, dialog-v2, menu-v2, tabs-v2, toast-v2, switch-v2, select-v2, segmented-control-v2, field-v2, textarea-v2, text-input-v2, badge-v2, divider-v2, loader-v2, tooltip-v2, …) with `src/v2/styles/*` (verified by directory listing; generator `script/build-oc2-v2-overrides.ts` noted in handoff §2.9).

### 1.4 Static scaffolding values (what mobile inherits today)

From `packages/ui/src/styles/theme.css`:
- Type: `--font-size-small: 13px`, `--font-size-base: 14px`, `--font-size-large: 16px`, `--font-size-x-large: 20px`; weights 400/500 only; line-heights 130%/150%/180%/200%; letter-spacing tight −0.16px / tightest −0.32px (`theme.css:8-21`). **All px, not rem.**
- Space: `--spacing: 0.25rem` (Tailwind v4 4px base, `theme.css:23`, mirrored in `styles/tailwind/index.css:12`).
- Radius: xs 0.125rem → xl 0.625rem (`theme.css:45-49`) — max 10px; iOS sheets want larger.
- Breakpoints: sm 40rem…2xl 96rem (`theme.css:25-29`; tailwind adds 3xl–5xl, `tailwind/index.css:20-22`).
- Shadows: layered, `light-dark()` aware, incl. composite border+shadow recipes (`--shadow-xs-border*`, `theme.css:51-88`).
- Full OC-2 light fallback block (`theme.css:93-358`) and dark via `@media (prefers-color-scheme: dark)` (`theme.css:360-630`) — these are pre-JS defaults, overridden at runtime.
- Preflight niceties already mobile-relevant: `-webkit-tap-highlight-color: transparent` (`base.css:36`) and an **iOS anti-auto-zoom rule forcing 16px inputs on coarse pointers** (`base.css:397-404`).

### 1.5 What neutrals exist today, and how far from zinc

Effective neutrals come from the runtime theme, not `colors.css`. Two facts:

1. **Static `colors.css` grays are warm, not zinc.** The `--gray-*` scale is declared twice: pure neutral first (`colors.css:2-25`), then **overridden by warm "smoke" values** (`colors.css:50-73`; cascade ⇒ last wins). Effective dark steps `#131010/#1b1818/#252121/#2d2828…` are red-warm (R>G=B); light steps `#fdfcfc/#f9f8f8…` warm off-white. Legacy `--smoke-*` aliases point at the same values (`colors.css:98-121, 689-740`).
2. **Default theme oc-2 is warm + colorful:** palette neutral `#f7f7f7`, ink `#171311` (warm), primary `#dcde8d` (yellow-green), interactive `#034cff` (saturated blue) (`themes/oc-2.json:6-17`); dark background resolves toward `#101010` (`styles/theme.css:365`).

Distance from shadcn-zinc (*inference, comparing against Tailwind zinc hexes — external reference, not repo data*):

| Anchor | Today (oc-2) | shadcn-zinc target | Gap |
|---|---|---|---|
| Dark bg | `#101010` neutral-warm | `#09090b` (zinc-950, violet-cool) | hue ≈ 60° warm → ≈ 260° cool; both near-zero chroma |
| Light bg | `#f8f8f8`/`#f7f7f7` | `#fafafa` (zinc-50) | trivial |
| Ink/text-strong | `#171311` warm / `#171717` | `#09090b` | slight warmth to remove |
| Borders (light) | `#DBDBDB`/`#E8E8E8` (oc-2 overrides, `oc-2.json:25-26`) | `#e4e4e7` (zinc-200) | near |
| Primary CTA | yellow-green `#dcde8d` / white-on-dark | monochrome zinc-950 / zinc-50 | **largest gap — categorical, not tonal** |
| Interactive/focus | `#034cff` blue | zinc keeps focus neutral (external ref) | decision required (§2.3) |

Conclusion: zinc is reachable **entirely through the existing palette+overrides format** — no engine changes.

---

## 2. Zinc mapping strategy — DECISION

### 2.1 Decision: add `themes/zinc.json` to the existing theme directory

Ship a new `packages/ui/src/theme/themes/zinc.json` in the standard `DesktopTheme` palette format, and have the PWA boot with `defaultTheme="zinc"` (`context.tsx:176-181`).

Why this wins:
- **Zero registration code**: glob discovery picks the file up automatically (`context.tsx:26-38`); display name comes from the JSON `"name"` field with the `names` map as optional polish (`context.tsx:321`).
- **It benefits every surface**: desktop settings and any future shell get a real zinc theme through the same picker — maximally aligned with the "one source of truth" axiom (00-handoff §3.3).
- **It respects the theme contract**: switching, caching, previews, and cross-tab sync all keep working because we play inside `ThemeProvider`, not around it.
- **Extend, don't fork** (00-handoff §3.5): a data file is the smallest possible extension of the existing system.

### 2.2 Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **PWA-local CSS-var patch applied after mount** | Fights the runtime: every `applyThemeCss` pass (scheme flip, preview, storage event) rewrites `:root` and would stomp the patch (`context.tsx:133-160, 234-253`); breaks theme switching/preview semantics; creates a second source of truth. |
| **Edit static `styles/colors.css` gray scales to zinc** | Pointless: those scales are pre-JS fallback/legacy material; runtime themes overwrite the same custom-property names (`theme.css:93-630` vs `context.tsx:144-152`). Would only change the pre-hydration flash, not the shipped look. |
| **New "mobile" theme engine / forked resolver** | Violates the extend-don't-fork axiom outright; duplicates ~500 lines of OKLCH machinery (`resolve.ts`, `color.ts`) for no capability gain. |
| **Reuse an existing near-neutral theme (vercel/github)** | None is zinc: each carries its own accent DNA and override sets; auditing/retuning someone else's overrides is harder than authoring a clean palette. |

### 2.3 Accent policy inside zinc (explicit sub-decision)

shadcn-zinc is near-monochrome: primary = zinc-950 (light) / zinc-50 (dark), focus rings neutral (*external reference: shadcn/ui zinc theme*). In this system, however, `interactive` is **functional**, not decorative — it drives `border-selected` (`resolve.ts:241`), `input-selected/focus` (`resolve.ts:189-191`), `text-interactive-base` (`resolve.ts:208`), and state surfaces.

**Decision:** zinc.json goes monochrome for *brand* surfaces (`button-primary-base` = ink, matching `resolve.ts:232` which already derives primary buttons from `neutral[11]`) but keeps a **desaturated blue `interactive`** for selection/focus/links. Rationale: on a dense mobile screen, selected-vs-unselected must survive glanceability and the 4.5:1 contrast bar; pure-neutral selection states regress usability. Alternative (strict shadcn purity: neutral rings) is viable and reversible — flagged as an open question (§9).

### 2.4 Concrete token block (illustrative `zinc.json` sketch)

Hex values below are Tailwind zinc stops (*external reference*, labeled inference as to resolved-token outcomes; the *mechanism* is cited):

```jsonc
{
  "$schema": "https://opencode.ai/desktop-theme.json",        // same schema ref as oc-2.json:2
  "name": "Zinc", "id": "zinc",
  "light": {
    "palette": {
      "neutral": "#fafafa",            // zinc-50 — background anchor (neutral[0], resolve.ts:116)
      "ink":     "#09090b",            // zinc-950 — text/border tone anchor (ink path, color.ts:172-194)
      "primary": "#09090b",            // monochrome brand
      "interactive": "#2563eb",        // desaturated functional blue (decision §2.3)
      "success": "#16a34a", "warning": "#ca8a04", "error": "#dc2626", "info": "#0891b2",
      "diffAdd": "#86efac", "diffDelete": "#fca5a5"
    },
    "overrides": {
      "background-base": "#fafafa", "background-weak": "#f4f4f5",
      "surface-raised-strong": "#ffffff", "surface-float-base": "#18181b",
      "text-strong": "#09090b", "text-base": "#52525b", "text-weak": "#71717a",
      "border-weak-base": "#e4e4e7", "border-weaker-base": "#ececef",
      "button-primary-base": "#09090b"
    },
    "v2Overrides": {
      "v2-grey-100": "#fafafaff", "v2-grey-200": "#f4f4f5ff", "v2-grey-300": "#e4e4e7ff",
      "v2-grey-400": "#d4d4d8ff", "v2-grey-500": "#a1a1aaff", "v2-grey-600": "#71717aff",
      "v2-grey-700": "#52525bff", "v2-grey-800": "#3f3f46ff", "v2-grey-900": "#27272aff",
      "v2-grey-1000": "#18181bff", "v2-grey-1100": "#09090bff"
    }
  },
  "dark": {
    "palette": {
      "neutral": "#09090b", "ink": "#fafafa",
      "primary": "#fafafa", "interactive": "#3b82f6",
      "success": "#22c55e", "warning": "#eab308", "error": "#ef4444", "info": "#06b6d4",
      "diffAdd": "#14532d", "diffDelete": "#7f1d1d"
    },
    "overrides": {
      "background-base": "#09090b", "background-weak": "#18181b",
      "surface-raised-stronger-non-alpha": "#18181b",       // cf. resolve.ts:146
      "surface-float-base": "#18181b",                       // menus/popovers lift one step
      "text-strong": "#fafafa", "text-base": "#a1a1aa", "text-weak": "#8b8b94",
      "border-weak-base": "#27272a", "border-weaker-base": "#1f1f23",
      "button-primary-base": "#fafafa"
    }
  }
}
```

How the asked-about roles resolve (both modes):

| Role | v1 token(s) | Light | Dark |
|---|---|---|---|
| Surface (page) | `background-base` (`resolve.ts:116`) | zinc-50 | zinc-950 |
| Elevated (cards/floats) | `surface-raised-*`, `surface-float-base` (`resolve.ts:134-142, 135-136`) | white / zinc-900 floats | white-alpha over zinc-950 / zinc-900 floats |
| Border | `border-weak-base`, `border-base` (`resolve.ts:238, 244`) | zinc-200 / ink-alpha | zinc-800 / white-alpha |
| Muted | `background-weak`, `text-weak` (`resolve.ts:117, 195`) | zinc-100 / zinc-500 | zinc-900 / zinc-400-ish |
| Accent | `button-primary-base` (mono) + `interactive` family (`resolve.ts:151-154, 232, 241`) | zinc-950 fill; blue selection | zinc-50 fill; blue selection |

Because `generateNeutralScale` mixes bg↔ink (`color.ts:171-195`), the palette alone already lands ~90% zinc; `overrides` pin the handful of anchors where the generator's curve deviates (same technique oc-2 uses, `oc-2.json:18-48`).

---

## 3. New York density spec, reconciled with 44pt touch targets

### 3.1 Baseline: the repo is already New-York dense

Verified control metrics: buttons 24/28/32px (`button.css:109-150`), icon-buttons 20/24/32px (`icon-button.css:114-140`), avatars 20/24/32px (`avatar.css:22-40`), checkbox 16px (`checkbox.css:24-25`), accordion/collapsible headers 32px (`accordion.css:30-31`), base type 13–14px (`theme.css:8-9`), radius cap 10px (`theme.css:45-49`). This **is** the shadcn "New York" temperament (compact, quiet, hairline-bordered). We do **not** inflate it for mobile; we add a touch layer.

### 3.2 Mobile type scale (rem-based proposal)

Today's px tokens resist user font scaling; on a phone that's an accessibility regression. Proposal (upstream change to `theme.css` tokens — values chosen to be drop-in equivalents):

| Token | Today | Proposed | Use |
|---|---|---|---|
| `--font-size-caption` *(new)* | — | 0.6875rem (11px) | timestamps, meta rows |
| `--font-size-x-small` *(new)* | ad-hoc 12px (`checkbox.css:71`) | 0.75rem | badges, keybinds |
| `--font-size-small` | 13px | 0.8125rem | dense UI, buttons |
| `--font-size-base` | 14px | 0.875rem | default |
| `--font-size-large` | 16px | 1rem | section headers, inputs (anti-zoom floor, `base.css:397-404`) |
| `--font-size-title` *(new)* | — | 1.0625rem (17px) | sheet/nav titles (iOS headline) |
| `--font-size-x-large` | 20px | 1.25rem | screen titles |
| `--font-size-large-title` *(new)* | — | 1.75rem (28px) | large-title header (§5) |

Line-heights: keep the existing four-step ladder (`theme.css:14-17`) and add `--line-height-tight: 120%` for titles. Code/mono stays 1em with `--line-height-normal` (matches `base.css:116-124`).

Real faces (verified): the app self-hosts **Inter** variable (`packages/app/src/index.css:13-18`) and **JetBrainsMono Nerd Font Mono** (`index.css:6-11`) via `@font-face`, while `--font-family-sans` defaults to the system stack (`theme.css:2`). Mobile spec: keep Inter as the identity face (it already ships); the system-stack fallback covers pre-load flash. Asset note from 06: Inter currently ships as variable **TTF** (`index.css:14` loads `/assets/Inter.ttf`) — likely the largest non-JS shell asset; woff2 conversion + subsetting is the cheapest precache win against 06's ≤2.5 MB shell budget (`06-pwa-platform.md` §6.2).

*Resolved by 03 (Option A′, third shell in `packages/app`):* these land **upstream in `@opencode-ai/ui`** as Phase 0 foundation candidates — they're shared-surface improvements with zero app coupling, so desktop benefits equally and no new package boundary is involved.

### 3.3 The density ↔ touch-target rule set

Anchors: Apple HIG minimum tappable area 44×44pt (*external reference*); WCAG 2.2 AA minimum 24px (2.5.8) (*external reference*). Repo reality: 20–32px visuals.

**Rules (binding for all PWA screens):**

1. **R1 — Visual density is sacred; hit area is negotiable.** Controls keep their New-York sizes (24–32px). Hit area is grown with *slop*, not size: an extended hit region (negative-inset pseudo-element or padded wrapper) centers on the visual and reaches **≥44×44px** for anything that is a *primary* tap affordance.
2. **R2 — Chrome pays full price.** Persistent navigation and primary actions — tab-bar items, composer send, cell disclosure/accessory buttons, sheet grabber-adjacent actions — are laid out at **44px logical height/width minimum**, no slop tricks.
3. **R3 — List rows are 44px.** Any tappable list/table row renders ≥44px tall regardless of content height (content vertically centered); dense 28–32px *visual* rows are allowed only when the row itself isn't the tap target (tap goes to a trailing accessory).
4. **R4 — Slop must not collide.** After slop expansion, sibling targets keep **≥8px edge-to-edge**; otherwise merge into one target or move the action into an overflow sheet.
5. **R5 — Inline-flow exceptions degrade gracefully.** Un-slopable inline targets (@mentions, inline tags in prose) get ≥24px effective height (WCAG 2.2 AA floor) **plus** a long-press alternate path (preview + open menu).
6. **R6 — Density tiers, not ad-hoc sizes.** Exactly three mobile control tiers: `touch` (44px, chrome/rows), `compact` (32px visual + slop, toolbars/cards), `dense` (24–28px visual + slop, meta/tool-output chrome). Nothing ships outside a tier.

*Scope note (post-05):* width breakpoints remain valid for **content-presentation** swaps inside a screen — e.g., 05's unified-diff default below 640px reuses the existing `--breakpoint-sm` (`theme.css:25`), inventing nothing. The pointer/standalone keying rule (see §6 baseline discussion) governs **navigation chrome and component pattern-swaps** (§4–5), not in-screen content layout.

Concrete mapping:

| Control | Visual (today) | Mobile tier | Hit result |
|---|---|---|---|
| Button | 24/28/32 (`button.css:109-150`) | compact/large→touch | 44px via padded wrapper on primary CTAs |
| Icon-button | 20/24/32 (`icon-button.css:114-140`) | dense/compact | slop to 44px; toolbar instances sized 32px visual |
| Checkbox/Switch | 16px box (`checkbox.css:24`) | dense | whole label row is the target (already partially true: `checkbox.css:4` gap-12 label pattern) |
| List row | varies | touch | 44px min (R3) |
| Tabs | component-defined | compact | segment ≥44×32 with slop; see §4 tabs row |

---

## 4. Component disposition table (~20 primitives)

Legend: **reuse** = ship as-is · **adapt** = mobile variant (props/CSS, shared file) · **pattern-swap** = different mobile pattern replaces desktop form · **suppress** = hidden on coarse pointers. Citations point at the component's implementation/css (existence verified via `styles/index.css:9-51` imports and `src/v2/components/` listing).

| # | Primitive | Evidence | Disposition | Mobile treatment |
|---|---|---|---|---|
| 1 | Button | `components/button.tsx`, `button.css:1-194`; `v2/button-v2.*` | **adapt** | Add `data-size="touch"` (44px) per R2/R6; press state: background shift (existing) + scale 0.97 (§7). Keep variants. |
| 2 | Icon-button | `icon-button.css:114-140` | **adapt** | Slop-to-44 wrapper (R1); `large` (32px) becomes toolbar default. |
| 3 | Dialog | `dialog.css:23, 127-134` (min(100vh−16px,512px)); `v2/dialog-v2.css:23-24` (fixed 480×368!) | **pattern-swap** | Content dialogs → **bottom sheet** (§5.1). Destructive confirms stay centered, alert-compact (≤320px). Fixed 480×368 v2 container is unusable on phones — must become intrinsic-height on mobile. |
| 4 | Dropdown-menu | `dropdown-menu.css` (Kobalte) | **pattern-swap** | Coarse pointer → **action sheet** (bottom, large rows, cancel). Keyboard/desktop keeps menu. Trigger stays; presentation swaps by `(pointer: coarse)`. |
| 5 | Popover | `popover.css`; app `status-popover.tsx` consumers | **adapt** | Anchored info popovers (read-only) survive with tightened insets; *interactive* popovers (forms, pickers) reroute to sheets. |
| 6 | Select | `select.css`; `v2/select-v2.*` | **pattern-swap** | Long lists → bottom-sheet searchable list (iOS-style picker); short lists → `SegmentedControlV2` (exists! §5.3). |
| 7 | Tabs | `tabs.css`; `v2/tabs-v2.*` | **adapt** | ≤5 segments → segmented control; many peer tabs → scrollable tab strip w/ 44px rows; top-level nav is *not* tabs (tab bar owns it, §5.4, [DEPENDS: 01 §navigation]). |
| 8 | Toast | `solid-sonner` (dep, handoff §2.3) + `v2/toast-v2.*` (reduced-motion aware, `toast-v2.tsx:266`) | **adapt** | Position bottom-center above tab bar + safe-area (§6); swipe-to-dismiss; max 1 stacked + counter. |
| 9 | Tooltip | `tooltip.css`; `v2/tooltip-v2.css:64` reduced-motion | **suppress** | No hover on touch. Icon-only actions must be self-labeling (i18n'd aria-label) or long-press reveal. |
| 10 | Scroll-view | `scroll-view.css` | **adapt** | Add `overscroll-behavior: contain` scroll-isolation for nested panes; safe-area padding variants (§6); momentum is default on iOS. |
| 11 | Text-field | `text-field.css`; `v2/text-input-v2.*`, `textarea-v2.*` | **reuse** | Anti-zoom already enforced globally (`base.css:397-404`); wrap at `touch` tier (44px) for forms; composer textarea exempt (multiline). |
| 12 | Switch | `switch.css` (+`v2/switch-v2.*`, elevation tokens `v2/mapping.ts:90-93`) | **reuse** | Row-integrated (whole row toggles, R1 slop); track size unchanged. |
| 13 | List | `list.css` | **adapt** | 44px rows (R3); swipe-action slot (leading/trailing) as mobile variant; dividers hairline `border-weaker-base`. |
| 14 | Card | `card.css:13-92` (pad/gap vars) | **reuse** | Padding vars already parameterized (`--card-pad-y/r/l`, `card.css:13, 24`); mobile sets tighter values via tier class. |
| 15 | Tag | `tag.css:12-25` | **reuse** | As-is; inline targets follow R5. |
| 16 | Avatar | `avatar.css:22-40` (20/24/32) | **reuse** | As-is; session rows use `normal`. |
| 17 | Spinner | `spinner.css`; `v2/loader-v2.*` (reduced-motion, `loader-v2.css:28`) | **reuse** | As-is. |
| 18 | Progress / Progress-circle | `progress.css`, `progress-circle.css` | **reuse** | As-is; context-pane gauges reuse them ([DEPENDS: 05 §context-pane]). |
| 19 | Image-preview | `image-preview.css` | **adapt** | Fullscreen viewer with pinch-zoom + double-tap — gesture layer is new work (flag in §9); share/download via action sheet. |
| 20 | Diff-changes | `diff-changes.css`; `v2/diff-changes-v2.*` | **reuse** | As-is for stat pills; full diffs render via session-ui kit on mobile ([DEPENDS: 05 §diffs]). |

Cross-cutting: **context-menu** (`context-menu.css`) follows dropdown-menu's pattern-swap; **hover-card** suppressed on touch; **keybind** chips hidden on coarse pointers (no keyboard) except in a "keyboard shortcuts" settings sheet.

---

## 5. Mobile-only additions & layer ownership

Dependency direction (binding, AGENTS.md via handoff §2.12): `app` depends on `ui`; `ui` never depends on `app`. Therefore anything reusable across shells belongs upstream in `@opencode-ai/ui` (v2 layer); anything encoding PWA navigation semantics starts local. *Resolved by 03 (Option A′):* "PWA-local" = `packages/app` itself — mobile chrome lives beside the third layout variant (`pages/layout-mobile.tsx` per 03); upstream promotions (bottom sheet, action sheet) ride 03's F1–F3 in-package extraction queue into `ui/v2`. The ownership *logic* below stands as written.

### 5.1 Bottom sheet — **upstream `ui/v2`**
- Basis exists twice: `@corvu/drawer` is already an app dependency with a wrapped Drawer ("can be promoted to ui/v2 later" — authors' own note, `app/src/components/ui/drawer.tsx:1-9`), currently styled as a **side** panel (`w-[560px]`, `drawer.tsx:58`).
- Proposal: promote corvu-based primitive into `ui/v2` with `side="bottom"` mobile styling: grabber, `radius-xl`+ (needs a `--radius-2xl` token, today capped at 0.625rem, `theme.css:45-49`), detents (peek/half/full), `env(safe-area-inset-bottom)` padding, sheet-scoped motion (§7). Desktop gets a free upgraded drawer — shared-source dividend.
- Why upstream: it's generic presentation, useful to desktop (command palette, previews), and depends only on ui-layer tokens.

### 5.2 Action sheet — **upstream `ui/v2`** (variant of bottom sheet)
Same primitive, opinionated slots (title/description/destructive-group/cancel). Owns the DropdownMenu pattern-swap (§4 #4). Destructive items use `surface-critical-*` tokens (`resolve.ts:162-164`).

### 5.3 Segmented control — **already exists upstream; adopt, don't build**
`SegmentedControlV2/ItemV2` ship today with controlled/uncontrolled value, deselect, roving arrow-key/Home/End focus, `aria-pressed` (`v2/components/segmented-control-v2.tsx:33-43, 158-208`). Mobile work is **CSS only**: a `touch` tier (44px segments, R1 slop) in `segmented-control-v2.css`.

### 5.4 Bottom tab bar — **PWA-local first, promotion later**
Encodes PWA information architecture — owned by 01, which has now decided: **persistent 3-tab bar (Sessions / Search / Settings)** + push stack for session/draft/group; context breakdown is a sheet, not a tab (`01-ux-architecture.md`, hybrid nav model). Build local on top of upstream primitives (list/tabs styling tokens); promote to `ui/v2` only if desktop ever wants it. Items: 44px targets (R2), `icon + 0.6875rem label`, active tint `text-interactive-base`, safe-area bottom (§6).
i18n keys (per handoff §3.6): `pwa.tab.sessions`, `pwa.tab.search`, `pwa.tab.settings` (+ a11y labels `pwa.tab.<x>.ariaLabel`).

### 5.5 Large-title header — **PWA-local**
Collapsing large-title → inline-title bar is iOS-chrome behavior tied to scroll position of *PWA screens*. 01's hybrid nav (push stack over zero new routes, mobile chrome as a third layout variant) is the host — the header belongs to that chrome layer. Local component consuming upstream tokens (`--font-size-large-title` §3.2, `tracking-tightest` `theme.css:20`); back action + contextual actions at 44px (R2); per-screen titles/actions per 01's screen inventory.

### 5.6 FAB — **REJECTED**
Rejected: opencode's primary action grammar is the composer + command palette (handoff §2.5); a FAB would duplicate the composer's new-session affordance, compete with the keyboard for the thumb zone, and has no desktop counterpart (breaks one-source-of-truth). "New session" lives as the tab bar's center action or header action instead. Revisit only if 01's IA ends up with a single dominant global create action.

---

## 6. Safe-area-aware layout tokens

Existing facts: `viewport-fit=cover` + `interactive-widget=resizes-content` already declared (`packages/app/index.html:7`); `layout-new.tsx` already pads with `env(safe-area-inset-top/bottom)` inline (`packages/app/src/pages/layout-new.tsx:67-68`); theme-color meta already synced per scheme (`context.tsx:157-159`); and a **standalone-mode dvh fix already exists** — `@media (display-mode: standalone) { #root { height: 100vh } }` with the comment "WebKit excludes safe-area insets from dvh in installed apps" (`packages/app/src/index.css:20-25`). Responsive baseline today is desktop-first: the only width media queries in app CSS are four 640px rules (`dialog-command-palette-v2.css:210`, `settings-v2.css:111,156,228`) — mobile chrome cannot lean on existing breakpoints below 40rem.

Proposal — name the insets once, consume everywhere:

```css
:root {
  /* Read once; components never call env() directly */
  --safe-area-top: env(safe-area-inset-top, 0px);
  --safe-area-right: env(safe-area-inset-right, 0px);
  --safe-area-bottom: env(safe-area-inset-bottom, 0px);
  --safe-area-left: env(safe-area-inset-left, 0px);

  /* Chrome metrics (PWA-local layer) */
  --chrome-tabbar-height: 3rem;              /* 48px + --safe-area-bottom at consumption site */
  --chrome-header-height: 2.75rem;           /* 44px collapsed bar */
  --chrome-header-large-title: 4.5rem;       /* expanded */

  /* Composite helpers */
  --page-pad-bottom: calc(var(--safe-area-bottom) + var(--chrome-tabbar-height));
  --sheet-pad-bottom: calc(var(--safe-area-bottom) + 0.5rem);
}
```

Rules: (a) fixed chrome offsets by composite helpers, never raw `env()` at call sites; (b) sheets/toasts/tab bar always include `--safe-area-bottom`; (c) landscape respects left/right insets (notch); (d) keyboard handling (`interactive-widget=resizes-content`, visualViewport) is 06's lane — tokens here only reserve space. *[DEPENDS: 06 §viewport-keyboard]*

---

## 7. Motion language

Stack facts: `motion` 12.x is an app+ui dependency (handoff §2.3); spring helper exists (`attachSpring`/`motionValue`, `visualDuration`/`bounce` API — `components/motion-spring.tsx:1-21`); a CSS spring-var precedent exists (`animated-number.css:16`: 560ms `cubic-bezier(0.22,1,0.36,1)`); drawer overlay transitions at 300ms with backdrop blur (`drawer.tsx:30-31, 37`); reduced-motion handled per-component in ≥10 places (grep: `animated-number.css:67`, `loader-v2.css:28`, `toast-v2.tsx:266`, `tooltip-v2.css:64`, `text-shimmer-v2.css:109`, `icon-button.css:147`, `text-reveal.css:141`, `text-shimmer.css:103`, `text-strikethrough.css:23`).

### 7.1 Token set (proposed, PWA-local until promoted)

```css
:root {
  --motion-instant: 80ms;   /* press states, toggles */
  --motion-fast: 160ms;     /* fades, small translates */
  --motion-base: 240ms;     /* standard transitions */
  --motion-sheet: 420ms;    /* bottom sheet travel */
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ease-sheet: cubic-bezier(0.32, 0.72, 0, 1);   /* iOS sheet curve (external ref) */
  --spring-ui: { visualDuration: 0.3, bounce: 0.15 };   /* motion-spring.tsx options */
  --spring-gesture: { visualDuration: 0.45, bounce: 0.2 };
}
```

### 7.2 What animates / what never does

**Animates:** sheet enter/exit + drag-tracking (spring-gesture); screen push/fade (base); press scale 0.97 on touch-tier controls (instant); segmented-control thumb (spring-ui); toast slide/dismiss; skeleton shimmer (existing pulse family, `animations.css:1-34`); streaming markdown reveals (existing text-reveal/shimmer, reduced-motion-aware); pull-to-refresh spinner; number ticks (existing animated-number).

**Never animates:** theme/scheme switches (instant swap — `applyThemeCss` already atomic, `context.tsx:133-160`); layout of streaming content (opacity only, no reflow animation — protects scroll anchoring during generation); diff line backgrounds on first paint; focus rings; anything inside `content-visibility` virtualized ranges; tab-bar presence (persistent chrome doesn't hide/show).

### 7.3 Reduced-motion policy (global rule, codifying existing practice)

Every added animation ships a `@media (prefers-reduced-motion: reduce)` disable (matching the 10 existing precedents); every `motion`-library animation checks `matchMedia("(prefers-reduced-motion: reduce)")` once and downgrades to opacity-only or instant (precedent: `toast-v2.tsx:266`). Springs collapse to their visualDuration endpoint. Gesture-driven motion (sheet drag) becomes instant reposition without inertia.

---

## 8. Iconography & haptics notes

**Icons.** Spritesheet pipeline exists (handoff §2.9: `vite-plugin-icons-spritesheet`; `file-icon`/`provider-icon`/`app-icon` components; e.g. `components/app-icons/sprite.svg`). Mobile rules: reuse the existing sets — **no new icon family**; glyphs render at existing sizes (`icon.css:10-25` small/normal/medium/large); a tappable icon sits in a ≥44px target (R1/R2) with the glyph ≥20px; filled-vs-stroke follows the existing set's convention; tab-bar icons request additions through the same spritesheet build, not ad-hoc SVGs.

**Haptics (within web limits).** *Platform facts, labeled inference/external:* `navigator.vibrate()` works on Android Chromium; **iOS Safari exposes no web haptics API** (as of iOS 17/18). Design stance: haptics are progressive enhancement routed through the `Platform` seam (`PlatformBase`, `app/src/context/platform.tsx:35-100`; `PlatformName = "web" | "desktop"` :20 — handoff §2.4 flags this as the slot). Patterns (Android only): 10ms tick on segmented/tab select; `[10, 30, 10]` on send-success; distinct error buzz on failure. **Haptics are never the sole signal** — every haptic pairs with a visual state change. Final seam shape: *[DEPENDS: 03 §platform-deltas]*.

---

## 9. Open questions & risks

1. **Undefined token `--surface-disabled`** — referenced by `button.css:99`, `checkbox.css:120`, `switch.css:121` but defined nowhere in `theme.css` or `resolve.ts` (grepped). Disabled controls silently fall back to transparent. Fix belongs upstream; zinc.json should define it explicitly regardless.
2. **Cold-start flash** — static `theme.css` fallback is OC-2 warm; a zinc-defaulted PWA paints warm before `ThemeProvider` applies (non-oc-2 themes go through async load + localStorage cache, `context.tsx:196-216, 162-172`). **Resolved by 06 §1.3:** the `oc-theme-preload` element is an inline script in `index.html:21` (build-inlined via `vite.js:39-45`), and the static `#root` skeleton is replaced wholesale by Solid (`entry.tsx:169-183`). Remaining actions: zinc.json must define `--surface-disabled` (risk #1), and the preload skeleton must avoid any component referencing it (pure SVG/neutral bars only — per 06).
3. **Monochrome vs functional-blue accent** (§2.3) — needs a design sign-off; affects `border-selected`, `input-selected`, link color across every screen.
4. **px→rem type migration** (§3.2) touches shared tokens; desktop regression risk is low but nonzero (pixel-perfect stories exist). Sequence behind 03's packaging decision.
5. **44pt enforcement is convention-only** — no lint/test guard exists. Mitigation: Storybook addon/checklist per tier (storybook package exists, handoff §2.8); consider a CI a11y-target audit later.
6. **Pinch-zoom image viewer** (§4 #19) is genuinely new gesture code (no existing zoom primitive found in ui/app greps) — scope it honestly in 05/06 planning.
7. **Sheet + keyboard interplay** — `interactive-widget=resizes-content` changes sheet geometry while composing (`index.html:7`). **Resolved by 06 §2.4:** single `KeyboardInset` store ({keyboardHeight, viewportBottom, keyboardOpen} from visualViewport, rAF-throttled); sheets/popovers clamp max-height to `viewportBottom`; composer anchors via translateY while open, safe-area-inset-bottom when closed; dvh does NOT track the iOS keyboard. The upstream bottom-sheet primitive (§5.1) must ship the clamp as part of its contract; no other component may read visualViewport directly.
8. **v2 grey ramp provenance** — oc-2 pins its entire `v2-grey-*` ramp by hand (`oc-2.json:49-62`); zinc.json must do the same or accept generator output; exact hexes above are proposals pending visual QA in Storybook.
9. **Theme-color meta vs status-bar styling** — runtime sync exists (`context.tsx:157-159`) but PWA standalone windows + `viewport-fit=cover` interplay (black translucent bars) needs device QA. *[DEPENDS: 06 §manifest]*
10. **i18n for new copy** — mobile additions introduce strings (tab labels §5.4, sheet a11y labels, action-sheet verbs). All must be keyed in `en.ts` per binding i18n rules (handoff §2.12); keys named inline above; full inventory lands with 01/05 screens.

---

### Disposition summary for downstream peers

- **05 (chat-tool-ux):** consume §4 table verbatim for tool/message chrome; diff/markdown streaming rules in §7.2; context pane gauges reuse progress primitives.
- **01 (ux-architect):** DELIVERED and aligned — tab bar = Sessions/Search/Settings (§5.4), large-title hosted by hybrid-nav chrome (§5.5), FAB rejection stands (§5.6), context-as-sheet matches §5.1's upstream sheet promotion; density tiers (§3.3) are constraints for screen specs.
- **03 (reuse-strategist):** DELIVERED — Option A′ (third shell in `packages/app`) adopted: tab bar/large-title confirmed PWA-local in the `layout-mobile.tsx` chrome layer (§5.4–5.5); bottom-sheet/action-sheet promotions ride the F1–F3 queue (§5.1–5.2); zinc.json + `--surface-disabled` fix + px→rem tokens are Phase 0 foundation candidates for the migration plan.
- **06 (pwa-platform):** safe-area token contract (§6), startup flash (risk #2), manifest/theme-color (risk #9), keyboard (risk #7) are joint surface.

— end of 02 —
