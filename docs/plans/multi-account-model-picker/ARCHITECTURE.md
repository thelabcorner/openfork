# Multi-Account Model Picker — Architecture

## 1. Guiding principles

- **The selector displays; the router decides.** Every account-selection affordance in
  the UI resolves to a *model id*, and the provider's server-side router remains the only
  thing that binds a request to a credential. The UI's "Auto would pick X" is a
  **preview**, computed from the same pure function the router uses (§5), never a
  competing implementation.
- **Provider-declared, not provider-hardcoded.** `dialog-select-model.tsx` already
  carries a long tail of `if (item.provider.id === "workbuddy")` / `"genspark"` branches
  (lines 1687, 2256, 2299, 2312…). This feature adds *zero* new ones: everything routes
  through a capability descriptor.
- **Never invent headroom.** Same rule the WorkBuddy stretch bar already follows: a
  missing rate/quota yields *no bar*, never a full one
  (`hooks/use-workbuddy-usage/index.ts:20-26`). An account with unknown state renders as
  "unknown", never as "healthy".
- **Collapse must be reversible.** Any information the collapsed row hides (which
  accounts exist, which is bound, which is exhausted) must be one hover / one ArrowRight
  away, and searchable by account label.
- **Zero network on hover.** Unlike the OpenRouter submenu (which fetches
  `/experimental/openrouter-endpoints` per model, `dialog-select-model.tsx:1508-1530`),
  all multi-account data is *already local* — it rides the quota poll. Hover must be a
  pure memo read.

## 2. System context

```
+- Renderer -----------------------------------------------------------------+
| dialog-select-model.tsx                                                     |
|   createModelSelectorController()                                           |
|      model.list()  -->  collapseAccountVariants()  -->  ranked canonical rows|
|                             |            ^                                  |
|                             |            +-- multiAccountProviders registry |
|                             v                                               |
|                        ModelGroup { canonical, variants[], accountIds[] }   |
|                                                                             |
|   ModelSelectorPopoverV2View                                                |
|      MultiAccountRow (MenuV2.Sub)                                           |
|         +- SubTrigger: name + account chip + stretch bar + price            |
|         +- SubContent: ModelTooltip | policy section | accounts | footer     |
|                                     ^                                       |
|   useAccountRouting(providerID) ----+                                       |
|      +- useLimits()      (workbuddyAccounts / verdentAccounts / windows)    |
|      +- sdk.experimental.accountRouting.get({provider})   [enrichment]      |
+--------------------------+--------------------------------------------------+
                           |
+- Server -----------------v--------------------------------------------------+
| GET /experimental/account-routing?provider=workbuddy                        |
|    -> accounts[] (id,label,state,cooldownUntil,credits,catalog,modelReports)|
|    -> bindings[] (sessionID -> accountId)                                   |
|    -> policy defaults + preview(modelID) resolved by the shared ranker      |
| POST /experimental/account-routing/unbind {provider, sessionID}             |
|                                                                             |
| plugin/account-policy.ts   <- NEW shared pure module                        |
|    rankAccounts(candidates, model, now, policy) -> ordered ids + reasons    |
|         ^                                  ^                                |
|         |                                  |                                |
|  AccountRouter.select()            routing endpoint preview                 |
|  (workbuddy-accounts.ts:598)                                                |
+-----------------------------------------------------------------------------+
```

## 3. Identity model

### 3.1 What an exposed model id looks like today

```
hy4-preview                          bare        -> provider auto-routing (session affine)
hy4-preview#ctx-262144               bare + ctx  -> same, non-default context window
hy4-preview@wb-3f1c9a                pinned      -> this WorkBuddy account, always
hy4-preview#ctx-262144@wb-3f1c9a     pinned + ctx
glm-5.3-flash-free@vd-ab12cd         pinned      -> this Verdent account
```

Decoders that must stay in agreement:

| Layer | Function | File |
|-------|----------|------|
| WorkBuddy proxy | `decodeAccountModel` (`lastIndexOf("@wb-")`) | `plugin/workbuddy.ts:834` |
| Verdent proxy | `decodeVerdentAccountModel` (`lastIndexOf("@vd-")`) | `plugin/verdent.ts:436` |
| Renderer usage | `splitWorkBuddyModelID` (`lastIndexOf("@")` + `#ctx-` strip) | `hooks/use-workbuddy-usage/index.ts:104` |

> **Finding.** The three decoders disagree: the renderer splits on the *last `@`*, the
> proxies on the *last `@wb-` / `@vd-`*. They agree today only because account ids happen
> to start with `wb-`/`vd-`. T1 unifies this behind one descriptor-driven splitter with a
> shared test-vector table, and keeps the proxy decoders as thin callers of it.

### 3.2 The descriptor

```ts
// packages/app/src/utils/multi-account-providers.ts   (NEW, pure, no Solid imports)
export type MultiAccountProvider = {
  /** Provider id as it appears on ModelItem.provider.id. */
  id: "workbuddy" | "verdent" | (string & {})
  /** Account-id prefix used in the exposed model suffix: "wb-" | "vd-". */
  accountPrefix: string
  /** Where per-account quota lives on ProviderResult.usage. */
  accountsField: "workbuddyAccounts" | "verdentAccounts"
  /** Aliases stripped before the account suffix (WorkBuddy context windows). */
  aliasMarkers: readonly string[]   // ["#ctx-"]
  /** Routing policies this provider supports. Gated by a capabilities probe. */
  policies: readonly AutoPolicy[]
  /** Unit shown in the account list: credit pool vs per-model window. */
  headroomKind: "credits" | "window"
  /** i18n key for the provider's own auto label, e.g. "Auto (WorkBuddy routing)". */
  autoLabelKey: string
}
```

`isMultiAccountProvider(id)`, `splitAccountModelID(id)`, `joinAccountModelID(base, acct)`
and `canonicalModelName(item, labels)` all derive from the descriptor. Adding a third
provider is one object literal plus one quota-adapter field.

### 3.3 Canonical display name

The plugins bake the account label into `Model.name` (`` `${entry.name} (${accountLabel})` ``,
`workbuddy.ts:1160`, `verdent.ts:2328`). The collapsed row must show `Hunyuan 4 Preview`,
not `Hunyuan 4 Preview (jack@example.com)`. Resolution order:

1. If a bare variant exists in the group, use its `name` (authoritative).
2. Else strip a trailing `` ` (<label>)` `` for any known account label of that provider.
3. Else strip a trailing parenthesised group that exactly equals a label from
   `usage.accountLabels`.
4. Else keep the name as-is.

Step 4's escape hatch matters: never fall back to a generic `/\s*\(.*\)$/` strip.
WorkBuddy's `toModel` appends a context-window suffix **after** the account label
(`hasAlternateContext`, `workbuddy.ts:1155-1161`), so the naive regex eats `(256K)` and
two different context rows collapse into one.

## 4. Collapsing in the controller

### 4.1 Where it hooks in

`createModelSelectorController` (`dialog-select-model.tsx:923`) currently does:

```
model.list() -> visible filter -> provider filter -> unsorted() -> sortByCheapness -> allModels()
```

Collapsing goes **between the filters and the ranking**, so the yield comparator ranks 12
models instead of 60. That also shrinks `searchableFields()`, `thresholdMap()` and
`prepareModelSearchFields` — all O(n) over the same list.

```
unsorted() -> collapseAccountVariants() -> ModelGroup[] -> sortByCheapness(canonical) -> groups()
```

### 4.2 The group

```ts
// packages/app/src/components/dialog-select-model-accounts.ts  (NEW, pure + tested)
export type AccountVariant = { accountID: string; item: ModelItem }
export type ModelGroup = {
  /** The row that gets ranked, rendered and keyed. Bare variant when it exists. */
  canonical: ModelItem
  /** Present when the provider exposes a bare (auto-routed) id for this model. */
  auto?: ModelItem
  /** Account-qualified variants, in enrollment order. Empty for normal providers. */
  variants: AccountVariant[]
  /** Display name with the account label stripped. */
  label: string
}
export function collapseAccountVariants(
  items: ModelItem[],
  providers: MultiAccountProviderRegistry,
): ModelGroup[]
```

Rules:

- Group key is `` `${provider.id}:${baseIDWithAliases}` `` — the account suffix is
  stripped but `#ctx-262144` is **kept**. Context-window aliases are genuinely different
  rows (different `limit.context`) and users pick between them.
- `canonical = auto ?? variants[0].item`. When there is no bare variant, the canonical
  row still renders and its default action selects the policy-resolved variant (§5.4).
- A provider with exactly one enrolled account collapses to `canonical` with a single
  variant and renders as a plain item — **no submenu** (D6).
- Non-multi-account providers pass through untouched: one item, one group, zero cost.

### 4.3 Ripple: everything keyed by `modelKey`

| Consumer | Today | After |
|----------|-------|-------|
| `favorites()` / `recents()` (`:1146-1163`) | filter `models()` by exact key | filter over groups; a favorited variant marks its **group** favorited and stamps the row with that account's chip |
| `renderRows()` (`:1882`) | `modelKey(item)` navKey | unchanged — the canonical item *is* a real `ModelItem`, so navKeys stay stable |
| `current()` (`:1120`) | `modelKey(model.current())` | the group is current when `model.current()` matches **any** variant; the chip shows which |
| `usageMap()` / `maxRequests()` (`:2024-2048`) | per visible item | per visible **canonical**, plus `modelVariants()` values for bar normalisation (already done at `:2003-2010`; it just stops needing duplicate rows to be visible) |
| `model.visible()` filter (`:1004`) | per exposed id | group visible when **any** variant is visible; `dialog-manage-models.tsx` gets the same collapse in T9 so the toggle is not per-account |
| `searchableFields()` (`:1108`) | `[name, id, provider.name]` | plus every variant's account label and id (§7) |

### 4.4 Toggling favorite on a collapsed row

Favorite is keyed by `{providerID, modelID}` (`model.favorite.toggle`). On a collapsed row
the toggle applies to **the variant the row would select** — the current pin if the group
is current, else the active policy's id. Un-favouriting removes every variant of the group,
otherwise a stale `hy4-preview@wb-old` haunts the favorites section after an account is
removed. `models.tsx:65-78` already prunes stale keys on catalog change; extend it to prune
orphaned account-qualified keys.

## 5. Routing policies — the OpenFork Auto Router

### 5.1 What already exists

`AccountRouter.select(session, model, explicitAccountId)`
(`plugin/workbuddy-accounts.ts:598-660`) implements exactly one policy:

1. explicit account id => rebind, use it;
2. else session binding, unless the bound account is blocked
   (`QUOTA_EXHAUSTED` | `!canAdmitModel(model)` | in cooldown | `!hasKnownCredits()`), in
   which case unbind;
3. else filter eligible (state, `canAdmitModel`, catalog membership) -> prefer accounts
   with known credits -> sort -> bind.

That is a good **sticky** policy. It is *not* what you want when you have five accounts and
want to burn them evenly, or when you want the freshest 24h window for a promo model.

### 5.2 The policies

| Policy | Suffix | Behaviour | Preview line |
|--------|--------|-----------|--------------|
| `sticky` | *(bare id)* | Today's behaviour. Binds once per session, rotates only on block. | "Stays on jack@… for this session" |
| `headroom` | `@wb-auto:headroom` | Per request: among eligible, max remaining entitlement for **this model** (falls back to account credits when the model has no window). Ignores session affinity. | "Now → dana@… · 71% left" |
| `spread` | `@wb-auto:spread` | Per request: among eligible, min observed usage in the current window (round-robin with drift correction). | "Now → sam@… · evens out burn" |

`sticky` stays the default, so nothing changes for users who never open the submenu.

### 5.3 Encoding (D3)

`decodeAccountModel` learns one reserved form:

```ts
// plugin/workbuddy.ts - decodeAccountModel
// "@wb-auto:headroom" is a POLICY, not an account. Account ids are opaque
// hashes and can never collide with the reserved "auto:" namespace.
{ model, accountId?: string, policy?: "sticky" | "headroom" | "spread", contextWindowTokens? }
```

`AccountRouter.select(session, model, explicit)` gains a fourth `policy` parameter. An old
server receiving `@wb-auto:headroom` fails the `accounts.find(id === explicit)` lookup and
returns `undefined` -> HTTP 429 "choose an account". So the **client must probe** before
offering non-sticky policies: `experimental.capabilities` gains
`accountRoutingPolicies: string[]`, and the submenu hides policies the server does not
advertise (same discipline as `utils/server-compat.ts`).

### 5.4 The shared ranker (D4)

```ts
// packages/opencode/src/plugin/account-policy.ts   (NEW, pure, no I/O)
export type AccountCandidate = {
  id: string
  label: string
  state: "READY" | "COOLING" | "QUOTA_EXHAUSTED" | "UNKNOWN"
  cooldownUntil: number | null
  hasKnownCredits: boolean
  packageCreditsRemaining: number | null
  /** From account.catalog.ids - undefined means "unknown, assume yes". */
  servesModel: boolean | undefined
  /** From governor.modelReport(model): the per-(account,model) window. */
  modelWindow?: {
    remainingPercent: number | null
    usedObserved: number
    resetAt: number | null
    limited: boolean
  }
}
export type RankReason =
  | "blocked:quota" | "blocked:cooldown" | "blocked:window" | "blocked:catalog"
  | "eligible" | "preferred:credits" | "preferred:headroom" | "preferred:spread"
export function rankAccounts(
  candidates: AccountCandidate[],
  policy: AutoPolicy,
  now: number,
): {
  ordered: Array<{ id: string; reasons: RankReason[] }>
  blocked: Array<{ id: string; reasons: RankReason[] }>
}
```

- `AccountRouter.select()` is refactored to call `rankAccounts` for steps 2-3. Its
  behaviour for `sticky` must be **bit-identical** to today; the existing
  `plugin/tests/workbuddy-accounts.test.ts` is the guard.
- The routing endpoint calls the same function to answer "who would you pick" and returns
  the `RankReason[]`, so the submenu can say *why* an account is greyed out ("Limited
  until 3:40 PM", "Not on this account's plan", "No credits").
- The renderer gets a **mirror** of the ranker for offline degradation
  (`utils/account-policy-preview.ts`), fed from quota data only. It is explicitly labelled
  as an estimate in the UI, and T10 adds a cross-check test that feeds identical candidate
  fixtures to both implementations and asserts identical ordering.

### 5.5 Verdent

`VerdentRouter` (`plugin/verdent-accounts.ts:591`) is a near-copy of WorkBuddy's. It gets
the same `policy` parameter and the same `rankAccounts` call. Its governor is
`WorkBuddyEntitlementGovernor` already (`verdent.ts:80`), so `modelWindow` comes from the
same shape — with the hy3/hy4 placeholder filter that `verdentLimitSnapshot` already
applies (`verdent.ts:104`).

## 6. Data plumbing

### 6.1 `useAccountRouting(providerID)`

```ts
// packages/app/src/hooks/use-account-routing/index.ts  (NEW)
export type AccountOption = {
  id: string
  label: string                      // "jack@example.com"
  short: string                      // "jack" - for the row chip
  /** Normalized headroom for THIS model, 0-100, or null when unknown. */
  remainingPercent: number | null
  /** Provider-native secondary figure: credits left, or ~requests left. */
  headroom: { kind: "credits" | "requests"; value: number; label: string } | null
  resetAt: number | null
  state: "ready" | "cooling" | "limited" | "exhausted" | "not-entitled" | "unknown"
  reasons: RankReason[]
  /** True when this session is currently bound here (sticky policy). */
  bound: boolean
  /** True when the active policy would pick this account for the next request. */
  wouldPick: boolean
}
export function useAccountRouting(provider: () => string | undefined): {
  enabled: () => boolean
  accounts: (modelID: string) => AccountOption[]
  policies: () => AutoPolicy[]           // capability-gated
  policy: () => AutoPolicy               // user preference, per provider
  setPolicy: (p: AutoPolicy) => void
  preview: (modelID: string, policy: AutoPolicy) => AccountOption | undefined
  unbind: () => Promise<void>
  source: () => "routing" | "quota" | "labels"   // degradation tier, for the footer
}
```

Implementation notes:

- **One instance per view.** Same rule as `useWorkBuddyUsage`
  (`hooks/use-workbuddy-usage/index.ts:113-120`): it owns a resource, so instantiate it in
  `ModelSelectorPopoverV2View` and pass values down. Rows stay presentational.
- **Generalise, don't fork.** `use-workbuddy-usage` already computes exactly the
  per-account funding logic we need (`forModel`, `modelVariants`, promo-window vs credit
  handling, `isBestAccount`). T2 extracts its account-resolution core into
  `hooks/use-account-usage/` parameterised by descriptor, and re-exports
  `useWorkBuddyUsage` as a thin binding so existing call sites (`:1687`, `:2003`, `:2256`)
  keep working unchanged. Verdent then gets a usage surface for free — today it has
  **none** in the picker, so Verdent rows show no bar at all. This design fixes that as a
  side effect.
- Gated on `store.open`, like every other memo in the file.

### 6.2 Endpoint (enrichment tier)

Registered next to the OpenRouter experimental endpoints
(`server/routes/instance/httpapi/groups/experimental.ts:243-246`, handlers in
`.../handlers/experimental.ts`):

```
GET  /experimental/account-routing?provider=workbuddy[&session=<id>][&model=<id>]
POST /experimental/account-routing/unbind   { provider, session }
```

The plugin already exposes everything needed on its loopback proxy `/health` and
`/metrics` (`plugin/workbuddy.ts:1055-1077`): account list, `governor.metrics()` (state,
`cooldownUntil`, `packageCreditsRemaining`, per-model reports) and `bindingsSnapshot()`.
The endpoint is a thin **in-process** read of `accountRegistry`/`accountRouter` — no HTTP
hop through the proxy — plus a `rankAccounts` preview. It must be advisory: failure returns
`ok:false` and the UI drops to quota-only.

### 6.3 Degradation ladder

| Tier | Source | What the submenu shows |
|------|--------|------------------------|
| `routing` | routing endpoint + quota | Everything: policy previews, bound badge, block reasons, per-model windows |
| `quota` | `useLimits()` only | Accounts, headroom bars, resets, exhausted state. Policy previews marked "estimated"; bound badge hidden |
| `labels` | `usage.accountLabels`, or account ids parsed out of the model list itself | Account names + Auto only; no bars |

The picker must be fully usable at tier `labels` — that is the tier a fresh install with a
cold quota cache lands on.

## 7. Search

`createModelSearchMatcher` runs over `prepareModelSearchFields([name, id, provider.name])`
(`:1108`). Collapsing would otherwise make `jack@example.com` unsearchable.

1. The canonical row's searchable fields gain **every** variant's account label and id, so
   typing `dana` finds the model.
2. **Escape hatch:** when the trimmed query matches one or more *account labels* and the
   group has more than one variant, the group **expands into per-account rows** for that
   query only, each labelled `Model · dana@example.com`. Enter selects that exact pin
   without opening a submenu. This preserves the power-user muscle memory (type the email,
   hit Enter) while the default view stays collapsed.
3. Expansion is decided in the pure collapse module
   (`expandForQuery(groups, query, labels)`), so it is unit-testable and cannot desync from
   navKeys.

## 8. Rendering

### 8.1 Component split

```
MultiAccountRow                 (dialog-select-model.tsx, sibling of OpenRouterRow:550)
  MenuV2.Sub / SubTrigger       <- identical hover + dismiss plumbing as OpenRouterRow
  MenuV2.SubContent
    ModelTooltip                <- reused verbatim, same header treatment as :627-641
    AutoPolicySection           (components/model-account-submenu.tsx, NEW)
    AccountOptionList           (components/model-account-submenu.tsx, NEW)
    AccountSubmenuFooter        (components/model-account-submenu.tsx, NEW)
```

`OpenRouterRow` and `MultiAccountRow` share ~60 lines of `SubTrigger` chrome (provider
icon, name, badge stack, `ModelRowMeta`, favorite toggle). T6 extracts that into a
`ModelRowBody` used by all three row kinds — the plain `MenuV2.Item` branch at `:2288`
included. Net line count of `dialog-select-model.tsx` should go **down**.

### 8.2 Submenu open/close plumbing — reuse, don't reinvent

The controller already has everything:

- `store.submenu` holds the open navKey; `setSubmenu(navKey, open, modelID)` (`:1557`)
  closes the previous one and triggers the data fetch. For multi-account there is nothing
  to fetch, so the fetch call moves behind the descriptor check.
- `activate()` (`:1565`) closes a foreign submenu on hover — reused as-is.
- The outside-dismiss guard checks `[data-model-selector-submenu]` (`:2209-2211`); the new
  SubContent carries the same attribute.
- `tooltipModel()` skips OpenRouter rows so the floating tooltip does not fight the submenu
  (`:1776`). It must skip collapsed multi-account rows for the same reason — the tooltip
  lives in the submenu header instead.

### 8.3 Virtualization

The row list is virtualized (`createVirtualizer`, `:1916`). Collapsing *shrinks* it, so
nothing changes there. The account list inside the submenu is **not** virtualized:
`OpenRouterEndpointList` needs it because OpenRouter returns 20-60 upstreams, while account
counts are single digits. A `max-h-[280px]` scroll container is enough and avoids the
focus/rangeExtractor complexity at `:449-470`.

## 9. Performance budget

| Metric | Today (4 accounts x 12 models) | Target |
|--------|-------------------------------|--------|
| Rows fed to `sortByCheapness` | 60+ | 12 |
| `prepareModelSearchFields` allocations on open | 60 | 12 (larger field set each) |
| Reactive work per hover | 1 memo + possible network (OpenRouter) | 1 memo read, no network |
| Submenu open -> paint | n/a | < 16 ms (data already in memory) |
| New network calls per picker open | 0 | 0-1 (routing snapshot, single-flighted, at most once per open) |

Guardrails: the collapse memo must run **once per `unsorted()` change**, not per render;
`accounts(modelID)` must be a `Map` lookup built in one memo, never an O(accounts x models)
scan per row (the trap `workbuddyMaxRequests` at `:189-198` narrowly avoids by scoping to
visible rows).

## 10. Failure & edge states

| Case | Behaviour |
|------|-----------|
| Zero accounts enrolled | Provider emits no models today. Unchanged. |
| One account | Plain row, no submenu, no chip. |
| Bare id missing for a model (WorkBuddy emits bare ids only from `accounts[0]`'s catalog, `workbuddy.ts:1253-1261`) | Canonical row comes from the account variant; **Auto · Sticky is disabled** with "Not available on your first account". **Server fix in T3:** emit bare ids for the *union* of all accounts' catalogs, which is correct anyway since the router already filters by `account.catalog.ids`. |
| Account removed while picker open | Group re-collapses; a `current()` pointing at the dead id falls back to the canonical row with a one-time toast (extend the stale-key pruning at `models.tsx:65-78`). |
| All accounts exhausted | Every account row is greyed with its reset countdown; the policy section shows "No account can serve this model right now" and Auto rows are disabled rather than silently 429ing on send. |
| Quota unavailable | Tier `quota` -> `labels` (§6.3). No bars, no false confidence. |
| Server without policy support | `capabilities.accountRoutingPolicies` absent => only Auto · Sticky renders. |
| Session bound to an account that no longer serves the model | Bound badge gets a warning dot + "will rotate on next request" — which is exactly what the router does at `workbuddy-accounts.ts:617-634`. |

## 11. ADRs

**ADR-1 — Collapse in the controller, not in the plugin.**
*Alternative:* stop emitting per-account models and expose accounts via a separate API.
*Rejected:* the account-qualified id **is** the transport contract (`chat.headers` reads
it, `handleCompletions` decodes it, drafts/recents/session records persist it), and it keeps
CLI/TUI working with explicit ids. Collapsing is a *view* concern.

**ADR-2 — Policy in the model id, not in a header or a settings toggle.**
*Alternative:* an `x-workbuddy-policy` header set by `chat.headers`. *Rejected for now:*
the id is what persists into recents, favorites, drafts and session records, so "this
session uses Auto · Spread" survives restart for free. A header would need a parallel store
keyed by session. `chat.headers` still *reads* the policy out of the id for Verdent-style
header routing, so both transports stay consistent.

**ADR-3 — Preview the router, don't reimplement it.**
*Alternative:* let the renderer pick the account and always send a pinned id. *Rejected:*
the renderer's quota snapshot is up to a poll interval stale and cannot see in-flight
leases, `pressure`, or a `cooldownUntil` set 200 ms ago. Pinning on stale data is how you
send a request to the account that just got 6004'd. The server decides at request time; the
UI shows its best guess and says so.

**ADR-4 — One submenu component, two providers, N future.**
*Alternative:* copy `OpenRouterRow` per provider. *Rejected:* the file is 2,687 lines and
already carries three provider-specific pricing branches. The descriptor registry is the
price of admission for "more likely to come in the future".

**ADR-5 — Keep `subProvider` out of this.**
The OpenRouter pin store (`context/models.tsx:206-214`, consumed at
`prompt-input/submit.ts:349`) is explicitly OpenRouter-scoped. Multi-account pinning uses
the model id instead (D2). The only shared concept is the *per-provider default policy*,
which gets its own small store (`accountPolicy: Record<providerID, AutoPolicy>`) beside it.

## 12. Testing strategy

| Layer | Tests |
|-------|-------|
| Identity | `model-account-identity.test.ts` — ~30 ids (bare, ctx, pinned, ctx+pinned, policy, malformed, `@` inside a name) asserted against split/join/canonical-name, shared with the proxy decoders |
| Collapse | `dialog-select-model-accounts.test.ts` — grouping, single-account passthrough, non-multi passthrough, missing-bare-id, favorites/recents mapping, `expandForQuery` |
| Ranker parity | `account-policy.test.ts` (server) + `account-policy-preview.test.ts` (renderer) run the **same fixture table** and must agree on ordering |
| Router regression | existing `plugin/tests/workbuddy-accounts.test.ts` must pass untouched after the `rankAccounts` refactor — that is the definition of "sticky is unchanged" |
| Hook | `use-account-routing` against fixture `ProviderResult`s for all three degradation tiers |
| Component | Storybook (`dialog-select-model-multi-account.stories.tsx`): 1/2/5 accounts, all-exhausted, cooling, not-entitled, tier-`labels`, long-email truncation |
| Interaction | the keyboard matrix from UX-SPEC §6 as a `@solidjs/testing-library` test |
