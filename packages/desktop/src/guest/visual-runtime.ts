// Heavy visual kernel for Electron browser guests.
//
// This is intentionally a SEPARATE preload build entry, not imported by
// preview-preload.ts. Browser main lazily injects the bundled source into
// Electron's context-isolated world (999) only when a visual operation is
// requested, preserving essentially zero SnapEye/SnapDOM startup cost.

import { runVisualOperation } from "@opencode-ai/browser-visual"

const VISUAL_BRIDGE_KEY = "__opencodeVisualBridgeV1"
const VISUAL_RUNTIME_KEY = "__opencodeVisualRuntimeV1"

type RpcResponse = { ok: true; id: string; result: unknown } | { ok: false; id: string; error: { code: string; message: string } }
type VisualBridge = {
  rpc: (requestId: string, request: { id: string }) => Promise<RpcResponse>
  onAbort: (requestId: string, listener: () => void) => () => void
}
type VisualCommand = {
  requestId: string
  capability: string
  runId: string
  maxChunkBytes: number
  operation: "capture" | "diff" | "record"
  input: {
    name: string
    target?: string
    redaction?: { blocks?: string[]; attributes?: Array<{ selector: string; names: string[] }> }
    options?: Record<string, unknown>
  }
}

const scope = globalThis as typeof globalThis & {
  [VISUAL_BRIDGE_KEY]?: VisualBridge
  [VISUAL_RUNTIME_KEY]?: { run: (command: VisualCommand) => Promise<unknown> }
}

const bridge = scope[VISUAL_BRIDGE_KEY]
if (!bridge || typeof bridge.rpc !== "function") throw new Error("OpenCode visual preload bridge is unavailable")

if (!scope[VISUAL_RUNTIME_KEY]) {
  let active = false
  scope[VISUAL_RUNTIME_KEY] = {
    async run(command) {
      validate(command)
      if (active) throw new Error("A visual operation is already active in this guest")
      active = true
      const controller = new AbortController()
      const unsubscribeAbort = bridge.onAbort(command.requestId, () => controller.abort())
      try {
        return await runVisualOperation({
          operation: command.operation,
          name: command.input.name,
          runId: command.runId,
          capability: command.capability,
          maxChunkBytes: command.maxChunkBytes,
          rpc: (request) => bridge.rpc(command.requestId, request),
          signal: controller.signal,
          target: typeof command.input.target === "string" ? command.input.target : undefined,
          redaction: command.input.redaction,
          options: command.input.options,
        })
      } finally {
        unsubscribeAbort()
        active = false
      }
    },
  }
}

function validate(command: VisualCommand) {
  if (!command || typeof command !== "object") throw new Error("Invalid visual command")
  if (command.operation !== "capture" && command.operation !== "diff" && command.operation !== "record") throw new Error("Unsupported visual operation")
  if (typeof command.requestId !== "string" || !command.requestId) throw new Error("Visual command is missing requestId")
  if (typeof command.capability !== "string" || !command.capability) throw new Error("Visual command is missing capability")
  if (typeof command.runId !== "string" || !command.runId) throw new Error("Visual command is missing runId")
  if (!Number.isSafeInteger(command.maxChunkBytes) || command.maxChunkBytes < 1) throw new Error("Invalid visual chunk size")
  if (!command.input || typeof command.input !== "object" || typeof command.input.name !== "string") {
    throw new Error("Visual operation is missing a baseline name")
  }
}
