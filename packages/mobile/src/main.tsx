import { render } from "solid-js/web"
import { App } from "./app"
import "katex/dist/katex.min.css"
import "./styles.css"

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js")
  })
  // The service worker posts this after a notification click (either to
  // focus this window, or immediately on a fresh openWindow() launch). The
  // app owns actual routing/state, so this is just forwarded as a DOM event
  // rather than main.tsx reaching into app state directly.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "PUSH_NAVIGATE" && typeof event.data.url === "string") {
      window.dispatchEvent(new CustomEvent("opencode:push-navigate", { detail: { url: event.data.url } }))
    }
  })
}

render(() => <App />, document.getElementById("root")!)
