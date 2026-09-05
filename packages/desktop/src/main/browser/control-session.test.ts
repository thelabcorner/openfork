import { expect, test } from "bun:test"
import { ControlSessionManager } from "./control-session"
import { ControlArbiter } from "./arbitration"

// Mock a WebContents-like object whose debugger records every sendCommand so we
// can assert that appearance emulation is RE-APPLIED on reattach. Appearance
// belongs to the CDP SESSION, not the WebContents, so it must be re-sent after
// any debugger churn (DevTools open/close, webview replacement, etc.).
const makeWebContents = (colorScheme: () => "light" | "dark") => {
  const commands: Array<{ method: string; params: unknown }> = []
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
        // Domain.enable returns {} so ensureAttached's enable loop resolves.
        return {}
      },
      on: () => undefined,
      removeListener: () => undefined,
    },
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
  } as unknown as Parameters<ControlSessionManager["obtain"]>[1] extends infer W ? W : never
  return { wc: wc as any, commands }
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

  // Simulate the user switching to dark in the renderer.
  scheme = "dark"
  commands.length = 0
  await manager.reattach(wc, "tab1")

  // The reattach MUST re-apply the now-dark scheme (CDP session state is gone).
  setMedia = commands.filter((c) => c.method === "Emulation.setEmulatedMedia")
  expect(setMedia.length).toBe(1)
  expect((setMedia[0].params as any).features).toEqual([{ name: "prefers-color-scheme", value: "dark" }])
})
