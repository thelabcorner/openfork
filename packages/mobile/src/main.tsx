import { render } from "solid-js/web"
import { MobileBootstrap } from "./bootstrap"
import { registerPwaServiceWorker } from "./service-worker"
import { PwaUpdatePrompt } from "./update-prompt"
import "./bootstrap.css"

if ("serviceWorker" in navigator) {
  // Register immediately: delaying until window.load makes installed-app cold
  // starts wait behind the entire JS/font graph before offline/push capability
  // begins reconciling.
  void registerPwaServiceWorker()

  // The service worker posts this after a notification click (either to focus
  // this window, or immediately on a fresh openWindow() launch). The app owns
  // actual routing/state, so this remains a narrow DOM-event bridge.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "PUSH_NAVIGATE" && typeof event.data.url === "string") {
      window.dispatchEvent(new CustomEvent("opencode:push-navigate", { detail: { url: event.data.url } }))
    }
  })
}

render(
  () => (
    <>
      <MobileBootstrap />
      <PwaUpdatePrompt />
    </>
  ),
  document.getElementById("root")!,
)
