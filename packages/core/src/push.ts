export * as PushV2 from "./push"

import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import webpush from "web-push"
import { PushSubscription } from "@opencode-ai/schema/push-subscription"
import { PermissionV2 } from "./permission"
import { QuestionV2 } from "./question"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { PushSubscriptionTable, PushVapidKeyTable } from "./push/sql"

export const ID = PushSubscription.ID
export type ID = typeof ID.Type

export const Info = PushSubscription.Info
export type Info = typeof Info.Type

export const SubscribeInput = PushSubscription.SubscribeInput
export type SubscribeInput = typeof SubscribeInput.Type

const VAPID_ROW_ID = "default"
const VAPID_SUBJECT = "mailto:push@opencode.ai"

/** Declarative-Web-Push-compatible envelope (RFC-8030 marker `web_push: 8030`).
 * The classic service-worker fallback renders the exact same shape, so a
 * single payload works on both paths. */
export interface PushNotificationPayload {
  readonly title: string
  readonly body?: string
  readonly navigate: string
  readonly icon?: string
  readonly badge?: string
  readonly tag?: string
  readonly silent?: boolean
  readonly appBadge?: string
  readonly data?: Record<string, unknown>
}

function envelope(notification: PushNotificationPayload) {
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: notification.title,
      body: notification.body,
      navigate: notification.navigate,
      icon: notification.icon ?? "/icons/icon-192.png",
      badge: notification.badge ?? "/icons/badge-96.png",
      tag: notification.tag,
      silent: notification.silent ?? false,
      app_badge: notification.appBadge,
      timestamp: Date.now(),
      data: notification.data,
    },
  })
}

export interface SendOptions {
  readonly ttl: number
  readonly urgency: "very-low" | "low" | "normal" | "high"
  /** Web Push Topic header (<=32 url-safe chars) — coalesces outstanding
   * messages for the same subscription so a flaky connection doesn't get
   * spammed by e.g. repeated "still generating" pushes for one session. */
  readonly topic?: string
}

export interface Interface {
  /** VAPID public key, safe to expose to any client for `PushManager.subscribe()`. */
  readonly publicKey: () => Effect.Effect<string>
  readonly subscribe: (input: SubscribeInput) => Effect.Effect<Info>
  readonly unsubscribe: (id: ID) => Effect.Effect<void>
  readonly unsubscribeByEndpoint: (endpoint: string) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Info>>
  /** Sends a notification to every live subscription; retires 404/410s. */
  readonly notifyAll: (notification: PushNotificationPayload, options: SendOptions) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/PushV2") {}

function hashEndpoint(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const vapidRow = yield* db
      .select()
      .from(PushVapidKeyTable)
      .where(eq(PushVapidKeyTable.id, VAPID_ROW_ID))
      .get()
      .pipe(Effect.orDie)

    const vapid = vapidRow
      ? { publicKey: vapidRow.public_key, privateKey: vapidRow.private_key }
      : yield* Effect.gen(function* () {
          // Generated once and persisted server-side. Never shipped to a
          // client — only the public key is exposed via the API.
          const generated = webpush.generateVAPIDKeys()
          yield* db
            .insert(PushVapidKeyTable)
            .values({
              id: VAPID_ROW_ID,
              public_key: generated.publicKey,
              private_key: generated.privateKey,
              created_at: Date.now(),
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          return { publicKey: generated.publicKey, privateKey: generated.privateKey }
        })

    webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey)
    const events = yield* EventV2.Service

    const info = (row: typeof PushSubscriptionTable.$inferSelect): Info => ({
      id: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      userAgentHint: row.user_agent_hint ?? undefined,
    })

    const list = Effect.fn("PushV2.list")(function* () {
      const rows = yield* db.select().from(PushSubscriptionTable).all().pipe(Effect.orDie)
      return rows.map(info)
    })

    const subscribe = Effect.fn("PushV2.subscribe")(function* (input: SubscribeInput) {
      const now = Date.now()
      const existing = yield* db
        .select()
        .from(PushSubscriptionTable)
        .where(eq(PushSubscriptionTable.endpoint, input.endpoint))
        .get()
        .pipe(Effect.orDie)
      const row = {
        id: existing?.id ?? ID.create(),
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        expiration_time: input.expirationTime ?? null,
        user_agent_hint: input.userAgentHint ?? null,
        created_at: existing?.created_at ?? now,
        last_seen_at: now,
      }
      yield* db
        .insert(PushSubscriptionTable)
        .values([row])
        .onConflictDoUpdate({
          target: PushSubscriptionTable.endpoint,
          set: {
            p256dh: row.p256dh,
            auth: row.auth,
            expiration_time: row.expiration_time,
            user_agent_hint: row.user_agent_hint,
            last_seen_at: row.last_seen_at,
          },
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.logInfo("Push subscription registered", { endpointHash: hashEndpoint(input.endpoint) })
      return info(row)
    })

    const unsubscribe = Effect.fn("PushV2.unsubscribe")(function* (id: ID) {
      yield* db.delete(PushSubscriptionTable).where(eq(PushSubscriptionTable.id, id)).run().pipe(Effect.orDie)
    })

    const unsubscribeByEndpoint = Effect.fn("PushV2.unsubscribeByEndpoint")(function* (endpoint: string) {
      yield* db.delete(PushSubscriptionTable).where(eq(PushSubscriptionTable.endpoint, endpoint)).run().pipe(Effect.orDie)
      yield* Effect.logInfo("Push subscription retired", { endpointHash: hashEndpoint(endpoint) })
    })

    const sendOne = (row: typeof PushSubscriptionTable.$inferSelect, body: string, options: SendOptions) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () =>
            webpush.sendNotification(
              { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
              body,
              {
                TTL: options.ttl,
                urgency: options.urgency,
                topic: options.topic?.slice(0, 32),
              },
            ),
          catch: (error) => ({ ok: false as const, error: error as { statusCode?: number } }),
        }).pipe(
          Effect.map(() => ({ ok: true as const, error: undefined })),
          Effect.catch((failure) => Effect.succeed(failure)),
        )
        if (result.ok) return
        const error = result.error!
        // 404/410: the push service says this endpoint is gone — retire it
        // immediately rather than retry-looping a dead subscription.
        if (error.statusCode === 404 || error.statusCode === 410) {
          yield* unsubscribeByEndpoint(row.endpoint)
          return
        }
        // 429: single-tenant/low-volume server — no retry queue, just skip
        // (Retry-After is informational only here).
        if (error.statusCode === 429) {
          yield* Effect.logWarning("Push send rate limited", { endpointHash: hashEndpoint(row.endpoint) })
          return
        }
        yield* Effect.logWarning("Push send failed", {
          endpointHash: hashEndpoint(row.endpoint),
          statusCode: error.statusCode,
          message: "message" in error ? String(error.message) : String(error),
        })
      })

    const notifyAll = Effect.fn("PushV2.notifyAll")(function* (
      notification: PushNotificationPayload,
      options: SendOptions,
    ) {
      const rows = yield* db.select().from(PushSubscriptionTable).all().pipe(Effect.orDie)
      if (rows.length === 0) return
      const body = envelope(notification)
      yield* Effect.forEach(rows, (row) => sendOne(row, body, options), { concurrency: 8, discard: true })
    })

    const service = Service.of({
      publicKey: () => Effect.succeed(vapid.publicKey),
      subscribe,
      unsubscribe,
      unsubscribeByEndpoint,
      list,
      notifyAll,
    })

    // Tracks sessions last seen busy, so an idle transition only notifies
    // when it represents "finished after working" rather than every idle
    // tick (e.g. a session that was never prompted). In-memory only — a
    // server restart just means the next idle after a fresh busy notifies
    // again, which is harmless.
    const busySessions = new Set<string>()
    const push = service

    // Mobile auto-accept is client-local. Wait briefly and skip the push if
    // a matching reply/reject landed first. PermissionV2/QuestionV2 are
    // location-scoped, so this global sender cannot re-query their pending maps.
    const PENDING_RECHECK = "750 millis"
    const settledAt = new Map<string, number>()
    const markSettled = (id: string) => {
      const now = Date.now()
      settledAt.set(id, now)
      if (settledAt.size <= 256) return
      for (const [key, at] of settledAt) {
        if (now - at > 10_000) settledAt.delete(key)
      }
    }
    const notifyIfStillPending = (id: string, notification: PushNotificationPayload, options: SendOptions) =>
      Effect.gen(function* () {
        yield* Effect.sleep(PENDING_RECHECK)
        if (settledAt.delete(id)) return
        yield* push.notifyAll(notification, options)
      })

    yield* events.subscribe(PermissionV2.Event.Replied).pipe(
      Stream.runForEach((event) => Effect.sync(() => markSettled(event.data.requestID))),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* events.subscribe(QuestionV2.Event.Replied).pipe(
      Stream.runForEach((event) => Effect.sync(() => markSettled(event.data.requestID))),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* events.subscribe(QuestionV2.Event.Rejected).pipe(
      Stream.runForEach((event) => Effect.sync(() => markSettled(event.data.requestID))),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* events.subscribe(PermissionV2.Event.Asked).pipe(
      Stream.runForEach((event) =>
        Effect.forkScoped(
          notifyIfStillPending(
            event.data.id,
            {
              title: "Permission requested",
              body: `${event.data.action} needs your approval`,
              navigate: `/session/${event.data.sessionID}`,
              tag: `permission-${event.data.sessionID}`,
              data: { sessionID: event.data.sessionID, kind: "permission" },
            },
            { ttl: 60, urgency: "high", topic: topicFor("permission", event.data.sessionID) },
          ),
        ).pipe(Effect.asVoid),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* events.subscribe(QuestionV2.Event.Asked).pipe(
      Stream.runForEach((event) =>
        Effect.forkScoped(
          notifyIfStillPending(
            event.data.id,
            {
              title: "Question from agent",
              body: event.data.questions[0]?.question,
              navigate: `/session/${event.data.sessionID}`,
              tag: `question-${event.data.sessionID}`,
              data: { sessionID: event.data.sessionID, kind: "question" },
            },
            { ttl: 60, urgency: "high", topic: topicFor("question", event.data.sessionID) },
          ),
        ).pipe(Effect.asVoid),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* events.subscribe(SessionEvent.Step.Failed).pipe(
      Stream.runForEach((event) =>
        push.notifyAll(
          {
            title: "Session failed",
            body: "The agent hit an error and stopped.",
            navigate: `/session/${event.data.sessionID}`,
            tag: `session-failed-${event.data.sessionID}`,
            data: { sessionID: event.data.sessionID, kind: "session-failed" },
          },
          { ttl: 300, urgency: "high", topic: topicFor("session-failed", event.data.sessionID) },
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* events.subscribe(SessionStatusEvent.Status).pipe(
      Stream.runForEach((event) => {
        const sessionID = event.data.sessionID
        if (event.data.status.type === "busy" || event.data.status.type === "retry") {
          busySessions.add(sessionID)
          return Effect.void
        }
        if (event.data.status.type === "idle") {
          if (!busySessions.delete(sessionID)) return Effect.void
          return push.notifyAll(
            {
              title: "Session finished",
              body: "Your agent session is done.",
              navigate: `/session/${sessionID}`,
              tag: `session-done-${sessionID}`,
              data: { sessionID, kind: "session-done" },
            },
            { ttl: 3600, urgency: "normal", topic: topicFor("session-done", sessionID) },
          )
        }
        return Effect.void
      }),
      Effect.forkScoped({ startImmediately: true }),
    )

    return service
  }),
)

function topicFor(kind: string, sessionID: string) {
  return createHash("sha256").update(`${kind}:${sessionID}`).digest("base64url").slice(0, 32)
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node],
})
