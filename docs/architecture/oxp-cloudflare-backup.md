# OXP Cloudflare backup transport

OXP supports OpenAI Secure MCP Tunnel and Cloudflare Tunnel as independent
transports to the same local OXP MCP endpoint. Cloudflare is an optional second
ChatGPT connector: it has its own public HTTPS URL, while retaining the same
OXP tools, grants, sidecar authorization, and receipts. Users may choose either
connector as primary in ChatGPT. OpenFork does not attempt to control ChatGPT's
connector selection or promise automatic failover.

## Ownership and request path

The sidecar remains authoritative for the OXP MCP listener, its unguessable
local endpoint, and all tool authorization. Electron main owns Cloudflare
credentials, the Cloudflare process, lifecycle, status, and the narrow relay.
The renderer receives only a configured/not-configured status and the public
backup URL needed to install the second ChatGPT connector.

For Cloudflare, requests flow through:

`ChatGPT backup connector -> Cloudflare edge -> cloudflared -> loopback relay
127.0.0.1:42991 -> current secret OXP endpoint -> existing MCP dispatcher`.

The remote-managed Cloudflare Tunnel must route the user's hostname to
`http://127.0.0.1:42991`. The relay listens only on loopback, forwards only its
stable random bearer path and matching protected-resource metadata path,
rewrites Host to the local OXP listener's expected loopback value, removes the
public Origin header, and rewrites the metadata resource URL to the public
HTTPS endpoint. It does not expose a generic proxy or change the OXP dispatcher.
The stable public bearer path is stored in OS-backed encrypted credential
storage and is not written to diagnostics.

Cloudflare credentials are purpose-specific and stored in the existing OS-backed
OXP credential store. The tunnel token is written only to a private temporary
file while cloudflared runs because Cloudflare supports token-file input; it is
removed after confirmed shutdown. `cloudflared` is pinned and checksum-verified
at build time, staged outside app.asar, and its Apache-2.0 license is included.
Cloudflare's managed tunnel reconnects at the process level; Electron restarts an
unexpectedly exited process with bounded backoff and verifies the public metadata
route before reporting the backup connected.

## Failure and setup behavior

The OpenAI tunnel-client's Cloudflare companion is not this backup: it still
depends on OpenAI's control-plane poll. The independent Cloudflare transport uses
the user's remotely managed Cloudflare tunnel and hostname, so it does not rely
on OpenAI's tunnel control plane. It does rely on the user's PC, network,
Cloudflare tunnel configuration, DNS/hostname, and ChatGPT availability.

Quick Tunnels are not used: they issue temporary hostnames and are unsuitable
for this persistent MCP backup. The backup URL must be installed as a separate
custom MCP connector in ChatGPT. If OpenAI's connector is unavailable, the user
selects the Cloudflare connector in ChatGPT; OpenFork cannot transparently switch
the connector selected by ChatGPT.

The Cloudflare connector can be started with its tunnel token before a public
hostname is configured. This lets Cloudflare register the connector before the
user adds the hostname route. Until the hostname is saved and routes to the
loopback relay, OpenFork reports the connector as starting and does not publish
a usable backup URL. Once a hostname exists, the relay route is configured and
OpenFork verifies its public protected-resource metadata endpoint. Unexpected
`cloudflared` exits include a bounded, token-redacted diagnostic tail in status
so setup and authentication failures can be distinguished from route failures.
OpenFork passes an explicit temporary, empty cloudflared config so a user's+default `~/.cloudflared/config.yml` cannot override or invalidate the remote+tunnel's dashboard-managed routes.

Status `connected` requires a successful HTTPS request to the configured public
protected-resource metadata route and a matching returned resource URL. A
Cloudflare process registration alone is not sufficient proof that the hostname
route reaches OXP. Disconnect first revokes the relay target, then stops the
Cloudflare process and relay. Disabling OXP also stops both transports before
retiring the sidecar endpoint.

## Verification

`packages/desktop/src/main/oxp/cloudflare-relay.test.ts` exercises the actual
HTTP relay against a loopback fixture: allowed bearer-path forwarding, public
metadata rewriting, local Host translation, Origin removal, and rejection of
other paths. Desktop config and credential tests cover hostname validation,
backup auto-connect persistence, and separate encrypted Cloudflare credentials.
Desktop and app typechecks cover the controller, preload, Settings, and renderer
projection boundary.
