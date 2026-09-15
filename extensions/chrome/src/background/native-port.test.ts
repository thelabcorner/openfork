import { describe, expect, test } from "bun:test"
import { NativePortV2, type PortLike } from "./native-port"
import type { BrokerRequest, BrokerResponse } from "../shared/protocol"

function emitter<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>()
  return {
    api: {
      addListener: (listener: T) => listeners.add(listener),
      removeListener: (listener: T) => listeners.delete(listener),
    },
    emit: (...args: Parameters<T>) => {
      for (const listener of [...listeners]) listener(...args)
    },
  }
}

describe("NativePortV2 duplex native-messaging transport", () => {
  test("delivers host-initiated requests exactly once and writes one response frame", () => {
    const messages = emitter<(message: unknown) => void>()
    const disconnects = emitter<() => void>()
    const writes: unknown[] = []
    const port: PortLike = {
      onMessage: messages.api,
      onDisconnect: disconnects.api,
      postMessage: (message) => writes.push(message),
      disconnect: () => {},
    }

    const requests: BrokerRequest[] = []
    const native = new NativePortV2({
      hostName: "com.opencode.desktop",
      connectNative: () => port,
      onResponse: () => {},
      onRequest: (request) => requests.push(request),
    })
    native.connect()

    const request = {
      requestId: "req-1",
      sessionId: "ses-1",
      windowId: "win-1",
      messageId: "msg-1",
      timeoutMs: 1000,
      operation: { name: "status", input: {} },
    } as BrokerRequest
    messages.emit({ type: "request", request })

    expect(requests).toEqual([request])
    const response: BrokerResponse = { ok: true, requestId: request.requestId, result: { tabs: [] }, elapsedMs: 2 }
    native.respond(response)
    expect(writes).toEqual([{ type: "response", response }])
  })

  test("correlates artifact RPC independently from browser-control flights", async () => {
    const messages = emitter<(message: unknown) => void>()
    const disconnects = emitter<() => void>()
    const writes: unknown[] = []
    const port: PortLike = {
      onMessage: messages.api,
      onDisconnect: disconnects.api,
      postMessage: (message) => writes.push(message),
      disconnect: () => {},
    }
    const native = new NativePortV2({ hostName: "com.opencode.desktop", connectNative: () => port })
    const pending = native.artifactRpc({ id: "artifact-1" }, 1000)
    expect(native.pendingArtifactCount).toBe(1)
    expect(writes[0]).toEqual({ type: "artifact_rpc", request: { id: "artifact-1" } })
    messages.emit({ type: "artifact_rpc_result", response: { ok: true, id: "artifact-1", result: { offset: 4 } } })
    expect(await pending).toEqual({ ok: true, id: "artifact-1", result: { offset: 4 } })
    expect(native.pendingArtifactCount).toBe(0)
    expect(native.pendingCount).toBe(0)
  })

  test("disconnect rejects artifact RPC, then a fresh native port can reconnect and complete a new RPC", async () => {
    const firstMessages = emitter<(message: unknown) => void>()
    const firstDisconnects = emitter<() => void>()
    const secondMessages = emitter<(message: unknown) => void>()
    const secondDisconnects = emitter<() => void>()
    const firstWrites: unknown[] = []
    const secondWrites: unknown[] = []
    const ports: PortLike[] = [
      {
        onMessage: firstMessages.api,
        onDisconnect: firstDisconnects.api,
        postMessage: (message) => firstWrites.push(message),
        disconnect: () => {},
      },
      {
        onMessage: secondMessages.api,
        onDisconnect: secondDisconnects.api,
        postMessage: (message) => secondWrites.push(message),
        disconnect: () => {},
      },
    ]
    const native = new NativePortV2({
      hostName: "com.opencode.desktop",
      connectNative: () => ports.shift()!,
    })

    const first = native.artifactRpc({ id: "rpc-before-disconnect" })
    expect(firstWrites).toHaveLength(1)
    firstDisconnects.emit()
    await expect(first).resolves.toEqual({
      ok: false,
      id: "rpc-before-disconnect",
      error: { code: "VISUAL_HOST_UNAVAILABLE", message: "Native host disconnected" },
    })

    native.connect()
    const second = native.artifactRpc({ id: "rpc-after-reconnect" })
    expect(secondWrites).toHaveLength(1)
    secondMessages.emit({ type: "artifact_rpc_result", response: { ok: true, id: "rpc-after-reconnect", result: null } })
    await expect(second).resolves.toEqual({ ok: true, id: "rpc-after-reconnect", result: null })
  })

  test("artifact RPC responses may arrive out of order without cross-resolving flights", async () => {
    const messages = emitter<(message: unknown) => void>()
    const disconnects = emitter<() => void>()
    const writes: unknown[] = []
    const port: PortLike = {
      onMessage: messages.api,
      onDisconnect: disconnects.api,
      postMessage: (message) => writes.push(message),
      disconnect: () => {},
    }
    const native = new NativePortV2({ hostName: "com.opencode.desktop", connectNative: () => port })
    const a = native.artifactRpc({ id: "rpc-a" })
    const b = native.artifactRpc({ id: "rpc-b" })
    expect(native.pendingArtifactCount).toBe(2)

    messages.emit({ type: "artifact_rpc_result", response: { ok: true, id: "rpc-b", result: { value: "B" } } })
    messages.emit({ type: "artifact_rpc_result", response: { ok: true, id: "rpc-a", result: { value: "A" } } })

    await expect(a).resolves.toEqual({ ok: true, id: "rpc-a", result: { value: "A" } })
    await expect(b).resolves.toEqual({ ok: true, id: "rpc-b", result: { value: "B" } })
    expect(native.pendingArtifactCount).toBe(0)
  })
})
