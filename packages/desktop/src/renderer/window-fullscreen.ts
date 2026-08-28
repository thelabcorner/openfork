import { createSignal } from "solid-js"

const [windowFullscreen, setWindowFullscreen] = createSignal(false)

if (window.api && typeof window.api.onWindowFullscreenChanged === "function") {
  window.api.onWindowFullscreenChanged(setWindowFullscreen)
}
if (window.api && typeof window.api.getWindowFullscreen === "function") {
  void window.api.getWindowFullscreen().then(setWindowFullscreen)
}

export { windowFullscreen }
