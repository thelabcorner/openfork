import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { VISUAL_ABORT_CHANNEL } from "../contracts"
import { WebviewVisualController } from "./webview-controller"

function fakeWebContents() {
  const lifecycle = new EventEmitter()
  const ipc = new EventEmitter()
  const sent: Array<{ channel: string; payload: unknown }> = []
  return Object.assign(lifecycle, {
    ipc,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    executeJavaScriptInIsolatedWorld: (_worldId: number, scripts: Array<{ code: string }>) => {
      const code = scripts[0]?.code ?? ""
      if (code.includes("typeof globalThis.__opencodeVisualRuntimeV1")) return Promise.resolve(true)
      return new Promise(() => {})
    },
    sent,
  })
}

function fixture() {
  const aborted: string[] = []
  const begins: unknown[] = []
  const coordinator = {
    begin: async (input: unknown) => {
      begins.push(input)
      return { capability: "cap-1", runId: "run-1", expiresAt: Date.now() + 30_000, maxChunkBytes: 1024, redaction: { blocks: [], attributes: [] } }
    },
    abort: async (capability: string) => { aborted.push(capability) },
  }
  const wc = fakeWebContents()
  const tab = {
    runtimeTabId: "tab-1",
    owner: { kind: "agent", sessionId: "ses-1" },
    webContents: wc,
    crashed: false,
    attached: true,
  }
  const context = {
    requestId: "req-1",
    sessionId: "ses-1",
    windowId: "win-1",
    directory: "C:/repo",
    messageId: "msg-1",
    timeoutMs: 30_000,
  }
  return { aborted, begins, coordinator, wc, tab, context }
}

describe("WebviewVisualController lifecycle", () => {
  test("cancel rejects the in-flight caller instead of orphaning its promise", async () => {
    const f = fixture()
    const controller = new WebviewVisualController(f.coordinator as never, { runtimeSource: async () => "" })
    const pending = controller.run(
      f.tab as never,
      "capture",
      { name: "baseline" },
      f.context as never,
      "system",
    )

    await Promise.resolve()
    controller.cancel("tab-1", "tab detached")

    await expect(pending).rejects.toMatchObject({ name: "BrowserControlInterrupted", message: "tab detached" })
    expect(f.aborted).toEqual(["cap-1"])
  })

  test("stop settles every active visual run exactly once", async () => {
    const f = fixture()
    const controller = new WebviewVisualController(f.coordinator as never, { runtimeSource: async () => "" })
    const pending = controller.run(
      f.tab as never,
      "diff",
      { name: "baseline" },
      f.context as never,
      "system",
    )

    await Promise.resolve()
    controller.stop()
    controller.stop()

    await expect(pending).rejects.toMatchObject({ name: "BrowserControlInterrupted", message: "Visual controller stopped" })
    expect(f.aborted).toEqual(["cap-1"])
  })

  test("an already-aborted request fails before minting a visual capability", async () => {
    const f = fixture()
    const abort = new AbortController()
    abort.abort()
    const controller = new WebviewVisualController(f.coordinator as never, { runtimeSource: async () => "" })

    await expect(controller.run(
      f.tab as never,
      "record",
      { name: "motion" },
      { ...f.context, signal: abort.signal } as never,
      "system",
    )).rejects.toMatchObject({ name: "BrowserControlInterrupted" })

    expect(f.begins).toHaveLength(0)
    expect(f.aborted).toHaveLength(0)
  })

  test("abort racing coordinator.begin revokes the grant before guest execution", async () => {
    const f = fixture()
    const abort = new AbortController()
    f.coordinator.begin = async (input: unknown) => {
      f.begins.push(input)
      abort.abort()
      return { capability: "cap-race", runId: "run-race", expiresAt: Date.now() + 30_000, maxChunkBytes: 1024, redaction: { blocks: [], attributes: [] } }
    }
    const controller = new WebviewVisualController(f.coordinator as never, { runtimeSource: async () => "" })

    await expect(controller.run(
      f.tab as never,
      "capture",
      { name: "panel" },
      { ...f.context, signal: abort.signal } as never,
      "system",
    )).rejects.toMatchObject({ name: "BrowserControlInterrupted" })

    expect(f.begins).toHaveLength(1)
    expect(f.aborted).toEqual(["cap-race"])
    expect(f.wc.sent.some((entry) => entry.channel === VISUAL_ABORT_CHANNEL)).toBe(true)
  })
})
