import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { makeRecoverableResolution } from "../src/ripgrep/resolution"

describe("recoverable ripgrep binary resolution", () => {
  test("100 concurrent first-use requests share exactly one successful installation", async () => {
    let attempts = 0
    const locator = await Effect.runPromise(makeRecoverableResolution(
      Effect.succeed<string | undefined>(undefined),
      Effect.gen(function* () {
        attempts++
        yield* Effect.sleep("25 millis")
        return "installed-rg"
      }),
    ))
    const paths = await Promise.all(Array.from({ length: 100 }, () => Effect.runPromise(locator)))
    expect(paths).toEqual(Array.from({ length: 100 }, () => "installed-rg"))
    expect(attempts).toBe(1)
    expect(await Effect.runPromise(locator)).toBe("installed-rg")
    expect(attempts).toBe(1)
  })

  test("a failed download is cooled down, not cached permanently", async () => {
    let attempts = 0
    const locator = await Effect.runPromise(makeRecoverableResolution(
      Effect.succeed<string | undefined>(undefined),
      Effect.suspend(() => {
        attempts++
        return attempts === 1 ? Effect.fail(new Error("temporary network failure")) : Effect.succeed("restored-rg")
      }),
      300,
    ))
    expect(Exit.isFailure(await Effect.runPromise(Effect.exit(locator)))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromise(Effect.exit(locator)))).toBe(true)
    expect(attempts).toBe(1)
    await Bun.sleep(360)
    expect(await Effect.runPromise(locator)).toBe("restored-rg")
    expect(attempts).toBe(2)
  })

  test("an externally placed binary immediately overrides a failed download cooldown", async () => {
    let available: string | undefined
    let attempts = 0
    const locator = await Effect.runPromise(makeRecoverableResolution(
      Effect.sync(() => available),
      Effect.suspend(() => {
        attempts++
        return Effect.fail(new Error("proxy unavailable"))
      }),
      60_000,
    ))
    expect(Exit.isFailure(await Effect.runPromise(Effect.exit(locator)))).toBe(true)
    available = "manual-rg"
    expect(await Effect.runPromise(locator)).toBe("manual-rg")
    expect(attempts).toBe(1)
  })

  test("interruption of an install does not poison subsequent attempts", async () => {
    let attempts = 0
    const locator = await Effect.runPromise(makeRecoverableResolution(
      Effect.succeed<string | undefined>(undefined),
      Effect.suspend(() => {
        attempts++
        return attempts === 1 ? Effect.never : Effect.succeed("after-cancellation")
      }),
      60_000,
    ))
    const cancelled = await Effect.runPromise(Effect.exit(locator.pipe(Effect.timeout("20 millis"))))
    expect(Exit.isFailure(cancelled)).toBe(true)
    expect(await Effect.runPromise(locator)).toBe("after-cancellation")
    expect(attempts).toBe(2)
  })
})