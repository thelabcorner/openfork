import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import {
  configuredSearchTimeoutMs,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_TIMEOUT_MS,
  withRipgrepSearchBudget,
} from "../src/ripgrep/budget"

describe("bounded ripgrep scans", () => {
  test("configuration never disables the search deadline", () => {
    expect(configuredSearchTimeoutMs({})).toBe(DEFAULT_SEARCH_TIMEOUT_MS)
    expect(configuredSearchTimeoutMs({ OPENFORK_RIPGREP_SEARCH_TIMEOUT_MS: "0" })).toBe(DEFAULT_SEARCH_TIMEOUT_MS)
    expect(configuredSearchTimeoutMs({ OPENFORK_RIPGREP_SEARCH_TIMEOUT_MS: "NaN" })).toBe(DEFAULT_SEARCH_TIMEOUT_MS)
    expect(configuredSearchTimeoutMs({ OPENFORK_RIPGREP_SEARCH_TIMEOUT_MS: "99999999" })).toBe(MAX_SEARCH_TIMEOUT_MS)
    expect(configuredSearchTimeoutMs({ OPENFORK_RIPGREP_SEARCH_TIMEOUT_MS: "13500" })).toBe(13_500)
  })

  test("terminates an indefinitely silent traversal and executes its process cleanup", async () => {
    let cleaned = false
    const longScan = Effect.never.pipe(Effect.ensuring(Effect.sync(() => { cleaned = true })))
    const startedAt = performance.now()
    const result = await Effect.runPromise(Effect.exit(withRipgrepSearchBudget(longScan, 30)))
    expect(Exit.isFailure(result)).toBe(true)
    expect(cleaned).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(2_000)
  })

  test("successful bounded search and real operation errors retain original semantics", async () => {
    expect(await Effect.runPromise(withRipgrepSearchBudget(Effect.succeed(["a", "b"]), 40))).toEqual(["a", "b"])
    const result = await Effect.runPromise(Effect.exit(withRipgrepSearchBudget(Effect.fail(new Error("bad pattern")), 40)))
    expect(Exit.isFailure(result)).toBe(true)
  })
})