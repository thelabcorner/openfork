# Multi-Account Model Picker — UX Spec

Design language is inherited, not invented: the same v2 tokens, sizes and rhythm the
OpenRouter submenu already uses (`dialog-select-model.tsx:430-687`). Anything not
specified here defaults to "whatever `OpenRouterEndpointList` does".

## 1. Vocabulary shown to the user

| Internal | User-facing | Notes |
|----------|-------------|-------|
| account-qualified model id | **account** | never say "credential", "variant", "qualified id" |
| `sticky` policy | **Auto** | the default; subtitle explains stickiness |
| `headroom` policy | **Auto · Most headroom** | |
| `spread` policy | **Auto · Spread evenly** | |
| session binding | **"This session is using …"** | never "bound", never "affinity" |
| `canAdmitModel === false` | **"Limited until 3:40 PM"** | always name the time, never "rate limited" |
| catalog miss | **"Not on this account's plan"** | |
| `packageCreditsRemaining <= 0` | **"No credits"** | matches `model.tag.noCredits` already in i18n |

## 2. The collapsed row

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⬡  Hunyuan 4 Preview          [Free now]   ▓▓▓▓▓░░  ~412   x0.00  ›  │
└──────────────────────────────────────────────────────────────────────┘
  ^   ^                          ^            ^        ^       ^     ^
  |   |                          |            |        |       |     └ submenu affordance
  |   |                          |            |        |       └ price / rate (unchanged)
  |   |                          |            |        └ estimated requests (unchanged)
  |   |                          |            └ stretch bar (unchanged)
  |   |                          └ promo badge (unchanged)
  |   └ canonical name, account label stripped
  └ provider icon (unchanged)
```

Additions over today's row — exactly two:

1. **Chevron** (`Icon name="chevron-right" size="small"` at 60% opacity), only when the
   group has >1 account. It is the single visual promise that a submenu exists. Same
   position and treatment as an OpenRouter row's implicit `SubTrigger` affordance.
2. **Account chip**, only when the current selection is *pinned* to a specific account, or
   the group is favorited on a specific account:

```
│ ⬡  Hunyuan 4 Preview   ◍ dana     ▓▓▓▓░░  ~118  x0.00  ✓  ›  │
                          ^^^^^^^
                          chip: 9px/600, text-v2-text-text-faint,
                          bg-v2-overlay-simple-overlay-hover, rounded-[3px],
                          px-1, max-w-[72px] truncate. Dot color = state tone.
```

The chip shows `short` (local-part of the email, or nickname), never the full address —
the full label is in the submenu and the row `title`.

**Bar semantics on a collapsed row.** The bar and `~requests` describe *what you would get
if you pressed Enter right now*:

- pinned selection -> that account's numbers;
- otherwise -> the numbers of the account the active policy would pick.

This is a deliberate change from today, where the unpinned "pool" row uses a
best-account-ish heuristic (`use-workbuddy-usage/index.ts:267-283`). Reuse that ordering,
but source it from `rankAccounts` so the row and the submenu can never disagree.

## 3. The submenu

Width `w-72` (a notch wider than the OpenRouter `w-64` — account labels are emails).
Structure, top to bottom:

```
┌────────────────────────────────────────────────┐
│ Hunyuan 4 Preview                              │  ModelTooltip, verbatim
│ 262K ctx · 8K out · reasoning · x0.00 credits  │  (same border-b treatment as :625-641)
├────────────────────────────────────────────────┤
│ ROUTING                                        │  section label, 9px/600, tracking .04
│ ◎ Auto                                    ✓    │  <- policy rows
│   Stays on jack@… for this session             │
│ ○ Auto · Most headroom                         │
│   Now → dana@… · 71% left                      │
│ ○ Auto · Spread evenly                         │
│   Now → sam@… · evens out burn                 │
├────────────────────────────────────────────────┤
│ ACCOUNTS                              4 total  │
│ ● jack@example.com      [Bound]  ▓▓▓░ 34%  ✓   │
│   1,204 credits · resets 3:40 PM               │
│ ● dana@example.com      [Best]   ▓▓▓▓ 71%      │
│   2,610 credits                                │
│ ● sam@example.com                ▓░░░  8%      │
│   210 credits · resets 11:02 PM                │
│ ○ kim@example.com   Limited until 3:40 PM      │
├────────────────────────────────────────────────┤
│ Use for all WorkBuddy models            [ ]    │
│ Manage accounts…                               │
└────────────────────────────────────────────────┘
```

### 3.1 Policy rows

- Radio semantics (`role="menuitemradio"`), because exactly one policy is active per
  provider. The check mark sits right, matching the OpenRouter Auto row (`:645-651`).
- The second line is the **live preview**, 10px/450, `text-v2-text-text-faint`. It is the
  whole point of the section: Auto stops being opaque.
- Preview text by policy:
  - `sticky`, session already bound -> "Stays on {short} for this session"
  - `sticky`, not bound -> "Picks {short} first"
  - `headroom` -> "Now → {short} · {n}% left"
  - `spread` -> "Now → {short} · evens out burn"
  - tier `quota` (no routing endpoint) -> suffix " · estimated"
  - nothing eligible -> "No account can serve this model right now" in
    `text-v2-state-fg-danger`, row disabled
- Policies the server does not advertise are **not rendered** (no disabled ghosts).
- Selecting a policy: sets the per-provider policy preference **and** selects the model
  with the corresponding id, then closes the popover — same one-action behaviour as
  `onPickProvider` today (`:2280-2284`).

### 3.2 Account rows

Two lines, 42px min-height, same geometry as `OpenRouterEndpointList` items (`:487-500`)
so the two submenus feel like one system.

Line 1: `state dot · label (truncate, flex-1) · [badge] · bar · percent · check`
Line 2 (`pl-5`, 10px, faint): `{credits or requests} · resets {time}` or the block reason.

- **State dot** 4px, colored by `colorFor(tone)` from `usage-gauge-v2` — the exact helper
  the uptime dot uses (`:519-524`). `ready` -> success/warning/danger by headroom;
  `cooling`/`limited` -> warning; `exhausted`/`not-entitled` -> danger; `unknown` -> faint.
- **Badges**: `[Bound]` (accent, only at tier `routing`), `[Best]` (success, top-ranked
  under the *active* policy — reuses the `dialog.model.subprovider.best` visual at `:503`).
  Maximum one badge; `Bound` wins.
- **Bar**: 24px mini bar, same `ModelStretchBar` fill/tone logic, no animation on open.
- **Order**: eligible first (by active policy rank), then blocked (by soonest reset). Never
  re-sort while the submenu is open — the same rule the model list follows with `openOrder`
  (`:1101-1110`); a list that reshuffles under the cursor is the single most disliked
  behaviour in this picker's history.
- **Blocked rows** are `disabled` but keep their reset countdown live (1 min tick via the
  existing `createPolled` in the view, not a per-row timer).
- Selecting an account = pin: sets model id `base@account`, closes, and flashes a
  one-line toast only when it *rebinds a session mid-conversation*:
  "This session will use dana@example.com from the next message." (The router treats an
  explicit account as a deliberate rebind — `workbuddy-accounts.ts:605-615`. The user must
  know.)

### 3.3 Footer

- **"Use for all {Provider} models"** — a checkbox row, not a menu item. Persists the pinned
  account (or policy) as the provider default so a newly picked model inherits it. Off by
  default. Copy is deliberately explicit; nothing implicit ever changes the meaning of
  other rows.
- **"Manage accounts…"** — opens the provider's auth/accounts surface (`dialog-connect-provider`
  for enrollment; the credential-switcher pattern in
  `components/dialog-credential-switcher.tsx` is the visual precedent for a fuller manager).
- At tier `quota`/`labels`, add a third faint line: "Live routing unavailable — showing
  cached quota." No error styling; this is a normal cold-start state.

## 4. States gallery (build all of these in Storybook)

| State | Row | Submenu |
|-------|-----|---------|
| 1 account | no chevron, no chip | none |
| 2+ accounts, auto | chevron | policy=Auto checked, accounts unchecked |
| pinned | chip + check | that account checked |
| pinned account exhausted | chip dot danger, bar 0, `No credits` in place of `~requests` | that row danger, block reason, others still selectable |
| all blocked | bar hidden, `~—` | policy rows disabled with the red line |
| model missing on some accounts | unchanged | those rows "Not on this account's plan", greyed, sorted last |
| tier `labels` | no bars anywhere | accounts list with labels only + the cold-start note |
| account added while open | new row animates in at its ranked position **only after the submenu closes** | |
| RTL / 40-char email | chip truncates at 72px | label truncates, badge and percent never wrap |

## 5. Motion

- Submenu open/close: inherit `MenuV2.SubContent` defaults. No custom transitions.
- Bars: no enter animation (they would strobe as you scan rows). Width changes from live
  data are eased 150 ms — same as the limits pane.
- Countdown text updates on the shared minute tick, never per second.

## 6. Keyboard

| Key | Context | Action |
|-----|---------|--------|
| `→` | collapsed row focused | open submenu, focus the active policy row |
| `←` / `Esc` | inside submenu | close submenu, return focus to the row (Esc must not close the whole popover — guard as the search input already does at `:2136`) |
| `↑` `↓` | inside submenu | move between policy rows and account rows as one list; skip section labels; wrap at ends (mirrors the endpoint list's `focusIndex` at `:471-479`) |
| `Enter` | collapsed row | select using the active policy — never opens the submenu |
| `Enter` | policy/account row | select it, close everything |
| `Tab` | anywhere | unchanged; the picker is a menu, Tab exits |
| `Space` | footer checkbox | toggle, keep submenu open |
| typing | inside submenu | filters the account list in-place (single-digit lists, so a simple `startsWith` on label is enough) |

Focus must be visible on every submenu row (`focus:outline-none` + explicit
`data-selected`/ring, matching the endpoint list).

## 7. Accessibility

- `MenuV2.SubTrigger` gets `aria-haspopup="menu"`, and an `aria-label` that includes the
  account count: "Hunyuan 4 Preview, 4 accounts".
- Policy rows: `role="menuitemradio"` + `aria-checked`.
- Account rows: `role="menuitemradio"` + `aria-checked` + `aria-disabled` on blocked rows,
  with the block reason in the accessible name, not only in color.
- Every state that is communicated by a dot color is **also** communicated by text on line
  2. No color-only information anywhere in this feature.
- The bar gets `role="img"` + `aria-label="{n}% remaining"` (today's stretch bar has none —
  fix it while we are here).

## 8. Copy / i18n keys

All new strings go in `packages/app/src/i18n/en.ts` next to the existing
`dialog.model.subprovider.*` block (`:346-354`).

```
dialog.model.account.section.routing      "Routing"
dialog.model.account.section.accounts     "Accounts"
dialog.model.account.count                "{{count}} total"
dialog.model.account.auto                 "Auto"
dialog.model.account.auto.sticky.bound    "Stays on {{account}} for this session"
dialog.model.account.auto.sticky.unbound  "Picks {{account}} first"
dialog.model.account.auto.headroom        "Most headroom"
dialog.model.account.auto.headroom.hint   "Now → {{account}} · {{percent}}% left"
dialog.model.account.auto.spread          "Spread evenly"
dialog.model.account.auto.spread.hint     "Now → {{account}} · evens out burn"
dialog.model.account.auto.none            "No account can serve this model right now"
dialog.model.account.estimated            "estimated"
dialog.model.account.badge.bound          "Bound"
dialog.model.account.badge.best           "Best"
dialog.model.account.blocked.window       "Limited until {{time}}"
dialog.model.account.blocked.cooldown     "Cooling down · retry {{time}}"
dialog.model.account.blocked.credits      "No credits"
dialog.model.account.blocked.catalog      "Not on this account's plan"
dialog.model.account.resets               "resets {{time}}"
dialog.model.account.credits              "{{count}} credits"
dialog.model.account.requests             "~{{count}} requests"
dialog.model.account.useForAll            "Use for all {{provider}} models"
dialog.model.account.manage               "Manage accounts…"
dialog.model.account.offline              "Live routing unavailable — showing cached quota."
dialog.model.account.rebind.toast         "This session will use {{account}} from the next message."
```

Rules: no em-dash-free jargon, no provider-internal codes (never show "6004"), always a
concrete time instead of a duration when a reset is known.

## 9. What we deliberately do **not** do

- No account avatars/gravatars — a colored state dot carries more information per pixel.
- No nested third-level submenu (e.g. policy → per-account override). Two levels max.
- No "auto-switch account for me" toast spam. The router already rotates silently; if the
  user wants to know, the submenu tells them.
- No blocking modal when an account is exhausted. The picker informs, the send path
  already errors well (`workbuddy.ts:445-460`).
