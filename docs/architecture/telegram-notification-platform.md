# Telegram notification platform

Status: implemented behind OpenFork's existing local server; **user opt-in**. Quota resets are the first notification source. This is intentionally a generic notification delivery integration, not a standalone quota bot.

## Ownership

| Layer | Owner | Responsibilities |
| --- | --- | --- |
| Telegram transport | `packages/opencode/src/notification/telegram/transport.ts` | Verify a Bot API token, fetch pairing updates, send text, apply per-call timeouts and response bounds |
| Telegram notification hub | `packages/opencode/src/notification/telegram/hub.ts` | Bot/chat identity, master opt-in, a single shared scheduler, delivery receipts, rate limits, error status, destination lifecycle |
| Service registry/composition | `packages/opencode/src/notification/telegram/index.ts` | Register sources under stable IDs; expose a process-global Effect service |
| Quota notification source | `packages/opencode/src/notification/telegram/quota-source.ts` | Quota subscriptions, baseline retention, reset verification, scheduled estimate reminders |
| Quota policy and agenda | `packages/opencode/src/quota/{telegram-reset-policy,resets,quota}.ts` | Account/model/window identity, provider reset evidence and pure verification |
| API | `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/telegram.ts` | Tier-0 settings and service configuration; never construct a workspace Instance |
| Settings | `packages/app/src/components/settings-v2/telegram.tsx` | Global Telegram tab, connection lifecycle, Quota reset service controls, per-account/window selection |

Future sources should be registered through the `NotificationSource` contract. They must **not** create another bot, webhook, polling connection, Telegram token file, chat pairing, or delivery deduplication system.

## Public local routes (authenticated)

| Method | Endpoint | Responsibility |
| --- | --- | --- |
| GET | `/global/telegram` | Sanitized hub configuration and registered source catalog |
| PATCH | `/global/telegram` | Master notification enablement |
| POST | `/global/telegram/bot` | Validate and replace bot token; clears existing chat association |
| DELETE | `/global/telegram/bot` | Disconnect and remove all source subscriptions |
| POST | `/global/telegram/pairing` | Begin one-time private chat pairing, creating a short-lived Telegram deep link |
| POST | `/global/telegram/pairing/check` | Explicit, bounded polling for the exact `/start <nonce>` message |
| POST | `/global/telegram/test` | Send one test notification to paired private chat |
| GET | `/global/telegram/services/quota` | Quota-specific preferences |
| PATCH | `/global/telegram/services/quota` | Quota-specific enablement and subscriptions |

Bot tokens never appear in status responses. The existing `Auth` file store holds credentials; its access controls are **not equivalent to encrypted OS-keychain storage**. Future desktop hardware-backed storage can replace that adapter without changing service semantics.

## Notification-source contract

The generic `NotificationSource` interface requires:

- `id`: stable unique source identifier, e.g. `quota`
- `title`: presentation label
- `initialize()`: load durable source-specific state
- `active()`: whether a source has subscriptions requiring monitoring
- `collect(now)`: bounded promise yielding `{ id, text }` notification intents
- `acknowledge(id)`: optional source-level cursor advancement after the generic hub claims a delivery
- `nextPollDelayMs(now)`: optional suggested next shared scan
- `clear()`: revoke source configuration on global disconnect

The generic hub alone determines the destination, claims the delivery receipt **before** outbound POST, and invokes the Bot API. The source neither knows a chat ID nor receives the bot token.

Because the Bot API `sendMessage` does not expose an idempotency key, the hub prioritizes **at-most-once** after an ambiguous network timeout. That can drop a message if Telegram never accepted it. A positively rejected HTTP 429 is safe to retry after its server-specified cooldown. Do not describe this design as exactly-once delivery.

## Quota semantics

Each subscription is identified by `[providerId, scope, accountId, model, windowKey]` rather than display labels. Different account IDs sharing the same label must remain separate. A notification candidate requires an observed **pre-deadline** baseline, so activating a subscription after a reset cannot fabricate a retrospective alert.

**Fixed-deadline** provider-authenticated sources require a fresh **post-deadline** observation of the *same account/model/window* whose next reset deadline has advanced. Messages say **quota reset confirmed** only for these fixed windows.

**OpenCode Go `5h` is a rolling window** (`usage.rolling`), not a fixed reset. Its `resetsAt` can advance without any change in utilization, so it is **never** used to trigger alerts. Pre-upgrade 5h deadline alerts are purged on startup/collection. OpenCode Go reports percentage **used**; the notification policy measures `remaining = 100 - used`, and reports an actual **≥1 percentage-point increase in remaining capacity** (including 98% → 99%), without requiring the quota ever to have been exhausted. Sub-point changes accumulate from a durable low-water mark. A cached/stale/non-authoritative first reading, re-poll at the same provider observation timestamp, an unchanged 100% reading, or a later reset estimate alone cannot trigger anything. Each exact account/window has a durable **60-minute cooldown**, and improvements while cooling down are consumed rather than queued into an alert when nothing changed. Every notification calls the event **rolling quota capacity increased**, not *quota reset confirmed*. Gaps of more than 20 minutes between fresh observations reseed the baseline rather than backfilling an uncertain change; disabling/re-enabling the service likewise starts with a new baseline. Old exhaustion-only pending notifications are dropped during migration; new delivery receipts and baseline values survive restart.

Inferred, observed, or locally estimated sources instead produce a message explicitly saying **expected quota reset time reached (unverified)** at their reported deadline. This is a calendar reminder, not a statement that account capacity has replenished. In particular, WorkBuddy package expiry is not proof of credit replenishment.

The hub defaults to a 30-minute rescan maximum and sources can request a sooner shared wakeup near an upcoming deadline. The quota plugin requests repeat checks at 5-minute intervals for overdue unresolved fixed resets; when a rolling Go 5h window is selected it requests a scan every **5 minutes + 2 seconds**, bounded by the Go official endpoint’s existing 5-minute single-flight cache. The hub has **no per-account timer**, and each quota polling cycle fetches **only selected providers** (with bounded four-way concurrency), so enabling Go 5h alerts does not poll unrelated accounts/providers. A disabled hub has no outbound Telegram or provider polling.

## Threat model and operational limits

1. Pairing requires a random 192-bit nonce from the private chat's exact `/start` message; group chats are rejected. The link expires after five minutes and never uses a public inbound webhook.
2. Never log the token-bearing Telegram API URL, raw exception strings from fetch, or the token entered in Settings.
3. Telegram's `getUpdates` cannot be used when another webhook is configured for the same bot. Do not destroy an existing webhook without an explicit user choice. A dedicated bot for OpenFork avoids this conflict.
4. A single process-owner file prevents ordinary duplicate schedulers. This is *not* yet a proven distributed lease across adversarial simultaneous process startups or PID reuse. A database-backed lease with fencing is the correct hardening for hosted multi-process deployments.
5. Credentials and notification data are user data; Telegram chats are not end-to-end encrypted.
6. Do not attach global settings to `InstanceContextMiddleware`; doing so could initialize plugins, tools and workspaces simply from opening Settings.
7. Source-specific notifications should remain optional. Future registration does not authorize enabling them automatically.

## Adding another service

Implement `NotificationSource` in a separate module with an immutable unique `id`, durable source-specific settings, bounded collection semantics and tests. Register exactly one source instance in `notification/telegram/index.ts`, expose its own `/global/telegram/services/<id>` endpoints and add a settings subsection. It must not depend on quota types, quota provider adapters, or Telegram Bot API calls.

Candidate extensions: session-completion alerts, queued permission requests, failed scheduled tasks, goal milestone notifications, OXP connection health and release build statuses. These are **ideas**, not currently implemented notification sources.

## Setup in OpenFork

1. Open **Settings → Telegram**.
2. Create a Telegram bot through **@BotFather** and paste its Bot API token into the masked field. **Verify bot** calls Telegram `getMe`, then stores the token only on the OpenFork server.
3. Click **Generate pairing link**, open it in Telegram, and press **Start**. Pairing accepts only the private chat that sends the exact one-time `/start` code.
4. Use **Send test** to confirm that this private chat accepts a message.
5. Enable the **Quota resets** service, discover current quota windows, and select individual provider/account/window switches. Then enable the **Telegram notifications** master switch.
6. Keep the OpenFork server/desktop sidecar running when you want delivery. No external hosted relay is provided.

A dedicated bot avoids interfering with existing bots or webhooks. No Telegram token is baked into the distribution.

## Verification

Focused checks:

- Telegram API validation, private-chat nonce pairing, bounded response size and bearer-token redaction
- Hub disabled-state zero polling/network, duplicate source registration, restarted at-most-once delivery
- Quota reset policy stable account/window isolation, authoritative fixed-window confirmation and no false post-start backfill
- OpenCode Go rolling 5h regression: moving expiry alone cannot notify; 98% → 99% remaining notifies once; 100%-flat for 24 hours stays silent; cumulative sub-point increases count; state/cooldowns survive restart; old pending exhaustion alerts are discarded
- Quota source suspended asynchronous scans, scheduled unverified reminders and source-level acknowledgment
- Settings presentation selection projection and route normalization
- Typechecking the Settings frontend

The OpenAPI spec was regenerated and verified to publish all seven paths. The first-party SDK was regenerated and typechecked, and the Settings app typechecked successfully. Focused HTTP handler tests exercise the generic channel separately from Quota and workspace Instances. The overall backend package still has unrelated existing TypeScript errors, so its full package typecheck is not green.

Before production certification: verify live delivery with a configured Telegram bot, run an assembled authenticated sidecar smoke test, and stress multiple sidecars contending over the notification owner lease. For hosted multi-process deployments, replace the PID file with a genuinely fenced lease and transactional outbox.
