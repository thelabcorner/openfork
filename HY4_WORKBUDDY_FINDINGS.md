# Hy4 / WorkBuddy OpenFork Findings

**Date:** 2026-08-29  
**Repository:** OpenFork (`C:\Users\slooshied\WebstormProjects\opencode`)  
**Status:** native OpenFork provider integration with account-local governors

## Executive result

OpenFork can expose Tencent's signed-in WorkBuddy / CodeBuddy entitlement as a first-class provider without putting a second CodeBuddy agent loop in front of OpenFork. OpenFork remains the agent, session, tool, and model-selection owner. The provider is a thin OpenAI-compatible translation layer; Tencent's signed-in runtime remains the owner of authentication and entitlement refresh.

The production architecture is now:

```text
OpenFork session
    -> WorkBuddy provider
    -> account router (bind once per session)
    -> WorkBuddyAccount
    -> EntitlementGovernor (account-local)
    -> Tencent /v2/chat/completions
```

A frequency window on Account A is not allowed to throttle Account B.

## Confirmed model and realm

- **Hy4 model ID:** `hy4-preview`
- **Global WorkBuddy realm:** credential `auth.domain = www.workbuddy.ai`; backend `https://www.workbuddy.ai`
- **CN CodeBuddy realm:** `www.codebuddy.cn` / `www.workbuddy.cn` credentials route to `https://copilot.tencent.com`
- Global and CN credentials are not interchangeable; a Global credential sent to the CN backend was rejected with HTTP 401.
- Hy3 and DeepSeek-v4 IDs observed in the CN catalog are not assumed available on Global.

Static metadata used only as a last-resort fallback for Hy4:

- context: `1,048,576`
- output: `65,536`
- reasoning: supported
- release observed: `2026-08-28`

Live catalog discovery is attempted per account at (corrected 2026-08-29):

```text
GET {realm}/v3/config                                     # primary
GET {realm}/console/enterprises/{enterpriseId}/config/models  # enterprise overlay
```

Both are called with `User-Agent: workbuddy-ai/<version>`. **The endpoint is
User-Agent gated**: a generic UA is answered with a trimmed payload containing
only `enterpriseId` and a few feature flags and **no models**, so discovery that
does not present the CLI's UA silently gets an empty catalog.

The previous `/console/enterprises/personal/models` path was never a real route
(it returns HTTP 500 at the apisix gateway, while neighbouring paths return 403).
That silent failure is why OpenFork fell back to the hardcoded list, which then
drifted from what the app shows. The correct routes were recovered by reading the
official desktop CLI bundle
(`resources/app.asar.unpacked/cli/dist/codebuddy.js`): `CloudProductProvider`
fetches `/v3/config`, and `ModelsProductProvider` fetches the enterprise route.

Response shape (verified live):

- `data.models` is the model universe, each entry carrying `id`, `name`,
  `maxInputTokens`, `maxOutputTokens`, `supportsReasoning`, `supportsImages`,
  `supportsToolCall`, `contextWindow`, `credits`, `reasoning.supportedEfforts`.
- `data.agents[name=="cli"].models` is the CLI-allowed subset.

The provider uses the `cli` agent's allowed model set intersected with
`data.models`, skips disabled models, caches for five minutes, and retains an
account-local last-known-good result before using the static fallback.

The **live catalog is authoritative about which models exist**. Static entries
only backfill metadata the live payload omits, so a model the endpoint stops
returning cannot linger in the model picker.

Verified live on 2026-08-29 for the Global realm: 19 models, matching the
WorkBuddy app UI exactly — `default-model` (Auto), `fast-model`, `balanced-model`,
`primary-model`, `deep-model` (Ultimate), `hy4-preview`, `hy3`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`,
`gemini-3.5-flash`, `glm-5.3`, `glm-5.2`, `kimi-k3`, `kimi-k2.6`, `minimax-m3`.

## Consumption rate and stretch bars (model picker)

WorkBuddy bills **credits per request**, not dollars per token, and each enrolled
account owns an independent balance. The existing OpenCode-Go stretch path
(`estimateRequestsRemaining` off a USD 5h window) is therefore unusable here —
there is no USD window to divide. The picker instead computes:

```text
estimatedRequests = accountRemainingCredits / modelConsumptionRate
```

The rate is read from the same `/v3/config` catalog entry that produced the model
list (`credits: "x0.79 credits"` / `"x3.47"`), so the bar and the list can never
disagree about which models exist or what they cost. It is exposed to the app
through the quota result's per-model map rather than by widening the `Model`
contract:

```text
plugin (parse `credits`) -> quota adapter -> ProviderUsage.models[].rate
  -> app: remaining credits / rate = est. requests
```

Critical distinctions that are easy to get wrong:

- **`rate: 0` means "unknown", not "free."** A genuinely free model is marked by
  `rateFree` (catalog `"x0.00"`) or an active `promotionLabel` (e.g. "Free now").
  Dividing by an unknown rate would imply infinite requests.
- **Only `Basic` gates.** Gift/Extra are bonus packs; using them would make a
  model look affordable when the main balance is drained.
- **Per-account, not aggregate.** Pooling every account reports "plenty" while
  the account a session is bound to may be empty.
- A missing rate or an unparseable point label yields *no bar*, never a
  full/empty one.

### Per-account bars require an explicit id -> label mapping

The picker lists both `hy4-preview` (auto-assigned) and
`hy4-preview@wb-<stable-id>` (pinned to one account), and each pinned row must
be funded by **its own** account. The stable id and the quota label are NOT
string-derivable from each other:

| source | derived from | example |
| --- | --- | --- |
| model-id suffix / stable id | Tencent UID | `wb-215789ee-59bf-4d13-a45b--9d455a389b` |
| quota window key label | nickname | `arcfit.dev@gmail.com` |

An earlier version looked up the rate with the un-split model id, so every
account-qualified row missed the map and rendered no bar, while the unqualified
rows all drew on one shared balance — indistinguishable from aggregate
behavior. The adapter now publishes `usage.accountLabels` (stable id -> label)
and the hook resolves a pinned row against its own account, falling back to the
best-funded account only for unpinned rows. An unknown account id yields no bar
rather than one funded by the wrong account.

Verified live: `gpt-5.6-luna` (x0.14) resolves to 714 requests on each of three
100-credit accounts and **0** on a drained one, proving rows are no longer
pinned to a single shared balance.

### Free badge

`model.tag.free` is driven by token pricing, which WorkBuddy does not publish —
so free models would never be badged. The badge is instead provider-reported:
the catalog ships `modelPromotions[].badge.label` (e.g. "Free now") alongside a
`x0.00` rate. The badge shows the provider's own wording, falling back to the
localized "Free" tag, and is gated on the rate lookup so it cannot appear for a
model whose rate is merely unknown.

Verified live: on a 100-credit account, `gpt-5.6-luna` (x0.14) → ~714 requests,
`gpt-5.6-sol` (x3.47) → ~28 requests, and `hy4-preview`/`hy3` correctly report as
free (Hy3 carrying its "Free now" promotion badge).

## Tencent protocol facts

- Chat endpoint: `POST {realm}/v2/chat/completions`
- Token refresh endpoint: `POST {realm}/v2/plugin/auth/token/refresh`
- Refresh headers include `X-Refresh-Token` and `X-Auth-Refresh-Source: plugin`; body is `{}`.
- Non-streaming inference is rejected with code `11101`; the provider always streams upstream and folds the stream for callers that requested non-streaming.
- The first message must be `role: system`; the provider injects a minimal system message if necessary. Tencent returns code `11128` otherwise.
- Reasoning arrives as `reasoning_content` deltas.
- Tencent emits `tool_calls: []` on many deltas, including pure reasoning deltas. The provider strips only empty arrays and preserves real tool calls.
- Tool-call continuation with an assistant message followed by a `tool` result was verified.
- Unknown models produce a typed model-availability error.

## Entitlement state and scheduling

Each `WorkBuddyAccount` owns an independent `WorkBuddyEntitlementGovernor`.

```text
READY
TRANSIENT_COOLDOWN
WINDOW_LIMITED(resetAt)
QUOTA_EXHAUSTED
AUTH_INVALID
UPSTREAM_DEGRADED
```

The governor separates:

1. active generation concurrency;
2. new-generation launch frequency; and
3. authoritative window/quota state.

The initial per-account baseline is intentionally configurable rather than presented as a discovered Tencent contract:

- `WORKBUDDY_MAX_CONCURRENT` default: `4`
- `WORKBUDDY_LAUNCH_BURST` default: `4`
- `WORKBUDDY_LAUNCH_PER_SEC` default: `4`

A launch token is consumed only when a new generation starts. Existing streams are not interrupted by launch pacing. Pressure from ordinary 429/5xx responses reduces the account's launch rate and concurrent budget; recovery does not exceed the configured baseline.

### Known Tencent frequency-window behavior

A real Tencent response observed during the investigation was:

```text
429 usage exceeds frequency limit ...
usage will reset at 2026-08-31 01:15:00 UTC+8
```

This is **not** treated as a generic 60-second retry. The governor parses the authoritative reset time, persists `WINDOW_LIMITED(resetAt)` for that account, and rejects future local admissions with the remaining reset time without probing Tencent again. A fresh OpenFork process loads the account-local state.

Ordinary 429s without an authoritative reset remain `TRANSIENT_COOLDOWN`. HTTP 402 becomes account-local `QUOTA_EXHAUSTED`; ordinary bearer-token rotation does not clear that persisted hard limit. Only an explicit re-enrollment/account-epoch change can clear it. No accounts are rotated automatically.

## Account discovery, enrollment, and affinity

The official desktop `.info` location is **not** the multi-account database. Community evidence from Sliverkiss CPA and workbuddy-switch indicates that the desktop workflow commonly exposes one active shared `workbuddy-desktop.info`; switching users replaces that active file. Therefore OpenFork treats desktop discovery as an additive import source only.

OpenFork now owns a durable vault:

```text
~/.workbuddy-ai/workbuddy/accounts/workbuddy-<stable-account-id>.json
```

There are two enrollment paths:

1. **Import current WorkBuddy desktop login** — parse the current `.info`, identify the Tencent UID, and save a copy in the OpenFork vault.
2. **Add WorkBuddy account** — start Tencent's normal OAuth state flow, open the returned authorization URL, poll `/v2/plugin/auth/token?state=...`, fetch account metadata, and save the resulting credential under its UID.

The provider exposes separate OAuth methods for WorkBuddy Global and CodeBuddy CN. Repeating the OAuth method adds another account without logging out the desktop app or overwriting an existing vault record. Discovery also performs convenient additive capture of a previously unseen authenticated desktop identity; explicit import remains available and both paths write to the same vault.

Vault credentials are authoritative for OpenFork. Refreshes update only the account's own vault record through account-local singleflight. OpenFork never writes back to `workbuddy-desktop.info`.

Account identity:

- prefer Tencent `uid`;
- include realm and enterprise identity in the stable hash;
- deduplicate duplicate credential files for the same identity;
- retain the newest duplicate during one-time desktop import;
- keep refreshed in-memory/vault credentials instead of reparsing stale desktop state;
- never log tokens.

The router binds an OpenFork session once:

```text
session alpha -> Account A
session beta  -> Account B
```

Tool continuations keep the same binding. An account removal does not silently rebind an existing session to another account. Automatic assignment is only for a new/unbound session and prefers model availability, non-limited state, and lower account-local load.

Provider model exposure includes account-qualified aliases such as:

```text
hy4-preview@wb-account-a-<stable-id>
```

The unqualified `hy4-preview` remains available for automatic assignment. The model alias selects an account at session bind time; it does not rotate accounts per request.

## Refresh and generation correctness

The generation lifecycle is:

```text
read account credential
  -> refresh before inference only when locally expired/near-expiry
  -> issue exactly one generation
  -> if that request actually returns 401/403, refresh once and retry once
  -> commit the first successful attempt
```

A successful inference is never re-issued merely because the local `expiresAt` was stale. Transport amplification is measured as `attempts / generations`; the offline regression proves `1.00` for a normal request and exactly one additional attempt for an actual auth recovery.

Refresh singleflight is keyed by the account identity. Account A refresh cannot replace Account B's access token. The long-lived credential object is mutated in place; registry scans do not replace it while an account is active. Quota persistence stores a non-secret enrollment epoch rather than a raw bearer token, and ordinary access-token rotation does not clear `QUOTA_EXHAUSTED`.

## Loopback boundary

The embedded OpenAI-compatible server listens only on `127.0.0.1` with a per-process bearer token. The plugin explicitly adds `127.0.0.1`, `localhost`, and `::1` to both `NO_PROXY` and `no_proxy`. An offline regression configured an external HTTP proxy and verified that it saw a non-loopback probe but zero embedded-proxy or fake-upstream loopback requests.

The governor lease spans successful SSE bodies until EOF/cancellation and folded non-stream responses until aggregation completes; terminal upstream errors release their slot immediately. The client response lifecycle propagates cancellation to the upstream fetch and removes queued generations before they start. OpenFork request IDs (`x-opencode-request`) provide the logical generation key; session routing accepts canonical and fallback session headers, and the plugin also injects both canonical session and request headers through `chat.headers`.

The fake backend used by deterministic tests is injected through an in-process test-only setter. There is no production `WORKBUDDY_BACKEND` relay/mirror configuration surface.

## Validation performed

- Governor/state-machine and lease/cancellation/deduplication tests: **43 passed, 0 failed**
- Multi-account registry/router/vault tests: **21 passed, 0 failed**
- Offline OAuth enrollment/vault tests: **10 passed, 0 failed**
- Offline account-aware proxy integration: **22 passed, 0 failed**
- Loopback proxy-bypass regression: **4 passed, 0 failed**
- WorkBuddy plugin bundle compilation: successful

The live provider smoke test previously validated streaming, reasoning, tool calls, tool-result continuation, non-stream folding, model errors, and plugin disposal. The account-aware changes preserve those behaviors in the offline proxy regression and add per-account routing/state isolation.

## Account-enrollment verification boundary

The implementation and offline tests prove that two credential records remain usable in the OpenFork-owned vault even when the simulated official desktop location contains only Account B. The live criterion is intentionally stricter and is **not yet claimed complete**:

1. enroll Account A through the normal OAuth flow;
2. enroll Account B through a separate OAuth flow;
3. switch the official WorkBuddy desktop UI from A to B, allowing its shared `.info` to be replaced;
4. run OpenFork generations bound independently to A and B;
5. verify both accounts still work without restoring or rewriting the desktop `.info` file.

We have not experimentally signed out of the user's real WorkBuddy desktop account in this session, so refresh-token revocation on official sign-out remains unresolved. That experiment should be performed only with explicit user approval and a disposable/known-safe account, because it may invalidate the refresh token. The vault architecture avoids relying on desktop sign-out semantics, but the revocation behavior still needs an empirical result.

The direct Tencent chat transport is intentionally retained because the official CodeBuddy Agent SDK / ACP owns its own agent loop and tool execution, which would create the rejected architecture `OpenFork agent -> CodeBuddy agent -> Hy4`. A future official lower-level runtime transport can replace the direct HTTP call only if it preserves OpenFork's primary agent loop and exposes the same account-local governor boundary.

The next live validation should run a real OpenFork agent session with account metrics captured: TTFT, stream duration, launch spacing, active concurrency, amplification, refresh survival, and session-to-account affinity. No account rotation should be used to mask entitlement behavior.

### Current live-test disposition

The real Tencent/Hy4 agent-session acceptance test is **deferred, not failed**. The account has already reported an authoritative frequency-window limit (`usage exceeds frequency limit`, with a reset timestamp), so another live generation during that window would be expected to fail locally or upstream and would not provide meaningful evidence about the OpenFork agent loop. No additional live inference was issued for this validation pass.

Non-inference validation remains green:

- local provider registration lists `workbuddy/hy4-preview` and the account-qualified model alias;
- the OpenFork CLI starts and exposes the `models` command;
- offline governor, lease-lifetime, cancellation, account-vault, OAuth-enrollment, proxy-translation, and loopback tests pass;
- the live e2e result remains **unknown until the authoritative reset window has elapsed** or a separately entitled account is explicitly enrolled and tested.
