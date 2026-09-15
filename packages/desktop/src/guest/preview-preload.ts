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

import {
  HUMAN_INPUT_CHANNEL,
  VISUAL_ABORT_CHANNEL,
  VISUAL_RPC_CHANNEL,
  VISUAL_RPC_RESPONSE_CHANNEL,
} from "../main/browser/contracts"
import "./annotation-overlay"

type RpcResponse = { ok: true; id: string; result: unknown } | { ok: false; id: string; error: { code: string; message: string } }
const pendingVisualRpc = new Map<string, { requestId: string; resolve: (response: RpcResponse) => void }>()
const visualAbortListeners = new Map<string, Set<() => void>>()
const VISUAL_BRIDGE_KEY = "__opencodeVisualBridgeV1"

type VisualBridge = {
  rpc: (requestId: string, request: { id: string }) => Promise<RpcResponse>
  onAbort: (requestId: string, listener: () => void) => () => void
}

const visualBridge: VisualBridge = {
  rpc: (requestId, request) => new Promise<RpcResponse>((resolve) => {
    pendingVisualRpc.set(request.id, { requestId, resolve })
    ipcRenderer.send(VISUAL_RPC_CHANNEL, { requestId, request })
  }),
  onAbort: (requestId, listener) => {
    const listeners = visualAbortListeners.get(requestId) ?? new Set()
    listeners.add(listener)
    visualAbortListeners.set(requestId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) visualAbortListeners.delete(requestId)
    }
  },
}

// Electron's contextIsolation preload world is world 999. Main lazily injects
// the large SnapEye/SnapDOM bundle into that SAME isolated world on first use;
// the bundle can therefore call this bridge without exposing Electron IPC or a
// visual capability to page JavaScript in the main world.
Object.defineProperty(globalThis, VISUAL_BRIDGE_KEY, {
  value: visualBridge,
  configurable: false,
  enumerable: false,
  writable: false,
})

ipcRenderer.on(VISUAL_RPC_RESPONSE_CHANNEL, (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") return
  const envelope = raw as { requestId?: unknown; response?: unknown }
  const response = envelope.response as RpcResponse | undefined
  if (!response || typeof response.id !== "string") return
  const pending = pendingVisualRpc.get(response.id)
  if (!pending || pending.requestId !== envelope.requestId) return
  pendingVisualRpc.delete(response.id)
  pending.resolve(response)
})

ipcRenderer.on(VISUAL_ABORT_CHANNEL, (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object") return
  const requestId = (raw as { requestId?: unknown }).requestId
  if (typeof requestId !== "string") return
  for (const [id, pending] of pendingVisualRpc) {
    if (pending.requestId !== requestId) continue
    pendingVisualRpc.delete(id)
    pending.resolve({ ok: false, id, error: { code: "VISUAL_ABORTED", message: "Visual operation aborted" } })
  }
  for (const listener of [...(visualAbortListeners.get(requestId) ?? [])]) listener()
  visualAbortListeners.delete(requestId)
})

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
