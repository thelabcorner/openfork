# OpenFork plan — OpenCode V2 authentication / account integration

Status: **planning only**. No runtime/auth migration is authorized by this document yet.

Date: 2026-09-21

## 1. Objective

OpenCode's V2/current product now has a materially different authentication/account
surface than the legacy OpenCode V1 flow that OpenFork inherited. OpenFork needs to
consume the upstream-operated OpenCode Console / Zen / Go authentication contracts
correctly **without turning this into a local V1 -> V2 runtime migration**.

The target is:

- OpenFork users can create/use the current OpenCode Console and OpenCode Go API
  keys expected by upstream.
- OpenFork can support the current OpenCode account/login model where useful
  (including multiple credentials/accounts and explicit active-account selection).
- Existing OpenFork multi-account Zen/Go routing, account selectors, limits,
  capacity estimation, scheduled tasks, OXP model selection, and usage attribution
  keep working.
- Existing OpenFork users are migrated without losing credentials or silently
  changing which account a session uses.
- OpenFork's mature V1 execution/provider path remains the production path.
- The strict compatibility target is the upstream **remote service contract**, not
  upstream's local V2 CLI/server/runtime architecture.

This is therefore a **remote-contract + shared-account-domain backport**, not an
OpenFork runtime-generation migration.

## 2. Upstream facts established in this audit

### 2.1 Current V2 product behavior

Current OpenCode V2 documentation exposes account-oriented auth commands:

- `opencode auth login <provider>`
- `opencode auth logout <provider> <account>`
- `opencode auth switch <provider> <account>`
- `opencode auth list`

That is stronger than the old one-provider/one-secret `auth.json` mental model:
the user-facing abstraction is now an integration with one or more accounts and an
active account.

Current V2 Console documentation says the OpenCode pay-as-you-go provider is used by
signing in to Console, creating/copying an API key, and connecting that key. Current
V2 Go documentation says the same for OpenCode Go. Go remains a bearer-key provider
against `https://opencode.ai/zen/go/v1/*`; current published limits are rolling,
weekly, and monthly usage budgets.

There is also a **new Console inference plane** that must not be conflated with the
legacy Zen/Go gateway. Current Console documentation exposes:

- `/inference/openai/v1/chat/completions`;
- `/inference/openai/v1/responses`;
- `/inference/anthropic/v1/messages`;
- `/inference/google/v1beta/...`.

That plane accepts either a **service-account key** or a **user session token** as
`Authorization: Bearer <token>`; user session tokens additionally require the
organization header. This is the strongest evidence behind the community phrase
"V2-compatible API key": V2 Console auth is not merely a renamed copy of the old
anonymous/IP-scoped Zen free path.

Therefore P0 must capture **both** remote provider families:

1. legacy/current Zen + Go provider endpoints under `/zen/**`;
2. Console/V2 inference + control-plane endpoints under `/console/**`,
   `/api/**`, and `/inference/**`.

OpenFork must not guess that one credential or endpoint family can transparently
substitute for the other.

### 2.2 Current upstream implementation already present in this fork

The local tree already contains substantial current/V2 donor architecture:

- `packages/core/src/credential.ts`
  - durable multi-credential storage;
  - multiple credentials per integration;
  - active credential selection;
  - label/update/remove operations.
- `packages/core/src/integration.ts`
  - provider/integration auth methods;
  - key and OAuth flows;
  - OAuth attempt lifecycle;
  - credential refresh and selection.
- `packages/core/src/plugin/provider/opencode.ts`
  - OpenCode Console device OAuth against the upstream Console service;
  - refresh-token flow;
  - `/api/user`, `/api/orgs`, and `/api/config` consumption;
  - manual API-key/service-account method;
  - upstream account/org metadata on OAuth credentials.
- `packages/opencode/src/account/**`
  - a Console **control-plane identity** service with durable account rows;
  - device-code login, token refresh, account/org selection, and remote config;
  - used by config loading to obtain a Console session token and merge the selected
    org's `/api/config` response.
- `packages/app/src/components/settings-v2/providers.tsx`
  - account rows, add account, select default, rename, and remove;
  - already capable of presenting multiple credentials when the backend exposes
    them.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/provider-settings.ts`
  - a bootstrap-free/global provider-settings path that already reads both legacy
    `Auth` and Core `Credential` state.

So this should not be implemented by inventing a third account system.

A deeper trace also shows that "account" has two different meanings in the current
tree and they must stay explicit:

- **Console control-plane account** — signed-in human/session + organization,
  currently represented by `Account.Service`; it can deliver remote config,
  policies, and a user session token.
- **Provider credential account** — one credential used to call an inference
  provider, represented by `Credential/Integration` and by OpenFork's older
  Zen/Go fork vault.

Those are related for OpenCode-hosted services, but they are not interchangeable.
A Console org switch is not the same operation as choosing which API key a session
uses for a model request.

## 3. Current OpenFork state that must be preserved

OpenFork's live V1 provider path still has three overlapping credential systems:

1. **Legacy Auth**
   - `packages/opencode/src/auth/index.ts`
   - one `Auth.Info` per provider in the compatibility `auth.json` model.

2. **Core Credential / Integration**
   - durable multi-account current/V2 domain;
   - already used by V2/current provider settings and integration flows.

3. **Fork Zen/Go credential vault**
   - `packages/opencode/src/fork/credentials.ts`
   - `fork_credential` + `fork_message_credential`;
   - powers the live OpenFork Zen/Go multi-key UX;
   - currently stores API keys independently from Core Credential;
   - `packages/opencode/src/plugin/zen.ts` maps those keys into stable
     `zen-<hash>` provider account IDs and performs actual V1 request routing.

The request path therefore does **not** yet have the same source of truth as the
current/V2 account UI/domain.

That split is the main integration problem.

## 4. Architecture decision

### 4.1 Canonical durable owners

There are two owners, because there are two domains.

**Provider inference credentials:** Core `Credential/Integration` becomes the
canonical durable provider-credential owner.

Do not make `Auth.Service`, `fork_credential`, the UI, or provider transport the
new source of truth for provider keys.

Why:

- it already models N credentials per integration;
- it already owns active selection and labels;
- it is process/global durable state, which matches repository Tier-0 ownership;
- the V2/new-layout Settings UI already understands it;
- it is the correct lowest shared owner for provider-auth semantics plus a narrow
  V1 adapter.

The existing `fork_credential` table becomes a **migration/compatibility source**,
not a second long-term provider-key vault.

`Auth.Service` remains a compatibility input for providers/runtime paths that have
not yet been adapted. It must not be expanded to reproduce the V2 account model.

**Console control-plane identity:** keep a separate explicit owner for signed-in
Console account/org/session state. The current candidate is `Account.Service`.
Do not fold org switching, Console session-token refresh, remote organizational
config, or policy state into provider credential rows merely because both domains
use OpenCode-operated authentication.

P0 must verify the latest upstream ownership before implementation, because the tree
currently contains both `Account.Service` and current/Core Console integration
logic. If upstream is still converging those surfaces, OpenFork should preserve the
semantic split and choose one shared owner deliberately rather than copy both
implementations.

### 4.2 Separate three identities

Never collapse these into one string:

1. **credentialID**
   - local durable record identity (e.g. `cred_...`);
   - used for storage mutation.

2. **providerAccountID**
   - stable identity used for model routing, session persistence, OXP model
     selection, quota/capacity attribution, and account lookup;
   - provider-specific but resolved through the generic Provider account contract.

3. **label**
   - mutable presentation only;
   - never a durable routing key.

For OpenCode Console/Go credentials:

- OAuth/device credentials should use the upstream account/user identity available
  from the remote account response, plus org/workspace metadata where relevant.
- API-key credentials should use a remote account/workspace identity when the
  upstream contract can resolve one safely.
- If the upstream key contract exposes no stable account identity, retain the
  existing secret-derived `zen-<hash>` fallback as the provider account identity.
  That is a routing identity, not the credential primary key.
- Never expose the raw key in account metadata, logs, routes, model IDs, or UI.

This separation is necessary because rotating a secret must not automatically be
treated as renaming the durable credential record, and a random credential row ID
must not leak into provider wire semantics.

## 5. Proposed shared projection

Add one narrow, process-global account projection over Credential rather than making
every consumer reconstruct credentials independently.

Conceptually:

```ts
type ProviderAccount = {
  providerID: string
  credentialID: Credential.ID
  accountID: string
  label: string
  active: boolean
  authType: "key" | "oauth"
  source: "credential" | "env" | "legacy"
  metadata?: {
    email?: string
    userID?: string
    orgID?: string
    orgName?: string
    workspaceID?: string
  }
}
```

The authoritative producer is the credential/integration domain. A provider-specific
adapter derives `accountID` from credential metadata/key identity.

Consumers receive compact account metadata only. They do **not** receive secrets.

The projection must support:

- list accounts by provider/integration;
- resolve human selector -> stable `accountID`;
- resolve `accountID` -> credential record for trusted provider transport;
- active account lookup;
- connection-added/removed/renamed/selected events.

This should plug into the provider-agnostic multi-account resolution work already
present in `Provider.resolveAccountID(...)`; do not create a Zen-only selector
parser.

## 6. OpenCode remote-auth boundary

Treat upstream OpenCode authentication as **two remote protocol planes** with a
shared compatibility discipline, not one giant auth adapter.

### 6.1 Console control plane

Owns:

- device-code login;
- user session token refresh;
- account/user/org selection;
- organization header semantics;
- remote `/api/config` and policy/config retrieval;
- organization-scoped metadata.

The provider request router must not independently reimplement this lifecycle.

### 6.2 Provider inference credentials

Owns:

- service-account/API-key credentials entered through provider connect/auth flows;
- key validation/probing where a documented safe upstream endpoint exists;
- provider-account identity derivation;
- trusted resolution of an accountID to secret material at dispatch;
- auth-classification of upstream inference errors.

For OpenCode-hosted inference, this plane may target either the Zen/Go gateway or the
new Console `/inference/**` gateway depending on the remote provider config. That
choice must come from an observed upstream contract/catalog/config, never from the
shape of the key or from UI naming.

### 6.3 Shared rules

Neither plane owns session model selection, quota UI, capacity UI, or V1 provider
construction.

The current implementations in
`packages/core/src/plugin/provider/opencode.ts` and
`packages/opencode/src/account/account.ts` are donor/reference evidence. P0 must
determine their current upstream lifecycle and extract the remote semantics into the
lowest correct shared owner(s), with narrow V1 adapters where needed.

Do not make Core depend on V1 implementation details, and do not merge control-plane
org identity into inference-credential identity just to reduce the number of types.

## 7. V1 request-routing cutover

The live V1 transport remains the OpenFork production path.

Today `packages/opencode/src/plugin/zen.ts` is the account/auth authority for
`opencode` and `opencode-go`. Preserve the transport mechanism, but replace its
vault source with the canonical account projection.

Target routing order:

1. explicit persisted/requested `accountID`;
2. active credential for that provider;
3. compatible migrated legacy credential;
4. applicable environment credential;
5. anonymous/public Zen only when the remote model explicitly supports anonymous
   access.

Important rules:

- explicit account selection always fails closed if the account disappeared;
- never silently fall through from an explicit account to a different key;
- `opencode-go` never falls back to anonymous/public auth;
- a configured current/V2 API key must not accidentally be shadowed by stale
  `auth.json` state;
- `opencode` anonymous/public behavior is a separate legacy/free mode, not an
  implicit substitute for a missing authenticated account;
- the provider account selected for transport must be the same account attributed
  to the assistant message, usage, quota, and capacity settlement.

The existing per-request Authorization rewrite / model de-qualification in
`zen.ts` can remain. Only the account source and identity authority should move.

## 8. Migration strategy

Migration must be monotonic and idempotent.

### Phase A — observe only

Build a migration reader that inventories:

- Core Credential records for `opencode` / `opencode-go`;
- `fork_credential` records;
- legacy `Auth.Service` entries;
- environment credentials.

Produce normalized identities and detect duplicates without mutating anything.

### Phase B — idempotent import into Credential

For each legacy fork credential not already represented:

- create a Core Credential key record;
- preserve the user label;
- preserve active/default state;
- attach migration metadata sufficient to trace the source record;
- compute the same stable providerAccountID used by the live router.

Deduplicate by secret fingerprint / resolved remote account identity, never by label.

Do not delete legacy data yet.

### Phase C — dual-read, single-write

For one compatibility release window:

- writes go to Core Credential only;
- V1 routing reads Core first;
- legacy fork/auth sources are fallback migration inputs only;
- mutations publish the same account-change event consumed by provider/catalog,
  limits, and UI refresh paths.

### Phase D — retire fork vault as owner

After parity tests prove the cutover:

- stop creating/updating `fork_credential`;
- keep a bounded migration reader for old installations;
- keep `fork_message_credential` only if historical message attribution still
  needs it, or migrate that relation to the canonical account identity in a
  separate explicit schema step.

Do not drop historical data merely to simplify the first cut.

## 9. Usage, quota, capacity, and reset events

The auth migration is incomplete if a request is authenticated correctly but the
rest of OpenFork attributes it to a different identity.

Every settled OpenCode request must carry one authoritative provider account identity
through:

```
selected model/account
  -> provider resolver
  -> V1 transport
  -> actual routed credential
  -> message settlement
  -> usage attribution
  -> quota snapshot
  -> capacity estimator
  -> reset-event calendar
```

Required consequences:

- `fork/usage.ts`, `quota/providers/opencode-go.ts`, and the capacity system
  consume canonical `accountID`, not whichever vault row happened to be active at
  step finish.
- official Go `/zen/go/v1/usage` queries use the exact routed API key.
- the 5h/weekly/monthly reset records remain per account.
- the calendar reset-event feature gets those reset events from quota/capacity
  state, not by re-reading secrets or provider config.
- no per-account polling timer. Quota refresh stays shared/single-flight/bounded.

## 10. UI / UX

The V2/new-layout provider UI is the correct presentation surface.

Do not build another credential manager.

Use the existing Settings -> Providers account rows and connect dialog, but ensure
the backend contract works under the V1 production runtime.

For OpenCode providers:

- **OpenCode Console**: Add account -> API key, with device login optionally offered
  if retained as a supported upstream flow.
- **OpenCode Go**: Add account -> API key.
- show account label and safe stable account identity;
- show active/default state;
- support add / select / rename / remove;
- show per-account quota/reset/capacity where available;
- never display or return the stored key after creation.

Connection success should validate enough upstream state to distinguish:

- syntactically stored but unauthorized key;
- valid Console key;
- valid Go entitlement;
- valid key but no Go subscription;
- transient upstream/network failure.

Do not eagerly create a workspace Instance to perform any of those checks.

## 11. Server ownership

Authentication/account metadata is **Tier 0 process/global**.

Required invariant:

> Listing, adding, selecting, removing, validating, or showing quota for an
> OpenCode account must create zero workspace Instances.

The existing bootstrap-free provider-settings route is the right architectural
direction. If additional routes are needed, keep them on a root/global group rather
than reusing an instance-scoped current/V2 integration route merely because the SDK
already has one.

The V2 UI may consume a V1/fork-owned global API. UI generation is not API
generation.

## 12. CLI / OXP / scheduled tasks

### CLI

OpenFork does not need to reproduce upstream CLI architecture for compatibility, but
its retained CLI should expose the same user concept where useful:

- login/add account;
- list accounts;
- switch active account;
- remove one account.

Those commands call the same global account service as the UI.

### OXP

OXP model selections already carry
`{ providerID, modelID, accountID, variant }`.

The V2-auth cutover must preserve that contract:

- human-facing selectors resolve through the shared provider-account resolver;
- durable OXP selections persist the stable internal `accountID`;
- runtime materialization resolves that account to a credential only inside the
  trusted provider adapter;
- OXP never receives or returns secret bytes.

### Scheduled tasks / agents

Persist `accountID`, not credential row IDs or labels. If the account disappears,
fail admission with an actionable account-missing error instead of silently routing
to the current default.

## 13. Performance requirements

The steady-state request hot path must be O(1) for account resolution:

- one in-memory map `accountID -> credential handle`;
- no SQLite scan per token/request;
- no credential list reconstruction per fetch;
- no network validation per request;
- no workspace bootstrap;
- no N-account timers.

Credential mutations rebuild/incrementally update the compact projection and publish
one change event.

Secret resolution occurs only at the trusted provider dispatch boundary.

Quota refresh remains independently cached/single-flight so an auth lookup never
waits on usage polling.

## 14. Security requirements

- Never log, serialize, emit, or place API keys in model IDs/account IDs.
- Do not expose credential values through provider/account list APIs.
- Explicit account routing fails closed.
- Remote verification URLs must remain HTTP(S) and be normalized exactly as the
  upstream device flow requires.
- Refresh-token updates must be atomic with respect to credential replacement.
- Key import migration must be idempotent and duplicate-safe.
- Account removal must invalidate cached provider account maps immediately.
- Stale `auth.json` must never override a deliberately selected current credential.
- Environment credentials remain read-only/non-removable from UI.
- Keep OpenCode remote-service branding and identifiers where they are protocol
  contracts; OpenFork-owned UI/help text remains OpenFork-branded.

## 15. Required test matrix

### Domain/storage

- N credentials under one provider;
- active selection;
- rename does not change account identity;
- remove active account picks deterministic fallback or no account;
- duplicate migration is idempotent;
- same secret in legacy/fork/Core sources deduplicates;
- OAuth refresh preserves providerAccountID.

### Migration

- only legacy `auth.json` key;
- only `fork_credential`;
- both containing same key;
- both containing different keys;
- Core Credential already populated;
- active legacy key preserved;
- malformed/partial legacy row leaves existing data untouched.

### Routing

- explicit account;
- active account;
- missing explicit account fails closed;
- Go never uses public;
- authenticated Zen does not get shadowed by public/stale legacy auth;
- model suffix/account metadata is stripped before upstream wire;
- actual routed account equals settlement attribution.

### Remote contract

- current Console service-account key success/failure on the V2 inference plane;
- current Console user-session token + organization header success/failure;
- current Zen key success/failure;
- current Go key success;
- valid key with no Go entitlement;
- provider config selecting `/inference/**` versus `/zen/**` routes;
- OpenAI Responses, OpenAI-compatible chat, Anthropic Messages, and Gemini route
  authentication where the upstream config advertises them;
- `401`, `403`, `429`, `FreeUsageLimitError`, `GoUsageLimitError`;
- official Go usage endpoint parsing;
- device auth pending / slow_down / denied / expired / refresh;
- org switch changes control-plane config/policy but does not silently mutate an
  explicitly persisted provider account selection.

### Cross-system identity

For one selected account, assert the identical accountID reaches:

- model picker;
- session persisted model ref;
- provider request route;
- message attribution;
- usage;
- quota;
- capacity;
- limits panel;
- reset-event calendar;
- OXP selection;
- scheduled task execution.

### Architecture/performance

- global account list creates **0 Instances**;
- credential validation creates **0 Instances**;
- quota refresh creates **0 Instances**;
- request auth resolution performs no SQLite list query on hot path;
- 1 / 10 / 100 account lookup remains O(1) after projection build;
- concurrent account mutation + request does not route a deleted credential;
- one mutation emits bounded refresh work, not N consumer fetches.

## 16. Implementation phases

### P0 — remote-contract capture

Before code changes:

1. capture current V2 docs/contracts for Console control-plane auth, Console
   `/inference/**`, Zen, Go, auth CLI, endpoints, headers, and errors;
2. compare latest upstream source/tag against the forked donor files;
3. trace the current V2 provider config returned for both a user-session login and
   a service-account key, including exact endpoint URLs, packages, headers, and
   model IDs;
4. determine whether manual API/service-account keys have a supported upstream
   identity/probe endpoint and what stable identity it returns;
5. classify `packages/core/src/plugin/provider/opencode.ts` and
   `packages/opencode/src/account/**` as provider-credential, Console
   control-plane, compatibility, or transitional owners in latest upstream;
6. determine whether the remote contract intentionally routes V2-authenticated
   OpenCode models through `/inference/**`, `/zen/**`, or both;
7. record exact compatibility fixtures before production mutation.

No production mutation in P0.

### P1 — canonical account projection

Implement the compact global account projection over Core Credential and wire it
into the generic Provider account resolver. No transport cutover yet.

### P2 — migration/import

Add observe/import migration from `fork_credential` and compatible `Auth` entries.
Run dual-read tests. Do not delete legacy state.

### P3 — V1 transport cutover

Make `zen.ts` consume the canonical projection and record the actual account used
at request dispatch/settlement.

### P4 — quota/capacity attribution

Cut all OpenCode Go/Zen usage, quota, capacity, reset-event, and model-account
surfaces to canonical accountID.

### P5 — global provider/account API + UI

Finish bootstrap-free add/select/remove/rename/login flows used by the V2/new-layout
settings and connect dialog. Preserve New York dense UI; no parallel settings system.

### P6 — retained CLI/OXP/scheduler integration

Point retained CLI auth commands, OXP account resolution, scheduled tasks, and
special-agent selection at the same account owner.

### P7 — legacy owner retirement

After parity and migration soak:

- stop writes to `fork_credential`;
- narrow `Auth.Service` to compatibility use;
- retain only migration shims still required by real installations;
- update `FORK.md` ownership table and the Zen multi-key plan to name the new
  canonical owner.

## 17. Hard acceptance criteria

This tranche is not complete until all are true:

1. A newly generated current OpenCode Console/Go API key can be connected in
   OpenFork and used by the V1 production runtime.
2. Multiple OpenCode keys/accounts remain independently selectable.
3. Explicit account selection is deterministic and fail-closed.
4. The account used on the wire is exactly the account charged/attributed in usage,
   quota, capacity, and reset events.
5. Existing fork-vault users migrate without losing labels/default selection.
6. No request requires migrating OpenFork execution to current/V2 runtime.
7. Account/auth metadata APIs create zero workspace Instances.
8. No secret is exposed through list/UI/OXP/model-selection surfaces.
9. Current OpenCode Go usage/quota contract remains wire-compatible.
10. Existing non-OpenCode multi-account providers keep using the generic
    provider-account contract unchanged.

## 18. Open questions that must be resolved in P0

1. **Manual-key identity:** Which current upstream endpoint, if any, maps a Console
   service-account key, Zen key, or Go key to stable account/workspace/user metadata
   without requiring a separate OAuth token?
2. **Two auth planes:** Are `Account.Service` and Core `Integration/Credential`
   intentionally separate control-plane/provider-credential domains in latest
   upstream, or is one a migration predecessor?
3. **V2 inference routing:** What exact remote config makes an authenticated V2
   OpenCode installation use `/inference/**` rather than `/zen/**`, and which
   models/providers remain on each family?
4. **Service-account versus user-session tokens:** Which APIs accept each token
   class, which require the organization header, and can the same token call both
   config/control-plane and inference endpoints?
5. **Console vs Go credentials:** Are the same generated key records valid for both
   `opencode` and `opencode-go`, or must they be represented as two integration
   connections referencing one secret/account?
6. **Anonymous Zen/Inference:** Which current V2 models intentionally allow
   unauthenticated access, and how is that capability advertised rather than
   inferred?
7. **Key rotation:** Does Console expose a stable key ID or account/workspace ID that
   lets a rotated secret preserve providerAccountID?
8. **Remote config authority:** When connected to Console, is remote `/api/config`
   authoritative for endpoint/package/model selection, or should OpenFork continue
   combining it with models.dev and fork-owned provider catalog data?
9. **Go usage identity:** Does the current Go usage endpoint identify the same
   workspace/user/account as Console service-account credentials, and can that
   identity be obtained without exposing the secret?
10. **Credential encryption:** this plan preserves current at-rest behavior; a move
    to OS-backed secret storage would be a separate security migration and must not
    be smuggled into the auth cutover.

## 19. Non-goals

- migrating OpenFork execution/runtime to OpenCode V2;
- replacing V1 local APIs with Protocol/current APIs for parity;
- implementing upstream CLI behavior 1:1;
- building a generic password manager;
- giving agents/OXP raw credential access;
- changing non-OpenCode provider authentication merely because this tranche exists;
- deleting legacy credential data before migration proof;
- using reinstall/uninstall behavior as an auth-reset mechanism.

## 20. Planning verdict

The correct implementation is **not** "copy upstream V2 auth into OpenFork."

OpenFork already has the pieces, but the ownership is split. The proper cutover is:

```
                  Console device login / user session
                              │
                              ▼
                    Console control-plane owner
                 (account + org + token + policies)
                              │
                              ├── /api/config / org policy
                              └── optional user-session inference auth
                              
legacy auth.json + fork_credential
           │ migration inputs
           ▼
   Core Credential / Integration
       (provider credential owner)
           │
           ├── compact ProviderAccount projection ──> UI / CLI / OXP / scheduler
           │
           ├── V1 provider adapter ──> trusted dispatch ──┬─> upstream /zen/**
           │                                              └─> upstream /inference/**
           │
           └── accountID ──> usage / quota / capacity / reset events
```

That keeps the mature V1 runtime, adopts the current upstream remote authentication
contracts, removes duplicate long-term provider-credential ownership, keeps Console
control-plane identity explicit, and gives inference selection one deterministic
provider account identity from selection through billing and quota attribution.
