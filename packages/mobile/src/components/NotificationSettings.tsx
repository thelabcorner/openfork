import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { Show, createSignal, onMount } from "solid-js"
import { disableNotifications, enableNotifications, pushState, refreshPushState } from "../push"
import { IconBell, IconCheckCircle } from "../icons"

function enableErrorCopy(reason?: string) {
  switch (reason) {
    case "denied":
      return "Notifications are blocked for this app. Enable them in your browser/OS settings."
    case "dismissed":
      return "Permission was dismissed. Tap Enable again and allow notifications."
    case "insecure":
      return "Push needs a secure origin (HTTPS or localhost). HTTP on a LAN IP will not work — install the app or use HTTPS."
    case "not-found":
    case "no-public-key":
      return "This OpenCode server doesn't support push yet. Update it to a build that includes Web Push and restart the server."
    case "unauthorized":
      return "The server rejected this device. Re-pair from Settings and try again."
    case "unsupported":
      return "This browser doesn't support push notifications."
    case "invalid-subscription":
      return "The browser returned an incomplete push subscription. Try again, or clear site data for this origin."
    default:
      return reason && reason !== "unknown"
        ? `Couldn't enable notifications: ${reason}`
        : "Couldn't enable notifications. Try again."
  }
}

export function NotificationSettings(props: { client?: OpencodeClient }) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  onMount(() => void refreshPushState())

  async function handleEnable() {
    if (!props.client) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await enableNotifications(props.client)
      if (!result.ok) setError(enableErrorCopy(result.reason))
    } catch (error) {
      console.error("enableNotifications", error)
      setError(enableErrorCopy(error instanceof Error ? error.message : "unknown"))
    } finally {
      setBusy(false)
    }
  }

  async function handleDisable() {
    if (!props.client) return
    setBusy(true)
    try {
      await disableNotifications(props.client)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div class="settings-section-head">
        <IconBell size={11} />
        <span>Notifications</span>
      </div>
      <div class="settings-card">
        <p class="settings-blurb">
          Get notified when an agent needs approval, asks a question, finishes, or hits an error — even when this app
          isn't open. Sent by your own opencode server, not a third party.
        </p>

        <Show when={pushState() === "needs-install"}>
          <div class="settings-static-row">
            <span class="label" style={{ "white-space": "normal", "line-height": "1.45" }}>
              Install this app to your Home Screen first (Share → Add to Home Screen), then open it from there to enable
              notifications.
            </span>
          </div>
        </Show>

        <Show when={pushState() === "unsupported"}>
          <div class="settings-static-row">
            <span class="label">This browser doesn't support push notifications</span>
          </div>
        </Show>

        <Show when={pushState() === "permission-denied"}>
          <div class="settings-static-row">
            <span class="label" style={{ color: "var(--accent-red)", "white-space": "normal", "line-height": "1.45" }}>
              Notifications are blocked. Re-enable them for this app in your browser/OS settings, then return here.
            </span>
          </div>
        </Show>

        <Show when={pushState() === "subscribed"}>
          <div class="settings-static-row">
            <span class="label" style={{ display: "flex", "align-items": "center", gap: "6px", color: "var(--accent-green)" }}>
              <IconCheckCircle size={14} />
              Enabled
            </span>
          </div>
          <button class="settings-row" disabled={busy() || !props.client} onClick={() => void handleDisable()}>
            <span class="label">{busy() ? "Turning off…" : "Turn off notifications"}</span>
          </button>
        </Show>

        <Show when={pushState() === "permission-default" || pushState() === "permission-granted-unsubscribed"}>
          <button class="settings-row" disabled={busy() || !props.client} onClick={() => void handleEnable()}>
            <span class="label">{busy() ? "Enabling…" : "Enable notifications"}</span>
          </button>
        </Show>

        <Show when={error()}>
          <div class="settings-static-row">
            <span class="label" style={{ color: "var(--accent-red)", "white-space": "normal" }}>
              {error()}
            </span>
          </div>
        </Show>
      </div>
    </>
  )
}
