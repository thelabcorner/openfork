# Personalized Request Yield / Capacity — Architecture & Integration Ledger

Status: **OpenCode Go production path implemented / durable source of truth**
Owner: OpenFork usage + quota architecture
Date: 2026-09-21

This ledger is the implementation blackboard for replacing OpenFork's fragmented
"estimated requests left" logic with one mathematically grounded, process-global
personalized request-yield projection.

It is deliberately written from authoritative producer/storage outward, per
`AGENTS.md` and `docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md`.

---

## 0. Product intent

The primary user-facing question is:

> **Under the way I actually use this model/provider/account, how many equivalent
> generations does this entitlement effectively buy me?**

The system should expose, where evidence permits:

- personalized full-entitlement yield, e.g. `≈ 525 requests / 5h`;
- current remaining request-equivalents, e.g. `≈ 179 requests left`;
- active-use demand pace, e.g. `27 requests / active hour`;
- projected demand over a familiar interval, e.g. `≈ 135 requests / 5 active hours`;
- uncertainty / evidence quality;
- the binding provider constraint as supporting detail rather than the primary
  mental model.

The system must also provide useful cold-start estimates for models with no exact
personal history by transferring the user's historical workload and provider/model
priors through a hierarchical fallback.

### Product non-goals

- Do not require a completed 5h/week/month/credit-pack cycle before showing value.
- Do not equate "requests sent per hour" with entitlement capacity.
- Do not collapse all provider semantics into a fake USD budget.
- Do not make a UI component the estimator owner.
- Do not introduce per-row HTTP requests, message-history hydration, provider
  catalog hydration, or workspace `Instance` creation for yield display.

---

## 1. Repository architecture constraints

The root and package `AGENTS.md` files make this a **Tier 0 process/global**
domain:

- usage/quota/account metadata is explicitly Tier 0;
- Tier 0 must never materialize a workspace `Instance`;
- process/global usage projections must not depend on `Location.Service`,
  `InstanceState`, workspace plugins, tools, LSP, VCS, snapshots, or cwd fallback;
- dense UI consumes O(1) materialized projections;
- one shared snapshot/update path is preferred over N per-row/per-pane fetches;
- hidden mounted panels must not keep unnecessary polling, timers, history scans,
  or provider-catalog work alive;
- browser-safe contracts carry already-materialized scalars and semantic state;
  schema must not contain runtime inference logic.

### Required negative invariants

Every implementation phase must preserve:

1. **zero implicit workspace instances** for any yield/capacity read;
2. **zero metric-only message/part history hydration**;
3. **zero HTTP requests per model row**;
4. **zero independent estimator math in UI surfaces**;
5. **zero per-row/per-model timers**;
6. **one server-scoped client owner** for the capacity snapshot/update stream;
7. **bounded payload and bounded materialized model/account state**;
8. **bounded provider refresh fanout** and no refresh multiplication by mounted
   surfaces;
9. **no quota refresh caused by Usage page range/filter changes**;
10. **no usage-history scan caused by opening the model picker or composer**.

---

## 2. Mathematical invariants already established by microprototypes

The implementation must preserve these mathematical rules.

### 2.1 Estimate consumption first, then invert

For positive resource consumption per request `C`:

```text
Y = 1 / E[C]
```

is the request yield. Never average `1/C_i` per request. Jensen's inequality makes
that systematically optimistic.

### 2.2 Partial resource windows are valid evidence

For an observation interval containing `n` requests and exact resource burn `ΔQ`:

```text
μ_hat = ΔQ / n
Y_hat = n / ΔQ
```

A completed provider window is unnecessary.

### 2.3 Full history may be retained with O(1) runtime state

Exponentially decayed sufficient statistics update recursively:

```text
S_t = d_t S_(t-1) + x_t
W_t = d_t W_(t-1) + 1
```

Normal prediction does not need a full-history scan.

### 2.4 Old data is not equally weighted data

Keep all raw observations, but combine:

- current session;
- current resource window;
- short-decay personal history;
- long-decay personal history;
- current-regime lifetime;
- cross-regime personal workload prior.

The exact mixture weights / half-lives are empirical calibration parameters.

### 2.5 Hierarchical fallback beats abrupt replacement at small n

Sparse exact-model data should shrink toward a strong personal/provider/model prior
rather than replacing it after an arbitrary sample threshold.

### 2.6 Rounded quota telemetry is interval-censored

A percentage remaining unchanged is not zero consumption. Coarse provider
snapshots define an identification interval whose width shrinks with exposure.

### 2.7 Correlated requests reduce effective sample size

Session/request rows are not assumed iid. Confidence must account for clustering
or block dependence; raw request count is evidence volume, not confidence by
itself.

### 2.8 Predictive uncertainty has at least two components

- future request/resource process variance;
- parameter uncertainty in the learned consumption rate.

Cold-start estimates must therefore have wider intervals.

### 2.9 Multiple provider constraints combine in request-equivalent space

For resources `j` with remaining amount `R_j` and mean per-request consumption `μ_j`:

```text
N ≈ min_j (R_j / μ_j)
```

The minimum identifies the binding resource. Joint simulation may refine finite
budget p10/p50/p90.

### 2.10 Preserve raw workload across economic regime changes

Historical `cost_usd` can become stale after pricing changes. Token/workload
vectors remain reusable because they can be re-priced/re-normalized under current
economics.

---

## 3. Current architecture: what exists and what is wrong

### 3.1 Durable usage producer

`packages/core/src/usage/sql.ts`

`usage_record` already stores one settled generation:

- session;
- provider;
- model;
- variant;
- agent/mode;
- timestamps;
- cost;
- input/cache read/cache write/output/reasoning tokens.

This is the correct durable raw-history basis.

**Gap:** account/routing identity is not first-class in `usage_record`, even though
session/model routing already carries account identity. Account-qualified transport
model IDs can therefore fragment statistics.

### 3.2 Historical analytics owner

`packages/opencode/src/usage/usage.ts`

Existing `Usage.Service` is already bootstrap-free/global and owns:

- `summary()` — range-scanned analytics for the Usage page;
- `modelProfile()` — recent-200 cost/cache aggregates;
- `pricingCatalog()` — global ModelsDev pricing/catalog data.

Useful existing performance properties:

- dedicated read connection for large summary scans;
- one-query semaphore to prevent scan storms;
- revision-aware summary/profile caches;
- bounded chart payloads.

The new yield engine should **not** turn `summary()` into the hot-path source for
model-picker/limits/composer data.

### 3.3 Quota provider observation layer

`packages/opencode/src/quota/**`

The adapter registry is useful but its current output is too presentation-oriented:

- generic `UsageWindow` percentage/value-label shape;
- provider-specific side channels for WorkBuddy/Zen;
- client code often has to recover resource semantics.

The provider integration should evolve toward typed resource observations while
preserving existing fetch/cache/auth behavior.

### 3.4 Fragmented frontend estimators to retire

Current request-capacity logic is spread across:

- `packages/app/src/utils/model-usage-estimate.ts`;
- schema copy `packages/schema/src/model-select/usage-estimate.ts`;
- `dialog-select-model.tsx`;
- `use-workbuddy-usage`;

- `use-genspark-usage`;
- `usePersonalUsage` / `usage.modelProfile`;
- OpenCode Go fork-usage paths;
- OpenRouter special usage paths.

This violates the intended ownership model even where individual hooks are locally
optimized.

---

## 4. Target domain split

The new architecture has **five owners**, not one giant service and not a backend
estimator sitting on top of client-side quota pollers.

```text
settled generation ------------------------------+
                                                  |
                                                  v
+-----------------------------------------------+ |
| A. Durable Consumption Ledger                 | |
| raw settled workload + exact resource burns   | |
+-----------------------------------------------+ |
                    |                             |
                    v                             |
+-----------------------------------------------+ |
| B. Yield Statistics                           | |
| O(1) materialized multi-timescale state       | |
+-----------------------------------------------+ |
                                                  |
provider APIs / local quota facts                 |
            |                                     |
            v                                     |
+-----------------------------------------------+ |
| C. Resource Observation Store                 | |
| one server-owned last-good normalized view    | |
+-----------------------------------------------+ |
            |                                     |
routing facts + catalog priors                    |
            +--------------------+----------------+
                                 v
+-----------------------------------------------+
| D. Capacity Projection                        |
| resources + personalized yield + routing      |
+-----------------------------------------------+
                                 |
                                 v
+-----------------------------------------------+
| E. UI client snapshot owner                   |
| one cache/update path, O(1) lookups           |
+-----------------------------------------------+
```

### A. Durable Consumption Ledger — Core

Core owns durable settled-generation facts because it already owns
`usage_record` and process-global durable usage state.

Responsibilities:

- persist canonical provider/model/account/session identity;
- persist token/workload vector;
- persist exact provider resource burns when known;
- retain raw historical rows for recalibration/backtests;
- increment the usage-history revision after settlement.

Do **not** put quota HTTP fetching or provider auth here.

### B. Yield Statistics — Core or lowest shared durable owner

A new process-global materialized statistics owner should update from settlement
events / durable ledger writes.

It should maintain bounded O(1) state per statistical key, for example:

```text
(provider, canonicalModel)
(provider, canonicalModel, account)
(provider family)
personal global workload
current session
current regime
```

Each state may contain only sufficient statistics / bounded sketches:

- weighted count / exposure;
- weighted resource sum;
- weighted second moment;
- session/block counters needed for effective sample size;
- short/medium/long decay states;
- regime revision;
- last observation timestamp;
- bounded distribution sketch only if required for predictive intervals.

Normal reads must never scan `usage_record`.

Raw history remains for backfill/rebuild/prequential evaluation.

### C. Resource Observation Store — OpenCode server Tier 0

Quota/provider acquisition must also have **one authoritative server owner**.

Today resource facts are split between:

- `Quota.Service` provider adapters and provider-specific caches;
- OpenCode Go `ForkUsage` client polling;
- renderer singleton `useOpenRouterFreeUsage`;
- a renderer/history-derived free-usage hook that reconstructs state by scanning synced message history;
- `useLimits`' renderer transport cache.

That would still be a second fragmented architecture even if yield math moved
server-side.

The target is a process-global Resource Observation Store fed by the quota/provider
adapters. It owns the latest normalized, last-good observations and their semantic
revision.

Responsibilities:

- acquire provider/account resource state once;
- preserve adapter auth/cooldown/single-flight behavior;
- normalize provider-native results into semantic resources;
- keep last-good/stale/error metadata explicit;
- expose one monotonically changing resource revision;
- publish compact updates for Capacity and Limits;
- never depend on a rendered surface being mounted to remain correct;
- never instantiate a workspace runtime.

The store is **not** a second durable history database. It is bounded current
operational state. Durable per-generation consumption belongs in A.

Provider-native detail may remain attached when Limits genuinely needs it, but
numeric semantics must not be recovered by parsing display labels.

### D. Capacity Projection — OpenCode server Tier 0

The fusion layer belongs in `packages/opencode`, not App, because it needs:

- Core Yield Statistics;
- the Resource Observation Store;
- provider/model/catalog priors;
- account/routing identity;
- current promotions/plan semantics.

This service remains process-global and bootstrap-free.

Conceptual responsibilities:

1. determine which resources apply to a model/account/routing mode;
2. obtain the mean-consumption posterior for each applicable resource;
3. produce full-entitlement personalized yield;
4. produce remaining request-equivalents;
5. resolve the next binding resource;
6. expose demand/pace separately;
7. expose evidence/uncertainty/provenance.

**Capacity does not initiate N provider fetches when queried.** It reads the current
resource snapshot. Explicit/manual refresh intent belongs to the resource owner.

### E. Shared UI client owner — App

Add one server-scoped app owner, conceptually `CapacityProvider/useCapacity`.

It owns:

- one in-memory capacity snapshot cache per ServerSDK;
- one in-flight capacity snapshot request per server/scope;
- bounded stale-while-revalidate behavior;
- coalesced invalidation after capacity/resource revisions;
- O(1) maps by canonical model/account key;
- no provider-specific estimation math.

Limits may also consume a shared compact Resource snapshot/client facade, but that
facade is a projection of the **server-owned** Resource Observation Store rather
than an owner of upstream polling semantics.

The App owner does **not** own:

- statistical inference;
- quota fetching semantics;
- history scans;
- provider catalog reconstruction;
- last-good provider-resource truth.

---

## 5. Canonical contracts

Names are provisional; semantics are not.

### 5.1 Resource observation

Provider adapters should eventually normalize into a browser/server-safe semantic
resource record rather than requiring UI to parse labels.

```ts
type ResourceUnit =
  | { kind: "request" }
  | { kind: "currency"; currency: string }
  | { kind: "credit"; name: string }
  | { kind: "token" }
  | { kind: "fraction" }
  | { kind: "rate"; denominatorMs: number }
  | { kind: "opaque"; name: string }

type ResourceScope =
  | { kind: "provider" }
  | { kind: "account"; accountID: string }
  | { kind: "model"; modelID: string }
  | { kind: "account-model"; accountID: string; modelID: string }
  | { kind: "model-family"; family: string }
  | { kind: "pool"; poolID: string }

type ResourceObservation = {
  resourceID: string
  providerID: string
  scope: ResourceScope
  unit: ResourceUnit

  used?: number
  remaining?: number
  limit?: number
  usedFraction?: number
  remainingFraction?: number

  observedAt: number
  resetsAt?: number

  source:
    | "provider-exact"
    | "provider-rounded"
    | "provider-derived"
    | "local-exact"
    | "learned"
    | "catalog-prior"

  resolution?: number
}
```

The wire contract belongs in Schema only if/when exposed publicly. Runtime parsing,
normalization, caching, and inference remain in the domain owner.

### 5.2 Capacity projection

The UI should consume already-materialized scalars.

```ts
type CapacityEstimate = {
  providerID: string
  modelID: string
  accountID?: string
  routingMode: "pinned" | "automatic" | "single"

  status:
    | "known"
    | "estimated"
    | "learning"
    | "unlimited"
    | "exhausted"
    | "unknown"

  yield?: {
    requestsPerFullEntitlement: number
    unitLabel: string
    windowSeconds?: number
  }

  remaining?: {
    requests: number
    p10?: number
    p50?: number
    p90?: number
    fraction?: number
  }

  pace?: {
    requestsPerActiveHour: number
    projectedFiveActiveHours: number
  }

  binding?: {
    resourceID: string
    label: string
    resetsAt?: number
    remainingFraction?: number
  }

  evidence: {
    rawRequests: number
    sessions: number
    effectiveSamples: number
    currentSessionSamples: number
    source:
      | "exact"
      | "personal-model"
      | "personal-family"
      | "personal-provider"
      | "personal-global"
      | "provider-prior"
      | "population-prior"
  }

  updatedAt: number
}
```

### 5.3 Snapshot shape

Dense consumers need one bounded response, not per-row endpoints.

Conceptually:

```ts
type CapacitySnapshot = {
  revision: number
  generatedAt: number
  providers: ProviderCapacitySummary[]
  models: CapacityEstimate[]
}
```

The server should return canonical base-model records plus account-qualified records
only where they are semantically distinct/available.

The client builds O(1) maps once:

```text
provider:model
provider:model:account
provider
```

### 5.4 Detail endpoint

If rich statistical diagnostics would bloat the dense snapshot, expose a separate
explicit detail route for Usage page drill-down / development diagnostics.

The dense snapshot must not include raw histories or unbounded posterior samples.

---

## 6. Identity and storage changes

### 6.1 Canonical model identity

At settlement, persist both:

- raw/transport model ID;
- canonical/base model ID.

Use the existing shared account-suffix parser from
`packages/schema/src/model-account-identity.ts`; do not duplicate string rules.

### 6.2 Account identity

Add durable account/routing identity to settled usage records when known.

Desired fields conceptually:

```text
provider_id
raw_model_id
canonical_model_id
account_id
routing_pool_id
served_model_id
variant
session_id
...
```

Do not infer account identity later by parsing arbitrary historical display labels.

### 6.3 Generic resource consumption

Where providers report exact burn per generation, persist it in a generic child
ledger instead of provider-specific governor-only storage.

Conceptual table:

```text
usage_resource_consumption
  message_id
  resource_kind / resource_key
  amount
  source
  observed_at
```

Examples:

- WorkBuddy exact credits;
- Genspark credits if/when exact consumption is available;
- direct request count = 1 for count-based quotas;
- normalized fraction burn inferred from bounded quota intervals only when the
  inference owner commits a durable observation.

Do not duplicate raw provider payloads as a second history database.

---

## 7. Provider adapter capability architecture

Avoid inheritance by provider type; providers can expose several simultaneous
resource classes.

Adapters may independently implement capabilities such as:

```text
observeResources()
observeCatalogPriors()
normalizeConsumption()
observeExhaustion()
routingBindings()
```

### Resource examples

- OpenRouter paid: currency balance.
- DeepSeek: USD/CNY balance.
- Genspark: credit balance + exact/learned credit consumption.
- WorkBuddy paid: per-account credit pools.
- WorkBuddy promo: account×model request entitlement.
- OpenCode Go: model/window quota fractions + published/canonical yield priors.
- OpenCode Zen: hidden request entitlement.

- Claude: 5h + weekly + model-scoped weekly + optional extra-use money.
- Codex: primary/secondary rate windows + credits/spend.
- Kimi: provider-defined quota windows.
- xAI: billing-cycle fraction.
- NVIDIA: request-rate resource.
- OpenRouter free: daily request count.

Provider adapters observe facts. They do not calculate UI `estimatedRequests`.

---

## 8. Cold-start / fallback hierarchy

For a model/account with insufficient direct evidence:

```text
exact account+model posterior
  -> exact personal model
  -> personal model-family
  -> personal provider workload
  -> personal global workload
  -> provider/model published prior
  -> provider-family prior
  -> generic population fallback
```

The projection must expose the chosen evidence source.

Sparse direct evidence shrinks toward the prior; it does not flip from "generic" to
"fully personal" at an arbitrary sample threshold.

Historical token/workload vectors should be re-priced/re-normalized under current
economic regime when possible.

---

## 9. Current-session adaptation

The selected/active model can adapt faster than the durable long-horizon profile.

Do not create a second history scanner. Use existing settlement/telemetry events.

Conceptual hierarchy:

```text
durable personal model posterior
             |
             v
      current-session posterior
             |
             v
     current capacity projection
```

Session-local state should remain bounded and be discarded/aged out after inactivity.

---

## 10. Active-time pace model

Pace is a separate demand model.

Display:

- requests / active hour;
- projected requests / 5 active hours;
- optionally headroom ratio vs current entitlement yield.

Do not use raw wall-clock rate.

A bounded inter-request idle contribution is a reasonable implementation family,
but the idle cutoff must be calibrated on historical sessions.

Pace does not participate in entitlement capacity arithmetic except for
"will I exhaust before reset?" forecasting.

---

## 11. Tier-0 route and transport plan

### 11.1 Server API

Prefer a new explicit global group / route whose ownership is obvious, e.g.

```text
GET /capacity/snapshot
GET /capacity/detail?...   # optional, explicit detail only
```

or an equivalently named root/global route.

Do not hide this under an instance/workspace route simply because model selection is
a session UI.

The route must:

- use Authorization only plus process-global dependencies;
- never enter `WorkspaceRoutingMiddleware`, `InstanceContextMiddleware`, or
  `InstanceStore`;
- never accept an optional directory that can become cwd;
- serve an already-materialized/cached projection.

If implemented in the existing unified SDK route tree, regenerate
`packages/sdk/js` with its normal generator. Never hand-edit generated files.

### 11.2 Snapshot invalidation

Use semantic revisions, not arbitrary re-fetch loops.

Candidate revision inputs:

- `UsageRecord.revision()`;
- resource/quota snapshot revision;
- account/routing revision;
- catalog/pricing regime revision.

The capacity service can memoize:

```text
(last usage revision,
 last quota/resource revision,
 last pricing regime revision,
 value)
```

and rebuild only when one changes.

### 11.3 Client owner

One `CapacityProvider` per server scope.

Requirements:

- shared in-flight request;
- bounded stale cache;
- coalesced event invalidation;
- no one-resource-per-consumer polling;
- no refetch caused by a component merely rerendering;
- inactive/hidden detail surfaces must not add listeners/timers;
- selected-model O(1) accessor must not allocate a new map/closure per row.

### 11.4 Server Resource Observation Store

A Capacity snapshot read must **not** synchronously fan out to configured providers.
That would make opening the model dialog, composer, Usage page, or Context panel an
upstream-network operation and would recreate the consumer-first architecture the
root `AGENTS.md` forbids.

Evolve the quota/resource layer into one process-global observation owner with:

```text
provider/account resource observations
last-good provider result
fetchedAt / nextRefreshAt
stale/error state
resourceRevision
```

Conceptual server API:

```text
ResourceStore.snapshot()            # pure/cheap read of last-good observations
ResourceStore.revision()            # O(1)
ResourceStore.refreshConfigured()   # explicit bounded refresh orchestration
ResourceStore.refreshProvider(id)   # explicit single-provider intent
```

Refresh rules:

- preserve each adapter's current single-flight and cooldown semantics;
- bound provider fetch concurrency;
- increment `resourceRevision` only when semantic resource state changes;
- retain last-good observations through transient fetch errors with explicit stale
  provenance;
- never let Capacity polling bypass adapter `nextRefreshAt`/cooldowns;
- do not make a request for one UI consumer that another already has in flight.

Capacity then becomes a pure projection over:

```text
YieldStatistics revision
+ ResourceStore revision
+ account/routing revision
+ pricing/catalog regime revision
```

and a normal `GET /capacity/snapshot` is therefore a cached/materialized Tier-0
read, not a provider crawler.

#### Consequences for current App acquisition paths

The following current frontend paths are migration inputs, not permanent owners:

- `useLimits` currently coordinates per-provider `quota.get` calls. Preserve its
  stale-while-revalidate UX during migration, then make it consume a server-owned
  batched resource snapshot / refresh command rather than acting as the primary
  provider-fetch orchestrator.
- Any renderer/history-derived free-usage hook that scans synced message history is
  a consumer-first reconstruction, not an owner. Remove that path; the server
  already owns the corresponding free-usage state and must publish it through the
  resource observation layer.
- `useOpenRouterFreeUsage` currently owns a renderer singleton poller. Preserve
  its provider-specific upstream implementation only as needed while migrating,
  then feed the normalized server resource store so all surfaces share one
  observation.
- `ForkUsage` currently owns the Go heartbeat/event refresh path. Its credential
  management/routing UI may remain distinct, but Go entitlement observations must
  enter the same resource store so request-yield math is not duplicated client-side.

Manual Limits refresh remains valid product intent: it should call the server's
bounded resource refresh, which advances `resourceRevision`; Capacity then
reprojects from the resulting observation state. Other surfaces simply consume the
new revision.

---

## 12. Surface integration plan

## 12.1 `dialog-select-model.tsx` — highest-priority dense consumer

### Current state

The dialog currently has provider-specific branches for:

- WorkBuddy;

- Genspark;
- OpenRouter free;
- OpenCode Go;
- Zen per-account;
- generic Go personal-cost fallback.

It already contains performance work to avoid N tooltip managers and repeated
closure allocation.

### Target

Replace all request-capacity branches with:

```ts
capacity.forModel({
  providerID: item.provider.id,
  modelID: item.id,
})
```

and account submenu lookups with:

```ts
capacity.forAccountModel(providerID, baseModelID, accountID)
```

Both are pure O(1) map lookups.

### Row presentation

Primary compact metric should become one of:

- `~525 / 5h` or provider-equivalent entitlement label;
- `~179 left` when a current resource exists;
- `learning` / `—` when insufficient evidence.

Tooltip can add:

- personalized/full entitlement yield;
- remaining p50 or point estimate;
- p10–p90 if useful;
- evidence source;
- active-hour pace;
- binding resource;
- reset.

### Deletions

Remove dialog-owned imports/branches for:

- `estimateRequestsRemaining*`;
- `useWorkBuddyUsage` request estimation;

- `useGensparkUsage` request estimation;
- Go request math;
- Zen request math.

Provider-specific routing/account UI may remain; only inference leaves the component.

### Performance gate

Opening a 500-model dialog must produce:

- one capacity snapshot request at most;
- zero per-row network requests;
- zero history scans;
- O(number of models) cheap map reads during list/model-map construction;
- virtualized rows must not register capacity subscriptions individually.

---

## 12.2 Limits pane — resource truth + yield overlay

File: `packages/app/src/pages/session/limits-panel.tsx`

### Preserve

The pane is the best place for raw provider resource detail:

- every provider;
- windows;
- resets;
- account rows;
- balances;
- status/errors.

Preserve:

- bounded DOM admission;
- shared display clock;
- provider ordering stability;
- refresh cooldown semantics;
- explicit focus/highlight behavior.

### Change

Do not make the pane itself combine weighted percentages into a false universal
capacity story.

Each provider header/model/account section can join its resource observation with
the capacity projection:

```text
Provider resource
  34% remaining · resets 1h42m

Personalized yield
  ≈525 requests / full 5h
  ≈179 equivalent requests left
```

The binding resource gets emphasized as explanatory detail.

### Global summary

Replace/retire ad-hoc weighted percentage "5h/weekly/monthly global buckets" as the
primary universal summary. Percentage values from semantically different resources
are not directly additive/comparable.

A stronger global summary should either:

- show provider tiles independently; or
- compare each provider/model in request-equivalent units when the comparison is
  semantically meaningful.

Do not average percentages across unrelated providers as if they were one pool.

### Dataflow

Limits continues to own explicit/manual resource refresh intent. Capacity consumes
the resulting server resource snapshot/revision; the client should not independently
re-fetch capacity N times while a refresh batch is resolving.

---

## 12.3 Prompt-input limit arc — selected-model compact projection

Files:

- `prompt-input-v2.tsx`;
- `prompt-input/limit-arc.ts`;
- `prompt-input/limit-arc-view.tsx`.

### Current state

The arc already tries to project the selected model's real provider and caps DOM
work, but it reconstructs semantics from `useLimits` plus `ForkUsage`.

### Target

The arc should consume the selected model's capacity/resource summary directly.

The ring can remain a resource-pressure visualization, but its hover card should
headline personalized yield:

```text
~525 requests / 5h
~179 equivalent left
34% quota remaining · 1h42m
```

The server projection should already identify the binding resource and selected
account.

### Performance

The always-mounted composer must not instantiate its own independent quota/capacity
poller. It should subscribe to the shared server-scoped Capacity owner.

The existing "clock only while hover" behavior should remain.

---

## 12.4 Context pane — current-session adaptation, not another global dashboard

Files:

- `context-panel.tsx`;
- `session-context-tab.tsx`;
- `session-context-usage.tsx`.

### Preserve current ownership

Session context metrics already consume compact telemetry for live context usage.
Do not replace that with global capacity state.

### Add a small session-aware yield section

The Context tab can show, for the **currently selected/served model**:

```text
Usage pace
  27 req / active hour

Current-session workload
  1.32x your normal model workload

Provider yield
  ~525 req / full 5h
  ~179 equivalent remaining

At current pace
  ~135 requests over 5 active hours
  headroom ~3.9x
```

This should consume:

- session telemetry / current model from existing compact session projection;
- one O(1) Capacity lookup.

It must **not** scan `messages()` merely to calculate yield/pace. The existing
Context detail view may still use message history for its explicit rich-history
sections; the new yield subsection must not depend on that history path.

### Hidden-tab rule

Because Context remains mounted after first visit, the new section may not add a
poller/timer/subscription that stays alive while hidden.

---

## 12.5 Usage page — historical explanation and calibration surface

Files:

- `pages/usage-page.tsx`;
- `components/usage/use-usage-summary.ts`;
- `pages/usage/*`.

### Keep historical analytics separate

`usage.summary` remains the source for arbitrary 1h/12h/1d/7d/... range analytics.

Do not embed live capacity computation in every `usage.summary` request.

The Usage page joins:

```text
historical usage summary
        +
current capacity snapshot
```

by canonical provider/model identity.

### Models section additions

For each model group, add optional columns/details:

- personal full-entitlement yield;
- current remaining equivalent requests;
- requests / active hour;
- effective sample size;
- evidence source/confidence;
- current binding provider resource.

A richer model-detail card can show:

- historical request count;
- personal workload distribution;
- short/medium/long-timescale estimates;
- current-session adaptation;
- posterior / predictive interval;
- cold-start fallback source if direct evidence is sparse.

### New "Yield" analytical view

A future dedicated section can visualize:

- yield over time / regime changes;
- demand pace;
- calibration;
- provider entitlement efficiency.

This is a detail surface and may request heavier explicit diagnostics. It must be
separate from the dense capacity snapshot.

### Filter independence

Changing Usage page window/project filters must not invalidate/re-fetch provider
quota or capacity unless the user explicitly refreshes capacity.

---

## 12.6 Model tooltip / Models panel / Manage Models

Current `usePersonalUsage` consumers:

- `model-tooltip.tsx`;
- `models/models-panel-content.tsx`;
- `dialog-manage-models.tsx`;
- `dialog-select-model.tsx`.

These should migrate from recent-200 average-cost maps to Capacity/Yield accessors.

Cost/cheapness ranking may still use a dedicated economics/yield ranking projection,
but it should derive from the same canonical personal workload statistics so
"cheap", "yield", and "requests remaining" cannot disagree because they used
different personal profiles.

Do not overload `CapacityEstimate` into a ranking score; expose the underlying
normalized personal workload/economics state through a shared domain projection if
the ranking engine needs it.

---

## 12.7 Free-tier special surfaces

Free-tier offers currently expose evidence of the acquisition split the target
architecture must remove:

- OpenRouter free uses a renderer-global polling singleton;
- a free tier with a renderer/history-derived hook exposes a consumer-first
  reconstruction even though the server already has a free-usage service feeding
  the quota layer.

Migration goal:

- server quota/resource adapters become the acquisition owner;
- normalized observations enter the Resource Observation Store;
- renderer polling/history reconstruction for resource truth is retired;
- Limits may continue showing provider-native detail from the shared server snapshot;
- picker/composer consume Capacity only;
- no mounted UI surface is required to keep these resource facts current.

---

## 12.8 Mobile / PWA and future consumers

Any mobile/PWA model picker, composer, or limits surface must consume the same
server capacity contract rather than porting desktop estimation code.

The snapshot should be browser-safe and transport-efficient enough that mobile does
not need a second architecture.

---

## 13. Cache and invalidation architecture

### Server resource layer

The Resource Observation Store owns provider refresh state.

It should maintain:

- one last-good observation set per provider/account/resource key;
- stale/error/cooldown metadata;
- one semantic `resourceRevision`;
- single-flight refreshes per provider;
- bounded refresh concurrency across providers;
- provider-specific TTL/backoff policy at the adapter/resource boundary.

A manual Limits refresh is explicit refresh intent and may ask the Resource Store to
refresh eligible providers. A Capacity read is **not** refresh intent.

### Server capacity layer

Maintain one process-global capacity cache keyed by semantic revisions.

No timer is required merely to recompute yield.

Recompute triggers:

- settled usage/yield-stat revision changes;
- Resource Store revision changes;
- account/routing state changes;
- pricing/catalog regime changes.

A capacity snapshot rebuild must be CPU/memory work over already-materialized state,
not synchronous upstream network fanout.

### Client

Use one server-scoped Capacity cache and, where raw Limits detail is required, one
server-scoped Resource snapshot cache/facade.

Suggested behavior:

- instant stale snapshot paint;
- coalesce concurrent `ensure()`;
- refetch compact server snapshots after semantic invalidation with short debounce;
- no independent upstream-provider polling in model rows/composer/context;
- manual Limits refresh calls the server resource refresh path, then consumes the
  resulting resource/capacity revisions.

### Avoid

- one 60s heartbeat per component;
- client-owned provider truth required for Capacity correctness;
- capacity recompute every 1s for countdown text;
- recompute entire model map when only `now` changes;
- per-row Solid resources;
- using UI visibility as the primary correctness source for resource/capacity state;
- a capacity endpoint that fans out to every configured provider on every read.

Reset countdowns are presentation derived from stable `resetAt` + a shared clock.

---

## 14. Materialization / backfill strategy

### New installations

Update materialized yield statistics synchronously/best-effort at settlement.

### Existing installations

Do not make first model-dialog open scan all historical usage.

Backfill options:

1. bounded low-priority background rebuild from `usage_record`;
2. maintain a versioned materialized-state table/blob;
3. checkpoint progress and resume;
4. foreground queries use:
   - whatever materialized personal state exists;
   - hierarchical provider/catalog fallback for missing history.

The UI should improve as backfill progresses without blocking.

Background backfill must:

- use its own low-priority SQLite/read path;
- be bounded/cooperative;
- never block foreground writer ownership;
- expose completion/version state if needed;
- be idempotent.

---

## 15. Persistence shape for materialized statistics

Exact schema remains implementation work, but avoid one row per raw request in the
materialized table.

Possible key dimensions:

```text
stat_key:
  scope_kind
  provider_id
  canonical_model_id?
  account_id?
  regime_id?
```

Per key store:

```text
updated_at
raw_requests
sessions
weighted_count_short
weighted_sum_short
weighted_sq_short
weighted_count_medium
weighted_sum_medium
weighted_sq_medium
weighted_count_long
weighted_sum_long
weighted_sq_long
current_regime_count/sum/...
cluster/session sufficient stats
pace sufficient stats
version
```

If predictive intervals need more than moments, prefer a bounded mergeable sketch.

Do not persist UI-ready strings.

---

## 16. Regime identity

A regime boundary may arise from:

- model revision;
- provider pricing change;
- quota multiplier change;
- plan/tier change;
- promotion;
- account entitlement change;
- resource accounting rule change.

Historical workload remains useful across regimes when it can be normalized under
current economics.

Separate:

```text
workload regime
economic/quota regime
```

where possible. A pricing change should not erase the learned distribution of the
user's token/context workload.

---

## 17. Routing-aware capacity

A bare multi-account model and an account-pinned model answer different questions.

### Pinned

Only the selected account's resources participate.

### Automatic pool

Capacity should project the **actual routing policy**, not:

- maximum account remaining;
- first account;
- naive sum unless all resources are truly additive.

Expose routing bindings from the authoritative router/governor where practical.

The capacity service should not reimplement WorkBuddy/Zen account-ranking
rules in App.

---

## 18. API payload/performance budget

Set explicit budgets before implementation.

Initial targets to validate, not blindly freeze:

- dense snapshot: O(configured models + account variants), bounded;
- one snapshot request per server scope on demand;
- no more than one coalesced rebuild per semantic revision burst;
- O(1) lookup per rendered row;
- no SQLite full-history scan on snapshot reads;
- no model catalog workspace bootstrap;
- no per-model timers/listeners.

If account/model cardinality becomes large, support:

- canonical model records;
- sparse account overrides;
- provider-level shared priors;
- detail paging outside the dense snapshot.

---

## 19. Validation plan

## 19.1 Mathematical / offline

Keep the Python proof corpus as executable reference.

Then build a real prequential replay harness over `usage_record`:

At historical time (t):

1. fit/update from rows strictly before (t);
2. predict next request/resource burn and capacity;
3. observe actual next row/snapshot;
4. update;
5. never leak future data.

Compare:

- current recent-200 average-cost estimator;
- provider/catalog prior only;
- lifetime equal mean;
- current-window only;
- rolling horizon;
- decayed full-history;
- hierarchical personal fallback;
- multi-timescale adaptive mixture;
- session-aware model.

Metrics:

- log/multiplicative point error;
- signed bias;
- MAE in request-equivalent units;
- interval coverage;
- WIS/CRPS where probabilistic;
- cold-start error at n=0/1/2/3/5/10/20/50;
- calibration after regime changes.

Avoid raw MAPE where true remaining is near zero.

## 19.2 Server ownership tests

Add Tier-0 tests proving capacity endpoints:

- return without workspace runtime;
- do not touch `InstanceStore`;
- do not require directory;
- do not hydrate session history.

Follow the existing
`packages/opencode/test/server/httpapi-tier0-ownership.test.ts` pattern.

## 19.3 Domain tests

Cover:

- canonical model/account keying;
- exact resource counts;
- currency/credit yield;
- rounded/censored quota intervals;
- hidden-cap posterior updates;
- multi-resource binding;
- pricing regime re-normalization;
- sparse exact-model hierarchical fallback;
- session clustering/effective sample size;
- account-pool routing.

## 19.4 App tests

Assert:

- dialog uses one capacity owner and O(1) map lookup;
- no provider-specific request-estimate branches;
- hidden Context/Limits tabs do not create extra capacity polling;
- Usage page filter changes do not trigger capacity/quota refresh;
- composer arc and Limits show the same binding resource/yield for the same model.

## 19.5 Trigger-state performance validation

Per `AGENTS.md`, exercise real states:

- model dialog with 100 / 500 / stress-corpus model rows;
- 1 / 3 / 6+ active sessions;
- Context visible vs hidden;
- Limits visible vs hidden;
- composer always mounted;
- Usage page open with 1h/30d/all-time summary;
- concurrent quota refresh + model settlement burst.

Measure:

- renderer long tasks;
- HTTP request count;
- SQLite query count/duration;
- sidecar CPU;
- event fanout;
- client listener count;
- snapshot bytes;
- time to first useful capacity value;
- time from settled request to updated projection.

---

## 20. Migration sequence

### Phase 0 — ledger + real-data validation harness

- keep this ledger current;
- build prequential evaluator against real `usage_record`;
- calibrate initial priors/decays using historical data;
- do not wire UI yet.

### Phase 1 — identity correctness

- canonical model ID in usage storage;
- account/routing identity in settled records;
- migration/backfill strategy;
- focused tests.

### Phase 2 — materialized Yield Statistics owner

- O(1) settlement updates;
- versioned materialized state;
- low-priority historical backfill;
- no quota dependency yet.

### Phase 3 — semantic resources + Resource Observation Store

- introduce normalized resource contract internally;
- add one process-global last-good observation store + semantic resource revision;
- move refresh orchestration behind the server owner with bounded concurrency;
- adapt provider quota sources incrementally;
- remove renderer-history-derived free-tier resource state;
- feed Go/OpenRouter-free observations into the same server resource revision;
- preserve provider-native raw detail for Limits;
- no UI request estimator math.

### Phase 4 — Capacity Service + Tier-0 snapshot API

- compose ResourceStore + Yield Statistics + priors/routing;
- make normal capacity reads pure/cached with zero synchronous provider fanout;
- cache by semantic revisions;
- add ownership and no-fanout tests;
- regenerate unified SDK.

### Phase 5 — shared App Capacity owner

- one server-scoped cache/in-flight request;
- O(1) model/account accessors;
- coalesced invalidation.

### Phase 6 — model dialog cutover

- replace all request-estimate branches;
- migrate account submenu;
- validate large-list performance;
- delete `model-usage-estimate` consumers.

### Phase 7 — composer arc + Limits cutover

- selected model uses same projection;
- Limits overlays yield/remaining equivalents;
- retire semantically invalid global weighted-percentage summary.

### Phase 8 — Context integration

- add session-aware yield/pace block from telemetry + Capacity;
- prove zero history dependency for the new block;
- hidden tab remains inert.

### Phase 9 — Usage page integration

- join summary + capacity by canonical identity;
- add yield/evidence fields;
- optional explicit Yield detail section;
- prove filter independence.

### Phase 10 — secondary consumers

- model tooltip;
- Models panel;
- Manage Models;
- mobile/PWA;
- warning banners/badges if applicable.

### Phase 11 — delete legacy architecture

Delete/retire when no consumers remain:

- `model-usage-estimate.ts`;
- duplicated schema estimator;
- request-estimation branches in WorkBuddy/Genspark hooks;
- recent-200 `modelProfile` if no longer needed for unrelated ranking;
- client parsing of numeric values from display labels;
- synthetic per-provider fallback math superseded by Capacity.

Do not delete provider-native quota detail required by Limits.

---

## 21. Explicit decisions

### D1 — Primary product metric

**Decision:** personalized effective request yield is primary; binding constraint is
supporting detail.

### D2 — Full history

**Decision:** retain complete raw history, but runtime prediction uses materialized
multi-timescale/relevance-weighted statistics.

### D3 — Cold start

**Decision:** no-data models use hierarchical personal/provider/catalog fallbacks,
but **only after normalization into a comparable workload/economic space**. Raw
provider/global means are not transferable priors and are prohibited by the
real-data replay.

### D4 — Ownership

**Decision:** statistical state is server/domain owned; UI only projects it.

### D5 — Tier

**Decision:** Capacity is Tier 0 global and bootstrap-free.

### D6 — Dense transport

**Decision:** one bounded snapshot/cache, never per-row requests.

### D7 — Usage page

**Decision:** historical range analytics and live capacity are separate domains
joined by identity; filters do not invalidate Capacity.

### D8 — Context

**Decision:** current-session adaptation may overlay the global model posterior but
must use compact telemetry/settlement state, not a new message scan.

### D9 — Limits

**Decision:** raw provider resource detail remains valuable; percentage averaging
across unrelated resources is not the universal capacity model.

### D10 — Pace

**Decision:** active-hour demand is modeled separately from entitlement supply.

### D11 — Base model and account overlays

**Decision:** account suffixes are materialized into separate durable
`base_model_id` + `account_id` fields while preserving raw `model_id`.
Production statistics keep a base-model prior and an account-specific overlay
rather than blindly pooling all accounts.

### D12 — Fast recency is first-class

**Decision:** current/session/short-horizon state is not merely an optional polish.
Real prequential replay shows substantial non-stationarity; a short same-model
decay materially outperforms the current recent-200 arithmetic mean. Long history
remains as prior/regime evidence, not equal-weight prediction truth.

---

## 22. Real-corpus prequential findings

The first production-data replay uses the historical global `usage_record`
corpus in strict chronological order. Maintenance/compaction rows are excluded.

Corpus:

- 59,292 user-facing settled generations;
- 942 sessions;
- 16 providers;
- 22,155 rows with positive recorded `cost_usd`;
- 117 raw provider/model keys collapsing to 74 suffix-free base-model keys;
- 18,620 account-qualified rows (**31.4%** of the corpus).

### 22.1 Identity fragmentation is material

Large model histories are split across account-qualified transport IDs. Examples
include OpenCode Go DeepSeek and WorkBuddy HY models with several physical account
suffixes per base model.

Result:

- suffix stripping is necessary for transfer/base priors;
- suffix stripping alone is insufficient because account behavior can differ;
- durable identity therefore stores raw model + base model + account separately.

The migration backfill SQL was cross-checked against the shared TypeScript
`splitAccountModelID` parser on all 108 distinct historical model IDs: **0
mismatches**.

### 22.2 The current recent-200 arithmetic mean is too slow to adapt

On the held-out final 30% of chronological workload observations:

```text
recent-200 raw model mean   mean |log error| ≈ 0.675
short EWMA (~8 obs)         mean |log error| ≈ 0.443
```

That is roughly a **34% reduction in mean absolute log error**.

For future **20-request mean workload**, closer to the actual (E[C]) target:

```text
recent-200 canonical        mean |log error| ≈ 0.345
short EWMA (~8 obs)         mean |log error| ≈ 0.209
EWMA geometric bias         ≈ +0.9%
```

Recorded-cost replay is noisier and covers fewer providers, but the same direction
holds. At the 20-request horizon, short EWMA reduced mean log error from about
0.561 to 0.495 and geometric bias from about +17.5% to +3.7%.

**Do not freeze the number 8 as a production constant.** It won the first corpus
sweep and proves fast adaptation matters; multi-timescale state and future
prequential tuning remain the production design.

### 22.3 Naive hierarchy was falsified

A deliberately simple fallback:

```text
same base model on another provider
  -> provider arithmetic mean
  -> global arithmetic mean
```

performed badly at cold start, sometimes by orders of magnitude.

This does **not** invalidate hierarchical transfer. It proves the hierarchy must
transfer **normalized personal workload** and then price/map that workload through
the target model/provider's current economics/resource prior.

Consequently, production must not ship a raw provider/global average as the
cold-start estimate.

### 22.4 Session dependence is large

Raw request rows substantially overstate independent evidence. Example real
estimates on log workload:

```text
OpenCode Go DeepSeek V4.1 Flash
  9,216 requests / 109 sessions
  ICC ≈ 0.247
  design effect ≈ 21.6
  effective request-equivalents ≈ 426

WorkBuddy HY3
  4,142 requests / 61 sessions
  ICC ≈ 0.237
  design effect ≈ 16.9
  effective request-equivalents ≈ 246
```

Current-session adaptation and cluster-aware confidence are therefore required,
not optional.

### 22.5 Replay performance

The complete 59k-row sweep, including multiple estimators/horizons and identity
audit, runs in roughly **2.6 seconds** as an offline script. Normal production
prediction still uses O(1) materialized state and does not replay history.

Harness:
`packages/opencode/script/usage-yield-prequential.ts`.

---

## 23. Production closeout — OpenCode Go

The OpenCode Go request-capacity path is implemented end to end. The renderer no
longer reconstructs provider economics or replays usage history to answer "how
many requests are left?"; it consumes the server-owned Capacity projection.

For a published 5h request capacity `R`, official remaining entitlement fraction
`q`, and workload multiplier `m`:

```text
remainingTypicalRequests = q * R
estimatedRequests = floor_epsilon(remainingTypicalRequests / m)
```

The workload multiplier is hierarchical:

```text
published prior -> personal base-model posterior -> physical-account overlay
```

with production calibration:

```text
personal half-life = 8 observations
base prior-equivalent κ = 1
account prior-equivalent κ = 32
effective samples = min(request ESS, contiguous-session-block ESS)
```

The account overlay has no n-based switch. It moves continuously on the first
usable account observation, but is regularized hard toward the already-personalized
base-model posterior because independent physical-account evidence is sparse.

The final chronological Go replay at closeout used 27,934 source rows, 21,528
usable repriced rows, 15,117 account-attributed rows, 13 model scopes, and 12
physical account scopes with a 70/30 chronological tune/held-out split. The
deployed candidate remains `hier_h8_kb1_ka32`: future-20-request mean absolute
log error was 0.47558 on tune and 0.44271 held out, with geometric bias +0.82%
and +3.62% respectively.

A dedicated current-session expert was evaluated only after freezing the durable
predictor. The best candidate (`session_expert_k16`) was slightly worse held out
(0.44417 mean absolute log error), so it is deliberately not deployed.

### Predictive uncertainty

Uncertainty is calibrated against realized renewal/stopping counts, not iid request
residuals. The product language is **predictive range**, never "confidence score"
or "confidence interval".

Fine-grained ESS-specific interval buckets were tested and rejected for production:
the sparse low-evidence buckets overfit the calibration prefix and degraded held-out
coverage. Production therefore exposes numeric ranges only after session-aware ESS
reaches 12:

```text
ESS < 12   -> predictiveRange.status = "learning"
ESS >= 12  -> predictiveRange.status = "calibrated"
ambiguous local burn -> predictiveRange.status = "unavailable"
```

For mature evidence, Capacity chooses the nearest calibrated remaining-entitlement
budget in log space from 5 / 20 / 100 typical-request equivalents. Mature held-out
coverage and multiplicative ranges are:

```text
budget 5:   [0.94099, 4.02275]   held-out coverage 77.51%
budget 20:  [0.69765, 2.66820]   held-out coverage 79.95%
budget 100: [0.46874, 2.05248]   held-out coverage 80.12%
```

The wire contract carries the evidence state directly, including effective samples,
maturity threshold, calibration budget, held-out coverage, and lower/upper request
counts when calibrated. The UI does not manufacture a separate confidence value.

### Account, snapshot, and cache correctness

The authoritative physical account identity is the routed stable account ID
(`zen-*` for OpenCode Go), not a vault credential UUID. Vault IDs are storage
aliases and are used for local attribution only when no routed account identity was
persisted.

A post-snapshot local settlement belongs to the represented official quota window
only when:

```text
snapshotAt < completedAt < resetAt
```

A newer official snapshot supersedes all earlier local settlements; duplicate
message IDs debit at most once; promotion capacity is evaluated at settlement time;
and any known local burn that cannot be normalized fails the request-count
projection closed instead of silently assuming zero burn.

`OfficialUsageCache.fetchedAt` is the timestamp of the real provider fetch.
Serving a cache hit does not advance that timestamp. This preserves the exact lower
boundary for post-snapshot local depletion while retaining the process-global
single-flight five-minute provider gate and the separate short-lived local L2 cache.

### Ownership/performance closeout

The production path preserves the Tier-0 architecture:

- zero workspace Instance bootstrap for Capacity reads;
- zero renderer message/part hydration;
- zero per-model HTTP calls;
- zero UI-owned Go capacity math;
- O(1) materialized Yield-stat lookup per model/account key;
- one bounded post-snapshot SQL read;
- one process-global official provider gate;
- one server-scoped App Capacity cache with coalesced refresh.

Legacy `$12 / $30 / $60` Go figures remain only as raw-usage display compatibility
when official percentage telemetry is absent. They are not resource limits and are
not used by Capacity.

---

## 24. Closeout decisions

The following decisions are now production facts for the OpenCode Go path:

1. **Point-estimate ownership:** server Capacity only.
2. **Estimator:** published prior -> personal base -> account overlay.
3. **Recency:** half-life 8, selected by chronological prequential evaluation.
4. **Correlation control:** posterior evidence is capped by session-block ESS.
5. **Base shrinkage:** κ=1 prior-equivalent.
6. **Account shrinkage:** κ=32 prior-equivalents.
7. **Current-session expert:** rejected because held-out error was worse.
8. **Uncertainty:** calibrated renewal/stopping-time predictive ranges.
9. **Cold/sparse uncertainty:** numeric range withheld until session-aware ESS=12.
10. **Local depletion:** exact post-snapshot normalization; ambiguous burn fails closed.
11. **Official snapshot clock:** provider-fetch timestamp is immutable across cache hits.
12. **Raw quota UI:** retained where semantically correct; never reused as Go request math.
13. **Generated clients:** server schema -> OpenAPI -> generated unified SDK only.
14. **Backward compatibility:** renderer-side fork client treats the new predictive-range
    field as additive so an older server remains readable during rolling development.

Focused validation at closeout:

```text
packages/opencode:
  Capacity + Go prior + official/local cache + quota providers + routing
  61 pass / 0 fail / 254 assertions

packages/core:
  Yield statistics + exact rebuild equivalence
  8 pass / 0 fail / 39 assertions

packages/app:
  typecheck clean

packages/sdk/js:
  canonical generation clean
  typecheck clean
```

The repository-wide `packages/opencode` typecheck is currently red from unrelated
concurrent OXP/filesystem test work. None of the reported errors touch Capacity,
Go quota/cache, Yield, the fork-capacity route, or the replay/calibration files.
The focused production path and generated API boundary are green.

---

## 25. Blackboard / final state

- [x] Existing request-estimation architecture investigated.
- [x] Mathematical microprototype: partial windows, full-history O(1), hierarchy.
- [x] Jensen inverse-bias rule and session-cluster effective-sample correction.
- [x] Durable raw/base/account identity migration and historical backfill.
- [x] Exact incremental Yield Statistics materialization.
- [x] Exact chronological rebuild-equivalence test.
- [x] Authoritative routed-account plumbing for direct, environment-pool, and vault accounts.
- [x] Process-global official Go usage gate and immutable provider snapshot timestamp.
- [x] Exact post-snapshot local depletion with fail-closed ambiguity handling.
- [x] Published -> personal-base -> account-hierarchical production estimator.
- [x] Chronological candidate calibration and held-out validation.
- [x] Current-session expert evaluated and rejected.
- [x] Renewal/stopping-time predictive uncertainty calibrated.
- [x] Fine-grained sparse ESS interval conditioning evaluated and rejected.
- [x] Mature-evidence predictive-range contract implemented.
- [x] Tier-0 `/fork/capacity` contract.
- [x] Shared App Capacity owner with bounded cache/in-flight coalescing.
- [x] Go model-picker request-count cutover.
- [x] Per-account Go capacity cutover.
- [x] Model-tooltip predictive-range UX.
- [x] Limits/composer/warning surfaces audited: raw quota semantics retained, with no
      duplicate Go request estimator.
- [x] Legacy Go request-estimator modules removed.
- [x] Unified SDK regenerated from the authoritative server schema.
- [x] Focused backend/Core tests and App/SDK typechecks green.

### Non-blocking future generalization

The architecture is intentionally provider-generic, but the production implementation
closed out by this ledger is the OpenCode Go path. Extending the same ownership model
to providers with different resource semantics may still require provider-generic
normalized Resource observations, exact resource-consumption child-ledger rows where
providers expose them, multi-resource simulation where closed form is insufficient,
provider-specific interval-censor models, and optional Usage/Context analytical
presentation of the already-owned statistics.

Those are additive provider/product extensions. They are not unfinished work in the
OpenCode Go request-capacity implementation above.

---

## 26. Truthful per-window capacity

The 5h numbers in section 23 are one window of a multi-window entitlement. The
per-window model makes the other windows explicit instead of leaving consumers to
guess them from a 5h percentage.

### 26.1 Two different quantities, two different names

For every published prior window the server publishes:

```text
personalized total capacity  = published window limit / workloadMultiplier
remaining capacity           = published window limit x observed remaining / workloadMultiplier
```

`workloadMultiplier` is the SAME hierarchical posterior for every window. That is
what a multiplier means, and reusing it keeps the two lines consistent
(`remaining ~= remainingFraction x totalCapacity` for the observed window).

An observed remaining fraction is applied ONLY to the window it was observed in.
Publishing the 5h fraction as a weekly remaining count would restate a 5h fact as
a weekly one, so a window whose consumption was not observed carries total
capacity only. Unknown consumption is not zero consumption.

Wire naming (`GoWindowCapacity.remaining`, `ProviderCapacity.Window.basis`):

| Value | Meaning |
| --- | --- |
| `personalized-total-capacity` | what the whole window could hold at my workload |
| `observed-remaining` | what is left in that exact window, from real provider telemetry |

`remainingPercent` and `resetAt` are per window and absent/null unless the
provider actually reported them for that window. No denominator is ever
synthesized.

### 26.2 No predictive range on window totals

The deployed `GoPredictiveRange` is a 5h renewal/stopping-time calibration
validated against realized counts of requests until the next 5h reset. It is not
validated for full-window totals or for weekly/monthly stopping behaviour, so it
stays on the legacy top-level 5h remaining line only. Window capacity rows carry
the authoritative personalized point total and nothing else; a consumer that
wants a sensitivity band for a full-window total derives one from its own
representative request corpus and must not call it a confidence interval.

### 26.3 Evidence comes from the snapshot that already exists

`forkUsageSnapshot` already merges official `5h`, `week`, and `month` windows per
credential out of ONE gated official read. The `/fork/capacity` handler used to
keep only the `5h` window and discard the weekly/monthly consumption; it now
carries them as `GoResource.observedWindows`, so weekly remaining is truthful
when the official weekly window exists, with no additional provider request.
`5h` stays the primary resource field for compatibility.

The merged window now also preserves the provider's verbatim
`officialPercent` alongside the dollar restatement. Capacity reads that value
instead of reconstructing a window fraction from `spentUSD / limitUSD`, whose
denominator is a local dollar budget rather than that window's own meter, and it
never uses the legacy `estimatedPercent`.

### 26.4 Local depletion is debited per window

Post-snapshot local settlements are normalized per window using that window's own
published limit (`multiplier / requests_window`), and a settlement is only debited
to a window whose own reset boundary it precedes. Ambiguous burn marks the
affected observed window unavailable instead of guessing; the total-capacity row
survives because it depends on neither consumption nor local accounting. An
observed window whose reset boundary has passed is dropped.

### 26.5 Generic providers expose independent windows too

`ProviderCapacity.Estimate.windows` carries one compact row per supported window
(`id`, `label`, `basis`, point estimate, optional calibrated
`lowerRequests`/`upperRequests`, `remainingPercent`, `resetAt`, provenance).
Direct request budgets, monetary balances, convertible credit balances, and
learned-burn windows all project per window now; the top-level fields and
`limitingWindow` still describe the binding window, so existing consumers read the
same binding number as before. A capacity-only window is never selected as the
binding window.

Bounds are preserved: the hard 64-model projection cap is unchanged and each
estimate carries at most `MAX_CAPACITY_WINDOWS` (8) windows, with the binding
window always retained so truncation can never drop the window the headline
number came from. `requests`/`$` remains economics only; window rows never carry
a price.
