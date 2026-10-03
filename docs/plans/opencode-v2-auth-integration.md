# OpenFork plan — port upstream OpenCode account authentication

Status: **canonical implementation plan; planning only**

Date: **2026-09-25**

Supersedes: the 2026-09-21 draft previously stored at this path.

## 1. Goal

Port OpenCode's current upstream **human account authentication used by the provider connect flow** into OpenFork without importing upstream's local runtime architecture.

The feature target is the current OpenCode Console device-OAuth flow exposed by upstream provider connect:

- **OpenCode Console account** — browser/device OAuth;
- **API key (service account)** — retained as a separate connection method;
- durable access + refresh token lifecycle;
- remote user/account and organization identity;
- multiple stored connections;
- explicit active/default connection selection;
- logout/removal;
- automatic refresh before use.

This is the auth surface previously described as the upstream "/connect" flow moving beyond an API-key-only modal. It is **not**:

- ChatGPT -> OXP authentication;
- the OpenFork local-server Authorization middleware;
- a generic credential broker;
- a V1 -> current/V2 runtime migration;
- a reason to restore upstream Console/backend packages that OpenFork intentionally prunes.

The implementation must preserve OpenFork's mature V1 execution runtime and fork-owned account-routing behavior while remaining wire-compatible with the upstream-operated OpenCode Console service.

## 2. Executive architecture decision

The port should **reuse upstream remote semantics, but not upstream local ownership boundaries verbatim**.

The target architecture is:

~~~text
V2/new-layout OpenFork UI
        |
        v
bootstrap-free provider-settings/auth API   (Tier 0)
        |
        v
bootstrap-free global Integration auth runtime
        |
        +--> shared OpenCode Console remote-auth protocol adapter
        |       - device code
        |       - polling
        |       - refresh
        |       - user/org identity
        |       - remote provider config
        |
        +--> Core Credential store
        |       - one durable provider credential record per connection
        |       - key OR OAuth
        |       - label + active selection
        |
        +--> ProviderAccount projection
                - secret-free identity
                - stable account routing ID
                - active/default state
                - UI/OXP/scheduler-visible metadata

V1 provider runtime
        |
        v
OpenCode provider-route resolver
        |
        +--> PUBLIC FREE
        |       - no Credential / no ProviderAccount
        |       - upstream "public" sentinel
        |       - trusted free classification + execution metadata + hosted availability
        |       - exact public-route attribution
        |
        +--> ACCOUNT
                - durable Session-affine ProviderAccountRouter binding
                - resolves/refreshes exact Credential
                - account/org-specific /api/config capability snapshot
                - exact account attribution

Existing Zen/Go API-key routing remains the compatibility adapter during convergence.
~~~

The existing location-scoped Core Integration service remains the workspace-facing composition, but its location-independent auth mechanics should be extracted into the shared kernel described below. The whole location service must **not** be invoked with a missing directory to make global auth "work." Authentication/account operations **and public catalog availability/refresh** are Tier 0 and must create zero workspace Instances.

## 3. Evidence snapshot

This plan was realigned against:

- the live OpenFork tree in /webstormprojects/opencode;
- OpenFork repository architecture rules in AGENTS.md and packages/opencode/AGENTS.md;
- docs/map/architecture.md;
- docs/map/v1-v2.md;
- docs/map/upstream-fork.md;
- docs/architecture/compatibility-boundary.md;
- the current OpenFork Credential, Integration, Account, provider-settings, connect-dialog, Zen/Go pool, usage, quota/account-routing code;
- upstream OpenCode dev as observed on **2026-09-25**, including commit **adee738d1e4597a2d0d317ca61a1625eff289efa**.

The upstream OpenCode provider-auth implementation at that snapshot still uses the same Console device-flow contract described below.

## 4. Confirmed upstream remote contract

The externally operated service is the strict compatibility boundary.

### 4.1 Console origin and client identity

Default Console origin:

- https://opencode.ai/console

OAuth client identifier:

- opencode-cli

Do not rename these because of OpenFork branding. They identify the upstream-operated service/protocol.

### 4.2 Device authorization

Start:

- POST {console}/auth/device/code
- JSON body: { "client_id": "opencode-cli" }

Expected response fields:

- device_code;
- user_code;
- verification_uri_complete;
- expires_in;
- interval.

OpenFork must preserve upstream validation that the verification URL resolves to HTTP(S).

### 4.3 Device-token polling

Poll:

- POST {console}/auth/device/token

Body:

- grant_type = urn:ietf:params:oauth:grant-type:device_code
- device_code = the issued device code
- client_id = opencode-cli

Known states:

- authorization_pending -> continue at current interval;
- slow_down -> add five seconds to the poll delay;
- successful token -> hydrate user/org metadata;
- any other terminal OAuth error -> fail the attempt visibly.

The attempt must also honor local expiry/cancellation and release its scope.

### 4.4 Refresh

Refresh:

- POST {console}/auth/device/token

Body:

- grant_type = refresh_token
- refresh_token = the current refresh token
- client_id = opencode-cli

Successful refresh rotates the persisted access and refresh tokens and recomputes expiration.

Refresh must be serialized **per durable credential**. OpenFork already added keyed refresh locking to Core Integration; that protection is stronger than upstream's current implementation and must be retained in the shared/global path.

### 4.5 Identity hydration

After successful device authorization:

- GET {console}/api/user with bearer access token;
- GET {console}/api/orgs with bearer access token.

Upstream currently records:

- remote user/account ID;
- email;
- organization ID;
- organization name;
- Console server origin.

The current provider plugin chooses one organization deterministically from the returned set. OpenFork must preserve compatible behavior for the first port but keep organization identity explicit because it affects remote provider configuration and potentially billing/routing.

### 4.6 Provider configuration

Authenticated provider configuration:

- GET {console}/api/config
- Authorization: Bearer <credential>
- x-org-id: <organization id> when an organization is selected.

The response contains provider configuration consumed by upstream's provider catalog.

This remote config is **provider/control-plane data**, not a reason to replace OpenFork's local config or runtime architecture.

## 5. Current OpenFork state

### 5.1 Legacy Auth

packages/opencode/src/auth/index.ts remains the legacy auth.json compatibility layer.

Current strengths that must not regress:

- atomic replacement rather than unsafe direct overwrite;
- process-local mutation serialization;
- normalization of provider keys;
- compatibility with OPENCODE_AUTH_CONTENT.

It remains a compatibility input. It is not the new multi-account owner.

### 5.2 Core Credential

packages/core/src/credential.ts plus packages/schema/src/credential.ts already provide the correct durable provider-credential model:

- Credential.ID;
- integrationID;
- mutable user label;
- Key or OAuth value;
- OAuth access / refresh / expiration / metadata;
- multiple credentials per integration;
- explicit active selection;
- add / update / select / remove.

OpenFork has already improved this area beyond current upstream:

- add() preserves multiple credentials instead of replacing the integration's existing credential;
- active connection state is persisted;
- reads use the read database;
- selection is transactionally updated.

**Decision:** Core Credential becomes the canonical durable owner for provider credentials created by the new global OpenCode provider-connect flow.

### 5.3 Core Integration

packages/core/src/integration.ts already contains high-quality reusable semantics:

- auth-method registry;
- key and OAuth methods;
- OAuth attempts;
- attempt expiry and terminal retention;
- code/auto modes;
- refresh;
- credential persistence;
- connection events.

OpenFork additionally has:

- multiple-account preservation;
- active selection;
- per-credential refresh locking and re-read after lock acquisition.

The problem is ownership: Integration.Service is a **location node**. Its method registry is built by the location/plugin runtime. Reusing it from global settings would either require a workspace Instance or reintroduce an implicit cwd fallback.

**Decision:** do not make the whole Integration service global and do not call its location API without an explicit directory.

Instead, extract/reuse the auth-attempt mechanics and OpenCode auth protocol beneath it.

### 5.4 Upstream OpenCode provider plugin

packages/core/src/plugin/provider/opencode.ts already contains the exact current donor implementation for:

- Console device OAuth;
- refresh;
- user/org hydration;
- OAuth metadata;
- service-account key option;
- remote /api/config retrieval;
- application of returned providers/models to the current catalog.

This is the primary semantic oracle for the "/connect" port.

Do not fork a second handwritten implementation of the HTTP contract.

### 5.5 Account.Service

packages/opencode/src/account/account.ts and account/repo.ts form a second upstream-derived Console account system.

It is process/global and currently owns:

- device login;
- token polling;
- refresh;
- durable account rows;
- account list/remove;
- active account + active org;
- user/org lookup;
- remote /api/config;
- retained CLI account commands.

Its durable account table stores access and refresh tokens directly.

This overlaps the provider OAuth flow at the **remote protocol** level, but it has a broader control-plane purpose than a provider credential connection.

**Decision for this port:**

1. do not delete Account.Service;
2. do not make provider connect write the same OAuth grant into both AccountTable and CredentialTable;
3. factor the shared remote protocol so Account.Service and provider auth stop maintaining divergent HTTP/OAuth implementations;
4. treat a provider-connect OAuth grant as Credential-owned;
5. treat an explicitly created Console control-plane login as Account-owned until a separate, proven storage-convergence migration is executed.

This prevents refresh-token rotation races caused by duplicating one grant into two independent token stores while keeping the first port bounded.

### 5.6 Fork Zen/Go credential pool

packages/opencode/src/fork/credentials.ts and packages/opencode/src/plugin/zen.ts currently own the live V1 Zen/Go API-key pool.

Important behavior already present:

- multiple Zen/Go API keys;
- user labels;
- active/default key;
- deterministic zen-* account identity;
- explicit model-account suffix routing;
- fail-closed explicit account resolution;
- Go direct-auth precedence;
- Zen pool/default precedence;
- authorization header rewrite;
- per-message account attribution;
- 402/429 account state;
- usage/quota/capacity integration.

This system is API-key shaped and cannot safely absorb OAuth by simply replacing key with access token.

**Decision:** preserve it unchanged through the first Console-OAuth cut. Converge storage only after the new flow is working end-to-end.

### 5.7 Bootstrap-free provider settings

packages/opencode/src/server/routes/instance/httpapi/groups/provider-settings.ts and handlers/provider-settings.ts are already the correct local ownership direction:

- process/global;
- no workspace/plugin bootstrap;
- global provider projection;
- Core Credential-backed key add;
- credential rename/remove/select;
- generated SDK surface;
- Authorization middleware.

This API is fork-owned. It is the correct host for global provider-auth endpoints.

### 5.8 Connect dialog gap

packages/app/src/components/dialog-connect-provider.tsx already contains upstream's OAuth UX and polling states.

However, OpenFork deliberately changed global/no-directory behavior:

- a directory-scoped provider can use Integration OAuth;
- a global provider falls back to API key;
- attempting OAuth globally is prevented because it would otherwise require an unsafe missing-location path.

This is correct defensive behavior today.

**The port should remove the limitation by adding a real global auth backend, not by undoing the guard.**

### 5.9 OpenChamber comparative precedent

OpenChamber's OpenCode 2 integration validates one important ownership principle while
also showing why its topology cannot simply be copied into OpenFork.

Observed OpenChamber design:

- it runs/manages an actual OpenCode 2 server;
- ordinary `/api/*` traffic, including `/api/integration/*` and `/api/credential/*`, is
  forwarded to that server;
- OpenCode 2 therefore owns provider OAuth attempt lifecycle and Credential persistence;
- OpenChamber removed normal credential writes from its own legacy auth layer;
- for ancillary features that need raw secret material but cannot get it from OpenCode's
  HTTP API, OpenChamber opens OpenCode's `credential` table read-only and projects the
  selected credential into its legacy internal shape;
- that private-DB read is explicitly a compatibility escape hatch, not a competing
  credential store.

Lessons to adopt:

1. **One credential authority.** OpenFork should not maintain a second OAuth token store
   or independent refresh lifecycle beside Core Credential/Integration.
2. **Reuse upstream auth semantics rather than translating secrets through legacy
   `auth.json`.**
3. **Do not copy OpenChamber's direct SQLite secret reader.** OpenFork is inside the same
   codebase and can call typed trusted Credential services directly.
4. **Do not copy OpenChamber's runtime topology.** OpenChamber solves V2 auth by also
   executing through the V2 OpenCode server. OpenFork intentionally preserves V1
   execution, so it still requires the V2-auth -> V1-provider bridge in this plan.

This comparative result is one reason §7 now extracts a shared Integration auth kernel
instead of introducing a parallel `ProviderAccountAuth` implementation.

## 6. Hard invariants

The implementation is wrong if any of these become false.

### 6.1 Ownership

- Provider/account auth metadata is Tier 0.
- Listing auth methods creates zero Instances.
- Starting device auth creates zero Instances.
- Polling auth creates zero Instances.
- Refreshing a credential creates zero Instances.
- Selecting/removing/renaming a global credential creates zero Instances.
- V1 remains the production execution runtime.

### 6.2 Compatibility

- Remote OpenCode Console requests preserve upstream endpoint, body, header, polling, refresh, and error semantics.
- Local API shape does not need to match upstream.
- Upstream current/V2 local runtime is a donor/reference, not the OpenFork destination.
- OpenCode remote-service names may remain where they identify the upstream service.

### 6.3 Secrets

- List/projection APIs never return key/access/refresh token bytes.
- UI never receives stored secret values after creation.
- OXP never receives secrets.
- model IDs never contain secrets.
- logs and errors never contain secrets.
- explicit account routing fails closed.

### 6.4 Multi-account

- Adding a new account never replaces an unrelated existing account.
- Selecting an account changes only the intended integration's active credential.
- labels are presentation data, never routing identity.
- credential row ID and provider account identity remain distinct concepts.
- refresh-token rotation preserves the durable local connection and provider account identity.

### 6.5 Existing Zen/Go behavior

- Zen explicit @zen-* routing remains authoritative.
- missing explicit Zen accounts fail closed.
- Go never falls through to anonymous/public auth.
- the routed account remains the one charged/attributed by usage, quota, and capacity.
- stale auth.json cannot silently shadow a deliberate pool selection.

### 6.6 Public free-model access is a first-class product contract

The OpenCode provider has two fundamentally different eligibility modes and the auth port
must preserve both:

~~~text
PUBLIC FREE
  no user credential required
  -> provider bootstrap uses the upstream "public" sentinel
  -> only models proven zero-cost/public are eligible
  -> no ProviderAccount/accountID is fabricated
  -> usage attribution records routeKind=public

AUTHENTICATED
  selected Credential / ProviderAccount
  -> resolve + refresh exact credential
  -> account/org-specific /api/config
  -> account-specific model/endpoint/entitlement eligibility
  -> exact account attribution
~~~

Hard invariants:

- connecting an OpenCode Console account must **not** be required to use the current
  public free-model lane;
- disconnecting the last credential must leave eligible public free models usable;
- adding OAuth must not accidentally disable, hide, or reroute public free models through
  an invalid account;
- `opencode-go` remains non-public and must never inherit the Zen public sentinel;
- a public request carries no credential handle or accountID and cannot be charged to a
  stored account;
- an explicitly account-pinned Session must not silently fall back to public;
- a healthy existing account-bound Session does not silently jump to public merely
  because the selected model is free;
- automatic fallback from an account route to public is allowed only if a documented
  provider policy explicitly enables it and the model is independently proven public;
- a `FreeUsageLimitError` on the public route is public-lane quota state, not an account
  auth failure;
- `FreeTierError`, `MissingSessionID`, or equivalent request-admission rejection must not
  cause credential rotation or public/account hopping by themselves.

The implementation is not complete until a currently advertised free **language** model
(not only the Jev/System-One semantic primitive) succeeds end-to-end through the real V1
OpenFork generation path while no OpenCode credential is configured.

### 6.7 Hosted model availability and trusted catalog metadata are separate

The live Zen `/v1/models` endpoint is the authority for what the hosted gateway currently
advertises, but it returns model identity/availability rather than the complete trusted
metadata OpenFork needs for safe generation.

Therefore:

- live `/models` answers **"is this ID currently advertised?"**;
- Models.dev / authenticated Console config / explicitly maintained compatibility
  metadata answer **"how may OpenFork safely construct this model?"**;
- never fabricate context limits, adapter package, modalities, tool support, variants,
  or paid/free cost merely from a model-name suffix;
- reconcile the two surfaces and expose drift diagnostically;
- trusted execution metadata is always required; hosted availability then has an explicit
  freshness state rather than a boolean;
- retain narrow synthesis only for protocols that OpenFork explicitly understands, such
  as the existing Jev/System-One compatibility path.

Use four hosted-catalog states per model/provider snapshot:

~~~text
never-seen  no successful hosted observation exists
fresh       last successful /models observation is within the refresh TTL
stale       last-known-good observation is older than TTL but within bounded grace
expired     last-known-good observation exceeded the automatic-use grace
~~~

Initial policy:

- keep the existing 5-minute discovery TTL as the fresh window;
- use a bounded automatic stale grace (proposed initial value: 6 hours) so transient
  `/models` outages do not erase the free catalog;
- `fresh` and `stale` may participate in Auto routing; stale always triggers
  single-flight background revalidation;
- `expired` is excluded from **Auto** public routing, but remains visible as stale history;
- an explicit **Public free** selection against `expired` may force one revalidation and,
  if the catalog service itself remains unavailable, may make one last-known-good public
  attempt because no paid credential can be charged. Failure is surfaced as a typed
  public-catalog/model-unavailable result and does not account-hop;
- `never-seen` is never inferred public solely from `-free`, zero local cost, or docs;
- a successful current `/models` response that omits an ID immediately removes that ID
  from public eligibility regardless of stale grace;
- a public-bound Session whose model is affirmatively removed fails with typed
  `public-model-unavailable`; it does not silently move to an account route.

As of the 2026-09-25 planning audit, the live public Zen endpoint advertised a broad
catalog including multiple `*-free` IDs, while the official Zen documentation separately
listed a set of limited-time free models. Those two public surfaces were not identical.
The checked repository test fixture also had full zero-cost metadata for only a subset of
today's hosted free IDs (for example `deepseek-v4-flash-free`, `mimo-v2.5-free`, and
`nemotron-3-ultra-free`). Production builds do refresh Models.dev independently, so the
fixture is evidence of drift risk rather than the production source of truth.

#### Free-model coverage contract

The product goal is not merely "one free model works." It is:

First define **trusted free classification** correctly:

- the current V1 loader's `value.cost.input === 0` check is insufficient and must not be
  the new public-eligibility predicate;
- when cost metadata is the evidence, every known billable component/tier must be zero:
  input, output, cache read/write, and any context-tier override;
- missing/unknown cost is not equivalent to zero;
- an explicit source-backed upstream `public/free` classification may establish free
  promotional status even when generic base-model pricing exists elsewhere, but it must
  be attached to the exact hosted model ID/variant;
- public transport never inherits pricing from a similarly named paid base model;
- free classification is keyed to the exact OpenCode provider + hosted model ID and,
  where a variant can change billing/transport eligibility, the exact variant;
- aliases/family names are never eligibility keys;
- the public sentinel itself prevents account billing, but local eligibility/display/
  Usage must still classify the model accurately.
- every model the current upstream Zen product explicitly identifies as a free **language**
  model and the live hosted catalog currently advertises must have either:
  1. current trusted Models.dev metadata; or
  2. a narrow source-backed OpenCode compatibility metadata row maintained by this
     provider adapter while Models.dev lags;
- no such model may disappear silently from OpenFork's picker;
- missing metadata is a named `catalog-drift/missing-metadata` condition and a release
  checklist failure for the OpenCode integration, not an invitation to fabricate fields;
- provider models that merely contain `-free` but are not corroborated by trusted free
  metadata/documentation are not automatically classified free;
- `inputCost === 0` by itself is never the free predicate;
- stealth/free models whose names do not contain `-free` are supported when the trusted
  metadata says zero-cost/public and the hosted catalog advertises them.

P0F should materialize a machine-readable coverage fixture:

~~~text
provider + hosted model ID (+ variant when variant can affect transport/billing)
  + trusted free/not-free classification for that exact hosted route
  + trusted execution metadata source
  + hosted freshness
  -> supported public / not public / metadata drift
~~~

Fixture/unit coverage should be 100% for the current documented free-language set.
Real-network release smoke tests should exercise representative public models plus any
new metadata adapter/transport family; they do not need to call every free model on every
build. The initial P0F qualification should manually exercise every currently documented
free language model once so unsupported outliers are discovered before cutover.

#### 2026-09-25 P0F starting snapshot — evidence only

Sources inspected on 2026-09-25:

- `https://opencode.ai/docs/en/zen/` endpoint/pricing tables;
- `https://opencode.ai/zen/v1/models` live hosted model-ID list.

The Zen pricing table explicitly marked these **language** routes Free:

- `big-pickle`;
- `space-bunny-free`;
- `mimo-v2.6-flash-free`;
- `mimo-v2.5-free`;
- `ling-3.0-flash-fin-free`;
- `nemotron-3-ultra-free`;
- `nemotron-3.5-lightning-free`;
- `muse-spark-1.3-contributor-free`.

It separately marks `jev-1.13-free` free, but Jev is a **System One** primitive rather
than a conversational language model and remains on its dedicated qualification path.

The live `/v1/models` list also advertised IDs including:

- `deepseek-v4-flash-free`;
- `muse-spark-1.2-contributor-free`.

Those extra IDs were **not** members of the inspected documentation's explicit free
pricing set. `/v1/models` itself supplies identity/availability, not price/free metadata.
Therefore their names are not sufficient to classify them public. They enter the normal
coverage resolver and become public only if exact provider/model trusted metadata or
another source-backed compatibility row establishes the free public route.

This snapshot is intentionally not a runtime allowlist. P0F regenerates/revalidates its
coverage evidence against current upstream sources.

#### Build/release coverage gate

`packages/opencode/script/generate.ts` already refreshes Models.dev and embeds the result
into the build, with a local cache fallback. That is useful, but a successful build must
not silently mean "whatever metadata happened to be cached is good enough."

Add a deterministic release validation step **after catalog generation**:

~~~text
committed source-backed free coverage fixture
  + generated/embedded exact OpenCode provider metadata
  + maintained compatibility metadata rows
  -> coverage validation
~~~

Requirements:

- release CI fails if any committed current free-language route lacks safe execution
  metadata after generation;
- the check inspects the generated data that will actually be compiled, not the old
  repository test fixture;
- normal developer/offline builds may use a cached Models.dev payload, but they emit a
  visible drift warning when committed coverage cannot be satisfied;
- CI that claims release qualification must not downgrade that failure to a warning;
- updating the committed coverage fixture requires source evidence/date and review;
- compatibility rows are narrow per exact provider/model[/variant] and include their
  source/provenance; they are removed when Models.dev catches up;
- runtime live `/models` discovery can make a previously covered model unavailable, but
  it cannot manufacture missing build-time execution metadata.

Do not scrape/parse human Zen documentation on every application startup. Documentation
is release-audit evidence; runtime uses validated metadata + the structured hosted model
endpoint.

## 7. Proposed component model

### 7.1 Shared OpenCode Console remote-auth adapter

Extract the duplicated Console HTTP/OAuth logic into one non-UI, non-workspace module.

Suggested ownership:

- packages/core/src/provider/opencode-console-auth.ts
  or
- a sibling provider-specific Core module near packages/core/src/plugin/provider/opencode.ts.

The exact filename is secondary. The ownership requirements are not.

The module should expose typed operations equivalent to:

- startDeviceAuthorization(server);
- pollDeviceAuthorization(login);
- refreshOAuth(credential);
- getUser(accessToken, server);
- getOrganizations(accessToken, server);
- getProviderConfig(accessToken, server, orgID).

It owns:

- OpenCode Console endpoint construction;
- client ID;
- request/response schemas;
- OAuth error classification;
- verification URL validation;
- poll-delay semantics;
- token refresh semantics;
- remote user/org schemas.

It does **not** own:

- Credential persistence;
- account selection;
- workspace/plugin state;
- provider catalog mutation;
- UI;
- OXP;
- quota;
- scheduling.

Then:

- current Core OpencodePlugin consumes this adapter;
- Account.Service consumes this adapter;
- the global Integration auth registry/kernel consumes this adapter.

This eliminates independently drifting copies of the same upstream contract.

### 7.2 Extract one reusable Integration auth kernel

The OpenChamber comparison sharpens the ownership decision: do **not** build a second
provider-auth lifecycle beside Core Integration if the existing Integration mechanics can
be factored into a global-safe kernel.

Current `Integration.Service` is a location node primarily because its **method registry**
is populated by location/plugin execution. Its credential persistence, attempt lifecycle,
connection mutation, refresh semantics, and event dependencies are otherwise compatible
with Tier-0 ownership.

Refactor Core Integration so one internal factory/kernel owns:

- connection projection over Core Credential;
- key connect;
- OAuth attempt creation/status/complete/cancel;
- pending/completing/terminal transition rules;
- attempt expiry/retention/scrub;
- scope cleanup;
- credential settlement;
- rename/select/remove;
- connection events;
- delegated credential refresh through the shared resolver.

Conceptually:

~~~ts
makeIntegrationAuthRuntime({
  registry,        // integration + auth method registrations
  credentials,
  credentialResolver,
  events,
  scope,
}) -> IntegrationAuthRuntime
~~~

The existing location-scoped `Integration.Service` composes this kernel with its
plugin/location-owned registry. A new Tier-0/global auth surface composes the **same
kernel** with a deliberately small global registry.

This gives us OpenChamber's strongest property — one auth authority — without adopting
OpenChamber's external-process proxy topology or migrating OpenFork execution to V2.

### 7.3 Global Integration auth registry, not a parallel auth subsystem

Create a bootstrap-free global registration owner in Core or packages/opencode that
contains only auth methods safe outside a workspace. Initial registration:

- integration/provider ID: `opencode`;
- name: OpenCode Console;
- OAuth method: `device` / OpenCode Console account;
- key method: API key (service account);
- OAuth implementation: the same extracted OpenCode Console registration used by the
  current Core `OpencodePlugin`.

Expose the global runtime through the fork-owned provider-settings API rather than
pretending the whole upstream `/api/integration/*` local API must be preserved.

Conceptual API:

~~~ts
methods(providerID) -> safe method descriptors
connections(providerID) -> safe connection descriptors

oauth.start({ providerID, methodID, inputs?, label? }) -> Attempt
attempt.status(attemptID) -> AttemptStatus
attempt.complete(attemptID, code?) -> void
attempt.cancel(attemptID) -> void

credential.select(id) -> void
credential.rename(id, label) -> void
credential.remove(id) -> void
~~~

Hard boundary: the global registry may never discover methods by materializing a
workspace Instance or executing arbitrary location plugins. A provider auth method is
globally available only if it is explicitly registered as Tier-0-safe.

On successful OpenCode OAuth settlement, the shared Integration kernel:

1. receives the typed OAuth Credential from the OpenCode registration;
2. persists one new Core Credential under integrationID `"opencode"`;
3. derives the label from explicit user label or the registration's metadata label;
4. preserves all existing credentials;
5. publishes the normal Integration connection events;
6. invalidates account/config capability snapshots for that integration;
7. never instantiates workspace/plugin state.

Selection remains explicit product policy. Current fallback semantics are: an explicit
`active=true` row wins; with no explicit active row, current Integration reverses the
time-created list and effectively chooses the newest connection. Preserve or deliberately
change that rule, but add a deterministic secondary ID tie-break for same-millisecond
creation and test it as a contract.

Do **not** leave a permanent `ProviderAccountAuth` implementation duplicating attempt,
refresh, and persistence semantics. If an interim shim is required to land safely in the
dirty tree, it must delegate to the shared kernel and carry a removal task.

### 7.4 Credential-backed refresh resolver

Global provider credential resolution needs one shared refresh path.

Do not let:

- current Integration;
- V1 Console provider adapter;
- quota;
- UI probes

each refresh the same OAuth credential independently.

Create one trusted resolver around Credential.Service:

~~~ts
resolveCredential(credentialID) -> {
  value: Key | fresh OAuth
  revision: number   // trusted strictly-monotonic storage revision
}
~~~

Required behavior:

- read once;
- return keys directly;
- if OAuth has more than five minutes remaining, return it;
- otherwise enter a refresh critical section keyed by Credential.ID;
- re-read after acquiring refresh ownership;
- refresh only if still stale;
- persist rotated token material only if the credential state/version observed for the
  refresh is still current;
- return the fresh value **plus the post-resolution trusted row revision** used for
  provider-client cache isolation;
- the revision is internal infrastructure metadata, not part of ProviderAccount/UI/OXP;
- unrelated credentials remain concurrent.

The current OpenFork Integration implementation is the **single-process behavioral
oracle**: keyed semaphore + re-read after lock acquisition. P2 must establish whether
that is also the deployment-level correctness boundary.

#### Refresh ownership across runtimes/processes

After P3, global and location-scoped Integration runtimes can resolve the same credential.
They must share the same resolver instance inside one process; separate per-Integration
semaphores are insufficient.

For multiple OS processes sharing one Credential database, choose exactly one supported
contract:

1. **single credential-writer process** — prove/enforce that only one process may refresh
   or mutate Credential rows, and other processes delegate resolution to it; or
2. **storage-level refresh ownership** — add a bounded lease/revision/CAS mechanism so
   only one process can refresh one stale Credential at a time.

If storage-level ownership is required:

- do not hold a SQLite transaction open across the remote token HTTP request;
- acquire a short durable refresh lease with owner + expiry + expected credential
  revision;
- perform the network refresh outside the transaction;
- persist the rotated value with compare-and-swap on expected revision/lease ownership;
- a loser re-reads the winner's fresh credential instead of overwriting it;
- crashed refresh owners become recoverable after the bounded lease expires;
- secret bytes and refresh tokens never appear in lease/diagnostic rows.

Do not introduce this machinery speculatively if OpenFork guarantees a single writer.
But that guarantee must be an architecture/tested invariant, not an assumption.

Core Integration, global Integration auth, V1 provider execution, quota probes, and
other trusted consumers must all call this one resolver instead of owning private refresh
locks.

### 7.5 ProviderAccount projection

Create a compact secret-free projection that becomes the shared account identity surface.

Conceptually:

~~~ts
type ProviderAccount = {
  providerID: string
  credentialID: Credential.ID
  accountID: string
  label: string
  active: boolean
  authType: "key" | "oauth"
  source: "credential" | "fork-vault" | "env" | "legacy"
  metadata?: {
    email?: string
    remoteUserID?: string
    orgID?: string
    orgName?: string
    server?: string
  }
}
~~~

Important distinction:

- credentialID = mutable local storage handle;
- accountID = stable routing/accounting identity;
- label = mutable UI text.

For OAuth, account identity must derive from upstream stable identity, including organization when organization changes billing/config semantics.

For Zen/Go API keys with no remote stable identity, preserve the existing secret-derived zen-* identity internally. Never expose the secret itself.

The projection may initially compose multiple sources instead of forcing a risky immediate migration:

1. Core Credential;
2. fork_credential;
3. environment connections;
4. legacy Auth fallback.

This gives consumers one account surface before old stores are retired.

### 7.6 Shared provider-neutral router is the selection authority

The multi-credential router work is not superseded by upstream Console OAuth. It is the
missing selection layer that should sit **after credential enrollment and before
transport**.

Relevant prior work already exists on `hosted-mt-t10c-cert`:

- `2caf5abd1f` — `docs/plans/multi-credential-routing/ARCHITECTURE.md`, defining the
  provider-neutral multi-credential architecture;
- `15d9873b52` — `packages/opencode/src/provider/account-router.ts`, implementing a
  pure router plus tests/benchmark.

That donor is a **policy engine prototype, not a completed routing subsystem**. A branch-wide
consumer search finds no production caller: only the router itself, its tests, and its
benchmark reference `ProviderAccountRouter`. Its bindings, round-robin cursor,
assignment counts, active-session counts, and concentrate-mode history are all in-memory
Maps. A process restart therefore forgets affinity and policy history, and synchronous
JavaScript mutation is atomic only inside one process.

Do not blindly cherry-pick it across the dirty, diverged tree. Forward-port the useful
selection semantics only behind a durable owner that provides:

- persisted session/account bindings where session affinity is intended to survive restart;
- persisted or reconstructible round-robin/concentrate state where policy continuity matters;
- compare-and-swap mutation that is valid across every process that can route the same
  session, not merely one JS event loop;
- lifecycle reconciliation so active-binding capacity cannot leak when Sessions are
  archived/deleted/crash-recovered;
- a trusted candidate-set boundary that rejects cross-provider/cross-affinity-domain
  candidates before policy ranking.

Preserve these locked semantics from the donor when forward-porting:

- stable opaque credential handles;
- session affinity;
- `concentrate` and `session-round-robin` policies;
- explicit hard/soft pins;
- typed health/eligibility;
- capacity gates;
- deterministic selection;
- compare-and-swap route revision on failover;
- no secret material and no network/storage I/O inside the router;
- no mid-stream credential switching.

The ownership law is:

~~~text
enrollment/authentication
  -> durable Credential
  -> secret-free ProviderAccount/candidate projection
  -> shared ProviderAccountRouter
  -> selected credential handle
  -> trusted Credential resolver/refresh
  -> provider transport
  -> exact routed account attribution
~~~

Upstream OpenCode auth therefore supplies **accounts to the router**. It does not become
a second router.

For a Console OAuth account:

- the router uses a **stable opaque credential handle** that survives secret refresh.
  The existing `Credential.ID` is a valid first implementation because refresh updates
  the row in place, but do not make row identity an irreversible public contract: an
  import/reconciliation or remove/re-enroll operation may replace a row later. If durable
  bindings must survive such migration, introduce an explicit stable handle/mapping;
- remote user/org identity produces `ProviderAccount.accountID` for accounting,
  entitlement, and UI correlation;
- token refresh updates secret/version material **without changing the handle or healthy
  session affinity**;
- refresh/auth failure updates that account's candidate state;
- authenticated `/api/config`, quota, and entitlement data update
  `servesModel`, quota/cooldown/reset, and other secret-free candidate facts;
- the router never receives the access token, refresh token, API key, or Authorization
  header.

Keep `credentialHandle` and `accountID` distinct. A single remote account/org may
rotate secrets while retaining both identities; conversely, a local credential row may
need replacement/migration without rewriting historical remote-account attribution.

#### Transitional Zen/Go adapter

The existing Zen pool currently uses a secret-derived `zen-*` identity and owns
selection itself. During convergence:

1. preserve `zen-*` as a compatibility/account alias so existing model suffixes,
   persisted selections, and historical usage continue resolving;
2. after a key is represented by a canonical Credential row, use its stable opaque
   credential handle for router/cache identity;
3. map the compatibility `zen-*` alias to that handle at the account-resolution
   boundary;
4. feed Zen account health/quota into the same generic candidate shape;
5. move policy selection out of `ZenAccountPool` and into the shared router only after
   parity tests pass.

Do not encode OAuth-versus-key differences into the generic policy engine. Provider
adapters own enrollment, refresh, endpoint selection, entitlement probes, and failure
classification. The router owns only **which eligible handle this session uses**.

#### Affinity domains

The router already supports an explicit `affinityDomain`. Use this deliberately.

Do not assume `providerID === affinityDomain` for OpenCode-hosted services. If
`opencode` and `opencode-go` genuinely share the same credential/account authority,
they may intentionally share an affinity domain; if Console `/api/config` exposes
distinct credential or org semantics, they must remain independent. P0 fixtures must
decide this from the live remote contract rather than from provider naming.

### 7.7 Account-specific remote config is required for multi-account routing

Upstream's current `OpencodePlugin` is intentionally **active-account oriented**:

~~~text
integration.connection.active("opencode")
  -> resolve one credential
  -> GET /api/config for that credential/org
  -> project one provider catalog
~~~

That is correct for upstream's single-active-account execution semantics, but it is not
sufficient once OpenFork's router can choose among N credentials per Session. If account
A and account B have different organizations, entitlements, endpoints, model lists, or
provider options, a global catalog hydrated from A must never be used as proof that B can
serve the same model or wire contract.

Introduce an account-scoped capability/config projection:

~~~text
credentialHandle
  -> resolved credential + org
  -> bounded /api/config snapshot
  -> provider/model capability map
       servesModel(model)
       endpoint/protocol/package
       request headers/options
       cost/limits/status
  -> generic router Candidate
~~~

Requirements:

- refresh/fetch the snapshot per account on enrollment, relevant credential/org mutation,
  bounded expiry, or an adapter-classified stale-config response — not on every request;
- keep secrets out of the snapshot;
- merge account/public capability snapshots into one user-facing **discovery catalog**
  without duplicating N copies of every model merely because N routes serve it;
- the merged discovery row is never the billing/execution authority when route definitions
  differ. It may expose safe route summaries such as `Public free`, account availability,
  and route-specific price/limit hints, but it must not collapse incompatible costs/
  limits/endpoints into one supposedly authoritative value;
- retain route/account capability indexes so routing filters `servesModel` and transport
  construction against the **selected route's** snapshot;
- if two accounts advertise materially incompatible transport definitions for the same
  provider/model ID, represent that as explicit account-scoped route capability rather
  than silently choosing the active account's definition;
- invalidate only the affected account snapshot where possible;
- never let an active/default account switch rewrite the capabilities or historical
  attribution of already-bound Sessions.

The generic router consumes the resulting secret-free candidates. It must not fetch
`/api/config` itself.

#### 7.7.1 Resolve route before materializing the execution model/client

The current V1 call order is partly backwards for first-class multi-account/public
routing:

~~~text
provider.getModel(providerID, modelID, accountID?)
  -> concrete Provider.Model
  -> provider.getLanguage(model)
  -> cached language client
  -> LLM.stream(...)
~~~

Today the legacy account-qualified model ID (`model@zen-*`) allows account choice to
affect that early concrete model/cache lookup. Once account identity moves out of model
IDs, choosing the route **after** `Provider.Model` materialization would be unsafe:

- account A and B may advertise the same visible model ID with different endpoint, npm
  adapter, headers, options, limits, or variants;
- the public route may use Zen public transport while an authenticated account's
  `/api/config` routes the same visible model somewhere else;
- one global language-client cache entry could capture the wrong account/route config.

Introduce one trusted execution-resolution boundary, conceptually:

~~~ts
resolveExecution({
  sessionID,
  providerID,
  modelID,          // account-neutral visible ID
  routeIntent?,
}) -> {
  route: ProviderRoute
  model: ConcreteExecutionModel
  attribution: RouteAttribution
  clientCacheIdentity: string
}
~~~

Resolution order:

~~~text
account-neutral selected model
  -> read/commit ProviderRoute binding
  -> verify selected route serves model
  -> materialize route-specific provider/model config
       public  -> trusted base metadata + public hosted capability
       account -> selected account's /api/config snapshot
  -> construct/reuse route-scoped provider/language client
  -> LLM request prep/transport
  -> settle with the same RouteAttribution
~~~

Requirements:

- the user-facing catalog stays account-neutral and deduplicated;
- `Provider.Model` used for execution is allowed to be route-specific/internal even when
  the visible provider/model ID is the same;
- route selection occurs once per bind/rebind boundary, not once per provider SDK helper;
- execution model construction is deterministic from `(base model, route capability
  snapshot version, non-secret config identity)`;
- route-scoped client cache keys include at minimum providerID, route identity
  (`opencode:public` or credentialHandle), credential/config version, and non-secret
  provider config identity;
- no cache key relies on label, email, access-token/API-key bytes, Authorization headers,
  or legacy suffix text;
- replace the current `resolveSDK()` raw-`options` JSON hash as the routing identity.
  Function-valued route-specific `fetch` is omitted by JSON serialization, while secret
  apiKey/header bytes may otherwise influence the hash accidentally;
- `resolveExecution()` must supply a non-secret `clientCacheIdentity` derived from:
  providerID + concrete adapter/package/protocol identity + route kind +
  (`opencode:public` OR credentialHandle/revision) + route capability/config snapshot
  version + relevant secret-free transport config identity;
- use that same route-scoped identity consistently for both SDK factory caching and
  language-model instance caching; do not keep `providerID/model.id` as a second weaker
  cache key;
- credential token/key rotation advances revision and therefore invalidates only that
  account's authenticated client without hashing secret material;
- public catalog/config version changes invalidate only affected Public clients;
- do not implement revisioning as an ever-growing map key. Prefer a stable cache slot
  keyed by provider + visible/concrete model + stable route identity, with the entry
  carrying the current credential revision/config version. On mismatch, rebuild and
  replace that slot atomically; explicit generational keys are acceptable only with
  prompt eviction of prior generations;
- credential removal purges that handle's SDK/language clients; account config invalidation
  purges only that route; public capability-version change purges affected public slots;
- bound the route-scoped client caches or prove their cardinality is bounded by active
  provider/model/route slots. Token refresh must not cause monotonic memory growth;
- if the selected route no longer serves the model, invoke the documented route/model
  compatibility rebind policy **before** client construction or fail typed; do not
  discover this by accidentally hitting another account inside fetch;
- special-agent/small-model/compaction resolution must call the same execution resolver
  when they execute a hosted model, rather than rebuilding active-account semantics.

#### Route-specific pricing, limits, and capability authority

`ConcreteExecutionModel` returned by `resolveExecution()` is the authority for:

- provider endpoint/package/protocol;
- request headers/options/variant lowering;
- context/input/output limits;
- tool/modalities/status capability;
- local cost estimation and Usage settlement inputs.

Public route construction uses the trusted public metadata/capability row for that exact
hosted model. Account route construction uses the selected account/org `/api/config`
snapshot. If the same visible model is free publicly but priced differently through an
account, those are two route-specific execution definitions behind one visible model ID.

Hard rules:

- settling an account request must never reuse a zero-cost public catalog row;
- settling a public request must never inherit an account's paid cost definition;
- Usage stores the committed route attribution alongside the resulting cost/tokens;
- if the upstream response supplies authoritative served-model/billing metadata, retain it
  as observed evidence, but do not silently change route identity;
- UI may say **Free via Public** while separately showing account route pricing; when
  multiple account snapshots disagree, display route-specific information rather than a
  fabricated single price;
- account-neutral sorting/search may use a presentation price only if labeled/derived
  explicitly; execution never consumes that presentation value.

This boundary is the safest place to eliminate the current accidental relationship
between `provider.getModel(...accountID)`, model suffixes, and authenticated client cache
identity.

### 7.8 First-class account identity must replace accidental suffix/cache coupling

OpenFork already has the correct public/persistence direction:

~~~text
providerID + account-neutral modelID + optional accountID + variant
~~~

`ModelV2.Ref` and V1 Session persistence can already carry `accountID` separately.
OXP also documents that its public model selection is account-neutral.

But several compatibility layers still assume account identity is encoded into the model
ID:

- `MULTI_ACCOUNT_PROVIDERS.opencode` and `opencode-go` accept only the legacy
  `zen-` account prefix;
- `OxpModelSelection.materialize()` rejects an explicit account that does not start
  with that prefix and lowers it back into `model@zen-...`;
- `Provider.getModel()` still converts first-class account selection into the
  provider-qualified model-ID ABI;
- `Provider.getLanguage()` caches language models by `providerID/model.id`.
  Today account-qualified model IDs accidentally make those cache keys account-specific;
- `SystemOne.infer()` independently calls `resolveZenRequest()` and therefore can bypass
  the durable route resolver entirely.

Do not assign Console OAuth identities a fake `zen-` prefix merely to fit this ABI.
Instead:

1. keep `accountID` first-class and provider-neutral in Session/OXP/scheduler/special-agent
   state;
2. preserve `@zen-...` lowering only inside the legacy Zen adapter while it remains
   necessary;
3. teach account resolution/materialization that newer provider accounts may have opaque
   IDs/handles not derivable from a provider prefix;
4. include the selected **credential handle** in every authenticated provider/language
   client cache key before removing account-qualified model IDs;
5. ensure cache invalidation is handle/version scoped so rotating account A cannot evict
   or reuse account B's authenticated client;
6. never use mutable label text or remote email as the cache/routing key.

This is a required cutover ordering: removing the suffix before making client-cache
identity handle-aware would create a cross-account credential leak.

### 7.9 Public-route resolver for free OpenCode models

Do not force the credential router to pretend that the anonymous/public Zen lane is a
user account. Introduce a small provider-route layer above account selection:

~~~ts
type ProviderRoute =
  | { kind: "public"; providerID: "opencode"; routeID: "opencode:public" }
  | { kind: "account"; providerID: string; accountID: string; credentialHandle: string }
~~~

Resolution order for OpenCode generation:

1. explicit account pin -> exact account route or fail closed;
2. explicit public pin -> `opencode:public` only if the model is independently public
   eligible; otherwise fail closed;
3. existing durable Session route binding -> preserve its route kind while still valid;
4. for an unbound Session, apply the provider-level free-route preference:
   - `public-first-for-free` (**OpenCode default**): when the selected model has a current
     trusted public capability, choose the genuine public route. If that public route is
     temporarily quota-exhausted/cooling-down or request-admission-rejected, surface that
     public-route state; do **not** silently use an account. If the model is affirmatively
     no longer a public capability, normal account routing may apply and the UI must no
     longer present it as Public free;
   - `account-first` (explicit compatibility override): choose through
     ProviderAccountRouter when an eligible account exists, otherwise use public when
     the model is public eligible;
5. otherwise fail with a typed no-eligible-route result.

OpenCode should default to `public-first-for-free` because selecting a model whose current
provider capability is explicitly **free/public** should not silently consume or bind a
user account merely because one exists. This is stronger than today's Zen pool behavior,
where a populated pool overrides the SDK `"public"` bootstrap sentinel.

Be precise about upstream parity: the current Core OpenCode provider plugin uses the
`"public"` sentinel only when it sees no configured key/active connection, and in that
anonymous state disables models with positive input cost. OpenFork's decision to keep/
prefer a deliberate public route **even while accounts also exist locally** is a
fork-owned routing/UX policy. The wire route itself remains the same upstream public
contract; we are not claiming upstream makes the same local selection choice.

The cutover is deliberately non-disruptive:

- existing durable Session bindings remain exactly where they are;
- explicit account pins remain strongest and fail closed;
- users who intentionally want account routing for free models can choose an account or
  set `account-first`;
- public quota/cooldown/admission failure under `public-first-for-free` never becomes an
  implicit paid/account request; and
- only new/unbound Auto routing changes.

Extend the existing shared router configuration rather than inventing an OpenCode-only
config domain:

~~~ts
type ProviderRoutingConfig = {
  defaultMode: "concentrate" | "session-round-robin"
  defaultFreeRoutePreference: "account-first" | "public-first-for-free"
  providers?: Record<string, {
    mode?: "concentrate" | "session-round-robin"
    freeRoutePreference?: "account-first" | "public-first-for-free"
  }>
}

// effective built-in default:
// providers.opencode.freeRoutePreference ??= "public-first-for-free"
// providers without a validated public lane ignore this setting.
~~~

`freeRoutePreference` is consulted only by provider adapters that actually expose a
validated public route; it is ignored by ordinary providers and by `opencode-go`.

Do not automatically fail over a bound/pinned account to public on rate-limit, quota,
auth, or request-policy errors. Cross-kind movement follows §7.10, not ordinary account
failover.

#### Hosted authority

Credential-free is not authority-free. In hosted/PresGen mode, extend the trusted
per-provider Session authority with an explicit public-lane permission, conceptually
`allowPublic`. The provider-route resolver may choose `opencode:public` only when:

- standalone/Desktop local policy permits it; or
- hosted trusted control authority explicitly permits it.

A hosted request cannot expand its authorized account pool by escaping to public, and a
client-supplied `public` selector is never itself authorization. Changing `allowPublic`
or the hosted free-route preference is an authority/policy change subject to the same
binding-version/capability rules as changing allowed credential handles.

Persisting the **route kind** matters. If a Session began on the public lane, adding an
OAuth account in Settings must not silently change the account/usage identity of the next
turn. Likewise, a Session bound to an account must not become public because the account
temporarily fails.

#### Public model catalog reconciliation

Add a bounded Zen public-catalog probe owned by the provider adapter, not the generic
router:

~~~text
trusted model metadata (Models.dev / maintained compatibility rows)
        +
successful recent GET https://opencode.ai/zen/v1/models
        =
public model eligibility / freshness projection
~~~

Recommended behavior:

- reuse the §6.7 `fresh` / `stale` / `expired` state machine rather than inventing a
  second boolean availability cache;
- keep the existing 5-minute freshness TTL; stale snapshots revalidate single-flight in
  the background;
- persist the **last validated successful** hosted model-ID snapshot in a small
  process-global, secret-free cache so stale-grace survives application restart;
- persist at minimum provider/route key, validated IDs, `fetchedAt`, schema/version, and
  optionally ETag/Last-Modified when the service supplies them;
- load that snapshot before the first network refresh and compute freshness from the
  recorded successful fetch time; never reset its age merely because the process restarted;
- replace it atomically only after a fully validated successful response; timeout, non-2xx,
  malformed JSON, or schema mismatch never overwrite last-known-good data;
- cap snapshot size/ID count defensively and reject absurd payloads;
- use strict response validation and a bounded timeout;
- never log credentials because this probe requires none;
- failed refresh preserves last-known-good data through the bounded stale policy rather
  than deleting every model;
- unknown hosted IDs are recorded as catalog drift but are not synthesized as language
  models without enough trusted metadata;
- trusted zero-cost models absent from a **successful current** hosted snapshot are
  immediately marked remotely unavailable rather than repeatedly attempted;
- zero cost in local metadata is necessary but not by itself sufficient proof of current
  public availability;
- a `-free` suffix is informative only; it is never the sole eligibility rule;
- public catalog state is provider capability data, not credential/account health.

Keep Jev's current System-One-specific discovery path until the generic reconciliation
service can represent semantic primitives without pretending they are language models.

#### Hosted request identity

Public and authenticated OpenCode requests must share one hosted-compatibility owner for
the request fields the upstream-operated service expects. P0F determines the no-credential
public contract; P0 determines authenticated/account parity. The implementation should then generate that contract from an
explicit upstream-compatibility version/source rather than from OpenFork's marketing
version string.

Do not solve free access by:

- inventing future OpenCode versions;
- injecting fake coding tools into maintenance-agent requests;
- converting a request-admission failure into account hopping;
- forcing OAuth;
- sending paid-account secrets on the public lane.

### 7.10 Durable route binding and historical attribution

`Model.Ref.accountID` is not sufficient to represent routing state. In particular,
`accountID === undefined` currently means both:

- no account has been selected/routed yet; and
- the request intentionally uses the public OpenCode lane.

Likewise, the legacy `fork_message_credential` table attributes old key-backed messages
but cannot represent a public route, and `usage_record.account_id IS NULL` currently
cannot distinguish public-by-design from missing attribution.

Create a fork-owned durable route ledger keyed by `(sessionID, affinityDomain)`. The
exact table/module name is secondary; conceptually the row is:

~~~ts
type DurableProviderRouteBinding = {
  sessionID: SessionID
  affinityDomain: string
  providerID: string
  routeKind: "public" | "account"

  // account route only
  accountID?: string
  credentialHandle?: string
  mode?: "concentrate" | "session-round-robin"
  pin?: "hard" | "soft"

  routeRevision: number
  assignedAt: number
  assignmentEpoch: number
  reason: "explicit" | "initial" | "failover" | "model-selection"
}
~~~

Persistence rules:

- composite primary key: `(session_id, affinity_domain)`;
- `session_id` references the live Session with delete cascade: route binding is
  operational state, not accounting history;
- archive does **not** delete a binding because archived Sessions can be resumed;
- `public` rows must have no accountID/credentialHandle;
- `account` rows must have the stable accountID + opaque credential handle required by
  the selected provider adapter;
- `route_revision` is the optimistic-CAS boundary for failover/manual rebind;
- ordinary request dispatch performs an indexed binding lookup; it must not rebuild
  routing history on every turn;
- public bindings do not participate in account round-robin cursor or account assignment
  counts.

The account-router's additional policy state also needs a durable owner:

- one cursor row per affinity domain (`epoch`, `lastAssignedHandle`) for
  session-round-robin;
- durable assignment count / last-assigned metadata where `concentrate` depends on
  historical use;
- active binding count is derived from the binding table, or updated transactionally with
  binding mutations and reconciled from bindings on startup. Never trust a process-local
  counter as a cross-process hard capacity gate.

Selection/failover mutation must be one database transaction with CAS. No provider
network I/O occurs while that transaction is open.

#### Cross-kind rebind semantics

Do not treat public/account as ordinary account failover candidates. Crossing route kind
is a user/product routing decision:

- transient auth/quota/rate-limit/admission failure never changes account <-> public;
- merely adding/removing/selecting credentials in Settings never changes an existing
  healthy binding;
- an explicit account selection may rebind public -> account;
- an explicit model selection that the current route cannot serve may cause a deliberate
  `reason=model-selection` rebind **only** through a documented provider-route policy;
- hard account pins fail closed;
- if no explicit cross-kind rebind policy applies, return a typed route/model
  incompatibility instead of silently changing identity.

#### Historical settlement

Extend durable Usage attribution so newly settled calls distinguish at least:

~~~text
route_kind = public   + account_id = NULL
route_kind = account  + account_id = <stable provider account>
route_kind = NULL     + account_id = NULL   // legacy/unknown only
~~~

`usage_record` is the natural owner for user-facing generation history; maintenance/yield
records need equivalent route/account identity where those calls can use hosted models.
Do not overload a fake `accountID="public"`: public is a route class, not a user
account.

Dispatch should carry a trusted internal `RouteAttribution` to settlement. Do not infer
public solely from the absence of `x-openfork-routed-account-id`, because a missing
header can also mean attribution was lost. For account routes, observed transport
metadata may validate the selected account, but the canonical expected identity comes
from the committed route binding used for dispatch.

### 7.11 Route once; transport must not secretly re-route

The current `routedZenProviderFetch()` still owns both **selection** and **transport**.
`resolveZenRequest()` intentionally replaces the SDK's `"public"` bootstrap sentinel
with the pool default whenever the Zen key pool is populated. That behavior is correct
for today's unbound routing but is incompatible with a durable public binding:

~~~text
Session bound routeKind=public
  -> SDK starts apiKey="public"
  -> current routedZenProviderFetch() sees populated pool
  -> silently replaces public with default account key   // WRONG after P5A
~~~

At the durable-routing cutover, split those responsibilities:

~~~text
ProviderRouteResolver
  -> commits public/account binding
  -> constructs/gets route-scoped provider client
      |
      +-- public client cache key includes routeID=opencode:public
      |     -> transport preserves Bearer public
      |
      +-- account client cache key includes credentialHandle/version
            -> trusted resolver supplies exact secret
            -> transport uses account-specific config/endpoint

Zen transport
  -> de-qualify legacy model suffix while adapter remains
  -> apply already-selected auth
  -> observe status/account evidence
  -> NEVER choose a different route
~~~

Implementation requirements:

- after P5A, no fetch wrapper calls `pool.defaultAccount()` or any generic router to make
  a second selection for an already-bound request;
- route-scoped provider client/cache identity includes public route ID or account
  credential handle so a public client can never be reused as an account client and vice
  versa;
- account secret resolution happens at the trusted transport boundary and can refresh
  without changing the route handle;
- the public transport explicitly preserves the upstream public sentinel even when
  accounts are present;
- Go rejects public during route resolution, before transport;
- legacy suffix de-qualification remains an adapter concern during migration, not a
  selection mechanism;
- retain a narrow compatibility fallback for old/unbound call sites only until every
  production V1 caller supplies ProviderRoute; instrument that fallback and remove it in
  P8.

This is essential to free-model correctness: merely persisting `routeKind=public` is not
enough if a lower fetch layer is still allowed to overwrite it.

## 8. Do not conflate provider OAuth with Account.Service

There are two valid user concepts:

### 8.1 Provider connection

"I want this OpenCode Console account available as an inference/provider connection."

Owner:

- Core Credential + ProviderAccount projection.

Selection changes provider routing.

### 8.2 Console control-plane session

"I am logged into an OpenCode Console account/org for remote configuration/control-plane behavior."

Current owner:

- Account.Service / AccountRepo.

Selection changes control-plane account/org.

These often refer to the same human identity but they are not automatically the same local operation.

The first auth-port tranche must therefore:

- share the remote protocol implementation;
- avoid duplicating a single refresh grant into two stores;
- keep selection semantics separate;
- avoid making a provider-account switch silently change the Console control-plane org;
- avoid making a Console org switch silently change a persisted provider/model account.

A later convergence can move Account.Service token persistence onto Core Credential if desired, but that is a separate schema/storage migration with its own proof gate.

## 9. Global HTTP/API design

Extend the existing provider-settings family rather than exposing location-scoped Integration routes globally.

Suggested fork-owned routes:

- GET /provider-settings/:providerID/auth
- POST /provider-settings/:providerID/oauth
- GET /provider-settings/oauth/:attemptID
- POST /provider-settings/oauth/:attemptID/complete
- DELETE /provider-settings/oauth/:attemptID

Exact naming can be adjusted to the existing generated-client conventions.

### 9.1 Safe auth-method response

The method response may contain:

- method ID;
- type;
- label;
- prompt descriptors.

It must never contain:

- callback closures;
- token state;
- keys;
- access tokens;
- refresh tokens.

### 9.2 Start response

Return the existing Integration.Attempt-compatible shape where useful:

- attemptID;
- URL;
- instructions;
- mode;
- created;
- expires.

Reusing the schema is preferable even though the local route is fork-owned.

### 9.3 Attempt status

Return only:

- pending;
- complete;
- failed + sanitized message;
- expired.

Do not proxy raw upstream error bodies that may contain sensitive data.

### 9.4 Authorization

Keep the existing local Authorization middleware.

The device verification URL is intended to leave the local app and open the upstream OpenCode page. All mutation/status endpoints remain protected local API operations.

### 9.5 Routing policy and explicit route intent API

Routing policy is Tier-0 user intent. A project/repository config must not be able to
select credentials, enable public fallback, or alter account routing.

Persist the shared routing config only in the process-global/user settings authority and
expose it through the provider-settings family, conceptually:

~~~text
GET   /provider-settings/routing
PATCH /provider-settings/routing
~~~

Safe response/input contains only:

- default account-routing mode;
- default free-route preference;
- per-provider overrides;
- no handles, keys, tokens, or secret-derived identifiers.

If the existing global config file is used as storage, the runtime must read this field
from `Config.getGlobal()`/the user layer only. Ignore/reject project/worktree values for
routing authority.

Explicit Session route intent is separate from `Model.Ref` and separate from global
policy. Use a typed server-owned action conceptually equivalent to:

~~~ts
type ProviderRouteIntent =
  | { kind: "auto" }
  | { kind: "public" }
  | { kind: "account"; accountID: string; pin?: "hard" | "soft" }
~~~

Rules:

- the client may name a safe `accountID`, never a credentialHandle/secret;
- the server resolves accountID against the authorized provider account set;
- explicit `public` is accepted only for a provider/model with validated public
  eligibility and only when local/hosted authority permits public;
- `auto` clears explicit pin intent but does not silently rebalance a still-healthy
  existing binding; an explicit rebind/rebalance action is separate if desired;
- first-turn route intent may be carried with trusted Session/prompt creation and bound
  transactionally before provider dispatch;
- changing routing defaults affects future bind/rebind only.

Exact endpoint placement can follow the existing Session action conventions. Do not
encode `public` as `accountID="public"` and do not put credential handles into the
public client API.

### 9.5 Backward-compatible route intent at OXP/scheduler ingress

Current ingress contracts are account-centric:

- `OxpSchema.ModelSelection` = providerID + modelID + optional accountID + variant;
- `OxpModelSelection.materialize()` interprets missing accountID as `automatic`;
- `ScheduledTask.Action.model` is `Model.Ref`, which likewise has only optional accountID;
- delegated-worker/subagent policy equality compares provider/model/account/variant.

That means `accountID === undefined` cannot distinguish **Auto** from **explicit Public**.
Fix this without turning route state into model identity.

Add one safe reusable public schema, conceptually:

~~~ts
type ProviderRouteIntent =
  | { kind: "auto" }
  | { kind: "public" }
  | { kind: "account"; accountID: string; pin?: "hard" | "soft" }
~~~

Compatibility projection rules:

~~~text
legacy accountID present + no routeIntent
  -> routeIntent = account(accountID, hard)

legacy accountID absent + no routeIntent
  -> routeIntent = auto

routeIntent=public
  -> accountID MUST be absent

routeIntent=account(A)
  -> any legacy accountID MUST be absent or exactly A

routeIntent=auto
  -> accountID MUST be absent
~~~

Do not make OXP callers send provider-internal handles. Account route intent contains only
the stable safe `accountID`; the trusted server resolves it to an authorized credential
handle at execution resolution.

Recommended surface evolution:

- extend OXP `ModelSelection` with optional `routeIntent` while retaining `accountID` as
  backward-compatible input/output during the migration window;
- update `OxpModelSelection.normalize/materialize/fromProviderModel` so public remains
  first-class and can no longer collapse to `automatic`; providerModelID lowering happens
  only after route resolution, not by inventing a suffix for public;
- extend `ScheduledTask.Action` with optional `routeIntent`; old tasks derive account/auto
  semantics from `model.accountID` exactly as above;
- Session control `set_selection` accepts model + route intent as one transactional
  user action when both change;
- OXP/session inspection returns the **effective explicit intent** where one exists plus
  the current safe bound-route projection separately. Do not pretend Auto and current
  binding are the same thing.

#### Scheduled-task semantics

For a scheduled run:

- `SessionPolicy=new` -> apply the task's persisted route intent before first dispatch;
- `reuse/auto/existing` with no explicit task route intent -> preserve the reused
  Session's healthy durable route binding; do not recompute Auto merely because a run
  started;
- an explicit task `public` or `account` intent against a reused Session is a deliberate
  rebind request and must pass the normal authority/model-eligibility/CAS checks before
  any prompt is sent;
- if the rebind cannot be satisfied, fail the run with a typed route error; do not
  silently fall back to Auto;
- editing global routing defaults does not rewrite persisted tasks or existing Session
  bindings.

## 10. App/UI port

The V2/new-layout UI is already the correct presentation surface.

### 10.1 Provider method discovery

For a directory-scoped provider:

- continue using the explicit location-scoped integration API where appropriate.

For global/no-directory settings:

- stop returning an unconditional API-key fallback;
- query provider-settings auth methods;
- OpenCode should expose:
  - OpenCode Console account;
  - API key (service account).

### 10.2 OAuth start

In ProviderConnection.selectMethod():

- if directory exists, existing scoped Integration path may remain;
- if directory is absent, call the bootstrap-free global Integration auth runtime through provider-settings.

Do not synthesize a directory.

### 10.3 Auto/device mode

Reuse existing OAuthAutoView:

- open verification URL;
- show/copy user code/instructions;
- poll status;
- complete UI on terminal success;
- show sanitized failure;
- stop polling on dialog unmount/back/cancel.

Preserve upstream desktop URL treatment used to identify desktop-origin device auth where applicable.

### 10.4 Completion

On success:

- invalidate provider-settings;
- invalidate connected provider/model projections that depend on OpenCode Console config;
- refresh account rows;
- do not globally dispose an unrelated workspace merely to observe the new account.

### 10.5 Account rows

Existing settings-v2 provider account UI already supports:

- count;
- active account;
- add;
- select;
- rename;
- remove.

Use those rows. Do not create a parallel "OpenCode Accounts" settings panel solely for provider credentials.

Remote email/org metadata may be shown where useful, but local label remains independently editable.

### 10.6 Public free-model UX and provider availability

Do not overload `connected` to mean "this provider can be used." The current global
`provider-settings` model projection filters providers out when they have no env/config/
legacy/stored credential. That is incorrect for OpenCode's public free lane.

Split the safe projection conceptually:

~~~ts
type ProviderAvailability = {
  connected: boolean          // user has credential/config auth state
  publicAvailable: boolean    // derived: at least one Auto-eligible public model
  publicCatalogState?: "fresh" | "stale" | "expired" | "unavailable"
  publicCatalogFetchedAt?: number
  publicModels?: Array<{
    id: string
    state: "fresh" | "stale" | "expired" | "unavailable" | "metadata-drift"
  }>
}
~~~

For OpenCode:

- zero credentials + at least one `fresh|stale` public model => `connected=false`,
  `publicAvailable=true`;
- OAuth/key configured => `connected=true`; public availability remains independently
  observable;
- expired-only snapshots => `publicAvailable=false` for Auto while retaining stale model
  history for explicit Public-free revalidation;
- model-list/model-picker APIs must include trusted public models even when
  `connected=false`, with freshness/drift state sufficient to explain disabled/manual
  behavior;
- paid/account-only models remain hidden/disabled when no eligible account route exists;
- do not fake a connection row named `public`; public is provider capability, not a
  Credential.

At model/route selection, OpenCode may expose:

- **Auto** — use the configured provider route policy;
- **Public free** — explicit public route; enabled only for a currently public-eligible
  model;
- real account rows — explicit account pin.

Provider routing settings should expose:

- account routing mode: `concentrate` / `session-round-robin`;
- free-route preference: `account-first` / `public-first-for-free`.

For **OpenCode**, the built-in default is `public-first-for-free`: a new/unbound Session
selecting a currently validated public/free model should actually use the free public
lane. `account-first` remains an explicit compatibility/user override. Existing durable
bindings are never rewritten by changing this preference.

UI state must distinguish:

- public catalog unavailable/stale;
- public model unavailable;
- authentication missing for account-only model;
- account missing/invalid;
- hosted request-admission failure.

Do not turn any of those into a generic "Connect provider" error.

## 11. V1 provider runtime integration

The port is incomplete if login succeeds in Settings but V1 execution cannot use it.

### 11.1 Preserve Zen/Go first

Do not immediately rewrite plugin/zen.ts.

Existing API-key routing stays live while Console OAuth is introduced.

This gives a safe feature boundary:

- Zen/Go key accounts continue behaving exactly as before during P1-P5 bring-up;
- Console OAuth becomes an additional authenticated provider source;
- storage convergence happens later.

However, current `resolveZenRequest()` is **not** the final P5A routing architecture. Its
bare-Zen rule deliberately chooses `pool.defaultAccount()` whenever the pool is populated,
even when the provider bootstrap supplied the `"public"` sentinel. P5A must replace that
second-stage routing decision for route-ledger-backed requests; otherwise
`public-first-for-free` would be correct in the router and silently undone in transport.

### 11.2 Console-authenticated provider config adapter

Backport the semantic behavior of current Core OpencodePlugin into the V1 provider/catalog path:

1. resolve the selected Core Credential;
2. refresh it through the shared resolver;
3. call Console /api/config with bearer token and x-org-id;
4. validate the returned ConfigV1 provider structure;
5. project only provider/model data needed by the V1 provider host;
6. do not blindly merge unrelated remote settings into OpenFork global config;
7. preserve provider IDs, endpoint URLs, package adapters, request headers/body options, model capabilities, variants, limits, costs, and status semantics supplied by the remote config;
8. never persist returned secret-bearing provider fields into user-visible config.

This is a **provider adapter**, not a runtime migration.

### 11.3 Dispatch auth

The remote config and exact upstream provider implementation must determine whether a model request targets:

- Console inference;
- Zen;
- Go;
- another provider endpoint returned by Console.

Do not infer the transport family from:

- key prefix;
- UI label;
- model name;
- provider name alone.

Before enabling production requests, capture authenticated /api/config fixtures for the relevant account types and assert the chosen URLs/headers against those fixtures.

### 11.4 Account-pinned models

When a model/session/OXP/scheduled task explicitly carries accountID:

- resolve the same account at dispatch;
- if missing, fail with an actionable account-missing error;
- never fall back to active/default silently.

When no accountID is pinned:

- **before P5A router cutover**, preserve the provider's documented active/default
  behavior for compatibility;
- **after P5A**, ask the shared session-affine router to bind/select from the eligible
  authorized account pool under the configured policy;
- changing the UI active/default credential may influence future fallback/default
  configuration where explicitly designed, but must not silently move an already-bound
  healthy Session.

### 11.4.1 Compile the committed route into transport

After P5A, provider routing is resolved **before** provider client/fetch construction and
the resulting immutable request/turn lease is carried into transport. Conceptually:

~~~ts
type ProviderRouteLease = {
  sessionID: SessionID
  affinityDomain: string
  routeRevision: number
  route:
    | { kind: "public"; providerID: "opencode" }
    | { kind: "account"; providerID: string; accountID: string; credentialHandle: string; credentialRevision: number }
}
~~~

The exact shape may differ, but the ownership rules are mandatory:

1. provider-route resolver reads/creates the durable binding and returns one lease;
2. account route resolves the exact credential through the trusted resolver;
3. public route constructs transport with the upstream public sentinel and **no** account
   credential resolution. This choice is late/authoritative: route-specific provider
   options must explicitly carry the public sentinel so generic provider construction
   cannot backfill an env/legacy/config/provider key;
4. public route sanitization must prevent all account-bearing auth sources from winning:
   `OPENCODE_API_KEY`, legacy `Auth.Service`, provider config `apiKey`, Core Credential,
   fork Zen vault/pool, active/default account, and preexisting Authorization headers.
   Only non-secret public-route headers/options from trusted base metadata may remain;
5. account route similarly injects the **exact resolved credential** after route selection
   so an unrelated env/default key cannot override an explicit account lease;
6. provider/language-client cache key includes route kind; account entries additionally
   include stable credential handle + trusted credential revision. The revision must be
   strictly monotonic. Existing `time_updated` may back it only if Credential mutations
   enforce `next > previous` even for same-millisecond writes; otherwise add a small
   integer revision column and increment it transactionally. Do not use a raw Date.now()
   equality assumption as a correctness boundary. Conservative invalidation on
   label/select mutation is acceptable;
7. the Zen fetch wrapper may de-qualify model IDs, observe response status, and attach
   validation metadata, but it may not call `pool.defaultAccount()` or choose another
   credential for a leased request;
8. no mid-stream account/public switching occurs. Failover, when allowed, creates a new
   route revision and a new logical transport attempt before visible output;
9. System One/non-generative hosted primitives must consume the same lease semantics once
   migrated; they cannot retain an independent implicit default-account path.

For the transitional period, retain legacy `resolveZenRequest()` only for paths not yet
cut over to the durable router. Mark those call sites explicitly. The P5A gate is not
complete until every production OpenCode V1 generation path uses the route lease and the
legacy resolver cannot override it.

#### System One / non-Session semantic inference

`SystemOne.infer()` is currently a concrete bypass: it resolves optional accountID, calls
`resolveZenRequest()` directly, rewrites auth, and synthesizes its own hosted identity.
Cut it over deliberately.

- extend `SystemOne.InferInput` with the reusable safe `routeIntent`; retain `accountID`
  as legacy input translated to explicit account intent;
- if System One is invoked **from a durable Session execution**, pass the parent's
  ProviderRouteLease internally and validate the System One model against that route;
- if it is a standalone semantic inference with no durable Session, resolve the explicit/
  Auto route once for that call and compile it directly into transport; do **not** create
  a fake Session row merely for routing;
- standalone `routeIntent=public` uses the public sentinel even if accounts exist;
- standalone `routeIntent=account(A)` resolves exact A or fails closed;
- standalone Auto applies the provider routing policy to that call. Do not promise durable
  account affinity across separate standalone calls unless a separate semantic-route
  binding contract is deliberately introduced later;
- existing `affinityID` remains a caller-owned **remote/cache/session-token affinity**
  input. It must not be reinterpreted as account/public route authority;
- System One response/account observations validate the selected route exactly like
  language-model transport.

Response `x-openfork-routed-account-id` metadata becomes **validation evidence**:

- public lease + observed account => route mismatch error/diagnostic;
- account lease A + observed account B => route mismatch error/diagnostic;
- account lease A + observed A => validation success;
- public lease + no account header => expected;
- missing account header on account lease does not erase the committed attribution, but
  should be observable so transport wrappers that stopped reporting identity are caught.

### 11.5 Hosted-service client identity and the free-tier gate

Console/Zen authentication and Console/Zen **client acceptance** are separate contracts.

A valid API key or OAuth credential is not sufficient proof that an OpenCode-hosted
free model will accept a request. The hosted free-tier path has actively enforced
OpenCode-specific request identity/shape, and the enforcement has changed over time.

OpenFork contains **attempted** compatibility work, but the re-audit found that
some of it must not be treated as source of truth:

- upstream OpenCode v1.18.30, v1.18.31, and current `upstream/dev` compose the V1
  generation User-Agent as `opencode/<InstallationVersion>`;
- OpenFork commit `8dd23c4dc3` introduced `InstallationUserAgent(...)` with the
  fork-specific shape `opencode/<channel>/<releaseVersion>/<client>` and a comment
  claiming that shape/minimum-version rule is canonical;
- commit `98d9499d551` then changed V1 generation to use that fork-specific formatter;
- that claim is not backed by the inspected upstream source and must be re-proven against
  the live service before it remains on the wire;
- `packages/opencode/src/session/llm/request.ts` still correctly centralizes the V1
  OpenCode-specific session/request/client/project header family, and both V1 native and
  AI-SDK execution receive those prepared headers;
- `SystemOne` has a separate header path and therefore needs the same contract audit.

Do not call any fork-authored identity formatter "canonical" merely because a local test
asserts it. Tests can preserve a wrong assumption indefinitely.

September 2026 external reproductions provide useful **observations**, not a stable API
contract. A positive-control bisection against the live Zen gateway on September 18
reported that acceptance at that moment depended on all of:

- a User-Agent whose leading token was `opencode/<version>`;
- an `x-opencode-session` shaped like the ordinary OpenCode
  `ses_<12 lowercase hex><14 alphanumeric>` identifier;
- streaming generation;
- a request tool surface containing a threshold of recognizable OpenCode core tool names.

That same investigation reported no reproducible version floor in its controlled test,
and later community reports said the route/tool predicate changed again. Official
OpenCode releases have also seen `FreeTierError` in title/compaction/subagent paths.

Therefore the only authoritative rule is: **capture what the upstream-operated service
and a current official client actually do now**. Treat historical reverse engineering as
a test-seeding hypothesis, never as an entitlement to spoof arbitrary client behavior.
If the service intentionally restricts a request class or free tier to an official
product flow, OpenFork must surface that limitation rather than fabricate capabilities.

Fields such as `x-opencode-request`, `x-opencode-client`, project identity, route
family, or version may still matter to other hosted routes even when one historical
free-tier probe did not require them.

Therefore:

1. **Do not claim the new auth system by itself fixes
   "OpenCode's free tier can only be used from within OpenCode."**
2. Keep authentication, routing, and hosted-client identity as three distinct owners.
3. P0F must include a zero-credential public positive-control wire capture from the
   current official OpenCode client and the equivalent zero-credential OpenFork request.
   P0 separately captures same-account authenticated parity.
4. Compare the actual final HTTP request **after** AI-SDK/provider transforms, not merely
   the pre-transport `LLMRequestPrep` object.
5. Exercise primary turns **and** title, compaction, prompt-revisor, Goal auditor,
   delegated/special agents, System One, and any other path that can invoke a free
   OpenCode model. A tool-less or differently shaped special-agent request can fail a
   gate that a normal build turn passes.
6. Classify `FreeTierError`/equivalent hosted rejection first as a
   request/service-admission failure, not credential invalidation. It must not poison the
   account, rotate credentials, or trigger multi-account failover without independent
   account-local auth/quota evidence.
7. Classify actual 401/403 auth revocation separately; only an account-local auth failure
   may update router health to `AUTH_INVALID`.
8. Do not spoof arbitrary future OpenCode versions. Track the released upstream
   compatibility baseline OpenFork is actually based on and forward-port required remote
   protocol semantics. If upstream raises a true minimum supported version, syncing that
   compatibility surface is the fix.
9. Add sanitized diagnostics for the compatibility tuple:
   route family, client kind, upstream-compat version, session-id shape, streaming flag,
   tool-name set hash/count, and response error type. Never log auth material or prompt
   content.

#### 11.5.1 Upstream compatibility version is not the OpenFork product version

OpenFork currently has three notions that must stop being conflated:

- `InstallationVersion` — the actual OpenFork build version;
- `InstallationReleaseVersion` / `OPENCODE_RELEASE_VERSION` — the OpenFork release line
  used to avoid synthetic preview versions in fork-owned build behavior;
- **OpenCode hosted compatibility version** — the upstream release/tag whose hosted
  protocol behavior OpenFork has actually synchronized and verified.

Today preview builds derive `OPENCODE_RELEASE_VERSION` from
`packages/opencode/package.json`, which happens to be `1.18.30` in the audited tree. That
is not a durable hosted-service contract once OpenFork's versioning diverges.

Add a separate committed machine-readable upstream compatibility baseline owned by the
existing tag-sync workflow. A minimal shape is sufficient, for example:

~~~json
{
  "openCodeHostedCompatibility": {
    "tag": "v1.18.30",
    "version": "1.18.30"
  }
}
~~~

The exact file may be an extension of `keep-manifest.json` or a small dedicated
fork-sync metadata file; choose the location that keeps one source of truth. Requirements:

- it is committed, reviewable, and updated only as part of a verified upstream tag sync;
- `fork:sync verify --tag <tag>` fails if the committed hosted-compatibility tag/version
  does not agree with the sync being verified;
- build scripts read that committed value and stamp a separate define such as
  `OPENCODE_UPSTREAM_COMPAT_VERSION`;
- production runtime never shells out to Git or guesses from tags;
- OpenFork's own package/release version can diverge freely without changing the hosted
  compatibility identity;
- the hosted compatibility owner uses the exact wire format proven by P0F/P0. If the
  current official client sends `User-Agent: opencode/<version>`, emit that shape using
  the verified upstream compatibility version; do not append OpenFork channel/client
  components unless the live upstream contract actually requires them;
- fork-owned and third-party User-Agent branding remains OpenFork-owned. This special
  compatibility identity is only for upstream-operated OpenCode services where it is a
  remote protocol requirement.

This makes upstream sync, not wishful version spoofing, the mechanism by which OpenFork
advances its hosted compatibility baseline.

The desired request path is:

~~~text
ProviderRoute
  |
  +-- public
  |     -> upstream "public" sentinel
  |     -> public capability/catalog projection
  |
  +-- account
        -> resolve/refresh exact credential
        -> account/org-specific capability snapshot

both
  -> apply one OpenCode-hosted compatibility identity policy
  -> provider/AI-SDK lowering
  -> final wire validation
  -> remote service
~~~

The compatibility policy must not live in the generic account router. A
`FreeTierError` with otherwise valid authentication is an **admission/client-policy
signal scoped to that request/model/lane**, not sufficient evidence that the credential
is invalid. It must not trigger credential rotation unless an independent auth signal
proves an account-local failure.

### 11.6 Special-agent execution has two stacks; audit the production one first

The re-audit found an important distinction that the first pass blurred.

**OpenFork V1 production adapters already do the right thing structurally for several
special agents:**

- Prompt Revisor's OpenFork runtime resolves through `Provider` and generates through
  the ordinary `SessionLLM` service;
- Goal Auditor has an OpenFork runtime adapter that also generates through
  `SessionLLM`;
- V1 Session Title and SPAD Auditor generation in `session/prompt.ts` call
  `SessionLLM.stream(...)`;
- these paths pass the parent/runtime ordinary Session ID into V1 request preparation,
  while the deterministic `ses_sa_<agent>_<hash>` ID remains only the durable
  transcript identity.

Therefore the `ses_sa_*` transcript format is **not presently the primary V1
free-tier incompatibility**. Do not rewrite those durable IDs.

However, the audit still found four real problems:

1. special-agent request bodies/tool surfaces are intentionally different from normal
   coding turns — Title and SPAD may expose only one terminal tool — so a remote
   request-class/tool admission policy can still reject them even with correct V1
   headers;
2. Goal Auditor's V1 runtime currently drops `candidate.accountID` when calling
   `provider.getModel(...)` and when building its V1 user anchor, so a worker/account
   pin can silently disappear;
3. newer Core/current donor implementations also contain direct
   `@opencode-ai/llm` execution paths. `packages/llm` itself does not synthesize
   OpenCode-hosted identity, so those paths require an explicit provider execution
   context before they can safely become production for OpenCode-hosted models;
4. `SessionRunnerModel.resolveRef()` similarly ignores `ModelV2.Ref.accountID` and
   resolves `Integration.connection.active(...)`, which is unsafe for any caller that
   uses the Core/current model stack with an explicit account.

The desired long-term execution identity boundary is still:

~~~text
local execution context
  durable transcript identity
  runtime/parent Session identity
  requestID
  client + special-agent kind
  committed ProviderRouteLease
    public OR account(accountID + credentialHandle/revision)
        |
        v
provider-host compatibility adapter
  -> remote affinity/session identity
  -> provider-required headers
  -> account-specific endpoint/org/auth
  -> request-class admission check
        |
        v
provider lowering -> final body -> transport
~~~

Do not make durable OpenFork IDs depend on a remote gateway regex. The V1 production
path may continue using its ordinary parent Session ID where that is the current upstream
contract; direct Core/current execution needs an equivalent trusted context if promoted.

Fix **route** propagation before broadening the new auth path:

- every explicit account route must resolve the same provider account or fail closed;
- every explicit public route must remain public or fail with a typed public eligibility/
  admission error; it must not degrade to Auto merely because accountID is absent;
- Goal Auditor, Session Title candidate selection, SPAD model selection, Prompt Revisor,
  OXP, scheduled tasks, swarms, delegated workers, subagents, and ordinary Sessions must
  feed the same route resolver/lease boundary;
- deduplication/cache keys for special-agent candidate models must include route kind and,
  for account routes, handle/revision once model IDs become account-neutral.

#### Derived-session and maintenance lineage

Route inheritance follows **execution lineage**, not optional account fields:

1. **same Session / maintenance call** (Title, SPAD, Prompt Revisor, Goal Auditor,
   compaction where it uses the same selected model policy): acquire/receive the parent
   Session's current ProviderRouteLease and validate that route against the chosen model;
   do not call Auto independently;
2. **child/delegated Session with inherited model policy**: create the child route binding
   transactionally from the parent/authorized route intent before its first provider
   dispatch. Public parent -> public child; account parent A -> account child A;
3. **child explicitly authorized with another model/route**: resolve that explicit route
   under delegation authority and persist it on the child; no silent fallback to parent
   or active/default;
4. **child model differs but route intent is inherited**: keep the inherited route kind
   only if that route can serve the new model. Otherwise fail with typed route/model
   incompatibility unless the delegation policy explicitly authorizes a new Auto
   resolution;
5. **resumed child**: its own durable route binding wins. Parent routing/default changes
   do not rewrite it;
6. **nested delegation**: protected delegation metadata must carry safe route intent/
   account identity needed to reproduce the authorized route. Never carry credential
   handles in untrusted metadata.

Current delegated/subagent model-policy equality is provider/model/account/variant only.
Extend the policy comparison so explicit `public` and `auto` are not considered equal
merely because both have no accountID. A resumed public worker must not pass an Auto policy
check and then bind to a newly available account.

For maintenance request classes that the upstream free service demonstrably does not
admit, the host may choose an explicitly configured eligible maintenance model/route. That
is a **separate model/route decision with explicit attribution**, not a hidden public ->
account retry of the original request.

Finally, **do not fabricate coding-tool stubs merely to satisfy a historical free-tier
gate**. If the current service does not admit title/revisor/auditor request shapes, route
those maintenance operations to an eligible model/lane or surface a typed unsupported
admission result. Only reproduce tool/request semantics that a current official client
actually uses for the same operation.

For any direct native/Core LLM path, use `LLMClient.compile()` as the provider-body
proof seam: it validates the provider-native body and binds the stream to the exact
compiled transport. Extend diagnostics narrowly if sanitized final URL/header inspection
is required; do not infer final wire behavior solely from a high-level `LLMRequest`.

### 11.7 Failure classification, route health, and retry are separate decisions

The current V1 `session/retry.ts` conflates **user-facing recovery/action metadata** with
**permission to retry**. In particular, `FreeUsageLimitError` currently returns a
`Retryable` value containing the Go upsell action, and `SessionRetry.policy()` schedules
anything returned by `retryable()` up to the normal retry budget. A static exhausted
public-free allowance can therefore be retried repeatedly even though another identical
request cannot succeed.

Likewise, V1 currently has no explicit `FreeTierError` / `MissingSessionID` admission
classification. A gateway status/body that also matches a generic retry rule could be
retried even though the defect is deterministic request/client admission.

Replace the implicit boolean-ish retry classification with a typed provider failure
decision at the V1 boundary. Conceptually:

~~~ts
type ProviderFailureDecision = {
  class:
    | "account-auth"
    | "account-quota"
    | "account-rate-limit"
    | "public-quota"
    | "request-admission"
    | "provider-transient"
    | "request-invalid"
    | "cancelled"

  retry: "none" | "same-route"

  routeEffect:
    | "none"
    | "account-auth-invalid"
    | "account-cooldown"
    | "account-quota-exhausted"
    | "public-quota-exhausted"

  action?: {
    reason: string
    title: string
    message: string
    label: string
    link?: string
  }
}
~~~

The exact type can be smaller, but the three decisions **must remain independent**:

1. what happened?
2. should the same logical request be retried?
3. does this change future route eligibility?

Required classification:

| Signal | Class | Immediate retry | Route effect | Cross-account/public switch |
| --- | --- | --- | --- | --- |
| `FreeUsageLimitError` on public lane | public quota | **none** | public quota exhausted/cooldown when reset is trustworthy | no |
| `FreeTierError` / `MissingSessionID` / client-admission rejection | request admission | **none** | none; optionally request-class eligibility cache | no |
| account 401/403 proven revoked/invalid | account auth | none | mark exact account auth-invalid | only router-safe next-request/failover rules |
| account-specific 429 / explicit quota limit | account rate/quota | only when provider contract explicitly permits same-route retry | exact account cooldown/quota | router-safe failover only before visible output and within retry budget |
| provider 5xx / DNS / shared outage | provider transient | bounded same-route retry | none | no |
| malformed/context/policy request error | request invalid | none | none | no |
| user cancellation | cancelled | none | none | no |

`FreeUsageLimitError` may still carry an upsell/action card. **Action does not imply
retry.** This is the specific V1 behavior that must be corrected.

#### Public-route health is not an AccountCandidate

The public lane may maintain provider-route health such as:

~~~ts
type PublicRouteState = "READY" | "STALE" | "COOLING_DOWN" | "QUOTA_EXHAUSTED" | "UNAVAILABLE"
~~~

but it remains outside the ProviderAccountRouter candidate pool. Public route state can
affect whether a new/unbound Session may select public; it does not fabricate account
quota/cooldown state.

Request-class admission is narrower still. If, for example, primary turns are accepted
but Title is rejected by the hosted service, cache/diagnose that as
`(route/model/requestClass)` admission evidence rather than globally disabling the free
model or public route.

#### Replay/failover boundary

Replaying the same logical request on another account is permitted only when all existing
shared-router safety conditions hold:

- failure is classified account-local;
- no visible assistant output has been emitted;
- no tool/external side effect has begun;
- the provider adapter marks replay safe;
- failover budget remains;
- the new account is already authorized/eligible;
- public/account route kind does not change.

A public request never walks the account pool after failure. An account request never
tries public after failure merely because the model also happens to be free.

## 12. Zen/Go convergence after the OAuth port

Once Console OAuth is proven, converge duplicate key ownership deliberately.

### 12.1 Phase 1 — projection only

ProviderAccount projection reads:

- Core Credential;
- fork_credential;
- env;
- legacy Auth.

No destructive migration.

### 12.2 Phase 2 — observe/import

Build an idempotent migration inventory for:

- fork_credential;
- Core Credential opencode/opencode-go rows;
- legacy auth.json;
- env keys.

Compute normalized identities and duplicate fingerprints without exposing secrets.

### 12.3 Phase 3 — import API keys into Core Credential

For each fork-vault key not already represented:

- add a Key credential;
- preserve label;
- preserve active/default state;
- attach migration provenance;
- preserve existing zen-* provider account identity;
- do not delete fork_credential yet.

Deduplicate by secret fingerprint or verified upstream identity, never by label.

### 12.4 Phase 4 — V1 router reads canonical projection

Change zen.ts to resolve accounts through ProviderAccount projection / trusted credential resolver.

Preserve its current:

- explicit suffix behavior;
- fail-closed rules;
- header rewrite;
- model de-qualification;
- rate-limit observation.

### 12.5 Phase 5 — single-write

New account/key writes go to Core Credential only.

fork_credential becomes migration-only.

### 12.6 Phase 6 — retire old secret ownership

After a compatibility window and migration proof:

- stop reading fork_credential on normal hot paths;
- retain a bounded importer for old installs;
- decide separately whether fork_message_credential remains the historical attribution table or is migrated to a generic account-attribution relation.

No historical usage data may be dropped as collateral damage.

## 13. Usage, quota, capacity, and attribution

The **committed ProviderRoute** used for dispatch must flow unchanged through accounting.
Account identity is present only when the route is account-backed.

Required chain:

~~~text
model + route intent
  -> durable ProviderRoute binding
       |
       +-- public
       |     -> public sentinel / public capability state
       |     -> RouteAttribution { routeKind: public }
       |
       +-- account
             -> ProviderAccount.accountID + credentialHandle
             -> exact credential resolution/refresh
             -> RouteAttribution { routeKind: account, accountID }

RouteAttribution
  -> actual provider transport
  -> message/support-agent settlement
  -> usage_record.route_kind + account_id?
  -> quota/capacity state
  -> reset/admission events
  -> UI/OXP/scheduler projections
~~~

### 13.1 Account-backed attribution

For Zen/Go and Console-authenticated inference:

- preserve the exact stable provider account identity selected by routing;
- use the stable remote account/org identity for billing/accounting when available;
- do not use Credential.ID as the billing identity unless the remote service exposes no
  stronger stable identity;
- org-sensitive billing must include org identity;
- rotating access/refresh tokens must not change accountID;
- rename must not change accountID;
- active/default credential switch must not rewrite historical attribution or an existing
  healthy Session binding;
- observed response routing metadata validates the expected account; it does not silently
  replace the committed account used for settlement.

### 13.2 Public attribution

Public free generation is intentionally accountless:

- `route_kind = public`;
- `account_id = NULL`;
- no credentialHandle is written into historical Usage;
- public quota/reset/admission state is provider-route state, not account state;
- public calls are never included in per-account spend/quota summaries as an unattributed
  account bucket;
- legacy records with `route_kind IS NULL AND account_id IS NULL` remain
  legacy/unknown and must not be retroactively labeled public without proof.

Where UI or analytics need an aggregate public row, derive/display it from
`route_kind=public`; do not materialize a fake account.

### 13.3 Quota/capacity ownership

Account quota/capacity is keyed by stable ProviderAccount/account handle and may influence
ProviderAccountRouter eligibility.

Public route health/quota is keyed by provider/public route (+ model/window where needed)
and may influence only public-route eligibility. It is never fed into account ranking.

Persist only **bounded server-derived public cooldown/quota facts** whose lifetime is
explicitly known (for example a trustworthy `resetAt`/Retry-After). This avoids a restart
immediately hammering a public lane the server just told us is exhausted. Requirements:

- state expires automatically at reset/TTL;
- state without a trustworthy expiry remains process-local and conservative;
- success may clear stale cooldown where the provider contract proves it;
- request-admission rejection is not persisted as global public quota;
- persistent public health contains no account/user/secret identity.

Request-class admission evidence is narrower than quota:

~~~text
(provider route, model, request class) -> admitted / rejected / unknown
~~~

A Title-only `FreeTierError` must not mark the whole public model quota-exhausted; a
public quota error from a primary turn must not mark an OAuth account exhausted.

### 13.4 Secret boundary

Quota/usage readers resolve secrets only through trusted provider services. UI-facing
Usage, provider availability, OXP, scheduler, and routing diagnostics receive only
route/account identities and safe state — never credential values.

## 14. Events and invalidation

Use producer-owned events rather than ad hoc cross-layer callbacks.

On add/select/rename/remove/refresh where observable provider state changes:

- publish Integration.Event.ConnectionUpdated for the affected integration;
- publish the broader integration/provider update only when its semantics actually changed;
- invalidate provider-settings query state;
- invalidate Console remote-config/catalog cache for the affected credential/account;
- invalidate quota cache only when account/key membership or routing identity changes;
- do not invalidate local historical usage merely because an access token refreshed.

Provider-route mutations have their own producer-owned event/projection boundary. Publish
safe events for bind/rebind/release where UI/OXP/supervision needs them, containing only:

- sessionID;
- providerID / affinityDomain;
- routeKind;
- safe accountID for account routes;
- routeRevision;
- bind reason / pin mode.

Never put credentialHandle into an untrusted public event unless the consumer is explicitly
trusted to receive opaque infrastructure handles; UI normally needs accountID/label only.

Public-catalog refresh should invalidate model/provider availability only when the
effective advertised set/freshness changes. It must not emit credential/account mutation
events.

Token refresh is not account mutation. Public catalog refresh is not Session route
mutation. Active/default selection is not an instruction to rebind existing Sessions.

## 15. Persistence and migration requirements

### 15.1 Credential table

No new secret table is required for provider OAuth.

Use the existing credential table:

- id;
- integration_id;
- label;
- value JSON;
- active;
- timestamps.

OAuth metadata should preserve at minimum:

- server;
- remote account/user ID;
- email;
- org ID;
- org name.

### 15.2 Account table

Do not alter AccountTable during the first provider-auth tranche unless the implementation requires a shared-protocol refactor that is schema-neutral.

A later token-store convergence must be designed separately because AccountTable currently owns:

- access_token;
- refresh_token;
- token_expiry.

That migration needs explicit rollback and refresh-rotation proofs.

### 15.3 Atomicity

Credential add/select operations that must appear as one user action should be transactionally bounded where practical.

A failed connection must not leave:

- a half-populated credential row;
- an active pointer to a missing credential;
- a completed attempt whose credential was never persisted.

### 15.4 Provider-route tables

Add normal schema-managed tables for live routing state; do not create them opportunistically
with ad-hoc runtime `CREATE TABLE` calls.

At minimum persist:

- `(session_id, affinity_domain)` route binding with provider ID, route kind, optional
  accountID/credentialHandle, mode/pin, revision, assignment epoch/time/reason;
- per-affinity-domain round-robin cursor;
- only the bounded concentrate statistics that cannot be reconstructed cheaply or whose
  restart continuity is part of the policy contract.

Foreign-key/lifecycle rules:

- binding -> Session delete cascade;
- archive does not delete binding;
- cursor/policy state has no secret material;
- deleting/removing an account makes its bindings ineligible/rebindable but does not
  destroy historical Usage;
- public binding has CHECK-equivalent validation forbidding account/credential fields;
- account binding has validation requiring the identities needed by dispatch.

Schema indexes must cover the hot paths:

- exact `(session_id, affinity_domain)` binding lookup;
- bindings by account/credential handle for account removal, capacity, and reconciliation;
- bindings by affinity domain where cursor/count reconciliation requires it.

### 15.5 Usage route-kind migration

Add nullable `route_kind` to new Usage attribution surfaces that can settle hosted calls.
For `usage_record`, valid new values are at least `public` / `account`.

Migration rules:

- existing `account_id IS NOT NULL` rows may be backfilled to `route_kind=account` only
  where that attribution is already authoritative;
- existing `account_id IS NULL` rows remain `route_kind=NULL` unless another durable
  source proves public execution;
- never bulk-backfill historical NULL rows to public merely because the model name ends
  in `-free` or cost is zero;
- future settlement always writes route_kind explicitly for OpenCode-hosted calls;
- historical queries treat NULL route_kind as legacy/unknown.

### 15.6 Public provider cache/state

Persist secret-free public-provider state through normal schema-managed storage:

- last validated public catalog snapshot + successful fetch timestamp/version;
- bounded public cooldown/quota state only when a trustworthy expiry exists.

This storage is process-global/provider-owned, not Session-owned and not Credential-owned.
It must survive restart, but its timestamps remain authoritative: restart never makes stale
data fresh. Malformed/network refreshes do not overwrite the last validated catalog.

Do **not** persist:

- arbitrary raw remote response bodies;
- request/prompt content;
- access/API tokens;
- indefinite request-admission denials;
- fake public account rows.

### 15.7 Migration idempotency

Every legacy import/migration must be safe to re-run after interruption.

Never infer migration completion solely from row count.

Use source provenance/fingerprint/account identity sufficient to distinguish:

- already imported;
- same secret under another label;
- same remote account with rotated secret;
- genuinely distinct account.

Route/Usage migrations must likewise be additive/idempotent and must not rewrite a newer
routeRevision or reclassify legacy Usage without authoritative evidence.

## 16. Security design

### 16.1 Secret boundary

Secret-bearing types stay below the provider/auth boundary.

Allowed secret consumers:

- shared Console remote-auth adapter;
- trusted credential resolver;
- provider dispatch;
- quota endpoint client when that endpoint requires the provider credential.

Disallowed:

- provider settings list;
- ProviderAccount projection;
- model picker;
- session JSON;
- OXP;
- scheduled-task public contract;
- logs;
- telemetry payloads;
- error strings.

### 16.2 Device URLs

Validate HTTP(S).

Do not execute javascript:, file:, custom shell protocols, or arbitrary local handlers from upstream-provided verification data.

Desktop browser opening remains an explicit platform operation.

### 16.3 Error sanitation

Persist/report semantic error classes, not arbitrary remote response dumps.

Differentiate at least:

- authorization pending;
- slow down;
- denied;
- expired;
- invalid/unauthorized refresh;
- network/transport;
- malformed remote response;
- local persistence failure.

### 16.4 Concurrency

Required races to handle:

- two Sessions resolving the same expiring OAuth credential;
- global + location auth runtimes resolving the same credential;
- multiple processes refreshing one credential where shared-DB multi-writer is supported;
- account removal during refresh;
- active/default switch during request admission;
- two new Sessions advancing the same round-robin cursor;
- two concurrent turns in the same Session attempting first route bind;
- automatic failover racing manual account/public rebind;
- public/account model-selection rebind racing a stale provider failure;
- account removal racing dispatch lease acquisition;
- Session delete racing route settlement;
- Session archive racing route release logic (archive must retain binding);
- route response-account mismatch arriving after a newer routeRevision;
- duplicate add/login completion;
- dialog cancel while device poll is in flight;
- server shutdown with pending attempts.

All route-binding/cursor mutations use transaction + CAS/revision. Provider network I/O
must never occur inside that transaction.

## 17. Performance requirements

Normal request routing must remain effectively O(1) after account projection/cache build.

Steady state:

- no full credential-table scan per token;
- no fork_credential scan per request after convergence;
- no remote validation per request;
- no workspace bootstrap;
- no per-account background polling timers;
- no global lock across unrelated credentials.

OAuth refresh:

- keyed by Credential.ID;
- one shared critical section per credential inside a process;
- re-read after ownership acquisition;
- if multiple writer processes share a Credential DB, storage-level lease/revision/CAS or
  enforced single-writer delegation supplies the cross-process boundary;
- no long DB transaction across network refresh I/O.

Provider config:

- bounded cache per credential/account + org;
- invalidated by relevant connection mutation;
- never refetched for every model request.

Public hosted catalog:

- no `/zen/v1/models` fetch per generation;
- short-TTL stale-while-revalidate cache;
- single-flight refresh;
- failed refresh preserves last known-good state;
- provider startup should not block indefinitely on hosted catalog discovery.

Route-scoped SDK/language clients:

- lookup remains O(1) by stable provider/model/route slot;
- credential refresh/config version change replaces or evicts the stale generation rather
  than accumulating one map entry per revision;
- credential removal purges that route's client slots;
- public catalog/capability version change invalidates only affected Public slots;
- no secret bytes participate in cache identity;
- stress test repeated token refreshes/config invalidations and assert cache cardinality
  returns to the bounded number of live provider/model/route slots.

## 18. File-level implementation map

### 18.1 Shared remote protocol

Likely touch/create:

- packages/core/src/plugin/provider/opencode.ts
- new shared provider-specific auth module near it
- packages/opencode/src/account/account.ts
- tests for both current plugin and Account.Service

Goal:

- one upstream Console protocol implementation.

### 18.2 Credential resolution

Likely touch/create:

- packages/core/src/credential.ts
- packages/core/src/integration.ts
- new credential resolver/helper
- credential/integration tests

Goal:

- one concurrency-safe OAuth refresh path.

### 18.3 Shared Integration auth kernel + global registry

Likely touch/create:

- `packages/core/src/integration.ts` — factor location-independent auth mechanics;
- a small Core integration-auth runtime/factory module if extraction keeps `integration.ts`
  simpler;
- a bootstrap-free global integration-auth registry/owner;
- explicit OpenCode global auth registration reusing the same provider registration as
  Core `OpencodePlugin`;
- focused Core + server architecture tests.

Dependencies:

- Credential.node;
- shared Credential resolver;
- EventV2.node;
- HttpClient;
- Scope;
- shared Console auth adapter.

Do not depend on Instance or workspace Plugin.Service. Do not create a permanent parallel
`ProviderAccountAuth` state machine.

### 18.4 Provider settings API

Likely touch:

- `packages/opencode/src/server/routes/instance/httpapi/groups/provider-settings.ts`;
- `packages/opencode/src/server/routes/instance/httpapi/handlers/provider-settings.ts`;
- global config schema/projection for routing defaults/overrides;
- provider availability projection (`connected` vs `publicAvailable`);
- safe routing-policy GET/PATCH endpoints;
- safe auth-method/attempt endpoints;
- explicit Session route-intent action surface where the existing Session API conventions
  place it;
- API composition only if needed;
- public OpenAPI exercise tests;
- generated SDK after schema update.

Security rule: routing-policy writes use only the process-global/user config authority;
project/worktree config cannot choose accounts or public-fallback policy.

### 18.5 UI

Likely touch:

- packages/app/src/components/dialog-connect-provider.tsx
- packages/app/src/hooks/use-provider-settings.ts
- settings-v2 provider tests
- e2e provider connect flow

### 18.6 V1 provider bridge

Likely touch/create:

- packages/opencode/src/provider/provider.ts
- packages/opencode/src/plugin/zen.ts only when Zen convergence begins
- provider catalog/config adapter dedicated to Console-authenticated remote config
- focused provider tests

### 18.7 Route/account projection and safe ingress

Likely touch/create:

- `packages/schema/src` provider-account identity + reusable safe ProviderRouteIntent
  contract;
- `packages/opencode/src/provider/account-resolution.ts`;
- provider/model route/account selection surfaces;
- `packages/opencode/src/oxp/schema.ts`;
- `packages/opencode/src/oxp/model-selection.ts`;
- OXP Session/worker control adapters;
- `packages/schema/src/scheduled-task.ts` + scheduled-task handlers/execution;
- `packages/schema/src/system-one.ts` + `packages/opencode/src/system-one/system-one.ts`;
- `packages/opencode/src/session/delegated-worker.ts`;
- `packages/opencode/src/session/subagent-delegation.ts`;
- special-agent/maintenance route-inheritance call sites.

Goal:

- external/user-owned surfaces can express Auto, Public, or a safe stable accountID
  without exposing credential handles;
- public and automatic survive normalization, persistence, delegation, scheduling, and
  inspection as distinct intents.

### 18.8 Shared account router forward-port

Source donor/reference:

- `hosted-mt-t10c-cert:packages/opencode/src/provider/account-router.ts`;
- commit `15d9873b52`;
- architecture source `2caf5abd1f:docs/plans/multi-credential-routing/ARCHITECTURE.md`.

Likely land/touch:

- `packages/opencode/src/provider/account-router.ts`;
- provider-neutral router tests;
- account candidate adapters for Console OAuth and Zen/Go;
- provider client cache identity;
- mandatory durable provider-route binding/cursor store + schema migration;
- shared global routing-policy config projection.

Goal:

- one secret-free configurable account-selection engine shared by OAuth and API-key
  accounts.

### 18.9 OpenCode hosted-service compatibility owner

Likely touch/create:

- `packages/core/src/installation/version.ts` — separate product/build version from
  upstream-hosted compatibility version;
- `packages/opencode/script/build.ts`;
- `packages/opencode/script/build-node.ts`;
- `script/fork-sync.ts` — verify/update the committed upstream compatibility baseline as
  part of tag-sync workflow;
- `keep-manifest.json` or one small dedicated committed fork-sync metadata file;
- `packages/opencode/src/session/llm/request.ts`;
- `packages/opencode/src/system-one/system-one.ts`;
- any first-party/special-agent request lowering that bypasses the common request path;
- focused sanitized wire-contract/build-metadata tests.

Goal:

- one compatibility owner for OpenCode-hosted request identity/shape, independent of
  account routing, credential lifecycle, and OpenFork product-version numbering;
- one committed upstream compatibility baseline that fork-sync and build tooling both
  validate.

### 18.10 Public free-model route/catalog

Likely touch/create:

- `packages/opencode/src/plugin/zen.ts` — reuse/generalize the existing hosted model-list
  fetch infrastructure without breaking System One;
- `packages/opencode/src/provider/provider.ts` — intersect trusted zero-cost metadata with
  hosted availability and preserve the public sentinel;
- normal global database/cache schema + service for last-known-good public catalog and
  bounded expiring public route health;
- public-lane fixture/integration tests, including process-restart behavior.

Goal:

- the full current upstream-documented free-language set is represented safely, while
  representative models remain usable with zero credentials and catalog freshness/hosted
  compatibility are independently observable.

### 18.11 Durable provider-route ledger and settlement attribution

Likely touch/create:

- normal Core database schema/migration for route binding + router cursor/stat state;
- `packages/opencode/src/provider/*` route-binding/store/service implementation;
- `packages/opencode/src/provider/account-router.ts` production adapter;
- `packages/opencode/src/session/processor.ts` — accept authoritative RouteAttribution;
- `packages/opencode/src/session/llm/ai-sdk.ts` and `native-runtime.ts` — preserve
  observed physical account metadata as validation evidence;
- `packages/core/src/usage/sql.ts` + UsageRecord settlement contract — add route kind;
- maintenance/yield usage schemas where hosted support-agent calls require the same
  attribution;
- migration/backfill tests and Session delete/archive lifecycle tests.

Do not add a second JSON field to `Session.model` as the route ledger. Model selection and
provider route affinity have different lifecycles.

Goal:

- one transactional `(sessionID, affinityDomain)` source of truth for public/account
  affinity and route revision;
- historical Usage explicitly distinguishes public, account, and legacy/unknown
  attribution after live Session state is deleted.

## 19. Implementation phases and proof gates

### P0F — prove/fix anonymous public free generation first

This tranche precedes auth work because free-model access is an independent OpenCode
provider contract. If the current tree already passes it, P0F is a short evidence-gathering
gate. If it fails with `FreeTierError`, `MissingSessionID`, "use OpenCode", "update
OpenCode", or equivalent, fixing that compatibility path is mandatory before P1.

Tasks:

1. with **no** OpenCode/Zen/Go credential configured, capture the current public Zen
   `/v1/models` list, current upstream free-model documentation, and current trusted
   Models.dev metadata into the machine-readable coverage fixture from §6.7;
2. require every currently documented free **language** model that the hosted catalog
   advertises to resolve to trusted execution metadata; resolve any gaps by refreshing
   Models.dev or adding a narrow source-backed compatibility row — never by guessing;
3. manually exercise every currently documented free language model once during initial
   qualification and record any upstream request-class limitation explicitly;
4. choose representative free models for reproducible positive-control fixtures and run
   them through a current official OpenCode build;
5. record that official build's exact upstream release/tag/version and persist the
   corresponding OpenFork hosted-compatibility baseline fixture;
6. capture the sanitized final official request: URL family, method, User-Agent,
   `x-opencode-*` identity fields, streaming semantics, tool-name set, and provider body
   shape;
7. run the same no-credential representative models through OpenFork's real V1
   primary-turn path;
8. prove transport uses the public sentinel and sends no stored provider credential;
9. compare final post-lowering requests against the positive controls;
10. correct only demonstrated hosted-compatibility differences;
11. add explicit non-retryable classification for request-admission errors;
12. capture successful public response + route/Usage attribution;
13. add a regression that removes/renames every local OpenCode credential fixture and
    still completes public requests;
14. replace the V1 input-cost-only anonymous filter with the trusted free-classification
    predicate and test zero-input/nonzero-output, nonzero cache/tier cost, unknown cost,
    explicit source-backed free promotion, and stealth-free/no-`-free`-suffix cases;
15. add coverage tests for `fresh`, `stale`, `expired`, affirmatively removed, and
    missing metadata states;
16. persist one fresh/one stale last-known-good catalog fixture, restart the service with
    `/models` unavailable, and prove freshness age + public visibility survive restart
    correctly; malformed refresh must not overwrite the snapshot;
17. persist a public quota cooldown with a known reset, restart, and prove it suppresses
    immediate retry until expiry without affecting account health;
18. build/test with an intentionally different OpenFork product version while keeping
    the verified upstream compatibility baseline fixed; hosted request identity must
    remain identical.

Gate:

- 100% of current upstream-documented free language models that the live hosted catalog
  advertises have trusted execution metadata; additional hosted IDs enter the public set
  only when independently classified free by exact trusted metadata/source evidence;
- every initially qualified free language model has one recorded live result;
- representative free models succeed through real OpenFork V1 with zero OpenCode
  credentials;
- the wire contains no stored account secret and attribution is `routeKind=public` with
  no accountID;
- representative final request contracts are backed by same-day official-client positive
  controls;
- changing the OpenFork product/build version alone does not alter the verified
  OpenCode-hosted compatibility identity;
- `opencode-go` cannot use the public route;
- request-admission errors do not rotate accounts, retry repeatedly, or mutate auth
  health.

### P0 — freeze remote contract fixtures

No production mutation.

Tasks:

1. capture latest upstream source for:
   - Core OpenCode plugin;
   - Integration;
   - Credential;
   - connect dialog;
   - Account.Service;
2. record exact Console auth requests/responses as typed fixtures;
3. capture authenticated /api/config from:
   - a device-OAuth Console account;
   - a service-account/API key where available;
   - a second independently enrolled account/org when available, specifically to prove
     whether model/endpoint/entitlement config is account-specific;
4. diff those config snapshots and record which provider IDs, endpoints, headers, model
   IDs, costs, limits, and statuses are stable versus account/org-specific;
5. record the exact current official OpenCode generation User-Agent/source implementation
   and upstream tag/version for the release used as positive control. Do not substitute
   the fork's `InstallationUserAgent(...)` assumption;
6. prove the committed upstream-hosted compatibility metadata agrees with that sync
   baseline and that `fork:sync verify --tag` can detect drift;
7. verify desktop device-auth URL behavior;
8. capture one current official-client free-tier request as a sanitized positive control;
9. capture the same model/account through OpenFork and compare the **final** wire request,
   including endpoint, User-Agent, session/request/client identity, stream semantics, and
   tool-name surface;
10. repeat that compatibility capture for the V1 primary turn, V1 Title, SPAD, Prompt
    Revisor, Goal Auditor, compaction, delegated/subagent execution, custom primary
    agents, and System One when each class can select the model. Include same-model
    built-in-subagent A/B controls (for example the class of `general`-works /
    `explore`-fails regressions observed upstream) so request-class differences are
    isolated from model/account differences;
11. capture any direct Core/current LLM route separately; do not assume the V1 compatibility
    wrapper applies to it;
12. record whether `FreeTierError` is reproducible independently of credential validity
    and which request class/lane produced it;
13. add documentation fixture metadata with upstream commit/date, product version,
    upstream compatibility version, credential class, and capture timestamp.

Gate:

- we can state exactly what bytes OpenFork must send and what remote config it must interpret;
- a known-good free-tier request has a reproducible positive control;
- auth/quota failure and request/service-admission failure are distinguishable.

### P1 — shared Console auth protocol

Tasks:

- extract request/response schemas and HTTP operations;
- make Core OpencodePlugin use it;
- make Account.Service use it;
- preserve external behavior;
- add protocol contract tests.

Gate:

- existing current plugin and Account CLI tests pass;
- no second implementation remains for device code/token/refresh/user/org/config semantics.

### P2 — shared credential resolver

Tasks:

- extract one concurrency-safe Credential OAuth resolver;
- define one strictly-monotonic trusted credential revision used by refresh CAS and
  authenticated-client cache isolation; either make `time_updated` strictly monotonic or
  add/increment a dedicated integer revision;
- port Integration's keyed refresh + re-read semantics into it;
- make location-scoped Integration, future global Integration auth, V1 Console transport,
  and trusted quota/config probes consume it;
- prove whether Credential has one OS-process writer per database;
- if not, implement the storage-level lease/revision/CAS contract from §7.4;
- test refresh rotation, removal, crash/recovery, and races.

Gate:

- 100 concurrent resolves for one expired credential in one process cause one effective
  refresh;
- global and location Integration runtimes in the same process share that same refresh
  critical section;
- unrelated credentials refresh concurrently;
- token rotation cannot regress to an older persisted refresh token;
- two credential mutations forced into the same wall-clock millisecond still produce
  distinct ordered revisions;
- if multi-process DB sharing is supported, concurrent processes cause one effective
  refresh and a crashed refresh owner cannot permanently wedge the credential;
- otherwise, architecture tests prove/enforce the single credential-writer invariant.

### P3 — shared Integration auth kernel + global registry/API

Tasks:

- factor the existing Integration attempt/connection lifecycle into the shared kernel;
- make location-scoped Integration consume that kernel without behavioral drift;
- register OpenCode's OAuth/key methods in a bootstrap-free global registry;
- expose provider-settings auth/attempt endpoints over that global Integration runtime;
- persist successful provider OAuth through the same Core Credential settlement path;
- regenerate SDK;
- add zero-Instance instrumentation tests.

Gate:

- full device flow can complete through local API with no workspace;
- list/start/status/cancel each create zero Instances;
- location-scoped and global auth runtimes pass the same attempt/settlement conformance
  suite;
- only one implementation owns refresh/persistence/attempt transition semantics.

### P4 — global UI hookup

Tasks:

- expose global auth methods;
- route no-directory OAuth through provider-settings;
- retain key method;
- reuse existing OAuth auto UI;
- wire cancellation/back/unmount;
- refresh provider account rows.

Gate:

- Settings -> Providers can add a Console account through browser/device OAuth from server/global settings;
- multiple credentials remain visible and independently selectable;
- no synthetic directory is created;
- **release visibility remains feature-gated** until P5A durable route semantics and P5B
  public/authenticated compatibility proofs pass. Internal bring-up may use the flow
  earlier, but a production release must not let connecting an account regress the
  public-free path.

### P5 — V1 Console provider bridge

Tasks:

- resolve active/pinned OAuth Credential in V1 provider path;
- fetch/cache `/api/config` through the shared Console adapter **per credential handle/org**;
- build the account capability index and merged account-neutral catalog described in §7.7;
- project the **selected account's** provider/model semantics into V1 provider construction;
- attach the selected account's correct bearer/org auth at transport;
- make authenticated provider/language client cache identity include credential handle/version;
- keep Zen/Go key paths unchanged.

Gate:

- an OAuth-connected Console account can execute at least one authenticated model through the **V1 production runtime**;
- two enrolled accounts with distinct fixture config cannot cross endpoints, org headers,
  capabilities, or authenticated client cache entries;
- wire endpoint/header/body match the selected account's captured upstream config;
- no current/V2 session runtime is involved.

### P5A — land durable provider routing + forward-port account-router policy

Tasks:

- create the transactional `(sessionID, affinityDomain)` provider-route ledger from
  §7.10 with explicit `routeKind=public|account` and CAS route revision;
- create/reconstruct the durable cursor + assignment state needed by the account policy;
- forward-port the **policy semantics**, not the in-memory storage implementation, from
  `15d9873b52` against current `main`;
- compose the provider-route resolver above the account router: public is a route class,
  never a fake account candidate;
- introduce the immutable ProviderRouteLease from §11.4.1 and compile that exact route
  into provider/fetch construction;
- cut P5A production generation paths away from `resolveZenRequest()` as a routing
  authority; legacy resolver may remain only behind explicitly transitional callers;
- cut System One over to the shared route-intent/lease model: Session-owned calls inherit
  a lease; standalone calls resolve one explicit/Auto route per inference without
  fabricating a Session, and `affinityID` remains non-authoritative for route choice;
- bind Console OAuth credentials into the secret-free candidate projection using the
  account-specific capability snapshots from §7.7;
- use a stable opaque credential handle across refresh while keeping remote
  `ProviderAccount.accountID` separate for accounting;
- adapt existing Zen/Go accounts into the same candidate vocabulary without deleting the
  old router yet;
- reject candidate/provider/affinity-domain mismatches before ranking;
- make failover carry an explicit exclusion set for handles already attempted by the
  logical request. The donor's `concentrate` failover ignores `failedHandle` and can
  otherwise reselect the same still-marked-eligible account before governor state catches
  up, incorrectly returning `no-eligible-account` while another account exists;
- make provider-specific governors decide whether unknown entitlement is admissible rather
  than letting the generic router interpret every `servesModel: "unknown"` identically;
- preserve richer hard-ineligibility causes such as account-forbidden without collapsing
  them into an auth failure;
- wire global/per-provider routing policy configuration;
- add trusted `RouteAttribution` to dispatch/SessionProcessor/settlement;
- add Usage `route_kind` attribution so public != legacy/unknown;
- make response-observed account metadata validate the selected account rather than
  replace the selected route as settlement authority;
- reconcile binding capacity on Session delete/crash recovery while preserving archive
  affinity;
- prove hard/soft pins, public/account cross-kind rules, and cross-process stale-failover
  CAS.

Gate:

- two or more OAuth credentials for OpenCode can coexist and be deterministically routed
  by Session without exposing tokens to the router;
- a zero-credential Session can bind durably to `opencode:public` without fabricating an
  account;
- adding/selecting/removing a credential does not change an existing healthy public or
  account route binding;
- a public lease reaches the wire with the public sentinel even when env, legacy Auth,
  provider config, Core Credential, and the legacy Zen pool all contain account
  credentials; no generic SDK/provider layer can backfill them;
- an account lease reaches the exact selected credential and cannot be replaced by a
  different env/default/config/pool account;
- every production V1 OpenCode generation path either consumes ProviderRouteLease or is
  explicitly blocked from P5A release cutover;
- System One Session-owned public/account inference uses the parent lease; standalone
  explicit Public/account routes compile exactly once and cannot be overridden by the Zen
  pool; `affinityID` never changes route kind;
- `concentrate` and `session-round-robin` preserve healthy account affinity across a
  process restart;
- concurrent routers/processes cannot double-assign a stale round-robin cursor or overwrite
  a newer route revision;
- a credential refresh does not rebind the Session;
- explicit account choice is fail-closed;
- account <-> public transition occurs only under the documented cross-kind rebind policy;
- deleting a Session removes its live route binding while Usage attribution remains;
- a cross-provider candidate is rejected even if a caller accidentally supplies it;
- no generic provider/network/request-policy failure causes pool-wide credential hopping
  or public/account hopping.

### P5B — hosted-client/free-tier compatibility proof

P5B is a **final integration proof gate**, not a dependency that must execute before P6.
Implement P6 route/intent propagation first, then run P5B against the resulting complete
downstream execution graph.

Tasks:

- re-derive the final OpenCode-hosted request identity policy from the P0 positive control;
  remove or change fork-authored assumptions that do not match the observed upstream contract;
- verify primary V1 generation after all provider/AI-SDK lowering;
- verify the actual V1 Title, SPAD, Prompt Revisor, Goal Auditor, compaction, delegated/
  subagent, and System One paths rather than testing only Core donor implementations;
- add focused account-propagation assertions: an explicit account must remain identical
  from special-agent model resolution through dispatch and settlement;
- separately verify any direct Core/current LLM route that can reach an OpenCode-hosted
  model;
- compare against the P0 official-client positive control;
- classify `FreeTierError`, `MissingSessionID`, and equivalent service-admission
  errors separately from credential/auth failures and scope them by request
  class/model/lane;
- keep those distinct from the already-recognized `FreeUsageLimitError`: the latter is
  published free-quota exhaustion/upsell state, while the former is request/client
  admission and is not evidence that another credential has quota;
- make request/client admission failures non-retryable by the ordinary Session retry
  policy unless the remote response explicitly identifies a transient condition. The
  current `session/retry.ts` has no explicit `FreeTierError`/`MissingSessionID`
  classifier, so a gateway status that looks generically retryable could otherwise waste
  repeated identical turns;
- ensure admission failure does not mutate account auth health or trigger router failover
  without an independent account-local signal;
- capture the current upstream endpoint/lane distinction for API-key versus OAuth
  credentials;
- if a request class is intentionally unsupported by the free service, encode that as
  model/request-class eligibility rather than manufacturing fake core tools or client
  identity.

Gate:

- the 100%-coverage fixture from P0F still covers all current upstream-documented free
  language models that remain hosted, plus any additional hosted IDs independently
  classified free by trusted evidence, after P3/P5/P5A/P6 changes;
- representative currently advertised free language models still succeed through the real
  OpenFork V1 primary-turn path with **no credential** when the current official client
  supports that public flow;
- the same compatibility owner also works for an authenticated OpenCode account without
  conflating the public and account routes;
- each maintenance/special-agent request class either matches a demonstrated official
  flow or is deliberately excluded/rerouted with a typed admission reason;
- an explicit account survives Goal Auditor/Prompt Revisor/Title/SPAD resolution without
  silently becoming the active/default account;
- no test passes merely because it mocks before the final provider transport.

### P6 — downstream route/account propagation

By this phase, P5/P5A must already have defined the durable ProviderRoute binding plus
stable Console `ProviderAccount.accountID`/credential-handle mapping. P6 propagates those
established identities into the remaining product surfaces; it does not invent routing
identity after dispatch.

Tasks:

- propagate **route intent** (`auto|public|account`) through OXP Session control, worker
  policy, scheduled-task actions, swarms/delegation, and trusted Session creation;
- propagate accountID only where an account route exists; public remains account-free;
- extend delegated/subagent protected-policy comparison and lineage metadata so Public
  and Auto cannot compare equal solely because both lack accountID;
- make same-Session maintenance/special-agent calls inherit the current ProviderRouteLease
  when using the same model policy; derived child Sessions persist the authorized route
  before first dispatch;
- propagate `routeKind`/route attribution through Usage and maintenance/support-agent
  accounting so public is distinguishable from legacy unknown;
- keep public routes account-free in OXP/scheduler/UI projections;
- remove legacy call sites that silently substitute active/default when an explicit
  accountID is present;
- ensure dispatch, provider execution, message settlement, Usage, and quota/capacity
  observe the same committed route/account identity;
- expose safe account metadata without exposing credential handles as mutable user-facing
  identity.

Gate:

- explicit account selection survives restart and routes deterministically;
- explicit Public intent survives OXP normalization, scheduled-task persistence, worker/
  subagent delegation, and restart without becoming Auto;
- public route binding survives restart with no fabricated accountID;
- same-policy Title/SPAD/Prompt Revisor/Goal Auditor/compaction uses the parent Session
  route rather than independently resolving Auto;
- a child inheriting public/account route creates a matching durable child binding before
  first dispatch; resumed child binding remains authoritative;
- every downstream consumer observes the same routeKind and, for account routes, the same
  accountID selected at routing;
- removing a pinned account makes the selection fail closed rather than selecting the
  active/default account or public route;
- historical Usage remains correctly attributed after the live Session/route binding is
  deleted.

### P7 — Zen/Go storage convergence

Tasks:

- introduce unified projection over Credential + fork vault + legacy/env;
- build observe/import migration;
- import fork keys into Credential;
- cut Zen router to trusted Credential resolution;
- preserve stable zen-* IDs and usage attribution;
- switch to single-write.

Gate:

- existing Zen/Go users see identical accounts, labels/defaults, models, quota, and historical usage before and after migration.

### P8 — legacy retirement

Only after a soak window.

Tasks:

- stop normal writes to fork_credential;
- reduce Auth.Service to compatibility inputs still required;
- retain migration shims;
- decide historical fork_message_credential future separately;
- update FORK.md and architecture docs.

Gate:

- no live product path requires duplicate provider-secret ownership.

## 20. Test matrix

### 20.1 Remote protocol

- device-code request exact client_id;
- relative and absolute verification URL normalization;
- reject non-HTTP(S) verification URL;
- pending;
- slow_down;
- denied;
- expired;
- malformed token response;
- refresh success with rotated refresh token;
- refresh 401/403;
- user decode;
- org decode;
- provider-config 404;
- provider-config malformed;
- x-org-id presence/absence.

### 20.2 Attempt lifecycle

- auto completion;
- code completion if a future method uses code mode;
- cancellation;
- timeout;
- status after completion;
- terminal retention cleanup;
- shutdown cleanup;
- duplicate completion is safe;
- cancel/complete race.

### 20.3 Credential storage

- add OAuth without replacing existing;
- add service-account key without replacing existing;
- active select;
- rename;
- remove active;
- deterministic fallback/no-active semantics, including same-millisecond credential creation;
- metadata round trip;
- secret never returned by list API.

### 20.4 Refresh concurrency

- one credential, 100 concurrent resolves -> one effective refresh;
- global + location Integration runtimes in one process share the same refresh lock;
- multiple credentials refresh concurrently;
- refresh while credential removed;
- stale reader after another refresh;
- refresh persistence failure;
- old refresh token never overwrites newer result;
- strictly-monotonic revision survives same-millisecond mutation tests and advances on
  any mutation that can change trusted provider-client behavior;
- if multi-process DB sharing is supported: two processes racing one expired credential
  produce one committed rotated token and the loser re-reads it;
- crashed durable refresh lease expires/recoveries when that mechanism is enabled;
- otherwise, startup/architecture enforcement proves only one credential writer exists.

### 20.5 Architecture

Assert zero workspace Instance creation for:

- provider-settings list;
- public-catalog load/refresh;
- public availability/free-model projection;
- auth methods;
- OAuth start;
- attempt status;
- attempt cancel;
- credential select;
- credential remove;
- refresh;
- provider account list.

Public catalog startup/refresh is Tier 0 network/cache work. It may use the process-global
database/cache and HTTP client, but never `Instance`, workspace Plugin.Service, or a
synthetic directory.

### 20.6 UI

- global OpenCode shows OAuth + service-account methods;
- directory-scoped flow still works;
- device URL opens;
- code/instructions display;
- poll completes;
- poll fails;
- cancel/back stops polling;
- second account can be added;
- active account can be switched;
- rename/remove work;
- no secret appears in DOM/network list response;
- zero credentials may show `connected=false` and `publicAvailable=true` simultaneously;
- trusted+advertised public models remain visible/selectable while disconnected;
- paid/account-only models are not presented as publicly runnable;
- route chooser distinguishes Auto / Public free / real accounts;
- Public free is disabled for a model that is not currently public-eligible;
- `public-first-for-free` is the effective built-in OpenCode default;
- `account-first` / `public-first-for-free` preference persists globally and is not
  writable from project config;
- route-specific errors are distinct: public catalog, auth missing, account missing,
  public quota, and hosted admission.

### 20.7 V1 execution

- OAuth Console credential -> remote config -> provider model -> request;
- account-pinned request;
- removed pinned account fails closed;
- before P5A, active/default switch preserves the legacy unpinned behavior;
- after P5A, active/default switch does not move an existing healthy session binding and
  can affect only future/unbound routing where the configured policy explicitly uses it;
- zero-credential Zen public/free primary generation succeeds;
- adding one OAuth credential does not delete or hide the public model catalog;
- removing the last OAuth/API-key credential restores/retains public eligibility without restart;
- a Session already bound `routeKind=public` remains public across credential add/select/remove;
- with a populated account pool, a public-bound Session still sends the public sentinel
  rather than being rewritten by `pool.defaultAccount()`;
- a public route-scoped provider client is never reused for an account route and vice versa;
- a Session already bound to an account does not silently become public;
- explicit Public free selection succeeds even when accounts exist, for a public-eligible model;
- `public-first-for-free` is the OpenCode default for new/unbound Sessions;
- `account-first` and `public-first-for-free` affect only new/unbound routing;
- Zen explicit @zen account unaffected;
- Go direct-auth precedence unaffected;
- Go never public-fallbacks.

### 20.8 Migration

- fork vault only;
- Auth only;
- Core Credential only;
- same key in multiple old stores;
- distinct keys in all stores;
- active/default preserved;
- labels preserved;
- interrupted import rerun;
- malformed legacy data leaves canonical data untouched;
- historical usage remains queryable.

### 20.9 Cross-system route/account identity

For an account route, assert the same accountID + routeKind reaches:

- model/account selection;
- durable provider-route binding;
- provider dispatch;
- SessionProcessor trusted RouteAttribution;
- message settlement;
- Usage;
- quota;
- capacity;
- reset events;
- OXP;
- scheduled task execution.

For a public route, assert:

- durable binding is `routeKind=public` with no accountID/credentialHandle;
- dispatch uses the public sentinel;
- SessionProcessor receives public RouteAttribution;
- Usage stores public explicitly rather than legacy/unknown;
- OXP/scheduler projections do not invent an account;
- absence of a routed-account response header does not erase public attribution;
- an unexpected account header on a public route is diagnosed as a route mismatch;
- an unexpected different account header on an account route is diagnosed and never
  silently settled as the observed account.

### 20.10 Shared router integration

- two Console OAuth credentials become two candidates with distinct opaque handles;
- their independently captured `/api/config` snapshots cannot cross model capability,
  endpoint, org, request-option, cost/limit, or cache state;
- one visible model may be zero-cost via Public and priced via account A; public settlement
  uses the public execution definition and account-A settlement uses account A's
  route-specific cost/limits;
- account-neutral discovery/presentation cost is never consumed for execution settlement;
- access/refresh token rotation leaves the selected handle unchanged;
- authenticated-client cache entries are isolated by handle/revision;
- an opaque OAuth account ID that does not start with `zen-` survives
  Session/OXP/scheduler selection without being forced into the legacy suffix ABI;
- `concentrate` preserves already-used accounts while healthy;
- `session-round-robin` assigns new sessions evenly and keeps them sticky;
- configured durable affinity survives process restart;
- concurrent routing owners cannot corrupt the round-robin cursor or route revision;
- explicit hard pin never silently switches;
- soft/automatic binding fails over only on adapter-certified account-local failure;
- concentrate failover excludes the failed/attempted handle even before asynchronous
  health-state propagation completes;
- stale failure cannot overwrite a newer manual selection;
- wrong-provider/wrong-affinity-domain candidates fail closed;
- `FreeTierError`/service-admission failure alone does **not** set `AUTH_INVALID`;
- `FreeUsageLimitError` on public does not schedule repeated identical retries or consume
  the account failover budget;
- public quota exhaustion does not change account-candidate health;
- account quota exhaustion does not disable the public route;
- response-observed account metadata can detect route mismatch but cannot overwrite the
  committed settlement route;
- Zen compatibility alias resolves to the same stable handle mapping after migration;
- Session archive preserves route binding; Session deletion removes live binding while
  historical Usage remains;
- crash/startup reconciliation repairs derived active-binding capacity.

### 20.11 Hosted free-tier compatibility

- final wire request matches the **captured current** OpenCode-hosted identity contract;
- session/affinity identity matches the captured contract for that request class rather
  than a fork-authored regex assumption;
- official-client and OpenFork positive controls use the same endpoint family expected
  for the credential type;
- streaming/body semantics match the current upstream contract;
- primary build turn with normal tools;
- V1 title generation;
- SPAD Auditor;
- compaction;
- V1 Prompt Revisor;
- V1 Goal Auditor;
- delegated/subagent turn, including same-model built-in agent A/B controls;
- custom primary agent on the same Session/model as a built-in primary control;
- System One where the model is supported;
- direct Core/current routes are tested separately if they can reach the hosted model;
- an explicit account remains identical through every request class and settlement;
- missing/changed compatibility property produces a typed request-admission failure in
  the fixture harness, not credential invalidation;
- API-key and OAuth lanes are tested independently;
- fixture metadata records official client commit/version, upstream compatibility
  tag/version, and observed User-Agent so a future remote-contract change fails loudly
  without assuming a particular version floor;
- build with OpenFork product version `X` and hosted compatibility version `Y`, then
  rebuild with product version `Z` and the same `Y`: hosted OpenCode identity is
  byte-identical;
- advancing the hosted compatibility baseline to a new verified upstream tag changes the
  hosted identity only according to the captured upstream wire contract;
- `fork:sync verify --tag` fails when committed hosted-compatibility metadata is stale.

### 20.12 Public free-model route

- zero stored OpenCode/Zen/Go credentials -> trusted free language model remains selectable;
- transport Authorization resolves to the public sentinel and never to stale `auth.json`;
- no ProviderAccount/accountID/credentialHandle is fabricated for the public route;
- settlement records `routeKind=public` and the exact model/provider;
- current hosted `/models` ID + trusted free classification/execution metadata -> public eligible;
- zero input cost with nonzero output/cache/tier cost -> **not** public eligible absent an
  explicit source-backed free-promotion classification;
- trusted metadata + current hosted absence -> remotely unavailable;
- hosted ID + missing trusted metadata -> catalog-drift diagnostic, not unsafe synthesis;
- hosted-catalog timeout/failure preserves last-known-good state and does not erase the
  entire public catalog;
- last-known-good catalog survives process restart without its `fetchedAt` age resetting;
- malformed/non-2xx refresh cannot overwrite the durable last-known-good snapshot;
- fresh -> stale -> expired transitions obey the configured clocks;
- successful current catalog omission immediately invalidates that model's public
  eligibility even if an older snapshot included it;
- expired snapshots are excluded from Auto; explicit Public free follows the one-forced-
  revalidation/last-known-good attempt policy from §6.7;
- one public-catalog refresh is single-flight under concurrent provider loads;
- `FreeUsageLimitError` yields user-visible quota/upsell state but no immediate retry;
- public cooldown/quota with trustworthy reset survives restart, expires automatically,
  and never changes any ProviderAccount candidate state;
- `FreeTierError` / `MissingSessionID` yields request-admission state but no retry, auth
  invalidation, account hopping, or public/account hopping;
- a Title-only admission failure does not globally disable public primary generation;
- public Session binding survives adding/selecting/removing an OAuth account;
- account-bound Session does not fall back to public after 401/402/429/FreeTierError;
- explicitly pinned account never public-fallbacks;
- `opencode-go` rejects `routeKind=public`;
- no public request carries access token, refresh token, account API key, org header, or
  account capability snapshot;
- with `OPENCODE_API_KEY`, legacy Auth key, config apiKey, Core Credential, and Zen pool
  default all populated with distinct sentinels, explicit/committed Public still emits
  only the upstream public sentinel;
- explicit account A with unrelated env/config/pool account B emits only A;
- free primary generation is rerun after P3, P5, P5A, P6, and P7 as a non-regression
  gate.

### 20.13 Route-intent ingress and lineage

Backward compatibility:

- legacy OXP selection with accountID A + no routeIntent -> explicit account A;
- legacy OXP selection with no accountID/routeIntent -> Auto;
- legacy scheduled task model.accountID A + no routeIntent -> explicit account A;
- legacy scheduled task with no accountID/routeIntent -> Auto;
- conflicting accountID A + routeIntent account B -> validation failure;
- accountID present + routeIntent public/auto -> validation failure;
- routeIntent public never materializes as `accountID="public"` or a `@public` model suffix.

OXP Session/worker:

- explicit Public survives normalize -> control -> durable binding -> inspection round-trip;
- Auto and Public with identical provider/model/variant compare as **different intents**;
- OXP worker policy can authorize public without authorizing an account handle;
- account labels/aliases canonicalize to stable accountID before route binding;
- changing global default does not mutate an OXP Session already bound public/account.

Scheduled tasks:

- new Session + explicit Public task -> public binding exists before first provider call;
- new Session + account A task -> exact account A binding or fail closed;
- reused Session + omitted route intent -> preserve healthy existing binding;
- reused public Session + explicit account A task -> deliberate CAS rebind before prompt;
- failed deliberate rebind aborts run; it does not execute under prior/Auto route;
- persisted task survives restart with Public distinct from Auto.

Delegation/special agents:

- public parent + inherited same-model child -> child binds public before first dispatch;
- account A parent + inherited child -> child binds account A;
- explicit child route B requires delegation authority and never silently falls back;
- resumed child preserves its own binding even if parent/default route changed;
- nested public delegation metadata never contains a credentialHandle;
- protected-policy equality distinguishes Auto from Public;
- same-policy Title/SPAD/Prompt Revisor/Goal Auditor/compaction consumes parent lease;
- a maintenance route override, where explicitly configured, settles under its own route
  attribution and is never reported as the parent public/account route.

System One:

- Session-owned System One inherits the parent public/account lease;
- standalone routeIntent=public uses the public sentinel even with populated account pool;
- standalone routeIntent=account(A) uses exact A or fails closed;
- standalone Auto follows current provider policy for that one call;
- same `affinityID` with different explicit route intents does not change/override those
  intents; affinityID is never route authority;
- legacy accountID input maps to account route intent during compatibility window;
- accountID + public routeIntent conflict fails validation.

## 21. Observability

Add narrow diagnostics without secret material.

Useful fields:

- providerID;
- credentialID;
- accountID;
- authType;
- attemptID;
- attempt state;
- remote server host;
- orgID;
- refresh performed boolean;
- provider-config cache hit/miss;
- routing source: pinned / active / env / legacy;
- credential handle (opaque only);
- routing mode;
- route revision;
- affinity domain;
- bind reason;
- compatibility route family;
- upstream-hosted compatibility tag/version and observed client identity;
- sanitized hosted error type, including `FreeTierError` separately from auth errors.

Never log:

- key;
- access token;
- refresh token;
- full Authorization header;
- raw remote auth response.

Metrics worth retaining:

- auth start/completion/failure count;
- attempt duration;
- refresh count/failure count;
- refresh deduplication ratio;
- remote config latency/cache hit rate;
- account-resolution failures;
- routeKind (`public` / `account`);
- public-catalog refresh success/failure/age;
- trusted-vs-hosted free-model drift count;
- public-lane request-admission failures by request class;
- zero-Instance invariant counter in tests.

## 22. Rollback strategy

Every phase before legacy retirement should be independently reversible.

### P0F public compatibility

P0F fixes are the baseline, not collateral OAuth behavior. Once the no-credential public
lane is proven against the current official client, later phase rollback must preserve
that known-good path unless upstream itself changes the service contract.

If the new generic public-catalog reconciliation misbehaves, fall back to the last
known-good trusted public model set/compatibility path rather than requiring OAuth.

### Before P5

If global OAuth UI/API is faulty:

- hide/disable the OAuth method;
- API-key flow remains available;
- proven zero-credential public free flow remains available;
- existing Zen/Go routing remains otherwise untouched.

### P5 provider bridge

Guard the Console-authenticated V1 provider projection behind one internal capability/
feature gate during bring-up.

Rollback returns authenticated provider construction to the previous path without
deleting Credential rows and without disabling the public free route.

### P5A routing cutover

Keep a bounded compatibility adapter for pre-route-ledger V1 selection until P5A has
soaked. Rollback may stop creating new durable route bindings and return new/unbound
Sessions to current account-first behavior, but it must:

- leave existing route-binding rows intact for forward recovery;
- never reinterpret a persisted public binding as an account binding;
- preserve `usage_record.route_kind` historical data;
- never rewrite explicit account/public user intent into model suffixes.

Do not keep two mutable routing authorities active simultaneously. Feature-gated rollback
must choose one authority for new dispatch.

### Migration

Do not delete `fork_credential` during import/cutover.

A rollback can restore old Zen reads because source data remains intact.

Additive route/Usage schema columns/tables do not need destructive down-migrations during
product rollback; older-compatible code should ignore them safely where supported.

Do not roll back by rewriting user secrets from logs/exported projections.

## 23. Explicit non-goals

This project does not include:

- replacing OpenFork V1 execution with current/V2 execution;
- making OpenFork's local API OpenCode-compatible;
- restoring packages/console or upstream hosted backend source;
- changing ChatGPT/OXP authentication;
- building a generic secret broker;
- exposing credentials to agents;
- redesigning every third-party provider login;
- moving all secrets to OS keychain in the same tranche;
- deleting legacy credential data before proof;
- merging Console control-plane account selection with provider account selection by accident.

## 24. Remaining questions that require live service fixtures

These are factual remote-contract questions. Public-lane questions block P0F; authenticated account questions block P5, but none justify guessing the protocol.

1. Which free language-model IDs does the public Zen `/v1/models` endpoint advertise at implementation time, and which have sufficient trusted local metadata?
2. What exact final request identity/body/tool contract does the current official OpenCode client use for a successful no-credential free primary turn?
3. Which internal request classes (Title, SPAD, compaction, Prompt Revisor, Goal Auditor, built-in/custom subagents) are currently admitted to the public free lane by the upstream service?
4. What exact provider IDs and inference URLs does current Console `/api/config` return for a device-OAuth user?
5. Does that config vary by organization in ways that require organization to be part of ProviderAccount.accountID?
6. What exact config is returned for a Console service-account/API key versus a user OAuth token?
7. Which returned provider entries still target `/zen/**` versus newer Console inference endpoints?
8. Does any API-key path expose a stable non-secret remote key/account/workspace ID suitable for account identity?
9. Can one user OAuth account validly select multiple orgs for inference, and if so should OpenFork expose org as a sub-account rather than adopting upstream's first-org behavior?
10. Which remote errors distinguish no entitlement from invalid authentication for Go/Console paid models?

Capture public questions with real no-credential positive controls before P1 and authenticated questions with real account fixtures before P5. Do not infer either contract from documentation, model suffixes, or key shape alone.

## 25. Acceptance criteria

The port is complete only when all are true.

1. With zero OpenCode/Zen/Go credentials, every current upstream-documented free
   **language** model that the live hosted catalog advertises has trusted execution
   metadata and appears public-eligible. Additional hosted IDs appear Public only when
   independently classified free by exact trusted evidence; representative models
   succeed end-to-end through OpenFork's real V1 primary-turn path using the public route.
2. The public route sends no stored provider secret, carries no accountID, and is
   attributed as `routeKind=public`.
3. Global OpenFork Settings can offer **OpenCode Console account** and **API key (service account)** as separate connection methods.
4. Device OAuth completes without creating a workspace Instance.
5. OAuth access/refresh credentials persist durably and refresh safely.
6. Multiple OpenCode credentials can coexist.
7. Active/default credential preference is explicit and durable, and remains
   distinct from an existing Session's router binding.
8. The global and location-scoped auth surfaces share one Integration auth kernel rather
   than independent attempt/refresh/persistence state machines.
9. An OAuth-connected account can drive an authenticated model request through OpenFork's V1 runtime.
10. The request uses the endpoint/header/body semantics advertised by the selected
    account's current upstream Console config.
11. Existing Zen/Go API-key account routing remains correct.
12. Explicit account routing fails closed.
13. The exact account used on the wire is the account attributed to usage/quota/capacity.
14. OXP, scheduled tasks, workers, and delegation can represent `auto|public|account` route intent; account routes expose only stable safe accountID and no surface exposes credential handles/secrets.
15. No list/UI/event/log surface leaks key/access/refresh tokens.
16. Concurrent refresh cannot corrupt a rotated refresh token.
17. The local API remains fork-owned and bootstrap-free.
18. Existing legacy credentials remain recoverable throughout migration.
19. Architecture tests prove auth/account operations **and public-catalog availability/refresh** create zero workspace Instances.
20. FORK.md and architecture docs identify the final canonical owners.
21. The shared provider-neutral router **semantics** are forward-ported behind a
    durable routing owner rather than reimplementing policy inside OpenCode auth or
    adopting the donor's process-local Maps as production state.
22. Multiple Console OAuth accounts can participate in `concentrate` and
    `session-round-robin` routing while remaining session-affine, account-capability
    isolated, and cache isolated.
23. Credential refresh/rotation never changes the stable router handle or silently
    rebinds a healthy session.
24. Public and account route bindings are distinct; adding/removing/selecting credentials
    cannot silently move an already-bound healthy Session between them.
25. `FreeTierError`/`MissingSessionID`/equivalent service-admission failure alone never
    causes credential invalidation, account rotation, or public/account hopping; only
    independently proven account-local auth/quota state may affect account health.
26. Every internal request class allowed to select a hosted free model either succeeds
    under a demonstrated current official-client contract or is deliberately excluded/
    rerouted with a typed admission reason rather than spoofed.
27. Explicit route intent survives ordinary turns, Title, SPAD, Prompt Revisor, Goal
    Auditor, delegated agents, OXP, scheduled tasks, swarms, provider dispatch, and
    settlement: Public never collapses to Auto/account, and account A never silently
    becomes the active/default credential.
28. Console OAuth account IDs do not require a fake `zen-` prefix; the legacy suffix
    ABI is contained to legacy provider adapters.
29. Two account-specific remote config snapshots cannot cross endpoint/org/model
    capability, cost/limit, or authenticated-client cache state; Public route pricing/
    limits are likewise isolated from account route definitions.
30. Hosted free-model availability is reconciled against trusted model metadata without
    synthesizing unsafe model definitions from names or suffixes alone.
31. OpenFork product/build versioning is independent from the committed upstream-hosted
    compatibility version; changing the former does not change hosted OpenCode identity,
    and advancing the latter requires a verified upstream sync plus refreshed wire
    fixtures.
32. For new/unbound OpenCode Sessions, Auto defaults to `public-first-for-free` when the
    selected model is currently public-eligible; explicit account pins and existing
    durable bindings remain authoritative.
33. Under `public-first-for-free`, public quota/cooldown/request-admission failure never
    silently becomes an account request. Account use requires explicit account intent or
    the user-selected `account-first` policy.
34. Explicit Public survives OXP normalization, scheduled-task persistence, delegation/
    nested delegation, special-agent execution, restart, and a populated account pool
    without acquiring an accountID.
35. Public/account SDK and language-client caches are route-isolated, use only non-secret
    identity/revisions, and remain bounded across repeated credential rotations/config
    invalidations.
36. Release qualification validates the **generated/embedded** provider metadata against
    the committed source-backed free coverage fixture; stale repository fixtures or
    cached Models.dev data cannot silently reduce the promised free-model set.
37. A committed Public lease wins over every local account credential source (env, legacy
    Auth, provider config, Core Credential, Zen pool/default); final wire auth remains the
    upstream public sentinel.

## 26. Recommended implementation order

The shortest safe path is:

~~~text
P0F prove/fix zero-credential public free generation
  ->
P0 capture authenticated + hosted-service fixtures
  ->
P1 deduplicate the Console remote-auth protocol
  ->
P2 centralize Credential refresh
  ->
P3 extract shared Integration auth kernel + global registry/API
  ->
P4 wire existing V2 connect UI to that API
  ->
P5 backport account-specific Console remote config into V1 execution
  ->
P5A forward-port durable shared provider-neutral account routing
  ->
P6 propagate stable account + route identity end-to-end
  ->
P5B prove hosted-client/free-tier compatibility on the complete final V1 wire
  ->
P7 migrate/converge Zen/Go key storage
  ->
P8 retire duplicate legacy ownership
~~~

Do **not** begin by rewriting Zen routing wholesale, deleting fork_credential, making the entire location-scoped Core Integration service global, or removing Account.Service. Extract only the location-independent auth kernel needed by the global registry.

The first proof is **not OAuth**. It is the public lane:

> With every OpenCode/Zen/Go credential removed from the test environment, select a currently hosted language model independently classified Public/free by trusted evidence and complete a real V1 primary-turn generation through the Zen public route. Prove no stored secret/account identity is used and compare the final wire contract with a current official OpenCode positive control.

Only after P0F passes should the first auth proof run:

> From global Settings, start upstream OpenCode Console device auth, complete it in the browser, persist one OAuth Credential through the shared Integration auth kernel, refresh/list/select it without an Instance, and use that exact credential to obtain its account-specific upstream provider config.

That ordering gives us a stable free baseline before auth and routing changes, then proves the authenticated bridge without destabilizing the existing Zen/Go behavior.

### Release cut line

P0F through P6 are implementation/proof increments, with P5B run afterward as the final hosted-integration proof; none is an individually shippable product milestone.
The new Console OAuth method stays behind its internal feature gate until all of these are
true in the same candidate build:

- P0F current free-model coverage passes;
- P5 authenticated V1 execution passes;
- P5A durable `public|account` routing passes, including public-first-for-free;
- P6 route intent/lineage propagation passes for OXP, scheduler, delegation, and
  maintenance/special-agent paths;
- P5B final-wire hosted compatibility passes for public and authenticated lanes across
  that complete downstream graph;
- the public regression suite passes with zero credentials **and** with multiple accounts
  configured.

This prevents a half-port where login works but merely having an account makes OpenFork
stop using the genuine free lane.

## 27. Final design verdict

OpenFork does not need to "copy OpenCode V2 auth."

The upstream work already present in the tree gives us the right remote semantics and most of the right data model. The missing piece is a **bootstrap-free ownership bridge** between the V2/new-layout global Settings experience and the mature V1 provider runtime.

The architecture should therefore:

- keep Core Credential as provider-secret authority;
- extract one Core Integration auth kernel used by both location-scoped and global auth surfaces;
- share one OpenCode Console remote-auth protocol implementation;
- expose only explicitly Tier-0-safe auth registrations globally;
- preserve the credential-free Zen public route as an independent first-class path;
- reconcile hosted free-model availability with trusted model metadata;
- preserve Account.Service as the separate Console control-plane domain for now;
- adapt authenticated account-specific Console provider config into V1 rather than migrating V1 to current runtime;
- keep public-vs-account route binding explicit and durable;
- preserve existing Zen/Go routing until the new flow is proven;
- converge old key storage only after account identity, route identity, and attribution are end-to-end deterministic.

That gives OpenFork upstream-compatible human login **and reliable access to the upstream public free-model lane** without surrendering fork-owned V1 runtime architecture or the multi-account behavior that OpenFork already does better than upstream.
