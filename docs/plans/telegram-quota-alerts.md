# OpenFork Telegram quota-reset alerts — architecture and acceptance ledger
Status: design / implementation contract (2026-10-10). Runtime claims must be independently tested; this document is not evidence of deployment.

## Product contract
- The sole user-facing configuration surface is a dedicated **Telegram** tab in the existing `settings-v2` Settings navigation (routed and modal), alongside WakaTime/Providers, using existing dense settings rows and design conventions. No required CLI, environment-variable-only setup, extra website, or external daemon.
- User supplies their own Telegram bot from @BotFather. Connecting is an explicit opt-in, and quota delivery is a separate opt-in. Select provider **accounts**, and individual quota windows (5-hour, weekly, monthly, provider-native).
- Offer connection status, reset/deauthorize, bot username, destination chat, test message, per-account/window controls, last notification/errors, and truthful offline limitations. Never show or return saved bot tokens.
- Reuse existing `Quota.Service` and `buildResetAgenda`, including `ForkUsageSnapshot` for OpenCode Go. The calendar is a projection, **not** a scheduler; Telegram must have a narrow, independent process-global delivery owner that does not instantiate workspace sessions.
- No general Telegram chat agent, remote tool execution, arbitrary message relay, group chat binding by default, or webhook listener.

## Facts from the codebase
- `packages/opencode/src/quota/quota.ts` owns adapters and `resetsForProvider` and `resets`; its results are advisory and never gate inference.
- `packages/opencode/src/quota/schema.ts` exposes `ResetOccurrence` {id, providerId, resetAt, observedAt, scope, accountId?, accountLabel?, model?, windows[]}. Some account labels are not stable identifiers.
- `packages/opencode/src/quota/resets.ts` merges overlapping windows into an occurrence. Its `stableID` includes deadline, but **not window keys**; therefore de-duplication must expand occurrence.windows.
- `packages/app/src/pages/scheduled-quota-resets.ts` and `use-quota-reset-agenda.ts` intentionally fetch on demand, with bounded caches. Do not turn these hooks into polling loops.
- The existing Settings tabs and tabs' safe URL navigation are in `packages/app/src/components/settings-v2/navigation.ts` and `dialog-settings-v2.tsx`.
- OpenFork V1 is active; current/V2 APIs are not a required new target. Background ownership must be process-global/Tier 0, not an expensive `InstanceStore` implicit bootstrap.

## External Bot API contract
- Official Telegram Bot API: `https://core.telegram.org/bots/api`. Telegram provides HTTPS `getMe`, `getUpdates`, and `sendMessage`. Webhook and polling are mutually exclusive.
- Preferred pairing: create a CSPRNG 128+ bit nonce, valid for 5 minutes and single use; display `https://t.me/<username>?start=<base64url_nonce>`. Run one narrow `getUpdates` listener only during pairing, `allowed_updates: [\"message\"]`; accept `/start <nonce>` **only in a private chat**; validate nonce, update id, and chat equality, then atomically consume. Ignore all other messages, callbacks, and commands.
- Telegram permits deep-link start tokens up to 64 characters using URL-safe alphabet. A bot token is bearer authority: never put it into logs, URLs shown to the renderer, spans, errors, query strings of a local web page, or serialized status responses.
- Polling other clients using this bot's token may conflict. Do not silently delete an existing webhook or clear pending updates; show an actionable error.
- `sendMessage` should POST JSON with bounded timeout and response-size cap. Handle HTTP errors/Telegram errors, `retry_after` for 429, 401 invalid token, 403 blocked chat. Do not echo raw Telegram URLs (contain token) into logs.
- Default to plain text or safely escaped formatting, no secret content from quota provider responses.

## State and stable identity
Preferred persisted models, stored in user-global scope, not project/session config:
- `telegram_preferences`: enabled, destinationChatId, destinationDisplay, pairingStateHash/expiry, pollOffset, lastCheckedAt, lastDeliveryState, updatedAt.
- Bot token: in existing OS-protected secret storage if possible (Electron safeStorage adapter on desktop), never the settings JSON or quota DB. If OS-protected storage is unavailable, report unconfigured instead of silently persisting plaintext.
- `telegram_subscriptions`: exact provider ID, account ID (or provider-level sentinel), model ID (optional), window key, enabled, createdAt; use stable account keys, never mutable labels as identity. If no stable account ID is available, display a provider-wide subscription, with transparent scope.
- `telegram_deadlines`: per subscription stable deadline, original pre-deadline remaining %, source/confidence, lastObservedAt, lifecycle (upcoming/due/verifying/confirmed/uncertain/skipped), generation revision.
- `telegram_outbox`: unique(event identity + destination), immutable message payload, delivery state, lease owner/expiry, attempts, last error; completed/aborted tombstones retained to suppress repeats across restarts.
- All timestamps epoch UTC ms; user timezone only affects formatting. Upsert selected subscriptions and reset observations atomically; deleting a subscription cancels pending deliveries.

## Correctness policy
- Distinguish **scheduled** reset and **confirmed** replenishment; the calendar's `resetAt` is a claim, not proof. A provider-sourced deadline can schedule a post-deadline refresh, but must never itself automatically produce \"your quota has reset\" without a fresh subsequent observation.
- A post-deadline fetch is fresh only if observed/fetched after the deadline. Confirm only when the same stable provider/account/window shows higher remaining capacity OR the provider advances its native next-reset timestamp consistently with a new period; compare window semantics per adapter. Handle windows with null percentages, rolling windows, and consumption immediately following reset conservatively.
- `observed`, `inferred`, `local`, expiring WorkBuddy packages, and unreliable status snapshots are not guaranteed replenishment. Allow \"expected reset time reached; availability not yet verified\" as a separate explicitly opted-in event if desired; never conflate.
- If a quota is already expired on first enable and no pre-deadline baseline exists, do not backfill a misleading reset notification.
- Expand grouped agenda occurrences into a durable event **per selected window key**. Stable event identity contains provider, account, model, window, original deadline, and Telegram destination; ensure no duplicate for simultaneous provider/account projection.
- Late or missing provider observations => defer/fail with diagnostics; never manufacture next cycles using 5-hour/weekly/monthly labels alone.
- On process startup, recover pending durable state and suppress previous notifications. A new reset deadline replaces only the corresponding selection's pending schedule.
- Exactly-once delivery is impossible to prove using Telegram `sendMessage` alone (no idempotency key). Explicitly choose best-effort **at-most-once** for network-ambiguous replies or at-least-once with possible duplicates; surface the choice in tests/diagnostics. Never promise both no duplicates and guaranteed delivery.
- No I/O on the renderer event loop and no O(N accounts) timers. Keep one timer set to earliest deadline, bounded provider refresh (e.g. at most 4 concurrent, disabled-by-default), backoff, and cancellation. When disabled, there are no quota polling requests and no Telegram network requests.

## Lifecycle / deployment
- Process-global owner starts only on explicit opt-in and shuts down on disable, auth remove, or process shutdown. Exactly one active poller/scheduler per stored profile/sidecar even with several windows and concurrent sessions.
- Single-machine multi-process server ownership requires a bounded durable lease or other audited single-writer facility. SQLite write contention is already a risk; prefer tiny transactions and no global lock held while fetching providers/Telegram.
- The local sidecar must remain running for timer-based notifications; OpenFork cannot deliver while closed/offline unless a separate always-on runtime is explicitly configured. Explain this in Settings and document catch-up behavior after restart.
- Permission boundary: Settings API to accept bot token must be authenticated local-only control (CSRF/origin/remote-access semantics audited). Remote shared browser sessions must not silently gain permission to replace credentials or read private chat identity.
- Never auto-discover and send to arbitrary chats; validate ownership with one-time challenge. Rotation revokes prior polling/pending sessions immediately.

## Minimum API, UI, and test plan
Proposed local API (names illustrative; align with existing first-party route style):
- GET status: sanitized current config, provider/account window metadata, health and last event, but never bot token/nonce hash.
- POST bot setup: validate token via `getMe`; securely persist only after validation and on explicit user request.
- POST pairing begin/status/cancel: nonce and deep link, short-lived `getUpdates`, verified private chat; no permanent inbound listener.
- PATCH subscriptions/master enabled; POST test; DELETE bot/reset. Strict schema, local user auth, bounded input, no token egress.
- Settings dedicated Telegram tab with disabled-by-default toggle; connection wizard; provider/account rows and per-window toggles; last reset/next event and test button; pending and error states; mobile UI support only if backend owner exists.

Verification ledger:
1. Navigation: the tab is present in routed and modal Settings; back/forward retains query selection; no unauthorized deep links.
2. Bot token never appears in GET status, DOM after save, persisted unencrypted config, error strings, traces, test screenshots, or telemetry.
3. Pairing: valid private-chat nonce succeeds once; replay, expired, mismatched, group, concurrent, stray command, and webhook conflict cannot bind.
4. Selection identity stable after account reorder, label rename, duplicate labels, provider reauth, window sorting and alias resolution.
5. Reset logic: pre/post success; stale result; expiring package; rolling window; unavailable provider; two windows sharing timestamp; consumed-during-reset; DST/UTC; clock skew.
6. Delivery: send success, 429 with retry-after, 401, 403, timeouts, crash between claim/send/ack, concurrent processes, repeated startup and disable race.
7. Performance: idle with alerts disabled network 0, timers 0; no measurable renderer main-thread stalls; no workspace startup and minimal SQLite busy pressure.
8. End-to-end: real Telegram account with consent, sidecar alive; exact account/window only; one message verified across app restart.
