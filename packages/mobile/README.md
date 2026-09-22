# OpenFork Mobile

OpenFork Mobile is the independently hosted first-party PWA shell for the
authoritative `packages/app` application runtime.

It is intentionally **not a second OpenFork client implementation**. The mobile
package owns only the browser/PWA boundary:

- static hosting, manifest, service worker, offline bootstrap, and install UX;
- device pairing and device-scoped credential persistence;
- public OFXP/OpenFork Network identity pinning before stored credentials are
  transmitted;
- QR scanning;
- the verified development proxy that binds the PWA to the intended desktop
  sidecar.

After trust succeeds, `src/bootstrap.tsx` lazy-loads
`@opencode-ai/app/pwa-client`. Session state, SSE transport, timeline rendering,
prompt assembly, tools, permissions, models, goals, settings, and navigation are
the same application contexts and route surfaces used by OpenFork's primary GUI.

This boundary is deliberate: mobile-specific presentation is allowed, but
mobile must not fork durable session/runtime semantics from `packages/app`.

## Development

Run the sanctioned paired development stack from the desktop package:

```bash
cd packages/desktop
bun run dev
```

This launches Electron, its ephemeral sidecar, and the PWA on `:3301` with a
per-launch identity handshake. The PWA dev proxy verifies the target before each
request and refuses stale, recycled, or unrelated OpenFork processes even when
one is listening on the expected port.

Open `http://localhost:3301` after the stack is ready.

For an intentionally standalone development target, set
`VITE_OPENCODE_SERVER_URL` or `OPENCODE_DEV_PROXY_TARGET`. The target is still
identity-checked and pinned; this is not the paired-desktop workflow.

## Pairing and backend identity

Settings → Devices on desktop creates a short-lived pairing session. The QR URL
carries the PWA/API location while the one-time code is placed in the fragment so
it is stripped before application/runtime code can observe or accidentally share
it.

A successful claim returns a device-scoped credential. When the backend exposes
an OFXP identity, the PWA also persists its public peer ID, fingerprint, and
realm. On subsequent cold starts the PWA probes `/instance/identity` **without
credentials** and verifies that pin before transmitting the stored device token.

This makes the URL a transport location rather than the trusted identity. A
recycled tunnel/hostname that presents a different OpenFork Network identity
cannot silently receive the phone's stored credential.

The Connection sheet exposes backend health, the pinned/live OFXP identity,
trusted peer state, and explicit device lifecycle controls. “Revoke device”
invalidates the server credential and then deletes the local pairing; “Forget
local pairing” is recovery-only and does not revoke the server record.

When a tunnel hostname changes, “Update address” probes the new endpoint's
pinned OpenFork Network identity without credentials and only then re-points
the stored credential. It never follows a different identity.

## Production shape

Deploy `dist/` to a static HTTPS host such as Cloudflare Pages. Expose the
OpenFork server separately through a secure HTTPS endpoint/tunnel, then configure
the desktop/server deployment:

```powershell
$env:OPENCODE_PUBLIC_URL = "https://openfork-api.example.com"
$env:OPENCODE_PWA_URL = "https://openfork-mobile.example.com/"
$env:OPENCODE_SERVER_PASSWORD = "<a-long-random-secret>"
opencode serve --port 4096 --cors https://openfork-mobile.example.com
```

Tunnel only the API listener; never expose the Vite development server. Disable
CDN caching for API responses and rate-limit `POST /pair/claim` at the edge.
Public deployments fail closed without master credentials or a previously paired
device credential.

Ingress notes: keep the API listener bound to loopback; do not edge-cache
`/instance/identity` (the route already sends `cache-control: no-store`); do not
place an interactive auth challenge in front of `/instance/identity` or
`/pair/claim`; SSE and pty WebSockets must pass through without proxy buffering.
Only the HTTP API is exposed through the ingress — the OFXP peer wire listener
is a separate TLS transport and is not proxied through public HTTP ingress.

## Performance and offline contract

The unpaired/bootstrap shell is intentionally independent from the full
application stylesheet. The connected runtime and its CSS are dynamically loaded
only after trust succeeds; camera/QR code is lazy as well.

The service worker never caches authorization-bearing/API/SSE requests. During
installation it precaches the root shell and parses the generated HTML to cache
its content-addressed bootstrap JS/CSS. Worker installation fails instead of
activating if the offline bootstrap cannot be made complete. Hashed application
assets are cache-first after they are used, while documents remain network-first
with the cached root shell as the offline navigation fallback.

## Non-goals

- No automatic failover: the paired HTTPS endpoint stays the phone's only
  transport.
- OFXP peer trust never transfers this device's credential to another backend;
  automatic failover requires an explicit authenticated relay or
  credential-transfer contract.
- The OFXP wire transport is not exposed through public HTTP ingress.
