# Mobile PWA QR authentication: diagnosis and contract (2026-10-15)

Status: source authentication, pairing, and mobile-proxy repair implemented; live loopback HTTP and full mobile tests passed. Public HTTPS ingress and installed-iOS verification are still pending deployment. Production bundle size-budget admission currently fails on connected runtime and OXP route chunks. This complements, and does not supersede, 08-separate-origin.md and 09-tunnel-ingress.md.

## Problem and observed cause

The phone must open an unauthenticated static PWA shell and pair by scanning the desktop-issued QR, not answer a browser-owned HTTP Basic username/password prompt. The QR's one-time six-character code is an application-level pairing secret, not the desktop's master password.

Before this work, two independent problems could cause a native Basic dialog:

1. When OPENCODE_PWA_URL was absent, the /pair/begin handler synthesized a QR URL pointing at the request's host, which is often the protected API/desktop-web-UI server rather than the PWA. Navigating there returned 401 with WWW-Authenticate: Basic before the mobile pairing application could load.
2. The retained V1 and current V2 API authorization middleware each appended WWW-Authenticate: Basic for unauthorized cross-origin browser fetches. A paired PWA with a rejected/stale token could therefore trigger a browser-native dialog, instead of handling 401 in application UI.

Neither case justifies disabling API authentication. The first is QR destination selection; the second is the HTTP challenge scheme presented to cross-origin applications.

## Supported deployment architecture

The normative near-term boundary remains:
- Public, static, installed PWA at a stable HTTPS origin; it serves its own HTML, manifest, SW, JS and icons without a browser-login challenge.
- A separate HTTPS origin/tunnel for the authenticated OpenFork HTTP API and streaming transports, reaching a loopback-bound sidecar. Configure CORS for the PWA origin.
- Private API requests remain authenticated by desktop/server credentials or device-specific, revocable pairing tokens. Unauthenticated /pair/claim and /instance/identity are narrowly public bootstrap endpoints, not an authorization bypass.
- Server identity is the pinned public OFXP peer ID, fingerprint and realmID, not merely a matching URL/hostname. On cold start the client probes /instance/identity WITHOUT a device credential, verifies the pin, and only then sends its stored credential.

Do not expose Vite's mobile development/HMR server through a public tunnel. Its local identity-verified proxy on :3301 is development tooling, not the production static frontend.

## QR generation and first launch

Desktop Settings > Devices > Pair device uses authenticated POST /pair/begin to mint a short-lived code. For a scannable QR, the server must have a valid OPENCODE_PWA_URL (static mobile origin) and OPENCODE_PUBLIC_URL (phone-reachable API origin). They must describe distinct trusted origins. Production origins should both be HTTPS; local loopback-only development is a separate allowance.

Expected conceptual URL:

    https://mobile.example.test/?server=https%3A%2F%2Fapi.example.test#pair=K7M2XQ

The pairing code belongs in the FRAGMENT, never a query string or backend access log. The mobile bootstrap consumes and removes the fragment before loading the shared application runtime, claims the code through public POST /pair/claim and stores only the returned device-specific token. The server must not generate a QR pointing to the protected API root when configuration is absent, incomplete, malformed, same-origin, or insecure. In those cases the desktop dialog offers a clear configuration hint and manual code entry remains available.

The installed PWA's own Scan QR action is useful on iOS: opening an OS Camera-generated link in Safari may use a different storage container from the installed standalone PWA. Validate pairing in the intended installed-app context.

## Authentication challenges, not authentication bypasses

V1 and V2 use one shared policy: failed API authorization returns status 401 with a Bearer challenge regardless of Origin (including missing, invalid, cross-origin, and same-origin requests). Basic remains only for an explicit non-API HTML document navigation. This is a challenge-header policy, not an authentication bypass. The mobile development proxy additionally replaces any legacy Basic challenge from an older sidecar with Bearer while preserving the upstream status and body.

Missing, invalid, expired and revoked device tokens MUST still be denied before protected handler execution. The normal desktop UI document remains authenticated. The public static PWA shell is not the desktop web UI root.

The same policy must cover /global/*, /api/*, instance routes and relevant SSE/terminal rejection paths, not merely one middleware implementation. Server-side pairing credential verification, per-device revocation, OFXP pinning and rate limiting are unchanged.

## HTTP/ingress matrix for real deployment admission

- GET PWA root: 200 mobile HTML, no WWW-Authenticate Basic, service worker/manifest assets load.
- GET API /instance/identity: unauthenticated 200 JSON with cache-control: no-store, no Cloudflare Access login interstitial.
- POST API /pair/claim with bad code: application-level 400 or rate-limited 429, NOT a browser Basic challenge. Correct short-lived code succeeds exactly once.
- POST API /pair/begin: unauthorized without desktop/device credential; authenticated desktop mints a code.
- GET private API without a device token from a PWA cross-origin browser fetch: 401 with Bearer challenge, no private data.
- GET private API with valid token: authorized; with revoked token: 401 and handler not reached.
- SSE and PTY WebSocket connect: authenticated, streamed through ingress without buffering. Validate their failures do not surface a Basic prompt from an upstream proxy.
- Force close/reopen installed PWA: pinned identity verified BEFORE a stored device secret is transmitted; a different peer or unreachable identity fails closed.
- Rotate/revoke token: application should show re-pair UI; no master password should appear or be requested.
- Install/update/offline: SW caches only static assets, never authorization-bearing API/SSE content.

A reverse proxy or Cloudflare Access policy can independently insert WWW-Authenticate: Basic. A source-level challenge fix cannot override an upstream prompt. The static PWA origin and pre-auth bootstrap endpoints must therefore be exempt from interactive proxy authentication; private API routes still enforce app-managed device authorization. Preserve edge rate limits on pair claims and disable API response caching.

## Relevant code and regression suites

- packages/opencode/src/server/routes/instance/httpapi/handlers/pair.ts
- packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts
- packages/server/src/middleware/authorization.ts
- packages/server/src/auth-challenge.ts
- packages/app/src/components/settings-v2/dialog-pair-device.tsx
- packages/mobile/src/bootstrap.tsx and network-identity.ts
- packages/opencode/test/server/httpapi-authorization.test.ts
- packages/opencode/test/server/pairing.test.ts and pairing-e2e.test.ts
- packages/server/src/auth-challenge.test.ts

The V2 revoked-token test must use a V2 HTTP test router. Testing /api/probe through a V1-only fixture yields an unmatched-route 404 and says nothing about V2 authentication; the corrected test first proves valid token execution, then revokes it, expects precisely 401 and verifies no handler execution.

## Operational and release notes

Do not restart live desktop/sidecar processes merely to run these source tests: this workstation has concurrently running sessions and historically significant SQLite contention. Source changes are not a deployed binary. Build and restart in a controlled maintenance window, with device/session state preserved, then validate from the actual phone over the public HTTPS URLs.

A single OpenFork-hosted PWA origin is a separate architectural project, not an auth middleware toggle. It requires an explicit public static route, secure path/scoped service worker and assets, separation from the protected desktop document, no browser Basic challenge for PWA-origin API calls (including same-origin cases), plus its own ingress and end-to-end tests. Keep the proven separate-origin deployment until that path is built and audited.

First-pairing now requires a public OFXP identity before posting the one-time code and verifies it again before persisting the issued device token. Previously saved unpinned credentials require re-pairing rather than insecure in-place upgrade; pairing fetches reject redirects and ambient browser credentials. Outstanding topics: signed challenge/proof of possession of the advertised OFXP key (JSON identity projections alone can be replayed by an active adversary), shorter-lived SSE tickets instead of long-lived device tokens in query strings, and end-to-end installed-iOS/public-HTTPS deployment checks.

## October 15 continuation — mobile-specific failure containment

The mobile bootstrap now owns a single asynchronous attempt generation. Starting another pairing, restore, or endpoint migration cancels the prior attempt and increments the generation; forgetting a device invalidates all pending operations before clearing state. Every asynchronous authentication boundary checks its captured generation before updating UI or storing credentials. `AbortSignal` alone is insufficient: a stale response can settle after an abort, and some transports ignore abort entirely.

Public identity probes, pairing-code claims, and credential health probes have 12-second request deadlines, covering streamed JSON bodies as well as response headers. The deadline races uncooperative transports rather than assuming the fetch implementation honors abort. Invalid or overlong pairing-code URL secrets and malformed issued device-token strings are rejected rather than normalized into another credential. Any post-claim identity mismatch continues to discard the token.

New trusted device state is a single `opencode.mobile.pairedConnection.v1` storage record that atomically binds API origin, device token, device ID, and OFXP identity pin. Old independent keys are migration inputs only: legacy records are migrated after a successful identity-gated restore, while a **corrupt** new record fails closed and never falls back to stale legacy credentials. After an atomic commit succeeds the legacy keys are deleted; storage failures permit only a clearly warned in-memory connection, not a falsely persistent pairing. Endpoint migration requires successful atomic persistence before switching the active API URL. Device forget and explicit token revocation clear the new record and the legacy keys.

Verification during this pass: mobile `bun test src dev` **100/100 passing, 298 assertions**; standalone `bunx tsc --noEmit` passed after the final mobile changes, and scoped `git diff --check` passed. The combined app/mobile typecheck was separately blocked by concurrent `packages/app/src/utils/server-compat.ts` diagnostics, unrelated to this mobile patch. No live sidecar or desktop process was restarted, and no deployment or installed-iPhone result is claimed. The public-HTTPS, on-device pairing and PWA bundle-budget gates remain pending.

Further negative testing exposed an additional identity trust-gap: the original persisted pin parser accepted empty realm/peer/fingerprint fields and unchecked stored protocol bounds. Both the public identity projection parser and persistent pin parser now reject those malformed inputs consistently. The atomic storage writer prevalidates a candidate tuple before writing so it cannot report success for a record that cold-start restore would reject. Development-only LAN HTTP remains allowed when explicitly running the dev frontend; remote HTTP is rejected in production. Attempt generations also invalidate on component cleanup. These are source patches, not evidence of completed public ingress deployment.

Legacy embedded-entry audit: `packages/app/pwa.html` and `packages/app/src/entry-pwa.tsx` still exist, separate from the supported `packages/mobile` bootstrap. They historically derive the API origin from the page itself, restore Basic-format device credentials, and do not implement the new atomic OFXP identity-gated credential firewall. They are **not** an acceptable alternative public deployment target. In particular, opening `/pwa.html` on an authenticated desktop webserver can trigger the server's protected-document Basic challenge before any JavaScript can run. Retain the dedicated publicly reachable static PWA origin until the embedded entry is deliberately replaced by the secure mobile bootstrap and the server adds an independently audited public-static route. Do not exempt the entire desktop UI or private API from authorization to make the legacy page load.
