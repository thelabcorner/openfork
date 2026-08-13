import { describe, expect, test } from "bun:test"
import { searchWithDeadline } from "./home-search-deadline"

// A request that settles only when the given signal aborts, mirroring how the
// SDK client's fetch rejects on an aborted signal.
function signalBoundPromise<T>(signal: AbortSignal): Promise<T> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

describe("searchWithDeadline", () => {
  test("resolves with the value when the request settles in time", async () => {
    const controller = new AbortController()
    const outcome = await searchWithDeadline(controller, 1_000, new Error("deadline"), async () => 42)
    expect(outcome).toEqual({ kind: "ok", value: 42 })
    expect(controller.signal.aborted).toBe(false)
  })

  test("times out and aborts with the marker reason when the request never settles", async () => {
    const controller = new AbortController()
    const marker = new Error("deadline")
    const outcome = await searchWithDeadline(controller, 10, marker, (signal) =>
      signalBoundPromise<never>(signal),
    )
    expect(outcome).toEqual({ kind: "timeout" })
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toBe(marker)
  })

  test("treats a caller abort as user cancellation, not a timeout", async () => {
    const controller = new AbortController()
    const marker = new Error("deadline")
    const outcome = searchWithDeadline(controller, 1_000, marker, (signal) =>
      signalBoundPromise<never>(signal),
    )
    controller.abort()
    expect(await outcome).toEqual({ kind: "user" })
    expect(controller.signal.reason).not.toBe(marker)
  })

  test("rethrows a genuine failure instead of classifying it as a timeout", async () => {
    const controller = new AbortController()
    const outcome = searchWithDeadline(controller, 1_000, new Error("deadline"), async () => {
      throw new Error("network down")
    })
    await expect(outcome).rejects.toThrow("network down")
  })

  test("clears the deadline timer after a successful settle", async () => {
    const controller = new AbortController()
    await searchWithDeadline(controller, 10, new Error("deadline"), async () => "done")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(controller.signal.aborted).toBe(false)
  })
})
