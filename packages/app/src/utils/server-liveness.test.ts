import { describe, expect, test } from "bun:test"
import { forgetServerStreamLiveness, isServerStreamLive, markServerStreamDead, markServerStreamLive } from "./server-liveness"

describe("server stream liveness", () => {
  test("marks a server live and reports it within the window", () => {
    markServerStreamLive("sidecar")
    expect(isServerStreamLive("sidecar")).toBe(true)
    forgetServerStreamLiveness("sidecar")
    expect(isServerStreamLive("sidecar")).toBe(false)
  })

  test("a stream failure clears liveness so the health poll resumes", () => {
    markServerStreamLive("sidecar")
    markServerStreamDead("sidecar")
    expect(isServerStreamLive("sidecar")).toBe(false)
  })

  test("keys are independent", () => {
    markServerStreamLive("sidecar")
    expect(isServerStreamLive("http://remote")).toBe(false)
    markServerStreamDead("sidecar")
    forgetServerStreamLiveness("sidecar")
  })

  test("liveness expires after the window without a refresh", () => {
    const original = Date.now
    let now = 1_000_000
    Date.now = () => now
    try {
      markServerStreamLive("sidecar")
      expect(isServerStreamLive("sidecar")).toBe(true)
      // The 10s SSE heartbeat re-marks within the 15s window; an un-refreshed
      // entry must not stay live forever.
      now += 16_000
      expect(isServerStreamLive("sidecar")).toBe(false)
    } finally {
      Date.now = original
      forgetServerStreamLiveness("sidecar")
    }
  })
})
