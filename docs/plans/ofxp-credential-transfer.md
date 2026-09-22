# OFXP credential transfer — secure cross-device account setup plan

**Status:** Phase-0 hostile audit in progress; architecture/design source of truth; **implementation remains prohibited until every unresolved design gate below is closed or explicitly rejected**  
**Date opened:** 2026-09-21  
**Parent architecture:** `docs/plans/ofxp-first-party-architecture.md`  
**Primary product objective:** let a user install OpenFork on a second trusted machine and securely bring over selected OpenFork-managed provider accounts through the existing OFXP peer-pairing/trust system, without re-running every login flow and without turning ordinary OFXP peer trust into ambient secret-reading authority.

This document is intentionally narrower than the parent OFXP plan. It defines the
credential-transfer domain, its threat model, security invariants, protocol lifecycle,
credential-owner contract, UX, rollout gates, and implementation sequence.

The core product flow is:

> Device B discovers Device A -> the existing OFXP pairing/SAS ceremony establishes
> B's peer identity -> A explicitly approves a one-shot account transfer -> selected
> credential owners export only transfer-safe material -> B imports it through its
> normal authoritative credential owners -> the transfer is permanently consumed.

The load-bearing distinction is:

> **OFXP pairing proves which peer B is. It does not authorize B to receive secrets.**
> Credential transfer is a separate, one-shot, operator-authorized ceremony bound to
> that already-paired peer identity.

---

## 0. Executive decision

Implement this as **Credential Transfer over OFXP**, not as:

- another pairing protocol;
- a general `credentials: true` OFXP grant;
- a model-facing OFXP capability;
- a peer-readable credential API;
- SQLite/auth-file replication;
- "sync every secret between paired machines";
- implicit trust propagation from an existing ServerConnection;
- generic serialization of arbitrary provider/plugin auth state.

The architecture should have five owners:

```text
OFXP peer domain
  proves peer identity / trust generation / revocation / re-key state
        |
        v
CredentialTransfer service
  owns one-shot transfer authorization, state, receipts, replay defense
        |
        +-----------------------+
        |                       |
        v                       v
Credential export adapters   Credential import adapters
  owner-specific policy        owner-specific validation/commit
        |                       |
        v                       v
authoritative credential owners / vaults
```

OFXP transport carries the ceremony and payload, but **does not become the source
of credential semantics or secret persistence**.

### 0.1 v1 recommendation

The first production slice should be intentionally narrow:

1. existing OFXP pairing and trusted-peer admission only;
2. one-shot operator-created transfer authorization;
3. OpenCode Go / fork multi-key credentials first;
4. API-key-style credentials next;
5. current `Credential.Key` next where ownership is clear;
6. OAuth only after provider-specific transfer policy exists;
7. externally managed/foreign credential sources remain non-exportable by default.

Do not make the first implementation "all auth everywhere."

---

## 1. Ground truth in the live tree

This plan follows repository source-of-truth rules: executable code and tests first,
then package/repository architecture contracts.

### 1.1 OFXP pairing already solves the trust bootstrap

Relevant live owners:

- `packages/core/src/ofxp-peer/pairing.ts`
- `packages/core/src/ofxp-peer/identity.ts`
- `packages/core/src/ofxp-peer/index.ts`
- `packages/core/src/ofxp-peer/sql.ts`
- `packages/opencode/src/ofxp/transport.ts`
- `packages/opencode/src/ofxp/runtime.ts`
- `packages/schema/src/ofxp.ts`

Current pairing already provides:

- durable P-256 peer identities;
- peer ID and fingerprint derived from the public key;
- fresh 32-byte pairing nonces;
- a 60-bit human-verifiable SAS;
- 90-second pairing expiry;
- bounded pending ceremonies;
- replay tombstones;
- mutual binding between the pairing transcript and the TLS peer identity;
- explicit operator confirmation;
- deny-by-default peer grants after trust is established;
- explicit revocation and re-key-required behavior;
- authority-generation tracking for cross-process invalidation.

Therefore credential transfer must **reuse** this trust domain.

### 1.2 Pairing and capability authority are already deliberately separate

The parent OFXP plan and live code agree on this law:

```text
candidate -> pairing_pending -> paired -> independently authorized
```

A trusted peer means:

> this is the same cryptographic peer identity the operator paired.

It does **not** mean:

> this peer may read local secrets.

Credential transfer must preserve that separation.

### 1.3 The current credential domain is heterogeneous

There is no single existing "all OpenFork credentials" storage primitive.

Relevant owners include:

#### Legacy/V1 Auth

`packages/opencode/src/auth/index.ts`

Stores:

- OAuth access token;
- OAuth refresh token;
- expiration;
- optional account ID / enterprise URL;
- API keys;
- well-known key/token pairs.

The ordinary durable path is `auth.json`, mode-hardened to `0600` on mutation.
`OPENCODE_AUTH_CONTENT` can also supply externally managed process auth.

#### Fork OpenCode Go multi-key credentials

`packages/opencode/src/fork/credentials.ts`

Stores multiple OpenCode/Go keys in `fork_credential`, including:

- local credential ID;
- label;
- key;
- active selection;
- creation time.

This is the most direct first adapter for the motivating use case.

#### Current/Core Credential

`packages/core/src/credential.ts` and
`packages/schema/src/credential.ts`

Supports:

- `Credential.Key`;
- `Credential.OAuth`;
- integration ownership;
- labels;
- active selection.

#### Provider/plugin-owned auth

Some integrations maintain additional state outside the generic Auth owner.

Example: Verdent reads an existing Verdent desktop session from the OS credential
store/keytar and has its own multi-account/vault behavior. That is **foreign/
externally managed credential material** from OpenFork's perspective and must not
be assumed exportable.

#### Desktop secure-storage precedent

`packages/desktop/src/main/oxp/credentials-store.ts` demonstrates important
secret-storage behavior already present in the repository:

- require OS-backed secure storage before mutation;
- reject insecure Linux Chromium fallback;
- encrypt the durable blob;
- fail closed on unreadable ciphertext;
- do not replace unreadable secret state with an apparently authoritative empty
  store;
- keep destructive reset as an explicit recovery action.

Credential transfer should copy these *security semantics* where applicable,
without coupling OFXP transfer to OXP's specific credential store.

### 1.4 Hostile-audit repository facts versus proposed additions

The following are **verified live-tree facts as of this audit**, not assumptions:

- durable OFXP peer rows currently carry the broad `authority_epoch`; they do **not** yet contain the proposed transfer-specific `trust_generation`;
- peer/grant mutations use immediate SQLite transactions in security-sensitive paths, but the existing generic `authorize()/access()` APIs are capability-plane authorization and are **not** an atomic credential-disclosure fence. In particular, `OfxpPeer.access()` also requires a present/non-expired capability grant; credential transfer must not accidentally inherit grant expiry as peer-trust semantics;
- the current OFXP runtime's application callback routes directly to `OfxpCapability.dispatch`; the proposed top-level application/control dispatcher does not exist yet;
- `OfxpClient.negotiate()` currently rejects a peer whose strict v1 Hello does not advertise `capabilityExchange`; base/control-plane negotiation is not yet separated from augmentation capability negotiation;
- the current v1 Hello feature struct is strict and the client decodes it with excess-property rejection, so adding an unsolicited `credentialTransfer` field would break mixed-version peers;
- the OFXP transport derives the presented certificate identity before application dispatch, but custom durable trust/object authorization happens above transport; transport identity alone is not transfer authority;
- generic OFXP application errors can currently project bounded `error.message` text to the peer, so secret-bearing handlers require their own closed error boundary;
- generic HTTP authorization accepts paired device bearer credentials, and ordinary auth can be configured absent/no-op; neither is a sensitive operator boundary;
- desktop `ServerReadyData` exposes the ordinary sidecar URL/username/password to the renderer, while Electron main separately owns a typed `utilityProcess.postMessage` / child `parentPort` control channel that the renderer cannot invoke arbitrarily;
- `ForkCredentials.list()` and current `Credential` list/get APIs materialize raw secret values; metadata-only transfer projections do not exist yet;
- the fork multi-key table has no owner revision/provenance and its current lazy migration boolean is not a completion barrier suitable for a security-sensitive transfer API. More importantly, `ForkCredentials.ensureMigrated()` reads `Auth.get("opencode")`, while legacy `Auth.all()` prefers `OPENCODE_AUTH_CONTENT`; the current migration can therefore materialize an externally managed environment key into `fork_credential` without preserving its origin;
- legacy `Auth` now serializes file mutation and uses atomic temp-file rename, but it still has no robust per-credential source generation and remains single-slot/provider-shaped.

Everything described later as “add”, “introduce”, “split”, “freeze”, or “must expose” is **proposed architecture until repository evidence proves otherwise**. In particular, `trust_generation`, transfer tables, transfer adapters, typed sensitive sidecar commands, the control dispatcher, transfer wire methods, HPKE/TLS-only profile code, and owner-native import markers are not asserted to exist.

### 1.5 Consequence

There must be a **credential-transfer adapter boundary**.

OFXP must never learn implementation facts such as:

- "`fork_credential.key` is the secret";
- "`auth.json` has a provider entry";
- "Verdent uses this keytar service";
- "copy this SQLite row";
- "the remote local credential ID should be preserved."

Those facts belong to each authoritative credential owner.

---

## 2. Product semantics

### 2.1 Primary flow

The intended setup flow is:

```text
Laptop B
  "Set up from another OpenFork"
        |
        v
discovers Desktop A over OFXP
        |
        v
existing OFXP Pair + SAS confirmation
        |
        v
B sends a bounded "credential transfer requested" control request
        |
        v
Desktop A
  "Laptop B wants account setup"
  [selected accounts]
  [Transfer]
        |
        v
one-shot authorization is created on A
        |
        v
selected adapters prepare transfer-safe material
        |
        v
encrypted/authenticated OFXP delivery
        |
        v
B validates + imports through authoritative owners
        |
        v
durable receipt / transfer consumed
```

The setup request itself grants no secret access and returns no credential
inventory to B.

### 2.2 Copy, not move

v1 is **copy semantics**.

A successful transfer:

- does not delete or rotate the source credential;
- does not revoke Device A;
- does not change provider state unless a provider-specific reissue adapter
  explicitly requires a provider-side operation;
- does not silently switch A's active account.

"Move credentials to this device" is a separate future product operation because
source deletion/revocation has very different failure semantics.

### 2.3 Selected accounts only

The operator must be able to choose:

- all eligible accounts;
- individual providers/accounts;
- no accounts.

"Pair & transfer all eligible accounts" may be a convenience button, but it still
creates an explicit one-shot transfer authorization with a concrete manifest.

### 2.4 Nearby/same-network is the v1 UX scope, not an authority primitive

The motivating product flow is two OpenFork installations on the same local network. Keep the first UI intentionally narrow:

- surface "Set up from this device" primarily for nearby/direct peers discovered through the normal OFXP nearby-discovery path;
- show whether the active route is direct/nearby versus a non-local seed/route when that distinction is known;
- do not silently broaden the initial onboarding UX into arbitrary remote credential export.

But **never use network locality as security authority**. mDNS presence, RFC1918/private addresses, IPv6 link-local/ULA addresses, subnet equality, SSID, hostname, or endpoint source do not prove identity. Every request still requires the same authenticated OFXP peer identity, pairing trust, one-shot operator authorization, and recipient binding.

If remote credential migration is intentionally enabled later, make that an explicit product/policy decision with appropriately stronger UX copy; the cryptographic identity model should not need to change.

---

## 3. Hard security laws

These are non-negotiable.

### 3.1 Pairing is necessary but insufficient

Only a currently trusted, non-revoked, stable-key OFXP peer may participate.

But trusted-peer state alone never authorizes secret export.

### 3.2 No durable ambient credential-sharing grant

Do **not** add:

```ts
grant.credentials = true
```

or an equivalent permanent OFXP capability.

Credential disclosure is not ordinary remote capability execution. Once a peer
receives a reusable API key or bearer credential, later OFXP revocation cannot
magically retract that disclosure.

Every transfer therefore requires a distinct, bounded, one-shot authorization.

### 3.3 Model-facing tools cannot initiate or approve disclosure

The model-facing `ofxp` tool must not expose operations that:

- enumerate transferable credentials;
- request raw secret values;
- approve a transfer;
- widen transfer scope;
- choose an arbitrary destination peer;
- mark a transfer committed;
- bypass transfer policy.

The only model-visible effect should be ordinary use of credentials already
installed on its local runtime.

### 3.4 Transfer authorization is recipient-bound

A transfer authorization is valid only for the exact recipient identity that the
operator approved.

At minimum bind it to:

- `recipientPeerID`;
- recipient public-key fingerprint;
- current trusted-peer generation;
- transfer ID;
- manifest digest;
- expiry;
- one-shot state.

A different endpoint presenting the same label is irrelevant.

### 3.5 Trust mutation invalidates pending transfer authority

Any of the following must abort/revalidate a pending transfer:

- peer revocation;
- re-key-required transition;
- confirmed re-key;
- revoke + same-key re-pair;
- loss of current trusted-peer generation;
- recipient identity mismatch.

Use a dedicated durable **`trust_generation`** on the peer trust record for credential-transfer fencing.

Do **not** use the existing `authority_epoch` as the semantic transfer generation. In the live peer service, `authority_epoch` also changes for ordinary grant/root authority mutations. Pairing identity/trust and capability grants are deliberately separate OFXP domains; an unrelated root approval or capability toggle should not silently invalidate a human-approved credential transfer.

`trust_generation` increments on trust-lifecycle transitions only, including:

- initial durable trust creation;
- revocation;
- same-key revoke/re-pair repair;
- entering re-key-required/identity-mismatch state where normal peer trust is no longer usable;
- confirmed replacement identity/re-key transitions as represented on the affected trust records.

Ordinary grant/root edits do not change it.

The existing broader `authority_epoch` may still be used as a cheap cross-process **wake-up signal**: on any relevant peer change, subscribers re-read durable state and compare the transfer's bound `trust_generation`. It is not itself the credential-transfer authorization fence.

It is not acceptable for a stale authorization to survive a trust reset.

### 3.6 Secret material never enters generic logs, receipts, exceptions, metrics,
or invocation transcripts

No plaintext:

- API key;
- access token;
- refresh token;
- password-like secret;
- private key;
- authorization header;
- encrypted-store plaintext;

may appear in:

- ordinary application logs;
- OFXP invocation history;
- durable mutation receipts;
- trace metadata;
- error strings;
- analytics;
- crash breadcrumbs;
- UI telemetry.

Audit the event, not the secret.

### 3.7 Foreign/external credentials are deny-by-default

A credential sourced from:

- environment variables;
- another application's OS keychain;
- externally managed configuration;
- hardware-backed non-exportable key material;
- unknown plugin state;

is **not exportable** unless its owning adapter explicitly says otherwise.

### 3.8 No downgrade to insecure transport or storage

If the required authenticated OFXP transport, transfer-envelope profile, or
destination credential store is unavailable, fail closed.

Do not silently fall back to:

- HTTP;
- unpinned TLS;
- discovery identity alone;
- plaintext temporary files;
- clipboard;
- command-line arguments;
- shell environment variables;
- URL query parameters;
- normal OFXP tool output.

### 3.9 No invented global ACID guarantee

Credential owners may span SQLite, files, OS keychains, and provider-specific
stores. A multi-provider transfer cannot honestly promise one cross-store atomic
transaction unless such a transaction actually exists.

v1 must expose truthful per-item commit state and idempotent retry.

---

## 4. Threat model

### 4.1 In scope

#### Malicious LAN peer

An attacker can:

- publish fake discovery advertisements;
- connect to the OFXP listener;
- replay captured non-secret control frames;
- race the real peer;
- spam transfer requests;
- change IP/port.

Defense:

- discovery is never trust;
- mTLS/pinned OFXP identity;
- existing SAS pairing;
- trusted-peer admission;
- rate limits;
- recipient identity binding;
- replay-resistant transfer IDs/nonces.

#### Malicious but previously paired peer

A paired peer may intentionally request secrets it was never granted.

Defense:

- pairing confers no transfer authority;
- request reveals no local credential inventory;
- operator approval is mandatory;
- one-shot transfer scope;
- exact recipient binding;
- no persistent credential capability.

#### Stale UI / revoke/re-pair race

An operator screen may show an older trusted generation while another process
revokes or re-pairs the peer.

Defense:

- generation fencing at approval and delivery;
- durable compare-and-set state transitions;
- revalidate immediately before secret export;
- cross-process authority-change invalidation.

#### Replay of a previous transfer

An attacker may replay an old delivery frame.

Defense:

- unique high-entropy transfer ID;
- recipient-bound manifest;
- recipient durable import journal;
- consumed/expired source authorization;
- exact manifest digest match on retry;
- old transfer IDs never become valid for a new trust generation.

#### Lost response after recipient commit

A imports successfully but the final acknowledgement is lost.

Defense:

- do not blindly repeat semantic import;
- recipient has a durable receipt keyed by transfer ID;
- source reconciles status;
- duplicate delivery for the same transfer is idempotent.

#### Source process crash during export

Defense:

- no durable plaintext staging;
- authorization remains metadata-only;
- retry revalidates the exact transfer and credential manifest.

#### Recipient crash during import

Defense:

- adapter-level idempotency;
- durable per-item receipt after commit;
- batch atomicity where the owner supports it;
- deterministic reconciliation for partial multi-owner import.

#### Prompt injection / malicious model

Defense:

- no model-facing transfer methods;
- peer messages are not operator authority;
- transfer approval occurs on an operator control surface;
- credentials are never materialized into Session text/tool results.

#### Log/crash exfiltration

Defense:

- secret-carrying structures are redaction-aware;
- envelope plaintext does not pass through generic debug serialization;
- errors use opaque item refs and bounded reason codes.

#### Compromised recipient after successful transfer

This cannot be cryptographically undone for cloneable bearer secrets.

Mitigation:

- user-visible statement that copied credentials now independently exist on B;
- provider-side revocation/rotation remains the ultimate control;
- prefer per-device reissue where providers support it;
- future account-management UI should identify credential provenance/device where
  the provider exposes such semantics.

### 4.2 Out of scope

This feature does not claim to protect a secret from:

- malware with arbitrary code execution as the same OS user on the source;
- malware with arbitrary code execution as the same OS user on the recipient;
- a compromised provider;
- a provider account whose upstream credentials are themselves already stolen.

It should still minimize unnecessary plaintext lifetime and persistence.

---

## 5. Credential transfer policy taxonomy

Every credential adapter must declare an explicit transfer policy.

Suggested semantic modes:

```ts
type TransferPolicy =
  | { mode: "clone"; reasonCode: CredentialTransferPolicyReasonCode }
  | { mode: "reissue"; reasonCode: CredentialTransferPolicyReasonCode }
  | { mode: "non_exportable"; reasonCode: CredentialTransferPolicyReasonCode }
  | { mode: "unsupported"; reasonCode: CredentialTransferPolicyReasonCode }
```

### 5.1 `clone`

The existing credential can be copied to another OpenFork installation without
violating known provider/client-binding semantics.

Typical candidates:

- ordinary API keys;
- OpenCode Go/fork keys where the upstream credential is not device-bound.

Cloneable does not mean "always selected." Operator approval is still required.

### 5.2 `reissue`

The source authorization can safely help obtain a distinct recipient credential,
but the same bearer secret should not simply be duplicated.

This is the preferred long-term mode whenever the upstream provider supports a
safe device/token issuance or token-exchange flow.

`reissue` is **not generic export with a different label**. It may create/revoke upstream provider state and therefore requires a provider-specific mutation contract: what upstream operation is authorized, what recipient/device identity is bound, whether source credentials are consumed/rotated, how provider retries are idempotent, what happens after an ambiguous upstream response, and whether a newly issued secret can be re-fetched after source restart. Until an adapter proves those semantics, it remains `unsupported`; the generic transfer layer must not call arbitrary provider auth endpoints on its behalf.

### 5.3 `non_exportable`

The credential owner knows the credential must not leave its current security
boundary.

Examples may include:

- hardware-backed keys;
- OS-keychain credentials owned by another application;
- device-bound proof-of-possession credentials.

### 5.4 `unsupported`

OpenFork has not yet established safe transfer semantics.

This must be the default for unknown credential types.

### 5.5 OAuth is never generically cloneable by type alone

The presence of:

```ts
{ type: "oauth", access, refresh, expires }
```

does **not** prove the credential may be copied.

OAuth security practice increasingly relies on:

- sender-constrained access/refresh tokens;
- DPoP or mTLS proof of possession;
- refresh-token rotation;
- client-specific binding.

Copying one rotating refresh token to two independent clients can create replay
detection, invalidation races, or a security regression.

Therefore:

> OAuth transfer policy belongs to the provider/auth-method adapter, not to the
> generic OAuth schema.

---

## 6. Proposed domain model

Names are provisional; semantics are not.

### 6.1 Request and transfer identifiers

Use two different high-entropy identifiers because a peer request and an operator-authorized secret mutation are different authority states:

```ts
CredentialTransferRequestID // recipient-minted, disposable request correlation
CredentialTransferID        // source-minted only after operator approval
```

Requirements:

- freeze one strict textual wire format for both IDs before v1 implementation; the recommended profile is 32 cryptographically random bytes encoded as unpadded base64url (43 characters), giving 256 random bits and a narrow decoder;
- B may mint a request ID, but **B never chooses the durable transfer ID**;
- A mints `CredentialTransferID` only when A commits operator approval;
- the party that owns an ID must never intentionally reuse it; collisions against state still retained by that party are rejected;
- do not claim that A can remember every **unapproved** request ID forever: those requests are intentionally memory-only, so a source restart forgets an unapproved request it previously saw. That is safe because a request carries zero disclosure authority. B is responsible for minting a fresh request ID for every new ceremony;
- approved request IDs remain durably bound one-to-one to their source-minted transfer ID, so a request ID that reached approval cannot later name another authorization;
- transfer IDs remain in durable transfer state/replay tombstones for the full security horizon and are never intentionally recycled;
- do not reuse `InvocationID` as either identity.

This prevents an untrusted request from pre-claiming the idempotency/replay namespace of an authorized disclosure without inventing an impossible "the source remembers every memory-only request forever" guarantee.

### 6.2 Transfer request

A recipient may request setup only after it is a trusted peer.

The request is intentionally secret-free:

```ts
// Gate A freezes one exact wire shape for transfer-protocol v1.
// If v1 is HPKE, this includes the recipient's fresh transfer public key.
// If v1 is TLS-only, there is no application-envelope key field.
type CredentialTransferV1RecipientContext = /* fixed by Gate A */ unknown

type CredentialTransferRequest = {
  requestID: CredentialTransferRequestID
  recipientPeerID: PeerID
  recipientContext: CredentialTransferV1RecipientContext
  protocol: "ofxp-credential-transfer-v1"
}

// Source-local, memory-only. These fields are derived by A; B does not supply them.
type PendingCredentialTransferRequest = {
  request: CredentialTransferRequest
  requestInstanceID: CredentialTransferRequestInstanceID // fresh source-local random nonce
  recipientFingerprint: PublicKeyFingerprint
  recipientTrustGeneration: number
  recipientContextDigest: string
  receivedAt: number
  expiresAt: number
}
```

Important:

- the authenticated transport identity must equal `recipientPeerID`;
- the request does not enumerate source accounts;
- the request does not authorize anything;
- transfer-protocol v1 has **one fixed protection profile**, not a recipient-controlled offer list;
- B supplies only the recipient context required by that fixed profile;
- incompatible protection/version support is rejected rather than silently downgraded;
- one peer gets a small bounded number of pending requests;
- A records its own `receivedAt` and computes request expiry from **A's local clock**;
- remote absolute timestamps are not trusted for authorization or TTL decisions;
- expiration is short.

If Gate A selects HPKE for v1, B generates a **fresh recipient transfer keypair per request**. The private key remains memory-only, is bound only to that `requestID`, and is never reused after cancellation, expiry, settlement, or restart. If B restarts and loses it, restart the transfer ceremony with a new request/keypair. If Gate A instead selects TLS-only for v1, there is no application-envelope key and the dedicated no-persistence/no-generic-logging rules in section 7 become part of the fixed v1 protocol contract.

`recipientContextDigest` is SHA-256 over a domain-separated canonical encoding of the **exact Gate-A-frozen recipient context**, e.g. `"OpenFork OFXP credential recipient context v1\\0" || canonical(recipientContext)`. It is not an authentication token by itself; it is a stable comparison/binding value. The same protocol-neutral canonical encoder/test-vector rules used for the manifest apply here. If HPKE is selected, the serialized recipient public transfer key and fixed profile identifier are inside that context and therefore inside the digest.

Unapproved requests should remain **bounded process-memory state on A**, not durable database rows. They carry no authority and may be re-requested after restart. For duplicate `requestID`s while pending: identical peer/recipient-context content is idempotent and does **not** extend the original local TTL; the same ID with different content is rejected as a conflicting replay.

Every newly accepted pending incarnation also receives a fresh source-local `requestInstanceID`, never sent to B and never persisted. Duplicate identical requests while that entry is still pending retain the same instance ID. A source restart, expiry/cancel removal, or later fresh acceptance of the same recipient-minted `requestID` produces a different instance ID. Local review state/native confirmation must bind this instance ID in addition to `requestID`, trust generation, recipient context, candidate revisions, and policy revisions. This prevents an old desktop review that survived a sidecar/source restart from approving a newly recreated same-ID zero-authority request.

Request authority is bound to the authenticated peer identity and recipient context, **not to one TCP/TLS connection**. A disconnect/reconnect may continue the same still-live request when the authenticated peer ID/fingerprint and current trust generation are unchanged. Connection teardown aborts only the in-flight method. Rekey/revocation/trust-generation change invalidates the request/authorization as defined elsewhere.

B keeps a single local “current request” record containing the exact source peer identity, `requestID`, protocol/profile, and recipient context (including its ephemeral public-key identity when HPKE is selected). Every status/approval response must match that record. If B restarts, cancels, expires the request, or replaces it with a newer ceremony, it deletes the current-request record and—under HPKE—the private transfer key; later responses for the old request are discarded as stale.

Because `CredentialTransferID` does not exist until A approves, `credential.transfer.status` must support request correlation before approval. For an exact authenticated requesting peer:

- pending status is addressed by `requestID`;
- after approval, status for that same `requestID` may disclose only the newly minted `transferID`, protocol/profile, coarse authorization state, and source-local expiry needed to continue the ceremony;
- selected credential metadata, local source refs, labels, manifest contents, and inventory counts are not returned by pre-delivery status;
- once a request reached durable approval, the durable authorization's unique `(recipientPeerID, requestID) -> transferID` mapping is authoritative across source restart;
- an unknown, expired memory-only, or not-owned request returns one fixed non-enumerating `not_available` result rather than revealing whether another peer owns it.

A recipient proves that an approval/status response belongs to its **current** ceremony by the authenticated source peer plus exact `requestID` and recipient-context binding; under HPKE, successful decryption later additionally proves possession of the memory-only private key corresponding to that request.

Cancellation is object-scoped. Before approval, the exact requesting peer may cancel its own memory-only `requestID`; A's local operator may also dismiss it. After approval, only the exact recipient may request peer-wire cancellation of its `transferID`, while A's local operator may cancel it through the sensitive local control surface. Neither side may cancel another peer's object by guessing an ID. Cancellation is terminal for disclosure authority and never retargets or widens the transfer.

### 6.3 Local transfer candidate

Only A's local operator UI sees the full candidate projection.

```ts
type TransferCandidate = {
  ref: CredentialTransferRef
  sourceRevision: CredentialTransferSourceRevision // non-secret owner generation/version
  owner: string
  adapterVersion: number // local transfer-adapter contract version
  policyRevision: string // bounded non-secret owner policy generation
  providerID: string
  label: string
  accountHint?: string
  active?: boolean
  policy: TransferPolicy // preferably stable reason codes, not arbitrary provider error strings
}
```

This is metadata, not secret material.

`listCandidates()` must be a **metadata-only path that does not materialize credential values**. Every transferable candidate also needs a non-secret `sourceRevision`/generation that changes whenever **any approved export snapshot changes**: secret material or portable metadata that can affect B (for example a preserved label or source-active intent). This must be an owner-defined monotonic/immutable generation fence, not merely a best-effort wall-clock timestamp, and it should **not** be an unkeyed hash/fingerprint of the secret used as a surrogate revision token. `adapterVersion` freezes the local adapter contract shape used to interpret the candidate; `policyRevision` freezes dynamic export-policy state that could change eligibility without changing the credential row itself. A mismatch in either at disclosure time is `policy_changed` and requires fresh review/approval. A code/process restart still follows the stricter restart-interruption rule rather than attempting to resume under a new adapter implementation.

Several live owners currently expose list/all methods containing raw `key`, `access`, or `refresh` fields. Do not call those APIs merely to render the transfer checklist if doing so can be avoided; add a narrow owner-level summary projection where necessary. Secret material should be read only by the just-in-time export path after disclosure admission. Candidate projections are source-local operator data: they are never sent to the requesting peer merely because that peer is paired.

`accountHint` must avoid unnecessary sensitive PII; adapters should prefer an existing display label over email/account identifiers where possible. Transfer-policy explanations should use stable local reason codes mapped to UI copy rather than surfacing arbitrary provider error text.

### 6.4 One-shot authorization

A creates this only after explicit operator approval:

```ts
type CredentialTransferAuthorization = {
  transferID: CredentialTransferID
  requestID: CredentialTransferRequestID
  recipientPeerID: PeerID
  recipientFingerprint: PublicKeyFingerprint
  recipientTrustGeneration: number
  recipientContext: CredentialTransferV1RecipientContext
  manifest: CredentialTransferManifest
  manifestDigest: string
  recipientManifest: CredentialTransferRecipientManifest
  recipientManifestDigest: string
  issuedAt: number
  expiresAt: number
  state: "approved" | "delivering" | "settled" | "cancelled" | "expired" | "revoked" | "interrupted" | "disabled"
}
```

Do not persist plaintext secrets in this record.

The source **must persist the exact immutable secret-free manifest, source revisions, and recipient context it approved**, not only a digest/count; otherwise a source restart cannot prove which credentials were authorized or which recipient transfer key/context was approved. The manifest contains opaque per-transfer item IDs and the minimum local adapter refs required to re-resolve those items. Under an HPKE v1 profile, the recipient context may contain the recipient transfer public key because it is public material. Neither may contain credential material, authorization headers, labels/emails unless strictly required, provider secrets, or any private transfer key.

If an adapter cannot represent a restart-safe secret-free local reference, that adapter's transfer becomes restart-invalidating: a source restart cancels that transfer and requires fresh operator approval.

### 6.5 Immutable manifest and canonical transfer item

A source-approved manifest is versioned and secret-free:

```ts
type CredentialTransferManifest = {
  version: 1
  items: Array<{
    itemID: CredentialTransferItemID // fresh random ID scoped to this transfer
    owner: string
    adapterVersion: number
    policyRevision: string
    sourceRef: CredentialTransferRef // local opaque adapter ref; never credential material
    sourceRevision: CredentialTransferSourceRevision
    policyMode: "clone" | "reissue"
  }>
}
```

`manifestDigest` is SHA-256 over a **domain-separated canonical encoding**, for example `"OpenFork OFXP credential manifest v1\\0" || canonical(manifest)`. Do not hash ad-hoc `JSON.stringify` output whose canonicalization contract is undefined. The digest is an integrity/idempotency correlation value, not a secret authenticator by itself.

The tree already has recursively sorted canonical JSON bytes in `packages/core/src/filesystem/index-serialization.ts`. Do not import a filesystem-domain module into this security protocol merely because the helper exists there. Either extract the tiny canonical encoding/hash primitive to a protocol-neutral Core utility with exact test vectors or adopt a standard canonical encoding. Whichever format is selected becomes part of transfer-protocol v1 and must be byte-stable across runtimes.

Manifest ordering is **not semantic**. Before canonical encoding, items are sorted by the bytewise/ASCII representation of `itemID`; locale-sensitive comparison is forbidden. Duplicate `itemID` values are rejected. A single source candidate/ref may appear at most once in one manifest; selecting the same credential twice is rejected rather than producing two imports. `owner`, `adapterVersion`, `policyRevision`, `sourceRef`, `sourceRevision`, and `policyMode` are all part of the hashed authorization. The operator UI may preserve its own display order separately, but changing display order must not change authorization semantics.

This full manifest is **source-local authorization state**. Do not transmit `sourceRef` or `sourceRevision` to B merely so B can pretend to validate source internals. They are unnecessary local identifiers/generations and the destination must not preserve them.

Derive a second strict recipient-safe projection from the approved manifest:

```ts
type CredentialTransferRecipientManifest = {
  version: 1
  items: Array<{
    itemID: CredentialTransferItemID
    owner: CredentialTransferOwnerID
    adapterVersion: number
    policyMode: "clone" | "reissue"
  }>
}
```

It uses the same non-semantic canonical item order and duplicate rules. Its domain-separated SHA-256 is `recipientManifestDigest`. The durable authorization stores both the full source `manifestDigest` and this safe projection/digest; the protected inner envelope carries the safe projection, never source refs/revisions. The outer envelope/AAD binds both digests.

A's export path must prove every emitted item maps one-to-one to the durable full manifest and then derive the recipient projection from that exact manifest. B independently recomputes `recipientManifestDigest`, verifies the protected item-ID/owner/adapter-version set exactly equals the recipient projection, and applies its own local policy. This is the honest split: **A proves what the operator authorized; B proves the received payload is internally exact and locally acceptable.** B cannot and need not validate A's private source-revision bookkeeping.

At disclosure admission, the source re-resolves the adapter registry entry and requires the approved `adapterVersion` and `policyRevision` to remain valid. Recipient adapters independently enforce their own supported wire/adapter version and policy; a matching source version is never permission to mutate an unsupported destination owner.

At export time, each adapter must resolve `sourceRef` and prove its current non-secret generation still equals the approved `sourceRevision` **as part of the same owner-critical read that captures the secret bytes**. A separate `checkRevision()` followed later by `getSecret()` is a TOCTOU bug. The adapter must return one immutable snapshot `(revision, secret material, portable metadata, adapterVersion, policyRevision)` obtained under the owner's transaction/lock/snapshot semantics, then the transfer layer compares that returned revision/policy tuple to the approved manifest before the bytes may leave the owner boundary.

The owner snapshot is the source-credential linearization point. A mutation that commits **before** that snapshot must be observed as a revision/policy mismatch and prevents disclosure. A mutation that commits **after** a matching snapshot cannot retroactively revoke bytes already captured under the approved revision; it does, however, make the next retry snapshot stale and therefore prevents redelivery under the old approval. Do not claim a stronger “credential can be revoked until the socket write finishes” guarantee unless an owner can actually hold an appropriate lock across the entire encryption/write path.

If the credential changed, rotated, was replaced, portable metadata changed, export policy changed, or the owner cannot prove generation equality, return a safe `source_changed`/`policy_changed` result and require fresh operator approval. Never silently export a newer secret or materially different metadata under an older authorization.

Prefer an explicit integer/opaque generation owned by the credential service. Wall-clock `time_updated` is not a rigorous security generation: it may have coarse resolution, can be rewritten/imported, and is easy to compare incorrectly. For the current `Credential` table, add a true revision/generation if this adapter ships; for the fork multi-key store, expose an explicit immutable generation even though secret replacement under an existing ID is not currently part of its API.

Credential-owner adapters then produce a canonical in-memory representation.

Conceptually:

```ts
type CredentialTransferItem = {
  itemID: CredentialTransferItemID
  owner: string
  providerID: string
  kind: string
  label?: string
  sourceActive?: boolean
  material: SecretBytes
  metadata?: Json
}
```

`material` must use a deliberately secret-bearing type that cannot be casually
JSON-stringified/logged through normal code paths.

A better concrete representation may be per-adapter encoded bytes rather than a
generic object. The transfer service should not inspect provider secrets.

### 6.6 Delivery envelope

Outer transport metadata should be non-secret:

```ts
type CredentialTransferEnvelope = {
  transferID: CredentialTransferID
  protocol: "ofxp-credential-transfer-v1"
  attemptNumber: number // 1..3, source admission counter for this transfer
  recipientPeerID: PeerID
  manifestDigest: string // source approval correlation; opaque to B
  recipientManifestDigest: string // B recomputes from protected safe projection
  protectedPayload: ProtectedCredentialTransferPayload
}
```

`ProtectedCredentialTransferPayload` is fixed by the credential-transfer protocol version. If Gate A selects HPKE for v1, it is an opaque ciphertext object with the frozen v1 profile metadata. If Gate A instead explicitly selects TLS-only for v1, it is a deliberately secret-bearing body accepted only by the dedicated no-log/no-persistence transport path. Provider IDs, labels, account
metadata, and secret values should not be copied into ordinary outer transport
metadata.

### 6.7 Recipient receipt

The recipient persists a non-secret receipt:

```ts
type CredentialTransferReceipt = {
  protocol: "ofxp-credential-transfer-v1"
  transferID: CredentialTransferID
  sourcePeerID: PeerID
  recipientPeerID: PeerID
  manifestDigest: string
  recipientManifestDigest: string
  receiptRevision: number // recipient-owned monotonic journal revision
  state: "committed" | "partial" | "failed" | "ambiguous"
  items: Array<{
    itemID: CredentialTransferItemID
    status: "imported" | "already_present" | "failed" | "ambiguous"
    reasonCode?: CredentialTransferReasonCode
  }>
  recordedAt: number // recipient-local observation time; never an authorization/order fence
}
```

No secret values in the receipt. Use the fresh per-transfer `itemID`; do not derive receipt handles by hashing local credential refs, labels, emails, or account IDs, because predictable identifiers can create unnecessary correlation or dictionary-attack surfaces.

Receipt authenticity in v1 comes from **live authenticated OFXP transport plus exact object binding**, not from an invented detached-signature format: A accepts a receipt only on a connection authenticated as the exact authorized recipient peer, while that peer is still currently trusted/stable and the transfer's bound trust generation still matches. The receipt must name the exact source/recipient IDs, transfer ID, protocol, full source manifest digest, recipient-manifest digest, and complete unique item-ID set. A receipt delivered by another peer, after trust revocation/rekey, or with either digest wrong or an extra/missing/duplicate item is rejected.

`receiptRevision` starts at 1 and increases only when B's durable owner-native reconciliation changes the receipt snapshot. A stores the highest accepted revision plus a canonical digest of that safe receipt. Same revision + same digest is idempotent; same revision + different digest is a conflict; lower revision is stale; higher revision is accepted only when every item transition is legal. `imported`/`already_present` never move backward. `ambiguous` may move to a proven terminal result after owner reconciliation. `failed` may move to `imported`/`already_present` only after an explicitly authorized retry actually commits. The source derives the top-level result from validated item states rather than trusting an inconsistent remote summary.

The derived top-level state is deterministic: `committed` iff every item is `imported`/`already_present`; `ambiguous` if any item is still ambiguous; otherwise `partial` when at least one item succeeded and at least one item failed; otherwise `failed` when all items failed. An empty item set is invalid because an approved manifest must contain 1–64 unique items. `recordedAt` is informational recipient-local time only; A never uses it for receipt ordering, freshness, authorization, expiry, or replay decisions.

A process restart does not create an exception to current trust. An `interrupted` source may reconcile a later exact receipt only if the same recipient identity/trust generation is still valid and OFXP is currently enabled. Cancellation or expiry may likewise accept a later exact receipt for an already-admitted attempt while the same trust generation remains valid; the authorization state stays `cancelled`/`expired` and only the orthogonal result journal changes.

Revocation/rekey is different: once recipient trust is invalid, A does **not** reopen the trust boundary merely to accept a receipt. Explicit source `disabled` is also a hard v1 cut: no new receipt for a transfer terminalized by disable is accepted later merely because OFXP was re-enabled. In those cases A retains the honest local outcome “delivery may have committed remotely; receipt unavailable after trust/disable invalidation.” A future detached signed-receipt design would be a separate protocol feature, not an implicit v1 property.

---

## 7. Cryptographic profile

### 7.1 Transport baseline

The live OFXP transport already targets/uses authenticated TLS 1.3 with peer
identity bound to the presented certificate and pinned OFXP identity.

That remains mandatory.

### 7.2 Application-layer secret envelope

An additional protected payload is desirable defense-in-depth because it can keep
credential plaintext out of generic OFXP frame inspection, buffering, diagnostics,
and future middleware.

However:

> **Do not invent a custom ECDH + HKDF + AES-GCM construction.**

There is currently no obvious HPKE/libsodium dependency in the tree.

P0 must select **exactly one protection profile for transfer-protocol v1**. Do not ship HPKE and TLS-only as simultaneously negotiable v1 alternatives; that doubles the secret-handling surface and creates a downgrade state machine that the product does not need.

#### Preferred v1 choice: standardized HPKE envelope

Use RFC 9180 through a mature, audited implementation.

Requirements:

- a fresh recipient transfer keypair per `requestID`, distinct from the durable OFXP identity key and never reused across ceremonies;
- memory-only recipient private key;
- authenticated OFXP peer identity still supplies transport/auth context;
- bind `requestID`, `transferID`, `attemptNumber`, source peer ID/fingerprint, recipient peer ID/fingerprint, a canonical digest of the exact recipient context/public transfer key, transfer-protocol/profile version, full source `manifestDigest`, and `recipientManifestDigest` into one versioned HPKE `info`/AAD context;
- one explicit frozen HPKE ciphersuite/profile identifier for transfer-protocol v1;
- strict payload size limits;
- no per-transfer algorithm negotiation or downgrade path inside v1;

RFC 9180 defines both P-256/HKDF-SHA256 and X25519/HKDF-SHA256 KEM profiles. The exact KEM should follow the vetted library/platform support, not aesthetics.

OFXP already authenticates both peers at the TLS layer. Therefore the default HPKE candidate should be **Base mode over the already authenticated OFXP channel**, with sender/source identity and transfer context bound into `info`/AAD. Do not reuse the durable OFXP identity private key merely to obtain HPKE Auth mode; that would violate key separation for little benefit.

For v1, protect the **entire bounded transfer payload as one HPKE message per fetch attempt**, not one independent ciphertext per credential. The plaintext is a strict versioned inner envelope containing the repeated bound header plus the complete selected item set. This keeps one manifest/context decision, permits complete structural validation before any destination mutation, and avoids per-item cryptographic state. Every admitted fetch/retry creates a fresh HPKE sender setup/encapsulation and fresh AEAD context; never reuse an HPKE sender context, sequence number, nonce, or ciphertext across retry attempts. The recipient's request-scoped KEM keypair may remain the same only for the lifetime of that one still-current request/authorization.

Unknown **outer** envelope fields/oversized ciphertext are rejected before decryption. Unknown or malformed **inner** fields are necessarily rejected after authenticated decryption but before adapter preparation. Any protected-envelope/schema/manifest/item-set failure fails the whole attempt with **zero credential mutations**. Item-level partial results begin only after the entire protected payload has passed protocol/schema/policy preflight and owner mutations actually start.

HPKE itself does **not** provide replay prevention, downgrade prevention, plaintext-length hiding, or a general forward-secrecy guarantee against recipient-key compromise. Those properties must not be claimed. Replay/downgrade are protocol responsibilities here, and the recipient transfer key's short memory-only lifetime is exposure reduction rather than a marketing claim of perfect forward secrecy.

#### Alternative v1 choice only if HPKE fails Gate A: TLS-only direct secret channel

If no HPKE implementation clears the dependency/audit/runtime bar, make an explicit ship/no-ship decision. If TLS-only is accepted, it becomes the **single fixed v1 profile**, not a runtime fallback selected when HPKE fails or a peer asks for weaker protection:

- authenticated/pinned TLS 1.3 remains mandatory;
- plaintext secret payload exists only in source/recipient process memory;
- transfer frames are never persisted, logged, traced, or placed in generic
  invocation ledgers;
- delivery must use a dedicated secret-bearing transport path;
- the TLS-only plaintext body must not flow through the generic capability dispatcher, generic request/activity tracing, or any middleware that may stringify bodies;
- no reconnect replay based on persisted plaintext.

This is less defense-in-depth but still preferable to home-grown cryptography. If a later release introduces HPKE after a TLS-only v1 shipped, add a new credential-transfer protocol version/profile and make fallback to the older profile an explicit local compatibility policy. Do not silently negotiate down.

### 7.3 Explicitly rejected profile

Reject a hand-rolled "TLS exporter + custom HKDF + custom AEAD protocol" unless a
later audited design demonstrates a concrete need.

The crypto code should be smaller and more standard, not merely cleverer.

### 7.4 Key separation

Never reuse:

- the long-lived OFXP P-256 identity private key as a payload decryption key;
- pairing nonces as encryption keys;
- provider credentials as transfer encryption keys.

Identity, pairing, and secret-envelope keys have different lifetimes/purposes.

---

## 8. Credential-owner adapter contract

The transfer service should consume one protocol-neutral interface.

Illustrative shape:

```ts
interface CredentialTransferAdapter {
  readonly owner: string

  listCandidates(): Effect<readonly TransferCandidate[]>

  prepareExport(input: {
    ref: CredentialTransferRef
    expectedSourceRevision: CredentialTransferSourceRevision
    destinationPeer: PeerIdentitySummary
  }): Effect<PreparedCredentialExport, TransferPolicyError>

  prepareImport(input: {
    sourcePeerID: PeerID
    transferID: CredentialTransferID
    itemID: CredentialTransferItemID
    metadata: TransferItemMetadata
  }): Effect<PreparedImport, ImportValidationError>

  reconcileImport(input: {
    sourcePeerID: PeerID
    transferID: CredentialTransferID
    itemID: CredentialTransferItemID
  }): Effect<ImportReconciliation, ImportError>

  commitImport(input: PreparedImport & {
    material: SecretBytes
    sourcePeerID: PeerID
    transferID: CredentialTransferID
    itemID: CredentialTransferItemID
  }): Effect<ImportResult, ImportError>
}
```

Exact Effect error types should be domain-specific.

### 8.1 Adapter responsibilities

Each adapter owns:

- mapping local credential IDs to transfer refs;
- exposing metadata-only candidates without eagerly reading every secret;
- determining clone/reissue/non-exportable policy;
- a non-secret monotonic/immutable source revision/generation that detects credential replacement/rotation under the same local ref;
- just-in-time revision verification and secret materialization only after delivery admission;
- strict decoding and validation of portable metadata;
- conflict detection;
- owner-native migration/initialization before conflict decisions;
- local ID creation;
- active-selection behavior;
- destination persistence through the least-destructive authoritative owner method;
- **crash-safe semantic idempotency** keyed by source peer + transfer ID + item ID, not merely in-memory dedup;
- deterministic `reconcileImport()` behavior after ambiguous process/transport failure;
- post-import cache/event invalidation.

### 8.2 Transfer service responsibilities

The generic transfer service owns:

- peer/trust validation;
- one-shot authorization;
- transfer IDs;
- expiry;
- full source authorization manifest digest plus recipient-safe manifest projection/digest;
- cryptographic envelope;
- bounded payload limits;
- source/recipient state machines;
- receipts/reconciliation;
- audit events;
- redaction boundary.

### 8.3 Decrypted payload remains untrusted

A cryptographically authenticated source is not equivalent to a trusted serialized object. After decryption, B must treat every field as untrusted structured input.

Requirements:

- strict versioned schemas with excess-property rejection;
- enforce both encoded-byte and decoded-structure limits before owner mutation: strings, arrays, item count, object depth, metadata bytes, and total payload;
- the protected inner header must repeat/bind protocol version, transfer ID, attempt number, source peer ID, recipient peer ID, full source manifest digest as opaque correlation, `recipientManifestDigest`, and item count; every value must exactly match authenticated outer/local state;
- B recomputes the recipient-safe manifest digest and requires item IDs to be unique and the decrypted item-ID/owner/adapter-version set to exactly match that protected recipient manifest projection—no extra, missing, duplicated, or substituted item. B does not receive or pretend to validate source-local refs/revisions;
- B independently re-evaluates whether its local adapter supports that owner/kind/import mode; **source-declared `clone`/`reissue` policy is never destination authority**;
- adapter allowlists for portable metadata rather than blind forwarding of `metadata`, URLs, enterprise endpoints, account fields, or provider/plugin blobs;
- labels/control text sanitized and length-bounded before UI/storage;
- destination owner/provider identity selected from the local allowlisted adapter registry, never by an arbitrary remote filesystem path/module name or dynamically loaded provider/plugin name;
- do not merge untrusted metadata into local configuration with broad `Object.assign`/spread-style semantics; reconstruct a typed destination value from explicitly accepted fields;
- v1 does not compress secret-bearing plaintext before protection. Compression is unnecessary for these tiny payloads and adds another parser/state surface; HPKE also does not claim to hide plaintext length;
- preflight every item's schema/policy/conflict state before beginning mutation where possible, while still preserving truthful partial/ambiguous semantics for commits that cannot be globally atomic;
- schema/decode failures converted to fixed safe reason codes before they cross the secret-handling boundary—do not propagate validator errors that may include raw secret-bearing input.

A compromised paired source must be able to cause, at worst, a rejected/failed/ambiguous import within a **locally supported** adapter—not arbitrary local configuration mutation, plugin loading, path selection, or credential-owner replacement.

### 8.4 What adapters must not do

Adapters must not:

- decide OFXP peer authority;
- emit secrets into logs;
- enumerate all plaintext credentials merely to build UI metadata;
- create a second networking protocol;
- persist transfer plaintext outside their normal credential owner;
- blindly pass through provider/plugin metadata objects;
- trust a remote `providerID`, URL, account field, or metadata blob enough to write arbitrary local auth state without schema/policy validation.

---

## 9. Initial adapter matrix

| Owner | Candidate v1 policy | Notes |
| --- | --- | --- |
| Fork OpenCode Go multi-key store | **clone** | First implementation target. Secret material is effectively immutable per local credential ID today; expose an explicit owner revision/generation anyway rather than relying on that accident forever. Recreate local IDs on B. |
| Legacy Auth API key | **blocked until owner revision semantics exist; then clone only into an empty/exact-matching destination slot** | `Auth` is single-slot per provider, `set` replaces, and the live owner lacks a robust per-credential generation token. Add safe source-revision semantics before enabling transfer; never overwrite a different destination credential implicitly. |
| Legacy Auth OAuth | **unsupported by default** | Enable only through provider-specific transfer policy. |
| Legacy Auth well-known key/token | **unsupported initially** | Semantics need provider-specific audit. |
| Current `Credential.Key` | **clone after owner integration** | Add/use an explicit monotonic owner revision for security fencing; `time_updated` alone should not be the sole proof because timestamp equality is not a rigorous generation token. Import with non-destructive `Credential.Service.add`, not `create`. |
| Current `Credential.OAuth` | **unsupported by default** | Provider-specific policy required. |
| `OPENCODE_AUTH_CONTENT` | **non_exportable / destination-managed** | Externally managed process configuration. Also refuse/flag imports that would be shadowed by active environment-owned auth instead of pretending the imported file credential became active. |
| Verdent desktop keytar token | **non_exportable** | Credential is owned by another application/OS store; OpenFork should not silently redistribute it. |
| Unknown plugin credential | **unsupported** | Opt-in adapter required. |

This table is intentionally conservative.

### 9.1 First-adapter owner contract — Fork/OpenCode Go

Repository audit shows the current owner is **not yet safe enough to call implementation-ready**:

- `ForkCredentials.Info` and `list()` include the raw `key`; transfer candidate rendering therefore cannot reuse `list()`;
- `fork_credential` currently has `id/label/key/active/time_created` but no security revision or origin/provenance field;
- `ensureMigrated()` is lazy and sets its in-process `migrationChecked` flag before the asynchronous migration work completes, so that boolean is not a reusable “initialization finished” barrier for a new security-sensitive API;
- `add()` computes first-active state with a separate count/read and insert; `select()` performs two separate updates; `remove()` spans read/delete/reselection. Those current methods are normal application APIs, not the transaction contract required for transfer import;
- there is no existing owner-native transfer idempotency marker.

The future first adapter therefore has this **exact required owner contract**; implementation remains prohibited during Phase 0:

1. Add a persistent positive per-credential transfer revision (name implementation-defined; semantics fixed here), initialized to 1 for existing rows.
2. Increment that revision in the same owner transaction whenever an export-relevant snapshot field changes: secret/key material, portable label, or active-selection state. A selection change increments every row whose exported active bit changes. Deletion removes the row and therefore makes later export resolution fail `source_changed`.
3. Introduce a serialized/memoized owner `ensureReady`-style barrier that completes **provenance-aware** legacy Auth migration before candidate projection, export, conflict detection, or transfer import. Do not treat the current set-before-I/O `migrationChecked` boolean as proof that migration completed, and do not call origin-blind `Auth.get()` in a way that turns `OPENCODE_AUTH_CONTENT` into an apparently OpenFork-owned transferable row.
4. Add owner provenance to the transferable credential record/projection. New credentials created through the authoritative local Fork owner are `local_owned`. A migration may classify an exact credential as `local_legacy_auth` only when the owner can prove it came from OpenFork's local `auth.json` path rather than the environment override. Active `OPENCODE_AUTH_CONTENT` remains externally managed/non-exportable and must not be silently persisted merely to make transfer easier. Existing historical fork rows have no provenance today; migrate them to `legacy_unknown` unless the owner can deterministically reconcile them to a current locally owned source. `legacy_unknown` is non-exportable by default. A separate explicit local “adopt/re-add as OpenFork-managed credential” action may create a new `local_owned` credential, but transfer approval itself must never silently perform that adoption.
5. Candidate projection selects only bounded non-secret fields such as local ref, label, active state, revision, provenance/eligibility, adapter/policy version. It never selects `key`.
6. Just-in-time export performs one owner query/snapshot returning `key + portable metadata + revision/policy tuple` for the exact ref. The transfer layer compares that returned tuple with the frozen manifest before constructing any outbound plaintext.
7. Destination import first completes owner initialization, then uses one owner-owned SQLite transaction for conflict detection, new local-ID creation, safe label handling, active-selection mutation, credential insertion, and import-idempotency recording.
8. The idempotency key is the tuple `(sourcePeerID, transferID, itemID)`, enforced by an owner-owned unique constraint/marker in the **same SQLite transaction** as the credential mutation. The marker records the resulting local credential ID and enough non-secret correlation (for example manifest digest/adapter version) to detect conflicting reuse.
9. If the exact key already exists locally, the owner may map the idempotency marker to that existing local credential and return `already_present`; it must compare secret equality only inside the credential owner and never expose a public secret fingerprint. Same label + different key is not an account-identity conflict; labels are presentation only and are deconflicted locally.
10. Preserve an existing destination active credential. If the destination had no credentials before the batch, activate an imported item marked source-active when one is present; if the selected subset contains no source-active item, deterministically activate one successfully imported item by canonical item-ID order so the owner does not end with an accidental unusable no-active state. Manifest ordering itself remains non-semantic.
11. A failed export never persists plaintext or a secret staging record. A failed/rolled-back import leaves neither credential nor idempotency marker. A crash after the atomic owner transaction can be reconciled from the marker even if the generic transfer receipt was never written.

This contract is deliberately stronger than the live owner. Phase 2 must change the **owner APIs first** and then build the adapter over them; OFXP must not reproduce these SQL rules itself.

---

## 10. Import/merge semantics

### 10.1 Never preserve local database IDs blindly

Source credential IDs are local implementation identities.

B should mint its own local IDs unless the authoritative owner defines a genuinely
portable upstream account identifier.

### 10.2 Preserve provider account identity separately

If an owner knows an upstream stable account identity, it may transfer that as
validated metadata.

Do not conflate:

- local credential ID;
- account ID;
- provider ID;
- model routing account ID;
- display label.

### 10.3 Existing destination credentials

Safe default:

- run the owner's own lazy migration/normalization path before deciding what already exists;
- do not destructively replace unrelated existing credentials;
- owner adapter detects exact/stable-account conflicts;
- add when safe using the owner's non-destructive method;
- report `already_present` for an idempotent match;
- require a separate explicit conflict action before overwriting a different secret for the same upstream account;
- if the destination is externally managed (for example an environment override), report that state instead of writing a shadowed credential and claiming success.

Concrete live-tree hazards to test:

- `ForkCredentials` performs legacy-auth migration lazily; the transfer import path must not bypass owner initialization and thereby strand an existing migrated key outside the new multi-key set;
- current `Credential.create` deletes existing integration credentials, so transfer import must use `add` unless an explicit destructive replacement flow is being performed.

### 10.4 Active selection

Default rule:

- if B already has an active credential, preserve B's local selection;
- if B had no credential for that owner/provider and one successfully imported selected item carries source-active intent, make that item active;
- if B had no credential and the selected subset contains no source-active item, the owner chooses one successfully imported item by a documented deterministic local rule rather than leaving an accidental no-active state;
- never silently deactivate a pre-existing destination account because A had a different active account;
- active intent is portable metadata and therefore covered by the source revision; changing A's active selection after approval invalidates the old snapshot for affected items.

A future UX may offer "make this device match A's active selections" as an explicit option.

### 10.5 Labels

Labels are convenience metadata, not identity.

Sanitize/bound them and resolve collisions locally.

### 10.6 Transfer credentials, not behavioral/history state

Credential transfer is not account-state synchronization. Unless a provider-specific reissue flow explicitly requires otherwise, do **not** transfer:

- local request/message attribution history;
- usage ledgers or capacity-estimator evidence;
- quota snapshots/caches;
- cooldown/backoff state;
- provider catalog/model caches;
- local routing preferences beyond the narrowly defined active-selection merge rule;
- session cookies or unrelated browser/app state;
- source timestamps that are only local bookkeeping.

For the first OpenCode Go adapter, transfer the selected key plus bounded portable label/active intent only. B should build its own usage/capacity/routing evidence from its own runtime and fresh official snapshots.

---

## 11. Transfer lifecycle and state machine

Keep two orthogonal state domains instead of overloading one enum:

1. **source authorization lifecycle** — whether A may disclose/re-disclose: `approved | delivering | settled | cancelled | expired | revoked | interrupted | disabled`;
2. **recipient import/result state** — what B can prove happened: `none | committed | partial | failed | ambiguous`, plus per-item results and receipt revision.

`delivering` means only that source disclosure admission succeeded. It does **not** mean the socket write completed, B decrypted the payload, or any credential was imported. Receipt acceptance updates the orthogonal recipient result journal; it does **not** by itself consume disclosure authority. `settled` is reserved for the case where A has accepted a receipt proving every selected item is durably `imported` or `already_present`, so no further secret-bearing retry is necessary. A `partial`, `failed`, or `ambiguous` receipt may coexist with source authorization state `delivering`, `expired`, `cancelled`, `interrupted`, `revoked`, or `disabled` depending which authority event won. UI and audit events must not collapse these concepts into a false “delivered successfully” state.

The source-side transition relation is closed and explicit:

| From | Event | To | Secret authority effect |
| --- | --- | --- | --- |
| no durable transfer | approval durable insert succeeds | `approved` | creates the one immutable authorization; no secret read yet |
| `approved` | first disclosure admission wins | `delivering` | one secret-bearing attempt may snapshot/export after the fence |
| `approved` | cancel / expiry / trust revoke / source restart / OFXP disable | corresponding terminal state | zero disclosure if this transition wins first |
| `delivering` | retry admission wins | `delivering` | increments bounded attempt counter; one new snapshot/export attempt |
| `delivering` | all-item success receipt accepted | `settled` | permanently removes future disclosure authority |
| `delivering` | cancel / expiry / trust revoke / source restart / OFXP disable | corresponding terminal state | no future disclosure/retry; admitted in-flight work is only best-effort aborted |
| any terminal state | receipt/result reconciliation that is still permitted by current trust rules | same authorization state | result journal may improve; disclosure authority never returns |
| `settled` | any later request/fetch/retry | `settled` | reject secret delivery; exact duplicate receipt remains idempotent |

No other authorization-state transition is valid. In particular, terminal states never return to `approved`/`delivering`, `settled` never means “partial but done,” and receipt reconciliation cannot resurrect disclosure authority.

The memory-only request lifecycle is separate and keyed by the authenticated `(recipientPeerID, requestID)` tuple: `absent -> pending` on a valid trusted request; identical duplicate from that same peer remains `pending` without TTL extension; conflicting duplicate from that peer is rejected without state change; durable approval consumes that exact `requestInstanceID` into the durable `(recipientPeerID, requestID) -> transferID` mapping; expiry/cancel/trust invalidation/restart/disable removes the pending entry. A different peer presenting the same recipient-chosen `requestID` is a separate zero-authority request namespace and can never alias/query/consume the first peer's request. A later same request ID from the same peer after memory loss is a fresh zero-authority pending incarnation unless that peer+request tuple already has a durable mapping.

### 11.1 Recipient request

```text
none
  |
  | B -> A request (trusted peer only)
  v
requested
```

The request:

- is rate-limited per authenticated peer and under a small process-global pending cap;
- has a short TTL;
- contains no source credential metadata;
- may create a passive local notification/badge on A, but a peer request must **never auto-open a modal/native confirmation dialog**;
- repeated/duplicate requests do not refresh TTL or generate unbounded notifications;
- only an explicit local user action opens the approval UI;
- never auto-approves.

### 11.2 Operator approval

```text
requested
  |
  | A operator selects concrete candidates
  v
approved
```

Approval must:

1. resolve the current memory-only pending entry by `requestID` and require the exact source-local `requestInstanceID` that the operator reviewed;
2. reload current peer trust/fingerprint/re-key state and require the same trust generation bound to that pending entry;
3. require the pending entry to still be unexpired and OFXP enabled;
4. resolve current candidate metadata and require every selected ref/revision/adapter-version/policy-revision to match the reviewed snapshot;
5. reject newly non-exportable, deleted, changed, duplicated, or policy-changed items;
6. build the deterministic canonical manifest itself; never accept a renderer-created manifest;
7. mint the source `CredentialTransferID` only at durable approval;
8. persist authorization metadata only—never plaintext secrets.

The memory-only request cannot be transactionally deleted in the same SQLite commit that creates durable authorization. The **approval linearization point** is therefore the successful immediate-writer insertion of the unique durable `(recipientPeerID, requestID) -> transferID` authorization after all checks above. The durable row wins from that instant onward. Only after commit does A remove the pending memory entry best-effort.

All request/status/local-approval paths must check the durable `(authenticated recipientPeerID, requestID)` mapping before treating that tuple as a fresh pending request. This closes the crash window where approval committed but the process died before deleting memory without letting one paired peer occupy another peer's recipient-chosen request namespace. A repeated exact local approval after commit returns/reuses the already-created transfer only if recipient/context/manifest/review binding is identical; conflicting reuse fails closed. A peer retry of its already-approved request is projected as existing transfer status, never as a second pending request or a second authorization.

If the durable insert fails, no disclosure authority exists and the pending request remains subject to its original TTL. If the source restarts before durable approval, the pending entry and `requestInstanceID` disappear; any later same recipient-minted `requestID` is a fresh zero-authority request with a new instance ID, so an old native review cannot authorize it.

### 11.3 Recipient fetch + just-in-time export

v1 is **recipient-pull**, not source-push:

```text
approved on A
  |
  | B -> A: credential.transfer.fetch(transferID)
  | over authenticated OFXP TLS as the exact recipient peer
  v
delivering
  |
  | A returns one protected payload as the fetch response
  v
B prepares/imports
```

B may poll only the coarse transfer status while its setup UI is actively waiting. Status must not reveal A's credential inventory or selected-account metadata beyond what B is already authorized to receive. A source-initiated push path is deliberately absent from v1.

This direction has important properties:

- the peer asking for the bytes is the same TLS identity against which A performs disclosure admission;
- A does not need to rediscover or establish a new outbound route to B after approval;
- asymmetric firewall/NAT behavior is simpler because B already proved it can reach A;
- there is no second source-side retry/dial state machine that can accidentally target stale discovery metadata.

Immediately before reading any secret for **every** fetch attempt, the authoritative transfer owner performs one atomic disclosure-admission transaction:

1. re-read the peer's current trust/re-key state and dedicated trust generation;
2. verify fingerprint and recipient identity;
3. verify OFXP is enabled and the authorization is unexpired;
4. verify the frozen protocol/profile, recipient context, immutable manifest, adapter versions, and policy revisions;
5. prove the authenticated fetch caller is exactly the authorized recipient peer;
6. require no existing in-flight disclosure lease for this transfer;
7. mint a fresh source-local `disclosureAttemptID`, atomically store it as the in-flight lease and increment the bounded disclosure-attempt counter; for the first attempt also require `approved` and transition to `delivering`;
8. for a retry, require the same `delivering` authorization to still belong to the **current source runtime lifetime**, re-run all checks above, enforce the retry budget, and acquire the same single-in-flight lease before any new secret snapshot.

The first `approved -> delivering` compare-and-transition is the **initial disclosure linearization point**. Each later retry has its own equally strong **retry-admission linearization point**. Both must use the repository's immediate-writer semantics for read-before-write security decisions; do not implement either as a stale read followed later by an unrelated update. A retry is not “already authorized bytes”; it is a new opportunity to read and emit secrets under the same immutable human authorization and therefore must be re-admitted.

Only after the relevant admission transaction commits may adapters perform their atomic revision+secret snapshot and the fetch response begin carrying protected credential material. `expiresAt` is an **admission/retry deadline**: if one attempt crossed its fence while valid, its bounded in-flight encryption/write may finish, but no new secret-bearing retry may be admitted after expiry. Non-secret status may continue after expiry, and receipt reconciliation follows the separate trust rules in section 6.7.

The in-flight lease is durable security state, not merely a Promise/mutex. On normal success, safe transport failure, or request abort, the transfer owner clears it with a compare-and-set that requires the same `disclosureAttemptID`; a late completion from attempt N must never clear attempt N+1's lease. Terminal cancel/expiry/revoke/disable may clear or ignore the marker because the authorization can no longer retry. A process crash need not recover the lease: startup first terminalizes old `approved|delivering` rows to `interrupted`, so no new disclosure can inherit it. If lease cleanup itself fails in a live runtime, retries fail closed as `busy` rather than guessing that no secret-bearing work remains.

`disclosureAttemptID` is source-local/non-secret bookkeeping and does not grant authority. If Gate A chooses HPKE, include a monotonic `attemptNumber` (the post-increment disclosure-attempt counter) in the protected inner header and HPKE application context so responses from distinct admitted attempts cannot be accidentally conflated. The recipient does not treat a higher attempt number as authority to overwrite owner-native idempotency state.

The source runtime creates an ephemeral random `runtimeInstanceID` at startup. A `delivering` transfer may retry only while associated with that runtime instance. The identifier need not be a remote protocol field; it exists to make “same source-runtime lifetime” testable rather than rhetorical. Startup recovery changes all persisted `approved`/`delivering` rows to `interrupted` before transfer methods become reachable, so a previous runtime's disclosure authority cannot be adopted by the replacement process.

Revocation/cancellation semantics are therefore precise:

- revoke/cancel/re-key that wins **before the relevant first-attempt or retry-admission fence** prevents that disclosure attempt;
- authority change that races **after that attempt's admission fence** blocks future deliveries/retries and should abort in-flight I/O best-effort, but the product must not claim it can retroactively unsend bytes already authorized/captured/emitted;
- if the owner-secret snapshot already occurred before a later credential mutation, that approved snapshot may still be emitted by the admitted attempt; the mutation blocks the next retry snapshot;
- re-pairing never revives an old transfer because its bound trust generation remains stale.

### 11.4 Recipient prepare/import

B:

1. authenticates the exact source OFXP peer and verifies its current trust/re-key state;
2. verifies this response belongs to B's still-current request/transfer and that OFXP remains enabled;
3. validates outer envelope bounds before allocating/decrypting the protected body;
4. resolves recipient-local transfer identity as the composite `(authenticated sourcePeerID, transferID)`; a source-minted transfer ID never aliases another source's object;
5. decrypts the protected payload;
6. validates the complete protected context/manifest/item set and all strict schemas;
7. asks **every** destination adapter to preflight local support/policy/conflicts without mutation;
8. crosses a local recipient **import-admission fence**: the request/transfer is still current, OFXP is enabled, source trust still matches, and the payload has not been superseded/cancelled;
9. commits owner batches using owner-native idempotency;
10. persists/reconciles the per-item durable receipt revision;
11. destroys plaintext transfer buffers as soon as practical.

A protocol/schema/manifest/preflight failure before step 8 yields zero credential mutation. Once owner mutation begins, the system no longer promises all-or-nothing across unrelated stores: later owner failure, process termination, or local disable can produce a truthful `partial`/`ambiguous` result governed by section 12.

Recipient-side disable/cancel that wins **before** the import-admission fence discards the payload and performs zero import. If it wins after an owner transaction has committed, it cannot undo that credential; it prevents starting later owner batches/network work where safe and records the resulting partial/ambiguous receipt. This is the recipient-side analogue of the source disclosure fence.

### 11.5 Receipt progression and settlement

```text
A returns fetch payload
   |
   v
B imports / durably records receipt revision
   |
   | B -> A: credential.transfer.receipt
   v
A validates exact recipient + transfer + manifest/item set + receipt revision
   |
   +--> all items imported/already_present -> authorization becomes settled
   |
   +--> partial/failed/ambiguous -> store result snapshot; disclosure authority
        remains whatever the source lifecycle independently permits
```

Receipt acceptance is therefore **not synonymous with settlement**. A stores the highest legal receipt revision even when the recipient result is partial/failed/ambiguous. While the source authorization is still `delivering`, unexpired, in the same runtime, below the attempt budget, and contains no unresolved ambiguous item that would make replay unsafe, B may request another fetch under the same immutable manifest. Successful/reconciled items are skipped idempotently on B; the source still sends one complete authenticated payload because the manifest itself is immutable.

A transitions the source authorization to `settled` only when the accepted receipt proves every selected item is durably `imported` or `already_present`. If the operator/recipient stops after a partial or failed result, the authorization ends through the ordinary `cancelled`/`expired`/`interrupted`/`revoked`/`disabled` lifecycle rather than laundering a partial result into “settled success.”

If receipt delivery is lost, B queries `status(transferID)` and re-sends its already-durable highest receipt revision when A has not accepted it. A missing acknowledgement does **not** imply import failure. B's durable receipt is authoritative for what B can prove it committed. A never responds to an ambiguous result by inventing success or blindly creating a new transfer.

### 11.6 Cancellation/expiration/restart

Source operator may cancel a live `approved` or `delivering` authorization. Already-terminal `expired`/`revoked`/`interrupted`/`disabled` records remain in their original terminal state; cancellation is idempotent/no-op for `cancelled`, and `settled` cannot be converted into cancellation. This preserves the reason that authority ended rather than rewriting history.

A source-process restart is a fail-closed disclosure boundary. During startup, **before the credential-transfer control dispatcher/wire methods become reachable**, A must transition every persisted `approved` or `delivering` authorization to `interrupted`. This recovery step is part of Tier-0 process composition, not a best-effort background cleanup after the OFXP listener starts. If recovery cannot complete, credential-transfer methods stay fail-closed/unavailable even if unrelated OFXP functionality is allowed to start.

An `interrupted` transfer:

- can never be fetched/redelivered again;
- may still accept an exact receipt only from the same currently trusted/stable recipient with the same bound trust generation, if B had already committed before A restarted;
- cannot accept a new receipt after that peer was revoked/rekeyed/disabled merely to make source status look cleaner;
- otherwise requires a brand-new request and fresh operator approval.

This deliberately avoids resuming a minutes-long secret-disclosure ceremony across process/software restart, avoids durable wall-clock authority extension, and prevents changed adapter/provider policy after restart from inheriting old approval. Recipient restart is separate: its memory-only pending request/HPKE private key is lost, so an unsettled ceremony is abandoned locally; durable completed/partial receipts and owner-native idempotency markers remain available for local reconciliation, but recipient restart never causes A to re-enable secret delivery across A's own restart boundary.

Expiry/cancel:

- prevents future export/delivery;
- cannot undo recipient items already committed;
- is recorded as state, not as secret-bearing history.

---

## 12. Idempotency and ambiguous commit

Credential transfer is a mutation protocol and must be designed like one.

### 12.1 Source idempotency

One `transferID` has one immutable:

- recipient identity;
- fixed protocol-v1 recipient context;
- selected full source authorization manifest;
- full source manifest digest;
- derived recipient-safe manifest projection and digest.

Changing any of these creates a new transfer.

"One-shot" means **one immutable disclosure authorization and one recipient-side semantic import**, not literally one TCP frame. Within the same source-runtime lifetime, an ambiguous fetch transport failure may be retried only with the same recipient, fixed recipient context, manifest, and digest, after re-checking current trust, and B must deduplicate semantic import. Across a source-process restart there is **no secret redelivery**: the authorization becomes `interrupted` and only receipt reconciliation remains legal.

### 12.2 Recipient idempotency

B maintains a bounded durable transfer journal, but **the generic receipt is not sufficient by itself for exactly-once import**. A crash can occur after an owner commits the credential and before the transfer service persists the receipt.

Therefore every import adapter must provide one of these proofs:

1. atomically persist an opaque import-idempotency key with the credential mutation in the owner's own transaction/store; or
2. provide an owner-native deterministic reconciliation rule that can prove the exact item is already present without creating another credential.

If neither proof is possible, a crash window must settle as `ambiguous`; the transfer service must not blindly retry that item.

For an existing recipient-local `(sourcePeerID, transferID)` object:

- same source + same full manifest digest + same recipient-manifest digest -> return/reconcile the existing receipt;
- the same `transferID` presented by a different authenticated source is a different namespace and must never read/mutate the first source's journal;
- different full manifest digest or recipient-manifest digest -> reject;
- already committed/reconciled item -> never duplicate it;
- item with unresolved commit ambiguity -> return `ambiguous` until the owner can reconcile or the user resolves it.

### 12.3 Partial multi-owner commits

If owner A commits and owner B fails:

- receipt is `partial`; use top-level `ambiguous` when the system cannot prove which items committed;
- successful item results remain durable;
- retry does not repeat successful/reconciled imports;
- definitely failed items may be retried only under the same immutable manifest while the existing source authorization is still `delivering`, unexpired, same-runtime, below the disclosure-attempt budget, and otherwise re-admissible; once that authorization becomes `expired`, `cancelled`, `interrupted`, `revoked`, or `disabled`, any new secret delivery requires a brand-new request and fresh operator approval—there is no in-place “renew authorization” shortcut;
- ambiguous items are **not** retried until `reconcileImport()` proves a safe next action;
- UI truthfully distinguishes imported, failed, and unknown/needs-attention outcomes.

Do not fake rollback or exactly-once semantics across unrelated stores.

---

## 13. Durable storage

Exact schema is implementation-phase work, but ownership should begin here.

### 13.1 Source authorization table

Conceptual:

```text
ofxp_credential_transfer
  transfer_id PK
  request_id             # recipient-chosen; unique only with recipient_peer_id
  recipient_peer_id        # UNIQUE(recipient_peer_id, request_id)
  recipient_fingerprint
  recipient_trust_generation
  recipient_context_json # fixed-v1 public recipient context only; never a private key
  manifest_json            # immutable source-local refs/revisions + random item IDs; never sent to B
  manifest_digest
  recipient_manifest_json  # immutable recipient-safe projection; no source refs/revisions
  recipient_manifest_digest
  authorization_state
  result_state?         # committed | partial | failed | ambiguous after receipt validation
  disclosure_attempts   # bounded monotonic attemptNumber; incremented atomically on admission
  inflight_attempt_id?  # fresh source-local lease; NULL required for a new admission
  runtime_instance_id?  # source-local non-secret marker; delivering retries require current runtime
  disclosure_admitted_at?
  last_receipt_revision?
  last_receipt_digest? # digest of canonical safe receipt, never secret payload
  issued_at
  expires_at
  settled_at?
  terminal_reason?       # bounded enum/code only; no arbitrary error text
  time_updated
```

Avoid credential labels, emails, portable account PII, or secret material unless proven necessary. `manifest_json` exists so the source can prove/reconstruct exactly what was approved after a restart; it is not a convenient place to mirror provider auth objects.

### 13.2 Recipient receipt table

Conceptual:

```text
ofxp_credential_transfer_receipt
  source_peer_id          # composite PK with transfer_id
  transfer_id             # composite PK with source_peer_id
  recipient_peer_id
  manifest_digest
  recipient_manifest_digest
  receipt_revision
  receipt_digest
  state
  safe_result_json
  recorded_at
  time_updated
```

`safe_result_json` contains fresh random per-transfer item IDs and bounded reason codes, not hashes of predictable local identifiers and never secrets.

### 13.3 Retention

Transfers should not become an unbounded history database.

Use two-tier bounded retention with **v1 constants frozen before implementation**:

- detailed source/recipient transfer + receipt state: retain for **30 days** after terminal settlement/interruption;
- compact replay tombstone `(transferID, sourcePeerID, recipientPeerID, manifestDigest, terminalState)`: retain for **365 days** after terminal state;
- never evict an unexpired/non-terminal authorization or the only deduplication record for a transfer that can still legitimately retry/reconcile;
- enforce a hard tombstone cardinality ceiling of **4096 rows per installation**. If the ceiling is reached and no tombstone is old enough for normal retention GC, fail closed by refusing new credential-transfer approvals rather than evicting live replay protection early.

These horizons are deliberately far longer than the minutes-long disclosure window. They are local anti-replay bookkeeping, not a claim that a copied provider credential expires with the tombstone. Changing these constants before v1 ships is a plan/protocol review; once interoperability/security tests freeze v1, do not silently shorten the replay horizon in a patch release.

Do not garbage-collect the only deduplication record while a source could still legitimately retry. The transfer volume is expected to be tiny, so correctness should dominate micro-optimization.

---

## 14. Wire/control-plane placement

Credential transfer is **not** a fifth model invocation plane.

It is an OFXP operator-control protocol.

Suggested peer-wire namespace:

```text
credential.transfer.info        # secret-free support/profile probe
credential.transfer.request
credential.transfer.status
credential.transfer.fetch          # B -> A; protected payload returned in response
credential.transfer.receipt
credential.transfer.cancel
```

The exact method names may change.

### 14.1 Admission

All peer-wire transfer methods require:

- authenticated OFXP TLS peer;
- currently trusted, non-revoked peer identity;
- stable re-key state;
- exact durable trust generation where the object already binds one;
- transport peer ID/fingerprint equality;
- exact method-direction/role binding;
- exact request/transfer ownership binding.

This requires a narrow **trust-only peer admission primitive** (or equivalent transaction-local query) that does not interpret ordinary capability grant fields/expiry. Do not reuse `OfxpPeer.authorize()` or blindly reuse current `OfxpPeer.access()` for this purpose: the latter currently couples trust admission to capability-grant presence/expiry. Credential transfer is intentionally not authorized by `Ofxp.Grant`. Capability grant/root edits may wake subscribers through `authority_epoch`, but they neither grant nor revoke credential-transfer authority.

For example, only the peer that created a request may cancel/query it; only the exact authorized recipient peer may fetch its transfer from A; only that same recipient may submit its receipt; and only the exact transfer participants may observe transfer status. "Any trusted peer" is never sufficient object-level authorization.

Secret delivery additionally requires the one-shot authorization and disclosure-admission fence. No peer-wire method can approve or widen a transfer; approval exists only on A's local sensitive-operator surface.

The live OFXP TLS listener derives a certificate identity before calling the generic application handler, but generic application dispatch is not itself durable peer authorization. Transfer dispatch must perform trusted-peer/object admission **before HPKE decryption, protected-payload schema work, or credential-owner access**. Reject unknown/revoked/rekey-required peers as early as the application method permits.

The live runtime already closes pooled peer connections on revoke/rekey/authority-generation changes. Reuse that signal to abort in-flight transfer I/O best-effort, but never treat connection teardown as a substitute for the atomic durable disclosure fence.

### 14.2 No generic capability catalog entry

Do not advertise:

```text
capability: credential.read
capability: credential.export
```

The model-facing capability broker must never make this discoverable.

The live runtime currently installs the generic OFXP application handler as a direct call to `OfxpCapability.dispatch(peer, method, body, signal)`. That is a verified repository fact, not the desired architecture. Introduce one **top-level OFXP application/control dispatcher** that owns method-family routing after transport identity extraction:

```text
OFXP transport
  -> base application dispatcher
       -> pairing/base methods        (transport-owned where already appropriate)
       -> credential-transfer control (CredentialTransfer service)
       -> capability/model plane      (OfxpCapability.dispatch)
       -> future first-party control families
```

The dispatcher itself does not grant transfer authority. It performs only method-family classification plus the earliest common peer-trust/method bounds that are genuinely shared; each control service still enforces its own object-level authorization. Unknown methods fail with one bounded safe code. There is no fallback from an unknown `credential.transfer.*` method into capability dispatch, tool execution, or arbitrary dynamic handler lookup.

Model-facing OXP/OFXP tooling must have no callable reference to the local sensitive-operator review/approval methods. Peer-wire control dispatch likewise cannot reach local operator methods by method-name substitution. Treat these as separate typed interfaces even if they share the same underlying transfer service state owner.

Transport teardown aborts the `AbortSignal` for an in-flight method and pooled connection invalidation closes I/O, but neither action mutates durable transfer state by itself. Durable cancel/revoke/disable/retry semantics are owned by the transfer/peer state transactions described elsewhere.

### 14.3 Version/feature negotiation without breaking OFXP v1

Do **not** casually add `credentialTransfer: true` to the current v1 `Hello.features` object. The live `Ofxp.Hello` schema is a strict fixed struct and clients decode Hello with excess-property rejection; an additive field would therefore make an older v1 peer reject the entire Hello.

Use one of two deliberate strategies:

1. **v1-compatible probe (preferred for the first slice):** after ordinary v1 Hello succeeds, call a secret-free transfer descriptor/probe method such as `credential.transfer.info`. A supporting peer returns a strict descriptor of protocol/profile support; an older peer returns `NOT_FOUND`. No secret or account inventory is exposed by the probe.
2. **Protocol v2:** explicitly extend protocol negotiation and Hello schema with backwards-compatible min/max behavior, then advertise transfer support there. Do this only if OFXP needs a broader extensible-feature redesign.

For the preferred probe, freeze a tiny response such as `{ protocol: "ofxp-credential-transfer-v1", profile: <single-v1-profile>, limitsVersion: 1 }` with excess-property rejection. The probe itself requires an authenticated **currently trusted/stable** peer; there is no reason to expose transfer support to an unpaired discovery candidate. Distinguish outcomes deliberately:

- trusted older peer / unknown method -> `not_supported`;
- supported method with malformed descriptor -> protocol error, fail closed;
- supported method with incompatible protocol/profile -> `profile_mismatch`, no fallback;
- peer claims support but a later method fails -> ordinary transfer failure, never profile downgrade;
- revoked/rekey-required/not-owned caller -> authorization failure, not “unsupported”.

Do not persist capability support as durable trust. The simplest v1 cache is per live pooled connection. If a broader cache is introduced, key it by peer ID + fingerprint + trust generation + remote surface fingerprint and invalidate it on reconnect, rekey/revoke, trust-generation change, or surface change.

The live `OfxpClient.negotiate()` currently hard-requires `Hello.features.capabilityExchange === true`. That is an augmentation-plane assumption, not a base OFXP protocol requirement. Before credential-transfer control can be considered implementation-ready, split connection negotiation into: (a) base TLS/Hello identity + protocol compatibility, then (b) optional capability-exchange assertion only for callers that use the augmentation/model capability plane. Credential transfer attaches to the base/control plane and must not deadlock merely because a peer lacks augmentation support.

Do not mutate strict protocol-v1 Hello in a way that creates accidental mixed-version incompatibility.

### 14.4 Transfer-protocol-v1 wire contract

The method names in §14 are now the v1 control namespace, not placeholders:

```text
credential.transfer.info
credential.transfer.request
credential.transfer.status
credential.transfer.fetch
credential.transfer.receipt
credential.transfer.cancel
```

All transfer bodies are strict versioned schemas with excess-property rejection. Except for the bounded protected `fetch` response, encoded control bodies are capped at 64 KiB even though the generic OFXP transport currently permits a larger frame. IDs use the frozen base64url format in §6.1. The authenticated TLS peer identity is **never accepted from a body as authority**; any peer ID field is only a redundant binding that must equal transport identity.

Profile-independent control shapes are:

```ts
type CredentialTransferInfoRequest = {} // or absent body; no caller-controlled fields

type CredentialTransferInfoResponse = {
  protocol: "ofxp-credential-transfer-v1"
  profile: CredentialTransferV1Profile // ONE literal frozen by Gate A
  limitsVersion: 1
}

type CredentialTransferRequestWire = {
  protocol: "ofxp-credential-transfer-v1"
  requestID: CredentialTransferRequestID
  recipientPeerID: PeerID // must equal authenticated transport peer
  recipientContext: CredentialTransferV1RecipientContext // exact ONE shape frozen by Gate A
}

type CredentialTransferRequestAck =
  | { requestID: CredentialTransferRequestID; state: "pending" }
  | { requestID: CredentialTransferRequestID; state: "existing" }
// "existing" reveals no transfer metadata by itself; B follows with status.

type CredentialTransferStatusRequest =
  | { requestID: CredentialTransferRequestID; transferID?: never }
  | { transferID: CredentialTransferID; requestID?: never }

type CredentialTransferStatusResponse =
  | { state: "not_available" }
  | { state: "pending"; requestID: CredentialTransferRequestID }
  | {
      state: "approved" | "delivering"
      requestID: CredentialTransferRequestID
      transferID: CredentialTransferID
    }
  | {
      state: "settled" | "cancelled" | "expired" | "revoked" | "interrupted" | "disabled"
      requestID: CredentialTransferRequestID
      transferID: CredentialTransferID
      resultState?: "committed" | "partial" | "failed" | "ambiguous"
      receiptRevision?: number
    }

type CredentialTransferFetchRequest = {
  transferID: CredentialTransferID
}
// success body = CredentialTransferEnvelope from §6.6

type CredentialTransferReceiptRequest = CredentialTransferReceipt

type CredentialTransferReceiptAck = {
  transferID: CredentialTransferID
  acceptedRevision: number
  disposition: "recorded" | "duplicate" | "stale"
}
// same revision + different digest and illegal higher-revision transitions are errors,
// never a successful "conflict" disposition.

type CredentialTransferCancelRequest =
  | { requestID: CredentialTransferRequestID; transferID?: never }
  | { transferID: CredentialTransferID; requestID?: never }

type CredentialTransferCancelAck = {
  state: "cancelled" | "already_terminal" | "not_available"
}
```

`requestID` lookup is always implicitly scoped by the authenticated caller peer, so a bare body request ID never selects another peer's object. `transferID` is source-generated/global, but object-level authorization still requires the exact participant.

`not_available` intentionally conflates unknown, expired memory-only, and not-owned objects where revealing the distinction would create an enumeration oracle. A correct participant may receive the more specific durable state only after object ownership is established. `status` never returns candidate labels, source refs, manifest contents, credential counts, adapter internals, or secret-bearing failure text.

The transfer service owns a closed safe error-code set for this family. At minimum v1 needs: `not_supported`, `profile_mismatch`, `unauthorized`, `not_available`, `malformed`, `oversized`, `busy`, `expired`, `cancelled`, `interrupted`, `disabled`, `retry_exhausted`, `source_changed`, `policy_changed`, `unsupported_adapter`, `receipt_conflict`, and `internal_safe_failure`. Error codes are not permission to expose arbitrary adapter/provider/validator text.

For the mixed-version probe only, an older peer's existing generic unknown-method/`method_not_found` response is interpreted locally as `not_supported`. No old peer is expected to know the new structured code.

**Gate A dependency:** `CredentialTransferV1Profile`, `CredentialTransferV1RecipientContext`, the protected envelope fields/encoding, KEM public-key length/validation, and ciphertext-overhead ceiling are deliberately **not frozen yet**. Gate A must select exactly one profile and replace those placeholders with one strict shape before Phase 0 exits. Presenting both HPKE and TLS-only shapes as a runtime union would violate the no-downgrade law.


---

## 15. Local operator API

The existing OFXP settings/control surface is the right product neighborhood.

Needed local operations conceptually:

```text
list pending transfer requests
list local transfer candidates
approve request with exact candidate refs
cancel request/authorization
read transfer status/receipt
```

These are Tier 0/process-global operations.

They must not:

- bootstrap a workspace;
- enter `InstanceStore`;
- hydrate Sessions;
- query model history;
- depend on a current directory.

### 15.1 Operator authorization

Approval is a durable user action, not model intent.

Initial release should support only the operator surface whose authority boundary is presently defensible in the repository: **same-machine desktop native control**. Ordinary local CLI/admin execution is deliberately excluded from v1 source approval because model/process tooling can invoke that surface indirectly.

**Do not simply reuse the existing generic HTTP `Authorization` middleware for transfer approval.** In the live tree, `packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts` accepts paired device bearer tokens as valid API credentials. Possession of a normal PWA/device token must not, by itself, authorize reusable provider-secret export.

Introduce a purpose-built sensitive-operator boundary (name provisional, e.g. `SensitiveOperatorAuthorization`) with these v1 laws:

- ordinary paired-device/PWA bearer tokens and the ordinary desktop sidecar HTTP password are rejected as credential-transfer authority for candidate inventory, approval, and export;
- candidate inventory is reachable only through a **request-scoped local operator review surface**, never a generic list-all HTTP API and never a peer/model method;
- the approval action is bound to one pending `requestID`, current recipient identity/generation, the exact reviewed candidate revisions/policy revisions, and the exact selected manifest;
- no reusable credential-export bearer token is minted into renderer state; the privileged local transport itself is the authority channel and the sidecar consumes one exact native-confirmed approval command;
- no "always allow credential transfer" memory/permission exists;
- the sensitive gate remains active even when ordinary loopback server authentication is configured as optional/no-op;
- desktop v1 uses the strongest existing local native control boundary without requiring a workspace runtime; headless approval is **not** included in v1 until it has an operator-presence boundary that model/process tooling cannot invoke indirectly;
- v1 exposes **no browser/PWA HTTP endpoint** for candidate inventory or approval, so CSRF/ambient-browser credentials are removed from the v1 sensitive path rather than merely mitigated with another token.

#### Desktop v1 approval path

Repository audit confirms two distinct desktop channels:

1. ordinary renderer -> sidecar HTTP credentials are **not privileged enough**. `awaitInitialization()` returns `ServerReadyData { url, username, password }` to the renderer, so that server password cannot distinguish native operator confirmation from a compromised first-party renderer;
2. Electron main already owns a private utility-process control channel to the sidecar: `OxpSidecarClient.request()` sends typed `oxp-request` messages using `utilityProcess.postMessage`/`parentPort`, and the renderer can reach only explicitly registered, `RendererTrust`-gated IPC handlers—not arbitrary sidecar commands.

Therefore desktop v1 should extend the **main-process -> utility-process typed control channel**, not HTTP, for the sensitive review/approval path. The architecture is:

1. a trusted top-frame app renderer may ask Electron main to open a review for one bounded `requestID`; it cannot provide authoritative peer/account display strings and cannot request arbitrary source credential IDs;
2. Electron main verifies `RendererTrust` and sends a typed request-scoped **review** command over the private sidecar channel. The sidecar resolves the authoritative pending request, peer ID/fingerprint/trust generation, and bounded metadata-only candidate projection. This review response contains no secret values;
3. Electron main may return that request-scoped safe review projection to the trusted renderer for the premium checklist UI. This is the only desktop candidate-inventory path; no generic renderer HTTP route exists;
4. when the user presses Transfer, Electron main re-resolves the authoritative review snapshot through the sidecar, then presents a **native confirmation dialog/sheet** containing the exact destination identity/fingerprint and selected account summary. Renderer-supplied labels are never the confirmation authority;
5. on native confirmation, Electron main sends one typed `approve exact review` command over the private sidecar channel carrying the bounded `requestID`, exact source-local `requestInstanceID`, selected opaque review refs, and expected review/trust/revision/policy digest needed for stale-action fencing;
6. the sidecar/transfer owner re-reads trust + candidates, rejects any stale revision/policy/review mismatch, builds the canonical manifest itself, and commits approval atomically. The sidecar does not accept a renderer-created manifest or a generic reusable “approval token”;
7. there is no lower-level renderer IPC that accepts “approved=true”, raw manifests, secrets, arbitrary destination IDs, or arbitrary sidecar command objects.

This provides a concrete purpose-built operator boundary while keeping the UI rich. A compromised/XSS'd first-party renderer may be able to request/show a bounded local review through the explicitly exposed trusted IPC, but it cannot approve or export without main-owned native confirmation, cannot widen the reviewed request, and cannot use the ordinary HTTP password to bypass the path. The threat model does not claim resistance to arbitrary same-user native-code compromise.

#### Headless approval — **not in v1**

Do **not** treat “local CLI + interactive TTY” as a sufficient sensitive-operator boundary. In OpenFork, a model/agent may legitimately hold process execution authority; such an agent can invoke a normal CLI, and depending on the execution surface may also control a pseudo-terminal. A `--yes`/non-interactive override would be an even clearer ambient approval bypass.

Therefore the first credential-transfer release is **desktop-native approval only**. Headless/source-server installations may participate as recipients, but they cannot act as an approving credential source until a separate operator-presence design proves that model-facing process/OXP tooling cannot invoke, satisfy, relay, or replay it. Possible future primitives may include an OS/native user-presence surface or external hardware-backed confirmation, but this plan does not choose one without repository/platform evidence.

A future headless or remote-admin approval mechanism requires its own explicit threat model and re-authentication/operator-presence design; it is not inherited from ordinary device auth, shell access, server master password, or paired OFXP trust.

Do not expose approval through an unauthenticated LAN route.

---

## 16. UX plan

### 16.1 Device B onboarding

When OFXP finds an existing trusted/nearby OpenFork installation:

```text
Set up this OpenFork

Nearby
  Jackson's Desktop
  [Set up from this device]
```

If not yet paired, this enters the existing OFXP pairing ceremony.

### 16.2 Existing pairing remains visually recognizable

Do not hide the SAS security step merely because account migration is convenient.

After pairing:

```text
Connected to Jackson's Desktop

Request account setup?
[Request accounts]
```

### 16.3 Device A approval

```text
Laptop B wants account setup
Paired identity: Laptop B · <short fingerprint>

[Select all eligible]

OpenCode Go
  [ ] Migrated key
  [ ] key2

Anthropic
  [ ] Personal OAuth     Re-login required on the new device

Verdent
  [ ] Managed by Verdent desktop — cannot be transferred

[Transfer selected accounts]
```

The peer request itself must never preselect accounts. Initial selections are empty unless A's local operator explicitly chose an equivalent "transfer all eligible" action in the same source-controlled setup flow. Show the paired device identity/fingerprint context near the confirmation so the label alone is not the security cue.

Use plain-language policy labels:

- "Can transfer";
- "Will create a separate device credential";
- "Sign in again";
- "Managed externally".

Do not expose protocol jargon such as HPKE, grant revision, or authority epoch in
ordinary UI.

### 16.4 Completion / non-success outcomes

Render “complete” only from proven recipient receipt state, never merely because A emitted a fetch response.

Fully proven example on B:

```text
Account setup complete

2 accounts imported
1 account requires sign-in
```

Fully proven example on A **only after A accepts the exact receipt**:

```text
Laptop B confirmed 2 accounts imported
```

Other required states:

- **Changed since review** — source credential revision/policy changed after the checklist/native review. Nothing is transferred under the stale approval; reopen review.
- **Unsupported / sign in again** — adapter/provider is not clone/reissue-safe.
- **Managed externally** — destination/source is externally owned and transfer did not mutate it.
- **Transfer interrupted** — source restarted/disabled before settlement; no retry under the old approval.
- **Import partially completed** — some owner-native commits are proven and some failed.
- **Import outcome uncertain** — at least one owner commit cannot yet be proven; do not offer blind “retry all.”
- **Receipt unavailable after trust change** — A may know an attempt was admitted but cannot accept a later receipt after revocation/rekey/disable; copy may already exist on B.
- **Failed before import** — protocol/schema/policy preflight failed with zero destination credential mutation.

A's UI may say “transfer attempt sent” or “waiting for Laptop B confirmation” after disclosure, but it must not say “transferred/imported successfully” until a validated receipt proves that result. B's UI is authoritative only for outcomes its credential owners can prove; an `ambiguous` owner result remains visibly ambiguous.

The UI should state that removing/revoking the OFXP peer later does not revoke already-copied provider credentials.

---

## 17. Secret-handling implementation rules

### 17.1 Minimize plaintext lifetime

- materialize only after final authorization revalidation;
- export one bounded batch;
- do not persist staging plaintext;
- do not stringify through generic debug helpers;
- release references after encryption/import;
- avoid unnecessary copies of large secret buffers.

JavaScript cannot guarantee deterministic memory zeroization, so documentation
must not claim it does. Use buffers/isolated scopes where practical and minimize
lifetime.

### 17.2 Payload limits

Set conservative **hard v1 ceilings**, not “tiny in practice” assumptions. These are security/resource limits; implementation may choose smaller local UX limits but may not accept larger wire/state values without a protocol-plan review:

- unapproved pending requests: **4 per authenticated peer, 32 process-global**;
- inbound `credential.transfer.request` calls: **8 attempts per authenticated peer per 60 seconds, 64 process-global per 60 seconds**; identical duplicates still consume rate budget even though they do not extend TTL or create another notification;
- all credential-transfer control calls combined: **120 per authenticated peer per 60 seconds, 1024 process-global per 60 seconds**, in addition to method-specific disclosure/receipt rules. The limiter is process-local, bounded, keyed by authenticated peer ID (not body-supplied identity), and may fail more conservatively under pressure; rate-limit state is not authority and need not survive restart;
- recipient status polling while the setup UI is actively waiting: **no faster than 1 Hz per live ceremony**, with stop-on-terminal/disconnect semantics; ordinary UI must prefer event-driven local state where available rather than create per-row pollers;
- durable non-terminal source authorizations: **4 per recipient peer, 32 process-global**; when full, new approval fails closed without evicting an existing authorization;
- request TTL on A: **5 minutes** from A's local `receivedAt`; duplicate requests never extend it;
- approved disclosure-admission TTL: **5 minutes** from source approval;
- max secret-bearing fetch admissions: **3 total** (initial attempt + at most 2 same-runtime retries);
- max one secret-bearing fetch in flight for a given `transferID`; concurrent duplicate fetches receive `busy`/safe retry status rather than causing parallel secret reads;
- per-attempt **explicit transfer application deadline: 30 seconds**. The live OFXP transport also configures a 30-second socket idle timeout, but that is not a request-deadline guarantee and must not be reused as the credential-transfer timer. Transfer code owns an explicit abort/deadline that bounds export/encryption/write handling independently of socket idleness;
- max **64 items** per transfer;
- canonical secret-free manifest: max **64 KiB** encoded;
- portable metadata: max **4 KiB encoded per item**, schema-specific, max nesting depth **8**, with no arbitrary recursive `Json` acceptance;
- individual decoded string field: max **4 KiB UTF-8**, while human labels/account hints are capped more tightly at **256 UTF-8 bytes**;
- inner encoded item: max **64 KiB** before encryption;
- entire protected plaintext: max **512 KiB**; ciphertext/framing overhead has a separately bounded small allowance fixed with Gate A's concrete library/profile;
- entire request/info/status/receipt control message: max **64 KiB**, with request bodies expected to be far smaller;
- detailed receipt/transfer retention: **30 days** after terminal state;
- replay tombstone retention: **365 days**, subject to the fail-closed 4096-row installation ceiling in section 13.3.

Oversize is rejected **before allocation/copy where the outer length makes that possible** and otherwise at the earliest decoder boundary. Size/depth checks happen before adapter dispatch. No implementation may silently truncate a secret-bearing payload to make it fit.

These values are intentionally generous for credentials while still small enough to make memory/CPU abuse boring. Benchmarking before v1 freeze may justify lowering them; raising them requires explicit review because it changes DoS and plaintext-exposure bounds.

### 17.3 No secret-bearing generic `unknown` dumps

Decode protected payload using strict schemas with excess-property rejection.

A malformed remote item must not turn into arbitrary local credential-store JSON.

### 17.4 Safe transport/error projection

The live `packages/opencode/src/ofxp/transport.ts` currently projects an application failure back to the peer using `error.message` (bounded to 1024 characters). That is acceptable for ordinary OFXP operations only when upstream errors are already safe; it is **not** a safe default for a secret-bearing path because a validator, provider adapter, or owner error could accidentally embed credential material.

Credential-transfer handlers therefore need a hard error-sanitization boundary:

- catch **all** errors after secret materialization/decryption and before they reach generic transport projection;
- map them to a closed set of stable wire reason codes plus non-sensitive bounded detail generated by the transfer service itself;
- never forward arbitrary `Error.message`, schema diagnostic dumps, provider response bodies, request bodies, or adapter exception strings to the peer;
- ensure `options.onError`, structured logging, tracing, and crash reporting receive only the sanitized error once secret-bearing processing has begun;
- where the transport needs richer semantics, add a dedicated safe structured peer-error type rather than teaching generic transport to serialize arbitrary exception objects;
- fuzz/test thrown exceptions whose message/cause contains sentinel secrets and prove no peer response or local telemetry contains the sentinel.

For the TLS-only profile, this boundary is mandatory before any plaintext body enters application dispatch. For HPKE, it still matters after decryption on B and while A materializes/encrypts source secrets.

### 17.5 Destination at-rest parity

Credential transfer must never create a weaker transfer-specific storage path.

- import through the same authoritative owner/storage boundary used by ordinary local authentication;
- do not create a second plaintext transfer cache, backup file, or transfer vault;
- if the normal owner uses OS secure storage, transfer must use it too and fail closed when that owner would fail;
- if an existing owner currently stores a credential under the local OS-account/file/SQLite boundary, transfer may use that owner but must document that the feature does not upgrade its at-rest security;
- secure-vault convergence for legacy owners is valuable follow-up work, but transfer code must not invent a parallel secret store as a shortcut.

### 17.6 Redaction tests are mandatory

Tests should inject sentinel secrets and prove they never occur in:

- logs;
- error messages;
- trace output;
- receipt rows;
- local settings projections;
- OFXP activity UI;
- serialized transfer authorization state.

---

## 18. Revocation semantics

Three different actions must remain distinguishable.

### 18.1 Cancel transfer

Cancellation that wins before the disclosure linearization point prevents delivery. Cancellation after that point prevents future retries but cannot guarantee that already-emitted bytes did not reach B.

### 18.2 Revoke OFXP peer

Stops future OFXP trust/authority.

It must also invalidate all non-settled transfer authorizations for that peer and prevent further retries/status-driven redelivery. A revoke racing after the disclosure linearization point is not retroactive; any already-authorized in-flight write is aborted best-effort only.

It does not revoke already copied upstream credentials.

### 18.3 Revoke provider credential

Provider-specific action outside OFXP trust.

Future account-management UX may help the user rotate/revoke a credential, but that is not equivalent to unpairing a machine.

### 18.4 Disable OFXP

Explicitly disabling OpenFork Network / OFXP is stronger than an ordinary process restart.

The disable transition should:

1. atomically prevent any new credential-transfer disclosure admission;
2. clear memory-only unapproved requests;
3. transition all non-settled source transfer authorizations to a terminal cancelled/disabled state so re-enable cannot resurrect them;
4. stop/abort transfer network work best-effort;
5. retain non-secret receipts/tombstones required for reconciliation/replay defense;
6. leave already-imported local provider credentials untouched.

As with peer revocation, an in-flight disclosure that already crossed the relevant admission fence cannot be truthfully claimed to be unsent.

Disable precedence must be explicit:

| Race | If disable commits first | If the competing fence/commit wins first |
| --- | --- | --- |
| inbound request creation | reject/forget request | request may exist briefly, then disable clears it; no authority exists |
| operator approval | approval fails | newly committed non-settled authorization is immediately terminalized by disable before any later disclosure admission |
| first disclosure/retry admission | zero secret read | admitted attempt may finish bounded encryption/write best-effort; no later retry |
| recipient import admission on B | decrypted/plaintext payload is discarded without credential mutation | owner transactions already admitted may commit; later work stops where safe and result is partial/ambiguous if necessary |
| receipt submission/reconciliation | no new network receipt accepted while disabled | a receipt already durably accepted remains valid non-secret history |
| re-enable | creates no authority | terminal `disabled`/cancelled/interrupted transfers stay terminal; user starts a fresh request/approval |

The source disable transition and source disclosure admission must therefore synchronize through the same process-global transfer owner/admission discipline; a mere asynchronous “close sockets” callback is insufficient. On B, the local import-admission fence plays the analogous role.

Repository reality matters here: current OFXP `setEnabled(false)` persists `ofxp.enabled=false` through global config and then tears down the runtime; that preference is not the same SQLite transaction domain as future transfer rows. Do **not** claim cross-store ACID.

For credential-transfer v1, define one in-process **disable linearization point** owned by the Tier-0 transfer/runtime composition:

1. acquire the same exclusive admission gate used to enter source disclosure/retry fences;
2. mark transfer admission closed in process memory **before releasing that gate**;
3. while admission remains closed, clear pending memory requests and terminalize all durable non-settled source authorizations to `disabled` using the transfer store's immediate-writer transaction;
4. persist/confirm the ordinary OFXP disabled preference and converge listener/connection teardown;
5. release/retire runtime resources only after no new transfer admission can enter.

If failure occurs after step 2, fail closed: do not reopen transfer admission merely because config persistence or socket teardown failed. Existing admitted I/O retains the already-documented best-effort abort semantics. If the ordinary runtime later reports a disable failure and remains enabled, old transfer authorizations still stay terminal; the user must create fresh approvals.

Crash recovery closes the cross-store gap. Before any transfer methods become reachable, startup reads ordinary OFXP enablement and transfer state. If OFXP is disabled, any leftover non-settled authorization is terminalized as `disabled`; if OFXP is enabled after a process restart, leftover `approved|delivering` rows become `interrupted` under the restart law. Re-enable never changes either terminal state back to live authority.

This is atomic with respect to **admission ordering**, not a false claim that global config and SQLite commit together.

---

## 19. Rekey semantics

A pending transfer is identity-generation-specific.

If recipient B rotates its OFXP identity:

- old pending transfer is invalid;
- continuity proof does not silently retarget the transfer;
- complete/confirm the re-key ceremony;
- create a new transfer authorization for the replacement identity.

This keeps "who receives the secret" explicit.

---

## 20. Performance architecture

Credential transfer is rare and security-sensitive, but it should still respect
OpenFork performance laws.

### 20.1 Tier 0 ownership

Everything needed for peer trust, candidate metadata, and transfer state is Tier 0/process-global and must not materialize a workspace instance. Persistence follows semantics rather than convenience:

- unapproved peer requests are bounded ephemeral process state;
- approved transfer authorizations/manifests and recipient receipts are durable;
- credential metadata comes from compact owner projections, not Session/provider history.

### 20.2 Candidate projection

Build candidate metadata at the credential owners, not by scanning provider/model
UI state.

The settings UI receives a compact projection.

### 20.3 No polling explosion

Use one process-level event/projection path for transfer state changes.

Do not create:

- one timer per credential;
- one remote request per list row;
- provider catalog hydration merely to label a credential.

### 20.4 Crypto cost

Credential payloads are tiny. Optimize for:

1. correctness;
2. minimal plaintext exposure;
3. bounded allocation;
4. simple audited primitives;

not throughput tricks.

---

## 21. Security event/audit model

Log safe semantic events such as:

```text
credential_transfer.requested
credential_transfer.approved
credential_transfer.cancelled
credential_transfer.delivery_started
credential_transfer.committed
credential_transfer.partial
credential_transfer.failed
credential_transfer.expired
credential_transfer.rejected_stale_trust
credential_transfer.replayed
```

Safe fields:

- transfer ID;
- source/recipient peer ID;
- count;
- safe owner/provider category;
- state;
- reason code;
- timestamps;
- manifest digest.

Unsafe fields:

- raw secret;
- access/refresh token;
- full authorization header;
- private transfer key;
- decrypted item payload;
- unnecessary account PII.

OWASP logging guidance explicitly recommends excluding access tokens,
authentication passwords, encryption keys, and primary secrets from logs.

---

## 22. Protocol/provider standards guidance

Implementation decisions should be checked against current standards, especially:

### RFC 8446 — TLS 1.3

OFXP's authenticated transport remains the baseline confidentiality/integrity
boundary.

https://www.rfc-editor.org/rfc/rfc8446.html

### RFC 9180 — HPKE

Preferred standard if an audited application-envelope implementation is adopted.

https://www.rfc-editor.org/rfc/rfc9180.html

### RFC 9700 — OAuth 2.0 Security Best Current Practice

Important constraints:

- sender-constrain bearer credentials where possible;
- public-client refresh tokens require sender constraint or rotation;
- minimize token privilege;
- treat tokens as sensitive secrets.

https://www.rfc-editor.org/rfc/rfc9700.html

### RFC 9449 — OAuth DPoP

Demonstrates why some tokens are cryptographically tied to a client key and
cannot be safely cloned as opaque strings.

https://www.rfc-editor.org/rfc/rfc9449.html

### RFC 8693 — OAuth Token Exchange

A possible provider-specific future primitive for reissue/delegation where the
provider actually supports it. It is not something OFXP can emulate locally.

https://www.rfc-editor.org/rfc/rfc8693.html

### OWASP Logging Cheat Sheet

Secret transfer events should be auditable while token/key material remains
excluded from logs.

https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html

### OWASP Secrets Management Cheat Sheet

Useful lifecycle guidance: least privilege, rotation/revocation, bounded secret
exposure, and never logging plaintext secrets.

https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html

---

## 23. Required negative invariants

Tests must prove not merely that transfer succeeds, but that unsafe architecture
does **not** appear.

At minimum:

1. pairing alone cannot export a credential;
2. deny-by-default peer trust is sufficient to make a bounded setup request but never for secret delivery without one-shot authorization;
3. model-facing OFXP capability dispatch cannot call transfer approval/export or enumerate transfer candidates;
4. ordinary paired-device/PWA bearer auth cannot enumerate source credential candidates or approve/export;
5. untrusted discovery candidate cannot request transfer;
6. revoked peer cannot request or receive transfer;
7. rekey-required peer cannot receive transfer;
8. stale pre-revoke authorization cannot become valid after same-key re-pair;
9. revoke/cancel winning before the disclosure linearization point yields zero secret export;
10. a revoke racing after linearization prevents retries but is not falsely reported as retroactive erasure;
11. different peer using a captured request/transfer ID cannot receive payload or query its receipt;
12. same request ID with mutated recipient context is rejected;
13. replayed delivery cannot duplicate imported credentials;
14. different manifest/recipient context under the same transfer ID is rejected;
15. detailed receipt GC does not remove the replay tombstone inside the retry/security horizon;
16. under HPKE, recipient restart losing the ephemeral private key fails closed;
17. source restart never leaves plaintext staging material on disk and can recover only the exact secret-free approved manifest;
18. candidate-list rendering does not call an owner path that materializes every raw key/token;
19. malformed/deep/oversized protected payload cannot write arbitrary auth/config JSON;
20. protected-payload validation errors cannot echo secret-bearing input;
21. arbitrary remote provider metadata/URLs are not blindly persisted;
22. environment/external credentials are not exported by generic fallback;
23. destination environment-managed auth is not silently shadow-written and reported active;
24. unsupported OAuth is not silently cloned;
25. current `Credential` import does not call destructive `create` for ordinary transfer;
26. fork multi-key import does not bypass its legacy migration/initialization semantics;
27. destination-store failure cannot be reported as success;
28. lost acknowledgement reconciles via receipt instead of blind semantic replay;
29. a protocol-v1 peer that lacks credential transfer fails the probe cleanly without Hello decode failure;
30. a transfer-protocol/profile mismatch is rejected; v1 has no per-transfer protection downgrade path;
31. secret sentinel never appears in logs/receipts/errors/settings projection;
32. transfer routes create zero workspace instances;
33. explicit OFXP disable clears pending requests, kills non-settled transfer authority, and does not delete already-imported local credentials;
34. crash after an owner commits an import but before generic receipt persistence cannot create a duplicate on retry; the owner reconciles or returns `ambiguous`;
35. arbitrary adapter/schema/provider exceptions containing a sentinel secret never cross the safe transport-error boundary or reach `onError`/logs;
36. source credential or exported portable-metadata mutation after approval changes the owner revision and aborts export until fresh approval;
37. a trusted Electron renderer cannot bypass main-process/native confirmation and directly mint transfer approval;
38. peer requests cannot auto-open modal/native confirmation UI or extend their TTL by replay;
39. destination policy is independently enforced; a malicious source cannot make an unsupported import valid by declaring `clone`/`reissue`;
40. transfer does not migrate usage attribution, quota/capacity history, cooldowns, or routing caches;
41. LAN/private-address/mDNS locality never substitutes for cryptographic peer trust or one-shot authority;
42. forgetting an **unapproved** memory-only request across source restart cannot create disclosure authority; a later same-ID request is treated only as a fresh zero-authority request unless that ID already maps to a durable approved transfer;
43. connection replacement/reconnect never changes recipient ownership; same identity/generation may continue a live request, different fingerprint/generation cannot;
44. adapter-version or policy-revision change after review/approval fails `policy_changed` and requires fresh approval;
45. concurrent fetches for one transfer cannot cause parallel secret snapshots; at most one is admitted in flight and the bounded attempt counter cannot be raced past its limit;
46. startup recovery completes `approved|delivering -> interrupted` before credential-transfer methods become reachable; an early packet cannot race startup into disclosure;
47. a receipt from the wrong peer, wrong manifest/item set, stale revision, conflicting same revision, or after trust revocation/rekey/disable cannot settle the source;
48. malformed outer envelope is rejected pre-decryption where possible; malformed authenticated inner payload fails the whole attempt with zero credential mutations;
49. an HPKE retry uses a fresh sender setup/encapsulation/AEAD context and never reuses sender nonce/sequence/ciphertext state;
50. no renderer IPC accepts arbitrary sidecar commands, raw transfer manifests, `approved=true`, or an arbitrary destination peer; only the typed review/native-confirm path exists;
51. the Fork owner initialization barrier cannot expose a half-completed legacy migration to candidate listing/export/import under concurrency, and origin-blind legacy migration cannot turn `OPENCODE_AUTH_CONTENT` into a transferable locally owned key;
52. reaching the replay-tombstone capacity before normal GC fails new approvals closed instead of evicting unexpired replay protection;
53. source credential mutation **after** a matching owner snapshot is represented honestly: the already-admitted captured snapshot may finish, but every later retry observes the new revision and fails;
54. source authorization state and recipient result state cannot be conflated: `delivering` alone is never rendered/audited as successful import; `partial`/`failed`/`ambiguous` receipt snapshots do not automatically produce `settled`; `settled` requires every selected item to be durably `imported`/`already_present`;
55. two different trusted peers may independently choose the same recipient-created `requestID` without aliasing request state; every lookup/dedup/approval maps `(authenticated recipientPeerID, requestID)`, never bare request ID;
56. a stale native review carrying an old `requestInstanceID` cannot approve a new pending incarnation created after source/sidecar restart, expiry, cancellation, or memory loss even if B reused the same request ID;
57. crash after durable approval insertion but before pending-memory deletion cannot create a second transfer: the durable peer+request mapping wins and duplicate request/approval resolves only to that exact transfer;
58. on the recipient, all generic journal/dedup lookup is keyed by `(authenticated sourcePeerID, transferID)`; two sources choosing the same transfer ID cannot alias receipts, idempotency markers, status, or imported-result state.

---

## 24. Adversarial test matrix

### 24.1 Pairing/trust/authorization races

- revoke immediately before approval;
- revoke after approval but before the atomic delivery fence;
- revoke immediately after the fence while the socket write is beginning;
- cancel vs delivery-admission transaction;
- re-pair same key after revoke;
- identity re-key between request and delivery;
- cross-process authority mutation;
- stale settings page submits approval;
- ordinary device-token or renderer-known sidecar-password caller attempts candidate list/approval over HTTP;
- CSRF-style browser request attempts the deliberately nonexistent v1 candidate/approval HTTP surface;
- compromised/trusted renderer invokes an approval IPC without native confirmation or attempts to pass an arbitrary sidecar command/raw manifest;
- renderer supplies misleading peer/account display strings while main resolves authoritative confirmation content;
- native dialog remains open while peer trust generation, candidate revision, or policy revision changes, then stale confirmation is submitted;
- repeated peer requests attempt to auto-open/spam native confirmation or extend request TTL;
- source startup receives a transfer request/fetch while recovery is converting persisted authorizations to `interrupted`;
- disable races request creation, approval, first disclosure admission, retry admission, recipient import admission, and receipt handling;
- two concurrent fetches race the same `transferID` and attempt budget.

Expected: operations that win before the relevant source/recipient admission fence yield zero corresponding mutation; post-fence races stop future work and are represented honestly. HTTP/CSRF/device-token paths never reach sensitive review/approval, stale native review fails closed, startup cannot disclose before recovery, and only one fetch per transfer is in flight.

### 24.2 Network/replay/versioning

- duplicate identical request;
- same request ID with different recipient context;
- source restart forgets an unapproved request, then receives the same ID again: it remains zero-authority, gets a fresh source-local `requestInstanceID`, and cannot collide with any durable approved mapping;
- an old native confirmation/review created before that restart is submitted against the newly recreated same-ID pending request and must fail the `requestInstanceID` fence;
- two different trusted peers intentionally submit the same `requestID`; pending/durable state remains isolated by authenticated peer ID and one peer cannot query/cancel/approve/fetch the other's object;
- approval commits durably, then the source crashes before pending-memory cleanup; the retried request/local approval resolves to the exact existing transfer rather than creating a second authorization;
- stale status/approval response arrives after B replaced or restarted its current request;
- same live request reconnects over a replacement TLS connection with same peer identity/generation;
- connection replacement presents a different fingerprint or rekey generation;
- duplicate delivery;
- delayed delivery after expiry;
- captured delivery/status request to another peer;
- altered protected payload/ciphertext;
- altered manifest digest;
- mutated fixed-v1 recipient context;
- HPKE retry attempts sender-context/encapsulation/nonce reuse;
- lost response after commit;
- reconnect during status reconciliation;
- forged receipt from another trusted peer;
- same `receiptRevision` with different receipt digest;
- lower/stale receipt revision after a newer one;
- higher receipt revision with an illegal terminal-item rollback;
- receipt arrives after recipient trust revocation/rekey/OFXP disable;
- detailed receipt expired but replay tombstone retained;
- tombstone store reaches the hard cap before any row is retention-expired;
- old v1 peer with no transfer support;
- malformed `credential.transfer.info` response;
- per-connection support cache survives a reconnect/rekey when it should have been invalidated;
- peer advertises an incompatible transfer-protocol version/profile and attempts fallback;
- peer advertises support, then later fails a transfer method and attempts to trigger weaker-profile retry.

Expected: no duplicate import, no cross-peer disclosure, no stale-current-request acceptance, no receipt rollback/forgery, no cryptographic state reuse, no silent protocol/profile fallback, clean mixed-version failure, and fail-closed replay retention under capacity pressure.

### 24.3 Credential-policy / malicious payload

- API key clone;
- unsupported OAuth;
- sender-bound OAuth fixture;
- rotating refresh-token fixture;
- environment-sourced auth;
- externally managed keychain auth;
- destination `OPENCODE_AUTH_CONTENT` override;
- plugin with no transfer adapter;
- unknown metadata keys;
- hostile/control-character label;
- arbitrary URL/enterprise endpoint injection;
- deeply nested/oversized metadata;
- decoder failure containing a sentinel secret;
- adapter/provider exception whose message/cause contains a sentinel secret;
- duplicate/missing/substituted item IDs versus the approved manifest;
- duplicate source ref selected twice in one manifest;
- locale-sensitive/different item ordering produces the same semantic manifest but must canonicalize byte-identically;
- adapter version or source policy revision changes after native review;
- malformed outer envelope with unknown fields/oversized declared length;
- authenticated/decrypted inner envelope with unknown fields, duplicate items, excessive nesting, or manifest mismatch;
- source declares `clone` for a destination adapter that locally marks the kind unsupported;
- payload asks for compression or an unknown encoding/profile.

Expected: only mutually/locally supported policies import, decrypted remote data cannot escape its adapter's portable schema, canonicalization is deterministic/non-locale-sensitive, malformed protocol payloads fail before any credential mutation, and no secret-bearing exception text escapes.

### 24.4 Destination conflicts

- empty destination;
- exact account already present;
- same label, different account;
- same provider account, different secret;
- existing local active account;
- imported source-active account;
- partial multi-owner failure;
- process crash immediately after owner credential commit but before generic receipt write;
- retry after the crash above;
- owner that cannot atomically mark/reconcile an import.

Expected: deterministic non-destructive behavior; committed items reconcile to the same local credential, and unprovable commit state becomes `ambiguous` rather than being replayed.

### 24.5 Secret leakage

Use high-entropy sentinel values and inspect:

- stdout/stderr;
- application logs;
- DB transfer tables;
- OFXP receipts;
- exception snapshots;
- HTTP/OpenAPI error bodies;
- UI serialized state;
- activity history.

Expected: zero plaintext sentinel matches outside the authoritative destination
credential store and deliberately scoped in-memory test hook.

### 24.6 Resource abuse

- many pending requests from one trusted peer;
- many trusted peers;
- maximum-size envelope;
- oversized item;
- deeply malformed protected JSON;
- slow recipient;
- disconnect storm.

Expected: bounded memory/state, rate limiting, no workspace bootstrap.

---

## 25. Implementation phases

### Phase 0 — design gates

**Current audit verdict: NOT AUTHORIZED FOR IMPLEMENTATION.** The plan now resolves most state-machine/security semantics, but that is not the same thing as the live repository satisfying them. Gate A (the single concrete v1 crypto profile/dependency) remains an architectural ship/no-ship decision, Gate E still needs the explicit first-provider policy decision/evidence, and several repository implementation proofs intentionally remain absent because this handoff authorizes plan audit only.

Phase-0 exit matrix:

| Required gate | Plan status after hostile audit | Repository status / remaining proof |
| --- | --- | --- |
| 1. sensitive operator authorization | **architecture resolved** | desktop must implement/verify typed main -> utility-process review/approval path; ordinary HTTP/device auth must fail |
| 2. exact request + transfer state machines | **resolved** | tests not implemented/run |
| 3. durable secret-free state | **resolved** | schema not implemented |
| 4. trust-generation/rekey invalidation | **architecture resolved** | live peer schema has only broader `authority_epoch`; dedicated `trust_generation` absent |
| 5. disclosure/retry linearization | **resolved** | atomic transfer-owner API absent |
| 6. first-adapter source revision + atomic export | **architecture resolved in §9.1** | live fork owner has no revision/atomic transfer snapshot APIs |
| 7. fixed cryptographic profile | **UNRESOLVED — Gate A** | no implementation authorized |
| 8. mixed-version negotiation/downgrade | **resolved** | current client still hard-requires `capabilityExchange`; base negotiation split absent |
| 9. dispatcher + connection lifecycle ownership | **resolved** | runtime still routes application methods directly to `OfxpCapability.dispatch` |
| 10. candidate-listing secrecy | **resolved** | fork/current Credential metadata-only projections absent; existing list/all APIs materialize secrets |
| 11. recipient schema/resource limits | **resolved** | strict transfer schemas/tests absent |
| 12. destination idempotency/reconciliation | **architecture resolved for first adapter** | owner-native import marker/transaction absent |
| 13. restart/disable/revoke/cancel | **resolved** | recovery/disable atomic owner implementation absent |
| 14. receipt authenticity/replay | **resolved for live-TLS v1 receipts** | receipt journal/transition validation absent |
| 15. partial/ambiguous outcomes | **resolved** | owner reconciliation implementations absent |
| 16. bounded memory/time/retry/retention | **resolved in §§13.3/17.2** | enforcement absent |
| 17. negative/adversarial tests | **specified** | not implemented/run |
| 18. verified facts vs proposed architecture | **resolved editorially** | maintain this distinction during implementation review |

Do not interpret “architecture resolved” as permission to skip the corresponding implementation proof. Conversely, do not keep reopening a resolved architecture question merely because its code does not exist yet; implementation work belongs to later phases after the genuinely unresolved design gates are closed.

Do not write the secret-delivery path until these are resolved/proven as appropriate:

- [ ] choose and freeze the **single** transfer-protocol-v1 protection profile: audited HPKE profile preferred, or an explicit TLS-only v1 ship/no-ship decision;
- [ ] define separate `CredentialTransferRequestID` / source-minted `CredentialTransferID` and strict wire schemas;
- [ ] define canonical manifest encoding/digest contract using an existing tested canonicalization primitive where suitable;
- [ ] add the dedicated durable OFXP peer `trust_generation` and define its trust-lifecycle mutation/fencing semantics;
- [ ] define the atomic disclosure-linearization API against `trust_generation`;
- [ ] define purpose-built sensitive-operator authorization that rejects ordinary device/PWA bearer tokens and the desktop main/native-confirmation path;
- [ ] split base OFXP connection negotiation from capability-specific `capabilityExchange` assertions so control protocols do not depend on the augmentation plane;
- [ ] define a top-level OFXP application/control dispatcher so transfer methods do not live inside `OfxpCapability.dispatch`;
- [ ] prototype/freeze the `SecretBytes`-style non-serializing/redacted in-memory boundary;
- [ ] define the closed safe wire-error/reason-code boundary before any real secret path exists;
- [ ] define bounded source authorization + recipient receipt/tombstone storage;
- [ ] define metadata-only candidate projections and adapter interface including owner-native import reconciliation;
- [ ] define per-adapter crash-idempotency proof requirements;
- [ ] prove model-facing OFXP tool cannot reach operator transfer methods.

### Phase 1 — metadata/control skeleton, no secrets

Implement:

- transfer request;
- bounded memory-only source pending request projection;
- secret-free `credential.transfer.info` mixed-version probe;
- candidate adapter registry + metadata-only owner projections;
- sensitive-operator approve/cancel;
- durable approved manifest/fixed recipient-context state;
- local-clock expiry;
- trust-generation invalidation + atomic disclosure fence;
- safe audit events.

Use fake/no-secret fixtures only.

Exit:

- security state machine tests green;
- generic device/PWA auth cannot enumerate candidates or approve transfer;
- mixed-version old peer fails the transfer probe cleanly without Hello failure;
- zero workspace bootstrap;
- no model path to approval.

### Phase 2 — OpenCode Go/fork key adapter

Implement the motivating case against
`packages/opencode/src/fork/credentials.ts`.

Requirements:

- add/consume a metadata-only candidate projection so settings rendering does not read every key;
- expose a stable non-secret source revision/generation for each candidate and re-check it immediately before secret export;
- force owner-native **provenance-aware** legacy migration/initialization before candidate/export/conflict decisions; `OPENCODE_AUTH_CONTENT` and historical `legacy_unknown` rows remain non-exportable unless separately adopted/re-added through an explicit local owner action;
- export only selected key(s) through a just-in-time owner API after delivery admission;
- no direct SQL copying in OFXP;
- add an owner-level **batch import** API rather than looping generic `add()` calls from OFXP; the owner should own one transaction for local ID creation, label handling, active-selection semantics, and any migration invariants;
- make that batch import crash-idempotent using an opaque per-item import key derived from `(sourcePeerID, transferID, itemID)` and persisted atomically with the inserted credential (for example via an owner-owned import-marker table/constraint); retries resolve to the original local credential instead of creating a duplicate;
- destination creates new local credential IDs; source IDs remain local refs only;
- safe label merge;
- active-selection rules;
- do not transfer message attribution, usage/capacity history, quota caches, cooldowns, or routing history;
- idempotent non-destructive import.

Exit:

- Device A -> Device B test imports selected keys;
- duplicate delivery creates no duplicates;
- crash after credential insertion but before generic receipt persistence reconciles to the same local credential;
- source key replacement/revision change after approval aborts export and requires fresh approval;
- candidate listing proves no raw key materialization and never classifies active `OPENCODE_AUTH_CONTENT` or unreconciled `legacy_unknown` rows as transferable;
- no usage/history/cache rows are migrated;
- source remains unchanged.

### Phase 3 — protected delivery

Add the Gate-A-frozen transfer-protocol-v1 protection profile.

Exit:

- tamper rejection;
- recipient binding;
- manifest/AAD binding;
- no plaintext secret in generic OFXP frame tracing;
- arbitrary secret-bearing adapter/schema exceptions are reduced to closed safe reason codes before peer response/logging;
- recipient crash/import ambiguity is reconciled owner-natively rather than blindly replayed;
- restart/expiry behavior proven.

### Phase 4 — legacy/current API-key adapters

Add:

- legacy Auth API;
- current `Credential.Key`;

through authoritative services only.

Do not enable OAuth generically.

### Phase 5 — premium setup UX

Wire:

- "Set up from another OpenFork";
- existing OFXP pair flow;
- post-pair setup request;
- source account-selection UI;
- transfer progress;
- partial/imported/re-login-required result.

New York dense UI should reuse the existing OpenFork Network settings vocabulary
and pairing components rather than create a separate account-migration visual
system.

### Phase 6 — provider-specific reissue/OAuth adapters

One provider at a time.

Each adapter requires evidence for:

- token binding;
- refresh rotation;
- upstream client semantics;
- revocation;
- multi-device support;
- whether cloning or reissue is valid.

### Phase 7 — storage hardening convergence

Separately evaluate whether legacy plaintext-at-rest credential owners should
converge on a process-global secure credential-vault abstraction.

Do **not** block the transfer protocol design on an unbounded credential-storage
rewrite, but do not pretend transfer is more secure at rest than the destination's
authoritative credential owner.

---

## 26. Likely code ownership

Exact files should be re-derived from the live tree before implementation.

Likely domains:

### Schema

`packages/schema/src/ofxp.ts` or a dedicated credential-transfer schema module:

- request ID + transfer ID;
- secret-free wire/control contracts;
- safe status/receipt projections;
- v1-compatible transfer descriptor/probe contracts; do not add an incompatible field to strict v1 Hello.

Do not place runtime crypto or secret-store behavior in Schema.

### Core

New protocol-neutral owner, likely under:

`packages/core/src/ofxp-credential-transfer/`

Responsibilities:

- transfer authorization state;
- trust generation fencing;
- adapter registry contract;
- source/recipient state machine;
- receipt semantics;
- durable rows/migrations.

This should remain independent of V1-specific auth implementation details.

### V1/OpenFork runtime

`packages/opencode/src/ofxp/`

Narrow adapters for:

- live OFXP transport;
- base protocol negotiation shared independently of capability-specific checks;
- top-level application/control dispatch routing transfer methods outside `OfxpCapability`;
- if Gate A selects TLS-only for v1, a specially classified sensitive delivery path that never falls back from a stronger profile at runtime;
- legacy/fork credential owners;
- local sensitive-operator control API;
- runtime event/cache refresh;
- `SURFACE_DESCRIPTOR`/fingerprint updates that reflect the executable surface without breaking strict v1 Hello.

Preserve V1 as the production path; do not migrate auth merely to follow current
APIs.

### App

`packages/app/src/components/settings-v2/`

Reuse:

- OFXP Network settings;
- existing pairing dialog/state;
- current credential/account selectors where semantically correct.

UI consumes compact Tier-0 projections.

---

## 27. Acceptance criteria for first production release

The feature is not production-ready until all are true:

### Security

- [ ] only explicitly paired/currently trusted recipient peer can participate;
- [ ] explicit sensitive-operator action approves every transfer;
- [ ] desktop approval requires trusted renderer initiation **and** main-process/native authoritative confirmation; renderer-only invocation cannot approve;
- [ ] v1 source approval is desktop-native only; no headless/CLI/process-accessible approval path exists;
- [ ] ordinary paired-device/PWA bearer auth cannot enumerate candidate accounts or approve/export;
- [ ] approval is exact-recipient + exact-manifest + exact fixed-v1 recipient-context + short-lived + one-shot;
- [ ] disclosure has an atomic documented linearization point;
- [ ] authorization is fenced to dedicated `trust_generation`, not ordinary grant/root `authority_epoch` changes;
- [ ] trust mutation invalidates pre-linearization/pending transfer and blocks later retries;
- [ ] model-facing agents cannot request approval/export or discover transfer as a capability;
- [ ] decrypted payload is strictly validated as untrusted input and destination policy is independently enforced;
- [ ] transfer secrets never enter logs/receipts/settings projection or generic error propagation;
- [ ] secret-bearing exceptions are sanitized to closed reason codes before peer response/`onError`/logging/tracing;
- [ ] exactly one protection profile is frozen per transfer-protocol version; no custom unaudited bulk crypto construction and no silent protocol/profile fallback;
- [ ] replay/idempotency/tombstone tests green;
- [ ] external/unsupported credentials fail closed.

### Correctness

- [ ] OpenCode Go/fork multi-key account transfer works end-to-end;
- [ ] source candidate listing does not materialize every key;
- [ ] every shipping source adapter exposes a non-secret revision over the approved export snapshot and mutation after approval blocks export;
- [ ] owner-native lazy migration/normalization runs before import conflict decisions;
- [ ] destination local IDs are valid and independently owned;
- [ ] existing destination credentials are never implicitly overwritten;
- [ ] active-selection merge semantics are deterministic;
- [ ] lost acknowledgement reconciles safely;
- [ ] duplicate delivery is harmless;
- [ ] crash after owner mutation but before generic receipt persistence resolves to the same import or `ambiguous`, never an automatic duplicate;
- [ ] each shipping adapter proves owner-level idempotency/reconciliation rather than relying only on the generic receipt;
- [ ] source restart can reconstruct only the exact approved secret-free manifest, or the adapter explicitly invalidates on restart;
- [ ] credential transfer does not migrate usage attribution, capacity/quota evidence, cooldowns, or routing caches;
- [ ] partial/ambiguous failure is represented truthfully.

### Performance/architecture

- [ ] zero `InstanceStore` creation for request/list/approve/status;
- [ ] no Session/history hydration;
- [ ] bounded pending/receipt state;
- [ ] no N-per-row polling/request pattern;
- [ ] OFXP disabled means no credential-transfer network handling.

### UX

- [ ] ordinary user can install B, pair with A, choose accounts, and complete setup
      without manually extracting any token;
- [ ] nearby/same-network is an onboarding UX cue only; private addressing/mDNS never bypasses cryptographic trust;
- [ ] inbound peer requests remain passive and cannot auto-open/spam confirmation UI;
- [ ] non-transferable accounts clearly say re-login is required;
- [ ] UI explains that OFXP unpairing does not revoke already copied provider
      credentials.

---

## 28. Explicitly rejected shortcuts

Do not:

1. copy `auth.json` over the network;
2. copy the OpenFork SQLite database/table wholesale;
3. expose a remote `credential.list(includeSecrets=true)`;
4. add a permanent credential-read capability to `Ofxp.Grant`;
5. infer transfer safety from `type === "oauth"`;
6. export environment-managed credentials;
7. scrape arbitrary OS keychains through a generic adapter;
8. preserve source local credential IDs as destination identity;
9. log encrypted/decrypted transfer payloads "for debugging";
10. treat HTTPS alone as peer authorization;
11. let mDNS metadata select a secret recipient;
12. allow a Session/model prompt to count as user approval;
13. silently replace an existing destination account;
14. claim transfer cancellation retracts a credential already delivered;
15. build custom crypto merely to avoid one dependency;
16. negotiate HPKE/TLS-only downward inside the same credential-transfer protocol version;
17. use an unkeyed hash/fingerprint of a credential as its public source-revision token;
18. treat a trusted renderer/preload IPC call by itself as sufficient human approval;
19. forward arbitrary `Error.message`, validator dumps, provider bodies, or adapter exceptions after secret handling begins;
20. assume the generic transfer receipt alone makes an owner mutation exactly-once across a crash;
21. copy usage attribution, quota/capacity history, cooldowns, routing caches, or unrelated session state as part of "credential" migration;
22. trust the source's declared transfer policy instead of independently enforcing destination adapter policy;
23. treat private IP/mDNS/same-subnet locality as credential-transfer authority.

---

## 29. Open design gates

These should be answered by implementation evidence, not guesswork.

### Gate A — transfer envelope library/profile

Evaluate vetted HPKE implementations against:

- Node/Electron/Windows/Linux support;
- maintenance;
- audit/review pedigree;
- bundle/runtime cost;
- exact RFC 9180 interoperability;
- P-256 vs X25519 support;
- no surprising native build burden.

If no HPKE implementation meets the bar, do **not** automatically fall back at runtime or quietly downgrade the design. Make an explicit architecture ship/no-ship decision for a TLS-only transfer-protocol v1. If accepted, TLS-only is the single frozen v1 profile described in section 7; if rejected, credential transfer does not ship until a satisfactory standardized envelope is available.

Current Phase-0 dependency evidence (checked 2026-09-21) does **not yet close this gate**:

- the live repository contains no `@hpke/*` or `hpke-js` dependency;
- `@hpke/core` / hpke-js is attractive operationally because it is TypeScript/WebCrypto, supports current Node/Bun/browser environments, implements RFC 9180 ciphersuites, and publishes RFC/Wycheproof vector coverage. However, its own project documentation explicitly says it **has not been formally audited**. It also had a critical concurrent `SenderContext.seal()` nonce-reuse vulnerability (CVE-2025-64767 / GHSA-73g8-5h73-26h4) in versions <=1.7.4, fixed in 1.7.5; current npm is newer. The planned one-message-per-fresh-sender-context use avoids the vulnerable usage shape, but past repair plus vector coverage is not equivalent to a formal audit. Sources: https://github.com/dajiaji/hpke-js and https://github.com/advisories/GHSA-73g8-5h73-26h4;
- `panva/hpke` has a documented security model and current WebCrypto/runtime support, but its current implementation targets the active `draft-ietf-hpke-hpke` work rather than simply freezing the RFC 9180 interface assumed by this plan. Adopting it would require an explicit protocol-profile review rather than relabeling a draft implementation “RFC 9180.” Source: https://github.com/panva/hpke;
- BoringSSL exposes an RFC 9180 HPKE implementation, but the repository has no existing BoringSSL HPKE binding. Adding one would introduce a native integration/build/distribution surface that must be justified against the otherwise pure JS/WebCrypto path. Source: https://boringssl.googlesource.com/boringssl/+/main/include/openssl/hpke.h.

Therefore do **not** silently reinterpret “mature, audited implementation” to make a convenient dependency pass. Gate A remains unresolved until the project either (a) explicitly accepts a specific HPKE library/version/profile after dependency/security review and freezes its interoperability vectors, or (b) explicitly selects TLS-only as the sole v1 profile and accepts the reduced defense-in-depth.

### Gate B — trust-generation semantics — architecture resolved; live implementation absent

Add a dedicated monotonic `trust_generation` to durable OFXP peer trust and bind credential-transfer authorization to it.

Required semantics:

- increment on trust creation/re-pair repair/revocation/re-key-required and other identity-trust invalidations;
- never reset/reuse a generation for the same durable peer record;
- do not increment for ordinary capability-grant/root changes;
- mutate it in the same immediate transaction as the trust transition it represents;
- include it in the narrow internal/operator projection needed for stale-action fencing without making it a remote authority token;
- preserve `authority_epoch` for its broader cross-process invalidation role and use it, if useful, only to trigger a re-read.

Add migration and race tests proving revoke/re-pair cannot recreate the previous generation even when operations occur within the same wall-clock millisecond.

### Gate C — operator action boundary — architecture resolved, implementation proof required

v1 authority is source-local and human-controlled:

- desktop metadata review is request-scoped and flows through an explicitly allowlisted `RendererTrust` IPC into Electron main, then through the private typed main -> utility-process sidecar channel;
- desktop final approval requires Electron main's native confirmation over authoritative state re-resolved from the sidecar; no renderer-only/preload call can directly approve;
- the ordinary sidecar HTTP password is not privileged proof because it is exposed to the renderer through `ServerReadyData`;
- v1 has no browser/PWA HTTP candidate-list or approval route, removing CSRF/ambient-browser authority from the sensitive path;
- headless source approval is excluded from v1 because ordinary CLI/TTY execution can be indirectly model/process reachable; a future headless operator-presence primitive is a separate security design;
- generic HTTP `Authorization`, paired-device/PWA bearer tokens, model-facing OFXP, and peer-wire methods cannot mint approval;
- any future remote-admin approval is a separate security design.

Implementation still must prove there is no generic/arbitrary sidecar-command renderer IPC, native confirmation cannot be bypassed, stale review/revision state fails closed, and only the exact request/selection confirmed by main can be committed.

### Gate D — generic secret type — required shape, concrete helper still open

Use a dedicated `SecretBytes`-style opaque wrapper at the transfer boundary rather than plain strings/JSON values.

Required properties:

- internal bytes are not publicly enumerable fields;
- default `toString`, Node inspection, structured logging, and JSON serialization yield only a redacted marker or throw safely—never the secret;
- extraction requires an explicit narrow callback/method at crypto/import boundaries;
- constructors copy/normalize input deliberately so ownership/lifetime is understood;
- callers cannot obtain secret data through an ordinary candidate/status/result projection;
- cleanup may overwrite owned buffers best-effort, but the product must not claim deterministic JavaScript memory erasure.

Prefer a tiny protocol-neutral Core helper with focused tests over sprinkling `Redacted<string>`/raw `Buffer` conventions through adapters. Prototype against Effect's existing `Redacted` behavior, Node inspection, JSON serialization, cloning, thrown errors, and debugger/logging paths before freezing the exact implementation.

### Gate E — first provider semantics — partially resolved, policy evidence still open

Live OpenFork uses the selected OpenCode Go key as a bearer API key. Current official OpenCode Go documentation likewise instructs users to copy an API key and paste it into `/connect`, and documents Go use from OpenCode and other coding-agent clients. That establishes the technical credential shape as a reusable API-key-style bearer, not an OAuth refresh-token/device-key construction.

It does **not**, by itself, establish an explicit upstream guarantee that one key may be cloned across an arbitrary number of simultaneous devices or that such cloning will remain policy-stable. Before shipping the `clone` adapter, record either:

- explicit provider documentation/terms confirming the intended multi-client/device use; or
- an OpenFork-owned compatibility decision that copying the user's own bearer key between their own installations is supported, with a clearly documented risk that upstream policy may later require reissue/re-login.

Do not infer broader credential-sharing rights merely from the key being technically portable.

Current provider evidence (checked 2026-09-21) is stronger than a generic “opaque key” assumption but still does not answer the exact cloning question. Official OpenCode Go documentation says the user copies an API key into `/connect`, exposes direct API endpoints, and explicitly states that Go is designed for OpenCode **and other coding agents** that send similar traffic; the Go product page likewise says “use with any agent.” That supports multi-client interoperability of the account/key API surface. It does **not** explicitly state that the **same key** is intended to be duplicated simultaneously across multiple user-owned devices/installations, nor does it define a device-bound/reissue policy for this transfer use case. Sources: https://dev.opencode.ai/docs/go/ and https://dev.opencode.ai/go.

Gate E therefore stays open rather than silently turning “works with multiple client products” into “provider guarantees same-key multi-device cloning.” Phase 0 must record one explicit policy decision before the first adapter is authorized: either upstream documentation/terms are found that resolve this exact question, or OpenFork deliberately treats cloning the user's own bearer key between their own installations as a compatibility feature and owns the risk/UX if upstream policy changes later.

### Gate F — owner-level import idempotency — architecture resolved, per-adapter proof required

Every shipping adapter must prove crash-safe reconciliation at its authoritative owner. The generic transfer receipt is never accepted as the sole exactly-once mechanism. For the first Fork/OpenCode Go adapter, implement an owner-owned atomic import marker/batch transaction keyed by `(sourcePeerID, transferID, itemID)` and test the crash window after credential insertion but before generic receipt persistence.

### Gate G — secret-bearing error boundary — architecture resolved, implementation proof required

Credential-transfer secret processing must never rely on the generic OFXP transport's current arbitrary `error.message` projection. Transfer handlers own closed safe reason codes and sanitize before any peer response, `onError`, log, trace, or crash-report path. Sentinel-secret exception tests are a release gate.

### Gate H — first-owner source revision/export contract — architecture resolved, implementation proof required

Section 9.1 freezes the required Fork/OpenCode Go semantics: persistent owner revision, revision changes over secret + portable label/active state, serialized owner initialization, metadata-only candidate projection, atomic revision+secret snapshot, and owner-native import marker/transaction.

Repository audit confirms those facilities do **not** exist today. In particular, the live table has no revision, `list()` returns raw keys, the current lazy migration boolean is not a completion barrier, and several active/add/remove operations span multiple statements without the transfer-specific transaction contract. The first adapter therefore remains blocked until the owner exposes the exact safe primitives; OFXP may not emulate them with direct SQL or a `checkRevision(); getSecret()` sequence.

### Gate I — bounded-resource profile — resolved

The hard v1 ceilings are frozen in §§13.3 and 17.2: pending/approved cardinality, five-minute request/approval windows, three total disclosure admissions, one in-flight fetch per transfer, 30-second attempt deadline, item/manifest/payload/schema bounds, 30-day detailed retention, and 365-day replay tombstones with fail-closed capacity behavior. Implementation may lower local limits but may not silently accept larger wire/security bounds.

---

## 30. Final architectural statement

Credential transfer should feel like a tiny convenience feature to the user and
remain a sharply bounded security protocol internally.

The intended law is:

```text
discovered
  != trusted

trusted
  != authorized to receive secrets

approved transfer
  != permanent secret access

successful copy
  != remotely revocable credential

provider credential
  != generically cloneable blob
```

OFXP already provides the hardest prerequisite: a first-party, explicit,
cryptographically identified peer relationship.

The credential-transfer feature should build on that relationship without
weakening it:

> **pair once, authorize disclosure explicitly, transfer the minimum supported
> secret material through its authoritative owner, commit idempotently, and leave
> no ambient credential-reading authority behind.**
