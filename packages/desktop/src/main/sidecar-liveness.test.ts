import { describe, expect, test } from "bun:test"
import { startSidecarLiveness } from "./sidecar-liveness"

describe("sidecar liveness watchdog", () => {
  test("reports a suspected hang only after repeated external probe failures", async () => {
    const states: string[] = []
    const stop = startSidecarLiveness({
      probe: async () => false,
      onState: (state) => states.push(state),
      intervalMs: 2,
      startupGraceMs: 0,
      failureThreshold: 3,
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    stop()
    expect(states).toContain("suspected-hang")
    expect(states.at(-1)).toBe("stopped")
  })

  test("does not report healthy probes as hangs", async () => {
    const states: string[] = []
    const stop = startSidecarLiveness({
      probe: async () => true,
      onState: (state) => states.push(state),
      intervalMs: 2,
      startupGraceMs: 0,
    })
    await new Promise((resolve) => setTimeout(resolve, 8))
    stop()
    expect(states).toContain("healthy")
    expect(states).not.toContain("suspected-hang")
  })

  test("startup grace suppresses early probe failures", async () => {
    const states: string[] = []
    const stop = startSidecarLiveness({
      probe: async () => false,
      onState: (state) => states.push(state),
      intervalMs: 2,
      startupGraceMs: 60_000,
      failureThreshold: 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 12))
    stop()
    expect(states).not.toContain("suspected-hang")
  })
})
