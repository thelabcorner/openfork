// Browser guest preload — runs inside every browser <webview> guest.
//
// Sandboxed (webPreferences.sandbox forced true by will-attach-webview
// hardening), so it only has the sandboxed preload surface (ipcRenderer).
// Its one job: report HUMAN input (pointer presses + keys) to the host over
// the guest's webContents IPC ("preview:human-input", listened on wc.ipc in
// guest.ts). Agent-dispatched input also surfaces here — the host's
// expected-agent-input queue consumes the agent's own echo (±1px / exact key)
// so it is never mistaken for a human preemption.

import { ipcRenderer } from "electron"

import { HUMAN_INPUT_CHANNEL } from "../main/browser/contracts"
import "./annotation-overlay"

const send = (signal: unknown) => {
  ipcRenderer.send(HUMAN_INPUT_CHANNEL, signal)
}

window.addEventListener(
  "mousedown",
  (event: MouseEvent) => {
    send({ kind: "pointer", x: event.clientX, y: event.clientY, button: event.button })
  },
  true,
)

window.addEventListener(
  "keydown",
  (event: KeyboardEvent) => {
    send({ kind: "key", key: event.key, code: event.code })
  },
  true,
)
