## Repository map

Read `../../docs/map/surfaces.md` and `../../docs/map/v1-v2.md` before
changing session presentation across legacy/current UI seams.

## Data / runtime boundary

- Session UI components are presentation consumers, not owners of server/runtime
  state. Do not add network fetches, workspace bootstrap, or hidden history
  hydration to a reusable UI component just to derive display metadata.
- Prefer narrow props/context backed by materialized or incremental domain
  projections. Do not repeatedly scan full message/part history on a timer for a
  value that can be supplied as a scalar or compact live snapshot.
- Keep token-rate rendering local to the actively rendered content that actually
  changes. Cross-session summaries belong upstream, not in every session row.
- Reusable session UI may render telemetry passed to it, but it must not create
  provider queries, workspace bootstraps, global event streams, or session
  history hydration to derive row/sidebar metadata on its own.

## Localization

- NEVER hardcode user-visible English strings in production code. ALWAYS use an i18n key for visible copy, placeholders, accessible labels, tooltips, menus, dialogs, empty states, and displayed errors.
- When migrating existing copy to i18n, preserve the English text byte-for-byte unless the task explicitly requests a copy change.
- NEVER change existing English text or English keys to facilitate translation. English is intentional, designer-written source copy; adapt locale-specific translations and i18n mechanics around it.
- Do not translate from model knowledge alone. Verify terminology and grammar with Unicode CLDR locale/plural data, Microsoft Localization Style Guides and terminology, Apple localization/style guidance and localized platform UI, Mozilla localization style guides, Mozilla Pontoon, and the Firefox localization corpus at `github.com/mozilla-l10n/firefox-l10n`.
- Also use the relevant language authority or official dictionary for the locale (for example RAE/Fundéu, FranceTerme, Duden, TDK, Kotus/Kielitoimiston sanakirja, Språkrådet/Bokmålsordboka, Rada Języka Polskiego/PWN, the Russian and Arabic language academies, the Ukrainian Orthography, Taiwan MOE dictionaries, or the Royal Society of Thailand). Treat the English dictionary as the semantic source of truth and preserve placeholders, code identifiers, product names, and keyboard labels.
