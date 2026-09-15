import { describe, expect, test } from "bun:test"
import { VisualRuntimeLoader } from "./visual-runtime-loader"

describe("Chrome visual runtime lazy loader", () => {
  test("warm documents never reinject the heavy runtime", async () => {
    let injections = 0
    const loader = new VisualRuntimeLoader({
      probe: async () => true,
      inject: async () => { injections++ },
    })
    expect(await loader.ensure(1)).toBe("warm")
    expect(await loader.ensure(1)).toBe("warm")
    expect(injections).toBe(0)
  })

  test("a cold document injects once and verifies readiness", async () => {
    let ready = false
    let injections = 0
    const loader = new VisualRuntimeLoader({
      probe: async () => ready,
      inject: async () => { injections++; ready = true },
    })
    expect(await loader.ensure(1)).toBe("cold")
    expect(await loader.ensure(1)).toBe("warm")
    expect(injections).toBe(1)
  })

  test("concurrent cold starts share one bundle injection", async () => {
    let ready = false
    let injections = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const loader = new VisualRuntimeLoader({
      probe: async () => ready,
      inject: async () => {
        injections++
        await gate
        ready = true
      },
    })
    const a = loader.ensure(7)
    const b = loader.ensure(7)
    await Promise.resolve()
    await Promise.resolve()
    expect(injections).toBe(1)
    release()
    expect(await Promise.all([a, b])).toEqual(["cold", "cold"])
    expect(injections).toBe(1)
  })

  test("failed installation is evicted so a later cold attempt can genuinely reinject", async () => {
    let ready = false
    let injections = 0
    const loader = new VisualRuntimeLoader({
      probe: async () => ready,
      inject: async () => {
        injections++
        if (injections === 2) ready = true
      },
    })
    await expect(loader.ensure(3)).rejects.toThrow("did not become ready")
    expect(await loader.ensure(3)).toBe("cold")
    expect(injections).toBe(2)
  })
})
