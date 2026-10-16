# Settings navigation: typed nested sections

Status: implemented in the V2 Settings surface. This is a presentation/navigation
contract, **not** a server-side configuration schema or new persistence layer.

## Product shape

Settings is a two-pane IDE-style view:

1. Existing application Settings sidebar: desktop/general and server/integrations.
2. Detail pane: one named section of the selected parent tab.

The selected parent's children are expanded **inside the existing sidebar**.
There is no third column, second settings window, per-service nested modal, or
new global router. Density is intentional: compact selected/hover states,
typographic hierarchy, zinc UI tokens, native focus styling, and reduced-motion
support. The Settings page is a functional control surface, not a dashboard.

Parent panels without children keep their existing behavior. The selected
child's heading replaces the old undifferentiated page title, and the parent
becomes the smaller context label. Each section displays its own existing
configuration controls rather than recreating their backing settings or APIs.

## Authoritative navigation contracts

- `packages/app/src/components/settings-v2/navigation-model.ts` owns the pure
  `SettingsTab` set, tab normalization and safe return-path rules.
- `packages/app/src/components/settings-v2/navigation.ts` retains the existing
  `useSettingsNavigation` hook and re-exports the pure definitions for compatibility.
- `sections.ts` owns the **single immutable registry** for section IDs and
  labels; IDs are stable public deep-link tokens, not display strings.
- `settingsSectionQuery` preserves the original return route, selected server,
  directory and session while switching parent/child navigation.
- `subnav.tsx` is the purely presentational child-sidebar renderer. Adding a
  section does not involve adding one-off DOM navigation logic to the sidebar.
- `section-scroll.ts` resets the existing content pane on child navigation,
  avoiding an apparently empty panel when transitioning from a long section.
- `settings-subnav.css` owns sub-navigation styling; tokens are inherited from
  V2 rather than introducing competing theme state.

Example routes (the first section is the fallback):

```
/settings?tab=general&section=appearance
/settings?tab=telegram&section=quota
/settings?tab=oxp&section=agents
```

Missing/unknown children normalize to the first registered section **for that
specific parent**, never to an identically named section under another parent.
A tab without child sections has no child selection. Switching parent tabs
clears stale child selection; opening Settings with a valid child selection uses
the same query builder. Invalid child sections are never forwarded into
configuration endpoints.

The canonical first-party ChatGPT integration is `tab=oxp`, labeled
“ChatGPT” in the localization dictionary, and is distinct from OpenAI's model
provider account configuration. Keep that separation.

## Current sections

| Parent | Sections |
|---|---|
| General | Basics, Appearance, Notifications, Sounds, Updates, Display, Advanced, Danger zone |
| ChatGPT (OXP) | Connection, Approved folders, Capabilities, Agent support, Background behavior, Activity & diagnostics, Migration |
| Telegram | Bot & pairing, Delivery, Quota resets, Management |

Telegram's notification channel and its services remain separate domains:
bot identity/chat pairing and global delivery controls are not the Quota reset
subscription policy. Quota window discovery is initiated only when visiting
the Quota resets section or explicitly refreshing there; simply opening
Telegram Settings must not trigger provider-wide quota discovery.

The live OXP state owner and its grants/credentials do not change when
sections change. Section selection must never duplicate credentials, write
settings, restart a service, or alter grants.

## Adding another nested section

1. Pick a stable URL ID and add it to the parent list in `sections.ts`.
   Use a localized label key where a dictionary label already exists.
2. Put the existing domain component under a matching selected-section
   predicate (or lazy import a complex page), without duplicating its data
   controller or its persistence logic.
3. Add the URL/fallback coverage in `sections.test.ts`. For a side-effecting
   section, prove loading another section does not fetch or mutate its domain.
4. Keep the active child visible and keyboard-focusable in the same sidebar.
   Use native buttons, focus-visible rings, arrow/Home/End keyboard navigation,
   and `aria-current` to communicate the selected item.
5. If the section is platform-conditional, render clear unavailability or
   remove the section from the list and normalize its URL accordingly; never
   leave a dead/unexplained blank panel.

## Performance invariants

- Navigation metadata is static and computed without server calls or
  message/session-history hydration.
- Only the selected Telegram service runs quota discovery.
- A change of section is not a change of server connection or credential.
- Do not create polling subscriptions from a closed/inactive section.
- Avoid a new network endpoint, provider aggregation query, global settings
  store, or UI event bus merely to support child tabs.

## Verification

Run in `packages/app`:

```sh
bun test --conditions=solid ./src/components/settings-v2/sections.test.ts
bun run typecheck
bun run build
```

Before considering UX fully certified, also manually check narrow desktop
windows, small mobile widths, tab/arrow focus traversal, dark/light contrast,
root-connection failure states, stale URLs, and session return navigation.
