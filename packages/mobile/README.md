# OpenCode Mobile

This is a separate first-party PWA. It is hosted independently from the
Electron renderer and does not depend on the sidecar serving an HTML bundle.

The sidecar remains the API process. The PWA uses `@opencode-ai/sdk/v2/client`
for REST calls and SSE events.

## Development

Run the sanctioned paired development stack from this package's sibling:

```bash
cd packages/desktop
bun run dev
```

This launches Electron, its ephemeral sidecar, and the PWA on `:3301` with a
per-launch identity handshake. The PWA refuses to proxy to a stale, recycled,
or unrelated OpenCode process, even if one happens to be listening on the old
port. Open `http://localhost:3301` after the stack is ready.

For an intentionally standalone PWA server, set `VITE_OPENCODE_SERVER_URL` or
`OPENCODE_DEV_PROXY_TARGET`; that target is still identity-checked and pinned
to the first instance that answers. It is not the paired desktop workflow.

## Production Shape

Deploy `dist/` to a static HTTPS host such as Cloudflare Pages. Expose the
sidecar API separately through Cloudflare Tunnel, then configure:

```powershell
$env:OPENCODE_PUBLIC_URL = "https://opencode-api.example.com"
$env:OPENCODE_PWA_URL = "https://opencode-mobile.example.com/"
$env:OPENCODE_SERVER_PASSWORD = "<a-long-random-secret>"
opencode serve --port 4096 --cors https://opencode-mobile.example.com
```

Tunnel only the API listener on `127.0.0.1:4096`; never expose the Vite
development server. Disable CDN caching for API responses and rate-limit
`POST /pair/claim` at the Cloudflare edge. Do not remove the server password:
public-URL deployments fail closed without either master credentials or a
previously paired device token.

Settings > Devices creates a QR URL on the PWA origin. The URL carries the API
origin in a query parameter and the short-lived pairing code in the fragment.
The PWA claims a device token once and stores it locally.
