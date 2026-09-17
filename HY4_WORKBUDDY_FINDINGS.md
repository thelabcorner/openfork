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

## ASAR verification of the official auth / re-auth path (2026-09-16)

Source read directly from the installed bundle (WorkBuddy AI 5.5.2):
`resources/app.asar` (`main/file-authentication-storage.js`,
`main/credential-protection.js`, `main/legacy-auth-session-migrator.js`) and
the unpacked CLI bundle `resources/app.asar.unpacked/cli/dist/codebuddy.js`.

### Official client behavior (authoritative for our translation layer)

- Login: `POST {endpoint}/v2/plugin/auth/state?platform=workbuddy-ai` → open
  the returned `authUrl` in a browser → poll
  `GET /v2/plugin/auth/token?state=…` → `GET /v2/plugin/account`.
- Refresh: `POST {endpoint}/v2/plugin/auth/token/refresh` with
  `X-Refresh-Token` and `X-Auth-Refresh-Source: plugin` (plus `X-Domain`) and
  deliberately **no `Authorization`** header. `data.data` carries the next
  `accessToken` / `refreshToken` / `expiresIn`; expiry is derived from
  `expiresIn` when absent.
- Session validation / post-refresh confirmation:
  `GET /v2/plugin/accounts` (`getAccountSnapshot`), confirmed live against
  `www.workbuddy.ai` (HTTP 200 `{code:0,data:{accounts:[…]}}`).
- Failure taxonomy: only HTTP 401/403 means "credential rejected"; every
  other failure (network, 5xx, empty payload) is transient. Poll-specific
  retry codes are 11217 / 12151.
- Storage: `{sharedDataPath}/auth/workbuddy-desktop-ai.info`, written under a
  file lock with atomic replace and a logout-marker protocol. Credential
  fields are encrypted at rest only when the host supplies a symmetric key
  (`main/credential-protection.js`); otherwise the file is plaintext JSON.

### OpenFork ownership after this verification

- The plugin's `AccountVault` stays the single durable credential owner; the
  desktop `.info` is an import/heal source only and is never written.
- `reauthenticateAccount(account)` is the single automatic re-auth entry
  point: account-local singleflight, official header shape, persisted
  rotation. A backend-rejected refresh cannot be renewed programmatically —
  Tencent's login is an interactive browser OAuth state flow — so desktop
  heal plus the explicit import/OAuth methods remain the fallback.
- `validateAccountAuth` is the Tier 0 proactive check against
  `/v2/plugin/accounts`. It is singleflighted and throttles non-valid
  verdicts for 30 s so a rejected credential (or a network blip) cannot
  become a retry loop; `valid` clears learned `AUTH_INVALID`.
- `WorkBuddyEntitlementGovernor` remains the single producer of learned auth
  state. Only a refresh the backend rejected (401/403) persists
  `AUTH_INVALID`; transient refresh failures never do. Validation rejections
  never poison the account. Account-forbidden verdicts quarantine separately
  (see the error-classification findings below).

### Error-classification findings (2026-09-16, corrected by live bisection)

- Code 11140 ("request illegal") and 11142 are **not** request-shape errors.
  The official client's own `classifyErrorDetail` maps them to
  `{category:"auth", subcategory:"auth_forbidden"}`. Live bisection on
  2026-09-16 proved the rejection is account-scoped: an affected account
  (`southsidehype111`, plus `xhuebusiness` and `4wgmsymbzr`) answered 11140
  for **every** model — including a minimal `system`+`user` body with no
  tools, reasoning, or sampling params — while other accounts succeeded with
  byte-identical requests. A freshly refreshed token pair still received
  11140, and `/v2/plugin/accounts` answered 200 for restricted accounts, so
  neither re-auth nor token inspection can detect it. Community reports
  ("workbuddy 账号不能用了 11140") match: reinstall/relogin/cache-clear do not
  help. OpenFork therefore classifies 11140/11142 as `ACCOUNT_FORBIDDEN`:
  quarantined for 15 minutes (`WORKBUDDY_FORBIDDEN_COOLDOWN_MS`), admission
  rejected with 403 `account_forbidden`, sessions auto-rotated to healthy
  accounts, and the error states plainly that this is a Tencent-side
  restriction that re-authentication does not clear.
- Blast radius (2026-09-16, all accounts probed with a minimal `hy4-preview`
  request): **restricted** = `southsidehype111`, `xhuebusiness@gmail.com`,
  `4wgmsymbzr-art` (403/11140); `arcfit.dev@gmail.com` rate-limited (429, not
  forbidden); the other eleven accounts still stream 200. Every restricted
  account had its vault credential rewritten that same day (i.e. was in
  active use); every healthy account's last write was 2026-08-29…09-06.
- The **official WorkBuddy desktop app** on a fresh login for
  `xhuebusiness@gmail.com` also returns 11140 (trace
  `8358005b27c94906860c2590ff54d215`, "Service encountered an error"),
  confirming this is account-level state that a re-login does not clear.
- Candidate detection signals (unproven — server-side risk control is not in
  any client bundle): first-party attestation the official client carries and
  the plugin does not — the **Qimei36 device fingerprint**
  (`@tencent/qimei-node`, injected into the agent subprocess env), the
  **`X-Private-Data`** header, the conversation-lifecycle headers
  (`X-Conversation-ID`, `X-Root-Request-ID`, …), Aegis/universal-report
  telemetry, plus behavioural correlates (multi-account fan-out from one
  machine/IP, free-model farming, retry storms). TLS/HTTP fingerprint
  differences are possible but secondary.
- A controlled experiment ruled out request shape and branding entirely: the
  official 18,884-char `cli-agent-prompt` (with its `<content_policy>`), the
  full official header extras (`X-Product`, `X-IDE-*`, `X-Agent-Intent`,
  `X-Conversation-*`, `X-Request-ID`, `X-Trace-ID`), `temperature: 1`, and a
  desktop-like `User-Agent` — plus sweeps with the official
  `workbuddy-ai/5.4.2` UA, no UA, no identity headers, and no `X-Domain` —
  every combination returned 11140 on the restricted account for both
  `deepseek-v4.1-flash` and `glm-5.2`, while the identical request returned
  200 (SSE) on a healthy control. There is no prompt, branding, or header
  fix that can unblock a restricted account.
- The 403 envelope carries a server `displayMsg`: "内容未通过安全审核，请调整后重试。"
  ("The content did not pass the safety review. Please adjust and retry."),
  which OpenFork now surfaces in the error text. It is nevertheless not
  prompt-triggered: a trivial "Say OK" request fails identically on a
  restricted account while other accounts accept byte-identical requests,
  and the official client's own taxonomy still classifies 11140 as
  `auth_forbidden`. Credits are ruled out (the restricted account still holds
  174.3 + 100 credits, vs 246.3 + 100 on a healthy one), as are tokens
  (`/v2/plugin/auth/token/refresh` 200, `/v2/plugin/accounts` 200 with
  `pluginEnabled: true`). Community reports in the same window describe
  exactly this: WorkBuddy International is enforcing against reverse-proxy
  consumption ("WorkBuddy国际版反代开始封号了"; the official client also
  stops working on flagged accounts), and multiple Tencent community threads
  on 11140 remain unresolved after reinstall and relogin. Escalation requires
  the account's UIN/UID plus the request id returned with the error
  (e.g. `d2b21222-326b-46c7-a499-c879cb6deae7`); the official FAQ directs
  users to `workbuddy_ai@tencent.com` (CN docs: `workbuddy@tencent.com`).
- Code 11155 requires the previous turn's `reasoning_content` to be echoed in
  thinking mode. The proxy backfills it additively, matching the vendor's own
  `ReasoningContentBackfillRule` (visible in the CLI bundle and the bundled
  model catalog's `compat.requiresReasoningContentOnAssistantMessages`).

### Live evidence and scope
- A real Global account was refreshed through the production
  `reauthenticateAccount` path: outcome `refreshed`, token pair rotated and
  persisted to the vault, `validateAccountAuth` returned `valid`
  (`packages/opencode/script/probe-workbuddy-refresh.ts`).
- Scope: measured on `www.workbuddy.ai` only. CN realms and staging share the
  same official provider code path but were not live-tested here.
- Residual: the vault stores tokens as 0600 plaintext JSON. The official
  app's at-rest codec key is host/Electron-derived and unavailable to an
  out-of-process plugin, so OS-keychain integration is not attempted.

## Upstream discriminator audit (2026-09-16)

Goal: nothing the provider emits should gratuitously identify OpenFork as a
third-party reverse proxy. Changed at the plugin boundary (new
`workbuddy-identity.ts` resolves the installed app/CLI first):

- **User-Agent**: replaced the self-branded `codebuddy2openai/2.0` with the
  official composition `WorkBuddy/<app> WorkBuddy AI/<app> CLI/<cli>`
  (`UserAgentHttpInterceptor.buildUserAgent`), resolved from
  `resources/install-manifest.json` + `cli/package.json`. Verified live: the
  `/v3/config` UA gate still returns the full catalog, and chat still streams
  HTTP 200 on healthy accounts.
- **Static application headers**: `X-Product: SaaS`,
  `X-IDE-Type/Name: WorkBuddy`, `X-IDE-Version: <appVersion>`.
- **Conversation lifecycle** every official model request carries:
  `X-Conversation-ID` (stable per account+session), `X-Conversation-Request-ID`,
  `X-Conversation-Message-ID`, `X-Request-ID`, `X-Agent-Intent: craft`,
  `X-Agent-Type: main`; refresh/billing also carry `X-Request-ID`/`X-Trace-ID`.
- **Anomalies removed**: empty `X-User-Id`/`X-Enterprise-Id`/`X-Tenant-Id`
  headers are omitted like the official client; GETs no longer send
  `Content-Type`; `Accept` matches the axios-style default; OAuth login calls
  and the quota/billing adapter now use the same identity.
- **Footprint**: the `auth_forbidden` probe interval rose 15 min → 1 h
  (`WORKBUDDY_FORBIDDEN_COOLDOWN_MS`) so restricted accounts are not hammered
  with rejected requests.
- **Also fixed**: HTTP 429 with code 14018 ("Credits exhausted") is now
  classified as `quota_balance_exhausted` instead of a transient cooldown.

Deliberately NOT done: forging per-device attestation (Qimei36, machineId,
`X-Private-Data`) or synthesising first-party telemetry — that is
circumventing enforcement, not removing fingerprints.

#### Second pass — full ASAR verification (same day)

Sources re-read: `cli/dist/codebuddy.js` (native model path, interceptors,
OpenAI SDK vendored code) and `main/application-manifest.js` (desktop
`httpService`, `AuthService`).

- The native model path goes through the CLI's **axios** stack
  (`maxBodyLength`/`maxContentLength` config, `delete authorization`/`user-agent`
  then interceptor re-add), **not** the Stainless OpenAI SDK. The SDK path
  exists only for custom/local models and explicitly **strips** `x-stainless-*`
  and internal headers when `CODEBUDDY_SKIP_INTERNAL_HEADERS` is set — so
  adding Stainless headers would have been wrong.
- `CommonHeaderHttpInterceptor` is authoritative for trace identity: it always
  sets `X-Request-ID` (32 hex, falling back to `X-Trace-ID` when a trace
  context exists) and sets `proxy = false` on every call. We now send only
  `X-Request-ID` and route gateway hosts around environment proxies via
  `no_proxy` (matching `proxy = false`; also keeps egress IPs consistent).
- `X-Product` differs per subsystem in the official app: model/REST calls use
  `deploymentType ?? "SaaS"` (CLI interceptor) while desktop activity calls
  hard-code `"WorkBuddy"`. Chat keeps `SaaS` (the CLI value the model path
  uses).
- Desktop billing/account calls use a separate `httpService` whose defaults
  are `Accept: application/json` + `Accept-Language` (user locale). The quota
  adapter now matches, and stamps the shared `X-Request-ID`.
- `X-Session-ID` and `X-Product-Version` constants exist but are never set on
  model requests, so we don't send them either. `traceparent`/`tracestate`
  appear only inside the OTel internals, not on REST calls.
- Final wire capture through the production proxy shows exactly: `accept`,
  `accept-encoding`, `authorization`, `connection`, `content-type`,
  `user-agent` (official composition), `x-agent-intent`, `x-agent-type`,
  `x-conversation-id/-request-id/-message-id`, `x-domain`, `x-ide-*`,
  `x-product`, `x-request-id`, `x-user-id` — no self-branding, no empty
  identity headers, no fabricated trace id. Real gateway: healthy account 200
  SSE, restricted account 403 `account_forbidden` with the 1 h probe window.

Known remaining ambiguity: `accept-encoding` is the host runtime's default
(`gzip, deflate, br, zstd`) rather than axios's list; billing runs against a
desktop-called endpoint whose exact UA cannot be captured without
MITM-ing the Electron app, so it uses the same first-party UA as everything
else.

Residual signals that cannot be fixed in this codebase: host TLS/HTTP
fingerprint (Bun/undici HTTP/1.1 vs Electron Chromium), absence of device
attestation and client telemetry, tool-schema/system-prompt content
differences, and behavioural patterns (many accounts from one machine/IP,
free-model usage, bursty agent loops). Closing those would require either a
native client stack or not using the integration this way.
