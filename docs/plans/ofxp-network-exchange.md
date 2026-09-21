# OFXP -- OpenFork Exchange Protocol

**Status:** architecture / implementation plan  
**Opened:** 2026-09-20  
**Product name:** OFXP = OpenFork Exchange Protocol  
**Primary objective:** allow an OpenFork Session on one machine to securely discover, pair with, and use explicitly authorized OpenFork capabilities, Sessions, and workers on another machine without requiring manual port management or duplicate remote-server configuration.

This document is the build-against architecture for OFXP. It is a plan, not yet a durable architecture contract. If executable source later disproves an assumption here, update this document rather than preserving a stale design.

---

## 1. Product thesis

OFXP is OpenFork-to-OpenFork agent exchange.

The parent agent is an already-running native OpenFork Session on Machine A. Machine B is another OpenFork installation that exposes a narrow, authenticated peer exchange surface.

~~~text
Existing Remote Server connection
=================================

OpenFork UI on A -----------------> OpenFork server B
                                    B becomes the selected backend.


OFXP
====

OpenFork Session on A
        |
        | native OFXP model tool
        v
OFXP client / peer authority on A
        |
        | authenticated peer exchange
        v
OFXP endpoint on B
        |
        +-- augmentation: remote capabilities
        +-- messaging: peer-to-peer Session communication
        +-- supervision: authorized existing Sessions
        '-- delegation: durable remote workers

Machine A remains Machine A's backend throughout.
~~~

The conceptual relationship to existing protocols is:

~~~text
ACP
external client
    |
    v
OpenFork-backed agent/session lifecycle


OXP
already-running ChatGPT agent
    |
    v
OpenFork support substrate


OFXP
already-running OpenFork Session
    |
    v
peer OpenFork support substrate
~~~

OFXP is therefore semantically much closer to OXP than ACP, but the external principal is another OpenFork installation and source Session rather than ChatGPT.

ACP remains the right protocol when an external client wants OpenFork itself to be the primary agent. OFXP does not replace ACP.

---

## 2. Architectural laws

Implementation must preserve all of these.

1. **Discovery is not trust.** An mDNS record, remembered address, or existing ServerConnection is only a rendezvous hint.

2. **Pairing is not authority.** Knowing which OpenFork installation is on the other end does not grant filesystem, process, Session, worker, or integration rights.

3. **Agent use cannot widen grants.** Pairing, grant expansion, root approval, and trust revocation are operator actions. The model-facing OFXP tool is use-only.

4. **Remote authority is an intersection, never a union.** Effective permission is bounded by the source Session/tool policy, local outbound OFXP policy, remote peer grant, approved root or target, and target-domain policy.

5. **Peer authority is not transitive.** A trusting B and B trusting C does not imply A trusts C. Nested OFXP delegation is denied by default.

6. **A remote call never impersonates the resident agent on the target machine.** Its provenance identifies the external OpenFork peer and source Session.

7. **Trusted peer text is still conversational text.** A message from a trusted peer does not become System or operator authority merely because the sender is paired.

8. **No implicit workspace.** Tier-2 and Tier-3 operations name an approved remote root or derive one from an explicitly addressed authorized Session. Missing location never falls through to process.cwd().

9. **One semantic owner.** OFXP reuses or extracts OpenFork capability owners. It must not implement a second filesystem, Git, process, Session, worker, MCP, browser, or scheduler runtime.

10. **Ambiguous mutations are never blindly retried.** If connectivity disappears after a remote commit may have begun, the caller reconciles by invocation ID.

11. **Long work belongs to durable remote resources, not a socket.** A remote worker can survive disconnect and reconnect.

12. **The normal OpenFork local server is not made LAN-public merely to support OFXP.** OFXP owns a narrow authenticated network listener.

13. **Disabled means near-zero cost.** No OFXP listener, advertiser, browser, reconnect loop, workspace Instance, provider catalog, or remote capability hydration runs when the feature is disabled.

14. **Discovery is Tier 0.** Nearby-peer browsing and health never materialize a workspace Instance.

15. **The model-facing schema stays stable and compact.** Remote capability churn belongs behind lazy list / describe / call semantics rather than permanent tool declarations.

---

## 3. Existing source-level foundations

OFXP is not greenfield.

The current repository already contains useful primitives and architectural precedents:

| Existing capability | Current owner / path | OFXP relevance |
|---|---|---|
| OXP authority, roots, capabilities, supervision, delegation | packages/opencode/src/oxp/** | Semantic donor. Extract protocol-neutral Exchange logic rather than copying OXP. |
| OXP compact capability brokerage | oxp/surface.ts and oxp/capability.ts | Precedent for stable top-level surface plus lazy descriptors. |
| OXP conservative mutation semantics | OXP capability implementations | Precedent for live authority revalidation and ambiguous mutation handling. |
| mDNS publication | packages/opencode/src/server/mdns.ts | Existing Bonjour dependency. OFXP needs a dedicated publish-and-browse service. |
| Local service descriptors and instance identity | server/service-discovery.ts and server/shared/instance-identity.ts | Strong precedent that a port is not identity and discovery hints require verification. |
| Device pairing | packages/core/src/device.ts and pair/device HTTP groups | Precedent for short-lived codes, rate limiting, one-time claims, and revocation. |
| Remote server management | packages/app/src/context/server.tsx and server dialogs | Existing reachability configuration. It becomes one OFXP bootstrap source, not the trust model. |
| Swarm peer provenance/admission | packages/schema/src/session-turn-provenance.ts and packages/opencode/src/swarm/** | Precedent for host-authored peer messages that remain attributable and conversational. |
| OXP secure credential storage | packages/desktop/src/main/oxp/credentials*.ts | At-rest secret-storage precedent. OFXP must additionally support headless OpenFork. |

Before implementation, read:

- repository AGENTS.md
- packages/opencode/AGENTS.md
- packages/app/AGENTS.md for UI work
- docs/map/README.md
- docs/map/architecture.md
- docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md
- docs/plans/oxp-first-party-architecture-ledger.md
- docs/plans/swarm-port-plan/00-first-party-overhaul-2026-09-18.md
- the live OFXP-related source named above

---

## 4. Bottom-up runtime path

The feature crosses storage, runtime, networking, server, client state, and UI. The supply path must be explicit.

### 4.1 Trust and discovery path

~~~text
Operator enables OFXP
        |
        v
process-global OFXP host starts
        |
        +-- narrow network listener
        '-- PeerDiscovery browser + advertiser
                |
                v
        ephemeral discovered-peer projection
                |
                | operator pairing
                v
        durable peer identity + trust
                |
                | operator grants roots/capabilities
                v
        durable directional peer grant revision
~~~

### 4.2 Agent invocation path

~~~text
OpenFork Session A emits native OFXP tool call
        |
        v
OFXP tool broker
        |
        +-- resolves trusted PeerID
        +-- checks local outbound policy
        '-- stamps truthful source Session provenance
                |
                v
OFXP client invocation
        |
        | authenticated encrypted transport
        v
OFXP server on Machine B
        |
        v
PeerAuthority admission
        |
        +-- peer trust still valid?
        +-- grant revision still permits operation?
        +-- root or target explicitly approved?
        '-- target-domain policy permits it?
                |
                v
shared Exchange operation
        |
        +-- augmentation executor
        +-- peer-message admission
        +-- Session supervision
        '-- worker delegation
                |
                v
authoritative native OpenFork owner
        |
        v
bounded OFXP result + invocation receipt
        |
        v
Session A receives tool result
~~~

The OFXP adapter is never the domain owner of Git, filesystem, processes, Sessions, workers, models, MCP integrations, or browser state.

---

## 5. Ownership tiers

### Tier 0 -- process/global

Examples:

- OFXP enabled state;
- local PeerID and public identity;
- peer discovery;
- trusted peer catalog;
- peer grant metadata;
- connection health;
- protocol and product version metadata;
- pairing and revocation state;
- aggregate OFXP metrics.

**Negative invariant:** every Tier-0 OFXP operation creates zero workspace Instances.

### Tier 1 -- durable location and Session metadata

Examples:

- approved remote root IDs and aliases;
- peer-to-root grant metadata;
- durable Session-to-directory mapping;
- remote durable Session list;
- durable worker handles;
- invocation receipts.

No plugins, tools, LSP, VCS, process runtime, or provider execution merely because metadata is requested.

### Tier 2 -- explicit workspace catalogs

Examples:

- remote model and agent catalog;
- remote commands and skills;
- remote MCP catalog;
- workspace-scoped capability descriptors.

An explicit approved root is required.

### Tier 3 -- execution

Examples:

- file mutation;
- shell and process execution;
- Git mutation;
- tests, typecheck, and LSP operations that require runtime;
- Session turns;
- worker start or continue;
- browser automation;
- integration or external network calls.

Every Tier-3 remote action must be attributable to:

~~~text
source PeerID
source SessionID
invocation ID
explicit approved root or target resource
effective grant revision
runtime reason
~~~

---

## 6. Process topology

The preferred topology is:

~~~text
Machine A                                      Machine B
+----------------------------+                 +----------------------------+
| OpenFork                   |                 | OpenFork                   |
|                            |                 |                            |
| Session A                  |                 | Existing Session B         |
|   |                        |                 | Worker Sessions            |
|   v                        |                 | Projects / tools / MCP     |
| native OFXP tool           |                 |                            |
|   |                        |                 | Shared Exchange substrate  |
|   v                        |                 |        ^                   |
| OFXP client                |                 |        |                   |
|   |                        | secure OFXP     | PeerAuthority + server     |
| PeerDirectory              +---------------->|        ^                   |
|                            |                 |        |                   |
| normal sidecar stays local |                 | narrow OFXP listener       |
+----------------------------+                 +----------------------------+
~~~

The normal desktop OpenFork server remains loopback-oriented. OFXP gets its own narrow network listener with its own admission boundary.

OFXP must also work in headless OpenFork. Electron may provide native affordances or a stronger secure-storage backend, but Electron cannot be required for the protocol runtime.

---

## 7. Discovery architecture

The common same-LAN experience should require no hostname, IP address, or port entry.

Phase 1 uses DNS-SD over mDNS with a dedicated OFXP service type, conceptually:

~~~text
_ofxp._tcp.local.
~~~

The exact Bonjour API spelling is an implementation detail resolved in the design gate.

The OFXP advertisement contains only non-secret rendezvous metadata:

- protocol version;
- public PeerID or a bounded public identity hint;
- OpenFork product version;
- listener port;
- pairing-supported flag;
- optional user-selected device label.

It must never advertise:

- tokens;
- credentials;
- approved roots;
- project paths;
- project names unless deliberately made public later;
- Session IDs or titles;
- capability grants.

### 7.1 Discovery providers

Discovery should be an abstraction from the beginning:

~~~text
PeerDiscoveryProvider
  -> mDNS / DNS-SD
  -> known trusted-peer endpoint hints
  -> existing ServerConnection bootstrap
  -> future Tailnet / VPN / rendezvous provider
~~~

mDNS is link-local. Phase 1 therefore promises zero-config discovery on ordinary same-link LAN environments, not routed VLANs or the public Internet.

OFXP semantics and trust must not depend on mDNS.

### 7.2 PeerDirectory

The process-global PeerDirectory merges:

~~~text
durable trusted peer rows
        +
mDNS discovery observations
        +
known endpoint hints
        +
ServerConnection bootstrap observations
        +
live authenticated transport state
~~~

Nearby unpaired peers live in a bounded TTL cache. Trusted peers are durable.

Do not create a permanent health loop per merely discovered peer.

---

## 8. Peer identity

Endpoints are ephemeral. Identity is durable.

The following must never be authorization identity:

- IP address;
- port;
- hostname;
- ServerConnection URL;
- process ID;
- mDNS service label.

Conceptually:

~~~text
PeerIdentity {
  peerID
  publicKey
  label
  createdAt
}
~~~

PeerID is derived from or cryptographically bound to a durable public key and survives:

- DHCP address changes;
- listener port changes;
- process restarts;
- Wi-Fi to Ethernet changes;
- hostname changes.

A deliberate identity-key reset creates a new peer identity and requires pairing again unless a future signed key-rotation protocol is added.

---

## 9. Transport security

The target is encrypted authenticated transport using the platform TLS stack plus durable peer cryptographic identity.

The implementation must provide these properties:

1. encrypted transport;
2. the endpoint is cryptographically bound to the paired PeerID;
3. bidirectional peer calls authenticate the caller's paired identity;
4. identity mismatch is rejected before privileged request content is sent;
5. no custom encryption primitive;
6. no reusable secret is placed in mDNS metadata or URLs.

Preferred shape:

~~~text
durable local keypair
        |
        +-- PeerID derives from public key
        '-- TLS certificate/public-key identity is pinned during pairing

future reconnect:
        endpoint hint
        -> TLS
        -> pinned peer identity check
        -> OFXP request admission
~~~

If a certificate is separate from the durable identity key, the transport must cryptographically bind the connection to the durable key. A plain self-signed TLS hop followed by an unrelated signature is not enough unless channel binding is proven.

### 9.1 Private key storage

OFXP must work on desktop and headless servers.

Therefore the durable private key belongs to a process-global OpenFork secret-storage abstraction accessible to packages/opencode.

Electron safeStorage is a useful adapter and precedent, but cannot be the only implementation.

The design gate must resolve the initial headless backend.

If a file-permission fallback is required, minimum requirements are:

- owner-only permissions where supported;
- atomic writes;
- never expose the key through normal file tools;
- malformed or unreadable secret state fails closed;
- never silently replace an unreadable key with a new identity;
- UI or CLI distinguishes OS-protected storage from file-permission-only storage.

---

## 10. Pairing

Discovery creates a candidate, not trust.

State model:

~~~text
unknown
   |
   v
discovered
   |
   | operator begins pairing
   v
pairing
   |
   | cryptographic identity verified + operator accepts
   v
trusted
   |
   | operator chooses directional grants
   v
authorized

online / offline are reachability overlays, not trust states.

trusted or authorized
   |
   | operator revokes
   v
revoked
~~~

Pairing requirements:

- initiated by operator action;
- short-lived;
- replay resistant;
- rate limited;
- explicit peer identity on both sides;
- human-verifiable short authentication value or equivalent confirmation;
- no implicit capability authority;
- pairing attempt expires;
- pairing transcript never becomes Session instruction authority.

The existing device-pairing implementation is a useful source-level precedent for one-time claims, TTL, normalization, rate limiting, constant-time secret comparison, and revocation. OFXP pairing is still a separate domain because its result is a cryptographic peer identity relationship.

### 10.1 Symmetry

One pairing ceremony should preferably establish mutual identity recognition.

Authority remains directional.

Example:

~~~text
A recognizes B
B recognizes A

B grants A:
  read + worker spawn on homelab root

A grants B:
  messaging only
~~~

Mutual identity does not imply symmetric grants.

---

## 11. Trust versus capability authority

Pairing means:

> I know which OpenFork installation this is.

A grant means:

> I allow this peer to perform these specific operations against these specific roots or resources.

Conceptual directional grant:

~~~text
PeerGrant {
  peerID
  revision

  read
  write
  process
  git
  integrations
  browser
  filesReceive
  filesSend
  automation

  messaging
  sessionSupervision
  requestSupervision

  delegation
  nestedDelegation

  roots[]
  workerPolicy?
}
~~~

The exact persisted shape may normalize these into multiple tables. The semantic rule is what matters.

Grant changes are operator-owned and revisioned.

### 11.1 Effective authority

For an agent-initiated OFXP call:

~~~text
effective authority
  =
source Session/tool permission
  INTERSECT local outbound OFXP policy
  INTERSECT target peer inbound grant
  INTERSECT approved root or target resource
  INTERSECT target-domain policy
~~~

No adapter can widen authority.

Every operation revalidates live authority at the commit boundary where mutation is possible.

---

## 12. Remote roots

Remote filesystem and workspace addressing should use:

~~~text
PeerID
RootID
relative path
~~~

The model on Machine A should not normally need Machine B's absolute filesystem path.

Public remote root projection:

~~~text
PublicPeerRoot {
  rootID
  alias
  available
}
~~~

Resolution order:

1. resolve peer grant;
2. resolve RootID;
3. verify root availability and identity;
4. resolve relative path under canonical root;
5. reject traversal or escape;
6. revalidate authority before committing a mutation.

This makes Windows-to-Linux collaboration natural and avoids leaking unnecessary absolute paths.

---

## 13. Shared Exchange substrate

OFXP must not become a copied OXP tree.

The target architecture is:

~~~text
                  protocol-neutral Exchange
                +-----------------------------+
                | capability executors        |
                | root/location enforcement   |
                | invocation/result contracts |
                | supervision adapters        |
                | delegation adapters         |
                | provenance construction     |
                +-------------+---------------+
                              |
               +--------------+--------------+
               |                             |
               v                             v
              OXP                           OFXP
      ChatGPT external principal    OpenFork peer principal
      OpenAI tunnel / MCP           peer network transport
      OXP connector grant           per-peer grant
      OXP root set                  per-peer root set
      parent tool epoch             durable peer identity
~~~

Extract only behavior that is actually protocol-neutral.

The following remain OXP-specific:

- ChatGPT connector identity;
- OpenAI tunnel lifecycle;
- OpenAI credentials;
- ChatGPT parent-tool epoch;
- ChatGPT-facing instructions and prose.

The following remain OFXP-specific:

- peer discovery;
- peer keypair;
- pairing;
- peer endpoint selection;
- directional peer grants;
- source Session correlation;
- peer transport lifecycle.

The one-owner rule prohibits copied OFXP implementations such as separate read, git, process, or worker engines.

---

## 14. OFXP semantic planes

OFXP has four explicit planes.

### 14.1 Augmentation

The source Session directly invokes an approved capability on the peer:

- filesystem read/search/mutation;
- Git;
- process and background jobs;
- project/symbol/LSP/test/typecheck;
- archive/JSON/skills;
- browser or computer capability where granted;
- peer-side external MCP integrations.

The resident model on the target machine did not emit the tool call.

### 14.2 Messaging

A Session on A sends attributable conversational peer input to an authorized Session on B.

Messaging is distinct from supervision and execution.

The default message operation:

- durably records peer communication;
- does not silently alter the target model;
- does not become privileged System input;
- does not automatically spend provider work unless explicitly designed to do so.

### 14.3 Supervision

The source Session observes or controls an authorized existing Session on B:

- list and inspect;
- bounded message reads;
- turn/continue where policy permits;
- pause/resume/abort;
- Permission or Question mediation where explicitly granted.

### 14.4 Delegation

The source Session creates or drives a subordinate worker on B:

- start;
- status;
- result;
- continue;
- cancel;
- later group/batch operations.

Nested delegation is denied by default.

---

## 15. Invocation envelope

Every admitted OFXP operation receives a canonical invocation identity.

Conceptually:

~~~text
OfxpInvocation {
  invocationID
  protocolVersion

  sourcePeerID
  sourceSessionID?

  plane
  operation

  rootID?
  targetSessionID?
  targetWorkerID?

  parentInvocationID?
  traceID
  hopCount

  grantRevision
  issuedAt
}
~~~

Transport connection IDs, IPs, and URLs are not durable semantic authority.

Correlation IDs are not authorization.

---

## 16. Provenance

Session-visible effects must remain truthful.

Target conceptual provenance:

~~~text
origin / lineage:
  actor: external_openfork_peer
  protocol: ofxp
  peerID: source peer
  sourceSessionID: optional source Session
  invocationID: remote invocation
  traceID: cross-peer trace
  parentInvocationID: optional parent
  plane: augmentation | messaging | supervision | delegation
  targetSessionID: optional local target

authorization lineage:
  peerGrantRevision
  rootGrant if relevant

instruction authority:
  conversational unless a separate trusted local rule explicitly elevates it
~~~

### 16.1 Never impersonate a resident agent

If Session A remotely edits a file on B through OFXP:

~~~text
actor = peer A / Session A
target = root on B
operation = edit
~~~

It must never be persisted or rendered as though Session B's resident model emitted the tool call.

### 16.2 Peer messages

A peer message entering Session B should conceptually be:

~~~text
owner = host
source = ofxp.peer
peerID = A
sourceSessionID = ses_A
instruction authority = conversational
~~~

A trusted peer is an authenticated origin, not a privileged prompt author.

---

## 17. Model-facing tool

The resident OpenFork model should receive one compact native tool:

**ofxp**

The permanent schema should remain small, conceptually:

~~~text
{
  action: peers | list | describe | call
  peerID?: string
  capability?: string
  rootID?: string
  contract?: string
  args?: object
}
~~~

Semantics:

- **peers** -- list trusted usable peers and compact availability;
- **list** -- list authorized capability rows for one peer, optionally root-scoped;
- **describe** -- fetch exact schema and contract fingerprint for one remote capability;
- **call** -- invoke that capability with live authorization.

Do not register one permanent model tool per remote peer or per remote native capability.

### 17.1 Capability IDs

Possible remote capability IDs include:

~~~text
read
find
git
process
project
symbols
test
typecheck
mcp/<server>/<tool>

message.send

session.list
session.get
session.messages
session.turn
session.pause
session.resume
session.abort

request.list
request.reply

worker.start
worker.status
worker.result
worker.continue
worker.cancel
~~~

The broker compresses the model surface. Internally, messaging, supervision, delegation, and augmentation remain distinct authority planes.

---

## 18. Lazy capability contracts

Remote capability discovery follows:

~~~text
list
  -> compact capability rows

describe
  -> exact schema + contract fingerprint

call
  -> capability ID + fingerprint + args
  -> live authority revalidation
  -> execute
~~~

If a remote capability changes after describe, the call fails with a stale-contract error instead of guessing.

Catalog generation is not authorization.

---

## 19. Wire profile

The first implementation should reuse standard protocol machinery where doing so removes duplication without transferring domain ownership.

Preferred layering:

~~~text
native OFXP model tool
      |
      v
OFXP semantic client
      |
      v
authenticated peer transport
      |
      +-- MCP Streamable HTTP list/call
      |   OR
      '-- a narrow OFXP HTTP broker selected in T0
      |
      v
OFXP semantic server
      |
      v
Exchange/native OpenFork owners
~~~

The design gate must decide whether v1 uses MCP Streamable HTTP directly or a small OFXP-specific HTTP envelope.

Whichever wire adapter is selected must preserve:

- bounded request bodies;
- structured typed errors;
- cancellation;
- protocol version negotiation;
- lazy schemas;
- capability fingerprints;
- live authority revalidation.

The transport adapter never becomes the source of truth for peer trust or grants.

---

## 20. Mutation and idempotency

Every call carries an InvocationID.

Operations should declare retry semantics such as:

~~~text
safe_read
idempotent_mutation
non_idempotent_mutation
durable_start
~~~

Reads may retry when failure is proven to have occurred before remote execution.

Once a remote mutation may have crossed its commit boundary:

~~~text
disconnect != retry
~~~

The caller receives an unknown-commit-state result correlated to InvocationID and reconciles.

Conceptual invocation receipt:

~~~text
InvocationReceipt {
  invocationID
  sourcePeerID
  operation
  state: admitted | committed | failed | cancelled
  resultDigest?
  targetRef?
  createdAt
  settledAt?
}
~~~

Receipts should remain bounded and must not become an unbounded duplicate output store.

---

## 21. Cancellation and durable work

Cancellation is correlated by InvocationID.

Dropping a socket is not equivalent to cancelling a durable operation.

For durable workers:

~~~text
worker.start
  -> peerID
  -> workerID
  -> sessionID
  -> invocationID
~~~

Machine A may disconnect. Machine B owns the durable worker. A later reconnect can query status/result by durable identity.

This is the preferred pattern for substantial remote work.

---

## 22. Loop and transitivity defense

Nested calls carry:

- traceID;
- parentInvocationID;
- origin PeerID;
- hop count.

Default policy:

~~~text
nestedDelegation = false
~~~

If nested delegation is introduced, grants may only attenuate:

- equal or fewer capability scopes;
- equal or fewer roots;
- shorter lifetime;
- bounded hop count.

A trusts B and B trusts C must never imply A can act on C.

The protocol should reject obvious cyclic active routes unless a future explicitly designed routing mode says otherwise.

---

## 23. Existing ServerConnection integration

Existing remote-server support remains its own domain.

A configured ServerConnection may act as a discovery/bootstrap source:

~~~text
ServerConnection URL
        |
        v
cheap OFXP peer bootstrap probe
        |
        v
PeerID + protocol/endpoint metadata
        |
        v
operator chooses Pair as peer
~~~

Existing HTTP credentials do not silently become OFXP authority.

A future one-click pairing flow may use an already authenticated ServerConnection to authorize starting the pairing ceremony, but the operator must initiate it and OFXP still commits a distinct peer identity and directional grant.

The same remote machine can therefore be both:

- a selectable remote app backend;
- an OFXP peer.

Those objects may be correlated in the UI but must not be collapsed.

---

## 24. Operator UX

Suggested V2/new-layout settings surface:

~~~text
Network
  OpenFork Peers

OpenFork Network                         [ Enabled ]

This device
  Jackson's Desktop
  Peer ID: ...7D2C

Trusted
  Homelab
  Online - last seen now
  3 approved roots
  Messaging yes - Sessions yes - Workers yes
                                         Manage

Nearby
  Sarah's PC
  OpenFork x.y
                                         Pair
~~~

Peer detail should separate:

### Identity

- label;
- fingerprint;
- paired at;
- last seen;
- protocol version;
- product version.

### Access this device grants to peer

- approved roots;
- read;
- write;
- process;
- Git;
- integrations;
- browser;
- file ingress/egress;
- messaging;
- Session supervision;
- request supervision;
- delegation;
- nested delegation.

### Connection

- online/offline;
- currently authenticated endpoint;
- discovery sources.

### Lifecycle

- revoke trust.

Do not render an IP address as though it is durable identity.

---

## 25. Pairing and grant UX

Pairing is operator-only.

Typical flow:

~~~text
1. Discover candidate.
2. User selects Pair.
3. Resolve candidate cryptographic identity.
4. Both machines show identity and a short authentication value.
5. Operator accepts.
6. Durable trust commits.
7. Grant editor opens.
8. Operator selects roots and capability policy.
~~~

The safest default is no authority after pairing unless T0 explicitly adopts a narrowly safe preset.

Possible convenience presets may exist in the operator UI while persisting granular policy:

### Messaging only

- peer messaging;
- no filesystem;
- no process;
- no supervision/delegation.

### Collaborate

Potentially:

- messaging;
- read on selected roots;
- worker delegation on selected roots;
- no write/process/Git mutation unless added.

### Custom

Explicit authority classes.

The model-facing OFXP tool must not expose pairing, root approval, grant expansion, or trust revocation.

---

## 26. Offline behavior

Trusted peers remain visible when offline.

Example:

~~~text
Homelab
Offline - last seen 18m ago
~~~

A model call should receive a typed peer-offline or unreachable error, not a raw socket stack trace.

Showing offline peer state must not hydrate remote tool, model, provider, or Session catalogs.

---

## 27. Lifecycle and cost

When OFXP is disabled:

~~~text
0 OFXP listeners
0 mDNS advertisers
0 mDNS browsers
0 reconnect loops
0 remote capability hydration
0 workspace Instances
~~~

When enabled:

~~~text
one process-global OFXP host
one discovery owner
one bounded PeerDirectory
one network listener
bounded on-demand authenticated peer connections
~~~

Do not create one timer, reconnect loop, or workspace runtime per discovered peer.

---

## 28. Suggested package ownership

| Concern | Owner |
|---|---|
| Browser-safe PeerID, grant, protocol schemas | packages/schema |
| Durable peer/trust/grant rows | packages/core |
| OFXP discovery, peer directory, transport runtime | packages/opencode |
| Shared Exchange capability semantics | lowest correct OpenFork owner, adapted in packages/opencode |
| Native OFXP model tool | packages/opencode/src/tool |
| Settings presentation | packages/app |
| Optional native desktop affordances | packages/desktop |

The renderer does not own discovery, trust, connection pools, or grants.

---

## 29. Initial durable data model sketch

The exact schema is a T1 implementation decision, but ownership should roughly separate:

### Peer identity

~~~text
ofxp_peer
  peer_id
  public_identity
  label
  paired_at
  revoked_at
  last_seen_at
  protocol_version?
  product_version?
~~~

### Directional grant

~~~text
ofxp_peer_grant
  peer_id
  revision
  authority fields or normalized authority relation
  created_at
  updated_at
~~~

### Approved roots

~~~text
ofxp_peer_root
  peer_id
  root_id
  canonical local location identity
  alias
  approved_at
  identity fingerprint
~~~

### Invocation receipt where required

~~~text
ofxp_invocation_receipt
  invocation_id
  peer_id
  operation
  commit class
  state
  target ref
  result digest
  created_at
  settled_at
~~~

Discovery observations and live transport state should remain bounded process-global projections rather than durable rows unless a specific fact genuinely needs persistence.

---

## 30. Implementation roadmap

### T0 -- design gate

Before production code:

- re-read live source and relevant AGENTS/docs;
- resolve the exact TLS/public-key mechanism;
- resolve headless private-key storage;
- choose MCP Streamable HTTP vs narrow OFXP broker wire profile;
- choose pairing SAS/code ceremony;
- choose empty vs safe default post-pair grant;
- decide normalized peer/root/grant persistence;
- define invocation receipt retention;
- confirm message.send does not automatically spend provider work in v1;
- define nested delegation as denied by default;
- define exactly how ServerConnection-authenticated bootstrap can begin pairing.

No production behavior should change in T0.

### T1 -- peer domain

Implement:

- PeerID and browser-safe schemas;
- durable trusted peer records;
- directional revisioned grants;
- root grants;
- revocation;
- compact Tier-0/Tier-1 projections.

Gate:

- peer catalog operations create zero Instances.

### T2 -- discovery

Implement:

- dedicated OFXP mDNS advertisement;
- mDNS browsing;
- self-filtering;
- deduplication;
- bounded TTL candidate cache;
- interface churn handling;
- known endpoint provider seam;
- ServerConnection discovery-provider seam.

Gate:

- two same-LAN hosts discover each other automatically with dynamic ports.

### T3 -- secure transport and pairing

Implement:

- narrow dynamic-port listener;
- cryptographic peer identity;
- encrypted transport;
- pairing ceremony;
- replay protection;
- rate limiting;
- trust persistence;
- reconnect across endpoint change;
- revocation;
- headless-capable secret storage.

Gate:

- spoofed discovery cannot impersonate a paired peer.

### T4 -- shared Exchange substrate

Classify current OXP code into:

- protocol-neutral capability/service logic;
- OXP-specific connector/tunnel/epoch logic.

Extract the lowest correct shared owners without changing OXP semantics.

Gate:

- focused OXP regression suite stays green;
- no copied OFXP filesystem/Git/process implementations exist.

### T5 -- read-only OFXP runtime

Implement:

- protocol negotiation;
- peer capability list;
- capability describe;
- capability call;
- explicit roots;
- read/find/project-like operations first;
- cancellation;
- bounded results;
- typed errors.

Gate:

- Session A can read an approved file on B;
- unapproved sibling path and missing root fail closed.

### T6 -- native OFXP tool and mutation safety

Implement:

- one compact model-facing OFXP tool;
- lazy remote schemas;
- write/Git/process capabilities as granted;
- invocation receipts;
- commit guards;
- ambiguous mutation reconciliation.

Gate:

- force disconnect after commit boundary;
- caller reports unknown commit state;
- mutation is not executed twice.

### T7 -- messaging, supervision, delegation

Implement:

- message.send with OFXP peer provenance;
- Session list/get/messages/turn/control;
- request supervision where granted;
- durable worker start/status/result/continue/cancel;
- trace/hop metadata;
- default nested delegation deny.

Gate:

- worker on B survives A disconnect and is recoverable later;
- peer messages remain conversational and attributable.

### T8 -- settings UX and ServerConnection bridge

Implement:

- nearby/trusted/offline peer settings;
- pairing flow;
- grant/root editor;
- revoke;
- activity projection;
- ServerConnection correlation/bootstrap.

Gate:

- common path is discover -> pair -> grant roots with no manual port entry;
- opening settings creates zero Instances and zero remote workspace catalog fetches.

### T9 -- verification and closeout

Run adversarial, failure, performance, and cross-platform matrices.

Promote proven long-lived laws into docs/architecture, specs, AGENTS.md, and code maps as appropriate.

Write a closeout handoff with measured evidence and known limitations.

---

## 31. Security verification matrix

At minimum:

| Scenario | Required behavior |
|---|---|
| Fake mDNS peer copies trusted label | remains untrusted |
| Trusted peer presents unexpected key | connection rejected |
| Pairing code/replay reused | rejected |
| Pair claim flood | rate limited |
| Peer paired but grant empty | all capabilities denied |
| Grant revoked before commit | live revalidation denies commit |
| Root removed after descriptor cached | call denied |
| Relative path traversal | denied |
| Root identity changed | fails according to canonical root policy |
| Peer claims unrelated source Session ID | correlation is never accepted as authority |
| Target Session outside granted roots | denied |
| A trusts B, B trusts C, A attempts transit to C | denied |
| Peer message requests System authority | remains conversational |
| Old IP now belongs to different host | identity mismatch; no privileged request sent |
| Secret store corrupt/unreadable | fail closed; do not silently regenerate identity |
| Revocation occurs on pooled connection | next operation denied |

---

## 32. Failure matrix

Exercise:

- listener restart on a new port;
- DHCP/IP change;
- Wi-Fi sleep/resume;
- peer process crash;
- caller process crash;
- request cancellation;
- disconnect before admission;
- disconnect after admission but before commit;
- disconnect after commit but before result;
- stale capability fingerprint;
- stale grant revision;
- peer revocation while connected;
- protocol-major mismatch;
- mDNS unavailable;
- multiple interfaces;
- duplicate advertisements;
- 100 or more discovered candidates.

---

## 33. Performance closure

Measure the real trigger states:

~~~text
OFXP disabled
OFXP enabled with zero peers
20 nearby unpaired peers
10 trusted peers all offline
10 trusted peers with 3 active
6 simultaneous remote calls
~~~

Track:

- idle CPU;
- RSS delta;
- open sockets;
- timers/fibers/listeners;
- discovery event rate;
- authenticated connection latency;
- remote round-trip latency;
- capability list/describe latency;
- retained bytes per discovered/trusted peer;
- workspace Instance creations.

Required negative invariants:

- disabled means no OFXP network lifecycle;
- nearby peer count does not scale workspace Instances;
- settings does not fetch remote tool/provider catalogs;
- no per-row timer;
- no unbounded reconnect fanout;
- discovery cache is count- and TTL-bounded;
- result buffers are bounded;
- no hidden component owns discovery or peer polling.

---

## 34. Cross-platform verification

At minimum:

- Windows desktop <-> Linux homelab;
- Windows desktop <-> Windows desktop;
- Linux headless <-> Windows desktop;
- desktop sleep/resume;
- firewall-denied and firewall-allowed paths;
- IPv4-only environment;
- IPv6-present environment.

Do not claim macOS support as verified until it is exercised.

---

## 35. v1 definition of complete

OFXP v1 is complete when:

- two same-LAN OpenFork installations auto-discover;
- operator can securely pair them without manual port entry;
- peer identity survives normal endpoint changes;
- grants and roots are explicit and directional;
- a native Session on A can use the compact OFXP tool to discover and invoke approved capabilities on B;
- read and mutation paths enforce root and authority invariants;
- ambiguous mutation failure cannot duplicate a commit;
- Session peer messages carry truthful conversational provenance;
- A can start a durable worker on B, disconnect, reconnect, and recover it;
- existing remote-server configuration can seed/correlate an OFXP peer without becoming the authority model;
- disabled OFXP has near-zero runtime cost;
- adversarial and failure matrices pass;
- OXP behavior remains intact through shared Exchange extraction.

---

## 36. Explicit non-goals for v1

- No public Internet rendezvous service.
- No automatic router port forwarding or UPnP.
- No trust-on-first-use without operator-visible pairing.
- No automatic grant inheritance from remote-server credentials.
- No peer trust mesh.
- No authority transitivity.
- No global peer-shared filesystem namespace.
- No arbitrary full OpenFork HTTP proxy.
- No mandatory migration of existing ServerConnection semantics.
- No second OXP-like copy of filesystem/Git/process capability implementations.
- No promise that mDNS discovery crosses routed VLANs.
- No agent-accessible pairing or grant expansion.

---

## 37. First action when implementation begins

Start with T0.

Do not begin with the settings UI, a network listener, or a copied OXP module.

The implementing agent should first re-read the live source, resolve the ten design-gate decisions in this document, and write the concrete service/package ownership diagram. Only after that should T1 peer-domain schema and storage begin.

