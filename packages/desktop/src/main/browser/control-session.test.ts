import { expect, test } from "bun:test"
import { ControlSessionManager } from "./control-session"
import { ControlArbiter } from "./arbitration"

// Mock a WebContents-like object whose debugger records every sendCommand so we
// can assert that appearance emulation is RE-APPLIED on reattach. Appearance
// belongs to the CDP SESSION, not the WebContents, so it must be re-sent after
// any debugger churn (DevTools open/close, webview replacement, etc.).
const makeWebContents = (colorScheme: () => "light" | "dark") => {
  const commands: Array<{ method: string; params: unknown }> = []
  const messageListeners = new Set<(event: unknown, method: string, params: Record<string, unknown>) => void>()
  let attached = false
  const wc = {
    id: 1,
    debugger: {
      attach: (_v: string) => {
        attached = true
      },
      isAttached: () => attached,
      detach: () => {
        attached = false
      },
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        commands.push({ method, params })
        return {}
      },
      on: (event: string, listener: (event: unknown, method: string, params: Record<string, unknown>) => void) => {
        if (event === "message") messageListeners.add(listener)
      },
      removeListener: (event: string, listener: (event: unknown, method: string, params: Record<string, unknown>) => void) => {
        if (event === "message") messageListeners.delete(listener)
      },
    },
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
  } as unknown as Parameters<ControlSessionManager["obtain"]>[1] extends infer W ? W : never
  const emitMessage = (method: string, params: Record<string, unknown>) => {
    for (const listener of messageListeners) listener(undefined, method, params)
  }
  return { wc: wc as any, commands, messageListeners, emitMessage }
}

test("ControlSessionManager reapplies emulated appearance on reattach", async () => {
  let scheme: "light" | "dark" = "light"
  const { wc, commands } = makeWebContents(() => scheme)
  const manager = new ControlSessionManager({ arbiter: new ControlArbiter(), colorScheme: () => scheme })

  await manager.reattach(wc, "tab1")
  // First attach applies the current scheme.
  let setMedia = commands.filter((c) => c.method === "Emulation.setEmulatedMedia")
  expect(setMedia.length).toBe(1)
  expect((setMedia[0].params as any).features).toEqual([{ name: "prefers-color-scheme", value: "light" }])

  // A hot-path re-entry with the same appearance should not spend another
  // debugger round-trip on an identical emulation command.
  commands.length = 0
  await manager.reattach(wc, "tab1")
  expect(commands.filter((c) => c.method === "Emulation.setEmulatedMedia")).toHaveLength(0)

  // Simulate the user switching to dark in the renderer.
  scheme = "dark"
  commands.length = 0
  await manager.reattach(wc, "tab1")

  // The reattach MUST re-apply the now-dark scheme (CDP session state is gone).
  setMedia = commands.filter((c) => c.method === "Emulation.setEmulatedMedia")
  expect(setMedia.length).toBe(1)
  expect((setMedia[0].params as any).features).toEqual([{ name: "prefers-color-scheme", value: "dark" }])
})

test("ControlSessionManager does not enable unused persistent CDP event domains", async () => {
  const { wc, commands, messageListeners } = makeWebContents(() => "light")
  const manager = new ControlSessionManager({ arbiter: new ControlArbiter(), colorScheme: () => "light" })

  await manager.reattach(wc, "tab1")

  expect(commands.filter((c) => c.method.endsWith(".enable"))).toEqual([])
  expect(commands.some((c) => c.method === "Input.setIgnoreInputEvents")).toBe(true)
  expect(commands.some((c) => c.method === "Emulation.setEmulatedMedia")).toBe(true)
  expect(messageListeners.size).toBe(0)
})

test("ControlSessionManager cleanly rebinds a reused webContents id", async () => {
  const { wc, commands } = makeWebContents(() => "light")
  const manager = new ControlSessionManager({ arbiter: new ControlArbiter(), colorScheme: () => "light" })

  await manager.reattach(wc, "tab1")
  commands.length = 0
  await manager.reattach(wc, "tab2")

  expect(commands.some((c) => c.method === "Emulation.setEmulatedMedia")).toBe(true)
})

test("ControlSessionManager wires debugger messages only for active screencast subscribers", async () => {
  const { wc, messageListeners, emitMessage } = makeWebContents(() => "light")
  const manager = new ControlSessionManager({ arbiter: new ControlArbiter(), colorScheme: () => "light" })
  await manager.reattach(wc, "tab1")
  expect(messageListeners.size).toBe(0)

  const frames: Array<{ tabId: string; params: Record<string, unknown> }> = []
  const unsubscribe = manager.onScreencastFrame((tabId, params) => frames.push({ tabId, params }))
  expect(messageListeners.size).toBe(1)

  emitMessage("Runtime.consoleAPICalled", { ignored: true })
  emitMessage("Page.screencastFrame", { sessionId: 7, data: "frame" })
  expect(frames).toEqual([{ tabId: "tab1", params: { sessionId: 7, data: "frame" } }])

  unsubscribe()
  expect(messageListeners.size).toBe(0)
})
