import { describe, expect, test } from "bun:test"
import { stopSession } from "./session-stop"

describe("session stop ownership parity", () => {
  test("deduplicates only simultaneous stop for the same server and Session", async () => {
    const requests: string[] = []
    let resolve!: () => void
    const api = {
      interrupt: async ({ sessionID }: { sessionID: string }) => {
        requests.push(sessionID)
        if (requests.length === 1) await new Promise<void>((done) => { resolve = done })
      },
    }
    const a = stopSession(api, "a")
    const b = stopSession(api, "a")
    expect(a).toBe(b)
    await Promise.resolve()
    expect(requests).toEqual(["a"])
    resolve()
    await Promise.all([a, b])
    await stopSession(api, "a")
    expect(requests).toEqual(["a", "a"])
  })

  test("does not conflate different sessions or servers", async () => {
    const calls: string[] = []
    const apiA = { interrupt: async ({ sessionID }: { sessionID: string }) => { calls.push("a:" + sessionID) } }
    const apiB = { interrupt: async ({ sessionID }: { sessionID: string }) => { calls.push("b:" + sessionID) } }
    await Promise.all([
      stopSession(apiA, "x"), stopSession(apiA, "y"), stopSession(apiB, "x"),
    ])
    expect(calls).toEqual(["a:x", "a:y", "b:x"])
  })

  test("does not retain success or suppress a failed generation Stop", async () => {
    let attempts = 0
    const api = { interrupt: async () => {
      if (++attempts === 1) throw new Error("generation superseded")
    } }
    await expect(stopSession(api, "s")).rejects.toThrow("generation superseded")
    await stopSession(api, "s")
    expect(attempts).toBe(2)
  })

  test("rejects a successful HTTP response whose body explicitly reports a failed Stop", async () => {
    const denied = { interrupt: async () => false }
    await expect(stopSession(denied, "s")).rejects.toThrow("not confirmed")
    const wrapped = { interrupt: async () => ({ data: false }) }
    await expect(stopSession(wrapped, "s")).rejects.toThrow("not confirmed")
    await stopSession({ interrupt: async () => undefined }, "s")
    await stopSession({ interrupt: async () => true }, "s")
    await stopSession({ interrupt: async () => ({ data: true }) }, "s")
  })
})
