# Tunnel and Secure-Ingress Support for Mobile Pairing

Status: active direction (2026-09-21)

This document describes how a tunnel-backed (or reverse-proxied) HTTPS endpoint
becomes the transport for the unified PWA pairing + OFXP identity model. It
extends `08-separate-origin.md` and does not change its origin split.

## The merge model

Pairing no longer treats the stored URL as the backend's identity:

- the OFXP public identity (`peerID`, `fingerprint`, `realmID`) is the identity;
- the paired HTTPS endpoint is the transport;
- the persisted identity pin is the merge point between the two.

A tunnel is therefore not a special case to be trusted. It is a transport that
must still satisfy the pin before the phone sends its device credential.

```text
Cloudflare Tunnel / reverse proxy / direct LAN
        │  (stable public HTTPS hostname)
        ▼
GET /instance/identity   (unauthenticated, cache-control: no-store)
        │  { realmID, ofxp: { peerID, fingerprint, protocolMin/Max, publicOrigin? } }
        ▼
mobile pin check: sameNetworkIdentity(pinned, live)
        │  only on match
        ▼
device credential (Authorization: Basic device:<token>)
```

## Cold start

`packages/mobile/src/bootstrap.tsx` probes `/instance/identity` without
credentials and compares it against the pin stored under
`opencode.mobile.networkIdentity.v1`. On mismatch or an unreachable probe the
restore stops with an explicit message and sends nothing. Legacy unpinned
pairings upgrade to a pin after their first successful authenticated restore.

A login-page or proxy interstitial cannot be pinned: the probe requires JSON and
the identity projection parser rejects anything else, so a Cloudflare Access
challenge in front of `/instance/identity` fails closed.

## Server advertisement

The unauthenticated identity route (packages/opencode/src/server/routes/instance/httpapi/server.ts)
now includes an optional `publicOrigin` on the OFXP bootstrap projection when
`OPENCODE_PUBLIC_URL` is configured (packages/opencode/src/ofxp/runtime.ts).
It is normalized to scheme + host and carries no credentials. Mobile parsers
ignore unknown fields; the shared app parser validates the field and drops
malformed values.

`publicOrigin` lets a client distinguish "this HTTP origin is public ingress"
from "this host:port is a directly reachable OFXP wire endpoint".

## Ingress-aware discovery

OFXP peer transport is a dedicated TLS listener (ALPN `ofxp/1`, mutual client
certificates). Public HTTP ingress does not proxy that listener. Seed derivation
in `packages/app/src/utils/ofxp-server-seeds.ts` therefore suppresses the wire
seed when the configured server's host equals the advertised `publicOrigin`
host: the identity is still recorded, but the client does not fabricate an
unreachable `host:port` dial target. Direct/LAN connections keep their seeds.

## Endpoint migration

Quick tunnels rotate hostnames. The Connection sheet exposes "Update address"
(`packages/app/src/components/pwa/connection-endpoint.tsx`, loaded on demand),
which runs the same firewall as cold start:

1. normalize the new URL (HTTPS required for remote hosts);
2. probe the new endpoint's `/instance/identity` without credentials;
3. require `sameNetworkIdentity` against the existing pin;
4. only then verify the stored credential at the new endpoint;
5. persist the new server URL and reconnect. The pin does not change.

Every failure verdict (`invalid-url`, `unpinned`, `identity-unavailable`,
`identity-mismatch`, `credential-invalid`, `unreachable`) is surfaced in the UI
and leaves the stored endpoint untouched. Migration is always user-initiated.

## Operational configuration

- Bind the API listener to loopback and expose it only through the tunnel.
- Set `OPENCODE_PUBLIC_URL` (API origin) and `OPENCODE_PWA_URL` (static PWA
  origin); `pair.begin` then emits the QR URL with `?server=<API origin>` and
  the code in the fragment.
- Serve the PWA origin with `opencode serve --cors <pwa-origin>`.
- Do not edge-cache `/instance/identity`; the route already sends
  `cache-control: no-store`.
- Rate-limit `POST /pair/claim` at the edge in addition to the server's own
  claim rate limiting.
- SSE (`/event`) and the pty WebSocket must stream through the tunnel without
  proxy buffering.
- Do not put an interactive auth challenge in front of `/instance/identity` or
  `/pair/claim`; those are the credential-free bootstrap steps.

## Non-goals

- No automatic failover to another OFXP peer or endpoint.
- OFXP peer trust never transfers the phone's device credential to another
  backend; automatic failover requires an explicit authenticated relay or
  credential-transfer contract that does not exist today.
- The OFXP wire listener is not proxied through public HTTP ingress.
- `cloudflared access tcp` private-access experiments are out of scope.

## Verification inventory

- `bun test src` in `packages/mobile` — identity pinning, tunnel-shaped
  projections, URL-independence, migration verdicts, pairing input, service
  worker cache contract.
- `bun test --conditions=solid --preload ./happydom.ts src/utils/ofxp-server-seeds.test.ts`
  in `packages/app` — ingress suppression, direct-connection seeds, malformed
  origin rejection.
- `bun test test/ofxp/runtime.test.ts -t "retains sanitized ServerConnection seeds"`
  in `packages/opencode` — `publicOrigin` advertisement.
- `bun test test/server/pairing-e2e.test.ts -t "tunnel ingress"` in
  `packages/opencode` — configured PWA/API origins produce the expected QR URL.

## Measured lazy budget

Production build of `packages/mobile` (Vite, minified):

| Chunk | Raw | Gzip |
| --- | --- | --- |
| `connection-settings` (base Connection sheet) | 13,903 B | 3,539 B |
| `connection-endpoint` (migration form, loaded only when expanded) | 1,929 B | 888 B |

The base chunk was already above the earlier ~9.7 KiB figure before this
workstream's additions; the migration form was split into its own on-demand
chunk so opening the Connection sheet does not pay for it. Reducing the base
back toward 9.7 KiB requires shrinking the revoke/network sections that shipped
concurrently, which is out of scope for this change.
