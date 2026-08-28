# Separate-Origin Mobile PWA

Status: active direction

This document supersedes the same-origin/embedded-serving assumptions in the
earlier PWA planning documents.

## Decision

The mobile client is a separate first-party application under
`packages/mobile`. It is built and deployed as static HTTPS assets, for
example to Cloudflare Pages. It is not an entry point of `packages/app`, and
the OpenCode sidecar does not serve its HTML, JavaScript, manifest, or service
worker.

The OpenCode sidecar remains the API process. Electron and the mobile client
may both call it, but they do not share a browser document or frontend bundle:

```text
Electron renderer ───────┐
                         ├── OpenCode sidecar API ── database / execution
Mobile PWA ── SDK + SSE ─┘
```

## Origins

There are two public origins:

- `OPENCODE_PUBLIC_URL`: the API origin exposed by Cloudflare Tunnel.
- `OPENCODE_PWA_URL`: the static mobile PWA origin.

The sidecar must allow the PWA origin with `opencode serve --cors`. The PWA
never assumes that its own origin is the API origin; it receives the API URL
from the pairing link or from its connection screen.

## Pairing

`pair.begin` remains an API operation authenticated by the desktop. When both
public URL variables are configured, its QR URL has this shape:

```text
https://mobile.example.com/?server=https%3A%2F%2Fapi.example.com#pair=K7M2XQ
```

The API URL is ordinary routing metadata and may be in the query string. The
short-lived pairing code remains in the fragment so it is not sent in HTTP
requests, access logs, or referrers. The mobile client exchanges the code with
`pair.claim`, stores the returned device token locally, and supplies device
credentials to the generated SDK client for future REST and SSE calls.

## Scope Boundary

The first mobile slice owns connection setup, pairing, device-token storage,
session listing/creation, message history, prompt submission, and instance SSE
refresh. It does not import Electron, Core, Server implementation services, or
the desktop renderer. The SDK is the only typed API dependency.

The current implementation intentionally starts with a small independent UI.
Desktop component reuse can be considered later only after stable mobile
contracts and bundle boundaries are established.
