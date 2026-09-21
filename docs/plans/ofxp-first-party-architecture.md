# OFXP — OpenFork Exchange Protocol first-party architecture plan

**Status:** architecture/design phase; migration target, not current behavior  
**Date opened:** 2026-09-20  
**Primary objective:** let an already-running OpenFork Session on one OpenFork
installation securely discover and use explicitly authorized capabilities,
Sessions, workers, and peer messaging on another OpenFork installation without
manual port choreography or collapsing the two installations into one backend.

### Implementation status — 2026-09-20

The first implementation tranche now exists and is intentionally below the
model/UI layer:

- **P0 partially closed**
  - durable peer identity key type selected: EC P-256;
  - `peerID` and fingerprint are derived from canonical SPKI, never endpoint;
  - protocol-v1 Hello / invocation / trace / error schemas exist;
  - bidirectionality is an explicit invariant;
  - pairing transcript/SAS semantics exist independently of transport.
- **P1 substantially underway**
  - durable peer/grant/root schema + migration exists;
  - trust is deny-by-default;
  - grants use optimistic revision fencing;
  - revocation / re-key-required states exist;
  - root projections hide canonical paths;
  - race-safe stable identity material abstraction exists;
  - headless host-key style file store converges concurrent creators and fails
    closed on corrupt state.
- **P2 partially implemented**
  - `_ofxp._tcp` DNS-SD publisher/browser exists as an isolated OFXP owner;
  - candidate projection is bounded, self-filtering, multi-endpoint aware, and
    performs no workspace/bootstrap work;
  - mDNS remains discovery-only and grants zero trust.
- **P3 pairing core implemented, transport still open**
  - initiator/responder are transient ceremony roles only;
  - both peers derive the same 60-bit human SAS from identities + fresh nonces;
  - pairing confirmation is operator-only, single-use, expiring, and bounded;
  - authenticated TLS listener/client integration and route-level rate limiting
    remain to be wired.

Current focused gates: OFXP peer-domain tests, identity-store tests, pairing
tests, discovery tests, protocol-schema tests, and migration consistency are
green. Do not skip the remaining TLS/certificate and desktop-key-custody gates
merely because the semantic core now exists.

**OFXP = OpenFork Exchange Protocol.** OFXP is the OpenFork-defined first-party
peer-agent exchange surface for OpenFork-to-OpenFork collaboration. It is not an
OpenCode compatibility protocol, not a generic remote-server mode, not an ACP
transport, and not a second implementation of OpenFork tools.

The load-bearing product distinction is:

> **A remote ServerConnection makes another OpenFork server the UI's backend.
> OFXP keeps Machine A as the parent runtime and lets its existing Session use a
> separately trusted Machine B as an external peer capability/agent runtime.**

The corresponding OXP distinction is:

> **OXP serves an already-running ChatGPT-side external agent. OFXP serves an
> already-running OpenFork Session through another OpenFork installation.**

This document is the build-against plan. When implementation proves a durable
rule, promote that rule into `docs/architecture/`, `docs/specs/`, repository or
package `AGENTS.md`, or the codebase map as appropriate. Do not make this plan
authoritative merely by leaving stale assumptions in it after the code moves.

---

## 0. Executive architecture

Target topology:

```text
Machine A                                             Machine B
┌──────────────────────────────────┐                 ┌──────────────────────────────────┐
│ OpenFork                         │                 │ OpenFork                         │
│                                  │                 │                                  │
│ parent Session ses_A             │                 │ native Sessions / workers        │
│      │                           │                 │ workspace / Git / shell / MCP    │
│      v                           │                 │      ^                           │
│ native model-facing `ofxp` tool  │                 │      │                           │
│      │                           │                 │ Exchange capability substrate    │
│      v                           │                 │      ^                           │
│ OFXP client + peer directory     │                 │      │                           │
│      │                           │                 │ OFXP admission / authority       │
└──────┼───────────────────────────┘                 │      ^                           │
       │                                             │      │                           │
       │ authenticated encrypted OFXP                │ dedicated OFXP listener          │
       └────────────────────────────────────────────►└──────────────────────────────────┘

        discovery: mDNS/DNS-SD + known-peer cache + existing ServerConnection seeds
```

OFXP has four semantic planes:

1. **Augmentation** — Machine A's Session directly invokes an authorized
   capability owned by Machine B: read/find/edit/Git/process/project/test/etc.
2. **Supervision** — Machine A inspects or controls explicitly authorized native
   Sessions and requests on Machine B.
3. **Delegation** — Machine A creates and supervises durable subordinate workers
   on Machine B.
4. **Peer messaging** — Machine A and Machine B exchange attributable,
   correlated conversational messages without pretending either sender is a
   local resident agent or a human.

Discovery, transport liveness, and cryptographic pairing are supporting concerns.
They are **not** additional authority planes.

The intended internal architecture is:

```text
                            shared Exchange substrate
                         ┌──────────────────────────────┐
                         │ roots / addressing           │
                         │ authority + revalidation     │
                         │ invocation + cancellation    │
                         │ capability executors         │
                         │ supervision                  │
                         │ delegation                   │
                         │ result projection            │
                         │ provenance                   │
                         └──────────────┬───────────────┘
                                        │
                         ┌──────────────┴───────────────┐
                         │                              │
                      OXP adapter                    OFXP adapter
                 ChatGPT principal              OpenFork peer principal
                 Secure MCP tunnel              network peer transport
                 OXP connector grant            per-peer local grant
                 parent tool epoch              durable peer identity
```

The shared substrate is a target architecture, **not permission to perform a
large mechanical OXP rename before behavior is understood**. Extract only seams
that are genuinely protocol-neutral and keep OXP green throughout the migration.

---

## 1. Ground-truth sources

This plan is derived from executable/source-level behavior first, following the
repository's `AGENTS.md` source-of-truth rules.

### 1.1 Repository architecture contracts

Read before substantial OFXP implementation:

- `AGENTS.md`
- `FORK.md`
- `docs/README.md`
- `docs/map/README.md`
- `docs/map/architecture.md`
- `docs/map/v1-v2.md`
- `docs/map/surfaces.md`
- `docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md`
- `packages/opencode/AGENTS.md`
- the nested `AGENTS.md` for every package/surface being changed

The critical repository laws are:

- design from the authoritative owner outward;
- keep Tier 0/1 work out of `InstanceStore`;
- require explicit locations for Tier 2/3 operations;
- do not reconstruct semantic ownership from provider `role`;
- keep provenance, instruction authority, trust, and provider lowering separate;
- preserve the mature V1/fork production runtime rather than migrating local
  APIs/runtime to current/V2 merely because current code exists;
- preserve unrelated work in the concurrently modified worktree.

### 1.2 Existing remote-server/client precedent

Current evidence:

- `packages/app/src/context/server.tsx`
  - `ServerConnection.Http` stores an HTTP endpoint and optional credentials;
  - `ServerConnection.Ssh` represents a desktop-owned SSH/proxy connection;
  - WSL and sidecar variants already distinguish local from remote runtimes;
  - remote project buckets are keyed per server.
- `packages/app/src/components/dialog-select-server.tsx`
  - current remote servers are added manually by URL;
  - health/protocol probes precede persistence;
  - this is useful UX/transport precedent, **not** the OFXP trust model.

OFXP must not turn `ServerConnection` into peer authority. Existing remote
connections may seed peer discovery after identity verification, but URL/password
knowledge is not an OFXP capability grant.

### 1.3 Existing mDNS and instance-identity precedent

Current evidence:

- `packages/opencode/src/server/mdns.ts`
  - uses `bonjour-service`;
  - currently publishes an HTTP service;
  - does not currently provide the OFXP browse/peer-directory behavior required
    by this plan.
- `packages/opencode/src/server/server.ts`
  - already supports `--mdns`;
  - publishes only for non-loopback listeners;
  - listener port may be dynamically chosen.
- `packages/opencode/src/server/service-discovery.ts`
  - publishes secret-free local rendezvous descriptors;
  - explicitly treats discovery as a hint, not identity proof.
- `packages/opencode/src/server/shared/instance-identity.ts`
  - separates durable `realmID`, process `instanceID`, PID/start/version, and
    listener address;
  - explicitly states that a listening port is not evidence of identity;
  - provides an expect-instance header to close probe/use races.

OFXP should preserve the same **identity is not endpoint** principle across
machines.

### 1.4 Existing device-pairing precedent

Current evidence:

- `packages/core/src/device.ts`
  - 90-second single-use pairing codes;
  - rate-limited unauthenticated claim path;
  - plaintext device token returned once and only a hash persisted;
  - revocation and last-seen state are durable.
- `packages/opencode/src/server/routes/instance/httpapi/groups/pair.ts`
  - separates authenticated pair-code minting from public claim;
  - bounds pair input and documents the bootstrap exception.
- `packages/opencode/src/server/routes/instance/httpapi/groups/device.ts`
  - provides durable revocation/listing.
- `packages/opencode/test/server/pairing*.test.ts`
  - already verifies begin/claim/replay/revoke/rate-limit behavior end-to-end.

OFXP should reuse the **ceremony and lifecycle lessons**, not reuse the device
bearer token as its peer identity. OFXP needs durable asymmetric peer identity so
endpoint/IP/port changes do not change who the peer is.

### 1.5 OXP capability/security oracle

Read before implementing the exchange layer or any OFXP capability:

- `docs/plans/oxp-first-party-architecture-ledger.md`
- `packages/opencode/src/oxp/**`
- `packages/desktop/src/main/oxp/**`
- `packages/app/src/oxp/**`
- `packages/app/src/components/settings-v2/oxp.tsx`

Particularly important current OXP components:

- `OxpAuthority` — explicit external grant + revalidation;
- `OxpRoot` — approved-root identity/addressing;
- `OxpInvocation`-equivalent request boundary in the host/server path;
- direct capability adapters such as read/find/edit/patch/Git/process/project;
- supervision/request/worker services;
- lazy capability/MCP brokerage;
- compact model-facing surface in `oxp/surface.ts`;
- conservative handling of ambiguous external mutations;
- provenance that never impersonates a resident OpenFork agent.

OFXP should converge with these semantics at the lowest correct owner. Do not
copy the `oxp/` directory into `ofxp/` and create two filesystem/Git/process
runtimes.

### 1.6 OXP secure-storage precedent

Current desktop OXP credentials use Electron `safeStorage` through:

- `packages/desktop/src/main/oxp/credentials.ts`
- `packages/desktop/src/main/oxp/credentials-store.ts`

The implementation explicitly refuses Linux Chromium `basic_text` fallback.
OFXP identity/private-key storage needs a protocol-neutral abstraction because
headless/homelab OpenFork must also work without Electron. Desktop should use
OS-backed secure storage where available; headless mode needs a narrowly scoped
host-key file or equivalent with strict permissions and no renderer exposure.

### 1.7 Swarm/peer provenance precedent

Current OpenFork already distinguishes host-authored peer input from human input:

- `packages/schema/src/session-turn-provenance.ts`
- `packages/opencode/src/swarm/session-admission.ts`
- `packages/session-ui/src/components/message-provenance-presentation.ts`
- `docs/plans/swarm-port-plan/00-first-party-overhaul-2026-09-18.md`

The existing Swarm plan also establishes a directly reusable security rule:
cross-boundary communication needs an explicit attenuated grant and must never
pretend the sender belongs to the destination collaboration domain.

---

## 2. Product thesis and user stories

### 2.1 Primary user story

Machine A is the user's desktop. A normal OpenFork Session is already running.
Machine B may be:

- the user's homelab server;
- another workstation;
- a laptop on the same LAN;
- another trusted person's computer;
- later, a peer reachable through a tailnet/VPN/routed network.

The model on Machine A should be able to say, conceptually:

```text
peer.list
  -> homelab (online)

capability.list(peer=homelab)
  -> project/read/git/process/worker/...

capability.call(peer=homelab, root=alphagym, capability=project, ...)

worker.start(peer=homelab, root=alphagym, ...)

session.turn(peer=homelab, session=ses_..., prompt=...)
```

without the human manually wiring ports into the model prompt and without
changing Machine A's active backend to Machine B.

### 2.1.1 Bidirectional peer invariant

OFXP is **bidirectional**. "Machine A" and "Machine B" describe one invocation,
not permanent client/server roles.

After pairing, either installation may be the parent runtime for a later
invocation:

```text
Desktop Session  -> OFXP -> Homelab
Homelab Session  -> OFXP -> Desktop
```

Pairing establishes mutual cryptographic recognition. Capability authority is
still directional and independently configured on each side:

```text
Desktop -> Homelab: read + workers on selected roots
Homelab -> Desktop: messaging only
```

Therefore the implementation must not persist concepts such as "client peer"
and "server peer" as durable identity roles. Every enabled OpenFork instance can
own both an OFXP listener and an OFXP client/connection manager, subject to local
configuration and grants.

### 2.2 Discovery UX goal

On an ordinary same-LAN setup:

1. enable OpenFork Network / OFXP;
2. nearby OpenFork installations appear automatically;
3. perform one explicit pairing ceremony;
4. choose what Machine A is allowed to do on Machine B;
5. authorized peers become available to native OpenFork agents.

Dynamic listener ports are expected. Users should not need to know them.

### 2.3 Existing-server integration goal

If the user already configured Machine B as an OpenFork `ServerConnection`, that
known transport should act as an OFXP **discovery seed**. The user should not
need to enter Machine B twice.

### 2.4 Homelab/headless goal

OFXP must not require Electron on Machine B. A headless OpenFork runtime should
be able to:

- own a stable peer identity;
- advertise/discover where the network supports it;
- expose the dedicated OFXP listener;
- perform a CLI/bootstrap pairing ceremony;
- persist grants/revocation;
- run delegated workers after the originating network request is gone.

### 2.5 Agent-to-agent goal

OFXP is not only remote tool invocation. It must support attributable
OpenFork-to-OpenFork conversational interaction:

- direct turn against an explicitly targeted remote Session;
- durable worker delegation;
- durable peer mail/threading for asynchronous collaboration;
- correlated replies;
- eventual offline/reconnect delivery without transcript spoofing.

---

## 3. Non-goals

OFXP v1 is **not**:

- a generic remote desktop protocol;
- an SSH replacement;
- a replacement for `ServerConnection` when the user actually wants the UI to
  use another OpenFork server as its backend;
- a mechanism for silently exposing the ordinary OpenFork HTTP API to the LAN;
- a reason to bind the normal desktop sidecar to `0.0.0.0`;
- a cloud account or global public rendezvous service;
- a trust-transitive mesh where A trusting B means A trusts C;
- a mechanism for a model to pair new machines or widen its own grants;
- a hidden way to turn peer messages into System/operator instructions;
- a second filesystem/Git/process/session implementation;
- a promise that arbitrary OpenCode clients/plugins can speak OFXP;
- a reason to migrate the mature V1 execution/runtime or local client API to
  current/V2.

Wide-area discovery/relay is deliberately post-v1. The semantic protocol must
allow another discovery/transport provider later without changing authority,
provenance, or capability ownership.

---

## 4. Terminology and identity model

Use these terms consistently.

### 4.1 Peer

A **Peer** is one durable OpenFork trust realm participating in OFXP. It is not an
IP address, DNS name, listener, process, Session, or model.

Target identity shape:

```ts
type OfxpPeerIdentity = {
  peerID: PeerID
  realmID: string
  label: string
  identityPublicKey: string
  fingerprint: string
}
```

`peerID` is stable across:

- DHCP address changes;
- listener port changes;
- Wi-Fi/Ethernet changes;
- process restarts;
- OpenFork upgrades.

Rotating the identity key is a first-class re-key event, not an endpoint update.

### 4.2 Candidate

A **Candidate** is an untrusted discovered endpoint claiming an OFXP identity.
Candidates may come from mDNS, an existing remote-server connection, or the
known-peer cache.

Candidates have zero capability authority.

### 4.3 Trusted peer

A **Trusted Peer** is a cryptographic identity that completed an explicit pairing
ceremony and has not been revoked.

Trust means "this is the same peer identity I paired." It does not mean "this
peer can read/write/process everything."

### 4.4 Peer grant

A **Peer Grant** is Machine B's durable policy describing what a paired Machine A
may do on B.

Pairing and grants are deliberately separate.

### 4.5 Parent Session

The **Parent Session** is the OpenFork Session whose resident model emitted the
local `ofxp` tool call on Machine A.

Machine B must preserve this as causal/provenance metadata. It must never treat
that Session as a local resident Session or as the human.

### 4.6 Remote resource references

Never treat a remote bare ID as globally self-describing. Address cross-machine
resources with a peer namespace:

```ts
type RemoteSessionRef = { peerID: PeerID; sessionID: SessionID }
type RemoteWorkerRef  = { peerID: PeerID; workerID: WorkerID }
type RemoteRootRef    = { peerID: PeerID; rootID: RootID }
```

---

## 5. Hard architectural laws

These are the design's non-negotiable invariants.

### 5.1 Discovery is not trust

mDNS/DNS-SD TXT data, IP addresses, DNS names, ServerConnection labels, and
claimed peer IDs are hints only. No discovered endpoint gains authority before
cryptographic identity verification and pairing.

### 5.2 Pairing is not capability authority

A paired peer starts with no dangerous capability grant unless the operator
explicitly grants one. Pairing establishes identity continuity only.

### 5.3 Models cannot self-pair or self-escalate

The native model-facing `ofxp` tool may use already authorized peers. It must not
expose operations to:

- approve a discovered candidate;
- accept a pairing request;
- rotate peer trust;
- add approved roots;
- widen an inbound peer grant;
- enable nested delegation.

Those are operator surfaces (UI/CLI/admin API) with explicit human authority.

### 5.4 Peer authority is never transitive

If A trusts B and B trusts C, A does not thereby trust C.

If A delegates to B and that B worker can itself use OFXP, B -> C requires a
separate B-to-C grant **and** an explicit nested-peer-delegation policy from A's
operation context where the product supports it.

Default: nested OFXP delegation is disabled.

### 5.5 Never impersonate a resident agent

An OFXP invocation on Machine B is attributable to:

```text
actor          = external OpenFork peer
sourcePeer     = peer_A
sourceSession  = ses_A
target         = root/session/worker/resource on B
operation      = ...
```

It is not attributable to B's resident model unless B later runs a model turn
that reacts to the peer input.

### 5.6 Peer text is conversational, not privileged

A trusted peer's text message does not become System/operator instruction
authority merely because its transport identity is trusted.

OFXP peer input is host-produced Synthetic/conversational input and should lower
through the provider conversational lane unless a separate trusted OpenFork rule
creates genuinely privileged policy.

### 5.7 Explicit location for Tier 2/3

Every workspace-dependent remote operation must name an approved `rootID` or
derive its location from an explicitly authorized target Session/worker.

Missing OFXP location must never become `process.cwd()`.

### 5.8 Remote paths are root-relative

The network contract addresses:

```text
peerID + rootID + relativePath
```

not arbitrary Machine-B absolute paths. Absolute/canonical paths remain local
authority state on B except where an operator UI explicitly needs to display
them locally.

### 5.9 One semantic capability owner

OFXP does not implement another read/edit/Git/process/test/session/worker engine.
It adapts authenticated peer requests into existing OpenFork-owned services or
protocol-neutral executors extracted from OXP/native tools.

### 5.10 Main sidecar remains private by default

Desktop's ordinary OpenFork sidecar remains authenticated loopback HTTP/SSE.
Enabling OFXP must not expose that complete API to the LAN.

OFXP owns a separate, narrow, explicitly enabled network listener.

### 5.11 Live authority is revalidated

Catalog discovery is not authorization. Every operation rechecks the current
peer grant and target/root policy at execution time and immediately before
dangerous commit boundaries where the underlying service supports revalidation.

Revocation must take effect without waiting for a peer to reconnect.

### 5.12 Ambiguous mutation is never blindly retried

If the network fails after a remote mutation may have begun, Machine A must not
automatically replay the mutation unless the operation's idempotency contract and
remote invocation state prove retry is safe.

### 5.13 Durable work outlives connections

Remote delegated workers/background resources are owned by Machine B's durable
runtime, not by one TCP/MCP request. A network disconnect does not implicitly
cancel a worker that was intentionally created as durable work.

### 5.14 Disabled means near-zero cost

When OFXP is disabled there should be no:

- OFXP network listener;
- mDNS OFXP advertisement;
- mDNS OFXP browse loop;
- reconnect loop;
- peer health polling fanout;
- remote tool-catalog hydration;
- workspace Instance creation.

Configuration visibility and durable peer rows may remain cheap Tier 0 state.

---

## 6. Bottom-up ownership model

### 6.1 Producer -> consumer path

For a representative remote capability call:

```text
Machine A resident model emits `ofxp`
        │
        v
local Tool permission/admission
        │
        v
OFXP client resolves trusted peerID
        │
        v
PeerDirectory chooses a currently verified endpoint
        │
        v
authenticated OFXP transport
        │
        v
Machine B OFXP admission
        │
        ├── verify peer identity
        ├── resolve operation plane
        ├── resolve explicit root/target
        ├── authorize current PeerGrant revision
        └── stamp invocation/provenance
        │
        v
shared Exchange / native domain service
        │
        v
existing OpenFork capability/session/worker owner
        │
        v
bounded OFXP result projection
        │
        v
Machine A `ofxp` tool result -> parent Session
```

At no point does the OFXP adapter become the source of project, Session, model,
filesystem, Git, process, or worker truth.

### 6.2 Reverse demand path: peer UI

The Settings peer list needs only compact Tier 0/1 facts:

| UI fact | Owner | Cost rule |
|---|---|---|
| nearby candidate | `OfxpDiscovery` live projection | No Instance |
| paired peer label/fingerprint | durable `OfxpPeer` | No Instance |
| online/offline/last seen | `OfxpPeerDirectory` compact liveness projection | No per-row polling |
| granted capability classes | durable `OfxpPeerGrant` | No workspace bootstrap |
| approved roots summary | durable peer-root rows/project metadata | Tier 1 max |
| recent OFXP activity | bounded invocation/activity projection | No transcript hydration |

The peer settings page must never initialize plugins, tools, providers, LSP, VCS,
snapshots, or Sessions merely to draw rows.

### 6.3 Ownership tiers

| Operation | Tier | Rule |
|---|---:|---|
| enable/disable OFXP | 0 | process/global config |
| list trusted peers/grants | 0 | durable global state |
| browse mDNS candidates | 0 | process-global network observation |
| pair/revoke identity | 0 | operator trust state; no workspace |
| peer hello/version/fingerprint | 0 | bootstrap-free identity |
| list approved root aliases | 1 | durable location metadata only |
| validate/resolve a configured root | 1 | no execution graph |
| list workspace-dependent agents/models/MCP catalog | 2 | explicit root required |
| read/edit/Git/process/test/typecheck/etc. | 3 | explicit approved root; execution services allowed |
| remote Session turn | 3 | explicit target Session -> its durable location |
| delegated worker start/continue | 3 | explicit root/worker location |

Negative invariant: **candidate discovery, pairing, peer listing, peer health, and
grant editing create zero workspace Instances.**

---

## 7. Discovery architecture

### 7.1 Discovery providers, not one hard-coded mechanism

Define one semantic owner:

```ts
interface OfxpDiscoveryProvider {
  start(): Effect
  candidates(): Stream<OfxpCandidateEvent>
  stop(): Effect
}
```

Target providers:

1. `MdnsOfxpDiscovery` — same-link zero-config discovery.
2. `KnownPeerDiscovery` — previously paired endpoints/hostnames, used as reconnect
   hints when mDNS is unavailable.
3. `ServerConnectionDiscovery` — bootstrap from an existing configured OpenFork
   remote server after verifying that server's identity.
4. Future routed/tailnet/relay provider — explicitly deferred; must feed the same
   candidate model rather than bypass peer identity/authority.

The `OfxpPeerDirectory` owns deduplication and candidate/trusted-peer correlation.
Providers do not each maintain their own trust store.

### 7.2 mDNS/DNS-SD profile

Use standard mDNS/DNS-SD (RFC 6762/6763), not a custom UDP broadcast protocol.

Target service type:

```text
_ofxp._tcp.local
```

The listener binds an ephemeral port (`port: 0` or equivalent) unless an advanced
operator configuration pins one. DNS-SD advertises the actual bound port.

TXT metadata must be small and secret-free. Candidate fields may include:

```text
protocol=1
peer=<public peer id or truncated routing id>
realm=<non-secret realm identifier>
version=<OpenFork version>
pairing=1
```

Do **not** advertise:

- credentials/tokens;
- absolute project/root paths;
- project names unless a later explicit privacy decision allows them;
- Session IDs/titles;
- model/provider/account information;
- user prompts/activity.

### 7.3 Link-local limitation is explicit

mDNS is normally link-local. OFXP v1 therefore guarantees zero-config discovery
on ordinary same-link LANs, not arbitrary VLAN/routed/public networks.

Known-peer and ServerConnection seeds provide useful fallback without changing
the trust model. Wide-area rendezvous is a separate future transport/discovery
problem.

### 7.4 Candidate lifecycle

```text
unseen -> discovered -> refreshed -> stale -> expired
                    \-> correlated_with_trusted_peer
```

Candidate TTL/liveness is ephemeral. Pairing/trust is durable.

No candidate disappearance revokes a peer. It only changes reachability.

### 7.5 No N-peer active polling

Do not create one timer/health loop per discovered peer.

The discovery owner should consume DNS-SD add/update/remove events and maintain a
bounded projection. Active transport probes happen lazily when:

- the operator opens a peer detail/pairing flow;
- an agent actually invokes OFXP;
- a bounded shared liveness refresh requires verification;
- durable outbound work is waiting for a previously trusted peer.

---

## 8. Peer identity, trust, and pairing

### 8.1 Stable asymmetric identity

Each OpenFork trust realm owns a long-lived asymmetric identity keypair suitable
for transport authentication or identity binding.

Requirements:

- cryptographically random;
- stable across restarts/ports/IPs;
- public fingerprint displayable to the operator;
- private key never exposed to renderer/model/session/tool output;
- explicit rotation/re-key lifecycle;
- revocation of old peer bindings after unexpected key change.

Do not derive the identity key from machine name, state path, MAC address, account
ID, or other guessable host metadata.

### 8.2 Private-key storage abstraction

Introduce a protocol-neutral `OfxpIdentityKeyStore`/host-key owner rather than
coupling identity to Electron.

Desktop target:

- use OS-backed secure storage where available;
- preserve OXP's refusal to treat insecure Linux Chromium `basic_text` as secure
  storage;
- never copy plaintext key material into renderer/localStorage/SQLite.

Headless target:

- support an unattended host-key file owned by the local OS account with strict
  permissions (SSH-host-key style) or an equivalent platform secret provider;
- fail if permissions/ownership are unsafe;
- document the security boundary honestly;
- never require Electron merely to start OFXP.

Exact certificate/key encoding is a P0 design-gate decision.

### 8.3 Purpose-built peer trust, not device bearer auth

The existing `Device` pairing system is optimized for PWA/device bearer tokens.
OFXP trust should be a separate domain because it needs:

- asymmetric peer identity;
- mutual identity continuity;
- per-peer capability grants;
- root grants;
- protocol-version/fingerprint state;
- peer-specific revocation/re-key handling.

Do not overload `DeviceTable` with OFXP peer semantics.

### 8.4 Pairing state machine

Target state:

```text
candidate
   │ operator initiates
   v
pairing_pending
   │ authenticate remote identity + human ceremony
   v
paired
   │ independent capability/root grants
   v
authorized
   │
   ├── online/offline are reachability overlays
   ├── rekey_pending requires operator confirmation
   └── revoked is terminal until new pairing
```

### 8.5 Human ceremony

Normal desktop flow:

```text
Nearby OpenFork
  Homelab
  [Pair]

Machine B:
  "Jackson's Desktop wants to pair"
  fingerprint/SAS: ember-canvas-vapor-cedar
  [Allow] [Reject]

Machine A:
  fingerprint/SAS: ember-canvas-vapor-cedar
  "Confirm the code matches Machine B"
```

The exact SAS/QR/bootstrap construction is a security-sensitive P0 decision. Do
not implement an ad-hoc key agreement or custom cryptographic primitive simply
because displaying words is easy.

Requirements whichever construction is chosen:

- encrypted transport before secrets/capability grants are exchanged;
- peer public identity bound to the ceremony;
- replay resistance;
- short TTL for bootstrap material;
- per-source and process-global rate limiting for public bootstrap endpoints;
- high-entropy QR/deep-link form where possible;
- human-readable fallback;
- no pairing secret in normal URL query logs/history (fragment or explicit code
  channel where applicable);
- both sides persist the resulting peer identity only after explicit approval.

### 8.6 Pair once, grant independently

One pairing ceremony may establish mutual identity recognition, but **authority
is directional**:

```text
A trusts B identity
B trusts A identity

B grant for A: read + workers on /alphagym
A grant for B: messaging only
```

Those are valid independent policies.

### 8.7 Key-change behavior

If a known `peerID` or endpoint presents an unexpected public key:

- do not silently update the key;
- mark the peer as `rekey_required`/identity mismatch;
- refuse normal OFXP operations;
- require explicit operator reconciliation;
- preserve the old fingerprint and audit lineage.

Endpoint changes are normal. Identity-key changes are not.

---

## 9. Transport and wire protocol

### 9.1 Dedicated OFXP listener

OFXP owns a separate listener from the ordinary OpenFork API.

Desktop target:

```text
ordinary sidecar: 127.0.0.1:<sidecar port>       normal GUI/API
OFXP listener:     LAN interfaces:<ephemeral>    paired peer traffic only
```

Headless `serve` may still expose the ordinary server by explicit operator
configuration, but that does not remove OFXP's separate authentication and
authority boundary.

### 9.2 Encryption/authentication

Preferred direction: TLS 1.3 using platform/runtime TLS primitives, with a stable
OpenFork peer identity cryptographically bound/pinned across connections.

Do not implement custom bulk encryption, MACs, or key agreement.

P0 must decide the exact v1 profile, likely one of:

- self-issued peer certificates + pinned fingerprints + mutual authentication
  after pairing;
- a small audited identity-signature layer over server-authenticated pinned TLS;
- another mature library/protocol only if it materially reduces custom security
  code and works on Windows/Linux/headless OpenFork.

The design must support dynamic peer trust/revocation without treating a public
WebPKI CA as proof of OpenFork peer authorization.

### 9.3 OFXP semantic protocol vs wire encoding

OFXP is the semantic product contract. Its first wire profile should reuse
standards already present in OpenFork where useful.

Preferred v1 data plane:

```text
OFXP semantics
    over
MCP Streamable HTTP / existing MCP SDK primitives
    over
authenticated TLS peer transport
```

Reasons:

- OXP already proves tools/list + tools/call + schema projection;
- cancellation and bounded structured results already have implementation
  precedent;
- capability descriptions can remain lazy;
- the model on Machine A does not need to see MCP as an external integration;
- MCP remains a wire adapter, not the domain owner.

This is a target, not a requirement to route OFXP through OpenFork's external-MCP
integration subsystem. The OFXP client/server should use the MCP protocol library
directly over its peer transport and shared Exchange services.

### 9.4 Version negotiation

Handshake/bootstrap must advertise a compact protocol envelope independent of
OpenFork application version:

```ts
type OfxpHello = {
  protocolMin: number
  protocolMax: number
  peerID: PeerID
  realmID: string
  openforkVersion: string
  surfaceFingerprint: string
  capabilities: {
    pairing: boolean
    mcp: boolean
    messaging: boolean
    supervision: boolean
    delegation: boolean
  }
}
```

Major incompatibility fails clearly. Minor capability differences negotiate by
feature/capability discovery rather than assumptions from application version.

### 9.5 Connection ownership

One process-global `OfxpConnectionManager` owns outbound peer connections.

Rules:

- lazy connect;
- bounded connection pool;
- deduplicate concurrent connects to the same `peerID`;
- endpoint choice comes from verified candidate/known-peer state;
- identity is rechecked on every new connection;
- exponential bounded reconnect only when there is real demand;
- no permanent reconnect loop for every offline peer;
- convergent shutdown/disable.

---

## 10. Shared Exchange substrate: OXP + OFXP convergence

### 10.1 Why extraction is required

Current OXP already contains many concepts OFXP needs:

- roots;
- grant evaluation/revalidation;
- capability catalog/brokerage;
- read/find/edit/patch/Git/process/project/etc.;
- supervision;
- worker delegation;
- request mediation;
- provenance/result shaping.

Those should not be independently implemented a second time.

### 10.2 What remains OXP-specific

Keep these in the OXP adapter/lifecycle:

- ChatGPT/OpenAI connector identity;
- Secure MCP tunnel client lifecycle;
- OpenAI credential/file-exchange specifics;
- ChatGPT parent-session correlation;
- OXP parent-tool epoch behavior;
- OXP-specific tool prose and connector UI.

### 10.3 What can become protocol-neutral

Candidate shared services, after source-level dependency analysis:

```text
ExchangeRoot
ExchangeAuthority
ExchangeInvocation
ExchangeCapabilityCatalog
ExchangeCapabilityExecutor(s)
ExchangeSupervision
ExchangeDelegation
ExchangeResult
ExchangeProvenance
```

Names are illustrative. Do not rename/export anything until responsibility and
dependency direction are proven.

### 10.4 Principal is explicit

Shared Exchange code must never erase who is calling it.

Conceptual principal union:

```ts
type ExchangePrincipal =
  | {
      kind: "openai_external_agent"
      connectorID: OxpConnectorID
      parentSessionRef?: string
    }
  | {
      kind: "openfork_peer_session"
      peerID: OfxpPeerID
      sourceSessionID: SessionID
      sourceInvocationID: OfxpInvocationID
    }
```

Authority, provenance, metrics, and audit paths consume the principal; adapters
must not fabricate a native target Session merely to reuse context.

### 10.5 Extraction strategy

Do not begin OFXP by moving all of `src/oxp`.

Preferred migration sequence:

1. implement OFXP discovery/trust independent of capabilities;
2. identify the first read-only capability seam needed by both OXP and OFXP;
3. extract that lowest correct executor/authority primitive with tests;
4. keep OXP behavior byte/semantically stable where required;
5. add OFXP adapter coverage;
6. repeat capability by capability;
7. only then consolidate package/file naming where the shared ownership is
   proven.

This prevents a large rename from masquerading as architecture.

---

## 11. Peer grants and effective authority

### 11.1 Directional grant model

Machine B owns the inbound grant for Machine A.

Conceptual shape:

```ts
type OfxpPeerGrant = {
  peerID: PeerID
  revision: number

  read: GrantMode
  write: GrantMode
  git: GrantMode
  process: GrantMode
  integrations: GrantMode
  browser: GrantMode
  filesReceive: GrantMode
  filesSend: GrantMode

  messaging: GrantMode
  sessionSupervision: "none" | "approved-roots"
  requestSupervision: GrantMode
  delegation: "disabled" | "spawn"
  nestedDelegation: boolean

  expiresAt?: number
}

type GrantMode = "deny" | "allow" // "ask" may be added once remote approval flow is designed
```

The initial implementation may normalize onto OXP's existing booleans/modes if
that is the shared owner. Do not add `ask` accidentally without defining how an
unattended remote caller observes and resumes an approval request.

### 11.2 Root grants

Pairing does not expose all Machine-B projects.

Model root authorization separately:

```ts
type OfxpPeerRootGrant = {
  peerID: PeerID
  rootID: RootID
  alias: RootAlias
  localCanonicalPath: AbsolutePath // local storage only; not advertised
  source?: "manual" | "project"
  approvedAt: number
}
```

Open projects may be convenient candidates in the operator UI, but selecting a
project in Machine B's own project picker does not automatically grant every
paired peer access to it.

### 11.3 Effective authority is intersection, never union

For a remote action:

```text
Machine A parent Session permission
        ∩
Machine A OFXP outbound policy
        ∩
Machine B paired-peer trust
        ∩
Machine B inbound PeerGrant revision
        ∩
Machine B peer RootGrant
        ∩
target Session/resource native policy
```

Every layer may narrow. No layer may enlarge authority granted by another.

### 11.4 Local parent permission still matters

The fact that Machine B allows `process` does not mean every model on Machine A
may invoke remote shell/process without Machine A's own tool/permission policy.

The local `ofxp` tool must classify remote operations and participate in the
normal Session permission model. A remote mutation must not become a permission
bypass merely because the side effect happens on another computer.

### 11.5 Presets are UI only

Operator UX may offer presets such as:

- **Messaging only**
- **Collaborate** — messaging + read + worker delegation on selected roots
- **Custom**

Presets compile to explicit granular grants. They are not separate runtime
authority concepts.

---

## 12. Root/path addressing and privacy

### 12.1 Public root view

Remote peers see a public projection such as:

```ts
type PublicOfxpRoot = {
  id: RootID
  alias: RootAlias
  available: boolean
  projectLabel?: string // only if explicitly chosen as non-sensitive metadata
}
```

They do not need Machine B's canonical path to operate.

### 12.2 Relative path resolution

Capability calls carry:

```text
rootID + relative path
```

Machine B's root owner:

1. resolves current canonical root;
2. verifies the root identity has not been replaced/moved unexpectedly;
3. resolves the relative path beneath it;
4. rejects traversal/escape;
5. revalidates peer authority before mutation.

Reuse OXP approved-root/path primitives where their semantics are already
protocol-neutral.

### 12.3 Cross-platform paths

The wire-level relative-path syntax must be canonical and independent of Windows
vs POSIX host separators. The receiving machine performs local conversion after
validation.

---

## 13. Model-facing `ofxp` tool

### 13.1 One stable top-level tool

Do not permanently register one tool per peer or one remote-prefixed copy of
every OpenFork capability.

Bad:

```text
homelab_read
homelab_edit
homelab_git
wife_pc_read
wife_pc_git
...
```

Target:

```text
ofxp
```

with a stable compact schema and lazy remote discovery.

### 13.2 Suggested namespace/action shape

Illustrative model-facing contract:

```ts
ofxp({ namespace: "peer",       action: "list" })
ofxp({ namespace: "peer",       action: "status", peer: "homelab" })

ofxp({ namespace: "capability", action: "list", peer: "homelab", rootID })
ofxp({ namespace: "capability", action: "describe", peer: "homelab", rootID, capability })
ofxp({ namespace: "capability", action: "call", peer: "homelab", rootID, capability, contract, args })

ofxp({ namespace: "session",    action: "list", peer: "homelab", rootID })
ofxp({ namespace: "session",    action: "messages", peer: "homelab", sessionID })
ofxp({ namespace: "session",    action: "turn", peer: "homelab", sessionID, prompt })

ofxp({ namespace: "worker",     action: "start", peer: "homelab", rootID, ... })
ofxp({ namespace: "worker",     action: "status", peer: "homelab", workerID })
ofxp({ namespace: "worker",     action: "result", peer: "homelab", workerID })
ofxp({ namespace: "worker",     action: "continue", peer: "homelab", workerID, prompt })
ofxp({ namespace: "worker",     action: "cancel", peer: "homelab", workerID })

ofxp({ namespace: "message",    action: "send", peer: "homelab", targetSessionID, body, ... })
ofxp({ namespace: "message",    action: "history", peer: "homelab", threadID })
```

The final schema should follow the compressed-tool-broker architecture and remain
small enough for provider tool registration. Dynamic remote model/catalog state
belongs in list/describe results, not permanent declarations.

### 13.3 Models see trusted peers only

`peer.list` returns peers already authorized for agent use. It should not expose
random unpaired nearby candidates to the model.

Nearby discovery/pairing belongs to operator UI/CLI. This prevents a model from
socially engineering the user through arbitrary LAN advertisements or attempting
self-pairing flows.

### 13.4 Lazy schemas

Remote brokered capabilities follow:

```text
list -> compact capability rows
describe -> bounded prose + input schema + contract/fingerprint
call -> exact contract + args
```

Machine A must not eagerly hydrate every peer's entire remote capability catalog
into every Session prompt.

### 13.5 Peer aliases are presentation, IDs are authority

The model may address a unique human-readable alias such as `homelab` when the
local peer directory resolves it unambiguously. Wire/audit state uses stable
`peerID`.

Ambiguous aliases fail and return bounded candidates. Never fuzzy-pick a peer for
a mutation.

---

## 14. Capability plane

### 14.1 Capability classification

Every remotely exposed capability must be classified, just as OXP does:

1. **Session-independent capability** — invoke a shared executor directly with an
   OFXP principal and explicit root.
2. **Session-targeted capability** — require an authorized remote Session target
   and preserve external-peer provenance.
3. **Resident-agent-only mechanic** — do not expose as a direct OFXP capability
   if it only makes sense inside model-turn/provider state.
4. **Meta-agent operation** — expose through session/worker/request namespaces,
   not disguised as a normal local tool.

### 14.2 Initial capability order

Bring up capabilities in increasing side-effect complexity:

1. project/root metadata;
2. read/find;
3. symbols/typecheck/test read-like operations where safe;
4. edit/patch/write;
5. Git mutation;
6. process/background;
7. external MCP/integrations;
8. browser/computer/file exchange where policy and transport are proven.

Do not gate discovery/identity work on achieving full OXP tool parity first.

### 14.3 Remote integration brokerage

An OFXP peer may eventually call Machine B's configured external MCP tools, but
that remains **B's integration policy**:

```text
A Session -> OFXP -> B Exchange authority -> B MCP broker -> external MCP
```

A must not inherit integration credentials or direct network secrets. Results are
bounded/projected through B.

---

## 15. Session supervision

### 15.1 Target semantics

Authorized OFXP supervision may support:

- list Sessions under approved roots;
- inspect durable Session metadata;
- read bounded message history;
- send/continue a conversational turn;
- pause/resume/abort where native semantics support it;
- inspect child/background agents;
- inspect/reply to Permission/Question requests when separately authorized.

Reuse OXP supervision services after principal/authority extraction rather than
driving Machine B through its UI.

### 15.2 Target Session owns location

For an operation against an existing Session, B resolves its durable Session row
to the current location and verifies that location is covered by the peer's
approved roots.

The caller does not additionally supply an arbitrary conflicting directory.

### 15.3 Remote turn != peer mailbox

`session.turn` means "ask this specific remote Session to run a model turn now."

Peer mail means "durably deliver a peer-authored conversational message," which
may or may not wake a model depending on explicit policy.

Keep these separate so asynchronous mail does not accidentally spend provider
work.

---

## 16. Delegated workers

### 16.1 Durable worker ownership

`worker.start` on Machine B returns durable remote references:

```ts
{
  peerID,
  workerID,
  sessionID,
  invocationID
}
```

The worker is owned by Machine B's normal worker/Session runtime. The OFXP client
connection is merely the initiating transport.

### 16.2 Model/agent policy

Machine A cannot select arbitrary Machine-B models/agents just because they are
installed.

Machine B's peer grant/worker policy determines the allowed model/agent set.
Selection must use the same explicit provider/account/model/variant identity
principles already developed for OXP workers.

### 16.3 Nested delegation

Default false.

If enabled later, every descendant operation carries causal lineage:

```text
originPeerID
originSessionID
traceID
parentInvocationID
hopCount
```

and authority can only narrow with depth.

Set an explicit maximum hop count even when nested delegation is enabled to
protect against peer-agent cycles.

---

## 17. Peer messaging

### 17.1 First-class domain, not text shoved into HTTP

Peer messaging needs durable identities and correlation:

```ts
type OfxpPeerMessage = {
  id: PeerMessageID
  threadID: PeerThreadID
  sourcePeerID: PeerID
  sourceSessionID?: SessionID
  targetPeerID: PeerID
  targetSessionID?: SessionID
  replyTo?: PeerMessageID
  body: string
  createdAt: number
  traceID: string
}
```

Exact storage location is a design task, but the semantic domain must not be
reconstructed from ordinary transcript text.

### 17.2 Inbound Session provenance

When an inbound peer message becomes Session-visible input, persist explicit
provenance at the trusted producer:

```text
owner        = host
source       = ofxp.peer
sourcePeer   = peer_A
sourceRef    = peerMessageID
remoteSessionRef? = peer_A/ses_A
instructionAuthority = conversational
```

Add a first-class `SessionTurnProvenance.Source.OfxpPeer` (or the shared
cross-peer source chosen by provenance architecture) rather than overloading
`SwarmPeer` if the domains need to remain distinguishable.

### 17.3 Wake policy

Durable delivery and provider execution are separate facts.

Target policies:

- `queue` — persist/display message, do not wake model;
- `wake` — admit the message and schedule/run a target Session turn if the peer
  grant + target Session policy allows unattended peer-triggered execution.

Default v1 should be conservative: direct `session.turn` explicitly spends a
model turn; generic peer mail should not silently do so until wake policy is
implemented and visible.

### 17.4 Offline delivery

Initial v1 may require the target peer online for `message.send`, but message IDs
and idempotency must be designed so a durable outbound queue can be added later
without changing provenance semantics.

Future offline queue rules:

- bounded bytes/messages/age;
- explicit expiration;
- at-least-once transport with receiver dedup by message ID;
- no duplicate Session input after retries;
- backpressure visible to sender;
- no infinite reconnect loop.

---

## 18. Invocation identity, retries, cancellation, and ambiguous commit

### 18.1 Every OFXP request has stable correlation

Machine A generates:

```ts
type OfxpInvocationContext = {
  invocationID: UUID
  traceID: UUID
  parentInvocationID?: UUID
  sourcePeerID: PeerID
  sourceSessionID: SessionID
  hopCount: number
}
```

Machine B does not trust source identity fields supplied as plain JSON; they are
bound to the authenticated peer and validated against the envelope.

### 18.2 Retry classes

Classify operations:

1. **read/idempotent** — may be retried after transport failure if identity and
   authority are revalidated;
2. **idempotent with key** — may retry using the same invocation/idempotency key
   when the remote owner guarantees dedup;
3. **mutation/ambiguous** — must reconcile remote invocation state before retry;
4. **durable create** — returns stable resource ID and should make repeated
   correlated start requests resolve to the same resource where feasible.

### 18.3 Durable mutation reconciliation

OFXP should add a small bounded/durable invocation ledger for mutating remote
operations where it materially improves correctness.

Conceptual states:

```text
admitted -> started -> committed
                   \-> failed
                   \-> ambiguous
```

`invocation.get(peer, invocationID)` (whether explicit or internal) lets Machine A
reconcile a lost response.

The ledger cannot magically make every side effect transactional. A process may
crash after Git/file/process effects and before final ledger settlement. Such an
entry stays `ambiguous`; the client does not replay blindly.

### 18.4 Cancellation

Direct ephemeral capability calls should bridge request cancellation into the
underlying executor where cancellation is semantically safe.

Durable resources have explicit lifecycle:

- `worker.cancel` cancels a worker;
- background process/job handles use their native cancel/kill operation;
- dropping the OFXP socket is not equivalent to canceling durable work.

---

## 19. Loop and confused-deputy protection

### 19.1 Hop accounting

Every nested peer invocation carries `traceID`, `parentInvocationID`, and
`hopCount`.

Reject:

- hop count above policy maximum;
- recursive invocation chains prohibited by policy;
- obvious immediate A -> B -> A loops for the same trace/resource;
- a peer attempting to claim a different authenticated origin than its transport
  identity.

### 19.2 No authority laundering

B must not accept "A says C authorized this" as authority.

Any future delegated cross-peer capability requires a verifiable, attenuated
grant chain issued by the relevant trust domain. Until that exists, nested OFXP
acts as the immediate authenticated peer under that peer's own grant only.

### 19.3 Remote content is untrusted data

File contents, peer messages, tool output, Session text, and external MCP output
from B may contain prompt-injection content. Transport trust does not elevate
content instruction authority.

---

## 20. Durable storage model

Exact tables are implementation-phase design, but ownership should start here.

### 20.1 `ofxp_peer`

Durable trust identity, not reachability:

```text
peer_id PK
realm_id
label
public_identity
fingerprint
paired_at
revoked_at?
rekey_state?
last_seen_at?
created_at
updated_at
```

Do not store private host keys here.

### 20.2 `ofxp_peer_grant`

Directional local grant:

```text
peer_id PK/FK
revision
grant_json or explicit columns
expires_at?
updated_at
```

Use optimistic revision/revalidation. Do not let stale in-memory connection state
be the authority.

### 20.3 `ofxp_peer_root`

Per-peer approved roots:

```text
peer_id
root_id
alias
canonical_path / durable project identity (local only)
identity_fingerprint?
source
approved_at
PRIMARY KEY(peer_id, root_id)
```

Where possible, share canonical root/path identity primitives with OXP rather
than duplicating unsafe path logic.

### 20.4 `ofxp_invocation`

Only if the P0/P3 design confirms a durable ledger is justified for mutation
reconciliation:

```text
invocation_id
peer_id
source_session_id
plane
operation
target_ref
request_fingerprint
status
started_at
settled_at?
result/error summary bounded
```

Keep retention bounded. This is an audit/reconciliation surface, not an unlimited
copy of tool output.

### 20.5 Peer messages

If durable asynchronous mail lands in v1, use first-class message/thread tables
or a proven shared messaging owner. Do not encode remote peer mail only as
Session transcript rows because:

- transport delivery/dedup exists before Session admission;
- one message may target an inbox or a Session;
- reply/correlation and offline state are peer-domain facts;
- transcript pruning must not erase transport audit/correlation truth.

---

## 21. Existing `ServerConnection` integration

### 21.1 Keep semantics separate

`ServerConnection` means:

> "The application can use this server as a backend."

`OfxpPeer` means:

> "This cryptographic OpenFork identity is trusted, and this machine may use the
> capabilities the remote operator granted."

One object may help discover the other; do not merge them into one type.

### 21.2 Bootstrap projection

Add a bootstrap-free Tier 0 identity/OFXP projection on the ordinary OpenFork
server so an already configured remote server can advertise something like:

```ts
{
  ofxp: {
    enabled: true,
    peerID,
    fingerprint,
    protocolMin,
    protocolMax,
    endpointHints: [...] // bounded; no credentials
  }
}
```

Whether this is attached to `/instance/identity` or a dedicated endpoint is an
implementation design decision. Preserve the current identity route's pre-auth
privacy contract if it is extended.

### 21.3 Correlation flow

```text
existing ServerConnection -> verified server instance/realm
                         -> OFXP bootstrap projection
                         -> candidate peer identity
                         -> correlate with PeerDirectory
                         -> pair if not already trusted
```

Never send the existing server's Basic password/device token to an arbitrary
mDNS endpoint merely because labels/addresses look similar.

---

## 22. Lifecycle and process topology

### 22.1 Runtime owners

Target ownership:

| Concern | Owner |
|---|---|
| durable peer/grant/root rows | Core/domain storage |
| peer identity/private-key abstraction | protocol-neutral host security service |
| OFXP network listener | `packages/opencode` runtime |
| mDNS browse/publish | `packages/opencode` process-global discovery owner |
| OFXP semantic admission/capabilities | `packages/opencode` Exchange/OFXP services |
| desktop secure-key adapter, native firewall/tray UX | `packages/desktop` |
| peer settings/pairing UI | `packages/app` V2/new-layout |
| model-facing `ofxp` tool | V1/fork production tool/runtime path |

The renderer never owns sockets, private keys, trust decisions, or connection
pools.

### 22.2 Enable state machine

Conceptual process state:

```text
disabled
   -> loading_identity
   -> starting_listener
   -> advertising
   -> browsing
   -> ready
   -> degraded (interface/firewall/mDNS issue)
   -> ready
   -> stopping
   -> disabled
```

Listener readiness and mDNS readiness are separate. A peer can still be reachable
through known/server-connection discovery when mDNS fails.

### 22.3 Network changes

Handle:

- sleep/wake;
- Wi-Fi/Ethernet transition;
- DHCP address change;
- VPN interface changes;
- listener restart;
- mDNS daemon/network loss.

These update endpoint candidates, not peer identity.

### 22.4 Desktop firewall behavior

Binding a LAN listener may trigger OS firewall prompts. Desktop implementation
must make this explicit in enablement UX and test Windows behavior. Do not work
around the firewall by exposing the ordinary sidecar or launching hidden port
forwarders.

---

## 23. UI/UX target

### 23.1 Settings surface

Suggested V2/new-layout structure:

```text
Settings
  Network / OpenFork Peers

  OpenFork Network                         [Enabled]

  This device
    Jackson's Desktop
    OFXP ready

  Trusted peers
    Homelab                 Online
    2 approved roots · Read · Workers · Messaging
    [Manage]

  Nearby
    Other-PC                OpenFork <version>
    [Pair]
```

### 23.2 Peer detail

Show:

- human label;
- stable peer fingerprint;
- paired date / last seen;
- reachability state;
- approved roots;
- granular grant classes;
- delegated model/agent policy where applicable;
- revoke/re-key controls;
- recent bounded security/activity summary.

Do not show giant live tool catalogs by default.

### 23.3 Pairing UX

Pairing must visibly distinguish:

- **Nearby** — untrusted discovery candidate;
- **Pairing** — identity ceremony in progress;
- **Trusted** — identity recognized;
- **Authorized** — capabilities/roots granted;
- **Identity changed** — fail-closed re-key state.

### 23.4 Operator-only actions

The UI/CLI can pair, grant, revoke, approve roots, and rotate identity.

The model-facing tool cannot.

---

## 24. Observability

### 24.1 Metrics

Process-global bounded metrics should include at least:

```text
discoveryCandidates
trustedPeers
onlineTrustedPeers
pairingAttempts / failures / rateLimits
connectionsOpened / reused / failed
invocationsByPlane
invocationFailures
authorityDenials
identityMismatches
ambiguousMutations
workerStarts
peerMessagesSent / received / deduplicated
```

No metric requires Session-history hydration.

### 24.2 Structured attribution

Logs for an OFXP operation should answer:

- which authenticated peer;
- which source Session/invocation;
- which plane;
- which root/target;
- which grant revision admitted it;
- whether authority was revalidated;
- whether the action reached a commit boundary;
- whether result state is known/failed/ambiguous.

Never log secrets, pairing bootstrap material, private keys, or unbounded tool
payloads.

### 24.3 Activity UI

Reuse/generalize OXP activity projection concepts where useful, but preserve
principal/protocol identity so OXP and OFXP actions remain distinguishable.

---

## 25. Threat model and required defenses

| Threat | Required defense |
|---|---|
| malicious host advertises `Homelab` via mDNS | discovery has zero authority; cryptographic pairing/fingerprint |
| DHCP/IP/port changes | trust keyed by peer identity, not endpoint |
| MITM during initial pairing | audited TLS/bootstrap ceremony + human/QR identity binding; no silent TOFU |
| brute-force pairing code | short TTL, high entropy where possible, per-source + global rate limits, single use |
| replayed pair/invocation request | nonce/bootstrap consumption + invocation IDs/dedup policy |
| stolen renderer/localStorage data | no private peer key or capability secrets in renderer storage |
| peer revoked while socket remains open | live authority/trust revalidation; close/deny active peer |
| peer root moved/replaced | durable root identity/fingerprint verification before use |
| path traversal | root-relative canonical resolution and escape rejection |
| remote prompt injection | peer/tool/file text remains conversational/untrusted content |
| agent tries to pair new machine | pairing absent from model-facing OFXP tool |
| agent tries privilege escalation | local + remote grant intersection; model cannot mutate grants |
| A -> B -> A agent loop | trace/hop limits + nested delegation disabled by default |
| lost response after mutation | durable invocation correlation; no blind retry |
| peer floods listener | bounded body/connections/rate limits/backpressure |
| discovery floods candidates | TTL/LRU/bounded candidate table; no per-candidate expensive bootstrap |
| offline peers create reconnect storm | demand-driven bounded reconnect owner |
| ordinary sidecar exposed accidentally | dedicated OFXP listener; negative bind tests |

Security tests are design gates, not post-release hardening work.

---

## 26. Performance and concurrency invariants

OFXP is process-global networking wrapped around selectively expensive Tier 3
work. The cheap and expensive halves must remain sharply separated.

### 26.1 Negative invariants

Tests must prove:

1. enabling/disabling/browsing/listing peers creates **zero workspace Instances**;
2. N discovered peers do not create N workspace runtimes;
3. N discovered peers do not create N permanent health timers/reconnect loops;
4. opening Settings does not hydrate remote capability catalogs;
5. model tool registration size does not scale with peer count or remote tool
   count;
6. untrusted candidates never trigger workspace/model/plugin initialization;
7. a failed identity/pairing probe cannot run any Tier 2/3 operation;
8. disabling OFXP tears down listener, advertisement, browser, connection pool,
   and pending non-durable work convergently;
9. durable remote workers survive connection loss without keeping the client
   request alive;
10. revocation takes effect on already connected peers.

### 26.2 Scaling dimensions

Measure deliberately against:

- 1 / 10 / 100 discovered candidates;
- 1 / 10 / 50 trusted peers;
- concurrent connect storms to one peer;
- several peers invoking one Machine-B root concurrently;
- multiple Sessions on A using one B connection manager;
- large remote capability catalogs;
- repeated sleep/wake/network-change cycles;
- bounded peer-message queues if offline delivery lands.

### 26.3 Resource bounds

Define explicit bounds for:

- candidate entries/TTL;
- open outbound connections;
- inbound concurrent requests;
- request body/result bytes;
- tool list/descriptor bytes;
- invocation ledger retention;
- peer activity retention;
- message queue count/bytes/age;
- reconnect backoff and concurrent dials.

---

## 27. Implementation roadmap

Work in dependency order. A later phase must not silently answer an earlier
design gate through implementation accident.

### P0 — architecture/security design gate

**Do**

- confirm this document against live OXP/server/pairing code;
- choose exact v1 peer identity key/certificate representation;
- choose audited pairing/bootstrap ceremony;
- choose exact TLS mutual-auth/pinning profile;
- decide desktop/headless private-key storage adapters;
- define protocol v1 hello/version/error envelope;
- define durable peer/grant/root schemas and migration ownership;
- define the principal/provenance envelope shared with Exchange;
- decide whether mutation invocation ledger ships in v1 or before first remote
  write capability.

**Do not**

- expose a LAN listener with a placeholder password;
- use mDNS name/IP as identity;
- reuse PWA bearer tokens as OFXP peer identity;
- write remote capabilities before the authority model is fixed.

**Done when**

- threat model has concrete tests for MITM/spoof/replay/revoke/rekey;
- storage and headless lifecycle have no unresolved security owner;
- transport can be implemented without custom cryptographic primitives.

### P1 — peer identity + durable trust domain

Implement:

- `PeerID`/schemas;
- stable local host identity;
- private-key store abstraction + desktop/headless adapters;
- `ofxp_peer`, grant/root persistence;
- list/revoke/rekey state services;
- zero-Instance tests.

No network capability execution yet.

### P2 — discovery + dedicated listener

Implement:

- separate OFXP listener on dynamic port;
- `_ofxp._tcp` publication;
- mDNS browsing;
- `OfxpPeerDirectory` candidate dedup/TTL/self-filter;
- known-peer endpoint hints;
- compact discovery/liveness events;
- enable/disable/sleep/wake teardown tests.

Still no trust from discovery.

### P3 — pairing + authenticated transport

Implement:

- pairing request/approve/reject/bootstrap;
- peer fingerprint/SAS/QR path selected in P0;
- rate limiting/replay protection;
- authenticated reconnect with identity pinning;
- key mismatch/re-key failure state;
- revocation of an active connection;
- protocol version negotiation.

Gate: no capability call exists until spoof/MITM/replay/revoke tests are green.

### P4 — shared Exchange seam + read-only OFXP capability

Implement the smallest proven shared seam:

- explicit `ExchangePrincipal` equivalent;
- root resolution/authority revalidation shared where correct;
- read-only `project`/`read`/`find` capability path;
- bounded results/cancellation;
- OXP regression tests proving extraction preserved behavior.

Gate: OFXP read of an approved root succeeds; unapproved/missing root fails without
cwd fallback; no duplicate filesystem implementation exists.

### P5 — model-facing `ofxp` broker

Implement:

- one stable native tool;
- trusted `peer.list`/status;
- capability list/describe/call;
- compact prose and lazy schema contracts;
- local Session permission classification;
- alias ambiguity handling;
- tool-registration size benchmarks independent of peer count.

Pairing/grant mutation remains absent from the model tool.

### P6 — remote writes/Git/process + invocation reconciliation

Implement shared capability adapters in increasing risk order:

- edit/patch/write;
- Git;
- process/background;
- test/typecheck/symbol services as appropriate;
- durable invocation reconciliation before any non-idempotent automatic retry;
- ambiguous-commit error/result semantics.

Gate with forced mid-response disconnects after side effects.

### P7 — supervision + requests

Implement:

- remote Session catalog for approved roots;
- messages/state/children;
- turn/pause/resume/abort as native semantics permit;
- Permission/Question request inspection/reply behind separate grant;
- truthful external-peer supervisory provenance.

Never write a remote supervisory action as if the target resident model emitted
it.

### P8 — delegated workers

Implement:

- worker start/status/result/continue/cancel;
- B-owned allowed model/agent policy;
- durable handles across disconnect;
- idempotent correlated start;
- nested delegation false by default;
- trace/hop lineage.

### P9 — peer messaging

Implement:

- durable message/thread identity;
- `ofxp.peer` Session provenance;
- send/history/reply correlation;
- receiver dedup;
- queue-vs-turn distinction;
- explicit wake policy before unattended peer-triggered model work.

Offline store-and-forward may be P9b if v1 initially requires peer online.

### P10 — existing remote-server integration

Implement:

- bootstrap-free OFXP projection on normal OpenFork server identity surface;
- `ServerConnectionDiscovery` provider;
- verified correlation to peer identity;
- UX that avoids asking for the same host twice;
- SSH/WSL behavior analysis where applicable.

Do not merge `ServerConnection` and `OfxpPeer` authority types.

### P11 — V2 peer UX + operational closeout

Implement:

- Network/Peers settings page;
- nearby/trusted/rekey/revoked states;
- grant/root editor and presets;
- activity/security summary;
- Windows/Linux/headless QA;
- docs/map + durable architecture/spec promotion;
- benchmark/threat-model closeout.

### P12 — routed/tailnet/wide-area discovery (deferred)

Only after local OFXP is correct:

- add another `OfxpDiscoveryProvider` for routed/private networks;
- preserve the same peer identity, pairing, grant, root, and invocation contracts;
- do not weaken auth because the overlay network is itself authenticated;
- decide whether relay/public rendezvous is a product goal separately.

---

## 28. Verification matrix

### 28.1 Discovery

- two instances on one LAN discover each other without fixed ports;
- self-advertisements are filtered;
- duplicate IPv4/IPv6/interface advertisements collapse to one candidate;
- stale mDNS entries expire;
- 100 fake candidates remain bounded and create zero Instances;
- mDNS unavailable -> known/server-seed paths still function where configured.

### 28.2 Pairing/trust

- spoofed same-name peer cannot inherit trust;
- wrong fingerprint/key for known peer fails closed;
- replayed pairing bootstrap fails;
- brute-force claim trips both source/global limits;
- pairing expiration works with deterministic clock;
- revocation kills existing/new connections;
- re-key requires explicit operator confirmation;
- renderer/model never receives private key material.

### 28.3 Authority/root

- paired-with-no-grant cannot read anything;
- read grant without root cannot use workspace capabilities;
- approved root works;
- sibling/parent traversal fails;
- replaced/moved root identity is detected;
- stale grant revision is revalidated before mutation;
- missing remote root cannot become cwd.

### 28.4 Model tool

- tool count/schema size is constant with 0/1/50 peers;
- peer aliases fail on ambiguity;
- untrusted nearby candidate never appears in model `peer.list`;
- list/describe/call lazy contract rejects stale/incorrect descriptor fingerprint;
- model cannot invoke pair/grant/root-approval operations because they are absent.

### 28.5 Mutation/network failure

- disconnect before execution -> safe retry class behaves correctly;
- disconnect during read -> bounded retry works;
- disconnect immediately after file/Git mutation -> no blind replay;
- invocation reconciliation reports committed/failed/ambiguous truthfully;
- same idempotency key cannot execute a guaranteed-idempotent create twice;
- cancellation reaches ephemeral execution but not unrelated durable workers.

### 28.6 Supervision/provenance

- OFXP-issued Session action is marked external peer, not resident model;
- peer text remains conversational provider lane;
- target Session outside peer roots cannot be inspected even if its ID is known;
- request replies require separate request-supervision grant;
- no remote source field can spoof `owner=user`/System authority.

### 28.7 Workers

- worker continues after caller disconnect;
- reconnect on A can status/result using durable remote ref;
- disallowed model/agent selection fails before provider spend;
- nested OFXP call denied by default;
- hop/trace loop protection blocks A -> B -> A recursion.

### 28.8 Lifecycle/performance

- disabled state has no listener/browser/advertiser/reconnect loop;
- Settings page does not build Instances or remote catalogs;
- sleep/wake and network interface changes converge without duplicate listeners;
- rapid enable/disable leaves no port/service advertisement behind;
- concurrent Sessions on A deduplicate peer connection establishment;
- inbound connection/request/body/result limits are enforced.

---

## 29. Decision ledger

### Decided

**D1 — OFXP is OpenFork-to-OpenFork agent exchange, not remote-server mode.**  
Machine A remains the parent runtime.

**D2 — use automatic discovery providers, with mDNS/DNS-SD as same-LAN v1.**  
No custom UDP broadcast protocol.

**D3 — discovery is never authority.**

**D4 — peer identity is cryptographic and stable across endpoints.**

**D5 — pairing and grants are distinct, and grants are directional.**

**D5a — peer topology is bidirectional.**  
Either paired OpenFork installation may originate OFXP operations toward the
other; initiator/responder are ceremony/request roles only, never permanent peer
roles.

**D6 — pairing/grant escalation is operator-only, not model-facing.**

**D7 — ordinary desktop sidecar remains loopback-only by default.**  
OFXP gets a dedicated listener.

**D8 — OFXP reuses/extracts OXP/native capability owners instead of copying
them.**

**D9 — one stable lazy model-facing `ofxp` broker.**  
Tool registration does not scale with peers/capabilities.

**D10 — remote paths are peer/root-relative.**

**D11 — remote peer text is conversational, not System authority.**

**D12 — no transitive peer authority; nested delegation false by default.**

**D13 — remote mutations are never blindly retried after ambiguous disconnect.**

**D14 — durable workers belong to the remote runtime, not the connection.**

**D15 — existing ServerConnections are discovery seeds, not peer grants.**

**D16 — durable peer identity uses EC P-256 keys.**  
The canonical public identity is SPKI. `peerID` is `ofxp_` plus the base64url
SHA-256 digest of SPKI; the display fingerprint is the hex SHA-256 digest. This
binds stable identity to key material while keeping endpoint/IP/port mutable.

**D17 — same-LAN OFXP discovery uses `_ofxp._tcp`.**  
The OFXP discovery owner both publishes and browses when enabled. It uses one
bounded process-global candidate directory and does not allocate one timer,
workspace, provider catalog, or connection per discovered peer.

**D18 — pairing SAS binds both peer identities and fresh nonces.**  
Both sides compute the same 60-bit Crockford-base32 display code from the ordered
initiator/responder peer IDs and fresh 256-bit nonces. Initiator/responder are
only transcript roles. Human confirmation releases the peer identity for local
trust persistence; it does not create a capability grant.

**D19 — headless identity creation is atomic and fail-closed.**  
A protocol-neutral identity-material store supports create-if-absent semantics.
The host-key file adapter uses a fully written/fsynced temporary inode and atomic
link-at-target so concurrent processes converge on one key rather than rotate or
overwrite each other. Corrupt existing identity state is never silently replaced.

### Open P0 decisions

**Q1 — exact TLS certificate representation/binding.**  
The durable key is now EC P-256/SPKI. Decide how the dedicated TLS listener binds
that identity into X.509 (preferred direction: self-issued EC certificate reusing
the durable key) and define certificate lifetime/rotation without changing
`peerID` accidentally.

**Q2 — pairing transport/bootstrap packaging.**  
The transcript/SAS construction is implemented. Remaining work is the QR/deep-link
encoding, authenticated TLS channel binding, route-level replay/rate limiting,
and desktop/headless operator presentation.

**Q3 — exact TLS mutual-auth mechanism after pairing.**  
Pinned self-issued certs/mTLS vs a minimal signed application identity layer over
pinned TLS. Optimize for least custom security code and dynamic revocation.

**Q4 — desktop and cross-platform private-key custody.**  
The headless host-key file adapter exists and enforces POSIX owner/mode checks.
Desktop should still use an OS-backed secure adapter where available; Windows
headless ACL verification, migration/backup, and key rotation UX remain open.

**Q5 — shared Exchange module/file boundaries.**  
Decide only after dependency analysis of the first read-only extraction; do not
preemptively move the entire OXP tree.

**Q6 — durable invocation ledger scope/retention.**  
Must be resolved before remote non-idempotent writes can ship.

**Q7 — peer-message storage owner.**  
Determine whether Swarm/native messaging primitives can be generalized cleanly
or whether OFXP needs a dedicated peer-mail domain. Preserve explicit external
grant/provenance either way.

**Q8 — initial wake semantics for peer mail.**  
Default should remain no implicit provider spend until unattended peer-triggered
turn policy is explicit.

---

## 30. Build checklist / Definition of Done for OFXP v1

OFXP v1 is not done until all of the following are true:

- [ ] Machine A and B auto-discover on an ordinary same-LAN network with dynamic
      OFXP ports.
- [ ] A malicious/spoofed mDNS advertisement cannot acquire or reuse peer trust.
- [ ] Pairing cryptographically binds stable peer identities and is explicitly
      approved by a human/operator.
- [ ] Pairing alone grants no filesystem/process/session authority.
- [ ] Per-peer grants and approved roots are durable, revisioned, revocable, and
      revalidated at execution.
- [ ] Ordinary desktop sidecar remains loopback-only by default.
- [ ] A dedicated authenticated encrypted OFXP listener works on desktop and
      headless OpenFork.
- [ ] One native `ofxp` model tool lists trusted peers and lazily brokers remote
      capabilities without schema count scaling with peers.
- [ ] The model cannot pair peers or widen grants.
- [ ] Read/find/project work against an approved remote root with root-relative
      addressing and no cwd fallback.
- [ ] Remote writes/Git/process have conservative retry/idempotency semantics and
      survive forced ambiguous-disconnect tests without duplicate mutation.
- [ ] Remote Session supervision preserves external-peer provenance and root
      authorization.
- [ ] Remote workers return durable handles and continue across disconnect.
- [ ] Peer messages, if included in v1, persist explicit `ofxp.peer` provenance
      and remain conversational instruction authority.
- [ ] A -> B -> A recursive peer loops are bounded/denied by default.
- [ ] Existing configured remote servers can seed OFXP discovery without
      duplicating peer authority or leaking their credentials to discovered
      endpoints.
- [ ] Disabled OFXP has near-zero runtime cost.
- [ ] Peer settings/listing/discovery create zero workspace Instances.
- [ ] Windows, Linux/headless, sleep/wake, network-change, restart, revoke, and
      re-key scenarios have automated or explicit release-gate coverage.
- [ ] OXP regression gates remain green after every shared Exchange extraction.
- [ ] Durable architectural truths discovered during implementation are promoted
      out of this plan into `docs/architecture`, `docs/specs`, maps, and/or
      `AGENTS.md` before closeout.

---

## 31. Short implementation orientation for successor agents

If you are starting work from this document:

1. **Do not start in the UI or `ofxp` model tool.** Start at P0: trust identity,
   listener/discovery ownership, and exact security profile.
2. **Re-read live source.** OXP, server pairing, Swarm, and ServerConnection are
   actively evolving; this plan is not permission to assume line-level state.
3. **Preserve the dirty worktree.** Never reset/stash/normalize unrelated work.
4. **Keep Tier 0 cheap.** Discovery/pairing/listing must not enter `InstanceStore`.
5. **Do not duplicate OXP.** Extract the lowest correct shared capability seam
   only when OFXP reaches that phase.
6. **Treat every remote mutation as a distributed-systems problem.** Identity,
   grant revision, idempotency, disconnect, cancellation, and ambiguous commit
   must be explicit.
7. **Keep trust and instruction authority separate.** A cryptographically trusted
   peer is still a source of conversational/untrusted content.
8. **Make failures prove architecture.** The strongest gates are spoof/revoke,
   zero-Instance discovery, no-cwd routing, no duplicate mutation, truthful
   provenance, bounded peer fanout, and convergent teardown.

The intended end state is simple to explain to a user and strict internally:

> **OpenFork installations find one another automatically, humans decide which
> machines trust each other and what each may access, and authorized agents can
> collaborate across those machines through one small OFXP tool without turning
> the LAN into a shared root shell or duplicating OpenFork's runtime.**
