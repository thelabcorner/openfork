# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

## Separate Mobile PWA

The mobile PWA is a separate static application. The desktop sidecar remains
an API server for both Electron and the PWA; it does not serve the mobile
bundle.

Configure the sidecar with the public API URL and the separately hosted PWA:

```powershell
$env:OPENCODE_PUBLIC_URL = "https://opencode-api.example.com"
$env:OPENCODE_PWA_URL = "https://opencode-mobile.example.com/"
$env:OPENCODE_SERVER_PASSWORD = "<a-long-random-secret>"
```

Expose the sidecar API through Cloudflare Tunnel and allow the PWA origin:

```powershell
opencode serve --port 4096 --cors https://opencode-mobile.example.com
```

Tunnel only `127.0.0.1:4096`, disable CDN caching for API responses, and add
an edge rate limit for `POST /pair/claim`. Never expose the PWA development
server or run the public API without the server password. Desktop-managed
sidecars generate their own master secret automatically.

The pairing QR opens the PWA origin with the API URL and one-time pairing code.
The PWA claims a device token and stores it locally for later SDK requests.
