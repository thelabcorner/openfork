# OpenCode Mobile

This is a separate first-party PWA. It is hosted independently from the
Electron renderer and does not depend on the sidecar serving an HTML bundle.

The sidecar remains the API process. The PWA uses `@opencode-ai/sdk/v2/client`
for REST calls and SSE events.

## Development

Start the OpenCode API server and allow the PWA origin:

```bash
opencode serve --port 4096 --cors http://localhost:3301
```

In another terminal:

```bash
bun run dev
```

Open `http://localhost:3301`. Set `VITE_OPENCODE_SERVER_URL` when the API is
not at the default entered in the connection screen.

## Production Shape

Deploy `dist/` to a static HTTPS host such as Cloudflare Pages. Expose the
sidecar API separately through Cloudflare Tunnel, then configure:

```powershell
$env:OPENCODE_PUBLIC_URL = "https://opencode-api.example.com"
$env:OPENCODE_PWA_URL = "https://opencode-mobile.example.com/"
opencode serve --port 4096 --cors https://opencode-mobile.example.com
```

Settings > Devices creates a QR URL on the PWA origin. The URL carries the API
origin in a query parameter and the short-lived pairing code in the fragment.
The PWA claims a device token once and stores it locally.
