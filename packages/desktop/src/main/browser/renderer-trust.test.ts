import { expect, test } from "bun:test"
import { RendererTrust } from "./renderer-trust"
import type { IpcMainInvokeEvent } from "electron"

// Minimal fakes for the event shape the allowlist inspects.
type FakeFrame = { url: string }
const makeEvent = (opts: {
  senderId: number
  inAllowlist: boolean
  mainFrame?: FakeFrame
  senderFrame?: FakeFrame | null
}): IpcMainInvokeEvent => {
  const mainFrame = opts.mainFrame ?? { url: "oc://renderer" }
  const senderFrame = opts.senderFrame === undefined ? mainFrame : opts.senderFrame
  const sender = {
    id: opts.senderId,
    isDestroyed: () => false,
    mainFrame: () => mainFrame,
    mainFrameSync: mainFrame,
    // The real API exposes `sender.mainFrame` (a property) and `senderFrame`
    // (the frame that triggered the call). We mirror the property access used
    // by isTrusted: event.sender.mainFrame and event.senderFrame.
  } as unknown as IpcMainInvokeEvent["sender"]
  // Real Electron: `webContents.mainFrame` is a property, `senderFrame` a field.
  Object.defineProperty(sender, "mainFrame", { value: mainFrame, configurable: true })
  const event = {
    sender,
    senderFrame: senderFrame as unknown,
  } as unknown as IpcMainInvokeEvent
  return event
}

test("isTrusted: registered app-renderer in its main frame is admitted", () => {
  const trust = new RendererTrust()
  trust.register({ id: 7 })
  const event = makeEvent({ senderId: 7, inAllowlist: true })
  expect(trust.isTrusted(event)).toBe(true)
})

test("isTrusted: unregistered webContents (guest / other) is rejected", () => {
  const trust = new RendererTrust()
  trust.register({ id: 7 })
  const guest = makeEvent({ senderId: 99, inAllowlist: false })
  expect(trust.isTrusted(guest)).toBe(false)
})

test("isTrusted: sender whose frame is NOT the main frame (sub-frame/guest) is rejected", () => {
  const trust = new RendererTrust()
  trust.register({ id: 7 })
  const event = makeEvent({
    senderId: 7,
    inAllowlist: true,
    mainFrame: { url: "oc://renderer" },
    senderFrame: { url: "https://evil.example.com" },
  })
  expect(trust.isTrusted(event)).toBe(false)
})

test("isTrusted: a guest webContents id that is absent from the allowlist cannot reach handlers", () => {
  // This is the security point: Chromium may report a <webview> guest as a
  // BrowserWindow on some versions, so the id-allowlist + main-frame assertion
  // — not BrowserWindow.fromWebContents — is what makes the boundary real.
  const trust = new RendererTrust()
  trust.register({ id: 7 })
  // Simulate a guest whose id is never registered.
  const guestInMainFrame = makeEvent({
    senderId: 123,
    inAllowlist: false,
    mainFrame: { url: "https://guest.example.com" },
    senderFrame: { url: "https://guest.example.com" },
  })
  expect(trust.isTrusted(guestInMainFrame)).toBe(false)
})

test("unregister removes a window from the allowlist", () => {
  const trust = new RendererTrust()
  trust.register({ id: 7 })
  trust.unregister(7)
  expect(trust.isTrusted(makeEvent({ senderId: 7, inAllowlist: false }))).toBe(false)
})
