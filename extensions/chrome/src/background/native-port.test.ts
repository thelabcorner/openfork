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
})
