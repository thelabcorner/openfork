# HANDOFF: OpenCode Zen Free Usage Limits

> **Purpose:** Preserve the research, inference model, implementation rationale, known limitations, and merge/validation state for the OpenFork Zen free-usage feature. Read this before modifying, simplifying, rebasing, or merging the feature.
>
> **Feature branch:** `feat/zen-free-usage-limits-v2`
>
> **Implementation head before this handoff commit:** `f2dce08fbc1291f4d7a01513d92e916ecc20b029`
>
> **Base at implementation time:** `main` at `f16fdd776e835b2b54de7548a1029af1a875dbff`
>
> **Status:** implementation is present on the v2 branch; final merge/CI cleanup is intentionally left to the next agent.

## 0. Executive summary

OpenCode Zen has an anonymous/promotional free-model quota, but OpenCode does not publish the actual numeric deployment limit in source or public documentation. The limiter implementation is public, while the numeric values are loaded from the deployment secret `ZEN_LIMITS` through `Subscription.getFreeLimits()`.

The correct OpenFork feature therefore cannot be a hardcoded exact counter. It is a **local estimator of a hidden, time-varying, IP-scoped quota** built from evidence already persisted in the user's OpenCode database.

The key architectural decisions are:

1. **Count provider generation requests, not chat messages.**
   - The source-of-truth observable unit in OpenCode history is persisted `part.type === "step-finish"` rows associated with assistant messages.
   - One assistant message can contain multiple provider generations around tool calls.
   - Counting `usage.summary().models[].messages` systematically undercounts Zen requests.

2. **Use UTC quota days, not a rolling 24-hour window.**
   - Upstream's limiter keys daily usage by UTC `YYYYMMDD` and computes retry time until the next UTC midnight.
   - Any implementation using `now - 24h` is semantically wrong.

3. **Treat successful usage as censored lower-bound evidence.**
   - A day with 137 successful requests proves only `limit >= 137`.
   - It does not prove the cap is 137.
   - A day with 287 successful requests invalidates an assumed 200 cap, but still does not reveal the exact cap.

4. **Treat persisted `FreeUsageLimitError` as the strongest local calibration signal.**
   - A limit hit tells us that the quota boundary was reached near the number of successful provider generations before the first rejection.
   - Repeated rejections after exhaustion are one quota episode, not multiple independent observations.

5. **Do not add a second persistence system for learned state.**
   - The database already stores the durable raw observations: generation steps and structured API failures.
   - Recompute the estimate from raw evidence so future estimator improvements can reinterpret old history without migrations or stale cached state.

6. **Make Zen a normal server-side quota provider.**
   - The feature registers `opencode-zen` through the existing `Quota.Service` provider registry.
   - The existing Limits UI should consume the normal `ProviderResult` contract.
   - Do not reintroduce a one-off Limits-pane card or frontend-local tracking system.

7. **The result is advisory display state only.**
   - It must never gate inference, block requests, or override OpenCode's authoritative retry/error behavior.

The old PR #1 implementation should be considered superseded because it used assistant-message counts and originally modeled rolling 24-hour windows.

---

## 1. Why this feature exists

The UX problem is straightforward: free Zen users receive a sudden HTTP 429 / `FreeUsageLimitError` with little or no advance indication of how much of the anonymous free allowance they have consumed.

OpenFork already has a quota/limits system that normalizes provider account quotas into a shared `ProviderResult` shape. The desired behavior is for Zen free usage to appear in that same Limits experience, even though Zen exposes no client-readable free-quota usage endpoint.

This is unusual compared with normal quota adapters:

- Claude, OpenRouter, NVIDIA, etc. can query provider/account data.
- Zen free usage is enforced server-side against hidden policy.
- The free limiter is IP-scoped.
- The actual deployment limit is secret.
- There can be per-model overrides.
- The server may temporarily change promotions and limits.

So the client has to infer, not pretend to know.

---

## 2. Upstream research: what is source-proven

### 2.1 The numeric limit is intentionally not in the repository

Upstream source:

- `packages/console/core/src/subscription.ts`
- `Subscription.getLimits()` parses `Resource.ZEN_LIMITS.value`.
- `Subscription.getFreeLimits()` returns the `free` section.

The schema proves the free policy contains:

```ts
free: {
  promoTokens: number
  dailyRequests: number
  dailyRequestsFallback: number
  checkHeaders: Record<string, string>
}
```

The values themselves are deployment configuration, not source constants.

Reference:

- https://github.com/anomalyco/opencode/blob/dev/packages/console/core/src/subscription.ts

**Do not replace the estimator with a claim that `200` is an official source constant. It is not.**

### 2.2 The free request limiter is IP-scoped

Upstream source:

- `packages/console/app/src/routes/zen/util/ipRateLimiter.ts`

Relevant behavior:

```ts
const limits = Subscription.getFreeLimits()
const dailyLimit = rateLimit ?? limits.dailyRequests
const ip = !rawIp.length ? "unknown" : rawIp
const lifetimeKey = buildRateLimitKey("ip", ip)
const dailyKey = buildRateLimitKey("ip", ip, dailyInterval)
```

This means the free quota is not reliably an account quota. Multiple machines/users behind the same public IP can affect the same allowance.

That explains reports from CGNAT, corporate networks, shared servers, containers, etc. It also means a local OpenFork counter can never be perfectly authoritative when another client consumes the same public-IP quota.

Reference:

- https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/ipRateLimiter.ts
- https://github.com/anomalyco/opencode/issues/42765

### 2.3 Reset is UTC midnight, not rolling 24 hours

Upstream builds its daily key from:

```ts
new Date(timestamp).toISOString().replace(/[^0-9]/g, "").substring(0, 8)
```

and computes retry-after as:

```ts
Math.ceil((86_400_000 - (now % 86_400_000)) / 1000)
```

Therefore the source-proven reset boundary is **00:00 UTC**.

OpenFork must count the current quota day from UTC midnight to now.

Historical samples should likewise be UTC calendar days.

### 2.4 "New" IPs can receive 2x the default daily allowance

For the default free-model pool, upstream reads both a lifetime IP counter and the daily counter:

```ts
isNew = isDefaultModel && lifetimeCount < dailyLimit * 7

if ((isNew && dailyCount >= dailyLimit * 2) || (!isNew && dailyCount >= dailyLimit)) {
  throw new FreeUsageLimitError(...)
}
```

Important implications:

- A user may legitimately exceed the ordinary daily baseline during the "new IP" phase.
- An observed 300+ request day does not automatically mean the long-term cap is 300+.
- A fixed `200/day` UI with no uncertainty would be wrong for such a user.

The current OpenFork estimator does **not** explicitly display `400` for new IPs because the client cannot reliably reconstruct the server's current IP identity or lifetime counter. Public IP can change, usage can occur from other clients, and the server owns the authoritative lifetime state.

Instead, successful usage above the fallback invalidates false precision and becomes a lower bound. Later structured limit hits calibrate the currently experienced regime.

### 2.5 Per-model rate-limit overrides exist

Upstream `createRateLimiter(...)` accepts a `rateLimit` argument.

When one exists:

```ts
const dailyLimit = rateLimit ?? limits.dailyRequests
const dailyInterval = rateLimit
  ? `${buildYYYYMMDD(now)}${modelId.substring(0, 2)}`
  : buildYYYYMMDD(now)
```

So the server can have:

- the default daily IP pool, and
- model-specific daily pools/limits.

Community reports also show one free model failing while another continues to work, which is consistent with model-specific policy/provider state.

References:

- https://github.com/anomalyco/opencode/issues/42074
- https://github.com/anomalyco/opencode/issues/42977

**Known limitation of the current v2 estimator:** it presents one aggregate `OpenCode Zen` free-quota estimate. It does not claim per-model exactness because the hidden `rateLimit` configuration is not available to the client.

If this is later extended to model-specific estimates, preserve the distinction between default-pool evidence and override-pool evidence. Do not simply divide or duplicate the aggregate count across models.

### 2.6 Header gating currently exists in source but is disabled

Upstream contains the historical `checkHeaders` / `dailyRequestsFallback` mechanism, but current source sets:

```ts
const headersExist = true
```

with the real header check commented out.

That means current source always uses:

```ts
rateLimit ?? limits.dailyRequests
```

rather than `dailyRequestsFallback` based on headers.

Historical context is still useful because this policy has changed before and can change again.

Reference:

- https://github.com/anomalyco/opencode/issues/28807

### 2.7 The free limiter can affect users with Zen credit balance

Community issue #33495 reports two accounts, including one with at least $20 Zen balance, both hitting an approximately 200-request free cap and receiving `FreeUsageLimitError`.

Other related reports show the same surprising behavior.

References:

- https://github.com/anomalyco/opencode/issues/33495
- https://github.com/anomalyco/opencode/issues/33318
- https://github.com/anomalyco/opencode/issues/32971

This supports the implementation decision to detect **the structured free-limit error itself**, not infer free-limit status from whether the user has billing/credit balance.

### 2.8 The best public numeric baseline is approximately 200 requests/day

OpenCode does not publish the actual deployment value in source.

However, multiple community reports explicitly describe a 200-request free daily limit, including issue #33495. This is strong enough for a weak bootstrap prior but not strong enough to label as official.

Therefore:

```ts
export const ZEN_FREE_FALLBACK_LIMIT = 200
```

is intentionally a **low-confidence fallback**, not a hard truth.

UI rendering reflects that distinction by using an approximate label for fallback state.

---

## 3. Current free-model identification strategy

During research on 2026-08-28, the live free Zen catalog included examples such as:

- `big-pickle`
- `deepseek-v4-flash-free`
- `muse-spark-1.2-contributor-free`
- `mimo-v2.5-free`
- `hy3-free`
- `ling-3.0-flash-fin-free`
- `nemotron-3-ultra-free`
- `nemotron-3.5-lightning-free`
- `laguna-s-2.1-free`

The catalog changes frequently. For that reason, `packages/opencode/src/usage/zen-free.ts` intentionally does **not** hardcode the whole list.

Current classifier:

```ts
export function isZenFreeModelID(modelID: string | null | undefined) {
  if (!modelID) return false
  const normalized = modelID.trim().toLowerCase()
  return normalized === "big-pickle" || normalized.endsWith("-free")
}
```

Rationale:

- Current promotional models consistently use `-free`.
- `big-pickle` is the established exception.
- Structural matching automatically handles new `*-free` additions without a client release.
- Paid Zen traffic is excluded from the learned free allowance.

Do not replace this with a frozen list unless upstream introduces a stable machine-readable free-model flag that can be consumed locally.

---

## 4. The critical measurement decision: count `step-finish`, not messages

This is the most important regression trap in the entire feature.

### 4.1 Why `usage.summary().models[].messages` is wrong

OpenCode's general Usage service aggregates assistant message rows for its `messages` metric.

But a single assistant turn can perform:

1. model generation,
2. tool call,
3. tool result,
4. model continuation,
5. another tool call,
6. another model continuation.

That is one assistant message lifecycle from a chat/UX perspective but multiple provider generation requests.

Zen's free limiter increments on provider requests, not on human prompts or visible conversation messages.

Therefore the original app-side implementation in PR #1 systematically undercounted real quota consumption for tool-heavy agent sessions.

### 4.2 Persisted `step-finish` parts are the useful observable unit

The v2 implementation scans:

```sql
SELECT
  p.time_created AS at,
  json_extract(m.data, '$.modelID') AS model_id
FROM part p
JOIN message m ON m.id = p.message_id
WHERE p.time_created >= ?
  AND p.time_created < ?
  AND json_extract(p.data, '$.type') = 'step-finish'
  AND json_extract(m.data, '$.role') = 'assistant'
  AND json_extract(m.data, '$.providerID') = 'opencode'
ORDER BY p.time_created ASC
```

Then it filters model IDs through `isZenFreeModelID`.

This gives an observed count of successful OpenCode Zen free provider-generation steps.

### 4.3 Tests explicitly pin this behavior

`packages/opencode/test/usage/zen-free.test.ts` seeds one assistant message containing two `step-finish` parts and verifies:

```ts
expect(day?.requests).toBe(2)
```

It also seeds a paid `opencode` model step and verifies it is excluded.

**Do not "simplify" the scanner back to assistant-message counts.**

---

## 5. Recovering durable limit-hit observations

OpenCode persists assistant errors in `message.data`.

The v2 scanner looks for:

- assistant role,
- `providerID === "opencode"`,
- `error.name === "APIError"`,
- `error.data.responseBody` containing `FreeUsageLimitError`.

Conceptually:

```sql
SELECT
  COALESCE(
    json_extract(m.data, '$.time.completed'),
    m.time_updated,
    m.time_created
  ) AS at,
  json_extract(m.data, '$.modelID') AS model_id
FROM message m
WHERE ...
  AND json_extract(m.data, '$.error.name') = 'APIError'
  AND instr(
    COALESCE(json_extract(m.data, '$.error.data.responseBody'), ''),
    'FreeUsageLimitError'
  ) > 0
```

This is deliberately more trustworthy than UI event instrumentation because it works even if:

- the Limits pane was never opened,
- the app was in another route,
- the error occurred in a background session,
- the observation predates this feature.

### 5.1 First rejection per UTC day is the calibration episode

Once a quota is exhausted, retries can produce multiple identical 429s.

Those are not independent measurements.

`buildZenFreeSnapshot()` sorts persisted errors and retains only the first free-limit hit per UTC day:

```ts
const seenHitDays = new Set<number>()
```

The hit's request count is the number of successful free-model request events earlier than the error timestamp.

The DB test seeds two post-exhaustion errors and verifies only one limit-hit sample survives.

---

## 6. Why there is no separate learned-state table or localStorage blob

The earlier frontend design considered storing compact quota observations separately.

The final v2 architecture deliberately does not.

The user's existing OpenCode DB already stores the raw evidence:

- successful provider-generation steps,
- timestamps,
- model IDs,
- structured API failures.

Persisting a second derived state would introduce:

- stale learned values after estimator changes,
- migration/versioning burden,
- duplicated truth,
- frontend lifecycle dependence,
- possible divergence from actual history.

Instead, `ZenFreeUsage.Service.snapshot()` reconstructs a bounded evidence window from the DB and the estimator derives the current view.

This is an important maintainability choice. Do not add a new database table just to cache the estimate unless profiling proves the current bounded scan is a real problem.

---

## 7. Scanner architecture and performance decisions

File:

- `packages/opencode/src/usage/zen-free.ts`

### 7.1 Bounded history

```ts
export const ZEN_FREE_HISTORY_DAYS = 90
```

The service does not scan the user's entire database indefinitely.

Ninety days is enough to:

- capture recent limit regimes,
- retain multiple hit samples for recency weighting,
- support changing promotions,
- avoid unbounded analytics cost.

### 7.2 Dedicated analytics connection

The service uses:

```ts
withBackfillDb(filename, ...)
```

rather than making the normal hot application DB connection perform a long historical analytics scan.

This follows the existing Usage-service architecture.

### 7.3 Serialized scans

```ts
const queryPermit = yield* Semaphore.make(1)
```

Only one snapshot query is allowed through this service at a time.

### 7.4 Five-second snapshot cache

```ts
const SNAPSHOT_CACHE_TTL_MS = 5_000
```

Quota UI refreshes should not repeatedly rescan the same 90-day window within a few milliseconds.

The cache is intentionally short because current-day request consumption is changing while agents generate.

### 7.5 Time indexes

The service creates, if absent:

```sql
CREATE INDEX IF NOT EXISTS idx_part_time_created ON part (time_created)
CREATE INDEX IF NOT EXISTS idx_message_time_updated ON message (time_updated)
```

These keep the bounded historical scan cheap on large, long-lived OpenCode databases.

The JSON predicates are still post-filtered, but the timestamp range is indexable.

Do not remove these indexes casually. If changing them, benchmark a realistic large database and confirm startup/service initialization behavior.

### 7.6 Global service node

The service is exposed through a global node with the database dependency:

```ts
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node],
})
```

This keeps the usage scanner server-side and reusable by quota code without coupling to the renderer.

---

## 8. Estimator semantics

File:

- `packages/opencode/src/quota/providers/opencode-zen.ts`

Constants at handoff:

```ts
ZEN_FREE_FALLBACK_LIMIT = 200
ZEN_FREE_LOWER_BOUND_HORIZON_MS = 14 days
ZEN_FREE_HIT_HALF_LIFE_MS = 14 days
```

### 8.1 Output state

The estimator returns:

```ts
type ZenFreeLimitEstimate = {
  used: number
  limit: number | null
  knownAtLeast: number
  source: "fallback" | "learned" | "lower-bound"
  confidence: number
  hitSamples: number
  lastLimitHitAt: number | null
}
```

### 8.2 Fallback state

With no stronger evidence:

- `limit = 200`
- `source = "fallback"`
- low confidence (`0.15`)

The fallback is a prior, not an assertion that OpenCode officially guarantees exactly 200.

### 8.3 Successful days are lower bounds

For recent completed UTC days, the estimator takes the maximum observed successful request count as `knownAtLeast`.

A successful day is censored data because the user may simply have stopped before exhaustion.

Example:

```text
137 successful requests, no 429
```

means:

```text
limit >= 137
```

not:

```text
limit = 137
```

### 8.4 Limit hits are recency-weighted

Each persisted structured limit hit receives exponential weight:

```ts
2 ** (-(now - at) / 14 days)
```

A weak fallback pseudo-observation is included:

```ts
{ value: 200, weight: 0.35 }
```

The learned point estimate is a weighted median.

Why weighted median instead of mean:

- robust to old promotional regimes,
- robust to occasional imperfect calibration,
- does not smear a sudden policy change into a fictitious midpoint as strongly as an arithmetic mean.

### 8.5 Recent policy changes must beat stale history

Tests pin the intended behavior:

- old 400-request hits,
- followed by a fresh 120-request hit,
- should learn approximately the fresh 120 regime.

This is why recent observations have a half-life rather than equal permanent weight.

### 8.6 Ignore pre-hit lower bounds after a legitimate downward regime change

Suppose yesterday the user successfully made 310 requests under an old promotion, then today hits a structured limit at 100.

The old 310 lower bound must not invalidate the fresh 100 regime forever.

The estimator therefore ignores completed-day lower-bound evidence older than the latest structured limit hit when determining the current regime.

This behavior has an explicit test:

```text
pre-hit high-usage days do not prevent a legitimate downward regime change
```

### 8.7 Successful usage above the learned cap destroys false precision

If the learner believes the cap is 200 but the current/recent observed successful usage reaches 235, the correct answer is not to show 117.5% of a 200 quota.

The estimate becomes:

```ts
limit: null
knownAtLeast: 235
source: "lower-bound"
```

The UI then reports that the cap is at least the observed value rather than asserting a false exact limit.

This is one of the most important statistical invariants in the feature.

---

## 9. Provider-result projection and UI integration

The v2 implementation intentionally does not add a custom frontend hook/card.

`opencodeZen(usage)` implements the existing quota `Adapter` contract:

```ts
export const opencodeZen = (usage: ZenFreeUsage): Adapter => ({
  id: "opencode-zen",
  name: "OpenCode Zen",
  aliases: ["zen", "opencode-free", "opencode-zen-free"],
  configured: () => Effect.succeed(true),
  fetch: () => ...,
})
```

It is registered in:

- `packages/opencode/src/quota/quota.ts`

with `ZenFreeUsage.Service` as a normal service dependency.

### 9.1 Why `configured()` is always true

This adapter describes locally observed anonymous/free Zen usage, not an authenticated external account endpoint.

The user does not need a separate Zen credential merely for the local estimate to exist.

### 9.2 Existing Limits UI should render it normally

The provider emits a standard `ProviderResult` and one daily window.

Learned example:

```text
planLabel: 50/200 req
window: daily learned
usedPercent: 25
resetAt: next UTC midnight
```

Fallback example uses approximate notation:

```text
53/~200 req
```

Lower-bound state intentionally sets `usedPercent` to `null` because a denominator is unknown.

It provides a value label similar to:

```text
235 used, cap at least 235
```

Do not invent a percentage when `limit === null`.

### 9.3 The quota result is advisory only

The comment in `quota.ts` is intentional:

> quota results are advisory display state only and never gate inference

Preserve this separation.

The authoritative behavior remains the actual provider call and existing retry/error path.

---

## 10. Why the original PR #1 must not be merged

PR #1:

- https://github.com/thelabcorner/openfork/pull/1
- branch: `feat/zen-free-usage-limits`
- title: `feat: learn and surface OpenCode Zen free usage limits`
- still open/draft at handoff time

It contains useful early estimator concepts but its measurement/integration architecture is superseded.

### Problems with PR #1

1. It reuses `usage.summary().models[].messages`.
   - That counts assistant messages, not provider generation requests.
   - Tool-using agent turns can issue multiple Zen requests per assistant message.

2. Its PR body still describes `rolling 24h` semantics.
   - Upstream source proves the actual reset is UTC midnight.

3. It performs learning/persistence in app-side hooks/utilities.
   - This depends more heavily on renderer lifecycle.
   - It duplicates evidence that already exists durably in the OpenCode DB.

4. It introduces more frontend special casing than necessary.
   - Zen fits the existing server-side `Quota.Service` adapter abstraction.

### Action for the merge agent

- Do not merge PR #1.
- Close it as superseded once the v2 PR exists/is accepted.
- Do not cherry-pick its frontend files into v2 unless a specific UX feature is independently proven necessary.

Old PR #1 changed files included:

- `packages/app/src/hooks/use-limits/index.ts`
- `packages/app/src/hooks/use-zen-free-usage.ts`
- `packages/app/src/pages/session/usage-exceeded-dialogs.tsx`
- `packages/app/src/utils/zen-free-usage.ts`
- `packages/app/test/utils/zen-free-usage.test.ts`

Those files are **not** the preferred v2 architecture.

---

## 11. v2 branch files and responsibilities

At handoff, `feat/zen-free-usage-limits-v2` is ahead of `main` by six implementation commits and changes exactly these feature files:

### `packages/opencode/src/usage/zen-free.ts`

Responsibilities:

- UTC-day helpers.
- Free-model classifier.
- Snapshot data types.
- Convert request/error events into daily usage and deduplicated limit hits.
- Query 90 days of persisted `step-finish` and `FreeUsageLimitError` evidence.
- Dedicated/backfill DB connection.
- Serialize historical query work.
- 5-second snapshot cache.
- Add time indexes.
- Expose `ZenFreeUsage.Service` and global node.

### `packages/opencode/src/quota/providers/opencode-zen.ts`

Responsibilities:

- 200-request weak fallback.
- Recency weighting.
- Lower-bound semantics.
- Learned/fallback/lower-bound state.
- Provider-result formatting.
- UTC reset projection.
- `opencode-zen` adapter.

### `packages/opencode/src/quota/quota.ts`

Responsibilities:

- Add `ZenFreeUsage.Service` dependency.
- Register `opencodeZen(zenFreeUsage)` in the existing adapter list.
- Keep all quota providers behind the same registry/service contract.

### `packages/opencode/test/quota/opencode-zen.test.ts`

Pins:

- low-confidence 200 fallback,
- successful historical days as lower bounds,
- fresh structured hit beating fallback,
- recent hits dominating stale policy,
- pre-hit high-usage days not blocking a downward regime change,
- successful usage above a learned cap invalidating exactness,
- standard Limits provider projection,
- UTC reset timestamp.

### `packages/opencode/test/usage/zen-free.test.ts`

Uses a real temporary SQLite DB and pins:

- two `step-finish` parts in one assistant message count as two requests,
- paid OpenCode Zen traffic is excluded,
- structured persisted `FreeUsageLimitError` is recovered,
- repeated post-exhaustion errors on one UTC day deduplicate to one calibration episode.

---

## 12. Known limitations and intentional uncertainty

The feature is designed to be honest about what can and cannot be reconstructed locally.

### 12.1 External usage on the same IP is invisible locally

Because the server limiter is IP-scoped, OpenFork cannot see requests made by:

- another computer behind the same NAT,
- another user on a shared server,
- another OpenCode installation,
- curl or another client,
- another process using the same public IP.

Local `used` is therefore **observed local usage**, not guaranteed authoritative Redis usage.

A structured limit hit still teaches the local learner that the remotely enforced boundary was reached, but the number of locally observed requests before the hit may understate shared-IP consumption.

Do not relabel this feature as an exact server counter unless OpenCode exposes an authoritative quota endpoint/header.

### 12.2 Per-model overrides are hidden

The server supports `rateLimit` overrides, but the client does not know which current models have them or the secret values.

The current aggregate provider is intentionally conservative.

A future per-model implementation should be driven by evidence/source changes, not guessed from model names.

### 12.3 A limit hit's observed request count can be below the true server count

Reasons include:

- shared-IP external consumption,
- historical DB gaps,
- use from another client,
- retries/requests not represented by successful `step-finish` rows.

This is why recency weighting and lower-bound invalidation matter, and why confidence should remain an advisory concept.

### 12.4 Free policy can change without an OpenFork release

`ZEN_LIMITS` is deployment configuration.

OpenCode can change:

- `dailyRequests`,
- model overrides,
- header policy,
- promotions,
- new-IP behavior,
- model catalog.

The feature must stay adaptive.

---

## 13. CI/homelab state at handoff

OpenFork originally had no workflow. A bootstrap CI workflow was added to `main` in commit:

```text
f16fdd776e835b2b54de7548a1029af1a875dbff
```

The required runner contract is:

```yaml
runs-on: [self-hosted, homelab]
```

The repo-scoped runner is expected to be named similarly to:

```text
homelab-thelabcorner-openfork
```

Do not switch this repository to GitHub-hosted runners merely to make checks run.

### PR #3

Open PR:

- https://github.com/thelabcorner/openfork/pull/3
- branch: `fix/homelab-ci-install`
- head at handoff: `e168372e43151d852222803f6131d0d0dd96b48b`
- title: `ci: allow Bun lockfile normalization on homelab`

Reason:

- repository pins Bun `1.3.14`,
- `bun install --frozen-lockfile` attempted to normalize 27 lockfile changes and then refused to continue,
- the PR changes CI to allow the ephemeral runner workspace to normalize/install dependencies.

The PR's homelab check reached validation but still failed in the existing root lint stage with 14 annotations. That baseline lint failure is separate from the Zen feature.

**Do not claim the Zen feature is fully CI-green until the exact v2 feature head has run after baseline CI is resolved.**

---

## 14. Recommended merge sequence for the next agent

Read `docs/handoff/AGENTS.md`, root `FORK.md`, and the nearest package instructions before any merge operation.

The current branch name predates the documented short-name convention. Do **not** rewrite history or force-push merely to rename it.

Recommended sequence:

1. Resolve PR #3 / baseline homelab CI so `main` has a meaningful green validation path.
2. Merge PR #3 if its change is still the correct baseline fix.
3. Bring the new `main` into `feat/zen-free-usage-limits-v2` with a **normal merge commit**.
   - Do not force-push.
   - Do not rebase merely for cosmetics.
   - Do not rewrite the six feature commits.
4. Resolve conflicts according to `FORK.md` ownership and local package instructions.
5. Run focused package validation from `packages/opencode`, not from repository root.
6. Confirm the exact feature head runs on `[self-hosted, homelab]`.
7. Open a new PR from `feat/zen-free-usage-limits-v2` to `main` if one does not already exist.
   - At handoff time there is **no open PR for the v2 branch**.
8. Review the resulting diff. It should not accidentally pull in the old PR #1 frontend implementation.
9. Merge only when feature-specific validation is green or any remaining baseline failure is clearly documented and independently accepted.
10. Close PR #1 as superseded.

---

## 15. Validation commands

Repository instructions explicitly say not to run tests from the repository root.

From `packages/opencode`:

```bash
bun test test/quota/opencode-zen.test.ts test/usage/zen-free.test.ts
bun typecheck
```

Also run the broader quota/server coverage appropriate to the package if baseline allows:

```bash
bun test test/quota
```

If quota HttpApi/generated surfaces are changed during merge resolution, follow `docs/handoff/AGENTS.md` generation rules. The current feature itself modifies the service/provider internals, not a new HttpApi route.

### Regression assertions that must stay true

- [ ] One assistant message with two `step-finish` parts counts as 2 Zen requests.
- [ ] A paid/non-free `providerID: "opencode"` model does not count toward free usage.
- [ ] `big-pickle` counts as free.
- [ ] New `*-free` models count automatically.
- [ ] UTC midnight is the daily reset.
- [ ] Successful high-usage days become lower bounds, not exact caps.
- [ ] A fresh structured hit can move the learned cap down from an older promotional regime.
- [ ] Old high-usage days before a fresh limit hit do not permanently block a downward regime change.
- [ ] Successful usage above a learned cap removes false exactness instead of showing >100% as if the denominator were still valid.
- [ ] Multiple post-exhaustion `FreeUsageLimitError`s in one UTC day are one calibration episode.
- [ ] Unknown denominator means `usedPercent === null`.
- [ ] Zen uses the normal quota provider path, not a one-off renderer implementation.
- [ ] Quota display state never gates inference.
- [ ] Homelab CI remains `[self-hosted, homelab]`.

---

## 16. Things not to "clean up" without understanding why

### Do not replace request counts with message counts

This is a correctness regression for tool-using agent sessions.

### Do not change UTC-day accounting to rolling 24 hours

The upstream limiter uses UTC calendar dates.

### Do not hardcode 200 as certain

It is a community-supported baseline plus hidden server policy, not a published invariant.

### Do not infer an exact cap from a day that never hit the limit

That is statistically invalid censored-data handling.

### Do not show a percentage when the denominator has been invalidated

Use lower-bound state with `usedPercent: null`.

### Do not store only the derived learned value

Raw persisted DB evidence is more durable and lets the algorithm evolve.

### Do not reintroduce frontend-local observation as the primary source

The server-side DB scanner can recover history and background-session events without renderer lifecycle dependence.

### Do not assume an account balance means the free limiter is irrelevant

Community reports show `FreeUsageLimitError` can still occur with paid Zen balance.

### Do not assume every free model necessarily shares one exact pool

Upstream supports per-model `rateLimit` overrides.

### Do not use the estimate to block inference

Only the Zen server knows the authoritative IP-side state.

### Do not switch CI to GitHub-hosted runners

OpenFork's CI is intentionally routed through the repo-scoped homelab runner.

---

## 17. Potential future improvements, explicitly out of scope for this merge

These are reasonable follow-ups but should not be smuggled into the merge unless independently justified and tested.

### 17.1 Authoritative response headers

If OpenCode begins returning remaining/reset headers for free Zen usage, prefer those as higher-confidence evidence and retain the local learner as fallback/history.

Issue #42765 specifically proposes this class of improvement upstream.

### 17.2 Per-model quota buckets

If upstream exposes model `rateLimit` metadata to clients, split observations into:

- default free pool,
- explicit model-specific pools.

Until then, avoid false model-level precision.

### 17.3 Shared-IP discrepancy signaling

A future UI could say something like "local observed usage" when a limit hit occurs much earlier than local request history predicts, indicating likely shared-IP consumption.

Do not silently mutate the learned cap to the local count and present it as authoritative.

### 17.4 Better calibration around failed provider requests

Current successful request evidence uses `step-finish`, while limit errors come from persisted API failures. If upstream persistence later exposes every provider attempt distinctly, including unsuccessful non-limit attempts, the measurement model can become more precise.

### 17.5 Estimator observability/debug UI

Confidence, hit sample count, last hit, and source are already computed. A future advanced/debug surface could expose them, but the normal Limits pane should stay compact.

---

## 18. Research source index

Source-proven implementation:

- IP free limiter: https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/ipRateLimiter.ts
- Hidden free limits schema/config loader: https://github.com/anomalyco/opencode/blob/dev/packages/console/core/src/subscription.ts
- Related token trial limiter, separate from the request counter: https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/trialLimiter.ts
- API-key minute limiter, also separate from the anonymous daily free counter: https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/keyRateLimiter.ts

Community evidence/corroboration:

- Paid balance still hitting reported ~200 free cap: https://github.com/anomalyco/opencode/issues/33495
- Paid balance still hitting `FreeUsageLimitError`: https://github.com/anomalyco/opencode/issues/33318
- Free tier / paid-balance confusion and IP behavior: https://github.com/anomalyco/opencode/issues/32971
- Shared-IP / CGNAT quota-warning motivation: https://github.com/anomalyco/opencode/issues/42765
- Model-specific failure while other free models can work: https://github.com/anomalyco/opencode/issues/42977
- DeepSeek free model failure investigation: https://github.com/anomalyco/opencode/issues/42074
- Historical header/fallback behavior for forks: https://github.com/anomalyco/opencode/issues/28807

Treat source code as authoritative for mechanics. Treat issue reports as evidence about deployed numeric values/real-world behavior, not as guaranteed policy contracts.

---

## 19. Final mental model

The simplest correct way to think about this feature is:

```text
OpenCode server owns an unseen, mutable IP quota.
              |
              | successful requests + structured 429s
              v
OpenCode DB stores durable local evidence.
              |
              | 90-day bounded reconstruction
              v
ZenFreeUsage snapshot
              |
              | censored lower bounds + recency-weighted limit hits
              v
Zen free limit estimate
              |
              | normal ProviderResult
              v
Existing OpenFork Limits UI
```

The design goal is **useful without lying**.

When evidence is weak, say approximately 200.

When successful usage proves the cap is higher, say at least N.

When a structured limit hit provides strong recent evidence, learn from it.

When newer evidence contradicts older policy, prefer the newer regime.

And at no point should the locally inferred display state pretend to be more authoritative than the Zen server that actually enforces the quota.
