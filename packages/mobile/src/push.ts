import { createSignal } from "solid-js"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

export type PushState =
  | "unsupported"
  | "needs-install"
  | "permission-default"
  | "permission-denied"
  | "permission-granted-unsubscribed"
  | "subscribed"

const [state, setState] = createSignal<PushState>("unsupported")
export const pushState = state

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function isAppleMobile() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
}

function supportsClassicWebPush() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

function statusOf(error: unknown): number | undefined {
  const cause = error instanceof Error ? (error.cause as { status?: number } | undefined) : undefined
  return cause?.status
}

function describeEnableError(error: unknown): string {
  const status = statusOf(error)
  if (status === 404 || status === 405) return "not-found"
  if (status === 401 || status === 403) return "unauthorized"
  if (!window.isSecureContext) return "insecure"
  if (error instanceof DOMException) return error.name === "NotAllowedError" ? "denied" : error.message
  if (error instanceof Error && error.message) return error.message
  return "unknown"
}

function base64UrlToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

/** Re-derives the current capability/permission/subscription state. Cheap and
 * side-effect-free (besides reading `pushManager.getSubscription()`), so it's
 * safe to call on every app launch to reconcile drift (permission revoked,
 * site data cleared, browser refreshed the subscription, etc). */
export async function refreshPushState(): Promise<PushState> {
  if (isAppleMobile() && !isStandalone()) return set("needs-install")
  if (!supportsClassicWebPush()) return set("unsupported")
  if (Notification.permission === "denied") return set("permission-denied")
  if (Notification.permission === "default") return set("permission-default")
  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    return set(subscription ? "subscribed" : "permission-granted-unsubscribed")
  } catch {
    return set("permission-granted-unsubscribed")
  }
}

function set(next: PushState) {
  setState(next)
  return next
}

/** Requests permission (must be called from a user gesture) and, if granted,
 * subscribes with the server's VAPID public key and registers the
 * subscription with the server. Never called automatically on load. */
export async function enableNotifications(client: OpencodeClient): Promise<{ ok: boolean; reason?: string }> {
  if (!supportsClassicWebPush()) return { ok: false, reason: "unsupported" }
  if (!window.isSecureContext) return { ok: false, reason: "insecure" }
  if (Notification.permission === "denied") return { ok: false, reason: "denied" }

  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission()
  if (permission !== "granted") {
    await refreshPushState()
    return { ok: false, reason: permission === "denied" ? "denied" : "dismissed" }
  }

  try {
    const keyResponse = await client.v2.push.publicKey.get({ throwOnError: true })
    const publicKey = keyResponse.data?.data.publicKey ?? (keyResponse.data as { publicKey?: string } | undefined)?.publicKey
    if (!publicKey) return { ok: false, reason: "no-public-key" }

    const registration = await navigator.serviceWorker.ready
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(publicKey),
      })
    }

    const json = subscription.toJSON()
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return { ok: false, reason: "invalid-subscription" }

    await client.v2.push.subscription.create(
      {
        pushSubscriptionSubscribeInput: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          expirationTime: subscription.expirationTime ?? undefined,
          userAgentHint: navigator.userAgent.slice(0, 128),
        },
      },
      { throwOnError: true },
    )
  } catch (error) {
    console.error("enableNotifications failed", error)
    return { ok: false, reason: describeEnableError(error) }
  }

  await refreshPushState()
  return { ok: true }
}

/** Unsubscribes locally and tells the server to retire the subscription. */
export async function disableNotifications(client: OpencodeClient): Promise<void> {
  if (!supportsClassicWebPush()) return
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (subscription) {
    const endpoint = subscription.endpoint
    await subscription.unsubscribe()
    try {
      await client.v2.push.subscription.delete({ endpoint })
    } catch {
      // Best-effort: the local unsubscribe already took effect.
    }
  }
  await refreshPushState()
}

/** Reconciles the server's copy of the current subscription (e.g. after the
 * browser silently refreshed it) without prompting for anything. Safe to call
 * on every app launch when already subscribed. */
export async function reconcilePushSubscription(client: OpencodeClient): Promise<void> {
  if (!supportsClassicWebPush()) return
  if (Notification.permission !== "granted") return
  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return
    const json = subscription.toJSON()
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return
    await client.v2.push.subscription.create({
      pushSubscriptionSubscribeInput: {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        expirationTime: subscription.expirationTime ?? undefined,
        userAgentHint: navigator.userAgent.slice(0, 128),
      },
    })
  } catch {
    // Non-fatal — the next enable/refresh cycle will retry.
  }
}
