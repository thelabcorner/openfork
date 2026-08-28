# Handoff — opencode mobile PWA work

This session's Claude subagents are gone (their transcripts are not accessible to a new
session). Everything a new session needs is written out manually below — verified by me
reading the actual files on disk, not just trusting agent self-reports.

## IMPORTANT: this repo has a LOT of unrelated in-flight changes right now

`git status` shows modifications across `packages/app`, `packages/opencode`,
`packages/desktop`, `packages/ui`, `packages/core`, etc. that are **NOT** from this
session's work — they're from other concurrent processes/agents also working in this
same shared working tree. Do not assume any file outside the list below relates to the
work described here. Only trust this document for: `packages/mobile/**` (new,
untracked), `packages/core/src/push.ts`, `packages/core/src/push/`,
`packages/core/src/database/migration/20260826190148_push_notifications.ts`,
`packages/server/src/handlers/push.ts`, `packages/protocol/src/groups/push.ts`, and the
small diffs to `packages/server/src/handlers.ts`, `packages/server/src/routes.ts`,
`packages/protocol/src/api.ts` (2 lines each — route registration), plus SDK codegen
output in `packages/sdk/js/src/v2/gen/*.gen.ts`.

## What this session actually did (chronological)

### 1. Mobile PWA overhaul (all verified complete, typechecked, built, visually confirmed)
- Tool-call row height bug fixed (`ToolCallRow.tsx`/`styles.css`) — Kobalte
  `AccordionHeader` margin-collapse trap.
- Reasoning/tool double-indentation fixed (`MessageBlock.tsx`) — `.msg-block` →
  `.segment-block` class swap.
- Full markdown/LaTeX/syntax-highlighting pipeline added under
  `packages/mobile/src/markdown/` (`parser.ts`, `stream.ts`, `sanitize.ts`,
  `highlight.ts`, `index.ts`) + `components/Markdown.tsx`, wired into `MessageBlock.tsx`.
  Ported from `packages/ui`/`packages/session-ui`'s marked+katex+shiki+dompurify+remend
  stack, minus the desktop's Web Worker offload (main-thread + block-projection caching
  only — a deliberate, communicated scope reduction). Fixed one real bug found during
  verification: `highlight.ts`'s shiki language allowlist only recognized full grammar
  names, so `\`\`\`ts`/`\`\`\`js`/`\`\`\`py`/`\`\`\`sh` fences fell back to unhighlighted
  — added an alias map.
- Message-timeline virtualization: `components/VirtualList.tsx` extended with real
  height measurement (`ResizeObserver` + scroll-anchoring) via an optional `getKey` prop,
  backward-compatible with `SessionsView.tsx`'s existing usage. Wired into `ChatView.tsx`.
- `ModelPicker.tsx` fully overhauled per explicit user request ("nothing like
  dialog-select-model.tsx") — two-pane layout: a Kobalte `RadioGroup`-based (from
  `@opencode-ai/ui/radio-group`, built on `@kobalte/core/segmented-control`) vertical
  provider rail on the left, grouped/favorites model list on the right, capability
  icons, Free/New/status tags, styled entirely with mobile's existing CSS-variable
  system. Verified live via the `?mock` dev harness. **This file has continued evolving
  from a separate concurrent process since** (added `modelPreferences.ts` for
  provider-rail drag-order persistence) — expected, not a conflict, don't touch unless
  asked.

### 2. Question/permission answering bug fix — COMPLETE, typechecked clean
User reported the "question" tool doesn't let them answer from the phone, and asked to
confirm permission requests work + fix auto-accept interactions. Root cause found and
fixed:
- **Root cause**: `packages/core/src/tool/question.ts`'s question tool gates itself
  behind `permission.assert({action: "question", resources: ["*"]})` BEFORE it asks the
  real question. `PermissionPrompt.tsx` rendered that gate with a generic terminal-icon
  "Resources: *" block, indistinguishable from a scary bash prompt — that's why
  answering questions from the phone read as broken.
- **Fix applied**: `packages/mobile/src/components/PermissionPrompt.tsx` now
  special-cases `action === "question"` with a friendly title/icon and skips the
  misleading resources block. Added inline error UI (`.prompt-error` in `styles.css`) to
  both `PermissionPrompt.tsx` and `QuestionPrompt.tsx` instead of silently swallowing
  failed replies (previously a failed reply just... did nothing visible). Fixed an
  auto-accept status-flash race in `app.tsx`'s `handleServerEvent` (session no longer
  briefly shows "waiting on permission" for a session that's about to auto-resolve).
  `ChatView.tsx` sheet-closing logic changed to close only once the underlying list
  actually drains (i.e. reply succeeded), so a failed reply keeps the sheet open with
  the error visible for retry.
- **Verification done**: `bun run --cwd packages/mobile typecheck` passed on these
  files at the time. **NOT done**: a live `?mock` visual pass (blocked at the time by
  concurrent edits from the push-notification work below) and a full package build
  (blocked by the push-notification work being mid-flight in the same package at the
  time — should be re-run now that more of that work exists on disk).

### 3. Full server-side Web Push — PARTIALLY COMPLETE, NOT FINISHED, NOT VERIFIED
User explicitly chose "Full server-side Web Push" (over client-only Notifications API)
via AskUserQuestion — i.e., notifications must work even when the PWA is fully
closed/killed, which requires server-side VAPID + subscription storage + a `web-push`
sender wired to session events, not just client JS.

Confirmed present on disk (I read these files directly, this is real, not a summary):
- `packages/core/src/push.ts` (332 lines) — `PushV2` service. Uses `web-push` npm
  package, `PushSubscription` schema from `@opencode-ai/schema/push-subscription`,
  reads/writes `PushSubscriptionTable`/`PushVapidKeyTable` via `packages/core/src/push/sql.ts`
  and `Database` service (Drizzle-based — this is the persistence pattern it used).
  VAPID subject hardcoded to `mailto:push@opencode.ai`, VAPID key row ID `"default"`.
  Defines a `PushNotificationPayload` interface matching the Declarative-Web-Push
  envelope shape (`title`, `body`, `navigate`, `icon`, `badge`, `tag`, `silent`,
  `appBadge`) — matches the research doc's recommended schema.
- `packages/core/src/database/migration/20260826190148_push_notifications.ts` — new DB
  migration for the subscription/VAPID-key tables.
- `packages/protocol/src/groups/push.ts` — new HttpApi group defining
  `push.publicKey.get` (`GET /api/push/public-key`), `push.subscription.create`, and
  `push.subscription.delete` (unsubscribe by endpoint) endpoints.
- `packages/server/src/handlers/push.ts` — the handler group implementation for the
  above three endpoints (confirmed the three `handle("push.X", ...)` calls exist).
- `packages/server/src/handlers.ts`, `packages/server/src/routes.ts`,
  `packages/protocol/src/api.ts` — each has a small 2-line diff registering the new
  push group (route wiring is in place).
- `packages/sdk/js/src/v2/gen/sdk.gen.ts` has a `class Push extends HeyApiClient` —
  **codegen was run and the SDK now exposes push methods.**
- `packages/mobile/src/push.ts` and `packages/mobile/src/components/NotificationSettingsSheet.tsx`
  exist (client-side subscription service + settings sheet).
- `packages/mobile/public/sw.js` — real `push` event handler added, rendering the
  Declarative-Web-Push-compatible payload via `showNotification()`, with a fallback for
  malformed/missing payload data. (I did not confirm whether `notificationclick` was
  also added — check `sw.js` past line 40.)
- `packages/mobile/src/views/ChatView.tsx` — already wired with a `client:
  OpencodeClient` prop and imports `NotificationSettingsSheet`, with a new `"notifications"`
  sheet type and an `IconBell` import — the settings sheet is at least partially wired
  into the UI.

**Confirmed NOT yet done** (I grepped for it, found nothing):
- **The debounce-and-recheck requirement is MISSING.** I sent this as a mid-flight
  follow-up to the implementing agent (via `SendMessage`, not a fresh agent) — the
  requirement: never send a "permission requested" push for a permission that's about
  to be auto-approved by mobile's client-local `autoAcceptSessions` toggle. Since that
  toggle is client-only (not synced to the server), the fix must be: on
  `permission.v2.asked` / `question.v2.asked`, wait ~600-900ms, re-check whether the
  request is still pending, and only send if it is. **`grep -n "debounce" packages/core/src/push.ts`
  found nothing** — this was not implemented before the agent stopped. This is the
  single most important remaining piece of work.
- Unknown/unverified: whether the event-bus wiring in `push.ts` actually subscribes to
  `EventV2.Service` and sends on `permission.v2.asked`/`question.v2.asked`/session-idle/
  session-failed (the file is 332 lines: I read the header/imports but not the full
  body — a new session should read the whole file before continuing).
- Unknown/unverified: 404/410 subscription-retirement logic, TTL/Urgency/Topic header
  usage, whether `packages/server` and `packages/mobile` currently typecheck/build at
  all with all this in place — **none of this was verified this session**, the agent
  was interrupted (status: "stopped", not "completed" — likely killed when the previous
  process exited, or hit an error) before it could report back or before I could verify.
- Unknown: whether `packages/mobile/public/manifest.webmanifest`'s empty `"icons": []`
  was ever addressed (the research doc flags this as a real gap for iOS install UX; no
  icon assets exist in the repo as far as I found).

## What to do next, in order

1. `git diff packages/core/src/push.ts packages/core/src/push/ packages/server/src/handlers/push.ts packages/mobile/src/push.ts packages/mobile/src/components/NotificationSettingsSheet.tsx packages/mobile/public/sw.js` (or just read the full files — `push.ts` is untracked/new so `git diff` may show it as an add, use `git status` first) to get the complete current implementation.
2. Read all of `packages/core/src/push.ts` (only the first ~40 lines were read this
   session) to determine exactly what event-sending logic exists and confirm/implement
   the debounce-and-recheck fix described above.
3. Run `bun run --cwd packages/server typecheck` (check `packages/server/package.json`
   for the exact script name if this fails), `bun run --cwd packages/core typecheck`,
   `bun run --cwd packages/mobile typecheck`, `bun run --cwd packages/mobile build`.
   Fix whatever breaks.
4. Live-verify via the `?mock` dev harness (pattern used successfully earlier this
   session: `bun run --cwd packages/mobile dev --port <N>` in background, then
   `mcp__t3-code__preview_navigate` with `{kind:"environment-port", port:<N>,
   path:"/?mock"}`, then `mcp__t3-code__preview_evaluate` running
   `document.querySelector(...)` checks — `preview_snapshot` screenshots were flaky
   earlier this session, `preview_evaluate` DOM inspection worked reliably instead):
   - `NotificationSettingsSheet` renders and its capability-state logic looks sane.
   - `PermissionPrompt`'s `action === "question"` special-case renders correctly.
   - `QuestionPrompt`'s inline error state.
   - No regressions in `ModelPicker.tsx` (owned by a separate concurrent process — don't
     edit it, just don't break it).
5. Confirm the manifest icons gap with the user rather than inventing placeholder binary
   icon files.
6. Do not commit/push anything without the user's explicit go-ahead.

## Reference material
- Research doc consulted for the Web Push architecture:
  `C:\Users\slooshied\Downloads\pwa-push-notifications-research-2026.md` (Declarative
  Web Push payload schema, VAPID, TTL/Urgency/Topic, 404/410 subscription cleanup — the
  send-side implementation should match this closely).
- Mobile connects **directly** to a user's opencode server over SSE — no backend of its
  own — which is why Web Push required touching `packages/server`/`packages/core`
  rather than being mobile-only (confirmed via `packages/mobile/src/app.tsx`'s
  `runEventLoop`/`handleServerEvent`, direct `createOpencodeClient` usage).
- Server uses Effect-TS + `HttpApiBuilder.group(Api, "server.X", ...)` — see
  `packages/server/src/handlers/event.ts` (the `EventV2.Service` pub/sub bus) and
  `permission.ts`/`question.ts` for the pattern a new handler group follows.
- Confirmed event type strings: `"permission.v2.asked"`, `"question.v2.asked"` (from
  `packages/schema/src/permission.ts` / `question.ts`).
