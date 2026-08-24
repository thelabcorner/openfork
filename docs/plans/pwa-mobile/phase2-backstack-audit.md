# Phase 2 — Redirect / Back-Stack Audit (risk R2)

- **Owner:** integrator (swarm `pwa-phase2-nav`, task t5)
- **Scope:** every redirect-style navigation in `../../../packages/app/src/app.tsx` plus the PWA entry, audited for replace-semantics so the mobile back-swipe can never land on a redirect and loop (docs/pwa-mobile/01 §2.4 item 4, 03 §5 "Redirect hygiene").
- **Method:** read each site's code, then verified the actual history semantics of the primitives used, then pinned the behavior with `../../../packages/app/e2e/regression/pwa-back-stack.spec.ts`.

## 1. Decisive library fact

`@solidjs/router` **0.15.4** (resolved for `../../../packages/app`) implements `<Navigate>` as an unconditional replace:

```
node_modules/@solidjs/router/dist/index.js:1685
function Navigate(props) {
  ...
  navigate(path, { replace: true, state })
}
```

Every `<Navigate href=… />` in the route table therefore already replaces its history entry. The R2 hypothesis ("inference on current behavior" — 01 §2.4) that these sites push entries is **not true** for this router version.

## 2. Site-by-site verdicts

| # | Site | What it does | Semantics | Verdict |
|---|---|---|---|---|
| 1 | `app.tsx:92` (`SessionRoute`, legacy `/…/session/:id` under new layout) | `<Navigate href={sessionHref(…)} />` → `/server/:key/session/:id` | replace (library) | ✅ safe |
| 2 | `app.tsx:172` (`LegacyTargetSessionRedirect`) | imperative `navigate(legacySessionHref(…), { replace: true })` | replace (explicit) | ✅ safe |
| 3 | `app.tsx:211` (`DraftRoute` fallback, invalid/missing `draftId`) | `<Navigate href="/" />` | replace (library) | ✅ safe — pinned by test 1 |
| 4 | `app.tsx:216` (`DraftRoute` legacy fallback) | `<Navigate href="/<b64>/session" />` | replace (library) | ✅ safe |
| 5 | `app.tsx:653` (`/:dir` → relative `"session"` alias) | `<Navigate href="session" />` | replace (library) | ✅ safe (audit found this site beyond the named set; already correct) |
| 6 | `app.tsx:701` (`NewLayoutLegacySessionRedirect`) | `<Navigate href={sessionHref(…)} />` after `tabs.ready()` | replace (library) | ✅ safe — pinned by test 2 |
| 7 | `entry-pwa.tsx` launch at `/pwa.html` | NEW: `history.replaceState(null, "", "/" + search + hash)` before render | replace (explicit) | ✅ added by this audit — see §3 |

## 3. Findings & fixes landed in phase 2

1. **PWA launch URL was a non-route pathname.** The pwa entry is served at `/pwa.html`; the router has no route for that path, so the shell booted with empty routed content until the first tab tap, and any later back-navigation could replay `/pwa.html`. Fix: `entry-pwa.tsx` normalizes to `/` via `history.replaceState` before render — no history entry, back from `/` exits the app as expected.
2. **Push-semantics redirects remaining (documented, intentionally not changed in phase 2):**
   - `app.tsx:281` (`LayoutCompatibility`): imperative `navigate("/")` without `replace` when a v2-protocol server is active under the legacy layout flag. Rare edge (explicit legacy preference + protocol mismatch); changing it alters legacy-shell behavior on desktop, which phase 2 may not do (byte-identical gate). Recommended phase-3 follow-up: add `{ replace: true }`.
   - No other `navigate(...)` call inside `app.tsx` pushes from a redirect-only component.
3. **Route table unchanged.** Zero new routes were added in any shell (Q5); settings render as a sheet over the active route (`components/pwa/settings-sheet.tsx`, mounted by `pages/layout-mobile.tsx`).

## 4. Test coverage

`../../../packages/app/e2e/regression/pwa-back-stack.spec.ts` (mocked server, deterministic seeds; history-length assertions are relative to a measured baseline because a fresh Playwright page owns an `about:blank` entry):

1. **Draft fallback** — `/new-session` with no matching draft replaces to `/` with exactly `baseline + 1` entries; `goBack()` cannot return to `/new-session` (no loop).
2. **New-layout legacy session redirect** — `/<b64(dir)>/session/:id` replaces to `/server/:key/session/:id` with exactly `baseline + 1` entries; `goBack()` cannot re-enter the redirect chain.
3. **Mobile arm flow** — boots `/pwa.html`: launch normalization keeps the stack at `baseline + 1` (replace, not push); session row tap pushes exactly one entry (`baseline + 2`) with the tab bar persisting across the arm's routes; `goBack()` returns home (tab bar + rows visible, no bounce); `goForward()` restores the session URL.

All three pass in the default `chromium` project. The env-gated `webkit-mobile` project (`PLAYWRIGHT_MOBILE=1`, iPhone 13 device descriptor per docs/pwa-mobile/06 §7.5, scoped to `pwa-*.spec.ts` so enabling it does not run the whole desktop suite under phone emulation — 06 §7.6 flake-budget caveat) is configured and the spec is written for it, but the run is blocked in this environment: the WebKit browser binary is not installed (`browserType.launch: Executable doesn't exist at …\ms-playwright\webkit-2272\Playwright.exe`; `playwright install webkit` required). Left to operator/CI rather than force-installing.

Known issue routed to the session-column lane / coordinator (triaged in `deliverable/t6`): under the e2e mock, entering a session via client-side navigation from home can leave the center column on its loading fallback ("Restoring your session…") even though the lineage fetch returns 200; direct-URL boots render fine. Test 3 therefore asserts back-stack semantics (URLs, history depth, chrome persistence) rather than session content paint.

## 5. Residual risks (out of phase-2 scope)

- `navigate("/")` at `app.tsx:281` (see finding 2).
- Redirect sites outside `app.tsx` (e.g. future feature-level `navigate` calls) are not covered by this audit; the e2e pins cover the shared route table only.
