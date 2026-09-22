import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { activatePwaUpdate, onPwaUpdateReady, registerPwaServiceWorker } from "./service-worker"

export function PwaUpdatePrompt() {
  const [ready, setReady] = createSignal(false)
  const [updating, setUpdating] = createSignal(false)

  onMount(() => {
    const unsubscribe = onPwaUpdateReady(() => setReady(true))
    onCleanup(unsubscribe)
    void registerPwaServiceWorker().then((registration) => {
      if (registration?.waiting && navigator.serviceWorker.controller) setReady(true)
    })
  })

  const update = async () => {
    if (updating()) return
    setUpdating(true)
    const activated = await activatePwaUpdate()
    if (activated) return
    setUpdating(false)
    setReady(false)
  }

  return (
    <Show when={ready()}>
      <div class="pwa-update-card" role="status" aria-live="polite">
        <div class="pwa-update-copy">
          <div class="pwa-update-title">Update ready</div>
          <div class="pwa-update-description">A new OpenFork Mobile release is staged and ready to load.</div>
        </div>
        <div class="pwa-update-actions">
          <button
            type="button"
            class="pwa-update-later"
            disabled={updating()}
            onClick={() => setReady(false)}
          >
            Later
          </button>
          <button
            type="button"
            class="pwa-update-now"
            disabled={updating()}
            onClick={() => void update()}
          >
            {updating() ? "Updating…" : "Update now"}
          </button>
        </div>
      </div>
    </Show>
  )
}
