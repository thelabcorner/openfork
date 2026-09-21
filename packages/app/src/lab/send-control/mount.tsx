/**
 * Send / Stop concept lab — mount. DEV-ONLY.
 *
 * Reached only from the `lab-send-control.html` entries, which are deliberately
 * absent from every `build.rollupOptions.input`, so this module never enters a
 * shipped bundle. It imports the app's real stylesheet (design tokens, the v2
 * theme, every component's CSS) and mounts nothing else — no router, no SDK, no
 * platform bridge, no server connection.
 */

import "@/index.css"
import { render } from "solid-js/web"
import { SendControlLab } from "./harness"

const root = document.getElementById("root")

if (root instanceof HTMLElement) {
  render(() => <SendControlLab />, root)
} else if (import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.error("[send-control lab] missing #root")
}
