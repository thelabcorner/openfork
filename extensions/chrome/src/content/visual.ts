// Lazy SnapEye/SnapDOM runtime for the Chrome lane.
//
// This file is NOT a manifest content_script. The service worker injects its
// bundled form into the ISOLATED world only for visual_capture/visual_diff, so
// normal browsing pays none of the SnapDOM/SnapEye parse/initialization cost.
// @ts-nocheck — built for Chrome's extension world.

import { runVisualOperation } from "@opencode-ai/browser-visual"

const INSTALL_KEY = "__opencodeVisualRuntimeV1"
const scope = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean }
const activeRuns = new Map<string, AbortController>()
const HUMAN_INTERRUPT_EVENTS = ["pointerdown", "keydown", "wheel", "beforeinput"] as const

const interruptForTrustedInput = (event: Event) => {
  if (!event.isTrusted || activeRuns.size === 0) return
  for (const controller of activeRuns.values()) controller.abort()
}

const setHumanInterruptMonitoring = (enabled: boolean) => {
  for (const type of HUMAN_INTERRUPT_EVENTS) {
    if (enabled) document.addEventListener(type, interruptForTrustedInput, { capture: true, passive: true })
    else document.removeEventListener(type, interruptForTrustedInput, true)
  }
}

if (!scope[INSTALL_KEY]) {
  scope[INSTALL_KEY] = true

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return
    if (message.type === "opencode:visual-ready") {
      sendResponse({ ready: true, version: 1 })
      return false
    }
    if (message.type === "opencode:visual-abort" && typeof message.requestId === "string") {
      const controller = activeRuns.get(message.requestId)
      controller?.abort()
      sendResponse({ ok: true, aborted: !!controller })
      return false
    }
    if (message.type !== "opencode:visual-run") return
    void execute(message.command).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({
        ok: false,
        aborted: error instanceof DOMException && error.name === "AbortError",
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return true
  })
}

async function execute(command) {
  if (!command || typeof command !== "object") throw new Error("Invalid visual command")
  if (command.operation !== "capture" && command.operation !== "diff" && command.operation !== "record") throw new Error("Unsupported visual operation")
  if (typeof command.name !== "string" || typeof command.runId !== "string" || typeof command.capability !== "string") {
    throw new Error("Visual command is missing identity fields")
  }
  if (typeof command.requestId !== "string") throw new Error("Visual command is missing requestId")
  if (!Number.isSafeInteger(command.maxChunkBytes) || command.maxChunkBytes < 1) throw new Error("Invalid visual chunk size")

  const controller = new AbortController()
  activeRuns.set(command.requestId, controller)
  if (activeRuns.size === 1) setHumanInterruptMonitoring(true)

  const rpc = async (request) => {
    if (controller.signal.aborted) return abortedRpc(request.id)
    const wireRequest = request.method === "write_chunk" && request.payload?.bytes instanceof Uint8Array
      ? {
          ...request,
          payload: {
            ...request.payload,
            bytes: bytesToBase64(request.payload.bytes),
          },
        }
      : request
    const response = await chrome.runtime.sendMessage({ type: "opencode:visual-rpc", request: wireRequest })
    if (controller.signal.aborted) return abortedRpc(request.id)
    if (!response || typeof response !== "object") {
      return { ok: false, id: request.id, error: { code: "VISUAL_HOST_UNAVAILABLE", message: "Visual RPC returned no response" } }
    }
    return response
  }

  try {
    const result = await runVisualOperation({
      operation: command.operation,
      name: command.name,
      runId: command.runId,
      capability: command.capability,
      maxChunkBytes: command.maxChunkBytes,
      rpc,
      signal: controller.signal,
      // In inactive tabs Chromium throttles page RAF/timers heavily. Keep the
      // same SnapEye stability algorithm but source its frame clock from the MV3
      // worker, whose timers are not background-page throttled.
      wait: (milliseconds) => extensionWait(command.requestId, milliseconds),
      preferWaitForFrames: true,
      target: typeof command.target === "string" ? command.target : undefined,
      redaction: command.redaction && typeof command.redaction === "object" ? command.redaction : undefined,
      options: command.options && typeof command.options === "object" ? command.options : undefined,
    })
    if (controller.signal.aborted) throw new DOMException("Visual operation aborted", "AbortError")
    return result
  } finally {
    if (activeRuns.get(command.requestId) === controller) activeRuns.delete(command.requestId)
    if (activeRuns.size === 0) setHumanInterruptMonitoring(false)
  }
}

async function extensionWait(requestId, milliseconds) {
  let remaining = Math.max(0, Number(milliseconds) || 0)
  if (remaining === 0) return
  // Bound each service-worker timer. If the operation is aborted, the shared
  // adapter rejects immediately while at most one <=1s worker timer finishes in
  // the background; long model-requested waits never pin a single huge timer.
  while (remaining > 0) {
    const durationMs = Math.min(1_000, remaining)
    const response = await chrome.runtime.sendMessage({
      type: "opencode:visual-wait",
      requestId,
      durationMs,
    })
    if (!response?.ok) throw new Error(response?.error ?? "Visual frame clock unavailable")
    remaining -= durationMs
  }
}

function abortedRpc(id) {
  return { ok: false, id, error: { code: "VISUAL_ABORTED", message: "Visual operation aborted" } }
}

function bytesToBase64(bytes) {
  // Modern Chromium exposes the typed-array base64 proposal and can encode a
  // native byte view without constructing the large intermediate binary string
  // below. Keep the blockwise path as the compatibility fallback.
  if (typeof bytes.toBase64 === "function") return bytes.toBase64()
  // 384 KiB chunks are deliberate: chunking this conversion avoids call-stack
  // argument limits and keeps the intermediate binary string bounded.
  const BLOCK = 0x8000
  let binary = ""
  for (let offset = 0; offset < bytes.byteLength; offset += BLOCK) {
    const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + BLOCK))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}
