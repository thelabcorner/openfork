import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createSignal } from "solid-js"

export type PwaPushState =
  | "unsupported"
  | "needs-install"
  | "permission-default"
  | "permission-denied"
  | "permission-granted-unsubscribed"
  | "subscribed"

const [state, setState] = createSignal<PwaPushState>("unsupported")
export const pwaPushState = state

function set(next: PwaPushState) {
  setState(next)
  return next
}

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
  return error instanceof Error ? (error.cause as { status?: number } | undefined)?.status : undefined
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

async function currentRegistration() {
  if (!("serviceWorker" in navigator)) return undefined
  return navigator.serviceWorker.getRegistration()
}

async function ensureRegistration() {
  if (!("serviceWorker" in navigator)) return undefined
  return (await currentRegistration()) ?? navigator.serviceWorker.register("/sw.js")
}

/** Re-derive browser capability, permission and local subscription state. */
export async function refreshPwaPushState(): Promise<PwaPushState> {
  if (isAppleMobile() && !isStandalone()) return set("needs-install")
  if (!supportsClassicWebPush()) return set("unsupported")
  if (Notification.permission === "denied") return set("permission-denied")
  if (Notification.permission === "default") return set("permission-default")
  try {
    const registration = await currentRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    return set(subscription ? "subscribed" : "permission-granted-unsubscribed")
  } catch {
    return set("permission-granted-unsubscribed")
  }
}

export async function enablePwaPush(client: OpencodeClient): Promise<{ ok: boolean; reason?: string }> {
  if (!supportsClassicWebPush()) return { ok: false, reason: "unsupported" }
  if (!window.isSecureContext) return { ok: false, reason: "insecure" }
  if (Notification.permission === "denied") return { ok: false, reason: "denied" }

  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission()
  if (permission !== "granted") {
    await refreshPwaPushState()
    return { ok: false, reason: permission === "denied" ? "denied" : "dismissed" }
  }

  try {
    const keyResponse = await client.v2.push.publicKey.get({ throwOnError: true })
    const publicKey =
      keyResponse.data?.data.publicKey ?? (keyResponse.data as { publicKey?: string } | undefined)?.publicKey
    if (!publicKey) return { ok: false, reason: "no-public-key" }

    const registration = await ensureRegistration()
    if (!registration) return { ok: false, reason: "unsupported" }
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
    console.error("[pwa] enable push failed", error)
    return { ok: false, reason: describeEnableError(error) }
  }

  await refreshPwaPushState()
  return { ok: true }
}

export async function disablePwaPush(client: OpencodeClient) {
  if (!supportsClassicWebPush()) return
  const registration = await currentRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (subscription) {
    const endpoint = subscription.endpoint
    await subscription.unsubscribe()
    try {
      await client.v2.push.subscription.delete({ endpoint })
    } catch {
      // Local unsubscribe is authoritative; server cleanup is best-effort.
    }
  }
  await refreshPwaPushState()
}

/** Re-register the browser's current subscription after silent browser refreshes. */
export async function reconcilePwaPush(client: OpencodeClient) {
  if (!supportsClassicWebPush() || Notification.permission !== "granted") return
  try {
    const registration = await currentRegistration()
    const subscription = await registration?.pushManager.getSubscription()
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
    // Non-fatal. The next settings/visibility reconciliation retries.
  }
}
